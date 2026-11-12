// Postgres database layer: schema, audit triggers and period locks.
// Production uses Neon (or any Postgres) via DATABASE_URL; local dev and tests use PGlite (embedded Postgres).
// All money is stored as BIGINT cents (Rs 1.00 = 100) to avoid float drift.
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const DEFAULT_SETTINGS = {
  company_return_rate: "0.15",         // managers: company_return = total_business * rate
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
  manager_security_rate: "0.01",       // security pre-filled as this share of the week's business
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

-- Application users. Roles: admin > accountant > clerk > viewer. hub restricts a clerk to one hub.
CREATE TABLE IF NOT EXISTS users (
  username      text PRIMARY KEY,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','accountant','manager','clerk','viewer')),
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

-- Existing databases were created before the hub-manager role: widen the role check (the name is Postgres's default).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','accountant','manager','clerk','viewer','staff'));

-- Balance brought forward from the old spreadsheets. Only used until the person has a first calculated month.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS opening_balance bigint NOT NULL DEFAULT 0;

-- Chain of command: distributor/guy -> supervisor -> group manager -> manager. upline_id is who this person reports to.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS staff_level text NOT NULL DEFAULT 'distributor' CHECK (staff_level IN ('distributor','supervisor','group_manager','manager'));
ALTER TABLE staff ADD COLUMN IF NOT EXISTS upline_id text REFERENCES staff(employee_id);
UPDATE staff SET staff_level = 'manager' WHERE role = 'manager' AND staff_level = 'distributor';
-- A staff-portal login belongs to one employee (a distributor, supervisor or group manager) and only ever sees that person's own figures.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id text REFERENCES staff(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;
-- Promoting manager and coacher sit above the manager and draw a fixed monthly salary (staff.basic_pay), as a manager can.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_staff_level_check;
ALTER TABLE staff ADD CONSTRAINT staff_staff_level_check CHECK (staff_level IN ('distributor','supervisor','group_manager','manager','promoting_manager','coacher'));

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

-- ---- audit trail: every UPDATE / DELETE is logged with the app user (set per transaction) and old/new values.
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
  o jsonb := audit_snapshot(to_jsonb(OLD), excl);
  n jsonb;
BEGIN
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
};

function triggerSql() {
  let sql = "";
  for (const [table, { key, period, exclude }] of Object.entries(AUDITED)) {
    const args = exclude ? `'${key}', '${exclude.join(",")}'` : `'${key}'`;
    sql += `DROP TRIGGER IF EXISTS ${table}_audit ON ${table};
      CREATE TRIGGER ${table}_audit AFTER UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION audit_trigger(${args});\n`;
    if (period) {
      sql += `DROP TRIGGER IF EXISTS ${table}_lock ON ${table};
        CREATE TRIGGER ${table}_lock BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION period_lock_trigger('${period}');\n`;
    }
  }
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
      if (user) await bound.query("SELECT set_config('app.user', ?, true)", [String(user)]);
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

// Run fn in a transaction with the audit user set.
async function withUser(db, user, fn, opts = {}) {
  if (!user || !String(user).trim()) throw httpError(400, "A user name is required for changes");
  return db.tx(fn, { ...opts, user: String(user).trim() });
}

async function getSettings(db) {
  return Object.fromEntries((await db.all("SELECT key, value FROM settings")).map((r) => [r.key, r.value]));
}

module.exports = { open, withUser, getSettings, DEFAULT_SETTINGS, SCHEMA_VERSION, httpError };
