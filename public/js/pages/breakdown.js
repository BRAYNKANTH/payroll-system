// Detailed breakdown drawer for one payroll summary row, with approve / reject actions.
import { post } from "../api.js";
import { can, refreshPending } from "../app.js";
import { $, html, icon, money, badge, drawer, toast, busy, confirmDialog, dateTime, roleLabel, initials, pct, modal } from "../ui.js";

const lines = (items) => items.filter((i) => i.amount !== 0 || /Basic|Profit/.test(i.label))
  .map((i) => html`<tr><td>${i.label}</td><td class="${i.amount < 0 ? "neg" : ""}">${money(i.amount)}</td></tr>`);

export function flagList(flags) {
  return flags.map((f) => html`<div class="flag">${icon("alert")}<div><b>${f.code.replace(/_/g, " ")}</b><br><span>${f.message}</span></div></div>`);
}

export function openPayslip(period, id) {
  modal({
    title: "Payslip",
    wide: true,
    body: `<iframe class="frame" src="/api/payroll/${period}/payslips/${encodeURIComponent(id)}" title="Payslip"></iframe>`,
    foot: `<a class="btn" href="/api/payroll/${period}/payslips/${encodeURIComponent(id)}" target="_blank" rel="noopener">Open in new tab</a><button class="btn primary" id="pp">Print</button>`,
  }).panel.querySelector("#pp").onclick = (e) => e.target.closest(".modal").querySelector("iframe").contentWindow.print();
}

