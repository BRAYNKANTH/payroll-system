const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const reports = require("../reports");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "Colombo", name: "Colombo" }, "admin");
  await svc.createEntry(d, "hubs", { code: "Kandy", name: "Kandy" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "Manager One", role: "manager", hub: "Colombo" }, "admin");
  await svc.createEntry(d, "staff", {
    employee_id: "G1", name: "Guy One", role: "guy", hub: "Colombo", manager_id: "M1", basic_pay: 30000, target: 500000,
    commission_rate: 0.02, security_deduction_rule: "fixed:1000", bank_name: "BOC", bank_code: "7010", branch_code: "001", bank_account_no: "1111222233",
  }, "admin");
  return d;
}
const row = async (d, period, id) => (await svc.getPeriod(d, period)).rows.find((r) => r.employee_id === id);

test("run → auto-approve → finalize → opening balance carries forward", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-08-03", employee_id: "G1", business_amount: 600000, settled_amount: 600000 }, "clerk");
  await svc.createEntry(d, "weekly", { week_start: "2026-08-03", week_end: "2026-08-09", manager_id: "M1", business_total: 600000, profit_percent: 0.3, rent: 10000 }, "clerk");
  const run = await svc.runPeriod(d, "2026-08", "clerk");
  assert.equal(run.employees, 2);
  const g = await row(d, "2026-08", "G1");
  assert.equal(g.status, "auto_approved");
  assert.equal(g.net_pay, 3000000 + 200000 - 100000);
  const m = await row(d, "2026-08", "M1");
  assert.equal(m.net_pay, 18000000 - 1000000 - 9000000 - g.net_pay);

  await svc.finalizePeriod(d, "2026-08", "boss");
  await svc.createEntry(d, "weekly", { week_start: "2026-09-07", week_end: "2026-09-13", manager_id: "M1", business_total: 600000, profit_percent: 0.3 }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  assert.equal((await row(d, "2026-09", "M1")).opening_balance, m.closing_balance);
});

test("finalized period locks log entries and summaries", async () => {
  const d = await setup();
  const entry = await svc.createEntry(d, "daily", { date: "2026-08-03", employee_id: "G1", business_amount: 600000, settled_amount: 600000 }, "clerk");
  await svc.runPeriod(d, "2026-08", "clerk");
  await svc.review(d, "2026-08", "M1", "boss", "approved", "No weekly sheets this month");
  await svc.finalizePeriod(d, "2026-08", "boss");
  await assert.rejects(() => svc.updateEntry(d, "daily", entry.id, { settled_amount: 1 }, "clerk"), /finalized/);
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-08-04", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "clerk"), /finalized/);
  await assert.rejects(() => svc.deleteEntry(d, "daily", entry.id, "clerk"), /finalized/);
  await assert.rejects(() => d.exec("UPDATE pay_period_summary SET net_pay = 1 WHERE period = '2026-08'"), /finalized/);
  await assert.rejects(() => svc.runPeriod(d, "2026-08", "clerk"), /finalized/);
});

test("edits after submission are audited with user and old value", async () => {
  const d = await setup();
  const entry = await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1000, settled_amount: 1000 }, "clerk");
  await svc.updateEntry(d, "daily", entry.id, { settled_amount: 900 }, "supervisor");
  await svc.deleteEntry(d, "daily", entry.id, "manager");
  const log = await svc.auditLog(d, { table: "daily_log", key: entry.id });
  assert.equal(log.length, 2);
  const [del, upd] = log;
  assert.equal(upd.changed_by, "supervisor");
  assert.equal(JSON.parse(upd.old_value).settled_amount, 100000);
  assert.equal(JSON.parse(upd.new_value).settled_amount, 90000);
  assert.equal(JSON.parse(upd.new_value).settle_up_minus, 10000);
  assert.equal(del.action, "delete");
  assert.equal(del.changed_by, "manager");

  await d.exec("UPDATE staff SET hub = 'Kandy' WHERE employee_id = 'G1'");
  assert.equal((await svc.auditLog(d, { table: "staff", key: "G1" }))[0].changed_by, "direct-db-edit");
});

