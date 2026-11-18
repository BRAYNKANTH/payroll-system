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
  if (v >= 1e5) return Math.round(v / 1e3) >= 1000 ? sign + (v / 1e6).toFixed(2) + "M" : sign + Math.round(v / 1e3) + "K"; // 999,950 is 1.00M, not 1000K
  if (v >= 1e3) return sign + (Math.round(v / 100) >= 1000 ? "100" : (v / 1e3).toFixed(1)) + "K";
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
export const roleLabel = (r) => (r === "guy" ? "Distributor / Supervisor" : r === "manager" ? "Manager" : titleCase(r));
// Chain of command, lowest to highest. Rank decides who may report to whom.
// Distributor and supervisor are the same level; a manager is above them, a promoting manager above a manager, a coacher above all.
export const LEVELS = [["distributor", "Distributor"], ["supervisor", "Supervisor"], ["manager", "Manager"],
  ["promoting_manager", "Promoting manager"], ["coacher", "Coacher"]]; // see LEVEL_RANK in service.js
// Manager, promoting manager and coacher draw a fixed monthly salary plus a share of sales (only a manager holds a weekly account).
export const MANAGER_LEVELS = ["manager", "promoting_manager", "coacher"];
export const isManagerLevel = (l) => MANAGER_LEVELS.includes(l);
// Used for a position until its own pay defaults are saved in Settings.
const TIERED = { pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25, food_per_day: 150, security_deduction_rule: "pct_business:1" };
export const POSITION_FALLBACK = {
  distributor: { ...TIERED, target: 100000, basic_pay: 25000, food_min_days: 0 },
  supervisor: { ...TIERED, target: 120000, basic_pay: 30000, food_min_days: 24 },
  manager: { basic_pay: 27000, target: 100000 }, promoting_manager: { basic_pay: 29000 }, coacher: { basic_pay: 30000 },
};
export function positionDefaults(settings) {
  let saved = {};
  try { saved = JSON.parse(settings.position_defaults || "{}"); } catch { /* none set */ }
  // Per position, so a saved row that leaves a field out keeps the fallback for that field.
  return Object.fromEntries(Object.keys({ ...POSITION_FALLBACK, ...saved }).map((k) => [k, { ...POSITION_FALLBACK[k], ...saved[k] }]));
}
// Same ranks as LEVEL_RANK in service.js: distributor and supervisor are one level.
const RANK = { distributor: 0, supervisor: 0, manager: 1, promoting_manager: 2, coacher: 3 };
export const levelRank = (l) => RANK[l] ?? -1;
// levelLabel("supervisor") → "Supervisor"; with a count other than 1 → "Supervisors".
const LEVEL_PLURAL = { distributor: "Distributors" };
export const levelLabel = (l, count = 1) => {
  const one = LEVELS.find(([k]) => k === l)?.[1] || titleCase(l);
  return count === 1 ? one : LEVEL_PLURAL[l] || one + "s";
};

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
  minus: '<path d="M5 12h14"/>',
  bag: '<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
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
  warehouse: '<path d="M3 21V9l9-5 9 5v12"/><path d="M7 21v-6h10v6M7 11h10"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><path d="M7.5 7.5h.01"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/>',
};
export const icon = (name, cls = "") => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`);

// ---- haptics: a light buzz on phones that allow it; people can turn it off on My account
export const hapticsOn = () => { try { return localStorage.getItem("pr.haptics") !== "off"; } catch { return true; } };
export const setHaptics = (on) => { try { localStorage.setItem("pr.haptics", on ? "on" : "off"); } catch { /* private mode */ } };
export const buzz = (ms = 8) => { if (hapticsOn()) { try { navigator.vibrate?.(ms); } catch { /* not supported */ } } };

// ---- live regions & toasts
// Screen readers only announce changes to live regions that already exist, so both are created up front.
// The app shell replaces the whole <body> after sign-in, which removes them; this puts them back whenever they are missing.
const live = {};
export function ensureLive() {
  if (live.polite && document.body.contains(live.polite) && document.body.contains(live.assertive) && document.body.contains(live.box)) return;
  for (const k of ["polite", "assertive", "box"]) { live[k]?.remove(); delete live[k]; }
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
  document.documentElement.classList.toggle("modal-open", on); // the page behind a form must not scroll
  document.querySelectorAll("body > *:not(.overlay):not(.drawer):not(.modal):not(.toasts):not(.sr-only):not(.chart-tip)").forEach((el) => (el.inert = on));
  // Only the top layer stays interactive.
  layers.forEach((l, i) => { l.panel.inert = on && i < layers.length - 1; l.ov.inert = on && i < layers.length - 1; });
}
document.addEventListener("keydown", (e) => {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); top.dismiss(); return; }
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
  // Closing by hand (X, Cancel, Escape, tapping outside) asks first if the person has typed into a form here, so a long form is never lost by accident.
  // Closing from code after a save (close()) never asks.
  layer.dirty = false;
  let asking = false;
  layer.dismiss = async () => {
    if (layer.dirty && !asking) {
      asking = true;
      const ok = await confirmDialog({ title: "Discard what you typed?", message: "You started filling this in. If you close it now, what you typed will be lost.", confirmText: "Discard", danger: true });
      asking = false;
      if (!ok) return;
    }
    close();
  };
  panel.addEventListener("input", (e) => { if (e.target.closest?.("form")) layer.dirty = true; });
  panel.addEventListener("change", (e) => { if (e.target.closest?.("form")) layer.dirty = true; });
  layers.push(layer);
  setBackgroundInert(true);
  ov.addEventListener("click", () => layer.dismiss());
  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => (/^(done|close)$/i.test(b.textContent.trim()) ? close() : layer.dismiss())));
  linkLabels(panel);
  setTimeout(() => {
    // On a touch screen, focusing a field would open the keyboard over the form; focus the dialog itself instead.
    if (matchMedia("(pointer: coarse)").matches) { panel.tabIndex = -1; panel.focus({ preventScroll: true }); return; }
    (panel.querySelector("input:not([disabled]),select:not([disabled]),textarea,button.primary") || panel.querySelector(FOCUSABLE))?.focus();
  }, 30);
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
// Filters live in the address (?q=…&status=…), so Back, bookmarks and shared links show the same view.
export function readQuery(obj) { const sp = new URLSearchParams(location.search); for (const k of Object.keys(obj)) if (sp.has(k)) obj[k] = sp.get(k); return obj; }
export function writeQuery(obj, defaults = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== (defaults[k] ?? "")) sp.set(k, v);
  const s = sp.toString();
  history.replaceState(history.state, "", location.pathname + (s ? "?" + s : ""));
}
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
  markRequired(root);
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
export function dataTable({ cols, rows, onRow, rowLabel = () => "Open", rowAction = "Open", empty = "Nothing here yet", emptyHint = "", sortable = true, footer = false, cls = "", rowAttr, caption = "", pageSize = 100, card, summary, groupBy, groupLabel }) {
  const id = "t" + Math.random().toString(36).slice(2, 8);
  if (!rows.length) return raw(`<div class="empty"><div class="ico">${icon("sheet")}</div><h4>${esc(empty)}</h4>${emptyHint ? `<p class="empty-hint">${esc(emptyHint)}</p>` : ""}</div>`);
  // On a phone a list of cards is easier to read and tap than a wide table. Each card is one button, so the whole row works as one control.
  // A table with more than four columns and no card of its own becomes cards too: the first column is the title, the rest are label and value pairs.
  const labelled = cols.filter((c) => c.label);
  if (!card && labelled.length > 4 && matchMedia("(max-width: 860px)").matches) {
    card = (r) => `<span class="mc-main"><b>${cols[0].render ? cols[0].render(r) : esc(r[cols[0].key])}</b>${labelled.slice(1).map((c) =>
      `<span class="mc-kv"><span class="k">${esc(c.label)}</span><span class="v">${c.render ? c.render(r) : esc(r[c.key])}</span></span>`).join("")}</span>`;
  }
  if (card && matchMedia("(max-width: 860px)").matches) {
    let shownCards = Math.min(rows.length, pageSize);
    // With groupBy, a heading is drawn above the first row of each group (rows must already be in group order).
    const cardsHtml = (from, to) => rows.slice(from, to).map((r, i) => (groupBy && (from + i === 0 || groupBy(rows[from + i - 1]) !== groupBy(r))
      ? `<li class="m-group"><span>${groupLabel(groupBy(r), rows.filter((x) => groupBy(x) === groupBy(r)))}</span></li>` : "") + cardHtml(r, from + i)).join("");
    const cardHtml = (r, ri) => `<li>${onRow ? `<button type="button" class="m-card" data-i="${ri}">${card(r)}<span class="chev" aria-hidden="true"></span></button>` : `<div class="m-card">${card(r)}</div>`}</li>`;
    const bar = () => (rows.length > shownCards ? `<div class="more-rows"><span class="muted" role="status">Showing ${shownCards} of ${rows.length}</span><button type="button" class="btn" data-more>Show ${Math.min(pageSize, rows.length - shownCards)} more</button></div>` : "");
    queueMicrotask(() => {
      const box = document.getElementById(id);
      if (!box) return;
      const ul = box.querySelector("ul");
      const bind = () => { const b = box.nextElementSibling; if (b?.matches(".more-rows")) b.querySelector("[data-more]").onclick = more; };
      const more = () => {
        const next = Math.min(rows.length, shownCards + pageSize);
        ul.insertAdjacentHTML("beforeend", cardsHtml(shownCards, next));
        shownCards = next;
        if (box.nextElementSibling?.matches(".more-rows")) box.nextElementSibling.remove();
        if (rows.length > shownCards) box.insertAdjacentHTML("afterend", bar());
        bind();
      };
      bind();
      if (onRow) ul.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) onRow(rows[b.dataset.i]); });
    });
    return raw(`<div class="m-list" id="${id}" role="region" aria-label="${esc(caption || "List")}">${summary ? `<p class="m-summary" role="status">${summary(rows)}</p>` : ""}<ul role="list">${cardsHtml(0, shownCards)}</ul></div>${bar()}`);
  }
  const sortableCol = (c) => sortable && c.sort !== false && c.label;
  const head = cols.map((c, i) => sortableCol(c)
    ? `<th class="${c.align || ""}" scope="col" aria-sort="none" data-col="${i}"><button type="button" class="th-sort">${esc(c.label)}<span class="sort-ind" aria-hidden="true"></span></button></th>`
    : `<th class="${c.align || ""}" scope="col">${c.label ? esc(c.label) : `<span class="sr-only">${onRow ? "" : "Actions"}</span>`}</th>`).join("")
    + (onRow ? `<th scope="col"><span class="sr-only">Actions</span></th>` : "");
  const rowHtml = (r, ri) => `<tr data-i="${ri}" class="${onRow ? "clickable" : ""}" ${rowAttr ? rowAttr(r) : ""}>${cols.map((c) => `<td class="${c.align || ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}${onRow ? `<td class="r row-act"><button type="button" class="btn sm ghost" data-row-open aria-label="${esc(rowLabel(r))}">${esc(rowAction)} ${icon("right")}</button></td>` : ""}</tr>`;
  // A long list draws its first rows at once and the rest on request, so the page appears quickly and stays light.
  let shown = Math.min(rows.length, pageSize);
  const span = cols.length + (onRow ? 1 : 0);
  // With groupBy, a heading row is drawn above the first row of each group (rows must already be in group order).
  const rowsHtml = (from, to) => rows.slice(from, to).map((r, i) => (groupBy && (from + i === 0 || groupBy(rows[from + i - 1]) !== groupBy(r))
    ? `<tr class="group-row"><th scope="rowgroup" colspan="${span}">${groupLabel(groupBy(r), rows.filter((x) => groupBy(x) === groupBy(r)))}</th></tr>` : "") + rowHtml(r, from + i)).join("");
  const body = rowsHtml(0, shown);
  const moreBar = () => (rows.length > shown ? `<div class="more-rows"><span class="muted" role="status">Showing ${shown} of ${rows.length}</span><button type="button" class="btn" data-more>Show ${Math.min(pageSize, rows.length - shown)} more</button></div>` : "");
  const foot = footer ? `<tfoot><tr>${cols.map((c, i) => `<td class="${c.align || ""}">${c.total ? c.total(rows) : i === 0 ? "Total" : ""}</td>`).join("")}${onRow ? "<td></td>" : ""}</tr></tfoot>` : "";
  queueMicrotask(() => {
    const t = document.getElementById(id);
    if (!t) return;
    const tb = t.querySelector("tbody");
    const wrap = t.closest(".table-wrap");
    const drawMore = (n) => {
      const next = Math.min(rows.length, shown + n);
      tb.insertAdjacentHTML("beforeend", rowsHtml(shown, next));
      shown = next;
      if (wrap.nextElementSibling?.matches(".more-rows")) wrap.nextElementSibling.remove();
      if (rows.length > shown) wrap.insertAdjacentHTML("afterend", moreBar());
      bindMore();
    };
    const bindMore = () => { const bar = wrap.nextElementSibling; if (bar?.matches(".more-rows")) bar.querySelector("[data-more]").onclick = () => drawMore(pageSize); };
    bindMore();
    if (onRow) tb.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (tr && (e.target.closest("[data-row-open]") || !e.target.closest("button,a,input,select"))) onRow(rows[tr.dataset.i]);
    });
    if (sortable) {
      t.querySelectorAll("th[data-col] .th-sort").forEach((btn) => btn.addEventListener("click", () => {
        const th = btn.parentElement;
        const c = cols[th.dataset.col];
        const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
        t.querySelectorAll("th[aria-sort]").forEach((x) => x.setAttribute("aria-sort", "none"));
        th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
        const val = c.sort || ((r) => r[c.key]);
        if (shown < rows.length) drawMore(rows.length); // sorting has to see every row, not just the ones on screen
        const cmp = (a, b) => {
          const x = val(rows[a.dataset.i]), y = val(rows[b.dataset.i]);
          return (x > y ? 1 : x < y ? -1 : 0) * dir;
        };
        if (groupBy) { // sort inside each group and keep the groups in their order
          const blocks = [];
          [...tb.children].forEach((tr) => { if (tr.classList.contains("group-row")) blocks.push({ head: tr, trs: [] }); else blocks[blocks.length - 1].trs.push(tr); });
          blocks.forEach((b) => { tb.append(b.head); b.trs.sort(cmp).forEach((tr) => tb.append(tr)); });
        } else [...tb.rows].sort(cmp).forEach((tr) => tb.append(tr));
        announce(`Sorted by ${c.label}, ${dir === 1 ? "ascending" : "descending"}`);
      }));
    }
  });
  return raw(`<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption || "Table")}"><table class="table ${cls}" id="${id}">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>${moreBar()}`);
}

