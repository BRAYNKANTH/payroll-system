// Demo data: node seed.js [target]
//   target = a folder for a local PGlite database (default data/demo), or a postgres:// URL.
//   With no argument and DATABASE_URL set (e.g. node --env-file=.env seed.js) it seeds that database.
// Three hubs, demo users, May–Aug 2026 finalized and September 2026 open with flagged cases.
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

// Demo sign-ins (demo database only — change or remove before real use)
const DEMO_USERS = [
  ["admin", "Owner Admin", "admin", null, "admin123"],
  ["accounts", "Dilani Accounts", "accountant", null, "accounts123"],
  ["clerk", "Anu Clerk", "clerk", "COL10", "clerk123"],
  ["viewer", "Board Viewer", "viewer", null, "viewer123"],
];
// A hosted database is reachable from the internet, so it never gets the well-known demo passwords.
if (remote) for (const u of DEMO_USERS) u[4] = "Pw" + crypto.randomBytes(6).toString("base64url") + "7";
await auth.setup(d, { username: DEMO_USERS[0][0], full_name: DEMO_USERS[0][1], password: DEMO_USERS[0][4] });
const adminUser = { username: "admin" };
await svc.updateSettings(d, { company_name: "Lanka Motor Spares", company_account_no: "0001234567" }, "admin");

await add("hubs", { code: "COL10", name: "Colombo 10", location: "Maradana, Colombo 10", phone: "011 269 0000" });
await add("hubs", { code: "KDY", name: "Kandy", location: "Peradeniya Road, Kandy", phone: "081 222 0000" });
await add("hubs", { code: "GAL", name: "Galle", location: "Main Street, Galle", phone: "091 223 0000" });
for (const [username, full_name, role, hub, password] of DEMO_USERS.slice(1)) {
  await auth.createUser(d, adminUser, { username, full_name, role, hub, password });
}

await add("staff", { employee_id: "M01", name: "Nimal Perera", role: "manager", hub: "COL10", phone: "077 111 2233", join_date: "2023-02-01" });
await add("staff", { employee_id: "M02", name: "Suresh Kumar", role: "manager", hub: "KDY", phone: "077 222 3344", join_date: "2023-06-15" });
await add("staff", { employee_id: "M03", name: "Chaminda Wickrama", role: "manager", hub: "GAL", phone: "077 333 4455", join_date: "2024-01-10" });
const BANKS = { 7010: "Bank of Ceylon", 7056: "Commercial Bank", 7278: "Sampath Bank", 7083: "Hatton National Bank", 7135: "People's Bank", 7287: "Seylan Bank" };
const guys = [
  ["G01", "Kasun Silva", "COL10", "M01", 35000, 400000, 0.03, "fixed:1000", "7010", "001", "1000123456"],
  ["G02", "Ruwan Jayasuriya", "COL10", "M01", 32000, 350000, 0.03, "pct_basic:5;cap:20000", "7056", "012", "2000987654"],
  ["G03", "Tharindu Fernando", "KDY", "M02", 30000, 300000, 0.025, "fixed:1000", "7278", "030", "3000555111"],
  ["G04", "Ashan Rajapaksa", "KDY", "M02", 30000, 300000, 0.025, "none", "7083", "045", "4000777222"],
  ["G05", "Lahiru Bandara", "GAL", "M03", 30000, 320000, 0.025, "fixed:750", "7135", "101", "5000333444"],
  ["G06", "Isuru Madushanka", "GAL", "M03", 28000, 280000, 0.02, "pct_gross:3;cap:15000", "7287", "022", "6000111999"],
];
for (const [id, name, hub, mgr, basic, target, rate, rule, bank, branch, acct] of guys) {
  await add("staff", { employee_id: id, name, role: "guy", hub, manager_id: mgr, basic_pay: basic, target, commission_rate: rate,
    security_deduction_rule: rule, bank_name: BANKS[bank], bank_code: bank, branch_code: branch, bank_account_no: acct,
    phone: `07${id.slice(-1)} 5${id.slice(-2)} 0${id.slice(-2)}1`, join_date: "2024-03-01" });
}

