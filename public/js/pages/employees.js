import { get, post, put, qs } from "../api.js";
import { state, can, scopeHub, navigate } from "../app.js";
import { $, $$, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, fromCents, initials, roleLabel, pct } from "../ui.js";

let filters = { q: "", role: "", status: "active" };

function parseRule(rule) {
  const m = /^(fixed|pct_gross|pct_basic):([\d.]+)(?:;cap:([\d.]+))?$/.exec(String(rule || "").trim());
  return m ? { kind: m[1], value: m[2], cap: m[3] || "" } : { kind: "none", value: "", cap: "" };
}

// Add / edit employee drawer. Used by the list and the profile page.
export async function employeeForm(existing, onSaved) {
  const staff = await get("/api/staff");
  const managers = staff.filter((s) => s.role === "manager" && s.status === "active");
  const e = existing || { role: "guy", status: "active", hub: scopeHub() || state.hubs[0]?.code, security_deduction_rule: "none", commission_rate: 0 };
  const rule = parseRule(e.security_deduction_rule);
  const d = drawer({
    title: existing ? `Edit ${existing.name}` : "Add employee",
    body: html`<form id="ef" class="form-grid" autocomplete="off">
      <div class="form-section">Identity</div>
      <div class="field"><label>Employee ID</label><input class="input" name="employee_id" value="${e.employee_id || ""}" ${existing ? "disabled" : ""} required placeholder="e.g. G05"></div>
      <div class="field"><label>Full name</label><input class="input" name="name" value="${e.name || ""}" required></div>
      <div class="field"><label>Role</label><select class="input" name="role">
        <option value="guy" ${e.role === "guy" ? "selected" : ""}>Guy / Supervisor</option><option value="manager" ${e.role === "manager" ? "selected" : ""}>Manager</option></select></div>
      <div class="field"><label>Hub</label><select class="input" name="hub">${state.hubs.map((h) => html`<option value="${h.code}" ${h.code === e.hub ? "selected" : ""}>${h.name}</option>`)}</select></div>
      <div class="field"><label>Phone</label><input class="input" name="phone" value="${e.phone || ""}" inputmode="tel"></div>
      <div class="field"><label>NIC</label><input class="input" name="nic" value="${e.nic || ""}"></div>
      <div class="field"><label>Join date</label><input class="input" type="date" name="join_date" value="${e.join_date || ""}"></div>
      <div class="field"><label>Status</label><select class="input" name="status"><option value="active" ${e.status === "active" ? "selected" : ""}>Active</option><option value="inactive" ${e.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>

      <div class="form-section" data-guy>Pay setup</div>
      <div class="field" data-guy><label>Reports to (manager)</label><select class="input" name="manager_id"><option value="">—</option>
        ${managers.map((m) => html`<option value="${m.employee_id}" ${m.employee_id === e.manager_id ? "selected" : ""}>${m.name} · ${m.hub}</option>`)}</select></div>
      <div class="field" data-guy><label>Basic pay (Rs / month)</label><input class="input" name="basic_pay" inputmode="decimal" value="${fromCents(e.basic_pay)}"></div>
      <div class="field" data-guy><label>Monthly target (Rs)</label><input class="input" name="target" inputmode="decimal" value="${fromCents(e.target)}"></div>
      <div class="field" data-guy><label>Commission on business over target (%)</label><input class="input" name="commission_pct" inputmode="decimal" value="${e.commission_rate ? +(e.commission_rate * 100).toFixed(4) : ""}"></div>
      <div class="field" data-guy><label>Security deduction</label><select class="input" name="sec_kind">
        ${[["none", "None"], ["fixed", "Fixed amount / month"], ["pct_gross", "% of gross pay"], ["pct_basic", "% of basic pay"]].map(([v, l]) => html`<option value="${v}" ${rule.kind === v ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field" data-guy data-sec><label id="sec-val-lbl">Amount</label><input class="input" name="sec_value" inputmode="decimal" value="${rule.value}"></div>
      <div class="field" data-guy data-sec><label>Stop after total of (Rs)</label><input class="input" name="sec_cap" inputmode="decimal" value="${rule.cap}" placeholder="No cap"><span class="hint">Lifetime cap on security held</span></div>

      <div class="form-section">Bank details</div>
      <div class="field"><label>Bank name</label><input class="input" name="bank_name" value="${e.bank_name || ""}" placeholder="e.g. Bank of Ceylon"></div>
      <div class="field"><label>Bank code</label><input class="input" name="bank_code" value="${e.bank_code || ""}" placeholder="e.g. 7010"></div>
      <div class="field"><label>Branch code</label><input class="input" name="branch_code" value="${e.branch_code || ""}" placeholder="e.g. 001"></div>
      <div class="field"><label>Account number</label><input class="input mono" name="bank_account_no" value="${e.bank_account_no || ""}" inputmode="numeric"></div>
      ${existing ? html`<div class="full alert info">${icon("shield")}<div>Changing the account number flags this employee's next payment for review. Another user must approve it before it is paid.</div></div>` : ""}
    </form>`.toString(),
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ef-save">${existing ? "Save changes" : "Add employee"}</button>`,
  });
  const f = $("#ef", d.panel);
  const sync = () => {
    const guy = f.role.value === "guy";
    $$("[data-guy]", f).forEach((x) => (x.hidden = !guy));
    const k = f.sec_kind.value;
    $$("[data-sec]", f).forEach((x) => (x.hidden = !guy || k === "none"));
    $("#sec-val-lbl", f).textContent = k === "fixed" ? "Amount (Rs / month)" : "Percentage (%)";
  };
  f.addEventListener("change", sync);
  sync();

  $("#ef-save", d.panel).onclick = (ev) => busy(ev.currentTarget, async () => {
    const v = Object.fromEntries(new FormData(f));
    const guy = v.role === "guy";
    const secRule = !guy || v.sec_kind === "none" ? "none" : `${v.sec_kind}:${v.sec_value || 0}${v.sec_cap ? `;cap:${v.sec_cap}` : ""}`;
    const body = {
      name: v.name, role: v.role, hub: v.hub, phone: v.phone, nic: v.nic, join_date: v.join_date, status: v.status,
      manager_id: guy ? v.manager_id : "", basic_pay: guy ? v.basic_pay || 0 : 0, target: guy ? v.target || 0 : 0,
      commission_rate: guy && v.commission_pct ? Number(v.commission_pct) / 100 : 0, security_deduction_rule: secRule,
      bank_name: v.bank_name, bank_code: v.bank_code, branch_code: v.branch_code, bank_account_no: v.bank_account_no,
    };
    const saved = existing ? await put(`/api/staff/${encodeURIComponent(existing.employee_id)}`, body) : await post("/api/staff", { ...body, employee_id: v.employee_id });
    toast(existing ? "Employee updated" : `${saved.name} added`);
    d.close();
    onSaved?.(saved);
  });
}

export default {
  title: "Employees",
  async render(ctx) {
    const { el } = ctx;
    const staff = await get("/api/staff" + qs({ hub: scopeHub() }));
    const byId = Object.fromEntries(staff.map((s) => [s.employee_id, s]));
    const hubName = (c) => state.hubs.find((h) => h.code === c)?.name || c;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Employees</h1><p>${staff.filter((s) => s.status === "active").length} active · ${staff.filter((s) => s.role === "guy" && s.status === "active").length} guys / supervisors · ${staff.filter((s) => s.role === "manager" && s.status === "active").length} managers</p></div>
        <div class="actions">${can("manage_staff") ? html`<button class="btn primary" id="add" ${state.hubs.length ? "" : "disabled"}>${icon("plus")} Add employee</button>` : ""}</div>
      </div>
      ${!state.hubs.length ? html`<div class="alert warn" style="margin-bottom:16px">${icon("alert")}<div>Create at least one hub before adding employees. <a href="/hubs" data-link>Go to hubs →</a></div></div>` : ""}
      <div class="card">
        <div class="card-head">
          <div class="row">
            <div class="search"><span>${icon("search")}</span><input class="input sm" id="q" placeholder="Search name, ID, phone" value="${filters.q}" style="width:240px"></div>
            <select class="input sm" id="role" style="width:auto"><option value="">All roles</option><option value="guy" ${filters.role === "guy" ? "selected" : ""}>Guys / supervisors</option><option value="manager" ${filters.role === "manager" ? "selected" : ""}>Managers</option></select>
            <div class="seg" id="st">${[["active", "Active"], ["inactive", "Inactive"], ["", "All"]].map(([v, l]) => html`<button data-v="${v}" class="${filters.status === v ? "on" : ""}">${l}</button>`)}</div>
          </div>
        </div>
        <div class="card-body flush" id="list"></div>
      </div>`;

    const draw = () => {
      const q = filters.q.toLowerCase();
      const rows = staff.filter((s) => (!filters.role || s.role === filters.role) && (!filters.status || s.status === filters.status) &&
        (!q || [s.name, s.employee_id, s.phone || "", s.nic || ""].some((x) => x.toLowerCase().includes(q))));
      $("#list").innerHTML = staff.length ? dataTable({
        rows, empty: "No employees match these filters",
        onRow: (s) => navigate(`/employees/${encodeURIComponent(s.employee_id)}`),
        cols: [
          { key: "name", label: "Employee", render: (s) => html`<div class="who"><div class="avatar" style="${s.role === "manager" ? "background:linear-gradient(135deg,#0ea5e9,#10b981)" : ""}">${initials(s.name)}</div><div><b>${s.name}</b><span>${s.employee_id}${s.phone ? ` · ${s.phone}` : ""}</span></div></div>` },
          { key: "role", label: "Role", render: (s) => badge(s.role, roleLabel(s.role)) },
          { key: "hub", label: "Hub", render: (s) => hubName(s.hub) },
          { key: "manager_id", label: "Manager", render: (s) => s.manager_id ? byId[s.manager_id]?.name || s.manager_id : html`<span class="faint">—</span>` },
          { key: "basic_pay", label: "Basic", align: "r", render: (s) => s.role === "guy" ? money(s.basic_pay) : html`<span class="faint">—</span>` },
          { key: "target", label: "Target", align: "r", render: (s) => s.role === "guy" ? money(s.target) : html`<span class="faint">—</span>` },
          { key: "commission_rate", label: "Comm.", align: "r", render: (s) => s.role === "guy" ? pct(s.commission_rate, 2) : html`<span class="faint">—</span>` },
          { key: "bank_account_no", label: "Bank", render: (s) => !s.bank_account_no ? html`<span class="badge amber plain">missing</span>`
            : s.bank_account_no !== s.bank_account_verified ? html`<span class="badge red">unverified</span>` : html`<span class="mono faint">…${s.bank_account_no.slice(-4)}</span>` },
          { key: "status", label: "Status", render: (s) => badge(s.status) },
        ],
      }).toString() : emptyState("No employees yet", "Add your guys, supervisors and managers to start entering sheets.", "users").toString();
    };
    draw();
    $("#q").oninput = (e) => { filters.q = e.target.value; draw(); };
    $("#role").onchange = (e) => { filters.role = e.target.value; draw(); };
    $$("#st button", el).forEach((b) => (b.onclick = () => { filters.status = b.dataset.v; $$("#st button", el).forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
    $("#add")?.addEventListener("click", () => employeeForm(null, (s) => navigate(`/employees/${encodeURIComponent(s.employee_id)}`)));
  },
};
