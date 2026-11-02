// Payroll HTTP server.
//   Local:      npm start                   (PGlite data folder in ./data, or DATABASE_URL for Postgres)
//   Vercel:     api/index.js reuses createHandler(); static files come from /public.
// Binds to 127.0.0.1 locally unless PAYROLL_HOST is set. Cookies get the Secure flag automatically
// whenever the request arrived over HTTPS (or PAYROLL_SECURE_COOKIE=1).
const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const svc = require("./service");
const auth = require("./auth");
const reports = require("./reports");

const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" };
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:; base-uri 'none'";
const BACKUP_TABLES = ["settings", "hubs", "users", "staff", "daily_log", "weekly_log", "stock_recon", "allowances", "periods", "pay_period_summary", "audit_log"];

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...BASE_HEADERS, ...extra });
  const raw = typeof body === "string" || Buffer.isBuffer(body);
  res.end(type.startsWith("application/json") && !raw ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (req.body !== undefined) return typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); // pre-parsed by host
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw svc.httpError(413, "Request too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw svc.httpError(400, "Invalid JSON"); }
}

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
const isHttps = (req) => process.env.PAYROLL_SECURE_COOKIE === "1" || req.headers["x-forwarded-proto"] === "https" || !!req.socket?.encrypted;
function sessionCookie(req, token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, "Bad request", "text/plain"); }
  if (rel === "/" || !path.extname(rel)) rel = "/index.html"; // SPA routes
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream",
      { "Content-Security-Policy": APP_CSP, "Cache-Control": rel === "/index.html" ? "no-store" : "no-cache" });
  });
}

