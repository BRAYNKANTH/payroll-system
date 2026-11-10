// Orchestration: loads source rows, runs the engine, stores summaries, handles approval workflow.
const crypto = require("crypto");
const { withUser, getSettings, httpError } = require("./db");
const engine = require("./engine");

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW = "now_iso()";

function assertPeriod(period) {
  if (!PERIOD_RE.test(period || "")) throw httpError(400, `Invalid period "${period}" (expected YYYY-MM)`);
}
async function isFinalized(db, period) {
  return (await db.get("SELECT status FROM periods WHERE period = ?", period))?.status === "finalized";
}

// ---------------------------------------------------------------- data entry

// Field types: text, money (Rs in, cents stored), rate (fraction 0..1), int, date, period, enum
const ENTITIES = {
  hubs: {
    table: "hubs", key: "code", keyType: "text",
    fields: {
      code: { type: "text", required: true, createOnly: true, check: (v) => { if (!/^[A-Za-z0-9-]{2,12}$/.test(v)) throw new Error("Hub code must be 2–12 letters/numbers"); } },
      name: { type: "text", required: true },
      location: { type: "text" },
      phone: { type: "text" },
      status: { type: "enum", values: ["active", "inactive"] },
    },
  },
  staff: {
    table: "staff", key: "employee_id", keyType: "text",
    fields: {
      employee_id: { type: "text", required: true, createOnly: true, check: (v) => { if (!/^[A-Za-z0-9._-]{1,20}$/.test(v)) throw new Error("Employee ID must be 1–20 letters/numbers"); } },
      name: { type: "text", required: true },
      role: { type: "enum", values: ["guy", "manager"] }, // derived from staff_level when that is given
      hub: { type: "text", required: true },
      phone: { type: "text" },
      nic: { type: "text" },
      join_date: { type: "date" },
      staff_level: { type: "enum", values: ["distributor", "supervisor", "group_manager", "manager", "promoting_manager", "coacher"] },
      opening_balance: { type: "money" }, // balance brought forward when payroll starts; negative = money owed
      upline_id: { type: "text" },
      manager_id: { type: "text" },
      basic_pay: { type: "money" },
      target: { type: "money" },
      commission_rate: { type: "rate" },
      pay_scheme: { type: "enum", values: ["over_target", "tiered"] },
      base_commission_rate: { type: "rate" },
      food_per_day: { type: "money" },
      food_min_days: { type: "int" },
      security_deduction_rule: { type: "text", check: (v) => engine.parseSecurityRule(v) },
      bank_name: { type: "text" },
      bank_code: { type: "text" },
      branch_code: { type: "text" },
      bank_account_no: { type: "text", check: (v) => { if (v && !/^\d{4,20}$/.test(v)) throw new Error("bank_account_no must be 4–20 digits"); } },
      status: { type: "enum", values: ["active", "inactive"] },
    },
  },
  daily: {
    table: "daily_log", key: "id", periodCol: "left(date, 7)",
    fields: {
      date: { type: "date", required: true },
      employee_id: { type: "text", required: true },
      business_amount: { type: "money", required: true },
      settled_amount: { type: "money", required: true },
      personal_minus: { type: "money" },
      notes: { type: "text" },
    },
  },
  weekly: {
    table: "weekly_log", key: "id", periodCol: "left(week_start, 7)",
    fields: {
      week_start: { type: "date", required: true },
      week_end: { type: "date", required: true },
      manager_id: { type: "text", required: true },
      business_total: { type: "money", required: true },
      profit_percent: { type: "rate" }, // left blank on a new row → the commission rule in Settings decides
      rent: { type: "money" },
      hub_fee: { type: "money" },
      security_cost: { type: "money" },
      personal_draw: { type: "money" },
    },
  },
  stock: {
    table: "stock_recon", key: "id", periodCol: "period",
    fields: {
      period: { type: "period", required: true },
      employee_id: { type: "text", required: true },
      product: { type: "text", required: true },
      opening_stock: { type: "int", required: true },
      issued: { type: "int" },
      sold: { type: "int" },
      counted_stock: { type: "int", required: true },
      unit_price: { type: "money", required: true },
    },
  },
  hubstock: {
    table: "hub_stock", key: "id", periodCol: "period", byHub: true,
    fields: {
      period: { type: "period", required: true },
      hub: { type: "text", required: true },
      product: { type: "text", required: true },
      opening_stock: { type: "int", required: true },
      received: { type: "int" },
      issued: { type: "int" },
      counted_stock: { type: "int", required: true },
      unit_price: { type: "money", required: true },
    },
  },
  allowances: {
    table: "allowances", key: "id", periodCol: "period",
    fields: {
      period: { type: "period", required: true },
      employee_id: { type: "text", required: true },
      description: { type: "text", required: true },
      amount: { type: "money", required: true },
    },
  },
};

function coerce(name, spec, raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") {
    if (spec.required) throw httpError(400, `${name} is required`);
    return spec.type === "text" ? null : ["rate", "money", "int"].includes(spec.type) ? 0 : null;
  }
  switch (spec.type) {
    case "money": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
      return Math.round(n * 100);
    }
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw httpError(400, `${name} must be a whole number`);
      return n;
    }
    case "rate": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw httpError(400, `${name} must be a fraction between 0 and 1`);
      return n;
    }
    case "date":
      if (!DATE_RE.test(raw) || isNaN(Date.parse(raw))) throw httpError(400, `${name} must be YYYY-MM-DD`);
      return raw;
    case "period":
      assertPeriod(raw);
      return raw;
    case "enum":
      if (!spec.values.includes(raw)) throw httpError(400, `${name} must be one of ${spec.values.join(", ")}`);
      return raw;
    default: {
      const s = String(raw).trim();
      try { spec.check?.(s); } catch (e) { throw httpError(400, e.message); }
      return s;
    }
  }
}

function clean(entity, body, { creating }) {
  const out = {};
  for (const [name, spec] of Object.entries(entity.fields)) {
    if (!creating && spec.createOnly) continue;
    const v = coerce(name, spec, body[name]);
    if (v === undefined) {
      if (creating && spec.required) throw httpError(400, `${name} is required`);
      continue;
    }
    out[name] = v;
  }
  return out;
}

const empCol = (kind) => (kind === "weekly" ? "manager_id" : "employee_id");

