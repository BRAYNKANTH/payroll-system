// The hub's cash book: cash in from the daily sheets, what the coacher spends or pays out, the handovers, and the cash in hand day to day.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");
const sales = require("../sales");
const handover = require("../handover");
const cashbook = require("../cashbook");

const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 0, food_min_days: 0, security_deduction_rule: "none" };
const COACH = { username: "coach1", hub: "H1" };
const COACH2 = { username: "coach2", hub: "H2" };
const ADMIN = { username: "admin" };
const today = () => sales.today();
const period = () => today().slice(0, 7);

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, hub, up) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub, staff_level: id.startsWith("M") ? "manager" : "distributor", ...(up ? { upline_id: up } : {}), bank_account_no: "11112222", ...seller }, "admin");
  await add("M1", "H1"); await add("D1", "H1", "M1"); await add("D2", "H1", "M1"); await add("D9", "H2");
  return d;
}
const sell = (d, date, id, business, settled = business) => svc.createEntry(d, "daily", { date, employee_id: id, business_amount: business, settled_amount: settled }, "clerk");
const day = (b, date) => b.days.find((x) => x.date === date);

test("cash in comes from the sellers' handed-in cash; expenses, salaries and the handover take cash out", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 60000, 58000); await sell(d, today(), "D2", 40000);   // the hub handed in Rs 98,000
  await sell(d, today(), "D9", 500000);                                              // another hub's cash is not this hub's
  await cashbook.add(d, COACH, { kind: "expense", category: "Tea and transport", amount: "1,500" });
  await cashbook.add(d, COACH, { kind: "salary", category: "Salary", amount: 20000, note: "Thanusa" });
  await cashbook.add(d, COACH, { kind: "other_in", amount: 5000 });
  await cashbook.add(d, COACH, { kind: "online", amount: 12000 });                   // not cash in hand
  await handover.submit(d, COACH, { date: today(), amount: "90,000" });
  const b = await cashbook.book(d, "H1", period());
  const r = day(b, today());
  assert.deepEqual([r.cash_in, r.other_in, r.expenses, r.salaries, r.handed, r.online], [9800000, 500000, 150000, 2000000, 9000000, 1200000]);
  assert.equal(r.closing, 9800000 + 500000 - 150000 - 2000000 - 9000000, "cash in hand = in - out");
  assert.equal(b.closing, r.closing);
});

test("a handover the office sent back is not counted as cash out", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 100000);
  const h = await handover.submit(d, COACH, { date: today(), amount: "95,000" });
  assert.equal(day(await cashbook.book(d, "H1", period()), today()).handed, 9500000);
  await handover.verify(d, ADMIN, h.id, { approve: false, note: "Counted wrong" });
  const r = day(await cashbook.book(d, "H1", period()), today());
  assert.equal(r.handed, 0);
  assert.equal(r.handover_status, "rejected");
  assert.equal(r.closing, 10000000, "the cash is still in hand");
});

test("the running cash carries from day to day and from month to month", async () => {
  const d = await setup();
  const t = today(), y = sales.addDays(t, -1);
  await sell(d, y, "D1", 30000); await sell(d, t, "D1", 20000);
  await cashbook.add(d, COACH, { kind: "expense", date: y, amount: 1000 });
  const b = await cashbook.book(d, "H1", t.slice(0, 7));
  if (y.slice(0, 7) === t.slice(0, 7)) {
    assert.equal(day(b, y).closing, 2900000);
    assert.equal(day(b, t).opening, 2900000, "today starts with yesterday's cash");
    assert.equal(b.closing, 4900000);
  }
  // the next month opens with everything before it
  const next = svc.shiftPeriod(t.slice(0, 7), 1);
  assert.equal((await cashbook.book(d, "H1", next)).opening, 4900000);
});

