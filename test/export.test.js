// Every report and list can be downloaded as an Excel file and as a PDF.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const db = require("../db");
const svc = require("../service");
const products = require("../products");
const auth = require("../auth");
const exporter = require("../export");
const { createServer } = require("../server");

async function setup() {
  const d = await db.open(":memory:");
  await svc.createEntry(d, "hubs", { code: "H1", name: "Hub 1" }, "admin");
  await svc.createEntry(d, "hubs", { code: "H2", name: "Hub 2" }, "admin");
  const add = (id, level, extra = {}) => svc.createEntry(d, "staff", { employee_id: id, name: `Name ${id}`, hub: "H1", staff_level: level, bank_account_no: "11112222", ...extra }, "admin");
  await add("M1", "manager", { basic_pay: 27000, target: 100000 });
  await add("D1", "distributor", { upline_id: "M1", basic_pay: 25000, target: 100000, pay_scheme: "tiered", commission_rate: 0.3, base_commission_rate: 0.25 });
  await svc.createEntry(d, "staff", { employee_id: "D9", name: "Name D9", hub: "H2", staff_level: "distributor", basic_pay: 25000, target: 100000 }, "admin");
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D1", business_amount: 130000, settled_amount: 120000, personal_minus: 1000, notes: "Market & fair <test>" }, "admin");
  await svc.createEntry(d, "daily", { date: "2026-10-05", employee_id: "D9", business_amount: 50000, settled_amount: 50000 }, "admin");
  await svc.createEntry(d, "weekly", { week_start: "2026-10-05", week_end: "2026-10-11", manager_id: "M1", business_total: 130000, rent: 4000, hub_fee: 500, security_cost: 1300 }, "admin");
  await svc.createEntry(d, "stock", { period: "2026-10", employee_id: "D1", product: "Shine", opening_stock: 50, sold: 20, counted_stock: 29, unit_price: 850 }, "admin");
  await svc.createEntry(d, "hubstock", { period: "2026-10", hub: "H1", product: "Shine", opening_stock: 100, received: 10, issued: 50, counted_stock: 59, unit_price: 850 }, "admin");
  await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
  await svc.runPeriod(d, "2026-10", "admin");
  return d;
}

// a small zip reader, so the spreadsheet can be opened and checked without any package
function unzip(buf) {
  const files = new Map();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = zlib.inflateRawSync(buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize));
    assert.equal(data.length, usize, name);
    files.set(name, data.toString("utf8"));
    p += 46 + nlen;
  }
  return files;
}
function pdfStrings(buf) {
  const out = [];
  let from = 0;
  for (;;) {
    const a = buf.indexOf("stream\n", from, "latin1");
    if (a < 0) break;
    const b = buf.indexOf("\nendstream", a, "latin1");
    try { out.push(zlib.inflateSync(buf.slice(a + 7, b)).toString("latin1")); } catch { /* not a content stream */ }
    from = b + 10;
  }
  return out.join("\n").match(/\((?:\\.|[^\\)])*\) Tj/g)?.map((s) => s.slice(1, -4).replace(/\\([\\()])/g, "$1")) || [];
}
const can = (...perms) => (p) => perms.includes(p);
const ADMIN = can("read", "view_pay", "manage_products");

