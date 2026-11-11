// Phone-first helpers: split long screens into steps or sections so a small screen shows one thing at a time.
// Everything here is keyboard and screen-reader friendly: real buttons, announced progress, focus moves to the new heading.
import { esc, icon, announce } from "./ui.js";

export const isPhone = () => matchMedia("(max-width: 860px)").matches;

// ---------------------------------------------------------------- step-by-step form
// The form's `.form-section` headings mark where each step starts. Fields hidden by the page (the `hidden` attribute)
// are respected, so a step with nothing to show is skipped. A final "Check and save" step lists the answers.
export function stepForm({ form, foot, titles = {}, finishLabel = "Save", onFinish, review, noun = "form" }) {
  const steps = [];
  let cur = null;
  for (const n of [...form.children]) {
    if (n.classList.contains("form-section")) {
      cur = { key: n.textContent.trim(), title: titles[n.textContent.trim()] || n.textContent.trim(), nodes: [] };
      n.dataset.stepHeading = "1";
      steps.push(cur);
    } else if (cur) cur.nodes.push(n);
  }
  const REVIEW = { key: "review", title: "Check and save", nodes: [] };
  const all = [...steps, REVIEW];

  const head = document.createElement("div");
  head.className = "stepper-head";
  head.innerHTML = `<p class="step-count" id="step-count"></p><h3 class="step-title" id="step-title" tabindex="-1"></h3>
    <div class="step-bar" role="progressbar" aria-label="Progress through the ${esc(noun)}" aria-valuemin="1"><span></span></div>
    <div class="step-errors" id="step-errors" role="alert" tabindex="-1" hidden></div>`;
  form.prepend(head);
  const reviewBox = document.createElement("div");
  reviewBox.className = "step-review";
  reviewBox.hidden = true;
  form.append(reviewBox);

  const back = document.createElement("button");
  back.type = "button"; back.className = "btn"; back.textContent = "Back"; back.hidden = true;
  const next = document.createElement("button");
  next.type = "button"; next.className = "btn primary"; next.id = "step-next";
  foot.append(back, next);
  foot.classList.add("stepper-foot");
  foot.querySelectorAll(".btn.primary:not(#step-next)").forEach((b) => (b.hidden = true)); // the page's own Save button, used on the last step

  const hasContent = (s) => s === REVIEW || s.nodes.some((n) => !n.hidden && !n.dataset.stepOff);
  const visible = () => all.filter((s) => s === REVIEW || s.nodes.some((n) => !n.hidden));
  let index = 0;
  const current = () => visible()[index];

  const labelOf = (inp) => form.querySelector(`label[for="${inp.id}"]`)?.textContent.trim() || inp.getAttribute("aria-label") || inp.name;
  const clearErrors = () => { head.querySelector("#step-errors").hidden = true; form.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid")); };
  const validate = (s) => {
    const bad = [];
    s.nodes.filter((n) => !n.hidden).forEach((n) => n.querySelectorAll("input[required], select[required]").forEach((i) => {
      if (!i.disabled && !String(i.value).trim()) bad.push(i);
    }));
    clearErrors();
    if (!bad.length) return true;
    bad.forEach((i) => i.setAttribute("aria-invalid", "true"));
    const box = head.querySelector("#step-errors");
    box.innerHTML = `${icon("alert")}<div><b>${bad.length === 1 ? "One answer is missing" : `${bad.length} answers are missing`}</b><ul>${bad.map((i) => `<li><a href="#${esc(i.id || "")}" data-fix="${esc(i.id || "")}">${esc(labelOf(i))} is required</a></li>`).join("")}</ul></div>`;
    box.hidden = false;
    box.querySelectorAll("[data-fix]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); form.querySelector(`#${CSS.escape(a.dataset.fix)}`)?.focus(); }));
    bad[0].focus();
    return false;
  };

  function show(i, { move = true } = {}) {
    const list = visible();
    index = Math.max(0, Math.min(i, list.length - 1));
    const s = list[index];
    all.forEach((st) => st.nodes.forEach((n) => (n.dataset.stepOff = st === s ? "" : "1")));
    form.querySelectorAll("[data-step-heading]").forEach((h) => (h.dataset.stepOff = "1"));
    all.forEach((st) => st.nodes.forEach((n) => { if (st === s) delete n.dataset.stepOff; }));
    reviewBox.hidden = s !== REVIEW;
    if (s === REVIEW) reviewBox.innerHTML = `<dl class="kv">${review().map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`).join("")}</dl>
      <p class="muted" style="margin:12px 0 0">Everything look right? Press <b>${esc(finishLabel)}</b>, or go back to change an answer.</p>`;
    const n = list.length;
    head.querySelector("#step-count").textContent = `Step ${index + 1} of ${n}`;
    head.querySelector("#step-title").textContent = s.title;
    const bar = head.querySelector(".step-bar");
    bar.setAttribute("aria-valuemax", String(n)); bar.setAttribute("aria-valuenow", String(index + 1)); bar.setAttribute("aria-valuetext", `Step ${index + 1} of ${n}: ${s.title}`);
    bar.firstElementChild.style.width = `${((index + 1) / n) * 100}%`;
    back.hidden = index === 0;
    next.textContent = index === n - 1 ? finishLabel : "Next";
    clearErrors();
    if (move) {
      announce(`Step ${index + 1} of ${n}: ${s.title}`);
      head.querySelector("#step-title").focus({ preventScroll: true });
      form.closest(".drawer-body, .modal-body")?.scrollTo({ top: 0 });
    }
  }
  next.onclick = () => {
    const s = current();
    if (!validate(s)) return;
    if (s === REVIEW) return onFinish();
    show(index + 1);
  };
  back.onclick = () => show(index - 1);
  // Enter in a field moves on, instead of submitting a half-filled form.
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input") && !e.target.matches("[type=submit]")) { e.preventDefault(); next.click(); } });
  // A change elsewhere (for example the position) can show or hide whole steps.
  form.addEventListener("change", () => show(index, { move: false }));
  show(0, { move: false });
  return { show, refresh: () => show(index, { move: false }), steps: all };
}

// ---------------------------------------------------------------- settings-style sections: a menu, then one section at a time
export function sectionScreens({ container, sections, saveRow, noun = "Settings" }) {
  const nav = document.createElement("nav");
  nav.className = "sec-menu";
  nav.setAttribute("aria-label", `${noun} sections`);
  nav.innerHTML = `<ul>${sections.map((s, i) => `<li><button type="button" class="m-card" data-sec="${i}"><span><b>${esc(s.title)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</span>
    <span class="chev" aria-hidden="true"></span></button></li>`).join("")}</ul>`;
  container.prepend(nav);
  const bar = document.createElement("div");
  bar.className = "sec-bar";
  bar.hidden = true;
  bar.innerHTML = `<button type="button" class="btn" id="sec-back">${icon("left")} ${esc(noun)}</button>`;
  nav.after(bar);
  let openIndex = -1;
  const showMenu = (focusIdx) => {
    openIndex = -1;
    nav.hidden = false; bar.hidden = true;
    sections.forEach((s) => (s.el.hidden = true));
    if (saveRow) saveRow.hidden = true;
    announce(`${noun}. Choose a section.`);
    if (focusIdx >= 0) nav.querySelector(`[data-sec="${focusIdx}"]`)?.focus();
  };
  const open = (i) => {
    openIndex = i;
    nav.hidden = true; bar.hidden = false;
    sections.forEach((s, j) => (s.el.hidden = j !== i));
    if (saveRow) saveRow.hidden = false;
    announce(`${sections[i].title} section`);
    const h = sections[i].el.querySelector("h2, h3");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    window.scrollTo(0, 0);
  };
  nav.querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => open(Number(b.dataset.sec))));
  bar.querySelector("#sec-back").onclick = () => { const i = openIndex; showMenu(i); window.scrollTo(0, 0); };
  showMenu(-1);
}

// ---------------------------------------------------------------- cards that open and close (dashboard sections)
export function foldCards(cards, { open = [] } = {}) {
  cards.forEach((card, n) => {
    const head = card.querySelector(".card-head");
    const body = card.querySelector(".card-body");
    const title = card.querySelector("h2, h3")?.textContent.trim() || "section";
    if (!head || !body) return;
    body.id ||= `fold-${Math.random().toString(36).slice(2, 8)}`;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "fold-btn";
    btn.setAttribute("aria-controls", body.id);
    const set = (on) => {
      body.hidden = !on;
      btn.setAttribute("aria-expanded", String(on));
      btn.setAttribute("aria-label", `${on ? "Hide" : "Show"} ${title}`);
      card.classList.toggle("is-open", on);
    };
    btn.innerHTML = `<span class="chev" aria-hidden="true"></span>`;
    head.append(btn);
    head.classList.add("fold-head");
    btn.onclick = () => set(body.hidden);
    head.addEventListener("click", (e) => { if (!e.target.closest("a, button")) btn.click(); });
    set(open.includes(n));
  });
}

// ---------------------------------------------------------------- tables that become one card per row
// Works on the real table, so the cells keep their meaning for screen readers: roles are added because
// "display: block" strips them in some browsers.
export function stackTable(table, { grid = false, wideFirst = 0 } = {}) {
  if (!table || table.dataset.stacked) return;
  table.dataset.stacked = "1";
  table.classList.add("stack");
  if (grid) table.classList.add("grid2"); // fields sit two to a row, label above, so a card stays short
  if (wideFirst) table.dataset.wideFirst = String(wideFirst); // the first N cells of each card span the whole width
  table.setAttribute("role", "table");
  const heads = [...(table.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.trim());
  table.querySelectorAll("thead, tbody, tfoot").forEach((g) => g.setAttribute("role", "rowgroup"));
  table.querySelectorAll("tr").forEach((tr) => {
    tr.setAttribute("role", "row");
    [...tr.cells].forEach((c, i) => {
      const inHead = !!c.closest("thead");
      c.setAttribute("role", inHead ? "columnheader" : c.tagName === "TH" ? "rowheader" : "cell");
      if (!inHead && heads[i] && c.tagName !== "TH") c.dataset.label = heads[i];
    });
  });
}

// ---------------------------------------------------------------- a process with several stages: show the current one
// `list` holds the `.step` elements (state classes: done, current). The full list stays one tap away.
export function compactSteps(list, { actions = {} } = {}) {
  const steps = [...list.querySelectorAll(".step")];
  if (!steps.length) return;
  let now = steps.findIndex((s) => s.classList.contains("current"));
  if (now < 0) now = steps.findIndex((s) => !s.classList.contains("done"));
  if (now < 0) now = steps.length - 1;
  const text = (s, sel) => s.querySelector(sel)?.textContent.trim() || "";
  const holder = list.closest(".card") || list;
  const done = steps.every((s) => s.classList.contains("done"));
  const box = document.createElement("section");
  box.className = "card mb-4 step-now";
  box.setAttribute("aria-label", "Where this month is up to");
  const act = actions[now];
  box.innerHTML = `<div class="card-body">
    <p class="step-count">${done ? "All steps done" : `Step ${now + 1} of ${steps.length}`}</p>
    <h2 class="step-title">${esc(text(steps[now], ".t"))}</h2>
    <p class="muted" style="margin:2px 0 12px">${esc(text(steps[now], ".d"))}</p>
    <div class="step-bar" role="progressbar" aria-label="Month progress" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${steps.filter((s) => s.classList.contains("done")).length}"
      aria-valuetext="${steps.filter((s) => s.classList.contains("done")).length} of ${steps.length} steps done"><span style="width:${(steps.filter((s) => s.classList.contains("done")).length / steps.length) * 100}%"></span></div>
    <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
      ${act ? `<a class="btn primary" href="${esc(act[0])}" data-link>${esc(act[1])}</a>` : ""}
      <button type="button" class="btn" id="all-steps" aria-expanded="false" aria-controls="steps-all">All steps</button></div></div>`;
  holder.before(box);
  holder.id = "steps-all";
  holder.hidden = true;
  box.querySelector("#all-steps").onclick = (e) => {
    holder.hidden = !holder.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!holder.hidden));
    e.currentTarget.textContent = holder.hidden ? "All steps" : "Hide steps";
  };
}
