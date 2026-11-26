import { get, post, qs } from "../api.js";
import { state, can, scopeHub, setDirtyCheck, navigate } from "../app.js";
import { exportButtons, $, $$, html, esc, icon, money, toast, busy, confirmDialog, modal, dateLabel, emptyState, downloadCsv, parseCsv, fromCents, parseAmount, isAmount, formatAmount, dataTable } from "../ui.js";
import { mountRange } from "../range.js";
import { wireFilters } from "../foldfilters.js";
import { sheetKeys, moneyInputs, periodLocked, lockedBanner, readOnlyBanner, segButtons, managerGroupOf, teamOrder } from "./shared.js";
import { isPhone } from "../phone.js";
import { announce, badge, initials } from "../ui.js";

// On a phone the daily sheet is entered one person at a time ("one by one"); the grid is still there for people who prefer it.
const viewPref = () => { try { return localStorage.getItem("pr.daily.view") || "quick"; } catch { return "quick"; } };
const setViewPref = (v) => { try { localStorage.setItem("pr.daily.view", v); } catch { /* private mode */ } };

// Which manager cards are folded is remembered in this browser.
const CLOSED_KEY = "pr.daily.closed";
const loadClosed = () => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY)) || []; } catch { return []; } };
const saveClosed = (ids) => { try { localStorage.setItem(CLOSED_KEY, JSON.stringify(ids)); } catch { /* private mode */ } };

const FIELDS = [
  { k: "business_amount", label: "Business" },
  { k: "settled_amount", label: "Settled" },
  { k: "personal_minus", label: "Personal minus" },
];

const levelName = (g) => ({ manager: "Manager", supervisor: "Supervisor", distributor: "Distributor" }[g.staff_level] || g.staff_level);

