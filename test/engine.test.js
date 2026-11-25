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

// Tiered scheme, figures taken from the business's own Excel payslips (Rs → cents ×100).
const supervisor = {
  ...guy, pay_scheme: "tiered", basic_pay: 3000000, target: 12000000, commission_rate: 0.3,
  base_commission_rate: 0.25, food_per_day: 15000, food_min_days: 24, security_deduction_rule: "pct_business:1",
};
const distributor = { ...supervisor, basic_pay: 2500000, target: 10000000, food_min_days: 0 };
// `days` entries totalling `business`, with `minus` of settle-up shortfall on the first day.
const month = (days, business, minus) => Array.from({ length: days }, (_, i) =>
  day(`2026-09-${String(i + 1).padStart(2, "0")}`, i === 0 ? business - (days - 1) * Math.floor(business / days) : Math.floor(business / days),
    i === 0 ? business - (days - 1) * Math.floor(business / days) - minus : Math.floor(business / days)));
const calc = (staff, daily) => engine.computeGuy({ staff, daily, stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });

test("tiered: supervisor over target gets fixed basic + 30% over target, no food under 24 days", () => {
  const r = calc(supervisor, month(21, 18069000, 1969000));
  assert.equal(r.gross_earnings, 3000000 + 1820700);        // 30,000 + 30% × 60,690
  assert.equal(r.detail.food_allowance, 0);                  // 21 days < 24
  assert.equal(r.detail.security_deducted, 180690);          // 1% of business
  assert.equal(r.net_pay, 2671010);                          // Rs 26,710.10 as in the sheet
});

test("tiered: supervisor with 24+ days gets food for every day", () => {
  const r = calc(supervisor, month(29, 16641000, 2570000));
  assert.equal(r.detail.food_allowance, 29 * 15000);         // Rs 4,350
  assert.equal(r.net_pay, 2090890);                          // Rs 20,908.90 as in the sheet
});

test("tiered: distributor under target earns 25% commission on all business plus food", () => {
  const r = calc(distributor, month(8, 3930000, 655000));
  assert.equal(r.detail.target_met, false);
  assert.equal(r.gross_earnings, 982500 + 8 * 15000);        // 9,825 + 1,200
  assert.equal(r.net_pay, 408200);                           // Rs 4,082 as in the sheet
});

test("tiered: business exactly on target is not 'over' target", () => {
  const r = calc(distributor, month(10, 10000000, 0));
  assert.equal(r.detail.target_met, false);
  assert.equal(r.detail.over_target_amount, 0);
  assert.equal(r.gross_earnings, 2500000 + 10 * 15000);      // 25% × 100,000 + food, no fixed basic
});

test("security rules", () => {
  assert.equal(engine.securityDeduction("pct_business:1", { gross: 0, basic: 0, business: 18069000, heldToDate: 0 }), 180690);
  assert.equal(engine.securityDeduction("none", { gross: 1e6, basic: 1e6, heldToDate: 0 }), 0);
  assert.equal(engine.securityDeduction("fixed:1500", { gross: 0, basic: 0, heldToDate: 0 }), 150000);
  assert.equal(engine.securityDeduction("pct_gross:5", { gross: 1000000, basic: 0, heldToDate: 0 }), 50000);
  assert.equal(engine.securityDeduction("pct_basic:10;cap:2000", { gross: 0, basic: 1000000, heldToDate: 150000 }), 50000);
  assert.equal(engine.securityDeduction("pct_basic:10;cap:2000", { gross: 0, basic: 1000000, heldToDate: 200000 }), 0);
  assert.throws(() => engine.parseSecurityRule("10%"), /Invalid/);
});

const week = (start, business) => ({ week_start: start, week_end: start, business_total: business, profit_percent: 0.2,
  rent: 400000, hub_fee: 50000, security_cost: 100000, personal_draw: 200000 });
const mgr = { employee_id: "M1", basic_pay: 2700000 };
const rules = { ownRate: 0.25, retainThreshold: 25000000, retainRate: 0.1 };

test("manager: weekly commission + own sales + basic salary, minus costs and the team's extras", () => {
  const r = engine.computeManager({
    staff: mgr, weekly: [week("2026-10-05", 10500000), week("2026-10-12", 10500000)],
    team: [{ employee_id: "G1", name: "G1", over_target: 150000, food: 390000 }, { employee_id: "G2", name: "G2", over_target: 0, food: 390000 }],
    openingBalance: 1000000, companyReturnRate: 0, teamSales: 30000000, ownSales: 6000000, rules,
  });
  assert.equal(r.detail.retaining, false);                 // Rs 360,000 of sales is above Rs 250,000
  assert.equal(r.gross_earnings, 4200000 + 1500000 + 2700000); // weekly 20% + 25% of own sales + basic
  assert.equal(r.total_deductions, 800000 + 100000 + 200000 + 400000 + 150000 + 780000);
  assert.equal(r.net_pay, 5970000);
  assert.equal(r.gross_earnings - r.total_deductions, r.net_pay);
  assert.equal(r.disbursed_amount, 1000000 + 5970000);     // a manager is paid to the bank like everyone else: no running account
  assert.equal(r.closing_balance, 0);
});

