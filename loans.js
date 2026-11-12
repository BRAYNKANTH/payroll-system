// Advances and loans for guys / supervisors.
//
// An advance is a loan with one instalment (the whole amount). A loan is paid back by a fixed monthly instalment.
// The payroll run takes each loan's instalment from that month's pay (engine.computeGuy) and records it in
// loan_repayments; when the month is finalized those rows lock, and they are what the loan balance is built from.
// The balance never lives in a column of its own, so it cannot drift from the payslips.
const { withUser, httpError } = require("./db");

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW = "now_iso()";

const isFinalized = async (db, period) => (await db.get("SELECT status FROM periods WHERE period = ?", period))?.status === "finalized";

function rupees(name, raw, { required = true } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (required) throw httpError(400, `${name} is required`);
    return undefined;
  }
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return Math.round(n * 100);
}

// What is due from one loan in `period`, given everything repaid in earlier periods.
function dueFor(loan, repaidBefore, period) {
  if (loan.status !== "active" || loan.start_period > period) return { outstanding: loan.amount - loan.already_repaid - repaidBefore, planned: 0 };
  const outstanding = loan.amount - loan.already_repaid - repaidBefore;
  return { outstanding, planned: Math.max(0, Math.min(loan.instalment, outstanding)) };
}

// Instalments the payroll run should try to take in `period`: Map employee_id -> [{ id, kind, planned, outstanding }].
// Only repayments from earlier periods count, so re-running a month never double counts it.
async function plan(db, period) {
  const loans = await db.all("SELECT * FROM loans WHERE status = 'active' AND start_period <= ? ORDER BY id", period);
  const out = new Map();
  if (!loans.length) return out;
  const repaid = new Map((await db.all("SELECT loan_id, SUM(amount) AS n FROM loan_repayments WHERE period < ? GROUP BY loan_id", period))
    .map((r) => [r.loan_id, Number(r.n)]));
  for (const l of loans) {
    const { outstanding, planned } = dueFor(l, repaid.get(l.id) || 0, period);
    if (planned <= 0) continue;
    (out.get(l.employee_id) || out.set(l.employee_id, []).get(l.employee_id)).push({ id: l.id, kind: l.kind, planned, outstanding });
  }
  return out;
}

// Called by the payroll run with what the engine actually took. Replaces that month's rows.
async function saveRepayments(db, period, results) {
  await db.run("DELETE FROM loan_repayments WHERE period = ?", period);
  const rows = [];
  for (const [employeeId, r] of results) {
    for (const l of r.detail.loans || []) if (l.amount > 0) rows.push([l.loan_id, employeeId, period, l.amount]);
  }
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await db.run(`INSERT INTO loan_repayments (loan_id, employee_id, period, amount) VALUES ${part.map(() => "(?,?,?,?)").join(", ")}`, ...part.flat());
  }
}

// Loans with their balances. `period` is the month "due this month" is worked out for.
async function list(db, { employee_id, hub, status, period } = {}) {
  const where = [], args = [];
  if (employee_id) { where.push("l.employee_id = ?"); args.push(employee_id); }
  if (hub) { where.push("s.hub = ?"); args.push(hub); }
  const loans = await db.all(`SELECT l.*, s.name, s.hub, s.staff_level FROM loans l JOIN staff s USING (employee_id)
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.id DESC`, ...args);
  if (!loans.length) return [];
  const reps = await db.all(`SELECT r.loan_id, r.period, r.amount, COALESCE(p.status, 'open') = 'finalized' AS final
    FROM loan_repayments r LEFT JOIN periods p ON p.period = r.period WHERE r.loan_id = ANY(?::bigint[]) ORDER BY r.period`, loans.map((l) => l.id));
  const byLoan = new Map();
  for (const r of reps) (byLoan.get(r.loan_id) || byLoan.set(r.loan_id, []).get(r.loan_id)).push(r);
  const out = loans.map((l) => {
    const mine = byLoan.get(l.id) || [];
    const repaid = l.already_repaid + mine.filter((r) => r.final).reduce((t, r) => t + r.amount, 0);
    const outstanding = l.amount - repaid;
    const before = mine.filter((r) => r.period < (period || "9999-99")).reduce((t, r) => t + r.amount, 0);
    const due = period ? dueFor(l, before, period).planned : 0;
    const state = outstanding <= 0 ? "paid" : l.status === "stopped" ? "stopped" : "active";
    return { ...l, repaid, outstanding, due, state, repayments: mine.map(({ period: p, amount, final }) => ({ period: p, amount, final })) };
  });
  return status ? out.filter((l) => l.state === status) : out;
}

async function assertScope(db, employeeId, scopeHub) {
  if (!scopeHub) return;
  const s = await db.get("SELECT hub FROM staff WHERE employee_id = ?", employeeId);
  if (s?.hub !== scopeHub) throw httpError(403, `You can only manage loans for staff of hub ${scopeHub}`);
}

