// The batched saves, month ranges and slim lists keep the same results as the one-at-a-time versions.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "M1", hub: "H1", staff_level: "manager", bank_account_no: "55550001" }, "admin");
  for (const [id, hub] of [["D1", "H1"], ["D2", "H1"], ["D3", "H2"]]) {
    await svc.createEntry(d, "staff", { employee_id: id, name: id, hub, staff_level: "distributor", upline_id: hub === "H1" ? "M1" : undefined, bank_account_no: "1111" + id.slice(1).padStart(4, "0"),
      basic_pay: 25000, target: 100000, commission_rate: 0.3, pay_scheme: "tiered", base_commission_rate: 0.25, security_deduction_rule: "pct_business:1" }, "admin");
  }
  return d;
}
const day = (date, id, b, s = b) => ({ date, employee_id: id, business_amount: b, settled_amount: s });

test("a bulk save creates, updates, leaves alone and deletes in one go, with the same counts and an audit row per change", async () => {
  const d = await setup();
  const first = await svc.bulkUpsert(d, "daily", [day("2026-10-01", "D1", 1000), day("2026-10-01", "D2", 2000), day("2026-10-02", "D1", 3000)], "admin");
  assert.deepEqual(first, { created: 3, updated: 0, unchanged: 0, deleted: 0 });
  const second = await svc.bulkUpsert(d, "daily", [
    day("2026-10-01", "D1", 1000),                  // same
    day("2026-10-01", "D2", 2500, 2400),            // changed
    day("2026-10-02", "D1", 3000, 2900),            // changed
    { date: "2026-10-03", employee_id: "D2", _delete: true }, // nothing to delete
    day("2026-10-03", "D1", 500),                   // new
  ], "admin");
  assert.deepEqual(second, { created: 1, updated: 2, unchanged: 1, deleted: 0 });
  const all = await svc.listEntries(d, "daily", { period: "2026-10" });
  assert.equal(all.length, 4);
  assert.equal(all.find((r) => r.date === "2026-10-01" && r.employee_id === "D2").business_amount, 250000);
  assert.equal(all.find((r) => r.date === "2026-10-02").settle_up_minus, 10000, "the generated column follows the update");
  const log = await svc.auditSearch(d, { table: "daily_log" });
  assert.equal(log.filter((l) => l.action === "update").length, 2);
  const third = await svc.bulkUpsert(d, "daily", [{ date: "2026-10-03", employee_id: "D1", _delete: true }, day("2026-10-01", "D1", 1000)], "admin");
  assert.deepEqual(third, { created: 0, updated: 0, unchanged: 1, deleted: 1 });
  // the same key twice: the last one wins and nothing is duplicated
  const twice = await svc.bulkUpsert(d, "daily", [day("2026-10-09", "D1", 100), day("2026-10-09", "D1", 200)], "admin");
  assert.equal(twice.created, 1);
  assert.equal((await svc.listEntries(d, "daily", { from: "2026-10-09", to: "2026-10-09" }))[0].business_amount, 20000);
});

test("a bulk save by a hub user is refused for another hub's people, and nothing is written", async () => {
  const d = await setup();
  await assert.rejects(() => svc.bulkUpsert(d, "daily", [day("2026-10-01", "D1", 1000), day("2026-10-01", "D3", 1000)], "mgr", "H1"), /hub H1/);
  assert.equal((await svc.listEntries(d, "daily", {})).length, 0);
  await svc.bulkUpsert(d, "daily", [day("2026-10-01", "D3", 1000)], "admin");
  await assert.rejects(() => svc.bulkUpsert(d, "daily", [{ date: "2026-10-01", employee_id: "D3", _delete: true }], "mgr", "H1"), /hub H1/);
});

test("month filters include the first and last day and exclude the neighbouring months", async () => {
  const d = await setup();
  await svc.bulkUpsert(d, "daily", [day("2026-09-30", "D1", 100), day("2026-10-01", "D1", 200), day("2026-10-31", "D1", 300), day("2026-11-01", "D1", 400)], "admin");
  const oct = await svc.listEntries(d, "daily", { period: "2026-10" });
  assert.deepEqual(oct.map((r) => r.date), ["2026-10-01", "2026-10-31"]);
  await svc.runPeriod(d, "2026-10", "admin");
  const row = (await svc.getPeriod(d, "2026-10")).rows.find((r) => r.employee_id === "D1");
  assert.equal(row.detail.total_business, 50000, "only October's two days are counted");
  const dash = await svc.dashboard(d, "2026-10");
  assert.equal(dash.kpis.guys_business, 50000);
  const dec = await svc.listEntries(d, "daily", { period: "2026-12" });
  assert.equal(dec.length, 0);
});

