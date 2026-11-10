const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  return d;
}
const add = (d, id, level, upline) =>
  svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, ...(upline ? { upline_id: upline } : {}) }, "admin");

test("staff_level sets role, and the chain follows seniority", async () => {
  const d = await setup();
  const m = await add(d, "M1", "manager");
  const gm = await add(d, "GM1", "group_manager", "M1");
  const s = await add(d, "S1", "supervisor", "GM1");
  const g = await add(d, "D1", "distributor", "S1");
  assert.equal(m.role, "manager");
  assert.deepEqual([gm.role, s.role, g.role], ["guy", "guy", "guy"]);
  assert.equal(g.upline_id, "S1");
  // payroll manager is found by walking up the chain
  assert.equal(g.manager_id, "M1");
  assert.equal(s.manager_id, "M1");
});

test("reporting to someone equal or junior is refused", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "S1", "supervisor", "M1");
  await assert.rejects(() => add(d, "S2", "supervisor", "S1"), /more senior/);
  await assert.rejects(() => add(d, "D1", "distributor", "D9"), /Unknown upline/);
  await assert.rejects(() => add(d, "M2", "manager", "M1"), /more senior/);
  await assert.rejects(() => svc.updateEntry(d, "staff", "S1", { upline_id: "S1" }, "admin"), /themselves/);
});

test("legacy role-only records still work and default their level", async () => {
  const d = await setup();
  const g = await svc.createEntry(d, "staff", { employee_id: "G1", name: "G1", hub: "H1", role: "guy" }, "admin");
  const m = await svc.createEntry(d, "staff", { employee_id: "M1", name: "M1", hub: "H1", role: "manager" }, "admin");
  assert.equal(g.staff_level, "distributor");
  assert.equal(m.staff_level, "manager");
  const moved = await svc.updateEntry(d, "staff", "G1", { upline_id: "M1" }, "admin");
  assert.equal(moved.manager_id, "M1");
});

test("a go-live balance is the opening balance of the first month only", async () => {
  const d = await setup();
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "M1", hub: "H1", staff_level: "manager", opening_balance: -5000 }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "D1", name: "D1", hub: "H1", staff_level: "distributor", upline_id: "M1", target: 100000, opening_balance: -2000, bank_account_no: "11112222" }, "admin");
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "D1", business_amount: 50000, settled_amount: 46000 }, "clerk");
  await svc.runPeriod(d, "2026-09", "acct");
  const sep = (await svc.getPeriod(d, "2026-09")).rows;
  assert.equal(sep.find((r) => r.employee_id === "D1").opening_balance, -200000);
  assert.equal(sep.find((r) => r.employee_id === "M1").opening_balance, -500000);
  await svc.createEntry(d, "daily", { date: "2026-10-01", employee_id: "D1", business_amount: 50000, settled_amount: 46000 }, "clerk");
  await svc.runPeriod(d, "2026-10", "acct");
  const oct = (await svc.getPeriod(d, "2026-10")).rows.find((r) => r.employee_id === "D1");
  assert.equal(oct.opening_balance, sep.find((r) => r.employee_id === "D1").closing_balance, "later months use the previous closing, not the go-live balance");
});

test("position pay defaults are validated and stored", async () => {
  const d = await setup();
  const good = { supervisor: { pay_scheme: "tiered", target: 120000, basic_pay: 30000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 24, security_deduction_rule: "pct_business:1" } };
  const s = await svc.updateSettings(d, { position_defaults: JSON.stringify(good) }, "admin");
  assert.equal(JSON.parse(s.position_defaults).supervisor.target, 120000);
  await assert.rejects(() => svc.updateSettings(d, { position_defaults: JSON.stringify({ boss: {} }) }, "admin"), /No pay defaults/);
  await assert.rejects(() => svc.updateSettings(d, { position_defaults: JSON.stringify({ supervisor: { commission_rate: 5 } }) }, "admin"), /invalid/);
  await assert.rejects(() => svc.updateSettings(d, { position_defaults: "nope" }, "admin"), /valid JSON/);
});
