// Helpers shared by several pages.
import { get } from "../api.js";
import { html, icon, monthName, parseAmount, formatAmount } from "../ui.js";

// Spreadsheet keyboard navigation: Enter / ↓ moves down, ↑ moves up, in the same column.
export function sheetKeys(root) {
  root.addEventListener("keydown", (e) => {
    const input = e.target.closest("input[data-f]");
    if (!input || !["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const tr = input.closest("tr");
    const next = e.key === "ArrowUp" ? tr.previousElementSibling : tr.nextElementSibling;
    const target = next?.querySelector(`input[data-f="${input.dataset.f}"]`);
    if (target) { e.preventDefault(); target.focus(); target.select(); }
  });
  root.addEventListener("focusin", (e) => {
    if (!e.target.matches("input[data-f]")) return;
    e.target.setAttribute("enterkeyhint", "next"); // Enter moves down the column, so the key should say Next
    e.target.select();
  });
}

let periodsCache = { at: 0, rows: [] };
export async function periodInfo(period, fresh = false) {
  if (fresh || Date.now() - periodsCache.at > 5000) periodsCache = { at: Date.now(), rows: await get("/api/periods") };
  return periodsCache.rows.find((p) => p.period === period) || { period, status: "open" };
}
export const periodLocked = async (period) => (await periodInfo(period, true)).status === "finalized";
export const lockedBanner = (period) => html`<div class="alert info mb-4">${icon("lock")}<div><b>${monthName(period)} is finalized.</b> Entries are locked and shown read-only.</div></div>`;

export const hubName = (hubs, code) => hubs.find((h) => h.code === code)?.name || code;

// Stock sheets: a count is a whole number of units, 0 or more; a price is an amount of 0 or more ("1,250.50" is fine).
// Empty is not "bad" here; the save checks which fields are required.
export function badNumber(field, value) {
  const v = String(value ?? "").trim();
  if (v === "") return false;
  if (field === "unit_price") { const n = parseAmount(v); return !Number.isFinite(n) || n < 0; }
  return !/^\d+$/.test(v);
}
// The value of a stock field as a number: empty counts as 0. Only call it on a value badNumber accepts.
export const stockNum = (value) => parseAmount(value) ?? 0;
// Mark each number cell in a row that holds something that is not a number, or a required price left empty after a save attempt.
// Returns true when the row has a bad number.
export function markBadNumbers(tr) {
  let bad = false;
  tr.querySelectorAll("input[data-num]").forEach((i) => {
    const wrong = badNumber(i.dataset.f, i.value);
    const missing = i.dataset.missing === "1" && i.value.trim() === "";
    if (wrong || missing) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid");
    if (wrong) bad = true;
  });
  return bad;
}

// Money cells show "14,751.00" when not being edited and plain digits while typing.
export function moneyInputs(root) {
  root.addEventListener("focusin", (e) => {
    const i = e.target.closest("input[data-money]");
    if (i && i.value) { const n = parseAmount(i.value); if (Number.isFinite(n)) i.value = String(n); }
  });
  root.addEventListener("focusout", (e) => {
    const i = e.target.closest("input[data-money]");
    if (i && i.value) i.value = formatAmount(i.value);
  });
}
export const readOnlyBanner = (text = "Read-only: your role can view this sheet but not change it.") =>
  html`<div class="alert info readonly-note" role="note">${icon("eye")}<div>${text}</div></div>`;
export function segButtons(root) {
  root.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.classList.contains("on"))));
}
