// The coacher enters a seller's bill by product, for a seller who cannot use the till; and the standing daily deduction ("morning minus").
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const products = require("../products");
const pos = require("../pos");
const sales = require("../sales");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const ADMIN = { username: "admin" };
const COACH = { username: "coach1", hub: "H1" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, hub, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: "distributor", bank_account_no: "1111" + id.replace(/\D/g, "").padStart(4, "0"), ...seller, ...extra }, "admin");
  await add("D1", "H1"); await add("D2", "H1"); await add("D9", "H2");
  const shine = Number((await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin")).id);
  const vim = Number((await products.create(d, { name: "Vim", list_price: 500, cost_price: 190 }, "admin")).id);
  for (const id of [shine, vim]) await products.addStock(d, id, { qty: 1000 }, "admin");
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 200 }, { product_id: vim, qty: 200 }] });
  // stock given three days ago, so that bills for the days since are covered
  await pos.give(d, COACH, { employee_id: "D1", date: sales.addDays(sales.today(), -3), lines: [{ product_id: shine, qty: 10 }, { product_id: vim, qty: 6 }] }, "H1");
  return { d, shine, vim };
}
const yesterday = () => sales.addDays(sales.today(), -1);
const day = (d, id, date) => d.get("SELECT * FROM daily_log WHERE employee_id = ? AND date = ?", id, date);

test("the coacher enters a seller's bill: the lines, the day's business and the stock left follow", async () => {
  const { d, shine, vim } = await setup();
  const date = yesterday();
  const r = await pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 4 }, { product_id: vim, qty: 2 }], settled_amount: "4,400" });
  assert.equal(r.amount, 4 * 85000 + 2 * 50000);
  const row = await day(d, "D1", date);
  assert.deepEqual([Number(row.business_amount), Number(row.settled_amount), row.source, row.created_by], [440000, 440000, "office", "coach1"], "the office's own entry, not waiting for confirmation");
  assert.deepEqual(r.state.products.filter((p) => p.left < 99).map((p) => [p.name, p.left]), [["Shine", 6], ["Vim", 4]]);
  assert.equal(r.state.lines.length, 2);
  // a second bill the same day adds to the first
  const r2 = await pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 1 }] });
  assert.equal(r2.day_total, 440000 + 85000);
  assert.equal(Number((await day(d, "D1", date)).business_amount), 525000);
  assert.equal(Number((await day(d, "D1", date)).settled_amount), 440000, "the cash handed in stays as it was");
});

test("a bill is refused when it is more than the seller holds, for another hub, or by the office", async () => {
  const { d, shine, vim } = await setup();
  const date = yesterday();
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 4 }, { product_id: vim, qty: 7 }] }), /only has 6 Vim left/);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM sale_lines")).n, 0, "all or nothing");
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D2", date, items: [{ product_id: shine, qty: 1 }] }), /no Shine left\. Give them stock first/);
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D9", date, items: [{ product_id: shine, qty: 1 }] }), /Outside your hub/);
  await assert.rejects(() => pos.billFor(d, ADMIN, { employee_id: "D1", date, items: [{ product_id: shine, qty: 1 }] }), /coacher/);
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date, items: [] }), /at least one/);
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date: sales.addDays(sales.today(), 1), items: [{ product_id: shine, qty: 1 }] }), /not happened/);
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date: sales.addDays(sales.today(), -30), items: [{ product_id: shine, qty: 1 }] }), /14 days back/);
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 1 }], settled_amount: "5,000" }), /cannot be more than the bill/);
});

test("a day typed on the daily sheet without products is not replaced unless the coacher confirms", async () => {
  const { d, shine } = await setup();
  const date = yesterday();
  await svc.createEntry(d, "daily", { date, employee_id: "D1", business_amount: 1000, settled_amount: 1000 }, "coach1");
  await assert.rejects(() => pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 1 }] }), /REPLACE: .*Rs 1,000\.00 typed/);
  assert.equal(Number((await day(d, "D1", date)).business_amount), 100000, "nothing changed");
  const r = await pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 2 }], confirm_replace: true });
  assert.equal(r.day_total, 170000);
  assert.equal(Number((await day(d, "D1", date)).business_amount), 170000);
});

