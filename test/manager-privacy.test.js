// A manager enters their own sales and knows who is under them. They never see what the people under them sold.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const portal = require("../portal");
const { createServer } = require("../server");

const PW = "password-12345";
const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  await svc.createEntry(d, "hubs", { code: "COL", name: "Colombo" }, "owner");
  const add = (id, level, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "COL", staff_level: level, bank_account_no: "11112222", basic_pay: 25000, ...extra }, "owner");
  await add("C1", "coacher");
  await add("M1", "manager", { upline_id: "C1" });
  await add("S1", "supervisor", { upline_id: "M1", target: 100000, pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25 });
  await add("D1", "distributor", { upline_id: "M1", target: 100000, pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25 });
  await add("D9", "distributor", { upline_id: "C1", target: 100000, pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25 });
  for (const [id, biz] of [["M1", 11111], ["S1", 22222], ["D1", 33333], ["D9", 44444]]) await svc.createEntry(d, "daily", { date: day, employee_id: id, business_amount: biz, settled_amount: biz }, "owner");
  await auth.createUser(d, admin, { username: "mgr", full_name: "Manager", role: "manager", employee_id: "M1", password: PW });
  await auth.createUser(d, admin, { username: "coach", full_name: "Coacher", role: "coacher", hub: "COL", password: PW });
  return d;
}

test("a manager sees only the total business of their team: no names, no people, nothing about anyone above", async () => {
  const d = await setup();
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const signIn = async (username) => (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ username, password: PW }) })).headers.get("set-cookie").split(";")[0];
  const get = async (p, cookie) => { const r = await fetch(base + p, { headers: { Cookie: cookie } }); return { status: r.status, body: await r.text() }; };
  const json = async (p, cookie) => JSON.parse((await get(p, cookie)).body);
  const month = day.slice(0, 7);
  try {
    const mgr = await signIn("mgr");

    // Team sales: only how much the team did, in total. No names, no positions, nobody above them, not even their own sales.
    const team = await json(`/api/team?period=${month}`, mgr);
    assert.equal(team.members, undefined, "no list of people");
    assert.deepEqual(team.business, { today: 5555500, month: 5555500 }, "S1 + D1 only: not the manager's own sales, not the coacher's team (D9)");
    assert.deepEqual(team.days, [{ date: day, business: 5555500 }]);
    assert.ok(!/Name |"S1"|"D1"|"C1"|"D9"|11111|22222|33333|44444/.test(JSON.stringify(team)), "no names, ids or single person's figures");

    // Live sales: only their own entries, and only themselves in the roster
    const live = await json(`/api/live?period=${month}`, mgr);
    assert.deepEqual([...new Set(live.feed.map((f) => f.employee_id))], ["M1"]);
    assert.deepEqual(live.people.map((p) => p.employee_id), ["M1"]);
    assert.deepEqual(live.roster.map((r) => r.employee_id), ["M1"]);
    assert.ok(!/22222|33333|44444|"S1"|"D1"/.test(JSON.stringify(live)), "nobody else's sales");

    // Their own page: no list of people at all
    const me = await json(`/api/me/portal?period=${month}`, mgr);
    assert.equal(me.team_sales_hidden, true);
    assert.ok(!me.team, "no list of people");
    assert.ok(!me.below_sales, "no team figure on their page");
    assert.equal(me.month.business, 1111100, "their own sales are still theirs");

    // A team member's report lists their sales day by day: a manager may print only their own
    assert.equal((await get(`/api/staff/D1/report.pdf?period=${month}`, mgr)).status, 403);
    assert.equal((await get(`/api/staff/M1/report.pdf?period=${month}`, mgr)).status, 200);

    // The coacher and the office still see everything
    const coach = await signIn("coach");
    const all = await json(`/api/live?period=${month}`, coach);
    assert.deepEqual(all.people.map((p) => p.employee_id).sort(), ["D1", "D9", "M1", "S1"]);
    const owner = await signIn("owner");
    assert.equal((await get(`/api/staff/D1/report.pdf?period=${month}`, owner)).status, 200);
    const full = await portal.forEmployee(d, "M1", month, undefined);
    assert.ok(full.team.every((t) => typeof t.business === "number") && full.below_sales > 0, "the office sees the team's sales on a manager's report");
  } finally { srv.close(); }
});

test("a stock keeper manager sees which stock sellers hold, never how much they sold", async () => {
  const d = await setup();
  await d.run("UPDATE staff SET stock_keeper = true WHERE employee_id = 'M1'");
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const signIn = async (username) => (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ username, password: PW }) })).headers.get("set-cookie").split(";")[0];
  const json = async (p, cookie) => JSON.parse(await (await fetch(base + p, { headers: { Cookie: cookie } })).text());
  try {
    const mgr = await signIn("mgr"), coach = await signIn("coach");
    for (const path of ["/api/stock-overview", `/api/stock-overview?from=${day}&to=${day}`, `/api/stock-issues?date=${day}`]) {
      const asManager = JSON.stringify(await json(path, mgr));
      assert.ok(!/"sold/.test(asManager), `${path}: no sold figures for a manager`);
      assert.ok(/"sold/.test(JSON.stringify(await json(path, coach))), `${path}: the coacher still sees them`);
    }
  } finally { srv.close(); }
});
