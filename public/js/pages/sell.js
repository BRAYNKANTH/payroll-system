// The till: a seller records each sale as it happens. Search a product, pick it, set the quantity, tap Sell.
// The date is always today and the price is always the list price. Under the till sit the seller's stock for the day
// (what the hub gave them and what is left), the sales made so far, and the cash handed in at the end of the day.
import { get, post, del } from "../api.js";
import { buzz, $, $$, html, raw, esc, icon, toast, busy, confirmDialog, emptyState, announce } from "../ui.js";

const n0 = (c) => (Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 });
const rs = (c) => `Rs ${n0(c)}`;
const when = (iso) => { try { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" }); } catch { return ""; } };
const dayLabel = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const LOW = 3; // this many or fewer pieces left shows as "low"

// Mounts the till into `box`. `onChanged` runs after anything is saved, so the rest of the page can refresh its totals.
export async function mountSell(box, { onChanged = () => {} } = {}) {
  let st = await get("/api/me/pos");
  let query = "", picked = null, qty = 1;
  let subtab = "sell"; // 'sell' (till grid), 'sales' (today's history), 'stock' (balance table), 'eod' (end of day)

  const stockRow = (p) => html`<tr class="${p.left === 0 ? "none" : ""}">
    <th scope="row">${p.name}<span class="ts-sub">Carried ${p.carried} · Given ${p.issued} · Sold ${p.sold}</span></th>
    <td>${p.carried}</td><td>${p.issued}</td><td>${p.sold}</td>
    <td class="left ${p.left > 0 && p.left <= LOW ? "low" : ""}"><b>${p.left}</b>${p.left > 0 && p.left <= LOW ? html`<span class="tag">Low</span>` : ""}</td>
  </tr>`;

  const draw = () => {
    // Without a search only the products the seller still has are shown; searching finds any product.
    const visible = st.products.filter((p) => p.active && (query ? p.name.toLowerCase().includes(query.toLowerCase()) : p.left > 0));
    const inHand = st.products.filter((p) => p.carried || p.issued || p.sold || p.left);
    const sel = picked ? st.products.find((p) => p.id === picked) : null;
    if (picked && (!sel || sel.left < 1)) { picked = null; }
    const day = st.day;

    box.innerHTML = html`
      <!-- Compact Apple iOS Till Header -->
      <section class="till-head card" aria-label="Today">
        <div class="th-left">
          <div class="th-date">${dayLabel(st.date)}</div>
          <div class="th-total"><small>Rs</small>${n0(st.totals.amount)}</div>
          <div class="th-sub">${st.totals.count} ${st.totals.count === 1 ? "sale" : "sales"} · ${st.totals.qty} ${st.totals.qty === 1 ? "piece" : "pieces"} sold today</div>
        </div>
        <div class="th-right">
          <button type="button" class="eod-jump-btn" data-subtab="eod" aria-label="End of day status">
            <span>End of day</span>
            <b class="${day.not_handed_in ? "neg" : ""}">${rs(day.not_handed_in || 0)}</b>
          </button>
        </div>
        ${st.locked ? html`<div class="till-lock full">${icon("lock")} ${st.closed ? "This month is closed." : "The office has recorded today, so it can no longer be changed here."}</div>` : ""}
      </section>

      <!-- Sub-tabs: Sell, Sales history, Stock, End of Day -->
      <div class="till-nav-wrap">
        <div class="seg till-nav" role="tablist" aria-label="Till sections">
          <button type="button" class="${subtab === "sell" ? "on" : ""}" data-subtab="sell" role="tab" aria-selected="${subtab === "sell"}">${icon("bag")} Sell</button>
          <button type="button" class="${subtab === "sales" ? "on" : ""}" data-subtab="sales" role="tab" aria-selected="${subtab === "sales"}">${icon("tag")} Sales ${st.lines.length ? html`<span class="badge plain sm">${st.lines.length}</span>` : ""}</button>
          <button type="button" class="${subtab === "stock" ? "on" : ""}" data-subtab="stock" role="tab" aria-selected="${subtab === "stock"}">${icon("box")} Stock</button>
          <button type="button" class="${subtab === "eod" ? "on" : ""}" data-subtab="eod" role="tab" aria-selected="${subtab === "eod"}">${icon("check")} Day End</button>
        </div>
      </div>

      <!-- VIEW: SELL PRODUCTS (TILL) -->
      ${subtab === "sell" ? html`
        ${st.locked ? html`
        <section class="card till-pick" aria-label="Sell a product">
          <div class="card-body"><div class="alert warn">${icon("lock")}<div><b>Selling is switched off for today.</b> ${st.closed ? "This month is closed." : "The office has already entered today's figures, so sales can no longer be added here."}</div></div></div>
        </section>` : html`
        <section class="card till-pick" aria-label="Sell a product">
          <div class="card-body">
            ${st.products.length && st.products.every((p) => p.left < 1) ? html`<div class="alert warn mb-3">${icon("box")}<div><b>You have no stock left to sell.</b> Ask your coacher or hub for more stock.</div></div>` : ""}
            
            <div class="till-search">
              <span aria-hidden="true">${icon("search")}</span>
              <input id="ts" class="input" type="search" inputmode="search" autocomplete="off" placeholder="Search products..." aria-label="Search products" value="${query}">
              ${query ? html`<button type="button" class="ts-clear" id="ts-clear" aria-label="Clear search">${icon("x")}</button>` : ""}
            </div>

            ${visible.length ? html`
              <div class="till-grid" role="group" aria-label="Products">
                ${visible.map((p) => html`
                  <button type="button" class="till-prod ${picked === p.id ? "on" : ""} ${p.left < 1 ? "out" : ""}" data-p="${p.id}" aria-pressed="${picked === p.id}" ${p.left < 1 ? "disabled" : ""}>
                    <span class="tp-name">${p.name}</span>
                    <div class="tp-bottom">
                      <span class="tp-price">${rs(p.price)}</span>
                      <span class="tp-badge ${p.left < 1 ? "none" : p.left <= LOW ? "low" : "ok"}">${p.left < 1 ? "None" : `${p.left} left`}</span>
                    </div>
                  </button>`)}
              </div>`
              : html`<p class="muted" style="margin:14px 0 0">${!st.products.some((p) => p.active) ? "There are no products yet. Ask the office to add them." : query ? `No product matches “${query}”.` : "You have nothing left to sell. Search to see all products."}</p>`}
          </div>
        </section>`}

        <!-- Active Product Action Sheet (Apple Bottom Sheet) -->
        ${sel && !st.locked ? html`
        <section class="till-sheet card" aria-label="Sell ${sel.name}">
          <div class="ts-handle" aria-hidden="true"></div>
          <div class="ts-top">
            <div>
              <b class="ts-name">${sel.name}</b>
              <div class="ts-meta">${rs(sel.price)} each · <span class="badge ${sel.left <= LOW ? "amber" : "green"} plain">${sel.left} in stock</span></div>
            </div>
            <button type="button" class="btn ghost icon sm" id="ts-close" aria-label="Close product selection">${icon("x")}</button>
          </div>

          <div class="ts-controls">
            <div class="ts-qty" role="group" aria-label="Quantity">
              <button type="button" class="ts-step" id="q-minus" aria-label="One less" ${qty <= 1 ? "disabled" : ""}>${icon("minus")}</button>
              <input id="q" class="input" type="text" inputmode="numeric" pattern="[0-9]*" value="${qty}" aria-label="Quantity" maxlength="4">
              <button type="button" class="ts-step" id="q-plus" aria-label="One more" ${qty >= sel.left ? "disabled" : ""}>${icon("plus")}</button>
            </div>
            <div class="ts-quick" aria-label="Quick quantity">
              ${[1, 2, 3, 5, 10].filter((n) => n <= sel.left).map((n) => html`<button type="button" class="chip-btn ${qty === n ? "on" : ""}" data-q="${n}">${n}</button>`)}
              ${sel.left > 1 && !([1, 2, 3, 5, 10].includes(sel.left)) ? html`<button type="button" class="chip-btn ${qty === sel.left ? "on" : ""}" data-q="${sel.left}">All (${sel.left})</button>` : ""}
            </div>
          </div>

          <button type="button" class="till-sell" id="sell">
            <span>Sell ${qty} × ${sel.name}</span>
            <b>${rs(qty * sel.price)}</b>
          </button>
        </section>` : ""}

        <!-- Compact quick-bar linking to history and end-of-day -->
        <div class="till-quick-bar">
          <span>${st.totals.count} sale${st.totals.count === 1 ? "" : "s"} (${rs(st.totals.amount)})</span>
          <div class="row" style="gap:6px">
            <button type="button" class="btn sm ghost" data-subtab="sales">View sales</button>
            <button type="button" class="btn sm primary" data-subtab="eod">Day End</button>
          </div>
        </div>
      ` : ""}

      <!-- VIEW: TODAY'S SALES HISTORY -->
      ${subtab === "sales" ? html`
        <section class="card" aria-label="Today's sales">
          <div class="card-head">
            <div>
              <h2>Today's sales</h2>
              <div class="sub">Total: ${rs(st.totals.amount)} (${st.totals.count} ${st.totals.count === 1 ? "sale" : "sales"})</div>
            </div>
            <button type="button" class="btn sm ghost" data-subtab="sell">${icon("left")} Till</button>
          </div>
          ${st.lines.length ? html`
            <ul class="till-lines" role="list">
              ${st.lines.map((l) => html`
                <li>
                  <div class="tl-main">
                    <b>${l.qty} × ${l.product}</b>
                    <span class="muted">${when(l.at)} · ${rs(l.unit_price)} each</span>
                  </div>
                  <div class="tl-amt">${rs(l.amount)}</div>
                  ${l.can_undo ? html`<button type="button" class="btn sm danger-ghost" data-undo="${l.id}" aria-label="Undo sale of ${l.qty} ${l.product}">Undo</button>` : ""}
                </li>`)}
            </ul>`
            : html`<div class="card-body">${emptyState("No sales yet today", "Recorded sales will show here with instant undo.", "tag")}</div>`}
        </section>
      ` : ""}

      <!-- VIEW: MY STOCK TODAY -->
      ${subtab === "stock" ? html`
        <section class="card" aria-label="My stock today">
          <div class="card-head">
            <div>
              <h2>My stock today</h2>
              <div class="sub">What the hub issued you and what is left to sell</div>
            </div>
            <button type="button" class="btn sm ghost" data-subtab="sell">${icon("left")} Till</button>
          </div>
          ${inHand.length ? html`
            <div class="card-body flush">
              <div class="table-wrap">
                <table class="till-stock">
                  <caption class="sr-only">My stock today</caption>
                  <thead><tr><th scope="col">Product</th><th scope="col">Carried</th><th scope="col">Given</th><th scope="col">Sold</th><th scope="col">Left</th></tr></thead>
                  <tbody>${inHand.map(stockRow)}</tbody>
                </table>
              </div>
            </div>`
            : html`<div class="card-body">${emptyState("No stock yet today", "Your hub gives you stock in the morning. It appears here once recorded.", "box")}</div>`}
        </section>
      ` : ""}

      <!-- VIEW: END OF DAY -->
      ${subtab === "eod" ? html`
        <section class="card" aria-label="End of day">
          <div class="card-head">
            <div>
              <h2>End of day</h2>
              <div class="sub">Enter the cash handed in. Your hub head will confirm the day.</div>
            </div>
            <button type="button" class="btn sm ghost" data-subtab="sell">${icon("left")} Till</button>
          </div>
          <form id="eod" class="card-body form-grid" autocomplete="off">
            <div class="field"><label for="eod-set">Money handed in (Rs)</label><input class="input" id="eod-set" name="settled_amount" inputmode="decimal" placeholder="0" value="${day.recorded && day.settled ? n0(day.settled).replace(/,/g, "") : ""}" ${st.locked || !st.totals.count ? "disabled" : ""}></div>
            <div class="field"><label for="eod-adv">Advance taken (Rs)</label><input class="input" id="eod-adv" name="personal_minus" inputmode="decimal" placeholder="0" value="${day.personal ? n0(day.personal).replace(/,/g, "") : ""}" ${st.locked || !st.totals.count ? "disabled" : ""}></div>
            <div class="full eod-sum" role="status">
              <span>Sold today</span><b>${rs(st.totals.amount)}</b>
              <span>Not handed in yet</span><b class="${day.not_handed_in ? "neg" : ""}">${rs(day.not_handed_in)}</b>
            </div>
            <div class="full" style="padding-top:4px">
              <button class="btn primary" id="eod-save" type="submit" style="width:100%;min-height:46px" ${st.locked || !st.totals.count ? "disabled" : ""}>${icon("check")} Save end of day</button>
              ${day.confirmed ? html`<div class="alert ok mt-3">${icon("check")} Confirmed by the office.</div>` : ""}
            </div>
          </form>
        </section>
      ` : ""}
    `.toString();

    wire();
  };

  const apply = (next) => { st = next; draw(); onChanged(); };

  const wire = () => {
    // Sub-tab switcher
    $$("[data-subtab]", box).forEach((btn) => {
      btn.onclick = () => {
        subtab = btn.dataset.subtab;
        draw();
        buzz(6);
      };
    });

    const ts = $("#ts", box);
    if (ts) {
      ts.oninput = (e) => {
        query = e.target.value;
        const at = e.target.selectionStart;
        draw();
        const again = $("#ts", box);
        if (again) {
          again.focus();
          try { again.setSelectionRange(at, at); } catch { /* not a text field */ }
        }
      };
    }

    const clearBtn = $("#ts-clear", box);
    if (clearBtn) {
      clearBtn.onclick = () => {
        query = "";
        draw();
        $("#ts", box)?.focus();
      };
    }

    $$("[data-p]", box).forEach((b) => (b.onclick = () => {
      picked = Number(b.dataset.p);
      qty = 1;
      draw();
      $(".till-sheet", box)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      buzz(6);
    }));

    const sel = picked ? st.products.find((p) => p.id === picked) : null;
    if (sel) {
      const setQty = (n) => { qty = Math.max(1, Math.min(sel.left, Math.floor(Number(n) || 1))); draw(); };
      const closeBtn = $("#ts-close", box);
      if (closeBtn) closeBtn.onclick = () => { picked = null; draw(); };
      const minusBtn = $("#q-minus", box);
      if (minusBtn) minusBtn.onclick = () => setQty(qty - 1);
      const plusBtn = $("#q-plus", box);
      if (plusBtn) plusBtn.onclick = () => setQty(qty + 1);
      $$("[data-q]", box).forEach((b) => (b.onclick = () => setQty(b.dataset.q)));
      const q = $("#q", box);
      if (q) {
        q.onchange = () => setQty(q.value);
        q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); setQty(q.value); $("#sell", box)?.click(); } };
        q.onfocus = () => q.select();
      }
      const sellBtn = $("#sell", box);
      if (sellBtn) {
        sellBtn.onclick = (e) => busy(e.currentTarget, async () => {
          const res = await post("/api/me/pos/sell", { product_id: sel.id, qty });
          const said = `Sold ${res.line.qty} × ${res.line.product} · ${rs(res.line.amount)}`;
          picked = null; qty = 1; query = "";
          buzz(14); toast(said); announce(said);
          apply(res.state);
        });
      }
    }

    $$("[data-undo]", box).forEach((b) => (b.onclick = async () => {
      const l = st.lines.find((x) => x.id === Number(b.dataset.undo));
      if (!l || !(await confirmDialog({ title: "Undo this sale?", message: `${esc(String(l.qty))} × ${esc(l.product)} for ${esc(rs(l.amount))} will be removed and returned to your stock.`, confirmText: "Undo sale", danger: true }))) return;
      await busy(b, async () => { apply(await del(`/api/me/pos/sale/${l.id}`)); toast("Sale removed"); });
    }));

    const eod = $("#eod", box);
    if (eod) {
      eod.onsubmit = (ev) => {
        ev.preventDefault();
        busy($("#eod-save", box), async () => {
          apply(await post("/api/me/pos/day", Object.fromEntries(new FormData(eod))));
          toast("End of day saved");
          buzz(12);
        });
      };
    }
  };

  draw();
}
