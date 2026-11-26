// Products: what the company sells, what it pays to buy each one, and the profit that is left after the workers' share.
//
// Of every sale the company pays workers at most 45%: 25% to the seller and 20% to his manager (settings product_seller_share and
// product_manager_share). What remains is the company's, and the product's cost price comes out of that:
//   profit per unit = list price − workers' share − cost price.
// The cost price is the purchase price: change it when the company buys at a new price. Every change is in the audit trail.
const { withUser, getSettings, httpError } = require("./db");

const NOW = "now_iso()";
const STATUSES = ["active", "inactive"];

function rupees(name, raw, { min = 0 } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") throw httpError(400, `${name} is required`);
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < min) throw httpError(400, `${name} must be a number${min > 0 ? " above 0" : ""}`);
  return Math.round(n * 100);
}

// Money split of one unit sold at `price`, with the product's `cost`, all in cents.
function economics(price, cost, settings) {
  const seller = Math.round(price * Number(settings.product_seller_share));
  const manager = Math.round(price * Number(settings.product_manager_share));
  const workers = seller + manager;
  const company = price - workers;
  const profit = company - cost;
  return { seller_share: seller, manager_share: manager, workers_share: workers, company_share: company, profit, margin: price ? profit / price : 0 };
}

// What the office holds of each product: everything received minus everything sent to hubs. `db` can be a transaction.
async function officeStock(db) {
  const rows = await db.all(`SELECT p.id,
    COALESCE((SELECT SUM(qty) FROM product_receipts r WHERE r.product_id = p.id), 0)::bigint AS received,
    COALESCE((SELECT SUM(qty) FROM hub_issues h WHERE h.product_id = p.id), 0)::bigint AS sent FROM products p`);
  return new Map(rows.map((r) => [String(r.id), { received: Number(r.received), sent: Number(r.sent), left: Number(r.received) - Number(r.sent) }]));
}

async function list(db) {
  const settings = await getSettings(db);
  const rows = await db.all("SELECT * FROM products ORDER BY (status = 'active') DESC, lower(name)");
  const office = await officeStock(db);
  return rows.map((p) => { const o = office.get(String(p.id)) || { received: 0, sent: 0, left: 0 }; return { ...p, ...economics(p.list_price, p.cost_price, settings), office_stock: o.left, received: o.received, sent: o.sent }; });
}

const slToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// The office receives stock of a product (the date is today unless another day, not in the future, is given).
async function addStock(db, id, body, user) {
  const p = await db.get("SELECT id, name FROM products WHERE id = ?", Number(id));
  if (!p) throw httpError(404, "Product not found");
  const qty = Number(String(body.qty ?? "").replace(/,/g, ""));
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) throw httpError(400, "Enter how many pieces were added, as a whole number");
  const today = slToday();
  const date = body.date ? String(body.date) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw httpError(400, "The date must look like 2026-11-18");
  if (date > today) throw httpError(400, "You cannot add stock for a day that has not happened yet");
  const note = String(body.note || "").trim().slice(0, 200) || null;
  await withUser(db, user, (t) => t.run("INSERT INTO product_receipts (date, product_id, qty, note, created_by) VALUES (?,?,?,?,?)", date, p.id, qty, note, user));
  const o = (await officeStock(db)).get(String(p.id));
  return { product: p.name, added: qty, date, office_stock: o.left };
}

// A product's office stock and its latest additions.
async function stockHistory(db, id) {
  const p = await db.get("SELECT id, name FROM products WHERE id = ?", Number(id));
  if (!p) throw httpError(404, "Product not found");
  const o = (await officeStock(db)).get(String(p.id));
  const rows = await db.all("SELECT id, date, qty, note, created_by FROM product_receipts WHERE product_id = ? ORDER BY date DESC, id DESC LIMIT 15", p.id);
  return { product: p.name, ...o, receipts: rows.map((r) => ({ id: Number(r.id), date: r.date, qty: r.qty, note: r.note, by: r.created_by })) };
}

// Take back a line added by mistake. Refused when part of it has already been sent to hubs.
async function removeStock(db, rid, user) {
  const r = await db.get("SELECT id, product_id, qty FROM product_receipts WHERE id = ?", Number(rid));
  if (!r) throw httpError(404, "That stock line was not found");
  await withUser(db, user, async (t) => {
    const left = (await officeStock(t)).get(String(r.product_id))?.left || 0;
    if (left < r.qty) throw httpError(409, "Part of this stock has already been sent to hubs, so it cannot be removed");
    await t.run("DELETE FROM product_receipts WHERE id = ?", r.id);
  }, { lockKey: "office-stock" });
  return { deleted: true };
}

