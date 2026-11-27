// The hub's cash book: the cash the hub holds, day by day.
//   cash in       what the sellers handed in on the daily sheet (automatic) + any other cash the coacher records
//   cash out      what the coacher spent or paid (expenses, salaries paid from the cash) + the cash handed over to the office
//   online        money that reached the company by bank or card; shown, but not cash in hand
//   in hand       opening + in - out, carried from day to day and from month to month
// A coacher keeps the book for their hub. The office, with no hub chosen, sees every hub's cash and opens one.
import { get, post, del, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, money, badge, toast, busy, drawer, dataTable, emptyState, confirmDialog, dateLabel, monthName } from "../ui.js";
import { today } from "../range.js";

const KIND_NAME = { expense: "Expense", salary: "Salary paid", draw: "Manager took cash", other_in: "Other cash in", online: "Online money" };
const OUT_KIND = (k) => k === "expense" || k === "salary" || k === "draw";
const KIND_HELP = {
  expense: "Cash you spent for the hub: tea, transport, fuel, rent, supplies.",
  salary: "A salary or part of one that you paid out of the hub's cash.",
  draw: "Cash a manager took from the hub's cash, for example their salary. It is taken off that manager's pay for the week.",
  other_in: "Cash that came in besides the sellers' daily cash.",
  online: "Money that reached the company by bank or card. It is not cash in hand.",
};
const rs = (c) => `Rs ${money(c)}`;
const handedBadge = (r) => (r.handover_status === "approved" ? badge("green", "Approved") : r.handover_status === "pending" ? badge("amber", "To verify") : r.handover_status === "rejected" ? badge("red", "Sent back") : "");

