import { get, post, put } from "../api.js";
import { state } from "../app.js";
import { $, html, icon, badge, toast, busy, drawer, dataTable, initials, ago } from "../ui.js";

const ROLES = [
  ["staff", "Staff portal", "A distributor, supervisor or group manager who signs in to see their own sales, pay and payslips"],
  ["admin", "Admin", "Everything, including finalizing months, users and settings"],
  ["accountant", "Accountant", "Run payroll, approve exceptions, manage staff and hubs, export files"],
  ["manager", "Hub manager", "Enter sheets and register the team of their own hub"],
  ["clerk", "Clerk", "Enter daily, weekly, stock and allowance sheets"],
  ["viewer", "Viewer", "Read-only access to dashboards, payroll and reports"],
];
const roleBadge = (r) => badge(r === "admin" ? "admin" : r === "accountant" ? "blue" : r === "clerk" || r === "manager" || r === "staff" ? "green" : "", ROLES.find((x) => x[0] === r)?.[1] || r);

export default {
  title: "Users & roles",
  async render(ctx) {
    const { el } = ctx;
    const [users, allStaff] = await Promise.all([get("/api/users"), get("/api/staff")]);
    const linked = new Set(users.map((x) => x.employee_id).filter(Boolean));
    const free = allStaff.filter((s) => s.role === "guy" && s.status === "active" && !linked.has(s.employee_id));
    const byId = Object.fromEntries(allStaff.map((s) => [s.employee_id, s]));
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Users & roles</h1><p>Who can sign in, and what they are allowed to do.</p></div>
        <div class="actions"><button class="btn primary" id="add">${icon("plus")} Add user</button></div>
      </div>
      <div class="grid kpis mb-4">${ROLES.map(([k, , d]) => html`
        <div class="card kpi"><div class="label">${roleBadge(k)}</div>
          <div class="value">${users.filter((u) => u.role === k && u.status === "active").length}</div><div class="foot">${d}</div></div>`)}</div>
      <div class="card"><div class="card-body flush" id="list"></div></div>`;

    const open = (u) => {
      const self = u && u.username.toLowerCase() === state.user.username.toLowerCase();
      const d = drawer({
        title: u ? `Edit ${u.full_name}` : "Add user",
        body: html`<form id="uf" class="form-grid" autocomplete="off">
          <div class="field"><label>Username</label><input class="input" name="username" value="${u?.username || ""}" ${u ? "disabled" : ""} autocomplete="off"></div>
          <div class="field"><label>Full name</label><input class="input" name="full_name" value="${u?.full_name || ""}"></div>
          ${u?.role === "staff" ? html`<div class="field full"><span class="lbl">Role</span>
            <div class="alert info">${icon("info")}<div><b>Staff portal</b> for ${byId[u.employee_id]?.name || u.employee_id} (${u.employee_id}). The role and the employee cannot be changed; create a new user for a different person.</div></div></div>`
          : html`<div class="field full"><span class="lbl">Role</span>
            <div class="grid halves" style="gap:8px;margin-top:4px">${ROLES.map(([k, l, desc]) => html`
              <label class="card" style="padding:10px 12px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;box-shadow:none">
                <input type="radio" name="role" value="${k}" ${(u?.role || "clerk") === k ? "checked" : ""} ${self ? "disabled" : ""} style="margin-top:3px">
                <span><b style="color:var(--text)">${l}</b><br><span class="faint" style="font-weight:400">${desc}</span></span></label>`)}</div>
            ${self ? html`<span class="hint">You can't change your own role.</span>` : ""}</div>
          <div class="field full" id="emp-wrap" hidden><label for="emp-sel">Employee</label>
            <select class="input" id="emp-sel" name="employee_id"><option value="">Choose the person this login is for</option>
              ${free.map((s) => html`<option value="${s.employee_id}">${s.name} · ${s.employee_id} · ${s.hub}`)}</select>
            <span class="hint">Only active distributors, supervisors and group managers without a login are listed. The login gets that person's hub.</span></div>`}
          <div class="field" id="hub-wrap" ${u?.role === "staff" ? "hidden" : ""}><label>Hub access</label><select class="input" name="hub"><option value="">All hubs</option>
            ${state.hubs.map((h) => html`<option value="${h.code}" ${u?.hub === h.code ? "selected" : ""}>${h.name} only</option>`)}</select>
            <span class="hint">Required for a hub manager. Limits a clerk to one hub's staff.</span></div>
          ${u ? html`<div class="field"><label>Status</label><select class="input" name="status" ${self ? "disabled" : ""}><option value="active">Active</option><option value="disabled" ${u.status === "disabled" ? "selected" : ""}>Disabled</option></select></div>` : ""}
          <div class="field full"><label>${u ? "Set a new password" : "Initial password"}</label><input class="input" type="password" name="password" autocomplete="new-password" placeholder="${u ? "Leave blank to keep the current one" : ""}">
            <span class="hint">At least 8 characters with letters and numbers.${u ? " Setting a new one signs the user out everywhere." : ""}</span></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="uf-save">${u ? "Save" : "Create user"}</button>`,
      });
      const syncRole = () => {
        const r = $("#uf", d.panel).querySelector("input[name=role]:checked")?.value;
        const ew = $("#emp-wrap", d.panel);
        if (ew) ew.hidden = r !== "staff";
        const hw = $("#hub-wrap", d.panel);
        if (hw) hw.hidden = r === "staff" || u?.role === "staff";
      };
      $("#uf", d.panel).addEventListener("change", (ev) => { if (ev.target.name === "role") syncRole(); });
      syncRole();
      $("#uf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#uf", d.panel)));
        if (v.role === "staff" && !u) v.full_name = v.full_name || byId[v.employee_id]?.name || "";
        if (u) {
          const body = { full_name: v.full_name, hub: v.hub };
          if (!self) { body.role = v.role; body.status = v.status; }
          if (v.password) body.password = v.password;
          await put(`/api/users/${encodeURIComponent(u.username)}`, body);
        } else await post("/api/users", v);
        toast("User saved"); d.close(); this.render(ctx);
      });
    };

    $("#list").innerHTML = dataTable({
      rows: users,
      onRow: (u) => open(u),
      card: (u) => html`<span class="mc-main"><b>${u.full_name}</b><span class="mc-sub">${u.username}${u.role === "staff" ? ` · ${u.employee_id}` : u.hub ? ` · ${u.hub} only` : " · all hubs"} · last sign-in ${ago(u.last_login_at)}</span></span>
        <span class="mc-end">${roleBadge(u.role)}<br>${badge(u.status)}</span>`,
      cols: [
        { key: "full_name", label: "User", render: (u) => html`<div class="who"><div class="avatar">${initials(u.full_name)}</div><div><b>${u.full_name}</b><span>${u.username}</span></div></div>` },
        { key: "role", label: "Role", render: (u) => roleBadge(u.role) },
        { key: "hub", label: "Hub access", render: (u) => (u.role === "staff" ? html`<span class="badge plain">${u.employee_id}</span>` : u.hub ? html`<span class="badge plain">${u.hub} only</span>` : html`<span class="faint">All hubs</span>`) },
        { key: "last_login_at", label: "Last sign-in", render: (u) => ago(u.last_login_at) },
        { key: "status", label: "Status", render: (u) => badge(u.status) },
      ],
    }).toString();
    $("#add").onclick = () => open(null);
  },
};
