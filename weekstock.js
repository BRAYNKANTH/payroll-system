// The hub's weekly stock sheet (the branch Excel's "stock details"): for one week, Monday to Sunday, every product the hub and its sellers hold:
//   opening   what was held when the week began   = everything the office sent the hub before the week - everything the sellers sold before it
//   received  what the office sent the hub on each day of the week
//   total     opening + received            sold  what the hub's sellers sold in the week
//   expected  total - sold                  counted  what the coacher counted at the end of the week (typed in)
//   missing   counted - expected (below zero = pieces missing), valued at the selling price
const { withUser, httpError } = require("./db");
const sales = require("./sales");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => Number(v) || 0;
const isoAdd = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// The Monday of the week a date is in.
const mondayOf = (iso) => { const dow = new Date(iso + "T00:00:00Z").getUTCDay(); return isoAdd(iso, -((dow + 6) % 7)); };

function checkWeek(raw) {
  const d = String(raw || sales.today());
  if (!DATE_RE.test(d) || isNaN(Date.parse(d))) throw httpError(400, "The date must look like 2026-11-18");
  return mondayOf(d);
}

async function week(db, { hub, date }) {
  const h = await db.get("SELECT code, name FROM hubs WHERE code = ?", String(hub || ""));
  if (!h) throw httpError(400, "Choose a hub");
  const from = checkWeek(date), to = isoAdd(from, 6), days = Array.from({ length: 7 }, (_, i) => isoAdd(from, i));
  const products = await db.all("SELECT id, name, list_price FROM products ORDER BY lower(name)");
  const by = (rows) => new Map(rows.map((r) => [String(r.product_id), num(r.n)]));
  const recBefore = by(await db.all("SELECT product_id, SUM(qty) AS n FROM hub_issues WHERE hub = ? AND date < ? GROUP BY product_id", h.code, from));
  const soldBefore = by(await db.all("SELECT l.product_id, SUM(l.qty) AS n FROM sale_lines l JOIN staff s ON s.employee_id = l.employee_id WHERE s.hub = ? AND l.date < ? GROUP BY l.product_id", h.code, from));
  const recDay = new Map();
  for (const r of await db.all("SELECT product_id, date, SUM(qty) AS n FROM hub_issues WHERE hub = ? AND date >= ? AND date <= ? GROUP BY product_id, date", h.code, from, to)) recDay.set(`${r.product_id}|${r.date}`, num(r.n));
  const soldWeek = by(await db.all("SELECT l.product_id, SUM(l.qty) AS n FROM sale_lines l JOIN staff s ON s.employee_id = l.employee_id WHERE s.hub = ? AND l.date >= ? AND l.date <= ? GROUP BY l.product_id", h.code, from, to));
  const counts = new Map((await db.all("SELECT product_id, counted FROM hub_week_counts WHERE hub = ? AND week_start = ?", h.code, from)).map((r) => [String(r.product_id), num(r.counted)]));
  const rows = [];
  for (const p of products) {
    const k = String(p.id);
    const opening = (recBefore.get(k) || 0) - (soldBefore.get(k) || 0);
    const received = days.map((d) => recDay.get(`${k}|${d}`) || 0);
    const receivedTotal = received.reduce((a, b) => a + b, 0);
    const sold = soldWeek.get(k) || 0, counted = counts.has(k) ? counts.get(k) : null;
    if (!opening && !receivedTotal && !sold && counted === null) continue; // a product that did not move and was not counted is not listed
    const total = opening + receivedTotal, expected = total - sold, price = num(p.list_price);
    const missing = counted === null ? null : counted - expected;
    rows.push({ id: Number(p.id), name: p.name, price, opening, received, received_total: receivedTotal, total, sold, expected, counted, missing, missing_value: missing === null ? null : missing * price });
  }
  const sum = (f) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  return { hub: h.code, name: h.name, week_start: from, week_end: to, days, products: rows,
    totals: { sold: sum((r) => r.sold), sold_value: sum((r) => r.sold * r.price), received: sum((r) => r.received_total), missing_value: sum((r) => (r.missing_value < 0 ? r.missing_value : 0)),
      counted_products: rows.filter((r) => r.counted !== null).length } };
}

// Save the week's counts. A count left empty removes it. The coacher saves their own hub; the admin names the hub.
async function saveCounts(db, user, body) {
  const hub = user.hub || String(body.hub || "");
  if (!hub) throw httpError(400, "Choose the hub");
  if (user.hub && body.hub && body.hub !== user.hub) throw httpError(403, "You can only count your own hub's stock");
  if (!(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", hub))) throw httpError(404, "Hub not found");
  const from = checkWeek(body.week_start);
  if (from > sales.today()) throw httpError(400, "That week has not started yet");
  const list = Array.isArray(body.counts) ? body.counts : [];
  if (!list.length) throw httpError(400, "There are no counts to save");
  return withUser(db, user.username, async (t) => {
    let saved = 0, removed = 0;
    for (const c of list) {
      const pid = Number(c.product_id);
      if (!(await t.get("SELECT 1 AS x FROM products WHERE id = ?", pid))) throw httpError(400, "Choose a product from the list");
      const raw = c.counted === null || c.counted === undefined ? "" : String(c.counted).replace(/,/g, "").trim();
      if (raw === "") { removed += (await t.run("DELETE FROM hub_week_counts WHERE hub = ? AND week_start = ? AND product_id = ?", hub, from, pid)).rowCount || 0; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 1000000) throw httpError(400, "A count must be a whole number of pieces, 0 or more");
      await t.run(`INSERT INTO hub_week_counts (hub, week_start, product_id, counted, created_by) VALUES (?,?,?,?,?)
        ON CONFLICT (hub, week_start, product_id) DO UPDATE SET counted = EXCLUDED.counted, updated_by = ?, updated_at = now_iso()`, hub, from, pid, n, user.username, user.username);
      saved++;
    }
    return { saved, removed };
  });
}

module.exports = { week, saveCounts, mondayOf };
