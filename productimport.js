// Bulk product upload from an Excel (.xlsx) or CSV file, with a sample template.
//   template()   an Excel file to fill in: one product per row (name, selling price, purchase price, pieces to add to the office stock, status)
//   preview()    reads an uploaded file and says, row by row, what would happen: new, update, same, skipped or an error. Changes nothing.
//   apply()      does it, only when every row is fine (a file with errors is refused so nothing is half loaded)
// An existing product (same name, any capital letters) is updated with the prices given; the stock given is added as a delivery.
// No new packages: the .xlsx is read here (a zip of XML files) with Node's own zlib.
const zlib = require("zlib");
const { httpError } = require("./db");
const products = require("./products");

const MAX_ROWS = 2000;
const HEADERS = ["Product name", "Selling price (Rs)", "Purchase price (Rs)", "Pieces to add to the office stock (optional)", "Status (active or inactive, optional)"];
const SAMPLE = [["Example: Dish wash liquid 500ml", 380, 270, 120, "active"], ["Example: Bath soap 3-pack", 390, 280, 80, "active"], ["Example: Plastic mug", 190, 120, "", ""]];

// ---------------------------------------------------------------- the sample template
function template(format = "xlsx") {
  const { renderXlsx } = require("./export");
  if (format === "csv") return Buffer.from("﻿" + [HEADERS, ...SAMPLE].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n") + "\r\n", "utf8");
  return renderXlsx({
    title: "Product import",
    subtitle: "One product per row, from row 5. Prices in rupees. Rows whose name starts with 'Example:' are ignored. Delete them or write over them.",
    columns: [{ label: HEADERS[0], type: "text" }, { label: HEADERS[1], type: "money" }, { label: HEADERS[2], type: "money" }, { label: HEADERS[3], type: "int" }, { label: HEADERS[4], type: "text" }],
    rows: SAMPLE.map((r) => [r[0], r[1] * 100, r[2] * 100, r[3], r[4]]),
  });
}

// ---------------------------------------------------------------- reading an .xlsx (a zip of XML files)
function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw httpError(400, "That does not look like an Excel (.xlsx) file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(dataStart, dataStart + csize);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const unxml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c))).replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16))).replace(/&amp;/g, "&");
const textOf = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");
const colIndex = (letters) => letters.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function readXlsx(buf) {
  const files = unzip(buf);
  const shared = files.has("xl/sharedStrings.xml") ? [...files.get("xl/sharedStrings.xml")().toString("utf8").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) throw httpError(400, "That Excel file has no sheet");
  const xml = files.get(sheets[0])().toString("utf8");
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Za-z]+)\d+"/.exec(cm[1]);
      if (!ref) continue;
      const type = (/\bt="([^"]+)"/.exec(cm[1]) || [])[1], body = cm[2] || "";
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      let value = "";
      if (type === "inlineStr") value = textOf(body);
      else if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "str") value = unxml(v ?? "");
      else if (v !== undefined) value = type === "b" ? (v === "1" ? "TRUE" : "FALSE") : Number(v);
      cells[colIndex(ref[1])] = value;
    }
    rows.push(Array.from(cells, (c) => (c === undefined ? "" : c)));
  }
  return rows;
}

// ---------------------------------------------------------------- reading a CSV
function readCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readFile(filename, data) {
  let buf;
  try { buf = Buffer.from(String(data || ""), "base64"); } catch { throw httpError(400, "The file could not be read"); }
  if (!buf.length) throw httpError(400, "The file is empty");
  if (buf.length > 4_000_000) throw httpError(413, "The file is too big (4 MB at most)");
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (/\.xls$/i.test(filename || "") && !isZip) throw httpError(400, "Save the file as .xlsx (Excel Workbook) or .csv and upload that");
  return isZip ? readXlsx(buf) : readCsv(buf.toString("utf8"));
}

