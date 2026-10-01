// Pure payroll calculations. No DB access here, so every rule is unit-testable.
// All money values are integer cents.

const sum = (rows, f) => rows.reduce((t, r) => t + (typeof f === "function" ? f(r) : r[f]), 0);
const pct = (amount, rate) => Math.round(amount * rate);

// security_deduction_rule grammar:  none | fixed:<Rs> | pct_gross:<n> | pct_basic:<n>   [;cap:<Rs>]
//   fixed:1500             Rs 1,500 every period
//   pct_gross:5            5% of gross earnings
//   pct_basic:5;cap:25000  5% of basic pay until Rs 25,000 has been held in total
function parseSecurityRule(rule) {
  const text = String(rule || "none").trim().toLowerCase();
  if (text === "none" || text === "") return { kind: "none", value: 0, cap: null };
  const [main, ...opts] = text.split(";").map((s) => s.trim());
  const m = /^(fixed|pct_gross|pct_basic):(\d+(?:\.\d+)?)$/.exec(main);
  if (!m) throw new Error(`Invalid security_deduction_rule "${rule}"`);
  let cap = null;
  for (const o of opts) {
    const c = /^cap:(\d+(?:\.\d+)?)$/.exec(o);
    if (!c) throw new Error(`Invalid security_deduction_rule option "${o}"`);
    cap = Math.round(Number(c[1]) * 100);
  }
  const value = m[1] === "fixed" ? Math.round(Number(m[2]) * 100) : Number(m[2]) / 100;
  return { kind: m[1], value, cap };
}

function securityDeduction(rule, { gross, basic, heldToDate }) {
  const r = parseSecurityRule(rule);
  let amount = 0;
  if (r.kind === "fixed") amount = r.value;
  else if (r.kind === "pct_gross") amount = pct(Math.max(0, gross), r.value);
  else if (r.kind === "pct_basic") amount = pct(basic, r.value);
  if (r.cap != null) amount = Math.min(amount, Math.max(0, r.cap - heldToDate));
  return amount;
}

// Guys / supervisors — monthly.
function computeGuy({ staff, daily, stock, allowances, openingBalance, securityHeldToDate }) {
  const totalBusiness = sum(daily, "business_amount");
  const overTarget = Math.max(0, totalBusiness - staff.target);
  const commission = pct(overTarget, staff.commission_rate);
  const allowanceTotal = sum(allowances, "amount");
  const gross = staff.basic_pay + commission + allowanceTotal;

  const settleUpDaily = sum(daily, "settle_up_minus");
  const stockShortfall = sum(stock, "shortfall_value");
  const settleUp = settleUpDaily + stockShortfall; // stock shortfall feeds settle_up_minus
  const personal = sum(daily, "personal_minus");
  const security = securityDeduction(staff.security_deduction_rule, {
    gross, basic: staff.basic_pay, heldToDate: securityHeldToDate,
  });
  const totalDeductions = settleUp + personal + security;
  const netPay = gross - totalDeductions;

  // A negative result carries forward as money owed; anything positive is paid out.
  const payable = openingBalance + netPay;
  const disbursed = Math.max(0, payable);

  return {
    role: "guy",
    opening_balance: openingBalance,
    gross_earnings: gross,
    total_deductions: totalDeductions,
    net_pay: netPay,
    disbursed_amount: disbursed,
    closing_balance: payable - disbursed,
    detail: {
      days_logged: daily.length,
      total_business: totalBusiness,
      target: staff.target,
      over_target_amount: overTarget,
      commission_rate: staff.commission_rate,
      earnings: [
        { label: "Basic pay", amount: staff.basic_pay },
        { label: `Commission (${fmtRate(staff.commission_rate)} of Rs ${fmt(overTarget)} over target)`, amount: commission },
        ...allowances.map((a) => ({ label: `Allowance: ${a.description}`, amount: a.amount })),
      ],
      deductions: [
        { key: "settle_up_daily", label: "Settle-up (business − settled)", amount: settleUpDaily },
        { key: "stock_shortfall", label: "Stock shortfall", amount: stockShortfall },
        { key: "personal", label: "Personal minus", amount: personal },
        { key: "security", label: `Security (${staff.security_deduction_rule})`, amount: security },
      ],
      stock_lines: stock.map((s) => ({
        product: s.product, shortfall_qty: s.shortfall_qty, unit_price: s.unit_price, shortfall_value: s.shortfall_value,
      })),
      negative_lines: daily
        .filter((d) => d.settle_up_minus < 0 || d.personal_minus < 0)
        .map((d) => ({ date: d.date, settle_up_minus: d.settle_up_minus, personal_minus: d.personal_minus })),
      stock_shortfall: stockShortfall,
      security_deducted: security,
    },
  };
}