function daysIn(period) {
  const [y, m] = period.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`);
}

let mode = "day";
let currentDate = null;
let currentEmp = null;
let staffAll = []; // everyone in view, including the people above the sellers, so each seller's manager can be found

// The office does not get one sheet with every hub's people mixed together. It gets the hubs, each showing how many of its people
// have a day entered for the chosen date; a hub opens to its own sheet (by day, by employee, or a date range).
async function hubList({ el }) {
  document.body.dataset.filters = "month"; // every hub is listed, so the hub choice is not shown
  const days = daysIn(state.period), todayIso = new Date().toISOString().slice(0, 10);
  if (!currentDate || !currentDate.startsWith(state.period)) currentDate = days.includes(todayIso) ? todayIso : days[0];
  el.innerHTML = html`<div class="daily-page">
    <div class="page-head"><div><h1>Daily sheet</h1><p>Days are entered hub by hub. Pick a hub to enter or check its days.</p></div></div>
    <div class="dl-daybar mb-4" id="dl-day"></div>
    <div id="dl-hubs"><div class="loading-screen"><div class="spinner"></div></div></div></div>`.toString();
  const closed = String(state.settings.closed_weekdays || "").split(",").filter(Boolean).map(Number);
  let seq = 0;
  const load = async () => {
    const mine = ++seq, date = currentDate, idx = days.indexOf(date);
    const [staff, entries] = await Promise.all([get("/api/staff"), get("/api/daily" + qs({ from: date, to: date }))]);
    if (mine !== seq) return;
    const done = new Set(entries.map((e) => e.employee_id));
    const sellers = staff.filter((s) => (s.role === "guy" || s.staff_level === "manager" || s.staff_level === "promoting_manager") && s.status === "active" && (!s.join_date || s.join_date <= date));
    const isClosed = closed.includes(new Date(date + "T00:00:00Z").getUTCDay());
    $("#dl-day").innerHTML = html`<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn icon" id="dl-prev" aria-label="Previous day" ${idx <= 0 ? "disabled" : ""}>${icon("left")}</button>
        <input type="date" class="input" id="dl-date" aria-label="Date" value="${date}" min="${days[0]}" max="${days[days.length - 1]}" style="width:160px">
        <button type="button" class="btn icon" id="dl-next" aria-label="Next day" ${idx >= days.length - 1 ? "disabled" : ""}>${icon("right")}</button>
        <b style="font-size:17px">${dateLabel(date)}</b>${isClosed ? badge("blue", "Closed day") : ""}</div>`.toString();
    const go = (d) => { if (d && d.startsWith(state.period)) { currentDate = d; load().catch((e) => toast(e.message, "warn")); } else toast("Pick a date inside the selected pay period", "warn"); };
    $("#dl-prev").onclick = () => go(days[idx - 1]);
    $("#dl-next").onclick = () => go(days[idx + 1]);
    $("#dl-date").onchange = (e) => go(e.target.value);
    const hubs = state.hubs.filter((h) => h.status === "active");
    $("#dl-hubs").innerHTML = hubs.length ? html`<div class="card hs-list"><ul role="list">${hubs.map((h) => {
      const mine = sellers.filter((s) => s.hub === h.code), n = mine.filter((s) => done.has(s.employee_id)).length, missing = mine.length - n;
      return html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/sales/daily" data-link aria-label="${h.name}: open its daily sheet">
        <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · ${n} of ${mine.length} entered</span></span>
        <span class="hs-flags">${!mine.length ? html`<span class="muted">No sellers</span>` : missing ? badge("amber", `${missing} to enter`) : badge("green", "Complete")}</span>
        <span class="hs-chev" aria-hidden="true"></span></a></li>`;
    })}</ul></div><p class="muted hs-hint">Tap a hub to enter its days, or to see them by employee or for a range of dates.</p>`.toString()
      : emptyState("No hubs yet", "Add a hub first, then its daily sheet appears here.", "store").toString();
  };
  await load();
}

export default {
  title: "Daily sheet",
  periodic: true,
  async render(ctx) {
    if (can("read") && !state.user.hub && !state.routeHub) return hubList(ctx);
    const { el } = ctx;
    const [staff, locked] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    staffAll = staff;
    const guys = staff.filter((s) => (s.role === "guy" || s.staff_level === "manager" || s.staff_level === "promoting_manager") && s.status === "active"); // everyone who sells, managers included
    // The days are entered by the hub's own coacher. The office (no hub of its own) looks at them and checks them, but does not enter them.
    const office = !state.user.hub;
    const editable = can("enter_data") && !locked && !office;
    const days = daysIn(state.period);
    const today = new Date().toISOString().slice(0, 10);
    if (!currentDate || !currentDate.startsWith(state.period)) currentDate = days.includes(today) ? today : days[0];
    if (!currentEmp || !guys.some((g) => g.employee_id === currentEmp)) currentEmp = guys[0]?.employee_id;

    el.innerHTML = html`<div class="daily-page">
      <div class="page-head">
        <div><h1>Daily sheet</h1><p class="hide-sm">Business and settlements for everyone who sells: distributors, supervisors and managers. Settle-up minus is calculated automatically.</p></div>
        <div class="actions" data-filters-host>
          <div class="seg"><button data-mode="day" class="${mode === "day" ? "on" : ""}">By day</button><button data-mode="emp" class="${mode === "emp" ? "on" : ""}">By employee</button><button data-mode="range" class="${mode === "range" ? "on" : ""}">Date range</button></div>
          <button type="button" class="btn filters-toggle" aria-expanded="false" aria-controls="dl-more">${icon("download")} Import / export</button>
          <div class="filter-panel" id="dl-more">
            ${editable && mode !== "range" ? html`<button class="btn" id="import">${icon("upload")} <span class="lbl-sm">Import CSV</span></button>` : ""}
            <button class="btn" id="export">${icon("download")} <span class="lbl-sm">CSV</span></button>
            ${mode === "range" || !can("read") ? "" : exportButtons("daily", { period: state.period, hub: scopeHub() })}
          </div>
        </div>
      </div>
      ${locked && mode !== "range" ? lockedBanner(state.period) : office && mode !== "range" ? readOnlyBanner("View only. The hub's coacher enters the days; here you check them.") : ""}
      <div class="card">
        <div class="card-head" id="picker"></div>
        <div class="card-body flush" id="grid"></div>
      </div></div>`;

    wireFilters(el);
    $$("[data-mode]", el).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; this.render(ctx); }));
    $("#export").onclick = async () => {
      // In Date range the file holds the days on screen; in the other views it holds the pay month.
      const inRange = mode === "range" && rangeShown;
      const rows = inRange ? rangeShown.rows : await get("/api/daily" + qs({ period: state.period, hub: scopeHub() }));
      const names = Object.fromEntries(staff.map((s) => [s.employee_id, s.name]));
      downloadCsv(inRange ? `daily-${rangeShown.from}-to-${rangeShown.to}.csv` : `daily-${state.period}.csv`, ["date", "employee_id", "name", "business_amount", "settled_amount", "settle_up_minus", "personal_minus", "notes"],
        rows.map((r) => [r.date, r.employee_id, names[r.employee_id], fromCents(r.business_amount), fromCents(r.settled_amount), fromCents(r.settle_up_minus), fromCents(r.personal_minus), r.notes || ""]));
    };
    $("#import")?.addEventListener("click", () => importCsv(guys, () => this.render(ctx)));

    if (!guys.length) {
      $("#grid").innerHTML = emptyState("No active sales staff", "Add distributors and supervisors on the Employees page first.", "users",
        can("manage_staff") ? `<a class="btn primary" href="/employees" data-link>Go to employees</a>` : "").toString();
      return;
    }
    if (mode === "day") await dayMode(ctx, guys, days, editable);
    else if (mode === "range") await rangeMode(staff);
    else await empMode(ctx, guys, days, editable);
  },
};

// ---------------------------------------------------------------- date range (read-only report)

let rangeShown = null; // the days on screen: { from, to, rows }, for the CSV button
let rangeBy = "person";

