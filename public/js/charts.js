// Small dependency-free SVG charts with hover tooltips.
import { esc, compact, money } from "./ui.js";

let tip;
function showTip(e, text) {
  if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; document.body.append(tip); }
  tip.innerHTML = text;
  tip.style.display = "block";
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = e.clientY - tip.offsetHeight - 10 + "px";
}
const hideTip = () => tip && (tip.style.display = "none");

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// Tooltips: mouse hover, tap (touch) and arrow keys (when the chart has focus) all show the value.
function bindTips(container) {
  const pts = [...container.querySelectorAll("[data-tip]")];
  pts.forEach((el) => {
    el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("click", (e) => { e.stopPropagation(); showTip(e, el.dataset.tip); });
  });
  const svg = container.querySelector("svg");
  if (!svg || !pts.length) return;
  let i = -1;
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    i = (i + (e.key === "ArrowRight" ? 1 : -1) + pts.length) % pts.length;
    const r = pts[i].getBoundingClientRect();
    showTip({ clientX: r.left + r.width / 2, clientY: r.top + 20 }, pts[i].dataset.tip);
  });
  svg.addEventListener("blur", hideTip);
}
document.addEventListener("click", hideTip);

// Visually hidden data table so screen-reader users get the same numbers as the chart.
function srTable(label, headers, rows) {
  const cell = (c, j) => (j ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`);
  return `<table class="sr-only"><caption>${esc(label)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table>`;
}
const seriesTable = (label, labels, series) =>
  srTable(label, ["", ...series.map((s) => s.name)], labels.map((l, i) => [l, ...series.map((s) => "Rs " + money(s.values[i] || 0))]));
const svgLabel = (label) => `${esc(label)}. Use the left and right arrow keys to read values.`;

const legend = (series) => `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;

// Grouped bar chart. labels: string[], series: [{ name, color, values: cents[] }]
export function barChart(el, { labels, series, height = 260, label = "Bar chart" }) {
  const W = 640, H = height, L = 52, R = 10, T = 14, B = 30;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const lo = min < 0 ? -niceMax(-min) : 0;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (max - lo));
  const band = (W - L - R) / Math.max(labels.length, 1);
  const bw = Math.min(28, (band * 0.72) / series.length);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((max - lo) * i) / 4;
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  labels.forEach((lab, i) => {
    const cx = L + band * i + band / 2;
    const start = cx - (bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      const top = y(Math.max(v, 0)), bot = y(Math.min(v, 0));
      g += `<rect x="${start + j * bw + 1}" y="${top}" width="${bw - 2}" height="${Math.max(bot - top, 1)}" rx="4" fill="${s.color}"
        data-tip="${esc(`<b>${esc(lab)}</b><br>${esc(s.name)}: Rs ${money(v)}`)}"/>`;
    });
    g += `<text x="${cx}" y="${H - 10}" text-anchor="middle">${esc(lab.length > 14 ? lab.slice(0, 13) + "…" : lab)}</text>`;
  });
  el.innerHTML = `${legend(series)}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${svgLabel(label)}">${g}</svg>${seriesTable(label, labels, series)}`;
  bindTips(el);
}

// Line / area chart. series: [{ name, color, values }]
export function lineChart(el, { labels, series, height = 260, area = true, label = "Line chart" }) {
  const W = 640, H = height, L = 52, R = 14, T = 14, B = 30;
  const all = series.flatMap((s) => s.values);
  const max = niceMax(Math.max(0, ...all));
  const lo = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
  const x = (i) => L + ((W - L - R) * i) / Math.max(labels.length - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (max - lo));
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((max - lo) * i) / 4;
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  labels.forEach((lab, i) => { g += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(lab)}</text>`; });
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    if (area) {
      g += `<polygon fill="${s.color}" fill-opacity=".08" points="${x(0)},${y(Math.max(lo, 0))} ${pts} ${x(s.values.length - 1)},${y(Math.max(lo, 0))}"/>`;
    }
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`;
    s.values.forEach((v, i) => {
      g += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--surface)" stroke="${s.color}" stroke-width="2.5"/>`;
    });
  });
  // hover columns
  labels.forEach((lab, i) => {
    const w = (W - L - R) / Math.max(labels.length - 1, 1);
    const tipText = `<b>${esc(lab)}</b>` + series.map((s) => `<br><span style="color:${s.color}">●</span> ${esc(s.name)}: Rs ${money(s.values[i] || 0)}`).join("");
    g += `<rect x="${x(i) - w / 2}" y="${T}" width="${w}" height="${H - T - B}" fill="transparent" data-tip="${esc(tipText)}"/>`;
  });
  el.innerHTML = `${legend(series)}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${svgLabel(label)}">${g}</svg>${seriesTable(label, labels, series)}`;
  bindTips(el);
}

// Donut. items: [{ name, value, color }]
export function donutChart(el, { items, center = "", sub = "", label = "Donut chart" }) {
  const total = items.reduce((t, i) => t + Math.max(0, i.value), 0) || 1;
  const R = 70, C = 2 * Math.PI * R;
  let off = 0, g = "";
  items.forEach((it) => {
    const len = (Math.max(0, it.value) / total) * C;
    g += `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${it.color}" stroke-width="26" stroke-dasharray="${len} ${C - len}"
      stroke-dashoffset="${-off}" transform="rotate(-90 100 100)" data-tip="${esc(`<b>${esc(it.name)}</b><br>Rs ${money(it.value)} (${((it.value / total) * 100).toFixed(1)}%)`)}"/>`;
    off += len;
  });
  el.innerHTML = `<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <svg viewBox="0 0 200 200" style="width:170px;height:170px;flex-shrink:0" role="img" aria-label="${esc(label)}: ${esc(items.map((it) => `${it.name} Rs ${money(it.value)}`).join(", "))}">
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="26"/>${g}
      <text x="100" y="98" text-anchor="middle" style="font:700 18px var(--font);fill:var(--text)">${esc(center)}</text>
      <text x="100" y="118" text-anchor="middle" style="font:11px var(--font);fill:var(--text-3)">${esc(sub)}</text>
    </svg>
    <div style="display:grid;gap:8px;flex:1;min-width:160px">${items.map((it) => `
      <div style="display:flex;align-items:center;gap:8px;font-size:13px"><i style="width:10px;height:10px;border-radius:3px;background:${it.color}"></i>
      <span style="flex:1;color:var(--text-2)">${esc(it.name)}</span><b class="num">${compact(it.value)}</b></div>`).join("")}</div></div>`;
  bindTips(el);
}

export const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
