import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, html, icon, money, compact, badge, monthName, emptyState, raw, toast } from "../ui.js";
import { mountRange, rangeText, today } from "../range.js";
import { loadHubData, hubInfo, plural } from "../hubinfo.js";

// The home page is deliberately small: where this month stands, three figures, and one card per hub.
const kpi = (label, value, foot = "") => html`
  <div class="card kpi"><div class="label">${label}</div>
  <div class="value"><small>Rs</small>${value}</div>${foot ? html`<div class="foot">${raw(foot)}</div>` : ""}</div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// Where this month stands and the one thing to do next.
function monthCard(d, k) {
  const done = d.status === "finalized";
  let say, go;
  if (done) { say = "This month is closed. Salaries and payslips are ready to view."; go = ["/payroll", "View salaries", "wallet"]; }
  else if (!k.calculated) { say = "Salaries have not been worked out yet. Finish the daily sheets, then work them out."; go = can("run_payroll") ? ["/payroll", "Work out salaries", "wallet"] : can("enter_data") ? ["/daily", "Open the daily sheet", "sheet"] : null; }
  else { say = "Salaries are worked out and ready to view."; go = can("view_pay") ? ["/payroll", "View salaries", "wallet"] : null; }
  return html`<section class="card month-card" aria-label="Where this month stands">
    <div class="mc-left"><h2>${monthName(d.period)}</h2><p>${say}</p>
      ${go ? html`<a class="btn primary" href="${go[0]}" data-link>${icon(go[2])} ${go[1]}</a>` : ""}</div>
    <dl class="mc-right"><div><dt>Salaries (everyone)</dt><dd>${k.calculated ? html`<small>Rs</small>${money(k.to_bank)}` : "Not calculated"}</dd></div></dl>
  </section>`;
}

export default {
  title: "Dashboard",
  periodic: true,
  async render({ el }) {
    const pay = can("view_pay"); // without it the server has already removed every pay figure
    const first = state.user.full_name.split(" ")[0];
    el.innerHTML = html`<div class="dash dash-min">
      <div class="page-head"><div><h1>${greeting()}, ${first}</h1><p id="dash-sub"></p></div></div>
      <div id="dash-range" class="mb-4"></div>
      <div id="dash-body"><div class="loading-screen"><div class="spinner"></div></div></div></div>`.toString();

    // "This month" follows the month chosen at the top (the pay month), so the sales here and the salaries below are for the same month.
    const lastDay = (p) => { const [y, m] = p.split("-").map(Number); return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
    const effective = (r) => (r.preset === "month" ? { ...r, from: `${state.period}-01`, to: state.period === today().slice(0, 7) ? today() : lastDay(state.period) } : r);

    let seq = 0, picker = null, hubData = null;
    const load = async () => {
      const mine = ++seq, r = picker.get();
      const dashP = get("/api/dashboard" + qs({ period: state.period, hub: scopeHub(), from: r.from, to: r.to }));
      // The hub list, people and review queue are fetched once, alongside the first dashboard answer; later date changes only ask for the numbers.
      if (!hubData) hubData = await loadHubData(state.period, pay, dashP);
      const d = await dashP;
      if (mine !== seq) return;
      const k = d.kpis;
      const info = hubInfo(hubData, state.period);
      const stats = Object.fromEntries(d.by_hub.map((h) => [h.code, h]));
      // One card per hub: people, sales for the chosen dates and (for those who may see pay) salaries. The whole card opens the hub.
      const hubTile = (h) => {
        const x = info[h.code], st = stats[h.code] || {};
        return html`<a class="card hub-tile" href="/hubs/${encodeURIComponent(h.code)}" data-link>
          <span class="hub-top"><b class="hub-name">${h.name}</b><span class="faint">${h.code}${h.status !== "active" ? " · inactive" : ""}</span></span>
          <span class="hub-count">${plural(x.active.length, "person", "people")}</span>
          <span class="hub-nums"><span><small>Sales</small><b class="num">${compact(st.hub_business || 0)}</b></span>
            ${pay ? html`<span><small>Salaries</small><b class="num">${compact(st.to_bank || 0)}</b></span>` : ""}</span></a>`;
      };
      $("#dash-sub").innerHTML = html`${monthName(d.period)} · ${badge(d.status)}`.toString();
      $("#dash-body").innerHTML = html`
        ${pay ? monthCard(d, k) : ""}

        <div class="grid kpis">
          ${kpi("Business", money(k.hub_business), rangeText(r))}
          ${kpi("Cash short", money(k.settle_up), `Sales minus cash handed in, ${rangeText(r)}`)}
          ${kpi("Stock short", money(k.stock_shortfall), `From the stock count for ${monthName(d.period)}`)}
        </div>

        <section class="mt-5" aria-labelledby="hubs-h">
          <div class="row between" style="margin-bottom:12px"><h2 id="hubs-h" class="section-title">${scopeHub() ? "Your hub" : "Hubs"}</h2>
            <a class="btn sm" href="/hubs" data-link>All hubs and people</a></div>
          ${hubData.hubs.length ? html`<div class="grid three">${hubData.hubs.map(hubTile)}</div>`
            : html`<div class="card">${emptyState("No hubs yet", "Add your first hub to start adding people.", "store", can("manage_hubs") ? `<a class="btn primary" href="/hubs" data-link>Add a hub</a>` : "")}</div>`}
        </section>`.toString();
    };
    picker = mountRange($("#dash-range"), { page: "dashboard", fallback: "month", resolve: effective, onChange: () => load().catch((e) => toast(e.message, "warn")) });
    await load();
  },
};
