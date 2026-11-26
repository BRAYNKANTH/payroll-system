// Promoting managers are a ladder: one can sit under another. A promoting manager earns the senior share (0.55%) on the groups of the managers
// directly under them (the manager's own sales plus everyone under that manager), never twice on the same group. No seller reports straight to one.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: "password-12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "owner");
  const add = (id, level, upline, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: level, upline_id: upline, bank_account_no: "11112222", basic_pay: 29000, ...extra }, "owner");
  await add("C1", "coacher", undefined, { basic_pay: 30000 });
  await add("PA", "promoting_manager", "C1");
  await add("PB", "promoting_manager", "PA");              // a promoting manager under a promoting manager
  await add("M1", "manager", "PB", { basic_pay: 27000, target: 100000 });
  await add("M2", "manager", "PA", { basic_pay: 27000, target: 100000 });
  await add("D1", "distributor", "M1", seller);
  await add("D2", "distributor", "M2", seller);
  const sale = (id, business) => svc.createEntry(d, "daily", { date: "2026-09-02", employee_id: id, business_amount: business, settled_amount: business }, "owner");
  await sale("M1", 100000); await sale("D1", 900000);       // M1's group: Rs 1,000,000
  await sale("M2", 50000); await sale("D2", 150000);        // M2's group: Rs 200,000
  return d;
}
const gross = async (d, id) => Number((await d.get("SELECT gross_earnings FROM pay_period_summary WHERE employee_id = ? AND period = '2026-09'", id)).gross_earnings);

test("a promoting manager can sit under another, but nobody can end up above themselves", async () => {
  const d = await setup();
  assert.equal((await d.get("SELECT upline_id FROM staff WHERE employee_id = 'PB'")).upline_id, "PA", "the ladder is allowed");
  await assert.rejects(() => svc.updateEntry(d, "staff", "PA", { upline_id: "PB" }, "owner"), /above themselves/, "A under B under A is a loop");
  await assert.rejects(() => svc.updateEntry(d, "staff", "C1", { upline_id: "PB" }, "owner"), /more senior|above themselves/, "nobody sits above the coacher");
  // a promoting manager is still never under a manager
  await assert.rejects(() => svc.updateEntry(d, "staff", "PB", { upline_id: "M1" }, "owner"), /more senior/);
});

test("a promoting manager is also a manager of his own sellers: he earns the manager commission on them and on his own sales, plus the share", async () => {
  const d = await setup();
  const mk = (id, level, upline) => svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, upline_id: upline, bank_account_no: "11112222", basic_pay: 25000, ...(level === "manager" ? {} : seller) }, "owner");
  await mk("X1", "distributor", "PA");   // his own seller
  await mk("X2", "supervisor", "PB");
  await mk("X3", "distributor", "M1");
  await mk("X4", "manager", "PB");
  assert.equal((await d.get("SELECT manager_id FROM staff WHERE employee_id = 'X1'")).manager_id, "PA", "a seller straight under a promoting manager belongs to him");
  assert.equal((await d.get("SELECT manager_id FROM staff WHERE employee_id = 'X3'")).manager_id, "M1", "a seller under a manager belongs to that manager");
  // week of Monday 7 Sept: his seller sells Rs 500,000 and he sells Rs 100,000 himself
  await svc.createEntry(d, "daily", { date: "2026-09-08", employee_id: "X1", business_amount: 500000, settled_amount: 500000 }, "owner");
  await svc.createEntry(d, "daily", { date: "2026-09-09", employee_id: "PA", business_amount: 100000, settled_amount: 100000 }, "owner");
  await svc.runPeriod(d, "2026-09", "owner");
  // weekly commission 20% of Rs 600,000 (the week reached his Rs 100,000 target) + own sales 25% of Rs 100,000 + basic Rs 29,000 + share 0.55% of M2's group Rs 200,000
  assert.equal(await gross(d, "PA"), 12000000 + 2500000 + 2900000 + 110000);
  const detail = JSON.parse((await d.get("SELECT detail FROM pay_period_summary WHERE employee_id = 'PA' AND period = '2026-09'")).detail);
  assert.deepEqual(detail.earnings.map((e) => e.amount), [12000000, 2500000, 110000, 2900000]);
  assert.ok(detail.deductions.find((x) => x.key === "rent").amount > 0, "he pays the weekly rent and hub fee like a manager");
  assert.match(detail.earnings[2].label, /your managers' groups/);
  assert.equal(await gross(d, "PB"), 2900000 + 550000, "PB is unchanged: his group is M1's alone");
});

test("a manager is promoted first, then a manager goes under him; a position change cannot strand the people under it", async () => {
  const d = await setup();
  const mk = (id, level, upline) => svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, upline_id: upline, bank_account_no: "11112222", basic_pay: 27000, ...(level === "manager" ? { target: 100000 } : seller) }, "owner");
  // M2 has a seller, D2. D2 brings a new team and becomes a manager: M2 must be a promoting manager first.
  await assert.rejects(() => svc.updateEntry(d, "staff", "D2", { staff_level: "manager", upline_id: "M2" }, "owner"), /make Name M2 a promoting manager first/);
  await svc.updateEntry(d, "staff", "M2", { staff_level: "promoting_manager" }, "owner"); // D2 stays directly under him
  await svc.updateEntry(d, "staff", "D2", { staff_level: "manager", target: 100000 }, "owner");
  assert.equal((await d.get("SELECT upline_id, staff_level FROM staff WHERE employee_id = 'D2'")).staff_level, "manager");
  await mk("N1", "distributor", "D2");
  // PB has a manager (M1) under him: he cannot be turned back into a manager while that manager reports to him
  await assert.rejects(() => svc.updateEntry(d, "staff", "PB", { staff_level: "manager" }, "owner"), /no longer be above them/);
});

test("each promoting manager earns 0.55% on the groups of the managers directly under them, and no group is paid twice", async () => {
  const d = await setup();
  await svc.runPeriod(d, "2026-09", "owner");
  // PB: M1's group, Rs 1,000,000 -> Rs 5,500. PA: only M2's group, Rs 200,000 -> Rs 1,100. M1's group is not paid to PA as well.
  assert.equal(await gross(d, "PB"), 2900000 + 550000, "basic 29,000 + 0.55% of 1,000,000");
  assert.equal(await gross(d, "PA"), 2900000 + 110000, "basic 29,000 + 0.55% of 200,000 (M2 only)");
  // the coacher is unchanged: 0.55% of everything below, Rs 1,200,000
  assert.equal(await gross(d, "C1"), 3000000 + 660000);
  const line = JSON.parse((await d.get("SELECT detail FROM pay_period_summary WHERE employee_id = 'PA' AND period = '2026-09'")).detail).earnings[1];
  assert.match(line.label, /your managers' groups/);
});
