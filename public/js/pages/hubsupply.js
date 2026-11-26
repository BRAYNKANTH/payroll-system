// Stock to hubs: the admin sends products to a particular hub. The hub's coacher then gives that stock out to the sellers (Morning stock).
// The page is a short list of the hubs, each with what it holds in one line. Tap a hub to see its stock per product, the latest stock sent
// to it (and take a mistake back), and the Send stock button.
import { get, post, del } from "../api.js";
import { state } from "../app.js";
import { $, $$, html, icon, toast, busy, drawer, confirmDialog, emptyState, badge, exportButtons } from "../ui.js";

const rs = (c) => `Rs ${(Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 })}`;
const dayLabel = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const n0 = (n) => Number(n).toLocaleString("en-LK");
const LOW = 10; // a product with this many pieces or fewer in the hub is "low"

export default {
  filters: false, // this page has no use for the hub and month bar, so it is not shown
  title: "Stock to hubs",
  async render(ctx) {
    const { el } = ctx;
    const d = await get("/api/hub-stock");
    const noProducts = !d.hubs.length || !d.hubs[0].stock.length;
    const office = Object.fromEntries((d.office || []).map((o) => [o.product_id, o.left])); // what the office holds
    const sum = (h) => h.stock.reduce((t, x) => t + x.left, 0);
    const out = (h) => h.stock.filter((x) => x.left === 0).length;
    const low = (h) => h.stock.filter((x) => x.left > 0 && x.left <= LOW).length;

    // One line per hub.
    const row = (h) => html`<li class="hs-send-row"><button type="button" class="hs-row" data-open="${h.code}">
      <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · ${n0(sum(h))} in the hub${h.status !== "active" ? " · inactive" : ""}</span>
        ${out(h) || low(h) ? html`<span class="hs-warn">${out(h) ? badge("red", `${out(h)} out`) : ""}${low(h) ? badge("amber", `${low(h)} low`) : ""}</span>` : ""}</span>
      <span class="hs-chev" aria-hidden="true"></span></button>
      <button type="button" class="btn primary hs-send" data-send="${h.code}" ${h.status !== "active" ? "disabled" : ""} aria-label="Send stock to ${h.name}">${icon("plus")} Send</button></li>`;

    // What the office holds: the stock that can be sent. Shown first, so nobody has to open a hub to find out.
    const officeList = (d.hubs[0]?.stock || []).map((x) => ({ name: x.product, left: office[x.product_id] || 0 }));
    const officeCard = officeList.length ? html`<section class="card hs-office mb-4" aria-label="Stock in the office">
      <div class="hs-office-head"><b>In the office</b><span class="muted">Available to send</span></div>
      <ul class="hs-office-list" role="list">${officeList.map((p) => html`<li class="${p.left === 0 ? "none" : ""}"><span>${p.name}</span><b class="num">${n0(p.left)}</b></li>`)}</ul>
      ${officeList.every((p) => p.left < 1) ? html`<p class="hs-office-none">The office has no stock to send. <a href="/products" data-link>Add stock on Products</a>.</p>` : ""}</section>` : "";

    el.innerHTML = html`<div class="hsup-page">
      <div class="page-head">
        <div><h1>Stock to hubs</h1><p>Send products from the office to a hub. The hub's coacher then gives the stock out to the sellers.</p></div><div class="actions">${exportButtons("hub-supply", { period: state.period })}</div>
      </div>
      ${noProducts ? html`<div class="card">${emptyState("No products yet", "Add your products first, then send them to the hubs.", "box", `<a class="btn primary" href="/products" data-link>Add products</a>`)}</div>`
        : html`${officeCard}<h2 class="section-title drill-h">Hubs</h2><div class="card hs-list"><ul role="list">${d.hubs.map(row)}</ul></div><p class="muted hs-hint">Press Send to send stock to a hub. Tap a hub's name to see what it holds.</p>`}</div>`;

    // A hub opened: its stock per product and the latest stock sent. From here: Send stock, or take a mistake back.
    const openHub = (h) => {
      const dr = drawer({
        title: h.name,
        body: html`<div class="hs-detail">
          <div class="muted" style="margin:0 0 10px">${h.code} · ${n0(sum(h))} pieces in the hub</div>
          <ul class="hs-prod" role="list" aria-label="Stock held by ${h.name}">${h.stock.map((x) => html`<li class="${x.left === 0 ? "none" : ""}">
            <span class="hp-main"><b>${x.product}</b><span class="muted">Sent ${n0(x.received)} · Given out ${n0(x.given)}</span></span>
            <span class="hp-left ${x.left > 0 && x.left <= LOW ? "low" : ""}"><b class="num">${n0(x.left)}</b><span class="muted">in the hub${x.left > 0 && x.left <= LOW ? " · low" : x.left === 0 ? " · out" : ""}</span></span></li>`)}</ul>
          ${h.recent.length ? html`<div class="mc-label" style="margin:16px 0 6px">Latest stock sent</div>
            <ul class="till-lines" role="list" style="margin:0">${h.recent.slice(0, 8).map((r) => html`<li><div class="tl-main"><b>${r.qty} × ${r.product}</b><span class="muted">${dayLabel(r.date)} · by ${r.by}${r.note ? ` · ${r.note}` : ""}</span></div><span></span>
              <button type="button" class="btn sm" data-del="${r.id}" aria-label="Take back ${r.qty} ${r.product} sent to ${h.name}">Take back</button></li>`)}</ul>` : html`<p class="muted" style="margin-top:14px">Nothing has been sent to this hub yet.</p>`}
        </div>`.toString(),
        foot: `<button class="btn" data-close>Close</button><button class="btn primary" id="hs-send" ${h.status !== "active" ? "disabled" : ""}>${icon("plus")} Send stock</button>`,
      });
      $("#hs-send", dr.panel).onclick = () => { dr.close(); sendStock(h); };
      $$("[data-del]", dr.panel).forEach((b) => (b.onclick = async () => {
        if (!(await confirmDialog({ title: "Take this stock back?", message: "It is removed from the hub's stock. This only works while the coacher has not given it to sellers.", confirmText: "Take back", danger: true }))) return;
        await busy(b, async () => { await del(`/api/hub-stock/${b.dataset.del}`); toast("Stock taken back"); dr.close(); await this.render(ctx); });
      }));
    };

    // Send stock: search a product, tap it, set how many. Only what the office holds can be sent.
    const sendStock = (h) => {
      const cart = new Map(); // product id -> qty
      const dr = drawer({
        title: `Send stock to ${h.name}`,
        body: html`<div class="give">
          <p class="muted" style="margin-top:0">Search a product and tap it to add it, then set how many you are sending. You can send only what the office holds.</p>
          ${(d.office || []).every((o) => o.left < 1) ? html`<div class="alert warn mb-3">${icon("box")}<div><b>The office has no stock.</b> Add stock to a product first: Products, choose the product, then Add stock.</div></div>` : ""}
          <div class="till-search"><span aria-hidden="true">${icon("search")}</span><input id="sq" class="input" type="search" autocomplete="off" placeholder="Search products" aria-label="Search products"></div>
          <ul class="give-list" id="s-results" role="list" aria-label="Products"></ul>
          <h3 class="section-title" style="margin:16px 0 8px">To send <span class="muted" id="s-count"></span></h3>
          <ul class="give-list" id="s-cart" role="list" aria-label="Products to send"></ul>
          <div class="field" style="margin-top:14px"><label for="s-note">Note (optional)</label><input class="input" id="s-note" maxlength="200" placeholder="For example: Monday delivery"></div></div>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="send-save" disabled>Send stock</button>`,
      });
      const q = $("#sq", dr.panel), res = $("#s-results", dr.panel), cartEl = $("#s-cart", dr.panel), save = $("#send-save", dr.panel);
      const prod = (id) => h.stock.find((x) => x.product_id === Number(id));
      const total = () => [...cart.values()].reduce((a, n) => a + n, 0);
      const drawResults = () => {
        const t = q.value.trim().toLowerCase();
        // Products the office has come first, then the ones it has run out of; the list scrolls, so a long catalogue stays short on screen.
        const list = h.stock.filter((x) => !cart.has(x.product_id) && (!t || x.product.toLowerCase().includes(t)))
          .sort((a, b) => (office[b.product_id] ? 1 : 0) - (office[a.product_id] ? 1 : 0) || a.product.localeCompare(b.product)).slice(0, 80);
        res.innerHTML = list.length ? list.map((x) => html`<li><button type="button" class="give-pick" data-add="${x.product_id}" ${office[x.product_id] ? "" : "disabled"}><span class="gp-main"><b>${x.product}</b><span class="muted">Office ${n0(office[x.product_id] || 0)} · Hub ${n0(x.left)}</span></span><span class="gp-add">${office[x.product_id] ? "+ Add" : "None"}</span></button></li>`).join("") : `<li class="muted" style="padding:8px 2px">${t ? "No product matches" : "All products are added"}</li>`;
      };
      const drawCart = () => {
        cartEl.innerHTML = cart.size ? [...cart].map(([id, n]) => html`<li><label for="c${id}"><b>${prod(id).product}</b><span class="muted">Office has ${n0(office[id] || 0)}</span></label>
          <input class="input" id="c${id}" data-cid="${id}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${n}" aria-label="Quantity of ${prod(id).product} to send">
          <button type="button" class="mc-x" data-rm="${id}" aria-label="Remove ${prod(id).product}">${icon("x")}</button></li>`).join("") : `<li class="muted" style="padding:8px 2px">Nothing added yet</li>`;
        $("#s-count", dr.panel).textContent = cart.size ? `· ${total()} pieces` : "";
        save.disabled = !cart.size;
      };
      const add = (id) => { cart.set(Number(id), 1); drawCart(); drawResults(); $(`#c${id}`, dr.panel)?.select(); };
      q.oninput = drawResults;
      q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); const f = $("[data-add]", res); if (f) { add(f.dataset.add); q.value = ""; drawResults(); } } };
      res.onclick = (e) => { const bt = e.target.closest("[data-add]"); if (bt) { add(bt.dataset.add); q.focus(); } };
      cartEl.onclick = (e) => { const bt = e.target.closest("[data-rm]"); if (bt) { cart.delete(Number(bt.dataset.rm)); drawCart(); drawResults(); } };
      cartEl.oninput = (e) => { const i = e.target.closest("[data-cid]"); if (i) { i.value = i.value.replace(/\D/g, ""); cart.set(Number(i.dataset.cid), Number(i.value) || 0); $("#s-count", dr.panel).textContent = `· ${total()} pieces`; } };
      save.onclick = (e) => busy(e.currentTarget, async () => {
        const lines = [...cart].map(([product_id, qty]) => ({ product_id, qty })).filter((l) => l.qty > 0);
        if (!lines.length) throw new Error("Enter a quantity for at least one product");
        const over = lines.find((l) => l.qty > (office[l.product_id] || 0));
        if (over) throw new Error(`The office has only ${office[over.product_id] || 0} ${prod(over.product_id).product}. Add stock to the product first`);
        await post("/api/hub-stock", { hub: h.code, lines, note: $("#s-note", dr.panel).value });
        toast(`Stock sent to ${h.name}`);
        dr.close();
        await this.render(ctx);
      });
      drawResults(); drawCart(); q.focus();
    };

    $$("[data-open]", el).forEach((b) => (b.onclick = () => openHub(d.hubs.find((x) => x.code === b.dataset.open))));
    $$("[data-send]", el).forEach((b) => (b.onclick = () => sendStock(d.hubs.find((x) => x.code === b.dataset.send))));
  },
};
