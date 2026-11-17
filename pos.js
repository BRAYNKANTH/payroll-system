// Selling like a till, and the stock behind it.
//
// Each morning the hub gives a seller their stock (stock_issues: a product and a quantity). During the day the seller records every
// sale on their phone (sale_lines): pick a product, set a quantity, tap Sell. The price is always the product's list price and a seller
// can never sell more than they have in hand. A seller's stock is everything given to them minus everything they sold, so what is left
// over carries on to the next day.
//
// A day's business total is the sum of that day's sale lines. It is kept in daily_log (business_amount), so pay, the live view and the
// reports work exactly as before. The seller adds the money handed in at the end of the day. Days entered this way are marked
// source = 'portal' and wait for the office to confirm them, like any day a seller enters.
const { withUser, httpError } = require("./db");
const svc = require("./service");
const sales = require("./sales");

const NOW = "now_iso()";
const MAX_QTY = 10_000;
const ISSUE_DAYS_BACK = 3; // the office may record a morning's stock up to this many days late

const num = (v) => Number(v) || 0;
const qty = (v, name = "Quantity") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw httpError(400, `${name} must be a whole number from 1 to ${MAX_QTY.toLocaleString("en-GB")}`);
  return n;
};
const key = (id) => String(id);

// What a seller has, per product, on a day: carried over from before, given that day, sold that day, and what is left.
async function stockOf(db, employeeId, date) {
  const issued = await db.all(`SELECT product_id, SUM(CASE WHEN date = ? THEN qty ELSE 0 END) AS today, SUM(CASE WHEN date < ? THEN qty ELSE 0 END) AS before
    FROM stock_issues WHERE employee_id = ? AND date <= ? GROUP BY product_id`, date, date, employeeId, date);
  const sold = await db.all(`SELECT product_id, SUM(CASE WHEN date = ? THEN qty ELSE 0 END) AS today, SUM(CASE WHEN date < ? THEN qty ELSE 0 END) AS before
    FROM sale_lines WHERE employee_id = ? AND date <= ? GROUP BY product_id`, date, date, employeeId, date);
  const out = new Map();
  const slot = (id) => out.get(key(id)) || out.set(key(id), { product_id: Number(id), carried: 0, issued: 0, sold: 0, left: 0 }).get(key(id));
  for (const r of issued) { const x = slot(r.product_id); x.carried += num(r.before); x.issued += num(r.today); }
  for (const r of sold) { const x = slot(r.product_id); x.carried -= num(r.before); x.sold += num(r.today); }
  for (const x of out.values()) x.left = x.carried + x.issued - x.sold;
  return out;
}

// ---------------------------------------------------------------- the seller's screen
async function state(db, user) {
  const s = await sales.myself(db, user);
  const date = sales.today();
  const stock = await stockOf(db, s.employee_id, date);
  const products = await db.all("SELECT id, name, list_price, status FROM products ORDER BY lower(name)");
  const lines = await db.all(`SELECT l.id, l.qty, l.unit_price, l.amount, l.created_at, l.created_by, p.name AS product
    FROM sale_lines l JOIN products p ON p.id = l.product_id WHERE l.employee_id = ? AND l.date = ? ORDER BY l.id DESC`, s.employee_id, date);
  const day = await db.get("SELECT source, confirmed_by, settled_amount, personal_minus FROM daily_log WHERE date = ? AND employee_id = ?", date, s.employee_id);
  const closed = await svc.isFinalized(db, date.slice(0, 7));
  // Once the office has recorded or confirmed the day, the seller can look but not change it.
  const locked = closed || !!(day && (day.source !== "portal" || day.confirmed_by));
  const list = products.map((p) => {
    const x = stock.get(key(p.id)) || { carried: 0, issued: 0, sold: 0, left: 0 };
    return { id: Number(p.id), name: p.name, price: num(p.list_price), active: p.status === "active", carried: x.carried, issued: x.issued, sold: x.sold, left: x.left };
  }).filter((p) => p.active || p.carried || p.issued || p.sold);
  const total = lines.reduce((t, l) => t + num(l.amount), 0);
  return {
    date, closed, locked, me: { employee_id: s.employee_id, name: s.name },
    products: list,
    lines: lines.map((l) => ({ id: Number(l.id), product: l.product, qty: l.qty, unit_price: num(l.unit_price), amount: num(l.amount), at: l.created_at, can_undo: !locked })),
    totals: { count: lines.length, qty: lines.reduce((t, l) => t + l.qty, 0), amount: total },
    day: { settled: day ? num(day.settled_amount) : 0, personal: day ? num(day.personal_minus) : 0, confirmed: !!(day && day.confirmed_by), recorded: !!day,
      not_handed_in: Math.max(0, total - (day ? num(day.settled_amount) : 0)) },
  };
}

