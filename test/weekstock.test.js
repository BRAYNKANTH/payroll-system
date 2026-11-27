// The hub's weekly stock sheet: opening, received each weekday, sold, expected, and what the coacher counted (missing = counted - expected).
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const products = require("../products");
const weekstock = require("../weekstock");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const COACH = { username: "coach1", hub: "H1" };
const ADMIN = { username: "admin" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "D1", name: "Name D1", hub: "H1", staff_level: "distributor", bank_account_no: "11112222", ...seller }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "D9", name: "Name D9", hub: "H2", staff_level: "distributor", bank_account_no: "11113333", ...seller }, "admin");
  const p = await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
  const q = await products.create(d, { name: "Vim", list_price: 500, cost_price: 190 }, "admin");
  const recv = (date, hub, pid, qty) => d.run("INSERT INTO hub_issues (date, hub, product_id, qty, created_by) VALUES (?,?,?,?,?)", date, hub, pid, qty, "admin");
  const sold = (date, emp, pid, qty) => d.run("INSERT INTO sale_lines (date, employee_id, product_id, qty, unit_price, amount, created_by) VALUES (?,?,?,?,?,?,?)", date, emp, pid, qty, 85000, 85000 * qty, "admin");
  return { d, shine: Number(p.id), vim: Number(q.id), recv, sold };
}
const row = (w, id) => w.products.find((x) => x.id === id);

test("a week shows the opening stock, each weekday's delivery, what was sold and what is expected", async () => {
  const { d, shine, recv, sold } = await setup();
  await recv("2026-11-03", "H1", shine, 100); await sold("2026-11-04", "D1", shine, 30);          // the week before: 70 are left
  await recv("2026-11-11", "H1", shine, 20); await recv("2026-11-13", "H1", shine, 10);            // Wednesday and Friday
  await sold("2026-11-10", "D1", shine, 15); await sold("2026-11-12", "D1", shine, 10);
  await recv("2026-11-11", "H2", shine, 500); await sold("2026-11-11", "D9", shine, 99);            // another hub does not count
  const w = await weekstock.week(d, { hub: "H1", date: "2026-11-12" });
  assert.deepEqual([w.week_start, w.week_end], ["2026-11-09", "2026-11-15"]);
  const r = row(w, shine);
  assert.deepEqual([r.opening, r.received, r.received_total, r.total, r.sold, r.expected, r.counted, r.missing], [70, [0, 0, 20, 0, 10, 0, 0], 30, 100, 25, 75, null, null]);
  assert.equal(w.totals.sold_value, 25 * 850 * 100, "sold at the selling price");
  assert.equal((await weekstock.week(d, { hub: "H1", date: "2026-11-15" })).week_start, "2026-11-09", "a Sunday is in the same week");
});

test("a count shows what is missing, valued at the selling price; an empty count is removed", async () => {
  const { d, shine, vim, recv, sold } = await setup();
  await recv("2026-11-10", "H1", shine, 100); await sold("2026-11-11", "D1", shine, 40);
  await recv("2026-11-10", "H1", vim, 50);
  assert.deepEqual(await weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", counts: [{ product_id: shine, counted: "55" }, { product_id: vim, counted: 50 }] }), { saved: 2, removed: 0 });
  let w = await weekstock.week(d, { hub: "H1", date: "2026-11-09" });
  assert.deepEqual([row(w, shine).expected, row(w, shine).counted, row(w, shine).missing, row(w, shine).missing_value], [60, 55, -5, -5 * 85000]);
  assert.equal(row(w, vim).missing, 0);
  assert.equal(w.totals.missing_value, -5 * 85000, "only what is missing is added up");
  // counting again replaces; an empty box removes the count
  await weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", counts: [{ product_id: shine, counted: 60 }, { product_id: vim, counted: "" }] });
  w = await weekstock.week(d, { hub: "H1", date: "2026-11-09" });
  assert.equal(row(w, shine).missing, 0);
  assert.equal(row(w, vim).counted, null);
});

test("counts are checked and limited to the coacher's own hub", async () => {
  const { d, shine, recv } = await setup();
  await recv("2026-11-10", "H1", shine, 10);
  await assert.rejects(() => weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", hub: "H2", counts: [{ product_id: shine, counted: 1 }] }), /own hub/);
  await assert.rejects(() => weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", counts: [{ product_id: shine, counted: "-3" }] }), /whole number/);
  await assert.rejects(() => weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", counts: [{ product_id: shine, counted: "2.5" }] }), /whole number/);
  await assert.rejects(() => weekstock.saveCounts(d, COACH, { week_start: "2026-11-09", counts: [{ product_id: 99999, counted: 1 }] }), /product/);
  await assert.rejects(() => weekstock.saveCounts(d, ADMIN, { week_start: "2026-11-09", counts: [{ product_id: shine, counted: 1 }] }), /Choose the hub/);
  await assert.rejects(() => weekstock.saveCounts(d, COACH, { week_start: "2099-01-05", counts: [{ product_id: shine, counted: 1 }] }), /not started/);
  assert.equal((await weekstock.saveCounts(d, ADMIN, { hub: "H1", week_start: "2026-11-09", counts: [{ product_id: shine, counted: 4 }] })).saved, 1);
  await assert.rejects(() => weekstock.week(d, { hub: "NOPE" }), /Choose a hub/);
});

test("products that did not move and were not counted are left off the sheet", async () => {
  const { d, shine, vim, recv } = await setup();
  await recv("2026-11-10", "H1", shine, 10);
  const w = await weekstock.week(d, { hub: "H1", date: "2026-11-10" });
  assert.deepEqual(w.products.map((x) => x.id), [shine]);
  assert.ok(!w.products.some((x) => x.id === vim));
});
