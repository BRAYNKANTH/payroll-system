// Cash handover: the coacher hands the day's cash to the admin (at least 90% of the day's sales); the admin approves it or sends it back.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");
const handover = require("../handover");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const COACH = { username: "coach1", hub: "H1" };
const ADMIN = { username: "admin" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, hub) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: "distributor", bank_account_no: "11112222", ...seller }, "admin");
  await add("D1", "H1"); await add("D2", "H1"); await add("D9", "H2");
  return d;
}
const sell = (d, date, id, business) => svc.createEntry(d, "daily", { date, employee_id: id, business_amount: business, settled_amount: business }, "clerk");
const today = () => sales.today();

test("only the admin approves cash; a coacher can submit but not approve", () => {
  assert.ok(auth.can({ role: "admin" }, "approve_cash"));
  assert.ok(!auth.can({ role: "coacher" }, "approve_cash") && auth.can({ role: "coacher" }, "enter_data"));
  for (const role of ["manager", "staff"]) assert.ok(!auth.can({ role }, "approve_cash"), role);
});

test("the handover must be at least 90% of the hub's sales for the day", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 60000); await sell(d, today(), "D2", 40000); // the hub sold Rs 100,000
  await sell(d, today(), "D9", 500000);                                    // another hub's sales do not count
  await assert.rejects(() => handover.submit(d, COACH, { date: today(), amount: "89999.99" }), /at least Rs 90,000\.00.*90%.*100,000\.00/);
  const ok = await handover.submit(d, COACH, { date: today(), amount: "90,000" });
  assert.equal(ok.status, "pending");
  assert.equal(ok.amount, 9000000);
  assert.equal(ok.sales, 10000000, "the day's sales are kept with the handover");
  assert.equal(ok.hub, "H1");
});

test("only a hub's coacher hands cash over, and not before sales are entered or for a future or very old day", async () => {
  const d = await setup();
  await assert.rejects(() => handover.submit(d, ADMIN, { date: today(), amount: "1000" }), /Only a hub's coacher/);
  await assert.rejects(() => handover.submit(d, COACH, { date: today(), amount: "1000" }), /No sales are entered/);
  await sell(d, today(), "D1", 10000);
  await assert.rejects(() => handover.submit(d, COACH, { date: sales.addDays(today(), 1), amount: "9000" }), /not happened yet/);
  await assert.rejects(() => handover.submit(d, COACH, { date: sales.addDays(today(), -30), amount: "9000" }), /days back/);
  await assert.rejects(() => handover.submit(d, COACH, { date: today(), amount: "" }), /Amount is required/);
  await assert.rejects(() => handover.submit(d, COACH, { date: today(), amount: "0" }), /Enter the amount/);
});

test("the admin approves or sends back; a returned handover can be corrected; an approved one is final", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 100000);
  const first = await handover.submit(d, COACH, { date: today(), amount: "90000", note: "all in the bag" });
  await assert.rejects(() => handover.verify(d, ADMIN, first.id, { approve: false }), /Say why/);
  const back = await handover.verify(d, ADMIN, first.id, { approve: false, note: "Counted Rs 85,000 only" });
  assert.deepEqual([back.status, back.verified_by, back.verify_note], ["rejected", "admin", "Counted Rs 85,000 only"]);
  await assert.rejects(() => handover.verify(d, ADMIN, first.id, { approve: true }), /already rejected/);
  // the coacher corrects it: same day, same row, back to pending with the old verdict cleared
  const again = await handover.submit(d, COACH, { date: today(), amount: "95000" });
  assert.equal(again.id, first.id);
  assert.deepEqual([again.status, again.amount, again.verified_by, again.verify_note], ["pending", 9500000, null, null]);
  const done = await handover.verify(d, ADMIN, again.id, { approve: true });
  assert.equal(done.status, "approved");
  await assert.rejects(() => handover.submit(d, COACH, { date: today(), amount: "99000" }), /already approved/);
  await assert.rejects(() => handover.verify(d, ADMIN, again.id, { approve: false, note: "x" }), /already approved/);
  await assert.rejects(() => handover.verify(d, ADMIN, 999, { approve: true }), /not found/);
});

test("the day view lists each hub with its sales and minimum; the list flags a handover the sheet has since outgrown", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 100000); await sell(d, today(), "D9", 20000);
  const sheet = await handover.day(d, { date: today() });
  assert.equal(sheet.min_percent, 90);
  assert.deepEqual(sheet.hubs.map((h) => [h.code, h.sales, h.min, h.handover]), [["H1", 10000000, 9000000, null], ["H2", 2000000, 1800000, null]]);
  assert.deepEqual((await handover.day(d, { date: today(), hub: "H2" })).hubs.map((h) => h.code), ["H2"], "a hub filter keeps to one hub");
  const sent = await handover.submit(d, COACH, { date: today(), amount: "90000" });
  assert.equal((await handover.day(d, { date: today() })).hubs[0].handover.id, sent.id);
  let rows = await handover.list(d, {});
  assert.equal(rows[0].short, false);
  await sell(d, today(), "D2", 50000); // more sales are entered after the handover: Rs 150,000 now needs Rs 135,000
  rows = await handover.list(d, { status: "pending" });
  assert.deepEqual([rows.length, rows[0].sales_now, rows[0].min_now, rows[0].short], [1, 15000000, 13500000, true]);
  assert.equal((await handover.list(d, { hub: "H2" })).length, 0, "a hub filter keeps to one hub");
});

test("a handover is in the audit trail", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 100000);
  const h = await handover.submit(d, COACH, { date: today(), amount: "90000" });
  await handover.verify(d, ADMIN, h.id, { approve: true });
  const trail = await svc.auditSearch(d, { table: "cash_handovers", key: String(h.id) });
  assert.deepEqual(trail.map((t) => t.action).sort(), ["create", "update"]);
});

test("the day shows the cash the sellers handed in, so the coacher can fill the amount in one tap", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: today(), employee_id: "D1", business_amount: 60000, settled_amount: 58000 }, "clerk");
  await sell(d, today(), "D2", 40000);
  const h = (await handover.day(d, { date: today(), hub: "H1" })).hubs[0];
  assert.equal(h.sales, 10000000);
  assert.equal(h.min, 9000000, "90% of the sales");
  assert.equal(h.cash, 9800000, "58,000 + 40,000 handed in");
});
