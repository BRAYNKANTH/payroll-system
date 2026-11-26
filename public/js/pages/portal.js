// Staff portal: one page for any employee (distributor, supervisor, manager, promoting manager or coacher), showing only their own figures and their team's sales.
import { get, post, del } from "../api.js";
import { state } from "../app.js";
import { buzz, $, $$, html, raw, esc, icon, money, badge, toast, busy, dataTable, emptyState, monthName, dateLabel, pct, dateTime, initials } from "../ui.js";
import { mountSell } from "./sell.js";
import { swipeTabs } from "../phone.js";

let tab = "month";
let monthDeck = "pay"; // 'pay' | 'days' | 'rules'
let tabInit = false; // the first time the page opens, a seller lands on the till
let dirty = false;   // something was sold or changed in the till, so the month figures need a refresh
const DOC_TYPES = [["nic", "ID / NIC"], ["bank_book", "Bank book front page"], ["ol_results", "O/L results sheet"], ["other", "Other"]];
const DOC_MAX = 3_000_000;
const fileSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
// Today in Sri Lanka (UTC+5:30), the same as the server uses, optionally some days away.
const slToday = (days = 0) => new Date(Date.now() + 5.5 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const n0 = (c) => (c / 100).toLocaleString("en-LK", { maximumFractionDigits: 0 });
const readBase64 = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(new Error("The file could not be read"));
  r.readAsDataURL(file);
});

// The person's own pay rules in plain words.
function payRules(p, me, rate) {
  const rs = (c) => `Rs ${money(c)}`;
  const lines = [];
  if (me?.staff_level === "promoting_manager") return [`A fixed salary of <b>${rs(p.basic_pay)}</b> every month.`, `Plus <b>${pct(rate, 2)}</b> of the sales of each manager directly under you: the manager's own sales and everyone under that manager. A promoting manager under you is paid on their own managers, so nobody is paid twice on the same sales.`, `Worked out by the office when the month closes.`];
  if (me?.senior) return [`A fixed salary of <b>${rs(p.basic_pay)}</b> every month, every month.`, `Plus <b>${pct(rate, 2)}</b> of the sales of everyone below you, worked out by the office when the month closes.`];
  if (me?.is_manager) return [`Your pay is your basic salary of <b>${rs(p.basic_pay)}</b> plus the weekly commission on your own and your team's sales (20% when the week reaches your target, otherwise 15%) and your own sales commission, less the weekly rent and hub fee and any extra pay or food you give your team.`, `It is all paid at month end.`];
  if (p.pay_scheme === "tiered") {
    lines.push(`If your sales in the month go over <b>${rs(p.target)}</b>: a fixed basic pay of <b>${rs(p.basic_pay)}</b> plus <b>${pct(p.commission_rate, 0)}</b> of the sales above the target.`);
    lines.push(`If your sales are <b>${rs(p.target)}</b> or less: <b>${pct(p.base_commission_rate, 0)}</b> of all your sales, and no basic pay.`);
  } else {
    lines.push(`A basic pay of <b>${rs(p.basic_pay)}</b> every month, plus <b>${pct(p.commission_rate, 0)}</b> of the sales above <b>${rs(p.target)}</b>.`);
  }
  if (p.food_per_day) lines.push(`Food: <b>${rs(p.food_per_day)}</b> for every day you work${p.food_min_days ? `, once you have worked ${p.food_min_days} days or more` : ""}.`);
  const m = /^(fixed|pct_gross|pct_basic|pct_business):([\d.]+)/.exec(p.security_deduction_rule || "");
  if (m) lines.push(`Security deposit held back: <b>${m[1] === "fixed" ? `Rs ${m[2]}` : `${m[2]}%`}</b>${{ fixed: " each month", pct_gross: " of your total earnings", pct_basic: " of your basic pay", pct_business: " of your sales" }[m[1]]}.`);
  lines.push("Taken off your pay: the difference between your sales and the money you handed in, any stock that is missing, and any advance or loan payment.");
  return lines;
}