// Active product names and selling prices for the stock sheets. Anyone who enters data may see these; the purchase price and profit stay admin-only.
async function names(db) {
  return db.all("SELECT name, list_price FROM products WHERE status = 'active' ORDER BY lower(name)");
}

function cleanName(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name.length > 80) throw httpError(400, "Name is required (up to 80 characters)");
  return name;
}

const dupe = (err) => (err.code === "23505" ? httpError(409, "A product with that name already exists") : err);

async function create(db, body, user) {
  const row = { name: cleanName(body.name), list_price: rupees("Selling price", body.list_price, { min: 0.01 }), cost_price: rupees("Purchase price", body.cost_price),
    status: STATUSES.includes(body.status) ? body.status : "active" };
  try {
    return await withUser(db, user, (t) => t.get(`INSERT INTO products (name, list_price, cost_price, status, created_by) VALUES (?,?,?,?,?) RETURNING *`,
      row.name, row.list_price, row.cost_price, row.status, user));
  } catch (err) { throw dupe(err); }
}

async function update(db, id, body, user) {
  const existing = await db.get("SELECT * FROM products WHERE id = ?", Number(id));
  if (!existing) throw httpError(404, "Product not found");
  const set = {};
  if (body.name !== undefined) set.name = cleanName(body.name);
  if (body.list_price !== undefined) set.list_price = rupees("Selling price", body.list_price, { min: 0.01 });
  if (body.cost_price !== undefined) set.cost_price = rupees("Purchase price", body.cost_price);
  if (body.status !== undefined) { if (!STATUSES.includes(body.status)) throw httpError(400, "Invalid status"); set.status = body.status; }
  const cols = Object.keys(set).filter((c) => set[c] !== existing[c]);
  if (!cols.length) return existing;
  try {
    return await withUser(db, user, (t) => t.get(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE id = ? RETURNING *`,
      ...cols.map((c) => set[c]), user, existing.id));
  } catch (err) { throw dupe(err); }
}

// Delete a product that was never used. Once it has been sent to a hub, given to a seller or sold it must stay in the history,
// so it can only be made inactive. Stock the office received for it (and nothing else) goes with it.
async function remove(db, id, user) {
  const p = await db.get("SELECT id, name FROM products WHERE id = ?", Number(id));
  if (!p) throw httpError(404, "Product not found");
  await withUser(db, user, async (t) => {
    for (const [table, what] of [["hub_issues", "sent to a hub"], ["stock_issues", "given to a seller"], ["sale_lines", "sold"]]) {
      if (await t.get(`SELECT 1 AS x FROM ${table} WHERE product_id = ? LIMIT 1`, p.id)) throw httpError(409, `${p.name} has already been ${what}, so it cannot be deleted. Set it to Inactive instead.`);
    }
    await t.run("DELETE FROM product_receipts WHERE product_id = ?", p.id);
    await t.run("DELETE FROM products WHERE id = ?", p.id);
  }, { lockKey: "office-stock" });
  return { deleted: true };
}

// The company's profit for a month, from what was sold (the stock counts: sold × unit price) and the catalogue's cost prices.
// A stock line is matched to a product by name; lines with no matching product are listed with no cost, so the gap is visible.
async function profitReport(db, period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || "")) throw httpError(400, `Invalid period "${period}" (expected YYYY-MM)`);
  const settings = await getSettings(db);
  const share = Number(settings.product_seller_share) + Number(settings.product_manager_share);
  const sold = await db.all(`SELECT product, SUM(sold)::bigint AS qty, SUM(sold * unit_price)::bigint AS revenue FROM stock_recon
    WHERE period = ? AND sold > 0 GROUP BY product ORDER BY product`, period);
  const catalogue = new Map((await db.all("SELECT name, cost_price FROM products")).map((p) => [p.name.toLowerCase(), p.cost_price]));
  const rows = sold.map((r) => {
    const cost = catalogue.get(String(r.product).toLowerCase());
    const matched = cost !== undefined;
    const workers = Math.round(Number(r.revenue) * share);
    const costTotal = matched ? Number(r.qty) * cost : null;
    return { product: r.product, qty: Number(r.qty), revenue: Number(r.revenue), workers, cost_price: matched ? cost : null, cost: costTotal,
      profit: matched ? Number(r.revenue) - workers - costTotal : null, matched };
  });
  const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  return { period, workers_rate: share, rows, totals: { revenue: sum("revenue"), workers: sum("workers"), cost: sum("cost"), profit: sum("profit"), unmatched: rows.filter((r) => !r.matched).length } };
}

module.exports = { list, names, create, update, remove, profitReport, economics, officeStock, addStock, stockHistory, removeStock };
