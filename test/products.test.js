// Products and their profit after the workers' 45%, and people who leave or come back.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const products = require("../products");
const people = require("../people");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  return d;
}
const add = (d, id, level, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, ...extra }, "admin");

test("only the admin may manage products", () => {
  assert.ok(auth.can({ role: "admin" }, "manage_products"));
  for (const role of ["coacher", "manager", "staff"]) assert.ok(!auth.can({ role }, "manage_products"), role);
});

test("a product shows the workers' 45% and the profit left after the purchase price", async () => {
  const d = await setup();
  const p = await products.create(d, { name: "Shine", list_price: 1000, cost_price: 300 }, "admin");
  assert.deepEqual([p.list_price, p.cost_price, p.status], [100000, 30000, "active"]);
  const [row] = await products.list(d);
  assert.equal(row.seller_share, 25000);     // 25% of Rs 1,000
  assert.equal(row.manager_share, 20000);    // 20%
  assert.equal(row.workers_share, 45000);
  assert.equal(row.company_share, 55000);    // the company keeps 55%
  assert.equal(row.profit, 25000);           // 550 − 300 purchase price
  assert.equal(row.margin, 0.25);
  // a purchase price above the company's 55% is a loss, and is shown as one
  await products.update(d, p.id, { cost_price: 600 }, "admin");
  assert.equal((await products.list(d))[0].profit, -5000);
  // the shares come from Settings
  await svc.updateSettings(d, { product_seller_share: 0.2, product_manager_share: 0.1 }, "admin");
  assert.equal((await products.list(d))[0].workers_share, 30000);
});

test("product rules: a name, a selling price above 0, one product per name, and every price change is audited", async () => {
  const d = await setup();
  const p = await products.create(d, { name: "Vim", list_price: 500, cost_price: 200 }, "admin");
  await assert.rejects(() => products.create(d, { name: " ", list_price: 500, cost_price: 200 }, "admin"), /Name is required/);
  await assert.rejects(() => products.create(d, { name: "Zero", list_price: 0, cost_price: 1 }, "admin"), /above 0/);
  await assert.rejects(() => products.create(d, { name: "Neg", list_price: 5, cost_price: -1 }, "admin"), /Purchase price/);
  await assert.rejects(() => products.create(d, { name: "vim", list_price: 500, cost_price: 200 }, "admin"), /already exists/);
  await assert.rejects(() => products.update(d, p.id, { name: "VIM", status: "weird" }, "admin"), /Invalid status/);
  await assert.rejects(() => products.update(d, 999, { name: "x" }, "admin"), /not found/);
  await products.update(d, p.id, { cost_price: 250, status: "inactive" }, "accounts");
  const log = (await svc.auditSearch(d, { table: "products" })).filter((l) => l.action === "update");
  assert.equal(log.length, 1);
  assert.equal(log[0].changed_by, "accounts");
  assert.equal(JSON.parse(log[0].old_value).cost_price, 20000);
  assert.equal(JSON.parse(log[0].new_value).cost_price, 25000);
});

test("the monthly profit uses what was sold, the catalogue's purchase prices and the workers' share", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "D1", "distributor", { upline_id: "M1" });
  await products.create(d, { name: "Shine", list_price: 1000, cost_price: 300 }, "admin");
  const stock = (product, sold) => svc.createEntry(d, "stock", { period: "2026-10", employee_id: "D1", product, opening_stock: 50, sold, counted_stock: 50 - sold, unit_price: 1000 }, "admin");
  await stock("shine", 10);                                   // matches "Shine" whatever the case
  await stock("Mystery", 4);                                  // not in the catalogue
  const r = await products.profitReport(d, "2026-10");
  const shine = r.rows.find((x) => x.product === "shine");
  assert.deepEqual([shine.qty, shine.revenue, shine.workers, shine.cost, shine.profit], [10, 1000000, 450000, 300000, 250000]);
  const mystery = r.rows.find((x) => x.product === "Mystery");
  assert.deepEqual([mystery.matched, mystery.cost, mystery.profit], [false, null, null]);
  assert.equal(r.totals.profit, 250000);
  assert.equal(r.totals.unmatched, 1);
  assert.equal(r.workers_rate, 0.45);
  await assert.rejects(() => products.profitReport(d, "2026-13"), /Invalid period/);
});

