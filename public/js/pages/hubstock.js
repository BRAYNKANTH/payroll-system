import { get, post, qs } from "../api.js";
import { state, can, scopeHub, setDirtyCheck } from "../app.js";
import { $, $$, html, icon, money, toast, busy, confirmDialog, emptyState, fromCents, parseAmount } from "../ui.js";
import { sheetKeys, periodLocked, lockedBanner, badNumber, stockNum, markBadNumbers } from "./shared.js";
import { isPhone, stackTable } from "../phone.js";

const INTS = ["opening_stock", "received", "issued", "counted_stock"];
// Same words as the column headings, so a screen reader says what is on screen.
const LABEL = { opening_stock: "Opening", received: "Received", issued: "Given out", counted_stock: "Counted" };
const prevPeriod = (p) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export default {
  title: "Hub stock",
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
        <div><h1>Hub stock</h1><p>Each hub's stock for the month. Expected = opening + received − given out. Difference = expected − counted.</p></div>
        <div class="actions">${editable ? html`
          <button type="button" class="btn" id="carry">${icon("copy")} Open from last month's count</button>
          <button type="button" class="btn" id="add" ${hubs.length ? "" : "disabled"}>${icon("plus")} Add product</button>` : ""}</div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card"><div class="card-body flush" id="grid"></div>
        ${editable ? html`<div class="row between card-foot">
          <span class="muted" id="info"></span><button type="button" class="btn primary" id="save">${icon("check")} Save hub stock</button></div>` : ""}</div>`;

    const grid = $("#grid");
    let rows = lines.map((l) => ({ ...l, _state: "saved" }));
    const hubOptions = (sel) => hubs.map((h) => html`<option value="${h.code}" ${h.code === sel ? "selected" : ""}>${h.name}</option>`);
    // The app asks before leaving the page while lines have unsaved edits (deleted lines too).
    if (editable) setDirtyCheck(() => rows.filter((r) => r._state === "deleted" || (r._dirty && r._state !== "gone")).length);

    const draw = () => {
      if (!rows.length) {
        grid.innerHTML = emptyState("No hub stock for this month", editable ? "Add a product, or open the month from last month's count." : "", "box").toString();
        return;
      }
      grid.innerHTML = html`<div class="table-wrap"><table class="table sheet">
        <thead><tr><th scope="col">Hub</th><th scope="col">Product</th><th scope="col" class="r">Opening</th><th scope="col" class="r">Received</th><th scope="col" class="r">Given out</th><th scope="col" class="r">Counted</th>
          <th scope="col" class="r">Unit price</th><th scope="col" class="r">Expected</th><th scope="col" class="r">Difference</th><th scope="col" class="r">Stock value</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
        <tbody>${rows.map((r, i) => {
          if (r._state === "deleted") return "";
          const product = r._draft?.product ?? r.product;
          const hub = hubName(r._draft?.hub ?? r.hub);
          const ctxLabel = `${product || "new product"}, ${hub || "new line"}`;
          return html`<tr data-i="${i}" class="${r._state === "new" ? "dirty" : ""}">
          <td class="name">${r.id ? html`<b>${hubName(r.hub)}</b><div class="faint text-sm">${r.hub}</div>`
            : html`<select class="input sm" data-f="hub" aria-label="Hub" style="min-width:140px">${hubOptions(r._draft?.hub ?? r.hub)}</select>`}</td>
          <td>${r.id ? html`<b>${r.product}</b>` : html`<input class="text" data-f="product" aria-label="Product name" value="${r._draft?.product ?? r.product ?? ""}" placeholder="Product name">`}</td>
          ${INTS.map((k) => html`<td><input data-f="${k}" data-num aria-label="${LABEL[k]}, ${ctxLabel}" inputmode="numeric" value="${r._draft?.[k] ?? r[k] ?? ""}" ${editable ? "" : "disabled"} style="min-width:70px"></td>`)}
          <td><input data-f="unit_price" data-num aria-label="Unit price in rupees, required, ${ctxLabel}" aria-required="true" placeholder="Price" inputmode="decimal" value="${r._draft?.unit_price ?? (r.unit_price != null ? fromCents(r.unit_price) : "")}" ${editable ? "" : "disabled"}></td>
          <td class="calc" data-e></td><td class="calc" data-q></td><td class="calc" data-v></td>
          <td>${editable ? html`<button type="button" class="btn sm icon danger-ghost" data-del="${i}" aria-label="Remove ${product || "new product"} at ${hub}">${icon("trash")}</button>` : ""}</td>
        </tr>`;
        })}</tbody>
        <tfoot><tr><td colspan="8">Totals</td><td class="r" id="tot-short"></td><td class="r" id="tot-val"></td><td></td></tr></tfoot></table></div>`.toString();
      if (isPhone()) stackTable(grid.querySelector("table"));
      refresh();
    };

    // Redrawing rebuilds the table from `rows`, so keep what has been typed so far in a per-row draft.
    const read = (tr) => Object.fromEntries([...tr.querySelectorAll("[data-f]")].map((i) => [i.dataset.f, i.value.trim()]));
    const snap = () => $$("tbody tr", grid).forEach((tr) => { const r = rows[tr.dataset.i]; if (r) r._draft = read(tr); });
    const refresh = () => {
      let short = 0, value = 0, dirty = 0, bad = 0;
      $$("tbody tr", grid).forEach((tr) => {
        const r = rows[tr.dataset.i];
        const v = read(tr);
        if (markBadNumbers(tr)) {
          // Not a number: say so instead of showing NaN, and keep it out of the totals.
          tr.querySelector("[data-e]").textContent = "—";
          tr.querySelector("[data-q]").textContent = "—";
          tr.querySelector("[data-v]").innerHTML = `<span class="neg">Check the numbers</span>`;
          tr.classList.add("dirty");
          r._dirty = true;
          bad++; dirty++;
          return;
        }
        const n = (k) => stockNum(v[k]);
        const price = Math.round(n("unit_price") * 100);
        const expected = n("opening_stock") + n("received") - n("issued");
        const q = expected - n("counted_stock");
        tr.querySelector("[data-e]").textContent = expected;
        tr.querySelector("[data-q]").innerHTML = v.counted_stock === "" ? "" : `<span class="${q > 0 ? "neg" : q < 0 ? "pos" : ""}">${q > 0 ? `${q} short` : q < 0 ? `${-q} over` : "0"}</span>`;
        tr.querySelector("[data-v]").textContent = v.counted_stock === "" ? "" : money(n("counted_stock") * price);
        if (v.counted_stock !== "") { short += Math.max(0, q) * price; value += n("counted_stock") * price; }
        const changed = r._state === "new" || INTS.some((k) => n(k) !== (r[k] ?? 0)) || price !== r.unit_price;
        tr.classList.toggle("dirty", changed);
        r._dirty = changed;
        if (changed) dirty++;
      });
      if ($("#tot-short")) $("#tot-short").innerHTML = short ? `<span class="neg">${money(short)} short</span>` : "—";
      if ($("#tot-val")) $("#tot-val").innerHTML = `<b>${money(value)}</b>`;
      if ($("#info")) $("#info").innerHTML = (bad ? `<span class="neg">${bad} line${bad > 1 ? "s have" : " has"} a number that isn't valid. </span>` : "") +
        (dirty ? `${dirty} line${dirty > 1 ? "s" : ""} changed` : "No unsaved changes");
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
      const trs = $$("tbody tr", grid);
      const name = (tr) => read(tr).product || rows[tr.dataset.i].product || "a new product";
      const listOf = (bad, n) => (bad.length === 1 ? name(bad[0]) : `${bad.length} products: ${bad.slice(0, n).map(name).join(", ")}${bad.length > n ? "…" : ""}`);
      // Numbers that are not numbers: name the lines and put the cursor on the first bad field.
      const badRows = trs.filter((tr) => rows[tr.dataset.i]._dirty && markBadNumbers(tr));
      if (badRows.length) {
        [...badRows[0].querySelectorAll("input[data-num]")].find((i) => badNumber(i.dataset.f, i.value))?.focus();
        throw new Error(`Check the numbers for ${listOf(badRows, 5)}. Stock is a whole number of units, and a price looks like 850 or 850.50.`);
      }
      // Every product needs a price. Name all the lines that lack one, mark them, and put the cursor on the first.
      const noPrice = trs.filter((tr) => rows[tr.dataset.i]._dirty && read(tr).unit_price === "");
      if (noPrice.length) {
        noPrice.forEach((tr) => { const i = tr.querySelector("[data-f=unit_price]"); i.dataset.missing = "1"; i.setAttribute("aria-invalid", "true"); });
        noPrice[0].querySelector("[data-f=unit_price]").focus();
        throw new Error(`Add a price for ${listOf(noPrice, 5)}. Every product needs a unit price.`);
      }
      for (const tr of trs) {
        const r = rows[tr.dataset.i];
        if (!r._dirty) continue;
        const v = read(tr);
        const product = v.product ?? r.product;
        if (!product) { tr.querySelector("[data-f=product]")?.focus(); throw new Error("Every line needs a product name"); }
        if (v.counted_stock === "") { tr.querySelector("[data-f=counted_stock]")?.focus(); throw new Error(`${product}: enter the counted stock`); }
        out.push({ period: state.period, hub: v.hub ?? r.hub, product, opening_stock: v.opening_stock || 0, received: v.received || 0, issued: v.issued || 0,
          counted_stock: v.counted_stock, unit_price: String(parseAmount(v.unit_price)) });
      }
      rows.filter((r) => r._state === "deleted").forEach((r) => out.push({ period: state.period, hub: r.hub, product: r.product, _delete: true }));
      if (!out.length) return toast("Nothing to save", "warn");
      const res = await post("/api/hubstock/bulk", { rows: out });
      toast(`Hub stock saved — ${res.created} added, ${res.updated} updated${res.deleted ? `, ${res.deleted} removed` : ""}`);
      setDirtyCheck(null);
      this.render(ctx);
    }));
  },
};
