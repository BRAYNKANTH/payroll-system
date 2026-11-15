// Rules given by the owner in November 2026: the manager's weekly target and retaining month, fixed salaries and a share of
// sales for the manager positions, branch stock, and employee documents.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const svc = require("../service");
const engine = require("../engine");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  return d;
}
const add = (d, id, level, extra = {}) =>
  svc.createEntry(d, "staff", { employee_id: id, name: id, hub: "H1", staff_level: level, ...extra }, "admin");

test("manager commission: 20% from Rs 100,000 of weekly business, 15% below it", async () => {
  const d = await setup();
  const s = await db.getSettings(d);
  assert.equal(engine.managerCommissionRate(10000000, s), 0.2);
  assert.equal(engine.managerCommissionRate(9999900, s), 0.15);

  await add(d, "M1", "manager");
  const week = (start, business, extra = {}) => svc.createEntry(d, "weekly",
    { week_start: start, week_end: start, manager_id: "M1", business_total: business, ...extra }, "admin");
  assert.equal((await week("2026-10-05", 125090)).profit_percent, 0.2);
  assert.equal((await week("2026-10-12", 44480)).profit_percent, 0.15);
  assert.equal((await week("2026-10-19", 150000, { profit_percent: 0.1 })).profit_percent, 0.1, "a typed rate is kept");

  const bulk = await svc.bulkUpsert(d, "weekly", [{ week_start: "2026-10-26", week_end: "2026-10-26", manager_id: "M1", business_total: 100000 }], "admin");
  assert.equal(bulk.created, 1);
  assert.equal((await svc.listEntries(d, "weekly", { period: "2026-10" })).find((w) => w.week_start === "2026-10-26").profit_percent, 0.2);

  // a manager's own weekly target decides his rate; the Settings figure is only the fallback
  await add(d, "M9", "manager", { target: 150000 });
  const mine = (business_total) => svc.createEntry(d, "weekly", { week_start: "2026-11-02", week_end: "2026-11-08", manager_id: "M9", business_total }, "admin");
  assert.equal((await mine(120000)).profit_percent, 0.15, "Rs 120,000 is below his Rs 150,000 target");

  await svc.updateSettings(d, { manager_commission_threshold: 200000, manager_commission_high: 0.25 }, "admin");
  const s2 = await db.getSettings(d);
  assert.equal(engine.managerCommissionRate(15000000, s2), 0.15);
  assert.equal(engine.managerCommissionRate(20000000, s2), 0.25);
});

test("the chain runs coacher > promoting manager > manager > sellers", async () => {
  const d = await setup();
  const c = await add(d, "C1", "coacher");
  const pm = await add(d, "PM1", "promoting_manager", { upline_id: "C1" });
  const m = await add(d, "M1", "manager", { upline_id: "PM1" });
  const s = await add(d, "S1", "supervisor", { upline_id: "M1" });
  assert.deepEqual([c.role, pm.role, m.role, s.role], ["manager", "manager", "manager", "guy"]);
  assert.equal(s.manager_id, "M1");
  await assert.rejects(() => add(d, "PM2", "promoting_manager", { upline_id: "M1" }), /more senior/);
  await assert.rejects(() => add(d, "C2", "coacher", { upline_id: "PM1" }), /more senior/);
  await assert.rejects(() => add(d, "M2", "manager", { upline_id: "S1" }), /more senior/);
  // hub users still cannot add any manager position
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "C3", name: "C3", hub: "H1", staff_level: "coacher" }, "mgr", "H1"), /managers/);
});

