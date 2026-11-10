// Staff portal: a distributor / supervisor / group manager sees only their own figures.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const portal = require("../portal");

const ADMIN = { username: "admin" };
const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, level, upline, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: level,
    ...(upline ? { upline_id: upline } : {}), basic_pay: 30000, target: 100000, commission_rate: 0.3, bank_account_no: "1111" + id.replace(/\D/g, "").padStart(4, "0"), ...extra }, "admin");
  await add("M1", "manager");
  await add("GM1", "group_manager", "M1");
  await add("S1", "supervisor", "GM1");
  await add("D1", "distributor", "S1");
  await add("D2", "distributor", "S1");
  await add("D9", "distributor", null, { hub: "H2" });
  const day = (date, id, business) => svc.createEntry(d, "daily", { date, employee_id: id, business_amount: business, settled_amount: business }, "admin");
  await day("2026-10-01", "D1", 70000); await day("2026-10-02", "D1", 60000);
  await day("2026-10-01", "D2", 40000); await day("2026-10-01", "S1", 90000); await day("2026-10-01", "D9", 55000);
  return d;
}
const login = (d, employee, username) => auth.createUser(d, ADMIN, { username, full_name: `Name ${employee}`, role: "staff", employee_id: employee, password: "portal1234" });

test("a staff login is tied to one distributor, supervisor or group manager, and takes their hub", async () => {
  const d = await setup();
  const u = await login(d, "D1", "user-d1");
  assert.deepEqual([u.role, u.employee_id, u.hub], ["staff", "D1", "H1"]);
  assert.deepEqual(auth.PERMISSIONS.staff, ["self"]);
  assert.ok(!auth.can(u, "read") && !auth.can(u, "enter_data") && !auth.can(u, "manage_staff"), "no office access");
  assert.ok(auth.can(u, "self"));
  assert.throws(() => auth.requirePerm(u, "read"), /cannot do this/);

  await assert.rejects(() => login(d, "D1", "user-d1b"), /already has a login/);
  await assert.rejects(() => login(d, "M1", "user-m1"), /distributors, supervisors and group managers/);
  await assert.rejects(() => login(d, "NOBODY", "user-nobody"), /Choose the employee/);
  await svc.updateEntry(d, "staff", "D2", { status: "inactive" }, "admin");
  await assert.rejects(() => login(d, "D2", "user-d2"), /inactive/);
  await assert.rejects(() => auth.createUser(d, ADMIN, { username: "user-x1", full_name: "X", role: "staff", password: "portal1234" }), /Choose the employee/);

  // the portal login cannot become an office role, and an office user cannot become a portal login
  await assert.rejects(() => auth.updateUser(d, ADMIN, "user-d1", { role: "admin" }), /cannot be changed/);
  await auth.createUser(d, ADMIN, { username: "clerk-one", full_name: "C", role: "clerk", password: "clerk12345" });
  await assert.rejects(() => auth.updateUser(d, ADMIN, "clerk-one", { role: "staff" }), /cannot be changed/);
  // a hub typed for a portal login is ignored
  assert.equal((await auth.updateUser(d, ADMIN, "user-d1", { hub: "H2" })).hub, "H1");
});

test("the portal shows only my own sales, target progress and an estimate marked as not final", async () => {
  const d = await setup();
  const u = await login(d, "D1", "user-d1");
  const p = await portal.summary(d, u, "2026-10");
  assert.equal(p.me.employee_id, "D1");
  assert.equal(p.me.level_name, "Distributor");
  assert.equal(p.me.reports_to, "Name S1");
  assert.equal(p.month.business, 13000000);       // 70,000 + 60,000
  assert.equal(p.month.days, 2);
  assert.equal(p.month.over_target, 3000000);
  assert.equal(p.month.to_go, 0);
  assert.equal(p.finalized, false);
  assert.equal(p.official, null);
  assert.ok(p.estimate, "an estimate exists while the month is open");
  assert.equal(p.estimate.gross, 3000000 + Math.round(3000000 * 0.3)); // basic 30,000 + 30% of 30,000 over target
  assert.equal(p.team, null, "a distributor has no team");
  assert.ok(!JSON.stringify(p).includes("Name D2") && !JSON.stringify(p).includes("D9"), "nothing about anyone else");
  // a month with no entries has no estimate
  assert.equal((await portal.summary(d, u, "2026-09")).estimate, null);
});

