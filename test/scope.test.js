// Who sees what: a coacher heads a hub and sees all of it; a manager sees only the people under them; a stock keeper (a manager with the tag)
// can also handle the stock of everyone in the hub. Nobody below the admin sees pay.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const products = require("../products");
const sales = require("../sales");
const { createServer } = require("../server");

const PW = "scope-pass-12";
// H1: coacher C1 -> promoting manager PM1 -> managers M1 (sellers D1, D2) and M2 (seller D3); a supervisor S1 under D... none. H2 has its own people.
async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  for (const code of ["H1", "H2"]) await svc.createEntry(d, "hubs", { code, name: `Hub ${code}` }, "owner");
  const add = (id, level, upline, hub = "H1") => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: level, ...(upline ? { upline_id: upline } : {}),
    basic_pay: 30000, target: 100000, commission_rate: 0.3, bank_account_no: "1111" + id.replace(/\D/g, "").padStart(4, "0") }, "owner");
  await add("C1", "coacher"); await add("PM1", "promoting_manager", "C1"); await add("M1", "manager", "PM1"); await add("M2", "manager", "PM1");
  await add("D1", "distributor", "M1"); await add("D2", "distributor", "M1"); await add("D3", "distributor", "M2");
  await add("C2", "coacher", null, "H2"); await add("M9", "manager", "C2", "H2"); await add("D9", "distributor", "M9", "H2");
  await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "owner");
  const shine = Number((await d.get("SELECT id FROM products WHERE name = 'Shine'")).id);
  const pos = require("../pos");
  await products.addStock(d, shine, { qty: 100000 }, "owner");
  for (const hub of ["H1", "H2"]) await pos.giveToHub(d, { username: "owner" }, { hub, lines: [{ product_id: shine, qty: 500 }] }); // the office sends stock to each hub
  const login = (username, employee_id, role = "staff") => auth.createUser(d, admin, { username, full_name: username, role, employee_id, password: PW });
  await login("coach", "C1"); await login("man1", "M1"); await login("man2", "M2"); await login("promo", "PM1"); await login("seller", "D1"); await login("coach2", "C2");
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  for (const [id, biz] of [["D1", 50000], ["D2", 30000], ["D3", 70000], ["D9", 90000]]) await svc.createEntry(d, "daily", { date: day, employee_id: id, business_amount: biz, settled_amount: biz }, "owner");
  return { d, admin, shine, day };
}
const as = async (d, username) => auth.userFromToken(d, (await auth.login(d, username, PW)).token);

test("the position decides the kind of login: coacher, manager, or the staff portal", async () => {
  const { d, admin } = await setup();
  const kinds = Object.fromEntries((await auth.listUsers(d)).map((u) => [u.username, u.role]));
  assert.deepEqual([kinds.coach, kinds.man1, kinds.promo, kinds.seller], ["coacher", "manager", "manager", "staff"]);
  assert.equal((await auth.listUsers(d)).find((u) => u.username === "man1").hub, "H1", "a manager takes their hub from their own record");
  await assert.rejects(() => auth.createUser(d, admin, { username: "xx-one", full_name: "X", role: "manager", employee_id: "D2", password: PW }), /manager or a promoting manager/);
  await assert.rejects(() => auth.createUser(d, admin, { username: "xx-two", full_name: "X", role: "manager", password: PW }), /Choose the employee/);
  await assert.rejects(() => auth.updateUser(d, admin, "man1", { role: "admin" }), /cannot be changed/);
});

test("a manager's team is everyone who reports to them, directly or through others, and themselves", async () => {
  const { d } = await setup();
  assert.deepEqual([...(await as(d, "man1")).teamIds].sort(), ["D1", "D2", "M1"]);
  assert.deepEqual([...(await as(d, "man2")).teamIds].sort(), ["D3", "M2"]);
  assert.deepEqual([...(await as(d, "promo")).teamIds].sort(), ["D1", "D2", "D3", "M1", "M2", "PM1"], "a promoting manager sees everyone below");
  const coach = await as(d, "coach");
  assert.equal(coach.teamIds, undefined, "a coacher is limited by hub, not by a list of people");
  assert.equal(JSON.stringify(await as(d, "man1")).includes("teamIds"), false, "the list is not sent to the browser");
});

