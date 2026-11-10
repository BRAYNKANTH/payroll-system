// Staff portal: what a distributor, supervisor or group manager may see about themselves.
// Every query here is keyed on the signed-in user's own employee_id; nothing takes an id from the request.
const { getSettings, httpError } = require("./db");
const engine = require("./engine");
const svc = require("./service");
const reports = require("./reports");

const TEAM_LEVELS = new Set(["supervisor", "group_manager"]);
const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];

async function me(db, user) {
  if (!user?.employee_id) throw httpError(403, "This login is not linked to an employee");
  const s = await db.get(`SELECT s.*, h.name AS hub_name, u.name AS upline_name FROM staff s JOIN hubs h ON h.code = s.hub
    LEFT JOIN staff u ON u.employee_id = s.upline_id WHERE s.employee_id = ?`, user.employee_id);
  if (!s) throw httpError(404, "Employee not found");
  return s;
}

// Everyone below this person in the chain (their team), with the month's business.
async function team(db, id, period) {
  const rows = await db.all(`
    WITH RECURSIVE d AS (
      SELECT employee_id, name, staff_level, upline_id, target, status, 1 AS depth FROM staff WHERE upline_id = ?
      UNION ALL
      SELECT s.employee_id, s.name, s.staff_level, s.upline_id, s.target, s.status, d.depth + 1
      FROM staff s JOIN d ON s.upline_id = d.employee_id WHERE d.depth < 6)
    SELECT d.employee_id, d.name, d.staff_level, d.target, d.status, d.depth, u.name AS reports_to,
      COALESCE(SUM(l.business_amount), 0) AS business, COUNT(l.id) AS days
    FROM d LEFT JOIN staff u ON u.employee_id = d.upline_id
    LEFT JOIN daily_log l ON l.employee_id = d.employee_id AND l.date >= ? AND l.date < ?
    GROUP BY d.employee_id, d.name, d.staff_level, d.target, d.status, d.depth, u.name
    ORDER BY d.depth, d.employee_id`, id, ...monthBounds(period));
  return rows.filter((r) => r.status === "active" || r.business > 0);
}

async function summary(db, user, period) {
  svc.assertPeriod(period);
  const s = await me(db, user);
  const finalized = await svc.isFinalized(db, period);
  const daily = await db.all("SELECT date, business_amount, settled_amount, settle_up_minus, personal_minus, notes FROM daily_log WHERE employee_id = ? AND date >= ? AND date < ? ORDER BY date", s.employee_id, ...monthBounds(period));
  const stock = await db.all("SELECT * FROM stock_recon WHERE employee_id = ? AND period = ? ORDER BY product", s.employee_id, period);
  const allowances = await db.all("SELECT description, amount FROM allowances WHERE employee_id = ? AND period = ? ORDER BY id", s.employee_id, period);
  const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
  const business = sum(daily, "business_amount");

  // Final figures exist only once the month is finalized. Before that, show an estimate from the same rules,
  // clearly marked as not final.
  let official = null, estimate = null;
  if (finalized) {
    const r = await db.get("SELECT * FROM pay_period_summary WHERE employee_id = ? AND period = ?", s.employee_id, period);
    if (r) official = { gross: r.gross_earnings, deductions: r.total_deductions, net: r.net_pay, paid: r.disbursed_amount, opening: r.opening_balance,
      closing: r.closing_balance, ...(({ earnings, deductions }) => ({ earnings, deduction_lines: deductions }))(JSON.parse(r.detail)) };
  } else if (daily.length || stock.length || allowances.length) {
    const prev = await db.get("SELECT closing_balance FROM pay_period_summary WHERE employee_id = ? AND period < ? ORDER BY period DESC LIMIT 1", s.employee_id, period);
    const held = await db.get(`SELECT COALESCE(SUM(security_held), 0) AS held FROM pay_period_summary WHERE employee_id = ? AND period < ?`, s.employee_id, period);
    const r = engine.computeGuy({ staff: s, daily, stock, allowances, openingBalance: prev ? prev.closing_balance : Number(s.opening_balance) || 0, securityHeldToDate: Number(held.held) || 0 });
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
      employee_id: s.employee_id, name: s.name, staff_level: s.staff_level, level_name: svc.LEVEL_NAME[s.staff_level] || "Distributor", hub: s.hub, hub_name: s.hub_name,
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
    official, estimate, history, security_held: Number(security.held) || 0,
    team: TEAM_LEVELS.has(s.staff_level) ? await team(db, s.employee_id, period) : null,
  };
}

// The payslip is shown only once the month is final, and only ever for the signed-in person.
async function payslip(db, user, period) {
  svc.assertPeriod(period);
  const s = await me(db, user);
  if (!(await svc.isFinalized(db, period))) throw httpError(403, "Your payslip is available once the month has been finalized");
  return reports.payslipHtml(db, period, s.employee_id, null);
}

const listDocuments = async (db, user) => svc.listDocuments(db, (await me(db, user)).employee_id, user.hub);
const addDocument = async (db, user, body) => svc.addDocument(db, (await me(db, user)).employee_id, body, user.username, user.hub);
async function getDocument(db, user, id) {
  const s = await me(db, user);
  const d = await svc.getDocument(db, id, user.hub);
  if (d.employee_id !== s.employee_id) throw httpError(404, "Document not found"); // never reveal that it exists
  return d;
}

module.exports = { summary, payslip, listDocuments, addDocument, getDocument };
