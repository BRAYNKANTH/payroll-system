// Go-live: load the real hubs and people (golive/hubs.csv and golive/people.csv) into the system.
//
//   node --env-file=.env tools/golive.js                                  CHECK ONLY. Reads the two files, tries every row against the real
//                                                                         rules in a scratch database, and says what is wrong. Changes nothing.
//   node --env-file=.env tools/golive.js --apply --yes-i-have-a-backup    LOAD. If the database already holds hubs or people (demo data) it also
//                                                                         needs --erase-demo, which clears them first. See the list printed.
//
// Erasing clears hubs, people, sales, stock moves, payroll, loans and logins other than the admin's. It KEEPS the admin logins, Settings, the product
// catalogue with its office stock, and the audit trail. A different database can be named as the first argument (a folder, for a local one);
// otherwise DATABASE_URL is used, the same as the server.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const svc = require("../service");
const auth = require("../auth");

const FOLDER = path.join(__dirname, "..", "golive");
const POSITIONS = { manager: "manager", "promoting manager": "promoting_manager", promoting_manager: "promoting_manager", pm: "promoting_manager", m: "manager" };
// Pay defaults for a position (the owner's list): a promoting manager Rs 30,000 and a manager Rs 27,000, unless the file says otherwise.
const DEFAULT_PAY = { manager: { basic_pay: 27000, target: 100000 }, promoting_manager: { basic_pay: 30000, target: 100000 } };
// Pay setup of the people under a manager, as the system's position defaults (Rs and fractions, the same shape Settings saves).
// A supervisor has a higher target and basic than a distributor, and food only from the 21st day worked.
const TIERED = { pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, security_deduction_rule: "pct_business:1" };
const SELLER_PAY = {
  distributor: { ...TIERED, target: 100000, basic_pay: 25000, food_min_days: 0 },
  supervisor: { ...TIERED, target: 120000, basic_pay: 30000, food_min_days: 21 },
};
const POSITION_DEFAULTS = { ...SELLER_PAY, manager: DEFAULT_PAY.manager, promoting_manager: DEFAULT_PAY.promoting_manager };
const SHARED_PASSWORD = "demo1234"; // every starter login; the client sets their own afterwards
// Kept when the database is erased. Everything else goes (users are handled on their own: only admin logins stay).
const KEEP = new Set(["schema_meta", "settings", "audit_log", "products", "product_receipts"]);

// A small CSV reader: quotes, commas inside quotes, a leading byte-order mark and Windows line endings.
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r, i) => ({ _line: i + 2, ...Object.fromEntries(head.map((h, j) => [h, (r[j] ?? "").trim()])) }));
}
const readTable = (file) => parseCsv(fs.readFileSync(file, "utf8"));
const yes = (v) => /^(y|yes|true|1|x)$/i.test(String(v || "").trim());

