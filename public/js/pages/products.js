import { get, post, put } from "../api.js";
import { state } from "../app.js";
import { $, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, pct, parseAmount } from "../ui.js";

// Of every sale the workers get a share (seller + manager, 45% at first); the company keeps the rest, and the purchase price comes out of that.
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
    const rows = await get("/api/products");
    const s = shares();
    const workers = pct(s.seller + s.manager, 0);

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Products</h1><p>What the company sells. Of every sale the workers get ${workers} (${pct(s.seller, 0)} to the seller, ${pct(s.manager, 0)} to his manager). The company keeps the rest, and the purchase price comes out of that.</p></div>
        <div class="actions"><button class="btn primary" id="add">${icon("plus")} Add product</button></div>
      </div>
      <div class="card"><div class="card-body flush" id="list"></div></div>`;

    $("#list").innerHTML = rows.length ? dataTable({
      rows, empty: "No products yet", onRow: (p) => open(p), rowLabel: (p) => `Edit ${p.name}`, rowAction: "Edit",
      cols: [
        { key: "name", label: "Product", render: (p) => html`<b>${p.name}</b>` },
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
        body: html`<form id="pf" class="form-grid" autocomplete="off">
          <div class="field full"><label for="pf-name">Product name</label><input class="input" id="pf-name" name="name" value="${p?.name || ""}" required></div>
          <div class="field"><label for="pf-price">Selling price (Rs)</label><input class="input" id="pf-price" name="list_price" inputmode="decimal" value="${p ? p.list_price / 100 : ""}" required></div>
          <div class="field"><label for="pf-cost">Purchase price (Rs)</label><input class="input" id="pf-cost" name="cost_price" inputmode="decimal" value="${p ? p.cost_price / 100 : ""}" required>
            <span class="hint">What the company pays to buy one. Change it when the buying price changes.</span></div>
          ${p ? html`<div class="field"><label for="pf-status">Status</label><select class="input" id="pf-status" name="status"><option value="active">Active</option><option value="inactive" ${p.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>` : ""}
          <div class="field full" id="pf-preview" aria-live="polite"></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pf-save">${p ? "Save" : "Add product"}</button>`,
      });
      const f = $("#pf", d.panel);
      const draw = () => {
        const price = Math.round((parseAmount(f.list_price.value) || 0) * 100), cost = Math.round((parseAmount(f.cost_price.value) || 0) * 100);
        const box = $("#pf-preview", d.panel);
        if (!price) { box.innerHTML = `<div class="muted">Enter the selling price and the purchase price to see the profit.</div>`; return; }
        const x = split(price, cost);
        box.innerHTML = html`<div class="card" style="box-shadow:none"><div class="card-body"><dl class="kv">
          <dt>Selling price</dt><dd>Rs ${money(price)}</dd>
          <dt>Workers ${workers}</dt><dd>− Rs ${money(x.seller + x.manager)} <span class="faint">(seller ${pct(s.seller, 0)} Rs ${money(x.seller)} · manager ${pct(s.manager, 0)} Rs ${money(x.manager)})</span></dd>
          <dt>Company keeps</dt><dd>Rs ${money(x.company)}</dd>
          <dt>Purchase price</dt><dd>− Rs ${money(cost)}</dd>
          <dt>Profit per unit</dt><dd><b class="${x.profit < 0 ? "neg" : ""}">Rs ${money(x.profit)}</b> <span class="faint">${pct(x.margin, 1)} of the selling price</span></dd></dl>
          ${x.profit < 0 ? html`<div class="alert warn" style="margin-top:10px">${icon("alert")}<div>The purchase price is more than the company keeps after the workers' share, so every unit sold makes a loss.</div></div>` : ""}
        </div></div>`.toString();
      };
      f.addEventListener("input", draw);
      draw();
      $("#pf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData(f));
        if (p) await put(`/api/products/${p.id}`, v); else await post("/api/products", v);
        toast(p ? "Product updated" : `${v.name} added`);
        d.close();
        this.render(ctx);
      });
    }
    $("#add").onclick = () => open(null);
  },
};
