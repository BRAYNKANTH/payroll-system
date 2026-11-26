// Excel (.xlsx) and PDF exports of every report and list, with no extra packages.
//
// Each report is described once as a table: { title, subtitle, columns: [{ label, type, total }], rows: [[...]] } where a money cell holds
// cents, a percent cell a fraction. The same table becomes a spreadsheet (real numbers, a SUM row, a frozen header) or a PDF (repeated
// header, page numbers). The PDF uses the built-in Helvetica, so it can print Latin text only; any other letter prints as "?".
// The spreadsheet keeps every character.
const zlib = require("zlib");
const { getSettings, httpError } = require("./db");
const svc = require("./service");
const products = require("./products");
const sales = require("./sales");
const loans = require("./loans");

// ---------------------------------------------------------------- shared helpers
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (p) => (/^\d{4}-\d{2}$/.test(p || "") ? `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}` : "");
const num = (n) => Number(n) || 0;
const fmtMoney = (c) => (num(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCell = (v, type) => {
  if (v === null || v === undefined || v === "") return "";
  if (type === "money") return fmtMoney(v);
  if (type === "int") return num(v).toLocaleString("en-US");
  if (type === "pct") return (num(v) * 100).toFixed(1) + "%";
  return String(v);
};
const total = (rows, i) => rows.reduce((t, r) => t + num(r[i]), 0);

// ---------------------------------------------------------------- XLSX
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = zlib.deflateRawSync(f.data), crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i) => { let s = ""; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// style ids (see STYLES): 1 header, 2 money, 3 integer, 4 percent, 5 title, 6 subtitle, 7 total money, 8 total text, 9 total integer
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]\\-#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="15"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF5F5B52"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1B5E4B"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFAEFD6"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF1B5E4B"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function renderXlsx(model) {
  const cols = model.columns;
  const HEAD = 4, FIRST = HEAD + 1, LAST = HEAD + model.rows.length;
  const str = (ref, s, style) => `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
  const rows = [];
  rows.push(`<row r="1" ht="22" customHeight="1">${str("A1", model.title, 5)}</row>`);
  rows.push(`<row r="2">${str("A2", model.subtitle || "", 6)}</row>`);
  rows.push(`<row r="${HEAD}" ht="30" customHeight="1">${cols.map((c, i) => str(colName(i) + HEAD, c.label, 1)).join("")}</row>`);
  model.rows.forEach((r, ri) => {
    const n = FIRST + ri;
    rows.push(`<row r="${n}">${cols.map((c, i) => {
      const v = r[i], ref = colName(i) + n;
      if (v === null || v === undefined || v === "") return "";
      if (c.type === "money") return `<c r="${ref}" s="2"><v>${num(v) / 100}</v></c>`;
      if (c.type === "int") return `<c r="${ref}" s="3"><v>${num(v)}</v></c>`;
      if (c.type === "pct") return `<c r="${ref}" s="4"><v>${num(v)}</v></c>`;
      return str(ref, v);
    }).join("")}</row>`);
  });
  if (cols.some((c) => c.total) && model.rows.length) {
    const n = LAST + 1;
    rows.push(`<row r="${n}">${cols.map((c, i) => {
      const ref = colName(i) + n;
      if (i === 0) return str(ref, "Total", 8);
      if (!c.total) return `<c r="${ref}" s="8"/>`;
      const col = colName(i), sum = total(model.rows, i);
      return `<c r="${ref}" s="${c.type === "money" ? 7 : 9}"><f>SUM(${col}${FIRST}:${col}${LAST})</f><v>${c.type === "money" ? sum / 100 : sum}</v></c>`;
    }).join("")}</row>`);
  }
  const widths = cols.map((c, i) => Math.min(48, Math.max(11, c.label.length + 2, ...model.rows.slice(0, 300).map((r) => fmtCell(r[i], c.type).length + 2))));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEAD}" topLeftCell="A${FIRST}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows.join("")}</sheetData>${model.rows.length ? `<autoFilter ref="A${HEAD}:${colName(cols.length - 1)}${LAST}"/>` : ""}</worksheet>`;
  const name = xml(model.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report");
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: Buffer.from(STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);
}

// ---------------------------------------------------------------- PDF
// Helvetica widths for characters 32..126, in 1/1000 em.
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const SWAP = { "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "×": "x", "→": "->", "−": "-", "₨": "Rs", "•": "*" };
const latin = (s) => String(s ?? "").replace(/[–—‘’“”…×→−₨•]/g, (c) => SWAP[c]).replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, "?").replace(/[\x00-\x1f]/g, " ");
const tw = (s, size, bold) => { let w = 0; for (const ch of latin(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? HW[c - 32] : 556; } return (w / 1000) * size * (bold ? 1.05 : 1); };
const fit = (s, maxW, size, bold) => {
  s = latin(s);
  if (tw(s, size, bold) <= maxW) return s;
  while (s.length > 1 && tw(s + "...", size, bold) > maxW) s = s.slice(0, -1);
  return s + "...";
};
const esc = (s) => latin(s).replace(/[\\()]/g, (c) => "\\" + c);

class Pdf {
  constructor() { this.pages = []; this.cur = null; }
  page(w, h) { this.cur = { w, h, ops: [] }; this.pages.push(this.cur); return this.cur; }
  text(x, y, s, size = 9, bold = false, gray = 0.1) { this.cur.ops.push(`BT ${gray} g /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`); }
  rect(x, y, w, h, rgb) { this.cur.ops.push(`${rgb.join(" ")} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  line(x1, y1, x2, y2, gray = 0.8) { this.cur.ops.push(`${gray} G 0.5 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  build(footer) {
    const objs = [null, null];       // 1 catalog, 2 pages (filled below)
    const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1")); return objs.length; };
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids = [];
    this.pages.forEach((p, i) => {
      if (footer) { this.cur = p; footer(this, i + 1, this.pages.length, p); }
      const data = zlib.deflateSync(Buffer.from(p.ops.join("\n"), "latin1"));
      const c = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    });
    objs[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1");
    objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
    const out = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [];
    let pos = out[0].length;
    objs.forEach((b, i) => {
      offsets.push(pos);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), b, Buffer.from("\nendobj\n", "latin1")]);
      out.push(chunk); pos += chunk.length;
    });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    out.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(out);
  }
}

function renderPdf(model, { company = "", generated = new Date() } = {}) {
  const cols = model.columns;
  const landscape = cols.length > 6;
  const W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89, M = 30, size = 7.6, rowH = 13.5;
  const avail = W - M * 2;
  const cells = model.rows.map((r) => cols.map((c, i) => fmtCell(r[i], c.type)));
  const totals = cols.map((c, i) => (c.total ? fmtCell(total(model.rows, i), c.type) : ""));
  // column widths: what the content needs, shrunk to the page when too wide
  let want = cols.map((c, i) => Math.min(190, Math.max(tw(c.label, size, true), ...cells.slice(0, 400).map((r) => tw(r[i], size)), tw(totals[i], size, true)) + 10));
  const sum = want.reduce((a, b) => a + b, 0);
  const scale = sum > avail ? avail / sum : Math.min(1.25, avail / sum);
  want = want.map((w) => Math.max(26, w * scale));
  const pdf = new Pdf();
  let y = 0;
  const newPage = (first) => {
    pdf.page(W, H);
    y = H - M;
    if (first) {
      pdf.text(M, y - 12, model.title, 14, true); y -= 20;
      if (model.subtitle) { pdf.text(M, y - 8, model.subtitle, 8.5, false, 0.35); y -= 14; }
      y -= 6;
    }
    // header row
    pdf.rect(M, y - rowH, want.reduce((a, b) => a + b, 0), rowH, [0.106, 0.369, 0.294]);
    let x = M;
    cols.forEach((c, i) => {
      const t = fit(c.label, want[i] - 6, size, true), right = c.type && c.type !== "text";
      pdf.text(right ? x + want[i] - 3 - tw(t, size, true) : x + 3, y - rowH + 4.2, t, size, true, 1);
      x += want[i];
    });
    y -= rowH;
  };
  const drawRow = (vals, opts = {}) => {
    if (y - rowH < M + 22) newPage(false);
    if (opts.shade) pdf.rect(M, y - rowH, want.reduce((a, b) => a + b, 0), rowH, opts.total ? [0.98, 0.937, 0.839] : [0.965, 0.965, 0.955]);
    if (opts.total) pdf.line(M, y, M + want.reduce((a, b) => a + b, 0), y, 0.3);
    let x = M;
    cols.forEach((c, i) => {
      const t = fit(vals[i], want[i] - 6, size, !!opts.total), right = c.type && c.type !== "text";
      if (t) pdf.text(right ? x + want[i] - 3 - tw(t, size, !!opts.total) : x + 3, y - rowH + 4.2, t, size, !!opts.total, String(vals[i]).startsWith("-") && right ? 0.6 : 0.1);
      x += want[i];
    });
    y -= rowH;
  };
  newPage(true);
  if (!cells.length) { y -= 6; pdf.text(M, y - 10, "Nothing to show for this selection.", 9, false, 0.35); }
  cells.forEach((r, i) => drawRow(r, { shade: i % 2 === 1 }));
  if (cols.some((c) => c.total) && cells.length) drawRow(["Total", ...totals.slice(1)], { shade: true, total: true });
  const stamp = generated.toISOString().slice(0, 16).replace("T", " ");
  return pdf.build((p, n, of) => {
    p.line(M, M + 12, W - M, M + 12, 0.85);
    p.text(M, M, `${company}${company ? "  -  " : ""}${model.title}  -  ${stamp}`, 7, false, 0.4);
    const t = `Page ${n} of ${of}`;
    p.text(W - M - tw(t, 7), M, t, 7, false, 0.4);
  });
}

// ---------------------------------------------------------------- the reports
// Every report is built from the same functions the screens use. A report needs `perm` (a permission) and, when canPay is false,
// leaves out its pay columns.
const C = (label, type = "text", totalIt = false) => ({ label, type, total: totalIt });
const level = (l) => svc.LEVEL_NAME[l] || l || "";

async function staffNames(db) {
  return new Map((await db.all("SELECT employee_id, name, hub, staff_level, upline_id FROM staff")).map((s) => [s.employee_id, s]));
}
const byHub = (rows, hub, get = (r) => r.hub) => (hub ? rows.filter((r) => get(r) === hub) : rows);

const REPORTS = {
  "hub-summary": async ({ db, period, hub, canPay }) => {
    const d = await svc.dashboard(db, period, hub || undefined);
    const pay = canPay;
    return { title: "Hub summary", subtitle: monthLabel(period),
      columns: [C("Hub"), C("Staff", "int", true), C("Hub business", "money", true), C("Guys' business", "money", true), ...(pay ? [C("Gross pay", "money", true), C("Net pay", "money", true), C("Salary", "money", true)] : []),
        C("Stock short", "money", true), ...(pay ? [C("Manager balance", "money", true)] : [])],
      rows: d.by_hub.map((h) => [h.name, h.staff, h.hub_business, h.guys_business, ...(pay ? [h.gross_pay, h.net_pay, h.to_bank] : []), h.stock_shortfall, ...(pay ? [h.manager_balance] : [])]) };
  },
  commission: async ({ db, period, hub }) => ({ title: "Commission", subtitle: monthLabel(period), pay: true,
    columns: [C("Employee"), C("Name"), C("Hub"), C("Business", "money", true), C("Target", "money"), C("Over target", "money", true), C("Rate", "pct"), C("Commission", "money", true)],
    rows: byHub(await svc.commissionReport(db, period), hub).map((r) => [r.employee_id, r.name, r.hub, r.business, r.target, r.over_target, r.rate, r.commission]) }),
  stock: async ({ db, period, hub }) => ({ title: "Stock shortfall", subtitle: monthLabel(period),
    columns: [C("Employee"), C("Name"), C("Hub"), C("Product"), C("Opening", "int"), C("Issued", "int"), C("Sold", "int"), C("Counted", "int"), C("Short qty", "int", true), C("Unit price", "money"), C("Short value", "money", true)],
    rows: byHub(await svc.stockReport(db, period), hub).map((r) => [r.employee_id, r.name, r.hub, r.product, r.opening_stock, r.issued, r.sold, r.counted_stock, r.shortfall_qty, r.unit_price, r.shortfall_value]) }),
  "branch-stock": async ({ db, period, hub }) => ({ title: "Hub stock", subtitle: monthLabel(period),
    columns: [C("Hub"), C("Product"), C("Opening", "int"), C("Received", "int"), C("Given out", "int"), C("Counted", "int"), C("Difference", "int"), C("Unit price", "money"), C("Short value", "money", true), C("Stock value", "money", true)],
    rows: (await svc.listEntries(db, "hubstock", { period, hub: hub || undefined })).map((r) => [r.hub, r.product, r.opening_stock, r.received, r.issued, r.counted_stock, r.shortfall_qty, r.unit_price, r.shortfall_value, r.stock_value]) }),
  balances: async ({ db, hub }) => ({ title: "Balances", subtitle: "Closing balance of each person at their latest month", pay: true,
    columns: [C("Employee"), C("Name"), C("Type"), C("Hub"), C("Status"), C("As of"), C("Closing balance", "money", true)],
    rows: byHub(await svc.balancesReport(db), hub).map((r) => [r.employee_id, r.name, r.role === "manager" ? "Manager level" : "Seller", r.hub, r.status, r.period, r.closing_balance]) }),
  months: async ({ db, canPay }) => ({ title: "Month history", subtitle: "Every calculated month",
    columns: [C("Month"), C("Status"), C("People", "int"), C("Pending", "int"), C("Rejected", "int"), ...(canPay ? [C("Net pay", "money", true), C("Salary", "money", true)] : []), C("Finalized by"), C("Finalized at")],
    rows: (await svc.listPeriods(db)).map((r) => [r.period, r.status, r.employees, r.pending, r.rejected, ...(canPay ? [r.net_pay, r.to_bank] : []), r.finalized_by || "", r.finalized_at || ""]) }),
  "product-profit": async ({ db, period }) => {
    const d = await products.profitReport(db, period);
    return { title: "Product profit", subtitle: `${monthLabel(period)} - after the workers' ${(d.workers_rate * 100).toFixed(0)}% and the purchase prices`, perm: "manage_products",
      columns: [C("Product"), C("Units sold", "int", true), C("Sales", "money", true), C("Workers' share", "money", true), C("Purchase cost", "money", true), C("Company profit", "money", true)],
      rows: d.rows.map((r) => [r.matched ? r.product : r.product + " (not in Products)", r.qty, r.revenue, r.workers, r.cost, r.profit]) };
  },
  products: async ({ db }) => ({ title: "Products", subtitle: "Selling price, purchase price and the profit per unit after the workers' share", perm: "manage_products",
    columns: [C("Product"), C("Selling price", "money"), C("Purchase price", "money"), C("Workers' share", "money"), C("Company keeps", "money"), C("Profit per unit", "money"), C("Of the price", "pct"), C("Status")],
    rows: (await products.list(db)).map((p) => [p.name, p.list_price, p.cost_price, p.workers_share, p.company_share, p.profit, p.margin, p.status]) }),
  register: async ({ db, period, hub }) => {
    const data = await svc.getPeriod(db, period);
    return { title: "Payroll register", subtitle: `${monthLabel(period)} - ${data.status}`, pay: true,
      columns: [C("Employee"), C("Name"), C("Position"), C("Hub"), C("Business", "money", true), C("Opening", "money", true), C("Gross", "money", true), C("Deductions", "money", true), C("Net pay", "money", true), C("Paid", "money", true), C("Closing", "money", true), C("Status"), C("Flags")],
      rows: byHub(data.rows, hub).map((r) => [r.employee_id, r.name, level(r.staff_level), r.hub, r.detail.total_business, r.opening_balance, r.gross_earnings, r.total_deductions, r.net_pay, r.disbursed_amount, r.closing_balance, r.status.replace("_", " "), r.flags.map((f) => f.code).join(" ")]) };
  },
  daily: async ({ db, period, hub }) => {
    const names = await staffNames(db);
    return { title: "Daily sheet", subtitle: monthLabel(period),
      columns: [C("Date"), C("Employee"), C("Name"), C("Hub"), C("Business", "money", true), C("Handed in", "money", true), C("Settle-up minus", "money", true), C("Advance taken", "money", true), C("Note")],
      rows: (await svc.listEntries(db, "daily", { period, hub: hub || undefined })).map((r) => [r.date, r.employee_id, names.get(r.employee_id)?.name || "", names.get(r.employee_id)?.hub || "", r.business_amount, r.settled_amount, r.settle_up_minus, r.personal_minus, r.notes || ""]) };
  },
  live: async ({ db, period, hub, canPay }) => {
    const d = await sales.live(db, { period, hub: hub || undefined }, canPay);
    return { title: "Live sales", subtitle: monthLabel(period),
      columns: [C("Day"), C("Person"), C("Hub"), C("Sale", "money", true), C("Handed in", "money", true), C("Month so far", "money"), C("Of target", "pct"), ...(canPay ? [C("Commission on this sale", "money", true), C("Earned so far", "money")] : []), C("Status")],
      rows: d.feed.map((f) => [f.date, `${f.name} (${f.employee_id})`, f.hub, f.business, f.settled, f.month_business, f.target_pct, ...(canPay ? [f.pay ? f.pay.commission : "", f.pay ? f.pay.gross_so_far : ""] : []), f.confirmed ? "Confirmed" : "Waiting for confirmation"]) };
  },
  audit: async ({ db, canPay, canUsers, hub, username, q }) => ({ title: "Audit trail", subtitle: "Who signed in, changed, added, uploaded, downloaded or opened what, and when",
    columns: [C("When"), C("Who"), C("Area"), C("Record"), C("Action"), C("Old value"), C("New value"), C("From (address)"), C("Browser")],
    rows: (await svc.auditSearch(db, { table: q.get("table") || undefined, key: q.get("key") || undefined, user: hub ? username : q.get("user") || undefined, from: q.get("from") || undefined, to: q.get("to") || undefined,
      action: q.get("action") || undefined, limit: 2000, noPay: !canPay, noAccess: !canUsers }))
      .map((a) => [a.changed_at, a.changed_by, a.table_name, a.row_key, a.action, (a.old_value || "").slice(0, 300), (a.new_value || "").slice(0, 300), a.ip || "", (a.agent || "").slice(0, 80)]) }),
  loans: async ({ db, hub }) => {
    const names = await staffNames(db);
    return { title: "Advances and loans", subtitle: "What was given, paid back and is still owed", pay: true,
      columns: [C("Employee"), C("Name"), C("Type"), C("Given on"), C("Amount", "money", true), C("Each month", "money"), C("Paid back", "money", true), C("Still owed", "money", true), C("Status"), C("Note")],
      rows: (await loans.list(db, { hub: hub || undefined })).map((l) => [l.employee_id, names.get(l.employee_id)?.name || "", l.kind, l.issued_on, l.amount, l.kind === "loan" ? l.instalment : "", l.repaid, l.outstanding, l.state, l.note || ""]) };
  },
  employees: async ({ db, hub, canPay }) => {
    const names = await staffNames(db);
    return { title: "Employees", subtitle: "Everyone on record, with their position and who they report to",
      columns: [C("Employee"), C("Name"), C("Position"), C("Hub"), C("Reports to"), C("Phone"), C("Status"), C("Joined"), C("Left"), C("Target", "money"), ...(canPay ? [C("Basic pay", "money")] : [])],
      rows: (await svc.listEntries(db, "staff", { hub: hub || undefined })).map((s) => [s.employee_id, s.name, level(s.staff_level), s.hub, names.get(s.upline_id)?.name || "", s.phone || "", s.status, s.join_date || "", s.leave_date || "", s.target, ...(canPay ? [s.basic_pay] : [])]) };
  },
  weekly: async ({ db, period, hub, canPay }) => {
    const weeks = (await svc.weeklyView(db, period, hub || undefined)).flatMap((m) => m.weeks.map((w) => ({ m, w })));
    return { title: "Weekly sheet", subtitle: monthLabel(period),
      columns: [C("Week starting"), C("Manager"), C("Hub"), C("Business", "money", true), ...(canPay ? [C("Commission %", "pct"), C("Rent", "money", true), C("Hub fee", "money", true), C("Security", "money", true), C("Weekly balance", "money", true)] : [])],
      rows: weeks.map(({ m, w }) => [w.week_start, m.name, m.hub, w.business_total, ...(canPay ? [w.profit_percent, w.rent, w.hub_fee, w.security_cost, w.weekly_balance] : [])]) };
  },
};

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

// Builds one report as a file. `can(perm)` says what the signed-in person may do; a hub-limited user only ever gets their own hub.
async function make(db, name, format, { can, hub, period, query, username }) {
  const build = REPORTS[name];
  if (!build || !TYPES[format]) throw httpError(404, "Unknown report");
  const canPay = can("view_pay");
  const per = period || new Date().toISOString().slice(0, 7);
  svc.assertPeriod(per);
  const model = await build({ db, period: per, hub, canPay, canUsers: can("manage_users"), username, q: query || new URLSearchParams() });
  if (model.pay && !canPay) throw httpError(403, "Your role cannot see pay");
  if (model.perm && !can(model.perm)) throw httpError(403, "Your role cannot see this report");
  const company = (await getSettings(db)).company_name || "";
  const data = format === "xlsx" ? renderXlsx(model) : renderPdf(model, { company });
  const slug = name + (/^(daily|live|weekly|register|commission|stock|branch-stock|hub-summary|product-profit)$/.test(name) ? "-" + per : "");
  return { data, type: TYPES[format], filename: `${slug}.${format}` };
}

// One page per person: the pay slip as a PDF. A finalized month shows final figures; an open one is marked DRAFT.
async function payslipsPdf(db, period, employeeId, hub) {
  svc.assertPeriod(period);
  const data = await svc.getPeriod(db, period);
  let rows = byHub(data.rows, hub);
  if (employeeId) rows = rows.filter((r) => r.employee_id === employeeId);
  if (!rows.length) throw httpError(404, "No payslips for that selection");
  const company = (await getSettings(db)).company_name || "";
  const draft = data.status !== "finalized";
  const pdf = new Pdf();
  const W = 595.28, H = 841.89, M = 46;
  for (const r of rows) {
    pdf.page(W, H);
    let y = H - M;
    pdf.text(M, y - 14, `${company} - Payslip ${period}`, 14, true); y -= 24;
    if (draft) { pdf.text(M, y - 9, "DRAFT - the month is not finalized yet", 9, true, 0.55); y -= 16; }
    pdf.text(M, y - 10, `${r.name} (${r.employee_id})`, 11, true); pdf.text(W - M - tw(`Hub ${r.hub}`, 9), y - 10, `Hub ${r.hub}`, 9); y -= 16;
    pdf.text(M, y - 9, `${level(r.staff_level)}  -  Business this month: Rs ${fmtMoney(r.detail.total_business)}`, 9, false, 0.3); y -= 22;
    const block = (title, lines, totalLabel, totalValue) => {
      pdf.text(M, y - 9, title, 10, true); y -= 14; pdf.line(M, y, W - M, y, 0.7); y -= 3;
      for (const l of lines.filter((x) => x.amount !== 0 || /Basic/.test(x.label))) {
        pdf.text(M + 4, y - 9, fit(l.label, W - M * 2 - 110, 9), 9);
        const t = fmtMoney(l.amount); pdf.text(W - M - tw(t, 9), y - 9, t, 9); y -= 13;
      }
      pdf.line(M, y - 2, W - M, y - 2, 0.3);
      pdf.text(M + 4, y - 13, totalLabel, 9.5, true); const t = fmtMoney(totalValue); pdf.text(W - M - tw(t, 9.5, true), y - 13, t, 9.5, true); y -= 28;
    };
    block("Earnings", r.detail.earnings, "Gross earnings", r.gross_earnings);
    block("Deductions", r.detail.deductions, "Total deductions", r.total_deductions);
    if (r.role === "manager" && r.detail.team?.length) {
      pdf.text(M, y - 9, "Team's extras paid from this manager's share", 10, true); y -= 14;
      for (const t of r.detail.team) { pdf.text(M + 4, y - 9, `${t.name} (${t.employee_id})  over target ${fmtMoney(t.over_target)}  food ${fmtMoney(t.food)}`, 8.5); y -= 12; }
      y -= 8;
    }
    pdf.rect(M, y - 24, W - M * 2, 24, [0.957, 0.965, 0.973]);
    pdf.text(M + 8, y - 16, `Net pay: Rs ${fmtMoney(r.net_pay)}${r.role === "guy" ? `   -   Salary: Rs ${fmtMoney(r.disbursed_amount)}` : ""}`, 11, true); y -= 40;
    pdf.text(M, y - 9, `Opening balance Rs ${fmtMoney(r.opening_balance)}   -   Closing balance Rs ${fmtMoney(r.closing_balance)}`, 8.5, false, 0.35); y -= 14;
    pdf.text(M, y - 9, `Status: ${r.status.replace("_", " ")}${r.reviewed_by ? ` by ${r.reviewed_by}` : ""}`, 8.5, false, 0.35);
  }
  return { data: pdf.build((p, n, of) => p.text(M, 22, `${company}  -  Payslip ${period}  -  page ${n} of ${of}`, 7, false, 0.4)),
    type: TYPES.pdf, filename: `payslip-${employeeId ? employeeId + "-" : ""}${period}.pdf` };
}

// One person's report for a month, as a PDF: who they are, their sales day by day, their team (for a senior), and their salary calculation.
// `canPay` false (a hub manager) leaves out everything about pay. `d` is the portal summary for that person.
function personReportPdf(d, { canPay, company = "" }) {
  const W = 595.28, H = 841.89, M = 46, BOTTOM = 56;
  const pdf = new Pdf();
  const m = d.me, mo = d.month;
  let y = 0;
  const page = () => { pdf.page(W, H); y = H - M; };
  const need = (h) => { if (y - h < BOTTOM) page(); };
  const row = (label, value, bold) => { need(14); pdf.text(M + 4, y - 9, fit(label, W - M * 2 - 140, 9, bold), 9, bold); const t = String(value); pdf.text(W - M - tw(t, 9, bold), y - 9, t, 9, bold); y -= 13; };
  const head = (t) => { need(34); y -= 8; pdf.text(M, y - 9, t, 10.5, true); y -= 14; pdf.line(M, y, W - M, y, 0.7); y -= 3; };
  const rs = (c) => "Rs " + fmtMoney(c);
  page();
  pdf.text(M, y - 14, `${company}${company ? " - " : ""}Personal report ${monthLabel(d.period)}`, 14, true); y -= 24;
  if (!d.finalized) { pdf.text(M, y - 9, "This month is not finalized yet - figures can still change.", 8.5, true, 0.5); y -= 14; }
  pdf.text(M, y - 10, `${m.name} (${m.employee_id})`, 12, true); y -= 17;
  pdf.text(M, y - 9, [m.level_name, m.hub_name || m.hub, m.reports_to ? `reports to ${m.reports_to}` : "", m.phone, m.join_date ? `joined ${m.join_date}` : ""].filter(Boolean).join("  -  "), 8.5, false, 0.35); y -= 14;

  head("Month at a glance");
  if (m.sells || mo.days) {
    row("Sales", rs(mo.business), true);
    row("Days with sales", String(mo.days));
    if (Number(mo.target) > 0) row(m.is_manager ? "Weekly target" : "Monthly target", rs(mo.target));
    if (Number(mo.target) > 0 && !m.is_manager) row(mo.to_go > 0 ? "Still to reach the target" : "Above the target", rs(mo.to_go > 0 ? mo.to_go : mo.over_target));
    if (mo.settle_up) row("Cash short at settle-up", rs(mo.settle_up));
    if (mo.personal) row("Advances taken", rs(mo.personal));
  }
  if (d.team) { row("People below", String(d.team.length)); if (!d.team_sales_hidden) row("Their sales this month", rs(d.below_sales)); }

  if (canPay) {
    const pay = d.official || d.estimate;
    head(`Salary calculation${pay ? (d.official ? " (final)" : " (estimate - not final)") : ""}`);
    if (pay) {
      for (const l of (pay.earnings || []).filter((x) => x.amount !== 0 || /Basic/.test(x.label))) row(l.label, fmtMoney(l.amount));
      row("Gross earnings", rs(pay.gross), true);
      const ded = (pay.deduction_lines || []).filter((x) => x.amount !== 0);
      if (ded.length) { y -= 3; for (const l of ded) row(l.label, "-" + fmtMoney(l.amount)); row("Total deductions", "-" + rs(pay.deductions), true); }
      y -= 3; row("Net pay", rs(pay.net), true);
      if (pay.closing || pay.opening) row("Balance carried (opening / closing)", `${fmtMoney(pay.opening)} / ${fmtMoney(pay.closing)}`);
    } else row(m.is_manager ? "A manager's pay is worked out from the weekly commission on his sales and his team's." : "No sales or entries this month, so there is nothing to calculate yet.", "");
  }

  if (mo.daily.length) {
    head("Day by day");
    const cols = [[M + 4, "Date", false], [M + 110, "Sales", true], [M + 200, "Cash handed in", true], [M + 300, "Advance", true], [M + 385, "Status", false]];
    const header = () => { cols.forEach(([x, t, r]) => pdf.text(r ? x + 70 - tw(t, 8, true) : x, y - 9, t, 8, true, 0.3)); y -= 13; };
    header();
    for (const r of mo.daily) {
      if (y - 14 < BOTTOM) { page(); header(); }
      const vals = [r.date, fmtMoney(r.business_amount), fmtMoney(r.settled_amount), Number(r.personal_minus) ? fmtMoney(r.personal_minus) : "-", r.source === "portal" ? (r.confirmed ? "entered, confirmed" : "entered, to confirm") : "office"];
      cols.forEach(([x, , right], i) => pdf.text(right ? x + 70 - tw(vals[i], 8.5) : x, y - 9, vals[i], 8.5));
      y -= 12.5;
    }
    need(16); pdf.line(M, y - 1, W - M, y - 1, 0.3); y -= 3; row("Total sales", rs(mo.business), true);
  }

  if (d.team && d.team.length) {
    head("Team (sales only)");
    const tcols = [[M + 4, "Name", false], [M + 200, "Position", false], [M + 340, "Days", true], [M + 400, "Sales", true]];
    const header = () => { tcols.forEach(([x, t, r]) => pdf.text(r ? x + (t === "Days" ? 30 : 90) - tw(t, 8, true) : x, y - 9, t, 8, true, 0.3)); y -= 13; };
    header();
    for (const t of d.team) {
      if (y - 14 < BOTTOM) { page(); header(); }
      pdf.text(M + 4 + (t.depth - 1) * 8, y - 9, fit(t.name, 190 - (t.depth - 1) * 8, 8.5), 8.5);
      pdf.text(M + 200, y - 9, fit(t.level_name, 130, 8.5), 8.5);
      const dd = String(t.days), ss = fmtMoney(t.business);
      pdf.text(M + 340 + 30 - tw(dd, 8.5), y - 9, dd, 8.5); pdf.text(M + 400 + 90 - tw(ss, 8.5), y - 9, ss, 8.5);
      y -= 12.5;
    }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return { data: pdf.build((p, n, of) => p.text(M, 22, `${company}  -  ${m.name}  -  ${d.period}  -  generated ${stamp}  -  page ${n} of ${of}`, 7, false, 0.4)),
    type: TYPES.pdf, filename: `report-${m.employee_id}-${d.period}.pdf` };
}

module.exports = { make, payslipsPdf, personReportPdf, renderXlsx, renderPdf, REPORTS };
