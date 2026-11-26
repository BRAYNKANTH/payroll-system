// The go-live tool: reads the hubs and people files, tries every row against the real rules, and loads them (clearing demo data if asked).
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const golive = require("../tools/golive");

const HUBS = `code,name,location,phone
J1,J1,,
J2,J2,,
J3,J3,,
CHV,Chavakachcheri,,
K1,K1 Branch,,
K2,K2 Branch,,
`;
// the owner's charts, with a hub given to everyone for the test
const PEOPLE = `employee_id,name,position,reports_to,hub,coacher,basic_pay,phone
PM01,Sathis II,promoting manager,,J3,yes,30000,
PM02,Satheesraj,promoting manager,,J1,no,30000,
PM03,Roshany,promoting manager,PM01,J2,yes,30000,
PM04,Dinesh I,promoting manager,PM03,J2,no,30000,
PM05,Dinesh II,promoting manager,PM03,J2,no,30000,
PM06,Sajeevan,promoting manager,PM04,K1,no,30000,
PM07,Jinthusa,promoting manager,PM05,J2,no,30000,
M01,Issany,manager,,J1,yes,30000,
M02,Rasath,manager,,CHV,yes,30000,
M03,Vasanth,manager,,K2,yes,30000,
M04,Edman,manager,PM06,K1,yes,30000,
M05,Santhees,manager,,J1,no,27000,
M06,Sivasri,manager,,J1,no,27000,
M07,Kirushika,manager,PM02,J1,no,27000,
M08,Visnuka,manager,PM01,J3,no,27000,
M09,Sugath,manager,PM01,J3,no,27000,
M10,Rinosha,manager,PM07,J2,no,27000,
`;
const plan = (people = PEOPLE, hubs = HUBS) => golive.prepare(golive.parseCsv(hubs), golive.parseCsv(people));

test("the csv reader handles quotes, commas inside them, a BOM and Windows line endings", () => {
  const rows = golive.parseCsv('﻿code,name\r\nA,"Hub, one"\r\nB,"say ""hi"""\r\n\r\n');
  assert.deepEqual(rows.map((r) => [r.code, r.name]), [["A", "Hub, one"], ["B", 'say "hi"']]);
});

test("the owner's six hubs and seventeen people pass every rule, people added after the one they report to", async () => {
  const p = plan();
  assert.deepEqual(p.problems, []);
  assert.equal(p.hubs.length, 6);
  assert.equal(p.people.length, 17);
  const at = Object.fromEntries(p.people.map((x, i) => [x.employee_id, i]));
  for (const x of p.people) if (x.upline_id) assert.ok(at[x.upline_id] < at[x.employee_id], `${x.name} comes after their upline`);
  assert.deepEqual(await golive.check(p), []);
  const coaches = p.people.filter((x) => x.is_coacher).map((x) => [x.hub, x.name]).sort();
  assert.deepEqual(coaches, [["CHV", "Rasath"], ["J1", "Issany"], ["J2", "Roshany"], ["J3", "Sathis II"], ["K1", "Edman"], ["K2", "Vasanth"]]);
  assert.deepEqual([p.people.find((x) => x.employee_id === "PM01").basic_pay, p.people.find((x) => x.employee_id === "M05").basic_pay], [30000, 27000]);
});

