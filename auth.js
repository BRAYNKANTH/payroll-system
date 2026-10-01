// Users, password hashing, sessions and role permissions.
const crypto = require("crypto");
const { withUser, getSettings, httpError } = require("./db");

const NOW = "now_iso()";
const ROLES = ["viewer", "clerk", "accountant", "admin"];
// What each role may do. Higher roles include everything below them.
const PERMISSIONS = {
  viewer: ["read"],
  clerk: ["read", "enter_data"],
  accountant: ["read", "enter_data", "manage_staff", "run_payroll", "review", "export", "manage_hubs"],
  admin: ["read", "enter_data", "manage_staff", "run_payroll", "review", "export", "manage_hubs", "finalize", "manage_users", "settings"],
};
const can = (user, perm) => !!user && PERMISSIONS[user.role]?.includes(perm);
function requirePerm(user, perm) {
  if (!user) throw httpError(401, "Please sign in");
  if (!can(user, perm)) throw httpError(403, `Your role (${user.role}) cannot do this`);
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
  username: u.username, full_name: u.full_name, role: u.role, hub: u.hub, status: u.status,
  last_login_at: u.last_login_at, created_at: u.created_at, permissions: PERMISSIONS[u.role],
});
const findUser = (db, username) => db.get("SELECT * FROM users WHERE lower(username) = lower(?)", String(username || ""));

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

// Brute-force protection: 5 failures locks the username for 5 minutes (stored in the DB, so it
// holds across serverless instances).
const LOCK_FAILS = 5;
const LOCK_MINUTES = 5;
async function login(db, username, password) {
  const key = String(username || "").toLowerCase();
  const f = await db.get(`SELECT count, last_at > now() - make_interval(mins => ?) AS recent FROM login_failures WHERE username = ?`, LOCK_MINUTES, key);
  if (f && f.recent && f.count >= LOCK_FAILS) throw httpError(429, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
  const user = await findUser(db, username);
  const ok = user && user.status === "active" && verifyPassword(password, user.password_hash);
  if (!ok) {
    await db.run(`INSERT INTO login_failures (username, count, last_at) VALUES (?, 1, now())
      ON CONFLICT (username) DO UPDATE SET count = CASE WHEN login_failures.last_at > now() - make_interval(mins => ?)
        THEN login_failures.count + 1 ELSE 1 END, last_at = now()`, key, LOCK_MINUTES);
    throw httpError(401, "Incorrect username or password");
  }
  const token = crypto.randomBytes(32).toString("hex");
  const hours = Number((await getSettings(db)).session_hours) || 12;
  await db.tx(async (t) => {
    await t.run("DELETE FROM login_failures WHERE username = ?", key);
    await t.run(`DELETE FROM sessions WHERE expires_at < ${NOW}`);
    await t.run(`INSERT INTO sessions (token_hash, username, expires_at)
      VALUES (?, ?, to_char((now() + make_interval(hours => ?)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      sha256(token), user.username, hours);
    // Session bookkeeping only; the audit trigger ignores last_login_at.
    await t.run(`UPDATE users SET last_login_at = ${NOW} WHERE username = ?`, user.username);
  });
  return { token, maxAge: hours * 3600, user: publicUser({ ...user, last_login_at: new Date().toISOString() }) };
}

async function userFromToken(db, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.get(`
    SELECT u.* FROM sessions s JOIN users u USING (username)
    WHERE s.token_hash = ? AND s.expires_at > ${NOW} AND u.status = 'active'`, sha256(token));
  return row ? publicUser(row) : null;
}
async function logout(db, token) {
  if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
}

// ---- user management (admin)
async function listUsers(db) {
  return (await db.all("SELECT * FROM users ORDER BY role DESC, username")).map(publicUser);
}
async function createUser(db, actor, body) {
  validateUsername(body.username);
  if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role");
  if (!String(body.full_name || "").trim()) throw httpError(400, "Full name is required");
  checkPasswordStrength(body.password);
  if (body.hub && !(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", body.hub))) throw httpError(400, "Unknown hub");
  if (await findUser(db, body.username)) throw httpError(409, "Username already exists");
  await withUser(db, actor.username, (t) =>
    t.run(`INSERT INTO users (username, full_name, role, hub, password_hash, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      body.username.trim(), body.full_name.trim(), body.role, body.hub || null, hashPassword(body.password), actor.username));
  return publicUser(await findUser(db, body.username));
}
async function updateUser(db, actor, username, body) {
  const u = await findUser(db, username);
  if (!u) throw httpError(404, "User not found");
  const sets = {};
  if (body.full_name !== undefined) sets.full_name = String(body.full_name).trim();
  if (body.role !== undefined) { if (!ROLES.includes(body.role)) throw httpError(400, "Invalid role"); sets.role = body.role; }
  if (body.hub !== undefined) {
    if (body.hub && !(await db.get("SELECT 1 AS x FROM hubs WHERE code = ?", body.hub))) throw httpError(400, "Unknown hub");
    sets.hub = body.hub || null;
  }
  if (body.status !== undefined) { if (!["active", "disabled"].includes(body.status)) throw httpError(400, "Invalid status"); sets.status = body.status; }
  if (body.password) { checkPasswordStrength(body.password); sets.password_hash = hashPassword(body.password); }
  if (u.username.toLowerCase() === actor.username.toLowerCase() && ((sets.role && sets.role !== "admin") || sets.status === "disabled")) {
    throw httpError(400, "You cannot remove your own admin access");
  }
  const cols = Object.keys(sets);
  if (!cols.length) return publicUser(u);
  await withUser(db, actor.username, async (t) => {
    await t.run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW} WHERE username = ?`,
      ...cols.map((c) => sets[c]), actor.username, u.username);
    if (sets.status === "disabled" || sets.password_hash) await t.run("DELETE FROM sessions WHERE username = ?", u.username);
  });
  return publicUser(await findUser(db, u.username));
}
async function changeOwnPassword(db, actor, { current_password, new_password }) {
  const u = await findUser(db, actor.username);
  if (!verifyPassword(current_password, u.password_hash)) throw httpError(400, "Current password is incorrect");
  checkPasswordStrength(new_password);
  await withUser(db, actor.username, (t) =>
    t.run(`UPDATE users SET password_hash = ?, updated_by = ?, updated_at = ${NOW} WHERE username = ?`,
      hashPassword(new_password), actor.username, u.username));
  return { ok: true };
}

module.exports = {
  ROLES, PERMISSIONS, can, requirePerm, hashPassword, verifyPassword, hasUsers, setup, login, logout, userFromToken,
  listUsers, createUser, updateUser, changeOwnPassword,
};
