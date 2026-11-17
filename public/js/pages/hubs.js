import { get, post, put, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, badge, toast, busy, drawer, emptyState, compact, LEVELS, levelLabel } from "../ui.js";

export default {
  title: "Hubs",
  async render(ctx) {
    const { el } = ctx;
    const pay = can("view_pay");
    const [hubs, staff, dash, live, queue] = await Promise.all([
      get("/api/hubs"), get("/api/staff"), get("/api/dashboard" + qs({ period: state.period })),
      get("/api/live" + qs({ period: state.period })).catch(() => ({ people: [] })),
      pay ? get("/api/review-queue").catch(() => []) : Promise.resolve([]),
    ]);
    state.hubs = hubs;
    const stats = Object.fromEntries(dash.by_hub.map((h) => [h.code, h]));
    const monthLabel = new Date(state.period + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    // Everything a hub card shows, worked out once per hub.
    const info = Object.fromEntries(hubs.map((h) => {
      const all = staff.filter((s) => s.hub === h.code);
      const active = all.filter((s) => s.status === "active");
      const sold = live.people.filter((p) => p.hub === h.code);
      const attention = [];
      const toReview = queue.filter((r) => r.hub === h.code && r.period === state.period).length;
      const unconfirmed = sold.reduce((t, p) => t + (p.unconfirmed || 0), 0);
      const noBank = active.filter((s) => !s.bank_account_no).length;
      const unverified = active.filter((s) => s.bank_account_no && s.bank_account_no !== s.bank_account_verified).length;
      if (toReview) attention.push(["red", plural(toReview, "pay line to review", "pay lines to review"), toReview]);
      if (unconfirmed) attention.push(["amber", plural(unconfirmed, "day to confirm", "days to confirm"), unconfirmed]);
      if (noBank) attention.push(["amber", plural(noBank, "person without a bank account", "people without a bank account"), noBank]);
      if (unverified) attention.push(["amber", plural(unverified, "unverified bank account", "unverified bank accounts"), unverified]);
      return [h.code, {
        all, active, attention,
        sales: sold.reduce((t, p) => t + p.business, 0),
        levels: LEVELS.slice().reverse().map(([v]) => [v, active.filter((s) => s.staff_level === v).length]).filter(([, n]) => n),
        head: active.find((s) => s.staff_level === "coacher"),
        joined: all.filter((s) => (s.join_date || "").startsWith(state.period)).length,
        left: all.filter((s) => (s.leave_date || "").startsWith(state.period)).length,
      }];
    }));
    const totals = {
      people: Object.values(info).reduce((t, x) => t + x.active.length, 0),
      sales: Object.values(info).reduce((t, x) => t + x.sales, 0),
      attention: Object.values(info).reduce((t, x) => t + x.attention.reduce((n, a) => n + a[2], 0), 0),
      hubsWithIssues: Object.values(info).filter((x) => x.attention.length).length,
    };

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Hubs</h1><p>Branches where distributors, supervisors and managers work. Figures are for ${monthLabel}.</p></div>
        <div class="actions">${can("manage_hubs") ? html`<button class="btn primary" id="add">${icon("plus")} Add hub</button>` : ""}</div>
      </div>
      ${hubs.length ? html`<div class="grid kpis mb-4">
        <div class="card kpi"><div class="label">Hubs</div><div class="value">${hubs.filter((h) => h.status === "active").length}</div><div class="foot">${hubs.length === 1 ? "1 hub in total" : `${hubs.length} hubs in total`}</div></div>
        <div class="card kpi"><div class="label">People</div><div class="value">${totals.people}</div><div class="foot">Active across all hubs</div></div>
        <div class="card kpi"><div class="label">Sales this month</div><div class="value">${compact(totals.sales)}</div><div class="foot">From the daily sheets</div></div>
        <div class="card kpi"><div class="label">Needs attention</div><div class="value ${totals.attention ? "neg" : ""}">${totals.attention}</div><div class="foot">${totals.attention ? `Items in ${plural(totals.hubsWithIssues, "hub", "hubs")}` : "All hubs are clear"}</div></div>
      </div>` : ""}
      <div class="grid three" id="cards"></div>`;

    $("#cards").innerHTML = hubs.length ? hubs.map((h) => {
      const x = info[h.code];
      const st = stats[h.code] || {};
      return html`<div class="card">
        <div class="card-head"><div class="row" style="gap:12px"><div class="kpi" style="padding:0"><span class="icon blue" style="width:40px;height:40px">${icon("store")}</span></div>
          <div><h2><a href="/hubs/${h.code}" data-link style="color:inherit;display:inline-block;min-height:24px;padding:2px 0">${h.name}</a></h2><div class="sub">${h.code}${h.location ? ` · ${h.location}` : ""}</div></div></div>${badge(h.status)}</div>
        <div class="card-body">
          <div class="row between" style="align-items:baseline;margin-bottom:6px"><b style="font-size:20px">${plural(x.active.length, "person", "people")}</b>
            <span class="muted" style="font-size:12.5px">${x.head ? `Head: ${x.head.name}` : "No coacher yet"}</span></div>
          <div class="muted" style="font-size:12.5px;margin-bottom:12px">${x.levels.map(([v, n]) => `${n} ${levelLabel(v, n).toLowerCase()}`).join(" · ") || "Nobody yet"}${x.all.length > x.active.length ? ` · ${x.all.length - x.active.length} inactive` : ""}</div>
          <div class="grid" style="grid-template-columns:repeat(${pay ? 3 : 1},1fr);gap:10px;margin-bottom:12px">
            <div><div class="faint" style="font-size:11.5px">Sales</div><b class="num">${compact(x.sales)}</b></div>
            ${pay ? html`<div><div class="faint" style="font-size:11.5px">Gross pay</div><b class="num">${compact(st.gross_pay || 0)}</b></div>
            <div><div class="faint" style="font-size:11.5px">Mgr balance</div><b class="num ${st.manager_balance < 0 ? "neg" : ""}">${compact(st.manager_balance || 0)}</b></div>` : ""}
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap" aria-label="Needs attention in ${h.name}">${x.attention.length
            ? x.attention.map(([tone, text]) => html`<span class="badge ${tone}">${text}</span>`)
            : html`<span class="badge green">All clear</span>`}</div>
          ${x.joined || x.left ? html`<div class="faint" style="font-size:12px;margin-top:10px">This month: ${[x.joined ? `${x.joined} joined` : "", x.left ? `${x.left} left` : ""].filter(Boolean).join(" · ")}</div>` : ""}
          ${h.phone ? html`<div class="faint" style="font-size:12px;margin-top:6px">${h.phone}</div>` : ""}
        </div>
        <div style="padding:0 18px 16px" class="row"><a class="btn sm primary" href="/hubs/${h.code}" data-link>${icon("users")} Open hierarchy &amp; members</a>${can("manage_hubs") ? html` <button class="btn sm" data-edit="${h.code}">${icon("edit")} Edit</button>` : ""}</div>
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
