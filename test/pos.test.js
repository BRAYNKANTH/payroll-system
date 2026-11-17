// Selling like a till: stock given in the morning, one record per sale, never more than the seller has, and the day's total follows.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const products = require("../products");
const pos = require("../pos");
const sales = require("../sales");

const ADMIN = { username: "admin" };
async function setup({ hubStock = true } = {}) {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, hub, level = "distributor") => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: level, basic_pay: 30000, target: 100000, commission_rate: 0.3, bank_account_no: "1111" + id.replace(/\D/g, "").padStart(4, "0") }, "admin");
  await add("D1", "H1"); await add("D2", "H2"); await add("D3", "H1");
  await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
  await products.create(d, { name: "Vim", list_price: 500, cost_price: 190 }, "admin");
  const shine = (await d.get("SELECT id FROM products WHERE name = 'Shine'")).id;
  const vim = (await d.get("SELECT id FROM products WHERE name = 'Vim'")).id;
  if (hubStock) for (const hub of ["H1", "H2"]) await pos.giveToHub(d, ADMIN, { hub, lines: [{ product_id: Number(shine), qty: 1000 }, { product_id: Number(vim), qty: 1000 }] });
  const seller = { username: "seller-d1", employee_id: "D1" };
  const hubHead = { username: "head-h1", hub: "H1" };
  return { d, shine: Number(shine), vim: Number(vim), seller, hubHead };
}
const give = (d, who, body, hub) => pos.give(d, who, body, hub);

test("a seller cannot sell what they were not given, and the message says what to do", async () => {
  const { d, shine, seller } = await setup();
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 1 }), /no Shine left. Ask your hub for more stock/);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM sale_lines")).n, 0);
});

test("the hub gives stock; each sale is its own record at the list price; the day's total follows", async () => {
  const { d, shine, vim, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 5 }, { product_id: vim, qty: 3 }] }, "H1");
  let s = await pos.state(d, seller);
  assert.deepEqual(s.products.map((p) => [p.name, p.issued, p.left]), [["Shine", 5, 5], ["Vim", 3, 3]]);
  const r = await pos.sell(d, seller, { product_id: shine, qty: 2 });
  assert.equal(r.line.amount, 170000, "2 x Rs 850 in cents");
  await pos.sell(d, seller, { product_id: vim, qty: 1 });
  s = await pos.state(d, seller);
  assert.equal(s.lines.length, 2);
  assert.equal(s.totals.amount, 170000 + 50000);
  assert.deepEqual(s.products.map((p) => [p.name, p.sold, p.left]), [["Shine", 2, 3], ["Vim", 1, 2]]);
  const row = await d.get("SELECT business_amount, settled_amount, source FROM daily_log WHERE employee_id = 'D1'");
  assert.deepEqual([Number(row.business_amount), Number(row.settled_amount), row.source], [220000, 0, "portal"]);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM daily_log WHERE employee_id = 'D1'")).n, 1, "one day row, however many sales");
});

test("selling more than is left is refused; the rest of the stock stays", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 3 }] }, "H1");
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 4 }), /only have 3 Shine left/);
  await pos.sell(d, seller, { product_id: shine, qty: 3 });
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 1 }), /no Shine left/);
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 0 }), /whole number/);
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 1.5 }), /whole number/);
  await assert.rejects(() => pos.sell(d, seller, { product_id: 99999, qty: 1 }), /Choose a product/);
});

test("undoing a sale returns the stock, and a day with no sales left disappears so it earns no food allowance", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 4 }] }, "H1");
  const a = await pos.sell(d, seller, { product_id: shine, qty: 1 });
  const b = await pos.sell(d, seller, { product_id: shine, qty: 2 });
  let s = await pos.undo(d, seller, b.line.id);
  assert.equal(s.products[0].left, 3);
  assert.equal(Number((await d.get("SELECT business_amount FROM daily_log WHERE employee_id = 'D1'")).business_amount), 85000);
  s = await pos.undo(d, seller, a.line.id);
  assert.equal(s.products[0].left, 4);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM daily_log WHERE employee_id = 'D1'")).n, 0);
  await assert.rejects(() => pos.undo(d, seller, a.line.id), /not found/);
  // another seller's sale cannot be undone
  await give(d, ADMIN, { employee_id: "D3", lines: [{ product_id: shine, qty: 2 }] });
  const other = await pos.sell(d, { username: "seller-d3", employee_id: "D3" }, { product_id: shine, qty: 1 });
  await assert.rejects(() => pos.undo(d, seller, other.line.id), /not found/);
});