export function breakdownDrawer(r, { finalized, onChange }) {
  const d = r.detail;
  const reviewable = can("review") && !finalized && r.flags.length && r.status !== "auto_approved";
  const body = html`
    <div class="row" style="gap:14px;margin-bottom:18px">
      <div class="avatar lg">${initials(r.name)}</div>
      <div style="flex:1"><h3 style="font-size:18px">${r.name}</h3><div class="muted">${r.employee_id} · ${roleLabel(r.role)} · ${r.hub}</div></div>
      ${badge(r.status)}
    </div>
    ${r.flags.length ? html`<div style="margin-bottom:16px">${flagList(r.flags)}</div>` : html`<div class="alert ok" style="margin-bottom:16px">${icon("checkCircle")}<div>No exceptions — processed automatically.</div></div>`}
    ${r.reviewed_by ? html`<div class="alert info" style="margin-bottom:16px">${icon("info")}<div><b>${r.status === "rejected" ? "Rejected" : "Approved"} by ${r.reviewed_by}</b> · ${dateTime(r.reviewed_at)}${r.review_note ? html`<br>${r.review_note}` : ""}</div></div>` : ""}

    <div class="grid halves" style="gap:14px;margin-bottom:18px">
      <div class="card kpi" style="box-shadow:none"><div class="label">Net pay</div><div class="value"><small>Rs</small><span class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</span></div></div>
      <div class="card kpi" style="box-shadow:none"><div class="label">${r.role === "guy" ? "Paid to bank" : "Closing balance"}</div>
        <div class="value"><small>Rs</small><span class="${(r.role === "guy" ? r.disbursed_amount : r.closing_balance) < 0 ? "neg" : ""}">${money(r.role === "guy" ? r.disbursed_amount : r.closing_balance)}</span></div></div>
    </div>

    ${r.role === "guy" ? html`<p class="muted" style="margin:0 0 12px">Business Rs ${money(d.total_business)} vs target Rs ${money(d.target)}
      (${d.target ? pct(d.total_business / d.target, 0) : "—"}) · ${d.days_logged} days logged</p>` : html`<p class="muted" style="margin:0 0 12px">Business Rs ${money(d.total_business)} · ${d.weeks_logged} weeks logged</p>`}

    <h4 style="margin:0 0 6px">Earnings</h4>
    <table class="breakdown">${lines(d.earnings)}<tr class="total"><td>Gross earnings</td><td>${money(r.gross_earnings)}</td></tr></table>
    <h4 style="margin:18px 0 6px">Deductions</h4>
    <table class="breakdown">${lines(d.deductions)}<tr class="total"><td>Total deductions</td><td>${money(r.total_deductions)}</td></tr></table>

    ${r.role === "manager" && d.weeks.length ? html`<h4 style="margin:18px 0 6px">Weeks</h4>
      <div class="table-wrap"><table class="table compact"><thead><tr><th>Week</th><th class="r">Business</th><th class="r">Profit</th><th class="r">Costs</th><th class="r">Balance</th></tr></thead>
      <tbody>${d.weeks.map((w) => html`<tr><td>${w.week_start}</td><td class="r">${money(w.business_total)}</td><td class="r">${money(w.profit_share)}</td>
        <td class="r">${money(w.rent + w.hub_fee + w.security_cost + w.personal_draw)}</td><td class="r ${w.weekly_balance < 0 ? "neg" : ""}">${money(w.weekly_balance)}</td></tr>`)}</tbody></table></div>` : ""}
    ${r.role === "manager" && d.guys.length ? html`<h4 style="margin:18px 0 6px">Guys' salaries charged</h4>
      <table class="breakdown">${d.guys.map((g) => html`<tr><td>${g.name} (${g.employee_id})</td><td>${money(g.net_pay)}</td></tr>`)}</table>` : ""}
    ${r.role === "guy" && d.stock_lines.length ? html`<h4 style="margin:18px 0 6px">Stock shortfall</h4>
      <table class="breakdown">${d.stock_lines.map((s) => html`<tr><td>${s.product} — ${s.shortfall_qty} × Rs ${money(s.unit_price)}</td><td>${money(s.shortfall_value)}</td></tr>`)}</table>` : ""}

    <h4 style="margin:18px 0 6px">Balance</h4>
    <table class="breakdown">
      <tr><td>Opening balance (last period's closing)</td><td>${money(r.opening_balance)}</td></tr>
      <tr><td>Net pay this period</td><td>${money(r.net_pay)}</td></tr>
      ${r.role === "guy" ? html`<tr><td>Paid to bank</td><td>− ${money(r.disbursed_amount)}</td></tr>` : ""}
      <tr class="total"><td>Closing balance</td><td class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</td></tr>
    </table>
    ${r.bank_account_no ? html`<p class="faint" style="margin-top:14px">Bank: ${r.bank_name || ""} · account …${r.bank_account_no.slice(-4)}</p>` : ""}`;

  const dr = drawer({
    title: `${r.period} · ${r.name}`,
    body: body.toString(),
    foot: html`<button class="btn" id="bd-slip">${icon("file")} Payslip</button>
      ${reviewable && r.status !== "rejected" ? html`<button class="btn danger-ghost" id="bd-reject">Reject</button>` : ""}
      ${reviewable && r.status !== "approved" ? html`<button class="btn success" id="bd-approve">${icon("check")} Approve</button>` : ""}`.toString(),
  });
  $("#bd-slip", dr.panel).onclick = () => openPayslip(r.period, r.employee_id);
  $("#bd-approve", dr.panel)?.addEventListener("click", async (e) => {
    const note = await confirmDialog({
      title: `Approve ${r.name}?`,
      message: r.flags.some((f) => f.code === "BANK_ACCOUNT_CHANGED")
        ? "Approving also confirms the new bank account as verified. Make sure you have checked it with the employee."
        : "The flagged items will be accepted and this entry goes into the payroll register.",
      confirmText: "Approve", input: { label: "Note (optional)", placeholder: "How did you check it?" },
    });
    if (note === null) return;
    await busy(e.target.closest("button"), async () => {
      await post(`/api/payroll/${r.period}/${encodeURIComponent(r.employee_id)}/approve`, { note });
      toast(`${r.name} approved`); dr.close(); refreshPending(); onChange?.();
    });
  });
  $("#bd-reject", dr.panel)?.addEventListener("click", async (e) => {
    const note = await confirmDialog({
      title: `Reject ${r.name}?`, danger: true, confirmText: "Reject",
      message: "Rejected entries block finalizing. Fix the source entries and recalculate.",
      input: { label: "Reason", placeholder: "What needs fixing?", required: true },
    });
    if (!note) return;
    await busy(e.target.closest("button"), async () => {
      await post(`/api/payroll/${r.period}/${encodeURIComponent(r.employee_id)}/reject`, { note });
      toast(`${r.name} rejected`, "warn"); dr.close(); refreshPending(); onChange?.();
    });
  });
  return dr;
}