// ---- grouped list rows (the iOS settings look): label on the left, value on the right
const row = (label, value, { sub = "", vsub = "", cls = "", strong = false, href = "", avatar = "" } = {}) => {
  const inner = `${avatar ? `<div class="avatar sm" aria-hidden="true">${esc(avatar)}</div>` : ""}<div class="g-l">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div><div class="g-v ${cls}">${value}${vsub ? `<small class="${cls}">${vsub}</small>` : ""}</div>`;
  return href ? `<a class="g-row link${strong ? " strong" : ""}" href="${esc(href)}" ${href.startsWith("/me/") ? "data-link" : 'target="_blank" rel="noopener"'}>${inner}</a>` : `<div class="g-row${strong ? " strong" : ""}">${inner}</div>`;
};
const group = (title, rows) => `<div class="g-group">${title ? `<div class="g-head">${esc(title)}</div>` : ""}${rows.join("")}</div>`;
const keep = (l) => l.amount !== 0 || /Basic/.test(l.label);

// The engine's labels carry its internal rule names; show them in plain words.
const plain = (label) => {
  const sec = /^Security \((fixed|pct_gross|pct_basic|pct_business):([\d.]+)/.exec(label);
  if (sec) return `Security deposit (${sec[1] === "fixed" ? `Rs ${sec[2]} a month` : `${sec[2]}% of your ${{ pct_gross: "total earnings", pct_basic: "basic pay", pct_business: "sales" }[sec[1]]}`})`;
  const old = [
    [/^Personal minus$/, "Advance taken"], [/^Stock shortfall$/, "Missing stock"],
    [/^Settle-up \(business − settled\)$/, "Cash not handed in (sales minus cash handed in)"],
    [/^Over-target income \((.+?) of (Rs [\d.,]+) over target\)$/, "Extra pay above target ($1 of $2 sales above your target)"],
    [/^Commission \((.+?) of (Rs [\d.,]+) business\)$/, "Commission ($1 of your sales, $2; the target was not reached)"],
    [/^Commission \((.+?) of (Rs [\d.,]+) over target\)$/, "Commission ($1 of $2 sales above your target)"],
    [/^Loan instalment \(balance after: (Rs [\d.,]+)(.*)\)$/, "Loan payment ($1 still to pay$2)"],
    [/^Advance repaid \(balance after: (Rs [\d.,]+)(.*)\)$/, "Advance paid back ($1 still to pay$2)"],
    [/^Share of sales below/, "Share of your team's sales"],
  ];
  for (const [re, to] of old) if (re.test(label)) return label.replace(re, to);
  return label;
};

// Returns title and secondary sub-caption for iOS grouped lists & payslips.
const plainParts = (rawLabel) => {
  const label = plain(rawLabel);
  const commSales = /^Commission \((.+?) of your sales, (Rs [\d.,]+); the target was not reached\)$/.exec(label);
  if (commSales) {
    return { label: `Commission (${commSales[1]})`, sub: `${commSales[2]} sales · target not reached` };
  }
  const commTarget = /^Commission \((.+?) of (Rs [\d.,]+) sales above your target\)$/.exec(label);
  if (commTarget) {
    return { label: `Commission (${commTarget[1]})`, sub: `${commTarget[2]} sales above target` };
  }
  const extraTarget = /^Extra pay above target \((.+?) of (Rs [\d.,]+) sales above your target\)$/.exec(label);
  if (extraTarget) {
    return { label: `Extra pay (${extraTarget[1]})`, sub: `${extraTarget[2]} sales above target` };
  }
  const food = /^Food allowance \((.+?)\)$/.exec(label);
  if (food) {
    return { label: "Food allowance", sub: food[1] };
  }
  const sec = /^Security deposit \((.+?)\)$/.exec(label);
  if (sec) {
    return { label: "Security deposit", sub: sec[1] };
  }
  const loan = /^Loan payment \((Rs [\d.,]+) still to pay(.*)\)$/.exec(label);
  if (loan) {
    return { label: "Loan payment", sub: `${loan[1]} still to pay` };
  }
  const adv = /^Advance paid back \((Rs [\d.,]+) still to pay(.*)\)$/.exec(label);
  if (adv) {
    return { label: "Advance paid back", sub: `${adv[1]} still to pay` };
  }
  if (label.startsWith("Cash not handed in")) {
    return { label: "Cash not handed in", sub: "Sales minus cash handed in" };
  }
  if (label.startsWith("Share of team's sales") || label.startsWith("Share of sales below")) {
    return { label: "Share of team sales", sub: "Commission from team members" };
  }

  return { label, sub: "" };
};

// Short, plain meanings for the words on this page.
export const GLOSSARY = [
  ["Estimate", "A guess made from the days entered so far. It can change until the office closes the month."],
  ["Target", "The amount of sales you are asked to reach in a month."],
  ["Extra pay above target", "Extra money for the sales you make above your target."],
  ["Cash not handed in", "Sales minus the cash you handed in. If you hand in less than you sold, the difference is taken off your pay."],
  ["Advance", "Money you took before pay day. It is taken off your pay."],
  ["Loan payment", "The part of a loan you pay back each month."],
  ["Security deposit", "A small amount held back from your pay as a safety deposit. Ask your hub head when it is returned."],
  ["Missing stock", "Items the records say you had, but that were not found at the stock count. Their value is taken off."],
  ["Allowance", "Extra money added by the office, for example a bonus."],
  ["Total earnings", "Everything you earned, before anything is taken off."],
  ["Net pay", "What is left after everything is taken off. This is what you are paid."],
  ["Carried to next month", "A balance that moves to next month: money you still owe, or are still owed."],
];
const glossary = () => `<details class="card fold"><summary><h2>What do these words mean?</h2></summary><div class="card-body"><dl class="glossary">${GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("")}</dl></div></details>`;
const payGroups = (p) => {
  const earnRows = p.earnings.filter(keep).map((l) => {
    const { label, sub } = plainParts(l.label);
    return row(label, money(l.amount), { sub });
  });
  const dedRows = p.deduction_lines.filter(keep).map((l) => {
    const { label, sub } = plainParts(l.label);
    return row(label, money(l.amount), { sub });
  });
  return group("Earnings", [...earnRows, row("Total earnings", money(p.gross), { strong: true })])
    + group("Taken off", [...dedRows, row("Total taken off", money(p.deductions), { strong: true })]);
};

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

export { plain, plainParts, keep };
export default {
  title: "My page",
  async render(ctx) {
    const { el } = ctx;
    el.classList.add("has-bottom-tabs");
    if (!ctx.refresh) el.innerHTML = skeleton(); // grey shapes in the layout of the page, instead of a spinner on a blank screen
    const d = await get("/api/me/portal?period=" + state.period);
    const me = d.me, m = d.month;
    if (!tabInit) { tabInit = true; tab = me.sells ? "sell" : "month"; }
    // The section is in the address (?tab=payslips), so Back moves between sections and a section can be bookmarked or shared.
    if (!ctx.refresh) { const q = new URLSearchParams(location.search).get("tab") || history.state?.tab; if (q) tab = q; else if (location.pathname === "/me") history.replaceState({ tab }, "", location.href); }
    const attain = m.target ? m.business / m.target : 0;
    const pay = d.official || d.estimate;
    const final = !!d.official;

    el.innerHTML = html`
      <div class="page-head portal-head">
        <div><h1>Hello, ${me.name.split(" ")[0]}</h1>
          <p>${badge("blue", me.level_name)} ${me.hub_name}${me.reports_to ? ` · reports to ${me.reports_to}` : ""}</p></div>
        <div class="actions"><a class="btn sm" href="/api/me/report.pdf?period=${d.period}" target="_blank" rel="noopener">${icon("file")} <span class="lbl-sm">My report (PDF)</span></a><button type="button" class="btn sm" id="refresh">${icon("refresh")} <span class="lbl-sm">Refresh</span></button></div>
      </div>
      <div class="tabs portal-tabs" id="tabs" aria-label="My page sections">${[...(me.sells ? [["sell", "Sell", "Sell", "bag", ""]] : []), ["month", "This month", "Month", "chart", ""],
        ...(d.team ? [["team", "My team", "Team", "users", d.team.length]] : []), ["payslips", "Payslips", "Payslips", "wallet", d.history.length],
        ...(d.loans.length ? [["loans", "Advances & loans", "Loans", "coins", d.loans.filter((l) => l.state !== "paid").length]] : []),
        ["documents", "My documents", "Docs", "file", ""], ["details", "My details", "Profile", "user", ""]]
        .map(([k, long, short, ic, n]) => html`<button data-t="${k}" class="${tab === k ? "on" : ""}"><span class="tab-ic">${icon(ic)}</span><span class="tab-lb"><span class="lg">${long}</span><span class="sm">${short}</span></span>${n !== "" ? html`<span class="cnt">(${n})</span>` : ""}</button>`)}</div>
      <div id="pane"></div>`;

    const panes = {
      sell: () => html`<div id="till" class="till"></div>`,
      month: () => html`
        <section class="hero" aria-label="Pay summary">
          <div class="h-top"><span>${monthName(d.period)}</span><span class="h-chip">${final ? "Final" : pay ? "Not final" : "Open"}</span></div>
          <div class="h-label">${final ? "Net pay" : "Estimated take-home so far"}</div>
          <div class="h-amount ${pay && pay.net < 0 ? "negative" : ""}">${pay ? raw(`<small>Rs</small>${money(pay.net)}`) : "—"}</div>
          <div class="h-foot">${final ? `Salary: Rs ${money(d.official.paid)}` : pay ? "Changes as more days are entered" : me.is_manager ? "Your pay is shown here once the month is closed" : "Your pay appears when your sales are entered"}</div>
          ${m.target ? html`<div class="h-bar" role="progressbar" aria-label="Progress to target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(attain, 1) * 100)}"><span style="width:${Math.min(100, attain * 100)}%"></span></div>
          <div class="h-foot">Sales Rs ${n0(m.business)} of Rs ${n0(m.target)} target · ${pct(attain, 0)}</div>` : ""}
        </section>
        <div class="stats">${raw((me.senior ? [
          me.staff_level === "promoting_manager"
            ? stat("Sales you earn on", `<small>Rs</small>${n0(d.share_sales)}`, `the groups of your ${d.team.filter((p) => p.depth === 1 && p.level_name === "Manager").length} managers`, "chart", "blue")
            : stat("Team sales so far", `<small>Rs</small>${n0(d.below_sales)}`, `${d.team.filter((p) => p.business).length} of ${d.team.length} people have sales`, "chart", "blue"),
          stat("People below you", String(d.team.length), "managers, supervisors and distributors", "users", ""),
          stat("Your salary", `<small>Rs</small>${n0(me.pay.basic_pay)}`, "each month", "wallet", "green"),
          stat("Your share rate", pct(d.senior_rate, 2), me.staff_level === "promoting_manager" ? "of your managers' groups" : "of the sales below you", "trend", "amber"),
        ] : [
          stat("Sales so far", `<small>Rs</small>${n0(m.business)}`, `${m.days} day${m.days === 1 ? "" : "s"} worked`, "chart", "blue"),
          m.over_target > 0 || attain >= 1 ? stat("Over target by", `<small>Rs</small>${n0(m.over_target)}`, "Target passed", "trend", "green") : stat("Still to go", `<small>Rs</small>${n0(m.to_go)}`, "to reach your target", "trend", "amber"),
          // The same total as the pay breakdown below (cash not handed in, advances, missing stock, the security deposit and loan payments),
          // so the take-home figure above adds up with what this card says.
          stat("Taken off so far", `<small>Rs</small>${n0(pay ? pay.deductions : m.settle_up + m.personal)}`,
            pay && pay.deductions !== m.settle_up + m.personal ? "Cash, advances, deposit and more: see the breakdown" : `Cash not handed in Rs ${n0(m.settle_up)} · advances Rs ${n0(m.personal)}`, "coins", "amber"),
          stat("Security deposit held", `<small>Rs</small>${n0(d.security_held)}`, "in total, from closed months", "shield", ""),
        ]).join(""))}</div>

        <!-- Apple iOS Segmented Deck Switcher (Chunked for zero scroll fatigue) -->
        <div class="month-deck-nav seg mb-3" role="tablist" aria-label="Month sections">
          <button type="button" class="${monthDeck === "pay" ? "on" : ""}" data-mdeck="pay" role="tab" aria-selected="${monthDeck === "pay"}">${icon("wallet")} Breakdown</button>
          ${me.senior ? "" : html`<button type="button" class="${monthDeck === "days" ? "on" : ""}" data-mdeck="days" role="tab" aria-selected="${monthDeck === "days"}">${icon("sheet")} Days ${m.days ? html`<span class="badge plain sm">${m.days}</span>` : ""}</button>`}
          <button type="button" class="${monthDeck === "rules" ? "on" : ""}" data-mdeck="rules" role="tab" aria-selected="${monthDeck === "rules"}">${icon("info")} Rules</button>
        </div>

        <div id="month-deck-body">
          <!-- SUB-DECK 1: PAY BREAKDOWN -->
          <div id="mdeck-pay" ${monthDeck === "pay" ? "" : "hidden"}>
            ${pay ? html`<section class="card mb-4 glist"><div class="card-head"><div><h2>${final ? `Your pay for ${monthName(d.period)}` : "Estimate so far"}</h2>
                <div class="sub">${final ? "Final. The month is closed." : "Worked out with your pay rules from the days entered up to now"}</div></div>
                ${final ? html`<a class="btn sm primary" href="/api/me/payslip/${d.period}" target="_blank" rel="noopener">${icon("printer")} Payslip</a>` : badge("amber", "Not final")}</div>
              ${raw(payGroups(pay))}
              ${final ? raw(group("Balance", [row("Brought forward", money(d.official.opening)), row("Net pay", money(d.official.net), { strong: true, cls: d.official.net < 0 ? "neg" : "" }),
                row("Salary paid", money(d.official.paid)), row("Carried to next month", money(d.official.closing), { cls: d.official.closing < 0 ? "neg" : "" })])) : ""}
              ${final ? "" : html`<div class="card-foot muted">The office calculates the final figure at the end of the month and may check some entries first. Your payslip appears here after the month is closed.</div>`}
            </section>` : html`<div class="card mb-4">${emptyState("No sales entered yet this month", "When your daily sales are entered, your progress and an estimate of your pay appear here.", "chart")}</div>`}
          </div>

          <!-- SUB-DECK 2: DAILY DAYS -->
          ${me.senior ? "" : html`
          <div id="mdeck-days" ${monthDeck === "days" ? "" : "hidden"}>
            <section class="card mb-4"><div class="card-head"><div><h2>Your days</h2><div class="sub">Sales and the money you handed in</div></div></div><div class="card-body flush" id="days"></div></section>
          </div>`}

          <!-- SUB-DECK 3: STOCK & RULES -->
          <div id="mdeck-rules" ${monthDeck === "rules" ? "" : "hidden"}>
            ${m.stock.length ? html`<section class="card mb-4"><div class="card-head"><div><h2>Stock count</h2><div class="sub">Missing pieces are taken off your pay</div></div></div><div class="card-body flush" id="stock"></div></section>` : ""}
            ${m.allowances.length ? html`<section class="card mb-4"><div class="card-head"><h2>Allowances this month</h2></div><div class="card-body flush" id="allow"></div></section>` : ""}
            <details class="card fold mb-4" open><summary><h2>How your pay is worked out</h2></summary><div class="card-body"><ul style="margin:0;padding-left:18px">${raw(payRules(me.pay, me, d.senior_rate).map((l) => `<li style="margin-bottom:6px">${l}</li>`).join(""))}</ul></div></details>
            ${raw(glossary())}
          </div>
        </div>`,

      team: () => d.team_sales_hidden
        ? html`<section class="card"><div class="card-head"><div><h2>My team</h2><div class="sub">The people who report to you.</div></div></div>
          <div class="card-body flush" id="team"></div></section>`
        : html`<section class="card"><div class="card-head"><div><h2>My team</h2><div class="sub">${monthName(d.period)}: sales of everyone below you. Sales only, never anyone's pay.</div></div></div>
          <div class="card-body flush" id="team"></div></section>
          <p class="muted" style="margin-top:12px">Total sales below you: <b class="num">Rs ${money(d.below_sales)}</b>.</p>`,

      payslips: () => d.history.length ? html`
        <div class="sec-held-card">${icon("shield")}<div><span>Security deposit held so far</span><b>Rs ${money(d.security_held)}</b></div></div>
        <section class="card"><div class="card-body flush" id="hist"></div></section>
        ${raw(glossary())}`
        : html`<div class="card">${emptyState("No payslips yet", "Your payslip for a month appears here once the office has closed that month.", "file")}</div>`,

      loans: () => html`<section class="card mb-4 glist"><div class="card-head"><div><h2>Advances and loans</h2><div class="sub">Money you took from the company, and what is left to pay back. It comes off your pay each month.</div></div></div>
        ${raw(d.loans.map((l) => group(`${l.kind === "advance" ? "Advance" : "Loan"} · given ${dateLabel(l.issued_on)}`, [
          row("Amount given", money(l.amount)), row("Paid back so far", money(l.repaid)),
          row("Still to pay back", l.state === "paid" ? "Paid off" : money(l.outstanding), { strong: true, cls: l.state === "paid" ? "pos" : "" }),
          ...(l.state === "stopped" ? [row("Status", "Deductions stopped")] : l.state === "active" ? [
            ...(l.kind === "loan" ? [row("Each month", money(l.instalment))] : []),
            row(`Comes off ${monthName(d.period)} pay`, l.due ? money(l.due) : "—")] : []),
        ])).join(""))}</section>`,


      documents: () => html`<section class="card"><div class="card-head"><div><h2>My documents</h2><div class="sub">JPG, PNG, WebP or PDF, up to 3 MB each</div></div></div>
        <div class="card-body" id="docs"><div class="sk" style="height:140px"></div></div></section>`,

      details: () => html`<div class="grid halves"><section class="card glist"><div class="card-head"><h2>My details</h2></div>
        ${raw(group("", [
          row("Name", me.name),
          row("Employee ID", `<span class="mono">${esc(me.employee_id)}</span>`),
          row("Position", me.level_name),
          row("Hub", me.hub_name),
          row("Reports to", me.reports_to || "—"),
          row("Phone", me.phone ? `<a href="tel:${esc(me.phone)}">${esc(me.phone)}</a>` : "—"),
          row("NIC", me.nic || "—"),
          row("Joined", me.join_date || "—"),
        ]))}</section>
        <section class="card glist"><div class="card-head"><h2>Bank details</h2></div>
        ${raw(group("", [
          row("Bank", me.bank_name || "—"),
          row("Account", `<span class="mono">${me.bank_last4 ? "…" + esc(me.bank_last4) : "—"}</span>`),
        ]))}
        <div class="card-foot muted">To change your phone, bank account or any other detail, ask your hub manager.</div></section></div>`,
    };

    const drawDocs = async () => {
      const docs = await get("/api/me/documents");
      const box = $("#docs");
      if (!box) return;
      box.innerHTML = html`<div class="doc-list">${DOC_TYPES.map(([k, l]) => {
        const mine = docs.filter((x) => x.doc_type === k);
        return html`<div class="doc-item">
          <div class="doc-meta">
            <div class="doc-head"><b>${l}</b> ${k === "other" ? "" : mine.length ? badge("green", "On file") : badge("amber", "Missing")}</div>
            ${mine.length ? mine.map((x) => html`<div class="doc-file"><a href="/api/me/documents/${x.id}" target="_blank" rel="noopener">${icon("file")} ${x.file_name}</a> <span class="doc-sub">${fileSize(x.size_bytes)} · ${dateTime(x.uploaded_at)}</span></div>`) : html`<span class="doc-desc muted">Upload required identity document</span>`}
          </div>
          <label class="btn sm ghost icon-text doc-btn">${icon("upload")} <span>Upload</span><input type="file" data-up="${k}" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></label>
        </div>`;
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
      el.setAttribute("data-tab", tab);
      // The month picker only matters on the tabs about this month; Sell, Payslips, Docs and Profile do not use it.
      document.body.dataset.filters = ["month", "team", "loans"].includes(tab) ? "" : "none";
      const pane = $("#pane");
      pane.innerHTML = panes[tab]().toString();
      if (animate) { pane.classList.remove("pane-in"); void pane.offsetWidth; pane.classList.add("pane-in"); }
      $$("#tabs button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
      if (tab === "sell") mountSell($("#till"), { onChanged: () => { dirty = true; } }).catch((e) => toast(e.message, "err"));
      if (tab === "month") {
        const daysEl = $("#days");
        if (daysEl) daysEl.innerHTML = m.daily.length ? both(
          dataTable({
            rows: m.daily, sortable: false, footer: true,
            cols: [
              { key: "date", label: "Day", render: (r) => dateLabel(r.date), total: () => "Total" },
              { key: "business_amount", label: "Sales", align: "r", render: (r) => money(r.business_amount), total: () => money(m.business) },
              { key: "settled_amount", label: "Handed in", align: "r", render: (r) => money(r.settled_amount), total: (x) => money(x.reduce((t, r) => t + r.settled_amount, 0)) },
              { key: "settle_up_minus", label: "Difference", align: "r", render: (r) => html`<span class="${r.settle_up_minus ? "neg" : ""}">${money(r.settle_up_minus)}</span>`, total: () => money(m.settle_up) },
              { key: "personal_minus", label: "Advance", align: "r", render: (r) => (r.personal_minus ? money(r.personal_minus) : "—"), total: () => money(m.personal) },
              { key: "notes", label: "Note", render: (r) => r.notes || "" },
              { key: "status", label: "", sort: false, render: (r) => (r.source === "portal" ? (r.confirmed ? badge("green", "Confirmed") : html`${badge("amber", "Waiting")} <button class="btn sm ghost" data-rm="${r.date}">Remove</button>`) : "") },
            ],
          }).toString(),
          group("", [...m.daily.slice().reverse().map((r) => row(dateLabel(r.date), money(r.business_amount), {
            sub: `Handed in ${money(r.settled_amount)}${r.personal_minus ? ` · Advance ${money(r.personal_minus)}` : ""}${r.notes ? ` · ${r.notes}` : ""}${r.source === "portal" && !r.confirmed ? " · waiting for confirmation" : ""}`,
            vsub: r.settle_up_minus ? `Not handed in ${money(r.settle_up_minus)}` : "", cls: "",
          })), row(`Total · ${m.days} day${m.days === 1 ? "" : "s"}`, money(m.business), { strong: true, vsub: m.settle_up ? `Not handed in ${money(m.settle_up)}` : "" })])) : emptyState("No days entered yet", "", "sheet").toString();
        if (m.stock.length && $("#stock")) $("#stock").innerHTML = group("", m.stock.map((r) => row(r.product, r.shortfall_value ? money(r.shortfall_value) : "—", { sub: `${r.shortfall_qty} missing × ${money(r.unit_price)}`, cls: r.shortfall_value ? "neg" : "" })));
        if (m.allowances.length && $("#allow")) $("#allow").innerHTML = group("", m.allowances.map((r) => row(r.description, money(r.amount))));
        // A day the seller entered themselves (older entries) can be taken back while the office has not confirmed it.
        $$("[data-rm]").forEach((b) => (b.onclick = () => busy(b, async () => {
          await del(`/api/me/sales/${b.dataset.rm}`);
          toast("Removed");
          await this.render({ ...ctx, refresh: true });
        })));

        const setMDeck = (dk) => {
          monthDeck = dk;
          $$("[data-mdeck]", el).forEach((b) => {
            const on = b.dataset.mdeck === dk;
            b.classList.toggle("on", on);
            b.setAttribute("aria-selected", String(on));
          });
          const deckBody = $("#month-deck-body");
          if (deckBody) {
            ["pay", "days", "rules"].forEach((k) => {
              const panel = deckBody.querySelector(`#mdeck-${k}`);
              if (panel) panel.hidden = (k !== dk);
            });
            deckBody.classList.remove("pane-in");
            void deckBody.offsetWidth;
            deckBody.classList.add("pane-in");
          }
        };

        $$("[data-mdeck]", el).forEach((b) => {
          b.onclick = () => { setMDeck(b.dataset.mdeck); buzz(6); };
        });

        const deckEl = $("#month-deck-body");
        if (deckEl) {
          const mDecks = me.senior ? ["pay", "rules"] : ["pay", "days", "rules"];
          swipeTabs({
            el: deckEl,
            tabs: mDecks,
            getActive: () => monthDeck,
            setActive: (dk) => { setMDeck(dk); buzz(8); },
          });
        }
      }
      if (tab === "team" && d.team && d.team_sales_hidden) {
        // A manager knows who is under them, never what they sold.
        $("#team").innerHTML = d.team.length ? html`<ul class="hs-list-flat" role="list" style="list-style:none;margin:0;padding:0">${d.team.map((r) => html`<li class="hs-row" style="padding-left:${16 + (r.depth - 1) * 18}px;cursor:default">
          <span class="avatar" aria-hidden="true">${initials(r.name)}</span><span class="hs-main"><b>${r.name}</b><span class="muted">${r.employee_id} · ${r.level_name}</span></span></li>`)}</ul>`.toString()
          : emptyState("No one reports to you yet", "People who report to you appear here.", "users").toString();
      } else if (tab === "team" && d.team) {
        $("#team").innerHTML = d.team.length ? both(
          dataTable({
            rows: d.team, sortable: false, footer: true,
            cols: [
              { key: "name", label: "Name", render: (r) => html`<span style="padding-left:${(r.depth - 1) * 14}px"><b>${r.name}</b> <span class="faint">${r.employee_id}</span></span>`, total: () => "Total" },
              { key: "level_name", label: "Position" },
              { key: "days", label: "Days", align: "r", total: (x) => x.reduce((t, r) => t + r.days, 0) },
              { key: "business", label: "Sales", align: "r", render: (r) => money(r.business), total: () => money(d.below_sales) },
              { key: "short", label: "Short", align: "r", render: (r) => (r.short ? html`<span class="neg">${money(r.short)}</span>` : "—"), total: (x) => money(x.reduce((t, r) => t + r.short, 0)) },
              { key: "target", label: "Of target", align: "r", render: (r) => (r.target ? pct(r.business / r.target, 0) : "—"), total: () => "" },
            ],
          }).toString(),
          group("", [...d.team.map((r) => row(r.name, money(r.business), {
            avatar: initials(r.name),
            sub: `${r.level_name} · ${r.days} day${r.days === 1 ? "" : "s"}${r.target ? ` · ${pct(r.business / r.target, 0)} of target` : ""}`,
            vsub: r.short ? `Short ${money(r.short)}` : "",
          })),
          row("Total below you", money(d.below_sales), { strong: true })])) : emptyState("No one reports to you yet", "People who report to you appear here with their sales.", "users").toString();
      }
      if (tab === "payslips" && d.history.length) {
        $("#hist").innerHTML = both(
          dataTable({
            rows: d.history, sortable: false, rowAction: "",
            cols: [
              { key: "period", label: "Month", render: (r) => html`<b>${monthName(r.period)}</b>` },
              { key: "gross_earnings", label: "Earned", align: "r", render: (r) => money(r.gross_earnings) },
              { key: "total_deductions", label: "Deductions", align: "r", render: (r) => money(r.total_deductions) },
              { key: "net_pay", label: "Net pay", align: "r", render: (r) => html`<b class="${r.net_pay < 0 ? "neg" : ""}">${money(r.net_pay)}</b>` },
              { key: "disbursed_amount", label: "Salary", align: "r", render: (r) => money(r.disbursed_amount) },
              { key: "closing_balance", label: "Carried forward", align: "r", render: (r) => html`<span class="${r.closing_balance < 0 ? "neg" : ""}">${money(r.closing_balance)}</span>` },
              { key: "slip", label: "", sort: false, align: "r", render: (r) => html`<a class="btn sm" href="/me/payslips/${r.period}" data-link aria-label="Open the payslip for ${monthName(r.period)}">${icon("file")} Payslip</a>` },
            ],
          }).toString(),
          group("", d.history.map((r) => row(monthName(r.period), money(r.net_pay), { sub: `Earned ${n0(r.gross_earnings)} · Taken off ${n0(r.total_deductions)}`, vsub: `Paid ${n0(r.disbursed_amount)}`, cls: r.net_pay < 0 ? "neg" : "", href: `/me/payslips/${r.period}` }))));
      }
      if (tab === "documents") drawDocs().catch((e) => toast(e.message, "err"));
    };
    $$("#tabs button", el).forEach((b) => (b.onclick = () => {
      if (tab === b.dataset.t) return;
      const was = tab; tab = b.dataset.t;
      history.pushState({ tab }, "", `${location.pathname}?tab=${tab}`);
      if (was === "sell" && dirty) { dirty = false; this.render({ ...ctx, refresh: true }); } else show();
    }));

    const tabOrder = [...(me.sells ? ["sell"] : []), "month", ...(d.team ? ["team"] : []), "payslips", ...(d.loans.length ? ["loans"] : []), "documents", "details"];
    swipeTabs({
      el: $("#tabs"),
      tabs: tabOrder,
      getActive: () => tab,
      setActive: (t) => {
        if (tab === t) return;
        const was = tab; tab = t;
        history.pushState({ tab }, "", `${location.pathname}?tab=${tab}`);
        if (was === "sell" && dirty) { dirty = false; this.render({ ...ctx, refresh: true }); } else show();
        buzz(10);
      },
    });
    if (!panes[tab] || (tab === "loans" && !d.loans.length)) tab = "month";
    show(!ctx.refresh);

    $("#refresh").onclick = (e) => busy(e.currentTarget, async () => { await this.render({ ...ctx, refresh: true }); toast("Up to date"); });
    setupPull();
    ptr.fn = () => this.render({ ...ctx, refresh: true });
  },
};