// Keeps the day's row in daily_log in step with its sale lines. A day with no lines and nothing else on it is removed,
// because a row with no sales would still count as a day worked (and earn the food allowance).
async function syncDay(t, user, s, date) {
  const sum = num((await t.get("SELECT COALESCE(SUM(amount), 0) AS n FROM sale_lines WHERE employee_id = ? AND date = ?", s.employee_id, date)).n);
  const row = await t.get("SELECT id, settled_amount, personal_minus FROM daily_log WHERE employee_id = ? AND date = ?", s.employee_id, date);
  if (row) {
    if (sum === 0 && num(row.settled_amount) === 0 && num(row.personal_minus) === 0) await t.run("DELETE FROM daily_log WHERE id = ?", row.id);
    else await t.run(`UPDATE daily_log SET business_amount = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, sum, user.username, row.id);
  } else if (sum > 0) {
    await t.run("INSERT INTO daily_log (date, employee_id, business_amount, settled_amount, personal_minus, created_by, source) VALUES (?,?,?,0,0,?, 'portal')", date, s.employee_id, sum, user.username);
  }
  return sum;
}

async function assertOpenDay(t, s, date) {
  if (await svc.isFinalized(t, date.slice(0, 7))) throw httpError(409, "That month is closed");
  const row = await t.get("SELECT source, confirmed_by FROM daily_log WHERE employee_id = ? AND date = ?", s.employee_id, date);
  if (row && (row.source !== "portal" || row.confirmed_by)) throw httpError(409, "The office has already recorded today. Ask your hub head to change it");
}

// One sale: a product and a quantity, at the list price. Refused when it is more than the seller has left.
async function sell(db, user, body) {
  const s = await sales.myself(db, user);
  const n = qty(body.qty);
  const date = sales.today();
  const line = await withUser(db, user.username, async (t) => {
    await assertOpenDay(t, s, date);
    const p = await t.get("SELECT id, name, list_price, status FROM products WHERE id = ?", Number(body.product_id));
    if (!p || p.status !== "active") throw httpError(400, "Choose a product from the list");
    const have = (await stockOf(t, s.employee_id, date)).get(key(p.id))?.left || 0;
    if (have <= 0) throw httpError(409, `You have no ${p.name} left. Ask your hub for more stock`);
    if (n > have) throw httpError(409, `You only have ${have} ${p.name} left`);
    const price = num(p.list_price);
    const row = await t.get(`INSERT INTO sale_lines (date, employee_id, product_id, qty, unit_price, amount, created_by) VALUES (?,?,?,?,?,?,?) RETURNING id, qty, unit_price, amount`,
      date, s.employee_id, p.id, n, price, n * price, user.username);
    await syncDay(t, user, s, date);
    return { ...row, product: p.name };
  }, { lockKey: "pos:" + s.employee_id });
  return { line: { id: Number(line.id), product: line.product, qty: line.qty, unit_price: num(line.unit_price), amount: num(line.amount) }, state: await state(db, user) };
}

// A seller takes back a sale they made today, while the office has not confirmed the day.
async function undo(db, user, id) {
  const s = await sales.myself(db, user);
  const date = sales.today();
  await withUser(db, user.username, async (t) => {
    await assertOpenDay(t, s, date);
    const row = await t.get("SELECT id FROM sale_lines WHERE id = ? AND employee_id = ? AND date = ?", Number(id), s.employee_id, date);
    if (!row) throw httpError(404, "That sale was not found for today");
    await t.run("DELETE FROM sale_lines WHERE id = ?", row.id);
    await syncDay(t, user, s, date);
  }, { lockKey: "pos:" + s.employee_id });
  return state(db, user);
}

// End of the day: the money handed in and any advance taken.
async function endOfDay(db, user, body) {
  const s = await sales.myself(db, user);
  const date = sales.today();
  const settled = sales.rupees("Money handed in", body.settled_amount);
  const personal = sales.rupees("Advance", body.personal_minus, { required: false });
  await withUser(db, user.username, async (t) => {
    await assertOpenDay(t, s, date);
    const row = await t.get("SELECT id FROM daily_log WHERE employee_id = ? AND date = ?", s.employee_id, date);
    if (!row) throw httpError(409, "Record a sale first, then enter the money you handed in");
    await t.run(`UPDATE daily_log SET settled_amount = ?, personal_minus = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, settled, personal, user.username, row.id);
  }, { lockKey: "pos:" + s.employee_id });
  return state(db, user);
}

