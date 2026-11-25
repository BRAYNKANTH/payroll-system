import { get, post, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { exportButtons, $, $$, html, icon, money, badge, toast, busy, dataTable, emptyState, pct, monthName, dateLabel, dateTime, levelLabel } from "../ui.js";
import { mountRange, monthsIn, singleMonth, today } from "../range.js";

// The last day of the month a date is in.
const lastDay = (iso) => { const d = new Date(iso.slice(0, 7) + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

let tab = "feed";

// A thin bar showing how far a person is towards their target; it turns green once the target is passed.
const bar = (p) => (p == null ? html`<span class="faint">no target</span>` : html`<div class="row target-bar">
  <div class="progress ${p >= 1 ? "green" : p >= 0.7 ? "" : "amber"}"><span style="width:${Math.min(100, p * 100)}%"></span></div><span class="num text-sm">${pct(p, 0)}</span></div>`);

export default {
  title: "Live sales",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    el.innerHTML = html`<div class="live-page">
      <div class="page-head">
        <div><h1>Live sales</h1><p>Every sale as it is entered, and how far each person is from their target.<span id="pay-note"></span></p></div>
        <div class="actions"><span id="lv-export"></span><button class="btn" id="refresh">${icon("refresh")} Refresh</button><button class="btn primary" id="confirm-all" hidden>${icon("check")} Confirm all</button></div>
      </div>
      <div id="lv-range" class="mb-4"></div>
      <div class="tabs" id="tabs">${[["feed", "Sales feed"], ["people", "By person"]].map(([k, l]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`)}</div>
      <div id="pane"><div class="loading-screen"><div class="spinner"></div></div></div></div>`;

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
      if (monthToDate) people = parts[0].people;
      else {
        const by = new Map();
        for (const f of feed) {
          const p = by.get(f.employee_id) || by.set(f.employee_id, { employee_id: f.employee_id, name: f.name, hub: f.hub, staff_level: f.staff_level, days: 0, business: 0, target: 0, target_pct: null, unconfirmed: 0 }).get(f.employee_id);
          p.days += 1; p.business += f.business; if (!f.confirmed) p.unconfirmed += 1;
        }
        people = [...by.values()].sort((a, b) => b.business - a.business);
      }
      data = { can_pay: parts[0].can_pay && monthToDate, feed_pay: parts[0].can_pay, monthToDate, feed, people, unconfirmed: feed.filter((f) => !f.confirmed).length, unconfirmedIds: feed.filter((f) => !f.confirmed).map((f) => f.id), range: r };
      $("#lv-export").innerHTML = singleMonth(r) && r.from.endsWith("-01") ? exportButtons("live", { period: r.from.slice(0, 7), hub: scopeHub() }).toString() : "";
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

      if (tab === "feed") {
        pane.innerHTML = d.feed.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows: d.feed, sortable: false, pageSize: 25, empty: "No sales entered yet", emptyHint: "Sales appear here as soon as they are entered on the daily sheet.",
          // On a phone each sale is a short card: who, which day, the amount and any shortfall, and the Confirm button when one is waiting.
          card: (r) => html`<span class="mc-main"><b>${r.name}</b><span class="mc-sub">${dateLabel(r.date)} · ${r.employee_id}${r.self_entered ? " · entered by the seller" : ""}</span>${confirmButton(r)}</span>
            <span class="mc-end"><b>${money(r.business)}</b><br>${r.business > r.settled ? html`<span class="neg">short ${money(r.business - r.settled)}</span>` : html`<span class="muted">handed in</span>`}<br>${r.confirmed ? badge("green", r.self_entered ? "Confirmed" : "Entered") : badge("amber", "To confirm")}</span>`,
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
      } else {
        pane.innerHTML = d.people.length ? html`<div class="card"><div class="card-body flush">${dataTable({
          rows: d.people, footer: true, pageSize: 25, empty: "Nobody has sales in this period", emptyHint: "People show here once they have a sale in the dates you chose.",
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

    $$("#tabs button", el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; if (data) draw(); }));
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
