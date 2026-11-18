// Stock overview for one hub: what came from the office, what was given to sellers, what the hub and the sellers hold, and what sold today.
// For a coacher (and a manager who is a stock keeper). The actions that change stock stay on Morning stock; this page is for reading.
import { get, qs } from "../api.js";
import { state, scopeHub } from "../app.js";
import { $, html, icon, badge, dataTable, emptyState, initials, levelLabel } from "../ui.js";

const dateText = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const n0 = (n) => Number(n).toLocaleString("en-LK");

export default {
  title: "Stock overview",
  async render({ el }) {
    const code = scopeHub();
    const d = await get("/api/stock-overview" + qs({ hub: code }));
    const t = d.totals;
    const isManager = state.user.role === "manager";
    const base = isManager ? "" : `/hubs/${encodeURIComponent(d.hub.code)}/stock`;
    const link = (path, label, ic, primary) => html`<a class="btn ${primary ? "primary" : ""}" href="${path}" data-link>${icon(ic)} ${label}</a>`;
    const level = (p) => (p.in_hub <= 0 ? ["red", "Out"] : p.in_hub <= Math.max(10, Math.round(p.received * 0.1)) ? ["amber", "Low"] : ["green", "Enough"]);
    const hasStock = d.products.some((p) => p.received > 0);

    el.innerHTML = html`<div class="stockv-page">
      <div class="page-head">
        <div><h1>Stock overview</h1><p>${d.hub.name} · as of today. What came from the office, what the hub holds, and what the sellers hold and sold.</p></div>
        <div class="actions">${link(isManager ? "/morning" : base, "Give stock to sellers", "plus", true)}${isManager ? "" : link(base + "/count", "Stock count", "sheet")}${isManager ? "" : link(base + "/sheet", "Hub stock sheet", "store")}</div>
      </div>

      <div class="grid kpis mb-4">
        <div class="card kpi"><div class="label"><span class="icon blue">${icon("warehouse")}</span>Received from the office</div><div class="value">${n0(t.received)}</div><div class="foot">Pieces, all time</div></div>
        <div class="card kpi"><div class="label"><span class="icon green">${icon("box")}</span>In the hub now</div><div class="value">${n0(t.in_hub)}</div><div class="foot">Ready to give to sellers</div></div>
        <div class="card kpi"><div class="label"><span class="icon">${icon("users")}</span>With the sellers</div><div class="value">${n0(t.with_sellers)}</div><div class="foot">Given out, not sold yet${t.given_today ? ` · ${n0(t.given_today)} given today` : ""}</div></div>
        <div class="card kpi"><div class="label"><span class="icon amber">${icon("trend")}</span>Sold today</div><div class="value">${n0(t.sold_today)}</div><div class="foot">Pieces recorded on the tills</div></div>
      </div>

      ${hasStock ? "" : html`<div class="alert warn mb-4">${icon("box")}<div><b>The hub has no stock yet.</b> The office sends stock to the hub first. It appears here as soon as it is sent.</div></div>`}

      <section class="card mb-4" aria-label="Stock by product"><div class="card-head"><div><h2>By product</h2><div class="sub">Received − given to sellers = in the hub</div></div></div>
        <div class="card-body flush" id="byprod"></div></section>

      <section class="card mb-4" aria-label="Stock with each seller"><div class="card-head"><div><h2>With each seller</h2><div class="sub">Stock carried over from earlier days is included</div></div></div>
        <div class="card-body flush" id="bysell"></div></section>

      <div class="grid halves">
        <section class="card" aria-label="Stock received from the office"><div class="card-head"><div><h2>Received from the office</h2><div class="sub">Latest 20</div></div></div><div class="card-body flush" id="recv"></div></section>
        <section class="card" aria-label="Stock given to sellers"><div class="card-head"><div><h2>Given to sellers</h2><div class="sub">Latest 20</div></div></div><div class="card-body flush" id="gave"></div></section>
      </div></div>`.toString();

    $("#byprod").innerHTML = d.products.length ? dataTable({
      rows: d.products, footer: true, empty: "No products yet",
      cols: [
        { key: "product", label: "Product", render: (p) => html`<b>${p.product}</b>`, total: () => "Total" },
        { key: "received", label: "Received", align: "r", total: (rs) => n0(rs.reduce((a, r) => a + r.received, 0)) },
        { key: "given", label: "Given to sellers", align: "r", total: (rs) => n0(rs.reduce((a, r) => a + r.given, 0)) },
        { key: "in_hub", label: "In the hub", align: "r", render: (p) => html`<b>${n0(p.in_hub)}</b>`, total: (rs) => n0(rs.reduce((a, r) => a + r.in_hub, 0)) },
        { key: "with_sellers", label: "With sellers", align: "r", total: (rs) => n0(rs.reduce((a, r) => a + r.with_sellers, 0)) },
        { key: "sold_today", label: "Sold today", align: "r", total: (rs) => n0(rs.reduce((a, r) => a + r.sold_today, 0)) },
        { key: "sold_month", label: "Sold this month", align: "r", total: (rs) => n0(rs.reduce((a, r) => a + r.sold_month, 0)) },
        { key: "status", label: "Hub stock", sort: false, render: (p) => { const [tone, text] = level(p); return badge(tone, text); } },
      ],
    }).toString() : emptyState("No products yet", "The office adds products first.", "box").toString();

    $("#bysell").innerHTML = d.sellers.length ? dataTable({
      rows: d.sellers, empty: "No sellers in this hub yet",
      groupBy: (s) => s.team.id,
      groupLabel: (key, rs) => `<b>${rs[0].team.title}</b> <span class="muted">· ${rs.length} ${rs.length === 1 ? "seller" : "sellers"} · ${n0(rs.reduce((a, r) => a + r.left, 0))} pieces held</span>`,
      card: (s) => html`<span class="mc-main"><b>${s.name}</b><span class="mc-sub">${s.employee_id} · ${levelLabel(s.staff_level)}</span></span><span class="mc-end">${n0(s.left)} left<br><span class="muted">sold ${n0(s.sold_today)} today</span></span>`,
      cols: [
        { key: "name", label: "Seller", render: (s) => html`<div class="who"><div class="avatar">${initials(s.name)}</div><div><b>${s.name}</b><span>${s.employee_id} · ${levelLabel(s.staff_level)}</span></div></div>` },
        { key: "carried", label: "Carried over", align: "r" },
        { key: "given_today", label: "Given today", align: "r" },
        { key: "sold_today", label: "Sold today", align: "r" },
        { key: "left", label: "Left now", align: "r", render: (s) => html`<b class="${s.left < 1 ? "neg" : ""}">${n0(s.left)}</b>` },
        { key: "items", label: "What they hold", sort: false, render: (s) => (s.items.length ? html`<div class="mc-chips">${s.items.slice(0, 3).map((i) => html`<span class="mc-chip">${i.left} × ${i.product}</span>`)}${s.items.length > 3 ? html`<span class="muted">+${s.items.length - 3} more</span>` : ""}</div>` : html`<span class="muted">Nothing</span>`) },
      ],
    }).toString() : emptyState("No sellers yet", "Add distributors, supervisors or managers to this hub first.", "users").toString();

    const list = (rows, line) => (rows.length ? html`<ul class="os-list stockv-list">${rows.map(line)}</ul>` : html`<p class="muted" style="padding:16px 20px;margin:0">Nothing yet.</p>`);
    $("#recv").innerHTML = list(d.received, (r) => html`<li><span><b>+${r.qty}</b> ${r.product}<span class="muted"> · ${dateText(r.date)}${r.note ? ` · ${r.note}` : ""}</span></span><span class="muted">by ${r.by}</span></li>`).toString();
    $("#gave").innerHTML = list(d.gave, (r) => html`<li><span><b>${r.qty}</b> ${r.product} → ${r.seller}<span class="muted"> · ${dateText(r.date)}</span></span><span class="muted">by ${r.by}</span></li>`).toString();
  },
};