// Sales, cash handed in, shortage and advances for any dates, added up by person or by day. Nothing is entered here: use By day or By employee for that.
async function rangeMode(staff) {
  const names = Object.fromEntries(staff.map((s) => [s.employee_id, s]));
  $("#picker").innerHTML = html`<div id="dr-range"></div><div class="seg" id="dr-by" role="group" aria-label="Group by">
    <button type="button" data-by="person" class="${rangeBy === "person" ? "on" : ""}">By person</button><button type="button" data-by="day" class="${rangeBy === "day" ? "on" : ""}">By day</button></div>`.toString();
  $("#picker").classList.add("dr-head");
  let seq = 0, picker = null;
  const load = async () => {
    const r = picker.get(), mine = ++seq;
    $("#grid").innerHTML = `<div class="loading-screen" style="min-height:160px"><div class="spinner"></div></div>`;
    const rows = await get("/api/daily" + qs({ from: r.from, to: r.to, hub: scopeHub() }));
    if (mine !== seq) return;
    rangeShown = { from: r.from, to: r.to, rows };
    draw();
  };
  const draw = () => {
    const { rows } = rangeShown;
    const add = (m, key, base, r) => {
      const x = m.get(key) || m.set(key, { ...base, days: 0, people: new Set(), business: 0, settled: 0, short: 0, personal: 0 }).get(key);
      x.days += 1; x.people.add(r.employee_id); x.business += Number(r.business_amount); x.settled += Number(r.settled_amount); x.short += Number(r.settle_up_minus); x.personal += Number(r.personal_minus);
    };
    const by = new Map();
    for (const r of rows) rangeBy === "person" ? add(by, r.employee_id, { employee_id: r.employee_id, name: names[r.employee_id]?.name || r.employee_id, level: levelName(names[r.employee_id] || {}) }, r) : add(by, r.date, { date: r.date }, r);
    const list = [...by.values()].sort((a, b) => (rangeBy === "person" ? b.business - a.business : a.date < b.date ? 1 : -1));
    const sum = (rs, k) => money(rs.reduce((t, x) => t + x[k], 0));
    const num = (k) => ({ key: k, label: { business: "Business", settled: "Handed in", short: "Short", personal: "Advance" }[k], align: "r", render: (x) => (k === "short" && x.short > 0 ? html`<span class="neg">${money(x.short)}</span>` : money(x[k])), total: (rs) => sum(rs, k) });
    $("#grid").innerHTML = list.length ? dataTable({
      rows: list, footer: true, pageSize: 50, sortable: true, empty: "No sales in these dates",
      onRow: rangeBy === "person" ? (x) => navigate(`/employees/${encodeURIComponent(x.employee_id)}`) : undefined,
      card: (x) => html`<span class="mc-main"><b>${rangeBy === "person" ? x.name : dateLabel(x.date)}</b><span class="mc-sub">${rangeBy === "person" ? `${x.level} · ${x.days} days` : `${x.people.size} people`}</span></span><span class="mc-end">${money(x.business)}<br><span class="muted">${x.short > 0 ? `short ${money(x.short)}` : "handed in"}</span></span>`,
      cols: [
        rangeBy === "person"
          ? { key: "name", label: "Person", render: (x) => html`<b>${x.name}</b><div class="faint text-sm">${x.employee_id} · ${x.level}</div>`, total: () => "Total" }
          : { key: "date", label: "Day", render: (x) => html`<b>${dateLabel(x.date)}</b>`, total: () => "Total" },
        rangeBy === "person" ? { key: "days", label: "Days", align: "r", total: (rs) => rs.reduce((t, x) => t + x.days, 0) } : { key: "people", label: "People", align: "r", render: (x) => x.people.size },
        num("business"), num("settled"), num("short"), num("personal"),
      ],
    }).toString() : emptyState("No sales in these dates", "Try a wider range. Days appear here once they are entered on the daily sheet.", "sheet").toString();
  };
  picker = mountRange($("#dr-range"), { page: "daily", fallback: "week", onChange: () => load().catch((e) => toast(e.message, "warn")) });
  $("#dr-by").onclick = (e) => { const b = e.target.closest("[data-by]"); if (!b) return; rangeBy = b.dataset.by; $$("#dr-by button").forEach((x) => x.classList.toggle("on", x === b)); if (rangeShown) draw(); };
  await load();
}

// ---------------------------------------------------------------- grid core

