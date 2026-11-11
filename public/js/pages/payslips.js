import { get } from "../api.js";
import { state, scopeHub } from "../app.js";
import { $, html, icon, money, badge, dataTable, emptyState, monthName, levelLabel } from "../ui.js";
import { openPayslip } from "./breakdown.js";

let q = "";

export default {
  title: "Payslips",
  periodic: true,
  async render({ el }) {
    const p = state.period;
    const data = await get(`/api/payroll/${p}?slim=1`);
    const rows = data.rows.filter((r) => !scopeHub() || r.hub === scopeHub());

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Payslips — ${monthName(p)}</h1><p>${data.status === "finalized" ? "Final payslips for the month." : "Draft payslips — they are marked DRAFT until the month is finalized."}</p></div>
        <div class="actions">${rows.length ? html`<a class="btn primary" href="/api/payroll/${p}/payslips" target="_blank" rel="noopener">${icon("printer")} Print all</a>` : ""}</div>
      </div>
      <div class="card">
        ${rows.length ? html`<div class="card-head"><div class="search"><span>${icon("search")}</span><input class="input sm" id="q" aria-label="Search employees" placeholder="Search employee" value="${q}" style="width:260px"></div>${badge(data.status)}</div>` : ""}
        <div class="card-body flush" id="list"></div></div>`;

    const draw = () => {
      const f = q.toLowerCase();
      const shown = rows.filter((r) => !f || r.name.toLowerCase().includes(f) || r.employee_id.toLowerCase().includes(f));
      $("#list").innerHTML = rows.length ? dataTable({
        rows: shown, empty: "No matching employees",
        onRow: (r) => openPayslip(p, r.employee_id),
        card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${r.employee_id} · ${levelLabel(r.staff_level)} · ${r.hub}</span></span>
          <span class="mc-end"><b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b><br>${badge(r.status)}</span>`,
        cols: [
          { key: "name", label: "Employee", render: (r) => html`<div class="who"><div><b>${r.name}</b><span>${r.employee_id} · ${r.hub}</span></div></div>` },
          { key: "role", label: "Position", render: (r) => levelLabel(r.staff_level) },
          { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings) },
          { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
          { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
          { key: "status", label: "Status", render: (r) => badge(r.status) },
          { key: "x", label: "", sort: false, align: "r", render: () => html`<span class="btn sm">${icon("file")} View</span>` },
        ],
      }).toString() : emptyState("No payslips yet", "Payslips appear once payroll has been calculated for this month.", "file").toString();
    };
    draw();
    $("#q")?.addEventListener("input", (e) => { q = e.target.value; draw(); });
  },
};
