const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const { createServer } = require("../server");

const PW = { owner: "owner-pass-1", clerk: "clerk-pass-1", viewer: "viewer-pass-1", lock: "lock-pass-1" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW.owner });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW.owner)).token);
  await svc.createEntry(d, "hubs", { code: "COL", name: "Colombo" }, "owner");
  await svc.createEntry(d, "hubs", { code: "KDY", name: "Kandy" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "M", role: "manager", hub: "COL" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "G1", name: "G1", role: "guy", hub: "COL", manager_id: "M1", basic_pay: 30000, bank_account_no: "11112222" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "G2", name: "G2", role: "guy", hub: "KDY", basic_pay: 30000 }, "owner");
  return { d, admin };
}

test("setup creates the first admin only once; bad credentials are refused", async () => {
  const { d } = await setup();
  await assert.rejects(() => auth.setup(d, { username: "xyz", full_name: "x", password: "abcd1234" }), /already/);
  await assert.rejects(() => auth.login(d, "owner", "not-the-pass-9"), /Incorrect/);
  assert.match((await d.get("SELECT password_hash FROM users")).password_hash, /^scrypt\$/);
  assert.ok(await auth.login(d, "OWNER", PW.owner), "usernames are case-insensitive");
});

test("failed sign-ins never lock an account (the owner's rule); they are only recorded", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "lockme", full_name: "L", role: "coacher", hub: "COL", password: PW.lock });
  for (let i = 0; i < 8; i++) await assert.rejects(() => auth.login(d, "lockme", "wrong-9999"), /Incorrect/);
  assert.ok((await auth.login(d, "lockme", PW.lock)).token, "the right password still works after many wrong ones");
  assert.equal((await svc.auditSearch(d, { table: "session", key: "lockme", action: "login_failed" })).length, 8);
});

test("someone who has left cannot sign in, their open sessions end, and their record and history stay", async () => {
  const { d, admin } = await setup();
  const people = require("../people");
  await svc.createEntry(d, "staff", { employee_id: "G9", name: "G9", staff_level: "distributor", hub: "COL", upline_id: "M1" }, "owner");
  await auth.createUser(d, admin, { username: "leaver", full_name: "Leaver", role: "staff", employee_id: "G9", password: PW.clerk });
  const s = await auth.login(d, "leaver", PW.clerk);
  assert.ok(await auth.userFromToken(d, s.token));
  const out = await people.leave(d, "G9", { leave_date: "2026-09-10", reason: "resigned" }, "owner", null);
  assert.equal(out.login_deactivated, true);
  assert.equal(await auth.userFromToken(d, s.token), null, "the open session ended");
  await assert.rejects(() => auth.login(d, "leaver", PW.clerk), /Incorrect/);
  assert.equal((await d.get("SELECT status FROM users WHERE username = 'leaver'")).status, "disabled", "the user stays, deactivated");
  assert.equal((await d.get("SELECT status FROM staff WHERE employee_id = 'G9'")).status, "inactive", "the employee record stays");
  // re-hiring does not switch the sign-in back on by itself
  await people.rehire(d, "G9", { join_date: "2026-10-01" }, "owner", null);
  await assert.rejects(() => auth.login(d, "leaver", PW.clerk), /Incorrect/);
  await auth.updateUser(d, admin, "leaver", { status: "active" });
  assert.ok((await auth.login(d, "leaver", PW.clerk)).token, "the admin turns it back on");
});

test("password hashes never reach the audit log", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "anu", full_name: "Anu", role: "coacher", hub: "COL", password: PW.clerk });
  await auth.updateUser(d, admin, "anu", { password: "changed-pass-2" });
  const log = await svc.auditSearch(d, { table: "users", key: "anu" });
  assert.equal(log.length, 2, "the new user and the password change");
  assert.ok(log.every((l) => !/scrypt/.test((l.old_value || "") + (l.new_value || ""))));
  await auth.login(d, "anu", "changed-pass-2"); // the login timestamp is not a change to the user record
  assert.equal((await svc.auditSearch(d, { table: "users", key: "anu" })).length, 2);
});