test("a person with no hub yet, a missing coacher, two coachers, a circle or a seller under a promoting manager is reported, not loaded", async () => {
  assert.match(plan(PEOPLE.replace("M05,Santhees,manager,,J1", "M05,Santhees,manager,,")).problems.join("\n"), /Santhees.*no hub yet/);
  assert.match(plan(PEOPLE.replace("M03,Vasanth,manager,,K2,yes", "M03,Vasanth,manager,,K2,no")).problems.join("\n"), /hub K2.*no coacher/);
  assert.match(plan(PEOPLE.replace("M05,Santhees,manager,,J1,no", "M05,Santhees,manager,,J1,yes")).problems.join("\n"), /hub J1 has 2 coachers/);
  assert.match(plan(PEOPLE.replace("PM01,Sathis II,promoting manager,,", "PM01,Sathis II,promoting manager,PM03,")).problems.join("\n"), /in a circle/);
  assert.match(plan(PEOPLE.replace("M01,Issany,manager,,J1", "M01,Issany,manager,PM99,J1")).problems.join("\n"), /PM99, who is not in the file/);
  assert.match(plan(PEOPLE.replace("M01,Issany,manager", "M01,Issany,distributor")).problems.join("\n"), /position must be/);
  // the system's own rules are applied too: a manager cannot sit above a promoting manager
  const bad = plan(PEOPLE.replace("PM04,Dinesh I,promoting manager,PM03", "PM04,Dinesh I,promoting manager,M01"));
  assert.deepEqual(bad.problems, []);
  assert.match((await golive.check(bad))[0], /Dinesh I.*more senior/);
});

test("apply loads into an empty database, and refuses a database with demo data unless it is asked to erase", async () => {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: "password-12345" });
  const r = await golive.apply(d, plan());
  assert.deepEqual([r.after.hubs, r.after.staff], [6, 17]);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM staff WHERE is_coacher")).n, 6);
  await assert.rejects(() => golive.apply(d, plan()), /already holds 6 hubs and 17 people.*--erase-demo/);
});

test("erasing demo data clears hubs, people, sales and demo logins, and keeps the admin, settings, products and the audit trail", async () => {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: "password-12345" });
  const owner = await auth.userFromToken(d, (await auth.login(d, "owner", "password-12345")).token);
  await svc.createEntry(d, "hubs", { code: "OLD", name: "Demo hub" }, "owner");
  await svc.createEntry(d, "staff", { employee_id: "DM1", name: "Demo manager", hub: "OLD", staff_level: "manager", basic_pay: 27000, target: 100000, bank_account_no: "11112222" }, "owner");
  await svc.createEntry(d, "daily", { date: "2026-09-02", employee_id: "DM1", business_amount: 50000, settled_amount: 50000 }, "owner");
  await auth.createUser(d, owner, { username: "demo1", full_name: "Demo", role: "staff", employee_id: "DM1", password: "password-12345" });
  await d.run("INSERT INTO products (name, list_price, cost_price, created_by) VALUES ('Shine', 85000, 60000, 'owner')");
  const trail = Number((await d.get("SELECT COUNT(*) AS n FROM audit_log")).n);
  const r = await golive.apply(d, plan(), { eraseDemo: true });
  assert.deepEqual([r.before.hubs, r.before.staff, r.before.daily_log, r.before.logins], [1, 1, 1, 1]);
  assert.deepEqual([r.after.hubs, r.after.staff, r.after.daily_log, r.after.logins], [6, 17, 0, 0]);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM staff WHERE employee_id = 'DM1'")).n, 0);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM hubs WHERE code = 'OLD'")).n, 0);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM products WHERE name = 'Shine'")).n, 1, "the product catalogue stays");
  assert.ok(Number((await d.get("SELECT COUNT(*) AS n FROM audit_log")).n) >= trail, "the audit trail is never cleared");
  assert.ok((await auth.login(d, "owner", "password-12345")).token, "the admin can still sign in");
});

// ---- starter sellers, starter logins, and keeping chosen logins ----
const base = () => plan();

test("about ten sellers are added under every manager and promoting manager: two supervisors and eight distributors, in his hub, with the right pay", () => {
  const p = golive.withSellers(base(), 10);
  assert.equal(p.people.length, 17 + 170);
  const under = (id) => p.people.filter((x) => x.upline_id === id && /D\d|S\d/.test(x.employee_id));
  for (const m of base().people) {
    const mine = under(m.employee_id);
    assert.equal(mine.length, 10, `${m.name} has ten`);
    assert.deepEqual([mine.filter((x) => x.staff_level === "supervisor").length, mine.filter((x) => x.staff_level === "distributor").length], [2, 8]);
    assert.ok(mine.every((x) => x.hub === m.hub), "same hub as the manager");
  }
  const sup = p.people.find((x) => x.employee_id === "M01S01"), dist = p.people.find((x) => x.employee_id === "M01D01");
  assert.deepEqual([sup.target, sup.basic_pay, sup.food_min_days], [120000, 30000, 21], "a supervisor: higher target and basic, food from 21 days");
  assert.deepEqual([dist.target, dist.basic_pay, dist.food_min_days], [100000, 25000, 0]);
  assert.equal(new Set(p.people.map((x) => x.employee_id)).size, p.people.length, "every id is unique");
});

