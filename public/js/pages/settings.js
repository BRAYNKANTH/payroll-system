import { get, put } from "../api.js";
import { state } from "../app.js";
import { $, $$, html, icon, toast, busy, LEVELS } from "../ui.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default {
  title: "Settings",
  async render(ctx) {
    const { el } = ctx;
    const s = await get("/api/settings");
    const closed = String(s.closed_weekdays || "").split(",").filter(Boolean);
    let pd = {};
    try { pd = JSON.parse(s.position_defaults || "{}"); } catch { /* start empty */ }
    el.innerHTML = html`
      <div class="page-head"><div><h1>Settings</h1><p>Company details and the rules the payroll engine uses. Every change is recorded in the audit trail.</p></div></div>
      <form id="sf" class="stack">
        <div class="card"><div class="card-head"><div><h3>Company</h3></div></div><div class="card-body form-grid">
          <div class="field"><label>Company name</label><input class="input" name="company_name" value="${s.company_name}"></div>
          <div class="field"><label>Company debit account</label><input class="input mono" name="company_account_no" value="${s.company_account_no}"><span class="hint">Shown on the bank file total line</span></div>
        </div></div>

        <div class="card"><div class="card-head"><div><h3>Payroll rules</h3><div class="sub">Changes apply the next time a month is calculated</div></div></div><div class="card-body form-grid">
          <div class="field"><label>Company return (% of manager business)</label><input class="input" name="company_return_rate" inputmode="decimal" value="${+(s.company_return_rate * 100).toFixed(4)}"></div>
          <div class="field"><label>Flag when net pay changes by more than (%)</label><input class="input" name="net_pay_change_threshold" inputmode="decimal" value="${+(s.net_pay_change_threshold * 100).toFixed(4)}"></div>
          <div class="field"><label>Flag stock shortfall above (Rs / month)</label><input class="input" name="stock_shortfall_threshold" inputmode="decimal" value="${s.stock_shortfall_threshold / 100}"></div>
          <div class="field full"><span class="lbl">Days hubs are closed</span><span class="hint">Used to spot missing daily sheets</span>
            <div class="row" style="margin-top:6px">${DAYS.map((d, i) => html`<label class="badge plain" style="cursor:pointer;padding:6px 12px"><input type="checkbox" name="closed" value="${i}" ${closed.includes(String(i)) ? "checked" : ""}> ${d}</label>`)}</div></div>
        </div></div>

        <div class="card"><div class="card-head"><div><h3>Pay defaults by position</h3><div class="sub">Pre-filled when you add someone at that position. Each person can still have their own target and rates on their profile.</div></div></div>
          <div class="card-body flush"><div class="table-wrap"><table class="table" id="pd">
            <thead><tr><th scope="col">Position</th><th scope="col">Pay scheme</th><th scope="col" class="r">Target (Rs)</th><th scope="col" class="r">Basic (Rs)</th><th scope="col" class="r">Commission over target %</th>
              <th scope="col" class="r">Commission under target %</th><th scope="col" class="r">Food (Rs/day)</th><th scope="col" class="r">Food after days</th><th scope="col">Security</th></tr></thead>
            <tbody>${LEVELS.filter(([k]) => k !== "manager").map(([k, l]) => { const d = pd[k] || {}; const sec = /^(fixed|pct_gross|pct_basic|pct_business):([\d.]+)/.exec(d.security_deduction_rule || "") || [];
              const inp = (f, v, w = 96) => html`<td class="r"><input class="input sm" style="width:${w}px;text-align:right" inputmode="decimal" data-l="${k}" data-f="${f}" aria-label="${l} ${f.replace(/_/g, " ")}" value="${v || ""}"></td>`;
              return html`<tr><th scope="row">${l}</th>
                <td><select class="input sm" style="min-width:150px" data-l="${k}" data-f="pay_scheme" aria-label="${l} pay scheme"><option value="over_target" ${d.pay_scheme !== "tiered" ? "selected" : ""}>Basic + over target</option><option value="tiered" ${d.pay_scheme === "tiered" ? "selected" : ""}>Tiered</option></select></td>
                ${inp("target", d.target)}${inp("basic_pay", d.basic_pay)}${inp("commission_pct", d.commission_rate ? +(d.commission_rate * 100).toFixed(4) : "", 70)}${inp("base_commission_pct", d.base_commission_rate ? +(d.base_commission_rate * 100).toFixed(4) : "", 70)}
                ${inp("food_per_day", d.food_per_day, 70)}${inp("food_min_days", d.food_min_days, 60)}
                <td><div class="row" style="gap:6px;flex-wrap:nowrap"><select class="input sm" data-l="${k}" data-f="sec_kind" aria-label="${l} security type" style="width:auto">${[["none", "None"], ["fixed", "Fixed Rs"], ["pct_gross", "% gross"], ["pct_basic", "% basic"], ["pct_business", "% business"]].map(([v, n]) => html`<option value="${v}" ${(sec[1] || "none") === v ? "selected" : ""}>${n}</option>`)}</select>
                  <input class="input sm" style="width:70px;text-align:right" inputmode="decimal" data-l="${k}" data-f="sec_value" aria-label="${l} security amount" value="${sec[2] || ""}"></div></td></tr>`; })}</tbody></table></div></div></div>

        <div class="card"><div class="card-head"><div><h3>Sign-in</h3></div></div><div class="card-body form-grid">
          <div class="field"><label>Session length (hours)</label><input class="input" name="session_hours" inputmode="numeric" value="${s.session_hours}"></div>
        </div></div>

        <div class="card"><div class="card-head"><div><h3>Bank file</h3></div></div><div class="card-body">
          <div class="alert warn">${icon("alert")}<div><b>Format: ${s.bank_format} (placeholder).</b> Get the exact bulk-upload / SLIPS column specification from your bank and add it to <code>reports.js</code> before uploading a live file.</div></div>
        </div></div>

        <div class="row" style="justify-content:flex-end"><button class="btn primary" id="save">${icon("check")} Save settings</button></div>
      </form>
      <div class="card mt-4"><div class="card-head"><div><h3>Backup</h3><div class="sub">Download every record (staff, sheets, payroll, audit trail) as one file. Passwords are not included.</div></div>
        <button class="btn" id="backup">${icon("download")} Download backup</button></div><div class="card-body muted">Neon also keeps its own point-in-time history of the database. Download a copy here after each month is finalized and keep it somewhere safe.</div></div>`;
    $("#backup").onclick = (e) => busy(e.currentTarget, async () => {
      const res = await fetch("/api/backup", { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Backup failed");
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "payroll-backup.json";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      a.click();
      toast("Backup downloaded");
    });
    $("#sf").onsubmit = (e) => {
      e.preventDefault();
      busy($("#save"), async () => {
        const f = new FormData(e.target);
        const v = {};
        $$("#pd [data-l]").forEach((x) => { (v[x.dataset.l] ||= {})[x.dataset.f] = x.value.trim(); });
        const position_defaults = {};
        for (const [level, d] of Object.entries(v)) {
          position_defaults[level] = {
            pay_scheme: d.pay_scheme, target: d.target, basic_pay: d.basic_pay,
            commission_rate: d.commission_pct ? Number(d.commission_pct) / 100 : 0, base_commission_rate: d.base_commission_pct ? Number(d.base_commission_pct) / 100 : 0,
            food_per_day: d.food_per_day, food_min_days: d.food_min_days,
            security_deduction_rule: d.sec_kind === "none" ? "none" : `${d.sec_kind}:${d.sec_value || 0}`,
          };
        }
        const saved = await put("/api/settings", {
          position_defaults: JSON.stringify(position_defaults),
          company_name: f.get("company_name"), company_account_no: f.get("company_account_no"),
          company_return_rate: Number(f.get("company_return_rate")) / 100,
          net_pay_change_threshold: Number(f.get("net_pay_change_threshold")) / 100,
          stock_shortfall_threshold: f.get("stock_shortfall_threshold"),
          closed_weekdays: f.getAll("closed").join(","),
          session_hours: f.get("session_hours"),
        });
        state.settings = saved;
        toast("Settings saved");
      });
    };
  },
};