test("the money handed in is entered at the end of the day, and only after a sale", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await assert.rejects(() => pos.endOfDay(d, seller, { settled_amount: 100 }), /Record a sale first/);
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 2 }] }, "H1");
  await pos.sell(d, seller, { product_id: shine, qty: 2 });
  let s = await pos.state(d, seller);
  assert.equal(s.day.not_handed_in, 170000);
  s = await pos.endOfDay(d, seller, { settled_amount: "1,500", personal_minus: "100" });
  assert.deepEqual([s.day.settled, s.day.personal, s.day.not_handed_in], [150000, 10000, 20000]);
  const row = await d.get("SELECT settle_up_minus FROM daily_log WHERE employee_id = 'D1'");
  assert.equal(Number(row.settle_up_minus), 20000, "the shortfall is what pay uses");
  await assert.rejects(() => pos.endOfDay(d, seller, { settled_amount: "-5" }), /must be a number/);
});

test("a day the office recorded or confirmed cannot be changed by selling or undoing", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 5 }] }, "H1");
  const a = await pos.sell(d, seller, { product_id: shine, qty: 1 });
  await sales.confirm(d, { username: "head-h1" }, { all: true, period: sales.today().slice(0, 7) }, "H1");
  await assert.rejects(() => pos.sell(d, seller, { product_id: shine, qty: 1 }), /already recorded today/);
  await assert.rejects(() => pos.undo(d, seller, a.line.id), /already recorded today/);
  const s = await pos.state(d, seller);
  assert.equal(s.locked, true);
  assert.ok(s.lines.every((l) => !l.can_undo));
  // a day typed in by the office is also theirs
  await svc.createEntry(d, "daily", { date: sales.today(), employee_id: "D3", business_amount: 1000, settled_amount: 1000 }, "admin");
  await give(d, ADMIN, { employee_id: "D3", lines: [{ product_id: shine, qty: 2 }] });
  await assert.rejects(() => pos.sell(d, { username: "s3", employee_id: "D3" }, { product_id: shine, qty: 1 }), /already recorded today/);
});

test("what is left carries over to the next day, and the morning screen shows it", async () => {
  const { d, shine, vim, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 5 }, { product_id: vim, qty: 2 }] }, "H1");
  await pos.sell(d, seller, { product_id: shine, qty: 2 });
  const tomorrow = sales.addDays(sales.today(), 1);
  const m = await pos.morning(d, { date: tomorrow, hub: "H1" });
  const d1 = m.sellers.find((x) => x.employee_id === "D1");
  assert.deepEqual(d1.carried.map((c) => [c.product, c.qty]).sort(), [["Shine", 3], ["Vim", 2]]);
  assert.deepEqual(m.sellers.map((x) => x.employee_id).sort(), ["D1", "D3"], "only this hub's sellers");
  const today = await pos.morning(d, { date: sales.today(), hub: "H1" });
  assert.equal(today.sellers.find((x) => x.employee_id === "D1").given.length, 2);
  assert.equal(today.sellers.find((x) => x.employee_id === "D1").sold_pieces, 2);
});

