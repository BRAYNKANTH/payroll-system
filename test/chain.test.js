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

test("reporting to someone equal or junior is refused; managers report to no one", async () => {
  const d = await setup();
  await add(d, "M1", "manager");
  await add(d, "S1", "supervisor", "M1");
  await assert.rejects(() => add(d, "S2", "supervisor", "S1"), /more senior/);
  await assert.rejects(() => add(d, "D1", "distributor", "D9"), /Unknown upline/);
  await assert.rejects(() => add(d, "M2", "manager", "M1"), /top of the chain/);
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
