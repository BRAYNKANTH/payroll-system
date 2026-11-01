// Shared UI helpers: escaping, formatting, icons, toasts, modals, drawers, tables, CSV.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// Tagged template that escapes interpolations unless wrapped with raw().
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("");
    else if (v instanceof Raw) out += v.s;
    else if (v === false || v == null) out += "";
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

// ---- formatting (money arrives from the API in cents)
const nf2 = new Intl.NumberFormat("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("en-LK", { maximumFractionDigits: 0 });
export const money = (c) => (c == null ? "—" : nf2.format(c / 100));
export const moneyHtml = (c) => raw(`<span class="num ${c < 0 ? "neg" : ""}">${money(c)}</span>`);
export const rs = (c) => (c == null ? "—" : "Rs " + nf2.format(c / 100));
export function compact(c) {
  const v = Math.abs(c / 100);
  const sign = c < 0 ? "-" : "";
  if (v >= 1e7) return sign + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e6) return sign + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e5) return sign + (v / 1e3).toFixed(0) + "K";
  if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + "K";
  return sign + nf0.format(v);
}
export const pct = (f, d = 1) => (f == null || !isFinite(f) ? "—" : (f * 100).toFixed(d) + "%");
export const monthName = (p) => {
  if (!p) return "";
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};
export const shortMonth = (p) => { const [y, m] = p.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" }); };
export const dateLabel = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const ago = (iso) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
};
export const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
export const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const statusLabel = (s) => ({ auto_approved: "Auto-approved", pending_review: "Needs review", approved: "Approved", rejected: "Rejected", finalized: "Finalized", open: "Open" }[s] || titleCase(s));
export const badge = (s, label) => html`<span class="badge ${s}">${label || statusLabel(s)}</span>`;
export const roleLabel = (r) => (r === "guy" ? "Guy / Supervisor" : r === "manager" ? "Manager" : titleCase(r));
// Chain of command, lowest to highest. Rank decides who may report to whom.
export const LEVELS = [["distributor", "Distributor / Guy"], ["supervisor", "Supervisor"], ["group_manager", "Group manager"], ["manager", "Manager"]];
export const levelRank = (l) => LEVELS.findIndex(([k]) => k === l);
export const levelLabel = (l) => LEVELS.find(([k]) => k === l)?.[1] || titleCase(l);

// ---- icons (Lucide-style, stroke based)
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.9 4.5 4.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  store: '<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9Z"/><path d="M5 13v8h14v-8M10 21v-5h4v5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2 2M15 8l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 14h.01"/>',
  bank: '<path d="m3 10 9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  coins: '<circle cx="8" cy="8" r="5"/><path d="M18.1 10.4A5 5 0 1 1 10.4 18M7 6h1v4M16.7 13.9l.7.7-2.8 2.8"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/>',
};
export const icon = (name, cls = "") => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`);

// ---- live regions & toasts
// Screen readers only announce changes to live regions that already exist, so both are created up front.
const live = {};
function ensureLive() {
  if (live.polite) return;
  for (const [k, attrs] of [["polite", 'aria-live="polite" role="status"'], ["assertive", 'aria-live="assertive" role="alert"']]) {
    const el = document.createElement("div");
    el.className = "sr-only";
    el.id = `live-${k}`;
    el.setAttribute("aria-atomic", "true");
    attrs.split(" ").forEach((a) => { const [n, v] = a.split("="); el.setAttribute(n, v.replace(/"/g, "")); });
    document.body.append(el);
    live[k] = el;
  }
  const box = document.createElement("div");
  box.className = "toasts";
  document.body.append(box);
  live.box = box;
}
// Announce text to assistive technology without showing anything.
export function announce(msg, urgent = false) {
  ensureLive();
  const el = urgent ? live.assertive : live.polite;
  el.textContent = "";
  setTimeout(() => (el.textContent = msg), 60);
}
if (document.readyState !== "loading") ensureLive(); else document.addEventListener("DOMContentLoaded", ensureLive);

// Success messages fade after a few seconds; errors and warnings stay until dismissed.
export function toast(msg, kind = "ok") {
  ensureLive();
  if (!document.body.contains(live.box)) { live.polite.remove(); live.assertive.remove(); Object.keys(live).forEach((k) => delete live[k]); ensureLive(); }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "ok" ? "checkCircle" : "alert")}<div class="toast-msg">${esc(msg)}</div>
    <button class="toast-x" type="button" aria-label="Dismiss message">${icon("x")}</button>`;
  el.querySelector(".toast-x").onclick = () => el.remove();
  live.box.append(el);
  announce(msg, kind === "err");
  if (kind === "ok") setTimeout(() => el.remove(), 4000);
}