async function listEntries(db, kind, { period, employee_id, hub, from, to } = {}) {
  const e = ENTITIES[kind];
  if (!e) throw httpError(404, `Unknown entity ${kind}`);
  const where = [];
  const args = [];
  if (period && e.periodCol) { assertPeriod(period); where.push(`${e.periodCol} = ?`); args.push(period); }
  if (from && e.fields.date) { where.push("date >= ?"); args.push(from); }
  if (to && e.fields.date) { where.push("date <= ?"); args.push(to); }
  if (employee_id && kind !== "staff" && kind !== "hubs" && !e.byHub) { where.push(`${empCol(kind)} = ?`); args.push(employee_id); }
  if (hub) {
    if (kind === "staff" || e.byHub) where.push("hub = ?");
    else if (kind === "hubs") where.push("code = ?");
    else where.push(`${empCol(kind)} IN (SELECT employee_id FROM staff WHERE hub = ?)`);
    args.push(hub);
  }
  const order = kind === "hubs" ? "code" : e.byHub ? "hub, product" : kind === "staff" ? "role DESC, hub, employee_id" : e.fields.date ? "date, employee_id"
    : e.fields.week_start ? "week_start, manager_id" : "employee_id, id";
  return db.all(`SELECT * FROM ${e.table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order}`, ...args);
}

// A hub-scoped user (e.g. a branch clerk) may only touch entries for staff of their own hub.
async function assertScope(db, kind, row, scopeHub) {
  if (!scopeHub) return;
  if (kind === "hubs") throw httpError(403, "Hub-restricted users cannot change master data");
  if (ENTITIES[kind].byHub) {
    if (row.hub !== scopeHub) throw httpError(403, `You can only enter data for hub ${scopeHub}`);
    return;
  }
  if (kind === "staff") {
    // A hub manager registers their own team: same hub, never another manager.
    if (row.hub !== scopeHub) throw httpError(403, `You can only manage staff of hub ${scopeHub}`);
    if (row.role === "manager" || MANAGER_LEVELS.has(row.staff_level)) throw httpError(403, "Hub users cannot add or change managers");
    return;
  }
  const hub = (await db.get("SELECT hub FROM staff WHERE employee_id = ?", row[empCol(kind)]))?.hub;
  if (hub !== scopeHub) throw httpError(403, `You can only enter data for hub ${scopeHub}`);
}

async function validateRefs(db, kind, row) {
  const staffRole = async (id) => (await db.get("SELECT role FROM staff WHERE employee_id = ?", id))?.role;
  if (kind === "staff" && row.manager_id && (await staffRole(row.manager_id)) !== "manager") {
    throw httpError(400, `manager_id ${row.manager_id} is not a manager`);
  }
  if (kind === "weekly" && row.manager_id && (await staffRole(row.manager_id)) !== "manager") {
    throw httpError(400, `${row.manager_id} is not a manager`);
  }
  if ((kind === "daily" || kind === "stock") && row.employee_id && (await staffRole(row.employee_id)) !== "guy") {
    throw httpError(400, `${row.employee_id} is not a guy/supervisor`);
  }
  if (kind === "allowances" && row.employee_id && !(await staffRole(row.employee_id))) {
    throw httpError(400, `Unknown employee ${row.employee_id}`);
  }
}

// Chain of command. Payroll only knows two roles (guy, manager); staff_level adds the rungs between them.
// Manager, promoting manager and coacher are all payroll "managers": a weekly account plus an optional fixed salary.
const LEVEL_RANK = { distributor: 0, supervisor: 1, group_manager: 2, manager: 3, promoting_manager: 4, coacher: 5 };
const LEVEL_NAME = { distributor: "Distributor", supervisor: "Supervisor", group_manager: "Group manager", manager: "Manager",
  promoting_manager: "Promoting manager", coacher: "Coacher" };
const MANAGER_LEVELS = new Set(["manager", "promoting_manager", "coacher"]);
const roleOf = (level) => (MANAGER_LEVELS.has(level) ? "manager" : "guy");

// Keeps role, staff_level, upline_id and manager_id consistent. `row` holds the changes, `existing` the stored record.
async function applyChain(db, row, existing = {}, id) {
  const m = { ...existing, ...row };
  if (!m.role && !m.staff_level) throw httpError(400, "staff_level (position) is required");
  if (row.staff_level) row.role = m.role = roleOf(row.staff_level);
  else if (row.role && row.role !== existing.role) row.staff_level = m.staff_level = row.role === "manager" ? "manager" : "distributor";
  else if (!m.staff_level) row.staff_level = m.staff_level = m.role === "manager" ? "manager" : "distributor";
  if (m.upline_id) {
    if (m.upline_id === id) throw httpError(400, "An employee cannot report to themselves");
    const up = await db.get("SELECT staff_level FROM staff WHERE employee_id = ?", m.upline_id);
    if (!up) throw httpError(400, `Unknown upline ${m.upline_id}`);
    if (LEVEL_RANK[up.staff_level] <= LEVEL_RANK[m.staff_level]) {
      throw httpError(400, `A ${LEVEL_NAME[m.staff_level].toLowerCase()} must report to someone more senior, not a ${LEVEL_NAME[up.staff_level].toLowerCase()}`);
    }
    // The nearest manager above this person is their payroll manager, unless one was set explicitly.
    if (m.role === "guy" && row.manager_id === undefined && row.upline_id !== undefined) {
      let cur = m.upline_id;
      for (let i = 0; cur && i < 10; i++) {
        const s = await db.get("SELECT role, upline_id FROM staff WHERE employee_id = ?", cur);
        if (s?.role === "manager") { row.manager_id = cur; break; }
        cur = s?.upline_id;
      }
    }
  }
}

// Map Postgres error codes to friendly HTTP errors.
function sqlError(err) {
  if (err.status) return err;
  const code = err.code;
  const m = String(err.message);
  if (code === "23505") return httpError(409, "That record already exists — edit it instead");
  if (code === "23503") return httpError(400, "Unknown employee, manager or hub");
  if (code === "23514") return httpError(400, "Value failed validation: " + m);
  if (/finalized/.test(m)) return httpError(409, m.replace(/^.*?(Pay period)/, "$1"));
  return err;
}

