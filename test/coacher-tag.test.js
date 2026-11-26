// A coacher is a manager or promoting manager carrying the coacher tag: the head of one hub. Pay and place in the chart follow the position.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const pos = require("../pos");
const portal = require("../portal");

const PW = "password-12345";
async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "owner", full_name: "Owner", password: PW });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", PW)).token);
  for (const [code, name] of [["H1", "Hub 1"], ["H2", "Hub 2"]]) await svc.createEntry(d, "hubs", { code, name }, "owner");
  const add = (id, level, hub, upline, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: level, upline_id: upline, bank_account_no: "11112222", basic_pay: 30000, ...extra }, "owner");
  return { d, admin, add };
}

test("the coacher tag goes on a manager or a promoting manager, one per hub", async () => {
  const { d, add } = await setup();
  await add("PM1", "promoting_manager", "H1", undefined, { is_coacher: true });
  await add("M1", "manager", "H1", "PM1");
  await assert.rejects(() => add("M2", "manager", "H1", "PM1", { is_coacher: true }), /already has a coacher \(Name PM1\)/, "one coacher per hub");
  await add("M3", "manager", "H2", undefined, { is_coacher: true }); // another hub is fine
  await assert.rejects(() => add("D1", "distributor", "H1", "M1", { is_coacher: true, pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25 }), /Only a manager or a promoting manager/);
  // taking the tag off one lets another hold it
  await svc.updateEntry(d, "staff", "PM1", { is_coacher: false }, "owner");
  await svc.updateEntry(d, "staff", "M1", { is_coacher: true }, "owner");
  assert.equal((await d.get("SELECT COUNT(*) AS n FROM staff WHERE is_coacher AND hub = 'H1'")).n, 1);
  // a coacher who has left no longer holds the hub: a new one can be tagged
  await svc.updateEntry(d, "staff", "M1", { status: "inactive" }, "owner");
  await svc.updateEntry(d, "staff", "PM1", { is_coacher: true }, "owner");
});

test("a login follows the tag: the coacher's login is a hub-head login, and goes back to a manager login without it", async () => {
  const { d, admin, add } = await setup();
  await add("M1", "manager", "H1");
  const made = await auth.createUser(d, admin, { username: "mgr_one", full_name: "M1", role: "staff", employee_id: "M1", password: PW });
  assert.equal(made.role, "manager");
  assert.ok(!auth.can(made, "enter_data"), "an ordinary manager does not enter data");
  await svc.updateEntry(d, "staff", "M1", { is_coacher: true }, "owner");
  const head = await auth.userFromToken(d, (await auth.login(d, "mgr_one", PW)).token);
  assert.deepEqual([head.role, head.hub], ["coacher", "H1"]);
  assert.ok(auth.can(head, "enter_data") && auth.can(head, "manage_team") && auth.can(head, "self"), "hub-head screens, and still their own page");
  await svc.updateEntry(d, "staff", "M1", { is_coacher: false }, "owner");
  assert.equal((await auth.userFromToken(d, (await auth.login(d, "mgr_one", PW)).token)).role, "manager");
  // a tagged person's login is made as a coacher login from the start
  await add("PM9", "promoting_manager", "H2", undefined, { is_coacher: true });
  assert.equal((await auth.createUser(d, admin, { username: "pmnine", full_name: "PM9", role: "staff", employee_id: "PM9", password: PW })).role, "coacher");
  // a coacher login can only be linked to a hub's coacher
  await add("M7", "manager", "H1"); // an ordinary manager, no tag, no login yet
  await assert.rejects(() => auth.createUser(d, admin, { username: "xuser", full_name: "X", role: "coacher", hub: "H1", employee_id: "M7", password: PW }), /hub's coacher/);
});

test("the hub's coacher is found by the tag (morning stock overview)", async () => {
  const { d, add } = await setup();
  await add("M1", "manager", "H1", undefined, { is_coacher: true });
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const m = await pos.morning(d, { date: day });
  assert.equal(m.hubs.find((h) => h.code === "H1").coacher.name, "Name M1");
  assert.equal(m.hubs.find((h) => h.code === "H2").coacher, null);
});

test("the reporting chart crosses hubs: a promoting manager's team includes managers of another hub", async () => {
  const { d, add } = await setup();
  await add("PM1", "promoting_manager", "H1");
  await add("M1", "manager", "H2", "PM1", { is_coacher: true }); // the coacher of H2 reports to someone from H1
  const p = await portal.forEmployee(d, "PM1", new Date().toISOString().slice(0, 7));
  assert.deepEqual(p.team.map((t) => t.employee_id), ["M1"]);
});

test("when the coacher leaves, the tag and their team go to the person who takes over", async () => {
  const people = require("../people");
  const { d, add } = await setup();
  await add("PM1", "promoting_manager", "H1", undefined, { is_coacher: true });
  await add("PM2", "promoting_manager", "H1");
  await add("M1", "manager", "H1", "PM1");
  await people.leave(d, "PM1", { replacement_id: "PM2", leave_date: "2026-09-30", reason: "Moved on" }, "owner");
  const row = (id) => d.get("SELECT is_coacher, status, upline_id FROM staff WHERE employee_id = ?", id);
  assert.deepEqual([(await row("PM1")).is_coacher, (await row("PM1")).status], [false, "inactive"], "the leaver no longer holds the tag");
  assert.equal((await row("PM2")).is_coacher, true, "the replacement is now the hub's coacher");
  assert.equal((await row("M1")).upline_id, "PM2", "their team moved too");
});
