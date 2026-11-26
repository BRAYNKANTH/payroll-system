// Distributors enter their own sales; the office confirms them; the admin sees each sale, its commission and the pay so far.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");

const ADMIN = { username: "admin" };
const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, level, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: level, bank_account_no: "11112222", ...extra }, "admin");
  await add("M1", "manager", { basic_pay: 27000 });
  await add("D1", "distributor", { upline_id: "M1", ...seller });
  await add("D2", "distributor", { upline_id: "M1", ...seller });
  await add("D9", "distributor", { hub: "H2", ...seller });
  return d;
}
const login = (d, employee, username) => auth.createUser(d, ADMIN, { username, full_name: employee, role: "staff", employee_id: employee, password: "portal1234" });
const day = (n = 0) => { const t = new Date(sales.today() + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10); };
const period = () => sales.today().slice(0, 7);

test("only the admin may see pay in the live view", () => {
  assert.ok(auth.can({ role: "admin" }, "view_pay"));
  for (const role of ["manager", "staff"]) assert.ok(!auth.can({ role }, "view_pay"), role);
});

test("a seller enters their own day; it is unconfirmed, and they can correct or remove it until the office confirms it", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  const row = await sales.addSale(d, u, { date: day(), business_amount: 45000, settled_amount: 41000, personal_minus: 500, notes: "Market day" });
  assert.deepEqual([row.source, row.business_amount, row.settled_amount, row.settle_up_minus, row.personal_minus, row.confirmed_by], ["portal", 4500000, 4100000, 400000, 50000, null]);
  assert.equal(row.created_by, "u-d1");
  // entering the same day again corrects it, it does not add a second row
  const again = await sales.addSale(d, u, { date: day(), business_amount: 47000, settled_amount: 43000 });
  assert.equal(again.id, row.id);
  assert.equal(again.business_amount, 4700000);
  assert.equal((await svc.listEntries(d, "daily", { employee_id: "D1" })).length, 1);
  // removing works while unconfirmed
  assert.deepEqual(await sales.removeSale(d, u, day()), { deleted: true });
  assert.equal((await svc.listEntries(d, "daily", { employee_id: "D1" })).length, 0);

  await sales.addSale(d, u, { date: day(), business_amount: 1000, settled_amount: 1000 });
  assert.equal((await sales.confirm(d, { username: "boss" }, { all: true, period: period() })).confirmed, 1);
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: 5, settled_amount: 5 }), /already recorded by the office/);
  await assert.rejects(() => sales.removeSale(d, u, day()), /already confirmed/);
});

test("rules for a self-entered day: not in the future, at most a week back, real numbers, and never over the office's entry", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  const ok = { business_amount: 100, settled_amount: 100 };
  await assert.rejects(() => sales.addSale(d, u, { ...ok, date: day(-1) }), /not happened yet/);
  await assert.rejects(() => sales.addSale(d, u, { ...ok, date: day(sales.DAYS_BACK + 1) }), /days back/);
  await assert.rejects(() => sales.addSale(d, u, { ...ok, date: "05/11/2026" }), /YYYY-MM-DD/);
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: -5, settled_amount: 1 }), /Sales must be/);
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: "abc", settled_amount: 1 }), /Sales must be/);
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: 5 }), /Money handed in is required/);
  // a day the office already entered cannot be overwritten by the seller
  await svc.createEntry(d, "daily", { date: day(2), employee_id: "D1", business_amount: 9000, settled_amount: 9000 }, "clerk");
  await assert.rejects(() => sales.addSale(d, u, { ...ok, date: day(2) }), /already recorded by the office/);
  // only sellers can use it: a manager's login is not a staff login at all, and an inactive seller is refused
  await svc.updateEntry(d, "staff", "D1", { status: "inactive" }, "admin");
  await assert.rejects(() => sales.addSale(d, u, { ...ok, date: day() }), /no longer active/);
  await assert.rejects(() => sales.addSale(d, { username: "x" }, { ...ok, date: day() }), /not linked/);
});

test("a closed month takes no more self-entered days", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  const p = period();
  await sales.addSale(d, u, { date: day(), business_amount: 1000, settled_amount: 1000 });
  await sales.confirm(d, { username: "boss" }, { all: true, period: p });
  await svc.runPeriod(d, p, "acct");
  for (const r of (await svc.getPeriod(d, p)).rows.filter((x) => x.status === "pending_review")) await svc.review(d, p, r.employee_id, "admin", "approved", "ok");
  await svc.finalizePeriod(d, p, "admin");
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: 1, settled_amount: 1 }), /closed/);
});