const insertSql = (table, cols) => `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;

// A new weekly row with no profit % gets the commission rule: high rate at or above the threshold, else the low rate.
const blank = (v) => v === undefined || v === null || v === "";
function weeklyDefaults(raw, settings) {
  const business = Number(raw.business_total);
  if (!blank(raw.profit_percent) || blank(raw.business_total) || !Number.isFinite(business)) return raw;
  return { ...raw, profit_percent: engine.managerCommissionRate(Math.round(business * 100), settings) };
}

async function createEntry(db, kind, body, user, scopeHub) {
  const e = ENTITIES[kind];
  if (!e) throw httpError(404, `Unknown entity ${kind}`);
  if (kind === "weekly") body = weeklyDefaults(body, await getSettings(db));
  const row = clean(e, body, { creating: true });
  if (kind === "staff") await applyChain(db, row, {}, row.employee_id);
  await validateRefs(db, kind, row);
  await assertScope(db, kind, row, scopeHub);
  row.created_by = user;
  if (kind === "staff") row.bank_account_verified = row.bank_account_no ?? null; // initial on-file account
  const cols = Object.keys(row);
  try {
    return await withUser(db, user, async (t) =>
      t.get(`${insertSql(e.table, cols)} RETURNING *`, ...cols.map((c) => row[c])));
  } catch (err) { throw sqlError(err); }
}

async function updateEntry(db, kind, key, body, user, scopeHub) {
  const e = ENTITIES[kind];
  if (!e) throw httpError(404, `Unknown entity ${kind}`);
  const existing = await db.get(`SELECT * FROM ${e.table} WHERE ${e.key}::text = ?`, String(key));
  if (!existing) throw httpError(404, "Not found");
  const row = clean(e, body, { creating: false });
  if (kind === "staff") await applyChain(db, row, existing, String(key));
  await validateRefs(db, kind, { ...existing, ...row });
  await assertScope(db, kind, existing, scopeHub);
  await assertScope(db, kind, { ...existing, ...row }, scopeHub);
  const cols = Object.keys(row).filter((c) => row[c] !== existing[c]);
  if (!cols.length) return existing;
  try {
    return await withUser(db, user, async (t) =>
      t.get(`UPDATE ${e.table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE ${e.key}::text = ? RETURNING *`,
        ...cols.map((c) => row[c]), user, String(key)));
  } catch (err) { throw sqlError(err); }
}

async function deleteEntry(db, kind, key, user, scopeHub) {
  const e = ENTITIES[kind];
  if (!e) throw httpError(404, `Unknown entity ${kind}`);
  if (kind === "staff" || kind === "hubs") throw httpError(400, "Master records cannot be deleted; set status to inactive");
  const existing = await db.get(`SELECT * FROM ${e.table} WHERE ${e.key}::text = ?`, String(key));
  if (!existing) throw httpError(404, "Not found");
  await assertScope(db, kind, existing, scopeHub);
  try {
    return await withUser(db, user, async (t) => {
      const r = await t.run(`DELETE FROM ${e.table} WHERE ${e.key}::text = ?`, String(key));
      if (!r.rowCount) throw httpError(404, "Not found");
      return { deleted: true };
    });
  } catch (err) { throw sqlError(err); }
}

// ---------------------------------------------------------------- bulk grid entry

const NATURAL_KEYS = { daily: ["date", "employee_id"], weekly: ["week_start", "manager_id"], stock: ["period", "employee_id", "product"],
  hubstock: ["period", "hub", "product"] };

// Save a whole grid (e.g. one hub's daily sheet) in a single all-or-nothing transaction.
// Rows are matched on their natural key: existing rows are updated (audited), new ones inserted,
// rows with _delete: true are removed.
async function bulkUpsert(db, kind, rows, user, scopeHub) {
  const e = ENTITIES[kind];
  const keys = NATURAL_KEYS[kind];
  if (!keys) throw httpError(400, `Bulk entry is not supported for ${kind}`);
  if (!Array.isArray(rows) || !rows.length) throw httpError(400, "No rows to save");
  if (rows.length > 3000) throw httpError(400, "Too many rows in one save (max 3000)");

  // Validate everything up front, with staff looked up once.
  const staff = new Map((await db.all("SELECT employee_id, role, hub FROM staff")).map((s) => [s.employee_id, s]));
  const wantRole = kind === "weekly" ? "manager" : "guy";
  const settings = kind === "weekly" ? await getSettings(db) : null;
  const rowHub = (r) => (e.byHub ? r.hub : staff.get(r[empCol(kind)])?.hub);
  const prepared = [];
  const errors = [];
  rows.forEach((raw, i) => {
    try {
      if (raw._delete) {
        prepared.push({ del: true, key: keys.map((k) => coerce(k, { ...e.fields[k], required: true }, raw[k])) });
        return;
      }
      const row = clean(e, settings ? weeklyDefaults(raw, settings) : raw, { creating: true });
      const s = staff.get(row[empCol(kind)]);
      if (!e.byHub && (!s || s.role !== wantRole)) throw httpError(400, `${row[empCol(kind)]} is not a ${wantRole === "guy" ? "guy/supervisor" : "manager"}`);
      if (scopeHub && rowHub(row) !== scopeHub) throw httpError(403, `You can only enter data for hub ${scopeHub}`);
      prepared.push({ row, key: keys.map((k) => row[k]) });
    } catch (err) {
      errors.push(`Row ${i + 1}${raw[keys[1]] ? ` (${raw[keys[1]]})` : ""}: ${err.message}`);
    }
  });
  if (errors.length) throw httpError(400, errors.slice(0, 8).join(" · ") + (errors.length > 8 ? ` · and ${errors.length - 8} more` : ""));

  const findSql = `SELECT * FROM ${e.table} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`;
  const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  try {
    await withUser(db, user, async (t) => {
      for (const p of prepared) {
        const existing = await t.get(findSql, ...p.key);
        if (p.del) {
          if (!existing) continue;
          if (scopeHub && rowHub(existing) !== scopeHub) throw httpError(403, `You can only enter data for hub ${scopeHub}`);
          await t.run(`DELETE FROM ${e.table} WHERE id = ?`, existing.id);
          counts.deleted++;
        } else if (existing) {
          const cols = Object.keys(p.row).filter((c) => !keys.includes(c) && p.row[c] !== existing[c]);
          if (!cols.length) { counts.unchanged++; continue; }
          await t.run(`UPDATE ${e.table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
            ...cols.map((c) => p.row[c]), user, existing.id);
          counts.updated++;
        } else {
          const row = { ...p.row, created_by: user };
          const cols = Object.keys(row);
          await t.run(insertSql(e.table, cols), ...cols.map((c) => row[c]));
          counts.created++;
        }
      }
    });
  } catch (err) { throw sqlError(err); }
  return counts;
}