// rows: [{ key, label, sub, date, employee_id, existing, muted }]
function buildGrid({ rows, editable, firstCol, onSaved, groups = null }) {
  const stale = $("#grid");
  const grid = stale.cloneNode(false); // drop listeners from the previous day/employee
  stale.replaceWith(grid);
  const cents = (v) => Math.round((parseAmount(v) || 0) * 100);
  const amt = (c) => (c == null ? "" : formatAmount(c / 100));
  const totalsRow = () => {
    const sums = { business_amount: 0, settled_amount: 0, personal_minus: 0 };
    $$("tbody tr", grid).forEach((tr) => FIELDS.forEach((f) => {
      const v = tr.querySelector(`[data-f="${f.k}"]`).value;
      if (isAmount(v)) sums[f.k] += cents(v);
    }));
    return sums;
  };
  const cell = (f, r, value) => html`<td><input data-f="${f.k}" data-money inputmode="decimal" autocomplete="off" value="${value}" ${editable ? "" : "disabled"}
    aria-label="${f.label}, ${r.label}${r.sub ? ", " + r.sub : ""}"></td>`;
  const rowHtml = (r, i) => html`
        <tr data-i="${i}" style="${r.muted ? "opacity:.6" : ""}">
          <th scope="row" class="name"><b>${r.label}</b><div class="faint text-sm fw-400">${r.sub}</div></th>
          ${FIELDS.slice(0, 2).map((f) => cell(f, r, r.existing ? amt(r.existing[f.k]) : ""))}
          <td class="calc" data-calc aria-live="off"></td>
          ${cell(FIELDS[2], r, r.existing && r.existing.personal_minus ? amt(r.existing.personal_minus) : "")}
          <td><input class="text" data-f="notes" value="${r.existing?.notes || ""}" ${editable ? "" : "disabled"} aria-label="Notes, ${r.label}"></td>
          <td>${r.existing?.updated_by ? html`<span class="badge plain" title="Edited by ${r.existing.updated_by}">edited</span>` : ""}</td>
        </tr>`;
  const tableOf = (idxs, foot, caption) => html`
    <div class="table-wrap" tabindex="-1"><table class="table sheet">
      <caption class="sr-only">${caption}</caption>
      <thead><tr><th scope="col">${firstCol}</th>${FIELDS.slice(0, 2).map((f) => html`<th scope="col" class="r">${f.label}</th>`)}<th scope="col" class="r">Settle-up minus</th>
        <th scope="col" class="r">${FIELDS[2].label}</th><th scope="col">Notes</th><th scope="col"><span class="sr-only">Status</span></th></tr></thead>
      <tbody>${idxs.map((i) => rowHtml(rows[i], i))}</tbody>
      ${foot ? html`<tfoot><tr><th scope="row">Total</th><td class="r" data-t="business_amount"></td><td class="r" data-t="settled_amount"></td><td class="r" data-t="settle"></td><td class="r" data-t="personal_minus"></td><td colspan="2"></td></tr></tfoot>` : ""}
    </table></div>`;
  const closed = loadClosed();
  grid.innerHTML = html`
    ${groups ? html`
      <div class="dsum" role="group" aria-label="Totals for everyone on this sheet">
        <div class="dstat"><span>Business</span><b data-s="business_amount">0.00</b></div>
        <div class="dstat"><span>Handed in</span><b data-s="settled_amount">0.00</b></div>
        <div class="dstat"><span>Short</span><b data-s="settle">0.00</b></div>
        <div class="dstat"><span>Entered</span><b data-s="entered">0 of ${rows.length}</b></div>
        <div class="dsum-actions"><button type="button" class="btn sm" id="grp-open">Expand all</button><button type="button" class="btn sm" id="grp-close">Collapse all</button></div>
      </div>
      ${groups.map((g) => html`<details class="dgrp card" data-gid="${g.id}" ${closed.includes(g.id) ? "" : "open"}>
        <summary><span class="dg-chev" aria-hidden="true">${icon("right")}</span><span class="avatar" aria-hidden="true">${initials(g.title)}</span>
          <span class="dg-title"><b>${g.title}</b><small>${g.sub}${g.sub ? " · " : ""}${g.idxs.length} ${g.idxs.length === 1 ? "person" : "people"}</small></span>
          <span class="dg-nums"><span><small>Business</small><b data-gt="business_amount">0.00</b></span><span><small>Short</small><b data-gt="settle">0.00</b></span><span class="dg-prog" data-gt="entered"></span></span></summary>
        ${tableOf(g.idxs, false, `Daily entries for ${g.title}'s group. Enter or arrow keys move between rows.`)}
      </details>`)}`
      : tableOf(rows.map((_, i) => i), true, "Daily entries. Enter or arrow keys move between rows.")}
    <p class="scroll-hint">Swipe the table sideways to see all columns.</p>
    <div id="sheet-errors"></div>
    ${editable ? html`<div class="savebar">
      <span class="muted" id="dirty-info" role="status">No unsaved changes</span>
      <div class="row"><button type="button" class="btn" id="revert" disabled>Discard</button><button type="button" class="btn primary" id="save" disabled>${icon("check")} Save sheet</button></div></div>` : ""}`;
  if (groups) {
    $$("details.dgrp", grid).forEach((d) => d.addEventListener("toggle", () => saveClosed($$("details.dgrp", grid).filter((x) => !x.open).map((x) => x.dataset.gid))));
    $("#grp-open", grid).onclick = () => $$("details.dgrp", grid).forEach((d) => (d.open = true));
    $("#grp-close", grid).onclick = () => $$("details.dgrp", grid).forEach((d) => (d.open = false));
  }

  // Validate as the user types: bad amounts are marked on the cell, never shown as "NaN".
  const validate = (tr) => {
    let ok = true;
    FIELDS.forEach((f) => {
      const inp = tr.querySelector(`[data-f="${f.k}"]`);
      const bad = !isAmount(inp.value) || (parseAmount(inp.value) ?? 0) < 0;
      inp.toggleAttribute("aria-invalid", bad);
      if (bad) { inp.setAttribute("aria-invalid", "true"); ok = false; }
    });
    tr.classList.toggle("error", !ok);
    return ok;
  };
  const refresh = () => {
    let dirty = 0;
    $$("tbody tr", grid).forEach((tr) => {
      const r = rows[tr.dataset.i];
      const val = (f) => tr.querySelector(`[data-f="${f}"]`).value.trim();
      const valid = validate(tr);
      const c = tr.querySelector("[data-calc]");
      const any = val("business_amount") !== "" || val("settled_amount") !== "";
      if (!valid) c.innerHTML = `<span class="neg">check amounts</span>`;
      else {
        const d = cents(val("business_amount")) - cents(val("settled_amount"));
        c.innerHTML = any ? `<span class="${d > 0 ? "neg" : d < 0 ? "pos" : ""}">${money(d)}</span>` : "";
      }
      const orig = r.existing;
      const changed = !valid || ["business_amount", "settled_amount", "personal_minus"].some((f) => {
        const now = val(f) === "" ? (f === "personal_minus" && orig ? 0 : null) : cents(val(f));
        return (orig ? orig[f] : null) !== now && !(now === null && !orig);
      }) || (val("notes") || null) !== (orig?.notes || null);
      tr.classList.toggle("dirty", changed);
      if (changed) dirty++;
    });
    const t = totalsRow();
    if ($('[data-t="business_amount"]', grid)) { // one flat table: the totals row
      $('[data-t="business_amount"]', grid).textContent = money(t.business_amount);
      $('[data-t="settled_amount"]', grid).textContent = money(t.settled_amount);
      $('[data-t="settle"]', grid).textContent = money(t.business_amount - t.settled_amount);
      $('[data-t="personal_minus"]', grid).textContent = money(t.personal_minus);
    }
    if (groups) { // one card per manager: their own totals, and how many of their people are entered
      const per = {};
      let enteredAll = 0;
      $$("tbody tr", grid).forEach((tr) => {
        const gid = rows[tr.dataset.i].group;
        const v = (f) => tr.querySelector(`[data-f="${f}"]`).value.trim();
        const x = (per[gid] = per[gid] || { b: 0, s: 0, n: 0, of: 0 });
        x.of++;
        if (v("business_amount") !== "" || v("settled_amount") !== "") { x.n++; enteredAll++; }
        if (isAmount(v("business_amount"))) x.b += cents(v("business_amount"));
        if (isAmount(v("settled_amount"))) x.s += cents(v("settled_amount"));
      });
      const short = (el, c) => { el.textContent = money(c); el.classList.toggle("neg", c > 0); };
      for (const g of groups) {
        const card = $(`details.dgrp[data-gid="${g.id}"]`, grid), x = per[g.id] || { b: 0, s: 0, n: 0, of: 0 };
        $('[data-gt="business_amount"]', card).textContent = money(x.b);
        short($('[data-gt="settle"]', card), x.b - x.s);
        const prog = $('[data-gt="entered"]', card);
        prog.textContent = `${x.n} of ${x.of} entered`;
        prog.className = `dg-prog ${x.n === x.of ? "done" : x.n ? "part" : ""}`;
      }
      $('[data-s="business_amount"]', grid).textContent = money(t.business_amount);
      $('[data-s="settled_amount"]', grid).textContent = money(t.settled_amount);
      short($('[data-s="settle"]', grid), t.business_amount - t.settled_amount);
      $('[data-s="entered"]', grid).textContent = `${enteredAll} of ${rows.length}`;
    }
    if (editable) {
      $("#save").disabled = $("#revert").disabled = !dirty;
      $("#dirty-info").textContent = dirty ? `${dirty} row${dirty > 1 ? "s" : ""} changed — not saved yet` : "No unsaved changes";
      $(".savebar", grid).classList.toggle("has-changes", !!dirty);
    }
    grid.dataset.dirty = dirty;
  };
  grid.addEventListener("input", refresh);
  sheetKeys(grid);
  moneyInputs(grid);
  setDirtyCheck(() => Number(grid.dataset.dirty || 0));
  refresh();
  if (!editable) return;

  const showErrors = (list) => {
    $("#sheet-errors", grid).innerHTML = list.length ? html`<div class="alert err sheet-errors" role="alert" tabindex="-1">${icon("alert")}<div>
      <b>${list.length} row${list.length > 1 ? "s need" : " needs"} fixing before saving:</b>
      <ul style="margin:6px 0 0;padding-left:18px">${list.map((m) => html`<li>${m}</li>`)}</ul></div></div>`.toString() : "";
  };
  $("#revert").onclick = onSaved;
  $("#save").onclick = (e) => busy(e.currentTarget, async () => {
    const out = [];
    const problems = [];
    let deletions = 0;
    for (const tr of $$("tbody tr.dirty", grid)) {
      const r = rows[tr.dataset.i];
      const v = (f) => tr.querySelector(`[data-f="${f}"]`).value.trim();
      if (!validate(tr)) { problems.push(`${r.label}: amounts must be numbers of 0 or more (for example 12,500 or 12500.50).`); continue; }
      if (v("business_amount") === "" && v("settled_amount") === "") {
        if (r.existing) { out.push({ date: r.date, employee_id: r.employee_id, _delete: true }); deletions++; }
        continue;
      }
      if (v("business_amount") === "" || v("settled_amount") === "") {
        tr.classList.add("error");
        tr.querySelector(`[data-f="${v("business_amount") === "" ? "business_amount" : "settled_amount"}"]`).setAttribute("aria-invalid", "true");
        problems.push(`${r.label}: enter both Business and Settled.`);
        continue;
      }
      out.push({ date: r.date, employee_id: r.employee_id, business_amount: parseAmount(v("business_amount")), settled_amount: parseAmount(v("settled_amount")),
        personal_minus: parseAmount(v("personal_minus")) || 0, notes: v("notes") });
    }
    showErrors(problems);
    if (problems.length) { const bad = $("tbody [aria-invalid=true]", grid); bad?.closest("details")?.setAttribute("open", ""); bad?.focus(); return; }
    if (!out.length) return;
    if (deletions && !(await confirmDialog({ title: "Delete entries?", message: `${deletions} cleared row${deletions > 1 ? "s" : ""} will be deleted. Deletions are recorded in the audit trail.`, confirmText: "Delete & save", danger: true }))) return;
    try {
      const res = await post("/api/daily/bulk", { rows: out });
      setDirtyCheck(null);
      toast(`Saved — ${res.created} added, ${res.updated} updated${res.deleted ? `, ${res.deleted} deleted` : ""}`);
      onSaved();
    } catch (err) {
      showErrors([err.message]);
      $("#sheet-errors .alert", grid)?.focus();
    }
  });
}

async function guardUnsaved() {
  if (Number($("#grid")?.dataset.dirty || 0) === 0) return true;
  return !!(await confirmDialog({ title: "Discard unsaved changes?", message: "You have edits on this sheet that haven't been saved.", confirmText: "Discard", danger: true }));
}

// ---------------------------------------------------------------- modes

async function dayMode(ctx, guys, days, editable) {
  const entries = await get("/api/daily" + qs({ from: currentDate, to: currentDate, hub: scopeHub() }));
  const byEmp = Object.fromEntries(entries.map((e) => [e.employee_id, e]));
  const idx = days.indexOf(currentDate);
  $("#picker").innerHTML = html`
    <div class="row">
      <button class="btn icon sm" id="prev-day" ${idx <= 0 ? "disabled" : ""} aria-label="Previous day">${icon("left")}</button>
      <input type="date" class="input sm" id="day" aria-label="Date" value="${currentDate}" min="${days[0]}" max="${days[days.length - 1]}" style="width:160px">
      <button class="btn icon sm" id="next-day" ${idx >= days.length - 1 ? "disabled" : ""} aria-label="Next day">${icon("right")}</button>
      <h2 style="margin-left:6px">${dateLabel(currentDate)}</h2>
    </div>
    <span class="badge ${entries.length === guys.length ? "green" : entries.length ? "amber" : ""}">${entries.length} of ${guys.length} entered</span>
    ${isPhone() && editable ? html`<div class="seg" id="view-seg" role="group" aria-label="How to enter"><button type="button" data-view="quick" aria-pressed="${viewPref() === "quick"}" class="${viewPref() === "quick" ? "on" : ""}">One by one</button>
      <button type="button" data-view="grid" aria-pressed="${viewPref() === "grid"}" class="${viewPref() === "grid" ? "on" : ""}">Grid</button></div>` : ""}`;
  const go = async (d) => { if (d && (await guardUnsaved())) { currentDate = d; ctx.el && (await dayMode(ctx, guys, days, editable)); } };
  $("#prev-day").onclick = () => go(days[idx - 1]);
  $("#next-day").onclick = () => go(days[idx + 1]);
  $("#day").onchange = (e) => (e.target.value.startsWith(state.period) ? go(e.target.value) : toast("Pick a date inside the selected pay period", "warn"));
  $$("#view-seg button").forEach((b) => (b.onclick = async () => { if (b.dataset.view === viewPref() || !(await guardUnsaved())) return; setViewPref(b.dataset.view); dayMode(ctx, guys, days, editable); }));
  if (isPhone() && editable && viewPref() === "quick") {
    setDirtyCheck(null);
    return quickEntry({ guys, byEmp, date: currentDate, toGrid: () => { setViewPref("grid"); dayMode(ctx, guys, days, editable); }, refresh: () => dayMode(ctx, guys, days, editable) });
  }
  // One card per manager: the manager and everyone who reports to them, so the sheet reads team by team.
  const byId = Object.fromEntries(staffAll.map((s) => [s.employee_id, s]));
  const teams = new Map();
  for (const g of guys) {
    const k = managerGroupOf(g, byId);
    if (!teams.has(k.id)) teams.set(k.id, { ...k, people: [] });
    teams.get(k.id).people.push(g);
  }
  // Looking only, on a phone: a short card per person (what they sold and handed in, or "Not entered"), team by team. Tap one to open them.
  if (isPhone() && !editable) {
    $("#grid").innerHTML = html`<div class="ro-days">${[...teams.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((t) => html`<section aria-label="${t.title}">
      <h3 class="ro-h"><b>${t.title}</b> <span class="muted">${t.sub}</span></h3>
      <div class="card hs-list"><ul role="list">${t.people.sort(teamOrder).map((g) => {
        const e = byEmp[g.employee_id], short = e ? Number(e.settle_up_minus) : 0;
        return html`<li><a class="hs-row" href="/employees/${encodeURIComponent(g.employee_id)}" data-link aria-label="${g.name}: open record">
          <span class="hs-main"><b>${g.name}</b><span class="muted">${g.employee_id} · ${levelName(g)}</span></span>
          <span class="hs-flags">${e ? html`<b class="num">${money(e.business_amount)}</b>${short > 0 ? badge("red", `short ${money(short)}`) : ""}` : badge("amber", "Not entered")}</span>
          <span class="hs-chev" aria-hidden="true"></span></a></li>`;
      })}</ul></div></section>`)}</div>`.toString();
    return;
  }
  const rows = [], groups = [];
  for (const t of [...teams.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
    const idxs = t.people.sort(teamOrder).map((g) => rows.push({ label: g.name, sub: `${g.employee_id} · ${levelName(g)}`, date: currentDate, employee_id: g.employee_id, existing: byEmp[g.employee_id], group: t.id }) - 1);
    groups.push({ id: t.id, title: t.title, sub: `${t.sub}${scopeHub() || !t.hub ? "" : " · " + t.hub}`, idxs });
  }
  buildGrid({ firstCol: "Employee", editable, rows, groups, onSaved: () => dayMode(ctx, guys, days, editable) });
}

async function empMode(ctx, guys, days, editable) {
  const entries = await get("/api/daily" + qs({ period: state.period, employee_id: currentEmp }));
  const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
  const closed = String(state.settings.closed_weekdays || "").split(",").filter(Boolean).map(Number);
  const emp = guys.find((g) => g.employee_id === currentEmp);
  $("#picker").innerHTML = html`
    <div class="row"><select class="input sm" id="emp" style="width:260px">${guys.map((g) => html`<option value="${g.employee_id}" ${g.employee_id === currentEmp ? "selected" : ""}>${g.name} (${g.employee_id})</option>`)}</select>
      <a class="btn sm ghost" href="/employees/${encodeURIComponent(currentEmp)}" data-link>${icon("user")} Profile</a></div>
    <span class="muted">Target Rs ${money(emp.target)} · ${entries.length} days entered</span>`;
  $("#emp").onchange = async (e) => { if (await guardUnsaved()) { currentEmp = e.target.value; empMode(ctx, guys, days, editable); } else e.target.value = currentEmp; };
  buildGrid({
    firstCol: "Date", editable,
    rows: days.map((d) => {
      const wd = new Date(d + "T00:00:00Z").getUTCDay();
      return { label: dateLabel(d), sub: closed.includes(wd) ? "closed day" : "", date: d, employee_id: currentEmp, existing: byDate[d], muted: closed.includes(wd) && !byDate[d] };
    }),
    onSaved: () => empMode(ctx, guys, days, editable),
  });
}

// ---------------------------------------------------------------- CSV import

function importCsv(guys, done) {
  const m = modal({
    title: "Import daily entries",
    wide: true,
    body: html`
      <p class="muted" style="margin-top:0">Upload a CSV with the columns <code>date, employee_id, business_amount, settled_amount, personal_minus, notes</code>.
      Dates are <code>YYYY-MM-DD</code>; amounts in rupees. Existing entries for the same date and employee are updated.</p>
      <div class="row mb-3"><input type="file" accept=".csv,text/csv" id="csv-file" class="input" style="max-width:360px;padding-top:6px">
        <button class="btn sm ghost" id="tmpl">${icon("download")} Download template</button></div>
      <div id="csv-preview"></div>`.toString(),
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="csv-go" disabled>Import</button>`,
  });
  let rows = [];
  $("#tmpl", m.panel).onclick = () => downloadCsv("daily-template.csv", ["date", "employee_id", "business_amount", "settled_amount", "personal_minus", "notes"],
    guys.slice(0, 3).map((g) => [`${state.period}-01`, g.employee_id, "15000", "15000", "0", ""]));
  $("#csv-file", m.panel).onchange = async (e) => {
    const text = await e.target.files[0].text();
    const data = parseCsv(text);
    const head = data.shift()?.map((h) => h.trim().toLowerCase().replace(/^﻿/, "")) || [];
    const need = ["date", "employee_id", "business_amount", "settled_amount"];
    const missing = need.filter((n) => !head.includes(n));
    if (missing.length) { $("#csv-preview", m.panel).innerHTML = `<div class="alert err">${icon("alert")}<div>Missing columns: ${esc(missing.join(", "))}</div></div>`; return; }
    rows = data.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])))
      .map((r) => ({ date: r.date, employee_id: r.employee_id, business_amount: r.business_amount, settled_amount: r.settled_amount, personal_minus: r.personal_minus || 0, notes: r.notes || "" }));
    const known = new Set(guys.map((g) => g.employee_id));
    const unknown = [...new Set(rows.filter((r) => !known.has(r.employee_id)).map((r) => r.employee_id))];
    $("#csv-preview", m.panel).innerHTML = html`
      <div class="alert ${unknown.length ? "warn" : "info"}" style="margin-bottom:12px">${icon("info")}<div><b>${rows.length} rows</b> ready to import.
        ${unknown.length ? `Unknown or inactive employees: ${unknown.join(", ")} — those rows will be rejected.` : ""}</div></div>
      <div class="table-wrap" style="max-height:300px"><table class="table compact"><thead><tr><th>Date</th><th>Employee</th><th class="r">Business</th><th class="r">Settled</th><th class="r">Personal</th><th>Notes</th></tr></thead>
      <tbody>${rows.slice(0, 50).map((r) => html`<tr><td>${r.date}</td><td>${r.employee_id}</td><td class="r">${r.business_amount}</td><td class="r">${r.settled_amount}</td><td class="r">${r.personal_minus}</td><td>${r.notes}</td></tr>`)}</tbody></table></div>
      ${rows.length > 50 ? html`<p class="faint">…and ${rows.length - 50} more</p>` : ""}`.toString();
    $("#csv-go", m.panel).disabled = !rows.length;
  };
  $("#csv-go", m.panel).onclick = (e) => busy(e.currentTarget, async () => {
    const res = await post("/api/daily/bulk", { rows });
    toast(`Imported — ${res.created} added, ${res.updated} updated, ${res.unchanged} unchanged`);
    m.close();
    done();
  });
}