test("someone leaves: their team moves to a replacement with the same position, and nothing is deleted", async () => {
  const d = await setup();
  await add(d, "C1", "coacher");
  await add(d, "C2", "coacher");                                  // the new coacher for the branch
  await add(d, "PM1", "promoting_manager", { upline_id: "C1" });
  await add(d, "M1", "manager", { upline_id: "PM1" });
  await add(d, "D1", "distributor", { upline_id: "M1" });

  await assert.rejects(() => people.leave(d, "C1", { leave_date: "2026-11-10" }, "admin"), /Choose who they move to/);
  await assert.rejects(() => people.leave(d, "C1", { leave_date: "2026-11-10", replacement_id: "PM1" }, "admin"), /also be a coacher/);
  await assert.rejects(() => people.leave(d, "C1", { leave_date: "10/11/2026", replacement_id: "C2" }, "admin"), /YYYY-MM-DD/);
  const out = await people.leave(d, "C1", { leave_date: "2026-11-10", reason: "Resigned", replacement_id: "C2" }, "admin");
  assert.deepEqual([out.moved, out.replacement], [1, "C2"]);
  const rows = Object.fromEntries((await svc.listEntries(d, "staff")).map((s) => [s.employee_id, s]));
  assert.deepEqual([rows.C1.status, rows.C1.leave_date, rows.C1.leave_reason], ["inactive", "2026-11-10", "Resigned"]);
  assert.equal(rows.PM1.upline_id, "C2");
  await assert.rejects(() => people.leave(d, "C1", { leave_date: "2026-11-11" }, "admin"), /already left/);

  // a manager's sellers move with him, and their payroll manager changes
  await add(d, "M2", "manager", { upline_id: "PM1" });
  await people.leave(d, "M1", { leave_date: "2026-11-12", replacement_id: "M2" }, "admin");
  const d1 = (await svc.listEntries(d, "staff")).find((s) => s.employee_id === "D1");
  assert.deepEqual([d1.upline_id, d1.manager_id], ["M2", "M2"]);
  // someone with nobody under them just leaves
  const solo = await people.leave(d, "D1", { leave_date: "2026-11-13" }, "admin");
  assert.equal(solo.moved, 0);
});

test("a hub manager can mark their own sellers as left, but not a manager or another hub's people", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "D1", "distributor", { upline_id: "M1" });
  await svc.createEntry(d, "staff", { employee_id: "D9", name: "D9", hub: "H2", staff_level: "distributor" }, "admin");
  await assert.rejects(() => people.leave(d, "M1", { leave_date: "2026-11-10", replacement_id: "M1" }, "mgr", "H1"), /cannot change managers/);
  await assert.rejects(() => people.leave(d, "D9", { leave_date: "2026-11-10" }, "mgr", "H1"), /cannot change managers or other hubs/);
  assert.equal((await people.leave(d, "D1", { leave_date: "2026-11-10" }, "mgr", "H1")).employee_id, "D1");
});

test("someone who comes back is re-hired with a new join date", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "D1", "distributor", { upline_id: "M1", join_date: "2025-01-01" });
  await assert.rejects(() => people.rehire(d, "D1", { join_date: "2026-11-20" }, "admin"), /already active/);
  await people.leave(d, "D1", { leave_date: "2026-10-31", reason: "Moved away" }, "admin");
  await assert.rejects(() => people.rehire(d, "D1", { join_date: "2026-10-01" }, "admin"), /before they left/);
  await people.rehire(d, "D1", { join_date: "2026-11-20" }, "admin");
  const s = (await svc.listEntries(d, "staff")).find((x) => x.employee_id === "D1");
  assert.deepEqual([s.status, s.join_date, s.leave_date, s.leave_reason], ["active", "2026-11-20", null, null]);
  // the history of both changes is in the audit trail
  assert.ok((await svc.auditSearch(d, { table: "staff", key: "D1" })).length >= 2);
  // if the person they reported to has left meanwhile, they must be given a new one first
  await people.leave(d, "D1", { leave_date: "2026-11-25" }, "admin");
  await add(d, "M3", "manager");
  await people.leave(d, "M1", { leave_date: "2026-11-26" }, "admin");
  await assert.rejects(() => people.rehire(d, "D1", { join_date: "2026-12-01" }, "admin"), /has left/);
});

test("days before someone joined and after they left are not counted as missing", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "D1", "distributor", { upline_id: "M1", join_date: "2026-10-20" });
  await add(d, "D2", "distributor", { upline_id: "M1", join_date: "2026-10-01" });
  const dash = await svc.dashboard(d, "2026-10");
  const c = Object.fromEntries(dash.completeness.map((x) => [x.employee_id, x]));
  assert.ok(c.D2.expected >= 24, "everyone else is expected on every working day");
  assert.ok(c.D1.expected < c.D2.expected);
  assert.ok(c.D1.missing.every((day) => day >= "2026-10-20"));
});

test("the stock sheets get active product names and selling prices, never the purchase price", async () => {
  const d = await setup();
  await products.create(d, { name: "Vim", list_price: 500, cost_price: 200 }, "admin");
  const old = await products.create(d, { name: "Old soap", list_price: 100, cost_price: 50 }, "admin");
  await products.update(d, old.id, { status: "inactive" }, "admin");
  await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
  assert.deepEqual(await products.names(d), [{ name: "Shine", list_price: 85000 }, { name: "Vim", list_price: 50000 }]);
  for (const role of ["admin", "coacher"]) assert.ok(auth.can({ role }, "enter_data"), role);
});

test("an unused product can be deleted with its office stock; a sold or sent one cannot", async () => {
  const d = await setup();
  const a = await products.create(d, { name: "Unused", list_price: 500, cost_price: 200 }, "admin");
  await products.addStock(d, a.id, { qty: 10 }, "admin");
  assert.deepEqual(await products.remove(d, a.id, "admin"), { deleted: true });
  assert.equal((await products.list(d)).length, 0);
  const b = await products.create(d, { name: "Sent", list_price: 500, cost_price: 200 }, "admin");
  await products.addStock(d, b.id, { qty: 10 }, "admin");
  await d.run("INSERT INTO hub_issues (date, hub, product_id, qty, created_by) VALUES ('2026-11-01','H1',?,2,'admin')", b.id);
  await assert.rejects(() => products.remove(d, b.id, "admin"), /Inactive/);
  await assert.rejects(() => products.remove(d, 99999, "admin"), /not found/);
});
