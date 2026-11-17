// A coacher, promoting manager and manager can each have their own portal login: own pay and payslips, and the sales of their team.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");
const portal = require("../portal");

const PW = "password-12345";
async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "owner");
  const add = (id, level, upline, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: "Person " + id, hub: "H1", staff_level: level, ...(upline ? { upline_id: upline } : {}), ...extra }, "owner");
  await add("C1", "coacher", null, { basic_pay: 30000 });
  await add("PM1", "promoting_manager", "C1", { basic_pay: 29000 });
  await add("M1", "manager", "PM1", { basic_pay: 27000, target: 100000 });
  await add("D1", "distributor", "M1", { basic_pay: 25000, target: 100000, pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25 });
  await add("D2", "distributor", "M1", { target: 100000 });
  const day = new Date().toISOString().slice(0, 7) + "-02";
  await svc.createEntry(d, "daily", { date: day, employee_id: "D1", business_amount: 100000, settled_amount: 90000 }, "owner");
  await svc.createEntry(d, "daily", { date: day, employee_id: "D2", business_amount: 50000, settled_amount: 50000 }, "owner");
  await svc.createEntry(d, "daily", { date: day, employee_id: "M1", business_amount: 20000, settled_amount: 20000 }, "owner");
  const login = async (username, employee_id) => {
    await auth.createUser(d, admin, { username, full_name: username, role: "staff", employee_id, password: PW });
    return auth.userFromToken(d, (await auth.login(d, username, PW)).token);
  };
  return { d, login, period: day.slice(0, 7) };
}

test("a coacher and a promoting manager can have a portal login, and see their team's sales and a salary-plus-share estimate", async () => {
  const { d, login, period } = await setup();
  const coach = await login("coach", "C1");
  const s = await portal.summary(d, coach, period);
  assert.equal(s.me.senior, true);
  assert.equal(s.me.level_name, "Coacher");
  assert.deepEqual(s.team.map((p) => p.employee_id).sort(), ["D1", "D2", "M1", "PM1"]);
  assert.equal(s.below_sales, 17000000, "everyone below: the manager's own 20,000 plus the two sellers");
  const rate = s.senior_rate;
  assert.ok(rate > 0);
  assert.equal(s.estimate.gross, 3000000 + Math.round(17000000 * rate));
  const pm = await login("promo", "PM1");
  assert.equal((await portal.summary(d, pm, period)).team.length, 3, "a promoting manager sees only those below them");
  assert.ok(!JSON.stringify(s.team).match(/basic_pay|net_pay|gross/), "team rows carry sales only, never pay");
});

test("a manager has a portal login, sells too, and sees the team", async () => {
  const { d, login, period } = await setup();
  const m = await login("mgr", "M1");
  const s = await portal.summary(d, m, period);
  assert.equal(s.me.is_manager, true);
  assert.equal(s.me.sells, true);
  assert.equal(s.estimate, null, "a manager's pay comes from the weekly account");
  assert.deepEqual(s.team.map((p) => p.employee_id).sort(), ["D1", "D2"]);
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  await sales.addSale(d, m, { date: today, business_amount: 5000, settled_amount: 5000 });
  assert.ok((await portal.summary(d, m, today.slice(0, 7))).month.daily.some((r) => r.date === today));
});

test("a coacher cannot enter sales, and a seller has no team", async () => {
  const { d, login, period } = await setup();
  const coach = await login("coach", "C1");
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  await assert.rejects(() => sales.addSale(d, coach, { date: today, business_amount: 1, settled_amount: 1 }), /Only distributors, supervisors and managers/);
  const guy = await login("guy", "D1");
  const s = await portal.summary(d, guy, period);
  assert.equal(s.team, null);
  assert.equal(s.me.sells, true);
});

test("a coacher login can be linked to the coacher's own record, which gives My page as well as the whole hub", async () => {
  const { d, period } = await setup();
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  await assert.rejects(() => auth.createUser(d, admin, { username: "c-office", full_name: "C", role: "coacher", hub: "H1", employee_id: "NOBODY", password: PW }), /Choose the employee/);
  await assert.rejects(() => auth.createUser(d, admin, { username: "c-office", full_name: "C", role: "coacher", hub: "H1", employee_id: "M1", password: PW }), /only be linked to a coacher/);
  const u = await auth.createUser(d, admin, { username: "c-office", full_name: "C", role: "coacher", hub: "H1", employee_id: "C1", password: PW });
  assert.equal(u.employee_id, "C1");
  await assert.rejects(() => auth.createUser(d, admin, { username: "c-two", full_name: "C", role: "coacher", hub: "H1", employee_id: "C1", password: PW }), /already has a login/);
  const me = await auth.userFromToken(d, (await auth.login(d, "c-office", PW)).token);
  assert.ok(auth.can(me, "enter_data") && auth.can(me, "self") && auth.can(me, "stock") && !auth.can(me, "view_pay"));
  assert.equal((await portal.summary(d, me, period)).me.employee_id, "C1");
  const plain = await auth.createUser(d, admin, { username: "plain", full_name: "P", role: "coacher", hub: "H1", password: PW });
  assert.equal(plain.employee_id, null);
  await assert.rejects(() => portal.summary(d, plain, period), /not linked/);
});

test("a coacher is the head of the hub: a plain portal login for a coacher gets the hub's office access plus My page, never pay", async () => {
  const { d, period } = await setup();
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  const u = await auth.createUser(d, admin, { username: "head", full_name: "Head", role: "staff", employee_id: "C1", password: PW });
  assert.deepEqual([u.role, u.hub, u.employee_id], ["coacher", "H1", "C1"]);
  const me = await auth.userFromToken(d, (await auth.login(d, "head", PW)).token);
  for (const p of ["read", "enter_data", "manage_team", "self"]) assert.ok(auth.can(me, p), p);
  for (const p of ["view_pay", "run_payroll", "finalize", "manage_users", "settings"]) assert.ok(!auth.can(me, p), p);
  assert.equal((await portal.summary(d, me, period)).me.level_name, "Coacher");
  // a promoting manager gets the manager login: their own people, never the whole hub
  const pm = await auth.createUser(d, admin, { username: "pmgr", full_name: "PM", role: "staff", employee_id: "PM1", password: PW });
  assert.equal(pm.role, "manager");
});