test("a line can be taken away; the day follows and an empty day disappears", async () => {
  const { d, shine, vim } = await setup();
  const date = yesterday();
  const made = await pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 2 }, { product_id: vim, qty: 1 }] });
  let st = await pos.removeBillLine(d, COACH, made.lines[1].id);
  assert.equal(Number((await day(d, "D1", date)).business_amount), 170000);
  assert.equal(st.lines.length, 1);
  await assert.rejects(() => pos.removeBillLine(d, { username: "coach2", hub: "H2" }, made.lines[0].id), /Outside your hub/);
  st = await pos.removeBillLine(d, COACH, made.lines[0].id);
  assert.equal(await day(d, "D1", date), undefined, "no sales and nothing else on the day: the row is removed");
});

test("the bill screen lists the hub's sellers and what each sold", async () => {
  const { d, shine } = await setup();
  const date = yesterday();
  await pos.billFor(d, COACH, { employee_id: "D1", date, items: [{ product_id: shine, qty: 2 }] });
  const st = await pos.billState(d, COACH, { date });
  assert.deepEqual(st.sellers.map((s) => [s.employee_id, s.business, s.by_products]), [["D1", 170000, true], ["D2", 0, false]]);
  assert.equal(st.seller, null);
  const one = await pos.billState(d, COACH, { date, employee_id: "D1" });
  assert.equal(one.seller.name, "Name D1");
  assert.equal(one.day.recorded, true);
});

test("a person's standing daily deduction is filled in as the personal minus on a new day", async () => {
  const { d, shine } = await setup();
  await svc.updateEntry(d, "staff", "D1", { daily_minus: 350 }, "admin");
  assert.equal(Number((await d.get("SELECT daily_minus FROM staff WHERE employee_id = 'D1'")).daily_minus), 35000);
  const d1 = sales.addDays(sales.today(), -5), d2 = sales.addDays(sales.today(), -6), d3 = sales.addDays(sales.today(), -7), d4 = sales.addDays(sales.today(), -1);
  // the daily sheet (one row, and a saved sheet), without a personal minus given
  await svc.createEntry(d, "daily", { date: d1, employee_id: "D1", business_amount: 5000, settled_amount: 5000 }, "clerk");
  assert.equal(Number((await day(d, "D1", d1)).personal_minus), 35000);
  await svc.bulkUpsert(d, "daily", [{ date: d2, employee_id: "D1", business_amount: 4000, settled_amount: 4000 }, { date: d3, employee_id: "D1", business_amount: 4000, settled_amount: 4000, personal_minus: 0 }], "clerk");
  assert.equal(Number((await day(d, "D1", d2)).personal_minus), 35000);
  assert.equal(Number((await day(d, "D1", d3)).personal_minus), 0, "an explicit 0 is kept: the deduction can be changed for a day");
  // the coacher's bill and the seller's own till
  await pos.billFor(d, COACH, { employee_id: "D1", date: d4, items: [{ product_id: shine, qty: 1 }] });
  assert.equal(Number((await day(d, "D1", d4)).personal_minus), 35000);
  const today = sales.today();
  const me = { username: "seller-d1", employee_id: "D1" };
  const sold = await pos.sell(d, me, { product_id: shine, qty: 1 });
  assert.equal(Number((await day(d, "D1", today)).personal_minus), 35000, "the till's new day takes it too");
  await pos.undo(d, me, sold.line.id);
  assert.equal(await day(d, "D1", today), undefined, "a day holding nothing but the standing deduction is not a day worked");
  // a person with none is unaffected
  await svc.createEntry(d, "daily", { date: d1, employee_id: "D2", business_amount: 5000, settled_amount: 5000 }, "clerk");
  assert.equal(Number((await day(d, "D2", d1)).personal_minus), 0);
});
