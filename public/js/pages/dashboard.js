import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, html, esc, icon, money, rs, compact, pct, badge, shortMonth, monthName, dataTable, initials, emptyState, raw } from "../ui.js";
import { lineChart, donutChart, barChart, PALETTE } from "../charts.js";
import { isPhone, foldCards } from "../phone.js";

const kpi = (label, value, ic, color, foot = "") => html`
  <div class="card kpi"><div class="label"><span class="icon ${color}">${icon(ic)}</span>${label}</div>
  <div class="value"><small>Rs</small>${value}</div><div class="foot">${raw(foot)}</div></div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default {
  title: "Dashboard",
  periodic: true,
  async render({ el }) {
    const d = await get("/api/dashboard" + qs({ period: state.period, hub: scopeHub() }));
    const k = d.kpis;
    const first = state.user.full_name.split(" ")[0];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>${greeting()}, ${first}</h1>
          <p>${monthName(d.period)} · ${badge(d.status)} ${d.last_run_at ? `· payroll last calculated ${new Date(d.last_run_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "· payroll not calculated yet"}</p></div>
        <div class="actions">
          ${can("enter_data") ? html`<a class="btn" href="/daily" data-link>${icon("sheet")} Daily sheet</a>` : ""}
          ${can("run_payroll") ? html`<a class="btn primary" href="/payroll" data-link>${icon("play")} Payroll run</a>` : ""}
        </div>
      </div>

      ${k.pending ? html`<div class="alert warn mb-4">${icon("alert")}<div><b>${k.pending} payroll ${k.pending === 1 ? "entry needs" : "entries need"} review</b> before ${monthName(d.period)} can be finalized.
        <a href="/approvals" data-link>Open approvals →</a></div></div>` : ""}

      <div class="grid kpis">
        ${kpi("Hub business", compact(k.hub_business), "store", "blue", `From weekly sheets. Daily sheets: Rs ${compact(k.guys_business)}${k.hub_business !== k.guys_business ? ` (Rs ${compact(Math.abs(k.hub_business - k.guys_business))} ${k.guys_business < k.hub_business ? "less" : "more"})` : ""}`)}
        ${kpi("Gross payroll (guys)", k.calculated ? compact(k.gross_pay) : "—", "wallet", "", k.calculated ? `${k.active_guys} ${k.active_guys === 1 ? "guy" : "guys"} · ${k.active_managers} ${k.active_managers === 1 ? "manager" : "managers"}` : "Run payroll to calculate")}
        ${kpi("To bank", k.calculated ? compact(k.to_bank) : "—", "bank", "green", k.calculated ? `Net pay Rs ${compact(k.net_pay)}` : "&nbsp;")}
        ${kpi("Settle-up + stock short", compact(k.settle_up + k.stock_shortfall), "coins", "amber", `Stock Rs ${compact(k.stock_shortfall)}`)}
        ${kpi("Managers' balance", k.calculated ? compact(k.manager_balance) : "—", "trend", k.manager_balance < 0 ? "red" : "green", "Combined closing balance")}
      </div>

      <div class="grid two mt-4">
        <div class="card"><div class="card-head"><div><h2>Six-month trend</h2><div class="sub">Guys' business vs payroll cost</div></div></div>
          <div class="card-body" id="trend"></div></div>
        <div class="card"><div class="card-head"><div><h2>Business by hub</h2><div class="sub">From managers' weekly sheets</div></div></div>
          <div class="card-body" id="hub-donut"></div></div>
      </div>

      <div class="grid two mt-4">
        <div class="card"><div class="card-head"><div><h2>Hubs at a glance</h2><div class="sub">${monthName(d.period)}</div></div>
          <a class="btn sm" href="/reports" data-link>Reports</a></div>
          <div class="card-body flush" id="hub-table"></div></div>
        <div class="card"><div class="card-head"><div><h2>Exceptions</h2><div class="sub">Flagged by the payroll rules</div></div>
          ${d.exceptions.length ? html`<a class="btn sm" href="/approvals" data-link>Review</a>` : ""}</div>
          <div class="card-body flush" id="exceptions"></div></div>
      </div>

      <div class="grid halves mt-4">
        <div class="card"><div class="card-head"><div><h2>Top performers</h2><div class="sub">Business vs monthly target</div></div></div>
          <div class="card-body flush" id="top"></div></div>
        <div class="card"><div class="card-head"><div><h2>Daily sheet completeness</h2><div class="sub">Working days without an entry</div></div>
          ${can("enter_data") ? html`<a class="btn sm" href="/daily" data-link>Fill in</a>` : ""}</div>
          <div class="card-body flush" id="complete"></div></div>
      </div>`;

    lineChart($("#trend"), {
      labels: d.trend.map((t) => shortMonth(t.period)),
      series: [
        { name: "Guys' business", color: PALETTE[1], values: d.trend.map((t) => t.business) },
        { name: "Gross payroll", color: PALETTE[0], values: d.trend.map((t) => t.gross_pay) },
        { name: "Paid to bank", color: PALETTE[2], values: d.trend.map((t) => t.to_bank) },
      ],
    });

    const hubsWithBiz = d.by_hub.filter((h) => h.hub_business > 0);
    if (hubsWithBiz.length) {
      donutChart($("#hub-donut"), {
        items: hubsWithBiz.map((h, i) => ({ name: h.name, value: h.hub_business, color: PALETTE[i % PALETTE.length] })),
        center: compact(k.hub_business), sub: "total business",
      });
    } else $("#hub-donut").innerHTML = emptyState("No weekly sheets yet", "", "calendar").toString();

    $("#hub-table").innerHTML = dataTable({
      rows: d.by_hub,
      empty: "No hubs yet",
      footer: d.by_hub.length > 1,
      cols: [
        { key: "name", label: "Hub", render: (h) => html`<b>${h.name}</b><div class="faint text-sm">${h.code} · ${h.staff} staff</div>`, total: () => "All hubs" },
        { key: "hub_business", label: "Business", align: "r", render: (h) => money(h.hub_business), total: (r) => money(r.reduce((t, h) => t + h.hub_business, 0)) },
        { key: "gross_pay", label: "Gross pay", align: "r", render: (h) => money(h.gross_pay), total: (r) => money(r.reduce((t, h) => t + h.gross_pay, 0)) },
        { key: "stock_shortfall", label: "Stock short", align: "r", render: (h) => h.stock_shortfall ? html`<span class="neg">${money(h.stock_shortfall)}</span>` : "—", total: (r) => money(r.reduce((t, h) => t + h.stock_shortfall, 0)) },
        { key: "manager_balance", label: "Mgr balance", align: "r", render: (h) => html`<span class="${h.manager_balance < 0 ? "neg" : ""}">${money(h.manager_balance)}</span>`, total: (r) => money(r.reduce((t, h) => t + h.manager_balance, 0)) },
      ],
    }).toString();

    $("#exceptions").innerHTML = d.exceptions.length
      ? d.exceptions.slice(0, 7).map((x) => html`
        <div class="list-item"><div class="avatar" style="background:var(--accent)">${initials(x.name)}</div>
          <div class="grow"><b>${x.name}</b><span>${x.hub} · ${x.flags.map((f) => f.code.replace(/_/g, " ").toLowerCase()).join(", ")}</span></div>
          ${badge(x.status)}</div>`).join("")
      : emptyState(k.calculated ? "No exceptions" : "Not calculated yet", k.calculated ? "Everything passed the payroll checks." : "Run payroll to check this period.", "checkCircle").toString();

    $("#top").innerHTML = d.top.length ? d.top.slice(0, 6).map((t) => {
      const a = t.attainment ?? 0;
      return html`<div class="list-item"><div class="avatar">${initials(t.name)}</div>
        <div class="grow"><b><a href="/employees/${encodeURIComponent(t.employee_id)}" data-link>${t.name}</a></b>
          <div class="row" style="gap:8px;margin-top:4px"><div class="progress ${a >= 1 ? "green" : a >= 0.7 ? "" : "amber"}" style="flex:1"><span style="width:${Math.min(100, a * 100)}%"></span></div>
          <span style="font-size:12px;font-weight:600;min-width:44px;text-align:right">${t.attainment == null ? "—" : pct(a, 0)}</span></div></div>
        <div style="text-align:right"><b class="num">${compact(t.business)}</b><div class="faint" style="font-size:11px">of ${compact(t.target)}</div></div></div>`;
    }).join("") : emptyState("No guys yet", "", "users").toString();

    const incomplete = d.completeness.filter((c) => c.missing.length).sort((a, b) => b.missing.length - a.missing.length);
    $("#complete").innerHTML = !d.completeness.length ? emptyState("No active guys", "", "users").toString()
      : !incomplete.length ? emptyState("All caught up", "Every working day so far has an entry.", "checkCircle").toString()
      : incomplete.slice(0, 7).map((c) => html`<div class="list-item">
          <div class="grow"><b>${c.name}</b><span>${c.hub} · missing ${c.missing.slice(0, 4).map((m) => m.slice(8)).join(", ")}${c.missing.length > 4 ? "…" : ""}</span></div>
          <div class="progress ${c.logged / c.expected >= 0.9 ? "green" : "amber"}" style="width:90px"><span style="width:${(c.logged / Math.max(1, c.expected)) * 100}%"></span></div>
          <span class="num" style="font-size:12px;width:48px;text-align:right">${c.logged}/${c.expected}</span></div>`).join("");

    // On a phone the summary cards stay up top and each section below opens on tap. Exceptions open first when there are any.
    if (isPhone()) foldCards([...el.querySelectorAll(".grid.two > .card, .grid.halves > .card")], { open: d.exceptions.length ? [3] : [] });
  },
};
