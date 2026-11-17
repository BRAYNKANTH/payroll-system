// Demo data: node seed.js [target]
//   target = a folder for a local PGlite database (default data/demo), or a postgres:// URL.
//   With no argument and DATABASE_URL set (e.g. node --env-file=.env seed.js) it seeds that database.
// Mock data shaped like the real business: three Jaffna branches, each with a coacher, a promoting manager, a manager
// (who sells too), supervisors and distributors. One branch is small enough for its manager to be "retaining". Four months are finalized and the current month is open with flagged cases.
// All names and numbers are made up.
//   --open=2026-10  makes that month the one with every exception scenario (the four months before it are finalized, and the months after it
//                   up to today are filled in cleanly), instead of the current month.
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const svc = require("./service");
const loans = require("./loans");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const target = args[0] || process.env.DATABASE_URL || path.join(__dirname, "data", "demo");
const remote = /^postgres/.test(target);

(async () => {
if (remote) {
  // A hosted database holds real accounts, so name it and ask for an explicit yes before writing to it.
  const host = new URL(target).hostname;
  if (!process.argv.includes("--yes")) {
    console.log(`This will add mock staff, sheets, payroll and demo users to the hosted database ${host}.\nRun it again with --yes to continue.`);
    return;
  }
  console.log(`Seeding the hosted database ${host} ...`);
}
const d = await db.open(target);
if ((await d.get("SELECT COUNT(*) AS n FROM staff")).n) {
  console.log("That database already has data — leaving it as is.");
  return d.close();
}
if ((await d.get("SELECT COUNT(*) AS n FROM hubs WHERE code IN ('J1','J2','J3')")).n) {
  console.log("That database already has a hub called J1, J2 or J3 — leaving it as is.");
  return d.close();
}
const auth = require("./auth");
const products = require("./products");
const add = (kind, row, user = "admin") => svc.createEntry(d, kind, row, user);

// Demo sign-ins (demo database only — change or remove before real use)
const DEMO_USERS = [
  ["admin", "Owner Admin", "admin", null, "admin123"],
  ["manager1", "Arun Selvam (Jaffna 01 manager)", "manager", "J1", "manager123"],
  ["manager2", "Ravi Shankar (Jaffna 02 manager)", "manager", "J2", "manager123"],
  ["manager3", "Selvi Anand (Jaffna 03 manager)", "manager", "J3", "manager123"],
];
// A hosted database is reachable from the internet, so it never gets the well-known demo passwords.
if (remote) for (const u of DEMO_USERS) u[4] = "Pw" + crypto.randomBytes(6).toString("base64url") + "7";
// A hosted database already has its owner's admin account: keep it, and do not create another.
const existingAdmin = await d.get("SELECT username FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
if (!existingAdmin) await auth.setup(d, { username: DEMO_USERS[0][0], full_name: DEMO_USERS[0][1], password: DEMO_USERS[0][4] });
const adminUser = { username: existingAdmin?.username || DEMO_USERS[0][0] };
const created = [];

// Pay setup per position. Distributors and supervisors are the same level and differ only in target and rates. A manager's target is weekly.
const PAY = {
  distributor: { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 0, security_deduction_rule: "pct_business:1" },
  supervisor: { pay_scheme: "tiered", target: 120000, basic_pay: 30000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 24, security_deduction_rule: "pct_business:1" },
  manager: { target: 100000, basic_pay: 27000 }, promoting_manager: { basic_pay: 29000 }, coacher: { basic_pay: 30000 },
};
await svc.updateSettings(d, {
  company_name: "World Entrepreneurs Company", company_account_no: "0001234567",
  company_return_rate: 0, // the Excel files show no company return, so the demo charges none
  position_defaults: JSON.stringify(PAY),
}, "admin");

// [code, name, location, manager id, profit rate, weekly rent]
const HUBS = [
  ["J1", "Jaffna 01", "Stanly Road, Jaffna", "M01", 0.2, 4000],
  ["J2", "Jaffna 02", "Kandy Road, Jaffna", "M02", 0.15, 4000],
  ["J3", "Jaffna 03", "Hospital Road, Jaffna", "M03", 0.1, 0],
];
for (const [code, name, location] of HUBS) await add("hubs", { code, name, location, phone: "021 722 3317" });
// The catalogue: selling price and the price the company pays to buy each product. The stock counts below sell these two.
await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
await products.create(d, { name: "Vim", list_price: 500, cost_price: 190 }, "admin");
for (const [username, full_name, role, hub, password] of DEMO_USERS.slice(1)) {
  if (await d.get("SELECT 1 AS x FROM users WHERE lower(username) = lower(?)", username)) continue; // keep an existing account as it is
  await auth.createUser(d, adminUser, { username, full_name, role, hub, password });
  created.push(username);
}

// The month that carries the exceptions (default: the current month) and a helper for the months around it.
const openArg = (process.argv.find((a) => a.startsWith("--open=")) || "").slice(7);
if (openArg && !/^\d{4}-(0[1-9]|1[0-2])$/.test(openArg)) throw new Error("--open must be YYYY-MM");
const nowDate = new Date();
const baseDate = openArg ? new Date(openArg + "-01T00:00:00Z") : nowDate;
const ym = (offset) => new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
const open = ym(0);
const currentMonth = nowDate.toISOString().slice(0, 7);

// id, name, hub, position, reports to, usual business per working day, share of days worked.
// Each branch: one coacher, a promoting manager, a manager (who sells too) and the sellers. Jaffna 03 is small, so its manager is "retaining".
const TEAM = [
  ["C01", "Jegan Muthiah", "J1", "coacher", null, 0, 0], ["PM01", "Hari Prasath", "J1", "promoting_manager", "C01", 0, 0], ["M01", "Arun Selvam", "J1", "manager", "PM01", 2500, 0.9],
  ["S01", "Kavin Thirumal", "J1", "supervisor", "M01", 6800, 0.97], ["S02", "Nila Sivakumar", "J1", "supervisor", "M01", 6000, 0.95],
  ["D01", "Pavan Kumar", "J1", "distributor", "M01", 4600, 0.97], ["D02", "Thevi Ganesh", "J1", "distributor", "M01", 4000, 0.95],
  ["D03", "Sharan Raj", "J1", "distributor", "M01", 3300, 0.95], ["D04", "Anitha Jegan", "J1", "distributor", "M01", 2800, 0.7],
  ["C02", "Mala Krishnan", "J2", "coacher", null, 0, 0], ["PM02", "Ganesan Pillai", "J2", "promoting_manager", "C02", 0, 0], ["M02", "Ravi Shankar", "J2", "manager", "PM02", 3000, 0.9],
  ["S03", "Dinesh Prabu", "J2", "supervisor", "M02", 6400, 0.97], ["S04", "Janani Vel", "J2", "supervisor", "M02", 4200, 0.9],
  ["D05", "Kavya Nathan", "J2", "distributor", "M02", 4400, 0.97], ["D06", "Mohan Das", "J2", "distributor", "M02", 3800, 0.95],
  ["D07", "Sutha Pillai", "J2", "distributor", "M02", 3500, 0.95], ["D08", "Yazhini Raj", "J2", "distributor", "M02", 2500, 0.7],
  ["C03", "Rajan Thevar", "J3", "coacher", null, 0, 0], ["PM03", "Sumathi Arul", "J3", "promoting_manager", "C03", 0, 0], ["M03", "Selvi Anand", "J3", "manager", "PM03", 1200, 0.9],
  ["S05", "Lavanya Muthu", "J3", "supervisor", "M03", 3000, 0.97], ["D09", "Vimal Raj", "J3", "distributor", "M03", 2500, 0.95], ["D10", "Priya Tharan", "J3", "distributor", "M03", 1800, 0.95],
];
const BANKS = [["7010", "Bank of Ceylon", "001"], ["7056", "Commercial Bank", "012"], ["7278", "Sampath Bank", "030"], ["7083", "Hatton National Bank", "045"], ["7135", "People's Bank", "101"]];
// Each person is created after the person they report to.
for (const [i, [id, name, hub, position, upline]] of TEAM.entries()) {
  const [bankCode, bankName, branch] = BANKS[i % BANKS.length];
  await add("staff", {
    employee_id: id, name, hub, staff_level: position, ...(upline ? { upline_id: upline } : {}), ...(PAY[position] || {}),
    bank_name: bankName, bank_code: bankCode, branch_code: branch, bank_account_no: String(1000000000 + i * 111111 + 4321),
    phone: `077 ${String(100 + i).padStart(3, "0")} ${2000 + i * 7}`, join_date: "2024-03-01",
  });
}
// A distributor who joined in the middle of the open month and has no bank account on file yet.
await add("staff", { employee_id: "D11", name: "Kumar Vel", hub: "J1", staff_level: "distributor", upline_id: "M01", ...PAY.distributor,
  phone: "077 200 3003", join_date: open + "-12" });
// Staff-portal logins: a distributor and two supervisors can sign in and see their own figures.
const PORTAL_USERS = [["pavan", "Pavan Kumar", "D01"], ["kavin", "Kavin Thirumal", "S01"], ["nila", "Nila Sivakumar", "S02"], ["coacher1", "Jegan Muthiah", "C01"], ["promo1", "Hari Prasath", "PM01"], ["mgrme1", "Arun Selvam", "M01"],
  ["coacher2", "Mala Krishnan", "C02"], ["coacher3", "Rajan Thevar", "C03"], ["promo2", "Ganesan Pillai", "PM02"], ["mgrme2", "Ravi Shankar", "M02"],
  ["mgrme3", "Selvi Anand", "M03"], ["anitha", "Anitha Jegan", "D04"], ["sutha", "Sutha Pillai", "D07"], ["dinesh", "Dinesh Prabu", "S03"], ["kumar", "Kumar Vel", "D11"]]
  .map(([username, full_name, employee_id]) => [username, full_name, employee_id, remote ? "Pw" + crypto.randomBytes(6).toString("base64url") + "7" : "staff123"]);
for (const [username, full_name, employee_id, password] of PORTAL_USERS) {
  await auth.createUser(d, adminUser, { username, full_name, role: "staff", employee_id, password });
}
const sellers = TEAM.filter((t) => t[5] > 0); // everyone who sells, managers included

// Deterministic pseudo-random so the demo is reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function month(period, { short = {}, growth = 1, draws = {}, stockShort = {} } = {}) {
  const [y, m] = period.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const daily = [];
  for (const [id, , , , , usual, attend] of sellers) {
    for (let day = 1; day <= days; day++) {
      if (new Date(y, m - 1, day).getDay() === 0) continue; // closed Sundays
      if (rnd() > attend) continue;
      const date = `${period}-${String(day).padStart(2, "0")}`;
      const business = Math.round((usual * (0.85 + rnd() * 0.3) * growth) / 10) * 10;
      const settled = Math.round((business * (0.9 + rnd() * 0.05)) / 10) * 10; // hand-in is usually 90–95% of business
      const gap = short[id] && rnd() < 0.2 ? Math.round(rnd() * short[id]) : 0;
      daily.push({ date, employee_id: id, business_amount: business, settled_amount: settled - gap, personal_minus: rnd() < 0.08 ? 1000 : 0 });
    }
  }
  await svc.bulkUpsert(d, "daily", daily, "manager1");
  await svc.bulkUpsert(d, "stock", sellers.filter((t) => t[3] === "distributor" || t[3] === "supervisor").flatMap(([id]) => [
    { period, employee_id: id, product: "Shine", opening_stock: 40, issued: 60, sold: 85, counted_stock: 15 - (stockShort[id] || 0) - (rnd() < 0.2 ? 1 : 0), unit_price: 850 },
    { period, employee_id: id, product: "Vim", opening_stock: 20, issued: 30, sold: 38, counted_stock: 12, unit_price: 500 },
  ]), "manager1");
  const weekly = [];
  for (let day = 1; day <= days; day++) {
    if (new Date(y, m - 1, day).getDay() !== 1) continue;
    const start = new Date(Date.UTC(y, m - 1, day));
    const end = new Date(start.getTime() + 6 * 864e5);
    const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
    for (const [hub, , , mgr, , rent] of HUBS) {
      const ids = new Set(sellers.filter((t) => t[2] === hub).map((t) => t[0]));
      const business = daily.filter((r) => ids.has(r.employee_id) && r.date >= from && r.date <= to).reduce((t, r) => t + r.business_amount, 0);
      if (!business) continue;
      weekly.push({ week_start: from, week_end: to, manager_id: mgr,
        business_total: business, profit_percent: business >= 100000 ? 0.2 : 0.15, rent, hub_fee: 500, security_cost: Math.round(business * 0.01),
        personal_draw: draws[mgr] || (business < 100000 ? Math.round((2000 + rnd() * 3000) / 100) * 100 : Math.round((8000 + rnd() * 12000) / 100) * 100) });
    }
  }
  await svc.bulkUpsert(d, "weekly", weekly, "admin");
  await svc.createEntry(d, "allowances", { period, employee_id: "D01", description: "Transport", amount: 3000 }, "admin");
}

async function closeMonth(period) {
  await svc.runPeriod(d, period, "admin");
  for (const r of (await svc.getPeriod(d, period)).rows.filter((x) => x.status === "pending_review")) {
    await svc.review(d, period, r.employee_id, "admin", "approved", "Checked against the hub's cash book");
  }
  await svc.finalizePeriod(d, period, "admin");
}

// Four finalized months, then the open month carries the exceptions.
const growth = [0.9, 0.95, 1.0, 1.04];
// A loan that started three months ago (Rs 10,000 still to come) and an advance for the open month, so the loans page has something to show.
await loans.create(d, { employee_id: "D01", kind: "loan", amount: 40000, instalment: 10000, start_period: ym(-3), issued_on: ym(-3) + "-02", note: "School fees" }, "admin");
await loans.create(d, { employee_id: "D03", kind: "advance", amount: 5000, start_period: ym(0), issued_on: ym(0) + "-04", note: "Medical" }, "admin");
await loans.create(d, { employee_id: "S02", kind: "loan", amount: 30000, instalment: 5000, start_period: ym(-2), issued_on: ym(-2) + "-06", note: "Bike repair" }, "admin");
for (let i = 0; i < 4; i++) {
  await month(ym(i - 4), { growth: growth[i], short: { D02: 1500 } });
  await closeMonth(ym(i - 4));
}

// The open month has realistic exceptions for the approvals queue.
await month(open, { growth: 1.06, short: { D02: 1500, D04: 9000 }, draws: { M02: 45000 }, stockShort: { D07: 9 } });
const row = (await svc.listEntries(d, "daily", { period: open, employee_id: "D01" }))[0];
await svc.updateEntry(d, "daily", row.id, { settled_amount: row.settled_amount / 100 - 200, notes: "Recount: Rs 200 short" }, "admin");
await svc.updateEntry(d, "staff", "D07", { bank_account_no: "3000999888" }, "admin");
// Pavan's last two days were entered by Pavan himself on the staff portal and are waiting for the office to confirm them.
await d.run(`UPDATE daily_log SET source = 'portal', created_by = 'pavan' WHERE id IN
  (SELECT id FROM daily_log WHERE employee_id = 'D01' AND date >= ? AND date < ? ORDER BY date DESC LIMIT 2)`, open + "-01", svc.shiftPeriod(open, 1) + "-01");

// More scenarios in the open month ------------------------------------------------------------------------------------------------
// Security with a lifetime cap (it stops once Rs 3,000 has been held in all months together).
await svc.updateEntry(d, "staff", "D05", { security_deduction_rule: "pct_business:1;cap:3000" }, "admin");
// A supervisor on the plain scheme: basic plus commission only on what is above the target.
await svc.updateEntry(d, "staff", "S04", { pay_scheme: "over_target", basic_pay: 30000, target: 120000, commission_rate: 0.3, base_commission_rate: 0, food_per_day: 0, food_min_days: 0 }, "admin");
// A day where more cash was handed in than sold (a credit line, which is flagged).
const credit = (await svc.listEntries(d, "daily", { period: open, employee_id: "D05" }))[1];
await svc.updateEntry(d, "daily", credit.id, { settled_amount: credit.business_amount / 100 + 400, notes: "Customer paid an old balance" }, "admin");
// Allowances for two people.
await svc.createEntry(d, "allowances", { period: open, employee_id: "S03", description: "Attendance bonus", amount: 2000 }, "admin");
await svc.createEntry(d, "allowances", { period: open, employee_id: "S01", description: "Festival bonus", amount: 5000 }, "admin");
// A new joiner: entries only from the day they joined, no stock count, no bank account.
const [oy, om] = open.split("-").map(Number);
const joinDays = [];
for (let day = 12; day <= new Date(oy, om, 0).getDate(); day++) {
  if (new Date(oy, om - 1, day).getDay() === 0) continue;
  const business = Math.round((2600 + rnd() * 900) / 10) * 10;
  joinDays.push({ date: `${open}-${String(day).padStart(2, "0")}`, employee_id: "D11", business_amount: business, settled_amount: Math.round(business * 0.92 / 10) * 10, personal_minus: 0 });
}
await svc.bulkUpsert(d, "daily", joinDays, "manager1");
// A leaver: a distributor who left near the end of the month (still paid for the days worked).
const people = require("./people");
await people.leave(d, "D08", { leave_date: open + "-24", reason: "Moved to another town" }, "admin");

await svc.runPeriod(d, open, "admin");
// The admin has dealt with some of the flagged lines already; the rest wait in the approvals queue.
const decide = async (id, decision, note) => {
  const r = (await svc.getPeriod(d, open)).rows.find((x) => x.employee_id === id);
  if (r && r.status === "pending_review") await svc.review(d, open, id, "admin", decision, note);
};
await decide("D02", "approved", "Checked against the hub's cash book");
await decide("M03", "approved", "Small hub: the retaining month is confirmed by the owner");
await decide("D04", "rejected", "Cash short is too large. Recount with the manager and re-enter");

// The months after the open one, up to today, are filled in cleanly so the current month is not empty.
for (let o = 1; ym(o) <= currentMonth; o++) {
  await month(ym(o), { growth: 1.05 + o * 0.01 });
  await svc.runPeriod(d, ym(o), "admin");
}

console.log(`Seeded ${remote ? "the Postgres database from DATABASE_URL" : target}`);
console.log(remote ? "Sign-ins (random passwords — save them now, they are not shown again):" : "Demo sign-ins:");
for (const [u, , r, h, p] of DEMO_USERS.slice(existingAdmin ? 1 : 0)) {
  console.log(`  ${u.padEnd(10)} ${!existingAdmin || created.includes(u) ? p : "(already existed, password unchanged)"}  ${r}${h ? ", " + h : ""}`);
}
for (const [u, , e, p] of PORTAL_USERS) console.log(`  ${u.padEnd(10)} ${p}  staff portal (${e})`);
if (existingAdmin) console.log(`  Your admin account "${existingAdmin.username}" was kept as it is.`);
for (const r of (await svc.getPeriod(d, open)).rows) {
  console.log(`  ${open} ${r.employee_id.padEnd(5)} ${r.status.padEnd(14)} net ${(r.net_pay / 100).toFixed(2).padStart(12)}  ${r.flags.map((f) => f.code).join(", ")}`);
}

await d.close();
})().catch((err) => { console.error(err); process.exit(1); });