test("the office sees each hub's cash; a coacher is limited to their own hub", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 10000); await sell(d, today(), "D9", 70000);
  const all = await cashbook.summary(d, { period: period() });
  assert.deepEqual(all.hubs.map((h) => [h.code, h.closing]), [["H1", 1000000], ["H2", 7000000]]);
  // a coacher is given their own hub and cannot write in another hub's book
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "expense", hub: "H2", amount: 100 }), /own hub/);
  const e = await cashbook.add(d, COACH2, { kind: "expense", amount: 300 });
  await assert.rejects(() => cashbook.remove(d, COACH, e.id), /another hub/);
  // the admin must say which hub
  await assert.rejects(() => cashbook.add(d, ADMIN, { kind: "expense", amount: 100 }), /Choose the hub/);
  assert.equal((await cashbook.add(d, ADMIN, { kind: "expense", hub: "H1", amount: 100 })).hub, "H1");
});

test("entries are checked: kind, amount, date, and a closed month cannot change", async () => {
  const d = await setup();
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "gift", amount: 100 }), /what kind/);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "expense", amount: 0 }), /above 0/);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "expense", amount: -5 }), /number/);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "expense", amount: 100, date: sales.addDays(today(), 1) }), /not happened/);
  const e = await cashbook.add(d, COACH, { kind: "expense", amount: 100 });
  assert.equal(e.category, "Other");
  assert.deepEqual(await cashbook.remove(d, COACH, e.id), { deleted: true });
  await assert.rejects(() => cashbook.remove(d, COACH, e.id), /not found/);
  // a month that has been closed is locked
  await sell(d, today(), "D1", 10000);
  const e2 = await cashbook.add(d, COACH, { kind: "expense", amount: 100 });
  await svc.runPeriod(d, period(), "admin");
  await svc.finalizePeriod(d, period(), "admin");
  await assert.rejects(() => cashbook.remove(d, COACH, e2.id), /closed/);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "expense", amount: 100 }), /closed/);
});

test("each team shows what it sold and what it handed in", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 60000, 55000); await sell(d, today(), "D2", 40000, 40000);
  const b = await cashbook.book(d, "H1", period());
  assert.equal(b.teams.length, 1);
  assert.deepEqual([b.teams[0].title, b.teams[0].sales, b.teams[0].cash, b.teams[0].not_handed_in], ["Name M1", 10000000, 9500000, 500000]);
});

test("the cash book edits are in the audit trail", async () => {
  const d = await setup();
  const e = await cashbook.add(d, COACH, { kind: "expense", category: "Fuel", amount: 250 });
  const log = await svc.auditSearch(d, { table: "cash_book_entries", key: String(e.id) });
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "create");
});

test("each team's cash by day, with what it still owed from before", async () => {
  const d = await setup();
  const t = today(), y = sales.addDays(t, -1);
  await sell(d, y, "D1", 60000, 55000);                       // yesterday D1 left Rs 5,000 not handed in
  await sell(d, t, "D1", 20000, 20000); await sell(d, t, "D2", 40000, 38000);
  const b = await cashbook.book(d, "H1", t.slice(0, 7));
  const today1 = b.team_days.find((x) => x.date === t);
  assert.deepEqual(today1.teams.map((x) => [x.id, x.sales, x.cash, x.gap]), [["M1", 6000000, 5800000, 200000]]);
  if (y.slice(0, 7) === t.slice(0, 7)) assert.equal(b.team_days.find((x) => x.date === y).teams[0].gap, 500000);
  else assert.equal(b.team_carried.M1, 500000, "yesterday was last month, so it is carried in");
  assert.equal(b.team_meta.find((m) => m.id === "M1").title, "Name M1");
});