// ---------------------------------------------------------------- one person at a time
function quickEntry({ guys, byEmp, date, toGrid, refresh }) {
  const grid = $("#grid");
  const done = (g) => !!byEmp[g.employee_id];
  const firstOpen = () => Math.max(0, guys.findIndex((g) => !done(g)));
  let i = firstOpen();
  const rupees = (c) => (c == null ? "" : formatAmount(c / 100));
  const diffText = (b, s) => {
    if (b === null || s === null) return "The difference shows when both amounts are filled in.";
    const d = Math.round((b - s) * 100);
    return d > 0 ? `Short by Rs ${money(d)}. This is taken off their pay.` : d < 0 ? `Handed in Rs ${money(-d)} more than the business.` : "Nothing short. Business and handed-in match.";
  };

  const draw = (move = true) => {
    const count = guys.filter(done).length;
    if (i >= guys.length) { // everyone has been visited
      grid.innerHTML = html`<div class="quick"><p class="step-count">${count} of ${guys.length} entered</p><h3 class="step-title" id="q-name" tabindex="-1">${count === guys.length ? "All done for this day" : "End of the list"}</h3>
        <p class="muted">${count === guys.length ? "Everyone has an entry." : `${guys.length - count} still need an entry.`}</p>
        <div class="q-actions"><button type="button" class="btn" id="q-first">Back to the first person</button><button type="button" class="btn" id="q-grid">Open the grid</button></div></div>`.toString();
      $("#q-first").onclick = () => { i = firstOpen(); draw(); };
      $("#q-grid").onclick = toGrid;
      if (move) { announce(count === guys.length ? "All done for this day" : "End of the list"); $("#q-name").focus(); }
      return;
    }
    const g = guys[i], e = byEmp[g.employee_id];
    grid.innerHTML = html`<div class="quick">
      <p class="step-count" id="q-count">Person ${i + 1} of ${guys.length} · ${count} entered</p>
      <div class="step-bar" role="progressbar" aria-label="People entered" aria-valuemin="0" aria-valuemax="${guys.length}" aria-valuenow="${count}" aria-valuetext="${count} of ${guys.length} people entered"><span style="width:${(count / guys.length) * 100}%"></span></div>
      <div class="person-row"><button type="button" class="btn icon" id="q-prev" aria-label="Previous person" ${i === 0 ? "disabled" : ""}>${icon("left")}</button>
        <select class="input" id="q-sel" aria-label="Choose a person">${guys.map((x, j) => html`<option value="${j}" ${j === i ? "selected" : ""}>${done(x) ? "✓ " : ""}${x.name}</option>`)}</select>
        <button type="button" class="btn icon" id="q-next" aria-label="Next person" ${i >= guys.length - 1 ? "disabled" : ""}>${icon("right")}</button></div>
      <h3 class="step-title" id="q-name" tabindex="-1">${g.name} <small class="faint" style="font:400 14px var(--font)">${g.employee_id} · ${g.hub}</small></h3>
      <p style="margin:0 0 10px">${e ? badge("green", "Entered") : badge("amber", "Not entered yet")}</p>
      <form id="q-form" novalidate>
        <div class="field"><label for="q-biz">Business (Rs)</label><input class="input" id="q-biz" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${rupees(e?.business_amount)}"></div>
        <div class="field"><label for="q-set">Handed in (Rs)</label><input class="input" id="q-set" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${rupees(e?.settled_amount)}"></div>
        <p class="q-diff" id="q-diff" role="status"></p>
        <div class="field"><label for="q-adv">Advance taken (Rs), if any</label><input class="input" id="q-adv" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${e?.personal_minus ? rupees(e.personal_minus) : ""}"></div>
        <div class="field"><label for="q-note">Note, if any</label><input class="input" id="q-note" autocomplete="off" enterkeyhint="done" value="${e?.notes || ""}"></div>
        <div class="step-errors" id="q-err" role="alert" tabindex="-1" hidden></div>
        <div class="q-actions"><button type="button" class="btn" id="q-skip">Skip</button><button type="submit" class="btn primary" id="q-save">Save and next</button></div>
      </form></div>`.toString();
    const f = $("#q-form");
    const val = (id) => $(id).value.trim();
    const upd = () => { $("#q-diff").textContent = diffText(parseAmount(val("#q-biz")), parseAmount(val("#q-set"))); };
    f.addEventListener("input", upd); upd();
    // Enter moves down the form; on the last field it saves.
    [["#q-biz", "#q-set"], ["#q-set", "#q-adv"], ["#q-adv", "#q-note"]].forEach(([a, b]) => $(a).addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $(b).focus(); } }));
    $("#q-prev").onclick = () => { i--; draw(); };
    $("#q-next").onclick = () => { i++; draw(); };
    $("#q-sel").onchange = (ev) => { i = Number(ev.target.value); draw(); };
    $("#q-skip").onclick = () => { i++; draw(); };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const bad = [];
      const money0 = (id, label, required) => {
        const v = val(id);
        const n = parseAmount(v);
        if (v === "" && required) bad.push([id, `${label} is required`]);
        else if (v !== "" && (!isAmount(v) || n < 0)) bad.push([id, `${label} must be a number of 0 or more, for example 12,500 or 12500.50`]);
      };
      ["#q-biz", "#q-set", "#q-adv"].forEach((id) => $(id).removeAttribute("aria-invalid"));
      money0("#q-biz", "Business", true); money0("#q-set", "Handed in", true); money0("#q-adv", "Advance", false);
      const box = $("#q-err");
      if (bad.length) {
        bad.forEach(([id]) => $(id).setAttribute("aria-invalid", "true"));
        box.innerHTML = `${icon("alert")}<div><b>${bad.length === 1 ? "Please fix one answer" : `Please fix ${bad.length} answers`}</b><ul>${bad.map(([id, m]) => `<li><a href="${id}" data-fix="${id}">${m}</a></li>`).join("")}</ul></div>`;
        box.hidden = false;
        box.querySelectorAll("[data-fix]").forEach((a) => (a.onclick = (x) => { x.preventDefault(); $(a.dataset.fix).focus(); }));
        $(bad[0][0]).focus();
        return;
      }
      box.hidden = true;
      const row = { date, employee_id: g.employee_id, business_amount: parseAmount(val("#q-biz")), settled_amount: parseAmount(val("#q-set")), personal_minus: parseAmount(val("#q-adv")) || 0, notes: val("#q-note") };
      await busy($("#q-save"), async () => {
        await post("/api/daily/bulk", { rows: [row] });
        byEmp[g.employee_id] = { business_amount: Math.round(row.business_amount * 100), settled_amount: Math.round(row.settled_amount * 100), personal_minus: Math.round(row.personal_minus * 100), notes: row.notes };
        toast(`Saved ${g.name}`);
        const nextOpen = guys.findIndex((x, j) => j > i && !done(x));
        i = nextOpen >= 0 ? nextOpen : i + 1;
        draw();
      });
    };
    if (move) {
      announce(`Person ${i + 1} of ${guys.length}: ${g.name}`);
      $("#q-name").focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  };
  draw(false);
}
