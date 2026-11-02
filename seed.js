// Demo data: node seed.js [target]
//   target = a folder for a local PGlite database (default data/demo), or a postgres:// URL.
//   With no argument and DATABASE_URL set (e.g. node --env-file=.env seed.js) it seeds that database.
// Mock data shaped like the real business: three Jaffna branches, each with a manager, a group manager,
// supervisors and distributors. Four months are finalized and the current month is open with flagged cases.
// All names and numbers are made up.
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const svc = require("./service");

const target = process.argv[2] || process.env.DATABASE_URL || path.join(__dirname, "data", "demo");
const remote = /^postgres/.test(target);

(async () => {
const d = await db.open(target);
if ((await d.get("SELECT COUNT(*) AS n FROM staff")).n) {
  console.log("That database already has data — leaving it as is.");
  return d.close();
}
const auth = require("./auth");
const add = (kind, row, user = "admin") => svc.createEntry(d, kind, row, user);

// Demo sign-ins, one per role (demo database only — change or remove before real use)
const DEMO_USERS = [
  ["admin", "Owner Admin", "admin", null, "admin123"],
  ["accounts", "Dilani Accounts", "accountant", null, "accounts123"],
  ["manager1", "Arun Selvam (Jaffna 01 manager)", "manager", "J1", "manager123"],
  ["manager2", "Ravi Shankar (Jaffna 02 manager)", "manager", "J2", "manager123"],
  ["manager3", "Selvi Anand (Jaffna 03 manager)", "manager", "J3", "manager123"],
  ["clerk", "Anu Clerk", "clerk", "J1", "clerk123"],
  ["viewer", "Board Viewer", "viewer", null, "viewer123"],
];
// A hosted database is reachable from the internet, so it never gets the well-known demo passwords.
if (remote) for (const u of DEMO_USERS) u[4] = "Pw" + crypto.randomBytes(6).toString("base64url") + "7";
await auth.setup(d, { username: DEMO_USERS[0][0], full_name: DEMO_USERS[0][1], password: DEMO_USERS[0][4] });
const adminUser = { username: "admin" };

// Pay setup per position (the owner has not confirmed the group manager figures; they are placeholders).
const PAY = {
  distributor: { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 0, security_deduction_rule: "pct_business:1" },
  supervisor: { pay_scheme: "tiered", target: 120000, basic_pay: 30000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 24, security_deduction_rule: "pct_business:1" },
  group_manager: { pay_scheme: "tiered", target: 150000, basic_pay: 35000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 24, security_deduction_rule: "pct_business:1" },
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
for (const [username, full_name, role, hub, password] of DEMO_USERS.slice(1)) {
  await auth.createUser(d, adminUser, { username, full_name, role, hub, password });
}

// id, name, hub, position, reports to, usual business per working day, share of days worked
const TEAM = [
  ["M01", "Arun Selvam", "J1", "manager", null, 0, 0], ["GM01", "Meena Rajan", "J1", "group_manager", "M01", 7500, 0.97],
  ["S01", "Kavin Thirumal", "J1", "supervisor", "GM01", 6800, 0.97], ["S02", "Nila Sivakumar", "J1", "supervisor", "GM01", 6000, 0.95],
  ["D01", "Pavan Kumar", "J1", "distributor", "S01", 4600, 0.97], ["D02", "Thevi Ganesh", "J1", "distributor", "S01", 4000, 0.95],
  ["D03", "Sharan Raj", "J1", "distributor", "S02", 3300, 0.95], ["D04", "Anitha Jegan", "J1", "distributor", "S02", 2800, 0.7],
  ["M02", "Ravi Shankar", "J2", "manager", null, 0, 0], ["GM02", "Uma Maheswari", "J2", "group_manager", "M02", 7200, 0.97],
  ["S03", "Dinesh Prabu", "J2", "supervisor", "GM02", 6400, 0.97], ["S04", "Janani Vel", "J2", "supervisor", "GM02", 4200, 0.9],
  ["D05", "Kavya Nathan", "J2", "distributor", "S03", 4400, 0.97], ["D06", "Mohan Das", "J2", "distributor", "S03", 3800, 0.95],
  ["D07", "Sutha Pillai", "J2", "distributor", "S04", 3500, 0.95], ["D08", "Yazhini Raj", "J2", "distributor", "S04", 2500, 0.7],
  ["M03", "Selvi Anand", "J3", "manager", null, 0, 0], ["GM03", "Karthik Rao", "J3", "group_manager", "M03", 6900, 0.97],
  ["S05", "Lavanya Muthu", "J3", "supervisor", "GM03", 6600, 0.97], ["S06", "Ganesh Bala", "J3", "supervisor", "GM03", 5900, 0.95],
  ["D09", "Vimal Raj", "J3", "distributor", "S05", 4300, 0.97], ["D10", "Priya Tharan", "J3", "distributor", "S05", 3900, 0.95],
  ["D11", "Siva Kumar", "J3", "distributor", "S06", 3400, 0.95], ["D12", "Nisha Paul", "J3", "distributor", "S06", 2600, 0.7],
];
const BANKS = [["7010", "Bank of Ceylon", "001"], ["7056", "Commercial Bank", "012"], ["7278", "Sampath Bank", "030"], ["7083", "Hatton National Bank", "045"], ["7135", "People's Bank", "101"]];
// Managers first, then each level reports to someone already created.
for (const [i, [id, name, hub, position, upline]] of TEAM.entries()) {
  const [bankCode, bankName, branch] = BANKS[i % BANKS.length];
  await add("staff", {
    employee_id: id, name, hub, staff_level: position, ...(upline ? { upline_id: upline } : {}), ...(PAY[position] || {}),
    bank_name: bankName, bank_code: bankCode, branch_code: branch, bank_account_no: String(1000000000 + i * 111111 + 4321),
    phone: `077 ${String(100 + i).padStart(3, "0")} ${2000 + i * 7}`, join_date: "2024-03-01",
  });
}
const sellers = TEAM.filter((t) => t[3] !== "manager");

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
  await svc.bulkUpsert(d, "daily", daily, "clerk");
  await svc.bulkUpsert(d, "stock", sellers.filter((t) => t[3] !== "group_manager").flatMap(([id]) => [
    { period, employee_id: id, product: "Shine", opening_stock: 40, issued: 60, sold: 85, counted_stock: 15 - (stockShort[id] || 0) - (rnd() < 0.2 ? 1 : 0), unit_price: 850 },
    { period, employee_id: id, product: "Vim", opening_stock: 20, issued: 30, sold: 38, counted_stock: 12, unit_price: 500 },
  ]), "clerk");
  const weekly = [];
  for (let day = 1; day <= days; day++) {
    if (new Date(y, m - 1, day).getDay() !== 1) continue;
    const start = new Date(Date.UTC(y, m - 1, day));
    const end = new Date(start.getTime() + 6 * 864e5);
    for (const [hub, , , mgr, profit, rent] of HUBS) {
      const perDay = sellers.filter((t) => t[2] === hub).reduce((s, t) => s + t[5] * t[6], 0);
      const business = Math.round((perDay * 6 * (0.9 + rnd() * 0.2) * growth) / 10) * 10;
      weekly.push({ week_start: start.toISOString().slice(0, 10), week_end: end.toISOString().slice(0, 10), manager_id: mgr,
        business_total: business, profit_percent: profit, rent, hub_fee: 500, security_cost: Math.round(business * 0.01),
        personal_draw: draws[mgr] || Math.round((8000 + rnd() * 12000) / 100) * 100 });
    }
  }
  await svc.bulkUpsert(d, "weekly", weekly, "accounts");
  await svc.createEntry(d, "allowances", { period, employee_id: "D01", description: "Transport", amount: 3000 }, "accounts");
}

async function closeMonth(period) {
  await svc.runPeriod(d, period, "accounts");
  for (const r of (await svc.getPeriod(d, period)).rows.filter((x) => x.status === "pending_review")) {
    await svc.review(d, period, r.employee_id, "admin", "approved", "Checked against the hub's cash book");
  }
  await svc.finalizePeriod(d, period, "admin");
}

// Four finalized months, then the current month stays open.
const now = new Date();
const ym = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
const growth = [0.9, 0.95, 1.0, 1.04];
for (let i = 0; i < 4; i++) {
  await month(ym(i - 4), { growth: growth[i], short: { D02: 1500 } });
  await closeMonth(ym(i - 4));
}

// The open month has realistic exceptions for the approvals queue.
const open = ym(0);
await month(open, { growth: 1.06, short: { D02: 1500, D04: 9000 }, draws: { M02: 45000 }, stockShort: { D07: 9 } });
const row = (await svc.listEntries(d, "daily", { period: open, employee_id: "D01" }))[0];
await svc.updateEntry(d, "daily", row.id, { settled_amount: row.settled_amount / 100 - 200, notes: "Recount: Rs 200 short" }, "accounts");
await svc.updateEntry(d, "staff", "D07", { bank_account_no: "3000999888" }, "accounts");
await svc.runPeriod(d, open, "accounts");

console.log(`Seeded ${remote ? "the Postgres database from DATABASE_URL" : target}`);
console.log((remote ? "Sign-ins (random passwords — save them now, they are not shown again): " : "Demo sign-ins: ") +
  DEMO_USERS.map(([u, , r, h, p]) => `${u} / ${p} (${r}${h ? ", " + h : ""})`).join(", "));
for (const r of (await svc.getPeriod(d, open)).rows) {
  console.log(`  ${open} ${r.employee_id.padEnd(5)} ${r.status.padEnd(14)} net ${(r.net_pay / 100).toFixed(2).padStart(12)}  ${r.flags.map((f) => f.code).join(", ")}`);
}

await d.close();
})().catch((err) => { console.error(err); process.exit(1); });