// ---------------------------------------------------------------- payroll run

// Fingerprint of everything a reviewer signs off on: the figures, their itemisation and the payee account.
function hashResult(r, staff) {
  return crypto.createHash("sha256").update(JSON.stringify([
    r.opening_balance, r.gross_earnings, r.total_deductions, r.net_pay, r.disbursed_amount, r.closing_balance,
    r.detail, staff.bank_account_no,
  ])).digest("hex");
}

const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r) && m, new Map());

// Recalculates every summary for the period from source entries. Safe to run repeatedly.
async function runPeriod(db, period, user) {
  assertPeriod(period);
  return withUser(db, user, async (t) => {
    if (await isFinalized(t, period)) throw httpError(409, `Period ${period} is finalized`);
    const settings = await getSettings(t);

    // Load the whole period in a handful of queries (cheap over a network connection to Neon).
    const dailyAll = await t.all("SELECT * FROM daily_log WHERE left(date, 7) = ? ORDER BY date", period);
    const stockAll = await t.all("SELECT * FROM stock_recon WHERE period = ? ORDER BY product", period);
    const allowAll = await t.all("SELECT * FROM allowances WHERE period = ? ORDER BY id", period);
    const weeklyAll = await t.all("SELECT * FROM weekly_log WHERE left(week_start, 7) = ? ORDER BY week_start", period);
    const daily = groupBy(dailyAll, "employee_id"), stock = groupBy(stockAll, "employee_id");
    const allow = groupBy(allowAll, "employee_id"), weekly = groupBy(weeklyAll, "manager_id");
    // Latest earlier summary per employee (opening balance + previous net pay) and security held so far.
    const prevRows = await t.all(`SELECT DISTINCT ON (employee_id) * FROM pay_period_summary
      WHERE period < ? ORDER BY employee_id, period DESC`, period);
    const prevBy = new Map(prevRows.map((r) => [r.employee_id, r]));
    const heldRows = await t.all(`SELECT employee_id, COALESCE(SUM((detail::jsonb->>'security_deducted')::numeric), 0) AS held
      FROM pay_period_summary WHERE period < ? GROUP BY employee_id`, period);
    const heldBy = new Map(heldRows.map((r) => [r.employee_id, Number(r.held)]));

    const active = new Set([...daily.keys(), ...stock.keys(), ...allow.keys(), ...weekly.keys()]);
    const staff = (await t.all("SELECT * FROM staff ORDER BY role DESC, employee_id"))
      .filter((s) => s.status === "active" || active.has(s.employee_id));

    const results = new Map();
    const guys = staff.filter((s) => s.role === "guy");
    const managers = staff.filter((s) => s.role === "manager");
    const errors = [];
    for (const s of guys) {
      const prev = prevBy.get(s.employee_id);
      try {
        results.set(s.employee_id, {
          staff: s, prev,
          result: engine.computeGuy({
            staff: s,
            daily: daily.get(s.employee_id) || [],
            stock: stock.get(s.employee_id) || [],
            allowances: allow.get(s.employee_id) || [],
            openingBalance: prev ? prev.closing_balance : Number(s.opening_balance) || 0, // go-live balance until a first month exists
            securityHeldToDate: heldBy.get(s.employee_id) || 0,
          }),
        });
      } catch (err) { errors.push(`${s.employee_id}: ${err.message}`); }
    }
    for (const m of managers) {
      const prev = prevBy.get(m.employee_id);
      const guyNetPays = guys
        .filter((g) => g.manager_id === m.employee_id && results.has(g.employee_id))
        .map((g) => ({ employee_id: g.employee_id, name: g.name, net_pay: results.get(g.employee_id).result.net_pay }));
      results.set(m.employee_id, {
        staff: m, prev,
        result: engine.computeManager({
          staff: m, weekly: weekly.get(m.employee_id) || [], guyNetPays,
          openingBalance: prev ? prev.closing_balance : Number(m.opening_balance) || 0,
          companyReturnRate: Number(settings.company_return_rate),
        }),
      });
    }
    if (errors.length) throw httpError(400, "Cannot calculate: " + errors.join("; "));

    const existingBy = new Map((await t.all(`SELECT employee_id, status, result_hash, flags, reviewed_by, reviewed_at, review_note
      FROM pay_period_summary WHERE period = ?`, period)).map((r) => [r.employee_id, r]));
    const counts = { auto_approved: 0, pending_review: 0, approved: 0, rejected: 0 };
    for (const [id, { staff: s, prev, result }] of results) {
      const flags = engine.evaluateFlags(result, { staff: s, previous: prev, settings });
      const hash = hashResult(result, s);
      const existing = existingBy.get(id);
      // A reviewer's decision survives a re-run only if the figures are unchanged and no new kind of
      // flag appeared (flags can disappear, e.g. approving a bank change verifies the account).
      const reviewedCodes = new Set(existing ? JSON.parse(existing.flags).map((f) => f.code) : []);
      const keep = existing && existing.result_hash === hash && ["approved", "rejected"].includes(existing.status)
        && flags.every((f) => reviewedCodes.has(f.code));
      const status = keep ? existing.status : flags.length ? "pending_review" : "auto_approved";
      counts[status]++;
      await t.run(`
        INSERT INTO pay_period_summary (employee_id, period, role, opening_balance, gross_earnings, total_deductions, net_pay,
          disbursed_amount, closing_balance, detail, flags, result_hash, status, bank_name, bank_code, branch_code, bank_account_no,
          computed_at, reviewed_by, reviewed_at, review_note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ${NOW},?,?,?)
        ON CONFLICT (employee_id, period) DO UPDATE SET
          role=excluded.role, opening_balance=excluded.opening_balance, gross_earnings=excluded.gross_earnings,
          total_deductions=excluded.total_deductions, net_pay=excluded.net_pay, disbursed_amount=excluded.disbursed_amount,
          closing_balance=excluded.closing_balance, detail=excluded.detail, flags=excluded.flags, result_hash=excluded.result_hash,
          status=excluded.status, bank_name=excluded.bank_name, bank_code=excluded.bank_code, branch_code=excluded.branch_code,
          bank_account_no=excluded.bank_account_no, computed_at=excluded.computed_at, reviewed_by=excluded.reviewed_by,
          reviewed_at=excluded.reviewed_at, review_note=excluded.review_note`,
        id, period, result.role, result.opening_balance, result.gross_earnings, result.total_deductions,
        result.net_pay, result.disbursed_amount, result.closing_balance, JSON.stringify(result.detail), JSON.stringify(flags),
        hash, status, s.bank_name, s.bank_code, s.branch_code, s.bank_account_no,
        keep ? existing.reviewed_by : null, keep ? existing.reviewed_at : null, keep ? existing.review_note : null);
    }
    const ids = [...results.keys()];
    await t.run(`DELETE FROM pay_period_summary WHERE period = ? AND NOT (employee_id = ANY(?::text[]))`, period, ids);
    await t.run(`INSERT INTO periods (period, last_run_by, last_run_at) VALUES (?, ?, ${NOW})
      ON CONFLICT (period) DO UPDATE SET last_run_by = excluded.last_run_by, last_run_at = excluded.last_run_at`, period, user);
    return { period, employees: results.size, ...counts };
  }, { lockKey: "period:" + period });
}

