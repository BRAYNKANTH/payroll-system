# Payroll

Payroll and hub accounts for a multi-branch retail business. Per branch: a coacher, a promoting manager, a manager (who also sells)
and the sellers, distributors and supervisors, who are one level and differ only in target and rates. Sellers are paid monthly with
commission; a manager keeps a weekly account; the promoting manager and coacher earn a salary plus a share of sales. Every figure in a
pay period is calculated from the daily, weekly, stock and allowance sheets. Nobody types a final salary.

Runs on Postgres: **Neon** in production, and PGlite (embedded Postgres, no install) on your own computer.
Needs Node 22+.

```
npm install
npm run demo        # local demo: data/demo with 3 hubs and 5 months of data, then serve it
npm run demo:october # October 2026 with every exception scenario and a login for each kind of user (data/october)
npm start           # local real database in data/pglite (first visit asks you to create the admin)
npm test
```

Open http://127.0.0.1:8090.

## Hosting on Neon + Vercel

The database lives on **Neon**; the app runs on **Vercel**. Both have free tiers.

1. **Neon** — sign up at neon.tech → *New project* → region **AWS Asia Pacific (Singapore)** (closest to Sri Lanka).
   Open *Connect*, choose **Pooled connection**, and copy the connection string
   (`postgresql://…-pooler…neon.tech/neondb?sslmode=require`).
2. **GitHub** — create a private repository and push this folder to it.
3. **Vercel** — sign up at vercel.com with GitHub → *Add New → Project* → import the repository.
   Framework preset **Other**; leave build settings as they are (`vercel.json` handles them).
   Under *Environment Variables* add `DATABASE_URL` = the Neon string from step 1. Deploy.
4. Open the Vercel address. The first visit asks you to create the **admin** account.
   The tables are created automatically on first use.
5. Check `https://<your-app>.vercel.app/api/health` shows `"ok": true`.

**Trial data on Neon (optional).** Put the Neon string in a `.env` file (see `.env.example`), then run
`npm run seed:neon`. It loads the demo data with **random passwords**, printed once — save them.
Only do this on an empty database; for real use, start empty and create the admin in the browser.

**Backups.** Neon keeps point-in-time history (restore from the Neon console). Admins can also download a
full copy from *Settings → Backup* — do this after each month is finalized.

The same code also runs on Render, Railway or any Node host: set `DATABASE_URL` and run `npm start`
(it listens on `PORT`).

**Demo sign-ins** (demo database only): `admin / admin123`,
`manager1` to `manager4` (all `manager123`: managers who each see only their own people; `manager4` is also a stock keeper), and staff-portal logins `pavan` (distributor D01), `kavin` (supervisor S01) and `nila` (supervisor S02), all `staff123`. The demo has three branches, each with a coacher, a promoting manager, a manager,
supervisors and distributors, four finalized months and the current month open. Jaffna 03 is small, so its manager is "retaining".

## What's in it