test("a hub head gives stock only inside their own hub; stock given by mistake can be taken back until it is sold", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await assert.rejects(() => give(d, hubHead, { employee_id: "D2", lines: [{ product_id: shine, qty: 1 }] }, "H1"), /Outside your hub/);
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", lines: [] }, "H1"), /Add at least one product/);
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", date: sales.addDays(sales.today(), 1), lines: [{ product_id: shine, qty: 1 }] }, "H1"), /not happened yet/);
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 0 }] }, "H1"), /whole number/);
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 3 }] }, "H1");
  await give(d, ADMIN, { employee_id: "D2", lines: [{ product_id: shine, qty: 1 }] });
  const issue = await d.get("SELECT id FROM stock_issues WHERE employee_id = 'D1'");
  await pos.sell(d, seller, { product_id: shine, qty: 2 });
  await assert.rejects(() => pos.takeBack(d, hubHead, issue.id, "H1"), /already sold/);
  const other = await d.get("SELECT id FROM stock_issues WHERE employee_id = 'D2'");
  await assert.rejects(() => pos.takeBack(d, hubHead, other.id, "H1"), /Outside your hub/);
  await pos.takeBack(d, ADMIN, other.id, null);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM stock_issues WHERE employee_id = 'D2'")).n, 0);
});

test("only people who sell can use the till", async () => {
  const { d } = await setup();
  await svc.createEntry(d, "staff", { employee_id: "C1", name: "Coacher", hub: "H1", staff_level: "coacher", basic_pay: 30000 }, "admin");
  await assert.rejects(() => pos.state(d, { username: "coach", employee_id: "C1" }), /Only distributors, supervisors and managers/);
  await assert.rejects(() => pos.state(d, { username: "office", employee_id: null }), /not linked/);
});

test("sales and stock changes are written to the audit trail", async () => {
  const { d, shine, seller, hubHead } = await setup();
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 2 }] }, "H1");
  await pos.sell(d, seller, { product_id: shine, qty: 1 });
  const rows = await d.all("SELECT table_name, action, changed_by FROM audit_log WHERE table_name IN ('stock_issues','sale_lines') ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.table_name, r.action, r.changed_by]), [["stock_issues", "create", "head-h1"], ["sale_lines", "create", "seller-d1"]]);
});

test("the flow: the office sends stock to a hub, then the coacher can give out only what the hub holds", async () => {
  const { d, shine, hubHead } = await setup({ hubStock: false });
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 1 }] }, "H1"), /The hub has no Shine left. Ask the office to send more stock/);
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 10 }], note: "Monday delivery" });
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 6 }] }, "H1");
  await assert.rejects(() => give(d, hubHead, { employee_id: "D3", lines: [{ product_id: shine, qty: 6 }] }, "H1"), /only 4 Shine left/);
  await give(d, hubHead, { employee_id: "D3", lines: [{ product_id: shine, qty: 4 }] }, "H1");
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 1 }] }, "H1"), /no Shine left/);
  // one request cannot slip past the limit by splitting a product over two lines
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 5 }] });
  await assert.rejects(() => give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 3 }, { product_id: shine, qty: 3 }] }, "H1"), /only 5 Shine left/);
  const supply = await pos.hubSupply(d, { hub: "H1" });
  const row = supply.hubs[0].stock.find((x) => x.product === "Shine");
  assert.deepEqual([row.received, row.given, row.left], [15, 10, 5]);
  assert.equal(supply.hubs[0].recent.length, 2);
  assert.equal(supply.hubs[0].recent[1].note, "Monday delivery");
});

test("each hub has its own stock: H1's stock cannot be given to a seller in H2", async () => {
  const { d, shine } = await setup({ hubStock: false });
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 50 }] });
  await assert.rejects(() => give(d, ADMIN, { employee_id: "D2", lines: [{ product_id: shine, qty: 1 }] }), /The hub has no Shine left/);
  await give(d, ADMIN, { employee_id: "D1", lines: [{ product_id: shine, qty: 1 }] });
  const all = await pos.hubSupply(d, {});
  assert.deepEqual(all.hubs.map((h) => [h.code, h.stock[0].left]), [["H1", 49], ["H2", 0]]);
});

test("stock taken back from a seller returns to the hub; stock sent to a hub can be withdrawn only while it is unused", async () => {
  const { d, shine, hubHead } = await setup({ hubStock: false });
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 10 }] });
  const mine = await d.get("SELECT id FROM hub_issues WHERE hub = 'H1'");
  await give(d, hubHead, { employee_id: "D1", lines: [{ product_id: shine, qty: 7 }] }, "H1");
  await assert.rejects(() => pos.takeFromHub(d, ADMIN, mine.id), /already been given to sellers/);
  const issue = await d.get("SELECT id FROM stock_issues WHERE employee_id = 'D1'");
  await pos.takeBack(d, hubHead, issue.id, "H1");
  assert.equal((await pos.hubSupply(d, { hub: "H1" })).hubs[0].stock[0].left, 10, "the seller's stock went back to the hub");
  await pos.takeFromHub(d, ADMIN, mine.id);
  assert.equal((await pos.hubSupply(d, { hub: "H1" })).hubs[0].stock[0].left, 0);
});

