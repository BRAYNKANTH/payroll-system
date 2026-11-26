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

test("no distributor or supervisor reports straight to a promoting manager; a manager can", async () => {
  const d = await setup();
  const mk = (id, level, upline) => svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, upline_id: upline, bank_account_no: "11112222", basic_pay: 25000, ...(level === "manager" ? {} : seller) }, "owner");
  await assert.rejects(() => mk("X1", "distributor", "PA"), /not directly to a promoting manager/);
  await assert.rejects(() => mk("X2", "supervisor", "PB"), /not directly to a promoting manager/);
  await assert.rejects(() => svc.updateEntry(d, "staff", "D1", { upline_id: "PB" }, "owner"), /not directly to a promoting manager/);
  await mk("X3", "distributor", "M1");
  await mk("X4", "manager", "PB");
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
