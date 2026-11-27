// Scenario demo: node seed-scenarios.js [folder] --reset
//   Builds a LOCAL demo database (default data/scenarios) from a snapshot of the live people (data/live-snapshot.json: hubs and the
//   whole team structure), then adds:
//   - 15 household products, held as stock (office -> hubs -> sellers)
//   - every working day of November up to YESTERDAY: sales, stock given out, daily sheets, stock counts, cash handovers, loans, allowances
//   - named example people who cover each pay situation (under / over target, cash short, stock short, new joiner, leaver, retaining
//     manager ...). Their sign-ins are printed at the end and written to docs/Scenario-Demo-Guide.txt is NOT done here: see the README.
//   Nothing is recorded for today, so every entry screen can be tried from empty.
//   It never touches a hosted database. The snapshot has names and team structure only (no phone numbers, IDs or bank details).
const fs = require("fs");
const path = require("path");
const db = require("./db");
const svc = require("./service");
const auth = require("./auth");
const products = require("./products");
const loans = require("./loans");
const people = require("./people");

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const target = path.resolve(arg || path.join(__dirname, "data", "scenarios"));
const reset = process.argv.includes("--reset");
const SNAP = path.join(__dirname, "data", "live-snapshot.json");
const PASSWORD = "demo1234";
const START = "2026-11-02"; // Sunday the 1st is a closed day; the first working day is Monday the 2nd

