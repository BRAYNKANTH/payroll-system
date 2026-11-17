import { get, qs } from "../api.js";
import { can } from "../app.js";
import { exportButtons, $, html, raw, esc, icon, dataTable, dateTime, downloadCsv, titleCase } from "../ui.js";

const MONEY = new Set(["business_amount", "settled_amount", "settle_up_minus", "personal_minus", "business_total", "rent", "hub_fee", "security_cost",
  "personal_draw", "unit_price", "shortfall_value", "amount", "basic_pay", "target", "food_per_day"]);
const HIDE = /^(updated_at|updated_by|created_at|created_by)$/;
const show = (k, v) => (v == null ? "∅" : MONEY.has(k) && typeof v === "number" ? "Rs " + (v / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 }) : String(v));

// A short label for the browser and the system a request came from, from its User-Agent text.
const device = (ua = "") => {
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const o = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return [b, o].filter(Boolean).join(" on ") || ua.slice(0, 30);
};
const SESSION = { login: "Signed in", logout: "Signed out", login_failed: "Sign-in failed", login_locked: "Locked out after too many failed tries", password_change: "Changed their own password", denied: "Refused: not allowed" };
const BAD = new Set(["delete", "reject", "login_failed", "login_locked", "denied"]);
const GOOD = new Set(["approve", "finalize", "create", "login", "upload"]);

