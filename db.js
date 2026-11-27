// Postgres database layer: schema, audit triggers and period locks.
// Production uses Neon (or any Postgres) via DATABASE_URL; local dev and tests use PGlite (embedded Postgres).
// All money is stored as BIGINT cents (Rs 1.00 = 100) to avoid float drift.
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("async_hooks");

const DEFAULT_SETTINGS = {
  company_return_rate: "0",            // no longer used: a manager returns no share to the company
  net_pay_change_threshold: "0.20",    // flag if net pay moves more than 20% vs previous period
  stock_shortfall_threshold: "500000", // cents -> Rs 5,000 per period
  bank_format: "generic_csv",
  closed_weekdays: "0",                // days hubs are closed (0 = Sunday), used for missing-entry checks
  session_hours: "12",
  company_account_no: "",
  company_name: "My Company",
  position_defaults: "{}",             // JSON: pay setup pre-filled when adding someone at each position (see service.updateSettings)
  // Managers' weekly sheet: commission is the high rate once the week's business reaches the threshold, else the low rate.
  manager_commission_threshold: "10000000", // cents -> Rs 100,000
  manager_commission_high: "0.20",
  manager_commission_low: "0.15",
  manager_rent_default: "400000",      // cents -> Rs 4,000 a week, pre-filled on the weekly sheet
  manager_hub_fee_default: "50000",    // cents -> Rs 500 a week
  manager_security_rate: "0",          // security taken from a manager as this share of the week's business (none by default)
  // A manager whose own + team sales for the month fall below the threshold is "retaining": basic salary + the retain rate on those sales.
  manager_retain_threshold: "25000000", // cents -> Rs 250,000 a month
  manager_retain_rate: "0.10",
  // Promoting managers and coachers: basic salary + this share of the sales of everyone below them (1% of the company's 55%).
  senior_commission_rate: "0.0055",
  // A manager also sells: the seller's commission on his own sales (the 20% team share is on top).
  manager_own_sales_rate: "0.25",
  // Of every sale the company pays workers at most 45%: this much to the seller and this much to his manager. Used for product profit.
  product_seller_share: "0.25",
  product_manager_share: "0.20",
};

// Timestamps are stored as ISO-8601 UTC text so they compare and serialise exactly like before.
const NOW = "now_iso()";
const DATE_CHECK = (col) => `CHECK (${col} ~ '^\\d{4}-\\d{2}-\\d{2}$')`;
const PERIOD_CHECK = (col) => `CHECK (${col} ~ '^\\d{4}-(0[1-9]|1[0-2])$')`;

