import { get, post, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, $$, html, icon, money, toast, busy, confirmDialog, emptyState, fromCents } from "../ui.js";
import { sheetKeys, periodLocked, lockedBanner } from "./shared.js";

const INTS = ["opening_stock", "received", "issued", "counted_stock"];
const prevPeriod = (p) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export default {
  title: "Branch stock",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [lines, locked] = await Promise.all([
      get("/api/hubstock" + qs({ period: state.period, hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    const hubs = state.hubs.filter((h) => !scopeHub() || h.code === scopeHub());
    const hubName = (c) => state.hubs.find((h) => h.code === c)?.name || c;
    const editable = can("enter_data") && !locked;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Branch stock</h1><p>Each branch's stock for the month. Expected = opening + received − given out. Difference = expected − counted.</p></div>
        <div class="actions">${editable ? html`
          <button class="btn" id="carry">${icon("copy")} Open from last month's count</button>
          <button class="btn" id="add" ${hubs.length ? "" : "disabled"}>${icon("plus")} Add product</button>` : ""}</div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card"><div class="card-body flush" id="grid"></div>
        ${editable ? html`<div class="row between card-foot">
          <span class="muted" id="info"></span><button class="btn primary" id="save">${icon("check")} Save branch stock</button></div>` : ""}</div>`;

    const grid = $("#grid");
    let rows = lines.map((l) => ({ ...l, _state: "saved" }));
    const hubOptions = (sel) => hubs.map((h) => html`<option value="${h.code}" ${h.code === sel ? "selected" : ""}>${h.name}</option>`);

    const draw = () => {
      if (!rows.length) {
        grid.innerHTML = emptyState("No branch stock for this month", editable ? "Add a product, or open the month from last month's count." : "", "box").toString();
        return;
      }
      grid.innerHTML = html`<div class="table-wrap"><table class="table sheet">
        <thead><tr><th>Branch</th><th>Product</th><th class="r">Opening</th><th class="r">Received</th><th class="r">Given out</th><th class="r">Counted</th>
          <th class="r">Unit price</th><th class="r">Expected</th><th class="r">Difference</th><th class="r">Stock value</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => r._state === "deleted" ? "" : html`<tr data-i="${i}" class="${r._state === "new" ? "dirty" : ""}">
          <td class="name">${r.id ? html`<b>${hubName(r.hub)}</b><div class="faint text-sm">${r.hub}</div>`
            : html`<select class="input sm" data-f="hub" aria-label="Branch" style="min-width:140px">${hubOptions(r._draft?.hub ?? r.hub)}</select>`}</td>
          <td>${r.id ? html`<b>${r.product}</b>` : html`<input class="text" data-f="product" aria-label="Product" value="${r._draft?.product ?? r.product ?? ""}" placeholder="Product name">`}</td>
          ${INTS.map((k) => html`<td><input data-f="${k}" aria-label="${k.replace("_", " ")}" inputmode="numeric" value="${r._draft?.[k] ?? r[k] ?? ""}" ${editable ? "" : "disabled"} style="min-width:70px"></td>`)}
          <td><input data-f="unit_price" aria-label="Unit price" inputmode="decimal" value="${r._draft?.unit_price ?? (r.unit_price != null ? fromCents(r.unit_price) : "")}" ${editable ? "" : "disabled"}></td>
          <td class="calc" data-e></td><td class="calc" data-q></td><td class="calc" data-v></td>
          <td>${editable ? html`<button class="btn sm icon danger-ghost" data-del="${i}" aria-label="Remove product">${icon("trash")}</button>` : ""}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td colspan="8">Totals</td><td class="r" id="tot-short"></td><td class="r" id="tot-val"></td><td></td></tr></tfoot></table></div>`.toString();
      refresh();
    };

    // Redrawing rebuilds the table from `rows`, so keep what has been typed so far in a per-row draft.
    const read = (tr) => Object.fromEntries([...tr.querySelectorAll("[data-f]")].map((i) => [i.dataset.f, i.value.trim()]));
    const snap = () => $$("tbody tr", grid).forEach((tr) => { const r = rows[tr.dataset.i]; if (r) r._draft = read(tr); });
    const refresh = () => {
      let short = 0, value = 0, dirty = 0;
      $$("tbody tr", grid).forEach((tr) => {
        const r = rows[tr.dataset.i];
        const v = read(tr);
        const n = (k) => Number(v[k] || 0);
        const price = Math.round(n("unit_price") * 100);
        const expected = n("opening_stock") + n("received") - n("issued");
        const q = expected - n("counted_stock");
        tr.querySelector("[data-e]").textContent = expected;
        tr.querySelector("[data-q]").innerHTML = v.counted_stock === "" ? "" : `<span class="${q > 0 ? "neg" : q < 0 ? "pos" : ""}">${q > 0 ? `${q} short` : q < 0 ? `${-q} over` : "0"}</span>`;
        tr.querySelector("[data-v]").textContent = v.counted_stock === "" ? "" : money(n("counted_stock") * price);
        if (v.counted_stock !== "") { short += Math.max(0, q) * price; value += n("counted_stock") * price; }
        const changed = r._state === "new" || INTS.some((k) => n(k) !== r[k]) || price !== r.unit_price;
        tr.classList.toggle("dirty", changed);
        r._dirty = changed;
        if (changed) dirty++;
      });
      if ($("#tot-short")) $("#tot-short").innerHTML = short ? `<span class="neg">${money(short)} short</span>` : "—";
      if ($("#tot-val")) $("#tot-val").innerHTML = `<b>${money(value)}</b>`;
      if ($("#info")) $("#info").textContent = dirty ? `${dirty} line${dirty > 1 ? "s" : ""} changed` : "No unsaved changes";
    };
    grid.addEventListener("input", refresh);
    grid.addEventListener("change", refresh);
    grid.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-del]");
      if (!b) return;
      snap();
      const r = rows[b.dataset.del];
      if (r.id && !(await confirmDialog({ title: "Remove product?", message: `${r.product} at ${hubName(r.hub)} will be deleted when you save.`, confirmText: "Remove", danger: true }))) return;
      r._state = r.id ? "deleted" : "gone";
      if (!r.id) rows.splice(b.dataset.del, 1);
      draw();
    });
    sheetKeys(grid);
    draw();

    $("#add")?.addEventListener("click", () => {
      snap();
      rows.push({ _state: "new", hub: hubs[0]?.code, product: "", opening_stock: 0, received: 0, issued: 0, counted_stock: null, unit_price: null });
      draw();
      $$("tbody tr:last-child [data-f=product]", grid)[0]?.focus();
    });
    $("#carry")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      snap();
      const prev = await get("/api/hubstock" + qs({ period: prevPeriod(state.period), hub: scopeHub() }));
      const have = new Set(rows.map((r) => `${r._draft?.hub ?? r.hub}|${r._draft?.product ?? r.product}`));
      const add = prev.filter((p) => !have.has(`${p.hub}|${p.product}`));
      if (!add.length) return toast("Nothing new to bring over from last month", "warn");
      add.forEach((p) => rows.push({ _state: "new", hub: p.hub, product: p.product, opening_stock: p.counted_stock, received: 0, issued: 0, counted_stock: null, unit_price: p.unit_price }));
      draw();
      toast(`${add.length} products added with opening stock = last month's count. Fill in received, given out and counted.`);
    }));
    $("#save")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const out = [];
      for (const tr of $$("tbody tr", grid)) {
        const r = rows[tr.dataset.i];
        if (!r._dirty) continue;
        const v = read(tr);
        const product = v.product ?? r.product;
        if (!product) throw new Error("Every line needs a product name");
        if (v.counted_stock === "") throw new Error(`${product}: enter the counted stock`);
        if (v.unit_price === "") throw new Error(`${product}: enter the unit price`);
        out.push({ period: state.period, hub: v.hub ?? r.hub, product, opening_stock: v.opening_stock || 0, received: v.received || 0, issued: v.issued || 0,
          counted_stock: v.counted_stock, unit_price: v.unit_price });
      }
      rows.filter((r) => r._state === "deleted").forEach((r) => out.push({ period: state.period, hub: r.hub, product: r.product, _delete: true }));
      if (!out.length) return toast("Nothing to save", "warn");
      const res = await post("/api/hubstock/bulk", { rows: out });
      toast(`Branch stock saved — ${res.created} added, ${res.updated} updated${res.deleted ? `, ${res.deleted} removed` : ""}`);
      this.render(ctx);
    }));
  },
};