test("security held is a plain column that matches the working and carries into later months", async () => {
  const d = await setup();
  await svc.bulkUpsert(d, "daily", [day("2026-09-10", "D1", 200000), day("2026-10-10", "D1", 100000)], "admin");
  await svc.runPeriod(d, "2026-09", "admin");
  for (const r of (await svc.getPeriod(d, "2026-09")).rows.filter((x) => x.status === "pending_review")) await svc.review(d, "2026-09", r.employee_id, "admin", "approved", "ok");
  await svc.finalizePeriod(d, "2026-09", "admin");
  const col = await d.get("SELECT security_held, detail FROM pay_period_summary WHERE employee_id = 'D1' AND period = '2026-09'");
  assert.equal(Number(col.security_held), JSON.parse(col.detail).security_deducted);
  assert.equal(Number(col.security_held), 200000 * 100 * 0.01);
  await svc.runPeriod(d, "2026-10", "admin");
  const oct = (await svc.getPeriod(d, "2026-10")).rows.find((r) => r.employee_id === "D1");
  assert.equal(oct.opening_balance, (await d.get("SELECT closing_balance FROM pay_period_summary WHERE employee_id = 'D1' AND period = '2026-09'")).closing_balance);
});

test("the slim payroll list leaves out the working, and one person's working can be fetched on its own", async () => {
  const d = await setup();
  await svc.bulkUpsert(d, "daily", [day("2026-10-01", "D1", 150000), day("2026-10-01", "D3", 150000)], "admin");
  await svc.runPeriod(d, "2026-10", "admin");
  const slim = await svc.getPeriod(d, "2026-10", { detail: false });
  const full = await svc.getPeriod(d, "2026-10");
  assert.equal(slim.rows.length, full.rows.length);
  assert.ok(slim.rows.every((r) => r.detail === undefined && r.net_pay !== undefined && Array.isArray(r.flags)));
  assert.ok(full.rows.every((r) => r.detail && r.detail.earnings));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length / 2);
  const one = await svc.getPeriodRow(d, "2026-10", "D1");
  assert.deepEqual(one.detail, full.rows.find((r) => r.employee_id === "D1").detail);
  await assert.rejects(() => svc.getPeriodRow(d, "2026-10", "D3", "H1"), /No payroll row/, "another hub's person is hidden");
  await assert.rejects(() => svc.getPeriodRow(d, "2026-10", "NOBODY"), /No payroll row/);
});

test("calculating a larger month saves everyone and is repeatable", async () => {
  const d = await setup();
  await d.exec(`INSERT INTO staff (employee_id, name, role, hub, staff_level, upline_id, manager_id, basic_pay, target, commission_rate, pay_scheme, base_commission_rate, security_deduction_rule, bank_account_no, bank_account_verified, created_by)
    SELECT 'X' || i, 'X' || i, 'guy', 'H1', 'distributor', 'M1', 'M1', 2500000, 10000000, 0.3, 'tiered', 0.25, 'pct_business:1', (20000000 + i)::text, (20000000 + i)::text, 'seed' FROM generate_series(1, 450) i`);
  await d.exec(`INSERT INTO daily_log (date, employee_id, business_amount, settled_amount, created_by)
    SELECT '2026-10-' || lpad(day::text, 2, '0'), 'X' || i, 400000, 380000, 'seed' FROM generate_series(1, 450) i, generate_series(1, 5) day`);
  const a = await svc.runPeriod(d, "2026-10", "admin");
  assert.equal(a.employees, 450 + 1 + 3, "all sales staff, the manager and the three earlier people");
  const b = await svc.runPeriod(d, "2026-10", "admin");
  assert.equal(b.employees, a.employees);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM pay_period_summary WHERE period = '2026-10'")).n, a.employees);
});