test("the morning screen shows what the hub holds, and the office's input is checked", async () => {
  const { d, shine, vim } = await setup({ hubStock: false });
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 12 }] });
  const m = await pos.morning(d, { date: sales.today(), hub: "H1" });
  assert.deepEqual(m.pools.H1.map((p) => [p.product, p.left]), [["Shine", 12], ["Vim", 0]]);
  // the admin's overview: every hub with its coacher, instead of every seller
  await svc.createEntry(d, "staff", { employee_id: "C1", name: "Head One", hub: "H1", staff_level: "coacher", basic_pay: 30000 }, "admin");
  await give(d, ADMIN, { employee_id: "D1", lines: [{ product_id: shine, qty: 4 }] });
  const all = await pos.morning(d, { date: sales.today() });
  const h1 = all.hubs.find((h) => h.code === "H1"), h2 = all.hubs.find((h) => h.code === "H2");
  assert.deepEqual([h1.coacher?.name, h1.sellers, h1.given_pieces, h1.without_stock], ["Head One", 2, 4, 1]);
  assert.deepEqual([h2.coacher, h2.sellers, h2.given_pieces], [null, 1, 0], "a hub with no coacher says so");
  assert.deepEqual(all.pools.H2.map((p) => [p.product, p.left]), [["Shine", 0], ["Vim", 0]]);
  await assert.rejects(() => pos.giveToHub(d, ADMIN, { hub: "NOPE", lines: [{ product_id: shine, qty: 1 }] }), /Choose a hub/);
  await assert.rejects(() => pos.giveToHub(d, ADMIN, { hub: "H1", lines: [] }), /at least one product/);
  await assert.rejects(() => pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: vim, qty: 0 }] }), /whole number/);
  await assert.rejects(() => pos.giveToHub(d, ADMIN, { hub: "H1", date: sales.addDays(sales.today(), 1), lines: [{ product_id: vim, qty: 1 }] }), /not happened yet/);
  await assert.rejects(() => pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: 9999, qty: 1 }] }), /Choose products/);
  const rows = await d.all("SELECT table_name, action, changed_by FROM audit_log WHERE table_name = 'hub_issues'");
  assert.deepEqual(rows.map((r) => [r.table_name, r.action, r.changed_by]), [["hub_issues", "create", "admin"]]);
});

test("giving to several sellers at once: one save, all or nothing, capped by what the hub holds in total", async () => {
  const { d, shine, hubHead } = await setup({ hubStock: false });
  await pos.giveToHub(d, ADMIN, { hub: "H1", lines: [{ product_id: shine, qty: 10 }] });
  const rows = (a, b) => [{ employee_id: "D1", lines: [{ product_id: shine, qty: a }] }, { employee_id: "D3", lines: [{ product_id: shine, qty: b }] }];
  // 6 + 6 is more than the hub's 10 even though each alone fits: nothing is saved
  await assert.rejects(() => pos.giveMany(d, hubHead, { rows: rows(6, 6) }, "H1"), /only 10 Shine left/);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM stock_issues")).n, 0);
  const r = await pos.giveMany(d, hubHead, { rows: rows(6, 4) }, "H1");
  assert.equal(r.sellers, 2);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM stock_issues")).n, 2);
  // a seller of another hub is refused, again with nothing saved
  await assert.rejects(() => pos.giveMany(d, hubHead, { rows: [{ employee_id: "D2", lines: [{ product_id: shine, qty: 1 }] }] }, "H1"));
  const m = await pos.morning(d, { date: sales.today(), hub: "H1" });
  assert.ok(m.sellers.every((s) => s.team && s.team.id));
});
