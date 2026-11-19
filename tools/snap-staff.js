const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright-core");
const db = require("../db");
const { createHandler } = require("../server");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = path.join(__dirname, "..", "audit-report", "staff-mobile");
const PORT = 8092;
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

  async function snapFull(filename) {
    const file = path.join(OUT, filename);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`Saved full screenshot: ${filename}`);
  }

  try {
    // 1. Log in as Pavan (distributor seller)
    await login("pavan", "staff123");

    // Sell subtabs
    await page.goto(`${BASE}/me?tab=sell`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("01_pavan_sell_tab.png");

    // Pick first product to open the sell sheet
    const prod = await page.$(".till-prod");
    if (prod) {
      await prod.click();
      await page.waitForTimeout(400);
      await snap("02_pavan_sell_sheet_open.png");
      const close = await page.$("#ts-close");
      if (close) await close.click();
      await page.waitForTimeout(300);
    }

    // Sell: Sales subtab
    const salesBtn = await page.$('[data-subtab="sales"]');
    if (salesBtn) {
      await salesBtn.click();
      await page.waitForTimeout(400);
      await snap("03_pavan_sell_subtab_sales.png");
    }

    // Sell: Stock subtab
    const stockBtn = await page.$('[data-subtab="stock"]');
    if (stockBtn) {
      await stockBtn.click();
      await page.waitForTimeout(400);
      await snap("04_pavan_sell_subtab_stock.png");
    }

    // Sell: End of Day subtab
    const eodBtn = await page.$('[data-subtab="eod"]');
    if (eodBtn) {
      await eodBtn.click();
      await page.waitForTimeout(400);
      await snap("05_pavan_sell_subtab_eod.png");
    }

    // 2. Month Tab
    await page.goto(`${BASE}/me?tab=month`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("06_pavan_month_top.png");
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(300);
    await snap("07_pavan_month_middle.png");
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(300);
    await snap("08_pavan_month_bottom.png");

    // 3. Payslips Tab
    await page.goto(`${BASE}/me?tab=payslips`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("09_pavan_payslips_list.png");

    // Click first payslip if available
    const slipLink = await page.$('a[href*="/me/payslips/"]');
    if (slipLink) {
      await slipLink.click();
      await page.waitForTimeout(600);
      await snap("10_pavan_single_payslip.png");
    }

    // 4. Loans Tab
    await page.goto(`${BASE}/me?tab=loans`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("11_pavan_loans.png");

    // 5. Documents Tab
    await page.goto(`${BASE}/me?tab=documents`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("12_pavan_documents.png");

    // 6. Profile / Details Tab
    await page.goto(`${BASE}/me?tab=details`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("13_pavan_profile_details.png");

    // 7. Log in as Coacher (senior staff)
    await ctx.clearCookies();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await login("coacher1", "staff123");

    // Coacher Month
    await page.goto(`${BASE}/me?tab=month`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("14_coacher_month.png");

    // Coacher Team
    await page.goto(`${BASE}/me?tab=team`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await snap("15_coacher_team.png");

    console.log("ALL SCREENSHOTS CAPTURED SUCCESSFULLY!");
  } catch (err) {
    console.error("Error during audit:", err);
  } finally {
    await browser.close();
    server.close();
    await database.close();
  }
}

main().catch(console.error);