| Area | |
|---|---|
| Dashboard | KPIs, 6-month trend, business by hub, exceptions, top performers, missing daily sheets |
| Daily sheet | Spreadsheet grid, by day (all guys) or by employee (whole month); CSV import/export |
| Weekly sheet | One row per manager per week, live weekly balance, month overview |
| Stock count | Per guy per product, live shortfall, carry over last month's count as opening stock |
| Branch stock | Per branch per product: opening, received, given out, counted; difference and stock value; open a month from last month's count |
| Allowances | Extra earnings per month |
| Salaries | View only: every person's pay for the month, worked out from the sheets, with a full breakdown per person |
| Approvals | Queue of flagged entries only; approve / reject with notes |
| Advances & loans | Give an advance (back in one month) or a loan (monthly instalments). The payroll run takes each instalment from pay; balances come from finalized months |
| Payslips | Per person or all, printable |
| Employees | Directory, add/edit, profile with pay history chart, team, change log |
| Hubs | Branches with live figures, and each branch's coach |
| Products | Admin: each product's selling price and purchase price, with the workers' 45% and the profit per unit shown live as the prices are typed. Reports gets a Product profit tab for the month |
| Who sees pay | Pay is private: the admin (`view_pay`) is the only role that sees payroll, payslips, approvals, the commission and balances reports, pay on the dashboard, hubs and profiles, the weekly balance, pay terms (basic, rates, food, security, opening balance) and the pay approvals in the audit trail. Managers, clerks and viewers see the sales: each person's daily business, the money handed in, the shortfall (settle-up minus), advances taken, stock, targets and progress. A hub manager can still add and edit their team: a new person gets the position's usual pay terms from Settings, and pay fields sent by a hub manager are ignored. Enforced on the server, not only hidden in the menu |
| Excel and PDF exports | Every report and list downloads as an Excel file (real numbers, a SUM row, a frozen header, filters) and as a PDF (repeated header, page numbers): hub summary, commission, stock shortfall, branch stock, balances, month history, product profit, products, payroll register, daily sheet, live sales, weekly sheet, employees, advances and loans, the audit trail (following its filters), and payslips (one page per person). Built by `export.js` with no extra packages; the same rules apply as on screen: pay reports need `view_pay`, product reports `manage_products`, a hub-limited user gets only their hub. The PDF uses the built-in Helvetica, so non-Latin letters print as "?" there (the Excel file keeps them). The bank file stays a CSV, as banks require |
| Audit trail | Records who signed in, failed to sign in (never the password), was locked out, signed out or changed a password; who added, changed or deleted anything (the database records it itself, so nothing can bypass it); who uploaded or opened a scanned document; who downloaded a report, the payroll register, payslips, the bank file or a backup; who opened the payroll or a payslip; and who was refused. Every line has the address and the browser. The log is append-only: a database rule refuses any update or delete of it. The admin sees everything; others do not see sign-ins, downloads or views, nor pay approvals without pay rights; a hub user sees only their own actions. Filter by area, action, person, record and dates; export as Excel, PDF or CSV |
| Live sales | Every sale as it is entered, newest first, with the person's progress to target. The admin also sees the commission on each sale (the higher rate applies to the part over target), the pay earned so far and the net so far; everyone else sees only the sales |
| Stock flow | The admin adds products, sends stock to a particular hub (Stock to hubs), the hub's coacher or stock keeper gives it out to individual sellers each morning (Morning stock; never more than the hub holds), and each seller records every sale on their phone (never more than they hold) |
| Sellers enter their own sales | On the staff portal a distributor or supervisor adds a day (sales, money handed in, advance). It is unconfirmed until a hub manager or the admin confirms it; until then the seller can correct or remove it, and payroll flags it (`UNCONFIRMED_SALES`) so a month cannot be finalized with unchecked sales |
| Coacher as hub head | A coacher is the head of a hub, with the managers under them. A staff-portal login created for a coacher becomes a hub-limited office login (enter data, confirm sales, register the team, hub accounts) that also has My page. It never shows anyone's pay; only the admin sees pay. |
| Leavers and joiners | Mark as left (last day, reason, and who takes over the people reporting to them, who must hold the same position in the same hub), Re-hire, and a coacher can be added for a branch. Days before someone joined or after they left are not counted as missing |
| Reports | Hub summary, commission, stock shortfall, branch stock, balances, month history (CSV export) |
| Audit trail | Every change after first entry: who, when, old → new; filters and export |
| Users & roles | Four kinds of login: admin; coacher (heads one hub and sees all of it); manager (sees only the people who report to them); staff portal. The position of the employee chosen decides the kind of login |
| Settings | Company, rule thresholds, closed days, session length |

## Roles

| Role | Can |
|---|---|
| Staff portal | A distributor or supervisor signs in to a single page: own sales and target progress, an estimate of pay while the month is open, final pay and payslips after it is finalized, documents, and (supervisors and group managers) their team's sales. Nothing else. |
| Coacher | Heads one hub: sees every person, all stock and all sheets of that hub, enters data, confirms days, registers the team and gives stock out each morning. Never sees pay |
| Manager | Sees only the people under them (directly or through others): their sales, stock and details, view only, never pay. Promoting managers get this login too. A manager tagged **stock keeper** can also see and give stock to everyone in the hub |
| Admin | The owner and the secretary: everything, including payroll, approvals, finalizing months, products, users and settings |

## Monthly workflow

