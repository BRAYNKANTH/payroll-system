// Cash handover. Each day a hub's coacher hands the day's cash to the office: at least 90% of the hub's sales for the day.
// The coacher opens the day, types the amount and submits. The admin checks it against the cash received and approves it, or sends it back.
//   coacher            -> their hub's day: the sales, the least to hand over, one amount box, and the earlier handovers
//   admin, one hub     -> that hub's day, with Approve / Send back
//   admin, all hubs    -> what is waiting to be checked, then every hub's handover for the day
import { get, post, qs } from "../api.js";
import { state, can, navigate } from "../app.js";
import { $, $$, html, icon, money, badge, toast, busy, emptyState, drawer, dateLabel, dateTime } from "../ui.js";
import { today, addDays } from "../range.js";

let date = null;

const share = (amount, sales) => (sales > 0 ? Math.round((amount / sales) * 100) : 0);
const statusBadge = (h) => (!h ? badge("amber", "Not handed over") : h.status === "approved" ? badge("green", "Approved") : h.status === "rejected" ? badge("red", "Sent back") : badge("amber", "To verify"));
const flat = (cents) => (Number(cents) / 100).toFixed(2);

export default {
  title: "Cash handover",
  filters: false, // this page works by day and by hub, so the hub and month bar is not shown
  async render(ctx) {
    const { el } = ctx;
    const hubCode = state.user.hub || state.routeHub || "";
    const isCoach = !!state.user.hub;
    const canApprove = can("approve_cash");
    const now = today();
    if (!date || date > now) date = now;

    const head = html`<div class="page-head"><div><h1>Cash handover</h1><p>${isCoach
      ? "Each day, hand the day's cash to the office. It must be at least 90% of the hub's sales for the day. The admin checks it and approves it."
      : "Each hub's coacher hands the day's cash to the office: at least 90% of the hub's sales. Check what you received, then approve it or send it back."}</p></div></div>`;

    // ------------------------------------------------------------ a day bar: previous, date, next
    const dayBar = () => html`<div class="dl-daybar mb-4"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
      <button type="button" class="btn icon" id="ho-prev" aria-label="Previous day">${icon("left")}</button>
      <input type="date" class="input" id="ho-date" aria-label="Date" value="${date}" max="${now}" style="width:160px">
      <button type="button" class="btn icon" id="ho-next" aria-label="Next day" ${date >= now ? "disabled" : ""}>${icon("right")}</button>
      <b style="font-size:17px">${dateLabel(date)}</b></div></div>`;
    const wireDayBar = () => {
      const go = (d) => { if (d && d <= now) { date = d; this.render(ctx); } };
      $("#ho-prev").onclick = () => go(addDays(date, -1));
      $("#ho-next").onclick = () => go(addDays(date, 1));
      $("#ho-date").onchange = (e) => go(e.target.value);
    };

    // ------------------------------------------------------------ approve / send back (the admin)
    const decide = (list) => {
      $$("[data-approve]", el).forEach((b) => (b.onclick = () => busy(b, async () => {
        await post(`/api/handovers/${b.dataset.approve}/verify`, { approve: true });
        toast("Approved"); this.render(ctx);
      })));
      $$("[data-back]", el).forEach((b) => (b.onclick = () => {
        const h = list.find((x) => String(x.id) === b.dataset.back);
        const d = drawer({
          title: "Send this handover back",
          body: html`<p class="muted" style="margin-top:0">${h.hub_name || h.hub} · ${dateLabel(h.date)} · Rs ${money(h.amount)}. Tell the coacher what is wrong so they can correct it.</p>
            <div class="field"><label for="ho-why">Why <span class="req">(required)</span></label><input class="input" id="ho-why" maxlength="200" autocomplete="off" placeholder="For example: I received Rs 85,000 only"></div>`.toString(),
          foot: `<button class="btn" data-close>Cancel</button><button class="btn danger" id="ho-send">Send back</button>`,
        });
        $("#ho-send", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
          const note = $("#ho-why", d.panel).value.trim();
          if (!note) { $("#ho-why", d.panel).setAttribute("aria-invalid", "true"); $("#ho-why", d.panel).focus(); throw new Error("Say why you are sending it back"); }
          await post(`/api/handovers/${h.id}/verify`, { approve: false, note });
          toast("Sent back to the coacher"); d.close(); this.render(ctx);
        });
      }));
    };
    const buttons = (h) => (canApprove && h?.status === "pending"
      ? html`<span class="ho-actions"><button type="button" class="btn primary" data-approve="${h.id}">${icon("check")} Approve</button><button type="button" class="btn" data-back="${h.id}">Send back</button></span>` : "");

    // One handover as a card: the amount, the share of the day's sales, who and when, and (for the admin) the buttons.
    const card = (h, { withHub = false } = {}) => html`<div class="card ho-item">
      <div class="ho-top"><span class="dc-main"><b>${withHub ? (h.hub_name || h.hub) : dateLabel(h.date)}</b><span class="muted">${withHub ? dateLabel(h.date) + " · " : ""}by ${h.submitted_by} · ${dateTime(h.submitted_at)}</span></span>
        <span class="dc-sales"><b class="num">Rs ${money(h.amount)}</b><span class="muted">${share(h.amount, h.sales_now ?? h.sales)}% of Rs ${money(h.sales_now ?? h.sales)}</span></span></div>
      <div class="ho-mid">${statusBadge(h)}${h.short ? badge("red", `Sales are now higher: at least Rs ${money(h.min_now)} is needed`) : ""}</div>
      ${h.note ? html`<p class="ho-note">${h.note}</p>` : ""}
      ${h.status === "rejected" && h.verify_note ? html`<p class="ho-note neg">Sent back: ${h.verify_note}</p>` : ""}
      ${h.status === "approved" ? html`<p class="ho-note muted">Approved by ${h.verified_by} · ${dateTime(h.verified_at)}</p>` : ""}
      ${buttons(h)}</div>`;

    // ------------------------------------------------------------ the office, all hubs
    if (!hubCode) {
      const [d, waiting] = await Promise.all([get("/api/handovers/day" + qs({ date })), get("/api/handovers" + qs({ status: "pending", limit: 100 }))]);
      el.innerHTML = html`<div class="handover-page">${head}
        <section aria-label="Waiting for you"><h2 class="section-title drill-h">To verify ${waiting.length ? html`<span class="badge amber">${waiting.length}</span>` : ""}</h2>
          ${waiting.length ? html`<div class="drill-grid mb-4">${waiting.map((h) => card(h, { withHub: true }))}</div>`
            : html`<div class="card mb-4"><div class="card-body muted">Nothing is waiting. Every handover has been checked.</div></div>`}</section>
        <h2 class="section-title drill-h">Each hub's handover</h2>
        ${dayBar()}
        ${d.hubs.length ? html`<div class="card hs-list"><ul role="list">${d.hubs.map((h) => html`<li><a class="hs-row" href="/hubs/${encodeURIComponent(h.code)}/sales/handover" data-link aria-label="${h.name}: open its handover">
          <span class="hs-main"><b>${h.name}</b><span class="muted">${h.code} · sales Rs ${money(h.sales)}${h.handover ? ` · handed over Rs ${money(h.handover.amount)} (${share(h.handover.amount, h.sales)}%)` : h.sales ? ` · at least Rs ${money(h.min)} due` : " · no sales"}</span></span>
          <span class="hs-flags">${h.sales || h.handover ? statusBadge(h.handover) : badge("blue", "No sales")}</span><span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
          : emptyState("No hubs yet", "Add a hub first.", "store")}</div>`.toString();
      wireDayBar(); decide(waiting);
      return;
    }

    // ------------------------------------------------------------ one hub: the coacher, or the admin looking at that hub
    const [d, recent] = await Promise.all([get("/api/handovers/day" + qs({ date, hub: hubCode })), get("/api/handovers" + qs({ hub: hubCode, limit: 14 }))]);
    const h = d.hubs[0];
    if (!h) { el.innerHTML = html`<div class="handover-page">${head}<div class="card">${emptyState("Hub not found", "", "store")}</div></div>`.toString(); return; }
    const mine = h.handover, final = mine?.status === "approved";
    const editing = isCoach && !final && h.sales > 0;
    el.innerHTML = html`<div class="handover-page">${head}${dayBar()}
      <div class="grid kpis hub-kpis mb-4">
        <div class="card kpi"><div class="label">Sales for the day</div><div class="value"><span class="v-full"><small>Rs</small>${money(h.sales)}</span><span class="v-short">${money(h.sales)}</span></div><div class="foot">${h.name}</div></div>
        <div class="card kpi"><div class="label">Hand over at least</div><div class="value"><span class="v-full"><small>Rs</small>${money(h.min)}</span><span class="v-short">${money(h.min)}</span></div><div class="foot">${d.min_percent}% of the day's sales</div></div>
      </div>
      ${mine ? "" : html`<p class="muted mb-4">${h.sales <= 0 ? "" : isCoach ? "Not handed over yet." : "The coacher has not handed this day over yet."}</p>`}
      ${h.sales <= 0 ? html`<div class="alert info mb-4">${icon("info")}<div>No sales are entered for this day yet. ${isCoach ? html`Enter the day on the <a href="/hubs/${encodeURIComponent(hubCode)}/sales/daily" data-link>daily sheet</a> first.` : ""}</div></div>` : ""}
      ${mine ? html`<div class="mb-4">${card({ ...mine, hub_name: h.name, sales_now: h.sales, short: mine.status !== "approved" && mine.amount < h.min })}</div>` : ""}
      ${editing ? html`<form id="ho-form" class="card ho-form mb-4" novalidate>
        <h2 class="section-title" style="margin:0 0 4px">${mine?.status === "rejected" ? "Correct and hand over again" : mine ? "Change the amount" : "Hand over the cash"}</h2>
        <p class="muted" style="margin:0 0 12px">Type the amount you are handing to the office. It must be at least Rs ${money(h.min)}.</p>
        <div class="field"><label for="ho-amt">Amount handed over (Rs) <span class="req">(required)</span></label>
          <input class="input" id="ho-amt" name="amount" inputmode="decimal" autocomplete="off" value="${mine ? flat(mine.amount) : ""}" placeholder="${flat(h.min)}" aria-describedby="ho-hint"><span class="hint" id="ho-hint"></span></div>
        <div class="field"><label for="ho-note">Note (optional)</label><input class="input" id="ho-note" name="note" maxlength="200" autocomplete="off" value="${mine?.note || ""}" placeholder="For example: handed to the office at 6 pm"></div>
        <button type="submit" class="btn primary" id="ho-submit">${icon("check")} ${mine ? "Hand over again" : "Hand over"}</button></form>` : ""}
      ${isCoach && final ? html`<div class="alert ok mb-4">${icon("check")}<div>This day's handover is approved. It cannot be changed.</div></div>` : ""}
      <h2 class="section-title drill-h">Earlier handovers</h2>
      ${recent.length ? html`<div class="drill-grid">${recent.filter((r) => r.date !== date).map((r) => card(r))}</div>` : html`<div class="card"><div class="card-body muted">No handovers yet.</div></div>`}</div>`.toString();
    wireDayBar(); decide(recent.concat(mine ? [{ ...mine, hub_name: h.name }] : []));

    // The amount box tells you at once whether it is enough.
    const amt = $("#ho-amt"), hint = $("#ho-hint"), submit = $("#ho-submit");
    if (amt) {
      const check = () => {
        const v = Number(String(amt.value).replace(/,/g, ""));
        const cents = Math.round(v * 100);
        if (!amt.value.trim()) { hint.textContent = ""; hint.className = "hint"; submit.disabled = true; return; }
        if (!Number.isFinite(v) || v <= 0) { hint.textContent = "Enter the amount as a number."; hint.className = "hint neg"; submit.disabled = true; return; }
        const ok = cents >= h.min;
        hint.textContent = ok ? `${share(cents, h.sales)}% of the day's sales. That is enough.` : `${share(cents, h.sales)}% of the day's sales. At least Rs ${money(h.min)} is needed.`;
        hint.className = ok ? "hint pos" : "hint neg";
        submit.disabled = !ok;
      };
      amt.addEventListener("input", check); check();
      $("#ho-form").onsubmit = (e) => { e.preventDefault(); busy(submit, async () => {
        await post("/api/handovers", { date, amount: amt.value, note: $("#ho-note").value });
        toast("Handed over. The admin will check it"); this.render(ctx);
      }); };
    }
  },
};
