// Staff portal: one page for a distributor, supervisor or group manager, showing only their own figures.
import { get, post } from "../api.js";
import { state } from "../app.js";
import { $, $$, html, raw, esc, icon, money, badge, toast, busy, dataTable, emptyState, monthName, dateLabel, pct, dateTime } from "../ui.js";

let tab = "month";
const DOC_TYPES = [["nic", "ID / NIC"], ["bank_book", "Bank book front page"], ["ol_results", "O/L results sheet"], ["other", "Other"]];
const DOC_MAX = 3_000_000;
const fileSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const n0 = (c) => (c / 100).toLocaleString("en-LK", { maximumFractionDigits: 0 });
const readBase64 = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(new Error("The file could not be read"));
  r.readAsDataURL(file);
});
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } }; // a light tap on phones that allow it

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

// ---- grouped list rows (the iOS settings look): label on the left, value on the right
const row = (label, value, { sub = "", vsub = "", cls = "", strong = false, href = "" } = {}) => {
  const inner = `<div class="g-l">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div><div class="g-v ${cls}">${value}${vsub ? `<small class="${cls}">${vsub}</small>` : ""}</div>`;
  return href ? `<a class="g-row link${strong ? " strong" : ""}" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="g-row${strong ? " strong" : ""}">${inner}</div>`;
};
const group = (title, rows) => `<div class="g-group">${title ? `<div class="g-head">${esc(title)}</div>` : ""}${rows.join("")}</div>`;
const keep = (l) => l.amount !== 0 || /Basic/.test(l.label);
// The engine's labels carry its internal rule names; show them in plain words.
const plain = (label) => {
  const sec = /^Security \((fixed|pct_gross|pct_basic|pct_business):([\d.]+)/.exec(label);
  if (sec) return `Security (${sec[1] === "fixed" ? `Rs ${sec[2]} a month` : `${sec[2]}% of your ${{ pct_gross: "gross pay", pct_basic: "basic pay", pct_business: "sales" }[sec[1]]}`})`;
  return label === "Personal minus" ? "Advance taken" : label;
};
const payGroups = (p) => group("Earnings", [...p.earnings.filter(keep).map((l) => row(plain(l.label), money(l.amount))), row("Gross earnings", money(p.gross), { strong: true })])
  + group("Taken off", [...p.deduction_lines.filter(keep).map((l) => row(plain(l.label), money(l.amount))), row("Total taken off", money(p.deductions), { strong: true })]);

const stat = (label, value, sub = "", ic = "", cls = "") => `<div class="stat ${cls}"><div class="s-label">${ic ? `<span class="s-ic">${icon(ic)}</span>` : ""}${esc(label)}</div><div class="s-value">${value}</div>${sub ? `<div class="s-sub">${sub}</div>` : ""}</div>`;

const skeleton = () => `<div aria-busy="true" aria-label="Loading your page">
  <div class="sk" style="height:34px;width:55%;margin-bottom:10px"></div><div class="sk" style="height:18px;width:80%;margin-bottom:20px"></div>
  <div class="sk" style="height:190px;border-radius:20px;margin-bottom:12px"></div>
  <div class="stats"><div class="sk" style="height:96px"></div><div class="sk" style="height:96px"></div><div class="sk" style="height:96px"></div><div class="sk" style="height:96px"></div></div>
  <div class="sk" style="height:220px;margin-top:12px"></div></div>`;

// ---- pull down to refresh (touch screens only). Set once; the current page registers what to refresh.
const ptr = { fn: null, y0: 0, dy: 0, on: false, el: null };
function setupPull() {
  if (ptr.el) return;
  ptr.el = document.createElement("div");
  ptr.el.className = "ptr";
  ptr.el.setAttribute("aria-hidden", "true");
  ptr.el.innerHTML = icon("refresh");
  document.body.append(ptr.el);
  const reset = () => { ptr.el.style.transform = "translate(-50%, -64px)"; ptr.el.style.opacity = "0"; ptr.el.classList.remove("ready", "spin"); };
  window.addEventListener("touchstart", (e) => {
    ptr.on = !!ptr.fn && location.pathname === "/me" && window.scrollY <= 0 && e.touches.length === 1 && !document.documentElement.classList.contains("modal-open");
    if (ptr.on) { ptr.y0 = e.touches[0].clientY; ptr.dy = 0; }
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!ptr.on) return;
    const dy = e.touches[0].clientY - ptr.y0;
    if (dy <= 0) { ptr.dy = 0; return reset(); }
    ptr.dy = Math.min(dy * 0.5, 88);
    ptr.el.style.transform = `translate(-50%, ${ptr.dy - 44}px) rotate(${ptr.dy * 4}deg)`;
    ptr.el.style.opacity = String(Math.min(1, ptr.dy / 56));
    ptr.el.classList.toggle("ready", ptr.dy >= 60);
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (!ptr.on) return;
    ptr.on = false;
    if (ptr.dy < 60) return reset();
    buzz(10);
    ptr.el.classList.add("spin");
    ptr.el.style.transform = "translate(-50%, 16px)";
    try { await ptr.fn?.(); } catch (err) { toast(err.message, "err"); }
    reset();
  });
}

