import { get, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, money, compact, badge, monthName, emptyState, raw, toast } from "../ui.js";
import { mountRange, rangeText, today } from "../range.js";

// The home page is deliberately small: what is waiting, one card per hub, and three figures for all hubs together.
const kpi = (label, value, foot = "") => html`
  <div class="card kpi"><div class="label">${label}</div>
  <div class="value"><small>Rs</small>${value}</div>${foot ? html`<div class="foot">${raw(foot)}</div>` : ""}</div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// What is waiting for a hub head today. Each line is one tap to the place where it is done.
function todoCard(hub, unconfirmed, noStock, cash) {
  const h = encodeURIComponent(hub);
  const row = (href, ic, tone, title, sub) => html`<li><a class="hs-row todo-row" href="${href}" data-link><span class="todo-ic ${tone}">${icon(ic)}</span>
    <span class="hs-main"><b>${title}</b><span class="muted">${sub}</span></span><span class="hs-chev" aria-hidden="true"></span></a></li>`;
  const rows = [
    unconfirmed ? row(`/hubs/${h}/sales`, "check", "amber", `${unconfirmed} ${unconfirmed === 1 ? "day" : "days"} to confirm`, "Sellers entered these. Check them and confirm.") : "",
    noStock ? row(`/hubs/${h}/stock/give`, "box", "red", `${noStock} ${noStock === 1 ? "seller has" : "sellers have"} no stock`, "Give them today's stock.") : "",
    // Today's cash goes to the office: at least 90% of the day's sales. Shown until it is handed over, and again if the office sends it back.
    cash?.sales > 0 && !cash.handover ? row(`/hubs/${h}/sales/handover`, "wallet", "amber", "Hand over today's cash", `At least Rs ${money(cash.min)} (90% of today's sales of Rs ${money(cash.sales)}).`) : "",
    cash?.handover?.status === "rejected" ? row(`/hubs/${h}/sales/handover`, "wallet", "red", "The office sent today's handover back", cash.handover.verify_note || "Correct the amount and hand it over again.") : "",
  ].filter(Boolean);
  const done = html`<li class="todo-done"><span class="todo-ic green">${icon("checkCircle")}</span><span class="hs-main"><b>All done</b><span class="muted">Nothing is waiting. The hub is up to date.</span></span></li>`;
  return html`<section class="card hs-list todo mb-4" aria-label="To do"><div class="todo-head"><b>To do</b></div><ul role="list">${rows.length ? rows : done}</ul></section>`;
}

// The month in order, for the office: each step is done or not, worked out from the real data. The first step not done is "Next", and every
// line is one tap to the place where it is done. (Cash handovers are the only thing that is per hub.)
function officeTodo(d, k, noStock, cash) {
  const wait = d.by_hub.filter((h) => h.unconfirmed), waitN = wait.reduce((t, h) => t + h.unconfirmed, 0);
  const dry = noStock.filter((h) => h.without_stock), dryN = dry.reduce((t, h) => t + h.without_stock, 0);
  const closed = d.status === "finalized";
  const canPay = can("run_payroll") || can("view_pay");
  const steps = [
    { done: dryN === 0, href: dryN ? `/hubs/${encodeURIComponent(dry[0].code)}/stock/give` : "/hub-stock", ic: "box",
      title: "Stock is with the sellers", ok: "Every seller has stock to sell.", todo: `${dryN} ${dryN === 1 ? "seller has" : "sellers have"} no stock. Send stock to the hub, then the coacher gives it out.` },
    { done: !k.missing_days_past, href: "/daily", ic: "sheet",
      title: "Every day is entered", ok: "Every working day so far has a sheet.", todo: `${k.missing_days_past} ${k.missing_days_past === 1 ? "day is" : "days are"} still missing a sheet. The coacher enters them on the daily sheet.` },
    { done: waitN === 0, href: "/live", ic: "eye",
      title: "Sellers' own days are confirmed", ok: "Nothing is waiting to be confirmed.", todo: `${waitN} ${waitN === 1 ? "day" : "days"} to confirm. ${wait.map((h) => `${h.name}: ${h.unconfirmed}`).join(" · ")}` },
    ...(can("approve_cash") ? [{ done: cash.length === 0, href: "/handovers", ic: "wallet",
      title: "Cash handovers are verified", ok: "Every handover has been checked.", todo: `${cash.length} ${cash.length === 1 ? "handover" : "handovers"} to verify. ${cash.map((c) => `${c.hub_name}: Rs ${money(c.amount)}`).join(" · ")}` }] : []),
    { done: k.stock_counted > 0, href: "/stock", ic: "box",
      title: "Stock is counted for the month", ok: "The stock count is in.", todo: "No stock count yet. It decides what is taken off for missing stock." },
    ...(canPay ? [
      { done: k.calculated, href: "/payroll", ic: "play",
        title: "Salaries are worked out", ok: `Rs ${money(k.to_bank)} for everyone.`, todo: "Press Work out salaries once the sheets above are done." },
      { done: closed, href: "/payroll", ic: "lock",
        title: "The month is closed", ok: "Salaries and payslips are ready to view.", todo: "Check the salaries and payslips, then close the month. It locks the sheets." },
      { done: k.calculated && !k.unpaid, href: "/payroll", ic: "wallet",
        title: "Everyone is paid", ok: "Every salary is marked as paid.", todo: k.calculated ? `${k.unpaid} ${k.unpaid === 1 ? "salary is" : "salaries are"} still to be paid. Pay them, then press Mark as paid on the Payroll page.` : "Work out the salaries first." },
    ] : []),
  ];
  const next = steps.findIndex((x) => !x.done), left = steps.filter((x) => !x.done).length;
  const row = (x, i) => html`<li><a class="hs-row todo-row ${i === next ? "is-next" : ""}" href="${x.href}" data-link>
    <span class="todo-ic ${x.done ? "green" : i === next ? "blue" : "amber"}">${icon(x.done ? "checkCircle" : x.ic)}</span>
    <span class="hs-main"><b><span class="step-n">${i + 1}.</span> ${x.title}${i === next ? html` <span class="badge blue">Next</span>` : ""}</b><span class="muted">${x.done ? x.ok : x.todo}</span></span>
    <span class="hs-chev" aria-hidden="true"></span></a></li>`;
  return html`<section class="card hs-list todo mb-4" aria-label="This month in order"><div class="todo-head"><b>This month, step by step</b><span class="muted">${left ? `${steps.length - left} of ${steps.length} done` : "All steps done"}</span></div>
    <ul role="list">${steps.map(row)}</ul></section>`;
}