const SCHEMA = `
CREATE OR REPLACE FUNCTION now_iso() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_key    text NOT NULL,
  action     text NOT NULL,
  changed_by text NOT NULL,
  changed_at text NOT NULL DEFAULT ${NOW},
  old_value  text,
  new_value  text
);
CREATE INDEX IF NOT EXISTS audit_log_row ON audit_log (table_name, row_key);
-- Where an action came from: the address and the browser. Filled in from the request (see requestContext) when the row is written.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip text DEFAULT nullif(current_setting('app.ip', true), '');
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS agent text DEFAULT nullif(current_setting('app.agent', true), '');
CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log (lower(changed_by), id DESC);
CREATE INDEX IF NOT EXISTS audit_log_area ON audit_log (table_name, id DESC);

CREATE TABLE IF NOT EXISTS hubs (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  location   text,
  phone      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW},
  updated_by text,
  updated_at text
);

-- Application users. Roles: admin, manager (hub manager, limited to one hub) and staff (portal).
CREATE TABLE IF NOT EXISTS users (
  username      text PRIMARY KEY,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','manager')),
  hub           text REFERENCES hubs(code),
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at text,
  created_by    text NOT NULL,
  created_at    text NOT NULL DEFAULT ${NOW},
  updated_by    text,
  updated_at    text
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  username   text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);

-- Failed sign-ins per username (kept in the database so the lockout works across server instances).
CREATE TABLE IF NOT EXISTS login_failures (
  username text PRIMARY KEY,
  count    integer NOT NULL,
  last_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  employee_id             text PRIMARY KEY,
  name                    text NOT NULL,
  role                    text NOT NULL CHECK (role IN ('guy','manager')),
  hub                     text NOT NULL REFERENCES hubs(code),
  phone                   text,
  nic                     text,
  join_date               text ${DATE_CHECK("join_date")},
  manager_id              text REFERENCES staff(employee_id),
  basic_pay               bigint NOT NULL DEFAULT 0,
  target                  bigint NOT NULL DEFAULT 0,
  commission_rate         double precision NOT NULL DEFAULT 0,
  security_deduction_rule text NOT NULL DEFAULT 'none',
  bank_name               text,
  bank_code               text,
  branch_code             text,
  bank_account_no         text,
  -- Account confirmed by a reviewer. Editing bank_account_no does not change this, so a mismatch
  -- triggers the fraud-check flag until another user approves the new account.
  bank_account_verified   text,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by              text NOT NULL,
  created_at              text NOT NULL DEFAULT ${NOW},
  updated_by              text,
  updated_at              text
);

-- Pay scheme columns (see engine.computeGuy). Added with ALTER so existing databases pick them up.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pay_scheme text NOT NULL DEFAULT 'over_target' CHECK (pay_scheme IN ('over_target','tiered'));
ALTER TABLE staff ADD COLUMN IF NOT EXISTS base_commission_rate double precision NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS food_per_day bigint NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS food_min_days integer NOT NULL DEFAULT 0;
-- No longer used: managers now earn by the weekly target rule and promoting managers by senior_commission_rate (settings). Kept so old databases still open.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS team_commission_rate double precision NOT NULL DEFAULT 0;

-- Existing databases were created before the hub-manager role: widen the role check (the name is Postgres's default).
-- The accountant, clerk and viewer roles no longer exist: their logins are removed (the admin does that work), then the check is narrowed.
DELETE FROM users WHERE role IN ('accountant','clerk','viewer');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
-- Roles: admin; coacher (the head of a hub: sees and handles the whole hub); manager (sees only the people under them); staff (own portal).
-- A hub-manager login made before this split saw a whole hub, so it becomes a coacher login. A manager login is always tied to a manager's own record.
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','coacher','manager','staff'));
-- A manager tagged as stock keeper can handle the stock of everyone in the hub, not only their own people.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS stock_keeper boolean NOT NULL DEFAULT false;
-- A coacher is a manager or promoting manager carrying the coacher tag: the head of one hub (one per hub). Their pay and place in the reporting
-- chart follow their position; the tag gives the hub-head screens. The old Coacher position is kept for old records and becomes the tag.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_coacher boolean NOT NULL DEFAULT false;

-- Balance brought forward from the old spreadsheets. Only used until the person has a first calculated month.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS opening_balance bigint NOT NULL DEFAULT 0;

-- Chain of command: distributor and supervisor (same level) -> manager -> promoting manager -> coacher. upline_id is who this person reports to.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS staff_level text NOT NULL DEFAULT 'distributor' CHECK (staff_level IN ('distributor','supervisor','group_manager','manager'));
ALTER TABLE staff ADD COLUMN IF NOT EXISTS upline_id text REFERENCES staff(employee_id);
-- People leave and rejoin: when they left and why (status becomes inactive). Cleared again when they are re-hired.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS leave_date text;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS leave_reason text;
UPDATE staff SET staff_level = 'manager' WHERE role = 'manager' AND staff_level = 'distributor';
-- A staff-portal login belongs to one employee (a distributor or supervisor) and only ever sees that person's own figures.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id text REFERENCES staff(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;
-- (see the role check above) a login made as a hub manager before the coacher/manager split saw a whole hub, so it becomes a coacher login.
UPDATE users SET role = 'coacher' WHERE role = 'manager' AND (employee_id IS NULL OR employee_id IN (SELECT employee_id FROM staff WHERE staff_level = 'coacher'));
-- The group manager position no longer exists. Anyone who was one becomes a supervisor (a seller), and the people who reported to a
-- group manager now report to that group manager's own upline. Safe to run again: it does nothing once no group managers are left.
UPDATE staff SET upline_id = (SELECT g.upline_id FROM staff g WHERE g.employee_id = staff.upline_id)
  WHERE upline_id IN (SELECT employee_id FROM staff WHERE staff_level = 'group_manager');
UPDATE staff SET staff_level = 'supervisor', role = 'guy' WHERE staff_level = 'group_manager';
-- Promoting manager and coacher sit above the manager and draw a fixed monthly salary (staff.basic_pay) plus a share of the sales below.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_staff_level_check;
ALTER TABLE staff ADD CONSTRAINT staff_staff_level_check CHECK (staff_level IN ('distributor','supervisor','manager','promoting_manager','coacher'));
-- The old Coacher position becomes the coacher tag (after the position column exists), and a hub has one active coacher.
UPDATE staff SET is_coacher = true WHERE staff_level = 'coacher' AND status = 'active' AND NOT is_coacher
  AND employee_id = (SELECT MIN(c.employee_id) FROM staff c WHERE c.hub = staff.hub AND c.staff_level = 'coacher' AND c.status = 'active');
CREATE UNIQUE INDEX IF NOT EXISTS staff_one_coacher_per_hub ON staff (hub) WHERE is_coacher AND status = 'active';

CREATE TABLE IF NOT EXISTS daily_log (
  id              bigserial PRIMARY KEY,
  date            text NOT NULL ${DATE_CHECK("date")},
  employee_id     text NOT NULL REFERENCES staff(employee_id),
  business_amount bigint NOT NULL,
  settled_amount  bigint NOT NULL,
  settle_up_minus bigint GENERATED ALWAYS AS (business_amount - settled_amount) STORED,
  personal_minus  bigint NOT NULL DEFAULT 0,
  notes           text,
  created_by      text NOT NULL,
  created_at      text NOT NULL DEFAULT ${NOW},
  updated_by      text,
  updated_at      text,
  UNIQUE (date, employee_id)
);
-- A day a seller entered themselves on the staff portal stays unconfirmed until the office confirms it (see sales.js).
ALTER TABLE daily_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'office' CHECK (source IN ('office','portal'));
ALTER TABLE daily_log ADD COLUMN IF NOT EXISTS confirmed_by text;
ALTER TABLE daily_log ADD COLUMN IF NOT EXISTS confirmed_at text;

CREATE TABLE IF NOT EXISTS weekly_log (
  id             bigserial PRIMARY KEY,
  week_start     text NOT NULL ${DATE_CHECK("week_start")},
  week_end       text NOT NULL CHECK (week_end >= week_start),
  manager_id     text NOT NULL REFERENCES staff(employee_id),
  business_total bigint NOT NULL,
  profit_percent double precision NOT NULL,
  rent           bigint NOT NULL DEFAULT 0,
  hub_fee        bigint NOT NULL DEFAULT 0,
  security_cost  bigint NOT NULL DEFAULT 0,
  personal_draw  bigint NOT NULL DEFAULT 0,
  created_by     text NOT NULL,
  created_at     text NOT NULL DEFAULT ${NOW},
  updated_by     text,
  updated_at     text,
  UNIQUE (week_start, manager_id)
);

CREATE TABLE IF NOT EXISTS stock_recon (
  id              bigserial PRIMARY KEY,
  period          text NOT NULL ${PERIOD_CHECK("period")},
  employee_id     text NOT NULL REFERENCES staff(employee_id),
  product         text NOT NULL,
  opening_stock   bigint NOT NULL,
  issued          bigint NOT NULL DEFAULT 0,
  sold            bigint NOT NULL DEFAULT 0,
  counted_stock   bigint NOT NULL,
  unit_price      bigint NOT NULL,
  shortfall_qty   bigint GENERATED ALWAYS AS (opening_stock + issued - sold - counted_stock) STORED,
  shortfall_value bigint GENERATED ALWAYS AS (GREATEST(0, opening_stock + issued - sold - counted_stock) * unit_price) STORED,
  created_by      text NOT NULL,
  created_at      text NOT NULL DEFAULT ${NOW},
  updated_by      text,
  updated_at      text,
  UNIQUE (period, employee_id, product)
);

-- Branch stock for the month: what the hub opened with, received, gave out and counted at the end.
CREATE TABLE IF NOT EXISTS hub_stock (
  id              bigserial PRIMARY KEY,
  period          text NOT NULL ${PERIOD_CHECK("period")},
  hub             text NOT NULL REFERENCES hubs(code),
  product         text NOT NULL,
  opening_stock   bigint NOT NULL,
  received        bigint NOT NULL DEFAULT 0,
  issued          bigint NOT NULL DEFAULT 0,
  counted_stock   bigint NOT NULL,
  unit_price      bigint NOT NULL,
  shortfall_qty   bigint GENERATED ALWAYS AS (opening_stock + received - issued - counted_stock) STORED,
  shortfall_value bigint GENERATED ALWAYS AS (GREATEST(0, opening_stock + received - issued - counted_stock) * unit_price) STORED,
  stock_value     bigint GENERATED ALWAYS AS (counted_stock * unit_price) STORED,
  created_by      text NOT NULL,
  created_at      text NOT NULL DEFAULT ${NOW},
  updated_by      text,
  updated_at      text,
  UNIQUE (period, hub, product)
);

-- Scans kept with an employee's record (NIC, bank book front page, O/L results). data is base64.
CREATE TABLE IF NOT EXISTS staff_documents (
  id          bigserial PRIMARY KEY,
  employee_id text NOT NULL REFERENCES staff(employee_id),
  doc_type    text NOT NULL CHECK (doc_type IN ('nic','bank_book','ol_results','other')),
  file_name   text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  data        text NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS staff_documents_emp ON staff_documents (employee_id);

CREATE TABLE IF NOT EXISTS allowances (
  id          bigserial PRIMARY KEY,
  period      text NOT NULL ${PERIOD_CHECK("period")},
  employee_id text NOT NULL REFERENCES staff(employee_id),
  description text NOT NULL,
  amount      bigint NOT NULL,
  created_by  text NOT NULL,
  created_at  text NOT NULL DEFAULT ${NOW},
  updated_by  text,
  updated_at  text
);

-- Advances and loans given to a guy / supervisor. An advance is a loan paid back in one go.
-- amount is what was handed over; already_repaid is anything paid back before the system took over (an old Excel loan).
-- loan_repayments is written only by the payroll run: one row per loan per month, and it locks when the month is finalized.
-- What the company sells. cost_price is the purchase price; list_price is the selling price. Money in cents.
CREATE TABLE IF NOT EXISTS products (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  list_price bigint NOT NULL CHECK (list_price > 0),
  cost_price bigint NOT NULL CHECK (cost_price >= 0),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW},
  updated_by text,
  updated_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS products_name_lower ON products (lower(name));

-- Stock the hub gives a seller (usually each morning): one row per product given. A seller's stock is everything given minus everything sold.
CREATE TABLE IF NOT EXISTS stock_issues (
  id          bigserial PRIMARY KEY,
  date        text NOT NULL ${DATE_CHECK("date")},
  employee_id text NOT NULL REFERENCES staff(employee_id),
  product_id  bigint NOT NULL REFERENCES products(id),
  qty         integer NOT NULL CHECK (qty > 0),
  note        text,
  created_by  text NOT NULL,
  created_at  text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS stock_issues_emp ON stock_issues (employee_id, date);

-- Stock the office (the admin) sends to a hub. What a hub holds is everything sent to it minus everything its coacher has given to sellers.
CREATE TABLE IF NOT EXISTS hub_issues (
  id         bigserial PRIMARY KEY,
  date       text NOT NULL ${DATE_CHECK("date")},
  hub        text NOT NULL REFERENCES hubs(code),
  product_id bigint NOT NULL REFERENCES products(id),
  qty        integer NOT NULL CHECK (qty > 0),
  note       text,
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS hub_issues_hub ON hub_issues (hub, date);

-- The cash a hub's coacher hands to the office for a day: at least 90% of the day's sales. The admin checks it and approves it (or sends it back).
CREATE TABLE IF NOT EXISTS cash_handovers (
  id           bigserial PRIMARY KEY,
  hub          text NOT NULL REFERENCES hubs(code),
  date         text NOT NULL ${DATE_CHECK("date")},
  sales        bigint NOT NULL CHECK (sales >= 0),   -- the hub's sales for the day when the handover was made
  amount       bigint NOT NULL CHECK (amount > 0),
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by text NOT NULL,
  submitted_at text NOT NULL DEFAULT ${NOW},
  verified_by  text,
  verified_at  text,
  verify_note  text,
  UNIQUE (hub, date)
);
CREATE INDEX IF NOT EXISTS cash_handovers_status ON cash_handovers (status, date);

-- The hub's cash book: what its coacher spent, paid out or received besides the sellers' cash (which comes from the daily sheets).
-- 'expense' and 'salary' take cash out; 'other_in' puts cash in; 'online' is money that reached the company by bank or card (not cash in hand).
CREATE TABLE IF NOT EXISTS cash_book_entries (
  id         bigserial PRIMARY KEY,
  hub        text NOT NULL REFERENCES hubs(code),
  date       text NOT NULL ${DATE_CHECK("date")},
  kind       text NOT NULL CHECK (kind IN ('expense','salary','other_in','online')),
  category   text,
  amount     bigint NOT NULL CHECK (amount > 0),
  note       text,
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS cash_book_hub_date ON cash_book_entries (hub, date);
-- 'draw' is cash a manager took from the hub's cash (salary or personal use): it is deducted from that manager's pay for the week it was taken.
ALTER TABLE cash_book_entries ADD COLUMN IF NOT EXISTS employee_id text REFERENCES staff(employee_id);
ALTER TABLE cash_book_entries DROP CONSTRAINT IF EXISTS cash_book_entries_kind_check;
ALTER TABLE cash_book_entries ADD CONSTRAINT cash_book_entries_kind_check CHECK (kind IN ('expense','salary','other_in','online','draw'));

-- What was actually paid to a person for a month's salary (the sheets' "paid / pending", cheques and part payments).
-- A month's salary is the pay period summary's disbursed amount; payments add up against it. Payments are recorded after the month is calculated
-- and also after it is closed, so this table is not locked with the month.
CREATE TABLE IF NOT EXISTS salary_payments (
  id          bigserial PRIMARY KEY,
  period      text NOT NULL,
  employee_id text NOT NULL REFERENCES staff(employee_id),
  amount      bigint NOT NULL CHECK (amount > 0),
  method      text NOT NULL CHECK (method IN ('cash','cheque','bank','other')),
  paid_on     text NOT NULL ${DATE_CHECK("paid_on")},
  note        text,
  created_by  text NOT NULL,
  created_at  text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS salary_payments_period ON salary_payments (period, employee_id);

-- The weekly stock sheet: the pieces the coacher counted for a product at the end of a week (the week starts on a Monday).
CREATE TABLE IF NOT EXISTS hub_week_counts (
  id         bigserial PRIMARY KEY,
  hub        text NOT NULL REFERENCES hubs(code),
  week_start text NOT NULL ${DATE_CHECK("week_start")},
  product_id bigint NOT NULL REFERENCES products(id),
  counted    integer NOT NULL CHECK (counted >= 0),
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW},
  updated_by text,
  updated_at text,
  UNIQUE (hub, week_start, product_id)
);

-- Supervisors get the food allowance only when more than 24 days are worked (it was 21): move existing supervisors and the saved position defaults.
UPDATE staff SET food_min_days = 25 WHERE staff_level = 'supervisor' AND food_min_days = 21;
UPDATE settings SET value = replace(value, '"food_min_days":21', '"food_min_days":25') WHERE key = 'position_defaults';

-- Stock the company receives (bought or made). The office holds everything received minus everything it sent to hubs.
CREATE TABLE IF NOT EXISTS product_receipts (
  id         bigserial PRIMARY KEY,
  date       text NOT NULL ${DATE_CHECK("date")},
  product_id bigint NOT NULL REFERENCES products(id),
  qty        integer NOT NULL CHECK (qty > 0),
  note       text,
  created_by text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS product_receipts_product ON product_receipts (product_id, date);

-- One row per sale a seller records on their phone: a product, a quantity and the list price at that moment. A day's business total is the sum of these.
CREATE TABLE IF NOT EXISTS sale_lines (
  id          bigserial PRIMARY KEY,
  date        text NOT NULL ${DATE_CHECK("date")},
  employee_id text NOT NULL REFERENCES staff(employee_id),
  product_id  bigint NOT NULL REFERENCES products(id),
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  bigint NOT NULL CHECK (unit_price > 0),
  amount      bigint NOT NULL CHECK (amount > 0),
  created_by  text NOT NULL,
  created_at  text NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS sale_lines_emp ON sale_lines (employee_id, date);

CREATE TABLE IF NOT EXISTS loans (
  id             bigserial PRIMARY KEY,
  employee_id    text NOT NULL REFERENCES staff(employee_id),
  kind           text NOT NULL CHECK (kind IN ('advance','loan')),
  amount         bigint NOT NULL CHECK (amount > 0),
  instalment     bigint NOT NULL CHECK (instalment > 0),
  start_period   text NOT NULL ${PERIOD_CHECK("start_period")},
  issued_on      text NOT NULL ${DATE_CHECK("issued_on")},
  already_repaid bigint NOT NULL DEFAULT 0 CHECK (already_repaid >= 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
  note           text,
  created_by     text NOT NULL,
  created_at     text NOT NULL DEFAULT ${NOW},
  updated_by     text,
  updated_at     text
);
CREATE INDEX IF NOT EXISTS loans_emp ON loans (employee_id);

CREATE TABLE IF NOT EXISTS loan_repayments (
  loan_id     bigint NOT NULL REFERENCES loans(id),
  employee_id text NOT NULL,
  period      text NOT NULL,
  amount      bigint NOT NULL,
  PRIMARY KEY (loan_id, period)
);
CREATE INDEX IF NOT EXISTS loan_repayments_period ON loan_repayments (period);

CREATE TABLE IF NOT EXISTS periods (
  period       text PRIMARY KEY,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized')),
  last_run_by  text,
  last_run_at  text,
  finalized_by text,
  finalized_at text
);

-- Written only by the calculation engine (service.runPeriod). No API route accepts these values.
CREATE TABLE IF NOT EXISTS pay_period_summary (
  employee_id      text NOT NULL REFERENCES staff(employee_id),
  period           text NOT NULL,
  role             text NOT NULL,
  opening_balance  bigint NOT NULL,
  gross_earnings   bigint NOT NULL,
  total_deductions bigint NOT NULL,
  net_pay          bigint NOT NULL,
  disbursed_amount bigint NOT NULL,
  closing_balance  bigint NOT NULL,
  detail           text NOT NULL,
  flags            text NOT NULL,
  result_hash      text NOT NULL,
  status           text NOT NULL CHECK (status IN ('auto_approved','pending_review','approved','rejected')),
  bank_name        text,
  bank_code        text,
  branch_code      text,
  bank_account_no  text,
  computed_at      text NOT NULL,
  reviewed_by      text,
  reviewed_at      text,
  review_note      text,
  PRIMARY KEY (employee_id, period)
);

-- Security held so far is summed on every payroll run, so it is kept as a plain column instead of being dug out of the JSON each time.
-- Finalized rows are locked, so the one-time fill-in switches the user triggers off while it runs; they are re-created below.
ALTER TABLE pay_period_summary ADD COLUMN IF NOT EXISTS security_held bigint;
ALTER TABLE pay_period_summary DISABLE TRIGGER USER;
UPDATE pay_period_summary SET security_held = COALESCE((detail::jsonb->>'security_deducted')::numeric, 0) WHERE security_held IS NULL;
ALTER TABLE pay_period_summary ENABLE TRIGGER USER;

-- Indexes for the lookups the pages make most.
CREATE INDEX IF NOT EXISTS daily_emp_date ON daily_log (employee_id, date);
CREATE INDEX IF NOT EXISTS staff_hub ON staff (hub);
CREATE INDEX IF NOT EXISTS staff_upline ON staff (upline_id);
CREATE INDEX IF NOT EXISTS pps_period ON pay_period_summary (period);
CREATE INDEX IF NOT EXISTS weekly_mgr_week ON weekly_log (manager_id, week_start);

-- ---- audit trail: every INSERT / UPDATE / DELETE is logged with the app user (set per transaction) and the values.
-- A password hash is reduced to a short fingerprint so the log shows that it changed without storing it.
CREATE OR REPLACE FUNCTION audit_snapshot(r jsonb, excl text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF r ? 'password_hash' THEN r := r || jsonb_build_object('password', right(r->>'password_hash', 6)); END IF;
  RETURN r - excl;
END $$;

CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keycol text := TG_ARGV[0];
  excl text[] := CASE WHEN TG_NARGS > 1 THEN string_to_array(TG_ARGV[1], ',') ELSE '{}'::text[] END;
  who text := coalesce(nullif(current_setting('app.user', true), ''), 'direct-db-edit');
  o jsonb;
  n jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value, new_value)
    VALUES (TG_TABLE_NAME, to_jsonb(NEW)->>keycol, 'create', who, NULL, audit_snapshot(to_jsonb(NEW), excl)::text);
    RETURN NEW;
  END IF;
  o := audit_snapshot(to_jsonb(OLD), excl);
  IF TG_OP = 'UPDATE' THEN
    n := audit_snapshot(to_jsonb(NEW), excl);
    IF o IS DISTINCT FROM n THEN
      INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value, new_value)
      VALUES (TG_TABLE_NAME, to_jsonb(OLD)->>keycol, 'update', who, o::text, n::text);
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value, new_value)
  VALUES (TG_TABLE_NAME, to_jsonb(OLD)->>keycol, 'delete', who, o::text, NULL);
  RETURN OLD;
END $$;

-- ---- the audit trail itself can never be changed or deleted, by the app or by anyone with a database tool.
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'The audit trail cannot be changed or deleted';
END $$;

-- ---- period locks: entries of a finalized month cannot be inserted, changed or deleted.
CREATE OR REPLACE FUNCTION period_lock_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text := TG_ARGV[0];
  p_old text;
  p_new text;
BEGIN
  IF TG_OP <> 'INSERT' THEN p_old := left(to_jsonb(OLD)->>col, 7); END IF;
  IF TG_OP <> 'DELETE' THEN p_new := left(to_jsonb(NEW)->>col, 7); END IF;
  IF EXISTS (SELECT 1 FROM periods WHERE status = 'finalized' AND period IN (p_old, p_new)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = CASE WHEN TG_TABLE_NAME = 'pay_period_summary' THEN 'Pay period is finalized; summary is locked'
                     ELSE 'Pay period is finalized; entries are locked' END;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
`;

