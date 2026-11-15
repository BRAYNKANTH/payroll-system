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

async function list(db) {
  const settings = await getSettings(db);
  const rows = await db.all("SELECT * FROM products ORDER BY (status = 'active') DESC, lower(name)");
  return rows.map((p) => ({ ...p, ...economics(p.list_price, p.cost_price, settings) }));
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

module.exports = { list, create, update, profitReport, economics };