export default {
  filters: "month", // the hubs are listed on this page, so the hub choice is not shown; the month still is
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

    let seq = 0, picker = null, todoStock, officeStock;
    const load = async () => {
      const mine = ++seq, r = picker.get();
      const dashP = get("/api/dashboard" + qs({ period: state.period, hub: state.user.hub || "", from: r.from, to: r.to }));
      const d = await dashP;
      if (mine !== seq) return;
      const k = d.kpis;
      // A hub head's day starts with what is waiting for them: days sellers entered that need confirming, and sellers with no stock to sell.
      if (state.user.hub && can("enter_data")) {
        if (todoStock === undefined) todoStock = await get("/api/stock-issues").then((x) => x.hubs?.[0]?.without_stock ?? 0).catch(() => null);
        const cashToday = await get("/api/handovers/day" + qs({ date: today() })).then((x) => x.hubs?.[0] || null).catch(() => null);
        $("#dash-todo").innerHTML = todoCard(state.user.hub, d.by_hub[0]?.unconfirmed || 0, todoStock || 0, cashToday).toString();
      }
      if (!state.user.hub && can("read")) {
        if (officeStock === undefined) officeStock = await get("/api/stock-issues").then((x) => x.hubs || []).catch(() => null);
        const cashWaiting = await get("/api/handovers" + qs({ status: "pending", limit: 100 })).catch(() => []);
        $("#dash-todo").innerHTML = officeTodo(d, k, officeStock || [], cashWaiting).toString();
      }
      $("#dash-sub").innerHTML = html`${monthName(d.period)} · ${badge(d.status)}`.toString();
      // The office sees everyone together, best sellers first. Hubs matter only for the daily cash handover (see the To do list above).
      let everyone = "";
      if (!state.user.hub && can("read")) {
        const live = await get("/api/live" + qs({ period: state.period })).catch(() => null);
        const rows = live ? live.people.slice(0, 8) : [];
        everyone = html`<section aria-labelledby="ppl-h">
          <div class="row between" style="margin-bottom:12px"><h2 id="ppl-h" class="section-title">Best sellers this month</h2>
            <a class="btn sm" href="/live" data-link>All employees</a></div>
          ${rows.length ? html`<div class="card hs-list"><ul role="list">${rows.map((p) => html`<li><a class="hs-row" href="/employees/${encodeURIComponent(p.employee_id)}" data-link>
            <span class="hs-main"><b>${p.name}</b><span class="muted">${p.employee_id} · ${p.hub}${p.target_pct != null ? ` · ${Math.round(p.target_pct * 100)}% of target` : ""}</span></span>
            <span class="hs-flags"><b class="num">${money(p.business)}</b>${p.unconfirmed ? badge("amber", `${p.unconfirmed} to confirm`) : ""}</span><span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
            : html`<div class="card">${emptyState("No sales yet this month", "Sales appear here as they are entered.", "chart")}</div>`}
        </section>`;
      }
      $("#dash-body").innerHTML = html`
        ${everyone}
        <section class="${state.user.hub ? "" : "mt-5"}" aria-label="${state.user.hub ? "Your hub" : "All employees together"}">
          ${state.user.hub ? "" : html`<h2 class="section-title" style="margin-bottom:12px">All employees together</h2>`}
          <div class="grid kpis dash-kpis">
            ${kpi("Sales", money(k.hub_business), rangeText(r))}
            ${kpi("Cash short", money(k.settle_up), `Sales minus cash handed in, ${rangeText(r)}`)}
            ${kpi("Stock short", money(k.stock_shortfall), `From the stock count for ${monthName(d.period)}`)}
          </div>
        </section>`.toString();
    };
    picker = mountRange($("#dash-range"), { page: "dashboard", fallback: "month", resolve: effective, onChange: () => load().catch((e) => toast(e.message, "warn")) });
    await load();
  },
};