test("a supervisor and a group manager see their team's sales, not their pay", async () => {
  const d = await setup();
  const s = await portal.summary(d, await login(d, "S1", "user-s1"), "2026-10");
  assert.deepEqual(s.team.map((t) => t.employee_id), ["D1", "D2"]);
  assert.equal(s.team.find((t) => t.employee_id === "D1").business, 13000000);
  assert.ok(s.team.every((t) => !("net_pay" in t) && !("gross" in t)));
  const g = await portal.summary(d, await login(d, "GM1", "user-gm1"), "2026-10");
  assert.deepEqual(g.team.map((t) => `${t.employee_id}:${t.depth}`), ["S1:1", "D1:2", "D2:2"], "the whole downline, nearest first");
  assert.ok(!g.team.some((t) => t.employee_id === "D9"), "another hub's person is not on the team");
});

test("final figures and the payslip appear only after the month is finalized, and only for me", async () => {
  const d = await setup();
  const u = await login(d, "D1", "user-d1");
  await assert.rejects(() => portal.payslip(d, u, "2026-10"), /finalized/);
  await svc.runPeriod(d, "2026-10", "admin");
  await assert.rejects(() => portal.payslip(d, u, "2026-10"), /finalized/, "calculated is not final");
  for (const r of (await svc.getPeriod(d, "2026-10")).rows.filter((x) => x.status === "pending_review")) await svc.review(d, "2026-10", r.employee_id, "admin", "approved", "ok");
  await svc.finalizePeriod(d, "2026-10", "admin");

  const p = await portal.summary(d, u, "2026-10");
  assert.equal(p.finalized, true);
  assert.equal(p.estimate, null);
  const row = (await svc.getPeriod(d, "2026-10")).rows.find((r) => r.employee_id === "D1");
  assert.equal(p.official.net, row.net_pay);
  assert.equal(p.official.closing, row.closing_balance);
  assert.equal(p.history.length, 1);
  assert.equal(p.history[0].net_pay, row.net_pay);

  const slip = await portal.payslip(d, u, "2026-10");
  assert.match(slip, /Name D1/);
  assert.ok(!/Name D2|Name S1|Name D9/.test(slip), "the payslip holds only my own");
  assert.doesNotMatch(slip, /DRAFT/);
  await assert.rejects(() => portal.payslip(d, u, "bad"), /Invalid period/);
});

test("I can upload and open my own documents but never another person's", async () => {
  const d = await setup();
  const u1 = await login(d, "D1", "user-d1");
  const u2 = await login(d, "D2", "user-d2");
  const doc = await portal.addDocument(d, u1, { doc_type: "nic", file_name: "nic.png", mime: "image/png", data: png });
  assert.equal((await portal.listDocuments(d, u1)).length, 1);
  assert.equal((await portal.listDocuments(d, u2)).length, 0);
  assert.equal((await portal.getDocument(d, u1, doc.id)).file_name, "nic.png");
  await assert.rejects(() => portal.getDocument(d, u2, doc.id), /not found/);
  await assert.rejects(() => portal.addDocument(d, u1, { doc_type: "nic", file_name: "a.exe", mime: "application/x-msdownload", data: png }), /JPG, PNG/);
  // an office user with no employee link cannot use the portal calls
  await assert.rejects(() => portal.summary(d, { username: "admin", employee_id: null }, "2026-10"), /not linked/);
});
