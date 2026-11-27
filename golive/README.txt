GO-LIVE: THE REAL HUBS AND PEOPLE
=================================

Two files in this folder describe your real business. Open them in Excel or Notepad and keep the first row as it is.

hubs.csv     one row per hub: code, name (location and phone are optional)
people.csv   one row per manager or promoting manager:
               employee_id   a short unique id (PM01, M04 ...)
               name
               position      manager   or   promoting manager
               team_of       the employee_id of the person whose team this person counts in for commission (empty = nobody, the owner)
               hub           the hub code this person works in (it must be a code from hubs.csv)
               coacher       yes for the ONE person who heads that hub, otherwise no
               basic_pay     monthly basic salary
               phone         optional

How the rules work
  - A coacher is a manager or promoting manager with the coacher tag. There is one per hub. Pay follows the position.
  - A promoting manager can be in another promoting manager's team (a ladder). A manager is in a promoting manager's team, or nobody's. A manager becomes a promoting manager when another manager comes under him, or one of his sellers builds a team: promote him first, then add the new manager under him.
  - Distributors and supervisors are NOT in this file. They are added later in the app, each under their manager or, if they are his own team, straight under a promoting manager.
  - A promoting manager is paid like a manager on his own team (weekly commission, own sales, rent and hub fee), plus 0.55% on the sales of each manager directly under him.
  - Roshan (the owner) is not in the file. People who are in nobody's team have an empty team_of.

WHAT THE TOOL ADDS ON ITS OWN (so the client can start straight away)
  - About 10 sellers under every manager and promoting manager: 2 supervisors and 8 distributors, in that manager's hub. They are placeholders
    named like 'Issany D1' and 'Issany S1'. The client renames, moves or removes them in the app.
      Distributor: target 100,000, basic 25,000.   Supervisor: target 120,000, basic 30,000, food only when more than 24 days are worked.
    Use  --sellers=0  for none, or  --sellers=6  for six each.
  - A login for every person (managers, promoting managers and sellers). The username starts with a random 4-digit number
    (for example 4821-issany or 7305-issany-d1) and the password for everyone is  demo1234.
    The list is written to golive/logins.csv after a successful load. It holds passwords: it is kept out of git, do not send it by chat or e-mail.
    The client should change the passwords, rename people and remove the placeholders on the Users and Employees pages.

STEP 1 - CHECK (changes nothing)
    npm run golive
  It reads both files, tries every hub, person and login against the system's rules, and tells you exactly what to fix.
  Keep running it until it says: The files are valid.

STEP 2 - BACKUP
  In the Neon dashboard make a backup (a branch or a snapshot) of your database. Do not skip this.

STEP 3 - LOAD (keeping the logins admin and navoj)
    npm run golive -- --apply --yes-i-have-a-backup --erase-demo --keep-users=admin,navoj

  --erase-demo clears: hubs, people, sales, stock sent and given, payroll, loans, cash handovers and every login except the ones named in --keep-users
  (without --keep-users every admin login stays).
  It KEEPS: those logins with their own passwords, Settings, the product catalogue with its office stock, and the audit trail.
  If a name in --keep-users does not exist the tool stops before changing anything.

STEP 4 - AFTER
  Sign in as admin, open Users and check the list. Hand the client golive/logins.csv privately and ask them to change the passwords.