test("role permissions", () => {
  assert.ok(auth.can({ role: "admin" }, "finalize"));
  assert.ok(auth.can({ role: "admin" }, "review") && auth.can({ role: "admin" }, "run_payroll") && auth.can({ role: "admin" }, "view_pay"));
  assert.deepEqual([...auth.ROLES].sort(), ["admin", "coacher", "manager", "staff"], "no accountant, clerk or viewer");
  for (const gone of ["accountant", "clerk", "viewer"]) assert.ok(!auth.can({ role: gone }, "read"), gone);
  assert.ok(!auth.can({ role: "staff" }, "enter_data"));
  // a coacher heads a hub: whole-hub work, never pay; a manager only looks at their own people
  assert.ok(auth.can({ role: "coacher" }, "enter_data") && auth.can({ role: "coacher" }, "manage_team") && auth.can({ role: "coacher" }, "stock"));
  assert.ok(!auth.can({ role: "coacher" }, "manage_staff") && !auth.can({ role: "coacher" }, "run_payroll") && !auth.can({ role: "coacher" }, "view_pay"));
  assert.deepEqual(auth.PERMISSIONS.manager, ["read_team", "self"]);
  assert.ok(!auth.can({ role: "manager" }, "read") && !auth.can({ role: "manager" }, "enter_data") && !auth.can({ role: "manager" }, "stock"));
  assert.ok(auth.can({ role: "manager", stock_keeper: true, permissions: [...auth.PERMISSIONS.manager, "stock"] }, "stock"), "a stock keeper may handle stock");
  assert.doesNotThrow(() => auth.requirePerm({ role: "coacher" }, ["manage_staff", "manage_team"]));
  assert.throws(() => auth.requirePerm({ role: "staff" }, ["manage_staff", "manage_team"]), /cannot do this/);
});

test("a coacher must be limited to one hub", async () => {
  const { d, admin } = await setup();
  await assert.rejects(() => auth.createUser(d, admin, { username: "mgr", full_name: "Mgr", role: "coacher", password: PW.clerk }), /one hub/);
  const u = await auth.createUser(d, admin, { username: "mgr", full_name: "Mgr", role: "coacher", hub: "COL", password: PW.clerk });
  assert.equal(u.role, "coacher");
  await assert.rejects(() => auth.updateUser(d, admin, "mgr", { hub: "" }), /one hub/);
});

test("a hub manager registers staff only in their own hub and never a manager", async () => {
  const { d } = await setup();
  const mine = await svc.createEntry(d, "staff", { employee_id: "D9", name: "D9", hub: "COL", staff_level: "distributor", upline_id: "M1" }, "mgr", "COL");
  assert.equal(mine.manager_id, "M1");
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "D8", name: "D8", hub: "KDY", staff_level: "distributor" }, "mgr", "COL"), /hub COL/);
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "M9", name: "M9", hub: "COL", staff_level: "manager" }, "mgr", "COL"), /managers/);
  await assert.rejects(() => svc.updateEntry(d, "staff", "D9", { hub: "KDY" }, "mgr", "COL"), /hub COL/);
  await assert.rejects(() => svc.updateEntry(d, "staff", "M1", { name: "Renamed" }, "mgr", "COL"), /managers/);
  await assert.rejects(() => svc.updateEntry(d, "staff", "G2", { name: "Renamed" }, "mgr", "COL"), /hub COL/);
  await assert.rejects(() => svc.createEntry(d, "hubs", { code: "NEW", name: "New" }, "mgr", "COL"), /master data/);
});

test("a hub-restricted user can only enter data for their hub", async () => {
  const { d } = await setup();
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "clerk", "COL");
  await assert.rejects(() => svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G2", business_amount: 1, settled_amount: 1 }, "clerk", "COL"), /hub COL/);
  await assert.rejects(() => svc.bulkUpsert(d, "daily", [{ date: "2026-09-02", employee_id: "G2", business_amount: 1, settled_amount: 1 }], "clerk", "COL"), /hub COL/);
  assert.equal((await svc.listEntries(d, "daily", { hub: "KDY" })).length, 0);
});

test("bulk save creates, updates, skips unchanged and deletes — all or nothing", async () => {
  const { d } = await setup();
  const rows = [
    { date: "2026-09-01", employee_id: "G1", business_amount: 100, settled_amount: 100 },
    { date: "2026-09-01", employee_id: "G2", business_amount: 200, settled_amount: 150 },
  ];
  assert.deepEqual(await svc.bulkUpsert(d, "daily", rows, "clerk"), { created: 2, updated: 0, unchanged: 0, deleted: 0 });
  rows[1].settled_amount = 200;
  assert.deepEqual(await svc.bulkUpsert(d, "daily", rows, "clerk"), { created: 0, updated: 1, unchanged: 1, deleted: 0 });
  assert.deepEqual(await svc.bulkUpsert(d, "daily", [{ date: "2026-09-01", employee_id: "G1", _delete: true }], "clerk"), { created: 0, updated: 0, unchanged: 0, deleted: 1 });
  await assert.rejects(() => svc.bulkUpsert(d, "daily", [
    { date: "2026-09-03", employee_id: "G1", business_amount: 1, settled_amount: 1 },
    { date: "2026-09-03", employee_id: "G2", business_amount: "abc", settled_amount: 1 },
  ], "clerk"), /Row 2/);
  // A failure half-way through the transaction (finalized month) must not leave the first rows behind.
  await d.run("INSERT INTO periods (period, status) VALUES ('2026-08', 'finalized')");
  await assert.rejects(() => svc.bulkUpsert(d, "daily", [
    { date: "2026-09-04", employee_id: "G1", business_amount: 1, settled_amount: 1 },
    { date: "2026-08-04", employee_id: "G1", business_amount: 1, settled_amount: 1 },
  ], "clerk"), /finalized/);
  assert.equal((await svc.listEntries(d, "daily", { period: "2026-09" })).length, 1);
});