async function getPeriod(db, period) {
  assertPeriod(period);
  const info = (await db.get("SELECT * FROM periods WHERE period = ?", period)) || { period, status: "open" };
  const rows = (await db.all(`
    SELECT p.*, s.name, s.hub, s.manager_id, s.staff_level FROM pay_period_summary p JOIN staff s USING (employee_id)
    WHERE p.period = ? ORDER BY p.role DESC, s.hub, p.employee_id`, period))
    .map((r) => ({ ...r, detail: JSON.parse(r.detail), flags: JSON.parse(r.flags) }));
  return { ...info, rows };
}

async function review(db, period, employeeId, user, decision, note) {
  assertPeriod(period);
  if (decision === "rejected" && !String(note || "").trim()) throw httpError(400, "A note is required when rejecting");
  return withUser(db, user, async (t) => {
    if (await isFinalized(t, period)) throw httpError(409, `Period ${period} is finalized`);
    const row = await t.get("SELECT * FROM pay_period_summary WHERE employee_id = ? AND period = ?", employeeId, period);
    if (!row) throw httpError(404, "No summary for that employee — run the period first");
    if (row.status === "auto_approved") throw httpError(409, "Entry has no flags and was auto-approved");
    const flags = JSON.parse(row.flags);
    // Approving a bank-account flag is what confirms the new account as the one on file.
    if (decision === "approved" && flags.some((f) => f.code === "BANK_ACCOUNT_CHANGED")) {
      // Four-eyes rule: whoever changed the account cannot be the one who confirms it.
      const changers = (await t.all(`SELECT changed_by FROM audit_log WHERE table_name = 'staff' AND row_key = ? AND action = 'update'
        AND (old_value::jsonb->>'bank_account_no') IS DISTINCT FROM (new_value::jsonb->>'bank_account_no')`, employeeId))
        .map((r) => r.changed_by.toLowerCase());
      const creator = (await t.get("SELECT created_by FROM staff WHERE employee_id = ?", employeeId))?.created_by;
      if (changers.includes(user.toLowerCase()) || (!changers.length && creator?.toLowerCase() === user.toLowerCase())) {
        throw httpError(403, "You entered this bank account yourself — another user must approve it");
      }
      await t.run(`UPDATE staff SET bank_account_verified = ?, updated_by = ?, updated_at = ${NOW} WHERE employee_id = ?`,
        row.bank_account_no, user, employeeId);
    }
    await t.run(`UPDATE pay_period_summary SET status = ?, reviewed_by = ?, reviewed_at = ${NOW}, review_note = ?
      WHERE employee_id = ? AND period = ?`, decision, user, note || null, employeeId, period);
    await t.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value, new_value) VALUES ('pay_period_summary', ?, ?, ?, ?, ?)`,
      `${employeeId}@${period}`, decision === "approved" ? "approve" : "reject", user,
      JSON.stringify({ status: row.status, flags }), JSON.stringify({ status: decision, note: note || null }));
    return { employee_id: employeeId, period, status: decision };
  }, { lockKey: "period:" + period });
}

async function finalizePeriod(db, period, user) {
  assertPeriod(period);
  if (await isFinalized(db, period)) throw httpError(409, `Period ${period} is already finalized`);
  const openEarlier = await db.all(`SELECT DISTINCT s.period FROM pay_period_summary s LEFT JOIN periods p USING (period)
    WHERE s.period < ? AND COALESCE(p.status,'open') <> 'finalized' ORDER BY s.period`, period);
  if (openEarlier.length) throw httpError(409, `Finalize earlier periods first: ${openEarlier.map((r) => r.period).join(", ")}`);
  await runPeriod(db, period, user); // always finalize fresh numbers
  await withUser(db, user, async (t) => {
    const blocking = await t.all(`SELECT employee_id, status FROM pay_period_summary WHERE period = ? AND status IN ('pending_review','rejected')
      ORDER BY employee_id`, period);
    if (blocking.length) {
      throw httpError(409, `Resolve before finalizing: ${blocking.map((b) => `${b.employee_id} (${b.status})`).join(", ")}`);
    }
    await t.run(`UPDATE periods SET status = 'finalized', finalized_by = ?, finalized_at = ${NOW} WHERE period = ?`, user, period);
    await t.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by) VALUES ('periods', ?, 'finalize', ?)`, period, user);
  }, { lockKey: "period:" + period });
  return getPeriod(db, period);
}

