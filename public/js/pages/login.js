import { post } from "../api.js";
import { $, esc, icon } from "../ui.js";

export default {
  title: "Sign in",
  render({ needsSetup, onDone }) {
    document.title = needsSetup ? "Set up · Payroll" : "Sign in · Payroll";
    document.body.innerHTML = `
    <div class="auth-wrap">
      <section class="auth-art">
        <div class="brand" style="padding:0"><div class="brand-mark">₨</div><div><div class="brand-name">Payroll</div><div class="brand-sub">Multi-hub payroll & accounts</div></div></div>
        <div>
          <h1>Every rupee calculated, every change on record.</h1>
          <p>Daily and weekly entries flow straight into payslips, manager balances and the bank file — no hand-typed salary figures.</p>
          <ul>
            <li>${icon("checkCircle")} Automatic commission, deductions and carry-forward balances</li>
            <li>${icon("shield")} Only exceptions need approval — everything else auto-processes</li>
            <li>${icon("history")} Full audit trail of who changed what, and when</li>
            <li>${icon("bank")} Bank disbursement file for the approved batch</li>
          </ul>
        </div>
        <div style="font-size:12px;color:#64748b">Amounts in Sri Lankan Rupees (LKR)</div>
      </section>
      <section class="auth-form">
        <div class="auth-card">
          <h2>${needsSetup ? "Create the admin account" : "Welcome back"}</h2>
          <p class="muted" style="margin:0">${needsSetup ? "This is the first run. The account you create here will have full access." : "Sign in to continue to your payroll workspace."}</p>
          <form id="auth-form" novalidate>
            ${needsSetup ? `<div class="field"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" autocomplete="name" required></div>` : ""}
            <div class="field"><label for="username">Username</label><input class="input" id="username" name="username" autocomplete="username" required autofocus></div>
            <div class="field"><label for="password">Password</label><input class="input" id="password" name="password" type="password" autocomplete="${needsSetup ? "new-password" : "current-password"}" required>
              ${needsSetup ? `<span class="hint">At least 8 characters, with letters and numbers.</span>` : ""}</div>
            <div id="auth-err" class="alert err" hidden>${icon("alert")}<div></div></div>
            <button class="btn primary" type="submit">${needsSetup ? "Create account & continue" : "Sign in"}</button>
          </form>
        </div>
      </section>
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
        btn.classList.remove("loading");
      }
    };
  },
};
