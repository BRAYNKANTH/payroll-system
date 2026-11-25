// Motion switch and number count-up.
//
// All the animation in the app (page slides, cards rising in, glows, count-up) is switched on by one class on <html>: "fx".
// It is on automatically, and off when the device asks for less motion (reduced-motion), is short of memory, or is on a data-saver
// connection. A person can also choose On or Off on My account. With "fx" off the pages simply appear: nothing else changes.
const KEY = "pr.fx"; // "on", "off", or nothing saved = automatic
const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");

const weakDevice = () => !!(navigator.connection?.saveData || (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2));
export const fxMode = () => { try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; } };
export const fxActive = () => { const m = fxMode(); return m === "off" ? false : m === "on" ? true : !(reduce?.matches) && !weakDevice(); };
export function applyFx() {
  const on = fxActive();
  document.documentElement.classList.toggle("fx", on);
  document.documentElement.classList.toggle("lite", !on); // lite also drops the glass blur, the costliest effect on a small phone
}
export function setFx(mode) { try { if (mode === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch { /* private mode */ } applyFx(); }
applyFx();
reduce?.addEventListener?.("change", applyFx);

// ---- count-up: the big numbers on cards run up from zero to their value, keeping their own format (commas, decimals, K/M suffix)
const SELECTOR = ".kpi .value, .stat .s-value, .hub-nums b, .dstat b, .hero .h-amount, .mc-right dd, .kpi-n";
const seen = new WeakSet();

function countUp(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, target = null;
  while ((node = walker.nextNode())) if (/\d/.test(node.nodeValue)) target = node; // the last piece of text with a number (the "Rs" is a separate <small>)
  if (!target) return;
  const m = /(-?\d[\d,]*)(\.\d+)?/.exec(target.nodeValue);
  if (!m) return;
  const to = parseFloat((m[1] + (m[2] || "")).replace(/,/g, ""));
  if (!Number.isFinite(to) || Math.abs(to) < 10) return; // tiny numbers just appear
  const dec = m[2] ? m[2].length - 1 : 0, group = m[1].includes(",");
  const before = target.nodeValue.slice(0, m.index), after = target.nodeValue.slice(m.index + m[0].length), final = target.nodeValue;
  const fmt = (v) => { const [i, d] = Math.abs(v).toFixed(dec).split("."); return (v < 0 ? "-" : "") + (group ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : i) + (d ? "." + d : ""); };
  const t0 = performance.now(), DURATION = 750;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / DURATION), eased = 1 - Math.pow(1 - p, 3);
    target.nodeValue = p < 1 ? before + fmt(to * eased) + after : final; // the last frame puts the exact original text back
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let watcher = null;
// Call after a page has been drawn: counts up what is on screen now, and anything drawn into the page in the next moments.
export function fxEnhance(view) {
  watcher?.disconnect();
  if (!document.documentElement.classList.contains("fx") || !view) return;
  const scan = (root) => { let n = 0; for (const el of root.matches?.(SELECTOR) ? [root] : root.querySelectorAll?.(SELECTOR) || []) { if (seen.has(el) || n++ > 24) continue; seen.add(el); countUp(el); } };
  scan(view);
  // Pages that draw their numbers a moment later (after a date filter changes) are covered for a few seconds.
  let pending = [];
  watcher = new MutationObserver((list) => {
    const had = pending.length;
    for (const mu of list) for (const a of mu.addedNodes) if (a.nodeType === 1 && !a.matches("tr, td, th, tbody, li, option, input")) pending.push(a); // table rows are never numbers to count
    if (had || !pending.length) return; // a scan is already queued
    requestAnimationFrame(() => { const batch = pending; pending = []; batch.slice(0, 20).forEach(scan); });
  });
  watcher.observe(view, { childList: true, subtree: true });
  setTimeout(() => watcher?.disconnect(), 120000);
}