test("a seller cannot hand in more than they sold: extra cash would otherwise raise their own pay", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  await assert.rejects(() => sales.addSale(d, u, { date: day(), business_amount: 1000, settled_amount: 1001 }), /cannot be more than your sales/);
  await sales.addSale(d, u, { date: day(), business_amount: 1000, settled_amount: 1000 }); // exactly the sales is fine
});

test("a month cannot be closed while sellers' days wait for the coacher's approval", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  const p = period();
  await sales.addSale(d, u, { date: day(), business_amount: 5000, settled_amount: 5000 });
  await assert.rejects(() => svc.finalizePeriod(d, p, "admin"), /not approved yet/);
  await sales.confirm(d, { username: "coach" }, { all: true, period: p }, "H1");
  await svc.finalizePeriod(d, p, "admin"); // approved: it closes
  assert.equal((await svc.getPeriod(d, p)).status, "finalized");
});

test("the dashboard's sales and cash follow a date range; without one it is the pay month", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D1", business_amount: 1000, settled_amount: 900 }, "clerk");
  await svc.createEntry(d, "daily", { date: "2026-10-20", employee_id: "D1", business_amount: 3000, settled_amount: 3000 }, "clerk");
  const k = (x) => [x.kpis.hub_business, x.kpis.settle_up];
  assert.deepEqual(k(await svc.dashboard(d, "2026-10")), [400000, 10000], "no range: the whole month");
  assert.deepEqual(k(await svc.dashboard(d, "2026-10", undefined, { from: "2026-10-01", to: "2026-10-10" })), [100000, 10000]);
  assert.deepEqual(k(await svc.dashboard(d, "2026-10", undefined, { from: "2026-10-11", to: "2026-10-31" })), [300000, 0]);
  assert.deepEqual(k(await svc.dashboard(d, "2026-10", undefined, { from: "2026-09-25", to: "2026-10-31" })), [400000, 10000], "a range may reach outside the month");
  const h1 = await svc.dashboard(d, "2026-10", undefined, { from: "2026-10-01", to: "2026-10-10" });
  assert.equal(h1.by_hub.find((h) => h.code === "H1").hub_business, 100000);
  assert.equal((await svc.dashboard(d, "2026-10", "H2", { from: "2026-10-01", to: "2026-10-31" })).kpis.hub_business, 0, "a hub sees only its own sales");
  await assert.rejects(() => svc.dashboard(d, "2026-10", undefined, { from: "2026-10-10", to: "2026-10-01" }), /start date is after/);
  await assert.rejects(() => svc.dashboard(d, "2026-10", undefined, { from: "nope", to: "2026-10-01" }), /YYYY-MM-DD/);
});

test("payroll flags days nobody has confirmed, and the flag goes once they are confirmed", async () => {
  const d = await setup();
  const u = await login(d, "D1", "u-d1");
  const p = period();
  await sales.addSale(d, u, { date: day(), business_amount: 5000, settled_amount: 5000 });
  await svc.runPeriod(d, p, "acct");
  let r = (await svc.getPeriod(d, p)).rows.find((x) => x.employee_id === "D1");
  assert.equal(r.status, "auto_approved"); // nothing waits for approval; the flag stays as a note
  assert.ok(r.flags.some((f) => f.code === "UNCONFIRMED_SALES"));
  assert.equal(r.detail.unconfirmed_days, 1);
  await sales.confirm(d, { username: "boss" }, { all: true, period: p });
  await svc.runPeriod(d, p, "acct");
  r = (await svc.getPeriod(d, p)).rows.find((x) => x.employee_id === "D1");
  assert.ok(!r.flags.some((f) => f.code === "UNCONFIRMED_SALES"));
});

test("a hub user confirms only their own hub's days", async () => {
  const d = await setup();
  const u1 = await login(d, "D1", "u-d1");
  const u9 = await login(d, "D9", "u-d9");
  const a = await sales.addSale(d, u1, { date: day(), business_amount: 1000, settled_amount: 1000 });
  const b = await sales.addSale(d, u9, { date: day(), business_amount: 2000, settled_amount: 2000 });
  assert.equal((await sales.confirm(d, { username: "mgr" }, { ids: [a.id, b.id] }, "H1")).confirmed, 1);
  const rows = await svc.listEntries(d, "daily", {});
  assert.equal(rows.find((r) => r.id === a.id).confirmed_by, "mgr");
  assert.equal(rows.find((r) => r.id === b.id).confirmed_by, null);
  await assert.rejects(() => sales.confirm(d, { username: "mgr" }, {}, "H1"), /Choose the entries/);
  assert.equal((await sales.confirm(d, { username: "mgr" }, { all: true, period: period() }, "H1")).confirmed, 0);
});

