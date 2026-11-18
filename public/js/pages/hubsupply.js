// Stock to hubs: the admin sends products to a particular hub. The hub's coacher then gives that stock out to the sellers (Morning stock).
// One card per hub shows what the hub holds now and the latest stock sent to it.
import { get, post, del } from "../api.js";
import { $, $$, html, icon, toast, busy, drawer, confirmDialog, emptyState } from "../ui.js";

const rs = (c) => `Rs ${(Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 })}`;
const dayLabel = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default {
  title: "Stock to hubs",
  async render(ctx) {
    const { el } = ctx;
    const d = await get("/api/hub-stock");
    const noProducts = !d.hubs.length || !d.hubs[0].stock.length;

    const card = (h) => html`<article class="card hubsupply" aria-label="${h.name}">
      <div class="card-head"><div><h2>${h.name}</h2><div class="sub">${h.code}</div></div>
        <button type="button" class="btn primary" data-send="${h.code}" ${h.status !== "active" ? "disabled" : ""}>${icon("plus")} Send stock</button></div>
      <div class="card-body flush">
        <table class="till-stock"><caption class="sr-only">Stock held by ${h.name}</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Sent</th><th scope="col">Given out</th><th scope="col">In the hub</th></tr></thead>
          <tbody>${h.stock.map((x) => html`<tr class="${x.left === 0 ? "none" : ""}"><th scope="row">${x.product}</th><td>${x.received}</td><td>${x.given}</td>
            <td class="left ${x.left > 0 && x.left <= 10 ? "low" : ""}"><b>${x.left}</b>${x.left > 0 && x.left <= 10 ? html`<span class="tag">Low</span>` : ""}</td></tr>`)}</tbody></table>
      </div>
      ${h.recent.length ? html`<div class="card-body"><div class="mc-label" style="margin-bottom:8px">Latest stock sent</div>
        <ul class="till-lines" role="list" style="margin:0 -18px -16px">${h.recent.slice(0, 5).map((r) => html`<li><div class="tl-main"><b>${r.qty} × ${r.product}</b><span class="muted">${dayLabel(r.date)} · by ${r.by}${r.note ? ` · ${r.note}` : ""}</span></div><span></span>
          <button type="button" class="btn sm ghost" data-del="${r.id}" aria-label="Take back ${r.qty} ${r.product} sent to ${h.name}">${icon("x")}</button></li>`)}</ul></div>` : ""}
    </article>`;

    el.innerHTML = html`<div class="hsup-page">
      <div class="page-head">
        <div><h1>Stock to hubs</h1><p>Send products to a hub. The hub's coacher then gives the stock out to the sellers, and can only give what the hub holds.</p></div>
      </div>
      ${noProducts ? html`<div class="card">${emptyState("No products yet", "Add your products first, then send them to the hubs.", "box", `<a class="btn primary" href="/products" data-link>Add products</a>`)}</div>`
        : html`<div class="grid three">${d.hubs.map(card)}</div>`}</div>`;

    $$("[data-send]", el).forEach((b) => (b.onclick = () => {
      const h = d.hubs.find((x) => x.code === b.dataset.send);
      const cart = new Map(); // product id -> qty
      const dr = drawer({
        title: `Send stock to ${h.name}`,
        body: html`<div class="give">
          <p class="muted" style="margin-top:0">Search a product and tap it to add it, then set how many you are sending.</p>
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
        const list = h.stock.filter((x) => !cart.has(x.product_id) && (!t || x.product.toLowerCase().includes(t))).slice(0, 8);
        res.innerHTML = list.length ? list.map((x) => html`<li><button type="button" class="give-pick" data-add="${x.product_id}"><span><b>${x.product}</b><span class="muted"> ${rs(x.price)} · ${x.left} in the hub now</span></span><span class="btn sm">Add</span></button></li>`).join("") : `<li class="muted" style="padding:8px 2px">${t ? "No product matches" : "All products are added"}</li>`;
      };
      const drawCart = () => {
        cartEl.innerHTML = cart.size ? [...cart].map(([id, n]) => html`<li><label for="c${id}"><b>${prod(id).product}</b><span class="muted">${prod(id).left} in the hub now</span></label>
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
        await post("/api/hub-stock", { hub: h.code, lines, note: $("#s-note", dr.panel).value });
        toast(`Stock sent to ${h.name}`);
        dr.close();
        await this.render(ctx);
      });
      drawResults(); drawCart(); q.focus();
    }));

    $$("[data-del]", el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: "Take this stock back?", message: "It is removed from the hub's stock. This only works while the coacher has not given it to sellers.", confirmText: "Take back", danger: true }))) return;
      await busy(b, async () => { await del(`/api/hub-stock/${b.dataset.del}`); toast("Stock taken back"); await this.render(ctx); });
    }));
  },
};
