// Explore data: node seed-explore.js [folder] --reset
//   Builds a fresh LOCAL demo database (default data/demo) with the same hubs, managers and logins as the normal demo, plus:
//   - a catalogue of 40 household products, held as stock only (office -> hubs -> sellers), with no old sales or stock behind it
//   - many more workers under the existing managers, new joiners and a leaver
//   - every kind of record from 2 November up to YESTERDAY: sales, stock moves, daily sheets, weekly sheets, stock counts, allowances, loans, approvals
//   - nothing at all recorded today, so every screen can be tried from empty
//   It never touches a hosted database. All names and numbers are made up. Without --reset it refuses to replace an existing database.
const fs = require("fs");
const path = require("path");
const db = require("./db");
const svc = require("./service");
const auth = require("./auth");
const products = require("./products");
const loans = require("./loans");
const people = require("./people");

const START = "2026-11-02";
const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const target = path.resolve(arg || path.join(__dirname, "data", "demo"));
const reset = process.argv.includes("--reset");
const crypto = require("crypto");
// --remote loads the data into the hosted database named by DATABASE_URL (node --env-file=.env seed-explore.js --remote --yes).
// It only ever fills an EMPTY hosted database, and the sign-ins get random passwords, because the site is on the internet.
const remote = process.argv.includes("--remote");