// Tables whose edits are audited, with the column that gives each row's pay period (null = not locked).
const AUDITED = {
  hubs:        { key: "code", period: null },
  users:       { key: "username", period: null, exclude: ["password_hash", "last_login_at"] },
  staff:       { key: "employee_id", period: null },
  daily_log:   { key: "id", period: "date" },
  weekly_log:  { key: "id", period: "week_start" },
  stock_recon: { key: "id", period: "period" },
  hub_stock:   { key: "id", period: "period" },
  allowances:  { key: "id", period: "period" },
  loans:       { key: "id", period: null },
  products:    { key: "id", period: null },
  stock_issues: { key: "id", period: "date" },
  hub_issues:  { key: "id", period: "date" },
  cash_handovers: { key: "id", period: null },
  cash_book_entries: { key: "id", period: "date" },
  salary_payments: { key: "id", period: null },
  hub_week_counts: { key: "id", period: "week_start" },
  product_receipts: { key: "id", period: "date" },
  sale_lines:  { key: "id", period: "date" },
};

function triggerSql() {
  let sql = "";
  for (const [table, { key, period, exclude }] of Object.entries(AUDITED)) {
    const args = exclude ? `'${key}', '${exclude.join(",")}'` : `'${key}'`;
    sql += `DROP TRIGGER IF EXISTS ${table}_audit ON ${table};
      CREATE TRIGGER ${table}_audit AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION audit_trigger(${args});\n`;
    if (period) {
      sql += `DROP TRIGGER IF EXISTS ${table}_lock ON ${table};
        CREATE TRIGGER ${table}_lock BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION period_lock_trigger('${period}');\n`;
    }
  }
  sql += `DROP TRIGGER IF EXISTS audit_log_guard ON audit_log;
    CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();\n`;
  // Repayments are derived by the payroll run; once a month is final they are what the loan balance is made of.
  sql += `DROP TRIGGER IF EXISTS loan_repayments_lock ON loan_repayments;
    CREATE TRIGGER loan_repayments_lock BEFORE INSERT OR UPDATE OR DELETE ON loan_repayments FOR EACH ROW EXECUTE FUNCTION period_lock_trigger('period');\n`;
  // A finalized summary is the source of next period's opening balance, so it must never change.
  sql += `DROP TRIGGER IF EXISTS summary_lock ON pay_period_summary;
    CREATE TRIGGER summary_lock BEFORE UPDATE OR DELETE ON pay_period_summary FOR EACH ROW EXECUTE FUNCTION period_lock_trigger('period');\n`;
  return sql;
}