async function auditSearch(db, { table, key, user, from, to, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (table) { where.push("table_name = ?"); args.push(table); }
  if (key) { where.push("row_key = ?"); args.push(String(key)); }
  if (user) { where.push("lower(changed_by) = lower(?)"); args.push(user); }
  if (from) { where.push("changed_at >= ?"); args.push(from); }
  if (to) { where.push("changed_at < ((?::date) + 1)::text"); args.push(to); }
  args.push(Math.min(Number(limit) || 300, 2000));
  return db.all(`SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...args);
}
const auditLog = auditSearch;

async function updateSettings(db, body, user) {
  const allowed = {
    company_return_rate: (v) => { const n = Number(v); if (!(n >= 0 && n <= 1)) throw httpError(400, "company_return_rate must be 0–1"); return String(n); },
    net_pay_change_threshold: (v) => { const n = Number(v); if (!(n > 0 && n <= 10)) throw httpError(400, "net_pay_change_threshold must be > 0"); return String(n); },
    stock_shortfall_threshold: (v) => { const n = Number(v); if (!(n >= 0)) throw httpError(400, "stock_shortfall_threshold must be ≥ 0"); return String(Math.round(n * 100)); },
    bank_format: (v) => String(v),
    closed_weekdays: (v) => {
      const days = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      if (!days.every((d) => /^[0-6]$/.test(d))) throw httpError(400, "closed_weekdays must be numbers 0–6 separated by commas");
      return [...new Set(days)].join(",");
    },
    session_hours: (v) => { const n = Number(v); if (!(n >= 1 && n <= 168)) throw httpError(400, "session_hours must be 1–168"); return String(Math.round(n)); },
    company_account_no: (v) => String(v).trim(),
    company_name: (v) => String(v).trim(),
    manager_commission_threshold: (v) => { const n = Number(v); if (!(n >= 0)) throw httpError(400, "manager_commission_threshold must be ≥ 0"); return String(Math.round(n * 100)); },
    manager_commission_high: (v) => { const n = Number(v); if (!(n >= 0 && n <= 1)) throw httpError(400, "manager_commission_high must be 0–1"); return String(n); },
    manager_commission_low: (v) => { const n = Number(v); if (!(n >= 0 && n <= 1)) throw httpError(400, "manager_commission_low must be 0–1"); return String(n); },
    manager_rent_default: (v) => { const n = Number(v); if (!(n >= 0)) throw httpError(400, "manager_rent_default must be ≥ 0"); return String(Math.round(n * 100)); },
    manager_hub_fee_default: (v) => { const n = Number(v); if (!(n >= 0)) throw httpError(400, "manager_hub_fee_default must be ≥ 0"); return String(Math.round(n * 100)); },
    manager_security_rate: (v) => { const n = Number(v); if (!(n >= 0 && n <= 1)) throw httpError(400, "manager_security_rate must be 0–1"); return String(n); },
    // Pay setup pre-filled for new staff at each position. People can still be given their own target and rates.
    position_defaults: (v) => {
      let o;
      try { o = typeof v === "string" ? JSON.parse(v) : v; } catch { throw httpError(400, "position_defaults must be valid JSON"); }
      if (!o || typeof o !== "object" || Array.isArray(o)) throw httpError(400, "position_defaults must be an object");
      const out = {};
      for (const [level, d] of Object.entries(o)) {
        if (!(level in LEVEL_RANK)) throw httpError(400, `No pay defaults for position ${level}`);
        const num = (k, max = Infinity) => { const n = Number(d[k] ?? 0); if (!(n >= 0 && n <= max)) throw httpError(400, `${level}: ${k} is invalid`); return n; };
        const scheme = d.pay_scheme === "tiered" ? "tiered" : "over_target";
        const rule = String(d.security_deduction_rule || "none");
        try { engine.parseSecurityRule(rule); } catch (e) { throw httpError(400, `${level}: ${e.message}`); }
        out[level] = {
          pay_scheme: scheme, target: num("target"), basic_pay: num("basic_pay"), commission_rate: num("commission_rate", 1),
          base_commission_rate: num("base_commission_rate", 1), food_per_day: num("food_per_day"), food_min_days: Math.round(num("food_min_days", 31)),
          security_deduction_rule: rule,
        };
      }
      return JSON.stringify(out);
    },
  };
  return withUser(db, user, async (t) => {
    for (const [k, v] of Object.entries(body)) {
      if (!allowed[k]) throw httpError(400, `Unknown setting ${k}`);
      const value = allowed[k](v);
      const old = (await t.get("SELECT value FROM settings WHERE key = ?", k))?.value;
      if (old === value) continue;
      await t.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", k, value);
      await t.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value, new_value) VALUES ('settings', ?, 'update', ?, ?, ?)`,
        k, user, JSON.stringify(old), JSON.stringify(value));
    }
    return getSettings(t);
  });
}

// ---------------------------------------------------------------- analytics

function shiftPeriod(period, delta) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
function daysOf(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Working days in the period that should have a daily entry (up to today for the current month).
function expectedDays(period, closedWeekdays) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let d = 1; d <= daysOf(period); d++) {
    const date = `${period}-${String(d).padStart(2, "0")}`;
    if (date > today) break;
    if (closedWeekdays.includes(new Date(date + "T00:00:00Z").getUTCDay())) continue;
    out.push(date);
  }
  return out;
}

