import { get, post, put, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, badge, toast, busy, drawer, emptyState, compact, initials } from "../ui.js";

export default {
  title: "Hubs",
  async render(ctx) {
    const { el } = ctx;
    const [hubs, staff, dash] = await Promise.all([get("/api/hubs"), get("/api/staff"), get("/api/dashboard" + qs({ period: state.period }))]);
    state.hubs = hubs;
    const stats = Object.fromEntries(dash.by_hub.map((h) => [h.code, h]));

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Hubs</h1><p>Branches that guys and managers work from. Business figures are for ${new Date(state.period + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}.</p></div>
        <div class="actions">${can("manage_hubs") ? html`<button class="btn primary" id="add">${icon("plus")} Add hub</button>` : ""}</div>
      </div>
      <div class="grid three" id="cards"></div>`;

    $("#cards").innerHTML = hubs.length ? hubs.map((h) => {
      const people = staff.filter((s) => s.hub === h.code && s.status === "active");
      const mgrs = people.filter((s) => s.role === "manager");
      const st = stats[h.code] || {};
      return html`<div class="card">
        <div class="card-head"><div class="row" style="gap:12px"><div class="kpi" style="padding:0"><span class="icon blue" style="width:40px;height:40px">${icon("store")}</span></div>
          <div><h2>${h.name}</h2><div class="sub">${h.code}${h.location ? ` · ${h.location}` : ""}</div></div></div>${badge(h.status)}</div>
        <div class="card-body">
          <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
            <div><div class="faint" style="font-size:11.5px">Business</div><b class="num">${compact(st.hub_business || 0)}</b></div>
            <div><div class="faint" style="font-size:11.5px">Gross pay</div><b class="num">${compact(st.gross_pay || 0)}</b></div>
            <div><div class="faint" style="font-size:11.5px">Mgr balance</div><b class="num ${st.manager_balance < 0 ? "neg" : ""}">${compact(st.manager_balance || 0)}</b></div>
          </div>
          <div class="row between"><div class="row" style="gap:4px">${people.slice(0, 6).map((p) => html`<div class="avatar" title="${p.name}" style="width:28px;height:28px;font-size:11px">${initials(p.name)}</div>`)}
            ${people.length > 6 ? html`<span class="faint">+${people.length - 6}</span>` : ""}</div>
            <span class="muted" style="font-size:12.5px">${people.length} staff · ${mgrs.map((m) => m.name).join(", ") || "no manager"}</span></div>
          ${h.phone ? html`<div class="faint" style="font-size:12px;margin-top:10px">${h.phone}</div>` : ""}
        </div>
        ${can("manage_hubs") ? html`<div style="padding:0 18px 16px"><button class="btn sm" data-edit="${h.code}">${icon("edit")} Edit</button></div>` : ""}
      </div>`;
    }).join("") : html`<div class="card" style="grid-column:1/-1">${emptyState("No hubs yet", "Create your first hub (branch) to start adding employees.", "store")}</div>`.toString();

    const open = (h) => {
      const d = drawer({
        title: h ? `Edit ${h.name}` : "Add hub",
        body: html`<form id="hf" class="form-grid">
          <div class="field"><label>Code</label><input class="input" name="code" value="${h?.code || ""}" ${h ? "disabled" : ""} placeholder="e.g. COL10" required><span class="hint">Short unique code, cannot be changed later</span></div>
          <div class="field"><label>Name</label><input class="input" name="name" value="${h?.name || ""}" required></div>
          <div class="field"><label>Location</label><input class="input" name="location" value="${h?.location || ""}"></div>
          <div class="field"><label>Phone</label><input class="input" name="phone" value="${h?.phone || ""}"></div>
          <div class="field"><label>Status</label><select class="input" name="status"><option value="active">Active</option><option value="inactive" ${h?.status === "inactive" ? "selected" : ""}>Inactive</option></select></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="hf-save">Save</button>`,
      });
      $("#hf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#hf", d.panel)));
        if (h) await put(`/api/hubs/${encodeURIComponent(h.code)}`, v); else await post("/api/hubs", v);
        toast("Hub saved"); d.close(); this.render(ctx);
      });
    };
    $("#add")?.addEventListener("click", () => open(null));
    el.onclick = (e) => { const b = e.target.closest("[data-edit]"); if (b) open(hubs.find((h) => h.code === b.dataset.edit)); };
  },
};
