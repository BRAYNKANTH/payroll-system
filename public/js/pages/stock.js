import { get, post, qs } from "../api.js";
import { state, can, scopeHub, setDirtyCheck } from "../app.js";
import { $, $$, html, icon, money, toast, busy, confirmDialog, emptyState, fromCents, raw, parseAmount } from "../ui.js";
import { sheetKeys, periodLocked, lockedBanner, badNumber, stockNum, markBadNumbers, productList, pickProduct, unknownProducts, findBox } from "./shared.js";
import { isPhone, stackTable } from "../phone.js";
import { announce } from "../ui.js";

const INTS = ["opening_stock", "issued", "sold", "counted_stock"];
const NUMS = [...INTS, "unit_price"];
const STOCK_LABEL = { opening_stock: "Opening", issued: "Issued", sold: "Sold", counted_stock: "Counted" };
const prevPeriod = (p) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
// A draft (what was typed) holds a value that is not a number.
const draftBad = (v) => NUMS.some((k) => k in v && badNumber(k, v[k]));
const shortText = (q) => (q > 0 ? `${q} short` : q < 0 ? `${-q} over` : "0");

export default {
  title: "Stock count",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, lines, locked, catalogue] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      get("/api/stock" + qs({ period: state.period, hub: scopeHub() })),
      periodLocked(state.period),
      can("enter_data") ? get("/api/products/names").catch(() => []) : [],
    ]);
    const guys = staff.filter((s) => s.role === "guy");
    const names = Object.fromEntries(guys.map((g) => [g.employee_id, g.name]));
    const editable = can("enter_data") && !locked;
    const threshold = Number(state.settings.stock_shortfall_threshold || 0);

    el.innerHTML = html`<div class="stockc-page">
      <div class="page-head">
        <div><h1>Stock count</h1><p>Shortfall = opening + issued − sold − counted. Its value is deducted from the seller's pay as settle-up.</p></div>
        <div class="actions">${editable ? html`
          <button type="button" class="btn" id="carry" aria-label="Carry over from last month">${icon("copy")} Carry over<span class="lbl-long"> from last month</span></button>
          <button type="button" class="btn" id="add">${icon("plus")} Add line</button>` : ""}</div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      ${productList(catalogue)}
      <div class="card">${lines.length && !isPhone() ? html`<div class="card-head">${findBox("Search stock lines", "Search person or product")}<span class="muted" id="find-count"></span></div>` : ""}
        <div class="card-body flush" id="grid"></div>
        ${editable ? html`<div class="row between card-foot">
          <span class="muted" id="info"></span><button type="button" class="btn primary" id="save">${icon("check")} Save stock count</button></div>` : ""}</div></div>`;

    const grid = $("#grid");
    let rows = lines.map((l) => ({ ...l, _state: "saved" }));
    const guyOptions = (sel) => guys.filter((g) => g.status === "active" || g.employee_id === sel)
      .map((g) => html`<option value="${g.employee_id}" ${g.employee_id === sel ? "selected" : ""}>${g.name}</option>`);
    // Lines with edits not yet saved (deleted lines too); the app asks before leaving the page while there are any.
    const unsaved = () => rows.filter((r) => r._state === "deleted" || (r._dirty && r._state !== "gone")).length;
    if (editable) setDirtyCheck(unsaved);

    // A month can have hundreds of lines; draw the first ones, plus any being edited, and the rest on request.
    let shown = 120;
    // On a phone the count is taken one person at a time: pick a person, see only their lines.
    const phone = isPhone();
    const empOf = (r) => r._draft?.employee_id ?? r.employee_id;
    const peopleIds = () => [...new Set(rows.filter((r) => r._state !== "deleted" && r._state !== "gone").map(empOf))].sort((a, b) => (names[a] || a).localeCompare(names[b] || b));
    let who = peopleIds()[0] || null;
    // Desktop search: only the lines whose person or product matches (new lines always show, so an added line is never hidden).
    let find = "";
    const matches = (r) => [names[empOf(r)], empOf(r), r._draft?.product ?? r.product].some((t) => String(t || "").toLowerCase().includes(find));
    const visible = phone ? (r) => empOf(r) === who
      : (r, i) => (find ? r._state === "new" || matches(r) : i < shown || r._state === "new" || !!r._draft);
    const personBar = () => {
      const ids = peopleIds();
      const at = Math.max(0, ids.indexOf(who));
      const count = (id) => rows.filter((r) => r._state !== "deleted" && r._state !== "gone" && empOf(r) === id).length;
      const edited = (id) => rows.some((r) => r._dirty && empOf(r) === id);
      return html`<div class="person-nav"><p class="step-count" id="who-count">Person ${at + 1} of ${ids.length}</p>
        <div class="person-row"><button type="button" class="btn icon" id="who-prev" aria-label="Previous person" ${at === 0 ? "disabled" : ""}>${icon("left")}</button>
          <select class="input" id="who-sel" aria-label="Choose a person">${ids.map((id) => html`<option value="${id}" ${id === who ? "selected" : ""}>${names[id] || id} · ${count(id)} line${count(id) === 1 ? "" : "s"}${edited(id) ? " · edited" : ""}</option>`)}</select>
          <button type="button" class="btn icon" id="who-next" aria-label="Next person" ${at >= ids.length - 1 ? "disabled" : ""}>${icon("right")}</button></div></div>`;
    };
    const goWho = (id) => {
      snap(); who = id;
      const keep = document.activeElement?.id;
      draw();
      if (keep) $("#" + keep)?.focus();
      announce(`${names[id] || id}, ${rows.filter((r) => empOf(r) === id && r._state !== "deleted").length} lines`);
    };
    const draw = () => {
      if (!rows.length) {
        grid.innerHTML = emptyState("No stock lines for this month", editable ? "Add a line or carry over last month's products." : "", "box").toString();
        return;
      }
      grid.innerHTML = html`${phone ? personBar() : ""}<div class="table-wrap"><table class="table sheet">
        <thead><tr><th scope="col">Employee</th><th scope="col">Product</th><th scope="col" class="r">Opening</th><th scope="col" class="r">Issued</th><th scope="col" class="r">Sold</th><th scope="col" class="r">Counted</th>
          <th scope="col" class="r">Unit price</th><th scope="col" class="r">Short qty</th><th scope="col" class="r">Short value</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
        <tbody>${rows.map((r, i) => {
          if (r._state === "deleted" || !visible(r, i)) return "";
          const product = r._draft?.product ?? r.product;
          const person = names[empOf(r)] || empOf(r) || "new line";
          const ctxLabel = `${product || "new product"}, ${person}`;
          return html`<tr data-i="${i}" class="${r._state === "new" ? "dirty" : ""}">
          <td class="name">${r.id ? html`<b>${names[r.employee_id] || r.employee_id}</b><div class="faint text-sm">${r.employee_id}</div>`
            : html`<select class="input sm" data-f="employee_id" aria-label="Employee" style="min-width:160px">${guyOptions(r._draft?.employee_id ?? r.employee_id)}</select>`}</td>
          <td>${r.id ? html`<b>${r.product}</b>` : html`<input class="text" data-f="product" list="product-list" autocomplete="off" aria-label="Product name" value="${r._draft?.product ?? r.product ?? ""}" placeholder="Product name">`}</td>
          ${INTS.map((k) => html`<td><input data-f="${k}" data-num aria-label="${STOCK_LABEL[k]}, ${ctxLabel}" inputmode="numeric" value="${r._draft?.[k] ?? r[k] ?? ""}" ${editable ? "" : "disabled"} style="min-width:70px"></td>`)}
          <td><input data-f="unit_price" data-num ${r._needPrice ? raw('data-missing="1"') : ""} aria-required="true" placeholder="Price" aria-label="Unit price in rupees, required, ${ctxLabel}" inputmode="decimal" value="${r._draft?.unit_price ?? (r.unit_price != null ? fromCents(r.unit_price) : "")}" ${editable ? "" : "disabled"}></td>
          <td class="calc" data-q></td><td class="calc" data-v></td>
          <td>${editable ? html`<button type="button" class="btn sm icon danger-ghost" data-del="${i}" aria-label="Remove ${product || "new line"} for ${person}">${icon("trash")}</button>` : ""}</td>
        </tr>`;
        })}</tbody>
        <tfoot><tr><td colspan="8" style="overflow:visible;white-space:nowrap">Total shortfall</td><td class="r" id="tot"></td><td></td></tr></tfoot></table></div>
        ${!find && rows.some((r, i) => r._state !== "deleted" && !visible(r, i)) ? html`<div class="more-rows"><span class="muted" role="status">Showing ${rows.filter(visible).length} of ${rows.length} lines</span>
          <button type="button" class="btn" id="more-lines">Show ${Math.min(150, rows.length - shown)} more</button></div>` : ""}`.toString();
      const live = rows.filter((r) => r._state !== "deleted" && r._state !== "gone");
      if ($("#find-count")) $("#find-count").textContent = find ? `${live.filter((r) => visible(r, rows.indexOf(r))).length} of ${live.length} lines` : "";
      $("#more-lines")?.addEventListener("click", () => { snap(); shown += 150; draw(); });
      if (phone) {
        stackTable(grid.querySelector("table"), { grid: true, wideFirst: 2 });
        $("#who-sel").onchange = (e) => goWho(e.target.value);
        const ids = peopleIds(), at = ids.indexOf(who);
        $("#who-prev").onclick = () => ids[at - 1] && goWho(ids[at - 1]);
        $("#who-next").onclick = () => ids[at + 1] && goWho(ids[at + 1]);
      }
      refresh();
    };

    // Redrawing rebuilds the table from `rows`, so keep what has been typed so far in a per-row draft.
    const snap = () => $$("tbody tr", grid).forEach((tr) => { const r = rows[tr.dataset.i]; if (r) r._draft = read(tr); });
    const read = (tr) => Object.fromEntries([...tr.querySelectorAll("[data-f]")].map((i) => [i.dataset.f, i.value.trim()]));
    const changedFrom = (r, v) => r._state === "new" || INTS.some((k) => stockNum(v[k]) !== (r[k] ?? 0)) || Math.round(stockNum(v.unit_price) * 100) !== r.unit_price;
    const refresh = () => {
      let total = 0, dirty = 0, bad = 0;
      const perEmp = {};
      const drawn = new Set($$("tbody tr", grid).map((tr) => Number(tr.dataset.i)));
      rows.forEach((r, i) => { // lines not on screen count with their saved values, or what was typed before moving on
        if (drawn.has(i) || r._state === "deleted" || r._state === "gone") return;
        if (r._draft) {
          r._dirty = true;
          if (draftBad(r._draft)) { bad++; dirty++; return; }
          const n = (k) => stockNum(r._draft[k]);
          const q = n("opening_stock") + n("issued") - n("sold") - n("counted_stock");
          const val = Math.max(0, q) * Math.round(n("unit_price") * 100);
          total += val; perEmp[empOf(r)] = (perEmp[empOf(r)] || 0) + val;
          r._dirty = changedFrom(r, r._draft);
          if (r._dirty) dirty++;
          return;
        }
        total += r.shortfall_value || 0;
        perEmp[r.employee_id] = (perEmp[r.employee_id] || 0) + (r.shortfall_value || 0);
      });
      $$("tbody tr", grid).forEach((tr) => {
        const r = rows[tr.dataset.i];
        const v = read(tr);
        if (markBadNumbers(tr)) {
          // Not a number: say so instead of showing NaN, and keep it out of the totals.
          tr.querySelector("[data-q]").textContent = "—";
          tr.querySelector("[data-v]").innerHTML = `<span class="neg">Check the numbers</span>`;
          tr.classList.add("dirty");
          r._dirty = true;
          bad++; dirty++;
          return;
        }
        const n = (k) => stockNum(v[k]);
        const q = n("opening_stock") + n("issued") - n("sold") - n("counted_stock");
        const val = Math.max(0, q) * Math.round(n("unit_price") * 100);
        tr.querySelector("[data-q]").innerHTML = `<span class="${q > 0 ? "neg" : q < 0 ? "pos" : ""}">${shortText(q)}</span>`;
        tr.querySelector("[data-v]").innerHTML = val ? `<span class="neg">${money(val)}</span>` : "—";
        total += val;
        const emp = v.employee_id || r.employee_id;
        perEmp[emp] = (perEmp[emp] || 0) + val;
        const changed = changedFrom(r, v);
        tr.classList.toggle("dirty", changed);
        r._dirty = changed;
        if (changed) dirty++;
      });
      if ($("#tot")) $("#tot").innerHTML = `<span class="neg">${money(total)}</span>${bad ? `<div class="faint text-sm">${bad} line${bad > 1 ? "s" : ""} left out</div>` : ""}`;
      const over = Object.entries(perEmp).filter(([, v]) => v > threshold).map(([e]) => names[e] || e);
      const unknown = unknownProducts(catalogue, $$("tbody [data-f=product]", grid));
      if ($("#info")) $("#info").innerHTML = (unknown ? `<span class="warn-text">${unknown} product name${unknown > 1 ? "s aren't" : " isn't"} in the Products list. </span>` : "") + (bad ? `<span class="neg">${bad} line${bad > 1 ? "s have" : " has"} a number that isn't valid. </span>` : "") +
        (dirty ? `${dirty} line${dirty > 1 ? "s" : ""} changed. ` : "No unsaved changes. ") +
        (over.length ? `<span class="neg">Above the Rs ${money(threshold)} review threshold: ${over.map((o) => o.replace(/[<>&]/g, "")).join(", ")}</span>` : "");
    };
    grid.addEventListener("input", refresh);
    grid.addEventListener("change", (e) => { pickProduct(e.target, catalogue); refresh(); });
    grid.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-del]");
      if (!b) return;
      snap();
      const r = rows[b.dataset.del];
      if (r.id && !(await confirmDialog({ title: "Remove stock line?", message: `${r.product} for ${names[r.employee_id] || r.employee_id} will be deleted when you save.`, confirmText: "Remove", danger: true }))) return;
      r._state = r.id ? "deleted" : "gone";
      if (!r.id) rows.splice(b.dataset.del, 1);
      draw();
    });
    sheetKeys(grid);
    draw();
    let typing;
    $("#find")?.addEventListener("input", (e) => {
      snap();
      find = e.target.value.trim().toLowerCase();
      draw();
      clearTimeout(typing);
      typing = setTimeout(() => announce(find ? `${$("#find-count").textContent} shown` : "All lines shown"), 600);
    });

    // Bring a line into view (on a phone, switch to its person) and put the cursor in one of its fields.
    const focusLine = (r, field) => {
      if (phone && empOf(r) !== who) goWho(empOf(r));
      // A line hidden by the search: clear the search so the line can be shown.
      if (!phone && !visible(r, rows.indexOf(r))) { snap(); find = ""; if ($("#find")) $("#find").value = ""; shown = Math.max(shown, rows.indexOf(r) + 1); draw(); }
      const tr = $$("tbody tr", grid).find((t) => rows[t.dataset.i] === r);
      const inp = tr && (field ? tr.querySelector(`[data-f="${field}"]`) : tr.querySelector("input[aria-invalid=true]"));
      inp?.focus();
    };

    $("#add")?.addEventListener("click", () => {
      snap();
      rows.push({ _state: "new", employee_id: (phone && who) || guys.find((g) => g.status === "active")?.employee_id, product: "", opening_stock: 0, issued: 0, sold: 0, counted_stock: null, unit_price: null });
      draw();
      $$("tbody tr:last-child [data-f=product]", grid)[0]?.focus();
    });
    $("#carry")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      snap();
      const prev = await get("/api/stock" + qs({ period: prevPeriod(state.period), hub: scopeHub() }));
      const have = new Set(rows.map((r) => `${r.employee_id}|${r.product}`));
      const add = prev.filter((p) => !have.has(`${p.employee_id}|${p.product}`) && guys.some((g) => g.employee_id === p.employee_id && g.status === "active"));
      if (!add.length) return toast("Nothing new to carry over from last month", "warn");
      add.forEach((p) => rows.push({ _state: "new", employee_id: p.employee_id, product: p.product, opening_stock: p.counted_stock, issued: 0, sold: 0, counted_stock: null, unit_price: p.unit_price }));
      draw();
      toast(`${add.length} lines added with opening stock = last month's count. Fill in issued, sold and counted.`);
    }));
    $("#save")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const out = [];
      snap(); // what is on screen joins what was typed for the other people
      const live = (r) => r._dirty && r._state !== "deleted" && r._state !== "gone";
      // Numbers that are not numbers: name the lines and put the cursor on the first one.
      const badRows = rows.filter((r) => live(r) && r._draft && draftBad(r._draft));
      if (badRows.length) {
        const list = badRows.map((r) => `${r._draft.product || r.product || "a new product"} (${names[empOf(r)] || empOf(r)})`);
        focusLine(badRows[0]);
        throw new Error(`Check the numbers for ${list.length === 1 ? list[0] : `${list.length} lines: ${list.slice(0, 4).join(", ")}${list.length > 4 ? "…" : ""}`}. Stock is a whole number of units, and a price looks like 850 or 850.50.`);
      }
      // Every product needs a price: mark each empty one and put the cursor on the first.
      const noPrice = rows.filter((r) => live(r) && (r._draft || {}).unit_price === "");
      if (noPrice.length) {
        noPrice.forEach((r) => { r._needPrice = true; });
        if (phone && empOf(noPrice[0]) !== who) goWho(empOf(noPrice[0]));
        $$("tbody tr", grid).forEach((tr) => {
          if (!rows[tr.dataset.i]?._needPrice) return;
          const i = tr.querySelector("[data-f=unit_price]");
          i.dataset.missing = "1";
          i.setAttribute("aria-invalid", "true");
        });
        focusLine(noPrice[0], "unit_price");
        const list = noPrice.map((r) => `${r._draft.product || r.product || "a new product"} (${names[empOf(r)] || empOf(r)})`);
        throw new Error(`Add a price for ${list.length === 1 ? list[0] : `${list.length} lines: ${list.slice(0, 4).join(", ")}${list.length > 4 ? "…" : ""}`}. Every product needs a unit price.`);
      }
      for (const r of rows) {
        if (!live(r)) continue;
        const v = r._draft || {};
        const product = v.product ?? r.product;
        const emp = v.employee_id ?? r.employee_id;
        if (!product) { focusLine(r, "product"); throw new Error("Every line needs a product name"); }
        if (v.counted_stock === "") { focusLine(r, "counted_stock"); throw new Error(`${product}: enter the counted stock`); }
        out.push({ period: state.period, employee_id: emp, product, opening_stock: v.opening_stock || 0, issued: v.issued || 0, sold: v.sold || 0,
          counted_stock: v.counted_stock, unit_price: String(parseAmount(v.unit_price)) });
      }
      rows.filter((r) => r._state === "deleted").forEach((r) => out.push({ period: state.period, employee_id: r.employee_id, product: r.product, _delete: true }));
      if (!out.length) return toast("Nothing to save", "warn");
      const res = await post("/api/stock/bulk", { rows: out });
      toast(`Stock saved — ${res.created} added, ${res.updated} updated${res.deleted ? `, ${res.deleted} removed` : ""}`);
      setDirtyCheck(null);
      this.render(ctx);
    }));
  },
};