test("permissions: a manager only looks at their people; a stock keeper handles stock; a coacher runs the hub", async () => {
  const { d } = await setup();
  const man = await as(d, "man1");
  assert.deepEqual(man.permissions, ["read_team", "self"]);
  for (const p of ["read", "enter_data", "manage_team", "stock", "view_pay"]) assert.ok(!auth.can(man, p), p);
  await svc.updateEntry(d, "staff", "M1", { stock_keeper: true }, "owner");
  const keeper = await as(d, "man1");
  assert.ok(auth.can(keeper, "stock") && keeper.stock_keeper === true);
  assert.ok(!auth.can(keeper, "enter_data") && !auth.can(keeper, "read"), "stock only, nothing else extra");
  const coach = await as(d, "coach");
  for (const p of ["read", "enter_data", "manage_team", "stock"]) assert.ok(auth.can(coach, p), p);
  assert.ok(!auth.can(coach, "view_pay"));
  await svc.updateEntry(d, "staff", "M1", { stock_keeper: "" }, "owner");
  assert.ok(!auth.can(await as(d, "man1"), "stock"), "taking the tag away takes the access away");
});

async function http(d) {
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cookies = {};
  const call = async (who, method, p, body) => {
    if (!cookies[who]) {
      const r = await fetch(base + "/api/auth/login", { method: "POST", body: JSON.stringify({ username: who, password: PW }), headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" } });
      assert.equal(r.status, 200, `${who} signs in`);
      cookies[who] = r.headers.get("set-cookie").split(";")[0];
    }
    const r = await fetch(base + p, { method, body: body && JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: cookies[who] } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { call, close: () => srv.close() };
}

test("HTTP: a manager sees only their own people, a coacher the whole hub", async () => {
  const { d } = await setup();
  const { call, close } = await http(d);
  try {
    const ids = async (who) => (await call(who, "GET", "/api/staff")).json.map((s) => s.employee_id).sort();
    assert.deepEqual(await ids("man1"), ["D1", "D2", "M1"]);
    assert.deepEqual(await ids("man2"), ["D3", "M2"]);
    assert.deepEqual(await ids("coach"), ["C1", "D1", "D2", "D3", "M1", "M2", "PM1"], "the whole hub, and nothing of the other hub");
    assert.ok((await ids("owner")).includes("D9"), "the admin sees every hub");
    // profiles and reports: own people yes, a colleague's people no
    assert.equal((await call("man1", "GET", "/api/staff/D1/profile")).status, 200);
    assert.equal((await call("man1", "GET", "/api/staff/D3/profile")).status, 403);
    assert.equal((await call("man1", "GET", "/api/staff/D3/report.pdf")).status, 403);
    // a report lists a person's sales day by day, so a manager prints their own only, not even their own people's
    assert.equal((await call("man1", "GET", "/api/staff/D2/report.pdf")).status, 403);
    assert.equal((await call("man1", "GET", "/api/staff/M1/report.pdf")).status, 200);
    assert.equal((await call("man1", "GET", "/api/staff/D1/profile")).json.staff.basic_pay, undefined, "no pay terms");
    // the live sales view: a manager's own sales only (M1 sold nothing), never the business of the people under them
    const live = (await call("man1", "GET", "/api/live")).json;
    assert.deepEqual(live.people.map((p) => p.employee_id), []);
    assert.deepEqual(live.feed, []);
    assert.deepEqual(live.roster.map((r) => r.employee_id), ["M1"]);
    assert.deepEqual((await call("coach", "GET", "/api/live")).json.people.map((p) => p.employee_id).sort(), ["D1", "D2", "D3"]);
  } finally { close(); }
});

test("HTTP: a manager reaches nothing that shows the whole hub", async () => {
  const { d } = await setup();
  const { call, close } = await http(d);
  try {
    for (const p of ["/api/dashboard", "/api/daily", "/api/weekly", "/api/stock", "/api/allowances", "/api/loans", "/api/periods", "/api/audit", "/api/reports/stock", "/api/stock-issues"]) {
      assert.equal((await call("man1", "GET", p)).status, 403, p);
    }
    assert.equal((await call("man1", "POST", "/api/sales/confirm", { all: true, period: "2026-01" })).status, 403);
    // what the app needs to start, and My page, still work
    assert.equal((await call("man1", "GET", "/api/hubs")).status, 200);
    assert.equal((await call("man1", "GET", "/api/settings")).status, 200);
    assert.equal((await call("man1", "GET", "/api/me/portal")).status, 200);
    assert.deepEqual((await call("man1", "GET", "/api/hubs")).json.map((h) => h.code), ["H1"]);
    const state = (await call("man1", "GET", "/api/auth/state")).json;
    assert.ok(state.hubs && state.settings, "the shell gets its start-up data");
  } finally { close(); }
});

test("HTTP: Team sales gives a manager only the total of their team, never a person, stock or pay", async () => {
  const { d, shine } = await setup();
  const { call, close } = await http(d);
  try {
    await call("coach", "POST", "/api/stock-issues", { employee_id: "D1", lines: [{ product_id: shine, qty: 6 }] });
    const t = (await call("man1", "GET", "/api/team")).json;
    assert.deepEqual(Object.keys(t).sort(), ["business", "date", "days", "period"], "totals only");
    assert.deepEqual(Object.keys(t.business).sort(), ["month", "today"]);
    assert.ok(!JSON.stringify(t).match(/D1|D2|members|basic|net_pay|gross|commission|stock|5000000/i), "no people, no pay, no stock anywhere");
    assert.equal((await call("seller", "GET", "/api/team")).status, 403, "a seller has no team page");
    assert.equal((await call("coach", "GET", "/api/team")).json.business.month, 0, "a coacher uses the hub pages, not Team sales");
  } finally { close(); }
});

test("HTTP: the coacher gives stock to the whole hub; a stock keeper may too; a plain manager may not", async () => {
  const { d, shine } = await setup();
  const { call, close } = await http(d);
  try {
    const give = (who, id) => call(who, "POST", "/api/stock-issues", { employee_id: id, lines: [{ product_id: shine, qty: 2 }] });
    assert.equal((await give("coach", "D3")).status, 200, "the coacher, anyone in the hub");
    assert.equal((await give("coach", "D9")).status, 403, "but not another hub");
    assert.equal((await give("man1", "D1")).status, 403, "a plain manager cannot");
    await svc.updateEntry(d, "staff", "M1", { stock_keeper: true }, "owner");
    assert.equal((await give("man1", "D3")).status, 200, "a stock keeper reaches a colleague's seller too");
    assert.equal((await give("man1", "D9")).status, 403, "but only inside their hub");
    const morning = (await call("man1", "GET", "/api/stock-issues")).json;
    assert.deepEqual(morning.sellers.map((s) => s.employee_id).sort(), ["D1", "D2", "D3", "M1", "M2", "PM1"], "everyone who sells in the hub: the sellers, the managers and the promoting manager (he sells sometimes)");
    // a stock keeper still cannot see the rest of the hub
    assert.equal((await call("man1", "GET", "/api/daily")).status, 403);
    assert.equal((await call("man1", "GET", "/api/staff/D3/profile")).status, 403);
  } finally { close(); }
});

test("HTTP: the coacher can confirm days and enter data for the hub, but not for another hub, and never sees pay", async () => {
  const { d, day } = await setup();
  const { call, close } = await http(d);
  try {
    assert.equal((await call("coach", "GET", "/api/daily?period=" + day.slice(0, 7))).status, 200);
    assert.equal((await call("coach", "GET", "/api/payroll/" + day.slice(0, 7))).status, 403);
    assert.equal((await call("coach", "GET", "/api/review-queue")).status, 403);
    assert.equal((await call("man1", "POST", "/api/staff", { employee_id: "X1", name: "X", hub: "H1", staff_level: "distributor" })).status, 403, "a manager cannot add people");
    assert.equal((await call("coach", "POST", "/api/staff", { employee_id: "X1", name: "X", hub: "H1", staff_level: "distributor", upline_id: "M1" })).status, 200, "a coacher can");
    assert.equal((await call("coach", "POST", "/api/staff", { employee_id: "X2", name: "X", hub: "H2", staff_level: "distributor", upline_id: "M9" })).status, 403, "not in another hub");
    assert.equal(typeof sales.today(), "string");
  } finally { close(); }
});

test("HTTP: only the admin sends stock to a hub; a coacher or stock keeper sees their own hub's stock; a manager sees none", async () => {
  const { d, shine } = await setup();
  const { call, close } = await http(d);
  try {
    const send = (who, hub) => call(who, "POST", "/api/hub-stock", { hub, lines: [{ product_id: shine, qty: 5 }] });
    assert.equal((await send("coach", "H1")).status, 403, "a coacher gives out stock, they do not create it");
    assert.equal((await send("man1", "H1")).status, 403);
    assert.equal((await send("owner", "H1")).status, 200);
    const mine = (await call("coach", "GET", "/api/hub-stock")).json;
    assert.deepEqual(mine.hubs.map((h) => h.code), ["H1"], "a coacher sees only their own hub");
    assert.equal(mine.hubs[0].stock[0].left, 505);
    assert.deepEqual((await call("owner", "GET", "/api/hub-stock")).json.hubs.map((h) => h.code), ["H1", "H2"]);
    assert.equal((await call("man1", "GET", "/api/hub-stock")).status, 403, "a plain manager has no stock pages");
    await svc.updateEntry(d, "staff", "M1", { stock_keeper: true }, "owner");
    assert.deepEqual((await call("man1", "GET", "/api/hub-stock")).json.hubs.map((h) => h.code), ["H1"], "a stock keeper sees the hub's stock");
    const id = (await call("owner", "GET", "/api/hub-stock")).json.hubs[0].recent[0].id;
    assert.equal((await call("coach", "DELETE", `/api/hub-stock/${id}`)).status, 403);
    assert.equal((await call("owner", "DELETE", `/api/hub-stock/${id}`)).status, 200);
  } finally { close(); }
});
