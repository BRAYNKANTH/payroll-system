// Staff portal: one page for a distributor, supervisor or group manager, showing only their own figures.
import { get, post } from "../api.js";
import { state } from "../app.js";
import { $, $$, html, raw, icon, money, compact, badge, toast, busy, dataTable, emptyState, monthName, dateLabel, pct, dateTime } from "../ui.js";

let tab = "month";
const DOC_TYPES = [["nic", "ID / NIC"], ["bank_book", "Bank book front page"], ["ol_results", "O/L results sheet"], ["other", "Other"]];
const DOC_MAX = 3_000_000;
const fileSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const readBase64 = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(new Error("The file could not be read"));
  r.readAsDataURL(file);
});

// The person's own pay rules in plain words.
function payRules(p) {
  const rs = (c) => `Rs ${money(c)}`;
  const lines = [];
  if (p.pay_scheme === "tiered") {
    lines.push(`If your sales in the month go over <b>${rs(p.target)}</b>: a fixed basic pay of <b>${rs(p.basic_pay)}</b> plus <b>${pct(p.commission_rate, 0)}</b> of the sales above the target.`);
    lines.push(`If your sales are <b>${rs(p.target)}</b> or less: <b>${pct(p.base_commission_rate, 0)}</b> of all your sales, and no basic pay.`);
  } else {
    lines.push(`A basic pay of <b>${rs(p.basic_pay)}</b> every month, plus <b>${pct(p.commission_rate, 0)}</b> of the sales above <b>${rs(p.target)}</b>.`);
  }
  if (p.food_per_day) lines.push(`Food: <b>${rs(p.food_per_day)}</b> for every day you work${p.food_min_days ? `, once you have worked ${p.food_min_days} days or more` : ""}.`);
  const m = /^(fixed|pct_gross|pct_basic|pct_business):([\d.]+)/.exec(p.security_deduction_rule || "");
  if (m) lines.push(`Security held back: <b>${m[1] === "fixed" ? `Rs ${m[2]}` : `${m[2]}%`}</b>${{ fixed: " each month", pct_gross: " of your gross pay", pct_basic: " of your basic pay", pct_business: " of your sales" }[m[1]]}.`);
  lines.push("Taken off your pay: the difference between your sales and the money you handed in, any stock that is missing, and any advance you took.");
  return lines;
}

const kpi = (label, value, ic, color, foot = "") => html`
  <div class="card kpi"><div class="label"><span class="icon ${color}">${icon(ic)}</span>${label}</div>
  <div class="value">${raw(value)}</div><div class="foot">${raw(foot)}</div></div>`;

const payTable = (lines) => `<table class="table"><tbody>${lines.filter((l) => l.amount !== 0 || /Basic/.test(l.label))
  .map((l) => `<tr><td>${html`${l.label}`}</td><td class="r">${money(l.amount)}</td></tr>`).join("")}</tbody></table>`;