const FULL_SCHEMA = SCHEMA + triggerSql();
const SCHEMA_VERSION = crypto.createHash("sha256").update(FULL_SCHEMA).digest("hex").slice(0, 16);

// `?` placeholders → `$1, $2 …` so queries read the same as before. (No query uses a literal `?`.)
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Thin async wrapper with the same feel as the old synchronous API.
class Database {
  constructor(driver, client = null) {
    this.driver = driver;   // { query(text, params), transaction(fn) , close() }
    this.client = client;   // set when bound to a transaction
  }
  async query(sql, params = []) {
    const target = this.client || this.driver;
    const res = await target.query(toPg(sql), params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.affectedRows ?? 0 };
  }
  async all(sql, ...params) { return (await this.query(sql, params)).rows; }
  async get(sql, ...params) { return (await this.query(sql, params)).rows[0]; }
  async run(sql, ...params) { return this.query(sql, params); }
  async exec(sql) { return this.client ? this.client.exec(sql) : this.driver.exec(sql); }

  // Run fn inside a transaction. Already inside one → just run it (no nesting).
  async tx(fn, { user = null, lockKey = null } = {}) {
    if (this.client) return fn(this);
    return this.driver.transaction(async (client) => {
      const bound = new Database(this.driver, client);
      if (user) {
        const ctx = requestContext.getStore() || {};
        await bound.query("SELECT set_config('app.user', ?, true), set_config('app.ip', ?, true), set_config('app.agent', ?, true)", [String(user), ctx.ip || "", ctx.agent || ""]);
      }
      if (lockKey) await bound.query("SELECT pg_advisory_xact_lock(hashtext(?))", [lockKey]);
      return fn(bound);
    });
  }
  close() { return this.driver.close?.(); }
}

