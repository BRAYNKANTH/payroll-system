import { get, post, qs } from "../api.js";
import { state, can, scopeHub, setDirtyCheck } from "../app.js";
import { $, $$, html, esc, icon, money, toast, busy, confirmDialog, modal, dateLabel, emptyState, downloadCsv, parseCsv, fromCents, parseAmount, isAmount, formatAmount } from "../ui.js";
import { sheetKeys, moneyInputs, periodLocked, lockedBanner, readOnlyBanner, segButtons } from "./shared.js";
import { isPhone } from "../phone.js";
import { announce, badge } from "../ui.js";

// On a phone the daily sheet is entered one person at a time ("one by one"); the grid is still there for people who prefer it.
const viewPref = () => { try { return localStorage.getItem("pr.daily.view") || "quick"; } catch { return "quick"; } };
const setViewPref = (v) => { try { localStorage.setItem("pr.daily.view", v); } catch { /* private mode */ } };

const FIELDS = [
  { k: "business_amount", label: "Business" },
  { k: "settled_amount", label: "Settled" },
  { k: "personal_minus", label: "Personal minus" },
];

function daysIn(period) {
  const [y, m] = period.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`);
}

let mode = "day";
let currentDate = null;
let currentEmp = null;

export default {
  title: "Daily sheet",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, locked] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    const guys = staff.filter((s) => s.role === "guy" && s.status === "active");
    const editable = can("enter_data") && !locked;
    const days = daysIn(state.period);
    const today = new Date().toISOString().slice(0, 10);
    if (!currentDate || !currentDate.startsWith(state.period)) currentDate = days.includes(today) ? today : days[0];
    if (!currentEmp || !guys.some((g) => g.employee_id === currentEmp)) currentEmp = guys[0]?.employee_id;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Daily sheet</h1><p class="hide-sm">Business and settlements for distributors, supervisors and group managers. Settle-up minus is calculated automatically.</p></div>
        <div class="actions">
          <div class="seg"><button data-mode="day" class="${mode === "day" ? "on" : ""}">By day</button><button data-mode="emp" class="${mode === "emp" ? "on" : ""}">By employee</button></div>
          ${editable ? html`<button class="btn" id="import">${icon("upload")} <span class="lbl-sm">Import CSV</span></button>` : ""}
          <button class="btn" id="export">${icon("download")} <span class="lbl-sm">Export</span></button>
        </div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card">
        <div class="card-head" id="picker"></div>
        <div class="card-body flush" id="grid"></div>
      </div>`;

    $$("[data-mode]", el).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; this.render(ctx); }));
    $("#export").onclick = async () => {
      const rows = await get("/api/daily" + qs({ period: state.period, hub: scopeHub() }));
      const names = Object.fromEntries(staff.map((s) => [s.employee_id, s.name]));
      downloadCsv(`daily-${state.period}.csv`, ["date", "employee_id", "name", "business_amount", "settled_amount", "settle_up_minus", "personal_minus", "notes"],
        rows.map((r) => [r.date, r.employee_id, names[r.employee_id], fromCents(r.business_amount), fromCents(r.settled_amount), fromCents(r.settle_up_minus), fromCents(r.personal_minus), r.notes || ""]));
    };
    $("#import")?.addEventListener("click", () => importCsv(guys, () => this.render(ctx)));

    if (!guys.length) {
      $("#grid").innerHTML = emptyState("No active sales staff", "Add distributors and supervisors on the Employees page first.", "users",
        can("manage_staff") ? `<a class="btn primary" href="/employees" data-link>Go to employees</a>` : "").toString();
      return;
    }
    if (mode === "day") await dayMode(ctx, guys, days, editable);
    else await empMode(ctx, guys, days, editable);
  },
};

// ---------------------------------------------------------------- grid core

// rows: [{ key, label, sub, date, employee_id, existing, muted }]
function buildGrid({ rows, editable, firstCol, onSaved }) {
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
  grid.innerHTML = html`
    <div class="table-wrap" tabindex="-1"><table class="table sheet">
      <caption class="sr-only">Daily entries. Enter or arrow keys move between rows.</caption>
      <thead><tr><th scope="col">${firstCol}</th>${FIELDS.slice(0, 2).map((f) => html`<th scope="col" class="r">${f.label}</th>`)}<th scope="col" class="r">Settle-up minus</th>
        <th scope="col" class="r">${FIELDS[2].label}</th><th scope="col">Notes</th><th scope="col"><span class="sr-only">Status</span></th></tr></thead>
      <tbody>${rows.map((r, i) => html`
        <tr data-i="${i}" style="${r.muted ? "opacity:.6" : ""}">
          <th scope="row" class="name"><b>${r.label}</b><div class="faint text-sm fw-400">${r.sub}</div></th>
          ${FIELDS.slice(0, 2).map((f) => cell(f, r, r.existing ? amt(r.existing[f.k]) : ""))}
          <td class="calc" data-calc aria-live="off"></td>
          ${cell(FIELDS[2], r, r.existing && r.existing.personal_minus ? amt(r.existing.personal_minus) : "")}
          <td><input class="text" data-f="notes" value="${r.existing?.notes || ""}" ${editable ? "" : "disabled"} aria-label="Notes, ${r.label}"></td>
          <td>${r.existing?.updated_by ? html`<span class="badge plain" title="Edited by ${r.existing.updated_by}">edited</span>` : ""}</td>
        </tr>`)}</tbody>
      <tfoot><tr><th scope="row">Total</th><td class="r" data-t="business_amount"></td><td class="r" data-t="settled_amount"></td><td class="r" data-t="settle"></td><td class="r" data-t="personal_minus"></td><td colspan="2"></td></tr></tfoot>
    </table></div>
    <p class="scroll-hint">Swipe the table sideways to see all columns.</p>
    <div id="sheet-errors"></div>
    ${editable ? html`<div class="savebar">
      <span class="muted" id="dirty-info" role="status">No unsaved changes</span>
      <div class="row"><button type="button" class="btn" id="revert" disabled>Discard</button><button type="button" class="btn primary" id="save" disabled>${icon("check")} Save sheet</button></div></div>` : ""}`;

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
    $('[data-t="business_amount"]', grid).textContent = money(t.business_amount);
    $('[data-t="settled_amount"]', grid).textContent = money(t.settled_amount);
    $('[data-t="settle"]', grid).textContent = money(t.business_amount - t.settled_amount);
    $('[data-t="personal_minus"]', grid).textContent = money(t.personal_minus);
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
    if (problems.length) { $("tbody [aria-invalid=true]", grid)?.focus(); return; }
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
  buildGrid({
    firstCol: "Employee", editable,
    rows: guys.map((g) => ({ label: g.name, sub: `${g.employee_id} · ${g.hub}`, date: currentDate, employee_id: g.employee_id, existing: byEmp[g.employee_id] })),
    onSaved: () => dayMode(ctx, guys, days, editable),
  });
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