// ---------------------------------------------------------------- the office: giving stock out
const sellersWhere = "s.status = 'active' AND (s.role = 'guy' OR s.staff_level = 'manager')";

async function checkSeller(db, id, scopeHub) {
  const s = await db.get(`SELECT s.employee_id, s.name, s.hub FROM staff s WHERE s.employee_id = ? AND ${sellersWhere}`, String(id || ""));
  if (!s) throw httpError(400, "Choose a seller who is active");
  if (scopeHub && s.hub !== scopeHub) throw httpError(403, "Outside your hub");
  return s;
}

// Who has what: every seller in the hub (or all hubs), with what they carry in, were given on `date`, and have sold.
async function morning(db, { date, hub }) {
  const day = String(date || sales.today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw httpError(400, "date must be YYYY-MM-DD");
  const people = await db.all(`SELECT s.employee_id, s.name, s.hub, s.staff_level FROM staff s WHERE ${sellersWhere}${hub ? " AND s.hub = ?" : ""} ORDER BY s.hub, s.name`, ...(hub ? [hub] : []));
  const ids = people.map((p) => p.employee_id);
  const products = await db.all("SELECT id, name, list_price, status FROM products ORDER BY lower(name)");
  const pname = new Map(products.map((p) => [key(p.id), p.name]));
  const given = ids.length ? await db.all(`SELECT i.id, i.employee_id, i.product_id, i.qty, i.created_by FROM stock_issues i WHERE i.date = ? AND i.employee_id = ANY(?::text[]) ORDER BY i.id`, day, ids) : [];
  const before = ids.length ? await db.all(`SELECT employee_id, product_id, SUM(qty) AS n FROM stock_issues WHERE date < ? AND employee_id = ANY(?::text[]) GROUP BY employee_id, product_id`, day, ids) : [];
  const soldBefore = ids.length ? await db.all(`SELECT employee_id, product_id, SUM(qty) AS n FROM sale_lines WHERE date < ? AND employee_id = ANY(?::text[]) GROUP BY employee_id, product_id`, day, ids) : [];
  const soldToday = ids.length ? await db.all(`SELECT employee_id, product_id, SUM(qty) AS n FROM sale_lines WHERE date = ? AND employee_id = ANY(?::text[]) GROUP BY employee_id, product_id`, day, ids) : [];
  const carried = new Map(); // "employee|product" -> pieces carried in
  for (const r of before) carried.set(r.employee_id + "|" + key(r.product_id), num(r.n));
  for (const r of soldBefore) carried.set(r.employee_id + "|" + key(r.product_id), (carried.get(r.employee_id + "|" + key(r.product_id)) || 0) - num(r.n));
  const sold = new Map(soldToday.map((r) => [r.employee_id + "|" + key(r.product_id), num(r.n)]));
  const pools = {};
  for (const h of [...new Set(people.map((p) => p.hub))]) {
    const pool = await poolOf(db, h);
    pools[h] = products.filter((p) => p.status === "active").map((p) => ({ product_id: Number(p.id), product: p.name, left: Math.max(0, pool.get(key(p.id))?.left || 0) }));
  }
  return {
    date: day,
    pools,
    products: products.filter((p) => p.status === "active").map((p) => ({ id: Number(p.id), name: p.name, price: num(p.list_price) })),
    sellers: people.map((p) => {
      const mine = given.filter((g) => g.employee_id === p.employee_id).map((g) => ({ id: Number(g.id), product_id: Number(g.product_id), product: pname.get(key(g.product_id)), qty: g.qty }));
      const keep = [...carried.entries()].filter(([k, n]) => k.startsWith(p.employee_id + "|") && n > 0).map(([k, n]) => ({ product_id: Number(k.split("|")[1]), product: pname.get(k.split("|")[1]), qty: n }));
      const soldPieces = [...sold.entries()].filter(([k]) => k.startsWith(p.employee_id + "|")).reduce((t, [, n]) => t + n, 0);
      return { employee_id: p.employee_id, name: p.name, hub: p.hub, staff_level: p.staff_level, carried: keep, given: mine, sold_pieces: soldPieces };
    }),
  };
}

// Give a seller their stock. `lines` is a list of { product_id, qty }.
async function give(db, user, body, scopeHub) {
  const s = await checkSeller(db, body.employee_id, scopeHub);
  const now = sales.today();
  const date = body.date ? String(body.date) : now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw httpError(400, "date must be YYYY-MM-DD");
  if (date > now) throw httpError(400, "You cannot give stock for a day that has not happened yet");
  if (date < sales.addDays(now, -ISSUE_DAYS_BACK)) throw httpError(400, `Stock can be recorded up to ${ISSUE_DAYS_BACK} days back`);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw httpError(400, "Add at least one product");
  const note = String(body.note || "").trim().slice(0, 200) || null;
  await withUser(db, user.username, async (t) => {
    if (await svc.isFinalized(t, date.slice(0, 7))) throw httpError(409, "That month is closed");
    // Stock comes out of what the office sent to the hub: a coacher cannot give more than the hub holds.
    const want = new Map(), names = new Map();
    for (const l of lines) {
      const p = await t.get("SELECT id, name, status FROM products WHERE id = ?", Number(l.product_id));
      if (!p || p.status !== "active") throw httpError(400, "Choose products from the list");
      want.set(key(p.id), (want.get(key(p.id)) || 0) + qty(l.qty)); names.set(key(p.id), p.name);
    }
    const pool = await poolOf(t, s.hub);
    for (const [pid, n] of want) {
      const left = Math.max(0, pool.get(pid)?.left || 0);
      if (n > left) throw httpError(409, left ? `The hub has only ${left} ${names.get(pid)} left. Ask the office to send more stock` : `The hub has no ${names.get(pid)} left. Ask the office to send more stock`);
    }
    for (const l of lines) await t.run("INSERT INTO stock_issues (date, employee_id, product_id, qty, note, created_by) VALUES (?,?,?,?,?,?)", date, s.employee_id, Number(l.product_id), qty(l.qty), note, user.username);
  }, { lockKey: "hub:" + s.hub });
  return { given: lines.length, employee_id: s.employee_id, date };
}

// Take back a line of stock that was given by mistake. Refused when the seller has already sold it.
async function takeBack(db, user, id, scopeHub) {
  const row = await db.get("SELECT i.id, i.date, i.employee_id, i.product_id, i.qty FROM stock_issues i WHERE i.id = ?", Number(id));
  if (!row) throw httpError(404, "That stock line was not found");
  const hub = (await db.get("SELECT hub FROM staff WHERE employee_id = ?", row.employee_id))?.hub;
  if (scopeHub && hub !== scopeHub) throw httpError(403, "Outside your hub");
  await withUser(db, user.username, async (t) => {
    if (await svc.isFinalized(t, row.date.slice(0, 7))) throw httpError(409, "That month is closed");
    const have = (await stockOf(t, row.employee_id, sales.today())).get(key(row.product_id))?.left || 0;
    if (have < row.qty) throw httpError(409, "The seller has already sold some of this stock, so it cannot be taken back");
    await t.run("DELETE FROM stock_issues WHERE id = ?", row.id);
  }, { lockKey: "pos:" + row.employee_id });
  return { deleted: true };
}

// What a hub holds, per product: everything the office sent minus everything its coacher gave to sellers.
async function poolOf(db, hub) {
  const got = await db.all("SELECT product_id, SUM(qty) AS n FROM hub_issues WHERE hub = ? GROUP BY product_id", hub);
  const out = await db.all("SELECT i.product_id, SUM(i.qty) AS n FROM stock_issues i JOIN staff s ON s.employee_id = i.employee_id WHERE s.hub = ? GROUP BY i.product_id", hub);
  const pool = new Map();
  const slot = (id) => pool.get(key(id)) || pool.set(key(id), { product_id: Number(id), received: 0, given: 0, left: 0 }).get(key(id));
  for (const r of got) slot(r.product_id).received += num(r.n);
  for (const r of out) slot(r.product_id).given += num(r.n);
  for (const x of pool.values()) x.left = x.received - x.given;
  return pool;
}

// The office's view: for every hub (or only the signed-in user's hub) the stock it holds and the latest stock sent to it.
async function hubSupply(db, { hub } = {}) {
  const hubs = await db.all(`SELECT code, name, status FROM hubs ${hub ? "WHERE code = ?" : ""} ORDER BY code`, ...(hub ? [hub] : []));
  const products = await db.all("SELECT id, name, list_price, status FROM products WHERE status = 'active' ORDER BY lower(name)");
  const pname = new Map((await db.all("SELECT id, name FROM products")).map((p) => [key(p.id), p.name]));
  const out = [];
  for (const h of hubs) {
    const pool = await poolOf(db, h.code);
    const recent = await db.all("SELECT id, date, product_id, qty, note, created_by FROM hub_issues WHERE hub = ? ORDER BY id DESC LIMIT 12", h.code);
    out.push({ code: h.code, name: h.name, status: h.status,
      stock: products.map((p) => { const x = pool.get(key(p.id)) || { received: 0, given: 0, left: 0 }; return { product_id: Number(p.id), product: p.name, price: num(p.list_price), received: x.received, given: x.given, left: Math.max(0, x.left) }; }),
      recent: recent.map((r) => ({ id: Number(r.id), date: r.date, product: pname.get(key(r.product_id)), qty: r.qty, note: r.note, by: r.created_by })) });
  }
  return { hubs: out };
}

// The admin sends stock to a hub. `lines` is a list of { product_id, qty }.
async function giveToHub(db, user, body) {
  const hub = await db.get("SELECT code FROM hubs WHERE code = ?", String(body.hub || ""));
  if (!hub) throw httpError(400, "Choose a hub");
  const now = sales.today();
  const date = body.date ? String(body.date) : now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw httpError(400, "date must be YYYY-MM-DD");
  if (date > now) throw httpError(400, "You cannot send stock for a day that has not happened yet");
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw httpError(400, "Add at least one product");
  const note = String(body.note || "").trim().slice(0, 200) || null;
  await withUser(db, user.username, async (t) => {
    if (await svc.isFinalized(t, date.slice(0, 7))) throw httpError(409, "That month is closed");
    for (const l of lines) {
      const p = await t.get("SELECT id, status FROM products WHERE id = ?", Number(l.product_id));
      if (!p || p.status !== "active") throw httpError(400, "Choose products from the list");
      await t.run("INSERT INTO hub_issues (date, hub, product_id, qty, note, created_by) VALUES (?,?,?,?,?,?)", date, hub.code, p.id, qty(l.qty), note, user.username);
    }
  }, { lockKey: "hub:" + hub.code });
  return { sent: lines.length, hub: hub.code, date };
}

// Take back stock sent to a hub by mistake. Refused when the coacher has already given some of it to sellers.
async function takeFromHub(db, user, id) {
  const row = await db.get("SELECT id, date, hub, product_id, qty FROM hub_issues WHERE id = ?", Number(id));
  if (!row) throw httpError(404, "That stock line was not found");
  await withUser(db, user.username, async (t) => {
    if (await svc.isFinalized(t, row.date.slice(0, 7))) throw httpError(409, "That month is closed");
    const left = (await poolOf(t, row.hub)).get(key(row.product_id))?.left || 0;
    if (left < row.qty) throw httpError(409, "Part of this stock has already been given to sellers, so it cannot be taken back");
    await t.run("DELETE FROM hub_issues WHERE id = ?", row.id);
  }, { lockKey: "hub:" + row.hub });
  return { deleted: true };
}

module.exports = { state, sell, undo, endOfDay, morning, give, takeBack, stockOf, poolOf, hubSupply, giveToHub, takeFromHub };
