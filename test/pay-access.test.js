// Pay is private to those who may see it (the admin). Hub managers see the sales, the shortfalls and the money
// handed in, but never what anyone earns.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const { createServer } = require("../server");

const PW = "password-12345";

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  await svc.createEntry(d, "hubs", { code: "COL", name: "Colombo" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "Manager", staff_level: "manager", hub: "COL", basic_pay: 27000, bank_account_no: "55550001" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "G1", name: "Guy", staff_level: "distributor", hub: "COL", upline_id: "M1", basic_pay: 25000, target: 100000,
    pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25, bank_account_no: "11112222" }, "owner");
  await svc.createEntry(d, "daily", { date: "2026-09-02", employee_id: "G1", business_amount: 120000, settled_amount: 110000, personal_minus: 2000 }, "owner");
  await svc.runPeriod(d, "2026-09", "owner");
  await d.run("INSERT INTO audit_log (table_name, row_key, action, changed_by) VALUES ('pay_period_summary', 'G1@2026-09', 'approve', 'owner')");
  for (const [username, role, hub] of [["mgr", "coacher", "COL"]]) {
    await auth.createUser(d, admin, { username, full_name: username, role, hub, password: PW });
  }
  return d;
}

test("pay pages and routes refuse a hub manager; the admin gets them", async () => {
  const d = await setup();
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const signIn = async (username) => (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ username, password: PW }) })).headers.get("set-cookie").split(";")[0];
  const get = async (p, cookie) => { const r = await fetch(base + p, { headers: { Cookie: cookie } }); return { status: r.status, body: await r.text() }; };
  const json = async (p, cookie) => JSON.parse((await get(p, cookie)).body);
  try {
    const PAY_ROUTES = ["/api/payroll/2026-09", "/api/payroll/2026-09/G1", "/api/payroll/2026-09/payslips", "/api/payroll/2026-09/payslips/G1", "/api/payroll/2026-09/register",
      "/api/review-queue", "/api/reports/commission?period=2026-09", "/api/reports/balances"];
    const SALES_ROUTES = ["/api/daily?period=2026-09", "/api/live?period=2026-09", "/api/staff", "/api/hubs", "/api/loans", "/api/reports/stock?period=2026-09", "/api/stock?period=2026-09", "/api/weekly?period=2026-09"];
    for (const who of ["owner"]) {
      const c = await signIn(who);
      for (const p of PAY_ROUTES) assert.equal((await get(p, c)).status, 200, `${who} ${p}`);
    }
    for (const who of ["mgr"]) {
      const c = await signIn(who);
      for (const p of PAY_ROUTES) assert.equal((await get(p, c)).status, 403, `${who} ${p}`);
      for (const p of SALES_ROUTES) assert.equal((await get(p, c)).status, 200, `${who} ${p}`);
    }

    // what the sales side shows: the day's business, the amount handed in, the shortfall and the advance taken
    const mgr = await signIn("mgr");
    const [day] = await json("/api/daily?period=2026-09", mgr);
    assert.deepEqual([day.business_amount, day.settled_amount, day.settle_up_minus, day.personal_minus], [12000000, 11000000, 1000000, 200000]);
    const live = await json("/api/live?period=2026-09", mgr);
    assert.equal(live.can_pay, false);
    assert.ok(!/"pay"|gross|commission/.test(JSON.stringify(live)));

    // the dashboard keeps the sales and drops every pay figure
    const dash = await json("/api/dashboard?period=2026-09", mgr);
    assert.equal(dash.pay_hidden, true);
    assert.equal(dash.kpis.guys_business, 12000000);
    assert.equal(dash.kpis.settle_up, 1000000);
    assert.deepEqual([dash.kpis.gross_pay, dash.kpis.net_pay, dash.kpis.to_bank, dash.kpis.manager_balance], [null, null, null, null]);
    assert.ok(dash.by_hub.every((h) => h.gross_pay === null && h.net_pay === null && h.manager_balance === null));
    assert.ok(dash.trend.every((t) => Object.keys(t).sort().join() === "business,period"));
    assert.deepEqual(dash.exceptions, []);
    const boss = await json("/api/dashboard?period=2026-09", await signIn("owner"));
    assert.ok(boss.kpis.gross_pay > 0 && !boss.pay_hidden);

    // the months list loses what was paid, the profile loses the pay history, the audit trail loses the pay approvals
    assert.ok((await json("/api/periods", mgr)).every((p) => !("net_pay" in p) && !("to_bank" in p)));
    assert.ok((await json("/api/periods", await signIn("owner"))).every((p) => "net_pay" in p && "to_bank" in p));
    const profile = await json("/api/staff/G1/profile", mgr);
    assert.deepEqual([profile.history, profile.security_held], [[], null]);
    assert.ok((await json("/api/staff/G1/profile", await signIn("owner"))).history.length > 0);
    assert.ok(!(await json("/api/audit", mgr)).some((a) => ["pay_period_summary", "settings"].includes(a.table_name)));
    assert.ok((await json("/api/audit", await signIn("owner"))).some((a) => a.table_name === "pay_period_summary"));
  } finally { srv.close(); }
});

