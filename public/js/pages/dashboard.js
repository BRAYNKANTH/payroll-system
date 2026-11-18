import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, html, esc, icon, money, rs, compact, pct, badge, monthName, initials, emptyState, raw } from "../ui.js";
import { loadHubData, hubInfo, plural } from "../hubinfo.js";
import { isPhone, foldCards } from "../phone.js";

const kpi = (label, value, ic, color, foot = "") => html`
  <div class="card kpi"><div class="label"><span class="icon ${color}">${icon(ic)}</span>${label}</div>
  <div class="value"><small>Rs</small>${value}</div><div class="foot">${raw(foot)}</div></div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// The home page opens with where this month stands and the one thing to do next, written on a ledger page.
function monthCard(d, k) {
  const done = d.status === "finalized";
  let say, go;
  if (done) { say = "This month is closed. Salaries and payslips are ready to view."; go = ["/payroll", "View salaries", "wallet"]; }
  else if (k.pending) { say = `${k.pending} ${k.pending === 1 ? "entry needs" : "entries need"} a look before the salaries can be trusted.`; go = can("review") ? ["/approvals", "Open approvals", "checkCircle"] : null; }
  else if (!k.calculated) { say = "Salaries have not been worked out yet. Finish the daily sheets, then work them out."; go = can("run_payroll") ? ["/payroll", "Work out salaries", "wallet"] : can("enter_data") ? ["/daily", "Open the daily sheet", "sheet"] : null; }
  else { say = "Everything passed the checks. Salaries are ready to view."; go = can("view_pay") ? ["/payroll", "View salaries", "wallet"] : null; }
  const at = done ? 4 : k.pending ? 1 : !k.calculated ? 0 : 2; // steps before this one are finished
  const steps = ["Daily entries", "Checks", "Salaries worked out", "Month closed"];
  return html`<section class="card month-card" aria-label="Where this month stands">
    <div class="mc-left"><h2>${monthName(d.period)}</h2><p>${say}</p>
      ${go ? html`<a class="btn primary" href="${go[0]}" data-link>${icon(go[2])} ${go[1]}</a>` : ""}
      <ol class="mstep" aria-label="Month progress">${steps.map((t, i) => html`<li class="${i < at ? "done" : i === at ? "now" : ""}" ${i === at ? 'aria-current="step"' : ""}><span class="mdot" aria-hidden="true">${i < at ? "✓" : i + 1}</span>${t}<span class="sr-only">${i < at ? " (done)" : i === at ? " (now)" : ""}</span></li>`)}</ol></div>
    <dl class="mc-right"><div><dt>To bank (everyone)</dt><dd>${k.calculated ? html`<small>Rs</small>${money(k.to_bank)}` : "Not calculated"}</dd></div>
      <div><dt>Sellers' net pay</dt><dd>${k.calculated ? html`<small>Rs</small>${money(k.net_pay)}` : "—"}</dd></div></dl>
  </section>`;
}

export default {
  title: "Dashboard",
  periodic: true,
  async render({ el }) {
    const pay = can("view_pay"); // without it the server has already removed every pay figure
    const [d, hubData] = await Promise.all([get("/api/dashboard" + qs({ period: state.period, hub: scopeHub() })), loadHubData(state.period, pay)]);
    const k = d.kpis;
    const info = hubInfo(hubData, state.period);
    const stats = Object.fromEntries(d.by_hub.map((h) => [h.code, h]));
    // One card per hub: the way in to that hub's people, sales and what is waiting.
    const hubTile = (h) => {
      const x = info[h.code], st = stats[h.code] || {};
      return html`<a class="card hub-tile" href="/hubs/${encodeURIComponent(h.code)}" data-link>
        <span class="hub-top"><b class="hub-name">${h.name}</b><span class="faint">${h.code}${h.status !== "active" ? " · inactive" : ""}</span></span>
        <span class="hub-count">${plural(x.active.length, "person", "people")}</span>
        <span class="muted hub-head">${x.head ? `Head: ${x.head.name}` : "No coacher yet"}</span>
        <span class="hub-nums"><span><small>Sales</small><b class="num">${compact(x.sales)}</b></span>
          ${pay ? html`<span><small>Gross pay</small><b class="num">${compact(st.gross_pay || 0)}</b></span><span><small>Manager account</small><b class="num ${st.manager_balance < 0 ? "neg" : ""}">${compact(st.manager_balance || 0)}</b></span>` : ""}</span>
        <span class="hub-chips">${x.attention.length ? x.attention.map(([tone, text]) => html`<span class="badge ${tone}">${text}</span>`) : html`<span class="badge green">All clear</span>`}</span>
        <span class="hub-go">Open hub ${icon("right")}</span></a>`;
    };
    const first = state.user.full_name.split(" ")[0];

    el.innerHTML = html`<div class="dash">
      <div class="page-head">
        <div><h1>${greeting()}, ${first}</h1>
          <p>${monthName(d.period)} · ${badge(d.status)} ${!can("view_pay") ? "" : d.last_run_at ? `· payroll last calculated ${new Date(d.last_run_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "· payroll not calculated yet"}</p></div>
        <div class="actions">
          ${can("enter_data") ? html`<a class="btn" href="/daily" data-link>${icon("sheet")} Daily sheet</a>` : ""}
          ${can("view_pay") ? html`<a class="btn primary" href="/payroll" data-link>${icon("wallet")} Salaries</a>` : ""}
        </div>
      </div>

      ${pay ? monthCard(d, k) : ""}

      <div class="grid kpis">
        ${kpi("Hub business", money(k.hub_business), "store", "blue", `From weekly sheets. Daily sheets: Rs ${money(k.guys_business)}${k.hub_business !== k.guys_business ? ` (Rs ${money(Math.abs(k.hub_business - k.guys_business))} ${k.guys_business < k.hub_business ? "less" : "more"})` : ""}`)}
        ${!pay ? "" : kpi("Sellers' gross pay", k.calculated ? money(k.gross_pay) : "—", "wallet", "", k.calculated ? `${k.active_guys} ${k.active_guys === 1 ? "seller" : "sellers"}. Managers are paid through their own account.` : "Run payroll to calculate")}
        ${kpi("Cash and stock short", money(k.settle_up + k.stock_shortfall), "coins", "amber", `Cash Rs ${money(k.settle_up)} · Stock Rs ${money(k.stock_shortfall)}`)}
        ${!pay ? "" : kpi("Managers' balance", k.calculated ? money(k.manager_balance) : "—", "trend", k.manager_balance < 0 ? "red" : "green", "Combined closing balance")}
      </div>

      <section class="mt-4" aria-labelledby="hubs-h">
        <div class="row between" style="margin-bottom:10px"><h2 id="hubs-h" class="section-title">${scopeHub() ? "Your hub" : "Hubs"}</h2>
          <a class="btn sm" href="/hubs" data-link>All hubs and people</a></div>
        ${hubData.hubs.length ? html`<div class="grid three">${hubData.hubs.map(hubTile)}</div>`
          : html`<div class="card">${emptyState("No hubs yet", "Add your first hub to start adding people.", "store", can("manage_hubs") ? `<a class="btn primary" href="/hubs" data-link>Add a hub</a>` : "")}</div>`}
      </section>

      <div class="grid halves mt-4">
        ${pay ? html`<div class="card"><div class="card-head"><div><h2>Exceptions</h2><div class="sub">Flagged by the payroll rules</div></div>
          ${d.exceptions.length ? html`<a class="btn sm" href="/approvals" data-link>Review</a>` : ""}</div>
          <div class="card-body flush" id="exceptions"></div></div>` : ""}
        <div class="card"><div class="card-head"><div><h2>Daily sheet completeness</h2><div class="sub">Working days without an entry</div></div>
          ${can("enter_data") ? html`<a class="btn sm" href="/daily" data-link>Fill in</a>` : ""}</div>
          <div class="card-body flush" id="complete"></div></div>
      </div>
      <details class="more-figures mt-4"><summary class="btn sm">More figures: top performers against target</summary>
        <div class="card mt-3"><div class="card-head"><div><h2>Top performers</h2><div class="sub">Business vs monthly target</div></div></div>
          <div class="card-body flush" id="top"></div></div></details></div>`;

    if (pay) $("#exceptions").innerHTML = d.exceptions.length
      ? d.exceptions.slice(0, 7).map((x) => html`
        <div class="list-item"><div class="avatar" style="background:var(--warning)">${initials(x.name)}</div>
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
    }).join("") : emptyState("No sellers yet", "", "users").toString();

    const incomplete = d.completeness.filter((c) => c.missing.length).sort((a, b) => b.missing.length - a.missing.length);
    $("#complete").innerHTML = !d.completeness.length ? emptyState("No active sellers", "", "users").toString()
      : !incomplete.length ? emptyState("All caught up", "Every working day so far has an entry.", "checkCircle").toString()
      : incomplete.slice(0, 7).map((c) => html`<div class="list-item">
          <div class="grow"><b>${c.name}</b><span>${c.hub} · missing ${c.missing.slice(0, 4).map((m) => m.slice(8)).join(", ")}${c.missing.length > 4 ? "…" : ""}</span></div>
          <div class="progress ${c.logged / c.expected >= 0.9 ? "green" : "amber"}" style="width:90px"><span style="width:${(c.logged / Math.max(1, c.expected)) * 100}%"></span></div>
          <span class="num" style="font-size:12px;width:48px;text-align:right">${c.logged}/${c.expected}</span></div>`).join("");

    // On a phone the summary cards stay up top and each section below opens on tap. Exceptions open first when there are any.
    if (isPhone()) foldCards([...el.querySelectorAll(".grid.halves > .card")], { open: pay && d.exceptions.length ? [0] : [] });
  },
};
