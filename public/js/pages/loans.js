// Advances and loans: who has one, how much is left, and what comes off pay this month.
import { get, post, put, del, qs } from "../api.js";
import { state, can, scopeHub } from "../app.js";
import { $, html, icon, money, toast, busy, confirmDialog, drawer, dataTable, badge, emptyState, monthName, shortMonth, dateLabel, fromCents } from "../ui.js";

const shift = (period, n) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const given = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const whole = (c) => "Rs " + Math.round(c / 100).toLocaleString("en-LK"); // big totals read better without cents
const kindLabel = (k) => (k === "advance" ? "Advance" : "Loan");
const stateBadge = (s) => (s === "paid" ? badge("blue", "Paid off") : s === "stopped" ? badge("amber", "Stopped") : badge("green", "Active"));
const FILTERS = [["active", "Active"], ["paid", "Paid off"], ["stopped", "Stopped"], ["", "All"]];
let filter = "active";

// "Rs 30,000 over 3 months: Aug, Sep, Oct (the last one Rs 10,000)"
function schedule(amount, instalment, already, start) {
  const left = amount - already;
  if (!(left > 0) || !(instalment > 0)) return "";
  const n = Math.ceil(left / instalment);
  const last = left - instalment * (n - 1);
  const at = (i) => shortMonth(shift(start, i));
  const months = n <= 6 ? Array.from({ length: n }, (_, i) => at(i)).join(", ") : `${at(0)}, ${at(1)}, ${at(2)} … ${at(n - 1)}`;
  return `Rs ${money(left * 100)} back in ${n} month${n === 1 ? "" : "s"}: ${months}${n > 1 && last !== instalment ? ` (the last one is Rs ${money(last * 100)})` : ""}. ` +
    "If a month's pay is too low to cover it, the rest moves to the next month.";
}

