// The hub's weekly stock sheet: for one week (Monday to Sunday) every product the hub and its sellers hold.
//   opening + what the office sent each weekday = total;  total - sold = expected;  counted (typed in) - expected = missing, valued at the selling price.
// The coacher counts at the end of the week and types the counts. The office, with no hub chosen, picks a hub first.
import { get, post, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, $$, html, icon, money, toast, busy, emptyState, dateLabel } from "../ui.js";
import { today, addDays } from "../range.js";

let weekDate = null;
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const mondayOf = (iso) => { const dow = new Date(iso + "T00:00:00Z").getUTCDay(); return addDays(iso, -((dow + 6) % 7)); };

export default {
  title: "Weekly stock",
  filters: false, // the week is chosen on the page; the hub comes from the address or the user
  async render(ctx) {
    const { el } = ctx;
    const hub = state.user.hub || state.routeHub || "";
    const now = today();
    if (!weekDate || weekDate > now) weekDate = now;
    weekDate = mondayOf(weekDate);

    if (!hub) {
      const hubs = state.hubs.filter((h) => h.status === "active");
      el.innerHTML = html`<div class="page-head"><div><h1>Weekly stock</h1><p>For each hub: what it held at the start of the week, what the office sent each day, what was sold and what the coacher counted at the end. Pick a hub.</p></div></div>
        ${hubs.length ? html`<div class="card hs-list"><ul role="list">${hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/stock/week" data-link><span class="hs-main"><b>${h.name}</b><span class="muted">${h.code}</span></span><span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
          : html`<div class="card">${emptyState("No hubs yet", "Add a hub first.", "store")}</div>`}`.toString();
      return;
    }

    const w = await get("/api/week-stock" + qs({ hub, date: weekDate }));
    const editable = can("stock");
    const end = addDays(w.week_start, 6);
    const bar = html`<div class="dl-daybar mb-4"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn icon" id="ws-prev" aria-label="Previous week">${icon("left")}</button>
        <input type="date" class="input" id="ws-date" aria-label="Any day in the week" value="${weekDate}" max="${now}" style="width:160px">
        <button type="button" class="btn icon" id="ws-next" aria-label="Next week" ${addDays(w.week_start, 7) > now ? "disabled" : ""}>${icon("right")}</button>
        <b style="font-size:17px">${dateLabel(w.week_start)} – ${dateLabel(end)}</b></div></div>`;
    el.innerHTML = html`<div class="page-head"><div><h1>Weekly stock — ${w.name}</h1><p>Opening stock plus what the office sent each day, less what was sold, is what should be here. Count what is here and type it in: the difference is what is missing, at the selling price.</p></div></div>
      ${bar}
      <div class="grid kpis hub-kpis mb-4">
        <div class="card kpi"><div class="label">Sold this week</div><div class="value"><small>Rs</small>${money(w.totals.sold_value)}</div><div class="foot">${w.totals.sold} pieces</div></div>
        <div class="card kpi"><div class="label">Received this week</div><div class="value">${w.totals.received}</div><div class="foot">pieces from the office</div></div>
        <div class="card kpi"><div class="label">Missing</div><div class="value ${w.totals.missing_value < 0 ? "neg" : ""}"><small>Rs</small>${money(-w.totals.missing_value)}</div><div class="foot">${w.totals.counted_products ? `${w.totals.counted_products} products counted` : "Nothing counted yet"}</div></div>
      </div>
      ${w.products.length ? html`<div class="card"><div class="table-wrap" tabindex="-1"><table class="table sheet" id="ws-table">
        <caption class="sr-only">Weekly stock for ${w.name}, ${w.week_start} to ${end}</caption>
        <thead><tr><th scope="col">Product</th><th scope="col" class="r">Opening</th>${DAY.map((d, i) => html`<th scope="col" class="r" title="${w.days[i]}">${d}</th>`)}<th scope="col" class="r">Total</th><th scope="col" class="r">Sold</th><th scope="col" class="r">Should be here</th><th scope="col" class="r">Counted</th><th scope="col" class="r">Missing</th><th scope="col" class="r">Value</th></tr></thead>
        <tbody>${w.products.map((p) => html`<tr data-pid="${p.id}">
          <th scope="row" class="name"><b>${p.name}</b><div class="faint text-sm fw-400">Rs ${money(p.price)}</div></th>
          <td class="r">${p.opening}</td>${p.received.map((n) => html`<td class="r">${n || "—"}</td>`)}
          <td class="r">${p.total}</td><td class="r">${p.sold}</td><td class="r"><b>${p.expected}</b></td>
          <td class="r">${editable ? html`<input class="ws-count" data-pid="${p.id}" data-was="${p.counted ?? ""}" inputmode="numeric" maxlength="7" value="${p.counted ?? ""}" aria-label="Counted pieces of ${p.name}">` : (p.counted ?? "—")}</td>
          <td class="r ${p.missing < 0 ? "neg" : ""}" data-miss>${p.missing === null ? "—" : p.missing}</td>
          <td class="r ${p.missing_value < 0 ? "neg" : ""}" data-val>${p.missing_value === null ? "—" : money(p.missing_value)}</td></tr>`)}</tbody></table></div></div>
        ${editable ? html`<div class="savebar"><span class="muted" id="ws-info" role="status">No unsaved counts</span><div class="row"><button type="button" class="btn primary" id="ws-save" disabled>${icon("check")} Save counts</button></div></div>` : ""}
        <p class="scroll-hint">Swipe the table sideways to see all the days.</p>`
        : html`<div class="card">${emptyState("Nothing moved this week", "Products appear here when the office sends stock to the hub or the sellers sell it.", "warehouse")}</div>`}`.toString();

    const go = (d) => { if (d && d <= now) { weekDate = d; this.render(ctx); } };
    $("#ws-prev").onclick = () => go(addDays(w.week_start, -7));
    $("#ws-next").onclick = () => go(addDays(w.week_start, 7));
    $("#ws-date").onchange = (e) => go(e.target.value);
    if (!editable || !w.products.length) return;
    const by = Object.fromEntries(w.products.map((p) => [p.id, p]));
    const refresh = () => {
      let changed = 0;
      $$(".ws-count", el).forEach((inp) => {
        const p = by[inp.dataset.pid], raw = inp.value.replace(/,/g, "").trim();
        const tr = inp.closest("tr");
        if (raw !== inp.dataset.was) changed++;
        const n = raw === "" ? null : Number(raw);
        const ok = n === null || (Number.isInteger(n) && n >= 0);
        inp.toggleAttribute("aria-invalid", !ok);
        const miss = n === null || !ok ? null : n - p.expected;
        tr.querySelector("[data-miss]").textContent = miss === null ? "—" : miss;
        tr.querySelector("[data-miss]").classList.toggle("neg", miss !== null && miss < 0);
        tr.querySelector("[data-val]").textContent = miss === null ? "—" : money(miss * p.price);
        tr.querySelector("[data-val]").classList.toggle("neg", miss !== null && miss < 0);
      });
      $("#ws-save").disabled = !changed;
      $("#ws-info").textContent = changed ? `${changed} count${changed === 1 ? "" : "s"} not saved yet` : "No unsaved counts";
    };
    el.oninput = (e) => { if (e.target.classList?.contains("ws-count")) refresh(); };
    $("#ws-save").onclick = (e) => busy(e.currentTarget, async () => {
      const counts = $$(".ws-count", el).filter((i) => i.value.replace(/,/g, "").trim() !== i.dataset.was).map((i) => ({ product_id: Number(i.dataset.pid), counted: i.value }));
      const r = await post("/api/week-stock/counts", { ...(state.user.hub ? {} : { hub }), week_start: w.week_start, counts });
      toast(`${r.saved} saved${r.removed ? `, ${r.removed} removed` : ""}`); this.render(ctx);
    });
  },
};
