const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const loans = require("../loans");
const engine = require("../engine");

// G1: basic pay Rs 30,000, security Rs 1,000 a month, no sales, so net pay is Rs 29,000 before any loan.
async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "Colombo", name: "Colombo" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "Manager One", role: "manager", hub: "Colombo" }, "admin");
  await svc.createEntry(d, "staff", {
    employee_id: "G1", name: "Guy One", role: "guy", hub: "Colombo", manager_id: "M1", basic_pay: 30000, target: 500000,
    commission_rate: 0.02, security_deduction_rule: "fixed:1000", bank_name: "BOC", bank_code: "7010", branch_code: "001", bank_account_no: "1111222233",
  }, "admin");
  return d;
}
const row = async (d, period, id) => (await svc.getPeriod(d, period)).rows.find((r) => r.employee_id === id);
async function close(d, period) {
  await svc.runPeriod(d, period, "accounts");
  for (const r of (await svc.getPeriod(d, period)).rows) {
    if (r.status === "pending_review") await svc.review(d, period, r.employee_id, "boss", "approved", "checked");
  }
  await svc.finalizePeriod(d, period, "boss");
}
const give = (d, body) => loans.create(d, { employee_id: "G1", kind: "loan", amount: 30000, instalment: 10000, start_period: "2026-08", ...body }, "accounts");

test("engine: the instalment comes off pay and is itemised", () => {
  const staff = { basic_pay: 3000000, target: 50000000, commission_rate: 0.02, security_deduction_rule: "none" };
  const r = engine.computeGuy({ staff, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0,
    loans: [{ id: 7, kind: "loan", planned: 1000000, outstanding: 3000000 }] });
  assert.equal(r.total_deductions, 1000000);
  assert.equal(r.net_pay, 2000000);
  assert.equal(r.detail.loans[0].outstanding_after, 2000000);
  assert.match(r.detail.deductions.at(-1).label, /^Loan instalment \(balance after: Rs 20,000\.00\)$/);
});

test("engine: an instalment bigger than the pay left is cut back and never makes pay negative", () => {
  const staff = { basic_pay: 3000000, target: 50000000, commission_rate: 0.02, security_deduction_rule: "fixed:1000" };
  const r = engine.computeGuy({ staff, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0,
    loans: [{ id: 1, kind: "loan", planned: 4000000, outstanding: 5000000 }, { id: 2, kind: "advance", planned: 500000, outstanding: 500000 }] });
  assert.equal(r.net_pay, 0);                                  // 30,000 − 1,000 security − 29,000 taken
  assert.equal(r.detail.loans[0].amount, 2900000);
  assert.equal(r.detail.loans[0].outstanding_after, 2100000);  // the rest stays on the loan
  assert.equal(r.detail.loans[1].amount, 0);                   // nothing left for the second one
  assert.match(r.detail.deductions.find((x) => x.key === "loan").label, /only Rs 29,000\.00 of Rs 40,000\.00 could be taken/);
});

