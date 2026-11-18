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
const loans = require("./loans");
const products = require("./products");
const sales = require("./sales");
const pos = require("./pos");
const team = require("./team");
const exporter = require("./export");
const people = require("./people");
const auth = require("./auth");
const reports = require("./reports");
const portal = require("./portal");

const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json" };
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" };
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:; base-uri 'none'";
const BACKUP_TABLES = ["settings", "hubs", "users", "staff", "daily_log", "weekly_log", "stock_recon", "hub_stock", "allowances", "loans", "loan_repayments", "products", "product_receipts", "periods", "pay_period_summary", "audit_log"];

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

// What someone who may not see pay gets from the dashboard: the sales, the shortfalls and who is late with a sheet, never pay.
function hidePay(d) {
  return {
    ...d, pay_hidden: true, last_run_at: null,
    kpis: { ...d.kpis, gross_pay: null, net_pay: null, to_bank: null, manager_balance: null, pending: 0, rejected: 0, calculated: false },
    by_hub: d.by_hub.map((h) => ({ ...h, gross_pay: null, net_pay: null, to_bank: null, manager_balance: null })),
    trend: d.trend.map((t) => ({ period: t.period, business: t.business })),
    exceptions: [],
  };
}

// Those who may not see pay do not receive the pay defaults either.
// A manager may open only the people under them (and themselves). Everyone else is limited by hub, as before.
function assertInTeam(user, employeeId) {
  if (user.teamIds && !user.teamIds.includes(String(employeeId))) throw svc.httpError(403, "That person is not in your team");
}
const visibleSettings = (user, settings) => (auth.can(user, "view_pay") ? settings : { ...settings, position_defaults: "{}" });

// A hub manager registers and edits their own team without seeing or setting pay: a new person gets the position's usual pay terms
// from Settings, and any pay field sent for someone already there is ignored.
async function staffBody(database, user, body, creating) {
  if (auth.can(user, "view_pay")) return body;
  const out = svc.withoutPayFields(body);
  if (creating) {
    let defaults = {};
    try { defaults = JSON.parse((await db.getSettings(database)).position_defaults || "{}")[out.staff_level] || {}; } catch { /* no defaults saved */ }
    for (const k of svc.PAY_FIELDS) if (defaults[k] !== undefined && k !== "opening_balance") out[k] = defaults[k];
    if (out.target === undefined && defaults.target !== undefined) out.target = defaults.target;
  }
  return out;
}