export default {
  title: "Cash book",
  filters: "month", // the month is chosen at the top; the hub comes from the address, the user's hub or a pick from the list
  async render(ctx) {
    const { el } = ctx;
    const hub = state.user.hub || state.routeHub || "";
    const period = state.period;

    // ---------------------------------------------------------------- the office with no hub chosen: every hub's cash
    if (!hub) {
      const all = await get("/api/cashbook" + qs({ period }));
      el.innerHTML = html`<div class="page-head"><div><h1>Cash book — ${monthName(period)}</h1><p>The cash each hub holds. Cash in is what the sellers handed in; cash out is what the coacher spent or paid and what was handed over to the office. Open a hub to see its days.</p></div></div>
        ${all.hubs.length ? html`<div class="card hs-list"><ul role="list">${all.hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/sales/cashbook" data-link>
          <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · in ${rs(h.totals.cash_in + h.totals.other_in)} · out ${rs(h.totals.expenses + h.totals.salaries + h.totals.handed)}</span></span>
          <span class="hs-flags"><b class="num ${h.closing < 0 ? "neg" : ""}">${rs(h.closing)}</b><span class="muted">in hand</span></span><span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
          : html`<div class="card">${emptyState("No hubs yet", "Add a hub first.", "store")}</div>`}`.toString();
      return;
    }

    const b = await get("/api/cashbook" + qs({ period, hub }));
    const t = b.totals, out = t.expenses + t.salaries + t.draws + t.handed;
    const canWrite = can("enter_data");
    el.innerHTML = html`<div class="page-head"><div><h1>Cash book — ${b.name}</h1><p>${monthName(period)}. The cash the hub holds, day by day. Sellers' cash comes from the daily sheet; you add what was spent or paid out. Cash handed to the office comes from the Cash handover page.</p></div>
        <div class="actions">${canWrite ? html`<button class="btn primary" id="cb-add">${icon("plus")} Add entry</button>` : ""}</div></div>
      <div class="grid kpis hub-kpis mb-4">
        <div class="card kpi"><div class="label">Cash at the start</div><div class="value"><small>Rs</small>${money(b.opening)}</div><div class="foot">${b.opening < 0 ? "Below zero: check the earlier entries" : "Brought from before"}</div></div>
        <div class="card kpi"><div class="label">Cash in</div><div class="value"><small>Rs</small>${money(t.cash_in + t.other_in)}</div><div class="foot">Sellers Rs ${money(t.cash_in)}${t.other_in ? ` · other Rs ${money(t.other_in)}` : ""}</div></div>
        <div class="card kpi"><div class="label">Cash out</div><div class="value"><small>Rs</small>${money(out)}</div><div class="foot">Spent Rs ${money(t.expenses)} · salaries Rs ${money(t.salaries)}${t.draws ? ` · managers took Rs ${money(t.draws)}` : ""} · to the office Rs ${money(t.handed)}</div></div>
        <div class="card kpi"><div class="label">Cash in hand</div><div class="value ${b.closing < 0 ? "neg" : ""}"><small>Rs</small>${money(b.closing)}</div><div class="foot">${b.closing < 0 ? "Below zero: more went out than came in" : "Start + in − out"}${t.online ? ` · online Rs ${money(t.online)} (not cash)` : ""}</div></div>
      </div>

      <h2 class="section-title drill-h">Day by day</h2>
      <div class="card mb-4"><div class="card-body flush" id="cb-days"></div></div>

      <h2 class="section-title drill-h">Entries you recorded</h2>
      <div class="card mb-4"><div class="card-body flush" id="cb-entries"></div></div>

      <h2 class="section-title drill-h">Each team's cash this month</h2>
      <div class="card mb-4"><div class="card-body flush" id="cb-teams"></div></div>

      <h2 class="section-title drill-h">Who handed in less than they sold</h2>
      <div class="card mb-4"><div class="card-body flush" id="cb-less"></div></div>

      <h2 class="section-title drill-h">Team cash on one day</h2>
      <div class="card"><div class="card-body" id="cb-teamday"></div></div>`.toString();

    // ---------------------------------------------------------------- days
    $("#cb-days").innerHTML = b.days.length ? dataTable({
      rows: b.days, sortable: false, pageSize: 31, footer: true,
      card: (r) => html`<span class="mc-main"><b>${dateLabel(r.date)}</b><span class="mc-sub">in ${rs(r.cash_in + r.other_in)} · out ${rs(r.expenses + r.salaries + r.handed)}${r.handed ? " (handover)" : ""}</span></span>
        <span class="mc-end"><b class="${r.closing < 0 ? "neg" : ""}">${money(r.closing)}</b><br><span class="muted">in hand</span></span>`,
      cols: [
        { key: "date", label: "Day", render: (r) => html`<b>${dateLabel(r.date)}</b>`, total: () => "Month" },
        { key: "sales", label: "Sales", align: "r", render: (r) => money(r.sales), total: () => money(t.sales) },
        { key: "cash_in", label: "Cash from sellers", align: "r", render: (r) => money(r.cash_in), total: () => money(t.cash_in) },
        { key: "other_in", label: "Other cash in", align: "r", render: (r) => (r.other_in ? money(r.other_in) : "—"), total: () => money(t.other_in) },
        { key: "expenses", label: "Spent", align: "r", render: (r) => (r.expenses ? money(r.expenses) : "—"), total: () => money(t.expenses) },
        { key: "salaries", label: "Salaries paid", align: "r", render: (r) => (r.salaries ? money(r.salaries) : "—"), total: () => money(t.salaries) },
        { key: "draws", label: "Managers took", align: "r", render: (r) => (r.draws ? money(r.draws) : "—"), total: () => money(t.draws) },
        { key: "handed", label: "To the office", align: "r", render: (r) => html`${r.handed ? money(r.handed) : r.handover_status === "rejected" ? "—" : "—"} ${handedBadge(r)}`, total: () => money(t.handed) },
        { key: "closing", label: "Cash in hand", align: "r", render: (r) => html`<b class="${r.closing < 0 ? "neg" : ""}">${money(r.closing)}</b>`, total: () => money(b.closing) },
      ],
    }).toString() : emptyState("Nothing recorded this month", "Cash appears here as sellers hand it in on the daily sheet, and as you add entries.", "wallet").toString();

    // ---------------------------------------------------------------- entries
    $("#cb-entries").innerHTML = b.entries.length ? dataTable({
      rows: b.entries, sortable: false, pageSize: 50,
      card: (e) => html`<span class="mc-main"><b>${KIND_NAME[e.kind]}${e.employee_name ? ` · ${e.employee_name}` : e.category ? ` · ${e.category}` : ""}</b><span class="mc-sub">${dateLabel(e.date)} · ${e.created_by}${e.note ? ` · ${e.note}` : ""}</span>
        ${canWrite ? html`<button type="button" class="btn sm danger-ghost" data-rm="${e.id}" aria-label="Remove this entry">${icon("trash")} Remove</button>` : ""}</span><span class="mc-end"><b class="${OUT_KIND(e.kind) ? "neg" : ""}">${OUT_KIND(e.kind) ? "−" : ""}${money(e.amount)}</b></span>`,
      cols: [
        { key: "date", label: "Day", render: (e) => dateLabel(e.date) },
        { key: "kind", label: "Kind", render: (e) => badge(OUT_KIND(e.kind) ? "amber" : e.kind === "online" ? "blue" : "green", KIND_NAME[e.kind]) },
        { key: "category", label: "What for", render: (e) => html`${e.employee_name ? html`<b>${e.employee_name}</b> · ` : ""}${e.category || "—"}${e.note ? html`<div class="faint text-sm">${e.note}</div>` : ""}` },
        { key: "amount", label: "Amount", align: "r", render: (e) => html`<b class="${OUT_KIND(e.kind) ? "neg" : ""}">${OUT_KIND(e.kind) ? "−" : ""}${money(e.amount)}</b>` },
        { key: "created_by", label: "By", render: (e) => e.created_by },
        ...(canWrite ? [{ key: "rm", label: "", sort: false, align: "r", render: (e) => html`<button type="button" class="btn sm danger-ghost" data-rm="${e.id}" aria-label="Remove this ${KIND_NAME[e.kind].toLowerCase()} entry">${icon("trash")}</button>` }] : []),
      ],
    }).toString() : emptyState("No entries yet", "Add what was spent or paid out of the hub's cash, so the cash in hand is right.", "wallet", canWrite ? `<button class="btn primary" id="cb-add2">Add entry</button>` : "").toString();

    // ---------------------------------------------------------------- teams
    $("#cb-teams").innerHTML = b.teams.length ? dataTable({
      rows: b.teams, sortable: false, footer: true,
      card: (x) => html`<span class="mc-main"><b>${x.title}</b> ${x.below ? badge("red", `Below ${b.min_percent}%`) : ""}<span class="mc-sub">${x.people} ${x.people === 1 ? "person" : "people"} · sales ${rs(x.sales)} · expected ${rs(x.expected)}</span></span>
        <span class="mc-end"><b class="${x.not_handed_in > 0 ? "neg" : ""}">${money(x.not_handed_in)}</b><br><span class="muted">not handed in</span></span>`,
      cols: [
        { key: "title", label: "Team", render: (x) => html`<b>${x.title}</b> ${x.below ? badge("red", `Below ${b.min_percent}%`) : ""}<div class="faint text-sm">${x.sub}</div>`, total: () => "All teams" },
        { key: "people", label: "People", align: "r", total: () => b.teams.reduce((s, x) => s + x.people, 0) },
        { key: "sales", label: "Sales", align: "r", render: (x) => money(x.sales), total: () => money(b.teams.reduce((s, x) => s + x.sales, 0)) },
        { key: "expected", label: `Expected (${b.min_percent}%)`, align: "r", render: (x) => money(x.expected), total: () => money(b.teams.reduce((s, x) => s + x.expected, 0)) },
        { key: "cash", label: "Handed in", align: "r", render: (x) => html`<span class="${x.below ? "neg" : ""}">${money(x.cash)}</span>`, total: () => money(b.teams.reduce((s, x) => s + x.cash, 0)) },
        { key: "not_handed_in", label: "Not handed in", align: "r", render: (x) => html`<b class="${x.not_handed_in > 0 ? "neg" : ""}">${money(x.not_handed_in)}</b>`, total: () => money(b.teams.reduce((s, x) => s + x.not_handed_in, 0)) },
        { key: "share", label: "Of sales", align: "r", render: (x) => (x.share == null ? "—" : `${Math.round(x.share * 100)}%`) },
      ],
    }).toString() : emptyState("No sales this month", "Teams appear once sellers have days on the daily sheet.", "users").toString();

    // ---------------------------------------------------------------- who gave less
    $("#cb-less").innerHTML = b.gave_less.length ? html`<p class="muted" style="margin:12px 16px 4px">The expected cash is ${b.min_percent}% of the sales. What each person handed in below their sales is taken off their pay as "cash not handed in", so it is not charged twice.</p>${dataTable({
      rows: b.gave_less, sortable: false, pageSize: 25, footer: true,
      card: (x) => html`<span class="mc-main"><b>${x.name}</b><span class="mc-sub">${x.team} · sold ${rs(x.sales)} · handed in ${rs(x.cash)}</span></span><span class="mc-end"><b class="neg">${money(x.short)}</b><br><span class="muted">short</span></span>`,
      cols: [
        { key: "name", label: "Person", render: (x) => html`<b>${x.name}</b><div class="faint text-sm">${x.employee_id} · ${x.team}</div>`, total: () => "Total" },
        { key: "sales", label: "Sold", align: "r", render: (x) => money(x.sales), total: (r) => money(r.reduce((s, x) => s + x.sales, 0)) },
        { key: "cash", label: "Handed in", align: "r", render: (x) => money(x.cash), total: (r) => money(r.reduce((s, x) => s + x.cash, 0)) },
        { key: "short", label: "Short (taken off their pay)", align: "r", render: (x) => html`<b class="neg">${money(x.short)}</b>`, total: (r) => money(r.reduce((s, x) => s + x.short, 0)) },
      ],
    })}`.toString() : emptyState("Everyone handed in all they sold", "Nobody is short this month.", "check").toString();

    // ---------------------------------------------------------------- one day, team by team
    // For each team: what it sold, what it handed in, the gap that day, and the gap added up from the start (with what it owed from before).
    const dayBox = $("#cb-teamday");
    if (!b.team_days.length) dayBox.innerHTML = emptyState("No sales this month", "Team cash by day appears once sellers have days on the daily sheet.", "users").toString();
    else {
      let pick = b.team_days[b.team_days.length - 1].date;
      const meta = Object.fromEntries(b.team_meta.map((m) => [m.id, m]));
      const drawDay = () => {
        const run = {};
        for (const [id, v] of Object.entries(b.team_carried)) run[id] = v;
        let shown = [];
        for (const day of b.team_days) {
          for (const t of day.teams) run[t.id] = (run[t.id] || 0) + t.gap;
          if (day.date === pick) shown = day.teams.map((t) => ({ ...t, balance: run[t.id] })).sort((a, c) => c.sales - a.sales);
          if (day.date >= pick) break;
        }
        dayBox.innerHTML = html`<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><label for="cb-pick"><b>Day</b></label>
            <select class="input" id="cb-pick" style="width:auto">${b.team_days.map((x) => html`<option value="${x.date}" ${x.date === pick ? "selected" : ""}>${dateLabel(x.date)}</option>`)}</select>
            <span class="muted">Balance = what the team still owes, added up from before the month to this day.</span></div>
          ${dataTable({
            rows: shown, sortable: false, footer: true,
            card: (x) => html`<span class="mc-main"><b>${meta[x.id]?.title || x.id}</b><span class="mc-sub">sold ${rs(x.sales)} · handed in ${rs(x.cash)}</span></span><span class="mc-end"><b class="${x.gap > 0 ? "neg" : ""}">${money(x.gap)}</b><br><span class="muted">balance ${money(x.balance)}</span></span>`,
            cols: [
              { key: "id", label: "Team", render: (x) => html`<b>${meta[x.id]?.title || x.id}</b><div class="faint text-sm">${meta[x.id]?.sub || ""}</div>`, total: () => "All teams" },
              { key: "sales", label: "Sold", align: "r", render: (x) => money(x.sales), total: (rs2) => money(rs2.reduce((s, x) => s + x.sales, 0)) },
              { key: "expected", label: `Expected (${b.min_percent}%)`, align: "r", render: (x) => money(x.expected), total: (rs2) => money(rs2.reduce((s, x) => s + x.expected, 0)) },
              { key: "cash", label: "Handed in", align: "r", render: (x) => html`<span class="${x.below ? "neg" : ""}">${money(x.cash)}</span> ${x.below ? badge("red", `Below ${b.min_percent}%`) : ""}`, total: (rs2) => money(rs2.reduce((s, x) => s + x.cash, 0)) },
              { key: "gap", label: "Not handed in", align: "r", render: (x) => html`<span class="${x.gap > 0 ? "neg" : ""}">${money(x.gap)}</span>`, total: (rs2) => money(rs2.reduce((s, x) => s + x.gap, 0)) },
              { key: "balance", label: "Balance to this day", align: "r", render: (x) => html`<b class="${x.balance > 0 ? "neg" : ""}">${money(x.balance)}</b>`, total: (rs2) => money(rs2.reduce((s, x) => s + x.balance, 0)) },
            ],
          })}`.toString();
        $("#cb-pick").onchange = (e) => { pick = e.target.value; drawDay(); };
      };
      drawDay();
    }

    // ---------------------------------------------------------------- add and remove
    const open = () => {
      const now = today();
      const d = drawer({
        title: "Add to the cash book",
        body: html`<form id="cbf" class="form-grid" autocomplete="off" novalidate>
          <div class="field full"><label for="cb-kind">What happened</label>
            <select class="input" id="cb-kind" name="kind">${Object.entries(KIND_NAME).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
            <span class="hint" id="cb-help">${KIND_HELP.expense}</span></div>
          <div class="field"><label for="cb-date">Day</label><input class="input" type="date" id="cb-date" name="date" value="${now}" max="${now}"></div>
          <div class="field"><label for="cb-amt">Amount (Rs) <span class="req">*</span></label><input class="input" id="cb-amt" name="amount" inputmode="decimal" placeholder="0" required></div>
          <div class="field full" id="cb-mgr-wrap" hidden><label for="cb-mgr">Which manager took it <span class="req">*</span></label>
            <select class="input" id="cb-mgr" name="employee_id"><option value="">Choose the manager</option>${b.managers.map((m) => html`<option value="${m.id}">${m.name} (${m.id})</option>`)}</select></div>
          <div class="field full"><label for="cb-cat">What for</label><input class="input" id="cb-cat" name="category" list="cb-cats" maxlength="60" placeholder="For example: Tea and transport">
            <datalist id="cb-cats">${b.categories.map((c) => html`<option value="${c}">`)}</datalist></div>
          <div class="field full"><label for="cb-note">Note (optional)</label><input class="input" id="cb-note" name="note" maxlength="200" placeholder="For example: who it was paid to"></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="cb-save">Save entry</button>`,
      });
      $("#cb-kind", d.panel).onchange = (e) => { $("#cb-help", d.panel).textContent = KIND_HELP[e.target.value]; $("#cb-mgr-wrap", d.panel).hidden = e.target.value !== "draw"; };
      $("#cbf", d.panel).addEventListener("submit", (e) => e.preventDefault());
      $("#cb-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#cbf", d.panel)));
        if (!String(v.amount || "").trim()) { $("#cb-amt", d.panel).setAttribute("aria-invalid", "true"); $("#cb-amt", d.panel).focus(); throw new Error("Enter the amount, for example 1500"); }
        if (v.kind === "draw" && !v.employee_id) { $("#cb-mgr", d.panel).setAttribute("aria-invalid", "true"); $("#cb-mgr", d.panel).focus(); throw new Error("Choose the manager who took the cash"); }
        await post("/api/cashbook", { ...v, ...(state.user.hub ? {} : { hub }) });
        toast("Saved to the cash book"); d.close(); this.render(ctx);
      });
    };
    $("#cb-add")?.addEventListener("click", open);
    $("#cb-add2")?.addEventListener("click", open);
    el.onclick = async (ev) => { // one handler on the page, replaced on every draw
      const x = ev.target.closest("[data-rm]");
      if (!x) return;
      const e = b.entries.find((r) => String(r.id) === x.dataset.rm);
      if (!(await confirmDialog({ title: "Remove this entry?", message: `${KIND_NAME[e.kind]}${e.category ? ` · ${e.category}` : ""} of Rs ${money(e.amount)} on ${dateLabel(e.date)} will be removed from the cash book.`, confirmText: "Remove", danger: true }))) return;
      await busy(x, async () => { await del(`/api/cashbook/${e.id}`); toast("Entry removed"); this.render(ctx); });
    };
  },
};
