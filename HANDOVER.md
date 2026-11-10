# Payroll system: project handover

Written 2026-11-01 so a new Claude session can continue without the earlier conversation.
**This file contains no passwords or connection strings. Never paste those into a chat.**

## 1. What this is

A payroll and hub-accounts system for a Sri Lankan direct-sales business ("World Entrepreneurs Company",
Stanly Road, Jaffna). It replaces a set of Excel workbooks.

- **People:** *guys* (field sellers, role `distributor` or `supervisor`) report to *managers*; managers run a hub
  (branches: Jaffna 01/02/03, Kilinochchi, Chavakachcheri).
- **Money flow, weekly:** stock issued, daily sales, cash settlement (manager hands in 90% of business),
  weekly master (what each manager owes the company), branch reconciliation (should net to 0).
- **Money flow, monthly:** manager month sheet (profit 15% or 20% less rent/hub/security/personal),
  guys' pay calculation, payslips with authority + employee signatures.
- The user (luggo.lk@gmail.com, Windows 11, PowerShell) owns the business data and decisions. Not a developer.

The analysis of the Excel files is in `C:\Users\T.BRAYNKANTH\PAYROLL\process-and-data-model.md`
(process, formulas found, 14-table data model, questions for the owner). Read it first.

## 2. Where everything is