// ---- drivers
function pgDriver(url) {
  // Neon: use its driver, which speaks Postgres over a WebSocket on port 443. Some networks reset
  // direct Postgres connections on port 5432; HTTPS-port traffic gets through, and it suits serverless.
  const neon = /\.neon\.tech/.test(url) && process.env.PG_DRIVER !== "tcp";
  const pg = neon ? require("@neondatabase/serverless") : require("pg");
  if (neon) pg.neonConfig.webSocketConstructor = globalThis.WebSocket;
  pg.types.setTypeParser(20, (v) => Number(v));   // int8 / bigint
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM of bigint)
  const pool = new pg.Pool(neon ? { connectionString: url, max: Number(process.env.PG_POOL_MAX || 5) } : {
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 5),
    ssl: /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
  });
  return {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (t, p) => client.query(t, p), exec: (t) => client.query(t) });
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir) {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const parsers = { 20: (v) => Number(v), 1700: (v) => Number(v) };
  const db = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await db.waitReady;
  // PGlite runs one query at a time; serialise transactions so concurrent requests don't interleave.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    query: (text, params) => serial(() => db.query(text, params)),
    exec: (text) => serial(() => db.exec(text)),
    transaction: (fn) => serial(() => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p), exec: (t) => tx.exec(t) }))),
    close: () => db.close(),
  };
}