async function create(db, body, user, scopeHub) {
  const kind = body.kind;
  if (!["advance", "loan"].includes(kind)) throw httpError(400, "Choose advance or loan");
  const s = await db.get("SELECT employee_id, role, status FROM staff WHERE employee_id = ?", String(body.employee_id || ""));
  if (!s) throw httpError(400, "Choose an employee");
  if (s.role !== "guy") throw httpError(400, "Advances and loans are for distributors, supervisors and group managers. A manager's account already has a personal draw.");
  if (s.status !== "active") throw httpError(400, "That employee is inactive");
  await assertScope(db, s.employee_id, scopeHub);

  const amount = rupees("Amount", body.amount);
  if (amount <= 0) throw httpError(400, "Amount must be more than zero");
  const instalment = kind === "advance" ? amount : rupees("Monthly instalment", body.instalment);
  if (instalment <= 0) throw httpError(400, "Monthly instalment must be more than zero");
  if (instalment > amount) throw httpError(400, "The monthly instalment cannot be more than the loan");
  const already = rupees("Already repaid", body.already_repaid, { required: false }) || 0;
  if (already < 0) throw httpError(400, "Already repaid cannot be negative");
  if (already >= amount) throw httpError(400, "Already repaid is the whole amount, so there is nothing left to take back");

  const start = String(body.start_period || "");
  if (!PERIOD_RE.test(start)) throw httpError(400, "Choose the month the first deduction is taken");
  if (await isFinalized(db, start)) throw httpError(409, `${start} is already finalized. Choose a month that is still open.`);
  const issued = String(body.issued_on || new Date().toISOString().slice(0, 10));
  if (!DATE_RE.test(issued)) throw httpError(400, "Date given must be a date");

  return withUser(db, user, (t) => t.get(`INSERT INTO loans (employee_id, kind, amount, instalment, start_period, issued_on, already_repaid, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`, s.employee_id, kind, amount, instalment, start, issued, already, String(body.note || "").trim() || null, user));
}

// What can change: the note, the instalment, stopping or resuming deductions, and (before anything is repaid) the amount and first month.
async function update(db, id, body, user, scopeHub) {
  const l = await db.get("SELECT * FROM loans WHERE id = ?", id);
  if (!l) throw httpError(404, "Loan not found");
  await assertScope(db, l.employee_id, scopeHub);
  const hasRepayments = !!(await db.get("SELECT 1 AS x FROM loan_repayments WHERE loan_id = ? LIMIT 1", id));
  const set = {};
  if (body.note !== undefined) set.note = String(body.note || "").trim() || null;
  if (body.status !== undefined) {
    if (!["active", "stopped"].includes(body.status)) throw httpError(400, "Status must be active or stopped");
    set.status = body.status;
  }
  if (body.instalment !== undefined && l.kind === "loan") {
    const v = rupees("Monthly instalment", body.instalment);
    if (v <= 0) throw httpError(400, "Monthly instalment must be more than zero");
    set.instalment = v;
  }
  if (body.amount !== undefined) {
    if (hasRepayments) throw httpError(409, "Some of this has already been taken from pay, so the amount cannot change. Stop it and record a new one instead.");
    const v = rupees("Amount", body.amount);
    if (v <= l.already_repaid) throw httpError(400, "Amount must be more than what was already repaid");
    set.amount = v;
    if (l.kind === "advance") set.instalment = v;
  }
  if (body.start_period !== undefined) {
    if (hasRepayments) throw httpError(409, "Deductions have already started, so the first month cannot change");
    if (!PERIOD_RE.test(body.start_period)) throw httpError(400, "Choose the month the first deduction is taken");
    if (await isFinalized(db, body.start_period)) throw httpError(409, `${body.start_period} is already finalized`);
    set.start_period = body.start_period;
  }
  const next = { ...l, ...set };
  if (next.instalment > next.amount) throw httpError(400, "The monthly instalment cannot be more than the loan");
  const cols = Object.keys(set).filter((c) => set[c] !== l[c]);
  if (!cols.length) return l;
  return withUser(db, user, (t) => t.get(`UPDATE loans SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE id = ? RETURNING *`,
    ...cols.map((c) => set[c]), user, id));
}

// Only a loan nothing has been taken against can be deleted (a mistake). Anything else is stopped, so the history stays.
async function remove(db, id, user, scopeHub) {
  const l = await db.get("SELECT * FROM loans WHERE id = ?", id);
  if (!l) throw httpError(404, "Loan not found");
  await assertScope(db, l.employee_id, scopeHub);
  if (await db.get("SELECT 1 AS x FROM loan_repayments WHERE loan_id = ? LIMIT 1", id)) {
    throw httpError(409, "Payments have already been taken from pay, so this cannot be deleted. Stop it instead.");
  }
  await withUser(db, user, (t) => t.run("DELETE FROM loans WHERE id = ?", id));
  return { deleted: true };
}

// A person's own loans for the staff portal: balances only, no internal notes.
async function mine(db, employeeId, period) {
  const rows = await list(db, { employee_id: employeeId, period });
  return rows.filter((l) => l.state !== "stopped" || l.outstanding > 0).map((l) => ({
    id: l.id, kind: l.kind, amount: l.amount, instalment: l.instalment, issued_on: l.issued_on, start_period: l.start_period,
    repaid: l.repaid, outstanding: l.outstanding, due: l.due, state: l.state,
  }));
}

module.exports = { plan, saveRepayments, list, create, update, remove, mine };
