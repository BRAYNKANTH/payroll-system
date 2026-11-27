// Loads the real sellers and products that were read from the branch Excel sheets.
//   node tools/load-real-sellers.js <folder or database address>                          CHECK ONLY (reads the database, changes nothing)
//   node tools/load-real-sellers.js <folder or database address> --apply --yes-i-have-a-backup [--cost-share=0.4] [--all-products]
//   With no address it uses DATABASE_URL (run it with: node --env-file=.env tools/load-real-sellers.js ...).
// Files (in golive/): sellers-from-excel.csv and products-from-excel.csv.
//   - For every manager that has real sellers in the file, the placeholder sellers the go-live tool made for that manager ('Issany D1', 'Issany S1' ...)
//     are removed (only when they have no records yet), and the real sellers are added under that manager, in the manager's hub.
//     Managers that are not in the file keep their placeholders.
//   - Products are added with their selling price. The Excel has no purchase price, so one is worked out as a share of the selling price
//     (--cost-share, default 0.4) until the owner gives the real figures: change them on the Products page. Products that already exist are left alone.
//   - It does not create sign-ins. The Users page has "Create logins for employees".
const fs = require("fs");
const path = require("path");
const db = require("../db");
const svc = require("../service");
const products = require("../products");

const FOLDER = path.join(__dirname, "..", "golive");
const args = process.argv.slice(2), flag = (f) => args.includes(f);
const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const target = args.find((a) => !a.startsWith("--")) || process.env.DATABASE_URL;

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}

(async () => {
  if (!target) { console.log("Give a data folder (for example data/real-preview) or a database address, or set DATABASE_URL."); process.exit(1); }
  const sellers = readCsv(path.join(FOLDER, "sellers-from-excel.csv"));
  const prods = readCsv(path.join(FOLDER, "products-from-excel.csv"));
  const costShare = Number(opt("cost-share") ?? 0.4);
  const d = await db.open(target);
  const problems = [];
  const hubs = new Set((await d.all("SELECT code FROM hubs")).map((h) => h.code));
  const heads = new Map((await d.all("SELECT * FROM staff WHERE staff_level IN ('manager','promoting_manager')")).map((m) => [m.employee_id, m]));
  const ids = new Set((await d.all("SELECT employee_id FROM staff")).map((s) => s.employee_id));
  const seen = new Set();
  for (const s of sellers) {
    if (!heads.has(s.team_of)) problems.push(`${s.name}: the manager ${s.team_of} is not in the database`);
    else if (heads.get(s.team_of).hub !== s.hub) problems.push(`${s.name}: the hub is ${s.hub} but ${s.team_of} is in ${heads.get(s.team_of).hub}`);
    if (!hubs.has(s.hub)) problems.push(`${s.name}: unknown hub ${s.hub}`);
    if (seen.has(s.employee_id)) problems.push(`${s.name}: the id ${s.employee_id} is used twice`);
    seen.add(s.employee_id);
    if (!["supervisor", "distributor"].includes(s.position)) problems.push(`${s.name}: position must be supervisor or distributor`);
  }
  const teams = [...new Set(sellers.map((s) => s.team_of))];
  // placeholders that may go: sellers under these managers named like 'Name D3' / 'Name S1' with no records at all
  const placeholders = [];
  for (const m of teams) {
    const rows = await d.all(`SELECT s.employee_id, s.name FROM staff s WHERE s.upline_id = ? AND s.name ~ ' [DS][0-9]+$'
      AND NOT EXISTS (SELECT 1 FROM daily_log x WHERE x.employee_id = s.employee_id) AND NOT EXISTS (SELECT 1 FROM sale_lines x WHERE x.employee_id = s.employee_id)
      AND NOT EXISTS (SELECT 1 FROM stock_issues x WHERE x.employee_id = s.employee_id) AND NOT EXISTS (SELECT 1 FROM stock_recon x WHERE x.employee_id = s.employee_id)`, m);
    placeholders.push(...rows);
  }
  const keep = new Set(placeholders.map((p) => p.employee_id));
  for (const s of sellers) if (ids.has(s.employee_id) && !keep.has(s.employee_id)) problems.push(`${s.name}: the id ${s.employee_id} already belongs to someone with records`);
  const have = new Set((await d.all("SELECT lower(name) AS n FROM products")).map((p) => p.n));
  const wantProducts = prods.filter((p) => flag("--all-products") || p.confidence === "high");
  const newProducts = wantProducts.filter((p) => !have.has(p.name.toLowerCase()));

  console.log(`Sellers in the file: ${sellers.length} (supervisors ${sellers.filter((s) => s.position === "supervisor").length}, distributors ${sellers.filter((s) => s.position === "distributor").length}) under ${teams.length} managers: ${teams.join(", ")}`);
  console.log(`Placeholders that would be removed (no records yet): ${placeholders.length}`);
  console.log(`Products in the file: ${prods.length}; to add: ${newProducts.length}${flag("--all-products") ? "" : " (only the high-confidence ones; add --all-products for all)"}; already there: ${wantProducts.length - newProducts.length}`);
  if (problems.length) { console.log("\nNOT READY:\n" + problems.map((p) => "  - " + p).join("\n")); await d.close(); process.exit(1); }
  if (!flag("--apply")) { console.log("\nCHECK ONLY. Nothing was changed. Run again with --apply --yes-i-have-a-backup to load it."); await d.close(); return; }
  if (!flag("--yes-i-have-a-backup")) { console.log("\nStopped: add --yes-i-have-a-backup to confirm you took a backup first."); await d.close(); process.exit(1); }

  // the pay set-up of each position, copied from a placeholder or any existing seller of that level (the form takes rupees; the table holds cents)
  const template = {};
  for (const level of ["supervisor", "distributor"]) {
    const t = await d.get("SELECT * FROM staff WHERE staff_level = ? ORDER BY employee_id LIMIT 1", level);
    if (!t) throw new Error(`There is no ${level} in the database to copy the pay set-up from.`);
    template[level] = { pay_scheme: t.pay_scheme, target: t.target / 100, basic_pay: t.basic_pay / 100, commission_rate: Number(t.commission_rate), base_commission_rate: Number(t.base_commission_rate),
      food_per_day: t.food_per_day / 100, food_min_days: t.food_min_days, security_deduction_rule: t.security_deduction_rule };
  }
  for (const p of placeholders) {
    await d.run("DELETE FROM users WHERE employee_id = ?", p.employee_id);
    await d.run("DELETE FROM staff WHERE employee_id = ?", p.employee_id);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const s of sellers) {
    await svc.createEntry(d, "staff", { employee_id: s.employee_id, name: s.name, hub: s.hub, staff_level: s.position, upline_id: s.team_of, status: "active", join_date: today, ...template[s.position] }, "realload");
  }
  for (const p of newProducts) {
    const price = Number(p.list_price);
    await products.create(d, { name: p.name, list_price: price, cost_price: Math.round(price * costShare) }, "realload");
  }
  const n = async (sql) => Number((await d.get(sql)).n);
  console.log(`\nDone. Staff: ${await n("SELECT COUNT(*) AS n FROM staff")} (removed ${placeholders.length} placeholders, added ${sellers.length} real sellers). Products: ${await n("SELECT COUNT(*) AS n FROM products")}.`);
  console.log(`Purchase prices were set to ${Math.round(costShare * 100)}% of the selling price: replace them with the real ones on the Products page.`);
  await d.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