// ---------------------------------------------------------------- checking the rows
const money = (raw) => {
  const s = String(raw ?? "").replace(/rs\.?/i, "").replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

function columnsOf(rows) {
  // the header row: a cell that is the product's name, and a cell about the price (title rows above it are skipped)
  const at = rows.findIndex((r) => r.some((c) => /^\s*(product\s*name|product|name|item)\s*$/i.test(String(c))) && r.some((c) => /price|selling/i.test(String(c))));
  if (at < 0) throw httpError(400, "The first column must be headed \"Product name\". Use the sample template.");
  const head = rows[at].map((c) => String(c ?? "").toLowerCase());
  const find = (re, not) => head.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const map = {
    name: find(/product|item|name/),
    selling: find(/selling|sell|list|price/, /purchase|cost|buy/),
    purchase: find(/purchase|cost|buy/),
    stock: find(/stock|piece|qty|quantity|opening/),
    status: find(/status|active/),
  };
  if (map.name < 0 || map.selling < 0) throw httpError(400, "The columns \"Product name\" and \"Selling price (Rs)\" are needed. Use the sample template.");
  return { at, map };
}

async function preview(db, filename, data) {
  const all = readFile(filename, data);
  const { at, map } = columnsOf(all);
  const body = all.slice(at + 1);
  if (body.length > MAX_ROWS) throw httpError(400, `A file can have up to ${MAX_ROWS} products. This one has ${body.length}.`);
  const existing = new Map((await db.all("SELECT id, name, list_price, cost_price, status FROM products")).map((p) => [p.name.toLowerCase(), p]));
  const seen = new Set();
  const rows = [];
  body.forEach((r, i) => {
    const line = at + 2 + i; // the row number in the sheet
    const cell = (k) => (map[k] >= 0 ? r[map[k]] : "");
    const name = String(cell("name") ?? "").replace(/\s+/g, " ").trim();
    const blank = r.every((c) => String(c ?? "").trim() === "");
    if (blank) return;
    if (/^example\s*:/i.test(name)) { rows.push({ line, name, action: "skip", message: "Example row, ignored" }); return; }
    const out = { line, name, action: "new", selling: null, purchase: null, stock: 0, status: null, message: "" };
    const errs = [], warns = [];
    if (!name) errs.push("Enter the product's name");
    else if (name.length > 80) errs.push("The name is longer than 80 characters");
    else if (seen.has(name.toLowerCase())) errs.push("This name is already in the file above");
    seen.add(name.toLowerCase());
    const old = existing.get(name.toLowerCase());
    const sell = money(cell("selling")), buy = money(cell("purchase"));
    if (Number.isNaN(sell) || (sell !== null && sell <= 0)) errs.push("The selling price must be a number above 0");
    else if (sell === null && !old) errs.push("Enter the selling price");
    if (Number.isNaN(buy) || (buy !== null && buy < 0)) errs.push("The purchase price must be a number, 0 or more");
    else if (buy === null && !old) warns.push("No purchase price: the profit will show as the whole price until you set it");
    const stockRaw = String(cell("stock") ?? "").replace(/,/g, "").trim();
    if (stockRaw !== "") { const n = Number(stockRaw); if (!Number.isInteger(n) || n < 0 || n > 1_000_000) errs.push("The pieces must be a whole number, 0 or more"); else out.stock = n; }
    const st = String(cell("status") ?? "").trim().toLowerCase();
    if (st !== "" && !["active", "inactive"].includes(st)) errs.push("The status must be active or inactive");
    out.selling = sell; out.purchase = buy; out.status = st || null;
    if (old) {
      out.action = "update"; out.id = Number(old.id);
      const same = (sell === null || Math.round(sell * 100) === Number(old.list_price)) && (buy === null || Math.round(buy * 100) === Number(old.cost_price)) && (!st || st === old.status) && out.stock === 0;
      if (same) out.action = "same";
    }
    if (errs.length) { out.action = "error"; out.message = errs.join(". "); } else out.message = warns.join(". ");
    rows.push(out);
  });
  const count = (a) => rows.filter((r) => r.action === a).length;
  return { rows, counts: { new: count("new"), update: count("update"), same: count("same"), skip: count("skip"), error: count("error") } };
}

async function apply(db, user, filename, data) {
  const p = await preview(db, filename, data);
  if (p.counts.error) throw httpError(400, `${p.counts.error} ${p.counts.error === 1 ? "row has" : "rows have"} an error. Fix the file and upload it again; nothing was imported.`);
  const done = { created: 0, updated: 0, stock_added: 0 };
  for (const r of p.rows) {
    if (r.action === "new") {
      const made = await products.create(db, { name: r.name, list_price: r.selling, cost_price: r.purchase ?? 0, status: r.status || "active" }, user.username);
      done.created++;
      if (r.stock > 0) { await products.addStock(db, made.id, { qty: r.stock, note: "Opening stock (import)" }, user.username); done.stock_added += r.stock; }
    } else if (r.action === "update") {
      const body = {};
      if (r.selling !== null) body.list_price = r.selling;
      if (r.purchase !== null) body.cost_price = r.purchase;
      if (r.status) body.status = r.status;
      if (Object.keys(body).length) { await products.update(db, r.id, body, user.username); done.updated++; }
      if (r.stock > 0) { await products.addStock(db, r.id, { qty: r.stock, note: "Delivery (import)" }, user.username); done.stock_added += r.stock; }
    }
  }
  return { ...done, counts: p.counts };
}

module.exports = { template, preview, apply, readXlsx, readCsv, HEADERS };
