// Morning stock: the hub head or hub manager gives each seller their stock for the day.
// One card per seller shows what they carry over, what they were given today and what they have sold. "Give stock" opens a short list of products.
import { get, post, del, qs } from "../api.js";
import { state, scopeHub, can } from "../app.js";
import { $, $$, html, esc, icon, toast, busy, drawer, confirmDialog, emptyState, initials, levelLabel, exportButtons } from "../ui.js";

const rs = (c) => `Rs ${(Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 })}`;
const slToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const shift = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const label = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
let day = null;

export default {
  title: "Give stock",
  async render(ctx) {
    const { el } = ctx;
    const today = slToday();
    day = day || today;
    const d = await get("/api/stock-issues" + qs({ date: day, hub: scopeHub() }));
    const hubName = (c) => state.hubs.find((h) => h.code === c)?.name || c;
    const isToday = day === today;
    const canGive = !(can("manage_products") && !state.user.hub) && day <= today && day >= shift(today, -3);
    const givenTotal = d.sellers.reduce((t, s) => t + s.given.reduce((n, g) => n + g.qty, 0), 0);
    const overview0 = () => can("manage_products") && !state.user.hub;
    const without = d.sellers.filter((s) => !(s.left || []).length).length;
    const hubEmpty = !overview0() && Object.values(d.pools).every((list) => list.every((p) => p.left === 0));
    // The admin does not hand stock to sellers: the admin sees each hub with its coacher and what it holds. The coacher gives it out.
    const overview = can("manage_products") && !state.user.hub;
    const tm = new Map();
    for (const x of d.sellers) { const t = x.team || { id: "none", title: "Sellers", sub: "", order: 2 }; if (!tm.has(t.id)) tm.set(t.id, { ...t, people: [] }); tm.get(t.id).people.push(x); }
    const teams = [...tm.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    const givenAll = (d.hubs || []).reduce((t, h) => t + h.given_pieces, 0);
    // A hub with several teams opens on a card per team (one summary each); a team opens to its sellers, where the stock is given.
    // ?team=ID in the address names the open team.
    const want = new URLSearchParams(location.search).get("team");
    const open = teams.length > 1 && want ? teams.find((g) => g.id === want) : null;
    const showTeams = teams.length > 1 && !open;
    const given = (g) => g.people.reduce((t, x) => t + x.given.reduce((n, y) => n + y.qty, 0), 0);
    const holding = (g) => g.people.reduce((t, x) => t + (x.left || []).reduce((n, l) => n + l.qty, 0), 0);
    const teamCards = showTeams ? html`<div class="drill-grid">${teams.map((g) => {
      const none = g.people.filter((x) => !(x.left || []).length).length;
      return html`<a class="card drill-card" href="${location.pathname}?team=${encodeURIComponent(g.id)}" data-link>
        <span class="dc-top"><span class="avatar" aria-hidden="true">${initials(g.title)}</span><span class="dc-main"><b>${g.title}</b><span class="muted">${g.sub}${g.sub ? " · " : ""}${g.people.length} ${g.people.length === 1 ? "seller" : "sellers"}</span></span>
          <span class="dc-sales"><b class="num">${given(g)}</b><span class="muted">given ${isToday ? "today" : "this day"}</span></span></span>
        <span class="dc-foot row" style="gap:8px;flex-wrap:wrap"><span class="muted">Holding ${holding(g)} pieces</span>${canGive && none ? html`<span class="badge amber">${none} without stock</span>` : ""}</span>
        <span class="dc-open" aria-hidden="true">Open team</span></a>`;
    })}</div>` : "";
    const crumbs = open ? html`<nav class="drill-crumbs" aria-label="Where you are"><a href="${location.pathname}" data-link>All teams</a><span aria-hidden="true">›</span><b>${open.title}</b></nav>` : "";
    const shown = open ? [open] : showTeams ? [] : teams;

    const sellersPart = d.sellers.length ? html`${crumbs}${teamCards}${shown.map((g) => html`<details class="dgrp card" data-gid="${g.id}" open>
          <summary><span class="dg-chev" aria-hidden="true">${icon("right")}</span><span class="avatar" aria-hidden="true">${initials(g.title)}</span>
            <span class="dg-title"><b>${g.title}</b><small>${g.sub}${g.sub ? " · " : ""}${g.people.length} ${g.people.length === 1 ? "seller" : "sellers"}</small></span>
            <span class="dg-nums"><span><small>Given</small><b>${g.people.reduce((t, x) => t + x.given.reduce((n, y) => n + y.qty, 0), 0)}</b></span><span><small>Holding</small><b>${g.people.reduce((t, x) => t + (x.left || []).reduce((n, l) => n + l.qty, 0), 0)}</b></span>${canGive && g.people.some((x) => !(x.left || []).length) ? html`<span class="dg-prog part">${g.people.filter((x) => !(x.left || []).length).length} without stock</span>` : ""}</span></summary>
          <div class="table-wrap" tabindex="-1"><table class="table sheet msheet">
            <caption class="sr-only">Stock for ${g.title}'s team</caption>
            <thead><tr><th scope="col">Seller</th><th scope="col">Has now</th><th scope="col">Given ${isToday ? "today" : "this day"}</th>${canGive ? html`<th scope="col"><span class="sr-only">Give stock</span></th>` : ""}</tr></thead>
            <tbody>${g.people.map((x) => html`<tr data-emp="${x.employee_id}">
              <th scope="row" class="name"><b>${x.name}</b><div class="faint text-sm fw-400">${x.employee_id} · ${levelLabel(x.staff_level)}</div></th>
              <td data-label="Has now">${(x.left || []).length ? html`<div class="mc-chips">${x.left.slice(0, 4).map((c) => html`<span class="mc-chip">${c.qty} × ${c.product}</span>`)}${x.left.length > 4 ? html`<span class="muted">+${x.left.length - 4} more</span>` : ""}</div>` : html`<span class="mc-chip out">Nothing</span>`}</td>
              <td data-label="Given ${isToday ? 'today' : 'this day'}">${x.given.length ? html`<div class="mc-chips">${x.given.map((y) => html`<span class="mc-chip given">${y.qty} × ${y.product}${canGive ? html`<button type="button" class="mc-x" data-del="${y.id}" aria-label="Take back ${y.qty} ${y.product} from ${x.name}">${icon("x")}</button>` : ""}</span>`)}</div>` : html`<span class="muted">Nothing yet</span>`}</td>
              ${canGive ? html`<td class="r give-cell"><button type="button" class="btn sm primary" data-give="${x.employee_id}">${icon("plus")} Give stock</button></td>` : ""}</tr>`)}</tbody></table></div>
        </details>`)}`
        : html`<div class="card">${emptyState("No sellers here yet", "Add distributors, supervisors or managers to this hub first.", "users")}</div>`;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>${overview ? "Morning stock" : "Give stock"}</h1><p>${overview ? "Each hub's coacher gives the stock out to the sellers. Here you see every hub, its coacher, what the hub holds and how much has been given out." : "Sellers keep their stock from day to day, so you only top up the ones who need more."}</p></div>
        <div class="actions">${exportButtons("stock-given", { period: state.period, hub: scopeHub() })}${overview ? "" : html`<a class="btn" href="/stock-overview" data-link>${icon("box")} Hub stock</a>`}</div>
      </div>
      <div class="daybar mb-4">
        <div class="row daynav" style="gap:8px;align-items:center">
          <button type="button" class="btn icon" id="d-prev" aria-label="Previous day">${icon("left")}</button>
          <div><b style="font-size:17px">${label(day)}</b>${isToday ? html` <span class="badge green">Today</span>` : ""}</div>
          <button type="button" class="btn icon" id="d-next" aria-label="Next day" ${day >= today ? "disabled" : ""}>${icon("right")}</button>
          ${isToday ? "" : html`<button type="button" class="btn sm" id="d-today">Back to today</button>`}
        </div>
        <div class="muted">${overview ? `${d.hubs.length} ${d.hubs.length === 1 ? "hub" : "hubs"} · ${givenAll} ${givenAll === 1 ? "piece" : "pieces"} given out` : `${d.sellers.length} ${d.sellers.length === 1 ? "seller" : "sellers"}${canGive && without ? ` · ${without} with no stock` : ""}`}</div>
      </div>
      ${hubEmpty ? html`<div class="alert warn mb-4">${icon("box")}<div><b>The hub has no stock to give out.</b> The office sends stock to the hub first. <a href="/stock-overview" data-link>See hub stock</a></div></div>` : ""}
      ${!canGive && !overview ? html`<div class="alert info mb-4">${icon("info")}<div>${day > today ? "This day has not happened yet." : "Stock can be changed only for the last 3 days. You can still look at this day."}</div></div>` : ""}
      ${overview ? html`<div class="grid three" ${open ? "hidden" : ""}>${d.hubs.map((h) => html`<article class="mcard card" aria-label="${h.name}">
          <div class="mc-top"><div class="avatar" aria-hidden="true">${h.code}</div><div class="mc-who"><b>${h.name}</b><span class="muted">${h.code}</span></div></div>
          <div class="mc-block"><span class="mc-label">Coacher</span>${h.coacher ? html`<b>${h.coacher.name}</b>` : html`<span class="mc-chip" style="background:var(--warning-soft);color:var(--warning)">No coacher yet</span>`}</div>
          <div class="mc-block"><span class="mc-label">Hub stock</span>${(d.pools[h.code] || []).length ? html`<div class="mc-chips">${d.pools[h.code].map((p) => html`<span class="mc-chip ${p.left > 0 ? "given" : ""}">${p.left} × ${p.product}</span>`)}</div>` : html`<span class="muted">No products yet</span>`}</div>
          <div class="mc-block"><span class="mc-label">Given out ${isToday ? "today" : "on this day"}</span>
            <span>${h.given_pieces} ${h.given_pieces === 1 ? "piece" : "pieces"} to ${h.sellers - h.without_stock} of ${h.sellers} ${h.sellers === 1 ? "seller" : "sellers"}${h.without_stock && isToday ? html` <span class="badge amber">${h.without_stock} without stock</span>` : ""}</span></div>
          <div class="mc-foot"><span></span><a class="btn primary" href="/hub-stock" data-link>${icon("plus")} Send stock to this hub</a></div></article>`)}</div>${scopeHub() && d.sellers.length ? sellersPart : ""}`
      : sellersPart}`;

    $("#d-prev").onclick = () => { day = shift(day, -1); this.render(ctx); };
    $("#d-next").onclick = () => { day = shift(day, 1); this.render(ctx); };
    $("#d-today")?.addEventListener("click", () => { day = today; this.render(ctx); });

    $$("[data-del]", el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: "Take this stock back?", message: "It is removed from the seller's stock. This only works while they have not sold it.", confirmText: "Take back", danger: true }))) return;
      await busy(b, async () => { await del(`/api/stock-issues/${b.dataset.del}`); toast("Stock taken back"); await this.render(ctx); });
    }));

    // Giving stock works like a till: search a product, tap it to add it, set the quantity, then give.
    $$("[data-give]", el).forEach((b) => (b.onclick = () => {
      const x = d.sellers.find((q) => q.employee_id === b.dataset.give);
      const pool = Object.fromEntries((d.pools[x.hub] || []).map((q) => [q.product_id, q.left]));
      const have = Object.fromEntries(x.carried.map((c) => [c.product_id, c.qty]));
      const cart = new Map(); // product id -> qty
      const dr = drawer({
        title: `Give stock to ${x.name}`,
        body: html`<div class="give">
          <p class="muted" style="margin-top:0">${label(day)}. Search a product and tap it to add it.</p>
          <div class="till-search"><span aria-hidden="true">${icon("search")}</span><input id="gq" class="input" type="search" autocomplete="off" placeholder="Search products" aria-label="Search products"></div>
          <ul class="give-list" id="g-results" role="list" aria-label="Products"></ul>
          <h3 class="section-title" style="margin:16px 0 8px">To give <span class="muted" id="g-count"></span></h3>
          <ul class="give-list" id="g-cart" role="list" aria-label="Products to give"></ul></div>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="give-save" disabled>Give stock</button>`,
      });
      const q = $("#gq", dr.panel), res = $("#g-results", dr.panel), cartEl = $("#g-cart", dr.panel), save = $("#give-save", dr.panel);
      const prod = (id) => d.products.find((p) => p.id === Number(id));
      const drawResults = () => {
        const t = q.value.trim().toLowerCase();
        // Products the hub has come first, then the ones it has run out of; the list scrolls, so a long catalogue stays short on screen.
        const list = d.products.filter((p) => !cart.has(p.id) && (!t || p.name.toLowerCase().includes(t)))
          .sort((a, b) => (pool[b.id] ? 1 : 0) - (pool[a.id] ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 80);
        res.innerHTML = list.length ? list.map((p) => html`<li><button type="button" class="give-pick" data-add="${p.id}" ${pool[p.id] ? "" : "disabled"}><span class="gp-main"><b>${p.name}</b><span class="muted">Hub ${Number(pool[p.id] || 0).toLocaleString("en-LK")}${have[p.id] ? ` · Seller has ${have[p.id]}` : ""}</span></span><span class="gp-add">${pool[p.id] ? "+ Add" : "None"}</span></button></li>`).join("") : `<li class="muted" style="padding:8px 2px">${t ? "No product matches" : "All products are added"}</li>`;
      };
      const drawCart = () => {
        cartEl.innerHTML = cart.size ? [...cart].map(([id, n]) => html`<li><label for="c${id}"><b>${prod(id).name}</b><span class="muted">${pool[id]} in the hub</span></label>
          <input class="input" id="c${id}" data-cid="${id}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${n}" aria-label="Quantity of ${prod(id).name}">
          <button type="button" class="mc-x" data-rm="${id}" aria-label="Remove ${prod(id).name}">${icon("x")}</button></li>`).join("") : `<li class="muted" style="padding:8px 2px">Nothing added yet</li>`;
        $("#g-count", dr.panel).textContent = cart.size ? `· ${[...cart.values()].reduce((a, n) => a + n, 0)} pieces` : "";
        save.disabled = !cart.size;
      };
      const add = (id) => { cart.set(Number(id), 1); drawCart(); drawResults(); $(`#c${id}`, dr.panel)?.select(); };
      q.oninput = drawResults;
      q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); const f = $("[data-add]:not([disabled])", res); if (f) { add(f.dataset.add); q.value = ""; drawResults(); } } };
      res.onclick = (e) => { const bt = e.target.closest("[data-add]"); if (bt) { add(bt.dataset.add); q.focus(); } };
      cartEl.onclick = (e) => { const bt = e.target.closest("[data-rm]"); if (bt) { cart.delete(Number(bt.dataset.rm)); drawCart(); drawResults(); } };
      cartEl.oninput = (e) => { const i = e.target.closest("[data-cid]"); if (i) { i.value = i.value.replace(/\D/g, ""); cart.set(Number(i.dataset.cid), Number(i.value) || 0); $("#g-count", dr.panel).textContent = `· ${[...cart.values()].reduce((a, n) => a + n, 0)} pieces`; } };
      save.onclick = (e) => busy(e.currentTarget, async () => {
        const lines = [...cart].map(([product_id, qty]) => ({ product_id, qty })).filter((l) => l.qty > 0);
        if (!lines.length) throw new Error("Enter a quantity for at least one product");
        const over = lines.find((l) => l.qty > (pool[l.product_id] || 0));
        if (over) throw new Error(`The hub has only ${pool[over.product_id] || 0} of ${prod(over.product_id).name}. Ask the office to send more stock`);
        await post("/api/stock-issues", { employee_id: x.employee_id, date: day, lines });
        toast(`Stock given to ${x.name}`);
        dr.close();
        await this.render(ctx);
      });
      drawResults(); drawCart(); q.focus();
    }));
  },
};