test("every report builds as an Excel file and as a PDF", async () => {
  const d = await setup();
  for (const name of Object.keys(exporter.REPORTS)) {
    for (const fmt of ["xlsx", "pdf"]) {
      const f = await exporter.make(d, name, fmt, { can: ADMIN, period: "2026-10" });
      assert.ok(f.data.length > 400, `${name}.${fmt}`);
      assert.match(f.filename, new RegExp(`^${name}(-2026-10)?\\.${fmt}$`));
      if (fmt === "xlsx") {
        const z = unzip(f.data);
        assert.deepEqual([...z.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
      } else {
        assert.equal(f.data.slice(0, 8).toString("latin1"), "%PDF-1.4");
        assert.match(f.data.slice(-8).toString("latin1"), /%%EOF/);
      }
    }
  }
});

test("the spreadsheet holds real numbers and a SUM row, and escapes what could break the file", async () => {
  const d = await setup();
  const sheet = unzip((await exporter.make(d, "daily", "xlsx", { can: ADMIN, period: "2026-10" })).data).get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /<c r="E5" s="2"><v>130000<\/v><\/c>/, "Rs 130,000.00 is the number 130000, not text");
  assert.match(sheet, /Market &amp; fair &lt;test&gt;/);
  assert.match(sheet, /<f>SUM\(E5:E6\)<\/f><v>180000<\/v>/);
  assert.match(sheet, /<pane ySplit="4"/, "the header stays in view");
  assert.match(sheet, /<autoFilter ref="A4:I6"\/>/);
  assert.match(unzip((await exporter.make(d, "daily", "xlsx", { can: ADMIN, period: "2026-10" })).data).get("xl/workbook.xml"), /name="Daily sheet"/);
});

test("the PDF carries the title, the rows and the page numbers", async () => {
  const d = await setup();
  const text = pdfStrings((await exporter.make(d, "daily", "pdf", { can: ADMIN, period: "2026-10" })).data);
  for (const s of ["Daily sheet", "October 2026", "Name D1", "130,000.00", "180,000.00", "Total", "Page 1 of 1"]) assert.ok(text.includes(s) || text.some((t) => t.includes(s)), s);
  // a long list runs over several pages, each with the header again
  for (let day = 6; day <= 31; day++) for (const id of ["D1", "D9"]) await svc.createEntry(d, "daily", { date: `2026-10-${String(day).padStart(2, "0")}`, employee_id: id, business_amount: 1000 + day, settled_amount: 1000 + day }, "admin");
  const many = await exporter.make(d, "daily", "pdf", { can: ADMIN, period: "2026-10" });
  const strings = pdfStrings(many.data);
  const pages = Number(/Page 1 of (\d+)/.exec(strings.find((s) => /^Page 1 of/.test(s)))[1]);
  assert.ok(pages >= 2);
  assert.equal(strings.filter((s) => s === "Handed in").length, pages, "the header is repeated on every page");
});

test("pay stays out of exports for those who may not see pay, and a hub filter keeps to one hub", async () => {
  const d = await setup();
  const mgr = can("read");
  for (const name of ["commission", "balances", "register"]) await assert.rejects(() => exporter.make(d, name, "xlsx", { can: mgr, period: "2026-10" }), /cannot see pay/);
  for (const name of ["product-profit", "products"]) await assert.rejects(() => exporter.make(d, name, "pdf", { can: mgr, period: "2026-10" }), /cannot see this report/);
  const hubs = unzip((await exporter.make(d, "hub-summary", "xlsx", { can: mgr, period: "2026-10" })).data).get("xl/worksheets/sheet1.xml");
  assert.ok(!/Gross pay|Net pay|To bank|Manager balance/.test(hubs));
  const emp = unzip((await exporter.make(d, "employees", "xlsx", { can: mgr })).data).get("xl/worksheets/sheet1.xml");
  assert.ok(!/Basic pay/.test(emp) && /Reports to/.test(emp));
  assert.ok(/Basic pay/.test(unzip((await exporter.make(d, "employees", "xlsx", { can: ADMIN })).data).get("xl/worksheets/sheet1.xml")));
  const live = unzip((await exporter.make(d, "live", "xlsx", { can: mgr, period: "2026-10" })).data).get("xl/worksheets/sheet1.xml");
  assert.ok(!/Commission on this sale|Earned so far/.test(live));
  assert.match(unzip((await exporter.make(d, "live", "xlsx", { can: ADMIN, period: "2026-10" })).data).get("xl/worksheets/sheet1.xml"), /Commission on this sale/);
  const h2 = unzip((await exporter.make(d, "daily", "xlsx", { can: mgr, period: "2026-10", hub: "H2" })).data).get("xl/worksheets/sheet1.xml");
  assert.ok(/Name D9/.test(h2) && !/Name D1</.test(h2));
  await assert.rejects(() => exporter.make(d, "nothing", "pdf", { can: ADMIN }), /Unknown report/);
  await assert.rejects(() => exporter.make(d, "daily", "docx", { can: ADMIN }), /Unknown report/);
  await assert.rejects(() => exporter.make(d, "daily", "pdf", { can: ADMIN, period: "2026-13" }), /Invalid period/);
});

test("payslips come as a PDF, one page per person, marked DRAFT until the month is final", async () => {
  const d = await setup();
  const all = await exporter.payslipsPdf(d, "2026-10", undefined, undefined);
  const text = pdfStrings(all.data);
  assert.equal(text.filter((s) => /Payslip 2026-10\s+-\s+page/.test(s)).length, 3, "three people");
  assert.ok(text.some((s) => /DRAFT/.test(s)) && text.includes("Gross earnings") && text.some((s) => /Net pay: Rs/.test(s)));
  const one = await exporter.payslipsPdf(d, "2026-10", "D1", undefined);
  assert.equal(one.filename, "payslip-D1-2026-10.pdf");
  assert.equal(pdfStrings(one.data).filter((s) => /page 1 of 1/.test(s)).length, 1);
  assert.equal((pdfStrings((await exporter.payslipsPdf(d, "2026-10", undefined, "H2")).data).filter((s) => /Payslip 2026-10\s+-\s+page/.test(s))).length, 1, "a hub filter");
  await assert.rejects(() => exporter.payslipsPdf(d, "2026-10", "NOBODY", undefined), /No payslips/);
});

test("the download route sends the file as an attachment, and refuses pay and product reports to a manager", async () => {
  const d = await setup();
  await auth.setup(d, { username: "owner", full_name: "Owner", password: "password-12345" });
  const admin = await auth.userFromToken(d, (await auth.login(d, "owner", "password-12345")).token);
  await auth.createUser(d, admin, { username: "mgr", full_name: "Mgr", role: "manager", hub: "H1", password: "password-12345" });
  const srv = createServer(d).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cookie = async (u) => (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ username: u, password: "password-12345" }) })).headers.get("set-cookie").split(";")[0];
  try {
    const boss = await cookie("owner"), mgr = await cookie("mgr");
    const r = await fetch(base + "/api/export/daily.xlsx?period=2026-10", { headers: { Cookie: boss } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /spreadsheetml\.sheet/);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="daily-2026-10\.xlsx"/);
    const pdf = await fetch(base + "/api/export/register.pdf?period=2026-10", { headers: { Cookie: boss } });
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await fetch(base + "/api/payroll/2026-10/payslips.pdf", { headers: { Cookie: boss } })).status, 200);
    assert.equal((await fetch(base + "/api/export/daily.pdf?period=2026-10", { headers: { Cookie: mgr } })).status, 200);
    for (const p of ["/api/export/register.xlsx", "/api/export/commission.pdf", "/api/export/products.xlsx", "/api/payroll/2026-10/payslips.pdf"]) assert.equal((await fetch(base + p + "?period=2026-10", { headers: { Cookie: mgr } })).status, 403, p);
    assert.equal((await fetch(base + "/api/export/daily.pdf")).status, 401, "sign-in required");
    assert.equal((await fetch(base + "/api/export/nothing.pdf", { headers: { Cookie: boss } })).status, 404);
  } finally { srv.close(); }
});
