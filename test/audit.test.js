// The audit trail records who signed in, added, changed, uploaded, downloaded and opened what, from where, and cannot be altered.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const { createServer } = require("../server");

const PW = "password-12345";
const IP = "203.0.113.7";
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36";

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  await svc.createEntry(d, "hubs", { code: "COL", name: "Colombo" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "M1", name: "Manager", staff_level: "manager", hub: "COL" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "G1", name: "Guy", staff_level: "distributor", hub: "COL", upline_id: "M1", basic_pay: 25000, bank_account_no: "11112222" }, "owner");
  await svc.createEntry(d, "daily", { date: "2026-09-02", employee_id: "G1", business_amount: 120000, settled_amount: 110000 }, "owner");
  await svc.runPeriod(d, "2026-09", "owner");
  await auth.createUser(d, admin, { username: "mgr", full_name: "Hub manager", role: "manager", hub: "COL", password: PW });
  await auth.createUser(d, admin, { username: "mgr2", full_name: "Second manager", role: "manager", hub: "COL", password: PW });
  return { d, admin };
}
async function serve(d) {
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { cookie, body, ip = IP } = {}) => {
    const r = await fetch(base + p, { method, body: body && JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-Forwarded-For": ip, "User-Agent": AGENT, ...(cookie ? { Cookie: cookie } : {}) } });
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const json = (r) => JSON.parse(r.buf.toString("utf8"));
  const signIn = async (username, password = PW, ip) => { const r = await call("POST", "/api/auth/login", { body: { username, password }, ip }); return r.status === 200 ? r.headers.get("set-cookie").split(";")[0] : null; };
  return { srv, call, json, signIn };
}
const rows = (d, where = "true", ...args) => d.all(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`, ...args);

test("additions are in the trail with who added them and what was added, and never a password", async () => {
  const { d } = await setup();
  const made = await rows(d, "table_name = 'staff' AND row_key = 'G1' AND action = 'create'");
  assert.equal(made.length, 1);
  assert.equal(made[0].changed_by, "owner");
  assert.equal(JSON.parse(made[0].new_value).employee_id, "G1");
  const users = await rows(d, "table_name = 'users' AND action = 'create'");
  assert.ok(users.length >= 3);
  assert.ok(users.every((u) => !/scrypt|password_hash/.test(u.new_value)), "no hash in the log");
  const day = await rows(d, "table_name = 'daily_log' AND action = 'create'");
  assert.equal(JSON.parse(day[0].new_value).business_amount, 12000000);
});

test("sign-ins, failed sign-ins, lockouts, sign-outs and password changes are recorded with the address and the browser", async () => {
  const { d } = await setup();
  const { srv, call, json, signIn } = await serve(d);
  try {
    assert.equal(await signIn("owner", "not-the-password-1", "198.51.100.9"), null);
    assert.equal(await signIn("nobody", "whatever-123", "198.51.100.9"), null);
    const cookie = await signIn("owner");
    assert.ok(cookie);
    assert.equal((await call("POST", "/api/auth/password", { cookie, body: { current_password: PW, new_password: "another-pass-77" } })).status, 200);
    assert.equal((await call("POST", "/api/auth/logout", { cookie, body: {} })).status, 200);
    const ev = await rows(d, "table_name = 'session'");
    const by = (a, u) => ev.filter((e) => e.action === a && e.changed_by === u);
    assert.equal(by("login_failed", "owner").length, 1);
    assert.equal(JSON.parse(by("login_failed", "owner")[0].new_value).reason, "wrong password");
    assert.equal(by("login_failed", "owner")[0].ip, "198.51.100.9");
    assert.equal(JSON.parse(by("login_failed", "nobody")[0].new_value).reason, "unknown username");
    const login = by("login", "owner").find((e) => e.ip === IP);
    assert.ok(login, "the successful sign-in from the second address");
    assert.equal(login.agent, AGENT);
    assert.equal(by("password_change", "owner").length, 1);
    assert.equal(by("logout", "owner").length, 1);
    assert.ok(!JSON.stringify(await rows(d)).includes("not-the-password-1"), "a typed password is never written down");
    // five wrong tries lock the name, and the lockout is recorded once, not once per attempt
    for (let i = 0; i < 7; i++) await signIn("mgr2", "wrong-password-" + i);
    const locked = await rows(d, "action = 'login_locked' AND changed_by = 'mgr2'");
    assert.equal(locked.length, 1);
    assert.equal((await rows(d, "action = 'login_failed' AND changed_by = 'mgr2'")).length, 5);
  } finally { srv.close(); }
});

test("a change made through the app carries the address and browser it came from", async () => {
  const { d } = await setup();
  const { srv, call, json, signIn } = await serve(d);
  try {
    const cookie = await signIn("owner");
    assert.equal((await call("PUT", "/api/staff/G1", { cookie, body: { phone: "0771234567" } })).status, 200);
    const made = await call("POST", "/api/staff", { cookie, body: { employee_id: "G2", name: "New", hub: "COL", staff_level: "distributor", upline_id: "M1" } });
    assert.equal(made.status, 200);
    const [upd] = await rows(d, "table_name = 'staff' AND row_key = 'G1' AND action = 'update' AND ip IS NOT NULL");
    assert.deepEqual([upd.changed_by, upd.ip, upd.agent], ["owner", IP, AGENT]);
    const [add] = await rows(d, "table_name = 'staff' AND row_key = 'G2' AND action = 'create'");
    assert.deepEqual([add.changed_by, add.ip], ["owner", IP]);
  } finally { srv.close(); }
});

test("downloads and views are recorded: exports, payroll and payslip views, scanned documents, and refused requests", async () => {
  const { d } = await setup();
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const doc = await svc.addDocument(d, "G1", { doc_type: "nic", file_name: "nic.png", mime: "image/png", data: png }, "owner");
  const { srv, call, json, signIn } = await serve(d);
  try {
    const boss = await signIn("owner"), mgr = await signIn("mgr");
    assert.equal((await call("GET", "/api/export/daily.xlsx?period=2026-09&hub=COL", { cookie: boss })).status, 200);
    assert.equal((await call("GET", "/api/payroll/2026-09", { cookie: boss })).status, 200);
    assert.equal((await call("GET", "/api/payroll/2026-09", { cookie: boss })).status, 200, "opened twice");
    assert.equal((await call("GET", "/api/payroll/2026-09/payslips", { cookie: boss })).status, 200);
    assert.equal((await call("GET", `/api/documents/${doc.id}`, { cookie: boss })).status, 200);
    assert.equal((await call("GET", "/api/payroll/2026-09", { cookie: mgr })).status, 403);
    const ev = await rows(d, "table_name IN ('export', 'view', 'staff_documents', 'session') AND changed_by IN ('owner', 'mgr') AND action IN ('export', 'view', 'denied')");
    const exp = ev.find((e) => e.action === "export");
    assert.deepEqual([exp.table_name, exp.row_key, exp.changed_by, exp.ip], ["export", "daily.xlsx", "owner", IP]);
    assert.equal(JSON.parse(exp.new_value).period, "2026-09");
    assert.equal(ev.filter((e) => e.row_key === "payroll 2026-09" && e.action === "view").length, 1, "opening the same page twice is one line");
    assert.ok(ev.some((e) => e.row_key === "payslips 2026-09" && e.action === "view"));
    assert.ok(ev.some((e) => e.table_name === "staff_documents" && e.action === "view" && e.row_key === `document ${doc.id}`));
    const denied = ev.find((e) => e.action === "denied");
    assert.deepEqual([denied.changed_by, JSON.parse(denied.new_value).path], ["mgr", "/api/payroll/2026-09"]);
    // the upload itself was already in the trail
    assert.ok((await rows(d, "table_name = 'staff_documents' AND action = 'upload'")).length === 1);
  } finally { srv.close(); }
});

test("who sees what in the trail: the admin everything, a hub manager no sign-ins or downloads and only their own actions, and a hub user only their own actions", async () => {
  const { d } = await setup();
  const { srv, call, json, signIn } = await serve(d);
  try {
    const boss = await signIn("owner"), mgr = await signIn("mgr");
    await call("GET", "/api/export/daily.xlsx?period=2026-09", { cookie: boss });
    await call("PUT", "/api/staff/G1", { cookie: mgr, body: { phone: "0770000001" } });
    const all = json(await call("GET", "/api/audit?limit=2000", { cookie: boss }));
    for (const area of ["session", "export", "staff", "daily_log", "users"]) assert.ok(all.some((a) => a.table_name === area), area);
    const mine = json(await call("GET", "/api/audit?limit=2000", { cookie: mgr }));
    assert.ok(mine.length >= 1 && mine.every((a) => a.changed_by === "mgr"), "a hub user sees only what they did themselves");
    assert.ok(!mine.some((a) => a.table_name === "session"));
    // the action filter
    const logins = json(await call("GET", "/api/audit?action=login&limit=2000", { cookie: boss }));
    assert.ok(logins.length >= 3 && logins.every((a) => a.action === "login"));
    // the exported trail follows the same rules and has the address column
    const xl = await call("GET", "/api/export/audit.xlsx", { cookie: boss });
    assert.equal(xl.status, 200);
    assert.ok(xl.buf.length > 800);
  } finally { srv.close(); }
});

test("the audit trail cannot be changed or deleted, not even directly in the database", async () => {
  const { d } = await setup();
  const before = (await rows(d)).length;
  await assert.rejects(() => d.exec("UPDATE audit_log SET changed_by = 'someone-else'"), /cannot be changed or deleted/);
  await assert.rejects(() => d.exec("DELETE FROM audit_log WHERE table_name = 'staff'"), /cannot be changed or deleted/);
  await assert.rejects(() => d.run("UPDATE audit_log SET new_value = 'x' WHERE id = 1"), /cannot be changed or deleted/);
  assert.equal((await rows(d)).length, before);
  await svc.createEntry(d, "hubs", { code: "KDY", name: "Kandy" }, "owner"); // adding to it still works
  assert.ok((await rows(d)).length > before);
});