export default {
  title: "Advances & loans",
  periodic: true,
  async render(ctx) {
    const { el } = ctx;
    const [staff, all, periods] = await Promise.all([
      get("/api/staff" + qs({ hub: scopeHub() })),
      get("/api/loans" + qs({ period: state.period, hub: scopeHub() })),
      get("/api/periods"),
    ]);
    const editable = can("manage_loans");
    const finalized = new Set(periods.filter((p) => p.status === "finalized").map((p) => p.period));
    const rows = filter ? all.filter((l) => l.state === filter) : all;
    const live = all.filter((l) => l.state === "active");
    const owing = new Set(all.filter((l) => l.outstanding > 0 && l.state !== "stopped").map((l) => l.employee_id)).size;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Advances & loans</h1><p>Money given to staff and taken back from their pay. An advance comes back in one month; a loan comes back in monthly instalments.</p></div>
        <div class="actions">${editable ? html`<button class="btn primary" id="add">${icon("plus")} Give advance or loan</button>` : ""}</div>
      </div>
      <div class="grid kpis mb-4">
        <div class="card kpi"><div class="label">Still to be paid back</div><div class="value">${whole(live.reduce((t, l) => t + l.outstanding, 0))}</div><div class="foot">${live.length} active</div></div>
        <div class="card kpi"><div class="label">Comes off pay in ${monthName(state.period)}</div><div class="value">${whole(live.reduce((t, l) => t + l.due, 0))}</div><div class="foot">Before any month's pay is too low to cover it</div></div>
        <div class="card kpi"><div class="label">People who owe money</div><div class="value">${owing}</div><div class="foot">${all.length} advance${all.length === 1 ? "" : "s"} and loans recorded</div></div>
      </div>
      <div class="row between mb-3" style="gap:12px;flex-wrap:wrap">
        <div class="seg" id="flt" role="group" aria-label="Show">${FILTERS.map(([v, l]) => html`<button type="button" data-v="${v}" aria-pressed="${filter === v}" class="${filter === v ? "on" : ""}">${l}</button>`)}</div>
      </div>
      <div class="card"><div class="card-body flush" id="list"></div></div>`;

    $("#flt").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) { filter = b.dataset.v; this.render(ctx); } };

    $("#list").innerHTML = rows.length ? dataTable({
      rows, onRow: (l) => detail(l), rowLabel: (l) => `Open ${kindLabel(l.kind).toLowerCase()} for ${l.name}`, rowAction: "Open",
      card: (l) => html`<span class="mc-main"><b>${l.name}</b><span class="mc-sub">${l.employee_id} · ${kindLabel(l.kind)} of Rs ${money(l.amount)} · ${given(l.issued_on)}</span>
          <span class="mc-kv"><span class="k">Still owes</span><span class="v">${whole(l.outstanding)}</span></span>
          ${l.state === "active" ? html`<span class="mc-kv"><span class="k">${shortMonth(state.period)} deduction</span><span class="v">${whole(l.due)}</span></span>` : ""}</span>
        <span class="mc-end">${stateBadge(l.state)}</span>`,
      cols: [
        { key: "name", label: "Person", render: (l) => html`<div class="who"><div><b>${l.name}</b><span>${l.employee_id} · ${l.hub} · ${kindLabel(l.kind)} given ${given(l.issued_on)}</span></div></div>` },
        { key: "amount", label: "Amount (Rs)", align: "r", render: (l) => money(l.amount) },
        { key: "outstanding", label: "Still owes (Rs)", align: "r", render: (l) => html`<b>${money(l.outstanding)}</b>` },
        { key: "due", label: `${shortMonth(state.period)} deduction (Rs)`, align: "r", render: (l) => (l.state === "active" ? money(l.due) : "—") },
        { key: "state", label: "Status", render: (l) => stateBadge(l.state) },
      ],
    }).toString() : emptyState(all.length ? "Nothing in this view" : "No advances or loans yet",
      editable && !all.length ? "Use “Give advance or loan” when someone takes money from the company. It comes off their pay automatically." : "", "wallet").toString();

    // ---- one loan: what has come back, and the things that can still change
    const detail = (l) => {
      const canChange = editable && l.state !== "paid";
      const hasRep = l.repayments.length > 0;
      const d = drawer({
        title: `${kindLabel(l.kind)} for ${l.name}`,
        body: html`
          <dl class="kv">
            <dt>Given</dt><dd>Rs ${money(l.amount)} on ${given(l.issued_on)}</dd>
            <dt>Paid back</dt><dd>Rs ${money(l.repaid)}${l.already_repaid ? html` <span class="faint">(Rs ${money(l.already_repaid)} before this system)</span>` : ""}</dd>
            <dt>Still owes</dt><dd><b>Rs ${money(l.outstanding)}</b></dd>
            <dt>${l.kind === "advance" ? "Taken back" : "Each month"}</dt><dd>${l.kind === "advance" ? `all at once from ${monthName(l.start_period)} pay` : `Rs ${money(l.instalment)} from ${monthName(l.start_period)}`}</dd>
            <dt>Status</dt><dd>${stateBadge(l.state)}</dd>
          </dl>
          ${l.state === "active" && l.due ? html`<div class="alert info mt-3">${icon("info")}<div>Rs ${money(l.due)} comes off ${monthName(state.period)} pay. It is recorded for good when that month is finalized.</div></div>` : ""}
          ${l.state === "stopped" ? html`<div class="alert warn mt-3">${icon("alert")}<div>Nothing more is taken from pay while this is stopped.</div></div>` : ""}
          <h4 style="margin:18px 0 6px">Taken from pay</h4>
          ${hasRep ? html`<ul style="list-style:none;margin:0;padding:0">${l.repayments.map((r) => html`<li style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0"><span style="white-space:nowrap">${shortMonth(r.period)} ${r.period.slice(0, 4)}</span><span style="display:flex;align-items:center;gap:8px;white-space:nowrap"><b>Rs ${money(r.amount)}</b> ${r.final ? badge("green", "Final") : badge("amber", "Not final")}</span></li>`)}</ul>`
            : html`<p class="muted" style="margin:0">Nothing yet. The first deduction is in ${monthName(l.start_period)} pay.</p>`}
          ${canChange ? html`<form id="lf" class="form-grid" style="margin-top:18px">
            ${l.kind === "loan" ? html`<div class="field"><label for="l-inst">Monthly instalment (Rs)</label><input class="input" id="l-inst" name="instalment" inputmode="decimal" value="${fromCents(l.instalment)}"></div>` : ""}
            <div class="field full"><label for="l-note">Note</label><input class="input" id="l-note" name="note" value="${l.note || ""}" placeholder="Why it was given, who approved it"></div>
          </form>` : l.note ? html`<p class="muted" style="margin-top:14px">${l.note}</p>` : ""}`.toString(),
        foot: canChange ? `${!hasRep ? `<button class="btn danger-ghost" id="l-del" style="margin-right:auto">Delete</button>` : ""}
          <button class="btn" id="l-stop">${l.state === "stopped" ? "Resume deductions" : "Stop deductions"}</button>
          <button class="btn primary" id="l-save">Save</button>` : `<button class="btn" data-close>Close</button>`,
      });
      if (!canChange) return;
      const done = (msg) => { toast(msg); d.close(); this.render(ctx); };
      $("#l-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData($("#lf", d.panel)));
        await put(`/api/loans/${l.id}`, v);
        done("Saved");
      });
      $("#l-stop", d.panel).onclick = async (e) => {
        const resume = l.state === "stopped";
        if (!resume && !(await confirmDialog({ title: "Stop taking this from pay?", message: `Nothing more will come off ${l.name}'s pay. Rs ${money(l.outstanding)} stays recorded as owed, and you can resume it later.`, confirmText: "Stop deductions" }))) return;
        await busy(e.currentTarget, async () => { await put(`/api/loans/${l.id}`, { status: resume ? "active" : "stopped" }); done(resume ? "Deductions resumed" : "Deductions stopped"); });
      };
      $("#l-del", d.panel)?.addEventListener("click", async (e) => {
        if (!(await confirmDialog({ title: "Delete this record?", message: "Nothing has been taken from pay yet, so it can be removed. This is recorded in the audit trail.", confirmText: "Delete", danger: true }))) return;
        await busy(e.currentTarget, async () => { await del(`/api/loans/${l.id}`); done("Deleted"); });
      });
    };

    // ---- give one
    const open = () => {
      const people = staff.filter((s) => s.role === "guy" && s.status === "active");
      const first = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => shift(state.period, i)).filter((p) => !finalized.has(p));
      const d = drawer({
        title: "Give advance or loan",
        body: html`<form id="nf" class="form-grid" autocomplete="off">
          <div class="field full"><label for="n-emp">Employee</label><select class="input" id="n-emp" name="employee_id" required>
            <option value="">Choose a person</option>${people.map((s) => html`<option value="${s.employee_id}">${s.name} (${s.employee_id}) · ${s.hub}</option>`)}</select></div>
          <div class="field full"><span class="lbl">What is it?</span>
            <div class="grid halves" style="gap:8px;margin-top:4px">
              <label class="card" style="padding:10px 12px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;box-shadow:none"><input type="radio" name="kind" value="advance" checked style="margin-top:3px">
                <span><b style="color:var(--text)">Advance</b><br><span class="faint" style="font-weight:400">Taken back in full from one month's pay</span></span></label>
              <label class="card" style="padding:10px 12px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;box-shadow:none"><input type="radio" name="kind" value="loan" style="margin-top:3px">
                <span><b style="color:var(--text)">Loan</b><br><span class="faint" style="font-weight:400">Paid back in monthly instalments</span></span></label></div></div>
          <div class="field"><label for="n-amt">Amount given (Rs)</label><input class="input" id="n-amt" name="amount" inputmode="decimal" required aria-required="true" placeholder="e.g. 20,000"></div>
          <div class="field"><label for="n-date">Date given</label><input class="input" id="n-date" type="date" name="issued_on" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field" id="inst-wrap" hidden><label for="n-inst">Monthly instalment (Rs)</label><input class="input" id="n-inst" name="instalment" inputmode="decimal" placeholder="e.g. 5,000"></div>
          <div class="field"><label for="n-start">First taken from</label><select class="input" id="n-start" name="start_period">${first.map((p) => html`<option value="${p}">${monthName(p)} pay</option>`)}</select></div>
          <div class="field full"><div class="alert info" id="plan" aria-live="polite" hidden>${icon("info")}<div></div></div></div>
          <div class="field full"><label for="n-note">Note <span class="faint">(optional)</span></label><input class="input" id="n-note" name="note" placeholder="Why it was given, who approved it"></div>
          <details class="field full"><summary class="muted" style="cursor:pointer">Moving an old loan over from Excel?</summary>
            <div class="field" style="margin-top:10px"><label for="n-done">Already paid back (Rs)</label><input class="input" id="n-done" name="already_repaid" inputmode="decimal" placeholder="0">
              <span class="hint">Enter the full original amount above, and what has already been repaid here. Only the rest is taken from pay.</span></div></details>
        </form>`.toString(),
        foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="n-save">Save</button>`,
      });
      const f = $("#nf", d.panel);
      const num = (n) => Number(String(f.elements[n].value || "").replace(/,/g, "")) || 0;
      const preview = () => {
        const loan = f.elements.kind.value === "loan";
        $("#inst-wrap", d.panel).hidden = !loan;
        const amount = num("amount"), inst = loan ? num("instalment") : amount;
        const text = amount > 0 && inst > 0 ? schedule(amount, inst, num("already_repaid"), f.elements.start_period.value) : "";
        $("#plan", d.panel).hidden = !text;
        $("#plan div", d.panel).textContent = text;
      };
      f.addEventListener("input", preview);
      f.addEventListener("change", preview);
      $("#n-save", d.panel).onclick = (e) => busy(e.currentTarget, async () => {
        const v = Object.fromEntries(new FormData(f));
        if (v.kind === "advance") delete v.instalment;
        await post("/api/loans", v);
        done();
      });
      const done = () => { toast("Saved. It comes off pay from the month you chose."); d.close(); this.render(ctx); };
    };
    $("#add")?.addEventListener("click", open);
  },
};
