#!/usr/bin/env node
// Mobile audit: signs in as each kind of user, opens every page it can reach at phone size, and reports the mistakes a design reviewer would find.
//
//   node tools/audit-mobile.js                                  all roles, phone size, the local demo on http://localhost:8090
//   node tools/audit-mobile.js --base=https://your-site        another address
//   node tools/audit-mobile.js --roles=admin,pavan              only some logins
//   node tools/audit-mobile.js --viewport=laptop                1366x768 instead of a phone (also: tablet)
//   node tools/audit-mobile.js --theme=dark                     also: contrast, dark-contrast (the device's dark and increase-contrast settings)
//   node tools/audit-mobile.js --max=40                         most pages per login (default 60)
//   node tools/audit-mobile.js --extra=/me/payslips/2026-09    also open pages the menus do not link to
//
// It only opens pages; it never presses buttons, so it is safe to run on live data. Output: audit-report/index.html (open it in a browser), plus report.json.
// Checks per page: sideways scrolling, buttons and links under 44 px, text under 14 px, clipped text, WCAG 2.1 AA problems (colour contrast, labels,
// names, headings, landmarks: axe-core), errors in the console, failed requests, slow loads, and a screenshot.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const BASE = arg("base", "http://localhost:8090").replace(/\/$/, "");
const VIEW = { phone: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, laptop: { width: 1366, height: 768, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } }[arg("viewport", "phone")];
const MAX = Number(arg("max", 60));
const THEME = arg("theme", "light"); // light | dark | contrast (device "increase contrast") | dark-contrast
const OUT = path.join(__dirname, "..", "audit-report");

// Demo logins (the local demo and the live demo). Override with AUDIT_USERS='[{"name":"admin","user":"admin","pass":"..."}]'.
const USERS = process.env.AUDIT_USERS ? JSON.parse(process.env.AUDIT_USERS) : [
  { name: "admin", user: "admin", pass: "admin123", kind: "Admin" },
  { name: "coacher1", user: "coacher1", pass: "staff123", kind: "Coacher" },
  { name: "manager1", user: "manager1", pass: "manager123", kind: "Manager" },
  { name: "manager4", user: "manager4", pass: "manager123", kind: "Manager (stock keeper)" },
  { name: "pavan", user: "pavan", pass: "staff123", kind: "Seller (distributor)" },
  { name: "kavin", user: "kavin", pass: "staff123", kind: "Seller (supervisor)" },
];
const only = arg("roles", "").split(",").filter(Boolean);
const users = only.length ? USERS.filter((u) => only.includes(u.name)) : USERS;

const chromePath = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => fs.existsSync(p));
if (!chromePath) { console.error("Chrome was not found. Set CHROME_PATH to its location."); process.exit(2); }

const SEV = { critical: 0, major: 1, minor: 2 };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "home";

