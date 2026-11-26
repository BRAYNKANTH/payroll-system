// Staff portal: what any employee (distributor, supervisor, manager, promoting manager or coacher) may see about themselves.
// Every query here is keyed on the signed-in user's own employee_id; nothing takes an id from the request.
const { getSettings, httpError } = require("./db");
const engine = require("./engine");
const svc = require("./service");
const reports = require("./reports");
const loans = require("./loans");

const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];

async function me(db, user) {
  if (!user?.employee_id) throw httpError(403, "This login is not linked to an employee");
  const s = await db.get(`SELECT s.*, h.name AS hub_name, u.name AS upline_name FROM staff s JOIN hubs h ON h.code = s.hub
    LEFT JOIN staff u ON u.employee_id = s.upline_id WHERE s.employee_id = ?`, user.employee_id);
  if (!s) throw httpError(404, "Employee not found");
  return s;
}

async function summary(db, user, period) {
  svc.assertPeriod(period);
  const s = await me(db, user);
  // A manager knows who is under them but never what those people sold; the office still sees the whole picture (forEmployee).
  return build(db, s, period, { hideTeamSales: s.staff_level === "manager" });
}
// The same figures for any employee, for the office (a hub-limited user only reaches their own hub). Used by the person report.
async function forEmployee(db, employeeId, period, hub) {
  svc.assertPeriod(period);
  const s = await db.get(`SELECT s.*, h.name AS hub_name, u.name AS upline_name FROM staff s JOIN hubs h ON h.code = s.hub
    LEFT JOIN staff u ON u.employee_id = s.upline_id WHERE s.employee_id = ?`, String(employeeId));
  if (!s) throw httpError(404, "Employee not found");
  if (hub && s.hub !== hub) throw httpError(403, "Outside your hub");
  return build(db, s, period);
}
async function build(db, s, period, { hideTeamSales = false } = {}) {
  const finalized = await svc.isFinalized(db, period);
  const daily = await db.all("SELECT id, date, business_amount, settled_amount, settle_up_minus, personal_minus, notes, source, (confirmed_by IS NOT NULL OR source <> 'portal') AS confirmed FROM daily_log WHERE employee_id = ? AND date >= ? AND date < ? ORDER BY date", s.employee_id, ...monthBounds(period));
  const stock = await db.all("SELECT * FROM stock_recon WHERE employee_id = ? AND period = ? ORDER BY product", s.employee_id, period);
  const allowances = await db.all("SELECT description, amount FROM allowances WHERE employee_id = ? AND period = ? ORDER BY id", s.employee_id, period);
  const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
  const business = sum(daily, "business_amount");
  const senior = s.staff_level === "promoting_manager" || s.staff_level === "coacher"; // paid a salary plus a share of the sales below them
  const isManager = s.staff_level === "manager" || s.staff_level === "promoting_manager"; // a promoting manager is also a manager of his own team
  const settings = await getSettings(db);

  // Everyone below this person in the chain, with their sales this month (sales only, never anyone's pay).
  let team = null, shareSales = null; // shareSales: what a promoting manager's share is worked out on (the groups of the managers directly under them)
  if (s.role === "manager") {
    // Everyone below, in any hub: the reporting chart crosses hubs (a branch's coacher can report to someone from another branch).
    const people = await db.all("SELECT employee_id, name, staff_level, upline_id, target, status FROM staff WHERE status = 'active'");
    const kids = new Map();
    for (const p of people) { if (!kids.has(p.upline_id)) kids.set(p.upline_id, []); kids.get(p.upline_id).push(p); }
    const below = [];
    const walk = (id, depth) => { for (const k of kids.get(id) || []) { if (depth < 8) { below.push({ ...k, depth }); walk(k.employee_id, depth + 1); } } };
    walk(s.employee_id, 1);
    if (hideTeamSales) { // names and positions only: no sales, days, shortages or targets of the people below
      team = below.map((p) => ({ employee_id: p.employee_id, name: p.name, level_name: svc.LEVEL_NAME[p.staff_level] || p.staff_level, depth: p.depth }));
    } else {
      const rows = below.length ? await db.all(`SELECT employee_id, COUNT(*) AS days, COALESCE(SUM(business_amount), 0) AS business, COALESCE(SUM(settle_up_minus), 0) AS short
        FROM daily_log WHERE date >= ? AND date < ? GROUP BY employee_id`, ...monthBounds(period)) : [];
      const byId = new Map(rows.map((r) => [r.employee_id, r]));
      team = below.map((p) => ({ employee_id: p.employee_id, name: p.name, level_name: svc.LEVEL_NAME[p.staff_level] || p.staff_level, depth: p.depth, target: Number(p.target) || 0,
        days: Number(byId.get(p.employee_id)?.days) || 0, business: Number(byId.get(p.employee_id)?.business) || 0, short: Number(byId.get(p.employee_id)?.short) || 0 }));
      if (s.staff_level === "promoting_manager") {
        const biz = new Map(team.map((p) => [p.employee_id, p.business]));
        const group = (id, depth = 0) => (biz.get(id) || 0) + (depth < 8 ? (kids.get(id) || []).reduce((t, k) => t + group(k.employee_id, depth + 1), 0) : 0);
        shareSales = (kids.get(s.employee_id) || []).filter((k) => k.staff_level === "manager").reduce((t, k) => t + group(k.employee_id), 0);
      }
    }
  }
  const belowSales = team && !hideTeamSales ? team.reduce((t, p) => t + p.business, 0) : 0;

  // Final figures exist only once the month is finalized. Before that, show an estimate from the same rules,
  // clearly marked as not final.
  let official = null, estimate = null;
  if (finalized) {
    const r = await db.get("SELECT * FROM pay_period_summary WHERE employee_id = ? AND period = ?", s.employee_id, period);
    if (r) official = { gross: r.gross_earnings, deductions: r.total_deductions, net: r.net_pay, paid: r.disbursed_amount, opening: r.opening_balance,
      closing: r.closing_balance, ...(({ earnings, deductions }) => ({ earnings, deduction_lines: deductions }))(JSON.parse(r.detail)) };
  } else if (senior && s.staff_level !== "promoting_manager") { // the old Coacher position; a promoting manager is paid like a manager (below)
    const promoting = s.staff_level === "promoting_manager";
    const r = engine.computeSenior({ staff: s, belowSales: promoting ? shareSales || 0 : belowSales, rate: Number(settings.senior_commission_rate) || 0, openingBalance: 0,
      shareOf: promoting ? "your managers' groups" : "your team's sales" });
    estimate = { gross: r.gross_earnings, deductions: 0, net: r.net_pay, opening: 0, closing: 0, earnings: r.detail.earnings, deduction_lines: [] };
  } else if (isManager) {
    estimate = null; // a manager's pay comes from the weekly account, which the office completes
  } else if (daily.length || stock.length || allowances.length) {
    const prev = await db.get("SELECT closing_balance FROM pay_period_summary WHERE employee_id = ? AND period < ? ORDER BY period DESC LIMIT 1", s.employee_id, period);
    const held = await db.get(`SELECT COALESCE(SUM(security_held), 0) AS held FROM pay_period_summary WHERE employee_id = ? AND period < ?`, s.employee_id, period);
    const due = (await loans.plan(db, period)).get(s.employee_id) || [];
    const r = engine.computeGuy({ staff: s, daily, stock, allowances, openingBalance: prev ? prev.closing_balance : Number(s.opening_balance) || 0, securityHeldToDate: Number(held.held) || 0, loans: due });
    estimate = { gross: r.gross_earnings, deductions: r.total_deductions, net: r.net_pay, opening: r.opening_balance, closing: r.closing_balance,
      earnings: r.detail.earnings, deduction_lines: r.detail.deductions };
  }

  const history = await db.all(`SELECT p.period, p.gross_earnings, p.total_deductions, p.net_pay, p.disbursed_amount, p.closing_balance
    FROM pay_period_summary p JOIN periods x USING (period) WHERE p.employee_id = ? AND x.status = 'finalized' ORDER BY p.period DESC LIMIT 36`, s.employee_id);
  const security = await db.get(`SELECT COALESCE(SUM(p.security_held), 0) AS held FROM pay_period_summary p
    JOIN periods x USING (period) WHERE p.employee_id = ? AND x.status = 'finalized'`, s.employee_id);

  return {
    period, finalized,
    company: (await getSettings(db)).company_name,
    me: {
      employee_id: s.employee_id, name: s.name, staff_level: s.staff_level, senior, is_manager: isManager, sells: s.role === "guy" || isManager, level_name: svc.LEVEL_NAME[s.staff_level] || "Distributor", hub: s.hub, hub_name: s.hub_name,
      reports_to: s.upline_name || null, phone: s.phone, nic: s.nic, join_date: s.join_date,
      bank_name: s.bank_name, bank_last4: s.bank_account_no ? s.bank_account_no.slice(-4) : null,
      pay: { pay_scheme: s.pay_scheme, target: s.target, basic_pay: s.basic_pay, commission_rate: s.commission_rate, base_commission_rate: s.base_commission_rate,
        food_per_day: s.food_per_day, food_min_days: s.food_min_days, security_deduction_rule: s.security_deduction_rule },
    },
    month: {
      days: daily.length, business, target: s.target, over_target: Math.max(0, business - s.target), to_go: Math.max(0, s.target - business),
      settle_up: sum(daily, "settle_up_minus"), personal: sum(daily, "personal_minus"),
      daily, stock: stock.map((k) => ({ product: k.product, shortfall_qty: k.shortfall_qty, unit_price: k.unit_price, shortfall_value: k.shortfall_value })), allowances,
    },
    // a manager is shown no list of people at all (team is null for them)
    team: hideTeamSales ? null : team, team_sales_hidden: hideTeamSales, below_sales: hideTeamSales ? null : belowSales, share_sales: hideTeamSales ? null : shareSales, senior_rate: Number(settings.senior_commission_rate) || 0,
    official, estimate, history, security_held: Number(security.held) || 0,
    loans: await loans.mine(db, s.employee_id, period),
  };
}

