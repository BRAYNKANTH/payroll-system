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
  .lg{display:inline-block;width:32px;height:32px;border-radius:50%;background:url(data:image/png;base64,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) center/cover;vertical-align:middle;margin-right:8px}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1f24;background:#fff;margin:24px;font-size:13px}
  h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:18px 0 6px}
  .muted{color:#5b6573} table{border-collapse:collapse;width:100%;margin-top:6px}
  th,td{padding:5px 8px;border-bottom:1px solid #e3e6ea;text-align:left;vertical-align:top}
  th{background:#f4f6f8;font-weight:600} td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.total td{font-weight:700;border-top:2px solid #1b1f24} .flag{color:#a4262c}
  .slip{max-width:720px;margin:0 auto 32px;page-break-after:always}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:8px}
  .net{font-size:16px;font-weight:700;margin-top:12px;padding:8px;background:#f4f6f8}
  .words{margin:10px 0 0;font-size:12px} .sign{display:flex;gap:48px;margin-top:44px} .sign div{flex:1;font-size:12px;text-align:center}
  .sign span{display:block;border-top:1px solid #1b1f24;margin-bottom:4px}
  @media print{body{margin:0} .noprint{display:none}}`;

// An amount in cents written out in words, for the payslip: 2090890 -> "Rupees Twenty Thousand Nine Hundred and Eight and Ninety Cents Only".
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] + " Hundred"); n %= 100; if (n) parts.push("and"); }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "")); } else if (n) parts.push(ONES[n]);
  return parts.join(" ");
}
function wordsOf(n) {
  if (n === 0) return "Zero";
  const scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]];
  const out = [];
  for (const [size, name] of scales) { if (n >= size) { out.push(under1000(Math.floor(n / size)) + " " + name); n %= size; } }
  if (n) { const tail = under1000(n); out.push(out.length && n < 100 ? "and " + tail : tail); }
  return out.join(" ");
}
function amountInWords(cents) {
  const neg = cents < 0, abs = Math.abs(Math.round(cents));
  const rupees = Math.floor(abs / 100), c = abs % 100;
  const text = `Rupees ${wordsOf(rupees)}${c ? ` and ${wordsOf(c)} ${c === 1 ? "Cent" : "Cents"}` : ""} Only`;
  return neg ? `Minus ${text}` : text;
}

// `plain` is for the person's own copy: the security deposit is for the company's eyes, so it shows only as "Other deduction".
async function payslipHtml(db, period, employeeId, hub, plain = false) {
  const data = await getPeriod(db, period);
  const rows = data.rows.filter((r) => (!employeeId || r.employee_id === employeeId) && (!hub || r.hub === hub));
  if (!rows.length) throw httpError(404, "No payslip — run the period first");
  const company = (await getSettings(db)).company_name;
  const hubNames = Object.fromEntries((await db.all("SELECT code, name FROM hubs")).map((h) => [h.code, h.name]));
  const draft = data.status !== "finalized";
  const slips = rows.map((r) => {
    const d = r.detail;
    const lines = (items) => items.filter((i) => i.amount !== 0 || /Basic/.test(i.label))
      .map((i) => `<tr><td>${esc(plain && /^Security/i.test(i.label) ? "Other deduction" : i.label)}</td><td class="n">${fmt(i.amount)}</td></tr>`).join("");
    const weeks = r.role === "manager" && d.weeks.length ? `
      <h2>Weekly balances</h2>
      <table><tr><th>Week</th><th class="n">Business</th><th class="n">Profit %</th><th class="n">Profit share</th><th class="n">${plain ? "Rent + fee + draw" : "Rent + fee + security + draw"}</th><th class="n">Weekly balance</th></tr>
      ${d.weeks.map((w) => `<tr><td>${esc(w.week_start)} → ${esc(w.week_end)}</td><td class="n">${fmt(w.business_total)}</td>
        <td class="n">${(w.profit_percent * 100).toFixed(2)}%</td><td class="n">${fmt(w.profit_share)}</td>
        <td class="n">${fmt(w.rent + w.hub_fee + w.security_cost + w.personal_draw)}</td><td class="n">${fmt(w.weekly_balance)}</td></tr>`).join("")}
      </table>` : "";
    const missing = r.role === "guy" ? d.stock_lines.filter((s) => Number(s.shortfall_qty) > 0) : [];
    const stock = missing.length ? `
      <h2>Stock reconciliation</h2>
      <table><tr><th>Product</th><th class="n">Shortfall qty</th><th class="n">Unit price</th><th class="n">Value</th></tr>
      ${missing.map((s) => `<tr><td>${esc(s.product)}</td><td class="n">${s.shortfall_qty}</td><td class="n">${fmt(s.unit_price)}</td><td class="n">${fmt(s.shortfall_value)}</td></tr>`).join("")}
      </table>` : "";
    return `<section class="slip">
      <h1><span class="lg"></span>${esc(company)} — Payslip ${esc(period)}${draft ? ' <span class="flag">(DRAFT — period not finalized)</span>' : ""}</h1>
      <div class="grid">
        <div><b>${esc(r.name)}</b> (${esc(r.employee_id)})</div><div>Hub: ${esc(hubNames[r.hub] || r.hub)}</div>
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
      <p class="words">Salary payable in words: <b>${esc(amountInWords(r.disbursed_amount))}</b></p>
      <div class="sign"><div><span></span>Authority signature</div><div><span></span>${r.role === "manager" ? "Manager" : "Employee"} signature</div></div>
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
    <h1><span class="lg"></span>${esc(company)} — Payroll register ${esc(period)}</h1>
    <p class="muted">Period status: ${esc(data.status)}${data.finalized_by ? ` by ${esc(data.finalized_by)} at ${esc(data.finalized_at)}` : ""} · ${data.rows.length} employees</p>
    <p class="noprint"><button id="print">Print</button><script src="/print.js"></script></p>
    <div style="overflow-x:auto"><table><tr>${head}</tr>${body}${total}</table></div></body></html>`;
}

module.exports = { amountInWords, payslipHtml, registerHtml, registerCsv };