test("a month of pay: manager shares, a retaining manager, and the promoting manager and coacher", async () => {
  const d = await setup();
  await svc.updateSettings(d, { company_return_rate: 0 }, "admin");
  const seller = { pay_scheme: "tiered", target: 100000, basic_pay: 25000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, food_min_days: 0, security_deduction_rule: "none" };
  await add(d, "C1", "coacher", { basic_pay: 30000, bank_account_no: "10000001" });
  await add(d, "PM1", "promoting_manager", { upline_id: "C1", basic_pay: 29000, bank_account_no: "10000002" });
  await add(d, "M1", "manager", { upline_id: "PM1", basic_pay: 27000, target: 100000, bank_account_no: "10000003" });
  await add(d, "M2", "manager", { upline_id: "PM1", basic_pay: 27000, target: 100000, bank_account_no: "10000004" });
  await add(d, "D1", "distributor", { upline_id: "M1", ...seller });
  await add(d, "D2", "distributor", { upline_id: "M1", ...seller });
  await add(d, "D3", "distributor", { upline_id: "M2", ...seller });
  const day = (employee_id, business_amount) => svc.createEntry(d, "daily", { date: "2026-10-05", employee_id, business_amount, settled_amount: business_amount }, "admin");
  await day("M1", 60000); await day("D1", 130000); await day("D2", 80000);   // M1's month: Rs 270,000 with his team
  await day("M2", 40000); await day("D3", 100000);                            // M2's month: Rs 140,000, below Rs 250,000
  await svc.createEntry(d, "weekly", { week_start: "2026-10-05", week_end: "2026-10-11", manager_id: "M1", business_total: 270000,
    rent: 4000, hub_fee: 500, security_cost: 2700, personal_draw: 0 }, "admin");   // profit % comes from his Rs 100,000 weekly target: 20%
  await svc.runPeriod(d, "2026-10", "admin");
  const r = Object.fromEntries((await svc.getPeriod(d, "2026-10")).rows.map((x) => [x.employee_id, x]));

  // M1: weekly 20% of 270,000, own sales at 25%, basic 27,000, less costs and what his sellers earn above the company's 25% (extra 1,500 + food 150 + 150)
  assert.equal(r.M1.detail.retaining, false);
  assert.equal(r.M1.detail.month_sales, 27000000);
  assert.equal(r.M1.gross_earnings, (54000 + 15000 + 27000) * 100);
  assert.equal(r.M1.total_deductions, (4000 + 500 + 2700 + 1500 + 150 + 150) * 100);
  assert.equal(r.M1.net_pay, 87000 * 100);
  assert.equal(r.M1.disbursed_amount, 27000 * 100);
  assert.equal(r.M1.closing_balance, 60000 * 100);
  assert.deepEqual(r.M1.detail.team.map((t) => [t.employee_id, t.over_target, t.food]), [["D1", 150000, 15000], ["D2", 0, 15000]]);
  // the sellers' own pay is not charged to him: D1 keeps 25,000 + 30% of 30,000 over target (+ food)
  assert.equal(r.D1.gross_earnings, (25000 + 9000 + 150) * 100);

  // M2: Rs 140,000 is below Rs 250,000, so he is retaining: 10% of it instead of any weekly commission, plus own sales and the basic
  assert.equal(r.M2.detail.retaining, true);
  assert.equal(r.M2.gross_earnings, (14000 + 10000 + 27000) * 100);
  assert.equal(r.M2.net_pay, (14000 + 10000 + 27000 - 150) * 100);
  assert.ok(r.M2.detail.earnings[0].label.startsWith("Retaining commission"));

  // PM1 and C1: basic salary plus 0.55% of everyone below (the managers' own sales included), paid to the bank
  assert.equal(r.PM1.detail.below_sales, 41000000);
  assert.equal(r.PM1.gross_earnings, 2900000 + 225500);
  assert.equal(r.PM1.disbursed_amount, 2900000 + 225500);
  assert.equal(r.C1.gross_earnings, 3000000 + 225500);
  assert.equal(r.C1.closing_balance, 0);
});

test("a manager sells like anyone else: he has a daily sheet; a coacher does not", async () => {
  const d = await setup();
  await add(d, "C1", "coacher");
  await add(d, "M1", "manager");
  await add(d, "D1", "distributor", { upline_id: "M1" });
  const day = (employee_id) => svc.createEntry(d, "daily", { date: "2026-10-05", employee_id, business_amount: 1000, settled_amount: 1000 }, "admin");
  await day("M1"); await day("D1");
  await assert.rejects(() => day("C1"), /does not sell/);
  assert.equal((await svc.bulkUpsert(d, "daily", [{ date: "2026-10-06", employee_id: "M1", business_amount: 500, settled_amount: 500 }], "admin")).created, 1);
});

test("a manager's basic salary is paid to the bank and leaves the running balance alone", async () => {
  const d = await setup();
  await svc.updateSettings(d, { company_return_rate: 0 }, "admin");
  await add(d, "M1", "manager", { basic_pay: 27000, bank_account_no: "12345678" });
  await add(d, "M2", "manager");
  for (const id of ["M1", "M2"]) {
    await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: id, business_amount: 300000, settled_amount: 300000 }, "admin"); // above Rs 250,000: not retaining
    await svc.createEntry(d, "weekly", { week_start: "2026-10-05", week_end: "2026-10-11", manager_id: id, business_total: 150000,
      rent: 4000, hub_fee: 500, security_cost: 1500, personal_draw: 2000 }, "admin");
  }
  await svc.runPeriod(d, "2026-10", "admin");
  const rows = Object.fromEntries((await svc.getPeriod(d, "2026-10")).rows.map((r) => [r.employee_id, r]));
  const account = 150000 * 0.2 + 300000 * 0.25 - 4000 - 500 - 1500 - 2000; // weekly commission + own sales − costs = 97,000
  assert.equal(rows.M2.closing_balance, account * 100);
  assert.equal(rows.M2.disbursed_amount, 0);
  assert.equal(rows.M1.closing_balance, account * 100, "salary does not change the account balance");
  assert.equal(rows.M1.disbursed_amount, 2700000);
  assert.equal(rows.M1.net_pay, (account + 27000) * 100);
  assert.equal(rows.M1.gross_earnings - rows.M1.total_deductions, rows.M1.net_pay);
  assert.ok(rows.M1.detail.earnings.some((e) => /Basic salary/.test(e.label) && e.amount === 2700000));
});