async function dashboard(db, period, hub) {
  assertPeriod(period);
  const settings = await getSettings(db);
  const closed = String(settings.closed_weekdays || "").split(",").filter(Boolean).map(Number);
  const hubs = (await db.all("SELECT * FROM hubs ORDER BY code")).filter((h) => !hub || h.code === hub);
  const staff = (await db.all("SELECT * FROM staff ORDER BY employee_id")).filter((s) => !hub || s.hub === hub);
  const ids = new Set(staff.map((s) => s.employee_id));
  const byId = new Map(staff.map((s) => [s.employee_id, s]));

  const daily = (await db.all(`SELECT employee_id, COUNT(*) AS days, SUM(business_amount) AS business, SUM(settle_up_minus) AS settle_up,
      SUM(personal_minus) AS personal, string_agg(date, ',') AS dates FROM daily_log WHERE left(date, 7) = ? GROUP BY employee_id`, period))
    .filter((r) => ids.has(r.employee_id));
  const weekly = (await db.all(`SELECT manager_id, COUNT(*) AS weeks, SUM(business_total) AS business FROM weekly_log
      WHERE left(week_start, 7) = ? GROUP BY manager_id`, period)).filter((r) => ids.has(r.manager_id));
  const stock = (await db.all(`SELECT employee_id, SUM(shortfall_value) AS shortfall FROM stock_recon WHERE period = ? GROUP BY employee_id`, period))
    .filter((r) => ids.has(r.employee_id));
  const summaries = (await getPeriod(db, period)).rows.filter((r) => ids.has(r.employee_id));
  const dailyBy = new Map(daily.map((r) => [r.employee_id, r]));
  const sum = (arr, k) => arr.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  const guys = summaries.filter((r) => r.role === "guy");
  const managers = summaries.filter((r) => r.role === "manager");

  const expected = expectedDays(period, closed);
  const activeGuys = staff.filter((s) => s.role === "guy" && s.status === "active");
  const completeness = activeGuys.map((s) => {
    const logged = new Set((dailyBy.get(s.employee_id)?.dates || "").split(",").filter(Boolean));
    const missing = expected.filter((d) => !logged.has(d));
    return { employee_id: s.employee_id, name: s.name, hub: s.hub, expected: expected.length, logged: expected.length - missing.length, missing };
  });

  const byHub = hubs.map((h) => {
    const inHub = (r, col = "employee_id") => byId.get(r[col])?.hub === h.code;
    const hubGuys = guys.filter((r) => inHub(r));
    return {
      code: h.code, name: h.name,
      staff: staff.filter((s) => s.hub === h.code && s.status === "active").length,
      guys_business: sum(daily.filter((r) => inHub(r)), "business"),
      hub_business: sum(weekly.filter((r) => inHub(r, "manager_id")), "business"),
      gross_pay: sum(hubGuys, "gross_earnings"),
      net_pay: sum(hubGuys, "net_pay"),
      to_bank: sum(hubGuys, "disbursed_amount"),
      manager_balance: sum(managers.filter((r) => inHub(r)), "closing_balance"),
      stock_shortfall: sum(stock.filter((r) => inHub(r)), "shortfall"),
    };
  });

  // Six-month trend in two queries.
  const first = shiftPeriod(period, -5);
  const trendRows = (await db.all(`SELECT p.period, p.role, p.net_pay, p.disbursed_amount, p.gross_earnings, s.hub
    FROM pay_period_summary p JOIN staff s USING (employee_id) WHERE p.period BETWEEN ? AND ?`, first, period)).filter((r) => !hub || r.hub === hub);
  const bizRows = (await db.all(`SELECT left(date, 7) AS period, employee_id, SUM(business_amount) AS b FROM daily_log
    WHERE left(date, 7) BETWEEN ? AND ? GROUP BY 1, 2`, first, period)).filter((r) => ids.has(r.employee_id));
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const p = shiftPeriod(period, -i);
    const rows = trendRows.filter((r) => r.period === p);
    trend.push({
      period: p,
      business: sum(bizRows.filter((r) => r.period === p), "b"),
      gross_pay: sum(rows.filter((r) => r.role === "guy"), "gross_earnings"),
      net_pay: sum(rows.filter((r) => r.role === "guy"), "net_pay"),
      to_bank: sum(rows, "disbursed_amount"),
      calculated: rows.length > 0,
    });
  }

  const top = activeGuys.map((s) => {
    const b = Number(dailyBy.get(s.employee_id)?.business || 0);
    return { employee_id: s.employee_id, name: s.name, hub: s.hub, business: b, target: s.target, attainment: s.target ? b / s.target : null };
  }).sort((a, b) => b.business - a.business);

  const info = (await db.get("SELECT * FROM periods WHERE period = ?", period)) || { period, status: "open" };
  return {
    period, hub: hub || null, status: info.status, last_run_at: info.last_run_at || null, finalized_at: info.finalized_at || null,
    kpis: {
      guys_business: sum(daily, "business"),
      hub_business: sum(weekly, "business"),
      settle_up: sum(daily, "settle_up"),
      stock_shortfall: sum(stock, "shortfall"),
      active_guys: activeGuys.length,
      active_managers: staff.filter((s) => s.role === "manager" && s.status === "active").length,
      calculated: summaries.length > 0,
      gross_pay: sum(guys, "gross_earnings"),
      net_pay: sum(guys, "net_pay"),
      to_bank: sum(summaries, "disbursed_amount"),
      manager_balance: sum(managers, "closing_balance"),
      pending: summaries.filter((r) => r.status === "pending_review").length,
      rejected: summaries.filter((r) => r.status === "rejected").length,
      missing_days: completeness.reduce((t, c) => t + c.missing.length, 0),
    },
    by_hub: byHub,
    trend,
    top,
    completeness,
    exceptions: summaries.filter((r) => r.flags.length).map((r) => ({
      employee_id: r.employee_id, name: r.name, hub: r.hub, status: r.status, net_pay: r.net_pay, flags: r.flags,
    })),
  };
}

async function employeeProfile(db, id) {
  const s = await db.get(`SELECT s.*, h.name AS hub_name, m.name AS manager_name, u.name AS upline_name FROM staff s JOIN hubs h ON h.code = s.hub
    LEFT JOIN staff m ON m.employee_id = s.manager_id LEFT JOIN staff u ON u.employee_id = s.upline_id WHERE s.employee_id = ?`, id);
  if (!s) throw httpError(404, "Employee not found");
  const history = (await db.all(`SELECT p.*, COALESCE(x.status,'open') AS period_status FROM pay_period_summary p
      LEFT JOIN periods x USING (period) WHERE employee_id = ? ORDER BY period DESC`, id))
    .map((r) => ({ ...r, detail: JSON.parse(r.detail), flags: JSON.parse(r.flags) }));
  const team = s.role === "manager"
    ? await db.all("SELECT employee_id, name, status, basic_pay, target FROM staff WHERE manager_id = ? ORDER BY employee_id", id) : [];
  const direct_reports = await db.all("SELECT employee_id, name, staff_level, status FROM staff WHERE upline_id = ? ORDER BY staff_level, employee_id", id);
  const changes = await db.all("SELECT * FROM audit_log WHERE table_name = 'staff' AND row_key = ? ORDER BY id DESC LIMIT 50", id);
  const security_held = history.reduce((t, r) => t + (r.detail.security_deducted || 0), 0);
  return { staff: s, history, team, direct_reports, changes, security_held };
}

