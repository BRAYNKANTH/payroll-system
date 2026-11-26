// Sales entered by the sellers themselves, and the live view of them.
//
// A distributor or supervisor adds their own day on the staff portal (sales, cash handed in, advance). Such a row is marked
// source = 'portal' and stays "unconfirmed" until the office (a hub manager or the admin) confirms it. Until then the seller can still
// correct or remove it; afterwards only the office can change it. An unconfirmed day is counted in pay but raises a payroll flag, so a
// month cannot be finalized with sales nobody has checked.
//
// The live view (only the admin sees the pay columns, everyone else sees only the sales) works out, for every entry, what that day
// earned under the person's own pay rules, how far the month is from the target, and what has been earned so far.
const { withUser, getSettings, httpError } = require("./db");
const engine = require("./engine");
const svc = require("./service");
const { teamOf } = require("./teams");

const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r) && m, new Map());

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW = "now_iso()";
const DAYS_BACK = 7;           // how far back a seller may enter a day
const MAX_RUPEES = 100_000_000; // a typing slip, not a real day

const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];
// Today in Sri Lanka (UTC+5:30), so an entry made after midnight there is dated correctly.
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function rupees(name, raw, { required = true } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (required) throw httpError(400, `${name} is required`);
    return 0;
  }
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > MAX_RUPEES) throw httpError(400, `${name} must be a number from 0 to ${MAX_RUPEES.toLocaleString("en-GB")}`);
  return Math.round(n * 100);
}

// A seller can never hand in more than they sold: extra cash would show as a negative deduction and raise their own pay.
// Paying back an earlier shortage is recorded by the coacher on the daily sheet, who sees and approves it.
function assertHandIn(settled, business) {
  if (settled > business) throw httpError(400, "Money handed in cannot be more than your sales for the day. To pay back an earlier shortage, ask your coacher to record it");
}

async function myself(db, user) {
  if (!user?.employee_id) throw httpError(403, "This login is not linked to an employee");
  const s = await db.get("SELECT employee_id, name, role, staff_level, status, hub FROM staff WHERE employee_id = ?", user.employee_id);
  if (!s || (s.role !== "guy" && !["manager", "promoting_manager"].includes(s.staff_level))) throw httpError(403, "Only distributors, supervisors, managers and promoting managers can enter sales here");
  if (s.status !== "active") throw httpError(403, "Your account is no longer active");
  return s;
}

// A seller adds (or corrects) their own day.
async function addSale(db, user, body) {
  const s = await myself(db, user);
  const date = String(body.date || "");
  if (!DATE_RE.test(date) || isNaN(Date.parse(date))) throw httpError(400, "date must be YYYY-MM-DD");
  const now = today();
  if (date > now) throw httpError(400, "You cannot enter a day that has not happened yet");
  if (date < addDays(now, -DAYS_BACK)) throw httpError(400, `You can enter days up to ${DAYS_BACK} days back. Ask your hub manager for an older day`);
  if (await svc.isFinalized(db, date.slice(0, 7))) throw httpError(409, "That month is closed");
  const business = rupees("Sales", body.business_amount);
  const settled = rupees("Money handed in", body.settled_amount);
  const personal = rupees("Advance", body.personal_minus, { required: false });
  assertHandIn(settled, business);
  const notes = String(body.notes || "").trim().slice(0, 200) || null;

  const existing = await db.get("SELECT id, source, confirmed_by FROM daily_log WHERE date = ? AND employee_id = ?", date, s.employee_id);
  if (existing && (existing.source !== "portal" || existing.confirmed_by)) {
    throw httpError(409, "That day was already recorded by the office. Ask your hub manager to change it");
  }
  return withUser(db, user.username, (t) => existing
    ? t.get(`UPDATE daily_log SET business_amount = ?, settled_amount = ?, personal_minus = ?, notes = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ? RETURNING *`,
      business, settled, personal, notes, user.username, existing.id)
    : t.get(`INSERT INTO daily_log (date, employee_id, business_amount, settled_amount, personal_minus, notes, created_by, source) VALUES (?,?,?,?,?,?,?, 'portal') RETURNING *`,
      date, s.employee_id, business, settled, personal, notes, user.username));
}

// A seller removes a day they entered, while the office has not confirmed it.
async function removeSale(db, user, date) {
  const s = await myself(db, user);
  const row = await db.get("SELECT id, source, confirmed_by FROM daily_log WHERE date = ? AND employee_id = ?", date, s.employee_id);
  if (!row) throw httpError(404, "No entry for that day");
  if (row.source !== "portal" || row.confirmed_by) throw httpError(409, "The office has already confirmed that day. Ask your hub manager to change it");
  await withUser(db, user.username, (t) => t.run("DELETE FROM daily_log WHERE id = ?", row.id));
  return { deleted: true };
}