test("live view: each sale shows its commission, with the higher rate on the part over target, and the pay so far", async () => {
  const d = await setup();
  const enter = (date, id, business) => svc.createEntry(d, "daily", { date, employee_id: id, business_amount: business, settled_amount: business - 1000 }, "clerk");
  await enter("2026-10-05", "D1", 90000);    // below the Rs 100,000 target: 25% of all sales
  await enter("2026-10-06", "D1", 20000);    // takes the month to 110,000: 10,000 at 25% and 10,000 at 30%
  await enter("2026-10-06", "M1", 30000);    // a manager sells too, with no pay figures of his own here
  const live = await sales.live(d, { period: "2026-10" }, true);
  const feed = live.feed.filter((f) => f.employee_id === "D1");
  assert.deepEqual(feed.map((f) => f.date), ["2026-10-06", "2026-10-05"], "newest first");
  const [second, first] = feed;
  assert.equal(first.pay.commission, 2250000);        // 25% of 90,000
  assert.equal(first.pay.gross_so_far, 2250000);
  assert.equal(second.pay.commission, 550000);        // 2,500 + 3,000
  assert.equal(second.pay.gross_so_far, 2800000);     // basic 25,000 + 30% of 10,000 over target
  assert.equal(second.month_business, 11000000);
  assert.equal(second.target_pct, 1.1);
  assert.equal(second.confirmed, true);
  const p = live.people.find((x) => x.employee_id === "D1");
  assert.deepEqual([p.days, p.business, p.pay.gross, p.pay.over_target], [2, 11000000, 2800000, 1000000]);
  assert.equal(p.pay.deductions, 200000, "the two days' short-fall of Rs 1,000 each");
  assert.equal(p.pay.net, 2800000 - 200000);
  assert.equal(live.feed.find((f) => f.employee_id === "M1").pay, undefined);
});

test("live view without pay rights shows the sales and nothing about pay; a hub filter keeps to one hub", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D1", business_amount: 90000, settled_amount: 90000 }, "clerk");
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D9", business_amount: 50000, settled_amount: 50000 }, "clerk");
  const noPay = await sales.live(d, { period: "2026-10" }, false);
  assert.equal(noPay.can_pay, false);
  assert.equal(noPay.feed.length, 2);
  assert.ok(noPay.feed.every((f) => f.pay === undefined && f.business > 0));
  assert.ok(noPay.people.every((x) => x.pay === undefined));
  assert.ok(!JSON.stringify(noPay).includes("gross") && !JSON.stringify(noPay).includes("commission"));
  const h2 = await sales.live(d, { period: "2026-10", hub: "H2" }, false);
  assert.deepEqual(h2.feed.map((f) => f.employee_id), ["D9"]);
});

test("live view groups people into teams, and lists everyone in the hub even before they have sold", async () => {
  const d = await setup();
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D1", business_amount: 90000, settled_amount: 90000 }, "clerk");
  const all = await sales.live(d, { period: "2026-10" }, false);
  assert.ok(all.roster.length > 1, "the roster has people with no sales too");
  assert.ok(all.roster.every((r) => r.team && typeof r.team.id === "string" && r.team.title));
  const sold = all.people.find((p) => p.employee_id === "D1");
  assert.equal(sold.team, all.roster.find((r) => r.employee_id === "D1").team.id, "a person and their roster entry agree on the team");
  assert.equal(all.feed[0].team, sold.team);
  const h2 = await sales.live(d, { period: "2026-10", hub: "H2" }, false);
  assert.ok(h2.roster.length && h2.roster.every((r) => r.hub === "H2"), "a hub filter keeps the roster to that hub");
  assert.ok(!h2.roster.some((r) => r.employee_id === "D1"));
  const own = await sales.live(d, { period: "2026-10", ids: ["D1"] }, false);
  assert.deepEqual(own.roster.map((r) => r.employee_id), ["D1"], "a manager sees only their own people");
});
