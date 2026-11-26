// Team sales: the page a manager or promoting manager sees about their team. Only how much business the team did, in total: today, this month,
// and day by day. No names, no positions, no one's own figures, no pay, and nobody above them. Their own selling is on the Sell page.
import { get, qs } from "../api.js";
import { state } from "../app.js";
import { $, html, icon, money, monthName, dateLabel, emptyState } from "../ui.js";

const big = (label, value, foot = "") => html`<div class="card kpi"><div class="label">${label}</div>
  <div class="value"><small>Rs</small>${money(value)}</div>${foot ? html`<div class="foot">${foot}</div>` : ""}</div>`;

export default {
  title: "Team sales",
  filters: "month", // the month picker at the top chooses the month shown
  periodic: true,
  async render({ el }) {
    const d = await get("/api/team" + qs({ period: state.period }));
    const days = d.days || [];
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Team sales</h1><p>The business your team did, in total.</p></div>
        <div class="actions"><a class="btn primary" href="/me" data-link>${icon("bag")} Sell</a></div>
      </div>
      <div class="grid kpis mb-4">
        ${big("Today", d.business.today, "All of your team together")}
        ${big(monthName(d.period), d.business.month, `${days.length} ${days.length === 1 ? "day" : "days"} with sales`)}
      </div>
      <section class="card" aria-label="Day by day">
        <div class="card-head"><div><h2>Day by day</h2><div class="sub">${monthName(d.period)}</div></div></div>
        ${days.length ? html`<ul class="pos-lines" role="list">${days.map((x) => html`<li><span class="pos-l-main"><b>${dateLabel(x.date)}</b></span><b class="pos-l-amt">${money(x.business)}</b></li>`)}</ul>`
          : html`<div class="card-body">${emptyState("No sales yet this month", "When your team sells, the total shows here.", "chart")}</div>`}
      </section>`;
  },
};