// Turns the two tables into hubs and people in the order they can be added (a person after the one whose team they are in), and lists every problem
// that can be seen from the files alone. The service rules are applied afterwards, by `check`.
function prepare(hubRows, peopleRows) {
  const problems = [];
  const hubs = [], codes = new Set();
  for (const h of hubRows) {
    const code = (h.code || "").trim();
    if (!code || !h.name) { problems.push(`hubs.csv line ${h._line}: a hub needs a code and a name`); continue; }
    if (codes.has(code)) { problems.push(`hubs.csv line ${h._line}: the code ${code} is used twice`); continue; }
    codes.add(code); hubs.push({ code, name: h.name, location: h.location || undefined, phone: h.phone || undefined });
  }
  const people = [], ids = new Set();
  for (const p of peopleRows) {
    const where = `people.csv line ${p._line}${p.name ? ` (${p.name})` : ""}`;
    if (!p.employee_id || !p.name) { problems.push(`${where}: a person needs an employee_id and a name`); continue; }
    if (ids.has(p.employee_id)) { problems.push(`${where}: the id ${p.employee_id} is used twice`); continue; }
    ids.add(p.employee_id);
    const level = POSITIONS[String(p.position || "").trim().toLowerCase()];
    if (!level) problems.push(`${where}: the position must be "manager" or "promoting manager" (distributors and supervisors are added later, under their manager)`);
    if (!p.hub) problems.push(`${where}: no hub yet. Write the hub code this person belongs to`);
    else if (!codes.has(p.hub)) problems.push(`${where}: the hub "${p.hub}" is not in hubs.csv`);
    const pay = Number(String(p.basic_pay || "").replace(/,/g, ""));
    people.push({ employee_id: p.employee_id, name: p.name, staff_level: level, upline_id: p.team_of || p.reports_to || undefined, hub: p.hub, is_coacher: yes(p.coacher), phone: p.phone || undefined,
      ...(level ? DEFAULT_PAY[level] : {}), ...(p.basic_pay && Number.isFinite(pay) ? { basic_pay: pay } : {}), _line: p._line });
  }
  for (const p of people) if (p.upline_id && !ids.has(p.upline_id)) problems.push(`people.csv line ${p._line} (${p.name}): is in the team of ${p.upline_id}, who is not in the file`);
  // one person above another, never in a circle: add people only after the person whose team they are in
  const ordered = [], done = new Set(), left = [...people];
  while (left.length) {
    const at = left.findIndex((p) => !p.upline_id || done.has(p.upline_id) || !ids.has(p.upline_id));
    if (at < 0) { problems.push(`people.csv: these people are in each other's teams, in a circle: ${left.map((p) => p.name).join(", ")}`); break; }
    const [p] = left.splice(at, 1); done.add(p.employee_id); ordered.push(p);
  }
  const heads = {};
  for (const p of ordered) if (p.is_coacher && p.hub) (heads[p.hub] = heads[p.hub] || []).push(p.name);
  for (const h of hubs) {
    if ((heads[h.code] || []).length > 1) problems.push(`hub ${h.code} has ${heads[h.code].length} coachers (${heads[h.code].join(", ")}); a hub has one`);
    if (!(heads[h.code] || []).length) problems.push(`hub ${h.code} (${h.name}) has no coacher. Put "yes" in the coacher column for one person of that hub`);
  }
  return { hubs, people: ordered, problems };
}

// About `perManager` sellers under every manager and promoting manager (supervisors first among them, the rest distributors), in the manager's own
// hub and in his team. Placeholder names (Issany D1, Issany S1 ...): the client renames them in the app.
function withSellers(plan, perManager = 10, supervisors = 2) {
  const sellers = [];
  for (const m of plan.people.filter((p) => p.staff_level === "manager" || p.staff_level === "promoting_manager")) {
    const nSup = Math.min(supervisors, perManager);
    for (let i = 1; i <= perManager; i++) {
      const sup = i <= nSup, k = sup ? i : i - nSup, level = sup ? "supervisor" : "distributor";
      sellers.push({ employee_id: `${m.employee_id}${sup ? "S" : "D"}${String(k).padStart(2, "0")}`, name: `${m.name} ${sup ? "S" : "D"}${k}`, staff_level: level,
        upline_id: m.employee_id, hub: m.hub, is_coacher: false, ...SELLER_PAY[level], _line: 0 });
    }
  }
  return { ...plan, people: [...plan.people, ...sellers] };
}

// One login per person. The username begins with a random 4-digit number, then the person's name, so it is easy to tell apart and not guessable
// from the name alone: 4821-issany, 7305-issany-d1. The password is the same for everyone and is meant to be changed.
function makeLogins(plan, { password = SHARED_PASSWORD, taken = [], random = (lo, hi) => crypto.randomInt(lo, hi) } = {}) {
  const used = new Set(taken.map((u) => String(u).toLowerCase())), out = [];
  const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const p of plan.people) {
    let username;
    do username = `${random(1000, 10000)}-${slug(p.name)}`.slice(0, 32).replace(/-+$/, ""); while (used.has(username.toLowerCase()));
    used.add(username.toLowerCase());
    const head = p.staff_level === "manager" || p.staff_level === "promoting_manager";
    out.push({ username, password, full_name: p.name, role: head ? "manager" : "staff", employee_id: p.employee_id, hub: p.hub,
      position: p.staff_level, team_of: p.upline_id || "" });
  }
  return out;
}
const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? "")).join(","))].join("\r\n") + "\r\n";

