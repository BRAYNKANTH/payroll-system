# Trial: one manager's group, from fresh

A full month for one manager and seven people, using every feature. The numbers below were run end to end
and every net pay matches your Excel payslip rule, so you can compare what you see on screen.

## Start

```powershell
npm run trial
```

Open http://localhost:8091. The database is empty, so the first page asks you to create the admin.
To start over, stop the server and delete the folder `data\trial`.

## The group (Jaffna 01)

| ID | Name | Position | Reports to | Days in October | Business per day | Business for the month |
|---|---|---|---|---|---|---|
| M01 | Arun Selvam | Manager | — | weekly sheets | — | — |
| GM01 | Meena Rajan | Group manager | M01 | 27 | 8,000 | 216,000 |
| S01 | Kavin Thirumal | Supervisor | GM01 | 27 | 7,000 | 189,000 |
| S02 | Nila Sivakumar | Supervisor | GM01 | 27 | 4,200 | 113,400 |
| D01 | Pavan Kumar | Distributor | S01 | 27 | 4,600 | 124,200 |
| D02 | Thevi Ganesh | Distributor | S01 | 27 | 3,000 | 81,000 |
| D03 | Sharan Raj | Distributor | S02 | 12 | 3,300 | 39,600 |
| D04 | Anitha Jegan | Distributor | S02 | 6 | 1,500 | 9,000 |

Everyone hands in 92% of their business (the settle-up). D03 takes a Rs 15,000 advance on 1 October.

## Steps

| # | Sign in as | Do this | You should see |
|---|---|---|---|
| 1 | (first page) | Create the admin, for example `owner`. | You land on the dashboard. |
| 2 | admin | **Settings**: set the company name. In **Pay defaults by position** enter: Distributor tiered, target 100000, basic 25000, 30% over, 25% under, food 150, after 0 days, security % business 1. Supervisor: target 120000, basic 30000, food after 24 days. Group manager: target 150000, basic 35000, food after 24 days. Set Company return to 0. | "Settings saved". |
| 3 | admin | **Hubs**: add `J1` Jaffna 01 and `J2` Jaffna 02. | Two hubs. |
| 4 | admin | **Users & roles**: add `acct` (Accountant), `mgr1` (Hub manager, hub J1), `clerk1` (Clerk, hub J1), `viewer1` (Viewer). Try a hub manager without a hub. | The manager without a hub is refused. |
| 5 | admin | **Employees**: add `M01` Arun Selvam, position Manager, hub J1. Leave the starting balance empty. | The manager appears. |
| 6 | mgr1 | **Employees** > Add employee. Register the seven people above. Choose the position, then **Reports to**. The pay setup fills in from your defaults. | Only Jaffna 01 people are listed. The hub is fixed and the Manager position is not offered. |
| 7 | clerk1 | Pick **October 2026** in the top bar. **Daily sheet** > **Import CSV** > `docs/trial/daily-2026-10.csv`. | Preview of 153 rows, then Import. |
| 8 | mgr1 | **Weekly sheet**: for the four Mondays (5, 12, 19, 26 Oct) enter business 190,000, profit 20%, rent 4,000, hub fee 500, security 1,900, personal draw 8,000. | Four weeks saved. |
| 9 | clerk1 | **Stock count**, product Shine, price 850. D01: opening 40, issued 60, sold 85, counted 15. D02: same but counted 12. | D02 shows 3 missing, Rs 2,550. |
| 10 | acct | **Allowances**: S01, Transport, 3,000. | One allowance. |
| 11 | acct | **Payroll run** > Calculate. | The table below. |
| 12 | acct | **Approvals**: two rows are flagged, M01 (manager balance deeper negative) and D03 (deductions exceed gross). Open each, read the breakdown, approve with a note. | Nothing left to review. |
| 13 | acct, then admin | The accountant cannot finalize. Sign in as admin and **Finalize month**. | October is locked. |
| 14 | acct | **Payslips**, the register CSV, and the **bank file**. | Six payments, total Rs 144,276.00. |
| 15 | admin | **Dashboard**, **Reports**, **Audit trail**. Open D01's profile and check the change log. | The same figures. |
| 16 | clerk1, acct | Pick **November 2026**. Enter 5 days of business 5,000 and settle 4,600 for S01, D01 and D03. Calculate. | D03 opens with minus 6,864.00, carried from October. |

## Expected October results

| Person | Net pay | Notes |
|---|---|---|
| GM01 | 39,410.00 | Over target. Basic 35,000 + 30% of 66,000. Food 27 days. |
| S01 | 40,740.00 | Over target, 3,000 allowance, food paid (27 days is at least 24). |
| S02 | 22,194.00 | Under target. 25% of 113,400, food paid. |
| D01 | 25,132.00 | Over target. Basic 25,000 + 30% of 24,200. |
| D02 | 14,460.00 | Under target. Stock shortfall 2,550 taken off. |
| D03 | −6,864.00 | The advance makes it negative. It carries to November and is flagged. |
| D04 | 2,340.00 | 6 days only. |
| M01 | closing −43,012.00 | Profit 20% minus weekly costs, minus the guys' net salaries. Flagged. |

## Things to try to break

- As `viewer1`: you can look, but not add or change anything, and the bank file is refused.
- As `clerk1`: you cannot run payroll, approve, or enter data for Jaffna 02.
- As `mgr1`: you cannot see or add anyone in Jaffna 02, and you cannot add a manager.
- After finalizing October: try to change a daily entry. It is refused.
- Before approving: try to finalize. It is refused.
- Reject one entry in step 12, correct the daily sheet, and calculate again.
- Give a person a starting balance (Employees > Starting balance) before the first calculation. The first month opens with it. Later months use the previous closing.