// Runs inside the page: the layout checks.
function inPage(minTap) {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !e.closest("[hidden],.sr-only"); };
  const label = (e) => { const t = (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || e.name || "").replace(/\s+/g, " ").trim().slice(0, 40); return `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${t ? ` "${t}"` : ""}`; };
  const out = { wide: [], tap: [], small: [], clipped: [], noname: [], images: [] };
  const vw = document.documentElement.clientWidth;
  out.scrollW = document.documentElement.scrollWidth; out.vw = vw;
  if (out.scrollW > vw + 1) for (const e of document.querySelectorAll("#view *, .topbar *, .bottom-nav *")) { const r = e.getBoundingClientRect(); if (r.right > vw + 1 && r.width > 0 && vis(e) && !e.closest(".table-wrap,.tabs,.ws-tabs,.ws-sub,[style*=overflow]")) { out.wide.push(label(e) + ` (right edge ${Math.round(r.right)}px)`); if (out.wide.length >= 6) break; } }
  const seen = new Set();
  for (const e of document.querySelectorAll("a[href], button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, summary, [role=button], [role=tab]")) {
    if (!vis(e) || e.closest("thead")) continue;
    const r = e.getBoundingClientRect();
    if (r.height < minTap - 0.5 || (r.width < minTap - 0.5 && e.tagName !== "INPUT" && e.tagName !== "SELECT")) {
      const k = label(e) + Math.round(r.height); if (seen.has(k)) continue; seen.add(k);
      out.tap.push(`${label(e)} is ${Math.round(r.width)}×${Math.round(r.height)} px`);
    }
    if (!(e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || (e.textContent || "").trim() || e.getAttribute("title") || e.labels?.length || e.getAttribute("placeholder") || e.querySelector("img[alt]:not([alt=''])"))) out.noname.push(label(e));
  }
  const tcount = {};
  for (const e of document.querySelectorAll("#view *, .topbar *, .bottom-nav *")) {
    if (e.children.length || !(e.textContent || "").trim() || !vis(e) || e.classList.contains("avatar") || e.closest(".avatar,.badge,.sr-only,.bottom-nav,.portal-tabs")) continue;
    const f = parseFloat(getComputedStyle(e).fontSize);
    if (f < 14) { const k = `${e.tagName.toLowerCase()}.${(e.className || "").toString().split(" ")[0]} ${f}px`; tcount[k] = (tcount[k] || 0) + 1; }
    if ((e.scrollWidth > e.clientWidth + 2) && getComputedStyle(e).overflow !== "visible" && e.clientWidth > 0) out.clipped.push(`${label(e)} is cut off`);
  }
  out.small = Object.entries(tcount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} × ${n}`);
  out.clipped = out.clipped.slice(0, 6);
  for (const img of document.querySelectorAll("img")) if (vis(img) && !img.hasAttribute("alt")) out.images.push(label(img));
  out.h1 = document.querySelectorAll("#view h1").length;
  return out;
}

async function waitReady(page) {
  await page.waitForFunction(() => { const v = document.querySelector("#view"); return v && !v.querySelector(".loading-screen,.spinner") && v.children.length > 0; }, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function run() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const report = { base: BASE, viewport: arg("viewport", "phone"), when: new Date().toISOString(), roles: [] };
  const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

  for (const u of users) {
    const role = { name: u.name, kind: u.kind || u.name, pages: [], error: null };
    report.roles.push(role);
    const ctx = await browser.newContext({ viewport: { width: VIEW.width, height: VIEW.height }, isMobile: VIEW.isMobile, hasTouch: VIEW.hasTouch, deviceScaleFactor: VIEW.deviceScaleFactor, colorScheme: /dark/.test(THEME) ? "dark" : "light", contrast: /contrast/.test(THEME) ? "more" : "no-preference" });
    const page = await ctx.newPage();
    let consoleErrs = [], failed = [];
    page.on("console", (m) => { if (m.type() === "error" && !/vibrate|favicon/i.test(m.text())) consoleErrs.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => consoleErrs.push("Script error: " + String(e.message).slice(0, 160)));
    page.on("response", (r) => { const s = r.status(); if (s >= 400 && r.url().startsWith(BASE) && !/\/api\/auth\/(state|logout)/.test(r.url()) && !(s === 401)) failed.push(`${s} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
    try {
      process.stdout.write(`\n${u.name} (${role.kind}) `);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("input", { timeout: 30000 });
      const inputs = await page.$$("form input");
      await inputs[0].fill(u.user); await inputs[1].fill(u.pass);
      await Promise.all([page.waitForSelector("#view", { timeout: 60000 }), page.keyboard.press("Enter")]);
      await waitReady(page);
      // find the pages this login can reach: its menu, bottom bar, tabs and links
      const queue = [new URL(page.url()).pathname, ...arg("extra", "").split(",").filter(Boolean)]; const done = new Set();
      while (queue.length && done.size < MAX) {
        const p = queue.shift(); if (done.has(p)) continue; done.add(p);
        consoleErrs = []; failed = [];
        const t0 = Date.now();
        let loaded = true;
        try { await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 60000 }); await waitReady(page); } catch { loaded = false; }
        const ms = Date.now() - t0;
        const title = await page.title().catch(() => p);
        const issues = [];
        const add = (sev, area, msg, fix) => issues.push({ sev, area, msg, fix });
        if (!loaded) add("critical", "Loading", "The page did not finish loading within 60 seconds", "Check the server and the request that hangs");
        const text = await page.evaluate(() => document.querySelector("#view")?.innerText.slice(0, 200) || "");
        if (/couldn.t load this page|something went wrong/i.test(text)) add("critical", "Loading", "The page shows an error message instead of its content", "Open the browser console and the failed request listed below");
        if (/no access/i.test(text.split("\n")[0] || "")) add("minor", "Access", "A menu link leads to a 'No access' page for this login", "Hide the link for this role, or allow the page");
        const r = await page.evaluate(inPage, 44);
        if (r.wide.length) add("critical", "Layout", `The page scrolls sideways (content ${r.scrollW}px wide on a ${r.vw}px screen). Widest: ${r.wide.slice(0, 3).join("; ")}`, "Make the widest element wrap or scroll inside its own box");
        if (r.tap.length) add("major", "Touch targets", `${r.tap.length} control${r.tap.length > 1 ? "s are" : " is"} smaller than 44×44 px: ${r.tap.slice(0, 4).join("; ")}${r.tap.length > 4 ? "…" : ""}`, "Give buttons and links a 44 px minimum height");
        if (r.noname.length) add("major", "Accessibility", `${r.noname.length} control${r.noname.length > 1 ? "s have" : " has"} no name a screen reader can read: ${r.noname.slice(0, 3).join("; ")}`, "Add a visible label or an aria-label");
        if (r.small.length) add("minor", "Readability", `Text under 14 px: ${r.small.slice(0, 4).join("; ")}`, "Use at least 14 px for anything people must read");
        if (r.clipped.length) add("major", "Layout", `Text is cut off: ${r.clipped.slice(0, 3).join("; ")}`, "Let the text wrap, or shorten it");
        if (r.images.length) add("major", "Accessibility", `${r.images.length} image${r.images.length > 1 ? "s have" : " has"} no alt text`, "Add alt text, or alt=\"\" for decoration");
        if (r.h1 !== 1) add("minor", "Structure", r.h1 ? `${r.h1} main headings on one page` : "The page has no main heading (h1)", "Use exactly one h1 per page");
        // WCAG 2.1 AA with axe-core
        try {
          await page.evaluate(axeSrc);
          const ax = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => (n.target || []).join(" ").slice(0, 70)), why: (v.nodes[0]?.any?.[0]?.message || v.nodes[0]?.failureSummary || "").replace(/\s+/g, " ").slice(0, 140) })));
          for (const v of ax) add(v.impact === "critical" || v.impact === "serious" ? "critical" : v.impact === "moderate" ? "major" : "minor", "WCAG · " + v.id, `${v.help} (${v.n} place${v.n > 1 ? "s" : ""}). ${v.why} e.g. ${v.sample.join(" | ")}`, "https://dequeuniversity.com/rules/axe/4.10/" + v.id);
        } catch (e) { add("minor", "WCAG", "The accessibility scan could not run: " + String(e.message).slice(0, 80)); }
        if (consoleErrs.length) add("major", "Console", `${consoleErrs.length} error${consoleErrs.length > 1 ? "s" : ""} in the browser console: ${[...new Set(consoleErrs)].slice(0, 2).join(" | ")}`, "Fix the script error");
        if (failed.length) add("major", "Network", `Failed requests: ${[...new Set(failed)].slice(0, 4).join("; ")}`, "Check the server log for these requests");
        if (ms > 4000) add("minor", "Speed", `Took ${(ms / 1000).toFixed(1)} s to open`, "Check how many requests the page makes and how big they are");
        const shot = `shots/${slug(u.name)}-${slug(p)}.png`;
        await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
        issues.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
        role.pages.push({ path: p, title, ms, shot, issues });
        process.stdout.write(issues.some((i) => i.sev === "critical") ? "x" : issues.length ? "!" : ".");
        // links to follow: menu, tabs, bottom bar, links inside the page
        const links = await page.evaluate(() => [...document.querySelectorAll("a[data-link][href]")].map((a) => a.getAttribute("href")).filter((h) => h && h.startsWith("/") && !h.startsWith("/api/") && !h.includes("#") && !/\.(pdf|csv|xlsx)/i.test(h)));
        for (const l of links) { const clean = l.split("?")[0]; if (!done.has(clean) && !queue.includes(clean) && !/^\/employees\/[^/]+$/.test(clean) || (/^\/employees\/[^/]+$/.test(clean) && ![...done].some((d) => /^\/employees\/[^/]+$/.test(d)) && !queue.includes(clean))) queue.push(clean); }
      }
    } catch (e) { role.error = String(e.message).slice(0, 200); console.error(`\n${u.name}: ${role.error}`); }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  writeHtml(report);
  const all = report.roles.flatMap((r) => r.pages.flatMap((p) => p.issues));
  const n = (s) => all.filter((i) => i.sev === s).length;
  console.log(`\n\nPages checked: ${report.roles.reduce((t, r) => t + r.pages.length, 0)}   Critical: ${n("critical")}   Major: ${n("major")}   Minor: ${n("minor")}`);
  console.log("Report: " + path.join(OUT, "index.html"));
  process.exit(n("critical") ? 1 : 0);
}

