// Salary payments: what was actually paid for a month, in parts, by cash, cheque or bank; recorded also after the month is closed.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");
const payments = require("../payments");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const ADMIN = { username: "admin" };
const P = "2026-10";

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, hub) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: "distributor", bank_account_no: "11112222", ...seller }, "admin");
  await add("D1", "H1"); await add("D2", "H1"); await add("D3", "H2");
  for (const id of ["D1", "D2", "D3"]) await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: id, business_amount: 80000, settled_amount: 80000 }, "admin");
  await svc.runPeriod(d, P, "admin");
  return d;
}
const row = async (d, id) => (await svc.getPeriod(d, P, { detail: false })).rows.find((r) => r.employee_id === id);

test("a salary is pending, then part paid, then paid as payments are recorded", async () => {
  const d = await setup();
  let r = await row(d, "D1");
  const salary = Number(r.disbursed_amount);
  assert.ok(salary > 0);
  assert.deepEqual([r.paid, r.pay_status], [0, "pending"]);
  await payments.record(d, ADMIN, P, { employee_id: "D1", amount: salary / 100 / 2, method: "cheque", note: "Cheque 4471" });
  r = await row(d, "D1");
  assert.deepEqual([r.paid, r.pay_status], [salary / 2, "part"]);
  await payments.record(d, ADMIN, P, { employee_id: "D1", amount: salary / 100 / 2, method: "cash" });
  r = await row(d, "D1");
  assert.deepEqual([r.paid, r.pay_status], [salary, "paid"]);
  assert.equal((await svc.getPeriodRow(d, P, "D1")).pay_status, "paid");
  const list = await payments.list(d, P);
  assert.deepEqual(list.map((x) => x.method).sort(), ["cash", "cheque"]);
});

test("more than what is still to pay is refused, and so are bad entries", async () => {
  const d = await setup();
  const salary = Number((await row(d, "D1")).disbursed_amount);
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "D1", amount: salary / 100 + 1 }), /still to pay/);
  await payments.record(d, ADMIN, P, { employee_id: "D1", amount: salary / 100 });
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "D1", amount: 1 }), /already paid in full/);
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "D2", amount: 0 }), /above 0/);
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "D2", amount: 100, method: "gift" }), /cash, cheque/);
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "D2", amount: 100, paid_on: sales.addDays(sales.today(), 1) }), /future/);
  await assert.rejects(() => payments.record(d, ADMIN, P, { employee_id: "NOBODY", amount: 100 }), /no salary worked out/);
});

test("mark everyone as paid pays what is left, and a removed payment makes it pending again", async () => {
  const d = await setup();
  const d1 = Number((await row(d, "D1")).disbursed_amount);
  await payments.record(d, ADMIN, P, { employee_id: "D1", amount: d1 / 100 / 4 });
  const r = await payments.payMany(d, ADMIN, P, { method: "bank", note: "November run" });
  assert.equal(r.paid_people, 3);
  assert.equal(r.amount, d1 * 3 - d1 / 4, "D1 had a quarter paid");
  for (const id of ["D1", "D2", "D3"]) assert.equal((await row(d, id)).pay_status, "paid");
  assert.deepEqual(await payments.payMany(d, ADMIN, P, {}), { paid_people: 0, amount: 0 }, "nothing left to pay");
  const one = (await payments.list(d, P)).find((x) => x.employee_id === "D2");
  await payments.remove(d, ADMIN, one.id);
  assert.equal((await row(d, "D2")).pay_status, "pending");
  // only the chosen people
  const some = await payments.payMany(d, ADMIN, P, { employee_ids: ["D2"] });
  assert.equal(some.paid_people, 1);
});

test("payments can be recorded after the month is closed, and a hub user sees only their hub's payments", async () => {
  const d = await setup();
  await svc.finalizePeriod(d, P, "admin");
  await payments.record(d, ADMIN, P, { employee_id: "D1", amount: 100 });
  await payments.record(d, ADMIN, P, { employee_id: "D3", amount: 100 });
  assert.equal((await payments.list(d, P)).length, 2);
  assert.deepEqual((await payments.list(d, P, "H2")).map((x) => x.employee_id), ["D3"]);
});

test("the dashboard counts salaries still waiting to be paid in full", async () => {
  const d = await setup();
  assert.equal((await svc.dashboard(d, P, undefined)).kpis.unpaid, 3);
  await payments.payMany(d, ADMIN, P, { employee_ids: ["D1", "D2"] });
  assert.equal((await svc.dashboard(d, P, undefined)).kpis.unpaid, 1);
});

test("only the admin records payments; payments are in the audit trail", async () => {
  assert.ok(auth.can({ role: "admin" }, "run_payroll"));
  for (const role of ["coacher", "manager", "staff"]) assert.ok(!auth.can({ role }, "run_payroll"), role);
  const d = await setup();
  const p = await payments.record(d, ADMIN, P, { employee_id: "D1", amount: 500 });
  const log = await svc.auditSearch(d, { table: "salary_payments", key: String(p.id) });
  assert.equal(log.length, 1);
});
