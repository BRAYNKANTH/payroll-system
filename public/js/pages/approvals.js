import { get, qs } from "../api.js";
import { can } from "../app.js";
import { $, html, icon, money, badge, emptyState, monthName, dateTime, initials, dataTable } from "../ui.js";
import { breakdownDrawer, flagList } from "./breakdown.js";

export default {
  title: "Approvals",
  async render(ctx) {
    const { el } = ctx;
    const [queue, recent] = await Promise.all([
      get("/api/review-queue"),
      get("/api/audit" + qs({ table: "pay_period_summary", limit: 30 })),
    ]);
    const periods = [...new Set(queue.map((r) => r.period))];

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Approvals</h1><p>Only entries that break a payroll rule land here. Everything else is processed automatically.</p></div>
      </div>
      ${!can("review") ? html`<div class="alert info" style="margin-bottom:16px">${icon("info")}<div>You can see the queue, but only accountants and admins can approve or reject.</div></div>` : ""}
      <div class="grid two">
        <div class="stack" id="queue"></div>
        <div class="card"><div class="card-head"><div><h3>Recent decisions</h3><div class="sub">From the audit trail</div></div></div>
          <div class="card-body flush" id="recent"></div></div>
      </div>`;

    $("#queue").innerHTML = !queue.length
      ? html`<div class="card">${emptyState("All clear", "No payroll entries are waiting for review.", "checkCircle")}</div>`.toString()
      : periods.map((p) => {
        const items = queue.filter((r) => r.period === p);
        return html`<div class="card"><div class="card-head"><div><h3>${monthName(p)}</h3><div class="sub">${items.length} to resolve</div></div></div>
          <div class="card-body">${items.map((r) => html`
            <div class="row" style="align-items:flex-start;padding:12px 0;border-top:1px solid var(--border);gap:14px" data-open="${r.period}|${r.employee_id}">
              <div class="avatar">${initials(r.name)}</div>
              <div style="flex:1;min-width:0">
                <div class="row between"><div><b>${r.name}</b> <span class="faint">${r.employee_id} · ${r.hub}</span></div>${badge(r.status)}</div>
                <div style="margin:8px 0 6px">${flagList(r.flags)}</div>
                <div class="row between"><span class="muted">Net pay <b class="${r.net_pay < 0 ? "neg" : ""}">Rs ${money(r.net_pay)}</b>${r.review_note ? ` · note: ${r.review_note}` : ""}</span>
                  <button class="btn sm primary" data-open-btn>${icon("eye")} Review</button></div>
              </div>
            </div>`)}</div></div>`;
      }).join("");

    el.addEventListener("click", (e) => {
      const box = e.target.closest("[data-open]");
      if (!box) return;
      const [p, id] = box.dataset.open.split("|");
      const row = queue.find((r) => r.period === p && r.employee_id === id);
      breakdownDrawer(row, { finalized: false, onChange: () => this.render(ctx) });
    });

    $("#recent").innerHTML = dataTable({
      rows: recent, sortable: false, empty: "No decisions yet",
      cols: [
        { key: "row_key", label: "Entry", render: (a) => html`<b>${a.row_key.split("@")[0]}</b><div class="faint" style="font-size:12px">${a.row_key.split("@")[1]}</div>` },
        { key: "action", label: "Decision", render: (a) => badge(a.action === "approve" ? "approved" : "rejected") },
        { key: "changed_by", label: "By", render: (a) => html`${a.changed_by}<div class="faint" style="font-size:12px">${dateTime(a.changed_at)}</div>` },
      ],
    }).toString();
  },
};