(async () => {
  if (!target.startsWith(path.join(__dirname, "data") + path.sep)) { console.log("Choose a folder inside this project's data folder, for example data/scenarios."); return; }
  if (!fs.existsSync(SNAP)) { console.log("data/live-snapshot.json is missing. Fetch it with: node tools/fetch-live-snapshot.js <live address> <admin user> <admin password>"); return; }
  if (fs.existsSync(target)) {
    if (!reset) { console.log(`${target} already exists. Run again with --reset to replace it.`); return; }
    fs.rmSync(target, { recursive: true, force: true });
  }
  const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const d = await db.open(target);
  const admin = { username: "admin" };
  const add = (kind, row, user = "admin") => svc.createEntry(d, kind, row, user);
  const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const todaySL = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const END = addDays(todaySL, -1);
  const PERIOD = START.slice(0, 7);
  const creds = [];

  await auth.setup(d, { username: "admin", full_name: "Owner Admin", password: PASSWORD });
  creds.push(["admin", "Owner: sees everything, runs payroll, closes the month"]);

  // ---- settings and hubs (from the live snapshot) -----------------------------------------------------------------------------
  let PAY = {};
  try { PAY = JSON.parse(snap.settings.position_defaults || "{}"); } catch { /* defaults stay as they are in the database */ }
  await svc.updateSettings(d, { company_name: snap.settings.company_name || "World Entrepreneurs Company", position_defaults: JSON.stringify(PAY) }, "admin");
  for (const h of snap.hubs) await add("hubs", { code: h.code, name: h.name, location: h.location || h.name, phone: h.phone || "021 000 0000" });

  // ---- 15 products ---------------------------------------------------------------------------------------------------------------
  // name, selling price, buying price, how often it sells
  const CATALOGUE = [
    ["Dish wash liquid 500ml", 380, 270, 9], ["Washing powder 1kg", 690, 520, 9], ["Bath soap 3-pack", 390, 280, 8], ["Toothpaste 120g", 310, 220, 8],
    ["Hand wash 250ml", 360, 250, 7], ["Tissue rolls 6-pack", 540, 400, 6], ["Floor cleaner 1L", 620, 450, 6], ["Sponge scourers 3-pack", 180, 110, 7],
    ["Garbage bags 30", 330, 230, 5], ["Plastic mug", 190, 120, 6], ["Broom soft", 520, 370, 4], ["Plastic bucket 10L", 780, 560, 4],
    ["Water bottle 1L", 560, 390, 4], ["Cup set 6pc", 1150, 820, 2], ["Cutlery set 24pc", 2450, 1750, 1.5],
  ];
  const P = [];
  for (const [name, list_price, cost_price, weight] of CATALOGUE) {
    await products.create(d, { name, list_price, cost_price }, "admin");
    P.push({ id: Number((await d.get("SELECT id FROM products WHERE name = ?", name)).id), name, price: list_price, weight });
  }

  // ---- the live team structure ---------------------------------------------------------------------------------------------------
  // Everyone joins on 15 October so that November is a full month. Pay fields come back from the live site in cents; the form takes rupees.
  const by = new Map(snap.staff.map((s) => [s.employee_id, s]));
  const depth = (s, n = 0) => (s.upline_id && by.get(s.upline_id) && n < 20 ? depth(by.get(s.upline_id), n + 1) + 1 : 0);
  const ordered = [...snap.staff].sort((a, b) => depth(a) - depth(b) || a.employee_id.localeCompare(b.employee_id));
  const NEW = { M01D08: "2026-11-16" };       // joins mid-month
  const LEAVER = { M05D08: "2026-11-14" };    // leaves mid-month
  for (const s of ordered) {
    await add("staff", {
      employee_id: s.employee_id, name: s.name, hub: s.hub, staff_level: s.staff_level, ...(s.upline_id ? { upline_id: s.upline_id } : {}),
      join_date: NEW[s.employee_id] || "2026-10-15", pay_scheme: s.pay_scheme, target: s.target / 100, basic_pay: s.basic_pay / 100,
      commission_rate: s.commission_rate, base_commission_rate: s.base_commission_rate, food_per_day: s.food_per_day / 100, food_min_days: s.food_min_days,
      security_deduction_rule: s.security_deduction_rule, ...(s.is_coacher ? { is_coacher: true } : {}),
    });
  }

  // ---- named example people ------------------------------------------------------------------------------------------------------
  // id -> { user, what, usual: business per working day in Rupees, attend: share of days worked, plus special behaviour }
  const SC = {
    M01D01: { user: "dist-under", what: "Distributor UNDER target (about 60% of Rs 100,000)", usual: 2900, attend: 1 },
    M01D02: { user: "dist-over", what: "Distributor OVER target (about 140%): higher rate on the part above target", usual: 6700, attend: 1, portalLastDayUnconfirmed: true },
    M01D03: { user: "dist-exact", what: "Distributor right ON target (about 100%)", usual: 4700, attend: 1 },
    M01D04: { user: "dist-cash-short", what: "Distributor who hands in LESS cash than sold on several days (cash short is taken off)", usual: 4300, attend: 1, shortDays: 6 },
    M01D05: { user: "dist-cash-extra", what: "Distributor who hands in MORE than sold on one day (a payback: raises the 'more cash than sales' note)", usual: 4300, attend: 1, extraDay: true },
    M01D06: { user: "dist-stock-short", what: "Distributor whose stock count finds products MISSING (value taken off, note raised)", usual: 4400, attend: 1, lost: [["Cutlery set 24pc", 3], ["Cup set 6pc", 2]] },
    M01D07: { user: "dist-loan", what: "Distributor with a loan being repaid, an advance and a bonus (allowance)", usual: 4500, attend: 1, advanceDay: 2000 },
    M01D08: { user: "dist-new", what: "Distributor who JOINED mid-month (16 Nov): only counted from that day", usual: 4000, attend: 1 },
    M06D01: { user: "dist-unconfirmed", what: "Distributor whose last two days were entered on the phone and are NOT YET CONFIRMED", usual: 4500, attend: 1, portalUnconfirmed: 2 },
    M06D02: { user: "dist-absent", what: "Distributor who worked only about half the days", usual: 4600, attend: 0.5 },
    M01S01: { user: "sup-under", what: "Supervisor UNDER target (target Rs 120,000) and under 21 days: NO food allowance", usual: 3900, attend: 0.8 },
    M01S02: { user: "sup-over", what: "Supervisor OVER target and every day worked (21+ days): food allowance paid", usual: 7600, attend: 1 },
    M06: { user: "mgr-over", what: "Manager whose team is OVER the weekly target: the higher profit share (20%)", usual: 1500, attend: 0.95, teamUsual: 5600 },
    M07: { user: "mgr-under", what: "Manager whose team is UNDER the weekly target: the lower profit share (15%), not retaining", usual: 1200, attend: 0.95, teamUsual: 1250 },
    M05: { user: "mgr-retaining", what: "RETAINING manager: month's sales below the retaining limit, so a flat share of the month's sales", usual: 600, attend: 0.9, teamUsual: 650 },
    M09: { user: "mgr-stock", what: "Manager who is also the STOCK KEEPER (gives stock out and counts it)", usual: 1500, attend: 0.95, stockKeeper: true },
    PM02: { user: "promo-1", what: "Promoting manager: pay from the sales of the managers under them (includes the under-target manager M07)", usual: 0, attend: 0 },
    PM04: { user: "promo-2", what: "Promoting manager with a large group", usual: 0, attend: 0 },
  };
  // Hub coachers: the manager or promoting manager carrying the coacher tag.
  const coachers = snap.staff.filter((s) => s.is_coacher);
  const coacherOf = {};
  for (const c of coachers) { coacherOf[c.hub] = "coacher-" + c.hub.toLowerCase(); }
  for (const c of coachers) SC[c.employee_id] = { ...(SC[c.employee_id] || {}), user: SC[c.employee_id]?.user || coacherOf[c.hub], coach: c.hub, what: (SC[c.employee_id]?.what ? SC[c.employee_id].what + ". " : "") + `COACHER of ${c.hub}: heads the hub, enters the daily sheet, hands cash to the office` };
  // The coacher login must be the coacher's own name for the hub, whatever else that person is.
  for (const c of coachers) SC[c.employee_id].loginAs = coacherOf[c.hub];
  for (const [id, sc] of Object.entries(SC)) {
    if (!by.has(id)) continue;
    const login = sc.loginAs || sc.user;
    await auth.createUser(d, admin, { username: login, full_name: by.get(id).name, role: "staff", employee_id: id, password: PASSWORD });
    creds.push([login, `${by.get(id).name} (${id}, ${by.get(id).hub}): ${sc.what}`]);
  }
  if (SC.M09?.stockKeeper) await svc.updateEntry(d, "staff", "M09", { stock_keeper: true }, "admin");

  // ---- who sells, and how much on a normal day -----------------------------------------------------------------------------------
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (arr, weightOf) => { const total = arr.reduce((t, x) => t + weightOf(x), 0); let r = rnd() * total; for (const x of arr) { r -= weightOf(x); if (r <= 0) return x; } return arr[arr.length - 1]; };
  const iso = (date, hh, mm) => `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;
  const kids = (id) => snap.staff.filter((s) => s.upline_id === id).map((s) => s.employee_id);
  const sellersOfManager = new Map(); // manager id -> usual for their people (when the manager has a team profile)
  for (const [id, sc] of Object.entries(SC)) if (sc.teamUsual) for (const k of kids(id)) sellersOfManager.set(k, sc.teamUsual);
  const isSeller = (s) => s.staff_level === "distributor" || s.staff_level === "supervisor" || s.staff_level === "manager";
  const sellers = snap.staff.filter(isSeller).map((s) => {
    const sc = SC[s.employee_id] || {};
    const base = s.staff_level === "supervisor" ? 4300 + rnd() * 1800 : s.staff_level === "manager" ? 900 + rnd() * 900 : 3000 + rnd() * 2200;
    const usual = sc.usual ?? (sellersOfManager.has(s.employee_id) ? sellersOfManager.get(s.employee_id) * (0.8 + rnd() * 0.4) : base);
    return { id: s.employee_id, hub: s.hub, level: s.staff_level, usual, attend: sc.attend ?? 1, sc,
      from: NEW[s.employee_id] || "2026-10-15", until: LEAVER[s.employee_id] || null };
  });
  const loginOf = Object.fromEntries(Object.entries(SC).filter(([, v]) => v.user).map(([id, v]) => [id, v.loginAs || v.user]));

  // ---- the stock chain and the sales, one day at a time -----------------------------------------------------------------------------
  const hubs = snap.hubs.map((h) => h.code);
  const officeLeft = new Map(), hubLeft = Object.fromEntries(hubs.map((c) => [c, new Map()])), sellerLeft = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const batch = { receipts: [], hub: [], issues: [], sales: [], daily: [], handover: [] };
  const bulk = async (table, cols, rows) => {
    for (let i = 0; i < rows.length; i += 120) {
      const chunk = rows.slice(i, i + 120);
      await d.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => "(" + cols.map(() => "?").join(", ") + ")").join(", ")}`, ...chunk.flat());
    }
  };
  for (const p of P) { const q = Math.round(p.weight * 900 + 800); batch.receipts.push([START, p.id, q, "Opening stock", "admin", iso(START, 8, 0)]); bump(officeLeft, p.id, q); }
  for (const code of hubs) for (const p of P) { const q = Math.round(p.weight * 90 + 150); batch.hub.push([START, code, p.id, q, "First delivery", "admin", iso(START, 8, 30)]); bump(officeLeft, p.id, -q); bump(hubLeft[code], p.id, q); }

  const dates = [];
  for (let day = START; day <= END; day = addDays(day, 1)) dates.push(day);
  const working = dates.filter((x) => new Date(x + "T00:00:00Z").getUTCDay() !== 0);
  const dailyMeta = new Map(); // "date|id" -> row
  const shortCount = {};
  for (const day of working) {
    for (const code of hubs) {
      const plan = [];
      for (const s of sellers) {
        if (s.hub !== code || day < s.from || (s.until && day > s.until)) continue;
        // a fixed share of days: the dates are spread by position so e.g. "half the days" is really about half
        const idx = working.indexOf(day);
        const works = s.attend >= 1 ? true : ((idx * 0.618 + (s.id.length % 7) * 0.13) % 1) < s.attend;
        if (!works) continue;
        const wanted = s.usual * (0.9 + rnd() * 0.2);
        const lines = [];
        let total = 0, guard = 0;
        while (total < wanted * 0.97 && guard++ < 80) {
          const p = pick(P, (x) => x.weight);
          const q = p.price > 2000 ? 1 : p.price > 700 ? 1 + (rnd() < 0.3 ? 1 : 0) : 1 + Math.floor(rnd() * 3);
          if (total + p.price * q > wanted * 1.12) { if (guard > 40) break; continue; }
          lines.push({ p, q }); total += p.price * q;
        }
        if (lines.length) plan.push({ s, lines, total });
      }
      const issueRows = [], hubNeed = new Map();
      for (const x of plan) {
        const need = new Map();
        for (const l of x.lines) bump(need, l.p.id, l.q);
        const left = sellerLeft.get(x.s.id) || new Map();
        for (const [pid, q] of need) {
          const short = q - (left.get(pid) || 0);
          if (short > 0) { const give = short + (rnd() < 0.5 ? 1 + Math.floor(rnd() * 3) : 0); issueRows.push({ id: x.s.id, pid, give }); bump(hubNeed, pid, give); }
        }
      }
      let t = 0;
      for (const [pid, need] of hubNeed) {
        const have = hubLeft[code].get(pid) || 0;
        if (have >= need) continue;
        const restock = need - have + 60 + Math.floor(rnd() * 120);
        if ((officeLeft.get(pid) || 0) < restock) { const buy = restock - (officeLeft.get(pid) || 0) + 400 + Math.floor(rnd() * 600); batch.receipts.push([day, pid, buy, "Supplier delivery", "admin", iso(day, 7, 40 + (t % 15))]); bump(officeLeft, pid, buy); }
        batch.hub.push([day, code, pid, restock, "Restock", "admin", iso(day, 8, 10 + (t++ % 40))]); bump(officeLeft, pid, -restock); bump(hubLeft[code], pid, restock);
      }
      let m = 0;
      for (const r of issueRows) {
        batch.issues.push([day, r.id, r.pid, r.give, "Morning stock", coacherOf[code], iso(day, 8 + Math.floor(m / 60), 45 + (m++ % 15))]);
        bump(hubLeft[code], r.pid, -r.give); bump(sellerLeft.get(r.id) || sellerLeft.set(r.id, new Map()).get(r.id), r.pid, r.give);
      }
      let hubSales = 0;
      for (const x of plan) {
        const left = sellerLeft.get(x.s.id) || sellerLeft.set(x.s.id, new Map()).get(x.s.id);
        let n = 0;
        for (const l of x.lines) {
          batch.sales.push([day, x.s.id, l.p.id, l.q, l.p.price * 100, l.p.price * l.q * 100, loginOf[x.s.id] || coacherOf[code], iso(day, 10 + Math.floor((n++ * 7) / 20), (n * 7) % 60)]);
          bump(left, l.p.id, -l.q);
        }
        const business = x.total;
        let settled = business, personal = 0, notes = null;
        const sc = x.s.sc;
        if (sc.shortDays && (shortCount[x.s.id] || 0) < sc.shortDays && rnd() < 0.4) { settled = business - (800 + Math.round(rnd() * 20) * 100); shortCount[x.s.id] = (shortCount[x.s.id] || 0) + 1; }
        else if (!sc.shortDays && rnd() < 0.04) settled = business - 100 * (1 + Math.floor(rnd() * 4)); // an ordinary small slip now and then
        if (sc.extraDay && day === working[9]) { settled = business + 600; notes = "Paid back an earlier shortage"; }
        if (sc.advanceDay && day === working[6]) personal = sc.advanceDay;
        hubSales += business;
        batch.daily.push([day, x.s.id, business * 100, Math.max(0, settled) * 100, personal * 100, notes, coacherOf[code], iso(day, 18, 15)]);
        dailyMeta.set(day + "|" + x.s.id, { business, settled });
      }
      // the coacher hands the day's cash to the office: at least 90% of the hub's sales
      if (hubSales > 0) {
        const last = day === working[working.length - 1];
        const status = last ? (code === "J1" || code === "K1" ? "pending" : code === "J2" ? "rejected" : "approved") : "approved";
        const amount = Math.round(hubSales * (status === "rejected" ? 0.86 : 0.9 + rnd() * 0.1)) * 100;
        batch.handover.push([code, day, hubSales * 100, amount, status === "rejected" ? "Counted twice, sorry" : null, status, coacherOf[code], iso(day, 19, 5),
          status === "pending" ? null : "admin", status === "pending" ? null : iso(day, 19, 40),
          status === "rejected" ? "Below 90% of the day's sales. Recount and hand over again." : null]);
      }
    }
  }
  // The stock-short person also holds a few pieces they never sold, so that the count can find them missing.
  for (const [name, n] of SC.M01D06.lost) {
    const p = P.find((x) => x.name === name);
    batch.issues.push([working[3], "M01D06", p.id, n + 2, "Morning stock", coacherOf.J1, iso(working[3], 8, 50)]);
    bump(hubLeft.J1, p.id, -(n + 2)); bump(sellerLeft.get("M01D06") || sellerLeft.set("M01D06", new Map()).get("M01D06"), p.id, n + 2);
  }
  await bulk("product_receipts", ["date", "product_id", "qty", "note", "created_by", "created_at"], batch.receipts);
  await bulk("hub_issues", ["date", "hub", "product_id", "qty", "note", "created_by", "created_at"], batch.hub);
  await bulk("stock_issues", ["date", "employee_id", "product_id", "qty", "note", "created_by", "created_at"], batch.issues);
  await bulk("sale_lines", ["date", "employee_id", "product_id", "qty", "unit_price", "amount", "created_by", "created_at"], batch.sales);
  await bulk("daily_log", ["date", "employee_id", "business_amount", "settled_amount", "personal_minus", "notes", "created_by", "created_at"], batch.daily);
  // The cash book: what each hub's coacher spent or paid out of the cash, with a salary and some online money.
  const book = [];
  for (const code of hubs) {
    working.forEach((day, i) => {
      if (i % 3 === 1) book.push([code, day, "expense", "Tea and transport", (5 + Math.floor(rnd() * 10)) * 100, null, coacherOf[code], iso(day, 17, 30)]);
      if (i % 7 === 5) book.push([code, day, "expense", "Office", 2000 + Math.floor(rnd() * 3) * 500, "Stationery and printing", coacherOf[code], iso(day, 17, 40)]);
    });
    book.push([code, working[10], "salary", "Salary", 20000 + Math.floor(rnd() * 5) * 1000, "Paid in cash", coacherOf[code], iso(working[10], 18, 0)]);
    book.push([code, working[14], "online", "Bank transfer", 15000 + Math.floor(rnd() * 20) * 1000, "Customer paid the company directly", "admin", iso(working[14], 12, 0)]);
    if (code === "J1") book.push([code, working[4], "other_in", "Float from the office", 10000, "Starting cash for the hub", "admin", iso(working[4], 9, 0)]);
  }
  await bulk("cash_book_entries", ["hub", "date", "kind", "category", "amount", "note", "created_by", "created_at"], book.map((r) => [r[0], r[1], r[2], r[3], r[4] * 100, r[5], r[6], r[7]]));
  await bulk("cash_handovers", ["hub", "date", "sales", "amount", "note", "status", "submitted_by", "submitted_at", "verified_by", "verified_at", "verify_note"], batch.handover);

  // Days that sellers with a login entered on their own phone. Older ones were confirmed by the office; some of the latest are waiting.
  for (const s of sellers) {
    const sc = s.sc;
    if (!sc.user || s.level === "manager") continue;
    const login = loginOf[s.id];
    const mine = working.filter((x) => dailyMeta.has(x + "|" + s.id));
    const waiting = sc.portalUnconfirmed ? mine.slice(-sc.portalUnconfirmed) : sc.portalLastDayUnconfirmed ? mine.slice(-1) : [];
    await d.run(`UPDATE daily_log SET source = 'portal', created_by = ?, confirmed_by = CASE WHEN date = ANY(?::text[]) THEN NULL ELSE 'admin' END,
      confirmed_at = CASE WHEN date = ANY(?::text[]) THEN NULL ELSE date || 'T18:30:00.000Z' END WHERE employee_id = ?`, login, waiting, waiting, s.id);
  }

  // ---- stock counts: sellers' sheet and the hubs' count sheet --------------------------------------------------------------------------
  const nameOf = Object.fromEntries(P.map((p) => [p.id, p]));
  const sellerStock = [];
  for (const s of sellers.filter((x) => x.level !== "manager")) {
    const issued = await d.all("SELECT product_id, SUM(qty) AS n FROM stock_issues WHERE employee_id = ? GROUP BY product_id", s.id);
    const sold = Object.fromEntries((await d.all("SELECT product_id, SUM(qty) AS n FROM sale_lines WHERE employee_id = ? GROUP BY product_id", s.id)).map((r) => [String(r.product_id), Number(r.n)]));
    for (const r of issued) {
      const p = nameOf[Number(r.product_id)];
      const left = sellerLeft.get(s.id)?.get(p.id) || 0;
      const lostRow = (s.sc.lost || []).find(([n]) => n === p.name);
      sellerStock.push({ period: PERIOD, employee_id: s.id, product: p.name, opening_stock: 0, issued: Number(r.n), sold: sold[String(p.id)] || 0,
        counted_stock: Math.max(0, left - (lostRow ? lostRow[1] : 0)), unit_price: p.price });
    }
  }
  if (sellerStock.length) await svc.bulkUpsert(d, "stock", sellerStock, "admin");
  const hubStock = [];
  for (const code of hubs) {
    const got = Object.fromEntries((await d.all("SELECT product_id, SUM(qty) AS n FROM hub_issues WHERE hub = ? GROUP BY product_id", code)).map((r) => [String(r.product_id), Number(r.n)]));
    const gave = Object.fromEntries((await d.all("SELECT i.product_id, SUM(i.qty) AS n FROM stock_issues i JOIN staff s ON s.employee_id = i.employee_id WHERE s.hub = ? GROUP BY i.product_id", code)).map((r) => [String(r.product_id), Number(r.n)]));
    for (const p of P) {
      const left = hubLeft[code].get(p.id) || 0;
      hubStock.push({ period: PERIOD, hub: code, product: p.name, opening_stock: 0, received: got[String(p.id)] || 0, issued: gave[String(p.id)] || 0,
        counted_stock: Math.max(0, left - (code === "J2" && p.name === "Washing powder 1kg" ? 7 : code === "K1" && p.name === "Bath soap 3-pack" ? 4 : 0)), unit_price: p.price });
    }
  }
  await svc.bulkUpsert(d, "hubstock", hubStock, "admin");

  // ---- the weekly stock sheet: the last full week is counted by each hub's coacher, with a few pieces missing in two hubs
  const weekstock = require("./weekstock");
  const lastWeek = addDays(weekstock.mondayOf(todaySL), -7);
  const lostAt = { J2: { "Washing powder 1kg": 7 }, K1: { "Bath soap 3-pack": 4 } };
  for (const code of hubs) {
    const w = await weekstock.week(d, { hub: code, date: lastWeek });
    const counts = w.products.map((p) => ({ product_id: p.id, counted: Math.max(0, p.expected - ((lostAt[code] || {})[p.name] || 0)) }));
    if (counts.length) await weekstock.saveCounts(d, { username: coacherOf[code], hub: code }, { week_start: lastWeek, counts });
  }

  // ---- loans, advances and allowances ---------------------------------------------------------------------------------------------------
  await svc.createEntry(d, "allowances", { period: PERIOD, employee_id: "M01D07", description: "Attendance bonus", amount: 2500 }, "admin");
  await svc.createEntry(d, "allowances", { period: PERIOD, employee_id: "M01S02", description: "Festival bonus (Deepavali)", amount: 5000 }, "admin");
  await loans.create(d, { employee_id: "M01D07", kind: "loan", amount: 40000, instalment: 10000, start_period: PERIOD, issued_on: "2026-11-03", note: "School fees" }, "admin");
  await loans.create(d, { employee_id: "M01D01", kind: "advance", amount: 5000, start_period: PERIOD, issued_on: "2026-11-04", note: "Medical" }, "admin");
  await loans.create(d, { employee_id: "M06D03", kind: "loan", amount: 30000, instalment: 5000, start_period: "2026-12", issued_on: "2026-11-12", note: "Phone purchase (repay from December)" }, "admin");

  // ---- the leaver, then the month's salaries --------------------------------------------------------------------------------------------
  await people.leave(d, "M05D08", { leave_date: LEAVER.M05D08, reason: "Moved to another town" }, "admin");
  await svc.runPeriod(d, PERIOD, "admin");

  // ---- a summary -----------------------------------------------------------------------------------------------------------------------------
  const count = async (sql) => Number((await d.get(sql)).n);
  console.log(`Built ${target}`);
  console.log(`  ${snap.hubs.length} hubs, ${snap.staff.length} people (from the live snapshot of ${snap.taken?.slice(0, 10)}), ${P.length} products, ${await count("SELECT COUNT(*) AS n FROM users")} logins`);
  console.log(`  ${START} to ${END}: ${working.length} working days, ${batch.sales.length} sale lines, ${batch.daily.length} day sheets, ${batch.handover.length} cash handovers (today ${todaySL} is empty)`);
  const rows = (await svc.getPeriod(d, PERIOD)).rows;
  const rowOf = Object.fromEntries(rows.map((r) => [r.employee_id, r]));
  console.log("\nScenario people:");
  for (const [id, sc] of Object.entries(SC)) {
    const r = rowOf[id]; if (!r) continue;
    const dt = r.detail || {};
    console.log(`  ${(loginOf[id] || "").padEnd(16)} ${id.padEnd(7)} sales ${String(Math.round((dt.total_business || dt.month_sales || 0) / 100)).padStart(8)}  gross ${String(Math.round(r.gross_earnings / 100)).padStart(7)}  ded ${String(Math.round(r.total_deductions / 100)).padStart(6)}  net ${String(Math.round(r.net_pay / 100)).padStart(8)}  ${r.flags.map((f) => f.code).join(",")}`);
  }
  console.log("\nLogins (password for all: " + PASSWORD + ")");
  for (const [u, what] of creds) console.log(`  ${u.padEnd(16)} ${what}`);
  await d.close();
  fs.writeFileSync(path.join(__dirname, "data", "scenario-logins.json"), JSON.stringify(creds, null, 1));
})().catch((err) => { console.error(err); process.exit(1); });
