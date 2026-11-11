import { get, post, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, $$, html, icon, money, toast, busy, confirmDialog, emptyState, fromCents, dateLabel, raw } from "../ui.js";
import { sheetKeys, periodLocked, lockedBanner } from "./shared.js";
import { isPhone, stackTable } from "../phone.js";

const MONEY = [
  { k: "business_total", label: "Business" },
  { k: "rent", label: "Rent" },
  { k: "hub_fee", label: "Hub fee" },
  { k: "security_cost", label: "Security" },
  { k: "personal_draw", label: "Personal draw" },
];

// Week starts (Mondays) that fall inside the period — a week belongs to the month its start date is in.
function weekStarts(period) {
  const [y, m] = period.split("-").map(Number);
  const out = [];
  for (let d = new Date(Date.UTC(y, m - 1, 1)); d.getUTCMonth() === m - 1; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 1) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let week = null;

export default {
  title: "Weekly sheet",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, entries, locked] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      get("/api/weekly" + qs({ period: state.period, hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    const managers = staff.filter((s) => s.role === "manager" && s.status === "active");
    const editable = can("enter_data") && !locked;
    const weeks = weekStarts(state.period);
    const st = state.settings;
    const rule = { threshold: Number(st.manager_commission_threshold ?? 10000000), high: Number(st.manager_commission_high ?? 0.2), low: Number(st.manager_commission_low ?? 0.15),
      rent: Number(st.manager_rent_default ?? 0), hub: Number(st.manager_hub_fee_default ?? 0), security: Number(st.manager_security_rate ?? 0) };
    if (!weeks.includes(week)) week = weeks.find((w) => w <= new Date().toISOString().slice(0, 10) && addDays(w, 6) >= new Date().toISOString().slice(0, 10)) || weeks[0];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Weekly sheet</h1><p>One row per manager per week. Weekly balance = business × profit % − rent − hub fee − security − personal draw.
          Profit is ${+(rule.high * 100).toFixed(2)}% when the week's business is Rs ${money(rule.threshold)} or more, otherwise ${+(rule.low * 100).toFixed(2)}%. You can change any figure.</p></div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card mb-4">
        <div class="card-head"><div class="seg" id="weeks">${weeks.map((w) => {
          const n = entries.filter((e) => e.week_start === w).length;
          return html`<button data-w="${w}" class="${w === week ? "on" : ""}">${dateLabel(w).replace(/^\w+ /, "")} – ${dateLabel(addDays(w, 6)).replace(/^\w+ /, "")}
            <span class="faint" style="margin-left:4px">${n}/${managers.length}</span></button>`;
        })}</div></div>
        <div class="card-body flush" id="grid"></div>
      </div>
      <div class="card"><div class="card-head"><div><h2>Month overview</h2><div class="sub">Weekly balances per manager</div></div></div>
        <div class="card-body flush" id="overview"></div></div>`;

    if (!managers.length) {
      $("#grid").innerHTML = emptyState("No active managers", "Add managers on the Employees page first.", "users").toString();
      return;
    }
    $$("#weeks button", el).forEach((b) => (b.onclick = async () => {
      if (Number($("#grid").dataset.dirty || 0) && !(await confirmDialog({ title: "Discard unsaved changes?", message: "Edits on this week haven't been saved.", confirmText: "Discard", danger: true }))) return;
      week = b.dataset.w; this.render(ctx);
    }));

    const byMgr = Object.fromEntries(entries.filter((e) => e.week_start === week).map((e) => [e.manager_id, e]));
    // A new row starts from the rules: rent and hub fee as this manager last paid them (or the default), profit % and security from the business.
    const lastRow = (id) => entries.filter((e) => e.manager_id === id && e.week_start < week).sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
    const grid = $("#grid");
    grid.innerHTML = html`
      <div class="table-wrap"><table class="table sheet">
        <thead><tr><th scope="col">Manager</th><th scope="col" class="r">Business</th><th scope="col" class="r">Profit %</th>${MONEY.slice(1).map((f) => html`<th class="r">${f.label}</th>`)}<th class="r">Weekly balance</th></tr></thead>
        <tbody>${managers.map((mg, i) => {
          const e = byMgr[mg.employee_id];
          const p = e ? e.profit_percent : null;
          const lw = lastRow(mg.employee_id);
          const pre = { rent: lw ? lw.rent : rule.rent, hub_fee: lw ? lw.hub_fee : rule.hub };
          const auto = e || !editable ? "" : "data-auto";
          return html`<tr data-i="${i}">
            <th scope="row" class="name"><b>${mg.name}</b><div class="faint text-sm fw-400">${mg.employee_id} · ${mg.hub}</div></th>
            <td><input data-f="business_total" aria-label="Business, ${mg.name}" inputmode="decimal" value="${e ? fromCents(e.business_total) : ""}" ${editable ? "" : "disabled"}></td>
            <td><input data-f="profit_percent" ${raw(auto)} aria-label="Profit %, ${mg.name}" inputmode="decimal" value="${p != null ? +(p * 100).toFixed(4) : ""}" ${editable ? "" : "disabled"} style="min-width:70px"></td>
            ${MONEY.slice(1).map((f) => html`<td><input data-f="${f.k}" ${raw(f.k === "security_cost" ? auto : "")} aria-label="${f.label}, ${mg.name}" inputmode="decimal"
              value="${e ? (e[f.k] ? fromCents(e[f.k]) : "") : pre[f.k] ? fromCents(pre[f.k]) : ""}" ${editable ? "" : "disabled"}></td>`)}
            <td class="calc" data-calc></td></tr>`;
        })}</tbody>
      </table></div>
      ${editable ? html`<div class="row between card-foot">
        <span class="muted" id="dirty-info"></span><button class="btn primary" id="save">${icon("check")} Save week</button></div>` : ""}`;

    if (isPhone()) stackTable(grid.querySelector("table"), { grid: true });
    const rowVals = (tr) => Object.fromEntries([...tr.querySelectorAll("[data-f]")].map((i) => [i.dataset.f, i.value.trim()]));
    const refresh = () => {
      let dirty = 0;
      $$("tbody tr", grid).forEach((tr) => {
        const v = rowVals(tr);
        const n = (k) => Number(v[k] || 0);
        const bal = Math.round(n("business_total") * n("profit_percent")) - Math.round((n("rent") + n("hub_fee") + n("security_cost") + n("personal_draw")) * 100);
        tr.querySelector("[data-calc]").innerHTML = v.business_total !== "" ? `<b class="${bal < 0 ? "neg" : ""}">${money(bal)}</b>` : "";
        const e = byMgr[managers[tr.dataset.i].employee_id];
        const changed = e
          ? MONEY.some((f) => Math.round(n(f.k) * 100) !== e[f.k]) || Math.abs(n("profit_percent") / 100 - e.profit_percent) > 1e-9
          : v.business_total !== "";
        tr.classList.toggle("dirty", changed);
        if (changed) dirty++;
      });
      grid.dataset.dirty = dirty;
      if ($("#dirty-info")) $("#dirty-info").textContent = dirty ? `${dirty} manager${dirty > 1 ? "s" : ""} changed` : "No unsaved changes";
    };
    // Typing the business fills profit % and security from the rules, until someone types their own figure there.
    grid.addEventListener("input", (ev) => {
      const inp = ev.target.closest("[data-f]");
      if (inp && inp.dataset.f !== "business_total") inp.removeAttribute("data-auto");
      if (inp?.dataset.f === "business_total") {
        const tr = inp.closest("tr");
        const b = Number(inp.value.trim());
        const ok = inp.value.trim() !== "" && Number.isFinite(b);
        const set = (f, v) => { const x = tr.querySelector(`[data-f=${f}][data-auto]`); if (x) x.value = ok ? v : ""; };
        set("profit_percent", +((Math.round(b * 100) >= rule.threshold ? rule.high : rule.low) * 100).toFixed(4));
        set("security_cost", rule.security ? Math.round(b * rule.security * 100) / 100 : "");
      }
      refresh();
    });
    sheetKeys(grid);
    refresh();

    $("#save")?.addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
      const rows = [];
      for (const tr of $$("tbody tr.dirty", grid)) {
        const v = rowVals(tr);
        const mg = managers[tr.dataset.i];
        if (v.business_total === "") continue;
        if (v.profit_percent === "") throw new Error(`${mg.name}: enter the profit %`);
        rows.push({ week_start: week, week_end: addDays(week, 6), manager_id: mg.employee_id, business_total: v.business_total,
          profit_percent: Number(v.profit_percent) / 100, rent: v.rent || 0, hub_fee: v.hub_fee || 0, security_cost: v.security_cost || 0, personal_draw: v.personal_draw || 0 });
      }
      if (!rows.length) return toast("Nothing to save", "warn");
      const res = await post("/api/weekly/bulk", { rows });
      toast(`Week saved — ${res.created} added, ${res.updated} updated`);
      this.render(ctx);
    }));

    // Month overview (a card per manager on a phone)
    const tbl = managers.map((mg) => {
      const cells = weeks.map((w) => {
        const e = entries.find((x) => x.manager_id === mg.employee_id && x.week_start === w);
        if (!e) return null;
        return Math.round(e.business_total * e.profit_percent) - e.rent - e.hub_fee - e.security_cost - e.personal_draw;
      });
      return { mg, cells, total: cells.reduce((t, c) => t + (c || 0), 0) };
    });
    $("#overview").innerHTML = html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Manager</th>${weeks.map((w) => html`<th class="r">w/c ${dateLabel(w).replace(/^\w+ /, "")}</th>`)}<th class="r">Month</th></tr></thead>
      <tbody>${tbl.map((r) => html`<tr><td><b>${r.mg.name}</b></td>${r.cells.map((c) => html`<td class="r">${c == null ? html`<span class="badge amber plain">missing</span>` : html`<span class="${c < 0 ? "neg" : ""}">${money(c)}</span>`}</td>`)}
        <td class="r"><b class="${r.total < 0 ? "neg" : ""}">${money(r.total)}</b></td></tr>`)}</tbody></table></div>`.toString();
    if (isPhone()) stackTable($("#overview table"));
  },
};
