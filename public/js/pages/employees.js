import { get, post, put, qs } from "../api.js";
import { state, can, scopeHub, navigate } from "../app.js";
import { $, $$, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, fromCents, initials, roleLabel, pct, LEVELS, levelRank, levelLabel, isManagerLevel, positionDefaults } from "../ui.js";

let filters = { q: "", role: "", status: "active" };

function parseRule(rule) {
  const m = /^(fixed|pct_gross|pct_basic|pct_business):([\d.]+)(?:;cap:([\d.]+))?$/.exec(String(rule || "").trim());
  return m ? { kind: m[1], value: m[2], cap: m[3] || "" } : { kind: "none", value: "", cap: "" };
}

// Add / edit employee drawer. Used by the list and the profile page.
export async function employeeForm(existing, onSaved) {
  const staff = await get("/api/staff");
  const e = existing || { role: "guy", staff_level: "distributor", status: "active", hub: scopeHub() || state.hubs[0]?.code, security_deduction_rule: "none", commission_rate: 0, pay_scheme: "over_target" };
  const rule = parseRule(e.security_deduction_rule);
  const d = drawer({
    title: existing ? `Edit ${existing.name}` : "Add employee",
    body: html`<form id="ef" class="form-grid" autocomplete="off">
      <div class="form-section">Identity</div>
      <div class="field"><label>Employee ID</label><input class="input" name="employee_id" value="${e.employee_id || ""}" ${existing ? "disabled" : ""} required placeholder="e.g. G05"></div>
      <div class="field"><label>Full name</label><input class="input" name="name" value="${e.name || ""}" required></div>
      <div class="field"><label for="ef-level">Position</label><select class="input" id="ef-level" name="staff_level">
        ${LEVELS.filter(([v]) => !(scopeHub() && isManagerLevel(v))).map(([v, l]) => html`<option value="${v}" ${v === (e.staff_level || (e.role === "manager" ? "manager" : "distributor")) ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field" id="ef-upline-wrap"><label for="ef-upline">Reports to</label><select class="input" id="ef-upline" name="upline_id"></select>
        <span class="hint" id="ef-upline-hint">Who sits directly above this person in the chain</span></div>
      <div class="field"><label>Hub</label><select class="input" name="hub" ${scopeHub() ? "disabled" : ""}>${state.hubs.map((h) => html`<option value="${h.code}" ${h.code === e.hub ? "selected" : ""}>${h.name}</option>`)}</select></div>
      <div class="field"><label>Phone</label><input class="input" name="phone" value="${e.phone || ""}" inputmode="tel"></div>
      <div class="field"><label>NIC</label><input class="input" name="nic" value="${e.nic || ""}"></div>
      <div class="field"><label>Join date</label><input class="input" type="date" name="join_date" value="${e.join_date || ""}"></div>
      <div class="field"><label>Status</label><select class="input" name="status"><option value="active" ${e.status === "active" ? "selected" : ""}>Active</option><option value="inactive" ${e.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>

      <div class="form-section">Pay setup</div>
      <div class="field" data-guy><label>Pay scheme</label><select class="input" name="pay_scheme">
        <option value="over_target" ${e.pay_scheme !== "tiered" ? "selected" : ""}>Basic + commission over target</option>
        <option value="tiered" ${e.pay_scheme === "tiered" ? "selected" : ""}>Tiered (commission under target, fixed basic over it)</option></select></div>
      <div class="field"><label id="basic-lbl">Basic pay (Rs / month)</label><input class="input" name="basic_pay" inputmode="decimal" value="${fromCents(e.basic_pay)}"><span class="hint" id="basic-hint" hidden>A separate fixed salary, paid to the bank each month on top of the weekly account. Leave at 0 for none.</span></div>
      <div class="field" data-guy><label>Monthly target (Rs)</label><input class="input" name="target" inputmode="decimal" value="${fromCents(e.target)}"></div>
      <div class="field" data-guy data-tiered><label>Commission on all business when target not reached (%)</label><input class="input" name="base_commission_pct" inputmode="decimal" value="${e.base_commission_rate ? +(e.base_commission_rate * 100).toFixed(4) : ""}"></div>
      <div class="field" data-guy><label>Commission on business over target (%)</label><input class="input" name="commission_pct" inputmode="decimal" value="${e.commission_rate ? +(e.commission_rate * 100).toFixed(4) : ""}"></div>
      <div class="field" data-guy data-tiered><label>Food allowance (Rs / day worked)</label><input class="input" name="food_per_day" inputmode="decimal" value="${e.food_per_day ? fromCents(e.food_per_day) : ""}"></div>
      <div class="field" data-guy data-tiered><label>Food paid only after (days worked)</label><input class="input" name="food_min_days" inputmode="numeric" value="${e.food_min_days || ""}" placeholder="0 = always"><span class="hint">Blank or 0 pays food from the first day</span></div>
      <div class="field" data-guy><label>Security deduction</label><select class="input" name="sec_kind">
        ${[["none", "None"], ["fixed", "Fixed amount / month"], ["pct_gross", "% of gross pay"], ["pct_basic", "% of basic pay"], ["pct_business", "% of total business"]].map(([v, l]) => html`<option value="${v}" ${rule.kind === v ? "selected" : ""}>${l}</option>`)}</select></div>
      <div class="field" data-guy data-sec><label id="sec-val-lbl">Amount</label><input class="input" name="sec_value" inputmode="decimal" value="${rule.value}"></div>
      <div class="field" data-guy data-sec><label>Stop after total of (Rs)</label><input class="input" name="sec_cap" inputmode="decimal" value="${rule.cap}" placeholder="No cap"><span class="hint">Lifetime cap on security held</span></div>

      <div class="form-section">Starting balance</div>
      <div class="field full"><label for="ef-open">Balance brought forward (Rs)</label><input class="input" id="ef-open" name="opening_balance" inputmode="decimal" value="${fromCents(e.opening_balance)}" placeholder="0">
        <span class="hint">From the old spreadsheet at the start date (a manager's last master balance, or money a guy still owes as a negative number). It is used only until the first month is calculated.</span></div>

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
  // Candidates for "Reports to": active staff strictly senior to the chosen position (never the person themselves).
  const currentUpline = e.upline_id || e.manager_id || "";
  const fillUpline = (keep) => {
    const rank = levelRank(f.staff_level.value);
    const top = rank === LEVELS.length - 1;
    const sel = f.upline_id;
    const want = keep ?? sel.value;
    const cands = staff.filter((s) => s.status === "active" && s.employee_id !== e.employee_id && levelRank(s.staff_level || (s.role === "manager" ? "manager" : "distributor")) > rank);
    sel.innerHTML = `<option value="">${top ? "Not applicable (top of the chain)" : cands.length ? "Not set yet" : "No one senior to this position yet"}</option>` +
      cands.map((s) => `<option value="${s.employee_id}">${s.name} · ${levelLabel(s.staff_level)} · ${s.hub}</option>`).join("");
    sel.value = cands.some((s) => s.employee_id === want) ? want : "";
    sel.disabled = top;
  };
  const sync = () => {
    const guy = !isManagerLevel(f.staff_level.value);
    $$("[data-guy]", f).forEach((x) => (x.hidden = !guy));
    $("#basic-hint", f).hidden = guy;
    const tiered = f.pay_scheme.value === "tiered";
    $$("[data-tiered]", f).forEach((x) => (x.hidden = !guy || !tiered));
    $("#basic-lbl", f).textContent = !guy ? "Basic salary (Rs / month)" : tiered ? "Fixed basic when target is exceeded (Rs / month)" : "Basic pay (Rs / month)";
    const k = f.sec_kind.value;
    $$("[data-sec]", f).forEach((x) => (x.hidden = !guy || k === "none"));
    $("#sec-val-lbl", f).textContent = k === "fixed" ? "Amount (Rs / month)" : "Percentage (%)";
  };
  // New staff start from the position's pay defaults (Settings); every field stays editable for this person.
  const applyDefaults = () => {
    const d = positionDefaults(state.settings)[f.staff_level.value];
    if (!d) return;
    const rule = parseRule(d.security_deduction_rule);
    const set = (n, v) => { f[n].value = v || ""; };
    f.pay_scheme.value = d.pay_scheme || "over_target";
    set("target", d.target); set("basic_pay", d.basic_pay);
    set("commission_pct", d.commission_rate ? +(d.commission_rate * 100).toFixed(4) : "");
    set("base_commission_pct", d.base_commission_rate ? +(d.base_commission_rate * 100).toFixed(4) : "");
    set("food_per_day", d.food_per_day); set("food_min_days", d.food_min_days);
    f.sec_kind.value = rule.kind; set("sec_value", rule.value); set("sec_cap", rule.cap);
  };
  fillUpline(currentUpline);
  if (!existing) applyDefaults();
  f.addEventListener("change", (ev) => { if (ev.target === f.staff_level) { fillUpline(); if (!existing) applyDefaults(); } sync(); });
  sync();

  $("#ef-save", d.panel).onclick = (ev) => busy(ev.currentTarget, async () => {
    const v = Object.fromEntries(new FormData(f));
    const guy = !isManagerLevel(v.staff_level);
    const secRule = !guy || v.sec_kind === "none" ? "none" : `${v.sec_kind}:${v.sec_value || 0}${v.sec_cap ? `;cap:${v.sec_cap}` : ""}`;
    const tiered = guy && v.pay_scheme === "tiered";
    const body = {
      name: v.name, staff_level: v.staff_level, upline_id: v.upline_id || "", hub: f.hub.value, phone: v.phone, nic: v.nic, join_date: v.join_date, status: v.status,
      ...(guy ? {} : { manager_id: "" }), basic_pay: v.basic_pay || 0, target: guy ? v.target || 0 : 0,
      commission_rate: guy && v.commission_pct ? Number(v.commission_pct) / 100 : 0, security_deduction_rule: secRule,
      pay_scheme: tiered ? "tiered" : "over_target",
      base_commission_rate: tiered && v.base_commission_pct ? Number(v.base_commission_pct) / 100 : 0,
      food_per_day: tiered ? v.food_per_day || 0 : 0, food_min_days: tiered ? Number(v.food_min_days) || 0 : 0,
      opening_balance: v.opening_balance || 0,
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
        <div><h1>Employees</h1><p>${staff.filter((s) => s.status === "active").length} active · ${LEVELS.map(([v]) => [staff.filter((s) => s.staff_level === v && s.status === "active").length, v]).filter(([n]) => n)
          .map(([n, v]) => `${n} ${levelLabel(v, n).toLowerCase()}`).join(" · ")}</p></div>
        <div class="actions">${can("manage_staff") || can("manage_team") ? html`<button class="btn primary" id="add" ${state.hubs.length ? "" : "disabled"}>${icon("plus")} Add employee</button>` : ""}</div>
      </div>
      ${!state.hubs.length ? html`<div class="alert warn mb-4">${icon("alert")}<div>Create at least one hub before adding employees. <a href="/hubs" data-link>Go to hubs →</a></div></div>` : ""}
      <div class="card">
        <div class="card-head">
          <div class="row">
            <div class="search"><span>${icon("search")}</span><input class="input sm" id="q" aria-label="Search employees" placeholder="Search name, ID, phone" value="${filters.q}" style="width:240px"></div>
            <select class="input sm" id="role" aria-label="Filter by position" style="width:auto"><option value="">All positions</option>${LEVELS.map(([v, l]) => html`<option value="${v}" ${filters.role === v ? "selected" : ""}>${l}</option>`)}</select>
            <div class="seg" id="st">${[["active", "Active"], ["inactive", "Inactive"], ["", "All"]].map(([v, l]) => html`<button data-v="${v}" class="${filters.status === v ? "on" : ""}">${l}</button>`)}</div>
          </div>
        </div>
        <div class="card-body flush" id="list"></div>
      </div>`;

    const draw = () => {
      const q = filters.q.toLowerCase();
      const rows = staff.filter((s) => (!filters.role || s.staff_level === filters.role) && (!filters.status || s.status === filters.status) &&
        (!q || [s.name, s.employee_id, s.phone || "", s.nic || ""].some((x) => x.toLowerCase().includes(q))));
      $("#list").innerHTML = staff.length ? dataTable({
        rows, empty: "No employees match these filters", cls: "people", rowAction: "", rowLabel: (s) => `Open ${s.name}`,
        onRow: (s) => navigate(`/employees/${encodeURIComponent(s.employee_id)}`),
        cols: [
          { key: "name", label: "Employee", render: (s) => html`<div class="who"><div class="avatar" style="${s.role === "manager" ? "background:var(--accent)" : ""}">${initials(s.name)}</div><div><b>${s.name}</b><span>${s.employee_id}${s.phone ? html`<span class="phone"> · ${s.phone}</span>` : ""}</span></div></div>` },
          { key: "staff_level", label: "Position", render: (s) => badge(s.role, levelLabel(s.staff_level)) },
          { key: "hub", label: "Hub", render: (s) => hubName(s.hub) },
          { key: "upline_id", label: "Reports to", render: (s) => { const u = s.upline_id || s.manager_id; return u ? byId[u]?.name || u : html`<span class="faint">—</span>`; } },
          { key: "basic_pay", label: "Basic", align: "r", render: (s) => s.role === "guy" || s.basic_pay ? money(s.basic_pay) : html`<span class="faint">—</span>` },
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