test("flagged entries need approval; bank change approval verifies the account", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1000, settled_amount: 1000 }, "clerk");
  await svc.updateEntry(d, "staff", "G1", { bank_account_no: "9999888877" }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  const g = await row(d, "2026-09", "G1");
  assert.equal(g.status, "pending_review");
  assert.deepEqual(g.flags.map((f) => f.code), ["BANK_ACCOUNT_CHANGED"]);
  await assert.rejects(() => svc.finalizePeriod(d, "2026-09", "boss"), /Resolve before finalizing: .*G1 \(pending_review\)/);
  await assert.rejects(() => svc.review(d, "2026-09", "G1", "boss", "rejected", ""), /note is required/);

  await svc.review(d, "2026-09", "G1", "boss", "approved", "Called employee, confirmed new account");
  // M1 logged no weeks, so paying G1 pushes the manager's balance negative — also flagged.
  assert.deepEqual((await row(d, "2026-09", "M1")).flags.map((f) => f.code), ["MANAGER_BALANCE_DEEPER_NEGATIVE"]);
  await svc.review(d, "2026-09", "M1", "boss", "approved", "Weekly sheets arriving late");
  assert.equal((await d.get("SELECT bank_account_verified FROM staff WHERE employee_id = 'G1'")).bank_account_verified, "9999888877");
  await svc.finalizePeriod(d, "2026-09", "boss");
  const file = await reports.bankFile(d, "2026-09");
  assert.match(file.body, /9999888877,29000\.00,SAL 2026-09/); // below target: basic 30,000 − security 1,000
});

test("approving a bank change plus other flags survives the re-run done by finalize", async () => {
  const d = await setup();
  await svc.createEntry(d, "stock", { period: "2026-09", employee_id: "G1", product: "Tyre", opening_stock: 1, counted_stock: 0, unit_price: 6000 }, "clerk");
  await svc.updateEntry(d, "staff", "G1", { bank_account_no: "9999888877" }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  assert.deepEqual((await row(d, "2026-09", "G1")).flags.map((f) => f.code).sort(), ["BANK_ACCOUNT_CHANGED", "STOCK_SHORTFALL"]);
  await svc.review(d, "2026-09", "G1", "boss", "approved", "checked");
  await svc.review(d, "2026-09", "M1", "boss", "approved", "checked");
  await svc.finalizePeriod(d, "2026-09", "boss");
  const g = await row(d, "2026-09", "G1");
  assert.equal(g.status, "approved");
  assert.deepEqual(g.flags.map((f) => f.code), ["STOCK_SHORTFALL"]);
});

test("approval is reset when a new kind of flag appears", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1000, settled_amount: 1100 }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  await svc.review(d, "2026-09", "G1", "boss", "approved", "ok");
  await svc.updateEntry(d, "staff", "G1", { bank_account_no: "5555666677" }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  assert.equal((await row(d, "2026-09", "G1")).status, "pending_review");
});

test("approval is reset when underlying numbers change", async () => {
  const d = await setup();
  const entry = await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1000, settled_amount: 1100 }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  await svc.review(d, "2026-09", "G1", "boss", "approved", "ok");
  await svc.runPeriod(d, "2026-09", "clerk");
  assert.equal((await row(d, "2026-09", "G1")).status, "approved");
  await svc.updateEntry(d, "daily", entry.id, { settled_amount: 1200 }, "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  assert.equal((await row(d, "2026-09", "G1")).status, "pending_review");
});

test("bank file requires finalized period; earlier periods must be finalized first", async () => {
  const d = await setup();
  await svc.runPeriod(d, "2026-08", "clerk");
  await svc.runPeriod(d, "2026-09", "clerk");
  await assert.rejects(() => reports.bankFile(d, "2026-09"), /Finalize/);
  await assert.rejects(() => svc.finalizePeriod(d, "2026-09", "boss"), /earlier periods first: 2026-08/);
});

test("input validation", async () => {
  const d = await setup();
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-9-1", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "c"), /YYYY-MM-DD/);
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "M1", business_amount: 1, settled_amount: 1 }, "c"), /not a guy/);
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "X", name: "X", role: "guy", hub: "Kandy", security_deduction_rule: "5%" }, "c"), /Invalid security/);
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "X", name: "X", role: "guy", hub: "Nowhere" }, "c"), /Unknown employee, manager or hub/);
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, ""), /user name/);
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "c");
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "c"), (e) => e.status === 409);
});
