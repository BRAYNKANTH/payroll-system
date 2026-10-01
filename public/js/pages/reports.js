import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, $$, html, icon, money, pct, badge, dataTable, downloadCsv, monthName, fromCents, shortMonth, emptyState } from "../ui.js";
import { barChart, lineChart, PALETTE } from "../charts.js";

let tab = "hubs";
const TABS = [["hubs", "Hub summary"], ["commission", "Commission"], ["stock", "Stock shortfall"], ["balances", "Balances"], ["periods", "Month history"]];

export default {
  title: "Reports",
  periodic: true,
  async render({ el }) {
    const p = state.period;
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Reports</h1><p>${monthName(p)} — switch the month in the top bar.</p></div>
        <div class="actions">
          <a class="btn" href="/api/payroll/${p}/register" target="_blank" rel="noopener">${icon("eye")} Payroll register</a>
          <button class="btn primary" id="csv">${icon("download")} Export CSV</button>
        </div>
      </div>
      <div class="tabs" id="tabs">${TABS.map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`)}</div>
      <div id="pane"><div class="loading-screen"><div class="spinner"></div></div></div>`;

    let exporter = () => {};
    const pane = $("#pane");
    const views = {
      async hubs() {
        const d = await get("/api/dashboard" + qs({ period: p, hub: scopeHub() }));
        pane.innerHTML = html`<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Business and payroll by hub</h3></div><div class="card-body" id="c"></div></div>
          <div class="card"><div class="card-body flush">${dataTable({
            rows: d.by_hub, footer: true,
            cols: [
              { key: "name", label: "Hub", render: (h) => html`<b>${h.name}</b> <span class="faint">${h.code}</span>`, total: () => "All hubs" },
              { key: "staff", label: "Staff", align: "r", total: (r) => r.reduce((t, h) => t + h.staff, 0) },
              ...[["hub_business", "Hub business"], ["guys_business", "Guys' business"], ["gross_pay", "Gross pay"], ["net_pay", "Net pay"], ["to_bank", "To bank"], ["stock_shortfall", "Stock short"], ["manager_balance", "Mgr balance"]]
                .map(([k, l]) => ({ key: k, label: l, align: "r", render: (h) => html`<span class="${h[k] < 0 ? "neg" : ""}">${money(h[k])}</span>`, total: (r) => money(r.reduce((t, h) => t + h[k], 0)) })),
              { key: "ratio", label: "Payroll / business", align: "r", render: (h) => (h.hub_business ? pct(h.gross_pay / h.hub_business) : "—"), sort: (h) => (h.hub_business ? h.gross_pay / h.hub_business : 0) },
            ],
          })}</div></div>`.toString();
        barChart($("#c"), { labels: d.by_hub.map((h) => h.name), series: [
          { name: "Hub business", color: PALETTE[1], values: d.by_hub.map((h) => h.hub_business) },
          { name: "Gross pay", color: PALETTE[0], values: d.by_hub.map((h) => h.gross_pay) },
          { name: "Manager balance", color: PALETTE[2], values: d.by_hub.map((h) => h.manager_balance) },
        ] });
        exporter = () => downloadCsv(`hub-summary-${p}.csv`, ["code", "hub", "staff", "hub_business", "guys_business", "gross_pay", "net_pay", "to_bank", "stock_shortfall", "manager_balance"],
          d.by_hub.map((h) => [h.code, h.name, h.staff, fromCents(h.hub_business), fromCents(h.guys_business), fromCents(h.gross_pay), fromCents(h.net_pay), fromCents(h.to_bank), fromCents(h.stock_shortfall), fromCents(h.manager_balance)]));
      },
      async commission() {
        const rows = await get("/api/reports/commission" + qs({ period: p }));
        pane.innerHTML = rows.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows, footer: true,
          cols: [
            { key: "name", label: "Employee", render: (r) => html`<b>${r.name}</b> <span class="faint">${r.employee_id} · ${r.hub}</span>`, total: () => "Total" },
            { key: "business", label: "Business", align: "r", render: (r) => money(r.business), total: (x) => money(x.reduce((t, r) => t + r.business, 0)) },
            { key: "target", label: "Target", align: "r", render: (r) => money(r.target) },
            { key: "att", label: "Attainment", align: "r", sort: (r) => (r.target ? r.business / r.target : 0), render: (r) => html`<div class="row" style="justify-content:flex-end;gap:8px"><div class="progress ${r.business >= r.target ? "green" : "amber"}" style="width:80px"><span style="width:${Math.min(100, r.target ? (r.business / r.target) * 100 : 0)}%"></span></div>${r.target ? pct(r.business / r.target, 0) : "—"}</div>` },
            { key: "over_target", label: "Over target", align: "r", render: (r) => money(r.over_target), total: (x) => money(x.reduce((t, r) => t + r.over_target, 0)) },
            { key: "rate", label: "Rate", align: "r", render: (r) => pct(r.rate, 2) },
            { key: "commission", label: "Commission", align: "r", render: (r) => html`<b>${money(r.commission)}</b>`, total: (x) => money(x.reduce((t, r) => t + r.commission, 0)) },
          ],
        })}</div></div>`.toString() : html`<div class="card">${emptyState("No payroll calculated for this month", "", "chart")}</div>`.toString();
        exporter = () => downloadCsv(`commission-${p}.csv`, ["employee_id", "name", "hub", "business", "target", "over_target", "rate", "commission"],
          rows.map((r) => [r.employee_id, r.name, r.hub, fromCents(r.business), fromCents(r.target), fromCents(r.over_target), r.rate, fromCents(r.commission)]));
      },
      async stock() {
        const rows = await get("/api/reports/stock" + qs({ period: p }));
        pane.innerHTML = rows.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows, footer: true,
          cols: [
            { key: "name", label: "Employee", render: (r) => html`<b>${r.name}</b> <span class="faint">${r.hub}</span>`, total: () => "Total" },
            { key: "product", label: "Product" },
            ...[["opening_stock", "Opening"], ["issued", "Issued"], ["sold", "Sold"], ["counted_stock", "Counted"]].map(([k, l]) => ({ key: k, label: l, align: "r" })),
            { key: "shortfall_qty", label: "Short qty", align: "r", render: (r) => html`<span class="${r.shortfall_qty > 0 ? "neg" : r.shortfall_qty < 0 ? "pos" : ""}">${r.shortfall_qty}</span>` },
            { key: "unit_price", label: "Unit price", align: "r", render: (r) => money(r.unit_price) },
            { key: "shortfall_value", label: "Value", align: "r", render: (r) => html`<b class="${r.shortfall_value ? "neg" : ""}">${money(r.shortfall_value)}</b>`, total: (x) => money(x.reduce((t, r) => t + r.shortfall_value, 0)) },
          ],
        })}</div></div>`.toString() : html`<div class="card">${emptyState("No stock counts this month", "", "box")}</div>`.toString();
        exporter = () => downloadCsv(`stock-${p}.csv`, ["employee_id", "name", "hub", "product", "opening", "issued", "sold", "counted", "shortfall_qty", "unit_price", "shortfall_value"],
          rows.map((r) => [r.employee_id, r.name, r.hub, r.product, r.opening_stock, r.issued, r.sold, r.counted_stock, r.shortfall_qty, fromCents(r.unit_price), fromCents(r.shortfall_value)]));
      },
      async balances() {
        const rows = await get("/api/reports/balances");
        pane.innerHTML = html`<div class="alert info" style="margin-bottom:16px">${icon("info")}<div>Latest closing balance per employee. Negative guy balances are money owed that is recovered from future pay; manager balances are their running account with the company.</div></div>
          <div class="card"><div class="card-body flush">${dataTable({
            rows, footer: true, empty: "No balances yet",
            cols: [
              { key: "name", label: "Employee", render: (r) => html`<a href="/employees/${encodeURIComponent(r.employee_id)}" data-link><b>${r.name}</b></a> <span class="faint">${r.employee_id}</span>`, total: () => "Total" },
              { key: "role", label: "Role", render: (r) => badge(r.role, r.role === "guy" ? "Guy" : "Manager") },
              { key: "hub", label: "Hub" },
              { key: "period", label: "As of", render: (r) => html`${monthName(r.period)} ${badge(r.period_status)}` },
              { key: "closing_balance", label: "Closing balance", align: "r", render: (r) => html`<b class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</b>`, total: (x) => money(x.reduce((t, r) => t + r.closing_balance, 0)) },
            ],
          })}</div></div>`.toString();
        exporter = () => downloadCsv("balances.csv", ["employee_id", "name", "role", "hub", "as_of", "closing_balance"],
          rows.map((r) => [r.employee_id, r.name, r.role, r.hub, r.period, fromCents(r.closing_balance)]));
      },
      async periods() {
        const rows = await get("/api/periods");
        const asc = [...rows].reverse().slice(-12);
        pane.innerHTML = html`${rows.length ? html`<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Payroll cost by month</h3></div><div class="card-body" id="c"></div></div>` : ""}
          <div class="card"><div class="card-body flush">${dataTable({
            rows, empty: "No months calculated yet",
            cols: [
              { key: "period", label: "Month", render: (r) => html`<b>${monthName(r.period)}</b>` },
              { key: "status", label: "Status", render: (r) => badge(r.status) },
              { key: "employees", label: "Employees", align: "r" },
              { key: "pending", label: "Pending", align: "r", render: (r) => (r.pending ? html`<span class="neg">${r.pending}</span>` : "0") },
              { key: "net_pay", label: "Guys' net pay", align: "r", render: (r) => money(r.net_pay) },
              { key: "to_bank", label: "To bank", align: "r", render: (r) => money(r.to_bank) },
              { key: "finalized_by", label: "Finalized", render: (r) => (r.finalized_by ? html`${r.finalized_by} <span class="faint">${new Date(r.finalized_at).toLocaleDateString("en-GB")}</span>` : "—") },
            ],
          })}</div></div>`.toString();
        if (rows.length) lineChart($("#c"), { labels: asc.map((r) => shortMonth(r.period)), series: [
          { name: "Guys' net pay", color: PALETTE[0], values: asc.map((r) => r.net_pay) },
          { name: "To bank", color: PALETTE[2], values: asc.map((r) => r.to_bank) },
        ] });
        exporter = () => downloadCsv("months.csv", ["period", "status", "employees", "pending", "net_pay", "to_bank", "finalized_by", "finalized_at"],
          rows.map((r) => [r.period, r.status, r.employees, r.pending, fromCents(r.net_pay), fromCents(r.to_bank), r.finalized_by || "", r.finalized_at || ""]));
      },
    };
    const show = async () => {
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      pane.innerHTML = `<div class="loading-screen"><div class="spinner"></div></div>`;
      await views[tab]();
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; show(); }));
    $("#csv").onclick = () => exporter();
    if (!can("export")) $("#csv").title = "Exports what you can see on screen";
    await show();
  },
};
