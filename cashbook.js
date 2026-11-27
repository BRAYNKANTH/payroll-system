// The hub's cash book: what cash the hub holds, day by day.
//
//   Cash in      what the sellers handed in on the daily sheets (automatic), plus any "other cash in" the coacher records
//   Cash out     what the coacher records as spent (expenses, salaries paid from the cash) plus the cash handed over to the office
//                (the day's handover; a handover the office sent back does not count)
//   Online       money that reached the company by bank or card instead of cash. It is shown, but it is not cash in hand.
//   Cash in hand opening + cash in - cash out, carried from day to day and from month to month
//
// The coacher keeps the book for their own hub; the admin can view every hub and can also add or remove entries.
const { withUser, httpError } = require("./db");
const sales = require("./sales");
const svc = require("./service");

const KINDS = { expense: "Expense", salary: "Salary paid", other_in: "Other cash in", online: "Online money received" };
const CATEGORIES = ["Tea and transport", "Office", "Fuel", "Rent", "Supplies", "Other"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (r) => ({ ...r, id: Number(r.id), amount: Number(r.amount) });
const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];
const daysIn = (period) => { const [y, m] = period.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// Everything before `date` for a hub: cash in, other cash in, cash out. Gives the opening cash for a day or month.
async function before(db, hub, date) {
  const one = async (sql, ...a) => Number((await db.get(sql, ...a)).n) || 0;
  const cashIn = await one("SELECT COALESCE(SUM(d.settled_amount), 0) AS n FROM daily_log d JOIN staff s USING (employee_id) WHERE s.hub = ? AND d.date < ?", hub, date);
  const otherIn = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_book_entries WHERE hub = ? AND kind = 'other_in' AND date < ?", hub, date);
  const spent = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_book_entries WHERE hub = ? AND kind IN ('expense','salary') AND date < ?", hub, date);
  const handed = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_handovers WHERE hub = ? AND status <> 'rejected' AND date < ?", hub, date);
  return cashIn + otherIn - spent - handed;
}

// One hub, one month: the day-by-day book, the entries, and how each team's cash stands.
async function book(db, hub, period) {
  const [from, to] = monthBounds(period);
  const opening = await before(db, hub, from);
  const settled = new Map((await db.all(`SELECT d.date, SUM(d.settled_amount) AS cash, SUM(d.business_amount) AS sales FROM daily_log d JOIN staff s USING (employee_id)
    WHERE s.hub = ? AND d.date >= ? AND d.date < ? GROUP BY d.date`, hub, from, to)).map((r) => [r.date, { cash: Number(r.cash), sales: Number(r.sales) }]));
  const entries = (await db.all("SELECT * FROM cash_book_entries WHERE hub = ? AND date >= ? AND date < ? ORDER BY date, id", hub, from, to)).map(num);
  const handovers = new Map((await db.all("SELECT date, amount, status FROM cash_handovers WHERE hub = ? AND date >= ? AND date < ?", hub, from, to)).map((r) => [r.date, { amount: Number(r.amount), status: r.status }]));
  const days = [];
  let run = opening;
  const tot = { cash_in: 0, other_in: 0, expenses: 0, salaries: 0, handed: 0, online: 0, sales: 0 };
  for (let n = 1; n <= daysIn(period); n++) {
    const date = `${period}-${String(n).padStart(2, "0")}`;
    const sold = settled.get(date) || { cash: 0, sales: 0 };
    const mine = entries.filter((e) => e.date === date);
    const sum = (k) => mine.filter((e) => e.kind === k).reduce((t, e) => t + e.amount, 0);
    const h = handovers.get(date);
    const row = { date, sales: sold.sales, cash_in: sold.cash, other_in: sum("other_in"), expenses: sum("expense"), salaries: sum("salary"), online: sum("online"),
      handed: h && h.status !== "rejected" ? h.amount : 0, handover_status: h ? h.status : null };
    if (!(row.sales || row.cash_in || row.other_in || row.expenses || row.salaries || row.online || h)) continue; // a day with nothing in it is not listed
    row.opening = run;
    run = run + row.cash_in + row.other_in - row.expenses - row.salaries - row.handed;
    row.closing = run;
    for (const k of Object.keys(tot)) tot[k] += row[k] || 0;
    days.push(row);
  }
  // Each team (a manager and everyone under them): what they sold in the month and what they handed in.
  const staff = await db.all("SELECT employee_id, name, hub, staff_level, upline_id, status FROM staff");
  const byId = new Map(staff.map((s) => [s.employee_id, s]));
  const { teamOf } = require("./teams");
  const per = await db.all(`SELECT d.employee_id, SUM(d.business_amount) AS sales, SUM(d.settled_amount) AS cash FROM daily_log d JOIN staff s USING (employee_id)
    WHERE s.hub = ? AND d.date >= ? AND d.date < ? GROUP BY d.employee_id`, hub, from, to);
  const teams = new Map();
  for (const r of per) {
    const t = teamOf(byId.get(r.employee_id), byId);
    const x = teams.get(t.id) || teams.set(t.id, { id: t.id, title: t.title, sub: t.sub, sales: 0, cash: 0, people: 0 }).get(t.id);
    x.sales += Number(r.sales); x.cash += Number(r.cash); x.people++;
  }
  const teamRows = [...teams.values()].map((t) => ({ ...t, not_handed_in: t.sales - t.cash, share: t.sales ? t.cash / t.sales : null })).sort((a, b) => b.sales - a.sales);
  return { hub, period, opening, closing: run, totals: tot, days, entries, teams: teamRows };
}

// For the office with no hub chosen: one line per hub for the month.
async function summary(db, { period, hub }) {
  svc.assertPeriod(period);
  const hubs = await db.all(`SELECT code, name FROM hubs WHERE status = 'active'${hub ? " AND code = ?" : ""} ORDER BY code`, ...(hub ? [hub] : []));
  if (hub) {
    if (!hubs.length) throw httpError(404, "Hub not found");
    return { ...(await book(db, hub, period)), name: hubs[0].name, kinds: KINDS, categories: CATEGORIES };
  }
  const out = [];
  for (const h of hubs) { const b = await book(db, h.code, period); out.push({ code: h.code, name: h.name, opening: b.opening, closing: b.closing, totals: b.totals }); }
  return { period, hubs: out };
}

async function add(db, user, body) {
  const hub = user.hub || String(body.hub || "");
  if (!hub) throw httpError(400, "Choose the hub this entry is for");
  if (user.hub && body.hub && body.hub !== user.hub) throw httpError(403, "You can only write in your own hub's cash book");
  if (!(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", hub))) throw httpError(404, "Hub not found");
  const kind = String(body.kind || "");
  if (!KINDS[kind]) throw httpError(400, "Choose what kind of entry this is");
  const date = String(body.date || sales.today());
  if (!DATE_RE.test(date) || isNaN(Date.parse(date))) throw httpError(400, "The date must look like 2026-11-18");
  const now = sales.today();
  if (date > now) throw httpError(400, "You cannot enter a day that has not happened yet");
  if (date < sales.addDays(now, -400)) throw httpError(400, "That date is too far back");
  const amount = sales.rupees("Amount", body.amount);
  if (amount <= 0) throw httpError(400, "Enter an amount above 0");
  const category = String(body.category || "").trim().slice(0, 60) || (kind === "salary" ? "Salary" : kind === "expense" ? "Other" : null);
  const note = String(body.note || "").trim().slice(0, 200) || null;
  if (await svc.isFinalized(db, date.slice(0, 7))) throw httpError(409, "That month is closed, so its cash book can no longer change");
  return num(await withUser(db, user.username, (t) => t.get(`INSERT INTO cash_book_entries (hub, date, kind, category, amount, note, created_by) VALUES (?,?,?,?,?,?,?) RETURNING *`,
    hub, date, kind, category, amount, note, user.username)));
}

async function remove(db, user, id) {
  const row = await db.get("SELECT * FROM cash_book_entries WHERE id = ?", Number(id));
  if (!row) throw httpError(404, "Entry not found");
  if (user.hub && row.hub !== user.hub) throw httpError(403, "That entry belongs to another hub");
  if (await svc.isFinalized(db, row.date.slice(0, 7))) throw httpError(409, "That month is closed, so its cash book can no longer change");
  await withUser(db, user.username, (t) => t.run("DELETE FROM cash_book_entries WHERE id = ?", row.id));
  return { deleted: true };
}

module.exports = { summary, book, add, remove, KINDS, CATEGORIES };
