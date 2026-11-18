import { get, post, put, del, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, html, icon, money, toast, busy, confirmDialog, drawer, dataTable, fromCents, emptyState } from "../ui.js";
import { periodLocked, lockedBanner } from "./shared.js";

export default {
  title: "Allowances",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, rows, locked] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      get("/api/allowances" + qs({ period: state.period, hub: scopeHub() })),
      periodLocked(state.period),
    ]);
    const byId = Object.fromEntries(staff.map((s) => [s.employee_id, s]));
    const editable = can("enter_data") && !locked;

    el.innerHTML = html`<div class="allow-page">
      <div class="page-head">
        <div><h1>Allowances</h1><p>Extra earnings for the month (transport, meals, bonuses). They are added to gross pay.</p></div>
        <div class="actions">${editable ? html`<button class="btn primary" id="add">${icon("plus")} Add allowance</button>` : ""}</div>
      </div>
      ${locked ? lockedBanner(state.period) : ""}
      <div class="card"><div class="card-body flush" id="list"></div></div></div>`;

    $("#list").innerHTML = rows.length ? dataTable({
      rows, footer: true,
      cols: [
        { key: "employee_id", label: "Employee", render: (r) => html`<div class="who"><div><b>${byId[r.employee_id]?.name || r.employee_id}</b><span>${r.employee_id} · ${byId[r.employee_id]?.hub || ""}</span></div></div>`, total: () => "Total" },
        { key: "description", label: "Description" },
        { key: "amount", label: "Amount (Rs)", align: "r", render: (r) => money(r.amount), total: (rs) => money(rs.reduce((t, r) => t + r.amount, 0)) },
        { key: "created_by", label: "Entered by", render: (r) => html`${r.updated_by || r.created_by}` },
        { key: "id", label: "", sort: false, align: "r", render: (r) => editable ? html`<button class="btn sm ghost" data-edit="${r.id}" aria-label="Edit allowance for ${byId[r.employee_id]?.name || r.employee_id}">${icon("edit")}</button><button class="btn sm icon danger-ghost" data-del="${r.id}" aria-label="Delete allowance for ${byId[r.employee_id]?.name || r.employee_id}">${icon("trash")}</button>` : "" },
      ],
    }).toString() : emptyState("No allowances this month", editable ? "Use “Add allowance” to record one." : "", "gift").toString();

    const open = (row) => {
      const d = drawer({
        title: row ? "Edit allowance" : "Add allowance",
        body: html`<form id="af" class="form-grid">
          <div class="field full"><label for="af-emp">Employee <span class="req">(required)</span></label><select class="input" id="af-emp" name="employee_id" ${row ? "disabled" : ""}>
            ${staff.filter((s) => s.status === "active" || s.employee_id === row?.employee_id).map((s) => html`<option value="${s.employee_id}" ${s.employee_id === row?.employee_id ? "selected" : ""}>${s.name} (${s.employee_id})</option>`)}</select></div>
          <div class="field full"><label for="af-desc">Description <span class="req">(required)</span></label><input class="input" id="af-desc" name="description" autocomplete="off" value="${row?.description || ""}" placeholder="e.g. Transport" required></div>
          <div class="field"><label for="af-amt">Amount (Rs) <span class="req">(required)</span></label><input class="input" id="af-amt" name="amount" inputmode="decimal" autocomplete="off" value="${row ? fromCents(row.amount) : ""}" required></div>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="af-save">Save</button>`,
      });
      $("#af-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const body = Object.fromEntries(new FormData($("#af", d.panel)));
        const bad = (id, msg) => { $(id, d.panel).setAttribute("aria-invalid", "true"); $(id, d.panel).focus(); throw new Error(msg); };
        if (!String(body.description || "").trim()) bad("#af-desc", "Say what the allowance is for, for example Transport");
        if (!(Number(String(body.amount || "").replace(/,/g, "")) > 0)) bad("#af-amt", "Enter the amount as a number above zero");
        if (row) await put(`/api/allowances/${row.id}`, { description: body.description, amount: body.amount });
        else await post("/api/allowances", { ...body, period: state.period });
        toast("Allowance saved");
        d.close();
        this.render(ctx);
      });
    };
    $("#add")?.addEventListener("click", () => open(null));
    // onclick, not addEventListener: render() runs again after every change and would stack a second handler.
    el.onclick = async (e) => {
      const ed = e.target.closest("[data-edit]");
      if (ed) return open(rows.find((r) => String(r.id) === ed.dataset.edit));
      const dl = e.target.closest("[data-del]");
      if (dl && (await confirmDialog({ title: "Delete allowance?", message: "This is recorded in the audit trail.", confirmText: "Delete", danger: true }))) {
        await busy(dl, async () => { await del(`/api/allowances/${dl.dataset.del}`); toast("Deleted"); this.render(ctx); });
      }
    };
  },
};
