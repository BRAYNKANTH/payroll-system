import { get, post, put, del } from "../api.js";
import { state } from "../app.js";
import { exportButtons, confirmDialog, esc, $, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, pct, parseAmount } from "../ui.js";

// Of every sale the workers get a share (seller + manager, 45% at first); the company keeps the rest, and the purchase price comes out of that.
const slToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const dateText = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shares = () => ({ seller: Number(state.settings.product_seller_share ?? 0.25), manager: Number(state.settings.product_manager_share ?? 0.2) });

// All in cents, the same split the server uses (products.economics).
function split(priceCents, costCents) {
  const s = shares();
  const seller = Math.round(priceCents * s.seller), manager = Math.round(priceCents * s.manager);
  const company = priceCents - seller - manager;
  return { seller, manager, company, profit: company - costCents, margin: priceCents ? (company - costCents) / priceCents : 0 };
}

export default {
  filters: false, // this page has no use for the hub and month bar, so it is not shown
  title: "Products",
  async render(ctx) {
    const { el } = ctx;
    const reload = () => this.render(ctx);
    const rows = await get("/api/products");
    const s = shares();
    const workers = pct(s.seller + s.manager, 0);

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Products</h1><p>What the company sells. Of every sale the workers get ${workers} (${pct(s.seller, 0)} to the seller, ${pct(s.manager, 0)} to their manager). The company keeps the rest, and the purchase price comes out of that.</p></div>
        <div class="actions">${exportButtons("products")}<button class="btn" id="import">${icon("upload")} Import from Excel</button><button class="btn primary" id="add">${icon("plus")} Add product</button></div>
      </div>
      <div class="card"><div class="card-body flush" id="list"></div></div>`;

    $("#list").innerHTML = rows.length ? dataTable({
      rows, empty: "No products yet", emptyHint: "Add products so they can be sent to hubs and sold.", onRow: (p) => open(p), rowLabel: (p) => `Edit ${p.name}`, rowAction: "Edit",
      // On a phone each product is one short line: the name, what it sells for and earns, and how many the office holds. Tap it for everything else.
      card: (p) => html`<span class="mc-main"><b>${p.name}</b><span class="mc-sub">Sells Rs ${money(p.list_price)} · profit <span class="${p.profit < 0 ? "neg" : ""}">Rs ${money(p.profit)}</span></span></span>
        <span class="mc-end"><b class="${p.office_stock < 1 ? "neg" : ""}">${p.office_stock}</b> <span class="muted">in the office</span><br>${badge(p.status)}</span>`,
      cols: [
        { key: "name", label: "Product", render: (p) => html`<b>${p.name}</b>` },
        { key: "office_stock", label: "In the office", align: "r", render: (p) => html`<b class="${p.office_stock < 1 ? "neg" : ""}">${p.office_stock}</b>` },
        { key: "list_price", label: "Selling price", align: "r", render: (p) => money(p.list_price) },
        { key: "cost_price", label: "Purchase price", align: "r", render: (p) => money(p.cost_price) },
        { key: "workers_share", label: `Workers ${workers}`, align: "r", render: (p) => money(p.workers_share) },
        { key: "company_share", label: "Company keeps", align: "r", render: (p) => money(p.company_share) },
        { key: "profit", label: "Profit per unit", align: "r", render: (p) => html`<b class="${p.profit < 0 ? "neg" : ""}">${money(p.profit)}</b>` },
        { key: "margin", label: "Of the price", align: "r", render: (p) => html`<span class="${p.profit < 0 ? "neg" : ""}">${pct(p.margin, 1)}</span>` },
        { key: "status", label: "Status", render: (p) => badge(p.status) },
        // Small buttons: add stock to this product, or delete it. They sit inside the row but do not open the edit panel.
        { key: "", label: "", sort: false, render: (p) => html`<span class="row-tools"><button type="button" class="btn sm" data-add-stock="${p.id}" aria-label="Add stock to ${p.name}">${icon("plus")} Stock</button>
          <button type="button" class="btn sm danger-ghost" data-del-product="${p.id}" aria-label="Delete ${p.name}">${icon("trash")}</button></span>` },
      ],
    }).toString() : emptyState("No products yet", "Add each product with its selling price and the price the company pays to buy it. The profit is worked out for you.", "box").toString();

    // Deleting asks first. The server refuses a product that was already sent to a hub, given to a seller or sold; make it Inactive instead.
    const remove = async (p, after) => {
      if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: `${p.name} will be removed from the product list${p.office_stock ? ` with its ${p.office_stock} pieces in the office` : ""}. This cannot be undone. A product that was already sent to a hub or sold cannot be deleted; set it to Inactive instead.`, confirmText: "Delete", danger: true }))) return;
      await del(`/api/products/${p.id}`);
      toast(`${p.name} deleted`);
      after?.();
      await reload();
    };
    $("#list").addEventListener("click", (e) => {
      const a = e.target.closest("[data-add-stock]"), x = e.target.closest("[data-del-product]");
      if (a) { const p = rows.find((r) => String(r.id) === a.dataset.addStock); if (p) { open(p); setTimeout(() => { const q = $("#os-qty"); q?.scrollIntoView({ block: "center" }); q?.focus(); }, 60); } }
      if (x) busy(x, () => remove(rows.find((r) => String(r.id) === x.dataset.delProduct)));
    });

    function open(p) {
      const d = drawer({
        title: p ? `Edit ${p.name}` : "Add product",
        body: html`<form id="pf" class="form-grid pform" autocomplete="off" novalidate>
          <div class="field full"><label for="pf-name">Product name <span class="req">*</span></label><input class="input" id="pf-name" name="name" value="${p?.name || ""}" required></div>
          <div class="field"><label for="pf-cost">Purchase price (Rs) <span class="req">*</span></label><input class="input" id="pf-cost" name="cost_price" inputmode="decimal" value="${p ? p.cost_price / 100 : ""}" required aria-describedby="pf-cost-h">
            <span class="hint" id="pf-cost-h">What the company pays to buy one.</span></div>
          <div class="field"><label for="pf-price">Selling price (Rs) <span class="req">*</span></label><input class="input" id="pf-price" name="list_price" inputmode="decimal" value="${p ? p.list_price / 100 : ""}" required aria-describedby="pf-price-h">
            <span class="hint" id="pf-price-h">What the seller sells it for.</span></div>
          ${p ? "" : html`<div class="field full"><label for="pf-open">Starting stock in the office (optional)</label><input class="input" id="pf-open" name="open_qty" inputmode="numeric" maxlength="7" placeholder="0"><span class="hint">How many pieces you have now. Today's date is used. You can add more later by editing the product.</span></div>`}
          ${p ? html`<div class="field full"><label for="pf-status">Status</label><select class="input" id="pf-status" name="status"><option value="active">Active</option><option value="inactive" ${p.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>` : ""}
          ${p ? html`<section class="ostock full" aria-label="Stock in the office">
            <h3>Stock in the office <span class="ostock-now"><b id="os-left">…</b> now</span></h3>
            <div class="ostock-form">
              <div class="field"><label for="os-date">Date</label><input class="input" type="date" id="os-date" value="${slToday()}" max="${slToday()}"></div>
              <div class="field"><label for="os-qty">Pieces added</label><input class="input" id="os-qty" inputmode="numeric" maxlength="7" placeholder="0"></div>
              <div class="field full"><label for="os-note">Note (optional)</label><input class="input" id="os-note" maxlength="200" placeholder="For example: delivery from the supplier"></div>
              <div class="full"><button type="button" class="btn primary" id="os-add">${icon("plus")} Add stock</button></div>
            </div>
            <ul class="os-list" id="os-list" aria-label="Latest stock added"></ul>
          </section>` : ""}
          <section class="pprev full" aria-label="Profit preview" aria-live="polite">
            <h3>Profit preview</h3>
            <dl>
              <div><dt>Purchase price</dt><dd data-v="cost">—</dd></div>
              <div><dt>Selling price</dt><dd data-v="price">—</dd></div>
              <div><dt>Workers ${workers}</dt><dd data-v="workers">—</dd><dd class="sub" data-v="split">seller ${pct(s.seller, 0)} · manager ${pct(s.manager, 0)}</dd></div>
              <div><dt>Company keeps</dt><dd data-v="company">—</dd></div>
              <div class="total"><dt>Profit per unit</dt><dd data-v="profit">—</dd><dd class="sub" data-v="margin">&nbsp;</dd></div>
            </dl>
            <div class="alert warn" data-v="loss" hidden>${icon("alert")}<div>The purchase price is more than the company keeps after the workers' share, so every unit sold makes a loss.</div></div>
          </section>
        </form>`.toString(),
        foot: `${p ? `<button class="btn danger" id="pf-del" style="margin-right:auto">${icon("trash")} Delete</button>` : ""}<button class="btn" data-close>Cancel</button><button class="btn primary" id="pf-save">${p ? "Save" : "Add product"}</button>`,
      });
      if (p) $("#pf-del", d.panel).onclick = (e) => busy(e.currentTarget, () => remove(p, () => d.close()));
      const f = $("#pf", d.panel);
      f.addEventListener("submit", (e) => e.preventDefault()); // Enter in a box must not reload the page
      const out = (k) => $(`[data-v="${k}"]`, d.panel);
      const rs = (c) => `Rs ${money(c)}`;
      // The numbers change as you type. Until a price is typed they stay blank.
      const draw = () => {
        const priceTxt = f.list_price.value.trim(), costTxt = f.cost_price.value.trim();
        const price = Math.round((parseAmount(priceTxt) || 0) * 100), cost = Math.round((parseAmount(costTxt) || 0) * 100);
        out("cost").textContent = Number.isFinite(parseAmount(costTxt)) ? rs(cost) : "—";
        out("price").textContent = price ? rs(price) : "—";
        const x = price ? split(price, cost) : null;
        out("workers").textContent = x ? `− ${rs(x.seller + x.manager)}` : "—";
        out("split").textContent = x ? `seller ${pct(s.seller, 0)} ${rs(x.seller)} · manager ${pct(s.manager, 0)} ${rs(x.manager)}` : `seller ${pct(s.seller, 0)} · manager ${pct(s.manager, 0)}`;
        out("company").textContent = x ? rs(x.company) : "—";
        const show = x && Number.isFinite(parseAmount(costTxt));
        const pr = out("profit");
        pr.textContent = show ? rs(x.profit) : "—";
        pr.classList.toggle("neg", !!(show && x.profit < 0));
        out("margin").textContent = show ? `${pct(x.margin, 1)} of the selling price` : "\u00a0";
        out("loss").hidden = !(show && x.profit < 0);
      };
      f.addEventListener("input", draw);
      draw();
      if (p) { // stock in the office: what it holds, adding more (today's date is filled in), and the latest additions
        const drawStock = async () => {
          const h = await get(`/api/products/${p.id}/stock`);
          $("#os-left", d.panel).textContent = h.left;
          $("#os-list", d.panel).innerHTML = h.receipts.length ? h.receipts.map((r) => html`<li><span><b>+${r.qty}</b> · ${dateText(r.date)}${r.note ? html` · <span class="muted">${r.note}</span>` : ""}</span>
            <button type="button" class="mc-x" data-rm="${r.id}" aria-label="Remove ${r.qty} added on ${dateText(r.date)}">${icon("x")}</button></li>`).join("") : `<li class="muted">Nothing added yet.</li>`;
        };
        drawStock();
        const add = () => busy($("#os-add", d.panel), async () => {
          const qty = $("#os-qty", d.panel);
          if (!/^[0-9,]+$/.test(qty.value.trim()) || Number(qty.value.replace(/,/g, "")) < 1) { qty.setAttribute("aria-invalid", "true"); qty.focus(); throw new Error("Enter how many pieces were added, for example 100"); }
          qty.removeAttribute("aria-invalid");
          await post(`/api/products/${p.id}/stock`, { qty: qty.value, date: $("#os-date", d.panel).value, note: $("#os-note", d.panel).value });
          toast(`Stock added to ${p.name}`);
          qty.value = ""; $("#os-note", d.panel).value = "";
          await drawStock();
          await reload();
        });
        $("#os-add", d.panel).onclick = add;
        $("#os-qty", d.panel).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
        $("#os-list", d.panel).onclick = (e) => busy(e.target.closest("[data-rm]") || e.target, async () => {
          const b = e.target.closest("[data-rm]"); if (!b) return;
          await del(`/api/product-stock/${b.dataset.rm}`);
          toast("Stock line removed");
          await drawStock();
          await reload();
        });
      }
      $("#pf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const bad = (el, msg) => { el.setAttribute("aria-invalid", "true"); el.focus(); throw new Error(msg); };
        if (!f.name.value.trim()) bad(f.name, "Enter the product's name");
        if (!(parseAmount(f.cost_price.value) >= 0) || !f.cost_price.value.trim()) bad(f.cost_price, "Enter the purchase price, for example 300");
        if (!(parseAmount(f.list_price.value) > 0)) bad(f.list_price, "Enter the selling price, for example 850");
        const v = Object.fromEntries(new FormData(f));
        const open = Number(String(v.open_qty || "").replace(/,/g, ""));
        if (!p && v.open_qty && (!Number.isInteger(open) || open < 0)) bad(f.open_qty, "Starting stock must be a whole number, or leave it empty");
        delete v.open_qty;
        if (p) await put(`/api/products/${p.id}`, v);
        else {
          const made = await post("/api/products", v);
          if (open > 0) await post(`/api/products/${made.id}/stock`, { qty: open, note: "Starting stock" });
        }
        toast(p ? "Product updated" : `${v.name} added`);
        d.close();
        await reload();
      });
    }
    $("#add").onclick = () => open(null);

    // ---------------------------------------------------------------- bulk upload from an Excel or CSV file
    // 1. download the sample template and fill it in   2. choose the file: every row is checked and shown   3. import (only when no row has an error)
    const base64 = (buf) => { let s = ""; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
    const ACTION = { new: ["green", "New"], update: ["amber", "Update"], same: ["plain", "No change"], skip: ["plain", "Ignored"], error: ["red", "Error"] };
    $("#import").onclick = () => {
      const d = drawer({
        title: "Import products from Excel",
        body: html`<ol class="imp-steps">
            <li><b>Download the sample file</b> and fill it in: one product per row. <a href="/api/products/template.xlsx" download>Excel template</a> · <a href="/api/products/template.csv" download>CSV template</a>
              <div class="muted">Columns: product name, selling price, purchase price, pieces to add to the office stock (optional), status (optional). Prices are in rupees. A product that already exists (same name) gets the new prices, and its pieces are added as a delivery. Rows starting with "Example:" are ignored.</div></li>
            <li><b>Choose your file</b> (.xlsx or .csv). Every row is checked first and nothing changes yet.
              <div class="mt-2"><input type="file" id="imp-file" class="input" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="max-width:380px;padding-top:6px" aria-label="Choose the Excel or CSV file"></div></li>
            <li><b>Check the list</b> below, then press Import.</li></ol>
          <div id="imp-out" aria-live="polite"></div>`.toString(),
        foot: `<button class="btn" data-close>Close</button><button class="btn primary" id="imp-go" disabled>Import</button>`,
      });
      let file = null, last = null;
      const out = $("#imp-out", d.panel), go = $("#imp-go", d.panel);
      const send = async (commit) => post("/api/products/import", { filename: file.name, data: base64(await file.arrayBuffer()), commit });
      $("#imp-file", d.panel).onchange = async (e) => {
        file = e.target.files[0]; last = null; go.disabled = true;
        if (!file) { out.innerHTML = ""; return; }
        out.innerHTML = `<p class="muted">Checking ${esc(file.name)}…</p>`;
        try { last = await send(false); } catch (err) { out.innerHTML = html`<div class="alert err" role="alert">${icon("alert")}<div>${err.message}</div></div>`.toString(); return; }
        const c = last.counts, rows = last.rows.slice(0, 400);
        const doable = c.new + c.update;
        out.innerHTML = html`<div class="imp-sum">${badge("green", `${c.new} new`)} ${badge("amber", `${c.update} to update`)} ${c.same ? badge("plain", `${c.same} no change`) : ""} ${c.skip ? badge("plain", `${c.skip} ignored`) : ""} ${c.error ? badge("red", `${c.error} with errors`) : ""}</div>
          ${c.error ? html`<div class="alert err" role="alert">${icon("alert")}<div><b>${c.error} ${c.error === 1 ? "row has" : "rows have"} an error.</b> Fix them in your file and choose it again. Nothing is imported until every row is right.</div></div>` : ""}
          <div class="table-wrap imp-table" tabindex="0" role="region" aria-label="What the import will do"><table class="table"><thead><tr><th scope="col">Row</th><th scope="col">Product</th><th scope="col" class="r">Selling</th><th scope="col" class="r">Purchase</th><th scope="col" class="r">Pieces</th><th scope="col">What happens</th></tr></thead>
            <tbody>${rows.map((r) => html`<tr class="${r.action === "error" ? "error" : ""}"><td>${r.line}</td><td><b>${r.name || "—"}</b></td><td class="r">${r.selling === null || r.selling === undefined ? "—" : money(Math.round(r.selling * 100))}</td><td class="r">${r.purchase === null || r.purchase === undefined ? "—" : money(Math.round(r.purchase * 100))}</td><td class="r">${r.stock || "—"}</td>
              <td>${badge(...ACTION[r.action])}${r.message ? html`<div class="${r.action === "error" ? "neg" : "muted"} text-sm">${r.message}</div>` : ""}</td></tr>`)}</tbody></table></div>
          ${last.rows.length > rows.length ? html`<p class="muted">Showing the first ${rows.length} of ${last.rows.length} rows. All are imported.</p>` : ""}`.toString();
        go.disabled = c.error > 0 || doable === 0;
        go.textContent = doable ? `Import ${doable} ${doable === 1 ? "product" : "products"}` : "Nothing to import";
      };
      go.onclick = (e) => busy(e.currentTarget, async () => {
        const r = await send(true);
        toast(`${r.created} added, ${r.updated} updated${r.stock_added ? `, ${r.stock_added} pieces added to the office stock` : ""}`);
        d.close();
        await reload();
      });
    };
  },
};
