import { get, post, put, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, badge, toast, busy, drawer, emptyState, compact, money, LEVELS, levelLabel } from "../ui.js";
import { loadHubData, hubInfo, plural } from "../hubinfo.js";

export default {
  filters: "month", // all hubs are listed here, so the hub choice is not shown; the month still is
  title: "Hubs",
  async render(ctx) {
    const { el } = ctx;
    const pay = can("view_pay");
    const dashP = get("/api/dashboard" + qs({ period: state.period })); // one request feeds both the cards and the totals
    const [data, dash] = await Promise.all([loadHubData(state.period, pay, dashP), dashP]);
    const { hubs, staff } = data;
    state.hubs = hubs;
    const stats = Object.fromEntries(dash.by_hub.map((h) => [h.code, h]));
    const monthLabel = new Date(state.period + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const info = hubInfo(data, state.period);
    const totals = {
      people: Object.values(info).reduce((t, x) => t + x.active.length, 0),
      sales: Object.values(info).reduce((t, x) => t + x.sales, 0),
      attention: Object.values(info).reduce((t, x) => t + x.attention.reduce((n, a) => n + a[2], 0), 0),
      hubsWithIssues: Object.values(info).filter((x) => x.attention.length).length,
    };

    el.innerHTML = html`
      <div class="page-head hubs-page">
        <div><h1>Hubs</h1><p>The places where distributors, supervisors and managers work. Figures are for ${monthLabel}.</p></div>
        <div class="actions">${can("manage_hubs") ? html`<button class="btn primary" id="add">${icon("plus")} Add hub</button>` : ""}</div>
      </div>
      ${hubs.length ? html`<div class="grid kpis hub-kpis mb-4">
        <div class="card kpi"><div class="label">Hubs</div><div class="value">${hubs.filter((h) => h.status === "active").length}</div><div class="foot">${hubs.length === 1 ? "1 hub in total" : `${hubs.length} hubs in total`}</div></div>
        <div class="card kpi"><div class="label">People</div><div class="value">${totals.people}</div><div class="foot">Active across all hubs</div></div>
        <div class="card kpi"><div class="label">Sales this month</div><div class="value"><span class="v-full"><small>Rs</small>${money(totals.sales)}</span><span class="v-short">${compact(totals.sales)}</span></div><div class="foot">From the daily sheets</div></div>
        <div class="card kpi"><div class="label">Needs attention</div><div class="value ${totals.attention ? "neg" : ""}">${totals.attention}</div><div class="foot">${totals.attention ? `Items in ${plural(totals.hubsWithIssues, "hub", "hubs")}` : "All hubs are clear"}</div></div>
      </div>` : ""}
      <div class="grid three" id="cards"></div>`;

    $("#cards").innerHTML = hubs.length ? hubs.map((h) => {
      const x = info[h.code];
      const st = stats[h.code] || {};
      return html`<article class="card hubc" aria-label="${h.name}">
        <header class="hubc-head"><span class="icon blue hubc-ic" aria-hidden="true">${icon("store")}</span>
          <div class="hubc-title"><h2><a href="/hubs/${encodeURIComponent(h.code)}" data-link class="hub-link">${h.name}</a></h2><div class="sub">${h.code}<span class="hubc-addr">${h.location ? ` · ${h.location}` : ""}${h.phone ? ` · ${h.phone}` : ""}</span></div></div>${h.status !== "active" ? badge(h.status) : ""}</header>
        <div class="hubc-body">
          <div class="hubc-people"><b>${plural(x.active.length, "person", "people")}</b><span class="muted">${x.head ? `Coacher: ${x.head.name}` : "No coacher yet"}</span></div>
          <div class="muted hubc-levels">${x.levels.map(([v, n]) => `${n} ${levelLabel(v, n).toLowerCase()}`).join(" · ") || "Nobody yet"}${x.all.length > x.active.length ? ` · ${x.all.length - x.active.length} inactive` : ""}</div>
          <dl class="hubc-nums ${pay ? "" : "one"}">
            <div><dt>Sales</dt><dd class="num">${compact(x.sales)}</dd></div>
            ${pay ? html`<div><dt>Gross pay</dt><dd class="num">${compact(st.gross_pay || 0)}</dd></div>
` : ""}</dl>
          <div class="hubc-chips" role="list" aria-label="Needs attention in ${h.name}">${x.attention.length
            ? x.attention.map(([tone, text]) => html`<span role="listitem" class="badge ${tone}">${text}</span>`)
            : html`<span role="listitem" class="badge green">All clear</span>`}</div>
          ${x.joined || x.left ? html`<div class="muted hubc-month">This month: ${[x.joined ? `${x.joined} joined` : "", x.left ? `${x.left} left` : ""].filter(Boolean).join(" · ")}</div>` : ""}
        </div>
        <footer class="hubc-foot"><a class="btn primary" href="/hubs/${encodeURIComponent(h.code)}" data-link>${icon("users")} Open hub</a>${can("manage_hubs") ? html`<button class="btn" data-edit="${h.code}" aria-label="Edit ${h.name}">${icon("edit")} <span class="hubc-edit-lbl">Edit</span></button>` : ""}</footer>
      </article>`;
    }).join("") : html`<div class="card hubs-empty">${emptyState("No hubs yet", "Create your first hub to start adding employees.", "store")}</div>`.toString();

    const open = (h) => {
      const d = drawer({
        title: h ? `Edit ${h.name}` : "Add hub",
        body: html`<form id="hf" class="form-grid" novalidate>
          <div class="field"><label for="hf-code">Code <span class="req">(required)</span></label><input class="input" id="hf-code" name="code" value="${h?.code || ""}" ${h ? "disabled" : ""} placeholder="e.g. COL10" required autocomplete="off" aria-describedby="hf-code-h"><span class="hint" id="hf-code-h">A short unique code. It cannot be changed later.</span></div>
          <div class="field"><label for="hf-name">Name <span class="req">(required)</span></label><input class="input" id="hf-name" name="name" value="${h?.name || ""}" required autocomplete="off"></div>
          <div class="field"><label for="hf-loc">Location</label><input class="input" id="hf-loc" name="location" value="${h?.location || ""}" autocomplete="off"></div>
          <div class="field"><label for="hf-phone">Phone</label><input class="input" id="hf-phone" name="phone" type="tel" inputmode="tel" value="${h?.phone || ""}" autocomplete="off"></div>
          <div class="field"><label for="hf-status">Status</label><select class="input" id="hf-status" name="status"><option value="active">Active</option><option value="inactive" ${h?.status === "inactive" ? "selected" : ""}>Inactive</option></select><span class="hint">Inactive hubs stay in the records but are hidden from new work.</span></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="hf-save">Save</button>`,
      });
      $("#hf-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#hf", d.panel)));
        if (!h && !String(v.code || "").trim()) { $("#hf-code", d.panel).setAttribute("aria-invalid", "true"); $("#hf-code", d.panel).focus(); throw new Error("Enter a short code for the hub"); }
        if (!String(v.name || "").trim()) { $("#hf-name", d.panel).setAttribute("aria-invalid", "true"); $("#hf-name", d.panel).focus(); throw new Error("Enter the hub's name"); }
        if (h) await put(`/api/hubs/${encodeURIComponent(h.code)}`, v); else await post("/api/hubs", v);
        toast("Hub saved"); d.close(); this.render(ctx);
      });
    };
    $("#add")?.addEventListener("click", () => open(null));
    el.onclick = (e) => { const b = e.target.closest("[data-edit]"); if (b) open(hubs.find((h) => h.code === b.dataset.edit)); };
  },
};