export const emptyState = (title, text = "", ico = "sheet", action = "") =>
  raw(`<div class="empty"><div class="ico">${icon(ico)}</div><p class="empty-title">${esc(title)}</p>${text ? `<p style="margin:0 0 14px">${esc(text)}</p>` : ""}${action}</div>`);

// ---- Excel and PDF
// A page puts exportButtons("daily", { period, hub }) in its header; the click handler below downloads /api/export/daily.xlsx (or .pdf).
export const exportButtons = (report, params = {}) => html`<span class="row" style="gap:8px;flex-wrap:nowrap">
  <button type="button" class="btn" data-export="${report}:xlsx" data-params="${JSON.stringify(params)}">${icon("download")} <span class="lbl-sm">Excel</span></button>
  <button type="button" class="btn" data-export="${report}:pdf" data-params="${JSON.stringify(params)}">${icon("file")} <span class="lbl-sm">PDF</span></button></span>`;
export async function downloadReport(report, format, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  const res = await fetch(`/api/export/${report}.${format}${query ? "?" + query : ""}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "The download failed");
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `${report}.${format}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-export]");
  if (!b) return;
  const [report, format] = b.dataset.export.split(":");
  let params = {};
  try { params = JSON.parse(b.dataset.params || "{}"); } catch { /* none */ }
  busy(b, () => downloadReport(report, format, params));
});

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

// Marks every required field with a visible asterisk and tells assistive technology it is required.
// "* means the field is required" is added once at the top of the form. The sign-in form is left alone: every field there is needed.
export function markRequired(root) {
  if (!root || !root.querySelectorAll) return;
  let note = null;
  root.querySelectorAll("input[required], select[required], textarea[required]").forEach((f) => {
    const form = f.closest("form");
    if (form && form.id === "auth-form") return;
    f.setAttribute("aria-required", "true");
    const label = (f.labels && f.labels[0]) || (f.id && root.querySelector(`label[for="${f.id}"]`));
    if (!label) return;
    if (!label.querySelector(".req")) label.insertAdjacentHTML("beforeend", ' <span class="req" aria-hidden="true">*</span>');
    if (form && !form.querySelector(".req-note")) form.insertAdjacentHTML("afterbegin", '<p class="req-note muted full">* means the field is required</p>');
  });
}