test("cash a manager took is recorded in the cash book and deducted from their pay for that week", async () => {
  const d = await setup();
  await svc.updateEntry(d, "staff", "M1", { basic_pay: 27000, target: 100000 }, "admin");
  const t = today();
  await sell(d, t, "D1", 60000); await sell(d, t, "D2", 40000);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "draw", amount: 100 }), /Choose the manager/);
  await assert.rejects(() => cashbook.add(d, COACH, { kind: "draw", employee_id: "D1", amount: 100 }), /Choose the manager/);
  const e = await cashbook.add(d, COACH, { kind: "draw", employee_id: "M1", amount: 20000, note: "Salary advance" });
  assert.equal(e.employee_id, "M1");
  const b = await cashbook.book(d, "H1", period());
  assert.equal(day(b, t).draws, 2000000);
  assert.equal(b.totals.draws, 2000000);
  assert.equal(day(b, t).closing, 10000000 - 2000000, "the cash taken is out of the cash in hand");
  assert.equal(b.entries.find((x) => x.kind === "draw").employee_name, "Name M1");
  assert.deepEqual(b.managers.map((m) => m.id), ["M1"]);
  // the pay run takes it off that manager
  await svc.runPeriod(d, period(), "admin");
  const row = (await svc.getPeriod(d, period())).rows.find((r) => r.employee_id === "M1");
  assert.equal(row.detail.deductions.find((x) => x.key === "personal_draw").amount, 2000000);
  const weekly = (await svc.weeklyView(d, period())).find((m) => m.manager_id === "M1");
  assert.equal(weekly.weeks.reduce((s, w) => s + w.personal_draw, 0), 2000000);
});

test("teams and sellers below the expected 90% of their sales are marked", async () => {
  const d = await setup();
  await sell(d, today(), "D1", 60000, 60000); await sell(d, today(), "D2", 40000, 30000);   // the team handed in Rs 90,000 of Rs 100,000
  let b = await cashbook.book(d, "H1", period());
  assert.deepEqual([b.teams[0].expected, b.teams[0].below, b.teams[0].short_of_expected], [9000000, false, 0], "exactly 90% is enough");
  assert.deepEqual(b.gave_less.map((x) => [x.employee_id, x.short]), [["D2", 1000000]], "the one who handed in less");
  await sell(d, sales.addDays(today(), -1), "D1", 50000, 40000);                                  // a day when the team is below 90%
  b = await cashbook.book(d, "H1", period());
  const y = b.team_days.find((x) => x.date === sales.addDays(today(), -1));
  if (y) assert.deepEqual([y.teams[0].expected, y.teams[0].below], [4500000, true]);
  assert.equal(b.min_percent, 90);
});

test("clearance, advertising and cards can be entered by the hub as expenses", async () => {
  const d = await setup();
  assert.ok(["Clearance", "Advertising", "Cards"].every((c) => cashbook.CATEGORIES.includes(c)));
  const e = await cashbook.add(d, COACH, { kind: "expense", category: "Advertising", amount: 850 });
  assert.equal(e.category, "Advertising");
});

test("the money people take (the daily sheet's personal minus) comes out of the hub's cash automatically", async () => {
  const d = await setup();
  const t = today(), y = sales.addDays(t, -1);
  await svc.createEntry(d, "daily", { date: y, employee_id: "D1", business_amount: 50000, settled_amount: 50000, personal_minus: 2000 }, "clerk");
  await svc.createEntry(d, "daily", { date: t, employee_id: "D2", business_amount: 40000, settled_amount: 40000, personal_minus: 1500 }, "clerk");
  await svc.createEntry(d, "daily", { date: t, employee_id: "D9", business_amount: 10000, settled_amount: 10000, personal_minus: 700 }, "clerk"); // another hub
  const b = await cashbook.book(d, "H1", t.slice(0, 7));
  assert.equal(day(b, t).personal, 150000);
  assert.equal(day(b, t).closing, day(b, t).opening + 4000000 - 150000, "today: cash from sellers less what D2 took");
  if (y.slice(0, 7) === t.slice(0, 7)) {
    assert.equal(day(b, y).personal, 200000);
    assert.equal(day(b, y).closing, 5000000 - 200000);
    assert.equal(day(b, t).opening, 4800000, "yesterday's cash carries, after what D1 took");
    assert.equal(b.totals.personal, 350000);
  }
  // changing the daily sheet changes the cash book: nothing is entered twice
  const row = await d.get("SELECT id FROM daily_log WHERE employee_id = 'D2' AND date = ?", t);
  await d.run("UPDATE daily_log SET personal_minus = 0 WHERE id = ?", row.id);
  assert.equal(day(await cashbook.book(d, "H1", t.slice(0, 7)), t).personal, 0);
});