1. The hub managers and the admin fill in the daily and weekly sheets, stock counts and allowances.
2. **Payroll run → Calculate.** Recalculate as often as you like. Entries without flags are auto-approved.
3. Approve or reject flagged entries in **Approvals**. A rejection needs a reason; fix the data and recalculate.
4. **Finalize** (admin). Recalculates once more, locks every entry for the month (enforced by database
   triggers), and makes each closing balance next month's opening balance.
5. Download the bank file, print payslips and the register.

## Rules

| | |
|---|---|
| Guy commission (`pay_scheme = over_target`, default) | `max(0, business − target) × commission_rate` |
| Guy gross | `basic + commission + allowances` |
| Guy, `pay_scheme = tiered` (business > target) | fixed `basic_pay` + `commission_rate × (business − target)` |
| Guy, `pay_scheme = tiered` (business ≤ target) | `base_commission_rate × all business`, no basic |
| Guy food allowance (tiered) | `food_per_day × days logged`, only once `food_min_days` are worked (0 = always) |
| Guy deductions | `Σ settle_up_minus + stock shortfall value + Σ personal_minus + security` |
| Guy balance | `payable = opening + net`; positive is paid to the bank, negative carries forward |
| Who pays what | Of every sale the company pays the seller 25% and the seller's manager 20%: at most 45% to workers. What a seller earns above 25% (the extra 5% on sales over target, and food) comes out of the manager's 20%, not the company's |
| Seller's extras charged to the manager | `(commission_rate − base_commission_rate) × business over target` plus the food allowance, per seller whose payroll manager he is (`manager_extra` in each seller's detail) |
| Manager weekly | `business × profit% − rent − hub_fee − security_cost − personal_draw`. Business is the manager's own sales plus his team's for the week (the weekly sheet fills it from the daily sheets). Profit % is 20% when it reaches the manager's weekly target (`staff.target`, default Rs 100,000), else 15% |
| Manager month | `Σ weekly commission + own sales × 25% + basic salary − rent − hub fee − security − draws − team's extras`. Only the basic salary goes to the bank; the rest is a running account |
| Retaining manager | When the month's sales (his own + his team's, from the daily sheets) are below Rs 250,000 he is "retaining" for that month: basic salary + 10% of those sales replaces the weekly commission. A tag worked out each month, not a position |
| Promoting manager and coacher | Basic salary (Rs 29,000 and Rs 30,000) + 0.55% (1% of the company's 55%) of the sales of everyone below them, managers' own sales included. Paid to the bank; no weekly account. One coacher per branch |
| Product profit | `selling price − workers' share (seller 25% + manager 20%) − purchase price`, per unit. Monthly: units sold × those figures, from the stock counts, matched to the Products list by name |
| Stock shortfall | `max(0, opening + issued − sold − counted) × unit_price` |
| Advance / loan instalment | `min(instalment, what is left)`, taken only from pay left after the other deductions, so it never makes a balance negative; anything not taken stays on the loan for next month. No interest. For distributors and supervisors only |
| Security rule | none, fixed amount, % of gross, % of basic or % of business (`pct_business:1`), with an optional lifetime cap |

Flags that need approval: net pay moved by more than 20%; a negative deduction; deductions greater than
gross; a manager's balance going further negative; bank account different from the verified one (or
missing); stock shortfall above Rs 5,000. Thresholds are in Settings.

## Controls

- Sign-in with scrypt-hashed passwords, HttpOnly SameSite=Strict session cookie (Secure over HTTPS), lockout after 5 failed attempts.
- Every write needs a custom request header, so other websites can't submit forms on a signed-in user's behalf.
- Four-eyes rule: whoever changed a bank account cannot approve the payment to it.
- Audit log is written by database triggers, so it also catches edits made outside the app. Password hashes
  never enter the log.
- Finalized months and their summaries are locked at the database level (Postgres triggers).

## Still to confirm

- **Pay rules differ from the company's Excel sheets** (below-target pay, 1% security, the 15% pot, manager profit tiers). Fix
  these before paying real salaries from the system.

- **Bank file format is a placeholder.** `generic_csv` in `reports.js` is not a confirmed bank spec. Get the
  bank's bulk-upload / SLIPS layout and add it to `BANK_FORMATS` before the first live upload.
- Managers are not paid through the bank file; their balance is a running account with the company.
- A weekly row belongs to the month its week-start (Monday) falls in.
- Download a backup from Settings after each month is finalized.
