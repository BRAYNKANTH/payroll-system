import { get, post, put, del } from "../api.js";
import { state } from "../app.js";
import { exportButtons, $, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, pct, parseAmount } from "../ui.js";

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
        <div class="actions">${exportButtons("products")}<button class="btn primary" id="add">${icon("plus")} Add product</button></div>
      </div>
      <div class="card"><div class="card-body flush" id="list"></div></div>`;

    $("#list").innerHTML = rows.length ? dataTable({
      rows, empty: "No products yet", emptyHint: "Add products so they can be sent to hubs and sold.", onRow: (p) => open(p), rowLabel: (p) => `Edit ${p.name}`, rowAction: "Edit",
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
      ],
    }).toString() : emptyState("No products yet", "Add each product with its selling price and the price the company pays to buy it. The profit is worked out for you.", "box").toString();

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
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pf-save">${p ? "Save" : "Add product"}</button>`,
      });
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
  },
};
