// One date-range filter for every page that is about days: Today, Yesterday, This week, This month, Last month, or a custom From – To.
// The choice is remembered per page (so Hub stock can sit on Today while Live sales sits on This month).
// Dates are Sri Lanka dates, like the tills and the daily sheet.
import { html, $, icon } from "./ui.js";

const iso = (d) => d.toISOString().slice(0, 10);
export const today = () => iso(new Date(Date.now() + 5.5 * 3600e3));
export const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s) => s.slice(0, 7) + "-01";
const monthEnd = (s) => { const d = new Date(monthStart(s) + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };

export const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["lastmonth", "Last month"], ["custom", "Custom"]];

// The first and last day a preset stands for. A week runs Monday to today; this month runs from the 1st to today.
export function rangeOf(preset, custom = {}) {
  const t = today();
  switch (preset) {
    case "yesterday": { const y = addDays(t, -1); return { from: y, to: y }; }
    case "week": return { from: addDays(t, -((new Date(t + "T00:00:00Z").getUTCDay() + 6) % 7)), to: t };
    case "month": return { from: monthStart(t), to: t };
    case "lastmonth": { const p = addDays(monthStart(t), -1); return { from: monthStart(p), to: monthEnd(p) }; }
    case "custom": {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(custom.from || "") ? custom.from : t, to = /^\d{4}-\d{2}-\d{2}$/.test(custom.to || "") ? custom.to : t;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    default: return { from: t, to: t };
  }
}

const read = (page, fallback) => {
  try { const v = JSON.parse(localStorage.getItem("pr.range." + page) || "null"); if (v && PRESETS.some(([k]) => k === v.preset)) return v; } catch { /* nothing saved */ }
  return { preset: fallback };
};
const save = (page, v) => { try { localStorage.setItem("pr.range." + page, JSON.stringify(v)); } catch { /* private mode */ } };

// The current choice for a page: { preset, from, to } with real dates.
export function currentRange(page, fallback = "today") {
  const v = read(page, fallback);
  return { preset: v.preset, ...rangeOf(v.preset, v) };
}

// Does the range fall inside a single calendar month? (Pages that work by pay month use this.)
export const singleMonth = (r) => r.from.slice(0, 7) === r.to.slice(0, 7);

// The months a range touches, as YYYY-MM, oldest first.
export function monthsIn(r) {
  const out = []; let m = r.from.slice(0, 7);
  while (m <= r.to.slice(0, 7) && out.length < 14) { out.push(m); const d = new Date(m + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); m = iso(d).slice(0, 7); }
  return out;
}

const dayText = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const rangeText = (r) => (r.from === r.to ? dayText(r.from) : `${dayText(r.from)} – ${dayText(r.to)}`);

// Draws the filter into `host` and calls onChange({ preset, from, to }) whenever it changes.
export function mountRange(host, { page, fallback = "today", onChange }) {
  let cur = currentRange(page, fallback);
  const draw = () => {
    host.innerHTML = html`<div class="range-bar" role="group" aria-label="Date range">
      <div class="seg">${PRESETS.map(([k, l]) => html`<button type="button" data-p="${k}" class="${cur.preset === k ? "on" : ""}" aria-pressed="${cur.preset === k}">${l}</button>`)}</div>
      ${cur.preset === "custom" ? html`<div class="range-custom">
        <label>From <input type="date" class="input" id="rg-from" value="${cur.from}" max="${today()}"></label>
        <label>To <input type="date" class="input" id="rg-to" value="${cur.to}" max="${today()}"></label></div>` : ""}
      <span class="range-text">${icon("calendar")} ${rangeText(cur)}</span></div>`.toString();
  };
  const set = (preset, custom) => { cur = { preset, ...rangeOf(preset, custom) }; save(page, { preset, from: cur.from, to: cur.to }); draw(); onChange(cur); };
  host.addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) set(b.dataset.p, cur); });
  host.addEventListener("change", (e) => {
    if (e.target.id !== "rg-from" && e.target.id !== "rg-to") return;
    let from = $("#rg-from", host).value, to = $("#rg-to", host).value;
    // Choosing a start after the end moves the end along (and the other way round), instead of swapping them behind the person's back.
    if (from && to && from > to) { if (e.target.id === "rg-from") to = from; else from = to; }
    set("custom", { from, to });
  });
  draw();
  return { get: () => cur };
}
