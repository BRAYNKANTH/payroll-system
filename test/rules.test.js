// Rules given by the owner in November 2026: manager commission by business, fixed salaries for the manager
// positions, branch stock, and employee documents.
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

  await svc.updateSettings(d, { manager_commission_threshold: 200000, manager_commission_high: 0.25 }, "admin");
  const s2 = await db.getSettings(d);
  assert.equal(engine.managerCommissionRate(15000000, s2), 0.15);
  assert.equal(engine.managerCommissionRate(20000000, s2), 0.25);
});

test("a promoting manager works under a manager; a coacher sits above the manager", async () => {
  const d = await setup();
  const c = await add(d, "C1", "coacher");
  const m = await add(d, "M1", "manager", { upline_id: "C1" });
  const pm = await add(d, "PM1", "promoting_manager", { upline_id: "M1" });
  const s = await add(d, "S1", "supervisor", { upline_id: "PM1" });
  assert.deepEqual([c.role, m.role, pm.role, s.role], ["manager", "manager", "manager", "guy"]);
  // The promoting manager has no weekly account of their own, so the guys below them belong to the manager above.
  assert.equal(s.manager_id, "M1");
  await assert.rejects(() => add(d, "M2", "manager", { upline_id: "PM1" }), /more senior/);
  await assert.rejects(() => add(d, "PM2", "promoting_manager", { upline_id: "S1" }), /more senior/);
  // hub users still cannot add any manager position
  await assert.rejects(() => svc.createEntry(d, "staff", { employee_id: "C3", name: "C3", hub: "H1", staff_level: "coacher" }, "mgr", "H1"), /managers/);
});

test("a manager gets 20% of the whole team's sales, including the promoting manager's team; the promoting manager gets the Rs 30,000 basic", async () => {
  const d = await setup();
  await add(d, "M1", "manager", { team_commission_rate: 0.2, bank_account_no: "11112222" });
  await add(d, "PM1", "promoting_manager", { upline_id: "M1", basic_pay: 30000, bank_account_no: "12345678" });
  await add(d, "S1", "supervisor", { upline_id: "PM1" });
  await add(d, "D1", "distributor", { upline_id: "S1" });   // two levels below the promoting manager
  await add(d, "D2", "distributor", { upline_id: "M1" });   // straight under the manager
  await add(d, "M2", "manager");
  await add(d, "D3", "distributor", { upline_id: "M2" });   // another manager's team: not counted
  const day = (employee_id, business_amount) => svc.createEntry(d, "daily", { date: "2026-10-05", employee_id, business_amount, settled_amount: business_amount }, "admin");
  await day("S1", 100000); await day("D1", 50000); await day("D2", 400000); await day("D3", 900000);
  await svc.updateSettings(d, { company_return_rate: 0 }, "admin");
  // The weekly sheet still supplies costs, but its business and profit % no longer decide the manager's share.
  await svc.createEntry(d, "weekly", { week_start: "2026-10-05", week_end: "2026-10-11", manager_id: "M1", business_total: 900000, profit_percent: 0.15,
    rent: 4000, hub_fee: 500, security_cost: 1500, personal_draw: 2000 }, "admin");
  await svc.runPeriod(d, "2026-10", "admin");
  const rows = Object.fromEntries((await svc.getPeriod(d, "2026-10")).rows.map((r) => [r.employee_id, r]));
  assert.equal(rows.M1.detail.team_sales, 55000000);                 // Rs 550,000: S1 + D1 + D2
  assert.equal(rows.M1.detail.team_commission, 11000000);            // 20% = Rs 110,000, instead of 15% of the weekly Rs 900,000
  assert.ok(rows.M1.detail.earnings.some((e) => e.label.startsWith("Team commission (20% of Rs 550,000.00 sales of everyone below")));
  assert.ok(!rows.M1.detail.earnings.some((e) => /^Profit share/.test(e.label)));
  assert.equal(rows.M1.disbursed_amount, 0);                         // it goes into the running account, not the bank
  assert.equal(rows.M1.closing_balance, 11000000 - 800000);          // Rs 110,000 less Rs 8,000 of weekly costs
  // The promoting manager is paid the basic only.
  assert.equal(rows.PM1.disbursed_amount, 3000000);
  assert.equal("team_commission" in rows.PM1.detail, false);
  assert.equal(rows.PM1.closing_balance, 0);
  // A manager with no team share is unchanged.
  assert.equal("team_commission" in rows.M2.detail, false);
});

test("a manager's basic salary is paid to the bank and leaves the running balance alone", async () => {
  const d = await setup();
  await svc.updateSettings(d, { company_return_rate: 0 }, "admin");
  await add(d, "M1", "manager", { basic_pay: 27000, bank_account_no: "12345678" });
  await add(d, "M2", "manager");
  await add(d, "C1", "coacher", { basic_pay: 30000, bank_account_no: "87654321" });
  for (const id of ["M1", "M2"]) {
    await svc.createEntry(d, "weekly", { week_start: "2026-10-05", week_end: "2026-10-11", manager_id: id, business_total: 150000,
      rent: 4000, hub_fee: 500, security_cost: 1500, personal_draw: 2000 }, "admin");
  }
  await svc.runPeriod(d, "2026-10", "admin");
  const rows = Object.fromEntries((await svc.getPeriod(d, "2026-10")).rows.map((r) => [r.employee_id, r]));
  const account = 150000 * 0.2 - 4000 - 500 - 1500 - 2000; // 22,000
  assert.equal(rows.M2.closing_balance, account * 100);
  assert.equal(rows.M2.disbursed_amount, 0);
  assert.equal(rows.M1.closing_balance, account * 100, "salary does not change the account balance");
  assert.equal(rows.M1.disbursed_amount, 2700000);
  assert.equal(rows.M1.net_pay, (account + 27000) * 100);
  assert.equal(rows.M1.gross_earnings - rows.M1.total_deductions, rows.M1.net_pay);
  assert.ok(rows.M1.detail.earnings.some((e) => /Basic salary/.test(e.label) && e.amount === 2700000));
  // a coacher with no weekly sheet is simply paid the salary
  assert.equal(rows.C1.disbursed_amount, 3000000);
  assert.equal(rows.C1.closing_balance, 0);
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
