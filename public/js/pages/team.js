// My team: the page a manager lands on. It shows only the people who report to them (directly or through others):
// today's sales, the month so far, the stock each one holds and the days waiting to be confirmed. Sales and stock only, never pay.
import { get, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, compact, badge, initials, levelLabel, monthName, emptyState } from "../ui.js";
import { plural } from "../hubinfo.js";

export default {
  title: "My team",
  periodic: true,
  async render({ el }) {
    const d = await get("/api/team" + qs({ period: state.period }));
    const t = d.totals;
    const first = (state.user.full_name || "").split(" ")[0];
    const keeper = can("stock");

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>My team</h1><p>The people who report to you. Sales and stock for ${monthName(d.period)}.</p></div>
      </div>
      ${keeper ? html`<div class="alert info mb-4">${icon("box")}<div><b>You are a stock keeper.</b> You can give stock to everyone in the hub, not only your own people. <a class="btn sm" href="/morning" data-link>Open Give stock</a></div></div>` : ""}
      <div class="grid kpis mb-4">
        <div class="card kpi"><div class="label">People</div><div class="value">${t.people}</div><div class="foot">Reporting to you</div></div>
        <div class="card kpi"><div class="label">Sold today</div><div class="value"><small>Rs</small>${compact(t.today_business)}</div><div class="foot">By your people</div></div>
        <div class="card kpi"><div class="label">This month</div><div class="value"><small>Rs</small>${compact(t.month_business)}</div><div class="foot">${monthName(d.period)}</div></div>
        <div class="card kpi"><div class="label">Stock in hand</div><div class="value">${t.stock_pieces}</div><div class="foot">Pieces your people hold</div></div>
      </div>
      <section aria-label="Your people">
        ${d.members.length ? html`<div class="grid three">${d.members.map((m) => html`<a class="card hub-tile" href="/employees/${encodeURIComponent(m.employee_id)}" data-link>
          <span class="hub-top"><span class="row" style="gap:10px;align-items:center"><span class="avatar" aria-hidden="true">${initials(m.name)}</span><b class="hub-name">${m.name}</b></span><span class="faint">${m.employee_id}</span></span>
          <span class="muted hub-head">${levelLabel(m.staff_level)}</span>
          <span class="hub-nums"><span><small>Today</small><b class="num">${compact(m.today_business)}</b></span><span><small>This month</small><b class="num">${compact(m.month_business)}</b></span><span><small>Stock</small><b class="num">${m.stock_pieces}</b></span></span>
          <span class="hub-chips">${m.unconfirmed ? html`<span class="badge amber">${plural(m.unconfirmed, "day", "days")} waiting for the coacher</span>` : html`<span class="badge green">Up to date</span>`}${m.stock_pieces === 0 ? html`<span class="badge amber">No stock</span>` : ""}</span>
          <span class="hub-chev" aria-hidden="true">${icon("right")}</span></a>`)}</div>`
          : html`<div class="card">${emptyState("No one reports to you yet", `${first ? first + ", " : ""}people you are the manager of appear here.`, "users")}</div>`}
      </section>`;
  },
};