test("engine: no loans leaves the result exactly as before", () => {
  const staff = { basic_pay: 3000000, target: 50000000, commission_rate: 0.02, security_deduction_rule: "none" };
  const r = engine.computeGuy({ staff, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  assert.equal("loans" in r.detail, false);
  assert.equal(r.detail.deductions.some((d) => d.key === "loan"), false);
});

test("a loan is taken one instalment a month until it is paid off", async () => {
  const d = await setup();
  await give(d, {});
  await close(d, "2026-08");
  const aug = await row(d, "2026-08", "G1");
  assert.equal(aug.net_pay, 3000000 - 100000 - 1000000);
  let [l] = await loans.list(d, { period: "2026-09" });
  assert.equal(l.repaid, 1000000);
  assert.equal(l.outstanding, 2000000);
  assert.equal(l.due, 1000000);

  await close(d, "2026-09");
  await close(d, "2026-10");
  [l] = await loans.list(d, { period: "2026-11" });
  assert.equal(l.outstanding, 0);
  assert.equal(l.state, "paid");
  assert.equal(l.due, 0);

  await svc.runPeriod(d, "2026-11", "accounts");
  assert.equal((await row(d, "2026-11", "G1")).net_pay, 3000000 - 100000); // nothing more is taken
});

test("running the month again does not take the instalment twice", async () => {
  const d = await setup();
  await give(d, {});
  await svc.runPeriod(d, "2026-08", "accounts");
  await svc.runPeriod(d, "2026-08", "accounts");
  assert.equal((await row(d, "2026-08", "G1")).net_pay, 3000000 - 100000 - 1000000);
  assert.equal((await d.all("SELECT * FROM loan_repayments")).length, 1);
  // Until the month is final the balance has not moved.
  assert.equal((await loans.list(d, { period: "2026-08" }))[0].outstanding, 3000000);
});

test("an advance comes back in one go, and the last instalment is only what is left", async () => {
  const d = await setup();
  const adv = await loans.create(d, { employee_id: "G1", kind: "advance", amount: 5000, start_period: "2026-08" }, "accounts");
  assert.equal(adv.instalment, 500000);
  await give(d, { amount: 25000, instalment: 10000, start_period: "2026-09" });
  await close(d, "2026-08");
  await close(d, "2026-09");
  await close(d, "2026-10");
  await svc.runPeriod(d, "2026-11", "accounts");
  const l = await loans.list(d, { period: "2026-11" });
  const loan = l.find((x) => x.kind === "loan");
  assert.deepEqual(loan.repayments.map((r) => r.amount), [1000000, 1000000, 500000]);
  assert.equal(loan.repaid, 2000000); // Sep and Oct are final; Nov is still open
  assert.equal(loan.outstanding, 500000);
  assert.equal(loan.due, 500000);     // the last instalment is Rs 5,000, not Rs 10,000
  assert.equal(l.find((x) => x.kind === "advance").state, "paid");
});

test("an old loan brought over from Excel starts with what was already repaid", async () => {
  const d = await setup();
  const l = await give(d, { amount: 50000, instalment: 10000, already_repaid: 35000 });
  assert.equal(l.already_repaid, 3500000);
  const [x] = await loans.list(d, { period: "2026-08" });
  assert.equal(x.outstanding, 1500000);
  assert.equal(x.due, 1000000);
});

test("a stopped loan stops coming off pay, and can be resumed", async () => {
  const d = await setup();
  const l = await give(d, {});
  await loans.update(d, l.id, { status: "stopped" }, "accounts");
  await svc.runPeriod(d, "2026-08", "accounts");
  assert.equal((await row(d, "2026-08", "G1")).net_pay, 3000000 - 100000);
  assert.equal((await loans.list(d, {}))[0].state, "stopped");
  await loans.update(d, l.id, { status: "active" }, "accounts");
  await svc.runPeriod(d, "2026-08", "accounts");
  assert.equal((await row(d, "2026-08", "G1")).net_pay, 3000000 - 100000 - 1000000);
});

test("a loan that starts later is not taken before its first month", async () => {
  const d = await setup();
  await give(d, { start_period: "2026-10" });
  await svc.runPeriod(d, "2026-08", "accounts");
  assert.equal((await row(d, "2026-08", "G1")).net_pay, 3000000 - 100000);
});

test("rules for who can get one and what can be changed", async () => {
  const d = await setup();
  await assert.rejects(() => loans.create(d, { employee_id: "M1", kind: "loan", amount: 1000, instalment: 100, start_period: "2026-08" }, "a"), /distributors, supervisors/);
  await assert.rejects(() => give(d, { amount: 0 }), /more than zero/);
  await assert.rejects(() => give(d, { instalment: 40000 }), /cannot be more than the loan/);
  await assert.rejects(() => give(d, { already_repaid: 30000 }), /nothing left/);
  await assert.rejects(() => give(d, { employee_id: "NOPE" }), /Choose an employee/);
  await assert.rejects(() => give(d, { kind: "gift" }), /advance or loan/);
  await assert.rejects(() => loans.create(d, { employee_id: "G1", kind: "loan", amount: 1000, instalment: 100, start_period: "2026-08" }, "a", "Kandy"), /only manage loans for staff of hub Kandy/);

  const l = await give(d, {});
  await close(d, "2026-08");
  await assert.rejects(() => give(d, { start_period: "2026-08" }), /already finalized/);
  await assert.rejects(() => loans.update(d, l.id, { amount: 99999 }, "a"), /cannot change/);
  await assert.rejects(() => loans.remove(d, l.id, "a"), /cannot be deleted/);
  // The month's repayment row is locked with the month.
  await assert.rejects(() => d.exec("UPDATE loan_repayments SET amount = 1"), /finalized/);
  await assert.rejects(() => d.exec("DELETE FROM loan_repayments"), /finalized/);

  const fresh = await give(d, { amount: 1000, instalment: 500, start_period: "2026-09" });
  assert.deepEqual(await loans.remove(d, fresh.id, "a"), { deleted: true });
});

test("changes to a loan are in the audit trail", async () => {
  const d = await setup();
  const l = await give(d, {});
  await loans.update(d, l.id, { instalment: 5000 }, "accounts");
  const log = await svc.auditLog(d, { table: "loans", key: l.id });
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0].old_value).instalment, 1000000);
  assert.equal(JSON.parse(log[0].new_value).instalment, 500000);
});

test("the staff portal shows the person's own loans and the instalment in their estimate", async () => {
  const d = await setup();
  await give(d, { note: "internal: asked twice" });
  await svc.createEntry(d, "daily", { date: "2026-08-03", employee_id: "G1", business_amount: 1000, settled_amount: 1000 }, "clerk");
  const portal = require("../portal");
  const s = await portal.summary(d, { employee_id: "G1" }, "2026-08");
  assert.equal(s.loans.length, 1);
  assert.equal(s.loans[0].outstanding, 3000000);
  assert.equal(s.loans[0].due, 1000000);
  assert.equal("note" in s.loans[0], false); // office notes stay private
  assert.ok(s.estimate.deduction_lines.some((l) => /^Loan instalment/.test(l.label) && l.amount === 1000000));
});
