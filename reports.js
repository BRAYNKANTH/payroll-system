// Payslips and the payroll register. (Salaries are not paid through a bank file from here, so there is no bank file.)
const { getSettings } = require("./db");
const { getPeriod, httpError, isFinalized, LEVEL_NAME } = require("./service");
const { fmt } = require("./engine");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const rs = (cents) => (cents / 100).toFixed(2);

const PAGE_CSS = `
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1f24;background:#fff;margin:24px;font-size:13px}
  h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:18px 0 6px}
  .muted{color:#5b6573} table{border-collapse:collapse;width:100%;margin-top:6px}
  th,td{padding:5px 8px;border-bottom:1px solid #e3e6ea;text-align:left;vertical-align:top}
  th{background:#f4f6f8;font-weight:600} td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.total td{font-weight:700;border-top:2px solid #1b1f24} .flag{color:#a4262c}
  .slip{max-width:720px;margin:0 auto 32px;page-break-after:always}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:8px}
  .net{font-size:16px;font-weight:700;margin-top:12px;padding:8px;background:#f4f6f8}
  @media print{body{margin:0} .noprint{display:none}}`;

async function payslipHtml(db, period, employeeId, hub) {
  const data = await getPeriod(db, period);
  const rows = data.rows.filter((r) => (!employeeId || r.employee_id === employeeId) && (!hub || r.hub === hub));
  if (!rows.length) throw httpError(404, "No payslip — run the period first");
  const company = (await getSettings(db)).company_name;
  const draft = data.status !== "finalized";
  const slips = rows.map((r) => {
    const d = r.detail;
    const lines = (items) => items.filter((i) => i.amount !== 0 || /Basic/.test(i.label))
      .map((i) => `<tr><td>${esc(i.label)}</td><td class="n">${fmt(i.amount)}</td></tr>`).join("");
    const weeks = r.role === "manager" && d.weeks.length ? `
      <h2>Weekly balances</h2>
      <table><tr><th>Week</th><th class="n">Business</th><th class="n">Profit %</th><th class="n">Profit share</th><th class="n">Rent + fee + security + draw</th><th class="n">Weekly balance</th></tr>
      ${d.weeks.map((w) => `<tr><td>${esc(w.week_start)} → ${esc(w.week_end)}</td><td class="n">${fmt(w.business_total)}</td>
        <td class="n">${(w.profit_percent * 100).toFixed(2)}%</td><td class="n">${fmt(w.profit_share)}</td>
        <td class="n">${fmt(w.rent + w.hub_fee + w.security_cost + w.personal_draw)}</td><td class="n">${fmt(w.weekly_balance)}</td></tr>`).join("")}
      </table>` : "";
    const stock = r.role === "guy" && d.stock_lines.length ? `
      <h2>Stock reconciliation</h2>
      <table><tr><th>Product</th><th class="n">Shortfall qty</th><th class="n">Unit price</th><th class="n">Value</th></tr>
      ${d.stock_lines.map((s) => `<tr><td>${esc(s.product)}</td><td class="n">${s.shortfall_qty}</td><td class="n">${fmt(s.unit_price)}</td><td class="n">${fmt(s.shortfall_value)}</td></tr>`).join("")}
      </table>` : "";
    return `<section class="slip">
      <h1>${esc(company)} — Payslip ${esc(period)}${draft ? ' <span class="flag">(DRAFT — period not finalized)</span>' : ""}</h1>
      <div class="grid">
        <div><b>${esc(r.name)}</b> (${esc(r.employee_id)})</div><div>Hub: ${esc(r.hub)}</div>
        <div>Position: ${LEVEL_NAME[r.staff_level] || (r.role === "guy" ? "Distributor" : "Manager")}</div>
        <div>Business this period: Rs ${fmt(d.total_business)}</div>
        ${r.role === "guy" ? `<div>Target: Rs ${fmt(d.target)} · Over target: Rs ${fmt(d.over_target_amount)}</div>`
          : d.month_sales != null ? `<div>Sales (own + team): Rs ${fmt(d.month_sales)}${d.retaining ? ` · <b>Retaining manager</b> (below Rs ${fmt(d.retain_threshold)})` : ""}</div>`
          : d.below_sales != null ? `<div>Sales below: Rs ${fmt(d.below_sales)}</div>` : `<div>Weeks logged: ${d.weeks_logged}</div>`}
      </div>
      <h2>Earnings</h2><table>${lines(d.earnings)}<tr class="total"><td>Gross earnings</td><td class="n">${fmt(r.gross_earnings)}</td></tr></table>
      <h2>Deductions</h2><table>${lines(d.deductions)}<tr class="total"><td>Total deductions</td><td class="n">${fmt(r.total_deductions)}</td></tr></table>
      ${weeks}${stock}
      <h2>Balance</h2>
      <table>
        <tr><td>Opening balance (from previous period)</td><td class="n">${fmt(r.opening_balance)}</td></tr>
        <tr><td>Net pay this period</td><td class="n">${fmt(r.net_pay)}</td></tr>
        <tr><td>Salary paid</td><td class="n">${fmt(r.disbursed_amount)}</td></tr>
        <tr class="total"><td>Closing balance (carried forward)</td><td class="n">${fmt(r.closing_balance)}</td></tr>
      </table>
      <div class="net">Net pay: Rs ${fmt(r.net_pay)}${r.role === "guy" ? ` · Paid: Rs ${fmt(r.disbursed_amount)}` : ""}</div>
      <p class="muted">Status: ${esc(r.status.replace("_", " "))}${r.reviewed_by ? ` by ${esc(r.reviewed_by)}` : ""} · Computed ${esc(r.computed_at)}</p>
    </section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Payslip ${esc(period)}</title><style>${PAGE_CSS}</style></head><body>
    <p class="noprint"><button id="print">Print</button><script src="/print.js"></script></p>${slips}</body></html>`;
}

const REGISTER_COLS = [
  ["Employee", (r) => r.employee_id], ["Name", (r) => r.name], ["Role", (r) => r.role], ["Hub", (r) => r.hub],
  ["Business", (r) => r.detail.total_business, true],
  ["Opening", (r) => r.opening_balance, true], ["Gross", (r) => r.gross_earnings, true],
  ["Deductions", (r) => r.total_deductions, true], ["Net pay", (r) => r.net_pay, true],
  ["Paid", (r) => r.disbursed_amount, true], ["Closing", (r) => r.closing_balance, true],
  ["Status", (r) => r.status], ["Flags", (r) => r.flags.map((f) => f.code).join(" ")],
];

async function registerData(db, period) {
  const data = await getPeriod(db, period);
  if (!data.rows.length) throw httpError(404, "Nothing to report — run the period first");
  const totals = REGISTER_COLS.map(([, f, money]) => (money ? data.rows.reduce((t, r) => t + f(r), 0) : null));
  return { data, totals };
}

async function registerCsv(db, period) {
  const { data, totals } = await registerData(db, period);
  return csv([
    REGISTER_COLS.map(([h]) => h),
    ...data.rows.map((r) => REGISTER_COLS.map(([, f, money]) => (money ? rs(f(r)) : f(r)))),
    REGISTER_COLS.map(([, , money], i) => (i === 0 ? "TOTAL" : money ? rs(totals[i]) : "")),
  ]);
}

async function registerHtml(db, period) {
  const { data, totals } = await registerData(db, period);
  const company = (await getSettings(db)).company_name;
  const head = REGISTER_COLS.map(([h, , m]) => `<th${m ? ' class="n"' : ""}>${esc(h)}</th>`).join("");
  const body = data.rows.map((r) => `<tr>${REGISTER_COLS.map(([, f, m]) => (m ? `<td class="n">${fmt(f(r))}</td>` : `<td>${esc(f(r))}</td>`)).join("")}</tr>`).join("");
  const total = `<tr class="total">${REGISTER_COLS.map(([, , m], i) => (i === 0 ? "<td>TOTAL</td>" : m ? `<td class="n">${fmt(totals[i])}</td>` : "<td></td>")).join("")}</tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Payroll register ${esc(period)}</title><style>${PAGE_CSS} body{margin:16px}</style></head><body>
    <h1>${esc(company)} — Payroll register ${esc(period)}</h1>
    <p class="muted">Period status: ${esc(data.status)}${data.finalized_by ? ` by ${esc(data.finalized_by)} at ${esc(data.finalized_at)}` : ""} · ${data.rows.length} employees</p>
    <p class="noprint"><button id="print">Print</button><script src="/print.js"></script></p>
    <div style="overflow-x:auto"><table><tr>${head}</tr>${body}${total}</table></div></body></html>`;
}

module.exports = { payslipHtml, registerHtml, registerCsv };
