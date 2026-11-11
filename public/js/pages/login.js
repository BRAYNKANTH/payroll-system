import { post } from "../api.js";
import { $, esc, icon } from "../ui.js";

export default {
  title: "Sign in",
  render({ needsSetup, onDone, company }) {
    document.title = needsSetup ? "Set up · Payroll" : "Sign in · Payroll";
    document.body.innerHTML = `
    <div class="auth-wrap">
      <section class="auth-art" aria-label="About">
        <div class="brand" style="padding:0"><div class="brand-mark" aria-hidden="true">₨</div><div><div class="brand-name">Payroll</div><div class="brand-sub">Hub payroll and manager accounts</div></div></div>
        <div>
          <h2 class="art-title">Every day's sheet ends up on a payslip.</h2>
          <p>Enter business and handed-in cash for each person. The system works out commission, shortfalls and the balance carried to next month.</p>
          <figure class="ledger" aria-label="Example of one day on the daily sheet">
            <figcaption>One day, one person (example)</figcaption>
            <dl>
              <div><dt>Business</dt><dd>48,000.00</dd></div>
              <div><dt>Handed in</dt><dd>46,500.00</dd></div>
              <div class="short"><dt>Short, taken off pay</dt><dd>1,500.00</dd></div>
            </dl>
          </figure>
          <p class="flow">Daily sheets, then the month's payroll, then review, finalize and the bank file.</p>
        </div>
        <div class="note">Amounts are in Sri Lankan rupees (LKR). Every change is recorded in the audit trail.</div>
      </section>
      <main class="auth-form">
        <div class="auth-card">
          <div class="auth-brand" aria-hidden="true"><div class="brand-mark">₨</div><div><div class="brand-name">${esc(company || "Payroll")}</div><div class="brand-sub">Payroll & hub accounts</div></div></div>
          <h1 class="auth-title">${needsSetup ? "Create the admin account" : "Welcome back"}</h1>
          <p class="muted" style="margin:0">${needsSetup ? "This is the first run. The account you create here will have full access." : "Sign in to continue to your payroll workspace."}</p>
          <form id="auth-form" novalidate>
            ${needsSetup ? `<div class="field"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" autocomplete="name" required></div>` : ""}
            <div class="field"><label for="username">Username</label><input class="input" id="username" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></div>
            <div class="field"><label for="password">Password</label>
              <div class="pw-wrap"><input class="input" id="password" name="password" type="password" autocomplete="${needsSetup ? "new-password" : "current-password"}" enterkeyhint="go" required>
                <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Show password" aria-pressed="false" aria-controls="password">${icon("eye")}</button></div>
              ${needsSetup ? `<span class="hint">At least 8 characters, with letters and numbers.</span>` : ""}</div>
            <div id="auth-err" class="alert err" role="alert" hidden>${icon("alert")}<div></div></div>
            <button class="btn primary" type="submit">${needsSetup ? "Create account & continue" : "Sign in"}</button>
          </form>
        </div>
      </main>
    </div>`;
    const form = $("#auth-form");
    if (company) document.title = `${needsSetup ? "Set up" : "Sign in"} · ${company}`;
    if (!matchMedia("(pointer: coarse)").matches) form.querySelector("input")?.focus(); // a phone keyboard should not cover the form on arrival
    $("#pw-toggle").onclick = (e) => {
      const pw = $("#password"), show = pw.type === "password";
      pw.type = show ? "text" : "password";
      e.currentTarget.setAttribute("aria-pressed", String(show));
      e.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
    };
    form.addEventListener("input", () => { form.querySelectorAll("[aria-invalid]").forEach((i) => { i.removeAttribute("aria-invalid"); i.removeAttribute("aria-describedby"); }); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      btn.classList.add("loading");
      $("#auth-err").hidden = true;
      try {
        const body = Object.fromEntries(new FormData(form));
        await post(needsSetup ? "/api/auth/setup" : "/api/auth/login", body);
        await onDone();
      } catch (err) {
        $("#auth-err div").innerHTML = esc(err.message);
        $("#auth-err").hidden = false;
        const pw = form.querySelector("#password");
        pw.setAttribute("aria-invalid", "true");
        pw.setAttribute("aria-describedby", "auth-err");
        pw.select();
        btn.classList.remove("loading");
      }
    };
  },
};