// Managers — monthly, built from that month's weekly rows.
// guyNetPays: net_pay of each guy whose manager_id is this manager, for the same period.
function computeManager({ staff, weekly, guyNetPays, openingBalance, companyReturnRate }) {
  const weeks = weekly.map((w) => {
    const profitShare = pct(w.business_total, w.profit_percent);
    return {
      week_start: w.week_start, week_end: w.week_end, business_total: w.business_total,
      profit_percent: w.profit_percent, profit_share: profitShare,
      rent: w.rent, hub_fee: w.hub_fee, security_cost: w.security_cost, personal_draw: w.personal_draw,
      weekly_balance: profitShare - w.rent - w.hub_fee - w.security_cost - w.personal_draw,
    };
  });
  const totalBusiness = sum(weeks, "business_total");
  const companyReturn = pct(totalBusiness, companyReturnRate);
  const guysSalaryTotal = sum(guyNetPays, "net_pay");
  const gross = sum(weeks, "profit_share");
  const deductions = [
    { key: "rent", label: "Rent", amount: sum(weeks, "rent") },
    { key: "hub_fee", label: "Hub fee", amount: sum(weeks, "hub_fee") },
    { key: "security_cost", label: "Security cost", amount: sum(weeks, "security_cost") },
    { key: "personal_draw", label: "Personal draw", amount: sum(weeks, "personal_draw") },
    { key: "company_return", label: `Company return (${fmtRate(companyReturnRate)} of business)`, amount: companyReturn },
    { key: "guys_salary", label: "Guys' net salaries", amount: guysSalaryTotal },
  ];
  const totalDeductions = sum(deductions, "amount");
  // closing = opening + Σweekly_balance − company_return − guys_salary_total
  const netPay = sum(weeks, "weekly_balance") - companyReturn - guysSalaryTotal;

  return {
    role: "manager",
    opening_balance: openingBalance,
    gross_earnings: gross,
    total_deductions: totalDeductions,
    net_pay: netPay,
    disbursed_amount: 0, // manager balances are a running account with the company, not a bank payout
    closing_balance: openingBalance + netPay,
    detail: {
      weeks_logged: weeks.length,
      total_business: totalBusiness,
      weeks,
      guys: guyNetPays,
      earnings: [{ label: "Profit share (Σ business × profit %)", amount: gross }],
      deductions,
    },
  };
}

// Exception flags. Any flag → pending_review; no flags → auto_approved.
function evaluateFlags(result, { staff, previous, settings }) {
  const flags = [];
  const add = (code, message) => flags.push({ code, message });
  const changeLimit = Number(settings.net_pay_change_threshold);

  if (previous) {
    const prev = previous.net_pay;
    const change = prev === 0 ? (result.net_pay === 0 ? 0 : Infinity) : Math.abs(result.net_pay - prev) / Math.abs(prev);
    if (change > changeLimit) {
      add("NET_PAY_CHANGE", `Net pay Rs ${fmt(result.net_pay)} vs Rs ${fmt(prev)} last period ` +
        `(${Number.isFinite(change) ? (change * 100).toFixed(1) + "%" : "from zero"}; limit ${(changeLimit * 100).toFixed(0)}%)`);
    }
  }

  const negatives = result.detail.deductions.filter((d) => d.amount < 0);
  for (const d of negatives) add("NEGATIVE_DEDUCTION", `${d.label} totals Rs ${fmt(d.amount)}`);
  for (const l of result.detail.negative_lines || []) {
    add("NEGATIVE_DEDUCTION", `${l.date}: settle-up Rs ${fmt(l.settle_up_minus)}, personal Rs ${fmt(l.personal_minus)}`);
  }
  if (result.role === "guy" && result.total_deductions > result.gross_earnings) {
    add("DEDUCTIONS_EXCEED_GROSS", `Deductions Rs ${fmt(result.total_deductions)} exceed gross Rs ${fmt(result.gross_earnings)}`);
  }

  if (result.role === "manager" && result.closing_balance < 0 && result.closing_balance < result.opening_balance) {
    add("MANAGER_BALANCE_DEEPER_NEGATIVE",
      `Closing balance Rs ${fmt(result.closing_balance)} is below opening Rs ${fmt(result.opening_balance)}`);
  }

  if (result.disbursed_amount > 0) {
    if (!staff.bank_account_no) add("BANK_ACCOUNT_MISSING", "No bank account on file");
    else if (staff.bank_account_no !== staff.bank_account_verified) {
      add("BANK_ACCOUNT_CHANGED", staff.bank_account_verified
        ? `Account ${mask(staff.bank_account_no)} differs from verified ${mask(staff.bank_account_verified)}`
        : `Account ${mask(staff.bank_account_no)} has never been verified`);
    }
  }

  const stockLimit = Number(settings.stock_shortfall_threshold);
  if (result.role === "guy" && result.detail.stock_shortfall > stockLimit) {
    add("STOCK_SHORTFALL", `Stock shortfall Rs ${fmt(result.detail.stock_shortfall)} exceeds Rs ${fmt(stockLimit)}`);
  }
  return flags;
}

function fmt(cents) {
  const sign = cents < 0 ? "-" : "";
  return sign + (Math.abs(cents) / 100).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtRate(r) { return `${+(r * 100).toFixed(4)}%`; }
function mask(acct) { return acct.length <= 4 ? acct : "…" + acct.slice(-4); }

module.exports = { parseSecurityRule, securityDeduction, computeGuy, computeManager, evaluateFlags, fmt, fmtRate };
