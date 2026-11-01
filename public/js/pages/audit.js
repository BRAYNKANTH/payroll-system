import { get, qs } from "../api.js";
import { $, html, raw, esc, icon, dataTable, dateTime, downloadCsv, titleCase } from "../ui.js";

const MONEY = new Set(["business_amount", "settled_amount", "settle_up_minus", "personal_minus", "business_total", "rent", "hub_fee", "security_cost",
  "personal_draw", "unit_price", "shortfall_value", "amount", "basic_pay", "target", "food_per_day"]);
const HIDE = /^(updated_at|updated_by|created_at|created_by)$/;
const show = (k, v) => (v == null ? "∅" : MONEY.has(k) && typeof v === "number" ? "Rs " + (v / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 }) : String(v));

// Human-readable diff of one audit row.
export function auditDiff(a) {
  let o, n;
  try { o = a.old_value ? JSON.parse(a.old_value) : null; n = a.new_value ? JSON.parse(a.new_value) : null; } catch { return esc(a.new_value || ""); }
  if (a.action === "finalize" || a.action === "bank_file_download") return raw(`<span class="muted">${esc(titleCase(a.action))} for ${esc(a.row_key)}</span>`);
  if (a.action === "approve" || a.action === "reject") {
    return raw(`<div class="diff">${esc(o?.status || "")} → <ins>${esc(n?.status)}</ins>${n?.note ? ` — “${esc(n.note)}”` : ""}<div class="faint">${esc((o?.flags || []).map((f) => f.code).join(", "))}</div></div>`);
  }
  if (typeof o !== "object" || o === null) {
    if (!n) return "";
    if (typeof n !== "object") return raw(`<div class="diff"><s>${esc(show(a.row_key, o))}</s> → <ins>${esc(show(a.row_key, n))}</ins></div>`);
  }
  if (!n) return raw(`<div class="diff"><s>deleted</s> <span class="faint">${esc(Object.entries(o).filter(([k]) => !HIDE.test(k)).map(([k, v]) => `${k}=${show(k, v)}`).join(", "))}</span></div>`);
  const keys = Object.keys(n).filter((k) => !HIDE.test(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
  if (!keys.length) return raw(`<span class="faint">no visible change</span>`);
  return raw(`<div class="diff">${keys.map((k) => k === "password"
    ? `<div><b>password</b> changed</div>`
    : `<div><b>${esc(k)}</b>: <s>${esc(show(k, o[k]))}</s> → <ins>${esc(show(k, n[k]))}</ins></div>`).join("")}</div>`);
}

const TABLES = [["", "Everything"], ["daily_log", "Daily sheet"], ["weekly_log", "Weekly sheet"], ["stock_recon", "Stock"], ["allowances", "Allowances"],
  ["staff", "Employees"], ["hubs", "Hubs"], ["pay_period_summary", "Approvals"], ["periods", "Periods"], ["users", "Users"], ["settings", "Settings"]];
let f = { table: "", user: "", from: "", to: "", key: "" };

export default {
  title: "Audit trail",
  async render({ el }) {
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Audit trail</h1><p>Every change to an entry after it was first saved: who, when, and the old and new values. This log cannot be edited.</p></div>
        <div class="actions"><button class="btn" id="csv">${icon("download")} Export</button></div>
      </div>
      <div class="card">
        <div class="card-head"><form class="row" id="af">
          <select class="input sm" name="table" aria-label="Record type" style="width:auto">${TABLES.map(([v, l]) => html`<option value="${v}" ${f.table === v ? "selected" : ""}>${l}</option>`)}</select>
          <input class="input sm" name="user" aria-label="User" placeholder="User" value="${f.user}" style="width:130px">
          <input class="input sm" name="key" aria-label="Record ID" placeholder="Record ID" value="${f.key}" style="width:120px">
          <input class="input sm" type="date" name="from" value="${f.from}" style="width:150px" aria-label="From">
          <input class="input sm" type="date" name="to" value="${f.to}" style="width:150px" aria-label="To">
          <button class="btn sm primary">${icon("filter")} Filter</button><button class="btn sm ghost" type="button" id="clear">Clear</button>
        </form></div>
        <div class="card-body flush" id="list"><div class="loading-screen" style="min-height:200px"><div class="spinner"></div></div></div>
      </div>`;
    let rows = [];
    const load = async () => {
      rows = await get("/api/audit" + qs({ ...f, limit: 1000 }));
      $("#list").innerHTML = dataTable({
        rows, sortable: false, empty: "No changes match these filters",
        cols: [
          { key: "changed_at", label: "When", render: (a) => html`<span style="white-space:nowrap">${dateTime(a.changed_at)}</span>` },
          { key: "changed_by", label: "Who", render: (a) => html`<b>${a.changed_by}</b>` },
          { key: "table_name", label: "Area", render: (a) => (TABLES.find(([v]) => v === a.table_name)?.[1] || a.table_name) },
          { key: "row_key", label: "Record", render: (a) => html`<span class="mono">${a.row_key}</span>` },
          { key: "action", label: "Action", render: (a) => html`<span class="badge plain ${a.action === "delete" || a.action === "reject" ? "red" : a.action === "approve" || a.action === "finalize" ? "green" : ""}">${titleCase(a.action)}</span>` },
          { key: "diff", label: "Change", render: auditDiff },
        ],
      }).toString();
    };
    $("#af").onsubmit = (e) => { e.preventDefault(); f = Object.fromEntries(new FormData(e.target)); load(); };
    $("#clear").onclick = () => { f = { table: "", user: "", from: "", to: "", key: "" }; $("#af").reset(); $$reset(); load(); };
    const $$reset = () => [...$("#af").elements].forEach((i) => { if (i.name) i.value = ""; });
    $("#csv").onclick = () => downloadCsv("audit-trail.csv", ["when", "who", "table", "record", "action", "old_value", "new_value"],
      rows.map((a) => [a.changed_at, a.changed_by, a.table_name, a.row_key, a.action, a.old_value || "", a.new_value || ""]));
    await load();
  },
};