// dbReady: a Database or a promise of one (so a serverless cold start can begin connecting immediately).
function createHandler(dbReady) {
  let database;
  const routes = [
    ["GET", /^\/api\/health$/, null, async () => ({ ok: true, db: !!(await database.get("SELECT 1 AS ok")).ok, schema: db.SCHEMA_VERSION })],
    ["GET", /^\/api\/auth\/state$/, null, async ({ user }) => ({ needs_setup: !(await auth.hasUsers(database)), user })],
    ["POST", /^\/api\/auth\/setup$/, null, async ({ body, req, res }) => {
      const s = await auth.setup(database, body);
      res.setHeader("Set-Cookie", sessionCookie(req, s.token, s.maxAge));
      return { user: s.user };
    }],
    ["POST", /^\/api\/auth\/login$/, null, async ({ body, req, res }) => {
      const s = await auth.login(database, body.username, body.password);
      res.setHeader("Set-Cookie", sessionCookie(req, s.token, s.maxAge));
      return { user: s.user };
    }],
    ["POST", /^\/api\/auth\/logout$/, null, async ({ req, res }) => {
      await auth.logout(database, cookie(req, "sid"));
      res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
      return { ok: true };
    }],
    ["POST", /^\/api\/auth\/password$/, "auth", ({ user, body }) => auth.changeOwnPassword(database, user, body)],

    ["GET", /^\/api\/users$/, "manage_users", () => auth.listUsers(database)],
    ["POST", /^\/api\/users$/, "manage_users", ({ user, body }) => auth.createUser(database, user, body)],
    ["PUT", /^\/api\/users\/([\w.-]+)$/, "manage_users", ({ user, body, m }) => auth.updateUser(database, user, m[1], body)],

    ["GET", /^\/api\/settings$/, "read", () => db.getSettings(database)],
    ["PUT", /^\/api\/settings$/, "settings", ({ user, body }) => svc.updateSettings(database, body, user.username)],
    ["GET", /^\/api\/backup$/, "settings", async ({ user }) => {
      const out = { exported_at: new Date().toISOString(), exported_by: user.username, schema: db.SCHEMA_VERSION, tables: {} };
      for (const t of BACKUP_TABLES) {
        out.tables[t] = (await database.all(`SELECT * FROM ${t}`)).map((r) => (t === "users" ? { ...r, password_hash: undefined } : r));
      }
      await database.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by) VALUES ('backup', ?, 'download', ?)`, out.exported_at, user.username);
      return { download: JSON.stringify(out), filename: `payroll-backup-${out.exported_at.slice(0, 10)}.json`, type: "application/json; charset=utf-8" };
    }],

    ["GET", /^\/api\/(hubs|staff|daily|weekly|stock|allowances)$/, "read", ({ user, m, q }) =>
      svc.listEntries(database, m[1], { period: q.get("period") || undefined, employee_id: q.get("employee_id") || undefined,
        hub: user.hub || q.get("hub") || undefined, from: q.get("from") || undefined, to: q.get("to") || undefined })],
    ["POST", /^\/api\/hubs$/, "manage_hubs", ({ user, body }) => svc.createEntry(database, "hubs", body, user.username)],
    ["PUT", /^\/api\/hubs\/([\w-]+)$/, "manage_hubs", ({ user, body, m }) => svc.updateEntry(database, "hubs", m[1], body, user.username)],
    ["POST", /^\/api\/staff$/, ["manage_staff", "manage_team"], ({ user, body }) => svc.createEntry(database, "staff", body, user.username, user.hub)],
    ["PUT", /^\/api\/staff\/([\w.-]+)$/, ["manage_staff", "manage_team"], ({ user, body, m }) => svc.updateEntry(database, "staff", m[1], body, user.username, user.hub)],
    ["GET", /^\/api\/staff\/([\w.-]+)\/profile$/, "read", async ({ m, user }) => {
      const p = await svc.employeeProfile(database, m[1]);
      if (user.hub && p.staff.hub !== user.hub) throw svc.httpError(403, "Outside your hub");
      return p;
    }],
    ["POST", /^\/api\/(daily|weekly|stock)\/bulk$/, "enter_data", ({ user, body, m }) => svc.bulkUpsert(database, m[1], body.rows, user.username, user.hub)],
    ["POST", /^\/api\/(daily|weekly|stock|allowances)$/, "enter_data", ({ user, body, m }) => svc.createEntry(database, m[1], body, user.username, user.hub)],
    ["PUT", /^\/api\/(daily|weekly|stock|allowances)\/(\d+)$/, "enter_data", ({ user, body, m }) => svc.updateEntry(database, m[1], m[2], body, user.username, user.hub)],
    ["DELETE", /^\/api\/(daily|weekly|stock|allowances)\/(\d+)$/, "enter_data", ({ user, m }) => svc.deleteEntry(database, m[1], m[2], user.username, user.hub)],

    ["GET", /^\/api\/dashboard$/, "read", ({ user, q }) => svc.dashboard(database, q.get("period"), user.hub || q.get("hub") || undefined)],
    ["GET", /^\/api\/audit$/, "read", ({ q }) => svc.auditSearch(database, {
      table: q.get("table"), key: q.get("key"), user: q.get("user"), from: q.get("from"), to: q.get("to"), limit: q.get("limit") })],
    ["GET", /^\/api\/periods$/, "read", () => svc.listPeriods(database)],
    ["GET", /^\/api\/review-queue$/, "read", ({ user }) => svc.reviewQueue(database, user.hub)],
    ["GET", /^\/api\/reports\/balances$/, "read", async ({ user }) => (await svc.balancesReport(database)).filter((r) => !user.hub || r.hub === user.hub)],
    ["GET", /^\/api\/reports\/stock$/, "read", async ({ user, q }) => (await svc.stockReport(database, q.get("period"))).filter((r) => !user.hub || r.hub === user.hub)],
    ["GET", /^\/api\/reports\/commission$/, "read", async ({ user, q }) => (await svc.commissionReport(database, q.get("period"))).filter((r) => !user.hub || r.hub === user.hub)],

    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})$/, "read", async ({ m, user }) => {
      const p = await svc.getPeriod(database, m[1]);
      return user.hub ? { ...p, rows: p.rows.filter((r) => r.hub === user.hub) } : p;
    }],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/run$/, "run_payroll", ({ m, user }) => svc.runPeriod(database, m[1], user.username)],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/finalize$/, "finalize", ({ m, user }) => svc.finalizePeriod(database, m[1], user.username)],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/([\w.-]+)\/(approve|reject)$/, "review", ({ m, user, body }) =>
      svc.review(database, m[1], m[2], user.username, m[3] === "approve" ? "approved" : "rejected", body.note)],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/payslips(?:\/([\w.-]+))?$/, "read", async ({ m, user }) =>
      ({ html: await reports.payslipHtml(database, m[1], m[2], user.hub) })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/register$/, "read", async ({ m }) => ({ html: await reports.registerHtml(database, m[1]) })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/register\.csv$/, "export", async ({ m }) =>
      ({ csv: await reports.registerCsv(database, m[1]), filename: `payroll-register-${m[1]}.csv` })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/bank-file$/, "export", async ({ m, user }) => {
      const f = await reports.bankFile(database, m[1]);
      await database.run(`INSERT INTO audit_log (table_name, row_key, action, changed_by) VALUES ('periods', ?, 'bank_file_download', ?)`, m[1], user.username);
      return { csv: f.body, filename: f.filename };
    }],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
        return serveStatic(res, url.pathname);
      }
      database = database || (await dbReady);
      const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (!route) return send(res, 404, { error: "Not found" });
      const [method, re, perm, fn] = route;
      // Custom header forces a CORS preflight, so other sites cannot forge state-changing requests.
      if (method !== "GET" && req.headers["x-requested-with"] !== "fetch") throw svc.httpError(403, "Missing request header");
      const user = await auth.userFromToken(database, cookie(req, "sid"));
      if (perm === "auth" && !user) throw svc.httpError(401, "Please sign in");
      if (perm && perm !== "auth") auth.requirePerm(user, perm);
      const body = method === "GET" ? {} : await readJson(req);
      const out = await fn({ req, res, user, body, m: re.exec(url.pathname), q: url.searchParams });
      if (out && out.html) return send(res, 200, out.html, "text/html; charset=utf-8", { "Content-Security-Policy": REPORT_CSP });
      if (out && out.csv !== undefined) {
        return send(res, 200, "﻿" + out.csv, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="${out.filename}"` });
      }
      if (out && out.download !== undefined) {
        return send(res, 200, out.download, out.type, { "Content-Disposition": `attachment; filename="${out.filename}"` });
      }
      return send(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? "Something went wrong — please try again" : err.message });
    }
  };
}

const createServer = (database) => http.createServer(createHandler(database));

if (require.main === module) {
  const PORT = Number(process.env.PAYROLL_PORT || process.env.PORT || 8090);
  const HOST = process.env.PAYROLL_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const target = process.argv[2] || process.env.DATABASE_URL || undefined;
  db.open(target).then(async (database) => {
    createServer(database).listen(PORT, HOST, async () => {
      console.log(`Payroll running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (database: ${/^postgres/.test(target || "") ? "Postgres" : target || "data/pglite"})`);
      if (!(await auth.hasUsers(database))) console.log("No users yet — open the page to create the first admin account.");
    });
  }).catch((err) => { console.error("Could not open the database:", err.message); process.exit(1); });
}

module.exports = { createServer, createHandler };