// dbReady: a Database or a promise of one (so a serverless cold start can begin connecting immediately).
function createHandler(dbReady) {
  let database;
  const routes = [
    ["GET", /^\/api\/health$/, null, async () => ({ ok: true, db: !!(await database.get("SELECT 1 AS ok")).ok, schema: db.SCHEMA_VERSION })],
    ["GET", /^\/api\/auth\/state$/, null, async ({ user }) => {
      const settings = await db.getSettings(database);
      const out = { needs_setup: !(await auth.hasUsers(database)), user, company_name: settings.company_name };
      // Everything the shell needs to draw itself, so start-up is one round trip instead of three.
      if (user && (auth.can(user, "read") || auth.can(user, "read_team"))) {
        out.hubs = await svc.listEntries(database, "hubs", { hub: user.hub || undefined });
        out.settings = visibleSettings(user, settings);
      }
      return out;
    }],
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

    // Staff portal: a signed-in distributor, supervisor or group manager sees only their own figures.
    ["GET", /^\/api\/me\/portal$/, "self", ({ user, q }) => portal.summary(database, user, q.get("period") || new Date().toISOString().slice(0, 7))],
    ["GET", /^\/api\/me\/payslip\/(\d{4}-\d{2})$/, "self", async ({ user, m }) => ({ html: await portal.payslip(database, user, m[1]) })],
    ["GET", /^\/api\/me\/report\.pdf$/, "self", async ({ user, q }) => {
      const f = exporter.personReportPdf(await portal.summary(database, user, q.get("period") || new Date().toISOString().slice(0, 7)), { canPay: true, company: (await db.getSettings(database)).company_name || "" });
      return { download: f.data, type: f.type, filename: f.filename };
    }],
    // One person's report: the admin sees pay; a hub manager sees sales only, and only their own hub.
    ["GET", /^\/api\/staff\/([\w.-]+)\/report\.pdf$/, ["read", "read_team"], async ({ m, user, q }) => {
      assertInTeam(user, m[1]);
      const d = await portal.forEmployee(database, m[1], q.get("period") || new Date().toISOString().slice(0, 7), user.hub);
      const f = exporter.personReportPdf(d, { canPay: auth.can(user, "view_pay"), company: (await db.getSettings(database)).company_name || "" });
      return { download: f.data, type: f.type, filename: f.filename };
    }],
    // Selling like a till: the seller's own screen (their stock, today's sales, the end-of-day cash).
    ["GET", /^\/api\/me\/pos$/, "self", ({ user }) => pos.state(database, user)],
    ["POST", /^\/api\/me\/pos\/sell$/, "self", ({ user, body }) => pos.sell(database, user, body)],
    ["DELETE", /^\/api\/me\/pos\/sale\/(\d+)$/, "self", ({ user, m }) => pos.undo(database, user, m[1])],
    ["POST", /^\/api\/me\/pos\/day$/, "self", ({ user, body }) => pos.endOfDay(database, user, body)],
    // The office gives each seller their stock for the day.
    // The office sends stock to a hub (admin); a coacher or stock keeper sees what their own hub holds.
    ["GET", /^\/api\/hub-stock$/, "stock", ({ user, q }) => pos.hubSupply(database, { hub: user.hub || q.get("hub") || undefined })],
    ["GET", /^\/api\/stock-overview$/, "stock", ({ user, q }) => pos.stockOverview(database, { hub: user.hub || q.get("hub"), date: q.get("date") })],
    ["POST", /^\/api\/hub-stock$/, "manage_products", ({ user, body }) => pos.giveToHub(database, user, body)],
    ["DELETE", /^\/api\/hub-stock\/(\d+)$/, "manage_products", ({ user, m }) => pos.takeFromHub(database, user, m[1])],
    ["GET", /^\/api\/stock-issues$/, "stock", ({ user, q }) => pos.morning(database, { date: q.get("date") || undefined, hub: user.hub || q.get("hub") || undefined })],
    ["POST", /^\/api\/stock-issues\/bulk$/, "stock", ({ user, body }) => pos.giveMany(database, user, body, user.hub)],
    ["POST", /^\/api\/stock-issues$/, "stock", ({ user, body }) => pos.give(database, user, body, user.hub)],
    ["DELETE", /^\/api\/stock-issues\/(\d+)$/, "stock", ({ user, m }) => pos.takeBack(database, user, m[1], user.hub)],
    ["POST", /^\/api\/me\/sales$/, "self", ({ user, body }) => sales.addSale(database, user, body)],
    ["DELETE", /^\/api\/me\/sales\/(\d{4}-\d{2}-\d{2})$/, "self", ({ user, m }) => sales.removeSale(database, user, m[1])],
    ["GET", /^\/api\/me\/documents$/, "self", ({ user }) => portal.listDocuments(database, user)],
    ["POST", /^\/api\/me\/documents$/, "self", ({ user, body }) => portal.addDocument(database, user, body)],
    ["GET", /^\/api\/me\/documents\/(\d+)$/, "self", async ({ user, m }) => {
      const d = await portal.getDocument(database, user, m[1]);
      return { file: d.buffer, type: d.mime, filename: d.file_name };
    }],

    ["GET", /^\/api\/users$/, "manage_users", () => auth.listUsers(database)],
    ["POST", /^\/api\/users$/, "manage_users", ({ user, body }) => auth.createUser(database, user, body)],
    ["PUT", /^\/api\/users\/([\w.-]+)$/, "manage_users", ({ user, body, m }) => auth.updateUser(database, user, m[1], body)],

    ["GET", /^\/api\/settings$/, ["read", "read_team"], async ({ user }) => visibleSettings(user, await db.getSettings(database))],
    ["PUT", /^\/api\/settings$/, "settings", ({ user, body }) => svc.updateSettings(database, body, user.username)],
    ["GET", /^\/api\/backup$/, "settings", async ({ user }) => {
      const out = { exported_at: new Date().toISOString(), exported_by: user.username, schema: db.SCHEMA_VERSION, tables: {} };
      for (const t of BACKUP_TABLES) {
        out.tables[t] = (await database.all(`SELECT * FROM ${t}`)).map((r) => (t === "users" ? { ...r, password_hash: undefined } : r));
      }
      await db.logEvent(database, { user: user.username, table: "backup", key: out.exported_at, action: "download" });
      return { download: JSON.stringify(out), filename: `payroll-backup-${out.exported_at.slice(0, 10)}.json`, type: "application/json; charset=utf-8" };
    }],

    ["GET", /^\/api\/(hubs|staff)$/, ["read", "read_team"], ({ user, m, q }) =>
      svc.listEntries(database, m[1], { period: q.get("period") || undefined, employee_id: q.get("employee_id") || undefined,
        hub: user.hub || q.get("hub") || undefined, from: q.get("from") || undefined, to: q.get("to") || undefined })
        .then((rows) => (m[1] === "staff" && user.teamIds ? rows.filter((r) => user.teamIds.includes(r.employee_id)) : rows))
        .then((rows) => (m[1] === "staff" && !auth.can(user, "view_pay") ? rows.map(svc.withoutPayFields) : rows))],
    ["GET", /^\/api\/(daily|weekly|stock|hubstock|allowances)$/, "read", ({ user, m, q }) =>
      svc.listEntries(database, m[1], { period: q.get("period") || undefined, employee_id: q.get("employee_id") || undefined,
        hub: user.hub || q.get("hub") || undefined, from: q.get("from") || undefined, to: q.get("to") || undefined })
        .then((rows) => (m[1] === "staff" && !auth.can(user, "view_pay") ? rows.map(svc.withoutPayFields) : rows))],
    ["POST", /^\/api\/hubs$/, "manage_hubs", ({ user, body }) => svc.createEntry(database, "hubs", body, user.username)],
    ["PUT", /^\/api\/hubs\/([\w-]+)$/, "manage_hubs", ({ user, body, m }) => svc.updateEntry(database, "hubs", m[1], body, user.username)],
    ["POST", /^\/api\/staff$/, ["manage_staff", "manage_team"], async ({ user, body }) => svc.createEntry(database, "staff", await staffBody(database, user, body, true), user.username, user.hub)],
    ["PUT", /^\/api\/staff\/([\w.-]+)$/, ["manage_staff", "manage_team"], async ({ user, body, m }) => svc.updateEntry(database, "staff", m[1], await staffBody(database, user, body, false), user.username, user.hub)],
    ["GET", /^\/api\/staff\/([\w.-]+)\/profile$/, ["read", "read_team"], async ({ m, user }) => {
      assertInTeam(user, m[1]);
      const p = await svc.employeeProfile(database, m[1]);
      if (user.hub && p.staff.hub !== user.hub) throw svc.httpError(403, "Outside your hub");
      return auth.can(user, "view_pay") ? p : { ...p, staff: svc.withoutPayFields(p.staff), history: [], security_held: null }; // no pay terms or pay history for those who may not see pay
    }],
    ["GET", /^\/api\/staff\/([\w.-]+)\/documents$/, ["manage_staff", "manage_team"], ({ m, user }) => svc.listDocuments(database, m[1], user.hub)],
    ["POST", /^\/api\/staff\/([\w.-]+)\/documents$/, ["manage_staff", "manage_team"], ({ m, user, body }) => svc.addDocument(database, m[1], body, user.username, user.hub)],
    ["GET", /^\/api\/documents\/(\d+)$/, ["manage_staff", "manage_team"], async ({ m, user }) => {
      const d = await svc.getDocument(database, m[1], user.hub);
      return { file: d.buffer, type: d.mime, filename: d.file_name };
    }],
    ["DELETE", /^\/api\/documents\/(\d+)$/, ["manage_staff", "manage_team"], ({ m, user }) => svc.deleteDocument(database, m[1], user.username, user.hub)],
    ["POST", /^\/api\/(daily|weekly|stock|hubstock)\/bulk$/, "enter_data", ({ user, body, m }) => svc.bulkUpsert(database, m[1], body.rows, user.username, user.hub)],
    ["POST", /^\/api\/(daily|weekly|stock|hubstock|allowances)$/, "enter_data", ({ user, body, m }) => svc.createEntry(database, m[1], body, user.username, user.hub)],
    ["PUT", /^\/api\/(daily|weekly|stock|hubstock|allowances)\/(\d+)$/, "enter_data", ({ user, body, m }) => svc.updateEntry(database, m[1], m[2], body, user.username, user.hub)],
    ["DELETE", /^\/api\/(daily|weekly|stock|hubstock|allowances)\/(\d+)$/, "enter_data", ({ user, m }) => svc.deleteEntry(database, m[1], m[2], user.username, user.hub)],

    // Live sales: everyone who can read sees the sales; only those who may see pay get the commission and pay-so-far columns.
    ["GET", /^\/api\/live$/, ["read", "read_team"], ({ user, q }) => sales.live(database, { period: q.get("period") || new Date().toISOString().slice(0, 7), hub: user.hub || q.get("hub") || undefined, ids: user.teamIds }, auth.can(user, "view_pay"))],
    // A manager's own people: their sales, today's sales and the stock they hold.
    ["GET", /^\/api\/team$/, "read_team", ({ user, q }) => team.overview(database, user, q.get("period") || new Date().toISOString().slice(0, 7))],
    ["POST", /^\/api\/sales\/confirm$/, "enter_data", ({ user, body }) => sales.confirm(database, user, body, user.hub)],
    ["GET", /^\/api\/products\/names$/, "enter_data", () => products.names(database)],
    ["GET", /^\/api\/products$/, "manage_products", () => products.list(database)],
    ["POST", /^\/api\/products$/, "manage_products", ({ user, body }) => products.create(database, body, user.username)],
    ["GET", /^\/api\/products\/(\d+)\/stock$/, "manage_products", ({ m }) => products.stockHistory(database, m[1])],
    ["POST", /^\/api\/products\/(\d+)\/stock$/, "manage_products", ({ user, body, m }) => products.addStock(database, m[1], body, user.username)],
    ["DELETE", /^\/api\/product-stock\/(\d+)$/, "manage_products", ({ user, m }) => products.removeStock(database, m[1], user.username)],
    ["PUT", /^\/api\/products\/(\d+)$/, "manage_products", ({ user, body, m }) => products.update(database, m[1], body, user.username)],
    ["GET", /^\/api\/reports\/product-profit$/, "manage_products", ({ q }) => products.profitReport(database, q.get("period"))],
    ["POST", /^\/api\/staff\/([\w.-]+)\/leave$/, ["manage_staff", "manage_team"], ({ user, body, m }) => people.leave(database, m[1], body, user.username, user.hub)],
    ["POST", /^\/api\/staff\/([\w.-]+)\/rehire$/, ["manage_staff", "manage_team"], ({ user, body, m }) => people.rehire(database, m[1], body, user.username, user.hub)],
    ["GET", /^\/api\/loans$/, "read", ({ user, q }) => loans.list(database, { employee_id: q.get("employee_id") || undefined,
      hub: user.hub || q.get("hub") || undefined, status: q.get("status") || undefined, period: q.get("period") || undefined })],
    ["POST", /^\/api\/loans$/, "manage_loans", ({ user, body }) => loans.create(database, body, user.username, user.hub)],
    ["PUT", /^\/api\/loans\/(\d+)$/, "manage_loans", ({ user, body, m }) => loans.update(database, m[1], body, user.username, user.hub)],
    ["DELETE", /^\/api\/loans\/(\d+)$/, "manage_loans", ({ user, m }) => loans.remove(database, m[1], user.username, user.hub)],

    ["GET", /^\/api\/dashboard$/, "read", async ({ user, q }) => {
      const d = await svc.dashboard(database, q.get("period"), user.hub || q.get("hub") || undefined);
      return auth.can(user, "view_pay") ? d : hidePay(d);
    }],
    // The audit trail: the admin sees everything; others do not see pay approvals or sign-ins and downloads, and a hub user only their own actions.
    ["GET", /^\/api\/audit$/, "read", ({ user, q }) => svc.auditSearch(database, {
      table: q.get("table"), key: q.get("key"), user: user.hub ? user.username : q.get("user"), from: q.get("from"), to: q.get("to"), action: q.get("action"), limit: q.get("limit"),
      noPay: !auth.can(user, "view_pay"), noAccess: !auth.can(user, "manage_users") })],
    ["GET", /^\/api\/periods$/, "read", async ({ user }) => {
      const rows = await svc.listPeriods(database);
      return auth.can(user, "view_pay") ? rows : rows.map(({ to_bank, net_pay, ...rest }) => rest);
    }],
    ["GET", /^\/api\/review-queue$/, "view_pay", ({ user }) => svc.reviewQueue(database, user.hub)],
    ["GET", /^\/api\/reports\/balances$/, "view_pay", async ({ user }) => (await svc.balancesReport(database)).filter((r) => !user.hub || r.hub === user.hub)],
    ["GET", /^\/api\/reports\/stock$/, "read", async ({ user, q }) => (await svc.stockReport(database, q.get("period"))).filter((r) => !user.hub || r.hub === user.hub)],
    ["GET", /^\/api\/reports\/commission$/, "view_pay", async ({ user, q }) => (await svc.commissionReport(database, q.get("period"))).filter((r) => !user.hub || r.hub === user.hub)],

    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})$/, "view_pay", async ({ m, user, q }) => {
      const p = await svc.getPeriod(database, m[1], { detail: q.get("slim") !== "1" }); // ?slim=1 leaves out each person's full working
      return user.hub ? { ...p, rows: p.rows.filter((r) => r.hub === user.hub) } : p;
    }],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/run$/, "run_payroll", ({ m, user }) => svc.runPeriod(database, m[1], user.username)],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/finalize$/, "finalize", ({ m, user }) => svc.finalizePeriod(database, m[1], user.username)],
    ["POST", /^\/api\/payroll\/(\d{4}-\d{2})\/([\w.-]+)\/(approve|reject)$/, "review", ({ m, user, body }) =>
      svc.review(database, m[1], m[2], user.username, m[3] === "approve" ? "approved" : "rejected", body.note)],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/payslips(?:\/([\w.-]+))?\.pdf$/, "view_pay", async ({ m, user }) => {
      const f = await exporter.payslipsPdf(database, m[1], m[2], user.hub);
      return { download: f.data, type: f.type, filename: f.filename };
    }],
    ["GET", /^\/api\/export\/([a-z-]+)\.(xlsx|pdf)$/, "read", async ({ m, user, q }) => {
      const f = await exporter.make(database, m[1], m[2], { can: (p) => auth.can(user, p), hub: user.hub || q.get("hub") || undefined, period: q.get("period") || undefined, query: q, username: user.username });
      return { download: f.data, type: f.type, filename: f.filename };
    }],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/payslips(?:\/([\w.-]+))?$/, "view_pay", async ({ m, user }) =>
      ({ html: await reports.payslipHtml(database, m[1], m[2], user.hub) })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/register$/, "view_pay", async ({ m }) => ({ html: await reports.registerHtml(database, m[1]) })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/register\.csv$/, "export", async ({ m }) =>
      ({ csv: await reports.registerCsv(database, m[1]), filename: `payroll-register-${m[1]}.csv` })],
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/bank-file$/, "export", async ({ m, user }) => {
      const f = await reports.bankFile(database, m[1]);
      await db.logEvent(database, { user: user.username, table: "periods", key: m[1], action: "bank_file_download" });
      return { csv: f.body, filename: f.filename };
    }],
    // One person's full working. Listed last so it never shadows /register, /payslips or /bank-file.
    ["GET", /^\/api\/payroll\/(\d{4}-\d{2})\/([\w.-]+)$/, "view_pay", ({ m, user }) => svc.getPeriodRow(database, m[1], m[2], user.hub)],
  ];

  // Every request runs with its address and browser, so each audit row (including those the database writes itself) can say where it came from.
  return function handler(req, res) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ctx = { ip: (forwarded || req.socket?.remoteAddress || "").replace(/^::ffff:/, "").slice(0, 64), agent: String(req.headers["user-agent"] || "").slice(0, 220) };
    return db.requestContext.run(ctx, () => handle(req, res));
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    let who = null;
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
      who = user?.username || null;
      if (perm === "auth" && !user) throw svc.httpError(401, "Please sign in");
      if (perm && perm !== "auth") auth.requirePerm(user, perm);
      const body = method === "GET" ? {} : await readJson(req);
      const out = await fn({ req, res, user, body, m: re.exec(url.pathname), q: url.searchParams });
      await recordUse(database, method, url, user);
      if (out && out.html) return send(res, 200, out.html, "text/html; charset=utf-8", { "Content-Security-Policy": REPORT_CSP });
      if (out && out.csv !== undefined) {
        return send(res, 200, "﻿" + out.csv, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="${out.filename}"` });
      }
      if (out && out.file !== undefined) {
        // An uploaded scan: shown in the browser, but never allowed to run scripts or load anything.
        return send(res, 200, out.file, out.type, { "Content-Disposition": `inline; filename="${encodeURIComponent(out.filename)}"`,
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; sandbox" });
      }
      if (out && out.download !== undefined) {
        return send(res, 200, out.download, out.type, { "Content-Disposition": `attachment; filename="${out.filename}"` });
      }
      return send(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      // Someone signed in asked for something their role does not allow: worth knowing, once in a while.
      if (status === 403 && who && database) {
        await db.logEvent(database, { user: who, table: "session", key: who, action: "denied", detail: { path: url.pathname, method: req.method }, dedupeMinutes: 5 }).catch(() => {});
      }
      send(res, status, { error: status === 500 ? "Something went wrong — please try again" : err.message });
    }
  }
}

// Reading is use too: who exported a report, opened someone's payslip or the payroll, or looked at a scanned document. A change is already in
// the trail through the database; this adds what a change cannot show. A failure to write the line never blocks the request.
const USE = [
  [/^\/api\/export\/([a-z-]+)\.(xlsx|pdf)$/, (m, q) => ({ table: "export", action: "export", key: `${m[1]}.${m[2]}`, detail: { period: q.get("period") || undefined, hub: q.get("hub") || undefined } })],
  [/^\/api\/staff\/([\w.-]+)\/report\.pdf$/, (m, q) => ({ table: "export", action: "export", key: `report.pdf ${m[1]} ${q.get("period") || ""}`.trim() })],
  [/^\/api\/me\/report\.pdf$/, (m, q) => ({ table: "export", action: "export", key: `my report.pdf ${q.get("period") || ""}`.trim() })],
  [/^\/api\/payroll\/(\d{4}-\d{2})\/payslips(?:\/([\w.-]+))?\.pdf$/, (m) => ({ table: "export", action: "export", key: `payslips.pdf ${m[1]}${m[2] ? " " + m[2] : ""}` })],
  [/^\/api\/payroll\/(\d{4}-\d{2})\/register(\.csv)?$/, (m) => ({ table: "export", action: m[2] ? "export" : "view", key: `register${m[2] || ""} ${m[1]}`, detail: { period: m[1] } })],
  [/^\/api\/payroll\/(\d{4}-\d{2})\/payslips(?:\/([\w.-]+))?$/, (m) => ({ table: "view", action: "view", key: `payslips ${m[1]}${m[2] ? " " + m[2] : ""}`, dedupeMinutes: 10 })],
  [/^\/api\/payroll\/(\d{4}-\d{2})$/, (m) => ({ table: "view", action: "view", key: `payroll ${m[1]}`, dedupeMinutes: 10 })],
  [/^\/api\/payroll\/(\d{4}-\d{2})\/([\w.-]+)$/, (m) => (m[2] === "register" || m[2] === "payslips" || m[2] === "bank-file" ? null : { table: "view", action: "view", key: `payroll ${m[1]} ${m[2]}`, dedupeMinutes: 10 })],
  [/^\/api\/reports\/(commission|balances)$/, (m) => ({ table: "view", action: "view", key: `report ${m[1]}`, dedupeMinutes: 10 })],
  [/^\/api\/(?:me\/)?documents\/(\d+)$/, (m) => ({ table: "staff_documents", action: "view", key: `document ${m[1]}`, dedupeMinutes: 10 })],
];
async function recordUse(database, method, url, user) {
  if (method !== "GET" || !user) return;
  for (const [re, make] of USE) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    const e = make(m, url.searchParams);
    if (!e) return;
    try { await db.logEvent(database, { user: user.username, ...e }); } catch (err) { console.error("audit:", err.message); }
    return;
  }
}

const createServer = (database) => http.createServer(createHandler(database));

if (require.main === module) {
  const PORT = Number(process.argv[3] || process.env.PAYROLL_PORT || process.env.PORT || 8090);
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
