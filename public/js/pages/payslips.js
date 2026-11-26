import { get } from "../api.js";
import { state, scopeHub } from "../app.js";
import { readQuery, writeQuery, $, html, icon, money, badge, dataTable, emptyState, monthName, levelLabel, announce } from "../ui.js";
import { openPayslip } from "./breakdown.js";

let q = "";

export default {
  title: "Payslips",
  periodic: true,
  async render({ el }) {
    q = readQuery({ q }).q;
    const p = state.period;
    const data = await get(`/api/payroll/${p}?slim=1`);
    const rows = data.rows.filter((r) => !scopeHub() || r.hub === scopeHub());

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Payslips — ${monthName(p)}</h1><p>${data.status === "finalized" ? "Final payslips for the month." : "Draft payslips — they are marked DRAFT until the month is finalized."}</p></div>
        <div class="actions">${rows.length ? html`<a class="btn primary" href="/api/payroll/${p}/payslips" target="_blank" rel="noopener">${icon("printer")} Print all</a>` : ""}</div>
      </div>
      <div class="card">
        ${rows.length ? html`<div class="card-head"><div class="search"><span>${icon("search")}</span><input class="input sm" id="q" aria-label="Search employees" placeholder="Search name, ID or hub" value="${q}" style="width:260px"></div><span class="muted" id="pslip-sum" role="status"></span>${badge(data.status)}</div>` : ""}
        <div class="card-body flush" id="list"></div></div>`;

    const draw = () => {
      const f = q.toLowerCase();
      const hubName = (c) => state.hubs.find((h) => h.code === c)?.name || c;
      // One list of everyone, by name. Click a heading to sort; the hub is a column (and the hub choice at the top narrows the list).
      const shown = rows.filter((r) => !f || r.name.toLowerCase().includes(f) || r.employee_id.toLowerCase().includes(f) || hubName(r.hub).toLowerCase().includes(f)).sort((a, b) => a.name.localeCompare(b.name));
      const net = shown.reduce((t, r) => t + r.net_pay, 0);
      const sumEl = $("#pslip-sum"); if (sumEl) sumEl.textContent = `${shown.length} ${shown.length === 1 ? "payslip" : "payslips"} · net pay Rs ${money(net)}`;
      $("#list").innerHTML = rows.length ? dataTable({
        rows: shown, pageSize: 50, empty: "No matching employees", emptyHint: "Try a different search, or clear the filters.",
        onRow: (r) => openPayslip(p, r.employee_id),
        rowAction: "View", rowLabel: (r) => `View payslip for ${r.name}`,
        card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${r.employee_id} · ${levelLabel(r.staff_level)} · ${hubName(r.hub)}</span></span>
          <span class="mc-end"><b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b><br>${badge(r.status)}</span>`,
        cols: [
          { key: "name", label: "Employee", render: (r) => html`<div class="who"><div><b>${r.name}</b><span>${r.employee_id}</span></div></div>` },
          { key: "hub", label: "Hub", render: (r) => hubName(r.hub) },
          { key: "role", label: "Position", render: (r) => levelLabel(r.staff_level) },
          { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings) },
          { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
          { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
          { key: "status", label: "Status", render: (r) => badge(r.status) },
        ],
      }).toString() : emptyState("No payslips yet", "Payslips appear once payroll has been calculated for this month.", "file").toString();
      return shown.length;
    };
    draw();
    // Say how many payslips match once typing pauses.
    let typing;
    $("#q")?.addEventListener("input", (e) => {
      q = e.target.value;
      writeQuery({ q }, { q: "" });
      const n = draw();
      clearTimeout(typing);
      typing = setTimeout(() => announce(`${n} payslip${n === 1 ? "" : "s"} shown`), 600);
    });
  },
};
