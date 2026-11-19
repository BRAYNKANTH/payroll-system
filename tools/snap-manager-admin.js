const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright-core");
const db = require("../db");
const { createHandler } = require("../server");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = path.join(__dirname, "..", "audit-report", "mgr-admin-mobile");
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("Opening data/fresh database...");
  const database = await db.open(path.join(__dirname, "..", "data", "fresh"));
  const server = http.createServer(createHandler(database));
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`Server listening on ${BASE}...`);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });

  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });

  const page = await ctx.newPage();

  async function login(username, password) {
    console.log(`Logging in as ${username}...`);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("form input");
    const inputs = await page.$$("form input");
    await inputs[0].fill(username);
    await inputs[1].fill(password);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const v = document.querySelector("#view");
      return v && !v.querySelector(".loading-screen, .spinner") && v.children.length > 0;
    }, { timeout: 30000 });
    await page.waitForTimeout(600);
  }

  async function snap(filename) {
    const file = path.join(OUT, filename);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`Saved screenshot: ${filename}`);
  }

  async function goTo(urlPath, filename) {
    await page.goto(`${BASE}${urlPath}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap(filename);
  }

  try {
    // ==========================================
    // 1. MANAGER SCREENS (Arun Selvam - manager1)
    // ==========================================
    await login("manager1", "manager123");

    await goTo("/team", "mgr_01_team.png");
    await goTo("/live", "mgr_02_live.png");
    await goTo("/employees", "mgr_03_employees.png");
    await goTo("/stock-overview", "mgr_04_stockview.png");
    await goTo("/morning", "mgr_05_morning.png");

    // Open mobile sidebar drawer for manager
    const burger = await page.$("#bnav-more");
    if (burger) {
      await burger.click();
      await page.waitForTimeout(400);
      await snap("mgr_06_sidebar_drawer.png");
      const close = await page.$("#sidebar-close");
      if (close) await close.click();
      await page.waitForTimeout(300);
    }

    // ==========================================
    // 2. ADMIN SCREENS (Owner Admin - admin)
    // ==========================================
    await ctx.clearCookies();
    await login("admin", "admin123");

    await goTo("/", "adm_01_dashboard.png");

    // Open mobile sidebar drawer for admin
    const adminBurger = await page.$("#bnav-more");
    if (adminBurger) {
      await adminBurger.click();
      await page.waitForTimeout(400);
      await snap("adm_02_sidebar_drawer.png");
      const close = await page.$("#sidebar-close");
      if (close) await close.click();
      await page.waitForTimeout(300);
    }

    await goTo("/payroll", "adm_03_payroll.png");
    await goTo("/approvals", "adm_04_approvals.png");
    await goTo("/payslips", "adm_05_payslips.png");
    await goTo("/daily", "adm_06_daily.png");
    await goTo("/weekly", "adm_07_weekly.png");
    await goTo("/products", "adm_08_products.png");
    await goTo("/hub-stock", "adm_09_hubstock.png");
    await goTo("/loans", "adm_10_loans.png");
    await goTo("/employees", "adm_11_employees.png");
    await goTo("/hubs", "adm_12_hubs.png");
    await goTo("/reports", "adm_13_reports.png");
    await goTo("/audit", "adm_14_audit.png");
    await goTo("/users", "adm_15_users.png");
    await goTo("/settings", "adm_16_settings.png");

    console.log("ALL MANAGER AND ADMIN SCREENSHOTS CAPTURED!");
  } catch (err) {
    console.error("Error capturing screenshots:", err);
  } finally {
    await browser.close();
    server.close();
    await database.close();
  }
}

main().catch(console.error);
