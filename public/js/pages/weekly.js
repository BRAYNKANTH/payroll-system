// Weekly sheet: a read-only view for the office. Nothing is entered here: each manager's week is worked out from the daily sheets
// (his own sales plus his team's). Daily entry stays with the hub.
import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { exportButtons, $, html, money, pct, dataTable, emptyState } from "../ui.js";

const dateText = (iso) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default {
  title: "Weekly sheet",
  periodic: true,
  async render({ el }) {
    const data = await get("/api/weekly-view" + qs({ period: state.period, hub: scopeHub() }));
    const pay = can("view_pay");
    const rows = data.flatMap((m) => m.weeks.map((w) => ({ ...m, w, key: m.manager_id + w.week_start })));
    el.innerHTML = html`<div class="weekly-page">
      <div class="page-head">
        <div><h1>Weekly sheet</h1><p>For viewing only. Each manager's week is worked out from the daily sheets: his own sales plus his team's.${pay ? " Commission is 20% when the week reaches his target, otherwise 15%. Rent and hub fee are taken every week." : ""}</p></div>
        <div class="actions">${exportButtons("weekly", { period: state.period, hub: scopeHub() })}</div>
      </div>
      <div class="card"><div class="card-body flush" id="grid"></div></div></div>`;
    const week = (r) => `${dateText(r.w.week_start)} – ${dateText(r.w.week_end)}`;
    $("#grid").innerHTML = rows.length ? dataTable({
      rows, sortable: false, pageSize: 50, caption: "Managers' weeks",
      card: (r) => html`<span class="mc-main"><b>${week(r)}</b><span class="mc-sub">${r.name} · ${r.hub}</span></span><span class="mc-val">Rs ${money(r.w.business_total)}</span>`,
      cols: [
        { key: "name", label: "Manager", render: (r) => html`<b>${r.name}</b> <span class="faint">${r.hub}</span>` },
        { key: "week", label: "Week", render: week },
        { key: "business", label: "Business", align: "r", render: (r) => money(r.w.business_total) },
        ...(pay ? [
          { key: "pct", label: "Commission", align: "r", render: (r) => pct(r.w.profit_percent) },
          { key: "costs", label: "Rent + fees", align: "r", render: (r) => money(r.w.rent + r.w.hub_fee + r.w.security_cost + r.w.personal_draw) },
          { key: "bal", label: "Weekly balance", align: "r", render: (r) => html`<span class="${r.w.weekly_balance < 0 ? "neg" : ""}">${money(r.w.weekly_balance)}</span>` },
        ] : []),
      ],
    }).toString() : emptyState("No manager sales this month", "Weeks appear here once the daily sheets have sales.", "calendar").toString();
  },
};
