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

    // The org chart: each person is a card (profile circle, name, position, sales); the people who report to them hang below on branches.
    // Click a card to open that person. The small button under a card folds or opens its branch.
    const levelKey = (s) => s.staff_level || (s.role === "manager" ? "manager" : "distributor");
    const node = (s) => {
      const direct = kids[s.employee_id] || [], n = count(s.employee_id), own = sales[s.employee_id]?.business || 0;
      return html`<li class="org-item" data-id="${s.employee_id}">
        <a href="/employees/${encodeURIComponent(s.employee_id)}" data-link class="org-card lv-${levelKey(s)}" aria-label="${s.name}, ${levelLabel(s.staff_level)}. Open record">
          <span class="avatar org-av" aria-hidden="true">${initials(s.name)}</span>
          <b class="org-name">${s.name}</b>
          <span class="org-id">${s.employee_id}</span>
          <span class="org-role">${levelLabel(s.staff_level)}</span>
          <span class="org-sales"><b class="num">${compact(own)}</b> own${n ? html` · <b class="num">${compact(total(s.employee_id))}</b> team` : ""}</span>
        </a>
        ${direct.length ? html`<button type="button" class="org-toggle" aria-expanded="true" aria-label="Show or hide the ${n} below ${s.name}"><span class="org-toggle-dot"><span class="org-chev" aria-hidden="true">▾</span> ${direct.length}</span></button>
          <ul class="org-kids">${direct.map((c) => node(c))}</ul>` : ""}
      </li>`;
    };
    const legend = [...new Set(active.map(levelKey))].sort((a, b) => levelRank(b) - levelRank(a));
    const tops = kids[""] || [];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Overview</h1><p>${hub.name} · ${hub.code}${hub.location ? ` · ${hub.location}` : ""} · ${active.length} active ${active.length === 1 ? "member" : "members"} · sales ${compact(live.people.reduce((t, p) => t + p.business, 0))} this month</p></div>
        <div class="actions">
          ${can(["manage_staff", "manage_team"]) ? html`<a class="btn primary" href="/hubs/${encodeURIComponent(code)}/people" data-link>${icon("users")} People in this hub</a>` : ""}
        </div>
      </div>
      <div class="card mb-4 hubpage"><div class="card-head"><div><h2>Reporting chain</h2><div class="sub">Top of the chain first, each person under the one they report to. Tap anyone to open their record.</div></div>
        ${tops.length ? html`<div class="org-tools" role="group" aria-label="Chart controls">
          <button type="button" class="btn org-zoom" id="org-out" aria-label="Zoom out">−</button><button type="button" class="btn org-zoom" id="org-in" aria-label="Zoom in">+</button>
          <button type="button" class="btn org-zoom" id="org-fit">Fit</button>
          <button type="button" class="btn" id="org-all">Open all</button><button type="button" class="btn" id="org-none">Fold all</button></div>` : ""}</div>
        <div class="card-body">${tops.length ? html`
          <div class="org-legend">${legend.map((l) => html`<span class="org-key lv-${l}"><i class="org-dot"></i>${levelLabel(l)}</span>`)}</div>
          <div class="org-scroll" id="org-scroll" tabindex="0" role="region" aria-label="Reporting chain chart, scroll sideways to see everyone"><div class="org" id="org"><ul class="org-root">${tops.map((s) => node(s))}</ul></div></div>`
          : emptyState("No members yet", "Add employees to this hub and set who each reports to.", "users")}</div></div>
      <div class="card hubpage"><div class="card-head"><div><h2>Members</h2><div class="sub">${members.length} in total, grouped by position</div></div></div><div class="card-body flush" id="mem"></div></div>`.toString();

    // Chart controls: fold or open a branch, fold/open everything, zoom.
    const org = $("#org", el);
    if (org) {
      const fold = (li, closed) => { li.classList.toggle("folded", closed); const b = li.querySelector(":scope > .org-toggle"); if (b) { b.setAttribute("aria-expanded", String(!closed)); b.querySelector(".org-chev").textContent = closed ? "▸" : "▾"; } };
      org.addEventListener("click", (e) => { const b = e.target.closest(".org-toggle"); if (b) fold(b.parentElement, !b.parentElement.classList.contains("folded")); });
      $("#org-all", el).onclick = () => org.querySelectorAll(".org-item").forEach((li) => fold(li, false));
      $("#org-none", el).onclick = () => org.querySelectorAll(".org-item").forEach((li) => { if (!tops.some((t) => t.employee_id === li.dataset.id)) fold(li, true); });
      const sc = $("#org-scroll", el);
      const narrow = window.matchMedia("(max-width: 900px)"); // a phone or tablet: the chart grows downward (see the CSS), so it never needs to scroll sideways
      let z = 1, touched = false;
      const setZoom = (v) => { z = Math.min(1.4, Math.max(0.3, +v.toFixed(2))); org.style.zoom = narrow.matches ? "" : z; };
      // Fit the whole chart into the width of the screen (never bigger than life size, never so small it cannot be read).
      const fit = () => {
        if (narrow.matches) { org.style.zoom = ""; sc.scrollLeft = 0; return; }
        org.style.zoom = ""; org.style.width = "max-content";
        const natural = org.scrollWidth, room = sc.clientWidth - 8;
        setZoom(Math.min(1, Math.max(0.5, room / natural)));
        sc.scrollLeft = Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2);
      };
      $("#org-in", el).onclick = () => { touched = true; setZoom(z + 0.1); };
      $("#org-out", el).onclick = () => { touched = true; setZoom(z - 0.1); };
      $("#org-fit", el).onclick = () => { touched = false; fit(); };
      fit();
      // Keep it fitted when the window is resized or the phone is turned (unless the person zoomed by hand).
      let t; const refit = () => { clearTimeout(t); t = setTimeout(() => { if (!document.body.contains(org)) { window.removeEventListener("resize", refit); return; } if (!touched) fit(); }, 150); };
      window.addEventListener("resize", refit);
    }

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