// Creates the logins through the real rules (a manager's login is tied to the person, and the hub's coacher gets the coacher login).
async function createLogins(d, logins, actor = { username: "golive" }) {
  for (const l of logins) {
    try { await auth.createUser(d, actor, { username: l.username, full_name: l.full_name, role: l.role, password: l.password, employee_id: l.employee_id }); }
    catch (err) { throw new Error(`login ${l.username} (${l.full_name}): ${err.message}`); }
  }
}

// Adds hubs and people through the real service, so every rule of the system applies (the ladder, the coacher tag, whose team each may be in).
async function load(d, plan, user = "golive") {
  for (const h of plan.hubs) await svc.createEntry(d, "hubs", { code: h.code, name: h.name, location: h.location, phone: h.phone, status: "active" }, user);
  for (const { _line, ...p } of plan.people) {
    try { await svc.createEntry(d, "staff", { ...p, status: "active", join_date: p.join_date || new Date().toISOString().slice(0, 10) }, user); }
    catch (err) { throw new Error(`people.csv line ${_line} (${p.name}): ${err.message}`); }
  }
}

// The rules of the system, tried on the whole list in a scratch database. Returns the problems found (none = ready).
async function check(plan, logins = []) {
  const scratch = await db.open(":memory:");
  try { await load(scratch, plan); await createLogins(scratch, logins); return []; } catch (err) { return [err.message]; }
}

const counts = async (d) => {
  const out = {};
  for (const t of ["hubs", "staff", "daily_log", "stock_issues", "sale_lines", "pay_period_summary", "loans", "cash_handovers"]) out[t] = Number((await d.get(`SELECT COUNT(*) AS n FROM ${t}`)).n);
  out.logins = Number((await d.get("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'")).n);
  return out;
};

// Clears the demo data: everything except the admin logins, Settings, the product catalogue with its stock receipts, and the audit trail.
// `keep` names the logins that survive (default: every admin). They keep their password and role; a kept login is no longer tied to a person or a hub,
// because those are cleared and rebuilt.
async function erase(d, keep = null) {
  const names = keep && keep.length ? keep.map((u) => String(u).toLowerCase()) : null;
  const admins = (await d.all("SELECT * FROM users")).filter((u) => (names ? names.includes(String(u.username).toLowerCase()) : u.role === "admin"));
  const all = (await d.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map((r) => r.table_name);
  const wipe = all.filter((t) => !KEEP.has(t));
  await d.run(`TRUNCATE ${wipe.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  for (const a of admins) { // the admin logins survive (they were truncated with the table that points at the people)
    const cols = Object.keys(a).filter((c) => a[c] !== undefined);
    await d.run(`INSERT INTO users (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => (c === "employee_id" || c === "hub" ? null : a[c])));
  }
  return wipe;
}

const savedDefaults = async (d) => { try { return JSON.parse((await db.getSettings(d)).position_defaults || "{}"); } catch { return {}; } };