async function balancesReport(db) {
  return db.all(`SELECT DISTINCT ON (s.employee_id) s.employee_id, s.name, s.role, s.hub, s.status, p.period, p.closing_balance,
      COALESCE(x.status,'open') AS period_status
    FROM staff s JOIN pay_period_summary p ON p.employee_id = s.employee_id LEFT JOIN periods x ON x.period = p.period
    ORDER BY s.employee_id, p.period DESC`).then((rows) => rows.sort((a, b) => a.closing_balance - b.closing_balance));
}

async function stockReport(db, period) {
  assertPeriod(period);
  return db.all(`SELECT k.*, s.name, s.hub FROM stock_recon k JOIN staff s USING (employee_id) WHERE k.period = ?
    ORDER BY k.shortfall_value DESC, s.hub, k.employee_id`, period);
}

// ---------------------------------------------------------------- employee documents

const DOC_TYPES = ["nic", "bank_book", "ol_results", "other"];
const DOC_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const DOC_MAX_BYTES = 3_000_000; // keeps the upload under the host's request limit once base64-encoded

async function docStaff(db, employeeId, scopeHub) {
  const s = await db.get("SELECT employee_id, hub, role FROM staff WHERE employee_id = ?", employeeId);
  if (!s) throw httpError(404, "Employee not found");
  if (scopeHub && s.hub !== scopeHub) throw httpError(403, "Outside your hub");
  return s;
}

async function listDocuments(db, employeeId, scopeHub) {
  await docStaff(db, employeeId, scopeHub);
  return db.all(`SELECT id, employee_id, doc_type, file_name, mime, size_bytes, uploaded_by, uploaded_at FROM staff_documents
    WHERE employee_id = ? ORDER BY doc_type, id`, employeeId);
}

async function addDocument(db, employeeId, body, user, scopeHub) {
  await docStaff(db, employeeId, scopeHub);
  const name = String(body.file_name || "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  if (!DOC_TYPES.includes(body.doc_type)) throw httpError(400, `doc_type must be one of ${DOC_TYPES.join(", ")}`);
  if (!name) throw httpError(400, "file_name is required");
  if (!DOC_MIME.includes(body.mime)) throw httpError(400, "Only JPG, PNG, WebP or PDF files can be uploaded");
  const data = String(body.data || "").replace(/^data:[^,]*,/, "");
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw httpError(400, "The file could not be read");
  const size = Buffer.from(data, "base64").length;
  if (size > DOC_MAX_BYTES) throw httpError(413, "The file is larger than 3 MB — scan or photograph it at a lower quality");
  return withUser(db, user, async (t) => {
    const row = await t.get(`INSERT INTO staff_documents (employee_id, doc_type, file_name, mime, size_bytes, data, uploaded_by) VALUES (?,?,?,?,?,?,?)
      RETURNING id, employee_id, doc_type, file_name, mime, size_bytes, uploaded_by, uploaded_at`, employeeId, body.doc_type, name, body.mime, size, data, user);
    await t.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by, new_value) VALUES ('staff_documents', ?, 'upload', ?, ?)`,
      employeeId, user, JSON.stringify({ id: row.id, doc_type: row.doc_type, file_name: row.file_name, size_bytes: size }));
    return row;
  });
}

async function getDocument(db, id, scopeHub) {
  const d = await db.get("SELECT * FROM staff_documents WHERE id = ?", Number(id));
  if (!d) throw httpError(404, "Document not found");
  await docStaff(db, d.employee_id, scopeHub);
  return { ...d, buffer: Buffer.from(d.data, "base64") };
}

async function deleteDocument(db, id, user, scopeHub) {
  const d = await db.get("SELECT id, employee_id, doc_type, file_name FROM staff_documents WHERE id = ?", Number(id));
  if (!d) throw httpError(404, "Document not found");
  await docStaff(db, d.employee_id, scopeHub);
  return withUser(db, user, async (t) => {
    await t.run("DELETE FROM staff_documents WHERE id = ?", d.id);
    await t.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by, old_value) VALUES ('staff_documents', ?, 'delete', ?, ?)`,
      d.employee_id, user, JSON.stringify(d));
    return { deleted: true };
  });
}

async function commissionReport(db, period) {
  return (await getPeriod(db, period)).rows.filter((r) => r.role === "guy").map((r) => ({
    employee_id: r.employee_id, name: r.name, hub: r.hub, business: r.detail.total_business, target: r.detail.target,
    over_target: r.detail.over_target_amount, rate: r.detail.commission_rate,
    commission: r.detail.earnings.find((e) => e.label.startsWith("Commission"))?.amount || 0,
  })).sort((a, b) => b.commission - a.commission);
}

async function reviewQueue(db, hub) {
  return (await db.all(`SELECT p.*, s.name, s.hub, s.staff_level FROM pay_period_summary p JOIN staff s USING (employee_id)
      LEFT JOIN periods x USING (period)
      WHERE p.status IN ('pending_review','rejected') AND COALESCE(x.status,'open') = 'open' ORDER BY p.period, s.hub, p.employee_id`))
    .filter((r) => !hub || r.hub === hub)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail), flags: JSON.parse(r.flags) }));
}

async function listPeriods(db) {
  return db.all(`SELECT p.period, COALESCE(x.status,'open') AS status, x.finalized_by, x.finalized_at, x.last_run_at, COUNT(*) AS employees,
      COUNT(*) FILTER (WHERE p.status = 'pending_review') AS pending, COUNT(*) FILTER (WHERE p.status = 'rejected') AS rejected,
      SUM(p.disbursed_amount) AS to_bank, SUM(CASE WHEN p.role = 'guy' THEN p.net_pay ELSE 0 END) AS net_pay
    FROM pay_period_summary p LEFT JOIN periods x USING (period)
    GROUP BY p.period, x.status, x.finalized_by, x.finalized_at, x.last_run_at ORDER BY p.period DESC`);
}

module.exports = {
  ENTITIES, listEntries, createEntry, updateEntry, deleteEntry, bulkUpsert,
  runPeriod, getPeriod, review, finalizePeriod, auditLog, auditSearch, updateSettings, isFinalized, httpError, assertPeriod,
  listDocuments, addDocument, getDocument, deleteDocument, LEVEL_RANK, LEVEL_NAME, MANAGER_LEVELS,
  dashboard, employeeProfile, balancesReport, stockReport, commissionReport, reviewQueue, listPeriods, shiftPeriod,
};