export default {
  title: "My page",
  async render(ctx) {
    const { el } = ctx;
    el.classList.add("has-bottom-tabs");
    if (!ctx.refresh) el.innerHTML = skeleton(); // grey shapes in the layout of the page, instead of a spinner on a blank screen
    const d = await get("/api/me/portal?period=" + state.period);
    const me = d.me, m = d.month;
    const hasTeam = !!d.team;
    const attain = m.target ? m.business / m.target : 0;
    const pay = d.official || d.estimate;
    const final = !!d.official;

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>Hello, ${me.name.split(" ")[0]}</h1>
          <p>${badge("blue", me.level_name)} ${me.hub_name}${me.reports_to ? ` · reports to ${me.reports_to}` : ""}</p></div>
      </div>
      <div class="tabs portal-tabs" id="tabs" aria-label="My page sections">${[["month", "This month", "Month", "chart", ""], ["payslips", "Payslips", "Payslips", "wallet", d.history.length],
        ...(hasTeam ? [["team", "My team", "Team", "users", d.team.length]] : []), ["documents", "My documents", "Documents", "file", ""], ["details", "My details", "Details", "user", ""]]
        .map(([k, long, short, ic, n]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}"><span class="tab-ic">${icon(ic)}</span><span class="tab-lb"><span class="lg">${long}</span><span class="sm">${short}</span></span>${n !== "" ? html`<span class="cnt">(${n})</span>` : ""}</button>`)}</div>
      <div id="pane"></div>`;

    const panes = {
      month: () => html`
        <section class="hero" aria-label="Pay summary">
          <div class="h-top"><span>${monthName(d.period)}</span><span class="h-chip">${final ? "Final" : pay ? "Not final" : "Open"}</span></div>
          <div class="h-label">${final ? "Net pay" : "Estimated take-home so far"}</div>
          <div class="h-amount ${pay && pay.net < 0 ? "negative" : ""}">${pay ? raw(`<small>Rs</small>${money(pay.net)}`) : "—"}</div>
          <div class="h-foot">${final ? `Paid to your bank: Rs ${money(d.official.paid)}` : pay ? "Changes as more days are entered" : "Your pay appears when your sales are entered"}</div>
          ${m.target ? html`<div class="h-bar" role="progressbar" aria-label="Progress to target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(attain, 1) * 100)}"><span style="width:${Math.min(100, attain * 100)}%"></span></div>
          <div class="h-foot">Sales Rs ${n0(m.business)} of Rs ${n0(m.target)} target · ${pct(attain, 0)}</div>` : ""}
        </section>
        <div class="stats">${raw([
          stat("Sales so far", `<small>Rs</small>${n0(m.business)}`, `${m.days} day${m.days === 1 ? "" : "s"} worked`, "chart", "blue"),
          m.over_target > 0 || attain >= 1 ? stat("Over target by", `<small>Rs</small>${n0(m.over_target)}`, "Target passed", "trend", "green") : stat("Still to go", `<small>Rs</small>${n0(m.to_go)}`, "to reach your target", "trend", "amber"),
          stat("Taken off so far", `<small>Rs</small>${n0(m.settle_up + m.personal)}`, `Short Rs ${n0(m.settle_up)} · advances Rs ${n0(m.personal)}`, "coins", "amber"),
          stat("Security held", `<small>Rs</small>${n0(d.security_held)}`, "in total, from closed months", "shield", ""),
        ].join(""))}</div>

        ${pay ? html`<section class="card mb-4 glist"><div class="card-head"><div><h2>${final ? `Your pay for ${monthName(d.period)}` : "Estimate so far"}</h2>
            <div class="sub">${final ? "Final. The month is closed." : "Worked out with your pay rules from the days entered up to now"}</div></div>
            ${final ? html`<a class="btn sm primary" href="/api/me/payslip/${d.period}" target="_blank" rel="noopener">${icon("printer")} Payslip</a>` : badge("amber", "Not final")}</div>
          ${raw(payGroups(pay))}
          ${final ? raw(group("Balance", [row("Brought forward", money(d.official.opening)), row("Net pay", money(d.official.net), { strong: true, cls: d.official.net < 0 ? "neg" : "" }),
            row("Paid to your bank", money(d.official.paid)), row("Carried to next month", money(d.official.closing), { cls: d.official.closing < 0 ? "neg" : "" })])) : ""}
          ${final ? "" : html`<div class="card-foot muted">The office calculates the final figure at the end of the month and may check some entries first. Your payslip appears here after the month is closed.</div>`}
        </section>` : html`<div class="card mb-4">${emptyState("No sales entered yet this month", "When your daily sales are entered, your progress and an estimate of your pay appear here.", "chart")}</div>`}

        <section class="card mb-4"><div class="card-head"><div><h2>Your days</h2><div class="sub">Sales and the money you handed in</div></div></div><div class="card-body flush" id="days"></div></section>
        ${m.stock.length ? html`<section class="card mb-4"><div class="card-head"><div><h2>Stock count</h2><div class="sub">Missing pieces are taken off your pay</div></div></div><div class="card-body flush" id="stock"></div></section>` : ""}
        ${m.allowances.length ? html`<section class="card mb-4"><div class="card-head"><h2>Allowances this month</h2></div><div class="card-body flush" id="allow"></div></section>` : ""}
        <details class="card fold"><summary><h2>How your pay is worked out</h2></summary><div class="card-body"><ul style="margin:0;padding-left:18px">${raw(payRules(me.pay).map((l) => `<li style="margin-bottom:6px">${l}</li>`).join(""))}</ul></div></details>`,

      payslips: () => d.history.length ? html`<section class="card"><div class="card-body flush" id="hist"></div></section>
        <p class="muted" style="margin-top:12px">Security held back so far: <b class="num">Rs ${money(d.security_held)}</b>.</p>`
        : html`<div class="card">${emptyState("No payslips yet", "Your payslip for a month appears here once the office has closed that month.", "file")}</div>`,

      team: () => html`<section class="card mb-4"><div class="card-head"><div><h2>Your team in ${monthName(d.period)}</h2><div class="sub">Sales only. Pay is private to each person.</div></div></div>
        <div class="card-body flush" id="team"></div></section>`,

      documents: () => html`<section class="card"><div class="card-head"><div><h2>My documents</h2><div class="sub">JPG, PNG, WebP or PDF, up to 3 MB each</div></div></div>
        <div class="card-body" id="docs"><div class="sk" style="height:140px"></div></div></section>`,

      details: () => html`<div class="grid halves"><section class="card"><div class="card-head"><h2>My details</h2></div><div class="card-body"><dl class="kv">
          <dt>Name</dt><dd>${me.name}</dd><dt>Employee ID</dt><dd class="mono">${me.employee_id}</dd><dt>Position</dt><dd>${me.level_name}</dd>
          <dt>Hub</dt><dd>${me.hub_name}</dd><dt>Reports to</dt><dd>${me.reports_to || "—"}</dd>
          <dt>Phone</dt><dd>${me.phone || "—"}</dd><dt>NIC</dt><dd>${me.nic || "—"}</dd><dt>Joined</dt><dd>${me.join_date || "—"}</dd></dl></div></section>
        <section class="card"><div class="card-head"><h2>Bank</h2></div><div class="card-body"><dl class="kv"><dt>Bank</dt><dd>${me.bank_name || "—"}</dd>
          <dt>Account</dt><dd class="mono">${me.bank_last4 ? "…" + me.bank_last4 : "—"}</dd></dl>
          <p class="muted" style="margin:12px 0 0">To change your phone, bank account or any other detail, ask your hub manager.</p></div></section></div>`,
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
        buzz(12);
        await drawDocs();
      })));
    };

    // A phone gets a list; a wide screen keeps the table. Both are written, CSS shows the right one.
    const both = (table, list) => `<div class="show-lg">${table}</div><div class="show-sm">${list}</div>`;
    const show = (animate = true) => {
      const pane = $("#pane");
      pane.innerHTML = panes[tab]().toString();
      if (animate) { pane.classList.remove("pane-in"); void pane.offsetWidth; pane.classList.add("pane-in"); }
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      if (tab === "month") {
        $("#days").innerHTML = m.daily.length ? both(
          dataTable({
            rows: m.daily, sortable: false, footer: true,
            cols: [
              { key: "date", label: "Day", render: (r) => dateLabel(r.date), total: () => "Total" },
              { key: "business_amount", label: "Sales", align: "r", render: (r) => money(r.business_amount), total: () => money(m.business) },
              { key: "settled_amount", label: "Handed in", align: "r", render: (r) => money(r.settled_amount), total: (x) => money(x.reduce((t, r) => t + r.settled_amount, 0)) },
              { key: "settle_up_minus", label: "Difference", align: "r", render: (r) => html`<span class="${r.settle_up_minus ? "neg" : ""}">${money(r.settle_up_minus)}</span>`, total: () => money(m.settle_up) },
              { key: "personal_minus", label: "Advance", align: "r", render: (r) => (r.personal_minus ? money(r.personal_minus) : "—"), total: () => money(m.personal) },
              { key: "notes", label: "Note", render: (r) => r.notes || "" },
            ],
          }).toString(),
          group("", [...m.daily.slice().reverse().map((r) => row(dateLabel(r.date), money(r.business_amount), {
            sub: `Handed in ${money(r.settled_amount)}${r.personal_minus ? ` · Advance ${money(r.personal_minus)}` : ""}${r.notes ? ` · ${r.notes}` : ""}`,
            vsub: r.settle_up_minus ? `Short ${money(r.settle_up_minus)}` : "", cls: "",
          })), row(`Total · ${m.days} day${m.days === 1 ? "" : "s"}`, money(m.business), { strong: true, vsub: m.settle_up ? `Short ${money(m.settle_up)}` : "" })])) : emptyState("No days entered yet", "", "sheet").toString();
        if (m.stock.length && $("#stock")) $("#stock").innerHTML = group("", m.stock.map((r) => row(r.product, r.shortfall_value ? money(r.shortfall_value) : "—", { sub: `${r.shortfall_qty} missing × ${money(r.unit_price)}`, cls: r.shortfall_value ? "neg" : "" })));
        if (m.allowances.length && $("#allow")) $("#allow").innerHTML = group("", m.allowances.map((r) => row(r.description, money(r.amount))));
      }
      if (tab === "payslips" && d.history.length) {
        $("#hist").innerHTML = both(
          dataTable({
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
          }).toString(),
          group("", d.history.map((r) => row(monthName(r.period), money(r.net_pay), { sub: `Gross ${n0(r.gross_earnings)} · Taken off ${n0(r.total_deductions)}`, vsub: `Paid ${n0(r.disbursed_amount)}`, cls: r.net_pay < 0 ? "neg" : "", href: `/api/me/payslip/${r.period}` }))));
      }
      if (tab === "team") {
        const t = d.team, label = (l) => (l === "supervisor" ? "Supervisor" : l === "group_manager" ? "Group manager" : "Distributor / Guy");
        $("#team").innerHTML = t.length ? both(
          dataTable({
            rows: t, sortable: false, footer: true,
            cols: [
              { key: "name", label: "Name", render: (r) => html`<b>${r.name}</b> <span class="faint">${r.employee_id}</span>`, total: () => "Team total" },
              { key: "staff_level", label: "Position", render: (r) => label(r.staff_level) },
              { key: "reports_to", label: "Reports to", render: (r) => r.reports_to || "—" },
              { key: "days", label: "Days", align: "r", total: (x) => x.reduce((s, r) => s + r.days, 0) },
              { key: "business", label: "Sales", align: "r", render: (r) => money(r.business), total: (x) => money(x.reduce((s, r) => s + r.business, 0)) },
              { key: "target", label: "Target", align: "r", render: (r) => money(r.target) },
              { key: "att", label: "Of target", align: "r", sort: false, render: (r) => (r.target ? pct(r.business / r.target, 0) : "—") },
            ],
          }).toString(),
          group("", [...t.map((r) => row(r.name, money(r.business), { sub: `${label(r.staff_level)} · ${r.days} day${r.days === 1 ? "" : "s"}`, vsub: r.target ? `${pct(r.business / r.target, 0)} of target` : "", cls: r.target && r.business >= r.target ? "pos" : "" })),
            row("Team total", money(t.reduce((s, r) => s + r.business, 0)), { strong: true })])) : emptyState("Nobody reports to you yet", "", "users").toString();
      }
      if (tab === "documents") drawDocs().catch((e) => toast(e.message, "err"));
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => { if (tab !== b.dataset.t) buzz(6); tab = b.dataset.t; show(); }));
    if (!panes[tab] || (tab === "team" && !hasTeam)) tab = "month";
    show(!ctx.refresh);

    setupPull();
    ptr.fn = () => this.render({ ...ctx, refresh: true });
  },
};