test("manager: below Rs 250,000 of sales he is retaining: basic + 10% of those sales, instead of the weekly commission", () => {
  const r = engine.computeManager({
    staff: mgr, weekly: [week("2026-10-05", 10500000), week("2026-10-12", 10500000)], team: [],
    openingBalance: 0, companyReturnRate: 0, teamSales: 10000000, ownSales: 2000000, rules,
  });
  assert.equal(r.detail.retaining, true);
  assert.equal(r.gross_earnings, 1200000 + 500000 + 2700000); // 10% of Rs 120,000, own sales 25%, basic
  assert.ok(r.detail.earnings[0].label.startsWith("Retaining commission"));
  // exactly on the limit is not retaining
  const edge = engine.computeManager({ staff: mgr, weekly: [], team: [], openingBalance: 0, companyReturnRate: 0, teamSales: 25000000, ownSales: 0, rules });
  assert.equal(edge.detail.retaining, false);
});

test("promoting manager and coacher: basic salary plus a share of the sales below, all paid to the bank", () => {
  const r = engine.computeSenior({ staff: { basic_pay: 2900000 }, belowSales: 100000000, rate: 0.0055, openingBalance: 0 });
  assert.equal(r.gross_earnings, 2900000 + 550000);        // Rs 29,000 + 0.55% of Rs 1,000,000
  assert.equal(r.net_pay, 3450000);
  assert.equal(r.disbursed_amount, 3450000);
  assert.equal(r.closing_balance, 0);
  assert.equal(r.total_deductions, 0);
});

test("a weekly target decides the manager's rate: his own target first, the Settings figure as the fallback", () => {
  const s = { manager_commission_threshold: "10000000", manager_commission_high: "0.20", manager_commission_low: "0.15" };
  assert.equal(engine.managerCommissionRate(10000000, s), 0.2);
  assert.equal(engine.managerCommissionRate(9999900, s), 0.15);
  assert.equal(engine.managerCommissionRate(12000000, s, 15000000), 0.15, "a higher personal target is not reached");
  assert.equal(engine.managerCommissionRate(12000000, s, 8000000), 0.2);
  assert.equal(engine.managerCommissionRate(10000000, s, 0), 0.2, "no personal target falls back to Settings");
});

test("a seller's extra on sales over target and food are what his manager pays; the base 25% is the company's", () => {
  const staff = { pay_scheme: "tiered", target: 10000000, basic_pay: 2500000, commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 15000, food_min_days: 0, security_deduction_rule: "none" };
  const day = (business) => ({ date: "2026-10-01", business_amount: business, settled_amount: business, settle_up_minus: 0, personal_minus: 0 });
  const over = engine.computeGuy({ staff, daily: [day(13000000)], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  assert.deepEqual(over.detail.manager_extra, { over_target: 900000 - 750000, food: 15000 }); // 30% − 25% of Rs 30,000, and one day's food
  const under = engine.computeGuy({ staff, daily: [day(8000000)], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  assert.deepEqual(under.detail.manager_extra, { over_target: 0, food: 15000 });
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

test("flags: bank details are kept for information only, so they never raise a flag", () => {
  const r = engine.computeGuy({ staff: guy, daily: [], stock: [], allowances: [], openingBalance: 0, securityHeldToDate: 0 });
  const changed = { ...guy, bank_account_no: "9999999999" };
  assert.deepEqual(engine.evaluateFlags(r, { staff: changed, previous: null, settings }), []);
  assert.deepEqual(engine.evaluateFlags(r, { staff: { ...guy, bank_account_no: null }, previous: null, settings }), []);
});

test("flags: manager balance going further negative", () => {
  const base = { role: "manager", detail: { deductions: [] }, disbursed_amount: 0 };
  const flags = (o, c) => engine.evaluateFlags({ ...base, opening_balance: o, closing_balance: c }, { staff: {}, previous: null, settings }).map((f) => f.code);
  assert.deepEqual(flags(-100, -200), ["MANAGER_BALANCE_DEEPER_NEGATIVE"]);
  assert.deepEqual(flags(100, -50), ["MANAGER_BALANCE_DEEPER_NEGATIVE"]);
  assert.deepEqual(flags(-200, -100), []);
  assert.deepEqual(flags(100, 50), []);
});
