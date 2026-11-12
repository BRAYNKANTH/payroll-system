// Pure payroll calculations. No DB access here, so every rule is unit-testable.
// All money values are integer cents.

const sum = (rows, f) => rows.reduce((t, r) => t + (typeof f === "function" ? f(r) : r[f]), 0);
const pct = (amount, rate) => Math.round(amount * rate);

// security_deduction_rule grammar:  none | fixed:<Rs> | pct_gross:<n> | pct_basic:<n> | pct_business:<n>   [;cap:<Rs>]
//   fixed:1500             Rs 1,500 every period
//   pct_gross:5            5% of gross earnings
//   pct_basic:5;cap:25000  5% of basic pay until Rs 25,000 has been held in total
//   pct_business:1         1% of the period's total business
function parseSecurityRule(rule) {
  const text = String(rule || "none").trim().toLowerCase();
  if (text === "none" || text === "") return { kind: "none", value: 0, cap: null };
  const [main, ...opts] = text.split(";").map((s) => s.trim());
  const m = /^(fixed|pct_gross|pct_basic|pct_business):(\d+(?:\.\d+)?)$/.exec(main);
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

function securityDeduction(rule, { gross, basic, business = 0, heldToDate }) {
  const r = parseSecurityRule(rule);
  let amount = 0;
  if (r.kind === "fixed") amount = r.value;
  else if (r.kind === "pct_gross") amount = pct(Math.max(0, gross), r.value);
  else if (r.kind === "pct_basic") amount = pct(basic, r.value);
  else if (r.kind === "pct_business") amount = pct(Math.max(0, business), r.value);
  if (r.cap != null) amount = Math.min(amount, Math.max(0, r.cap - heldToDate));
  return amount;
}

// Guys / supervisors — monthly.
// staff.pay_scheme picks how earnings are built:
//   over_target (default)  basic_pay always, plus commission_rate × business over target.
//   tiered                 target not exceeded → base_commission_rate × all business, no basic;
//                          target exceeded     → fixed basic_pay plus commission_rate × business over target.
//                          Food allowance = food_per_day × days logged, only once food_min_days are worked
//                          (food_min_days 0 = always paid).
function computeGuy({ staff, daily, stock, allowances, openingBalance, securityHeldToDate, loans = [] }) {
  const tiered = staff.pay_scheme === "tiered";
  const totalBusiness = sum(daily, "business_amount");
  const overTarget = Math.max(0, totalBusiness - staff.target);
  const metTarget = totalBusiness > staff.target;
  const commission = pct(overTarget, staff.commission_rate);
  const allowanceTotal = sum(allowances, "amount");
  const basic = tiered && !metTarget ? 0 : staff.basic_pay;
  const baseCommission = tiered && !metTarget ? pct(totalBusiness, staff.base_commission_rate) : 0;
  const foodDays = daily.length;
  const food = tiered && staff.food_per_day > 0 && foodDays >= (staff.food_min_days || 0) ? staff.food_per_day * foodDays : 0;
  const gross = basic + baseCommission + commission + food + allowanceTotal;

  const settleUpDaily = sum(daily, "settle_up_minus");
  const stockShortfall = sum(stock, "shortfall_value");
  const settleUp = settleUpDaily + stockShortfall; // stock shortfall feeds settle_up_minus
  const personal = sum(daily, "personal_minus");
  const security = securityDeduction(staff.security_deduction_rule, {
    gross, basic, business: totalBusiness, heldToDate: securityHeldToDate,
  });
  // Advances and loans: each has an instalment due this month. It is taken only from pay that is left after the other
  // deductions, so a loan never pushes anyone into a negative balance. What cannot be taken stays on the loan for next month.
  let room = Math.max(0, gross - settleUp - personal - security);
  const loanLines = loans.map((l) => {
    const take = Math.min(l.planned, room);
    room -= take;
    return { loan_id: l.id, kind: l.kind, planned: l.planned, amount: take, outstanding_after: l.outstanding - take };
  });
  const loanTotal = sum(loanLines, "amount");
  const totalDeductions = settleUp + personal + security + loanTotal;
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
      ...(tiered ? { pay_scheme: "tiered", target_met: metTarget, food_allowance: food } : {}),
      earnings: tiered ? [
        ...(metTarget ? [{ label: "Basic pay", amount: basic }] : [
          { label: `Commission (${fmtRate(staff.base_commission_rate)} of Rs ${fmt(totalBusiness)} business)`, amount: baseCommission },
        ]),
        { label: `Over-target income (${fmtRate(staff.commission_rate)} of Rs ${fmt(overTarget)} over target)`, amount: commission },
        { label: `Food allowance (${foodDays} days × Rs ${fmt(staff.food_per_day)})`, amount: food },
        ...allowances.map((a) => ({ label: `Allowance: ${a.description}`, amount: a.amount })),
      ] : [
        { label: "Basic pay", amount: staff.basic_pay },
        { label: `Commission (${fmtRate(staff.commission_rate)} of Rs ${fmt(overTarget)} over target)`, amount: commission },
        ...allowances.map((a) => ({ label: `Allowance: ${a.description}`, amount: a.amount })),
      ],
      deductions: [
        { key: "settle_up_daily", label: "Settle-up (business − settled)", amount: settleUpDaily },
        { key: "stock_shortfall", label: "Stock shortfall", amount: stockShortfall },
        { key: "personal", label: "Personal minus", amount: personal },
        { key: "security", label: `Security (${staff.security_deduction_rule})`, amount: security },
        ...loanLines.map((l) => ({ key: "loan", label: loanLabel(l), amount: l.amount })),
      ],
      ...(loanLines.length ? { loans: loanLines } : {}),
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

// Commission rate for a manager's week: the high rate once business reaches the threshold, otherwise the low rate.
function managerCommissionRate(businessCents, settings) {
  return businessCents >= Number(settings.manager_commission_threshold) ? Number(settings.manager_commission_high) : Number(settings.manager_commission_low);
}

// Managers — monthly, built from that month's weekly rows.
// staff.basic_pay is a separate fixed salary (manager, promoting manager, coacher): it is paid out to the bank
// and does not move the running balance.
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
  const salary = Number(staff.basic_pay) || 0;
  const gross = sum(weeks, "profit_share") + salary;
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
  const netPay = sum(weeks, "weekly_balance") - companyReturn - guysSalaryTotal + salary;

  return {
    role: "manager",
    opening_balance: openingBalance,
    gross_earnings: gross,
    total_deductions: totalDeductions,
    net_pay: netPay,
    disbursed_amount: salary, // only the fixed salary is a bank payout; the rest is a running account with the company
    closing_balance: openingBalance + netPay - salary,
    detail: {
      weeks_logged: weeks.length,
      total_business: totalBusiness,
      weeks,
      guys: guyNetPays,
      basic_salary: salary,
      earnings: [{ label: "Profit share (Σ business × profit %)", amount: gross - salary },
        ...(salary ? [{ label: "Basic salary (paid to bank)", amount: salary }] : [])],
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

function loanLabel(l) {
  const what = l.kind === "advance" ? "Advance repaid" : "Loan instalment";
  const short = l.amount < l.planned ? `, only Rs ${fmt(l.amount)} of Rs ${fmt(l.planned)} could be taken` : "";
  return `${what} (balance after: Rs ${fmt(l.outstanding_after)}${short})`;
}

function fmt(cents) {
  const sign = cents < 0 ? "-" : "";
  return sign + (Math.abs(cents) / 100).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtRate(r) { return `${+(r * 100).toFixed(4)}%`; }
function mask(acct) { return acct.length <= 4 ? acct : "…" + acct.slice(-4); }

module.exports = { parseSecurityRule, securityDeduction, computeGuy, computeManager, managerCommissionRate, evaluateFlags, fmt, fmtRate };