function writeHtml(report) {
  const badge = (s) => `<span class="b ${s}">${s}</span>`;
  const all = report.roles.flatMap((r) => r.pages.flatMap((p) => p.issues));
  const cnt = (s) => all.filter((i) => i.sev === s).length;
  const byArea = {};
  for (const i of all) { const k = i.area.replace(/ ·.*/, ""); byArea[k] = (byArea[k] || 0) + 1; }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mobile audit</title>
<style>
body{font:15px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#f4f6fb;color:#0f172a}
header{background:#1e3a8a;color:#fff;padding:24px 28px}header h1{margin:0 0 4px;font-size:24px}header p{margin:0;opacity:.85}
main{max-width:1180px;margin:0 auto;padding:20px}
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 20px}
.card{background:#fff;border:1px solid #dbe2ee;border-radius:12px;padding:16px}.sum .card b{display:block;font-size:28px}
.b{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.critical{background:#fde2e2;color:#9b1c1c}.major{background:#ffedd5;color:#9a4a00}.minor{background:#e0e7ff;color:#3730a3}
h2{margin:28px 0 10px}details.role{margin:0 0 14px}details.role>summary{cursor:pointer;font-size:18px;font-weight:700;padding:12px 16px;background:#fff;border:1px solid #dbe2ee;border-radius:12px}
.page{display:grid;grid-template-columns:200px 1fr;gap:18px;padding:16px;margin:10px 0;background:#fff;border:1px solid #dbe2ee;border-radius:12px}
.page img{width:200px;border:1px solid #dbe2ee;border-radius:8px;max-height:420px;object-fit:cover;object-position:top}
.page h3{margin:0 0 2px;font-size:16px}.path{color:#64748b;font-size:13px;margin-bottom:8px}
ul{margin:0;padding:0;list-style:none}li{padding:8px 0;border-top:1px solid #edf0f6}li small{display:block;color:#64748b}
.ok{color:#166534;font-weight:600}
@media(max-width:760px){.page{grid-template-columns:1fr}.page img{width:100%;max-height:300px}}
</style>
<header><h1>Mobile audit</h1><p>${esc(report.base)} · ${esc(report.viewport)} · ${esc(new Date(report.when).toLocaleString())}</p></header><main>
<div class="sum"><div class="card"><b>${report.roles.reduce((t, r) => t + r.pages.length, 0)}</b>pages checked</div><div class="card"><b>${cnt("critical")}</b>${badge("critical")}</div><div class="card"><b>${cnt("major")}</b>${badge("major")}</div><div class="card"><b>${cnt("minor")}</b>${badge("minor")}</div></div>
<div class="card"><b>Most common kinds of problem</b><br>${Object.entries(byArea).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${esc(k)}: ${n}`).join(" · ") || "none"}</div>
${report.roles.map((r) => `<h2>${esc(r.kind)} <small style="font-weight:400;color:#64748b">(${esc(r.name)})</small></h2>${r.error ? `<div class="card"><span class="b critical">stopped</span> ${esc(r.error)}</div>` : ""}
<details class="role" open><summary>${r.pages.length} pages · ${r.pages.reduce((t, p) => t + p.issues.length, 0)} issues</summary>
${r.pages.map((p) => `<section class="page"><a href="${esc(p.shot)}" target="_blank"><img loading="lazy" src="${esc(p.shot)}" alt="Screenshot of ${esc(p.title)}"></a><div><h3>${esc(p.title.replace(/ · .*/, ""))}</h3><div class="path">${esc(p.path)} · ${(p.ms / 1000).toFixed(1)} s</div>
${p.issues.length ? `<ul>${p.issues.map((i) => `<li>${badge(i.sev)} <b>${esc(i.area)}</b> ${esc(i.msg)}${i.fix ? `<small>Fix: ${esc(i.fix)}</small>` : ""}</li>`).join("")}</ul>` : `<p class="ok">No problems found.</p>`}</div></section>`).join("")}</details>`).join("")}
</main>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
}

run().catch((e) => { console.error(e); process.exit(2); });
