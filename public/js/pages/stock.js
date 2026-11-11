import { get, post, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, $$, html, icon, money, toast, busy, confirmDialog, emptyState, fromCents, raw } from "../ui.js";
import { sheetKeys, periodLocked, lockedBanner } from "./shared.js";
import { isPhone, stackTable } from "../phone.js";
import { announce } from "../ui.js";

const INTS = ["opening_stock", "issued", "sold", "counted_stock"];
const STOCK_LABEL = { opening_stock: "Opening", issued: "Issued", sold: "Sold", counted_stock: "Counted" };
const prevPeriod = (p) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export default {
  title: "Stock count",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, lines, locked] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      get("/api/stock" + qs({ period: state.period, hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    const guys = staff.filter((s) => s.role === "guy");
    const names = Object.fromEntries(guys.map((g) => [g.employee_id, g.name]));
    const editable = can("enter_data") && !locked;
    const threshold = Number(state.settings.stock_shortfall_threshold || 0);

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Stock count</h1><p>Shortfall = opening + issued − sold − counted. Its value is deducted from the guy's pay as settle-up.</p></div>
        <div class="actions">${editable ? html`
          <button class="btn" id="carry">${icon("copy")} Carry over from last month</button>
          <button class="btn" id="add">${icon("plus")} Add line</button>` : ""}</div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card"><div class="card-body flush" id="grid"></div>
        ${editable ? html`<div class="row between card-foot">
          <span class="muted" id="info"></span><button class="btn primary" id="save">${icon("check")} Save stock count</button></div>` : ""}</div>`;

    const grid = $("#grid");
    let rows = lines.map((l) => ({ ...l, _state: "saved" }));
    const guyOptions = (sel) => guys.filter((g) => g.status === "active" || g.employee_id === sel)
      .map((g) => html`<option value="${g.employee_id}" ${g.employee_id === sel ? "selected" : ""}>${g.name}</option>`);

    // A month can have hundreds of lines; draw the first ones, plus any being edited, and the rest on request.
    let shown = 120;
    // On a phone the count is taken one person at a time: pick a person, see only their lines.
    const phone = isPhone();
    const empOf = (r) => r._draft?.employee_id ?? r.employee_id;
    const peopleIds = () => [...new Set(rows.filter((r) => r._state !== "deleted" && r._state !== "gone").map(empOf))].sort((a, b) => (names[a] || a).localeCompare(names[b] || b));
    let who = peopleIds()[0] || null;
    const visible = phone ? (r) => empOf(r) === who : (r, i) => i < shown || r._state === "new" || !!r._draft;
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
        <thead><tr><th>Employee</th><th>Product</th><th class="r">Opening</th><th class="r">Issued</th><th class="r">Sold</th><th class="r">Counted</th>
          <th class="r">Unit price</th><th class="r">Short qty</th><th class="r">Short value</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => r._state === "deleted" || !visible(r, i) ? "" : html`<tr data-i="${i}" class="${r._state === "new" ? "dirty" : ""}">
          <td class="name">${r.id ? html`<b>${names[r.employee_id] || r.employee_id}</b><div class="faint text-sm">${r.employee_id}</div>`
            : html`<select class="input sm" data-f="employee_id" aria-label="Employee" style="min-width:160px">${guyOptions(r._draft?.employee_id ?? r.employee_id)}</select>`}</td>
          <td>${r.id ? html`<b>${r.product}</b>` : html`<input class="text" data-f="product" aria-label="Product name" value="${r._draft?.product ?? r.product ?? ""}" placeholder="Product name">`}</td>
          ${INTS.map((k) => html`<td><input data-f="${k}" aria-label="${STOCK_LABEL[k]}, ${r.product || "new product"}, ${names[r.employee_id] || "new line"}" inputmode="numeric" value="${r._draft?.[k] ?? r[k] ?? ""}" ${editable ? "" : "disabled"} style="min-width:70px"></td>`)}
          <td><input data-f="unit_price" aria-required="true" placeholder="Price" aria-label="Unit price (required),${r.product || "new product"}, ${names[r.employee_id] || "new line"}" inputmode="decimal" value="${r._draft?.unit_price ?? (r.unit_price != null ? fromCents(r.unit_price) : "")}" ${editable ? "" : "disabled"}></td>
          <td class="calc" data-q></td><td class="calc" data-v></td>
          <td>${editable ? html`<button class="btn sm icon danger-ghost" data-del="${i}" aria-label="Remove line">${icon("trash")}</button>` : ""}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td colspan="8">Total shortfall</td><td class="r" id="tot"></td><td></td></tr></tfoot></table></div>
        ${rows.some((r, i) => r._state !== "deleted" && !visible(r, i)) ? html`<div class="more-rows"><span class="muted" role="status">Showing ${rows.filter(visible).length} of ${rows.length} lines</span>
          <button type="button" class="btn" id="more-lines">Show ${Math.min(150, rows.length - shown)} more</button></div>` : ""}`.toString();
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
    const refresh = () => {
      let total = 0, dirty = 0;
      const perEmp = {};
      const drawn = new Set($$("tbody tr", grid).map((tr) => Number(tr.dataset.i)));
      rows.forEach((r, i) => { // lines not on screen count with their saved values, or what was typed before moving on
        if (drawn.has(i) || r._state === "deleted" || r._state === "gone") return;
        if (r._draft) {
          const n = (k) => Number(r._draft[k] || 0);
          const q = n("opening_stock") + n("issued") - n("sold") - n("counted_stock");
          const val = Math.max(0, q) * Math.round(n("unit_price") * 100);
          total += val; perEmp[empOf(r)] = (perEmp[empOf(r)] || 0) + val;
          r._dirty = r._state === "new" || INTS.some((k) => n(k) !== r[k]) || Math.round(n("unit_price") * 100) !== r.unit_price;
          if (r._dirty) dirty++;
          return;
        }
        total += r.shortfall_value || 0;
        perEmp[r.employee_id] = (perEmp[r.employee_id] || 0) + (r.shortfall_value || 0);
      });
      $$("tbody tr", grid).forEach((tr) => {
        const r = rows[tr.dataset.i];
        const v = read(tr);
        const n = (k) => Number(v[k] || 0);
        const q = n("opening_stock") + n("issued") - n("sold") - n("counted_stock");
        const val = Math.max(0, q) * Math.round(n("unit_price") * 100);
        tr.querySelector("[data-q]").innerHTML = `<span class="${q > 0 ? "neg" : q < 0 ? "pos" : ""}">${q}</span>`;
        tr.querySelector("[data-v]").innerHTML = val ? `<span class="neg">${money(val)}</span>` : "—";
        total += val;
        const emp = v.employee_id || r.employee_id;
        perEmp[emp] = (perEmp[emp] || 0) + val;
        const changed = r._state === "new" || INTS.some((k) => n(k) !== r[k]) || Math.round(n("unit_price") * 100) !== r.unit_price;
        tr.classList.toggle("dirty", changed);
        r._dirty = changed;
        if (changed) dirty++;
      });
      if ($("#tot")) $("#tot").innerHTML = `<span class="neg">${money(total)}</span>`;
      const over = Object.entries(perEmp).filter(([, v]) => v > threshold).map(([e]) => names[e] || e);
      if ($("#info")) $("#info").innerHTML = (dirty ? `${dirty} line${dirty > 1 ? "s" : ""} changed. ` : "No unsaved changes. ") +
        (over.length ? `<span class="neg">Above the Rs ${money(threshold)} review threshold: ${over.map((o) => o.replace(/[<>&]/g, "")).join(", ")}</span>` : "");
    };
    grid.addEventListener("input", refresh);
    grid.addEventListener("change", refresh);
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
      const noPrice = rows.filter((r) => r._dirty && r._state !== "deleted" && r._state !== "gone" && (r._draft || {}).unit_price === "");
      if (noPrice.length) {
        const list = noPrice.map((r) => `${r._draft.product || r.product || "a new product"} (${names[empOf(r)] || empOf(r)})`);
        if (phone && empOf(noPrice[0]) !== who) goWho(empOf(noPrice[0]));
        $$("[data-f=unit_price]", grid).find((i) => i.value.trim() === "")?.setAttribute("aria-invalid", "true");
        throw new Error(`Add a price for ${list.length === 1 ? list[0] : `${list.length} lines: ${list.slice(0, 4).join(", ")}${list.length > 4 ? "…" : ""}`}. Every product needs a unit price.`);
      }
      for (const r of rows) {
        if (!r._dirty || r._state === "deleted" || r._state === "gone") continue;
        const v = r._draft || {};
        const product = v.product ?? r.product;
        const emp = v.employee_id ?? r.employee_id;
        if (!product) throw new Error("Every line needs a product name");
        if (v.counted_stock === "") throw new Error(`${product}: enter the counted stock`);
        if (v.unit_price === "") throw new Error(`${product}: enter the unit price`);
        out.push({ period: state.period, employee_id: emp, product, opening_stock: v.opening_stock || 0, issued: v.issued || 0, sold: v.sold || 0, counted_stock: v.counted_stock, unit_price: v.unit_price });
      }
      rows.filter((r) => r._state === "deleted").forEach((r) => out.push({ period: state.period, employee_id: r.employee_id, product: r.product, _delete: true }));
      if (!out.length) return toast("Nothing to save", "warn");
      const res = await post("/api/stock/bulk", { rows: out });
      toast(`Stock saved — ${res.created} added, ${res.updated} updated${res.deleted ? `, ${res.deleted} removed` : ""}`);
      this.render(ctx);
    }));
  },
};