(async () => {
  if (/^postgres/i.test(arg || "")) { console.log("Give no address here. For the hosted database run: node --env-file=.env seed-explore.js --remote --yes"); return; }
  if (remote) {
    const url = process.env.DATABASE_URL || "";
    if (!/^postgres/i.test(url)) { console.log("DATABASE_URL is not set. Run with: node --env-file=.env seed-explore.js --remote --yes"); return; }
    if (!process.argv.includes("--yes")) { console.log(`This will load explore data into the hosted database ${new URL(url).hostname}. Run again with --yes to continue.`); return; }
  } else {
    if (!target.startsWith(path.join(__dirname, "data") + path.sep)) { console.log("Choose a folder inside this project's data folder, for example data/demo."); return; }
    if (fs.existsSync(target)) {
      if (!reset) { console.log(`${target} already exists. Run again with --reset to replace it with fresh explore data.`); return; }
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  const d = await db.open(remote ? process.env.DATABASE_URL : target);
  if (remote) {
    const have = Number((await d.get("SELECT (SELECT COUNT(*) FROM staff) + (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM hubs) AS n")).n);
    if (have) { console.log("The hosted database already has data. Leaving it as it is."); return d.close(); }
  }
  const pw = (fixed) => (remote ? "Pw" + crypto.randomBytes(6).toString("base64url") + "7" : fixed);
  const creds = [];
  const adminUser = { username: "admin" };
  const add = (kind, row, user = "admin") => svc.createEntry(d, kind, row, user);

  const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const todaySL = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const END = addDays(todaySL, -1); // yesterday: nothing is recorded for today
  const PERIOD = START.slice(0, 7);

  // ---- sign-ins -----------------------------------------------------------------------------------------------------------------
  const adminPw = pw("admin123"); creds.push(["admin", adminPw, "owner / admin"]);
  await auth.setup(d, { username: "admin", full_name: "Owner Admin", password: adminPw });
  const MANAGER_LOGINS = [["manager1", "Arun Selvam", "M01"], ["manager2", "Ravi Shankar", "M02"], ["manager3", "Selvi Anand", "M03"], ["manager4", "Dev Anand", "M04"]];

  // ---- settings, pay setup, hubs ------------------------------------------------------------------------------------------------
  const PAY = {
    distributor: { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 0, security_deduction_rule: "pct_business:1" },
    supervisor: { pay_scheme: "tiered", target: 120000, basic_pay: 30000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 25, security_deduction_rule: "pct_business:1" },
    manager: { target: 100000, basic_pay: 27000 }, promoting_manager: { basic_pay: 29000 }, coacher: { basic_pay: 30000 },
  };
  // The pay defaults must match what seed.js stores, so read them from there rather than guess.
  try {
    const src = fs.readFileSync(path.join(__dirname, "seed.js"), "utf8");
    const m = src.match(/const PAY = (\{[\s\S]*?\n\});/);
    if (m) Object.assign(PAY, new Function(`return ${m[1]}`)());
  } catch { /* keep the defaults above */ }
  await svc.updateSettings(d, { company_name: "World Entrepreneurs Company", company_account_no: "0001234567", company_return_rate: 0, position_defaults: JSON.stringify(PAY) }, "admin");

  const HUBS = [["J1", "Jaffna 01", "Stanly Road, Jaffna", "M01", 0.2, 4000], ["J2", "Jaffna 02", "Kandy Road, Jaffna", "M02", 0.15, 4000], ["J3", "Jaffna 03", "Hospital Road, Jaffna", "M03", 0.1, 0]];
  for (const [code, name, location] of HUBS) await add("hubs", { code, name, location, phone: "021 722 3317" });

  // ---- 40 household products ----------------------------------------------------------------------------------------------------
  // name, selling price, buying price, how often it sells (relative)
  const CATALOGUE = [
    ["Dish wash liquid 500ml", 380, 270, 9], ["Floor cleaner 1L", 620, 450, 6], ["Bleach 1L", 340, 240, 6], ["Washing powder 1kg", 690, 520, 9],
    ["Fabric softener 1L", 780, 560, 5], ["Toilet cleaner 500ml", 450, 320, 6], ["Glass cleaner 500ml", 420, 300, 3], ["Hand wash 250ml", 360, 250, 7],
    ["Bath soap 3-pack", 390, 280, 8], ["Toothpaste 120g", 310, 220, 8], ["Toothbrush 2-pack", 260, 170, 6], ["Tissue rolls 6-pack", 540, 400, 6],
    ["Kitchen towel roll", 290, 200, 4], ["Garbage bags 30", 330, 230, 5], ["Aluminium foil 10m", 410, 300, 3], ["Cling wrap 30m", 460, 330, 3],
    ["Sponge scourers 3-pack", 180, 110, 7], ["Steel scrubber 2-pack", 150, 90, 5], ["Broom soft", 520, 370, 4], ["Dustpan set", 650, 470, 3],
    ["Plastic bucket 10L", 780, 560, 4], ["Plastic mug", 190, 120, 6], ["Laundry basket", 1450, 1050, 2], ["Storage box 10L", 1250, 900, 2],
    ["Food container set 3pc", 980, 700, 3], ["Water bottle 1L", 560, 390, 4], ["Lunch box", 740, 520, 3], ["Plate set 6pc", 1850, 1350, 2],
    ["Cup set 6pc", 1150, 820, 2], ["Cutlery set 24pc", 2450, 1750, 1.5], ["Frying pan 24cm", 2950, 2150, 1], ["Electric kettle 1.7L", 4650, 3500, 0.8],
    ["Steam iron", 5400, 4100, 0.6], ["LED bulb 9W 2-pack", 780, 560, 5], ["Extension cord 3m", 1350, 980, 2], ["AA batteries 4-pack", 420, 300, 5],
    ["Candles 12-pack", 240, 160, 4], ["Mosquito coils 10", 290, 200, 6], ["Insect spray 300ml", 720, 520, 4], ["Clothes pegs 24", 230, 150, 5],
  ];
  if (CATALOGUE.length !== 40) throw new Error("The catalogue must have 40 products");
  const P = []; // { id, name, price (rupees), weight }
  for (const [name, list_price, cost_price, weight] of CATALOGUE) {
    await products.create(d, { name, list_price, cost_price }, "admin");
    const id = Number((await d.get("SELECT id FROM products WHERE name = ?", name)).id);
    P.push({ id, name, price: list_price, weight });
  }

  // ---- people ---------------------------------------------------------------------------------------------------------------------
  // id, name, hub, position, reports to, usual business per working day (Rs), share of days worked
  const TEAM = [
    ["C01", "Jegan Muthiah", "J1", "coacher", null, 0, 0], ["PM01", "Hari Prasath", "J1", "promoting_manager", "C01", 0, 0], ["M01", "Arun Selvam", "J1", "manager", "PM01", 2500, 0.9],
    ["S01", "Kavin Thirumal", "J1", "supervisor", "M01", 6800, 0.97], ["S02", "Nila Sivakumar", "J1", "supervisor", "M01", 6000, 0.95],
    ["D01", "Pavan Kumar", "J1", "distributor", "M01", 4600, 0.97], ["D02", "Thevi Ganesh", "J1", "distributor", "M01", 4000, 0.95],
    ["D03", "Sharan Raj", "J1", "distributor", "M01", 3300, 0.95], ["D04", "Anitha Jegan", "J1", "distributor", "M01", 2800, 0.7],
    ["M04", "Dev Anand", "J1", "manager", "PM01", 2200, 0.9], ["D12", "Mani Raj", "J1", "distributor", "M04", 3000, 0.95], ["D13", "Latha Sri", "J1", "distributor", "M04", 2600, 0.9],
    ["C02", "Mala Krishnan", "J2", "coacher", null, 0, 0], ["PM02", "Ganesan Pillai", "J2", "promoting_manager", "C02", 0, 0], ["M02", "Ravi Shankar", "J2", "manager", "PM02", 3000, 0.9],
    ["S03", "Dinesh Prabu", "J2", "supervisor", "M02", 6400, 0.97], ["S04", "Janani Vel", "J2", "supervisor", "M02", 4200, 0.9],
    ["D05", "Kavya Nathan", "J2", "distributor", "M02", 4400, 0.97], ["D06", "Mohan Das", "J2", "distributor", "M02", 3800, 0.95],
    ["D07", "Sutha Pillai", "J2", "distributor", "M02", 3500, 0.95], ["D08", "Yazhini Raj", "J2", "distributor", "M02", 2500, 0.7],
    ["C03", "Rajan Thevar", "J3", "coacher", null, 0, 0], ["PM03", "Sumathi Arul", "J3", "promoting_manager", "C03", 0, 0], ["M03", "Selvi Anand", "J3", "manager", "PM03", 1200, 0.9],
    ["S05", "Lavanya Muthu", "J3", "supervisor", "M03", 3000, 0.97], ["D09", "Vimal Raj", "J3", "distributor", "M03", 2500, 0.95], ["D10", "Priya Tharan", "J3", "distributor", "M03", 1800, 0.95],
    // more workers under the managers
    ["D14", "Sathiya Moorthy", "J1", "distributor", "M01", 3100, 0.95], ["D15", "Keerthana Balan", "J1", "distributor", "M01", 2700, 0.9],
    ["D16", "Ahilan Raj", "J1", "distributor", "M01", 3600, 0.96], ["S06", "Thayalan Suresh", "J1", "supervisor", "M01", 5200, 0.95],
    ["D17", "Nirosha Kumar", "J1", "distributor", "M04", 2900, 0.92], ["D18", "Brindha Selva", "J1", "distributor", "M04", 2400, 0.9], ["S07", "Gowtham Raj", "J1", "supervisor", "M04", 4800, 0.95],
    ["D19", "Tharsan Mohan", "J2", "distributor", "M02", 3300, 0.95], ["D20", "Vasuki Anand", "J2", "distributor", "M02", 2800, 0.9],
    ["D21", "Ruban Kumar", "J2", "distributor", "M02", 3900, 0.96], ["S08", "Kajan Vijay", "J2", "supervisor", "M02", 5000, 0.95], ["D22", "Subha Sri", "J2", "distributor", "M02", 2300, 0.85],
    ["D23", "Kirushanth Raj", "J3", "distributor", "M03", 2200, 0.95], ["D24", "Mathi Vani", "J3", "distributor", "M03", 1900, 0.9],
    ["D25", "Jenu Jey", "J3", "distributor", "M03", 2400, 0.93], ["S09", "Rohan Dias", "J3", "supervisor", "M03", 3600, 0.95],
  ];
  // Joiners during the period (no sales before they join, and some have no bank account on file yet)
  const JOINERS = [["D11", "Kumar Vel", "J1", "M01", 3000, 0.92, "2026-11-12", false], ["D26", "Aravind Siva", "J1", "M01", 2800, 0.95, "2026-11-09", true], ["D27", "Nathan Peris", "J2", "M02", 3100, 0.95, "2026-11-16", true]];
  const joinOn = Object.fromEntries(JOINERS.map((j) => [j[0], j[6]]));
  const leaveOn = { D08: "2026-11-14" };
  const BANKS = [["7010", "Bank of Ceylon", "001"], ["7056", "Commercial Bank", "012"], ["7278", "Sampath Bank", "030"], ["7083", "Hatton National Bank", "045"], ["7135", "People's Bank", "101"]];
  for (const [i, [id, name, hub, position, upline]] of TEAM.entries()) {
    const [bankCode, bankName, branch] = BANKS[i % BANKS.length];
    await add("staff", { employee_id: id, name, hub, staff_level: position, ...(upline ? { upline_id: upline } : {}), ...(PAY[position] || {}),
      bank_name: bankName, bank_code: bankCode, branch_code: branch, bank_account_no: String(1000000000 + i * 111111 + 4321),
      phone: `077 ${String(100 + i).padStart(3, "0")} ${2000 + i * 7}`, join_date: "2024-03-01" });
  }
  for (const [i, [id, name, hub, upline, , , joined, bank]] of JOINERS.entries()) {
    await add("staff", { employee_id: id, name, hub, staff_level: "distributor", upline_id: upline, ...PAY.distributor, phone: `077 ${300 + i} ${4100 + i * 13}`, join_date: joined,
      ...(bank ? { bank_name: "Sampath Bank", bank_code: "7278", branch_code: "030", bank_account_no: String(2000000000 + i * 99999 + 77) } : {}) });
  }
  const sellers = [...TEAM.filter((t) => t[5] > 0), ...JOINERS.map(([id, , hub, up, usual, att]) => [id, "", hub, "distributor", up, usual, att])];

  // Staff-portal logins (the sellers who can sign in and sell from their own phone) and the manager logins
  const PORTAL_USERS = [["pavan", "Pavan Kumar", "D01"], ["kavin", "Kavin Thirumal", "S01"], ["nila", "Nila Sivakumar", "S02"], ["coacher1", "Jegan Muthiah", "C01"], ["promo1", "Hari Prasath", "PM01"],
    ["coacher2", "Mala Krishnan", "C02"], ["coacher3", "Rajan Thevar", "C03"], ["promo2", "Ganesan Pillai", "PM02"], ["anitha", "Anitha Jegan", "D04"], ["sutha", "Sutha Pillai", "D07"],
    ["dinesh", "Dinesh Prabu", "S03"], ["kumar", "Kumar Vel", "D11"], ["sathiya", "Sathiya Moorthy", "D14"], ["gowtham", "Gowtham Raj", "S07"], ["tharsan", "Tharsan Mohan", "D19"], ["rohan", "Rohan Dias", "S09"]];
  for (const [username, full_name, employee_id] of PORTAL_USERS) { const password = pw("staff123"); creds.push([username, password, `staff portal (${employee_id})`]); await auth.createUser(d, adminUser, { username, full_name, role: "staff", employee_id, password }); }
  for (const [username, full_name, employee_id] of MANAGER_LOGINS) { const password = pw("manager123"); creds.push([username, password, `manager (${employee_id})`]); await auth.createUser(d, adminUser, { username, full_name, role: "staff", employee_id, password }); }
  await svc.updateEntry(d, "staff", "M04", { stock_keeper: true }, "admin");
  const userOf = Object.fromEntries(PORTAL_USERS.map(([u, , e]) => [e, u]));
  const coacherOf = { J1: "coacher1", J2: "coacher2", J3: "coacher3" };

  // ---- a deterministic pseudo-random generator, so the data is the same every time ------------------------------------------------
  let seed = 2026;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (arr, weightOf) => { const total = arr.reduce((t, x) => t + weightOf(x), 0); let r = rnd() * total; for (const x of arr) { r -= weightOf(x); if (r <= 0) return x; } return arr[arr.length - 1]; };
  const iso = (date, hh, mm) => `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;

  // ---- the stock chain and the sales, one day at a time ---------------------------------------------------------------------------
  const officeLeft = new Map(), hubLeft = Object.fromEntries(HUBS.map(([c]) => [c, new Map()])), sellerLeft = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const tally = { receipts: 0, hubIssues: 0, issues: 0, saleLines: 0 };
  // Rows are collected while the days are simulated and written in batches afterwards (much faster, especially on a hosted database).
  const batch = { receipts: [], hub: [], issues: [], sales: [] };
  const insertReceipt = (date, pid, qty, note, at) => { tally.receipts++; batch.receipts.push([date, pid, qty, note, "admin", at]); };
  const insertHub = (date, hub, pid, qty, note, at) => { tally.hubIssues++; batch.hub.push([date, hub, pid, qty, note, "admin", at]); };
  const insertIssue = (date, hub, id, pid, qty, at) => { tally.issues++; batch.issues.push([date, id, pid, qty, "Morning stock", coacherOf[hub], at]); };
  const bulk = async (table, cols, rows) => {
    for (let i = 0; i < rows.length; i += 120) {
      const chunk = rows.slice(i, i + 120);
      await d.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => "(" + cols.map(() => "?").join(", ") + ")").join(", ")}`, ...chunk.flat());
    }
  };

  // Day one: the office receives its first stock, and every hub is sent a starting quantity
  for (const p of P) { const q = Math.round(p.weight * 55 + 60); await insertReceipt(START, p.id, q, "Opening stock", iso(START, 8, 0)); bump(officeLeft, p.id, q); }
  for (const [code] of HUBS) for (const p of P) { const q = Math.round(p.weight * 9 + 12); await insertHub(START, code, p.id, q, "First delivery", iso(START, 8, 30)); bump(officeLeft, p.id, -q); bump(hubLeft[code], p.id, q); }

  const dailyRows = []; // for the daily sheet (rupees)
  const shortOn = { D02: 1500, D04: 9000, D21: 1200 };
  const dates = [];
  for (let day = START; day <= END; day = addDays(day, 1)) dates.push(day);
  for (const day of dates) {
    const sunday = new Date(day + "T00:00:00Z").getUTCDay() === 0;
    if (sunday) continue; // closed Sundays
    const trend = 1 + (dates.indexOf(day) / Math.max(1, dates.length)) * 0.08;
    for (const [code] of HUBS) {
      // 1. who works today, and what they will sell
      const plan = [];
      for (const [id, , hub, , , usual, attend] of sellers) {
        if (hub !== code) continue;
        if (joinOn[id] ? day < joinOn[id] : false) continue;
        if (leaveOn[id] && day > leaveOn[id]) continue;
        if (rnd() > attend) continue;
        const target = usual * (0.85 + rnd() * 0.3) * trend;
        const lines = [];
        let total = 0, guard = 0;
        while (total < target * 0.96 && guard++ < 60) {
          const p = pick(P, (x) => x.weight);
          const q = p.price > 2000 ? 1 : p.price > 700 ? 1 + (rnd() < 0.3 ? 1 : 0) : 1 + Math.floor(rnd() * 3);
          if (total + p.price * q > target * 1.12) { if (guard > 30) break; continue; }
          lines.push({ p, q }); total += p.price * q;
        }
        if (lines.length) plan.push({ id, lines, total });
      }
      // 2. what each seller needs from the hub this morning
      const issueRows = [], hubNeed = new Map();
      for (const s of plan) {
        const need = new Map();
        for (const l of s.lines) bump(need, l.p.id, l.q);
        const left = sellerLeft.get(s.id) || new Map();
        for (const [pid, q] of need) {
          const short = q - (left.get(pid) || 0);
          if (short > 0) { const give = short + (rnd() < 0.5 ? 1 + Math.floor(rnd() * 3) : 0); issueRows.push({ id: s.id, pid, give }); bump(hubNeed, pid, give); }
        }
      }
      // 3. the hub tops up from the office when it runs short, and the office buys more when it runs short
      let t = 0;
      for (const [pid, need] of hubNeed) {
        const have = hubLeft[code].get(pid) || 0;
        if (have >= need) continue;
        const restock = need - have + 40 + Math.floor(rnd() * 80);
        if ((officeLeft.get(pid) || 0) < restock) { const buy = restock - (officeLeft.get(pid) || 0) + 150 + Math.floor(rnd() * 300); await insertReceipt(day, pid, buy, "Supplier delivery", iso(day, 7, 40 + (t % 15))); bump(officeLeft, pid, buy); }
        await insertHub(day, code, pid, restock, "Restock", iso(day, 8, 10 + (t++ % 40))); bump(officeLeft, pid, -restock); bump(hubLeft[code], pid, restock);
      }
      // 4. the coacher gives stock out, the sellers sell, then hand in the money
      let m = 0;
      for (const r of issueRows) { await insertIssue(day, code, r.id, r.pid, r.give, iso(day, 8 + Math.floor(m / 40), 45 + (m++ % 15))); bump(hubLeft[code], r.pid, -r.give); bump(sellerLeft.get(r.id) || sellerLeft.set(r.id, new Map()).get(r.id), r.pid, r.give); }
      for (const s of plan) {
        const left = sellerLeft.get(s.id) || sellerLeft.set(s.id, new Map()).get(s.id);
        let n = 0;
        for (const l of s.lines) {
          tally.saleLines++;
          batch.sales.push([day, s.id, l.p.id, l.q, l.p.price * 100, l.p.price * l.q * 100, userOf[s.id] || coacherOf[code], iso(day, 10 + Math.floor((n++ * 7) / 20), (n * 7) % 60)]);
          bump(left, l.p.id, -l.q);
        }
        const business = s.total;
        const gap = shortOn[s.id] && rnd() < (s.id === "D04" ? 0.12 : 0.2) ? Math.round(rnd() * shortOn[s.id]) : 0;
        const settled = Math.round((business * (0.9 + rnd() * 0.05)) / 10) * 10 - gap;
        dailyRows.push({ date: day, employee_id: s.id, business_amount: business, settled_amount: Math.max(0, settled), personal_minus: rnd() < 0.08 ? 1000 : 0, hub: code });
      }
    }
  }

  // ---- the daily sheets (the day totals match the sales above) --------------------------------------------------------------------
  const credit = dailyRows.find((r) => r.employee_id === "D05" && r.date >= "2026-11-10");
  if (credit) { credit.settled_amount = credit.business_amount + 400; credit.notes = "Customer paid an old balance"; }
  // Written straight to the tables, the way the till does, because managers sell too (the day-sheet importer only takes distributors and supervisors).
  await bulk("product_receipts", ["date", "product_id", "qty", "note", "created_by", "created_at"], batch.receipts);
  await bulk("hub_issues", ["date", "hub", "product_id", "qty", "note", "created_by", "created_at"], batch.hub);
  await bulk("stock_issues", ["date", "employee_id", "product_id", "qty", "note", "created_by", "created_at"], batch.issues);
  await bulk("sale_lines", ["date", "employee_id", "product_id", "qty", "unit_price", "amount", "created_by", "created_at"], batch.sales);
  await bulk("daily_log", ["date", "employee_id", "business_amount", "settled_amount", "personal_minus", "notes", "created_by", "created_at"],
    dailyRows.map((r) => [r.date, r.employee_id, r.business_amount * 100, r.settled_amount * 100, r.personal_minus * 100, r.notes || null, "manager1", iso(r.date, 18, 15)]));
  // Days sellers with a login entered themselves: older ones are confirmed by the office, the last two days wait for confirmation.
  const lastTwo = dates.filter((x) => new Date(x + "T00:00:00Z").getUTCDay() !== 0).slice(-2);
  for (const [username, , employee_id] of PORTAL_USERS) {
    await d.run(`UPDATE daily_log SET source = 'portal', created_by = ?, confirmed_by = CASE WHEN date IN (${lastTwo.map(() => "?").join(",")}) THEN NULL ELSE 'manager1' END,
      confirmed_at = CASE WHEN date IN (${lastTwo.map(() => "?").join(",")}) THEN NULL ELSE date || 'T18:30:00.000Z' END WHERE employee_id = ?`, username, ...lastTwo, ...lastTwo, employee_id);
  }

  // ---- weekly sheets for the weeks that are finished -------------------------------------------------------------------------------
  const weekly = [];
  for (let ws = START; addDays(ws, 6) <= END; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    for (const [hub, , , mgr, , rent] of HUBS) {
      const business = dailyRows.filter((r) => r.hub === hub && r.date >= ws && r.date <= we).reduce((t, r) => t + r.business_amount, 0);
      if (!business) continue;
      weekly.push({ week_start: ws, week_end: we, manager_id: mgr, business_total: business, profit_percent: business >= 100000 ? 0.2 : 0.15, rent, hub_fee: 500, security_cost: Math.round(business * 0.01),
        personal_draw: mgr === "M02" && ws === "2026-11-09" ? 45000 : business < 100000 ? Math.round((2000 + rnd() * 3000) / 100) * 100 : Math.round((8000 + rnd() * 12000) / 100) * 100 });
    }
  }
  if (weekly.length) await svc.bulkUpsert(d, "weekly", weekly, "admin");

  // ---- stock counts: sellers' sheet and the hubs' count sheet ----------------------------------------------------------------------
  const nameOf = Object.fromEntries(P.map((p) => [p.id, p]));
  const sellerStock = [];
  const ids = [...sellerLeft.keys()];
  for (const id of ids) {
    const issued = await d.all("SELECT product_id, SUM(qty) AS n FROM stock_issues WHERE employee_id = ? GROUP BY product_id", id);
    const sold = Object.fromEntries((await d.all("SELECT product_id, SUM(qty) AS n FROM sale_lines WHERE employee_id = ? GROUP BY product_id", id)).map((r) => [String(r.product_id), Number(r.n)]));
    for (const r of issued) {
      const left = (sellerLeft.get(id).get(Number(r.product_id)) || 0);
      const lost = id === "D07" && nameOf[Number(r.product_id)].name === "Dish wash liquid 500ml" ? 9 : id === "D02" && rnd() < 0.05 ? 1 : 0;
      sellerStock.push({ period: PERIOD, employee_id: id, product: nameOf[Number(r.product_id)].name, opening_stock: 0, issued: Number(r.n), sold: sold[String(r.product_id)] || 0,
        counted_stock: Math.max(0, left - lost), unit_price: nameOf[Number(r.product_id)].price });
    }
  }
  // The seller count sheet only takes distributors and supervisors (managers sell on the till, but are not on this sheet).
  const sheetIds = new Set(sellers.filter((t) => t[3] === "distributor" || t[3] === "supervisor").map((t) => t[0]));
  const sheetRows = sellerStock.filter((r) => sheetIds.has(r.employee_id));
  if (sheetRows.length) await svc.bulkUpsert(d, "stock", sheetRows, "manager1");
  const hubStock = [];
  for (const [code] of HUBS) {
    const got = Object.fromEntries((await d.all("SELECT product_id, SUM(qty) AS n FROM hub_issues WHERE hub = ? GROUP BY product_id", code)).map((r) => [String(r.product_id), Number(r.n)]));
    const gave = Object.fromEntries((await d.all("SELECT i.product_id, SUM(i.qty) AS n FROM stock_issues i JOIN staff s ON s.employee_id = i.employee_id WHERE s.hub = ? GROUP BY i.product_id", code)).map((r) => [String(r.product_id), Number(r.n)]));
    for (const p of P) {
      const left = hubLeft[code].get(p.id) || 0;
      hubStock.push({ period: PERIOD, hub: code, product: p.name, opening_stock: 0, received: got[String(p.id)] || 0, issued: gave[String(p.id)] || 0,
        counted_stock: Math.max(0, left - (code === "J2" && p.name === "Washing powder 1kg" ? 5 : 0)), unit_price: p.price });
    }
  }
  await svc.bulkUpsert(d, "hubstock", hubStock, "admin");

  // ---- allowances, loans and advances ----------------------------------------------------------------------------------------------
  const allowances = [["D01", "Transport", 3000], ["S03", "Attendance bonus", 2000], ["S01", "Festival bonus (Deepavali)", 5000], ["S06", "Festival bonus (Deepavali)", 4000], ["D19", "Transport", 2500], ["M02", "Hub opening", 3500]];
  for (const [employee_id, description, amount] of allowances) await svc.createEntry(d, "allowances", { period: PERIOD, employee_id, description, amount }, "admin");
  await loans.create(d, { employee_id: "D01", kind: "loan", amount: 40000, instalment: 10000, start_period: PERIOD, issued_on: "2026-11-03", note: "School fees" }, "admin");
  await loans.create(d, { employee_id: "D03", kind: "advance", amount: 5000, start_period: PERIOD, issued_on: "2026-11-04", note: "Medical" }, "admin");
  await loans.create(d, { employee_id: "S02", kind: "loan", amount: 30000, instalment: 5000, start_period: PERIOD, issued_on: "2026-11-03", note: "Bike repair" }, "admin");
  await loans.create(d, { employee_id: "D19", kind: "advance", amount: 3000, start_period: PERIOD, issued_on: "2026-11-10", note: "Family event" }, "admin");
  await loans.create(d, { employee_id: "D21", kind: "loan", amount: 20000, instalment: 5000, start_period: "2026-12", issued_on: "2026-11-12", note: "Phone purchase (repay from December)" }, "admin");

  // ---- scenarios for the payroll checks and the approvals queue -------------------------------------------------------------------
  await svc.updateEntry(d, "staff", "D05", { security_deduction_rule: "pct_business:1;cap:3000" }, "admin");
  await svc.updateEntry(d, "staff", "S04", { pay_scheme: "over_target", basic_pay: 30000, target: 120000, commission_rate: 0.3, base_commission_rate: 0, food_per_day: 0, food_min_days: 0 }, "admin");
  await svc.updateEntry(d, "staff", "D07", { bank_account_no: "3000999888" }, "admin");
  await people.leave(d, "D08", { leave_date: leaveOn.D08, reason: "Moved to another town" }, "admin");

  await svc.runPeriod(d, PERIOD, "admin");
  const decide = async (id, decision, note) => {
    const r = (await svc.getPeriod(d, PERIOD)).rows.find((x) => x.employee_id === id);
    if (r && r.status === "pending_review") await svc.review(d, PERIOD, id, "admin", decision, note);
  };
  await decide("D02", "approved", "Checked against the hub's cash book");
  await decide("M03", "approved", "Small hub: the retaining month is confirmed by the owner");
  await decide("D04", "rejected", "Cash short is too large. Recount with the manager and re-enter");

  // ---- a summary ---------------------------------------------------------------------------------------------------------------------
  const count = async (sql) => Number((await d.get(sql)).n);
  console.log(`Built ${remote ? "the hosted database " + new URL(process.env.DATABASE_URL).hostname : target}`);
  console.log(`  Period: ${START} to ${END} (today ${todaySL} has nothing recorded)`);
  console.log(`  Products: ${await count("SELECT COUNT(*) AS n FROM products")} | staff: ${await count("SELECT COUNT(*) AS n FROM staff")} (${sellers.length} sell) | logins: ${await count("SELECT COUNT(*) AS n FROM users")}`);
  console.log(`  Stock: ${tally.receipts} office receipts, ${tally.hubIssues} sends to hubs, ${tally.issues} stock given to sellers | sales: ${tally.saleLines} lines, ${await count("SELECT COUNT(*) AS n FROM daily_log")} day sheets`);
  console.log(`  Today's records: ${await count(`SELECT (SELECT COUNT(*) FROM daily_log WHERE date >= '${todaySL}') + (SELECT COUNT(*) FROM sale_lines WHERE date >= '${todaySL}') + (SELECT COUNT(*) FROM stock_issues WHERE date >= '${todaySL}') + (SELECT COUNT(*) FROM hub_issues WHERE date >= '${todaySL}') + (SELECT COUNT(*) FROM product_receipts WHERE date >= '${todaySL}') AS n`)}`);
  console.log(remote ? "Sign-ins (random passwords, save them now: they are not shown again):" : "Sign-ins:");
  for (const [u, p, what] of creds) console.log(`  ${u.padEnd(10)} ${p.padEnd(14)} ${what}`);
  for (const r of (await svc.getPeriod(d, PERIOD)).rows.filter((x) => x.flags.length)) console.log(`  ${PERIOD} ${r.employee_id.padEnd(5)} ${r.status.padEnd(14)} ${r.flags.map((f) => f.code).join(", ")}`);
  await d.close();
})().catch((err) => { console.error(err); process.exit(1); });