// The payslip is shown only once the month is final, and only ever for the signed-in person.
async function payslip(db, user, period) {
  svc.assertPeriod(period);
  const s = await me(db, user);
  if (!(await svc.isFinalized(db, period))) throw httpError(403, "Your payslip is available once the month has been finalized");
  return reports.payslipHtml(db, period, s.employee_id, null);
}

// One closed month's payslip as data, for the phone screen. Only the signed-in person's own, only once the month is final (the same rule as the printed payslip).
async function payslipData(db, user, period) {
  svc.assertPeriod(period);
  const s = await me(db, user);
  if (!(await svc.isFinalized(db, period))) throw httpError(403, "Your payslip is available once the month has been finalized");
  const r = await db.get("SELECT * FROM pay_period_summary WHERE employee_id = ? AND period = ?", s.employee_id, period);
  if (!r) throw httpError(404, "There is no payslip for that month");
  const d = JSON.parse(r.detail);
  const months = (await db.all(`SELECT p.period FROM pay_period_summary p JOIN periods x ON x.period = p.period AND x.status = 'finalized'
    WHERE p.employee_id = ? ORDER BY p.period`, s.employee_id)).map((x) => x.period);
  const at = months.indexOf(period);
  return {
    period, name: s.name, employee_id: s.employee_id, hub: s.hub_name, position: svc.LEVEL_NAME[s.staff_level] || s.staff_level, is_seller: s.role === "guy",
    bank: s.bank_name ? { name: s.bank_name, last4: s.bank_account_no ? String(s.bank_account_no).slice(-4) : "" } : null,
    earnings: (d.earnings || []).map((l) => ({ label: l.label, amount: l.amount })), deductions: (d.deductions || []).map((l) => ({ label: l.label, amount: l.amount })),
    gross: r.gross_earnings, total_deductions: r.total_deductions, net_pay: r.net_pay, paid: r.disbursed_amount, opening: r.opening_balance, closing: r.closing_balance,
    business: d.total_business ?? null, target: d.target ?? null, over_target: d.over_target_amount ?? null,
    prev: at > 0 ? months[at - 1] : null, next: at >= 0 && at < months.length - 1 ? months[at + 1] : null,
  };
}

const listDocuments = async (db, user) => svc.listDocuments(db, (await me(db, user)).employee_id, user.hub);
const addDocument = async (db, user, body) => svc.addDocument(db, (await me(db, user)).employee_id, body, user.username, user.hub);
async function getDocument(db, user, id) {
  const s = await me(db, user);
  const d = await svc.getDocument(db, id, user.hub);
  if (d.employee_id !== s.employee_id) throw httpError(404, "Document not found"); // never reveal that it exists
  return d;
}

module.exports = { summary, forEmployee, payslip, payslipData, listDocuments, addDocument, getDocument };
