// Morning stock: the hub head or hub manager gives each seller their stock for the day.
// One card per seller shows what they carry over, what they were given today and what they have sold. "Give stock" opens a short list of products.
import { get, post, del, qs } from "../api.js";
import { state, scopeHub, can } from "../app.js";
import { $, $$, html, esc, icon, toast, busy, drawer, confirmDialog, emptyState, initials, levelLabel } from "../ui.js";

const rs = (c) => `Rs ${(Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 })}`;
const slToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const shift = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const label = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
let day = null;

export default {
  title: "Morning stock",
  async render(ctx) {
    const { el } = ctx;
    const today = slToday();
    day = day || today;
    const d = await get("/api/stock-issues" + qs({ date: day, hub: scopeHub() }));
    const hubName = (c) => state.hubs.find((h) => h.code === c)?.name || c;
    const isToday = day === today;
    const canGive = day <= today && day >= shift(today, -3);
    const hubs = [...new Set(d.sellers.map((s) => s.hub))];
    const givenTotal = d.sellers.reduce((t, s) => t + s.given.reduce((n, g) => n + g.qty, 0), 0);
    const without = d.sellers.filter((s) => !s.given.length && !s.carried.length).length;
    // The admin does not hand stock to sellers: the admin sees each hub with its coacher and what it holds. The coacher gives it out.
    const overview = can("manage_products") && !state.user.hub;
    const givenAll = (d.hubs || []).reduce((t, h) => t + h.given_pieces, 0);

    const card = (s) => html`<article class="mcard card" aria-label="${s.name}">
      <div class="mc-top"><div class="avatar" aria-hidden="true">${initials(s.name)}</div>
        <div class="mc-who"><b>${s.name}</b><span class="muted">${s.employee_id} · ${levelLabel(s.staff_level)}</span></div></div>
      <div class="mc-block"><span class="mc-label">Carried over</span>
        ${s.carried.length ? html`<div class="mc-chips">${s.carried.map((c) => html`<span class="mc-chip">${c.qty} × ${c.product}</span>`)}</div>` : html`<span class="muted">Nothing</span>`}</div>
      <div class="mc-block"><span class="mc-label">Given ${isToday ? "today" : "on this day"}</span>
        ${s.given.length ? html`<div class="mc-chips">${s.given.map((g) => html`<span class="mc-chip given">${g.qty} × ${g.product}${canGive ? html`<button type="button" class="mc-x" data-del="${g.id}" aria-label="Take back ${g.qty} ${g.product} from ${s.name}">${icon("x")}</button>` : ""}</span>`)}</div>` : html`<span class="muted">Nothing yet</span>`}</div>
      <div class="mc-foot"><span class="muted">${s.sold_pieces} ${s.sold_pieces === 1 ? "piece" : "pieces"} sold</span>
        ${canGive ? html`<button type="button" class="btn primary" data-give="${s.employee_id}">${icon("plus")} Give stock</button>` : ""}</div>
    </article>`;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Morning stock</h1><p>${overview ? "Each hub's coacher gives the stock out to the sellers. Here you see every hub, its coacher, what the hub holds and how much has been given out." : "Give each seller the stock they take out today. They see it on their phone and can only sell what they have."}</p></div>
      </div>
      <div class="card mb-4"><div class="card-body row between" style="gap:12px;flex-wrap:wrap">
        <div class="row" style="gap:8px;align-items:center">
          <button type="button" class="btn icon" id="d-prev" aria-label="Previous day">${icon("left")}</button>
          <div><b style="font-size:17px">${label(day)}</b>${isToday ? html` <span class="badge green">Today</span>` : ""}</div>
          <button type="button" class="btn icon" id="d-next" aria-label="Next day" ${day >= today ? "disabled" : ""}>${icon("right")}</button>
          ${isToday ? "" : html`<button type="button" class="btn sm" id="d-today">Back to today</button>`}
        </div>
        <div class="muted">${overview ? `${d.hubs.length} ${d.hubs.length === 1 ? "hub" : "hubs"} · ${givenAll} ${givenAll === 1 ? "piece" : "pieces"} given out` : `${d.sellers.length} ${d.sellers.length === 1 ? "seller" : "sellers"} · ${givenTotal} ${givenTotal === 1 ? "piece" : "pieces"} given${canGive && without ? ` · ${without} with no stock` : ""}`}</div>
      </div></div>
      ${overview ? "" : Object.entries(d.pools).map(([h, list]) => html`<section class="card mb-4" aria-label="${hubName(h)} stock"><div class="card-body">
        <div class="row between" style="gap:12px;flex-wrap:wrap;margin-bottom:8px"><b style="font-size:17px">${hubName(h)} stock</b><span class="muted">What the hub holds to give out to sellers</span></div>
        ${list.length ? html`<div class="mc-chips">${list.map((p) => html`<span class="mc-chip ${p.left > 0 ? "given" : ""}">${p.left} × ${p.product}</span>`)}</div>` : html`<span class="muted">No products yet.</span>`}
        ${list.length && list.every((p) => p.left === 0) ? html`<p class="muted" style="margin:10px 0 0">The hub has no stock to give out. The office sends stock to the hub first.</p>` : ""}</div></section>`)}
      ${!canGive ? html`<div class="alert info mb-4">${icon("info")}<div>${day > today ? "This day has not happened yet." : "Stock can be changed only for the last 3 days. You can still look at this day."}</div></div>` : ""}
      ${overview ? html`<div class="grid three">${d.hubs.map((h) => html`<article class="mcard card" aria-label="${h.name}">
          <div class="mc-top"><div class="avatar" aria-hidden="true">${h.code}</div><div class="mc-who"><b>${h.name}</b><span class="muted">${h.code}</span></div></div>
          <div class="mc-block"><span class="mc-label">Coacher</span>${h.coacher ? html`<b>${h.coacher.name}</b>` : html`<span class="mc-chip" style="background:var(--warning-soft);color:var(--warning)">No coacher yet</span>`}</div>
          <div class="mc-block"><span class="mc-label">Hub stock</span>${(d.pools[h.code] || []).length ? html`<div class="mc-chips">${d.pools[h.code].map((p) => html`<span class="mc-chip ${p.left > 0 ? "given" : ""}">${p.left} × ${p.product}</span>`)}</div>` : html`<span class="muted">No products yet</span>`}</div>
          <div class="mc-block"><span class="mc-label">Given out ${isToday ? "today" : "on this day"}</span>
            <span>${h.given_pieces} ${h.given_pieces === 1 ? "piece" : "pieces"} to ${h.sellers - h.without_stock} of ${h.sellers} ${h.sellers === 1 ? "seller" : "sellers"}${h.without_stock && isToday ? html` <span class="badge amber">${h.without_stock} without stock</span>` : ""}</span></div>
          <div class="mc-foot"><span></span><a class="btn primary" href="/hub-stock" data-link>${icon("plus")} Send stock to this hub</a></div></article>`)}</div>`
      : d.sellers.length ? (hubs.length > 1
        ? hubs.map((h) => html`<section class="mb-4" aria-label="${hubName(h)}"><h2 class="section-title" style="margin:0 0 10px">${hubName(h)}</h2>
            <div class="grid three">${d.sellers.filter((s) => s.hub === h).map(card)}</div></section>`)
        : html`<div class="grid three">${d.sellers.map(card)}</div>`)
        : html`<div class="card">${emptyState("No sellers here yet", "Add distributors, supervisors or managers to this hub first.", "users")}</div>`}`;

    $("#d-prev").onclick = () => { day = shift(day, -1); this.render(ctx); };
    $("#d-next").onclick = () => { day = shift(day, 1); this.render(ctx); };
    $("#d-today")?.addEventListener("click", () => { day = today; this.render(ctx); });

    $$("[data-del]", el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: "Take this stock back?", message: "It is removed from the seller's stock. This only works while they have not sold it.", confirmText: "Take back", danger: true }))) return;
      await busy(b, async () => { await del(`/api/stock-issues/${b.dataset.del}`); toast("Stock taken back"); await this.render(ctx); });
    }));

    $$("[data-give]", el).forEach((b) => (b.onclick = () => {
      const s = d.sellers.find((x) => x.employee_id === b.dataset.give);
      const pool = Object.fromEntries((d.pools[s.hub] || []).map((p) => [p.product_id, p.left]));
      const dr = drawer({
        title: `Give stock to ${s.name}`,
        body: html`<div class="give">
          <p class="muted" style="margin-top:0">${label(day)}. Enter how many of each product. Leave the rest at 0.</p>
          <div class="till-search"><span aria-hidden="true">${icon("search")}</span><input id="gq" class="input" type="search" autocomplete="off" placeholder="Search products" aria-label="Search products"></div>
          <ul class="give-list" role="list">${d.products.map((p) => html`<li data-name="${p.name.toLowerCase()}"><label for="g${p.id}"><b>${p.name}</b><span class="muted">${rs(p.price)} · ${pool[p.id] || 0} in the hub${(s.carried.find((c) => c.product_id === p.id)?.qty) ? ` · ${s.carried.find((c) => c.product_id === p.id).qty} carried over` : ""}</span></label>
            <input class="input" id="g${p.id}" data-pid="${p.id}" data-max="${pool[p.id] || 0}" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="${pool[p.id] ? "0" : "None"}" maxlength="4" ${pool[p.id] ? "" : "disabled"} aria-label="Quantity of ${p.name}"></li>`)}</ul>
          ${d.products.length ? "" : html`<p class="muted">There are no products yet. Add them under Products first.</p>`}</div>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="give-save">Give stock</button>`,
      });
      $("#gq", dr.panel).oninput = (e) => { const q = e.target.value.toLowerCase(); $$(".give-list li", dr.panel).forEach((li) => { li.hidden = q && !li.dataset.name.includes(q); }); };
      $("#give-save", dr.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const lines = $$("[data-pid]", dr.panel).map((i) => ({ product_id: Number(i.dataset.pid), qty: Number(i.value) })).filter((l) => l.qty > 0);
        if (!lines.length) throw new Error("Enter a quantity for at least one product");
        const over = $$("[data-pid]", dr.panel).find((i) => Number(i.value) > Number(i.dataset.max));
        if (over) throw new Error(`The hub has only ${over.dataset.max} of ${d.products.find((p) => p.id === Number(over.dataset.pid)).name}. Ask the office to send more stock`);
        await post("/api/stock-issues", { employee_id: s.employee_id, date: day, lines });
        toast(`Stock given to ${s.name}`);
        dr.close();
        await this.render(ctx);
      });
    }));
  },
};
