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

const KINDS = { expense: "Expense", salary: "Salary paid", draw: "Cash taken by a manager", other_in: "Other cash in", online: "Online money received" };
// What the hub may enter as an expense. Clearance, advertising and cards are the charges on the branch sheets; the hub writes them here.
const CATEGORIES = ["Tea and transport", "Office", "Fuel", "Rent", "Supplies", "Clearance", "Advertising", "Cards", "Other"];
const { MIN_SHARE } = require("./handover");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (r) => ({ ...r, id: Number(r.id), amount: Number(r.amount) });
const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];
const daysIn = (period) => { const [y, m] = period.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// Everything before `date` for a hub: cash in, other cash in, cash out. Gives the opening cash for a day or month.
async function before(db, hub, date) {
  const one = async (sql, ...a) => Number((await db.get(sql, ...a)).n) || 0;
  const cashIn = await one("SELECT COALESCE(SUM(d.settled_amount), 0) AS n FROM daily_log d JOIN staff s USING (employee_id) WHERE s.hub = ? AND d.date < ?", hub, date);
  const otherIn = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_book_entries WHERE hub = ? AND kind = 'other_in' AND date < ?", hub, date);
  const spent = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_book_entries WHERE hub = ? AND kind IN ('expense','salary','draw') AND date < ?", hub, date);
  const handed = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM cash_handovers WHERE hub = ? AND status <> 'rejected' AND date < ?", hub, date);
  return cashIn + otherIn - spent - handed;
}

// One hub, one month: the day-by-day book, the entries, and how each team's cash stands.
async function book(db, hub, period) {
  const [from, to] = monthBounds(period);
  const opening = await before(db, hub, from);
  const settled = new Map((await db.all(`SELECT d.date, SUM(d.settled_amount) AS cash, SUM(d.business_amount) AS sales FROM daily_log d JOIN staff s USING (employee_id)
    WHERE s.hub = ? AND d.date >= ? AND d.date < ? GROUP BY d.date`, hub, from, to)).map((r) => [r.date, { cash: Number(r.cash), sales: Number(r.sales) }]));
  const entries = (await db.all(`SELECT e.*, s.name AS employee_name FROM cash_book_entries e LEFT JOIN staff s ON s.employee_id = e.employee_id
    WHERE e.hub = ? AND e.date >= ? AND e.date < ? ORDER BY e.date, e.id`, hub, from, to)).map(num);
  const handovers = new Map((await db.all("SELECT date, amount, status FROM cash_handovers WHERE hub = ? AND date >= ? AND date < ?", hub, from, to)).map((r) => [r.date, { amount: Number(r.amount), status: r.status }]));
  const days = [];
  let run = opening;
  const tot = { cash_in: 0, other_in: 0, expenses: 0, salaries: 0, draws: 0, handed: 0, online: 0, sales: 0 };
  for (let n = 1; n <= daysIn(period); n++) {
    const date = `${period}-${String(n).padStart(2, "0")}`;
    const sold = settled.get(date) || { cash: 0, sales: 0 };
    const mine = entries.filter((e) => e.date === date);
    const sum = (k) => mine.filter((e) => e.kind === k).reduce((t, e) => t + e.amount, 0);
    const h = handovers.get(date);
    const row = { date, sales: sold.sales, cash_in: sold.cash, other_in: sum("other_in"), expenses: sum("expense"), salaries: sum("salary"), draws: sum("draw"), online: sum("online"),
      handed: h && h.status !== "rejected" ? h.amount : 0, handover_status: h ? h.status : null };
    if (!(row.sales || row.cash_in || row.other_in || row.expenses || row.salaries || row.draws || row.online || h)) continue; // a day with nothing in it is not listed
    row.opening = run;
    run = run + row.cash_in + row.other_in - row.expenses - row.salaries - row.draws - row.handed;
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
  // What each team (manager) sold and handed in on each day, and what it still owed from before the month: the sheets' "settle-up detail" and
  // "last week balance". A team's balance is sales minus cash handed in, added up from day to day.
  const perDay = await db.all(`SELECT d.date, d.employee_id, SUM(d.business_amount) AS sales, SUM(d.settled_amount) AS cash FROM daily_log d JOIN staff s USING (employee_id)
    WHERE s.hub = ? AND d.date >= ? AND d.date < ? GROUP BY d.date, d.employee_id ORDER BY d.date`, hub, from, to);
  const prior = await db.all(`SELECT d.employee_id, SUM(d.business_amount - d.settled_amount) AS gap FROM daily_log d JOIN staff s USING (employee_id) WHERE s.hub = ? AND d.date < ? GROUP BY d.employee_id`, hub, from);
  const meta = new Map(), carried = {}, byDay = new Map();
  for (const r of prior) { const t = teamOf(byId.get(r.employee_id), byId); meta.set(t.id, { id: t.id, title: t.title, sub: t.sub }); carried[t.id] = (carried[t.id] || 0) + Number(r.gap); }
  for (const r of perDay) {
    const t = teamOf(byId.get(r.employee_id), byId);
    meta.set(t.id, { id: t.id, title: t.title, sub: t.sub });
    const day = byDay.get(r.date) || byDay.set(r.date, new Map()).get(r.date);
    const x = day.get(t.id) || day.set(t.id, { id: t.id, sales: 0, cash: 0 }).get(t.id);
    x.sales += Number(r.sales); x.cash += Number(r.cash);
  }
  // The expected cash is 90% of the sales. A team (or a day of a team) below it is marked. What a seller handed in short is already taken off that
  // seller's pay as "cash not handed in", so nothing is charged twice: this only shows who it was.
  const expectedOf = (sales) => Math.ceil(sales * MIN_SHARE);
  const teamDays = [...byDay.entries()].map(([date, m]) => ({ date, teams: [...m.values()].map((x) => ({ ...x, gap: x.sales - x.cash, expected: expectedOf(x.sales), below: x.cash < expectedOf(x.sales) })) }));
  const teamRows = [...teams.values()].map((t) => ({ ...t, not_handed_in: t.sales - t.cash, share: t.sales ? t.cash / t.sales : null, carried: carried[t.id] || 0,
    expected: expectedOf(t.sales), below: t.cash < expectedOf(t.sales), short_of_expected: Math.max(0, expectedOf(t.sales) - t.cash) })).sort((a, b) => b.sales - a.sales);
  // Everyone who handed in less than they sold this month, with the team they are in.
  const gaveLess = per.filter((r) => Number(r.sales) > Number(r.cash)).map((r) => {
    const s = byId.get(r.employee_id), t = teamOf(s, byId);
    return { employee_id: r.employee_id, name: s.name, team: t.title, sales: Number(r.sales), cash: Number(r.cash), short: Number(r.sales) - Number(r.cash) };
  }).sort((a, b) => b.short - a.short);
  const managers = staff.filter((s) => s.hub === hub && s.status === "active" && (s.staff_level === "manager" || s.staff_level === "promoting_manager")).map((s) => ({ id: s.employee_id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
  return { hub, period, opening, closing: run, totals: tot, days, entries, teams: teamRows, team_days: teamDays, team_meta: [...meta.values()], team_carried: carried, gave_less: gaveLess, managers, min_percent: Math.round(MIN_SHARE * 100) };
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
  let employeeId = null;
  if (kind === "draw") { // cash a manager took: it is deducted from that manager's pay for the week
    employeeId = String(body.employee_id || "");
    const m = await db.get("SELECT employee_id, hub, status, staff_level FROM staff WHERE employee_id = ?", employeeId);
    if (!m || m.status !== "active" || !["manager", "promoting_manager"].includes(m.staff_level)) throw httpError(400, "Choose the manager who took the cash");
    if (m.hub !== hub) throw httpError(400, "That manager belongs to another hub");
  }
  const category = String(body.category || "").trim().slice(0, 60) || (kind === "salary" ? "Salary" : kind === "draw" ? "Manager's salary" : kind === "expense" ? "Other" : null);
  const note = String(body.note || "").trim().slice(0, 200) || null;
  if (await svc.isFinalized(db, date.slice(0, 7))) throw httpError(409, "That month is closed, so its cash book can no longer change");
  return num(await withUser(db, user.username, (t) => t.get(`INSERT INTO cash_book_entries (hub, date, kind, category, amount, note, created_by, employee_id) VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
    hub, date, kind, category, amount, note, user.username, employeeId)));
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
