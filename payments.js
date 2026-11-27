// Salary payments: what was actually paid to each person for a month (the sheets' "paid / pending", part payments, cheques).
//
// A person's salary for a month is the pay run's "disbursed amount". Payments add up against it:
//   pending   nothing paid yet     part   something paid, some still to pay     paid   all of it paid
// The admin records them, also after the month is closed (closing locks the sheets, not the payments). A payment above what is still to pay is refused.
const { withUser, httpError } = require("./db");
const sales = require("./sales");
const svc = require("./service");

const METHODS = { cash: "Cash", cheque: "Cheque", bank: "Bank", other: "Other" };
const num = (r) => ({ ...r, id: Number(r.id), amount: Number(r.amount) });

async function owed(db, period, employeeId) {
  const row = await db.get("SELECT disbursed_amount FROM pay_period_summary WHERE period = ? AND employee_id = ?", period, employeeId);
  if (!row) throw httpError(404, "That person has no salary worked out for this month yet");
  const paid = Number((await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM salary_payments WHERE period = ? AND employee_id = ?", period, employeeId)).n);
  const salary = Number(row.disbursed_amount);
  return { salary, paid, left: salary - paid };
}

function checkFields(body) {
  const method = String(body.method || "cash");
  if (!METHODS[method]) throw httpError(400, "Choose cash, cheque, bank or other");
  const paidOn = String(body.paid_on || sales.today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || isNaN(Date.parse(paidOn))) throw httpError(400, "The date must look like 2026-11-18");
  if (paidOn > sales.today()) throw httpError(400, "A payment cannot be dated in the future");
  return { method, paidOn, note: String(body.note || "").trim().slice(0, 200) || null };
}

// Every payment of a month, newest first (a hub-limited user gets only their hub's people).
async function list(db, period, hub) {
  svc.assertPeriod(period);
  const rows = await db.all(`SELECT x.*, s.name, s.hub FROM salary_payments x JOIN staff s USING (employee_id) WHERE x.period = ?${hub ? " AND s.hub = ?" : ""} ORDER BY x.paid_on DESC, x.id DESC`, period, ...(hub ? [hub] : []));
  return rows.map(num);
}

async function record(db, user, period, body) {
  svc.assertPeriod(period);
  const employeeId = String(body.employee_id || "");
  const amount = sales.rupees("Amount", body.amount);
  if (amount <= 0) throw httpError(400, "Enter an amount above 0");
  const { method, paidOn, note } = checkFields(body);
  return withUser(db, user.username, async (t) => {
    const o = await owed(t, period, employeeId);
    if (o.salary <= 0) throw httpError(409, "There is no salary to pay this person this month");
    if (amount > o.left) throw httpError(409, o.left <= 0 ? "This salary is already paid in full" : `Only Rs ${(o.left / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })} is still to pay`);
    return num(await t.get(`INSERT INTO salary_payments (period, employee_id, amount, method, paid_on, note, created_by) VALUES (?,?,?,?,?,?,?) RETURNING *`,
      period, employeeId, amount, method, paidOn, note, user.username));
  });
}

// "Mark as paid" for many people at once: whatever is still to pay for each of them (everyone with something left, or the ids given).
async function payMany(db, user, period, body) {
  svc.assertPeriod(period);
  const { method, paidOn, note } = checkFields(body);
  const ids = Array.isArray(body.employee_ids) ? body.employee_ids.map(String) : null;
  return withUser(db, user.username, async (t) => {
    const rows = await t.all(`SELECT p.employee_id, p.disbursed_amount,
        COALESCE((SELECT SUM(x.amount) FROM salary_payments x WHERE x.period = p.period AND x.employee_id = p.employee_id), 0) AS paid
      FROM pay_period_summary p WHERE p.period = ? AND p.disbursed_amount > 0`, period);
    let count = 0, total = 0;
    for (const r of rows) {
      if (ids && !ids.includes(r.employee_id)) continue;
      const left = Number(r.disbursed_amount) - Number(r.paid);
      if (left <= 0) continue;
      await t.run(`INSERT INTO salary_payments (period, employee_id, amount, method, paid_on, note, created_by) VALUES (?,?,?,?,?,?,?)`, period, r.employee_id, left, method, paidOn, note, user.username);
      count++; total += left;
    }
    return { paid_people: count, amount: total };
  });
}

async function remove(db, user, id) {
  const row = await db.get("SELECT id FROM salary_payments WHERE id = ?", Number(id));
  if (!row) throw httpError(404, "Payment not found");
  await withUser(db, user.username, (t) => t.run("DELETE FROM salary_payments WHERE id = ?", row.id));
  return { deleted: true };
}

module.exports = { list, record, payMany, remove, METHODS };