| Thing | Location |
|---|---|
| Code (this repo) | `D:\payroll-system`, branch `master`, remote `https://github.com/BRAYNKANTH/payroll-system` |
| Analysis doc | `C:\Users\T.BRAYNKANTH\PAYROLL\process-and-data-model.md` |
| Source Excel files | `C:\Users\T.BRAYNKANTH\Downloads\music\` (`sep managers-2026`, `ROSHAN - Copy (9)`, `santhees`, `sathees`, `chava`, `j1`, `j2 branch`, `j3`, `kili`, `killi 2`) |
| Hosted app | Vercel project `payroll-system-luggo` (https://payroll-system-luggo.vercel.app) |
| Hosted database | Neon, Singapore, endpoint `ep-wandering-math-azh2zips` (db `neondb`) |

The older `C:\Users\T.BRAYNKANTH\.claude\...\memory\project_payroll_system.md` says the project lives at
`D:/payroll-system` and must stay separate from `helans-pos`. That is still true.

## 3. The code

Node 22+, no framework. Postgres everywhere: **Neon** in production, **PGlite** (embedded) locally and in tests.
Money is integer cents. See `README.md` for the full feature list and hosting notes.

| File | Role |
|---|---|
| `engine.js` | Pure payroll calculations (`computeGuy`, `computeManager`, `evaluateFlags`, security rules) |
| `service.js` | Entity definitions and validation, `runPeriod`, review, finalize |
| `db.js` | Schema (re-applied when its hash changes), audit triggers, period locks, drivers |
| `auth.js` | Users, scrypt passwords, sessions, roles |
| `server.js`, `api/index.js` | HTTP routes; `api/index.js` is the Vercel serverless entry |
| `vercel.json` | Rewrites `/api/*` to `/api/index`, everything else to `index.html`, plus security headers |
| `seed.js` | Demo data (random passwords on a hosted DB) |
| `public/` | Single-page UI (`js/pages/*.js`) |
| `test/` | `node:test` suites |

Commands: `npm install`, `npm run demo` (local demo at http://127.0.0.1:8090), `npm test` (32 tests, about 40 s).
Demo sign-ins on a local demo database only: `admin/admin123`, `accounts/accounts123`, `manager1`/`manager2`/`manager3` (all `manager123`, one branch each), staff portal `pavan`/`kavin`/`meena` (all `staff123`), `clerk/clerk123`, `viewer/viewer123`.

### Done in the last session (commit `8ea4c21`, pushed)

A per-person **`tiered` pay scheme** matching the Excel payslips:

| Rule | Behaviour |
|---|---|
| `pay_scheme` | `over_target` (default, old behaviour) or `tiered` |
| Tiered, business > target | fixed `basic_pay` + `commission_rate` x (business - target) |
| Tiered, business <= target | `base_commission_rate` x all business, no basic |
| Food allowance | `food_per_day` x days logged, only if days >= `food_min_days` (0 = always) |
| Security rule | new `pct_business:<n>` (1% of total business) |

New `staff` columns: `pay_scheme`, `base_commission_rate`, `food_per_day`, `food_min_days` (added with
`ALTER TABLE ... IF NOT EXISTS` in `db.js`). Employee form and profile page show them. The new tests reproduce three
real Excel payslips to the cent (net 26,710.10 / 20,908.90 / 4,082.00).

Typical Excel values: supervisor target 120,000, fixed basic 30,000, food 150/day only from 24 days;
distributor target 100,000, fixed basic 25,000, food 150/day always; base commission 25%; over-target 30%.

### Not done

- **Manager rules are unchanged** because the Excel files contradict each other (see section 6).
- **UI redesign** (commit `71dfa21`, "Redesign UI: light warm palette..."): not from the last session. It is committed
  locally but **not pushed**, as is the handover commit, so `origin/master` is still at `8ea4c21` and the live site
  has neither. That redesign removed `#page-title`, so `pages/employee.js` guards that line. The pay-scheme fields
  in `pages/employees.js` survived the redesign (checked).

## 4. Hosting status: the open problem

Goal: use the hosted system on Vercel + Neon.

- **Neon:** 14 payroll tables were created in endpoint `ep-wandering-math-azh2zips` by running `db.open()`.
  `users` has **0 rows**. The `neon_auth` schema in that database belongs to Neon Auth; ignore it, the app has its own login.
- **Admin account: not created.** The user must choose their own username and password. Do not generate or
  hold credentials for them. Either the first-visit "create admin" page (once the API works) or, from their machine:
  set `$env:DATABASE_URL` in PowerShell, then run
  `node --no-warnings -e "const db=require('./db'),auth=require('./auth');(async()=>{const d=await db.open();await auth.setup(d,{username:process.argv[1],full_name:'Owner Admin',password:process.argv[2]});console.log('Admin created');await d.close()})()" USER PASS`
- **The blocker:** the live site serves the sign-in page but **`POST /api/auth/login` returns 405 and
  `/api/health` returns the home page.** So Vercel is serving static files and not running `api/index.js`.
- **Cause found:** in Vercel Settings > Build, "Production Overrides" shows the current production deployment was
  built with **Framework: Node** and an empty build command, while the project setting is **Other** (Output
  Directory `public`, no build/install override). A deployment built under the current settings was never made.
- **Tried, not confirmed:** Redeploy without build cache; a fresh Git push to `master` was proposed but not done.
- **Next steps:** (1) force a clean production deployment, either Redeploy with cache unticked or a small commit
  pushed to `master`; (2) check `/api/health` returns `{"ok":true,...}`; (3) check the deployment's Functions list
  includes `api/index`; (4) make sure Vercel's `DATABASE_URL` (Production) is the pooled Neon string for
  `ep-wandering-math-azh2zips`; (5) create the admin; (6) the site is behind Vercel Deployment Protection, so only
  logged-in Vercel users can open it; ask the user before changing that.
- A local `D:\payroll-system\.env` exists (gitignored) and points to a **different** Neon endpoint
  (`ep-wild-band-b3plrmci`). Its contents are unknown and it is not the hosted database.

**Security note:** the user pasted the `neondb_owner` connection string, including its password, into a chat.
**It must be rotated** (Neon > project > Roles > reset password), then `DATABASE_URL` in Vercel updated and
redeployed. Treat the old password as compromised.

## 5. Working agreements with this user

- Keep payroll work in `D:\payroll-system`; do not touch `helans-pos`.
- Commit only your own changes; check `git status` first, other sessions may have uncommitted work.
- Never create accounts, passwords or tokens for them, and never ask them to paste secrets into chat.
- Confirm before pushing, deploying or changing hosted settings.
- Verify claims (run tests, open the page) before saying something works; say plainly when something is unverified.

## 6. Open questions for the business owner (blocking manager-side work)

1. Manager profit is 15% in some masters and 20% in others; month sheet uses 20% when business >= 100,000, else 15%. Which is correct?
2. What do the 0.75 and 0.9 factors in cell E7 of each weekly master mean (manager discount level)?
3. What is the 90% hand-in rule exactly, and where does the 15% "guys" line go (it is added in some places, charged in others)?
4. Over-target income is 30% on payslips but 5% on the month sheet. Which applies?
5. Are the fixed basics (25,000 / 30,000) paid instead of commission or on top?
6. Who approves payslips, and where is "paid" status tracked (only free text like "5000paid" was seen)?
7. The engine's company-return rule (`company_return_rate` setting, default 15%) from the earlier build still needs to be reconciled with these answers.

Known data problems in the Excel files, to avoid reproducing: `#REF!` errors in `j1 stock details`, prices hard-coded
and inconsistent per day/sheet, stale dates, role matched on the misspelling `supervior`, same sheets copied into every branch workbook.

## 7. What to upload to the new account

- This file (`D:\payroll-system\HANDOVER.md`) and `C:\Users\T.BRAYNKANTH\PAYROLL\process-and-data-model.md`.
- The repo is on GitHub (`BRAYNKANTH/payroll-system`, branch `master`), but only up to commit `8ea4c21`. Commits
  `71dfa21` (UI redesign) and the handover commit exist only on `D:\payroll-system` until pushed. Push them, or copy
  the folder, before switching accounts.
- The ten Excel files only if the new session must re-read them. They hold real names and business figures, so share deliberately.
- Do **not** upload `.env`, any connection string, or the Neon password.