async function apply(d, plan, { eraseDemo = false, keepUsers = null, logins = [] } = {}) {
  if (keepUsers && keepUsers.length) {
    const have = (await d.all("SELECT username FROM users")).map((u) => String(u.username).toLowerCase());
    const missing = keepUsers.filter((u) => !have.includes(String(u).toLowerCase()));
    if (missing.length) throw new Error(`Cannot keep the login(s) ${missing.join(", ")}: not found in the database. Nothing was changed.`);
    const clash = logins.filter((l) => keepUsers.map((u) => String(u).toLowerCase()).includes(l.username.toLowerCase()));
    if (clash.length) throw new Error(`A new login would reuse a kept name (${clash[0].username}). Nothing was changed.`);
  }
  const have = await counts(d);
  if ((have.hubs || have.staff) && !eraseDemo) throw new Error(`The database already holds ${have.hubs} hubs and ${have.staff} people (demo data?). Add --erase-demo to clear them first, or stop here.`);
  const wiped = (have.hubs || have.staff || have.daily_log) ? await erase(d, keepUsers) : [];
  await load(d, plan);
  await svc.updateSettings(d, { position_defaults: JSON.stringify({ ...(await savedDefaults(d)), ...POSITION_DEFAULTS }) }, "golive");
  await createLogins(d, logins);
  const kept = (await d.all("SELECT username, role FROM users")).filter((u) => !logins.some((l) => l.username === u.username));
  return { before: have, wiped, after: await counts(d), kept };
}

async function main() {
  const args = process.argv.slice(2), flag = (f) => args.includes(f);
  const target = args.find((a) => !a.startsWith("--")) || process.env.DATABASE_URL || undefined;
  const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  const perManager = opt("sellers") === null ? 10 : Number(opt("sellers"));
  const keepUsers = opt("keep-users") ? opt("keep-users").split(",").map((x) => x.trim()).filter(Boolean) : null;
  const base = prepare(readTable(path.join(FOLDER, "hubs.csv")), readTable(path.join(FOLDER, "people.csv")));
  const plan = perManager > 0 ? withSellers(base, perManager) : base;
  const logins = flag("--no-logins") ? [] : makeLogins(plan, { taken: keepUsers || [] });
  console.log(`Read ${plan.hubs.length} hubs and ${base.people.length} managers; ${plan.people.length - base.people.length} sellers added under them (${plan.people.length} people), ${logins.length} logins.`);
  const problems = [...plan.problems];
  if (!problems.length) problems.push(...(await check(plan, logins)));
  if (problems.length) {
    console.log("\nNOT READY. Fix these and run it again:\n" + problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  console.log("The files are valid: every row passes the system's rules.");
  const where = target ? String(target).replace(/\/\/[^@/]*@/, "//***@") : "the local database (data/pglite)";
  if (!flag("--apply")) { console.log(`\nCHECK ONLY. Nothing was changed. To load it into ${where}, run again with:  --apply --yes-i-have-a-backup  (add --erase-demo if the database holds demo data)`); return; }
  if (!flag("--yes-i-have-a-backup")) { console.log("\nStopped: add --yes-i-have-a-backup to confirm you took a backup of the database first."); process.exit(1); }
  const d = await db.open(target);
  console.log(`\nLoading into ${where} ...`);
  const r = await apply(d, plan, { eraseDemo: flag("--erase-demo"), keepUsers, logins });
  if (r.wiped.length) console.log(`Cleared: ${r.wiped.join(", ")}.\nBefore: ${JSON.stringify(r.before)}`);
  if (logins.length) {
    const file = opt("logins-file") ? path.resolve(opt("logins-file")) : path.join(FOLDER, "logins.csv");
    fs.writeFileSync(file, "\ufeff" + toCsv(logins, ["username", "password", "full_name", "position", "hub", "team_of", "employee_id", "role"]));
    console.log(`The list of sign-ins was written to ${file}. It holds passwords: keep it private and never send it by chat or e-mail.`);
  }
  console.log(`Done. Now in the database: ${JSON.stringify(r.after)}\nKept logins: ${r.kept.map((u) => `${u.username} (${u.role})`).join(", ") || "none"}\nEvery new login has the password ${SHARED_PASSWORD}. Tell the client to change them (Users page).`);
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error("\nFAILED: " + e.message); process.exit(1); });
module.exports = { parseCsv, prepare, withSellers, makeLogins, createLogins, toCsv, check, load, apply, erase, counts, KEEP, SELLER_PAY, SHARED_PASSWORD };
