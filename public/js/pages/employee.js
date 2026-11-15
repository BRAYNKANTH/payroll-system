import { get, post, del } from "../api.js";
import { can, navigate, state } from "../app.js";
import { toast, busy, confirmDialog, drawer } from "../ui.js";
import { $, $$, html, icon, money, badge, dataTable, emptyState, initials, roleLabel, levelLabel, pct, dateTime, monthName, shortMonth } from "../ui.js";
import { lineChart, PALETTE } from "../charts.js";
import { employeeForm } from "./employees.js";
import { breakdownDrawer } from "./breakdown.js";
import { auditDiff } from "./audit.js";

let tab = "overview";

const today = () => new Date().toISOString().slice(0, 10);

// Mark someone as left. Anyone who reports to them moves to a replacement who holds the same position.
async function leaveDrawer(p, done) {
  const s = p.staff;
  const reports = [...p.direct_reports, ...p.team].filter((r, i, all) => r.status === "active" && all.findIndex((x) => x.employee_id === r.employee_id) === i);
  const staff = reports.length ? await get("/api/staff") : [];
  const options = staff.filter((x) => x.status === "active" && x.employee_id !== s.employee_id && x.staff_level === s.staff_level && x.hub === s.hub);
  const d = drawer({
    title: `${s.name} has left`,
    body: html`<form id="lf" class="form-grid" autocomplete="off">
      <div class="field"><label for="lf-date">Last day</label><input class="input" id="lf-date" type="date" name="leave_date" value="${today()}" required></div>
      <div class="field"><label for="lf-why">Reason</label><input class="input" id="lf-why" name="reason" list="lf-reasons" placeholder="e.g. Resigned"><datalist id="lf-reasons"><option value="Resigned"><option value="Dismissed"><option value="Retired"><option value="Moved away"></datalist></div>
      ${reports.length ? html`<div class="field full"><label for="lf-repl">Who takes over?</label>
        <select class="input" id="lf-repl" name="replacement_id"><option value="">Choose a ${levelLabel(s.staff_level).toLowerCase()}</option>${options.map((x) => html`<option value="${x.employee_id}">${x.name} · ${x.employee_id}</option>`)}</select>
        <span class="hint">${reports.length} ${reports.length === 1 ? "person reports" : "people report"} to ${s.name} (${reports.slice(0, 4).map((r) => r.name).join(", ")}${reports.length > 4 ? "…" : ""}). They move to the person you choose.${options.length ? "" : " There is nobody else at this position in this hub yet: add the new " + levelLabel(s.staff_level).toLowerCase() + " first."}</span></div>` : ""}
      <div class="full alert info">${icon("info")}<div>${s.name} stays in the system with their history, as inactive. Pay for entries already made is still calculated. If they come back later you can re-hire them.</div></div>
    </form>`.toString(),
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lf-save">Mark as left</button>`,
  });
  $("#lf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
    const v = Object.fromEntries(new FormData($("#lf", d.panel)));
    const out = await post(`/api/staff/${encodeURIComponent(s.employee_id)}/leave`, v);
    toast(out.moved ? `${s.name} has left; ${out.moved} moved to ${out.replacement}` : `${s.name} has left`);
    d.close();
    done();
  });
}

function rehireDrawer(p, done) {
  const s = p.staff;
  const d = drawer({
    title: `Re-hire ${s.name}`,
    body: html`<form id="rf" class="form-grid" autocomplete="off">
      <div class="field"><label for="rf-date">Joins again on</label><input class="input" id="rf-date" type="date" name="join_date" value="${today()}" required></div>
      <div class="full alert info">${icon("info")}<div>${s.name} becomes active again with the same position and pay setup${s.leave_date ? ` (they left on ${s.leave_date})` : ""}. Edit their record first if any of that has changed.</div></div>
    </form>`.toString(),
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rf-save">Re-hire</button>`,
  });
  $("#rf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
    await post(`/api/staff/${encodeURIComponent(s.employee_id)}/rehire`, Object.fromEntries(new FormData($("#rf", d.panel))));
    toast(`${s.name} is active again`);
    d.close();
    done();
  });
}

// Scans kept with the record. The first three are the ones the company asks every person for.
const DOC_TYPES = [["nic", "ID / NIC"], ["bank_book", "Bank book front page"], ["ol_results", "O/L results sheet"], ["other", "Other"]];
const DOC_MAX = 3_000_000;
const fileSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const readBase64 = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(new Error("The file could not be read"));
  r.readAsDataURL(file);
});

