// Weekly sheet: a read-only view for the office. Nothing is entered here: each manager's week is worked out from the daily sheets
// (his own sales plus his team's). Daily entry stays with the hub.
import { get, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { exportButtons, $, html, money, pct, dataTable, emptyState, badge } from "../ui.js";

const dateText = (iso) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default {
  title: "Weekly sheet",
  periodic: true,
  async render({ el }) {
    const office = can("read") && !state.user.hub && !state.routeHub; // no hub chosen: list the hubs, not every manager mixed together
    const data = await get("/api/weekly-view" + qs({ period: state.period, hub: scopeHub() }));
    const pay = can("view_pay");
    if (office) {
      document.body.dataset.filters = "month"; // every hub is listed, so the hub choice is not shown
      const hubs = state.hubs.filter((h) => h.status === "active").map((h) => {
        const ms = data.filter((m) => m.hub === h.code);
        return { ...h, managers: ms.length };
      });
      el.innerHTML = html`<div class="weekly-page">
        <div class="page-head"><div><h1>Weekly sheet</h1><p>Each manager's weeks, hub by hub. Pick a hub to see its managers and their weeks.</p></div>
          <div class="actions">${exportButtons("weekly", { period: state.period, hub: "" })}</div></div>
        ${hubs.length ? html`<div class="card hs-list"><ul role="list">${hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/money" data-link>
          <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · ${h.managers} ${h.managers === 1 ? "manager" : "managers"}</span></span>
          <span class="hs-flags">${h.managers ? "" : badge("amber", "No sales")}</span>
          <span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div><p class="muted hs-hint">Tap a hub to see its managers and their weeks.</p>`
          : html`<div class="card">${emptyState("No hubs yet", "Add a hub first.", "store")}</div>`}</div>`;
      return;
    }
    const rows = data.flatMap((m) => m.weeks.map((w) => ({ ...m, w, key: m.manager_id + w.week_start })));
    el.innerHTML = html`<div class="weekly-page">
      <div class="page-head">
        <div><h1>Weekly sheet</h1><p>For viewing only. Each manager's week is worked out from the daily sheets: his own sales plus his team's.${pay ? " Commission is 20% when the week reaches his target, otherwise 15%. Rent and hub fee are taken every week, except that a retaining manager (month's sales below the limit) pays no rent." : ""}</p></div>
        <div class="actions">${exportButtons("weekly", { period: state.period, hub: scopeHub() })}</div>
      </div>
      <div class="card"><div class="card-body flush" id="grid"></div></div></div>`;
    const week = (r) => `${dateText(r.w.week_start)} – ${dateText(r.w.week_end)}`;
    $("#grid").innerHTML = rows.length ? dataTable({
      rows, sortable: false, pageSize: 50, caption: "Managers' weeks",
      // A heading for each manager with their month, then that manager's weeks.
      groupBy: (r) => r.manager_id,
      groupLabel: (key, rs) => `<b>${rs[0].name}</b> <span class="muted">· ${rs[0].hub} · ${rs.length} ${rs.length === 1 ? "week" : "weeks"}</span>${rs[0].retaining ? ` <span class="badge amber">Retaining: no rent</span>` : ""}`,
      card: (r) => html`<span class="mc-main"><b>${week(r)}</b>${pay ? html`<span class="mc-sub">Balance <span class="${r.w.weekly_balance < 0 ? "neg" : ""}">${money(r.w.weekly_balance)}</span></span>` : ""}</span><span class="mc-val">Rs ${money(r.w.business_total)}</span>`,
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
