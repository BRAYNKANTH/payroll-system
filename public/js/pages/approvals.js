import { get, post, qs } from "../api.js";
import { can, refreshPending } from "../app.js";
import { $, $$, html, icon, money, badge, emptyState, monthName, dateTime, initials, dataTable, toast, busy, buzz, confirmDialog } from "../ui.js";
import { breakdownDrawer, flagList } from "./breakdown.js";
import { swipeTabs } from "../phone.js";

const QUEUE_SHOWN = 8; // a long queue shows its first items; the rest open on request
let filter = "all"; // 'all' | 'bank' | 'pay' | 'deduct'

const matchesFilter = (r, f) => {
  if (f === "all") return true;
  if (f === "bank") return r.flags.some((x) => x.code.includes("bank"));
  if (f === "pay") return r.flags.some((x) => x.code.includes("net_pay") || x.code.includes("gross") || x.code.includes("target"));
  if (f === "deduct") return r.flags.some((x) => x.code.includes("deduction") || x.code.includes("stock") || x.code.includes("balance") || x.code.includes("minus"));
  return true;
};

export default {
  title: "Approvals",
  async render(ctx) {
    const { el } = ctx;
    const [queue, recent] = await Promise.all([
      get("/api/review-queue"),
      get("/api/audit" + qs({ table: "pay_period_summary", limit: 30 })),
    ]);
    const periods = [...new Set(queue.map((r) => r.period))];

    const cBank = queue.filter((r) => matchesFilter(r, "bank")).length;
    const cPay = queue.filter((r) => matchesFilter(r, "pay")).length;
    const cDeduct = queue.filter((r) => matchesFilter(r, "deduct")).length;

    const availableFilters = [
      ["all", `All (${queue.length})`],
      ...(cBank ? [["bank", `Bank (${cBank})`]] : []),
      ...(cPay ? [["pay", `Pay changes (${cPay})`]] : []),
      ...(cDeduct ? [["deduct", `Deductions (${cDeduct})`]] : []),
    ];
    if (!availableFilters.some(([f]) => f === filter)) filter = "all";

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Approvals</h1><p>Only entries that break a payroll rule land here. Everything else is processed automatically.</p></div>
      </div>
      ${!can("review") ? html`<div class="alert info mb-4">${icon("info")}<div>You can see the queue, but only the admin can approve or reject.</div></div>` : ""}
      
      ${queue.length && availableFilters.length > 1 ? html`
      <div class="seg mb-3" id="app-filters" role="tablist" aria-label="Approvals filter">
        ${availableFilters.map(([f, label]) => html`<button type="button" class="${filter === f ? "on" : ""}" data-af="${f}" role="tab" aria-selected="${filter === f}">${label}</button>`)}
      </div>` : ""}

      <div class="grid two">
        <div class="stack" id="queue"></div>
        <div class="card"><div class="card-head"><div><h2>Recent decisions</h2><div class="sub">From the audit trail</div></div></div>
          <div class="card-body flush" id="recent"></div></div>
      </div>`;

    const renderQueue = () => {
      const filtered = queue.filter((r) => matchesFilter(r, filter));
      $("#queue").innerHTML = !filtered.length
        ? html`<div class="card">${emptyState("No entries in this category", "All entries under this filter have been resolved.", "checkCircle")}</div>`.toString()
        : periods.map((p) => {
          const items = filtered.filter((r) => r.period === p);
          if (!items.length) return "";
          const pending = items.filter((x) => x.status === "pending_review");
          return html`<div class="card"><div class="card-head"><div><h2>${monthName(p)}</h2><div class="sub">${items.length} to resolve</div></div>
            ${can("review") && pending.length > 1 ? html`<button type="button" class="btn sm" id="bulk-approve" data-period="${p}">${icon("check")} Approve all (${pending.length})</button>` : ""}
          </div>
            <div class="card-body">${items.map((r, i) => html`
              <div class="row queue-item" ${i >= QUEUE_SHOWN ? "hidden data-extra" : ""} data-open="${r.period}|${r.employee_id}">
                <div class="avatar" aria-hidden="true">${initials(r.name)}</div>
                <div class="queue-main">
                  <div class="row between"><div><b>${r.name}</b> <span class="faint">${r.employee_id} · ${r.hub}</span></div>${badge(r.status)}</div>
                  <div style="margin:8px 0 6px">${flagList(r.flags)}</div>
                  <div class="row between"><span class="muted">Net pay <b class="${r.net_pay < 0 ? "neg" : ""}">Rs ${money(r.net_pay)}</b>${r.review_note ? ` · note: ${r.review_note}` : ""}</span>
                    <button type="button" class="btn sm primary" data-open-btn aria-label="Review ${r.name}">${icon("eye")} Review</button></div>
                </div>
              </div>`)}${items.length > QUEUE_SHOWN ? html`<button type="button" class="btn mt-3" data-more-queue>Show ${items.length - QUEUE_SHOWN} more</button>` : ""}</div></div>`;
        }).join("");
    };

    renderQueue();

    // Wire filter buttons
    $$("[data-af]", el).forEach((b) => {
      b.onclick = () => {
        filter = b.dataset.af;
        $$("[data-af]", el).forEach((x) => x.classList.toggle("on", x.dataset.af === filter));
        renderQueue();
        buzz(6);
      };
    });

    // Wire touch swipe across filter categories
    if (availableFilters.length > 1) {
      swipeTabs({
        el: $("#queue"),
        tabs: availableFilters.map(([f]) => f),
        getActive: () => filter,
        setActive: (f) => {
          filter = f;
          $$("[data-af]", el).forEach((x) => x.classList.toggle("on", x.dataset.af === filter));
          renderQueue();
          buzz(8);
        },
      });
    }

    // onclick, not addEventListener: render() runs again after every decision and would stack a second handler.
    el.onclick = async (e) => {
      const bulkBtn = e.target.closest("#bulk-approve");
      if (bulkBtn) {
        const period = bulkBtn.dataset.period;
        const toApprove = queue.filter((r) => r.period === period && matchesFilter(r, filter) && r.status === "pending_review");
        if (!toApprove.length) return;
        if (!(await confirmDialog({
          title: `Approve all ${toApprove.length} entries?`,
          message: `All ${toApprove.length} pending entries under this category for ${monthName(period)} will be approved.`,
          confirmText: "Approve all",
        }))) return;
        await busy(bulkBtn, async () => {
          for (const item of toApprove) {
            await post(`/api/payroll/${item.period}/${encodeURIComponent(item.employee_id)}/approve`, { note: "Approved via category review" });
          }
          toast(`Approved ${toApprove.length} entries`);
          refreshPending();
          this.render(ctx);
        });
        return;
      }
      const more = e.target.closest("[data-more-queue]");
      if (more) { const body = more.parentElement; body.querySelectorAll("[data-extra]").forEach((x) => x.removeAttribute("hidden")); more.remove(); return; }
      const box = e.target.closest("[data-open]");
      if (!box) return;
      const [p, id] = box.dataset.open.split("|");
      const row = queue.find((r) => r.period === p && r.employee_id === id);
      breakdownDrawer(row, { finalized: false, onChange: () => this.render(ctx) });
    };

    $("#recent").innerHTML = dataTable({
      rows: recent, sortable: false, pageSize: 5, empty: "No decisions yet", emptyHint: "Approved and rejected items will show here.",
      cols: [
        { key: "row_key", label: "Entry", render: (a) => html`<b>${a.row_key.split("@")[0]}</b><div class="faint text-sm">${a.row_key.split("@")[1]}</div>` },
        { key: "action", label: "Decision", render: (a) => badge(a.action === "approve" ? "approved" : "rejected") },
        { key: "changed_by", label: "By", render: (a) => html`${a.changed_by}<div class="faint text-sm">${dateTime(a.changed_at)}</div>` },
      ],
    }).toString();
  },
};
