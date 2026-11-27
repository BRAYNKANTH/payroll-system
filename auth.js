// Users, password hashing, sessions and role permissions.
const crypto = require("crypto");
const { withUser, getSettings, httpError, logEvent } = require("./db");

const NOW = "now_iso()";
const ROLES = ["coacher", "manager", "admin", "staff"];
// What each role may do. The admin does everything. A coacher is the head of a hub: they see and handle the whole hub (data entry, the team, stock)
// but never anyone's pay. A manager sees only the people who report to them (read_team) and never pay; a manager tagged as stock keeper may also
// handle the stock of the whole hub. The staff portal sees only its own figures.
const PERMISSIONS = {
  staff: ["self"], // the staff portal: own figures only, nothing in the office pages
  manager: ["read_team", "self"], // their own people only; "self" is My page
  coacher: ["read", "read_team", "enter_data", "manage_team", "stock", "self"],
  admin: ["read", "read_team", "enter_data", "manage_staff", "run_payroll", "review", "export", "manage_hubs", "manage_loans", "manage_products", "view_pay", "finalize", "manage_users", "settings", "stock", "approve_cash"],
};
// Stock is managed only by each hub's coacher (and viewed by the office). A manager never gets the stock permission, whatever the old "stock keeper" tag says.
const permissionsOf = (u) => [...(PERMISSIONS[u.role] || [])];
const can = (user, perm) => !!user && (user.permissions || PERMISSIONS[user.role] || []).includes(perm);
// perm may be a list: any one of them is enough.
function requirePerm(user, perm) {
  if (!user) throw httpError(401, "Please sign in");
  if (![].concat(perm).some((p) => can(user, p))) throw httpError(403, `Your role (${user.role}) cannot do this`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function checkPasswordStrength(pw) {
  if (typeof pw !== "string" || pw.length < 8) throw httpError(400, "Password must be at least 8 characters");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw httpError(400, "Password must contain letters and numbers");
}
function validateUsername(u) {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(String(u || ""))) throw httpError(400, "Username must be 3–32 letters, numbers, dot, dash or underscore");
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const publicUser = (u) => u && ({
  username: u.username, full_name: u.full_name, role: u.role, hub: u.hub, employee_id: u.employee_id || null, status: u.status,
  staff_level: u.staff_level || null, stock_keeper: !!u.stock_keeper,
  last_login_at: u.last_login_at, created_at: u.created_at, permissions: permissionsOf(u),
});
// A login with the employee it belongs to (their position and stock-keeper tag decide what it may see).
const WITH_EMPLOYEE = "SELECT u.*, s.staff_level, s.stock_keeper, s.status AS employee_status FROM users u LEFT JOIN staff s ON s.employee_id = u.employee_id";
// A login is usable only while its user is active and the employee it belongs to has not left.
const usable = (u) => !!u && u.status === "active" && u.employee_status !== "inactive";
const findUser = (db, username) => db.get(`${WITH_EMPLOYEE} WHERE lower(u.username) = lower(?)`, String(username || ""));

// A manager sees only the people under them: everyone who reports to them, directly or through others, and themselves.
async function teamOf(db, employeeId) {
  if (!employeeId) return [];
  const rows = await db.all(`WITH RECURSIVE t(employee_id) AS (
      SELECT employee_id FROM staff WHERE upline_id = ?
      UNION SELECT s.employee_id FROM staff s JOIN t ON s.upline_id = t.employee_id)
    SELECT employee_id FROM t`, employeeId);
  return [employeeId, ...rows.map((r) => r.employee_id)];
}

const hasUsers = async (db) => (await db.get("SELECT COUNT(*) AS n FROM users")).n > 0;

// First-run: create the initial admin when no users exist.
async function setup(db, { username, full_name, password }) {
  validateUsername(username);
  checkPasswordStrength(password);
  if (!String(full_name || "").trim()) throw httpError(400, "Full name is required");
  await withUser(db, username, async (t) => {
    await t.query("SELECT pg_advisory_xact_lock(727275)"); // two people racing through setup
    if (await hasUsers(t)) throw httpError(409, "Setup already completed");
    await t.run(`INSERT INTO users (username, full_name, role, password_hash, created_by) VALUES (?, ?, 'admin', ?, 'setup')`,
      username.trim(), full_name.trim(), hashPassword(password));
  });
  return login(db, username, password);
}

// Accounts are never locked by failed attempts (the owner's decision): a wrong password only says "incorrect" and is written to the audit trail.
async function login(db, username, password) {
  const key = String(username || "").toLowerCase();
  const user = await findUser(db, username);
  const ok = usable(user) && verifyPassword(password, user.password_hash);
  if (!ok) {
    // Never the password, only who tried and why it failed.
    await logEvent(db, { user: key || "unknown", table: "session", key: key || "unknown", action: "login_failed",
      detail: { reason: !user ? "unknown username" : user.status !== "active" ? "account disabled" : user.employee_status === "inactive" ? "employee has left" : "wrong password" } });
    throw httpError(401, "Incorrect username or password");
  }
  const token = crypto.randomBytes(32).toString("hex");
  const hours = Number((await getSettings(db)).session_hours) || 12;
  await db.tx(async (t) => {
    await t.run(`DELETE FROM sessions WHERE expires_at < ${NOW}`);
    await t.run(`INSERT INTO sessions (token_hash, username, expires_at)
      VALUES (?, ?, to_char((now() + make_interval(hours => ?)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      sha256(token), user.username, hours);
    // Session bookkeeping only; the audit trigger ignores last_login_at.
    await t.run(`UPDATE users SET last_login_at = ${NOW} WHERE username = ?`, user.username);
  });
  await logEvent(db, { user: user.username, table: "session", key: user.username, action: "login", detail: { role: user.role } });
  return { token, maxAge: hours * 3600, user: publicUser({ ...user, last_login_at: new Date().toISOString() }) };
}

async function userFromToken(db, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.get(`
    SELECT u.*, s.staff_level, s.stock_keeper FROM sessions x JOIN users u USING (username) LEFT JOIN staff s ON s.employee_id = u.employee_id
    WHERE x.token_hash = ? AND x.expires_at > ${NOW} AND u.status = 'active' AND COALESCE(s.status, 'active') <> 'inactive'`, sha256(token));
  if (!row) return null;
  const user = publicUser(row);
  if (row.role === "manager") {
    // Not sent to the browser (not enumerable): the people this manager may see, used by the server to limit every answer.
    Object.defineProperty(user, "teamIds", { value: await teamOf(db, row.employee_id), enumerable: false });
  }
  return user;
}
async function logout(db, token) {
  if (!token) return;
  const s = await db.get("SELECT username FROM sessions WHERE token_hash = ?", sha256(token));
  await db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  if (s) await logEvent(db, { user: s.username, table: "session", key: s.username, action: "logout" });
}

// ---- user management (admin)
async function listUsers(db) {
  return (await db.all(`${WITH_EMPLOYEE} ORDER BY u.role DESC, u.username`)).map(publicUser);
}
async function createUser(db, actor, body) {
  validateUsername(body.username);
  if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role");
  if (!String(body.full_name || "").trim()) throw httpError(400, "Full name is required");
  checkPasswordStrength(body.password);
  if (body.hub && !(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", body.hub))) throw httpError(400, "Unknown hub");
  if (await findUser(db, body.username)) throw httpError(409, "Username already exists");
  let hub = body.hub || null;
  let employeeId = null;
  let role = body.role;
  const employee = async () => {
    const s = await db.get("SELECT employee_id, hub, role, status, staff_level, is_coacher FROM staff WHERE employee_id = ?", String(body.employee_id || ""));
    if (!s) throw httpError(400, "Choose the employee this login is for");
    if (s.status !== "active") throw httpError(400, "That employee is inactive");
    if (await db.get("SELECT 1 AS x FROM users WHERE employee_id = ?", s.employee_id)) throw httpError(409, "That employee already has a login");
    return s;
  };
  if (role === "staff" || role === "manager") {
    // These logins belong to one person and take that person's hub.
    const s = await employee();
    employeeId = s.employee_id;
    hub = s.hub;
    if (role === "manager" && !["manager", "promoting_manager"].includes(s.staff_level)) throw httpError(400, "A manager login is for a manager or a promoting manager");
    // The position and the coacher tag decide the kind of login: the coacher of a hub heads the hub; any other manager or promoting manager
    // sees their own people.
    const head = s.is_coacher || s.staff_level === "coacher";
    if (head && ["staff", "manager"].includes(role)) role = "coacher";
    else if (role === "staff" && ["manager", "promoting_manager"].includes(s.staff_level)) role = "manager";
  } else if (role === "coacher") {
    if (!hub) throw httpError(400, "A coacher must be limited to one hub");
    if (body.employee_id) {
      const s = await employee();
      if (!(s.is_coacher || s.staff_level === "coacher")) throw httpError(400, "A coacher login can only be linked to the hub's coacher");
      if (s.hub !== hub) throw httpError(400, "The employee belongs to a different hub than the one chosen");
      employeeId = s.employee_id;
    }
  }
  await withUser(db, actor.username, (t) =>
    t.run(`INSERT INTO users (username, full_name, role, hub, employee_id, password_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      body.username.trim(), body.full_name.trim(), role, hub, employeeId, hashPassword(body.password), actor.username));
  return publicUser(await findUser(db, body.username));
}
async function updateUser(db, actor, username, body) {
  const u = await findUser(db, username);
  if (!u) throw httpError(404, "User not found");
  const sets = {};
  if (body.full_name !== undefined) sets.full_name = String(body.full_name).trim();
  // A new username (the sign-in name). It must be free; the person is signed out everywhere and signs in again with the new one.
  const newName = body.username !== undefined ? String(body.username).trim() : u.username;
  if (newName !== u.username) {
    validateUsername(newName);
    if (newName.toLowerCase() !== u.username.toLowerCase() && (await findUser(db, newName))) throw httpError(409, "That username is already used");
    if (u.username.toLowerCase() === actor.username.toLowerCase()) throw httpError(400, "You cannot rename the account you are signed in with");
    sets.username = newName;
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role");
    if ((body.role === "staff") !== (u.role === "staff")) throw httpError(400, "A staff-portal login cannot be changed into an office role (or the other way). Create a new user instead.");
    if ((body.role === "manager") !== (u.role === "manager")) throw httpError(400, "A manager login belongs to the manager's own record and cannot be changed into another role (or the other way). Create a new user instead.");
    sets.role = body.role;
  }
  if (body.hub !== undefined && u.role !== "staff" && u.role !== "manager") {
    if (body.hub && !(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", body.hub))) throw httpError(400, "Unknown hub");
    sets.hub = body.hub || null;
  }
  if (body.status !== undefined) { if (!["active", "disabled"].includes(body.status)) throw httpError(400, "Invalid status"); sets.status = body.status; }
  if (body.password) { checkPasswordStrength(body.password); sets.password_hash = hashPassword(body.password); }
  if ((sets.role ?? u.role) === "coacher" && !(sets.hub !== undefined ? sets.hub : u.hub)) throw httpError(400, "A coacher must be limited to one hub");
  if (u.username.toLowerCase() === actor.username.toLowerCase() && ((sets.role && sets.role !== "admin") || sets.status === "disabled")) {
    throw httpError(400, "You cannot remove your own admin access");
  }
  const cols = Object.keys(sets);
  if (!cols.length) return publicUser(u);
  await withUser(db, actor.username, async (t) => {
    // Sessions point at the username, so they go first when it changes (the person signs in again).
    if (sets.username || sets.status === "disabled" || sets.password_hash) await t.run("DELETE FROM sessions WHERE username = ?", u.username);
    await t.run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE username = ?`,
      ...cols.map((c) => sets[c]), actor.username, u.username);
  });
  return publicUser(await findUser(db, sets.username || u.username));
}
async function changeOwnPassword(db, actor, { current_password, new_password }) {
  const u = await findUser(db, actor.username);
  if (!verifyPassword(current_password, u.password_hash)) throw httpError(400, "Current password is incorrect");
  checkPasswordStrength(new_password);
  await withUser(db, actor.username, (t) =>
    t.run(`UPDATE users SET password_hash = ?, updated_by = ?, updated_at = ${NOW} WHERE username = ?`,
      hashPassword(new_password), actor.username, u.username));
  await logEvent(db, { user: actor.username, table: "session", key: actor.username, action: "password_change", detail: { by: "the user themself" } });
  return { ok: true };
}

module.exports = {
  ROLES, PERMISSIONS, can, requirePerm, teamOf, hashPassword, verifyPassword, hasUsers, setup, login, logout, userFromToken,
  listUsers, createUser, updateUser, changeOwnPassword,
};