// Deterministic pseudo-random so the demo is reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function month(period, { short = {}, growth = 1, draws = {}, stockShort = {} } = {}) {
  const [y, m] = period.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const daily = [];
  for (const [id] of guys) {
    for (let day = 1; day <= days; day++) {
      if (new Date(y, m - 1, day).getDay() === 0) continue; // closed Sundays
      const date = `${period}-${String(day).padStart(2, "0")}`;
      const business = Math.round((12000 + rnd() * 8000) * growth);
      const gap = short[id] && rnd() < 0.2 ? Math.round(rnd() * short[id]) : 0;
      daily.push({ date, employee_id: id, business_amount: business, settled_amount: business - gap, personal_minus: rnd() < 0.08 ? 500 : 0 });
    }
  }
  await svc.bulkUpsert(d, "daily", daily, "clerk");
  await svc.bulkUpsert(d, "stock", guys.flatMap(([id]) => [
    { period, employee_id: id, product: "Engine oil 1L", opening_stock: 40, issued: 60, sold: 85, counted_stock: 15 - (stockShort[id] || 0) - (rnd() < 0.3 ? 1 : 0), unit_price: 1450 },
    { period, employee_id: id, product: "Brake pads (set)", opening_stock: 12, issued: 10, sold: 14, counted_stock: 8, unit_price: 3200 },
  ]), "clerk");
  const weekly = [];
  for (let day = 1; day <= days; day++) {
    if (new Date(y, m - 1, day).getDay() !== 1) continue;
    const start = new Date(Date.UTC(y, m - 1, day));
    const end = new Date(start.getTime() + 6 * 864e5);
    for (const [mgr, profit, rent] of [["M01", 0.42, 15000], ["M02", 0.4, 9000], ["M03", 0.4, 8000]]) {
      weekly.push({ week_start: start.toISOString().slice(0, 10), week_end: end.toISOString().slice(0, 10), manager_id: mgr,
        business_total: Math.round((235000 + rnd() * 45000) * growth), profit_percent: profit, rent, hub_fee: 2500, security_cost: 1500,
        personal_draw: draws[mgr] || 10000 });
    }
  }
  await svc.bulkUpsert(d, "weekly", weekly, "accounts");
  await svc.createEntry(d, "allowances", { period, employee_id: "G01", description: "Transport", amount: 3000 }, "accounts");
}

async function closeMonth(period) {
  await svc.runPeriod(d, period, "accounts");
  for (const r of (await svc.getPeriod(d, period)).rows.filter((x) => x.status === "pending_review")) {
    await svc.review(d, period, r.employee_id, "admin", "approved", "Checked against the hub's cash book");
  }
  await svc.finalizePeriod(d, period, "admin");
}

await month("2026-05", { growth: 0.9, short: { G02: 1500 } });
await closeMonth("2026-05");
await month("2026-06", { growth: 0.95, short: { G02: 1500 } });
await closeMonth("2026-06");
await month("2026-07", { growth: 1.0, short: { G02: 1200 } });
await closeMonth("2026-07");
await month("2026-08", { growth: 1.04, short: { G02: 1500 } });
await closeMonth("2026-08");

// September stays open with realistic exceptions for the approvals queue.
await month("2026-09", { growth: 1.06, short: { G02: 1500, G04: 9000 }, draws: { M02: 45000 }, stockShort: { G03: 9 } });
const row = (await svc.listEntries(d, "daily", { period: "2026-09", employee_id: "G01" }))[0];
await svc.updateEntry(d, "daily", row.id, { settled_amount: row.settled_amount / 100 - 200, notes: "Recount: Rs 200 short" }, "accounts");
await svc.updateEntry(d, "staff", "G03", { bank_account_no: "3000999888" }, "accounts");
await svc.runPeriod(d, "2026-09", "accounts");

console.log(`Seeded ${remote ? "the Postgres database from DATABASE_URL" : target}`);
console.log((remote ? "Sign-ins (random passwords — save them now, they are not shown again): " : "Demo sign-ins: ") +
  DEMO_USERS.map(([u, , r, , p]) => `${u} / ${p} (${r})`).join(", "));
for (const r of (await svc.getPeriod(d, "2026-09")).rows) {
  console.log(`  2026-09 ${r.employee_id} ${r.status.padEnd(14)} net ${(r.net_pay / 100).toFixed(2).padStart(12)}  ${r.flags.map((f) => f.code).join(", ")}`);
}

await d.close();
})().catch((err) => { console.error(err); process.exit(1); });