async function migrate(db) {
  // Concurrent cold starts (serverless) all try to migrate; the advisory lock makes them take turns.
  await db.tx(async (t) => {
    await t.query("SELECT pg_advisory_xact_lock(727274)");
    const has = await t.get("SELECT to_regclass('public.schema_meta') AS t");
    if (has.t) {
      const v = await t.get("SELECT value FROM schema_meta WHERE key = 'version'");
      if (v?.value === SCHEMA_VERSION) return;
    }
    await t.exec(FULL_SCHEMA);
    // A database that sent stock to hubs before the office's own stock was tracked gets one opening line per product, so the office does not start below zero.
    await t.query("SAVEPOINT opening_stock");
    try {
      await t.query(`INSERT INTO product_receipts (date, product_id, qty, note, created_by)
        SELECT to_char(now() AT TIME ZONE 'Asia/Colombo', 'YYYY-MM-DD'), product_id, SUM(qty), 'Opening balance: stock sent to hubs before office stock was tracked', 'system'
        FROM hub_issues WHERE NOT EXISTS (SELECT 1 FROM product_receipts) GROUP BY product_id`);
    } catch { await t.query("ROLLBACK TO SAVEPOINT opening_stock"); }
    await t.query("INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [SCHEMA_VERSION]);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await t.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [k, v]);
    }
  });
}

