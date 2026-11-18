import { get, post, put } from "../api.js";
import { state } from "../app.js";
import { $, html, icon, badge, toast, busy, drawer, dataTable, initials, ago, LEVELS } from "../ui.js";
const LV = Object.fromEntries(LEVELS);

const ROLES = [
  ["staff", "Staff portal", "A distributor or supervisor signs in to see their own sales, pay and payslips, and to record their sales. A coacher or a manager who is chosen here automatically gets the coacher or manager login below"],
  ["coacher", "Coacher (hub head)", "Heads one hub and sees all of it: every person, all stock and sheets. Gives stock out, marks and confirms the days, registers the team. Never sees pay"],
  ["manager", "Manager", "Sees only the people who report to them: their sales, stock and details, view only. Never sees pay. A manager tagged as stock keeper can also handle the stock of the whole hub"],
  ["admin", "Admin", "Everything, including finalizing months, users and settings"],
];
const roleBadge = (r) => badge(r === "admin" ? "admin" : "green", ROLES.find((x) => x[0] === r)?.[1] || r);

export default {
  title: "Users & roles",
  async render(ctx) {
    const { el } = ctx;
    const [users, allStaff] = await Promise.all([get("/api/users"), get("/api/staff")]);
    const linked = new Set(users.map((x) => x.employee_id).filter(Boolean));
    const free = allStaff.filter((s) => s.status === "active" && !linked.has(s.employee_id));
    const byId = Object.fromEntries(allStaff.map((s) => [s.employee_id, s]));
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Users & roles</h1><p>Who can sign in, and what they are allowed to do.</p></div>
        <div class="actions"><button class="btn" id="bulk">${icon("users")} Create logins for employees</button><button class="btn primary" id="add">${icon("plus")} Add user</button></div>
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
          ${u && (u.role === "staff" || u.role === "manager") ? html`<div class="field full"><span class="lbl">Role</span>
            <div class="alert info">${icon("info")}<div><b>${ROLES.find((x) => x[0] === u.role)[1]}</b> for ${byId[u.employee_id]?.name || u.employee_id} (${u.employee_id}). The role and the employee cannot be changed; create a new user for a different person.</div></div></div>`
          : html`<div class="field full"><span class="lbl">Role</span>
            <div class="grid halves" style="gap:8px;margin-top:4px">${ROLES.filter(([k]) => k !== "manager").map(([k, l, desc]) => html`
              <label class="card" style="padding:10px 12px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;box-shadow:none">
                <input type="radio" name="role" value="${k}" ${(u?.role || "staff") === k ? "checked" : ""} ${self ? "disabled" : ""} style="margin-top:3px">
                <span><b style="color:var(--text)">${l}</b><br><span class="faint" style="font-weight:400">${desc}</span></span></label>`)}</div>
            ${self ? html`<span class="hint">You can't change your own role.</span>` : ""}</div>
          <div class="field full" id="emp-wrap" hidden><label for="emp-sel" id="emp-lbl">Employee</label>
            <select class="input" id="emp-sel" name="employee_id"><option value="">Choose the person this login is for</option>
              ${free.map((s) => html`<option value="${s.employee_id}" data-level="${s.staff_level}">${s.name} · ${LV[s.staff_level] || s.staff_level} · ${s.employee_id} · ${s.hub}`)}</select>
            <span class="hint" id="emp-hint">Every active employee without a login is listed. The login takes that person's hub and shows their own page. Choosing a coacher gives the coacher login; choosing a manager or promoting manager gives the manager login.</span></div>`}
          <div class="field" id="hub-wrap" ${u && (u.role === "staff" || u.role === "manager") ? "hidden" : ""}><label>Hub access</label><select class="input" name="hub"><option value="">All hubs</option>
            ${state.hubs.map((h) => html`<option value="${h.code}" ${u?.hub === h.code ? "selected" : ""}>${h.name} only</option>`)}</select>
            <span class="hint">Required for a coacher: they see only that hub. An admin can see all hubs.</span></div>
          ${u ? html`<div class="field"><label>Status</label><select class="input" name="status" ${self ? "disabled" : ""}><option value="active">Active</option><option value="disabled" ${u.status === "disabled" ? "selected" : ""}>Disabled</option></select></div>` : ""}
          <div class="field full"><label>${u ? "Set a new password" : "Initial password"}</label><input class="input" type="password" name="password" autocomplete="new-password" placeholder="${u ? "Leave blank to keep the current one" : ""}">
            <span class="hint">At least 8 characters with letters and numbers.${u ? " Setting a new one signs the user out everywhere." : ""}</span></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="uf-save">${u ? "Save" : "Create user"}</button>`,
      });
      const syncRole = () => {
        const r = $("#uf", d.panel).querySelector("input[name=role]:checked")?.value;
        const ew = $("#emp-wrap", d.panel);
        if (ew) {
          ew.hidden = !(r === "staff" || (r === "coacher" && !u));
          const o = ew.querySelector("option");
          if (o) o.textContent = r === "coacher" ? "Not linked (no My page)" : "Choose the person this login is for";
          $("#emp-lbl", d.panel).textContent = r === "coacher" ? "Coacher's own record (optional)" : "Employee";
          // a coacher login can only be linked to a coacher
          ew.querySelectorAll("option[data-level]").forEach((x) => { x.hidden = r === "coacher" && x.dataset.level !== "coacher"; x.disabled = x.hidden; });
          const sel = $("#emp-sel", d.panel);
          if (sel.selectedOptions[0]?.disabled) sel.value = "";
        }
        const hw = $("#hub-wrap", d.panel);
        if (hw) hw.hidden = r === "staff" || (u && (u.role === "staff" || u.role === "manager"));
      };
      $("#uf", d.panel).addEventListener("change", (ev) => {
        if (ev.target.name === "role") syncRole();
        if (ev.target.name === "employee_id" && !u) { // the mobile number becomes the username, unless one was already typed
          const f = $("#uf", d.panel), s = byId[ev.target.value], digits = String(s?.phone || "").replace(/\D/g, "");
          if (s && digits && !f.username.value) f.username.value = digits;
          if (s && !f.full_name.value) f.full_name.value = s.name;
        }
      });
      syncRole();
      $("#uf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#uf", d.panel)));
        if (!u && v.employee_id) v.full_name = v.full_name || byId[v.employee_id]?.name || "";
        if (u) {
          const body = { full_name: v.full_name, hub: v.hub };
          if (!self) { body.role = v.role; body.status = v.status; }
          if (v.password) body.password = v.password;
          await put(`/api/users/${encodeURIComponent(u.username)}`, body);
        } else { if (!v.employee_id) delete v.employee_id; await post("/api/users", v); }
        toast("User saved"); d.close(); this.render(ctx);
      });
    };

    $("#list").innerHTML = dataTable({
      rows: users,
      onRow: (u) => open(u),
      card: (u) => html`<span class="mc-main"><b>${u.full_name}</b><span class="mc-sub">${u.username}${u.role === "staff" || u.role === "manager" ? ` · ${u.employee_id}` : u.hub ? ` · ${u.hub} only` : " · all hubs"} · last sign-in ${ago(u.last_login_at)}</span></span>
        <span class="mc-end">${roleBadge(u.role)}<br>${badge(u.status)}</span>`,
      cols: [
        { key: "full_name", label: "User", render: (u) => html`<div class="who"><div class="avatar">${initials(u.full_name)}</div><div><b>${u.full_name}</b><span>${u.username}</span></div></div>` },
        { key: "role", label: "Role", render: (u) => html`${roleBadge(u.role)}${u.stock_keeper ? html` ${badge("amber", "Stock keeper")}` : ""}` },
        { key: "hub", label: "Hub access", render: (u) => (u.role === "staff" || u.role === "manager" ? html`<span class="badge plain">${u.employee_id}</span>` : u.hub ? html`<span class="badge plain">${u.hub} only</span>` : html`<span class="faint">All hubs</span>`) },
        { key: "last_login_at", label: "Last sign-in", render: (u) => ago(u.last_login_at) },
        { key: "status", label: "Status", render: (u) => badge(u.status) },
      ],
    }).toString();
    $("#add").onclick = () => open(null);

    // One step for many people: every active employee without a login gets one, the mobile number being the username.
    const A = "abcdefghjkmnpqrstuvwxyz", N = "23456789";
    const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join("");
    const makePw = () => pick(A, 4) + pick(N, 4);
    const digits = (v) => String(v || "").replace(/\D/g, "");
    $("#bulk").onclick = () => {
      const cands = free.map((x) => ({ ...x, user: digits(x.phone) })).sort((a, b) => a.name.localeCompare(b.name));
      const d = drawer({
        title: "Create logins for employees",
        body: html`<div id="bk">
          ${cands.length ? html`
          <p class="muted" style="margin-top:0">Each person signs in with their <b>mobile number</b> as the username. A coacher gets the whole hub; a manager or promoting manager sees only their own people. Tick who should get a login, choose how passwords are set, then create.</p>
          <div class="field"><label>Passwords</label>
            <select class="input" id="bk-mode"><option value="gen">A different random password for each person</option><option value="same">The same starting password for everyone</option></select></div>
          <div class="field" id="bk-same-wrap" hidden><label>Starting password</label><input class="input" id="bk-same" type="text" autocomplete="off" placeholder="At least 8 characters, letters and numbers"></div>
          <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="bk-all" checked> Select all with a mobile number</label>
          <div style="max-height:46vh;overflow:auto;border:1px solid var(--border,#e5e7eb);border-radius:10px">
            <table class="table" style="width:100%"><thead><tr><th scope="col"></th><th scope="col">Employee</th><th scope="col">Username</th></tr></thead><tbody>
            ${cands.map((x, i) => html`<tr><td><input type="checkbox" class="bk-row" data-i="${i}" ${x.user.length >= 3 ? "checked" : "disabled"} aria-label="Create a login for ${x.name}"></td>
              <td><b>${x.name}</b><br><span class="faint" style="font-size:14px">${LV[x.staff_level] || x.staff_level} · ${x.employee_id} · ${x.hub}</span></td>
              <td>${x.user.length >= 3 ? x.user : html`<span class="faint">no mobile number</span>`}</td></tr>`)}
            </tbody></table></div>` : html`<div class="alert info">${icon("info")}<div>Every active employee already has a login.</div></div>`}
        </div>`.toString(),
        foot: `<button class="btn" data-close>Close</button>${cands.length ? '<button class="btn primary" id="bk-go">Create logins</button>' : ""}`,
      });
      if (!cands.length) return;
      const body = $("#bk", d.panel), all = $("#bk-all", d.panel);
      $("#bk-mode", d.panel).onchange = (e) => { $("#bk-same-wrap", d.panel).hidden = e.target.value !== "same"; };
      all.onchange = () => d.panel.querySelectorAll(".bk-row:not(:disabled)").forEach((c) => { c.checked = all.checked; });
      $("#bk-go", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const chosen = [...d.panel.querySelectorAll(".bk-row:checked")].map((c) => cands[+c.dataset.i]);
        if (!chosen.length) throw new Error("Tick at least one person");
        const same = $("#bk-mode", d.panel).value === "same", sp = $("#bk-same", d.panel).value;
        if (same && !(sp.length >= 8 && /[A-Za-z]/.test(sp) && /\d/.test(sp))) throw new Error("The starting password needs at least 8 characters with letters and numbers");
        const out = [];
        for (const x of chosen) {
          const pw = same ? sp : makePw();
          try { await post("/api/users", { username: x.user, full_name: x.name, role: "staff", employee_id: x.employee_id, password: pw }); out.push([x, x.user, pw, ""]); }
          catch (err) { out.push([x, x.user, "", err.message]); }
        }
        const ok = out.filter((r) => !r[3]);
        body.innerHTML = html`<div class="alert ${ok.length ? "info" : "warn"}">${icon("info")}<div><b>${ok.length} login${ok.length === 1 ? "" : "s"} created${out.length > ok.length ? `, ${out.length - ok.length} failed` : ""}.</b> Passwords are shown only now. Copy or print this list and hand each person their own.</div></div>
          <div style="overflow:auto;margin-top:10px"><table class="table" style="width:100%"><thead><tr><th scope="col">Employee</th><th scope="col">Username</th><th scope="col">Password</th></tr></thead><tbody>
          ${out.map(([x, u, pw, err]) => html`<tr><td>${x.name}</td><td class="mono">${u}</td><td class="mono">${err ? html`<span class="neg">${err}</span>` : pw}</td></tr>`)}</tbody></table></div>`.toString();
        const foot = d.panel.querySelector(".drawer-foot");
        foot.innerHTML = `<button class="btn" data-close>Done</button><button class="btn" id="bk-copy">Copy list</button><button class="btn primary" id="bk-print">Print</button>`;
        const lines = ok.map(([x, u, pw]) => `${x.name}\t${u}\t${pw}`).join("\n");
        $("#bk-copy", d.panel).onclick = async () => { try { await navigator.clipboard.writeText("Employee\tUsername\tPassword\n" + lines); toast("List copied"); } catch { toast("Could not copy; select the table and copy it", "err"); } };
        $("#bk-print", d.panel).onclick = () => window.print();
        foot.querySelector("[data-close]").addEventListener("click", () => this.render(ctx));
      });
    };
  },
};
