const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../engine");

const settings = { net_pay_change_threshold: "0.20", stock_shortfall_threshold: "500000" };
const guy = {
  employee_id: "G1", role: "guy", basic_pay: 3000000, target: 50000000, commission_rate: 0.02,
  security_deduction_rule: "fixed:1000", bank_account_no: "1234567890", bank_account_verified: "1234567890",
};
const day = (date, business, settled, personal = 0) =>
  ({ date, business_amount: business, settled_amount: settled, settle_up_minus: business - settled, personal_minus: personal });

test("guy: commission only on business over target", () => {
  const r = engine.computeGuy({
    staff: guy,
    daily: [day("2026-09-01", 30000000, 30000000), day("2026-09-02", 30000000, 29950000, 100000)],
    stock: [{ product: "Oil", shortfall_qty: 2, unit_price: 150000, shortfall_value: 300000 }],
    allowances: [{ description: "Transport", amount: 200000 }],
    openingBalance: 0, securityHeldToDate: 0,
  });
  // business 600,000 − target 500,000 = 100,000 × 2% = 2,000
  assert.equal(r.detail.over_target_amount, 10000000);
  assert.equal(r.gross_earnings, 3000000 + 200000 + 200000);           // basic + commission + allowance
  assert.equal(r.total_deductions, 50000 + 300000 + 100000 + 100000);  // settle-up + stock + personal + security
  assert.equal(r.net_pay, 3400000 - 550000);
  assert.equal(r.disbursed_amount, r.net_pay);
  assert.equal(r.closing_balance, 0);
});

test("guy: below target earns no commission; negative result carries forward", () => {
  const r = engine.computeGuy({
    staff: { ...guy, basic_pay: 100000 },
    daily: [day("2026-09-01", 1000000, 0)],
    stock: [], allowances: [], openingBalance: -50000, securityHeldToDate: 0,
  });
  assert.equal(r.detail.over_target_amount, 0);
  assert.equal(r.net_pay, 100000 - 1000000 - 100000);
  assert.equal(r.disbursed_amount, 0);
  assert.equal(r.closing_balance, -50000 + r.net_pay);
});

test("guy: positive net pay first clears debt carried in", () => {
  const r = engine.computeGuy({ staff: { ...guy, security_deduction_rule: "none" }, daily: [], stock: [], allowances: [], openingBalance: -1000000, securityHeldToDate: 0 });
  assert.equal(r.net_pay, 3000000);
  assert.equal(r.disbursed_amount, 2000000);
  assert.equal(r.closing_balance, 0);
});

test("security rules", () => {
  assert.equal(engine.securityDeduction("none", { gross: 1e6, basic: 1e6, heldToDate: 0 }), 0);
  assert.equal(engine.securityDeduction("fixed:1500", { gross: 0, basic: 0, heldToDate: 0 }), 150000);
  assert.equal(engine.securityDeduction("pct_gross:5", { gross: 1000000, basic: 0, heldToDate: 0 }), 50000);
  assert.equal(engine.securityDeduction("pct_basic:10;cap:2000", { gross: 0, basic: 1000000, heldToDate: 150000 }), 50000);
  assert.equal(engine.securityDeduction("pct_basic:10;cap:2000", { gross: 0, basic: 1000000, heldToDate: 200000 }), 0);
  assert.throws(() => engine.parseSecurityRule("10%"), /Invalid/);
});

test("manager: closing = opening + Σweekly − company return − guys' salaries", () => {
  const w = (start, business) => ({ week_start: start, week_end: start, business_total: business, profit_percent: 0.3,
    rent: 1000000, hub_fee: 200000, security_cost: 100000, personal_draw: 500000 });
  const r = engine.computeManager({
    staff: { employee_id: "M1" },
    weekly: [w("2026-09-01", 20000000), w("2026-09-08", 20000000), w("2026-09-15", 20000000), w("2026-09-22", 20000000), w("2026-09-29", 20000000)],
    guyNetPays: [{ employee_id: "G1", net_pay: 3000000 }, { employee_id: "G2", net_pay: 2500000 }],
    openingBalance: 1000000, companyReturnRate: 0.15,
  });
  const weekly = 20000000 * 0.3 - 1800000;              // 4,200,000 per week
  assert.equal(r.detail.total_business, 100000000);
  assert.equal(r.net_pay, 5 * weekly - 15000000 - 5500000);
  assert.equal(r.closing_balance, 1000000 + r.net_pay);
  assert.equal(r.gross_earnings - r.total_deductions, r.net_pay);
  assert.equal(r.disbursed_amount, 0);
});

test("flags: net pay change over 20%", () => {
  const r = engine.computeGuy({ staff: guy, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  const codes = (prev) => engine.evaluateFlags(r, { staff: guy, previous: prev, settings }).map((f) => f.code);
  assert.deepEqual(codes(null), []);
  assert.deepEqual(codes({ net_pay: r.net_pay * 1.1 }), []);
  assert.deepEqual(codes({ net_pay: r.net_pay * 2 }), ["NET_PAY_CHANGE"]);
  assert.deepEqual(codes({ net_pay: 0 }), ["NET_PAY_CHANGE"]);
});

test("flags: negative deduction, deductions exceed gross, stock threshold", () => {
  const r = engine.computeGuy({
    staff: { ...guy, basic_pay: 100000 },
    daily: [day("2026-09-01", 100000, 150000), day("2026-09-02", 2000000, 0)],
    stock: [{ product: "Tyre", shortfall_qty: 1, unit_price: 600000, shortfall_value: 600000 }],
    allowances: [], openingBalance: 0, securityHeldToDate: 0,
  });
  const codes = engine.evaluateFlags(r, { staff: guy, previous: null, settings }).map((f) => f.code);
  assert.ok(codes.includes("NEGATIVE_DEDUCTION"), "over-settled day");
  assert.ok(codes.includes("DEDUCTIONS_EXCEED_GROSS"));
  assert.ok(codes.includes("STOCK_SHORTFALL"));
});

test("flags: bank account differs from verified only when paying", () => {
  const r = engine.computeGuy({ staff: guy, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  const changed = { ...guy, bank_account_no: "9999999999" };
  assert.deepEqual(engine.evaluateFlags(r, { staff: changed, previous: null, settings }).map((f) => f.code), ["BANK_ACCOUNT_CHANGED"]);
  assert.deepEqual(engine.evaluateFlags(r, { staff: { ...guy, bank_account_no: null }, previous: null, settings }).map((f) => f.code), ["BANK_ACCOUNT_MISSING"]);
  const unpaid = { ...r, disbursed_amount: 0 };
  assert.deepEqual(engine.evaluateFlags(unpaid, { staff: changed, previous: null, settings }), []);
});

test("flags: manager balance going further negative", () => {
  const base = { role: "manager", detail: { deductions: [] }, disbursed_amount: 0 };
  const flags = (o, c) => engine.evaluateFlags({ ...base, opening_balance: o, closing_balance: c }, { staff: {}, previous: null, settings }).map((f) => f.code);
  assert.deepEqual(flags(-100, -200), ["MANAGER_BALANCE_DEEPER_NEGATIVE"]);
  assert.deepEqual(flags(100, -50), ["MANAGER_BALANCE_DEEPER_NEGATIVE"]);
  assert.deepEqual(flags(-200, -100), []);
  assert.deepEqual(flags(100, 50), []);
});