// open(): DATABASE_URL → Postgres (Neon); ":memory:" → in-memory PGlite (tests); otherwise a PGlite data folder.
async function open(target = process.env.DATABASE_URL || path.join(__dirname, "data", "pglite")) {
  const isUrl = /^postgres(ql)?:\/\//.test(target);
  const driver = isUrl ? pgDriver(target) : await pgliteDriver(target === ":memory:" ? null : target);
  const db = new Database(driver);
  await migrate(db);
  return db;
}

// The address and browser of the request being served, so every audit row can say where it came from.
// The server runs each request inside requestContext.run({ ip, agent }, ...).
const requestContext = new AsyncLocalStorage();

// Writes one event to the audit trail on its own (a sign-in, a download, a view). dedupeMinutes > 0 skips it when the same person
// already has the same event for the same record within that many minutes, so opening a page twice is one line, not two.
async function logEvent(db, { user, table, key, action, detail = null, dedupeMinutes = 0 }) {
  const ctx = requestContext.getStore() || {};
  const who = String(user || "unknown").slice(0, 120) || "unknown";
  await db.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by, new_value, ip, agent)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE ?::int > 0 AND table_name = ? AND row_key = ? AND action = ? AND lower(changed_by) = lower(?)
      AND changed_at >= to_char((now() - make_interval(mins => ?::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    table, String(key ?? "").slice(0, 200), action, who, detail ? JSON.stringify(detail) : null, ctx.ip || null, ctx.agent || null,
    dedupeMinutes, table, String(key ?? "").slice(0, 200), action, who, dedupeMinutes);
}

// Run fn in a transaction with the audit user set.
async function withUser(db, user, fn, opts = {}) {
  if (!user || !String(user).trim()) throw httpError(400, "A user name is required for changes");
  return db.tx(fn, { ...opts, user: String(user).trim() });
}

async function getSettings(db) {
  return Object.fromEntries((await db.all("SELECT key, value FROM settings")).map((r) => [r.key, r.value]));
}

module.exports = { open, withUser, logEvent, requestContext, getSettings, DEFAULT_SETTINGS, SCHEMA_VERSION, httpError };
