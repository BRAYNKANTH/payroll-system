import { get, post, qs } from "../api.js";
import { state, can, scopeHub, navigate } from "../app.js";
import { exportButtons, $, $$, html, icon, money, badge, toast, busy, dataTable, emptyState, pct, monthName, dateLabel, dateTime, levelLabel, levelRank, initials, compact } from "../ui.js";
import { mountRange, monthsIn, singleMonth, today, rangeText } from "../range.js";

// The last day of the month a date is in.
const lastDay = (iso) => { const d = new Date(iso.slice(0, 7) + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

let tab = "teams";

// Teams: a manager and everyone under them. The sales of the chosen dates are added up per team, so a hub reads as a few cards
// (one per team) instead of one long list of people. A team opens to its members and its own sales by day.
function teamsOf(d) {
  const by = new Map(), sold = new Map(d.people.map((p) => [p.employee_id, p])), roster = d.roster || [];
  const mk = (t) => { if (!by.has(t.id)) by.set(t.id, { id: t.id, title: t.title || "Other sellers", sub: t.sub || "", order: t.order ?? 3, members: [], business: 0, days: 0, unconfirmed: 0, target: 0 }); return by.get(t.id); };
  for (const r of roster) { const p = sold.get(r.employee_id); mk(r.team).members.push({ ...r, business: p?.business || 0, days: p?.days || 0, unconfirmed: p?.unconfirmed || 0, target: p?.target || 0, target_pct: p?.target_pct ?? null }); }
  for (const p of d.people) if (!roster.some((r) => r.employee_id === p.employee_id)) mk({ id: p.team || "none" }).members.push({ ...p }); // someone with sales who is no longer active
  for (const t of by.values()) {
    for (const m of t.members) { t.business += m.business; t.days += m.days; t.unconfirmed += m.unconfirmed; t.target += m.target; }
    t.members.sort((a, b) => levelRank(b.staff_level) - levelRank(a.staff_level) || b.business - a.business || a.name.localeCompare(b.name));
  }
  return [...by.values()].sort((a, b) => b.business - a.business || a.order - b.order || a.title.localeCompare(b.title));
}

const tile = (label, value, foot) => html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
const peopleText = (n) => `${n} ${n === 1 ? "person" : "people"}`;

// The teams of a hub as cards; or, when ?team=ID is in the address, that one team.
function teamsView(pane, d, drawFeed) {
  const teams = teamsOf(d), path = location.pathname, r = d.range;
  const want = new URLSearchParams(location.search).get("team"), team = want && teams.find((t) => t.id === want);
  if (!teams.length) { pane.innerHTML = html`<div class="card">${emptyState("No teams yet", "Add a manager and the people under them. Their sales appear here.", "users")}</div>`.toString(); return; }

  if (team) {
    const count = team.members.length, head = team.members.find((m) => m.staff_level === "manager");
    const pctOf = d.monthToDate && team.target > 0 ? team.business / team.target : null;
    pane.innerHTML = html`<nav class="drill-crumbs" aria-label="Where you are"><a href="${path}" data-link>All teams</a><span aria-hidden="true">›</span><b>${team.title}</b></nav>
      <div class="grid kpis hub-kpis mb-4">
        ${tile("Sales", html`<span class="v-full"><small>Rs</small>${money(team.business)}</span><span class="v-short">${compact(team.business)}</span>`, rangeText(r))}
        ${tile("People", count, head ? `Led by ${head.name}` : team.sub || "In this team")}
        ${tile("To confirm", html`<span class="${team.unconfirmed ? "neg" : ""}">${team.unconfirmed}</span>`, team.unconfirmed ? "Days waiting for you" : "Everything is confirmed")}
        ${tile("Of target", pctOf == null ? "—" : pct(pctOf, 0), pctOf == null ? "Shown for this month" : "Team sales against team targets")}
      </div>
      <h2 class="section-title drill-h">People in this team</h2>
      <div class="drill-grid mb-4">${team.members.map((m) => html`<a class="card drill-card" href="/employees/${encodeURIComponent(m.employee_id)}" data-link aria-label="${m.name}: open record">
        <span class="dc-top"><span class="avatar" aria-hidden="true">${initials(m.name)}</span><span class="dc-main"><b>${m.name}</b><span class="muted">${m.employee_id} · ${levelLabel(m.staff_level)}</span></span><span class="dc-sales"><b class="num">${money(m.business)}</b><span class="muted">${m.days} ${m.days === 1 ? "day" : "days"}</span></span></span>
        ${d.monthToDate && m.target ? html`<span class="dc-foot">${bar(m.target_pct)}</span>` : ""}${m.unconfirmed ? html`<span class="dc-foot">${badge("amber", `${m.unconfirmed} to confirm`)}</span>` : ""}</a>`)}</div>
      <h2 class="section-title drill-h">Sales by day</h2><div id="team-feed"></div>`.toString();
    drawFeed($("#team-feed", pane), d.feed.filter((f) => f.team === team.id));
    return;
  }

  const people = teams.reduce((t, x) => t + x.members.length, 0), money0 = teams.reduce((t, x) => t + x.business, 0);
  pane.innerHTML = html`<div class="grid kpis hub-kpis mb-4">
      ${tile("Sales", html`<span class="v-full"><small>Rs</small>${money(money0)}</span><span class="v-short">${compact(money0)}</span>`, rangeText(r))}
      ${tile("Teams", teams.length, "Each led by a manager")}
      ${tile("People", people, "Selling in this hub")}
      ${tile("To confirm", html`<span class="${d.unconfirmed ? "neg" : ""}">${d.unconfirmed}</span>`, d.unconfirmed ? "Days waiting for you" : "Everything is confirmed")}
    </div>
    <div class="drill-grid">${teams.map((t) => {
      const pctOf = d.monthToDate && t.target > 0 ? t.business / t.target : null, head = t.members.find((m) => m.staff_level === "manager");
      return html`<a class="card drill-card" href="${path}?team=${encodeURIComponent(t.id)}" data-link aria-label="${t.title}: open this team">
        <span class="dc-top"><span class="avatar" aria-hidden="true">${initials(t.title)}</span><span class="dc-main"><b>${t.title}</b><span class="muted">${head ? "Manager" : t.sub} · ${peopleText(t.members.length)}</span></span><span class="dc-sales"><b class="num">${money(t.business)}</b></span></span>
        ${pctOf == null ? "" : html`<span class="dc-foot">${bar(pctOf)}</span>`}${t.unconfirmed ? html`<span class="dc-foot">${badge("amber", `${t.unconfirmed} to confirm`)}</span>` : ""}
        <span class="dc-open" aria-hidden="true">Open team</span></a>`;
    })}</div>
    <p class="muted hs-hint">Tap a team to see its people and every sale.</p>`.toString();
}

// A thin bar showing how far a person is towards their target; it turns green once the target is passed.
const bar = (p) => (p == null ? html`<span class="faint">no target</span>` : html`<div class="row target-bar">
  <div class="progress ${p >= 1 ? "green" : p >= 0.7 ? "" : "amber"}"><span style="width:${Math.min(100, p * 100)}%"></span></div><span class="num text-sm">${pct(p, 0)}</span></div>`);

// The office (no single hub chosen) does not get one merged feed of every hub: that mixes hubs together and confuses everyone.
// It gets the hubs as a list, each with its sales for the chosen dates; a hub opens to its own live sales.
async function hubList({ el }) {
  document.body.dataset.filters = "month"; // every hub is listed, so the hub choice is not shown
  el.innerHTML = html`<div class="live-page">
    <div class="page-head"><div><h1>Live sales</h1><p>Sales are shown hub by hub. Tap a hub to see every sale in it, as it is entered.</p></div></div>
    <div id="lv-range" class="mb-4"></div>
    <div id="lv-hubs"><div class="loading-screen"><div class="spinner"></div></div></div></div>`.toString();
  const lastOf = (p) => { const [y, m] = p.split("-").map(Number); return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
  // "This month" follows the month chosen at the top, as on the Dashboard.
  const effective = (r) => (r.preset === "month" ? { ...r, from: `${state.period}-01`, to: state.period === today().slice(0, 7) ? today() : lastOf(state.period) } : r);
  let picker = null, seq = 0;
  const load = async () => {
    const mine = ++seq, r = picker.get();
    const d = await get("/api/dashboard" + qs({ period: state.period, from: r.from, to: r.to }));
    if (mine !== seq) return;
    const hubs = d.by_hub;
    $("#lv-hubs").innerHTML = hubs.length ? html`<div class="card hs-list"><ul role="list">${hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/sales" data-link aria-label="${h.name}: open its live sales">
        <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · ${h.staff} ${h.staff === 1 ? "person" : "people"}</span></span>
        <span class="hs-flags"><b class="num">${h.hub_business ? money(h.hub_business) : "No sales"}</b>${h.unconfirmed ? badge("amber", `${h.unconfirmed} to confirm`) : ""}</span>
        <span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div><p class="muted hs-hint">Tap a hub to see its sales feed and who has sold what.</p>`.toString()
      : html`<div class="card">${emptyState("No hubs yet", "Add a hub first, then its sales appear here.", "store")}</div>`.toString();
  };
  picker = mountRange($("#lv-range"), { page: "live", fallback: "month", resolve: effective, onChange: () => load().catch((e) => toast(e.message, "warn")) });
  await load();
}

export default {
  title: "Live sales",
  periodic: true,
  async render(ctx) {
    if (can("read") && !state.user.hub && !state.routeHub) return hubList(ctx);
    const { el } = ctx;
    el.innerHTML = html`<div class="live-page">
      <div class="page-head">
        <div><h1>Live sales</h1><p>Every sale as it is entered, and how far each person is from their target.<span id="pay-note"></span></p></div>
        <div class="actions"><span id="lv-export"></span><button class="btn" id="refresh">${icon("refresh")} Refresh</button><button class="btn primary" id="confirm-all" hidden>${icon("check")} Confirm all</button></div>
      </div>
      <div id="lv-range" class="mb-4"></div>
      <div class="tabs" id="tabs">${[["teams", "Teams"], ["feed", "All sales"], ["people", "By person"]].map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`)}</div>
      <div id="pane"><div class="loading-screen"><div class="spinner"></div></div></div></div>`;

    if (new URLSearchParams(location.search).get("team")) tab = "teams"; // an address that names a team opens that team
    let data = null, picker = null, seq = 0;
    // The sales of the chosen dates. A range can touch several months, so each month is asked for and the days outside the range are dropped.
    const load = async () => {
      const r = picker.get(), mine = ++seq;
      const parts = await Promise.all(monthsIn(r).map((m) => get("/api/live" + qs({ period: m, hub: scopeHub() }))));
      if (mine !== seq) return;
      const feed = parts.flatMap((p) => p.feed).filter((f) => f.date >= r.from && f.date <= r.to).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      // "Of target" and "earned so far" only make sense for a month counted from its first day up to now, so those show only for such a range.
      const monthToDate = singleMonth(r) && r.from.endsWith("-01") && (r.to >= today() || r.to === lastDay(r.to));
      let people;
      if (monthToDate) {
        // The server adds up the whole month. Sales, days and days-to-confirm follow the dates chosen, so every figure on the page matches the hub list.
        people = parts[0].people.map((p) => {
          const mine = feed.filter((f) => f.employee_id === p.employee_id), business = mine.reduce((t, f) => t + f.business, 0);
          return { ...p, business, days: mine.length, unconfirmed: mine.filter((f) => !f.confirmed).length, target_pct: p.target > 0 ? business / p.target : null };
        }).sort((a, b) => b.business - a.business);
      }
      else {
        const by = new Map();
        for (const f of feed) {
          const p = by.get(f.employee_id) || by.set(f.employee_id, { employee_id: f.employee_id, name: f.name, hub: f.hub, staff_level: f.staff_level, team: f.team, days: 0, business: 0, target: 0, target_pct: null, unconfirmed: 0 }).get(f.employee_id);
          p.days += 1; p.business += f.business; if (!f.confirmed) p.unconfirmed += 1;
        }
        people = [...by.values()].sort((a, b) => b.business - a.business);
      }
      data = { roster: parts[0].roster, can_pay: parts[0].can_pay && monthToDate, feed_pay: parts[0].can_pay, monthToDate, feed, people, unconfirmed: feed.filter((f) => !f.confirmed).length, unconfirmedIds: feed.filter((f) => !f.confirmed).map((f) => f.id), range: r };
      // Excel and PDF only for those allowed to download reports (a manager is not: the buttons would only fail).
      $("#lv-export").innerHTML = can("read") && singleMonth(r) && r.from.endsWith("-01") ? exportButtons("live", { period: r.from.slice(0, 7), hub: scopeHub() }).toString() : "";
      draw();
    };

    const confirmButton = (r) => (can("enter_data") && !r.confirmed ? html`<button class="btn sm" data-confirm="${r.id}">${icon("check")} Confirm</button>` : "");

    const draw = () => {
      const d = data;
      $("#pay-note").textContent = d.feed_pay ? (d.can_pay ? " Commission and pay so far are shown because you may see pay." : " Pay so far on the By person tab shows for This month, or a range that starts on the 1st.") : "";
      const all = $("#confirm-all");
      all.hidden = !(can("enter_data") && d.unconfirmed);
      all.lastChild.textContent = ` Confirm all (${d.unconfirmed})`;
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      const pane = $("#pane");

      // The sales feed, for the whole hub or for one team.
      const drawFeed = (host, rows) => {
        host.innerHTML = rows.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows, sortable: false, pageSize: 25, empty: "No sales entered yet", emptyHint: "Sales appear here as soon as they are entered on the daily sheet.",
          // The feed reads like a diary: a heading for each day with its count and total, then that day's sales, newest day first.
          groupBy: (r) => r.date,
          groupLabel: (key, rs) => `<b>${dateLabel(key)}</b> <span class="muted">· ${rs.length} ${rs.length === 1 ? "sale" : "sales"} · Rs ${money(rs.reduce((t, x) => t + x.business, 0))}${rs.some((x) => !x.confirmed) ? ` · ${rs.filter((x) => !x.confirmed).length} to confirm` : ""}</span>`,
          // On a phone each sale is a short card: who, the amount and any shortfall, and the Confirm button when one is waiting.
          card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${r.employee_id}${r.self_entered ? " · entered by the seller" : ""}</span>${confirmButton(r)}</span>
            <span class="mc-end"><b>${money(r.business)}</b><br>${r.business > r.settled ? html`<span class="neg">short ${money(r.business - r.settled)}</span>` : html`<span class="muted">all handed in</span>`}${r.confirmed ? "" : html`<br>${badge("amber", "To confirm")}`}</span>`,
          cols: [
            { key: "date", label: "Day", render: (r) => html`<b>${dateLabel(r.date)}</b><div class="faint text-sm">${r.self_entered ? `entered ${dateTime(r.entered_at)}` : "entered by the office"}</div>` },
            { key: "name", label: "Person", render: (r) => html`<b>${r.name}</b><div class="faint text-sm">${r.employee_id} · ${r.hub} · ${levelLabel(r.staff_level)}</div>` },
            { key: "business", label: "Sale", align: "r", render: (r) => html`<b>${money(r.business)}</b>` },
            { key: "settled", label: "Handed in", align: "r", render: (r) => html`${money(r.settled)}${r.business !== r.settled ? html`<div class="text-sm ${r.business > r.settled ? "neg" : ""}">${r.business > r.settled ? "short" : "over"} ${money(Math.abs(r.business - r.settled))}</div>` : ""}` },
            ...(d.feed_pay ? [
              { key: "commission", label: "Commission on this sale", align: "r", render: (r) => (r.pay ? html`<b class="pos">${money(r.pay.commission)}</b>${r.pay.food ? html`<div class="faint text-sm">+ food ${money(r.pay.food)}</div>` : ""}` : html`<span class="faint">—</span>`) },
            ] : []),
            { key: "month_business", label: "Month so far", align: "r", render: (r) => money(r.month_business) },
            { key: "target_pct", label: "Of target", render: (r) => bar(r.target_pct) },
            ...(d.feed_pay ? [
              { key: "gross_so_far", label: "Earned so far", align: "r", render: (r) => (r.pay ? html`<b>${money(r.pay.gross_so_far)}</b>` : html`<span class="faint">—</span>`) },
            ] : []),
            { key: "status", label: "Status", render: (r) => (r.confirmed ? badge("green", r.self_entered ? "Confirmed" : "Entered") : badge("amber", "Waiting for confirmation")) },
            { key: "act", label: "", sort: false, align: "r", render: (r) => confirmButton(r) },
          ],
        })}</div></div>`.toString() : html`<div class="card">${emptyState("No sales entered yet", "Sales appear here as soon as they are entered, by the office or by the sellers themselves.", "chart")}</div>`.toString();
      };
      if (tab === "teams") teamsView(pane, d, drawFeed);
      else if (tab === "feed") drawFeed(pane, d.feed);
      else {
        pane.innerHTML = d.people.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows: d.people, footer: true, pageSize: 25, empty: "Nobody has sales in this period", emptyHint: "People show here once they have a sale in the dates you chose.",
          onRow: (r) => navigate(`/employees/${encodeURIComponent(r.employee_id)}`), rowLabel: (r) => `Open ${r.name}`,
          // A ranking: who sold most, how far each is from the target (when that makes sense), and who has days waiting. Tap a person for the rest.
          card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${levelLabel(r.staff_level)} · ${r.days} ${r.days === 1 ? "day" : "days"}</span>${d.monthToDate ? bar(r.target_pct) : ""}${r.unconfirmed ? badge("amber", `${r.unconfirmed} to confirm`) : ""}</span>
            <span class="mc-end"><b>${money(r.business)}</b>${d.can_pay && r.pay ? html`<br><span class="muted">earned ${money(r.pay.gross)}</span>` : ""}</span>`,
          cols: [
            { key: "name", label: "Person", render: (r) => html`<b>${r.name}</b><div class="faint text-sm">${r.employee_id} · ${r.hub} · ${levelLabel(r.staff_level)}</div>`, total: () => "Total" },
            { key: "days", label: "Days", align: "r" },
            { key: "business", label: "Sales", align: "r", render: (r) => html`<b>${money(r.business)}</b>`, total: (rs) => money(rs.reduce((t, x) => t + x.business, 0)) },
            ...(d.monthToDate ? [
              { key: "target", label: "Target", align: "r", render: (r) => (r.target ? money(r.target) : "—") },
              { key: "target_pct", label: "Of target", render: (r) => bar(r.target_pct) },
            ] : []),
            ...(d.can_pay ? [
              { key: "gross", label: "Earned so far", align: "r", render: (r) => (r.pay ? html`<b>${money(r.pay.gross)}</b>` : html`<span class="faint">—</span>`) },
              { key: "deductions", label: "Taken off", align: "r", render: (r) => (r.pay ? money(r.pay.deductions) : "—") },
              { key: "net", label: "Net so far", align: "r", render: (r) => (r.pay ? html`<b class="${r.pay.net < 0 ? "neg" : ""}">${money(r.pay.net)}</b>` : "—") },
            ] : []),
            { key: "unconfirmed", label: "Waiting", render: (r) => (r.unconfirmed ? badge("amber", `${r.unconfirmed} to confirm`) : html`<span class="faint">—</span>`) },
          ],
        })}</div></div>${d.can_pay ? html`<p class="muted mt-3">Earned so far is worked out with each person's own pay rules from the days entered up to now. It is an estimate: stock shortfalls, loans and the office's checks are settled when payroll is calculated.</p>` : ""}`.toString()
          : html`<div class="card">${emptyState("Nobody has sales in this period", "", "chart")}</div>`.toString();
      }
    };

    $$("#tabs button", el).forEach((b) => (b.onclick = () => {
      tab = b.dataset.t;
      if (tab === "teams" && location.search) { navigate(location.pathname); return; } // back to the list of teams
      if (data) draw();
    }));
    $("#refresh").onclick = (e) => busy(e.currentTarget, async () => { await load(); toast("Up to date"); });
    $("#confirm-all").onclick = (e) => busy(e.currentTarget, async () => {
      // Only the days on screen (the chosen dates), never days the person has not looked at.
      const out = await post("/api/sales/confirm", { ids: data.unconfirmedIds });
      toast(`${out.confirmed} confirmed`);
      await load();
    });
    el.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-confirm]");
      if (!b) return;
      busy(b, async () => { await post("/api/sales/confirm", { ids: [Number(b.dataset.confirm)] }); toast("Confirmed"); await load(); });
    });

    picker = mountRange($("#lv-range"), { page: "live", fallback: "month", onChange: () => load().catch((e) => toast(e.message, "warn")) });
    await load();
    // New sales appear without pressing anything: look again every half minute while this page is open.
    const timer = setInterval(() => { if (!ctx.isCurrent?.() || !document.body.contains(el)) return clearInterval(timer); load().catch(() => {}); }, 30000);
  },
};
