// A seller's payslip for one closed month, on a phone.
// It answers four questions, in this order: How much was I paid? Why that much (what was added, what was taken off)? What is carried forward? Can I keep a copy?
// Plain words, big figures, one column, the printed copy one tap away.
import { get } from "../api.js";
import { $, html, icon, money, monthName, pct } from "../ui.js";
import { plain, keep } from "./portal.js";

// A short "what is this?" for lines people ask about. Only lines that need it get one.
const HELP = [
  [/^Basic/i, "Your fixed pay for the month."],
  [/^Commission/i, "Your share of what you sold."],
  [/^Extra pay above target/i, "Extra pay for selling more than your target."],
  [/^Food/i, "Food allowance for the days you worked."],
  [/^Cash not handed in/i, "Sales you recorded, minus the cash you handed in."],
  [/^Missing stock/i, "Stock the count found missing, at the selling price."],
  [/^Advance/i, "Money you took earlier. It comes off your pay."],
  [/^Loan/i, "A loan payment. The amount still to pay is shown on the line."],
  [/^Security/i, "A small amount held back as a deposit."],
];
const helpFor = (label) => HELP.find(([re]) => re.test(label))?.[1] || "";

const short = (p) => new Date(p + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

export default {
  title: "Payslip",
  async render({ el, params }) {
    const period = params[0];
    let d;
    try { d = await get(`/api/me/payslip/${period}/data`); }
    catch (e) {
      if (!/finalized|no payslip/i.test(String(e.message))) throw e;
      // A month that is not closed yet (or has no pay): say so plainly and point back.
      el.innerHTML = html`<main class="slip" aria-labelledby="sl-h1"><div class="sl-top"><a class="sl-back" href="/me" data-link>${icon("left")}<span>My payslips</span></a></div>
        <h1 id="sl-h1" class="sl-empty-h">${monthName(period)}</h1>
        <section class="card sl-card"><h2>Not ready yet</h2><p class="sl-note">Your payslip for ${monthName(period)} appears here once the office has closed the month. Until then, the Month tab on your page shows how you are doing so far.</p></section></main>`.toString();
      return;
    }
    const paid = d.paid > 0;
    const earn = d.earnings.filter(keep), took = d.deductions.filter(keep);
    const line = (l, sign) => {
      const label = plain(l.label), help = helpFor(label);
      return html`<li class="sl-line">
        ${help ? html`<details class="sl-help"><summary><span class="sl-label">${label}</span><span class="sl-amt">${sign}${money(l.amount)}</span></summary><p>${help}</p></details>`
          : html`<div class="sl-plain"><span class="sl-label">${label}</span><span class="sl-amt">${sign}${money(l.amount)}</span></div>`}</li>`;
    };
    const nb = (p, dir) => (p
      ? html`<a class="sl-nav" href="/me/payslips/${p}" data-link aria-label="${short(p)}, ${dir === "prev" ? "earlier month" : "later month"}">${dir === "prev" ? icon("left") : ""}<span>${short(p)}</span>${dir === "next" ? icon("right") : ""}</a>`
      : html`<span class="sl-nav off" aria-hidden="true"></span>`);

    el.innerHTML = html`<main class="slip" aria-labelledby="sl-h1">
      <div class="sl-top">
        <a class="sl-back" href="/me" data-link id="sl-back">${icon("left")}<span>My payslips</span></a>
      </div>
      <div class="sl-months">${nb(d.prev, "prev")}<h1 id="sl-h1">${monthName(period)}</h1>${nb(d.next, "next")}</div>

      <section class="sl-hero" aria-label="Your pay">
        <p class="sl-kicker">${paid ? "Sent to your bank" : "Your pay this month"}</p>
        <p class="sl-big"><small>Rs</small> ${money(paid ? d.paid : d.net_pay)}</p>
        <p class="sl-status"><span class="sl-chip">${icon("check")} Final</span><span>${paid ? (d.bank ? `${d.bank.name}${d.bank.last4 ? ` · account ending ${d.bank.last4}` : ""}` : "To your bank") : "Nothing was sent to your bank this month."}</span></p>
      </section>

      <section class="sl-eq" aria-label="How it adds up">
        <div><span>Earned</span><b>${money(d.gross)}</b></div>
        <div class="op" aria-hidden="true">−</div>
        <div><span>Taken off</span><b>${money(d.total_deductions)}</b></div>
        <div class="op" aria-hidden="true">=</div>
        <div><span>Your pay</span><b>${money(d.net_pay)}</b></div>
      </section>

      <section class="card sl-card" aria-labelledby="sl-earn"><h2 id="sl-earn">What you earned</h2>
        ${earn.length ? html`<ul class="sl-list">${earn.map((l) => line(l, ""))}</ul>` : html`<p class="sl-none">Nothing this month.</p>`}
        <div class="sl-total"><span>Total earned</span><b>Rs ${money(d.gross)}</b></div></section>

      <section class="card sl-card" aria-labelledby="sl-took"><h2 id="sl-took">What was taken off</h2>
        ${took.length ? html`<ul class="sl-list">${took.map((l) => line(l, "− "))}</ul>` : html`<p class="sl-none">Nothing was taken off. </p>`}
        <div class="sl-total"><span>Total taken off</span><b>Rs ${money(d.total_deductions)}</b></div></section>

      <section class="card sl-card" aria-labelledby="sl-bal"><h2 id="sl-bal">Your balance</h2>
        <dl class="sl-dl">
          <div><dt>Brought forward from last month</dt><dd>${money(d.opening)}</dd></div>
          <div><dt>Your pay this month</dt><dd>${money(d.net_pay)}</dd></div>
          <div><dt>Sent to your bank</dt><dd>${money(d.paid)}</dd></div>
          <div class="sl-total"><dt>Carried forward to next month</dt><dd>Rs ${money(d.closing)}</dd></div>
        </dl>
        <p class="sl-note">A minus amount means you owe it. It is taken from your next pay.</p></section>

      ${d.is_seller && d.business != null ? html`<section class="card sl-card" aria-labelledby="sl-sales"><h2 id="sl-sales">Your sales</h2>
        <dl class="sl-dl">
          <div><dt>Sold this month</dt><dd>Rs ${money(d.business)}</dd></div>
          ${d.target ? html`<div><dt>Your target</dt><dd>Rs ${money(d.target)}</dd></div>` : ""}
        </dl>
        ${d.target ? html`<div class="sl-meter" role="img" aria-label="${pct(Math.min(1, d.business / d.target), 0)} of your target reached"><span style="width:${Math.min(100, (d.business / d.target) * 100)}%"></span></div>
          <p class="sl-note">${d.business >= d.target ? `You reached your target (${pct(d.business / d.target, 0)}).` : `You reached ${pct(d.business / d.target, 0)} of your target.`}</p>` : ""}
      </section>` : ""}

      <div class="sl-actions"><a class="btn primary" href="/api/me/payslip/${period}" target="_blank" rel="noopener">${icon("printer")} Open printable payslip</a></div>
    </main>`.toString();

    // "Back" goes to where the person came from (their payslip list), not to a fresh page.
    $("#sl-back")?.addEventListener("click", (e) => { if (history.length > 1 && document.referrer.startsWith(location.origin)) { e.preventDefault(); history.back(); } });
  },
};
