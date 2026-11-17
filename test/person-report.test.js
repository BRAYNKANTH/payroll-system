// The per-person PDF report: any employee, any month; pay only when allowed; a hub manager only reaches their own hub.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const portal = require("../portal");
const exporter = require("../export");

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, level, upline, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: level,
    ...(upline ? { upline_id: upline } : {}), basic_pay: 30000, target: 100000, commission_rate: 0.3, bank_account_no: "1111" + id.replace(/\D/g, "").padStart(4, "0"), ...extra }, "admin");
  await add("M1", "manager");
  await add("D1", "distributor", "M1");
  await add("D9", "distributor", null, { hub: "H2" });
  await svc.createEntry(d, "daily", { date: "2026-10-01", employee_id: "D1", business_amount: 70000, settled_amount: 70000 }, "admin");
  await svc.createEntry(d, "daily", { date: "2026-10-02", employee_id: "D1", business_amount: 60000, settled_amount: 60000 }, "admin");
  return d;
}
// The page content is deflated: inflate every stream and join what was drawn.
const zlib = require("zlib");
const text = (f) => {
  const raw = f.data.toString("latin1"); const out = [];
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) { try { out.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1")); } catch { /* not a page stream */ } }
  return out.join("\n");
};

test("the office gets a PDF for any employee: pay for the admin, sales only without view_pay", async () => {
  const d = await setup();
  const rep = await portal.forEmployee(d, "D1", "2026-10", null);
  const withPay = exporter.personReportPdf(rep, { canPay: true, company: "Co" });
  assert.equal(withPay.data.subarray(0, 5).toString(), "%PDF-");
  assert.equal(withPay.filename, "report-D1-2026-10.pdf");
  assert.match(text(withPay), /Salary calculation/);
  assert.match(text(withPay), /Day by day/);
  const noPay = exporter.personReportPdf(rep, { canPay: false, company: "Co" });
  assert.doesNotMatch(text(noPay), /Salary calculation|Net pay|Gross earnings/, "no pay for a hub manager");
  assert.match(text(noPay), /Day by day/);
});

test("a hub-limited user cannot report on another hub, and an unknown employee is refused", async () => {
  const d = await setup();
  await assert.rejects(() => portal.forEmployee(d, "D9", "2026-10", "H1"), /Outside your hub/);
  assert.equal((await portal.forEmployee(d, "D1", "2026-10", "H1")).me.employee_id, "D1");
  await assert.rejects(() => portal.forEmployee(d, "NOPE", "2026-10", null), /not found/);
  await assert.rejects(() => portal.forEmployee(d, "D1", "bad", null), /Invalid period/);
});

test("a manager's report shows the team and leaves out an estimate, and an empty month still renders", async () => {
  const d = await setup();
  const rep = await portal.forEmployee(d, "M1", "2026-10", null);
  assert.equal(rep.team.length, 1);
  const f = exporter.personReportPdf(rep, { canPay: true });
  assert.match(text(f), /Team \\?\(sales only/);
  const empty = exporter.personReportPdf(await portal.forEmployee(d, "D1", "2026-01", null), { canPay: true });
  assert.equal(empty.data.subarray(0, 5).toString(), "%PDF-");
});

test("the commission report counts the over-target income of a tiered seller, not just the base commission", async () => {
  const d = await setup();
  const tiered = { pay_scheme: "tiered", basic_pay: 25000, target: 100000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, security_deduction_rule: "none" };
  for (const id of ["T1", "T2"]) await svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: "distributor", upline_id: "M1", ...tiered, bank_account_no: "2222" + id.slice(1).padStart(4, "0") }, "admin");
  await svc.createEntry(d, "daily", { date: "2026-10-03", employee_id: "T1", business_amount: 120000, settled_amount: 120000 }, "admin"); // 20,000 over target
  await svc.createEntry(d, "daily", { date: "2026-10-03", employee_id: "T2", business_amount: 80000, settled_amount: 80000 }, "admin"); // below target
  await svc.runPeriod(d, "2026-10", "admin");
  const rows = Object.fromEntries((await svc.commissionReport(d, "2026-10")).map((r) => [r.employee_id, r.commission]));
  assert.equal(rows.T1, 600000, "30% of the Rs 20,000 over target");
  assert.equal(rows.T2, 2000000, "25% of all Rs 80,000 below target");
});