// The office confirms self-entered days: by id, or every unconfirmed day of a month. A hub-limited user only reaches their own hub.
async function confirm(db, user, body, scopeHub) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  let where = "d.source = 'portal' AND d.confirmed_by IS NULL";
  const args = [];
  if (ids.length) { where += ` AND d.id = ANY(?::bigint[])`; args.push(ids); }
  else if (body.all) { svc.assertPeriod(body.period); where += " AND d.date >= ? AND d.date < ?"; args.push(...monthBounds(body.period)); }
  else throw httpError(400, "Choose the entries to confirm");
  if (scopeHub) { where += " AND s.hub = ?"; args.push(scopeHub); }
  const rows = await db.all(`SELECT d.id, d.date FROM daily_log d JOIN staff s USING (employee_id) WHERE ${where}`, ...args);
  for (const p of new Set(rows.map((r) => r.date.slice(0, 7)))) {
    if (await svc.isFinalized(db, p)) throw httpError(409, `${p} is finalized`);
  }
  if (!rows.length) return { confirmed: 0 };
  await withUser(db, user.username, (t) => t.run(`UPDATE daily_log SET confirmed_by = ?, confirmed_at = ${NOW} WHERE id = ANY(?::bigint[])`, user.username, rows.map((r) => r.id)));
  return { confirmed: rows.length };
}

// ---------------------------------------------------------------- the live view

// What a person has earned from sales, day by day. Each entry's share is the difference between the earnings with and without it,
// so a sale that takes someone over their target shows the higher rate on the part above it.
function earnedSoFar(staff, rows) {
  const r = engine.computeGuy({ staff, daily: rows, stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  const food = Number(r.detail.food_allowance) || 0;
  return { gross: r.gross_earnings, food, commission: r.gross_earnings - food };
}

async function live(db, { period, hub, ids }, canPay) {
  svc.assertPeriod(period);
  const [from, to] = monthBounds(period);
  const args = [from, to];
  let hubSql = "";
  if (hub) { hubSql = " AND s.hub = ?"; args.push(hub); }
  if (ids) { hubSql += " AND d.employee_id = ANY(?::text[])"; args.push(ids); } // a manager sees only their own people
  const rows = await db.all(`SELECT d.id, d.date, d.employee_id, d.business_amount, d.settled_amount, d.personal_minus, d.settle_up_minus, d.notes, d.source,
      d.confirmed_by, d.created_by, d.created_at, s.name, s.hub, s.staff_level, s.role
    FROM daily_log d JOIN staff s USING (employee_id) WHERE d.date >= ? AND d.date < ?${hubSql} ORDER BY d.date, d.id`, ...args);
  const staff = new Map((await db.all("SELECT * FROM staff")).map((s) => [s.employee_id, s]));
  const stock = groupBy(await db.all("SELECT * FROM stock_recon WHERE period = ?", period), "employee_id");
  const allow = groupBy(await db.all("SELECT * FROM allowances WHERE period = ?", period), "employee_id");

  const byPerson = new Map();
  for (const r of rows) (byPerson.get(r.employee_id) || byPerson.set(r.employee_id, []).get(r.employee_id)).push(r);

  const feed = [], people = [];
  for (const [id, list] of byPerson) {
    const s = staff.get(id);
    const teamId = teamOf(s, staff).id;
    const sells = s.role === "guy"; // a manager's pay is built differently, so only sellers get pay figures
    let cumulative = 0, before = { gross: 0, food: 0, commission: 0 };
    list.forEach((r, i) => {
      cumulative += Number(r.business_amount);
      const entry = {
        id: r.id, date: r.date, employee_id: id, name: r.name, hub: r.hub, staff_level: r.staff_level, team: teamId,
        business: Number(r.business_amount), settled: Number(r.settled_amount), personal: Number(r.personal_minus), notes: r.notes,
        self_entered: r.source === "portal", confirmed: r.source !== "portal" || !!r.confirmed_by, entered_by: r.created_by, entered_at: r.created_at,
        month_business: cumulative, target: Number(s.target) || 0, target_pct: s.target > 0 ? cumulative / s.target : null,
      };
      if (canPay && sells) {
        const after = earnedSoFar(s, list.slice(0, i + 1));
        entry.pay = { commission: after.commission - before.commission, food: after.food - before.food, gross_so_far: after.gross };
        before = after;
      }
      feed.push(entry);
    });
    const person = {
      employee_id: id, name: s.name, hub: s.hub, staff_level: s.staff_level, team: teamId, days: list.length, business: cumulative, target: Number(s.target) || 0,
      target_pct: s.target > 0 ? cumulative / s.target : null, unconfirmed: list.filter((r) => r.source === "portal" && !r.confirmed_by).length,
    };
    if (canPay && sells) {
      const full = engine.computeGuy({ staff: s, daily: list, stock: stock.get(id) || [], allowances: allow.get(id) || [], openingBalance: 0, securityHeldToDate: 0 });
      person.pay = { gross: full.gross_earnings, deductions: full.total_deductions, net: full.net_pay, over_target: Math.max(0, cumulative - s.target) };
    }
    people.push(person);
  }
  feed.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  people.sort((a, b) => b.business - a.business);
  // Everyone who sells in this hub (or in the manager's own team), even with no sales yet, so every team shows as a card.
  const mine = ids ? new Set(ids) : null;
  const roster = [...staff.values()]
    .filter((s) => s.status === "active" && (s.role === "guy" || ["manager", "promoting_manager"].includes(s.staff_level)) && (!hub || s.hub === hub) && (!mine || mine.has(s.employee_id)))
    .map((s) => ({ employee_id: s.employee_id, name: s.name, hub: s.hub, staff_level: s.staff_level, team: teamOf(s, staff) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { period, can_pay: !!canPay, unconfirmed: people.reduce((t, p) => t + p.unconfirmed, 0), feed, people, roster };
}

module.exports = { addSale, removeSale, confirm, live, today, addDays, rupees, myself, assertHandIn, DAYS_BACK };