test("a changed bank account raises no flag, and nothing waits for approval", async () => {
  const { d } = await setup();
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "clerk");
  await svc.updateEntry(d, "staff", "G1", { bank_account_no: "99998888" }, "editor");
  await svc.runPeriod(d, "2026-09", "owner");
  const g = (await svc.getPeriod(d, "2026-09")).rows.find((r) => r.employee_id === "G1");
  assert.equal(g.status, "auto_approved");
  assert.ok(!g.flags.some((f) => f.code.startsWith("BANK_ACCOUNT")));
  await assert.rejects(() => svc.review(d, "2026-09", "G1", "owner", "approved", "ok"), /auto-approved/);
});

test("dashboard summarises a period, optionally per hub", async () => {
  const { d } = await setup();
  await svc.bulkUpsert(d, "daily", [
    { date: "2026-09-01", employee_id: "G1", business_amount: 1000, settled_amount: 900 },
    { date: "2026-09-01", employee_id: "G2", business_amount: 500, settled_amount: 500 },
  ], "clerk");
  await svc.runPeriod(d, "2026-09", "owner");
  const dash = await svc.dashboard(d, "2026-09");
  assert.equal(dash.kpis.guys_business, 150000);
  assert.equal(dash.kpis.settle_up, 10000);
  assert.equal(dash.by_hub.find((h) => h.code === "COL").guys_business, 100000);
  assert.equal(dash.trend.length, 6);
  assert.equal((await svc.dashboard(d, "2026-09", "KDY")).kpis.guys_business, 50000);
});

test("HTTP: sign-in required, roles enforced, forged requests refused, backup", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "view", full_name: "V", role: "coacher", hub: "COL", password: PW.viewer });
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, p, body, cookie, header = true, extra = {}) => fetch(base + p, {
    method, body: body && JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(header ? { "X-Requested-With": "fetch" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
  });
  try {
    assert.equal((await (await call("GET", "/api/health")).json()).ok, true);
    assert.equal((await call("GET", "/api/staff")).status, 401);
    const login = await call("POST", "/api/auth/login", { username: "view", password: PW.viewer });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Secure/);
    const sid = setCookie.split(";")[0];
    assert.equal((await call("GET", "/api/staff", null, sid)).status, 200);
    assert.equal((await call("POST", "/api/users", { username: "x", full_name: "X", role: "admin", password: PW.viewer }, sid)).status, 403);
    assert.equal((await call("GET", "/api/backup", null, sid)).status, 403);
    assert.equal((await call("POST", "/api/auth/login", { username: "view", password: PW.viewer }, null, false)).status, 403);
    assert.equal((await call("POST", "/api/auth/logout", {}, sid)).status, 200);
    assert.equal((await call("GET", "/api/staff", null, sid)).status, 401);

    // Behind an HTTPS proxy (Vercel) the cookie must be Secure.
    const viaHttps = await call("POST", "/api/auth/login", { username: "owner", password: PW.owner }, null, true, { "X-Forwarded-Proto": "https" });
    assert.match(viaHttps.headers.get("set-cookie"), /; Secure/);
    const adminSid = viaHttps.headers.get("set-cookie").split(";")[0];
    const backup = await call("GET", "/api/backup", null, adminSid);
    assert.equal(backup.status, 200);
    const dump = await backup.json();
    assert.equal(dump.tables.staff.length, 3);
    assert.ok(dump.tables.users.every((u) => !("password_hash" in u)));

    const page = await fetch(base + "/dashboard");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal((await fetch(base + "/..%2f..%2fdb.js")).status, 403);
  } finally { srv.close(); }
});

test("the admin can rename a user's username; the old name stops working and the person is signed out", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "oldname", full_name: "Anu", role: "coacher", hub: "COL", password: PW.clerk });
  const s = await auth.login(d, "oldname", PW.clerk);
  const u = await auth.updateUser(d, admin, "oldname", { username: "newname" });
  assert.equal(u.username, "newname");
  assert.equal(await auth.userFromToken(d, s.token), null, "signed out");
  await assert.rejects(() => auth.login(d, "oldname", PW.clerk), /Incorrect/);
  assert.ok((await auth.login(d, "newname", PW.clerk)).token);
  await assert.rejects(() => auth.updateUser(d, admin, "newname", { username: "ab" }), /Username must be/);
  await auth.createUser(d, admin, { username: "other", full_name: "O", role: "coacher", hub: "COL", password: PW.clerk });
  await assert.rejects(() => auth.updateUser(d, admin, "newname", { username: "OTHER" }), /already used/);
});