test("manager positions take a basic salary default; unknown positions are refused", async () => {
  const d = await setup();
  const s = await svc.updateSettings(d, { position_defaults: JSON.stringify({ manager: { basic_pay: 27000 }, coacher: { basic_pay: 30000 } }) }, "admin");
  assert.equal(JSON.parse(s.position_defaults).coacher.basic_pay, 30000);
  await assert.rejects(() => svc.updateSettings(d, { position_defaults: JSON.stringify({ boss: {} }) }, "admin"), /No pay defaults/);
});

test("branch stock: difference and value are worked out, and a hub user stays in their hub", async () => {
  const d = await setup();
  const line = { period: "2026-10", hub: "H1", product: "Perfume A", opening_stock: 100, received: 50, issued: 120, counted_stock: 27, unit_price: 1500 };
  const res = await svc.bulkUpsert(d, "hubstock", [line, { ...line, hub: "H2", product: "Perfume B", counted_stock: 30 }], "admin");
  assert.equal(res.created, 2);
  const h1 = (await svc.listEntries(d, "hubstock", { period: "2026-10", hub: "H1" }));
  assert.equal(h1.length, 1);
  assert.equal(h1[0].shortfall_qty, 3);          // 100 + 50 − 120 − 27
  assert.equal(h1[0].shortfall_value, 450000);   // 3 × Rs 1,500
  assert.equal(h1[0].stock_value, 4050000);      // 27 × Rs 1,500
  // same natural key updates instead of duplicating
  assert.equal((await svc.bulkUpsert(d, "hubstock", [{ ...line, counted_stock: 30 }], "admin")).updated, 1);
  await assert.rejects(() => svc.bulkUpsert(d, "hubstock", [{ ...line, hub: "H2", product: "X" }], "clerk1", "H1"), /hub H1/);
  await assert.rejects(() => svc.createEntry(d, "hubstock", { ...line, hub: "H2", product: "Y" }, "clerk1", "H1"), /hub H1/);
  await assert.rejects(() => svc.createEntry(d, "hubstock", { ...line, hub: "NOPE", product: "Z" }, "admin"), /Unknown/);
});

test("employee documents: upload, list, read, delete, with type, size and hub checks", async () => {
  const d = await setup();
  await add(d, "D1", "distributor");
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const doc = await svc.addDocument(d, "D1", { doc_type: "nic", file_name: "nic front.png", mime: "image/png", data: "data:image/png;base64," + png }, "admin");
  assert.equal(doc.size_bytes, 8);
  assert.equal(doc.data, undefined, "the list never carries the file itself");
  assert.equal((await svc.listDocuments(d, "D1")).length, 1);
  assert.deepEqual([...(await svc.getDocument(d, doc.id)).buffer], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(() => svc.addDocument(d, "D1", { doc_type: "passport", file_name: "a.png", mime: "image/png", data: png }, "admin"), /doc_type/);
  await assert.rejects(() => svc.addDocument(d, "D1", { doc_type: "nic", file_name: "a.exe", mime: "application/x-msdownload", data: png }, "admin"), /JPG, PNG/);
  const big = Buffer.alloc(3_000_001).toString("base64");
  await assert.rejects(() => svc.addDocument(d, "D1", { doc_type: "nic", file_name: "big.png", mime: "image/png", data: big }, "admin"), /3 MB/);
  await assert.rejects(() => svc.addDocument(d, "NOBODY", { doc_type: "nic", file_name: "a.png", mime: "image/png", data: png }, "admin"), /not found/);
  // a user of another hub can neither see nor remove it
  await assert.rejects(() => svc.listDocuments(d, "D1", "H2"), /Outside your hub/);
  await assert.rejects(() => svc.getDocument(d, doc.id, "H2"), /Outside your hub/);
  await assert.rejects(() => svc.deleteDocument(d, doc.id, "mgr2", "H2"), /Outside your hub/);

  await svc.deleteDocument(d, doc.id, "admin");
  assert.equal((await svc.listDocuments(d, "D1")).length, 0);
  const log = await svc.auditSearch(d, { table: "staff_documents" });
  assert.deepEqual(log.map((l) => l.action).sort(), ["delete", "upload"]);
});
