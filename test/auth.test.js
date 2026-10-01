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

test("repeated failed sign-ins lock the username", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "lockme", full_name: "L", role: "clerk", password: PW.lock });
  for (let i = 0; i < 5; i++) await assert.rejects(() => auth.login(d, "lockme", "wrong-9999"), /Incorrect/);
  await assert.rejects(() => auth.login(d, "lockme", PW.lock), /Too many/);
});

test("password hashes never reach the audit log", async () => {
  const { d, admin } = await setup();
  await auth.createUser(d, admin, { username: "anu", full_name: "Anu", role: "clerk", password: PW.clerk });
  await auth.updateUser(d, admin, "anu", { password: "changed-pass-2" });
  const log = await svc.auditSearch(d, { table: "users", key: "anu" });
  assert.equal(log.length, 1);
  assert.ok(!/scrypt/.test(log[0].old_value + log[0].new_value));
  await auth.login(d, "anu", "changed-pass-2"); // login timestamp alone is not audited
  assert.equal((await svc.auditSearch(d, { table: "users", key: "anu" })).length, 1);
});

test("role permissions", () => {
  assert.ok(auth.can({ role: "admin" }, "finalize"));
  assert.ok(!auth.can({ role: "accountant" }, "finalize"));
  assert.ok(auth.can({ role: "accountant" }, "review"));
  assert.ok(auth.can({ role: "clerk" }, "enter_data"));
  assert.ok(!auth.can({ role: "clerk" }, "run_payroll"));
  assert.ok(!auth.can({ role: "viewer" }, "enter_data"));
});

test("hub-restricted clerk can only enter data for their hub", async () => {
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

test("whoever changed a bank account cannot approve it", async () => {
  const { d } = await setup();
  await svc.createEntry(d, "daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, "clerk");
  await svc.updateEntry(d, "staff", "G1", { bank_account_no: "99998888" }, "editor");
  await svc.runPeriod(d, "2026-09", "owner");
  await assert.rejects(() => svc.review(d, "2026-09", "G1", "editor", "approved", "ok"), /another user/);
  await svc.review(d, "2026-09", "G1", "owner", "approved", "called employee");
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
  await auth.createUser(d, admin, { username: "view", full_name: "V", role: "viewer", password: PW.viewer });
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
    assert.equal((await call("POST", "/api/daily", { date: "2026-09-01", employee_id: "G1", business_amount: 1, settled_amount: 1 }, sid)).status, 403);
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
