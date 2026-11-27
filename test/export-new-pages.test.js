// The cash book, the "handed in less" list, the weekly stock sheet and the salary payments can be downloaded as Excel and as PDF.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");
const products = require("../products");
const exporter = require("../export");
const cashbook = require("../cashbook");
const payments = require("../payments");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const COACH = { username: "coach1", hub: "H1" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "D1", name: "Name D1", hub: "H1", staff_level: "distributor", bank_account_no: "11112222", ...seller }, "admin");
  const p = Number((await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin")).id);
  await d.run("INSERT INTO hub_issues (date, hub, product_id, qty, created_by) VALUES (?,?,?,?,?)", sales.today(), "H1", p, 50, "admin");
  const t = sales.today();
  await svc.createEntry(d, "daily", { date: t, employee_id: "D1", business_amount: 60000, settled_amount: 50000 }, "clerk");
  await cashbook.add(d, COACH, { kind: "expense", category: "Cards", amount: 850 });
  await svc.runPeriod(d, t.slice(0, 7), "admin");
  await payments.record(d, { username: "admin" }, t.slice(0, 7), { employee_id: "D1", amount: 100, method: "cheque", note: "Cheque 12" });
  return { d, period: t.slice(0, 7) };
}
const make = (d, name, format, extra = {}) => exporter.make(d, name, format, { can: () => true, query: new URLSearchParams(extra.query || ""), ...extra });

test("the new pages download as Excel and PDF, with the right rows", async () => {
  const { d, period } = await setup();
  const cases = [
    ["cashbook", { hub: "H1", period }, /^cashbook-/], ["cashbook", { period }, /^cashbook-/],
    ["gave-less", { hub: "H1", period }, /^gave-less-/], ["week-stock", { hub: "H1", period }, /^week-stock/], ["salary-payments", { period }, /^salary-payments-/],
  ];
  for (const [name, extra, file] of cases) {
    const x = await make(d, name, "xlsx", extra), p = await make(d, name, "pdf", extra);
    assert.equal(x.data.slice(0, 2).toString(), "PK", `${name} xlsx is a zip`);
    assert.equal(p.data.slice(0, 4).toString(), "%PDF", `${name} pdf`);
    assert.match(x.filename, file);
  }
  const m = await exporter.REPORTS.cashbook({ db: d, period, hub: "H1" });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0][2], 5000000, "cash from sellers");
  assert.equal(m.rows[0][4], 85000, "spent");
  const all = await exporter.REPORTS.cashbook({ db: d, period, hub: "" });
  assert.equal(all.rows[0][0], "Hub 1");
  const less = await exporter.REPORTS["gave-less"]({ db: d, period, hub: "H1" });
  assert.deepEqual(less.rows.map((r) => [r[1], r[6]]), [["D1", 1000000]]);
  const w = await exporter.REPORTS["week-stock"]({ db: d, hub: "H1", q: new URLSearchParams() });
  assert.equal(w.rows[0][0], "Shine");
  const pay = await exporter.REPORTS["salary-payments"]({ db: d, period });
  assert.deepEqual(pay.rows.map((r) => [r[1], r[4], r[5], r[6]]), [["D1", "cheque", 10000, "Cheque 12"]]);
  assert.equal((await exporter.REPORTS["gave-less"]({ db: d, period })).rows.length, 1, "with no hub, every hub is listed");
  assert.equal((await exporter.REPORTS["week-stock"]({ db: d, q: new URLSearchParams() })).rows.length, 0, "no hub: an empty sheet that says to choose one");
  await assert.rejects(() => exporter.make(d, "salary-payments", "xlsx", { can: (perm) => perm !== "view_pay", period, query: new URLSearchParams() }), /cannot see pay/);
});
