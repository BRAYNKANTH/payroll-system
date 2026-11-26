// Stock overview for one hub, for a chosen period: what came from the office, what was given to sellers and what sold in that period,
// and (as of now) what the hub and each seller hold. For a coacher (and a manager who is a stock keeper).
// The actions that change stock stay on Give stock; this page is for reading.
import { get, qs } from "../api.js";
import { state, scopeHub, can } from "../app.js";
import { $, html, icon, badge, dataTable, emptyState, initials, levelLabel } from "../ui.js";
import { mountRange, rangeText } from "../range.js";

const dateText = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const n0 = (n) => Number(n).toLocaleString("en-LK");

export default {
  title: "Hub stock",
  async render({ el }) {
    const code = scopeHub();
    const isManager = state.user.role === "manager";
    const showSold = can("read"); // a stock-keeper manager sees what sellers hold, never how much they sold
    const base = isManager ? "" : `/hubs/${encodeURIComponent(code)}/stock`;
    const link = (path, label, ic, primary) => html`<a class="btn ${primary ? "primary" : ""}" href="${path}" data-link>${icon(ic)} ${label}</a>`;
    const level = (p) => (p.in_hub <= 0 ? ["red", "Out"] : p.in_hub <= Math.max(10, Math.round(p.received * 0.1)) ? ["amber", "Low"] : ["green", "Enough"]);

    el.innerHTML = html`<div class="stockv-page">
      <div class="page-head">
        <div><h1>Hub stock</h1><p id="sv-sub">Stock sent by the office stays in the hub until you give it to sellers. Sellers keep what they have from day to day.</p></div>
        <div class="actions">${link(isManager ? "/morning" : base + "/give", "Give stock to sellers", "plus", true)}${isManager ? "" : link(base + "/count", "Stock count", "sheet")}${isManager ? "" : link(base + "/sheet", "Hub count sheet", "store")}</div>
      </div>
      <div id="sv-range" class="mb-4"></div>
      <div id="sv"><div class="loading-screen"><div class="spinner"></div></div></div></div>`.toString();

    let seq = 0;
    const load = async (r) => {
      const mine = ++seq;
      const d = await get("/api/stock-overview" + qs({ hub: code, from: r.from, to: r.to }));
      if (mine !== seq) return; // a newer choice is already on its way
      draw(d, r);
    };

    const draw = (d, r) => {
      const t = d.totals;
      const hasStock = d.products.some((p) => p.received > 0);
      $("#sv-sub").textContent = `${d.hub.name} · ${rangeText(r)}. The period numbers follow the dates you choose; "in the hub" and "with sellers" are what is held now.`;
      $("#sv").innerHTML = html`
        <div class="grid kpis ${showSold ? "kpis-3" : ""} mb-4">
          <div class="card kpi"><div class="label"><span class="icon blue">${icon("warehouse")}</span>Received from the office</div><div class="value">${n0(t.received_in)}</div><div class="foot">Pieces, ${rangeText(r)}</div></div>
          <div class="card kpi"><div class="label"><span class="icon">${icon("users")}</span>Given to sellers</div><div class="value">${n0(t.given_in)}</div><div class="foot">Pieces, ${rangeText(r)}</div></div>
          ${showSold ? html`<div class="card kpi"><div class="label"><span class="icon amber">${icon("trend")}</span>Sold</div><div class="value">${n0(t.sold_in)}</div><div class="foot">Pieces recorded on the tills, ${rangeText(r)}</div></div>` : ""}
        </div>

        ${hasStock ? "" : html`<div class="alert warn mb-4">${icon("box")}<div><b>The hub has no stock yet.</b> The office sends stock to the hub first. It appears here as soon as it is sent.</div></div>`}

        <section class="card mb-4" aria-label="Stock by product"><div class="card-head"><div><h2>By product</h2><div class="sub">Received, given and sold in the period; in the hub and with sellers are as of now</div></div></div>
          <div class="card-body flush" id="byprod"></div></section>

        <section class="card mb-4" aria-label="Stock with each seller"><div class="card-head"><div><h2>With each seller</h2><div class="sub">Carried over is what they held when the period began</div></div></div>
          <div class="card-body flush" id="bysell"></div></section>

        <div class="grid halves">
          <section class="card" aria-label="Stock received from the office"><div class="card-head"><div><h2>Received from the office</h2><div class="sub">${rangeText(r)}</div></div></div><div class="card-body flush" id="recv"></div></section>
          <section class="card" aria-label="Stock given to sellers"><div class="card-head"><div><h2>Given to sellers</h2><div class="sub">${rangeText(r)}</div></div></div><div class="card-body flush" id="gave"></div></section>
        </div>`.toString();

      $("#byprod").innerHTML = d.products.length ? dataTable({
        rows: d.products, footer: true, empty: "No products yet", emptyHint: "Add products so they can be sent to hubs and sold.",
        cols: [
          { key: "product", label: "Product", render: (p) => html`<b>${p.product}</b>`, total: () => "Total" },
          { key: "received_in", label: "Received", align: "r", total: (rs) => n0(rs.reduce((a, x) => a + x.received_in, 0)) },
          { key: "given_in", label: "Given to sellers", align: "r", total: (rs) => n0(rs.reduce((a, x) => a + x.given_in, 0)) },
          ...(showSold ? [{ key: "sold_in", label: "Sold", align: "r", total: (rs) => n0(rs.reduce((a, x) => a + x.sold_in, 0)) }] : []),
          { key: "in_hub", label: "In the hub now", align: "r", render: (p) => html`<b>${n0(p.in_hub)}</b>`, total: (rs) => n0(rs.reduce((a, x) => a + x.in_hub, 0)) },
          { key: "with_sellers", label: "With sellers now", align: "r", total: (rs) => n0(rs.reduce((a, x) => a + x.with_sellers, 0)) },
          { key: "status", label: "Hub stock", sort: false, render: (p) => { const [tone, text] = level(p); return badge(tone, text); } },
        ],
      }).toString() : emptyState("No products yet", "The office adds products first.", "box").toString();

      $("#bysell").innerHTML = d.sellers.length ? dataTable({
        rows: d.sellers, empty: "No sellers in this hub yet", emptyHint: "Add sellers to this hub on the Employees page.",
        groupBy: (s) => s.team.id,
        groupLabel: (key, rs) => `<b>${rs[0].team.title}</b> <span class="muted">· ${rs.length} ${rs.length === 1 ? "seller" : "sellers"} · ${n0(rs.reduce((a, x) => a + x.left, 0))} pieces held</span>`,
        card: (s) => html`<span class="mc-main"><b>${s.name}</b><span class="mc-sub">${s.employee_id} · ${levelLabel(s.staff_level)}</span></span><span class="mc-end">${n0(s.left)} left${showSold ? html`<br><span class="muted">sold ${n0(s.sold_in)}</span>` : ""}</span>`,
        cols: [
          { key: "name", label: "Seller", render: (s) => html`<div class="who"><div class="avatar">${initials(s.name)}</div><div><b>${s.name}</b><span>${s.employee_id} · ${levelLabel(s.staff_level)}</span></div></div>` },
          { key: "carried_in", label: "Carried over", align: "r" },
          { key: "given_in", label: "Given", align: "r" },
          ...(showSold ? [{ key: "sold_in", label: "Sold", align: "r" }] : []),
          { key: "left", label: "Left now", align: "r", render: (s) => html`<b class="${s.left < 1 ? "neg" : ""}">${n0(s.left)}</b>` },
          { key: "items", label: "What they hold", sort: false, render: (s) => (s.items.length ? html`<div class="mc-chips">${s.items.slice(0, 3).map((i) => html`<span class="mc-chip">${i.left} × ${i.product}</span>`)}${s.items.length > 3 ? html`<span class="muted">+${s.items.length - 3} more</span>` : ""}</div>` : html`<span class="muted">Nothing</span>`) },
        ],
      }).toString() : emptyState("No sellers yet", "Add distributors, supervisors or managers to this hub first.", "users").toString();

      const list = (rows, line) => (rows.length ? html`<ul class="os-list stockv-list">${rows.map(line)}</ul>` : html`<p class="muted" style="padding:16px 20px;margin:0">Nothing in this period.</p>`);
      $("#recv").innerHTML = list(d.received, (x) => html`<li><span><b>+${x.qty}</b> ${x.product}<span class="muted"> · ${dateText(x.date)}${x.note ? ` · ${x.note}` : ""}</span></span><span class="muted">by ${x.by}</span></li>`).toString();
      $("#gave").innerHTML = list(d.gave, (x) => html`<li><span><b>${x.qty}</b> ${x.product} → ${x.seller}<span class="muted"> · ${dateText(x.date)}</span></span><span class="muted">by ${x.by}</span></li>`).toString();
    };

    const picker = mountRange($("#sv-range"), { page: "hubstock", fallback: "today", onChange: (r) => load(r).catch(() => {}) });
    await load(picker.get());
  },
};
