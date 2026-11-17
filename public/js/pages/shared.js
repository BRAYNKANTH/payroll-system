// Helpers shared by several pages.
import { get } from "../api.js";
import { html, icon, monthName, parseAmount, formatAmount, fromCents, money, announce, LEVELS } from "../ui.js";

// Spreadsheet keyboard navigation: Enter / ↓ moves down, ↑ moves up, in the same column.
// Everyone sits in a group: the manager they report to (directly or through others), or, when no manager is above them, whoever they report to.
// Returns { id, title, sub, order, name, hub }. byId maps employee_id -> person (the whole hub, with the people above the sellers).
export function managerGroupOf(person, byId) {
  if (person.staff_level === "coacher" || person.staff_level === "promoting_manager") return { id: "lead:" + person.hub, title: "Leadership", sub: `Coacher and promoting manager · ${person.hub}`, order: -1, name: "", hub: person.hub };
  const isManager = (x) => x && x.staff_level === "manager";
  let boss = isManager(person) ? person : null, cur = person, hops = 0;
  while (!boss && cur?.upline_id && hops++ < 8) { cur = byId[cur.upline_id]; if (isManager(cur)) boss = cur; }
  if (boss) return { id: boss.employee_id, title: boss.name, sub: `Manager · ${boss.employee_id}`, order: 0, name: boss.name, hub: boss.hub };
  const up = byId[person.upline_id];
  if (up) return { id: "up:" + up.employee_id, title: `Reports to ${up.name}`, sub: up.employee_id, order: 1, name: up.name, hub: up.hub };
  return { id: "none", title: "No manager", sub: "", order: 2, name: "", hub: person.hub };
}
// People sorted the way a team reads: the manager first, then supervisors, then distributors, each by name.
const posIndex = (l) => LEVELS.findIndex(([v]) => v === l);
export const teamOrder = (a, b) => (posIndex(b.staff_level) - posIndex(a.staff_level)) || a.name.localeCompare(b.name);

export function sheetKeys(root) {
  root.addEventListener("keydown", (e) => {
    const input = e.target.closest("input[data-f]");
    if (!input || !["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const tr = input.closest("tr");
    const all = [...root.querySelectorAll("tbody tr")];
    const at = all.indexOf(tr);
    const next = all[e.key === "ArrowUp" ? at - 1 : at + 1];
    const target = next?.querySelector(`input[data-f="${input.dataset.f}"]`);
    if (target) target.closest("details")?.setAttribute("open", ""); // a collapsed card opens when the cursor moves into it
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
// ---- Product names on the stock sheets
// `catalogue` is [{ name, list_price }] from /api/products/names. Product fields suggest these names (a datalist), so a
// name is typed the same way every month; a name outside the list is still allowed but flagged.
export const productList = (catalogue) =>
  html`<datalist id="product-list">${catalogue.map((p) => html`<option value="${p.name}"></option>`)}</datalist>`;
const findProduct = (catalogue, name) => {
  const key = String(name || "").trim().toLowerCase();
  return key ? catalogue.find((p) => p.name.toLowerCase() === key) : null;
};
// After a product field changes: use the catalogue's spelling, and fill in an empty price with the selling price.
export function pickProduct(input, catalogue) {
  if (!input?.matches?.("[data-f=product]")) return;
  const p = findProduct(catalogue, input.value);
  if (!p) return;
  input.value = p.name;
  const price = input.closest("tr")?.querySelector("[data-f=unit_price]");
  if (price && !price.value.trim() && !price.disabled) {
    price.value = fromCents(p.list_price);
    announce(`${p.name}: unit price filled in as Rs ${money(p.list_price)} from the Products list`);
  }
}
// How many of these product fields hold a name that is not in the catalogue (0 when there is no catalogue to check).
export const unknownProducts = (catalogue, inputs) =>
  catalogue.length ? inputs.filter((i) => i.value.trim() && !findProduct(catalogue, i.value)).length : 0;

// Search box for a sheet; the page listens for input on #find.
export const findBox = (label, placeholder) =>
  html`<div class="search"><span>${icon("search")}</span><input class="input sm" id="find" type="search" autocomplete="off" aria-label="${label}" placeholder="${placeholder}" style="width:260px"></div>`;

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
