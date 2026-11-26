// The till: a standard point-of-sale screen. Small plain lettering for names, big numbers for money and quantities.
// Three views only: Sell (a bill: one row per product with - and +, then one Save bill), Sales (today's sales, with undo) and Hand over (the cash handed in).
// The date is always today and the price is always the list price. What is left of each product shows on its row.
import { get, post, del } from "../api.js";
import { buzz, $, $$, html, esc, icon, toast, busy, confirmDialog, emptyState, announce } from "../ui.js";
import { swipeTabs } from "../phone.js";

const SUBTABS = ["sell", "sales", "eod"];

const n0 = (c) => (Number(c) / 100).toLocaleString("en-LK", { maximumFractionDigits: 2 });
const rs = (c) => `Rs ${n0(c)}`;
const when = (iso) => { try { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" }); } catch { return ""; } };
const dayLabel = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const LOW = 3; // this many or fewer pieces left shows as "low"

// Mounts the till into `box`. `onChanged` runs after anything is saved, so the rest of the page can refresh its totals.
export async function mountSell(box, { onChanged = () => {} } = {}) {
  let st = await get("/api/me/pos");
  let query = "";
  const bill = new Map(); // product id -> pieces on the bill being made (nothing is saved until "Save bill")
  let subtab = "sell";

  const draw = () => {
    // Without a search only the products the seller still has are shown; searching finds any product.
    const visible = st.products.filter((p) => p.active && (query ? p.name.toLowerCase().includes(query.toLowerCase()) : p.left > 0));
    for (const [id, n] of bill) { const p = st.products.find((x) => x.id === id); if (!p || p.left < 1) bill.delete(id); else if (n > p.left) bill.set(id, p.left); }
    const billLines = bill.size;
    const billCount = [...bill.values()].reduce((a, b) => a + b, 0);
    const billTotal = [...bill].reduce((a, [id, n]) => a + n * (st.products.find((x) => x.id === id)?.price || 0), 0);
    const day = st.day, due = day.not_handed_in || 0;

    box.innerHTML = html`
      <section class="pos-head" aria-label="Today">
        <div class="pos-sum">
          <span class="pos-cap">${dayLabel(st.date)} · sold today</span>
          <b class="pos-big"><small>Rs</small>${n0(st.totals.amount)}</b>
          <span class="pos-cap">${st.totals.count} ${st.totals.count === 1 ? "sale" : "sales"} · ${st.totals.qty} ${st.totals.qty === 1 ? "piece" : "pieces"}</span>
        </div>
        <button type="button" class="pos-due ${due ? "owe" : ""}" data-subtab="eod">
          <span class="pos-cap">To hand in</span>
          <b class="pos-big"><small>Rs</small>${n0(due)}</b>
        </button>
        ${st.locked ? html`<div class="pos-lock">${icon("lock")} ${st.closed ? "This month is closed." : "The office has recorded today, so it can no longer be changed here."}</div>` : ""}
      </section>

      <div class="pos-tabs" role="tablist" aria-label="Till sections">
        <button type="button" class="${subtab === "sell" ? "on" : ""}" data-subtab="sell" role="tab" aria-selected="${subtab === "sell"}">Sell</button>
        <button type="button" class="${subtab === "sales" ? "on" : ""}" data-subtab="sales" role="tab" aria-selected="${subtab === "sales"}">Sales${st.lines.length ? html` <i>${st.lines.length}</i>` : ""}</button>
        <button type="button" class="${subtab === "eod" ? "on" : ""}" data-subtab="eod" role="tab" aria-selected="${subtab === "eod"}">Hand over</button>
      </div>

      ${subtab === "sell" ? (st.locked ? html`<div class="alert warn">${icon("lock")}<div><b>Selling is switched off for today.</b></div></div>` : html`
        <div class="pos-search">
          <span aria-hidden="true">${icon("search")}</span>
          <input id="ts" class="input" type="search" inputmode="search" autocomplete="off" placeholder="Search product" aria-label="Search products" value="${esc(query)}">
          ${query ? html`<button type="button" class="ts-clear" id="ts-clear" aria-label="Clear search">${icon("x")}</button>` : ""}
        </div>
        ${st.products.length && st.products.every((p) => p.left < 1) ? html`<div class="alert warn mb-3">${icon("box")}<div><b>No stock left to sell.</b> Ask your coacher or hub for more.</div></div>` : ""}
        ${visible.length ? html`
          <ul class="pos-bill" role="list" aria-label="Bill">
            ${visible.map((p) => { const n = bill.get(p.id) || 0; return html`<li class="pos-brow ${n ? "on" : ""}" data-row="${p.id}">
              <span class="pos-name">${p.name}<small class="${p.left < 1 ? "none" : p.left <= LOW ? "low" : ""}">${n0(p.price)} each · ${p.left < 1 ? "none left" : `${p.left} left`}</small></span>
              <span class="pos-bq" role="group" aria-label="Quantity of ${esc(p.name)}">
                <button type="button" class="pos-step" data-minus="${p.id}" aria-label="One less ${esc(p.name)}" ${n < 1 ? "disabled" : ""}>${icon("minus")}</button>
                <input class="pos-qn" data-qn="${p.id}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${n || ""}" placeholder="0" aria-label="Pieces of ${esc(p.name)}" ${p.left < 1 ? "disabled" : ""}>
                <button type="button" class="pos-step" data-plus="${p.id}" aria-label="One more ${esc(p.name)}" ${n >= p.left ? "disabled" : ""}>${icon("plus")}</button>
              </span>
              <b class="pos-amt">${n ? n0(n * p.price) : ""}</b>
            </li>`; })}
          </ul>`
          : html`<p class="muted pos-empty">${!st.products.some((p) => p.active) ? "There are no products yet. Ask the office to add them." : query ? `No product matches “${esc(query)}”.` : "Nothing left to sell. Search to see every product."}</p>`}
        <div class="pos-bar" aria-live="polite">
          <span class="pos-bar-sum"><small>${billCount} ${billCount === 1 ? "piece" : "pieces"}${billLines ? ` · ${billLines} ${billLines === 1 ? "item" : "items"}` : ""}</small><b>Rs ${n0(billTotal)}</b></span>
          ${billLines ? html`<button type="button" class="btn ghost" id="bill-clear">Clear</button>` : ""}
          <button type="button" class="pos-sell" id="bill-save" ${billLines ? "" : "disabled"}><span>Save bill</span>${icon("check")}</button>
        </div>`) : ""}

      ${subtab === "sales" ? html`
        <section class="pos-panel" aria-label="Today's sales">
          <div class="pos-panel-head"><span>Today's sales</span><b>${rs(st.totals.amount)}</b></div>
          ${st.lines.length ? html`
            <ul class="pos-lines" role="list">
              ${st.lines.map((l) => html`<li>
                <span class="pos-l-main"><b>${l.qty} × ${l.product}</b><small>${when(l.at)} · ${n0(l.unit_price)} each</small></span>
                <b class="pos-l-amt">${n0(l.amount)}</b>
                ${l.can_undo ? html`<button type="button" class="pos-undo" data-undo="${l.id}" aria-label="Undo sale of ${l.qty} ${esc(l.product)}">Undo</button>` : ""}
              </li>`)}
            </ul>`
            : html`<div class="card-body">${emptyState("No sales yet today", "Each sale you make shows here, and can be undone.", "tag")}</div>`}
        </section>` : ""}

      ${subtab === "eod" ? html`
        <form id="eod" class="pos-panel pos-eod" autocomplete="off">
          <div class="pos-panel-head"><span>Hand over</span></div>
          <div class="pos-eod-sum">
            <div><span class="pos-cap">Sold today</span><b class="pos-big"><small>Rs</small>${n0(st.totals.amount)}</b></div>
            <div><span class="pos-cap">Not handed in yet</span><b class="pos-big ${due ? "neg" : ""}"><small>Rs</small>${n0(due)}</b></div>
          </div>
          <label class="pos-cap" for="eod-set">Cash handed in (Rs)</label>
          <input class="pos-money" id="eod-set" name="settled_amount" inputmode="decimal" placeholder="0" value="${day.recorded && day.settled ? n0(day.settled).replace(/,/g, "") : ""}" ${st.locked || !st.totals.count ? "disabled" : ""}>
          <button class="pos-sell" id="eod-save" type="submit" ${st.locked || !st.totals.count ? "disabled" : ""}><span>Save hand over</span>${icon("check")}</button>
          ${!st.totals.count ? html`<p class="muted pos-note">Make a sale first, then enter the cash you hand in.</p>` : ""}
          ${day.confirmed ? html`<div class="alert ok">${icon("check")} Confirmed by the office.</div>` : ""}
        </form>` : ""}
    `.toString();

    wire();
  };

  const apply = (next) => { st = next; draw(); onChanged(); };

  const wire = () => {
    $$("[data-subtab]", box).forEach((btn) => {
      btn.onclick = () => { subtab = btn.dataset.subtab; draw(); buzz(6); };
    });

    const ts = $("#ts", box);
    if (ts) {
      ts.oninput = (e) => {
        query = e.target.value;
        const at = e.target.selectionStart;
        draw();
        const again = $("#ts", box);
        if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch { /* not a text field */ } }
      };
    }
    const clearBtn = $("#ts-clear", box);
    if (clearBtn) clearBtn.onclick = () => { query = ""; draw(); $("#ts", box)?.focus(); };

    // Change one row; the screen is drawn again with the new quantity.
    const setRow = (id, n) => {
      const p = st.products.find((x) => x.id === id); if (!p) return;
      n = Math.max(0, Math.min(p.left, Math.floor(Number(n) || 0)));
      if (n) bill.set(id, n); else bill.delete(id);
      draw();
    };
    $$("[data-plus]", box).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.plus); setRow(id, (bill.get(id) || 0) + 1); buzz(6); }));
    $$("[data-minus]", box).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.minus); setRow(id, (bill.get(id) || 0) - 1); buzz(6); }));
    $$("[data-qn]", box).forEach((inp) => {
      inp.onfocus = () => inp.select();
      inp.onchange = () => setRow(Number(inp.dataset.qn), inp.value.replace(/\D/g, ""));
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } };
    });
    const clearBill = $("#bill-clear", box);
    if (clearBill) clearBill.onclick = () => { bill.clear(); draw(); };
    const save = $("#bill-save", box);
    if (save) {
      save.onclick = (e) => busy(e.currentTarget, async () => {
        const items = [...bill].map(([product_id, q]) => ({ product_id, qty: q }));
        const res = await post("/api/me/pos/bill", { items });
        const said = `Saved ${res.lines.length} ${res.lines.length === 1 ? "item" : "items"} · ${rs(res.amount)}`;
        bill.clear(); query = "";
        buzz(14); toast(said); announce(said);
        apply(res.state);
      });
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
        // An advance the office may have recorded for today stays as it is: this screen only takes the cash handed in.
        const body = { settled_amount: new FormData(eod).get("settled_amount"), personal_minus: st.day.personal ? n0(st.day.personal).replace(/,/g, "") : "" };
        busy($("#eod-save", box), async () => {
          apply(await post("/api/me/pos/day", body));
          toast("Hand over saved");
          buzz(12);
        });
      };
    }
  };

  swipeTabs({
    el: box,
    tabs: SUBTABS,
    getActive: () => subtab,
    setActive: (t) => { subtab = t; draw(); buzz(10); },
  });

  draw();
}