// ---- overlays (drawers and modals)
// A stack so Escape closes only the top layer, Tab stays inside it, and the page behind is inert.
const layers = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])';
let uid = 0;
function setBackgroundInert(on) {
  document.querySelectorAll("body > *:not(.overlay):not(.drawer):not(.modal):not(.toasts):not(.sr-only):not(.chart-tip)").forEach((el) => (el.inert = on));
  // Only the top layer stays interactive.
  layers.forEach((l, i) => { l.panel.inert = on && i < layers.length - 1; l.ov.inert = on && i < layers.length - 1; });
}
document.addEventListener("keydown", (e) => {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); top.close(); return; }
  if (e.key !== "Tab") return;
  const items = [...top.panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el.tagName === "IFRAME");
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (!top.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);

function overlayShell(cls, title, inner, { onClose } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  const panel = document.createElement("div");
  const titleId = `dlg-title-${++uid}`;
  panel.className = cls;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", titleId);
  panel.innerHTML = inner.replace("%TITLE_ID%", titleId);
  document.body.append(ov, panel);
  const prevFocus = document.activeElement;
  let closed = false;
  const layer = { panel, ov };
  const close = () => {
    if (closed) return;
    closed = true;
    ov.remove(); panel.remove();
    layers.splice(layers.indexOf(layer), 1);
    setBackgroundInert(layers.length > 0);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    onClose?.();
  };
  layer.close = close;
  layers.push(layer);
  setBackgroundInert(true);
  ov.addEventListener("click", close);
  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  linkLabels(panel);
  setTimeout(() => (panel.querySelector("input:not([disabled]),select:not([disabled]),textarea,button.primary") || panel.querySelector(FOCUSABLE))?.focus(), 30);
  return { panel, close };
}

export function drawer({ title, body, foot = "", onClose }) {
  return overlayShell("drawer", title, `
    <div class="drawer-head"><h3 id="%TITLE_ID%">${esc(title)}</h3><button class="btn ghost icon" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="drawer-body">${body}</div>${foot ? `<div class="drawer-foot">${foot}</div>` : ""}`, { onClose });
}

export function modal({ title, body, foot = "", wide = false, onClose }) {
  return overlayShell(`modal${wide ? " wide" : ""}`, title, `
    <div class="modal-head"><h3 id="%TITLE_ID%">${esc(title)}</h3><button class="btn ghost icon" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`, { onClose });
}

// ---- form labels
// Pages write `<div class="field"><label>Name</label><input …></div>`; this links each label to its
// control (for/id) so screen readers announce it and clicking the label focuses the field.
export function linkLabels(root = document) {
  root.querySelectorAll(".field").forEach((f) => {
    const label = f.querySelector(":scope > label");
    if (!label || label.htmlFor || label.querySelector("input,select,textarea")) return;
    const ctrl = f.querySelector(":scope > input, :scope > select, :scope > textarea, :scope > .search > input");
    if (!ctrl) return;
    if (!ctrl.id) ctrl.id = `fld-${++uid}`;
    label.htmlFor = ctrl.id;
    const hint = f.querySelector(":scope > .hint");
    if (hint) { if (!hint.id) hint.id = `hint-${uid}`; ctrl.setAttribute("aria-describedby", hint.id); }
  });
  root.querySelectorAll(".field > .lbl").forEach((lbl) => {
    const group = lbl.parentElement;
    if (group.getAttribute("role")) return;
    if (!lbl.id) lbl.id = `grp-${++uid}`;
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", lbl.id);
  });
}
// Keep labels linked as pages render.
new MutationObserver((muts) => {
  for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1 && (n.matches?.(".field") || n.querySelector?.(".field"))) linkLabels(n.parentElement || n); });
}).observe(document.documentElement, { childList: true, subtree: true });

