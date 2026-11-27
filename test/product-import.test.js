// Bulk product upload from an Excel or CSV file, with a sample template.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const auth = require("../auth");
const products = require("../products");
const imp = require("../productimport");
const { renderXlsx } = require("../export");

const ADMIN = { username: "admin" };
const b64 = (buf) => Buffer.from(buf).toString("base64");
const csv = (text) => b64(Buffer.from(text, "utf8"));

// A small .xlsx the way Excel writes it: shared strings, numbers, a gap in a row (stored zip entries).
function excelStyle(rows) {
  const strings = [], idx = (s) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (v === "" || v === null || v === undefined) return "";
    return typeof v === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`;
  }).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`;
  const files = [["xl/worksheets/sheet1.xml", sheet], ["xl/sharedStrings.xml", sst]];
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(h, n, d); central.push(c, n); offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function setup() {
  const d = await db.open(":memory:");
  await auth.setup(d, { username: "admin", full_name: "Admin", password: "admin12345" });
  await products.create(d, { name: "Shine", list_price: 850, cost_price: 300 }, "admin");
  return d;
}

test("the sample template is a valid Excel file whose example rows are ignored", async () => {
  const d = await setup();
  const xlsx = imp.template("xlsx");
  assert.equal(xlsx.slice(0, 2).toString(), "PK");
  const rows = imp.readXlsx(xlsx);
  assert.ok(rows.some((r) => r[0] === "Product name" && /Selling price/.test(r[1])), "the header row is in the file");
  const p = await imp.preview(d, "template.xlsx", b64(xlsx));
  assert.deepEqual(p.counts, { new: 0, update: 0, same: 0, skip: 3, error: 0 });
  assert.match(imp.template("csv").toString("utf8"), /Product name,Selling price \(Rs\)/);
  assert.equal((await imp.preview(d, "t.csv", b64(imp.template("csv")))).counts.skip, 3);
});

test("an Excel file, as Excel saves it, is read: new, updated and unchanged products are told apart", async () => {
  const d = await setup();
  const file = excelStyle([
    ["Sample products"], [],
    ["Product name", "Selling price (Rs)", "Purchase price (Rs)", "Pieces to add to the office stock", "Status"],
    ["Vim", 500, 190, 60, "active"],
    ["shine", 900, "", 10, ""],            // an existing product (any capitals): new selling price, stock added
    ["Clorex 500ml", "1,250.50", 700, "", "inactive"],
    ["Shine", "", "", "", ""],             // appears twice
    ["", 100, 50],                          // no name
  ]);
  const p = await imp.preview(d, "products.xlsx", b64(file));
  const by = Object.fromEntries(p.rows.map((r) => [r.line, r]));
  assert.deepEqual([by[4].action, by[4].selling, by[4].purchase, by[4].stock], ["new", 500, 190, 60]);
  assert.deepEqual([by[5].action, by[5].name], ["update", "shine"]);
  assert.deepEqual([by[6].action, by[6].selling, by[6].status], ["new", 1250.5, "inactive"]);
  assert.equal(by[7].action, "error"); assert.match(by[7].message, /already in the file/);
  assert.equal(by[8].action, "error"); assert.match(by[8].message, /name/);
  assert.equal(p.counts.error, 2);
  await assert.rejects(() => imp.apply(d, ADMIN, "products.xlsx", b64(file)), /2 rows have an error/);
  assert.equal((await products.list(d)).length, 1, "nothing was imported");
});

test("a CSV is read too, with commas inside quotes and a semicolon delimiter", async () => {
  const d = await setup();
  const a = await imp.preview(d, "p.csv", csv('Product name,Selling price (Rs),Purchase price (Rs)\r\n"Soap, large",450,300\r\nVim,500,190\r\n'));
  assert.deepEqual(a.rows.map((r) => [r.name, r.action]), [["Soap, large", "new"], ["Vim", "new"]]);
  const b = await imp.preview(d, "p.csv", csv("Product name;Selling price;Purchase price\nBroom;520;370\n"));
  assert.deepEqual(b.rows.map((r) => [r.name, r.selling, r.purchase]), [["Broom", 520, 370]]);
});

test("the rows are checked: prices, stock, status and name length", async () => {
  const d = await setup();
  const p = await imp.preview(d, "p.csv", csv([
    "Product name,Selling price (Rs),Purchase price (Rs),Stock,Status",
    "A,abc,10,,", "B,0,10,,", "C,100,-5,,", "D,100,10,2.5,", "E,100,10,,maybe", `${"x".repeat(81)},100,10,,`, "F,100,,,",
  ].join("\n")));
  assert.deepEqual(p.rows.map((r) => r.action), ["error", "error", "error", "error", "error", "error", "new"]);
  assert.match(p.rows[0].message, /selling price must be a number above 0/);
  assert.match(p.rows[2].message, /purchase price/);
  assert.match(p.rows[3].message, /whole number/);
  assert.match(p.rows[4].message, /active or inactive/);
  assert.match(p.rows[5].message, /80 characters/);
  assert.match(p.rows[6].message, /No purchase price/, "a blank purchase price is allowed, with a warning");
  await assert.rejects(() => imp.preview(d, "p.csv", csv("Name,Colour\nA,red\n")), /Product name/);
  await assert.rejects(() => imp.preview(d, "p.xls", b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]))), /\.xlsx/);
  await assert.rejects(() => imp.preview(d, "p.csv", ""), /empty/);
});

test("importing creates the products, updates existing prices and adds the stock to the office", async () => {
  const d = await setup();
  const file = renderXlsx({ title: "Product import", subtitle: "x", columns: [{ label: "Product name", type: "text" }, { label: "Selling price (Rs)", type: "money" }, { label: "Purchase price (Rs)", type: "money" }, { label: "Pieces", type: "int" }, { label: "Status", type: "text" }],
    rows: [["Vim", 50000, 19000, 40, "active"], ["SHINE", 90000, "", 25, ""], ["Mug", 19000, 12000, "", "inactive"], ["Example: ignore me", 1, 1, 1, ""]] });
  const r = await imp.apply(d, ADMIN, "p.xlsx", b64(file));
  assert.deepEqual([r.created, r.updated, r.stock_added], [2, 1, 65]);
  const list = Object.fromEntries((await products.list(d)).map((p) => [p.name, p]));
  assert.deepEqual([list.Vim.list_price, list.Vim.cost_price, list.Vim.office_stock], [50000, 19000, 40]);
  assert.deepEqual([list.Shine.list_price, list.Shine.cost_price, list.Shine.office_stock], [90000, 30000, 25], "the new selling price; the purchase price stays");
  assert.equal(list.Mug.status, "inactive");
  // the same file again changes nothing about prices (only adds the stock again)
  const again = await imp.preview(d, "p.xlsx", b64(file));
  assert.deepEqual(again.rows.filter((x) => x.action === "update").map((x) => x.name), ["Vim", "SHINE"], "they carry stock to add, so they are not 'same'");
});