export default {
  title: "My page",
  async render(ctx) {
    const { el } = ctx;
    el.classList.add("has-bottom-tabs");
    const d = await get("/api/me/portal?period=" + state.period);
    const me = d.me, m = d.month;
    const hasTeam = !!d.team;
    const attain = m.target ? m.business / m.target : 0;
    const bar = attain >= 1 ? "green" : attain >= 0.7 ? "" : "amber";

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Hello, ${me.name.split(" ")[0]}</h1>
          <p>${badge("green", me.level_name)} ${me.hub_name}${me.reports_to ? ` · reports to ${me.reports_to}` : ""} · ${monthName(d.period)} ${badge(d.finalized ? "finalized" : "open")}</p></div>
      </div>
      <div class="tabs portal-tabs" id="tabs" aria-label="My page sections">${[["month", "This month", "Month", "chart", ""], ["payslips", "Payslips", "Payslips", "wallet", d.history.length],
        ...(hasTeam ? [["team", "My team", "Team", "users", d.team.length]] : []), ["documents", "My documents", "Documents", "file", ""], ["details", "My details", "Details", "user", ""]]
        .map(([k, long, short, ic, n]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}"><span class="tab-ic">${icon(ic)}</span><span class="tab-lb"><span class="lg">${long}</span><span class="sm">${short}</span></span>${n !== "" ? html`<span class="cnt">(${n})</span>` : ""}</button>`)}</div>
      <div id="pane"></div>`;

    const panes = {
      month: () => html`
        <div class="grid kpis mb-4">
          ${kpi("Your sales so far", `<small>Rs</small>${compact(m.business)}`, "chart", "blue", `<b class="num">Rs ${money(m.business)}</b> in ${m.days} day${m.days === 1 ? "" : "s"}`)}
          ${kpi("Target", `<small>Rs</small>${compact(m.target)}`, "trend", attain >= 1 ? "green" : "amber",
            m.target ? (attain >= 1 ? `Passed. <b class="num">Rs ${money(m.over_target)}</b> over the target` : `<b class="num">Rs ${money(m.to_go)}</b> still to go`) : "No target set")}
          ${kpi("Taken off so far", `<small>Rs</small>${compact(m.settle_up + m.personal)}`, "coins", "amber", `Settle-up Rs ${money(m.settle_up)} · advances Rs ${money(m.personal)}`)}
          ${d.finalized && d.official ? kpi("Net pay", `<small>Rs</small>${compact(d.official.net)}`, "wallet", "green", `Paid to bank <b class="num">Rs ${money(d.official.paid)}</b>`)
            : d.estimate ? kpi("Estimated net pay", `<small>Rs</small>${compact(d.estimate.net)}`, "wallet", "", "Not final. See below") : kpi("Net pay", "—", "wallet", "", "Nothing entered yet")}
        </div>
        ${m.target ? html`<div class="card mb-4"><div class="card-body">
          <div class="row between"><b>Progress to your target</b><span class="num">${pct(attain, 0)}</span></div>
          <div class="progress ${bar}" style="margin-top:8px" role="progressbar" aria-label="Progress to target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(attain, 1) * 100)}"><span style="width:${Math.min(100, attain * 100)}%"></span></div>
        </div></div>` : ""}

        ${d.official ? html`<div class="card mb-4"><div class="card-head"><div><h2>Your pay for ${monthName(d.period)}</h2><div class="sub">Final. The month is closed.</div></div>
            <a class="btn sm primary" href="/api/me/payslip/${d.period}" target="_blank" rel="noopener">${icon("printer")} Open payslip</a></div>
          <div class="card-body flush">${raw(payTable([...d.official.earnings, { label: "Gross earnings", amount: d.official.gross }]))}
            ${raw(payTable([...d.official.deduction_lines, { label: "Total deductions", amount: d.official.deductions }]))}
            <table class="table"><tbody><tr><td>Balance brought forward</td><td class="r">${money(d.official.opening)}</td></tr>
              <tr><td><b>Net pay</b></td><td class="r"><b class="${d.official.net < 0 ? "neg" : ""}">${money(d.official.net)}</b></td></tr>
              <tr><td>Paid to your bank</td><td class="r">${money(d.official.paid)}</td></tr>
              <tr><td>Balance carried to next month</td><td class="r ${d.official.closing < 0 ? "neg" : ""}">${money(d.official.closing)}</td></tr></tbody></table></div></div>`
        : d.estimate ? html`<div class="card mb-4"><div class="card-head"><div><h2>Estimate so far</h2><div class="sub">Worked out with your pay rules from the sales entered up to now</div></div>${badge("amber", "Not final")}</div>
          <div class="card-body flush">${raw(payTable([...d.estimate.earnings, { label: "Gross earnings", amount: d.estimate.gross }]))}
            ${raw(payTable([...d.estimate.deduction_lines, { label: "Total deductions", amount: d.estimate.deductions }]))}
            <table class="table"><tbody><tr><td><b>Estimated net pay</b></td><td class="r"><b class="${d.estimate.net < 0 ? "neg" : ""}">${money(d.estimate.net)}</b></td></tr></tbody></table></div>
          <div class="card-foot muted">This changes as more days are entered. The office calculates the final figure at the end of the month and may check some entries first. Your payslip appears here after the month is closed.</div></div>`
        : html`<div class="card mb-4">${emptyState("No sales entered yet this month", "When your daily sales are entered, your progress and an estimate of your pay appear here.", "chart")}</div>`}

        <div class="card mb-4"><div class="card-head"><div><h2>Your days</h2><div class="sub">Sales and the money you handed in</div></div></div>
          <div class="card-body flush" id="days"></div></div>
        ${m.stock.length ? html`<div class="card mb-4"><div class="card-head"><div><h2>Stock count</h2><div class="sub">Missing pieces are taken off your pay</div></div></div><div class="card-body flush" id="stock"></div></div>` : ""}
        ${m.allowances.length ? html`<div class="card mb-4"><div class="card-head"><h2>Allowances this month</h2></div><div class="card-body flush" id="allow"></div></div>` : ""}
        <details class="card fold"><summary><h2>How your pay is worked out</h2></summary><div class="card-body"><ul style="margin:0;padding-left:18px">${raw(payRules(me.pay).map((l) => `<li style="margin-bottom:6px">${l}</li>`).join(""))}</ul></div></details>`,

      payslips: () => d.history.length ? html`<div class="card"><div class="card-body flush" id="hist"></div></div>
        <p class="muted" style="margin-top:12px">Security held back so far: <b class="num">Rs ${money(d.security_held)}</b>.</p>`
        : html`<div class="card">${emptyState("No payslips yet", "Your payslip for a month appears here once the office has closed that month.", "file")}</div>`,

      team: () => html`<div class="card mb-4"><div class="card-head"><div><h2>Your team in ${monthName(d.period)}</h2><div class="sub">Sales only. Pay is private to each person.</div></div></div>
        <div class="card-body flush" id="team"></div></div>`,

      documents: () => html`<div class="card"><div class="card-head"><div><h2>My documents</h2><div class="sub">JPG, PNG, WebP or PDF, up to 3 MB each</div></div></div>
        <div class="card-body" id="docs"><div class="loading-screen"><div class="spinner"></div></div></div></div>`,

      details: () => html`<div class="grid halves"><div class="card"><div class="card-head"><h2>My details</h2></div><div class="card-body"><dl class="kv">
          <dt>Name</dt><dd>${me.name}</dd><dt>Employee ID</dt><dd class="mono">${me.employee_id}</dd><dt>Position</dt><dd>${me.level_name}</dd>
          <dt>Hub</dt><dd>${me.hub_name}</dd><dt>Reports to</dt><dd>${me.reports_to || "—"}</dd>
          <dt>Phone</dt><dd>${me.phone || "—"}</dd><dt>NIC</dt><dd>${me.nic || "—"}</dd><dt>Joined</dt><dd>${me.join_date || "—"}</dd></dl></div></div>
        <div class="card"><div class="card-head"><h2>Bank</h2></div><div class="card-body"><dl class="kv"><dt>Bank</dt><dd>${me.bank_name || "—"}</dd>
          <dt>Account</dt><dd class="mono">${me.bank_last4 ? "…" + me.bank_last4 : "—"}</dd></dl>
          <p class="muted" style="margin:12px 0 0">To change your phone, bank account or any other detail, ask your hub manager.</p></div></div></div>`,
    };

    const drawDocs = async () => {
      const docs = await get("/api/me/documents");
      const box = $("#docs");
      if (!box) return;
      box.innerHTML = html`<div class="stack">${DOC_TYPES.map(([k, l]) => {
        const mine = docs.filter((x) => x.doc_type === k);
        return html`<div class="row between" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
          <div style="min-width:200px;flex:1"><b>${l}</b> ${k === "other" ? "" : mine.length ? badge("green", "On file") : badge("amber", "Missing")}
            ${mine.map((x) => html`<div class="row" style="gap:8px;margin-top:6px"><a href="/api/me/documents/${x.id}" target="_blank" rel="noopener">${icon("file")} ${x.file_name}</a>
              <span class="faint text-sm">${fileSize(x.size_bytes)} · ${dateTime(x.uploaded_at)}</span></div>`)}</div>
          <label class="btn sm">${icon("upload")} Upload<input type="file" data-up="${k}" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></label></div>`;
      })}</div>
      <p class="muted" style="margin:14px 0 0">To remove or replace a document, ask your hub manager.</p>`.toString();
      $$("[data-up]", box).forEach((inp) => (inp.onchange = () => busy(inp.parentElement, async () => {
        const file = inp.files[0];
        if (!file) return;
        if (file.size > DOC_MAX) throw new Error("The file is larger than 3 MB. Scan or photograph it at a lower quality.");
        await post("/api/me/documents", { doc_type: inp.dataset.up, file_name: file.name, mime: file.type, data: await readBase64(file) });
        toast(`${file.name} uploaded`);
        await drawDocs();
      })));
    };

    const show = () => {
      $("#pane").innerHTML = panes[tab]().toString();
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      if (tab === "month") {
        $("#days").innerHTML = m.daily.length ? dataTable({
          rows: m.daily, sortable: false, footer: true,
          cols: [
            { key: "date", label: "Day", render: (r) => dateLabel(r.date), total: () => "Total" },
            { key: "business_amount", label: "Sales", align: "r", render: (r) => money(r.business_amount), total: () => money(m.business) },
            { key: "settled_amount", label: "Handed in", align: "r", render: (r) => money(r.settled_amount), total: (x) => money(x.reduce((t, r) => t + r.settled_amount, 0)) },
            { key: "settle_up_minus", label: "Difference", align: "r", render: (r) => html`<span class="${r.settle_up_minus ? "neg" : ""}">${money(r.settle_up_minus)}</span>`, total: () => money(m.settle_up) },
            { key: "personal_minus", label: "Advance", align: "r", render: (r) => (r.personal_minus ? money(r.personal_minus) : "—"), total: () => money(m.personal) },
            { key: "notes", label: "Note", render: (r) => r.notes || "" },
          ],
        }).toString() : emptyState("No days entered yet", "", "sheet").toString();
        if (m.stock.length && $("#stock")) $("#stock").innerHTML = dataTable({ rows: m.stock, sortable: false, cols: [
          { key: "product", label: "Product" }, { key: "shortfall_qty", label: "Missing", align: "r" },
          { key: "unit_price", label: "Unit price", align: "r", render: (r) => money(r.unit_price) },
          { key: "shortfall_value", label: "Value", align: "r", render: (r) => html`<b class="${r.shortfall_value ? "neg" : ""}">${money(r.shortfall_value)}</b>` }] }).toString();
        if (m.allowances.length && $("#allow")) $("#allow").innerHTML = dataTable({ rows: m.allowances, sortable: false, cols: [
          { key: "description", label: "What" }, { key: "amount", label: "Amount", align: "r", render: (r) => money(r.amount) }] }).toString();
      }
      if (tab === "payslips" && d.history.length) {
        $("#hist").innerHTML = dataTable({
          rows: d.history, sortable: false, rowAction: "",
          cols: [
            { key: "period", label: "Month", render: (r) => html`<b>${monthName(r.period)}</b>` },
            { key: "gross_earnings", label: "Gross", align: "r", render: (r) => money(r.gross_earnings) },
            { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
            { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
            { key: "disbursed_amount", label: "Paid to bank", align: "r", render: (r) => money(r.disbursed_amount) },
            { key: "closing_balance", label: "Carried forward", align: "r", render: (r) => html`<span class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</span>` },
            { key: "slip", label: "", sort: false, align: "r", render: (r) => html`<a class="btn sm" href="/api/me/payslip/${r.period}" target="_blank" rel="noopener">${icon("printer")} Payslip</a>` },
          ],
        }).toString();
      }
      if (tab === "team") {
        const t = d.team;
        $("#team").innerHTML = t.length ? dataTable({
          rows: t, sortable: false, footer: true,
          cols: [
            { key: "name", label: "Name", render: (r) => html`<b>${r.name}</b> <span class="faint">${r.employee_id}</span>`, total: () => "Team total" },
            { key: "staff_level", label: "Position", render: (r) => (r.staff_level === "supervisor" ? "Supervisor" : r.staff_level === "group_manager" ? "Group manager" : "Distributor / Guy") },
            { key: "reports_to", label: "Reports to", render: (r) => r.reports_to || "—" },
            { key: "days", label: "Days", align: "r", total: (x) => x.reduce((s, r) => s + r.days, 0) },
            { key: "business", label: "Sales", align: "r", render: (r) => money(r.business), total: (x) => money(x.reduce((s, r) => s + r.business, 0)) },
            { key: "target", label: "Target", align: "r", render: (r) => money(r.target) },
            { key: "att", label: "Of target", align: "r", sort: false, render: (r) => (r.target ? pct(r.business / r.target, 0) : "—") },
          ],
        }).toString() : emptyState("Nobody reports to you yet", "", "users").toString();
      }
      if (tab === "documents") drawDocs().catch((e) => toast(e.message, "err"));
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; show(); }));
    if (!panes[tab] || (tab === "team" && !hasTeam)) tab = "month";
    show();
  },
};
