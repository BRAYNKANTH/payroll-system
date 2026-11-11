import { get, post, qs } from "../api.js";
import { state, can, scopeHub, refreshPending } from "../app.js";
import { $, $$, html, icon, money, compact, badge, toast, busy, confirmDialog, dataTable, monthName, dateTime, emptyState, modal, levelLabel } from "../ui.js";
import { openBreakdown } from "./breakdown.js";
import { isPhone, compactSteps } from "../phone.js";

let filter = "all";
let search = "";

export default {
  title: "Payroll run",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const p = state.period;
    const [data, dash] = await Promise.all([get(`/api/payroll/${p}?slim=1`), get("/api/dashboard" + qs({ period: p, hub: scopeHub() }))]);
    const all = data.rows.filter((r) => !scopeHub() || r.hub === scopeHub());
    const finalized = data.status === "finalized";
    const count = (s) => all.filter((r) => r.status === s).length;
    const pending = count("pending_review"), rejected = count("rejected");
    const calculated = all.length > 0;
    const sum = (k, rows = all) => rows.reduce((t, r) => t + r[k], 0);
    const k = dash.kpis;

    // Stepper state
    const dataOk = k.missing_days === 0;
    const steps = [
      { t: "Enter data", d: dataOk ? "All daily sheets complete" : `${k.missing_days} day entries missing`, s: dataOk ? "done" : calculated ? "warn" : "current" },
      { t: "Calculate", d: calculated ? `Last run ${dateTime(data.last_run_at)}` : "Not run yet", s: calculated ? "done" : dataOk ? "current" : "" },
      { t: "Review exceptions", d: !calculated ? "After calculating" : pending + rejected ? `${pending + rejected} to resolve` : "Nothing to review", s: !calculated ? "" : pending + rejected ? "current" : "done" },
      { t: "Finalize", d: finalized ? `By ${data.finalized_by}` : "Locks the month", s: finalized ? "done" : calculated && !(pending + rejected) ? "current" : "" },
      { t: "Pay", d: finalized ? `Rs ${money(sum("disbursed_amount"))} to bank` : "Bank file after finalizing", s: finalized ? "current" : "" },
    ];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Payroll — ${monthName(p)}</h1><p>Every figure is calculated from the sheets. Opening balances come from last month's closing balances.</p></div>
        <div class="actions">
          ${badge(data.status)}
          ${can("run_payroll") && !finalized ? html`<button class="btn ${calculated ? "" : "primary"}" id="run">${icon("refresh")} ${calculated ? "Recalculate" : "Calculate payroll"}</button>` : ""}
          ${can("finalize") && !finalized && calculated ? html`<button class="btn primary" id="finalize" ${pending + rejected ? "disabled" : ""}>${icon("lock")} Finalize month</button>` : ""}
        </div>
      </div>

      <div class="card mb-4"><div class="steps">${steps.map((s, i) => html`
        <div class="step ${s.s}"><div class="dot">${s.s === "done" ? icon("check") : i + 1}</div><div><div class="t">${s.t}</div><div class="d">${s.d}</div></div></div>`)}</div></div>

      ${calculated ? html`
      <div class="grid kpis mb-4">
        <div class="card kpi"><div class="label"><span class="icon">${icon("users")}</span>Employees</div><div class="value">${all.length}</div>
          <div class="foot">${count("auto_approved")} auto · ${count("approved")} approved · <span class="${pending ? "neg" : ""}">${pending} pending</span>${rejected ? ` · ${rejected} rejected` : ""}</div></div>
        <div class="card kpi"><div class="label"><span class="icon">${icon("wallet")}</span>Gross earnings</div><div class="value"><small>Rs</small>${compact(sum("gross_earnings", all.filter((r) => r.role === "guy")))}</div><div class="foot"><b class="num">Rs ${money(sum("gross_earnings", all.filter((r) => r.role === "guy")))}</b> · Guys & supervisors</div></div>
        <div class="card kpi"><div class="label"><span class="icon amber">${icon("coins")}</span>Deductions</div><div class="value"><small>Rs</small>${compact(sum("total_deductions", all.filter((r) => r.role === "guy")))}</div><div class="foot"><b class="num">Rs ${money(sum("total_deductions", all.filter((r) => r.role === "guy")))}</b> · Settle-up, stock, personal, security</div></div>
        <div class="card kpi"><div class="label"><span class="icon green">${icon("bank")}</span>To bank</div><div class="value"><small>Rs</small>${compact(sum("disbursed_amount"))}</div><div class="foot"><b class="num">Rs ${money(sum("disbursed_amount"))}</b> · ${all.filter((r) => r.disbursed_amount > 0).length} payments</div></div>
        <div class="card kpi"><div class="label"><span class="icon blue">${icon("trend")}</span>Managers' closing</div><div class="value"><small>Rs</small>${compact(sum("closing_balance", all.filter((r) => r.role === "manager")))}</div><div class="foot"><b class="num">Rs ${money(sum("closing_balance", all.filter((r) => r.role === "manager")))}</b> · Running account with the company</div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="row">
            <div class="seg" id="pay-filters">${[["all", "All"], ["review", `Needs review (${pending + rejected})`], ["guy", "Sales staff"], ["manager", "Managers"]].map(([f, l]) => html`<button data-f="${f}" class="${filter === f ? "on" : ""}">${l}</button>`)}</div>
            <div class="search"><span>${icon("search")}</span><input class="input sm" id="q" aria-label="Search employees" placeholder="Search name or ID" value="${search}" style="width:220px"></div>
          </div>
          <div class="row">
            <a class="btn sm" href="/api/payroll/${p}/register" target="_blank" rel="noopener">${icon("eye")} Register</a>
            ${can("export") ? html`<a class="btn sm" href="/api/payroll/${p}/register.csv">${icon("download")} CSV</a>` : ""}
            <a class="btn sm" href="/api/payroll/${p}/payslips" target="_blank" rel="noopener">${icon("printer")} All payslips</a>
            ${can("export") && finalized ? html`<button class="btn sm primary" id="bank">${icon("bank")} Bank file</button>` : ""}
          </div>
        </div>
        <div class="card-body flush" id="table"></div>
      </div>` : html`<div class="card">${emptyState("Not calculated yet",
        can("run_payroll") ? "When the sheets are in, press “Calculate payroll”. You can recalculate as often as you like until the month is finalized." : "An accountant or admin needs to run the payroll for this month.", "play",
        can("run_payroll") && !finalized ? `<button class="btn primary" id="run2">Calculate payroll</button>` : "")}</div>`}`;

    if (isPhone()) compactSteps(el.querySelector(".steps"), { actions: { 0: ["/daily", "Open the daily sheet"], 2: ["/approvals", "Open approvals"] } });
    const drawTable = () => {
      const q = search.toLowerCase();
      const rows = all.filter((r) =>
        (filter === "all" || (filter === "review" ? ["pending_review", "rejected"].includes(r.status) : r.role === filter)) &&
        (!q || r.name.toLowerCase().includes(q) || r.employee_id.toLowerCase().includes(q)));
      $("#table").innerHTML = dataTable({
        rows, footer: true, empty: "No matching employees",
        card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${r.employee_id} · ${levelLabel(r.staff_level)} · ${r.hub}</span>
            ${r.flags.length ? html`<span class="mc-flags">${r.flags.map((f) => html`<span class="chip">${f.code.replace(/_/g, " ").toLowerCase()}</span>`)}</span>` : ""}</span>
          <span class="mc-end"><b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b><br>${badge(r.status)}</span>`,
        summary: (rs) => `${rs.length} ${rs.length === 1 ? "person" : "people"} · net pay Rs ${money(sum("net_pay", rs))} · to bank Rs ${money(sum("disbursed_amount", rs))}`,
        onRow: (r) => openBreakdown(r, p, { finalized, onChange: () => this.render(ctx) }),
        cols: [
          { key: "name", label: "Employee", render: (r) => html`<div class="who"><div><b>${r.name}</b><span>${r.employee_id} · ${r.hub}</span></div></div>`, total: (rs) => `${rs.length} employees` },
          { key: "role", label: "Position", render: (r) => badge(r.role, levelLabel(r.staff_level)) },
          { key: "opening_balance", label: "Opening", align: "r", render: (r) => html`<span class="${r.opening_balance < 0 ? "neg" : ""}">${money(r.opening_balance)}</span>`, total: (rs) => money(sum("opening_balance", rs)) },
          { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings), total: (rs) => money(sum("gross_earnings", rs)) },
          { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions), total: (rs) => money(sum("total_deductions", rs)) },
          { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>`, total: (rs) => money(sum("net_pay", rs)) },
          { key: "disbursed_amount", label: "To bank", align: "r", render: (r) => money(r.disbursed_amount), total: (rs) => money(sum("disbursed_amount", rs)) },
          { key: "closing_balance", label: "Closing", align: "r", render: (r) => html`<span class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</span>`, total: (rs) => money(sum("closing_balance", rs)) },
          { key: "status", label: "Status", render: (r) => html`${badge(r.status)}${r.flags.length ? html`<div style="margin-top:4px">${r.flags.map((f) => html`<span class="chip">${f.code.replace(/_/g, " ").toLowerCase()}</span>`)}</div>` : ""}` },
        ],
      }).toString();
    };
    if (calculated) {
      drawTable();
      $$("#pay-filters button", el).forEach((b) => (b.onclick = () => { filter = b.dataset.f; $$("#pay-filters button", el).forEach((x) => x.classList.toggle("on", x === b)); drawTable(); }));
      $("#q").oninput = (e) => { search = e.target.value; drawTable(); };
    }

    const run = (e) => busy(e.currentTarget, async () => {
      const r = await post(`/api/payroll/${p}/run`);
      toast(`Calculated ${r.employees} employees — ${r.auto_approved} auto-approved, ${r.pending_review} need review`, r.pending_review ? "warn" : "ok");
      refreshPending();
      this.render(ctx);
    });
    $("#run")?.addEventListener("click", run);
    $("#run2")?.addEventListener("click", run);
    $("#finalize")?.addEventListener("click", async (e) => {
      const ok = await confirmDialog({
        title: `Finalize ${monthName(p)}?`, confirmText: "Finalize",
        message: `Payroll is recalculated one last time, then every entry for ${monthName(p)} is locked. Closing balances become next month's opening balances. This cannot be undone.`,
      });
      if (!ok) return;
      await busy(e.target.closest("button"), async () => { await post(`/api/payroll/${p}/finalize`); toast(`${monthName(p)} finalized`); this.render(ctx); });
    });
    $("#bank")?.addEventListener("click", () => {
      const payees = all.filter((r) => r.disbursed_amount > 0);
      const m = modal({
        title: "Bank disbursement file",
        body: html`<div class="alert warn mb-3">${icon("alert")}<div><b>Check the file format with your bank before the first upload.</b>
          The current layout is a generic CSV, not a confirmed SLIPS specification.</div></div>
          <p style="margin:0 0 10px"><b>${payees.length}</b> payments totalling <b>Rs ${money(sum("disbursed_amount", payees))}</b>.</p>
          <div class="table-wrap" style="max-height:280px"><table class="table compact"><thead><tr><th>Employee</th><th>Bank</th><th>Account</th><th class="r">Amount</th></tr></thead>
          <tbody>${payees.map((r) => html`<tr><td>${r.name}</td><td>${r.bank_name || "—"}</td><td class="mono">…${(r.bank_account_no || "").slice(-4)}</td><td class="r">${money(r.disbursed_amount)}</td></tr>`)}</tbody></table></div>`.toString(),
        foot: `<button class="btn" data-close>Close</button><button class="btn primary" id="dl">${icon("download")} Download</button>`,
      });
      m.panel.querySelector("#dl").addEventListener("click", (e) => busy(e.currentTarget, async () => {
        const res = await fetch(`/api/payroll/${p}/bank-file`, { credentials: "same-origin" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Download failed");
        const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `salary-${p}.csv`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await res.blob());
        a.download = name;
        a.click();
        toast("Bank file downloaded — the download is recorded in the audit trail");
      }));
    });
  },
};