test("logins: one per person, usernames begin with a random number, everyone gets demo1234, and every one is valid and unique", () => {
  const p = golive.withSellers(base(), 10);
  const logins = golive.makeLogins(p, { taken: ["admin", "navoj"] });
  assert.equal(logins.length, 187);
  assert.ok(logins.every((l) => /^\d{4}-[a-z0-9-]+$/.test(l.username) && l.username.length <= 32 && l.password === "demo1234"));
  assert.equal(new Set(logins.map((l) => l.username.toLowerCase())).size, 187);
  assert.equal(logins.filter((l) => l.role === "manager").length, 17);
  assert.match(golive.toCsv(logins.slice(0, 1), ["username", "password"]), /^username,password\r\n\d{4}-sathis-ii,demo1234\r\n$/);
});

test("a username that is already taken is never reused", () => {
  let n = 0;
  const logins = golive.makeLogins({ people: [{ name: "Issany", staff_level: "manager", employee_id: "M01", hub: "J1" }] }, { taken: ["1111-issany"], random: () => (n++ === 0 ? 1111 : 2222) });
  assert.equal(logins[0].username, "2222-issany");
});

test("go-live with sellers and logins: the admin and the named login survive, everything else is rebuilt, and every new login signs in with demo1234", async () => {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "password-12345" });
  const admin = await auth.userFromToken(d, (await auth.login(d, "admin", "password-12345")).token);
  await auth.createUser(d, admin, { username: "navoj", full_name: "Navoj", role: "admin", password: "password-12345" });
  await svc.createEntry(d, "hubs", { code: "OLD", name: "Demo hub" }, "admin");
  await svc.createEntry(d, "staff", { employee_id: "DM1", name: "Demo manager", hub: "OLD", staff_level: "manager", basic_pay: 27000, target: 100000 }, "admin");
  await auth.createUser(d, admin, { username: "demo1", full_name: "Demo", role: "staff", employee_id: "DM1", password: "password-12345" });
  const p = golive.withSellers(base(), 10), logins = golive.makeLogins(p, { taken: ["admin", "navoj"] });
  await assert.rejects(() => golive.apply(d, p, { eraseDemo: true, keepUsers: ["admin", "nobody"], logins }), /nobody.*not found.*Nothing was changed/);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM hubs WHERE code = 'OLD'")).n, 1, "a refused run changes nothing");
  const r = await golive.apply(d, p, { eraseDemo: true, keepUsers: ["admin", "navoj"], logins });
  assert.deepEqual([r.after.hubs, r.after.staff], [6, 187]);
  assert.deepEqual(r.kept.map((u) => u.username).sort(), ["admin", "navoj"]);
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM users WHERE username = 'demo1'")).n, 0, "the demo login is gone");
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM users")).n, 189);
  assert.ok((await auth.login(d, "navoj", "password-12345")).token, "the kept login keeps its own password");
  for (const l of logins) assert.ok((await auth.login(d, l.username, "demo1234")).token, `${l.username} signs in`);
  const coach = await d.get("SELECT u.role FROM users u JOIN staff s ON s.employee_id = u.employee_id WHERE s.name = 'Issany' AND s.employee_id = 'M01'");
  assert.equal(coach.role, "coacher", "the hub's coacher gets the coacher login");
  assert.equal(JSON.parse((await db.getSettings(d)).position_defaults).supervisor.food_min_days, 21, "new people pre-fill the 21-day food rule");
});
