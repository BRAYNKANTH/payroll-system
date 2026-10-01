import { get } from "../api.js";
import { can, navigate } from "../app.js";
import { $, $$, html, icon, money, badge, dataTable, emptyState, initials, roleLabel, pct, dateTime, monthName, shortMonth } from "../ui.js";
import { lineChart, PALETTE } from "../charts.js";
import { employeeForm } from "./employees.js";
import { breakdownDrawer } from "./breakdown.js";
import { auditDiff } from "./audit.js";

let tab = "overview";

export default {
  title: "Employee",
  async render(ctx) {
    const { el, params } = ctx;
    const p = await get(`/api/staff/${encodeURIComponent(params[0])}/profile`);
    const s = p.staff;
    const last = p.history[0];
    const bankState = !s.bank_account_no ? ["amber", "Missing"] : s.bank_account_no !== s.bank_account_verified ? ["red", "Awaiting verification"] : ["green", "Verified"];

    el.innerHTML = html`
      <div style="margin-bottom:14px"><a href="/employees" data-link class="muted">${icon("left")} All employees</a></div>
      <div class="card" style="margin-bottom:16px">
        <div class="profile-head">
          <div class="avatar lg" style="${s.role === "manager" ? "background:linear-gradient(135deg,#0ea5e9,#10b981)" : ""}">${initials(s.name)}</div>
          <div style="flex:1;min-width:200px">
            <h2>${s.name}</h2>
            <div class="row" style="margin-top:6px;gap:8px">${badge(s.role, roleLabel(s.role))} ${badge(s.status)} <span class="muted">${s.employee_id} · ${s.hub_name}</span></div>
          </div>
          <div class="row" style="gap:28px">
            <div><div class="faint" style="font-size:12px">Latest net pay</div><div style="font-size:20px;font-weight:700" class="num ${last?.net_pay < 0 ? "neg" : ""}">${last ? `Rs ${money(last.net_pay)}` : "—"}</div><div class="faint" style="font-size:12px">${last ? monthName(last.period) : ""}</div></div>
            <div><div class="faint" style="font-size:12px">Balance carried</div><div style="font-size:20px;font-weight:700" class="num ${last?.closing_balance < 0 ? "neg" : ""}">${last ? `Rs ${money(last.closing_balance)}` : "—"}</div></div>
            ${s.role === "guy" ? html`<div><div class="faint" style="font-size:12px">Security held</div><div style="font-size:20px;font-weight:700" class="num">Rs ${money(p.security_held)}</div></div>` : ""}
          </div>
          ${can("manage_staff") ? html`<button class="btn" id="edit">${icon("edit")} Edit</button>` : ""}
        </div>
      </div>

      <div class="tabs" id="tabs">${[["overview", "Overview"], ["history", `Pay history (${p.history.length})`], ...(s.role === "manager" ? [["team", `Team (${p.team.length})`]] : []), ["changes", "Change log"]]
        .map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`)}</div>
      <div id="pane"></div>`;

    const panes = {
      overview: () => html`<div class="grid halves">
        <div class="card"><div class="card-head"><h3>Details</h3></div><div class="card-body"><dl class="kv">
          <dt>Employee ID</dt><dd class="mono">${s.employee_id}</dd><dt>Hub</dt><dd>${s.hub_name} (${s.hub})</dd>
          <dt>Role</dt><dd>${roleLabel(s.role)}</dd>${s.role === "guy" ? html`<dt>Manager</dt><dd>${s.manager_id ? html`<a href="/employees/${encodeURIComponent(s.manager_id)}" data-link>${s.manager_name}</a>` : "—"}</dd>` : ""}
          <dt>Phone</dt><dd>${s.phone || "—"}</dd><dt>NIC</dt><dd>${s.nic || "—"}</dd><dt>Joined</dt><dd>${s.join_date || "—"}</dd>
          <dt>Added by</dt><dd>${s.created_by} · ${dateTime(s.created_at)}</dd></dl></div></div>
        <div class="stack">
          ${s.role === "guy" ? html`<div class="card"><div class="card-head"><h3>Pay setup</h3></div><div class="card-body"><dl class="kv">
            <dt>Basic pay</dt><dd>Rs ${money(s.basic_pay)} / month</dd><dt>Target</dt><dd>Rs ${money(s.target)} / month</dd>
            <dt>Commission</dt><dd>${pct(s.commission_rate, 2)} of business over target</dd><dt>Security rule</dt><dd class="mono">${s.security_deduction_rule}</dd></dl></div></div>`
            : html`<div class="card"><div class="card-head"><h3>How manager pay works</h3></div><div class="card-body muted">Each week: business × profit % − rent − hub fee − security − personal draw. Each month the company return and the guys' net salaries are charged, and the result is carried as a running balance.</div></div>`}
          <div class="card"><div class="card-head"><h3>Bank</h3>${badge(bankState[0], bankState[1])}</div><div class="card-body"><dl class="kv">
            <dt>Bank</dt><dd>${s.bank_name || "—"}</dd><dt>Bank / branch</dt><dd class="mono">${s.bank_code || "—"} / ${s.branch_code || "—"}</dd>
            <dt>Account</dt><dd class="mono">${s.bank_account_no || "—"}</dd>
            ${s.bank_account_no !== s.bank_account_verified ? html`<dt>Verified account</dt><dd class="mono">${s.bank_account_verified || "none"}</dd>` : ""}</dl></div></div>
        </div></div>`,
      history: () => p.history.length ? html`
        <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Net pay over time</h3></div><div class="card-body" id="chart"></div></div>
        <div class="card"><div class="card-body flush" id="hist"></div></div>` : html`<div class="card">${emptyState("No pay history yet", "", "file")}</div>`,
      team: () => html`<div class="card"><div class="card-body flush">${dataTable({
        rows: p.team, empty: "No guys report to this manager", onRow: (g) => navigate(`/employees/${encodeURIComponent(g.employee_id)}`),
        cols: [{ key: "name", label: "Name", render: (g) => html`<b>${g.name}</b> <span class="faint">${g.employee_id}</span>` }, { key: "basic_pay", label: "Basic", align: "r", render: (g) => money(g.basic_pay) },
          { key: "target", label: "Target", align: "r", render: (g) => money(g.target) }, { key: "status", label: "Status", render: (g) => badge(g.status) }],
      })}</div></div>`,
      changes: () => html`<div class="card"><div class="card-body flush">${dataTable({
        rows: p.changes, sortable: false, empty: "No changes since the record was created",
        cols: [{ key: "changed_at", label: "When", render: (a) => dateTime(a.changed_at) }, { key: "changed_by", label: "Who" }, { key: "diff", label: "Change", render: (a) => auditDiff(a) }],
      })}</div></div>`,
    };
    const show = () => {
      $("#pane").innerHTML = panes[tab]().toString();
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      if (tab === "history" && p.history.length) {
        const h = [...p.history].reverse().slice(-12);
        lineChart($("#chart"), { labels: h.map((r) => shortMonth(r.period)), height: 220, series: [
          { name: "Net pay", color: PALETTE[0], values: h.map((r) => r.net_pay) },
          ...(s.role === "guy" ? [{ name: "Gross", color: PALETTE[1], values: h.map((r) => r.gross_earnings) }] : [{ name: "Closing balance", color: PALETTE[2], values: h.map((r) => r.closing_balance) }]),
        ] });
        $("#hist").innerHTML = dataTable({
          rows: p.history, onRow: (r) => breakdownDrawer({ ...r, name: s.name, hub: s.hub }, { finalized: r.period_status === "finalized", onChange: () => this.render(ctx) }),
          cols: [
            { key: "period", label: "Month", render: (r) => html`<b>${monthName(r.period)}</b>` },
            { key: "opening_balance", label: "Opening", align: "r", render: (r) => money(r.opening_balance) },
            { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings) },
            { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
            { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
            { key: "closing_balance", label: "Closing", align: "r", render: (r) => html`<span class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</span>` },
            { key: "status", label: "Status", render: (r) => html`${badge(r.status)} ${r.period_status === "finalized" ? html`<span class="faint">${icon("lock")}</span>` : ""}` },
          ],
        }).toString();
      }
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; show(); }));
    if (!panes[tab]) tab = "overview";
    show();
    $("#edit")?.addEventListener("click", () => employeeForm(s, () => this.render(ctx)));
    document.title = `${s.name} · Payroll`;
    $("#page-title").textContent = s.name;
  },
};
