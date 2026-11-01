import { post } from "../api.js";
import { $, esc, icon } from "../ui.js";

export default {
  title: "Sign in",
  render({ needsSetup, onDone }) {
    document.title = needsSetup ? "Set up · Payroll" : "Sign in · Payroll";
    document.body.innerHTML = `
    <div class="auth-wrap">
      <section class="auth-art" aria-label="About">
        <div class="brand" style="padding:0"><div class="brand-mark" aria-hidden="true">₨</div><div><div class="brand-name">Payroll</div><div class="brand-sub">Hub payroll and manager accounts</div></div></div>
        <div>
          <h2 class="art-title">Daily sheets in, payslips and a bank file out.</h2>
          <p>Staff enter each day's business and settlements. The system works out commission, deductions and balances carried from last month.</p>
          <ol>
            <li>Enter the daily sheets for each hub</li>
            <li>Calculate the month's payroll</li>
            <li>Review the rows that were flagged</li>
            <li>Finalize, which locks the month</li>
            <li>Download the bank file and payslips</li>
          </ol>
        </div>
        <div class="note">Amounts are in Sri Lankan rupees (LKR). Every change is recorded in the audit trail.</div>
      </section>
      <main class="auth-form">
        <div class="auth-card">
          <h1 class="auth-title">${needsSetup ? "Create the admin account" : "Welcome back"}</h1>
          <p class="muted" style="margin:0">${needsSetup ? "This is the first run. The account you create here will have full access." : "Sign in to continue to your payroll workspace."}</p>
          <form id="auth-form" novalidate>
            ${needsSetup ? `<div class="field"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" autocomplete="name" required></div>` : ""}
            <div class="field"><label for="username">Username</label><input class="input" id="username" name="username" autocomplete="username" required autofocus></div>
            <div class="field"><label for="password">Password</label><input class="input" id="password" name="password" type="password" autocomplete="${needsSetup ? "new-password" : "current-password"}" required>
              ${needsSetup ? `<span class="hint">At least 8 characters, with letters and numbers.</span>` : ""}</div>
            <div id="auth-err" class="alert err" role="alert" hidden>${icon("alert")}<div></div></div>
            <button class="btn primary" type="submit">${needsSetup ? "Create account & continue" : "Sign in"}</button>
          </form>
        </div>
      </main>
    </div>`;
    const form = $("#auth-form");
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
        form.querySelector("#password").select();
        btn.classList.remove("loading");
      }
    };
  },
};
