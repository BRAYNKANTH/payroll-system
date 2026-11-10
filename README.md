# Payroll

Payroll and hub accounts for a multi-branch retail business with two kinds of staff: guys/supervisors
(paid monthly with commission) and managers (running weekly profit-share account). Every figure in a pay
period is calculated from the daily, weekly, stock and allowance sheets. Nobody types a final salary.

Runs on Postgres: **Neon** in production, and PGlite (embedded Postgres, no install) on your own computer.
Needs Node 22+.

```
npm install
npm run demo        # local demo: data/demo with 3 hubs and 5 months of data, then serve it
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

**Demo sign-ins** (demo database only): `admin / admin123`, `accounts / accounts123`,
`manager1`, `manager2`, `manager3` (all `manager123`, each limited to one Jaffna branch), `clerk / clerk123`
(Jaffna 01 only), `viewer / viewer123`. The demo has three branches, each with a manager, a group manager,
supervisors and distributors, four finalized months and the current month open.

## What's in it

| Area | |
|---|---|
| Dashboard | KPIs, 6-month trend, business by hub, exceptions, top performers, missing daily sheets |
| Daily sheet | Spreadsheet grid, by day (all guys) or by employee (whole month); CSV import/export |
| Weekly sheet | One row per manager per week, live weekly balance, month overview |
| Stock count | Per guy per product, live shortfall, carry over last month's count as opening stock |
| Branch stock | Per branch per product: opening, received, given out, counted; difference and stock value; open a month from last month's count |
| Allowances | Extra earnings per month |
| Payroll run | Step-by-step: data check → calculate → review → finalize → pay; full breakdown per person |
| Approvals | Queue of flagged entries only; approve / reject with notes |
| Payslips | Per person or all, printable |
| Employees | Directory, add/edit, profile with pay history chart, team, change log |
| Hubs | Branches with live figures |
| Reports | Hub summary, commission, stock shortfall, branch stock, balances, month history (CSV export) |
| Audit trail | Every change after first entry: who, when, old → new; filters and export |
| Users & roles | Admin, accountant, hub manager (one hub; registers their own team), clerk (optionally one hub), viewer |
| Settings | Company, rule thresholds, closed days, session length |

## Roles

| Role | Can |
|---|---|
| Viewer | See everything, change nothing |
| Clerk | Enter daily / weekly / stock / allowance sheets (limited to one hub if set) |
| Accountant | + manage staff and hubs, calculate payroll, approve / reject, export files |
| Admin | + finalize months, manage users, change settings |

## Monthly workflow

1. Clerks fill in the daily and weekly sheets, stock counts and allowances.
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
| Manager weekly | `business × profit% − rent − hub_fee − security_cost − personal_draw` |
| Manager closing | `opening + Σ weekly − business × 15% − Σ net pay of their guys` |
| Stock shortfall | `max(0, opening + issued − sold − counted) × unit_price` |
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
