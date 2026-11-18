// One hub: its whole reporting chain (coacher at the top down to distributors) and its members, with a switcher to move between hubs.
import { get, qs } from "../api.js";
import { state, can, navigate } from "../app.js";
import { $, html, icon, badge, compact, initials, levelRank, levelLabel, LEVELS, dataTable, emptyState } from "../ui.js";

const rankOf = (s) => levelRank(s.staff_level || (s.role === "manager" ? "manager" : "distributor"));

export default {
  title: "Hub",
  async render(ctx) {
    const { el, params } = ctx;
    const code = decodeURIComponent(params[0] || "");
    const [hubs, staff, live] = await Promise.all([get("/api/hubs"), get("/api/staff"), get("/api/live" + qs({ period: state.period, hub: code }))]);
    state.hubs = hubs;
    const hub = hubs.find((h) => h.code === code);
    if (!hub) { el.innerHTML = html`<div class="card">${emptyState("Hub not found", "It may have been removed.", "store")}</div>`.toString(); return; }

    const sales = Object.fromEntries(live.people.map((p) => [p.employee_id, p]));
    const members = staff.filter((s) => s.hub === code);
    const active = members.filter((s) => s.status === "active");
    const byId = Object.fromEntries(members.map((s) => [s.employee_id, s]));
    const up = (s) => s.upline_id || s.manager_id || null;
    // Everyone whose boss is in this hub hangs under that boss; anyone with no boss (or a boss elsewhere) is a top of the chain here.
    const kids = {};
    for (const s of active) { const u = up(s); const k = u && byId[u] && byId[u].status === "active" ? u : ""; (kids[k] = kids[k] || []).push(s); }
    for (const k in kids) kids[k].sort((a, b) => rankOf(b) - rankOf(a) || a.name.localeCompare(b.name));
    const total = (id) => (sales[id]?.business || 0) + (kids[id] || []).reduce((t, c) => t + total(c.employee_id), 0);
    const count = (id) => (kids[id] || []).reduce((t, c) => t + 1 + count(c.employee_id), 0);

    const node = (s, depth) => {
      const n = count(s.employee_id), own = sales[s.employee_id]?.business || 0;
      return html`<li class="cn-item">
        <a href="/employees/${s.employee_id}" data-link class="cn">
          <span class="avatar cn-av" aria-hidden="true">${initials(s.name)}</span>
          <span class="cn-who"><b>${s.name}</b> <span class="faint">${s.employee_id}</span><span class="cn-sub">${levelLabel(s.staff_level)}${n ? ` · ${n} below` : ""}</span></span>
          <span class="cn-sales"><b class="num">${compact(own)}</b><span>${n ? `team ${compact(total(s.employee_id))}` : "own sales"}</span></span>
        </a>
        ${(kids[s.employee_id] || []).length ? html`<ul class="cn-kids">${(kids[s.employee_id] || []).map((c) => node(c, depth + 1))}</ul>` : ""}
      </li>`;
    };
    const tops = kids[""] || [];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Overview</h1><p>${hub.name} · ${hub.code}${hub.location ? ` · ${hub.location}` : ""} · ${active.length} active ${active.length === 1 ? "member" : "members"} · sales ${compact(live.people.reduce((t, p) => t + p.business, 0))} this month</p></div>
        <div class="actions">
          ${can(["manage_staff", "manage_team"]) ? html`<a class="btn primary" href="/hubs/${encodeURIComponent(code)}/people" data-link>${icon("users")} People in this hub</a>` : ""}
        </div>
      </div>
      <div class="card mb-4 hubpage"><div class="card-head"><div><h2>Reporting chain</h2><div class="sub">Top of the chain first. Tap anyone to open their record.</div></div></div>
        <div class="card-body">${tops.length ? html`<ul class="cn-root">${tops.map((s) => node(s, 0))}</ul>` : emptyState("No members yet", "Add employees to this hub and set who each reports to.", "users")}</div></div>
      <div class="card hubpage"><div class="card-head"><div><h2>Members</h2><div class="sub">${members.length} in total, grouped by position</div></div></div><div class="card-body flush" id="mem"></div></div>`.toString();

    // Members are grouped by position, in chain order: coacher first, then promoting manager, manager, supervisor, distributor.
    const lvl = (s) => LEVELS.findIndex(([v]) => v === (s.staff_level || (s.role === "manager" ? "manager" : "distributor")));
    const ordered = [...members].sort((a, b) => lvl(b) - lvl(a) || (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || a.name.localeCompare(b.name));
    $("#mem").innerHTML = dataTable({
      rows: ordered,
      groupBy: (s) => s.staff_level,
      groupLabel: (key, rs) => `<b>${levelLabel(key, rs.length)}</b> <span class="muted">· ${rs.length}</span>`,
      onRow: (s) => navigate(`/employees/${s.employee_id}`),
      card: (s) => html`<span class="mc-main"><b>${s.name}</b><span class="mc-sub">${s.employee_id} · ${levelLabel(s.staff_level)}${up(s) && byId[up(s)] ? ` · reports to ${byId[up(s)].name}` : ""}</span></span>
        <span class="mc-end">${compact(sales[s.employee_id]?.business || 0)}<br>${badge(s.status)}</span>`,
      cols: [
        { key: "name", label: "Member", render: (s) => html`<div class="who"><div class="avatar">${initials(s.name)}</div><div><b>${s.name}</b><span>${s.employee_id}</span></div></div>` },
        { key: "staff_level", label: "Position", render: (s) => badge(s.role, levelLabel(s.staff_level)) },
        { key: "upline_id", label: "Reports to", render: (s) => (up(s) && byId[up(s)] ? byId[up(s)].name : html`<span class="faint">—</span>`) },
        { key: "sales", label: "Sales this month", render: (s) => html`<span class="num">${compact(sales[s.employee_id]?.business || 0)}</span>` },
        { key: "report", label: "Report", sort: false, render: (s) => html`<a class="btn" href="/api/staff/${encodeURIComponent(s.employee_id)}/report.pdf?period=${state.period}" target="_blank" rel="noopener" aria-label="PDF report for ${s.name}">${icon("file")} PDF</a>` },
        { key: "status", label: "Status", render: (s) => badge(s.status) },
      ],
    }).toString();

  },
};