export default {
  title: "Employee",
  async render(ctx) {
    const { el, params } = ctx;
    const p = await get(`/api/staff/${encodeURIComponent(params[0])}/profile`);
    const s = p.staff;
    const last = p.history[0];
    const canDocs = can("manage_staff") || can("manage_team");
    const bankState = !s.bank_account_no ? ["amber", "Missing"] : s.bank_account_no !== s.bank_account_verified ? ["red", "Awaiting verification"] : ["green", "Verified"];

    el.innerHTML = html`
      <div class="mb-3"><a href="/employees" data-link class="muted">${icon("left")} All employees</a></div>
      <div class="card mb-4">
        <div class="profile-head">
          <div class="avatar lg" style="${s.role === "manager" ? "background:var(--accent)" : ""}">${initials(s.name)}</div>
          <div style="flex:1;min-width:200px">
            <h1>${s.name}</h1>
            <div class="row" style="margin-top:6px;gap:8px">${badge(s.role, levelLabel(s.staff_level))} ${badge(s.status)} <span class="muted">${s.employee_id} · ${s.hub_name}</span></div>
          </div>
          <div class="row" style="gap:28px">
            <div><div class="faint text-sm">Latest net pay</div><div class="num stat-lg ${last?.net_pay < 0 ? "neg" : ""}">${last ? `Rs ${money(last.net_pay)}` : "—"}</div><div class="faint text-sm">${last ? monthName(last.period) : ""}</div></div>
            <div><div class="faint text-sm">Balance carried</div><div class="num stat-lg ${last?.closing_balance < 0 ? "neg" : ""}">${last ? `Rs ${money(last.closing_balance)}` : "—"}</div></div>
            ${s.role === "guy" ? html`<div><div class="faint text-sm">Security held</div><div class="num stat-lg">Rs ${money(p.security_held)}</div></div>` : ""}
          </div>
          ${(can("manage_staff") || can("manage_team")) && !(state.user.hub && s.role === "manager") ? html`<div class="row" style="gap:8px"><button class="btn" id="edit">${icon("edit")} Edit</button>
            ${s.status === "active" ? html`<button class="btn" id="leave">${icon("logout")} Mark as left</button>` : html`<button class="btn primary" id="rehire">${icon("refresh")} Re-hire</button>`}</div>` : ""}
        </div>
      </div>

      <div class="tabs" id="tabs">${[["overview", "Overview"], ["history", `Pay history (${p.history.length})`], ...(s.role === "manager" ? [["team", `Team (${p.team.length})`]] : []), ...(canDocs ? [["documents", "Documents"]] : []), ["changes", "Change log"]]
        .map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`)}</div>
      <div id="pane"></div>`;

    const panes = {
      overview: () => html`<div class="grid halves">
        <div class="card"><div class="card-head"><h2>Details</h2></div><div class="card-body"><dl class="kv">
          <dt>Employee ID</dt><dd class="mono">${s.employee_id}</dd><dt>Hub</dt><dd>${s.hub_name} (${s.hub})</dd>
          <dt>Position</dt><dd>${levelLabel(s.staff_level)}</dd>${s.role === "guy" || s.upline_id ? html`<dt>Reports to</dt><dd>${s.upline_id ? html`<a href="/employees/${encodeURIComponent(s.upline_id)}" data-link>${s.upline_name}</a>` : "—"}</dd>
          ${s.manager_id && s.manager_id !== s.upline_id ? html`<dt>Payroll manager</dt><dd><a href="/employees/${encodeURIComponent(s.manager_id)}" data-link>${s.manager_name}</a></dd>` : ""}` : ""}
          ${p.direct_reports.length ? html`<dt>Direct reports</dt><dd>${p.direct_reports.map((r) => html`<div><a href="/employees/${encodeURIComponent(r.employee_id)}" data-link>${r.name}</a> <span class="faint">${levelLabel(r.staff_level)}</span></div>`)}</dd>` : ""}
          <dt>Phone</dt><dd>${s.phone || "—"}</dd><dt>NIC</dt><dd>${s.nic || "—"}</dd><dt>Joined</dt><dd>${s.join_date || "—"}</dd>${s.leave_date ? html`<dt>Left</dt><dd>${s.leave_date}${s.leave_reason ? html` <span class="faint">· ${s.leave_reason}</span>` : ""}</dd>` : ""}
          <dt>Added by</dt><dd>${s.created_by} · ${dateTime(s.created_at)}</dd></dl></div></div>
        <div class="stack">
          ${s.role === "guy" ? html`<div class="card"><div class="card-head"><h2>Pay setup</h2></div><div class="card-body"><dl class="kv">
            ${s.pay_scheme === "tiered" ? html`<dt>Scheme</dt><dd>Tiered</dd>
            <dt>Under target</dt><dd>${pct(s.base_commission_rate, 2)} of all business, no basic</dd>
            <dt>Over target</dt><dd>Rs ${money(s.basic_pay)} fixed basic + ${pct(s.commission_rate, 2)} of business over target</dd>
            <dt>Target</dt><dd>Rs ${money(s.target)} / month</dd>
            <dt>Food</dt><dd>${s.food_per_day ? html`Rs ${money(s.food_per_day)} / day${s.food_min_days ? ` once ${s.food_min_days}+ days worked` : ""}` : "None"}</dd>`
            : html`<dt>Basic pay</dt><dd>Rs ${money(s.basic_pay)} / month</dd><dt>Target</dt><dd>Rs ${money(s.target)} / month</dd>
            <dt>Commission</dt><dd>${pct(s.commission_rate, 2)} of business over target</dd>`}
            <dt>Security rule</dt><dd class="mono">${s.security_deduction_rule}</dd></dl></div></div>`
            : html`<div class="card"><div class="card-head"><h2>How manager pay works</h2></div><div class="card-body muted">Each week: business × profit % − rent − hub fee − security − personal draw. Each month the company return and the guys' net salaries are charged, and the result is carried as a running balance.
              <dl class="kv mt-4"><dt>Basic salary</dt><dd>${s.basic_pay ? html`Rs ${money(s.basic_pay)} / month, paid to the bank separately` : "None"}</dd></dl></div></div>`}
          <div class="card"><div class="card-head"><h2>Bank</h2>${badge(bankState[0], bankState[1])}</div><div class="card-body"><dl class="kv">
            <dt>Bank</dt><dd>${s.bank_name || "—"}</dd><dt>Bank / branch</dt><dd class="mono">${s.bank_code || "—"} / ${s.branch_code || "—"}</dd>
            <dt>Account</dt><dd class="mono">${s.bank_account_no || "—"}</dd>
            ${s.bank_account_no !== s.bank_account_verified ? html`<dt>Verified account</dt><dd class="mono">${s.bank_account_verified || "none"}</dd>` : ""}</dl></div></div>
        </div></div>`,
      history: () => p.history.length ? html`
        <div class="card mb-4"><div class="card-head"><h2>Net pay over time</h2></div><div class="card-body" id="chart"></div></div>
        <div class="card"><div class="card-body flush" id="hist"></div></div>` : html`<div class="card">${emptyState("No pay history yet", "", "file")}</div>`,
      team: () => html`<div class="card"><div class="card-body flush">${dataTable({
        rows: p.team, empty: "No guys report to this manager", onRow: (g) => navigate(`/employees/${encodeURIComponent(g.employee_id)}`),
        cols: [{ key: "name", label: "Name", render: (g) => html`<b>${g.name}</b> <span class="faint">${g.employee_id}</span>` }, { key: "basic_pay", label: "Basic", align: "r", render: (g) => money(g.basic_pay) },
          { key: "target", label: "Target", align: "r", render: (g) => money(g.target) }, { key: "status", label: "Status", render: (g) => badge(g.status) }],
      })}</div></div>`,
      documents: () => html`<div class="card"><div class="card-head"><div><h2>Documents</h2><div class="sub">JPG, PNG, WebP or PDF, up to 3 MB each</div></div></div>
        <div class="card-body" id="docs"><div class="loading-screen"><div class="spinner"></div></div></div></div>`,
      changes: () => html`<div class="card"><div class="card-body flush">${dataTable({
        rows: p.changes, sortable: false, empty: "No changes since the record was created",
        cols: [{ key: "changed_at", label: "When", render: (a) => dateTime(a.changed_at) }, { key: "changed_by", label: "Who" }, { key: "diff", label: "Change", render: (a) => auditDiff(a) }],
      })}</div></div>`,
    };
    const drawDocs = async () => {
      const docs = await get(`/api/staff/${encodeURIComponent(s.employee_id)}/documents`);
      const box = $("#docs");
      if (!box) return;
      box.innerHTML = html`<div class="stack">${DOC_TYPES.map(([k, l]) => {
        const mine = docs.filter((d) => d.doc_type === k);
        return html`<div class="row between" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
          <div style="min-width:200px;flex:1"><b>${l}</b> ${k === "other" ? "" : mine.length ? badge("green", "On file") : badge("amber", "Missing")}
            ${mine.map((d) => html`<div class="row" style="gap:8px;margin-top:6px"><a href="/api/documents/${d.id}" target="_blank" rel="noopener">${icon("file")} ${d.file_name}</a>
              <span class="faint text-sm">${fileSize(d.size_bytes)} · ${d.uploaded_by} · ${dateTime(d.uploaded_at)}</span>
              <button class="btn sm icon danger-ghost" data-rm="${d.id}" data-name="${d.file_name}" aria-label="Remove ${d.file_name}">${icon("trash")}</button></div>`)}</div>
          <label class="btn sm">${icon("upload")} Upload<input type="file" data-up="${k}" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></label></div>`;
      })}</div>`.toString();
      $$("[data-up]", box).forEach((inp) => (inp.onchange = () => busy(inp.parentElement, async () => {
        const file = inp.files[0];
        if (!file) return;
        if (file.size > DOC_MAX) throw new Error("The file is larger than 3 MB. Scan or photograph it at a lower quality.");
        await post(`/api/staff/${encodeURIComponent(s.employee_id)}/documents`, { doc_type: inp.dataset.up, file_name: file.name, mime: file.type, data: await readBase64(file) });
        toast(`${file.name} uploaded`);
        await drawDocs();
      })));
      $$("[data-rm]", box).forEach((b) => (b.onclick = async () => {
        if (!(await confirmDialog({ title: "Remove document?", message: `${b.dataset.name} will be deleted. This cannot be undone.`, confirmText: "Remove", danger: true }))) return;
        await del(`/api/documents/${b.dataset.rm}`);
        toast("Document removed");
        await drawDocs();
      }));
    };
    const show = () => {
      $("#pane").innerHTML = panes[tab]().toString();
      if (tab === "documents") drawDocs().catch((e) => toast(e.message, "err"));
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      if (tab === "history" && p.history.length) {
        const h = [...p.history].reverse().slice(-12);
        lineChart($("#chart"), { labels: h.map((r) => shortMonth(r.period)), height: 220, series: [
          { name: "Net pay", color: PALETTE[0], values: h.map((r) => r.net_pay) },
          ...(s.role === "guy" ? [{ name: "Gross", color: PALETTE[1], values: h.map((r) => r.gross_earnings) }] : [{ name: "Closing balance", color: PALETTE[2], values: h.map((r) => r.closing_balance) }]),
        ] });
        $("#hist").innerHTML = dataTable({
          rows: p.history, onRow: (r) => breakdownDrawer({ ...r, name: s.name, hub: s.hub, staff_level: s.staff_level }, { finalized: r.period_status === "finalized", onChange: () => this.render(ctx) }),
          cols: [
            { key: "period", label: "Month", render: (r) => html`<b>${monthName(r.period)}</b>` },
            { key: "opening_balance", label: "Opening", align: "r", render: (r) => money(r.opening_balance) },
            { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings) },
            { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
            { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
            { key: "closing_balance", label: "Closing", align: "r", render: (r) => html`<span class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</span>` },
            { key: "status", label: "Status", render: (r) => html`${badge(r.status)} ${r.period_status === "finalized" ? html`<span class="faint">${icon("lock")}</span>` : ""}` },
          ],
        }).toString();
      }
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; show(); }));
    if (!panes[tab]) tab = "overview";
    show();
    $("#edit")?.addEventListener("click", () => employeeForm(s, () => this.render(ctx)));
    $("#leave")?.addEventListener("click", () => leaveDrawer(p, () => this.render(ctx)));
    $("#rehire")?.addEventListener("click", () => rehireDrawer(p, () => this.render(ctx)));
    document.title = `${s.name} · Payroll`;
    const title = $("#page-title"); // the redesigned header has no #page-title, only breadcrumbs
    if (title) title.textContent = s.name;
  },
};
