// The coacher enters a seller's bill by product, for a seller who cannot use the till (no phone, no signal).
//   pick the day and the seller, tap + on each product sold, set the cash handed in, Save bill.
// It makes the same sale lines as the till, so the seller's stock, the weekly stock sheet and the product reports are right.
import { get, post, del, qs } from "../api.js";
import { state } from "../app.js";
import { $, $$, html, esc, icon, toast, busy, confirmDialog, emptyState, announce } from "../ui.js";
import { today, addDays } from "../range.js";

const n0 = (c) => (Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 });
const LOW = 3;
let date = null, pickedSeller = "", query = "";

export default {
  title: "Enter a bill",
  filters: false,
  async render(ctx) {
    const { el } = ctx;
    const hub = state.user.hub || state.routeHub || "";
    if (!hub) { // the admin picks a hub first
      const hubs = state.hubs.filter((h) => h.status === "active");
      el.innerHTML = html`<div class="page-head"><div><h1>Enter a bill</h1><p>Enter or correct a seller's day by product. Pick a hub.</p></div></div>
        ${hubs.length ? html`<div class="card hs-list"><ul role="list">${hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/sales/bill" data-link><span class="hs-main"><b>${h.name}</b><span class="muted">${h.code}</span></span><span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
          : html`<div class="card">${emptyState("No hubs yet", "Add a hub first.", "store")}</div>`}`.toString();
      return;
    }
    const asHub = state.user.hub ? {} : { hub }; // the admin names the hub in each request
    const now = today(), oldest = addDays(now, -14);
    // Opened from a row of the daily sheet (?seller=…&date=…): take the person and the day, then clear the address so the page keeps its own choices.
    const qp = new URLSearchParams(location.search);
    if (qp.get("seller")) {
      pickedSeller = qp.get("seller");
      if (/^\d{4}-\d{2}-\d{2}$/.test(qp.get("date") || "")) date = qp.get("date");
      history.replaceState({}, "", location.pathname);
    }
    if (!date || date > now || date < oldest) date = now;
    const st = await get("/api/hub-bill" + qs({ date, employee_id: pickedSeller || undefined, ...asHub }));
    if (pickedSeller && !st.seller) pickedSeller = "";
    const bill = new Map(); // product id -> pieces on the bill being made

    el.innerHTML = html`<div class="page-head"><div><h1>Enter a bill</h1><p>For a seller who cannot use the till, entered by the hub's coacher or the admin. Pick the day and the seller, tap + for each product they sold, then save. The stock, the weekly stock sheet and the product reports follow.</p></div>
        <div class="actions"><a class="btn" href="/hubs/${encodeURIComponent(hub)}/sales/daily" data-link>Daily sheet</a></div></div>
      <div class="card mb-4"><div class="card-body"><div class="form-grid">
        <div class="field"><label for="bl-date">Day</label><input class="input" type="date" id="bl-date" value="${date}" min="${oldest}" max="${now}"></div>
        <div class="field"><label for="bl-seller">Seller</label><select class="input" id="bl-seller"><option value="">Choose the seller</option>
          ${st.sellers.map((s) => html`<option value="${s.employee_id}" ${s.employee_id === pickedSeller ? "selected" : ""}>${s.entered ? "✓ " : ""}${s.name} (${s.employee_id})${s.entered ? ` · Rs ${n0(s.business)}${s.by_products ? "" : " · total only"}` : ""}</option>`)}</select></div>
      </div></div></div>
      <div id="bl-body"></div>`.toString();

    $("#bl-date").onchange = (e) => { if (e.target.value && e.target.value <= now && e.target.value >= oldest) { date = e.target.value; this.render(ctx); } };
    $("#bl-seller").onchange = (e) => { pickedSeller = e.target.value; query = ""; this.render(ctx); };
    const box = $("#bl-body");
    if (!st.seller) {
      box.innerHTML = html`<div class="card">${emptyState("Choose a seller", "Their products and the stock they hold appear here. A ✓ marks sellers who already have the day entered.", "tag")}</div>`.toString();
      return;
    }
    if (st.closed) { box.innerHTML = html`<div class="alert warn">${icon("lock")}<div><b>That month is closed.</b> Its bills can no longer change.</div></div>`.toString(); return; }

    const draw = () => {
      const visible = st.products.filter((p) => p.active && (query ? p.name.toLowerCase().includes(query.toLowerCase()) : p.left > 0));
      for (const [id, n] of bill) { const p = st.products.find((x) => x.id === id); if (!p || n > p.left) { if (p && p.left > 0) bill.set(id, p.left); else bill.delete(id); } }
      const pieces = [...bill.values()].reduce((a, b) => a + b, 0);
      const total = [...bill].reduce((a, [id, n]) => a + n * (st.products.find((x) => x.id === id)?.price || 0), 0);
      const dayTotal = st.lines.reduce((t, l) => t + l.amount, 0);
      box.innerHTML = html`
        ${st.day.typed_total ? html`<div class="alert warn mb-4">${icon("alert")}<div>This day already has a total of <b>Rs ${n0(st.day.typed_total)}</b> typed on the daily sheet, without products. Saving a bill replaces that total with the bill's total.</div></div>` : ""}
        <div class="pos-search mb-3"><span aria-hidden="true">${icon("search")}</span><input id="bl-q" class="input" type="search" autocomplete="off" placeholder="Search product" aria-label="Search products" value="${esc(query)}"></div>
        ${st.products.length && st.products.every((p) => p.left < 1) ? html`<div class="alert warn mb-3">${icon("box")}<div><b>${esc(st.seller.name)} holds no stock for this day.</b> Give them stock first on <a href="/hubs/${encodeURIComponent(hub)}/stock/give" data-link>Give stock</a>.</div></div>` : ""}
        ${visible.length ? html`<ul class="pos-bill" role="list" aria-label="Bill">${visible.map((p) => { const n = bill.get(p.id) || 0; return html`<li class="pos-brow ${n ? "on" : ""}">
            <span class="pos-name">${p.name}<small class="${p.left < 1 ? "none" : p.left <= LOW ? "low" : ""}">${n0(p.price)} each · ${p.left < 1 ? "none left" : `${p.left} left`}</small></span>
            <span class="pos-bq" role="group" aria-label="Pieces of ${esc(p.name)}">
              <button type="button" class="pos-step" data-minus="${p.id}" aria-label="One less ${esc(p.name)}" ${n < 1 ? "disabled" : ""}>${icon("minus")}</button>
              <input class="pos-qn" data-qn="${p.id}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${n || ""}" placeholder="0" aria-label="Pieces of ${esc(p.name)}" ${p.left < 1 ? "disabled" : ""}>
              <button type="button" class="pos-step" data-plus="${p.id}" aria-label="One more ${esc(p.name)}" ${n >= p.left ? "disabled" : ""}>${icon("plus")}</button></span>
            <b class="pos-amt">${n ? n0(n * p.price) : ""}</b></li>`; })}</ul>`
          : html`<p class="muted pos-empty">${query ? `No product matches “${esc(query)}”.` : "Nothing left to sell. Search to see every product."}</p>`}
        <div class="card mb-4 bl-cash"><div class="card-body"><div class="form-grid">
          <div class="field"><label for="bl-set">Cash handed in for the day (Rs)</label><input class="input" id="bl-set" inputmode="decimal" autocomplete="off" placeholder="${n0(dayTotal + total)}" value="${st.day.recorded ? n0(st.day.settled).replace(/,/g, "") : ""}">
            <span class="hint">Leave it as it is to keep what the daily sheet has. The most that can be handed in is the day's total, Rs ${n0(dayTotal + total)}.</span></div>
          <div class="field"><button type="button" class="btn" id="bl-all">Handed in = all sales</button></div></div></div></div>
        <div class="pos-bar" aria-live="polite">
          <span class="pos-bar-sum"><small>${pieces} ${pieces === 1 ? "piece" : "pieces"}${bill.size ? ` · ${bill.size} ${bill.size === 1 ? "item" : "items"}` : ""}</small><b>Rs ${n0(total)}</b></span>
          ${bill.size ? html`<button type="button" class="btn ghost" id="bl-clear">Clear</button>` : ""}
          <button type="button" class="pos-sell" id="bl-save" ${bill.size ? "" : "disabled"}><span>Save bill</span>${icon("check")}</button></div>
        <h2 class="section-title drill-h">Already entered for ${esc(st.seller.name)} on this day</h2>
        <div class="card">${st.lines.length ? html`<ul class="pos-lines" role="list">${st.lines.map((l) => html`<li><span class="pos-l-main"><b>${l.qty} × ${l.product}</b><small>${n0(l.unit_price)} each${l.by ? ` · by ${l.by}` : ""}</small></span><b class="pos-l-amt">${n0(l.amount)}</b>
            <button type="button" class="pos-undo" data-rm-line="${l.id}" aria-label="Remove ${l.qty} ${esc(l.product)}">Remove</button></li>`)}</ul>
          <div class="card-body muted">Day's total Rs ${n0(dayTotal)} · handed in Rs ${n0(st.day.settled)}${st.day.personal ? ` · daily minus / advance Rs ${n0(st.day.personal)}` : ""}</div>`
          : html`<div class="card-body">${emptyState("No products entered yet", "Bills you save appear here, and each line can be removed.", "tag")}</div>`}</div>`.toString();
      wire();
    };

    const wire = () => {
      const setRow = (id, n) => {
        const p = st.products.find((x) => x.id === id); if (!p) return;
        n = Math.max(0, Math.min(p.left, Math.floor(Number(n) || 0)));
        if (n) bill.set(id, n); else bill.delete(id);
        draw();
      };
      $$("[data-plus]", box).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.plus); setRow(id, (bill.get(id) || 0) + 1); }));
      $$("[data-minus]", box).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.minus); setRow(id, (bill.get(id) || 0) - 1); }));
      $$("[data-qn]", box).forEach((inp) => {
        inp.onfocus = () => inp.select();
        inp.onchange = () => setRow(Number(inp.dataset.qn), inp.value.replace(/\D/g, ""));
        inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } };
      });
      const q = $("#bl-q", box);
      q.oninput = (e) => { query = e.target.value; const at = e.target.selectionStart; draw(); const again = $("#bl-q", box); again.focus(); try { again.setSelectionRange(at, at); } catch { /* not a text field */ } };
      $("#bl-clear", box)?.addEventListener("click", () => { bill.clear(); draw(); });
      $("#bl-all", box).onclick = () => {
        const total = st.lines.reduce((t, l) => t + l.amount, 0) + [...bill].reduce((a, [id, n]) => a + n * (st.products.find((x) => x.id === id)?.price || 0), 0);
        $("#bl-set", box).value = (total / 100).toFixed(2);
      };
      $$("[data-rm-line]", box).forEach((b) => (b.onclick = async () => {
        const l = st.lines.find((x) => String(x.id) === b.dataset.rmLine);
        if (!(await confirmDialog({ title: "Remove this line?", message: `${l.qty} × ${l.product} for Rs ${n0(l.amount)} will be removed and returned to ${esc(st.seller.name)}'s stock.`, confirmText: "Remove", danger: true }))) return;
        await busy(b, async () => { await del(`/api/hub-bill/lines/${l.id}`); toast("Line removed"); this.render(ctx); });
      }));
      $("#bl-save", box)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        const items = [...bill].map(([product_id, q]) => ({ product_id, qty: q }));
        const body = { employee_id: pickedSeller, date, items, settled_amount: $("#bl-set", box).value, ...asHub };
        let res;
        try { res = await post("/api/hub-bill", body); }
        catch (err) {
          if (!/^REPLACE:/.test(err.message)) throw err;
          const ok = await confirmDialog({ title: "Replace the typed total?", message: err.message.replace(/^REPLACE:\s*/, ""), confirmText: "Replace", danger: true });
          if (!ok) return;
          res = await post("/api/hub-bill", { ...body, confirm_replace: true });
        }
        const said = `Saved ${res.lines.length} ${res.lines.length === 1 ? "item" : "items"} · Rs ${n0(res.amount)}`;
        toast(said); announce(said); this.render(ctx);
      }));
    };
    draw();
  },
};