// Human-readable diff of one audit row.
export function auditDiff(a) {
  let o, n;
  try { o = a.old_value ? JSON.parse(a.old_value) : null; n = a.new_value ? JSON.parse(a.new_value) : null; } catch { return esc(a.new_value || ""); }
  if (SESSION[a.action]) {
    const extra = n?.reason ? ` <span class="faint">(${esc(n.reason)})</span>` : n?.path ? ` <span class="faint">${esc(n.method || "")} ${esc(n.path)}</span>` : "";
    return raw(`<span>${SESSION[a.action]}${extra}</span>`);
  }
  if (a.action === "export") return raw(`<span>Downloaded <b>${esc(a.row_key)}</b>${n?.period ? ` <span class="faint">${esc(n.period)}${n.hub ? " · " + esc(n.hub) : ""}</span>` : ""}</span>`);
  if (a.action === "view") return raw(`<span>Opened <b>${esc(a.row_key)}</b></span>`);
  if (a.table_name === "backup") return raw(`<span>Downloaded a full backup</span>`);
  if (a.action === "finalize" || a.action === "bank_file_download") return raw(`<span class="muted">${esc(titleCase(a.action))} for ${esc(a.row_key)}</span>`);
  if (a.action === "approve" || a.action === "reject") {
    return raw(`<div class="diff">${esc(o?.status || "")} → <ins>${esc(n?.status)}</ins>${n?.note ? ` — “${esc(n.note)}”` : ""}<div class="faint">${esc((o?.flags || []).map((f) => f.code).join(", "))}</div></div>`);
  }
  if (typeof o !== "object" || o === null) {
    if (!n) return "";
    if (typeof n !== "object") return raw(`<div class="diff"><s>${esc(show(a.row_key, o))}</s> → <ins>${esc(show(a.row_key, n))}</ins></div>`);
  }
  // No earlier value (e.g. a document upload): list what was added.
  if (!o) return raw(`<div class="diff"><ins>added</ins> <span class="faint">${esc(Object.entries(n).filter(([k]) => !HIDE.test(k)).map(([k, v]) => `${k}=${show(k, v)}`).join(", "))}</span></div>`);
  if (!n) return raw(`<div class="diff"><s>deleted</s> <span class="faint">${esc(Object.entries(o).filter(([k]) => !HIDE.test(k)).map(([k, v]) => `${k}=${show(k, v)}`).join(", "))}</span></div>`);
  const keys = Object.keys(n).filter((k) => !HIDE.test(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
  if (!keys.length) return raw(`<span class="faint">no visible change</span>`);
  return raw(`<div class="diff">${keys.map((k) => k === "password"
    ? `<div><b>password</b> changed</div>`
    : `<div><b>${esc(k)}</b>: <s>${esc(show(k, o[k]))}</s> → <ins>${esc(show(k, n[k]))}</ins></div>`).join("")}</div>`);
}

const TABLES = [["", "Everything"], ["daily_log", "Daily sheet"], ["weekly_log", "Weekly sheet"], ["stock_recon", "Stock"], ["hub_stock", "Hub stock"], ["allowances", "Allowances"], ["loans", "Advances & loans"],
  ["session", "Sign-ins and sign-outs"], ["export", "Downloads"], ["view", "Views"], ["backup", "Backups"],
  ["staff", "Employees"], ["products", "Products"], ["staff_documents", "Documents"], ["hubs", "Hubs"], ["pay_period_summary", "Approvals"], ["periods", "Periods"], ["users", "Users"], ["settings", "Settings"]];
const ACTIONS = [["", "Any action"], ["create", "Added"], ["update", "Changed"], ["delete", "Deleted"], ["upload", "Uploaded"], ["login", "Signed in"], ["login_failed", "Sign-in failed"], ["logout", "Signed out"],
  ["export", "Downloaded"], ["view", "Opened"], ["approve", "Approved"], ["reject", "Rejected"], ["finalize", "Finalized"], ["password_change", "Password changed"], ["denied", "Refused"]];
const ACCESS = new Set(["session", "export", "view", "backup"]);
let f = { table: "", action: "", user: "", from: "", to: "", key: "" };

export default {
  title: "Audit trail",
  async render({ el }) {
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Audit trail</h1><p>Who signed in, added, changed, uploaded, downloaded or opened what, when, and from where. Nothing here can be edited or deleted.${can("manage_users") ? "" : " You see your own actions" + (can("view_pay") ? "" : ", without pay") + "."}</p></div>
        <div class="actions"><span id="xaudit"></span><button class="btn" id="csv">${icon("download")} CSV</button></div>
      </div>
      <div class="card">
        <div class="card-head"><form class="row" id="af">
          <select class="input sm" name="table" aria-label="Record type" style="width:auto">${TABLES.filter(([v]) => (can("view_pay") || !["pay_period_summary", "settings"].includes(v)) && (can("manage_users") || !ACCESS.has(v))).map(([v, l]) => html`<option value="${v}" ${f.table === v ? "selected" : ""}>${l}</option>`)}</select>
          <select class="input sm" name="action" aria-label="Action" style="width:auto">${ACTIONS.map(([v, l]) => html`<option value="${v}" ${f.action === v ? "selected" : ""}>${l}</option>`)}</select>
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
      $("#xaudit").innerHTML = exportButtons("audit", f).toString(); // Excel and PDF follow the filters on screen
      $("#list").innerHTML = dataTable({
        rows, sortable: false, empty: "No changes match these filters",
        cols: [
          { key: "changed_at", label: "When", render: (a) => html`<span style="white-space:nowrap">${dateTime(a.changed_at)}</span>` },
          { key: "changed_by", label: "Who", render: (a) => html`<b>${a.changed_by}</b>` },
          { key: "table_name", label: "Area", render: (a) => (TABLES.find(([v]) => v === a.table_name)?.[1] || a.table_name) },
          { key: "row_key", label: "Record", render: (a) => html`<span class="mono">${a.row_key}</span>` },
          { key: "action", label: "Action", render: (a) => html`<span class="badge plain ${BAD.has(a.action) ? "red" : GOOD.has(a.action) ? "green" : ""}">${titleCase(a.action.replace(/_/g, " "))}</span>` },
          { key: "diff", label: "What", render: auditDiff },
          { key: "ip", label: "From", render: (a) => (a.ip ? html`<span class="mono">${a.ip}</span><div class="faint text-sm">${device(a.agent)}</div>` : html`<span class="faint">—</span>`) },
        ],
      }).toString();
    };
    $("#af").onsubmit = (e) => { e.preventDefault(); f = Object.fromEntries(new FormData(e.target)); load(); };
    $("#clear").onclick = () => { f = { table: "", action: "", user: "", from: "", to: "", key: "" }; $("#af").reset(); $$reset(); load(); };
    const $$reset = () => [...$("#af").elements].forEach((i) => { if (i.name) i.value = ""; });
    $("#csv").onclick = () => downloadCsv("audit-trail.csv", ["when", "who", "area", "record", "action", "old_value", "new_value", "address", "browser"],
      rows.map((a) => [a.changed_at, a.changed_by, a.table_name, a.row_key, a.action, a.old_value || "", a.new_value || "", a.ip || "", a.agent || ""]));
    await load();
  },
};