test("a hub manager registers their team without seeing or setting pay terms", async () => {
  const d = await setup();
  await svc.updateSettings(d, { position_defaults: JSON.stringify({ distributor: { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 0, security_deduction_rule: "pct_business:1" } }) }, "owner");
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, cookie, body) => { const r = await fetch(base + p, { method, body: body && JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: cookie } }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const signIn = async (username) => (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ username, password: PW }) })).headers.get("set-cookie").split(";")[0];
  try {
    const mgr = await signIn("mgr"), boss = await signIn("owner");
    const PAY = ["basic_pay", "commission_rate", "base_commission_rate", "food_per_day", "food_min_days", "security_deduction_rule", "pay_scheme", "opening_balance"];
    // the list and the profile carry no pay terms for a manager, and everything for the admin
    const list = (await call("GET", "/api/staff", mgr)).json;
    assert.ok(list.length >= 2 && list.every((s) => PAY.every((k) => !(k in s))));
    assert.ok(list.every((s) => "target" in s && "bank_account_no" in s), "targets and bank details are still there");
    const profileStaff = (await call("GET", "/api/staff/G1/profile", mgr)).json.staff;
    assert.ok(PAY.every((k) => !(k in profileStaff)));
    assert.equal((await call("GET", "/api/staff", boss)).json.find((s) => s.employee_id === "G1").basic_pay, 2500000);
    // the pay defaults in Settings are not sent to a manager
    assert.equal((await call("GET", "/api/settings", mgr)).json.position_defaults, "{}");
    assert.match((await call("GET", "/api/settings", boss)).json.position_defaults, /basic_pay/);
    assert.equal((await call("GET", "/api/auth/state", mgr)).json.settings.position_defaults, "{}");

    // a new person gets the position's usual pay terms, whatever the manager's request says
    const made = await call("POST", "/api/staff", mgr, { employee_id: "G7", name: "New Guy", hub: "COL", staff_level: "distributor", upline_id: "M1", basic_pay: 999999, commission_rate: 0.9 });
    assert.equal(made.status, 200);
    const g7 = (await call("GET", "/api/staff", boss)).json.find((s) => s.employee_id === "G7");
    assert.deepEqual([g7.basic_pay, g7.commission_rate, g7.pay_scheme, g7.food_per_day], [2500000, 0.3, "tiered", 15000]);
    // editing someone ignores any pay field the manager sends
    assert.equal((await call("PUT", "/api/staff/G1", mgr, { phone: "0771234567", basic_pay: 1, commission_rate: 0.99 })).status, 200);
    const g1 = (await call("GET", "/api/staff", boss)).json.find((s) => s.employee_id === "G1");
    assert.deepEqual([g1.phone, g1.basic_pay, g1.commission_rate], ["0771234567", 2500000, 0.3]);

    // the audit trail shows that a record changed, but not the pay terms in it
    await svc.updateEntry(d, "staff", "G1", { basic_pay: 26000, phone: "0770000000" }, "owner");
    const seen = (await call("GET", "/api/audit?table=staff&key=G1", mgr)).json;
    assert.ok(seen.length >= 1 && seen.every((a) => !/basic_pay|commission_rate/.test((a.old_value || "") + (a.new_value || ""))));
    assert.ok((await call("GET", "/api/audit?table=staff&key=G1", boss)).json.some((a) => /basic_pay/.test(a.new_value || "")));
  } finally { srv.close(); }
});
