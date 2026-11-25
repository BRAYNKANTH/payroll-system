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

// What is waiting for a hub head today. Each line is one tap to the place where it is done.
function todoCard(hub, unconfirmed, noStock) {
  const h = encodeURIComponent(hub);
  const row = (href, ic, tone, title, sub) => html`<li><a class="hs-row todo-row" href="${href}" data-link><span class="todo-ic ${tone}">${icon(ic)}</span>
    <span class="hs-main"><b>${title}</b><span class="muted">${sub}</span></span><span class="hs-chev" aria-hidden="true"></span></a></li>`;
  const rows = [
    unconfirmed ? row(`/hubs/${h}/sales`, "check", "amber", `${unconfirmed} ${unconfirmed === 1 ? "day" : "days"} to confirm`, "Sellers entered these. Check them and confirm.") : "",
    noStock ? row(`/hubs/${h}/stock/give`, "box", "red", `${noStock} ${noStock === 1 ? "seller has" : "sellers have"} no stock`, "Give them today's stock.") : "",
  ].filter(Boolean);
  const done = html`<li class="todo-done"><span class="todo-ic green">${icon("checkCircle")}</span><span class="hs-main"><b>All done</b><span class="muted">Nothing is waiting. The hub is up to date.</span></span></li>`;
  return html`<section class="card hs-list todo mb-4" aria-label="To do"><div class="todo-head"><b>To do</b></div><ul role="list">${rows.length ? rows : done}</ul></section>`;
}

export default {
  title: "Dashboard",
  periodic: true,
  async render({ el }) {
    const pay = can("view_pay"); // without it the server has already removed every pay figure
    const first = state.user.full_name.split(" ")[0];
    el.innerHTML = html`<div class="dash dash-min">
      <div class="page-head"><div><h1>${greeting()}, ${first}</h1><p id="dash-sub"></p></div></div>
      <div id="dash-todo"></div>
      <div id="dash-range" class="mb-4"></div>
      <div id="dash-body"><div class="loading-screen"><div class="spinner"></div></div></div></div>`.toString();

    // "This month" follows the month chosen at the top (the pay month), so the sales here and the salaries below are for the same month.
    const lastDay = (p) => { const [y, m] = p.split("-").map(Number); return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
    const effective = (r) => (r.preset === "month" ? { ...r, from: `${state.period}-01`, to: state.period === today().slice(0, 7) ? today() : lastDay(state.period) } : r);

    let seq = 0, picker = null, hubData = null, todoStock;
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
      // Each hub is its own card: a coloured band with the hub's code in a circle, the name and headcount centred, then the numbers side by side.
      const ACCENTS = ["#0071e3", "#7c3aed", "#0f766e", "#c2410c", "#db2777", "#4f46e5"];
      const hubTile = (h, i) => {
        const x = info[h.code], st = stats[h.code] || {};
        return html`<a class="card hub-tile ht" style="--hc:${ACCENTS[i % ACCENTS.length]}" href="/hubs/${encodeURIComponent(h.code)}" data-link aria-label="${h.name}: open this hub">
          <span class="ht-badge" aria-hidden="true">${h.code}</span>
          <b class="ht-name">${h.name}</b>
          <span class="ht-count">${plural(x.active.length, "person", "people")}${h.status !== "active" ? " · inactive" : ""}</span>
          ${x.attention.length ? html`<span class="ht-chips">${x.attention.map(([tone, text]) => badge(tone, text))}</span>` : ""}
          <span class="ht-nums ${pay ? "" : "one"}"><span class="ht-stat"><small>Sales</small><b class="num">${compact(st.hub_business || 0)}</b></span>
            ${pay ? html`<span class="ht-stat"><small>Salaries</small><b class="num">${compact(st.to_bank || 0)}</b></span>` : ""}</span>
          <span class="ht-open">Open hub</span></a>`;
      };
      // A hub head's day starts with what is waiting for them: days sellers entered that need confirming, and sellers with no stock to sell.
      if (state.user.hub && can("enter_data")) {
        if (todoStock === undefined) todoStock = await get("/api/stock-issues").then((x) => x.hubs?.[0]?.without_stock ?? 0).catch(() => null);
        $("#dash-todo").innerHTML = todoCard(state.user.hub, d.by_hub[0]?.unconfirmed || 0, todoStock || 0).toString();
      }
      $("#dash-sub").innerHTML = html`${monthName(d.period)} · ${badge(d.status)}`.toString();
      $("#dash-body").innerHTML = html`
        ${pay ? monthCard(d, k) : ""}

        <div class="grid kpis">
          ${kpi("Business", money(k.hub_business), rangeText(r))}
          ${kpi("Cash short", money(k.settle_up), `Sales minus cash handed in, ${rangeText(r)}`)}
          ${kpi("Stock short", money(k.stock_shortfall), `From the stock count for ${monthName(d.period)}`)}
        </div>

        ${scopeHub() ? "" : html`<section class="mt-5" aria-labelledby="hubs-h">
          <div class="row between" style="margin-bottom:12px"><h2 id="hubs-h" class="section-title">${scopeHub() ? "Your hub" : "Hubs"}</h2>
            <a class="btn sm" href="/hubs" data-link>All hubs and people</a></div>
          ${hubData.hubs.length ? html`<div class="grid three">${hubData.hubs.map(hubTile)}</div>`
            : html`<div class="card">${emptyState("No hubs yet", "Add your first hub to start adding people.", "store", can("manage_hubs") ? `<a class="btn primary" href="/hubs" data-link>Add a hub</a>` : "")}</div>`}
        </section>`}`.toString();
    };
    picker = mountRange($("#dash-range"), { page: "dashboard", fallback: "month", resolve: effective, onChange: () => load().catch((e) => toast(e.message, "warn")) });
    await load();
  },
};
