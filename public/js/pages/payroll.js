import { get, post, qs } from "../api.js";
import { state, can, scopeHub, refreshPending } from "../app.js";
import { exportButtons, $, $$, html, icon, money, compact, badge, toast, busy, dataTable, monthName, dateTime, emptyState, levelLabel, announce, confirmDialog } from "../ui.js";
import { openBreakdown } from "./breakdown.js";

let filter = "all";
let search = "";

export default {
  title: "Salaries",
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
    const sellers = all.filter((r) => r.role === "guy"), managers = all.filter((r) => r.role === "manager");
    const bankSellers = sum("disbursed_amount", sellers), bankManagers = sum("disbursed_amount", managers);

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Salaries — ${monthName(p)}</h1><p>What each person earns this month, worked out from the daily, weekly and stock sheets. To change a figure, correct the sheet it comes from${can("run_payroll") && !finalized ? ", then press “Update salary figures”" : ""}.</p></div>
        <div class="actions">
          ${calculated ? exportButtons("register", { period: p }) : ""}
          ${badge(data.status)}
          ${can("finalize") && !scopeHub() && calculated && !finalized ? html`<button class="btn ${pending || rejected ? "" : "primary"}" id="close-month">${icon("lock")} Close month</button>` : ""}
          ${can("run_payroll") && !finalized ? html`<button class="btn ${calculated ? "" : "primary"}" id="run">${icon("refresh")} ${calculated ? "Update salary figures" : "Work out salaries"}</button>` : ""}
        </div>
      </div>

      ${calculated ? html`
      <div class="grid kpis mb-4">
        <div class="card kpi"><div class="label"><span class="icon">${icon("users")}</span>Employees</div><div class="value">${all.length}</div>
          <div class="foot">${count("auto_approved")} auto · ${count("approved")} approved · <span class="${pending ? "neg" : ""}">${pending} pending</span>${rejected ? ` · ${rejected} rejected` : ""}</div></div>
        <div class="card kpi"><div class="label"><span class="icon">${icon("wallet")}</span>Sellers' gross earnings</div><div class="value"><small>Rs</small>${compact(sum("gross_earnings", all.filter((r) => r.role === "guy")))}</div><div class="foot"><b class="num">Rs ${money(sum("gross_earnings", all.filter((r) => r.role === "guy")))}</b><span class="kpi-note"> · Sellers, distributors and supervisors. Managers are paid through their own account.</span></div></div>
        <div class="card kpi"><div class="label"><span class="icon amber">${icon("coins")}</span>Sellers' deductions</div><div class="value"><small>Rs</small>${compact(sum("total_deductions", all.filter((r) => r.role === "guy")))}</div><div class="foot"><b class="num">Rs ${money(sum("total_deductions", all.filter((r) => r.role === "guy")))}</b><span class="kpi-note"> · Money to settle up, stock shortfall, personal deductions, security</span></div></div>
        <div class="card kpi"><div class="label"><span class="icon green">${icon("bank")}</span>To bank (everyone)</div><div class="value"><small>Rs</small>${compact(sum("disbursed_amount"))}</div><div class="foot"><b class="num">Rs ${money(sum("disbursed_amount"))}</b><span class="kpi-note"> · ${all.filter((r) => r.disbursed_amount > 0).length} payments</span></div></div>
        <div class="card kpi"><div class="label"><span class="icon blue">${icon("trend")}</span>Managers' closing</div><div class="value"><small>Rs</small>${compact(sum("closing_balance", all.filter((r) => r.role === "manager")))}</div><div class="foot"><b class="num">Rs ${money(sum("closing_balance", all.filter((r) => r.role === "manager")))}</b><span class="kpi-note"> · Running account with the company</span></div></div>
      </div>

      <p class="reconcile" id="reconcile"><b>How the bank total adds up:</b> sellers Rs <span class="num">${money(bankSellers)}</span> + managers Rs <span class="num">${money(bankManagers)}</span> = <b class="num">Rs ${money(bankSellers + bankManagers)}</b> to bank. Sellers' net pay before the opening balance is Rs <span class="num">${money(sum("net_pay", sellers))}</span>.</p>

      <div class="card">
        <div class="card-head">
          <div class="row">
            <div class="seg" id="pay-filters" role="group" aria-label="Show">${[["all", "All"], ["review", `Needs review (${pending + rejected})`], ["guy", "Sales staff"], ["manager", "Managers"]].map(([f, l]) => html`<button type="button" data-f="${f}" class="${filter === f ? "on" : ""}" aria-pressed="${filter === f ? "true" : "false"}">${l}</button>`)}</div>
            <div class="search"><span>${icon("search")}</span><input class="input sm" id="q" aria-label="Search employees" placeholder="Search name or ID" value="${search}" style="width:220px"></div>
          </div>
          <details class="more-menu"><summary class="btn sm">More views and downloads</summary><div class="more-list">
            <a href="/api/payroll/${p}/register" target="_blank" rel="noopener">${icon("eye")} Register (print view)</a>
            ${can("export") ? html`<a href="/api/payroll/${p}/register.csv">${icon("download")} Register as CSV</a>` : ""}
            <a href="/api/payroll/${p}/payslips" target="_blank" rel="noopener">${icon("printer")} All payslips (print view)</a>
          </div></details>
        </div>
        <div class="card-body flush" id="table"></div>
      </div>` : html`<div class="card">${emptyState("Salaries not worked out yet",
        can("run_payroll") ? "When the sheets are in, press “Work out salaries”. You can update the figures as often as you like." : "The admin needs to work out the salaries for this month.", "play",
        can("run_payroll") && !finalized ? `<button class="btn primary" id="run2">Work out salaries</button>` : "")}</div>`}`;

    const drawTable = () => {
      const q = search.toLowerCase();
      const rows = all.filter((r) =>
        (filter === "all" || (filter === "review" ? ["pending_review", "rejected"].includes(r.status) : r.role === filter)) &&
        (!q || r.name.toLowerCase().includes(q) || r.employee_id.toLowerCase().includes(q)));
      $("#table").innerHTML = dataTable({
        rows, footer: true, pageSize: 25, empty: "No matching employees", emptyHint: "Try a different search, or clear the filters.",
        card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${r.employee_id} · ${levelLabel(r.staff_level)} · ${r.hub}</span>
            ${r.flags.length ? html`<span class="mc-flags">${r.flags.map((f) => html`<span class="chip">${f.code.replace(/_/g, " ").toLowerCase()}</span>`)}</span>` : ""}</span>
          <span class="mc-end"><b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b><br>${badge(r.status)}</span>`,
        summary: (rs) => `${rs.length} ${rs.length === 1 ? "person" : "people"} · net pay Rs ${money(sum("net_pay", rs))} · to bank Rs ${money(sum("disbursed_amount", rs))}`,
        onRow: (r) => openBreakdown(r, p, { finalized, onChange: () => this.render(ctx) }),
        rowLabel: (r) => `Open pay details for ${r.name}`,
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
      return rows.length;
    };
    // After a filter or search, say how many people are shown (search waits for a pause in typing).
    const shownText = (n) => `${n} ${n === 1 ? "person" : "people"} shown`;
    let typing;
    if (calculated) {
      drawTable();
      $$("#pay-filters button", el).forEach((b) => (b.onclick = () => {
        filter = b.dataset.f;
        $$("#pay-filters button", el).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        announce(shownText(drawTable()));
      }));
      $("#q").oninput = (e) => {
        search = e.target.value;
        const n = drawTable();
        clearTimeout(typing);
        typing = setTimeout(() => announce(shownText(n)), 600);
      };
    }

    const run = (e) => busy(e.currentTarget, async () => {
      const r = await post(`/api/payroll/${p}/run`);
      toast(`Worked out ${r.employees} people — ${r.auto_approved} auto-approved, ${r.pending_review} need review`, r.pending_review ? "warn" : "ok");
      refreshPending();
      this.render(ctx);
    });
    // Closing the month is final: salaries are worked out once more, the month's sheets are locked and sellers can open their payslips.
    $("#close-month")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (pending || rejected) {
        toast(`${pending + rejected} ${pending + rejected === 1 ? "entry still needs" : "entries still need"} a decision before the month can be closed. Open Approvals.`, "warn");
        return;
      }
      const month = monthName(p);
      const ok = await confirmDialog({
        title: `Close ${month}?`,
        message: `<ul style="margin:0;padding-left:18px;line-height:1.7">
          <li><b>${all.length}</b> people · to the bank <b>Rs ${money(sum("disbursed_amount"))}</b></li>
          <li>Salaries are worked out once more from the latest sheets.</li>
          <li>The daily, weekly, stock and allowance entries for ${month} are <b>locked</b>. They cannot be changed afterwards.</li>
          <li>Sellers can then open their payslips.</li></ul>
          <p style="margin:12px 0 0"><b>This cannot be undone here.</b></p>`,
        confirmText: `Close ${month}`, danger: true,
      });
      if (!ok) return;
      await busy(btn, async () => {
        try { await post(`/api/payroll/${p}/finalize`); }
        catch (err) { throw new Error(String(err.message).replace(/^Finalize earlier periods first: (.+)$/, (_, m) => `Close the earlier months first: ${m.split(", ").map((x) => monthName(x)).join(", ")}`)); }
        toast(`${month} is closed. Payslips are ready.`, "ok");
        refreshPending();
        this.render(ctx);
      });
    });
    $("#run")?.addEventListener("click", run);
    $("#run2")?.addEventListener("click", run);
  },
};