// Promise-based confirm / prompt dialogs.
export function confirmDialog({ title, message, confirmText = "Confirm", danger = false, input = null }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p style="margin:0 0 ${input ? 14 : 0}px;color:var(--text-2)">${message}</p>${input ? `
        <div class="field"><label for="dlg-in">${esc(input.label)}</label>
        <textarea class="input" id="dlg-in" rows="3" placeholder="${esc(input.placeholder || "")}"></textarea></div>` : ""}`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="dlg-ok">${esc(confirmText)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const ok = m.panel.querySelector("#dlg-ok");
    ok.addEventListener("click", () => {
      const val = input ? m.panel.querySelector("#dlg-in").value.trim() : true;
      if (input?.required && !val) { m.panel.querySelector("#dlg-in").focus(); toast(`${input.label} is required`, "warn"); return; }
      done = true; m.close(); resolve(val === "" ? "" : val);
    });
  });
}

// ---- tables
// cols: [{ key, label, align: 'r'|'c', render(row) -> html/raw, sort(row) -> value | false, total(rows) -> html }]
// onRow: makes rows clickable for mouse users AND adds a real button per row (rowLabel names it) so the
// same action works from the keyboard and for screen readers.
export function dataTable({ cols, rows, onRow, rowLabel = () => "Open", rowAction = "Open", empty = "Nothing here yet", sortable = true, footer = false, cls = "", rowAttr, caption = "" }) {
  const id = "t" + Math.random().toString(36).slice(2, 8);
  if (!rows.length) return raw(`<div class="empty"><div class="ico">${icon("sheet")}</div><h4>${esc(empty)}</h4></div>`);
  const sortableCol = (c) => sortable && c.sort !== false && c.label;
  const head = cols.map((c, i) => sortableCol(c)
    ? `<th class="${c.align || ""}" scope="col" aria-sort="none" data-col="${i}"><button type="button" class="th-sort">${esc(c.label)}<span class="sort-ind" aria-hidden="true"></span></button></th>`
    : `<th class="${c.align || ""}" scope="col">${c.label ? esc(c.label) : `<span class="sr-only">${onRow ? "" : "Actions"}</span>`}</th>`).join("")
    + (onRow ? `<th scope="col"><span class="sr-only">Actions</span></th>` : "");
  const body = rows.map((r, ri) => `<tr data-i="${ri}" class="${onRow ? "clickable" : ""}" ${rowAttr ? rowAttr(r) : ""}>${cols.map((c) => `<td class="${c.align || ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}${onRow ? `<td class="r row-act"><button type="button" class="btn sm ghost" data-row-open aria-label="${esc(rowLabel(r))}">${esc(rowAction)} ${icon("right")}</button></td>` : ""}</tr>`).join("");
  const foot = footer ? `<tfoot><tr>${cols.map((c, i) => `<td class="${c.align || ""}">${c.total ? c.total(rows) : i === 0 ? "Total" : ""}</td>`).join("")}${onRow ? "<td></td>" : ""}</tr></tfoot>` : "";
  queueMicrotask(() => {
    const t = document.getElementById(id);
    if (!t) return;
    if (onRow) t.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-row-open]") || !e.target.closest("button,a,input,select")) onRow(rows[tr.dataset.i]);
    }));
    if (sortable) {
      t.querySelectorAll("th[data-col] .th-sort").forEach((btn) => btn.addEventListener("click", () => {
        const th = btn.parentElement;
        const c = cols[th.dataset.col];
        const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
        t.querySelectorAll("th[aria-sort]").forEach((x) => x.setAttribute("aria-sort", "none"));
        th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
        const val = c.sort || ((r) => r[c.key]);
        const tb = t.querySelector("tbody");
        [...tb.rows].sort((a, b) => {
          const x = val(rows[a.dataset.i]), y = val(rows[b.dataset.i]);
          return (x > y ? 1 : x < y ? -1 : 0) * dir;
        }).forEach((tr) => tb.append(tr));
        announce(`Sorted by ${c.label}, ${dir === 1 ? "ascending" : "descending"}`);
      }));
    }
  });
  return raw(`<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption || "Table")}"><table class="table ${cls}" id="${id}">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`);
}

export const emptyState = (title, text = "", ico = "sheet", action = "") =>
  raw(`<div class="empty"><div class="ico">${icon(ico)}</div><h4>${esc(title)}</h4>${text ? `<p style="margin:0 0 14px">${esc(text)}</p>` : ""}${action}</div>`);

// ---- CSV
export function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// Button spinner wrapper: disables the button while the promise runs, reports errors as toasts.
// The button is really disabled (not just styled) so a second Enter/click can't submit twice.
export async function busy(btn, fn) {
  if (btn?.disabled) return;
  if (btn) { btn.classList.add("loading"); btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try { return await fn(); }
  catch (e) { toast(e.message, "err"); }
  finally { if (btn && btn.isConnected) { btn.classList.remove("loading"); btn.disabled = false; btn.removeAttribute("aria-busy"); } }
}

// Amounts typed into sheets may contain thousands separators ("14,751.00").
export const parseAmount = (v) => (String(v ?? "").trim() === "" ? null : Number(String(v).replace(/,/g, "").trim()));
export const isAmount = (v) => { const n = parseAmount(v); return n === null || Number.isFinite(n); };
export const formatAmount = (v) => { const n = parseAmount(v); return n === null || !Number.isFinite(n) ? String(v ?? "") : nf2.format(n); };

export const toCents = (v) => (v === "" || v == null ? null : Math.round(Number(v) * 100));
export const fromCents = (c) => (c == null ? "" : String(c / 100));
