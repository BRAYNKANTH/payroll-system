// Global search in the top bar: type a name, an employee ID, a phone number or a hub, pick a result, land on that page.
// Built as an ARIA combobox: the input keeps the focus, the arrow keys move through the results, Enter opens one, Esc closes the list.
// "/" or Ctrl+K from anywhere on the page jumps to the box. NIC numbers are deliberately not searchable here.
import { get } from "./api.js";
import { esc, icon, announce, levelLabel } from "./ui.js";

const MAX_PEOPLE = 8;
const MAX_HUBS = 3;
const FRESH_MS = 60_000; // the people list is fetched when the box is first used, then reused for a minute

export function mountSearch(host, { navigate, state, scopeHub }) {
  host.innerHTML = `
    <label class="sr-only" for="gs-input">Search people and hubs</label>
    <span class="gs-ico" aria-hidden="true">${icon("search")}</span>
    <input id="gs-input" class="input sm" type="text" role="combobox" aria-expanded="false" aria-controls="gs-list" aria-autocomplete="list"
      placeholder="Search people, hubs" autocomplete="off" spellcheck="false" enterkeyhint="search">
    <kbd class="gs-key" aria-hidden="true">/</kbd>
    <ul id="gs-list" role="listbox" aria-label="Search results" hidden></ul>`;
  const input = host.querySelector("input"), list = host.querySelector("ul");
  let people = [], loadedAt = 0, loading = null, items = [], active = -1;

  const load = () => {
    if (Date.now() - loadedAt < FRESH_MS && people.length) return Promise.resolve();
    loading = loading || get("/api/staff" + (scopeHub() ? `?hub=${encodeURIComponent(scopeHub())}` : ""))
      .then((rows) => { people = rows; loadedAt = Date.now(); })
      .catch(() => { /* leave the old list; the next focus tries again */ })
      .finally(() => { loading = null; });
    return loading;
  };

  const norm = (s) => String(s || "").toLowerCase();
  const digits = (s) => String(s || "").replace(/\D/g, "");

  function search(raw) {
    const q = norm(raw).trim();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    const qd = digits(q);
    const hubs = (state.hubs || []).filter((h) => tokens.every((t) => norm(`${h.name} ${h.code} ${h.location || ""}`).includes(t)))
      .slice(0, MAX_HUBS).map((h) => ({ kind: "hub", id: h.code, label: h.name, sub: `${h.code}${h.location ? " · " + h.location : ""}`, href: `/hubs/${encodeURIComponent(h.code)}` }));
    const scored = [];
    for (const s of people) {
      const hay = norm(`${s.name} ${s.employee_id}`);
      const ph = digits(s.phone);
      const hit = tokens.every((t) => hay.includes(t)) || (qd.length >= 3 && ph.includes(qd));
      if (!hit) continue;
      const nm = norm(s.name);
      const score = (norm(s.employee_id) === q ? 0 : nm.startsWith(q) ? 1 : nm.split(/\s+/).some((w) => w.startsWith(tokens[0])) ? 2 : 3) + (s.status === "active" ? 0 : 10);
      scored.push([score, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    const hubName = (c) => (state.hubs || []).find((h) => h.code === c)?.name || c;
    const folks = scored.slice(0, MAX_PEOPLE).map(([, s]) => ({ kind: "person", id: s.employee_id, label: s.name,
      sub: `${s.employee_id} · ${levelLabel(s.staff_level)} · ${hubName(s.hub)}${s.status === "active" ? "" : " · inactive"}`, href: `/employees/${encodeURIComponent(s.employee_id)}` }));
    return [...hubs, ...folks];
  }

  function draw(query) {
    items = search(query);
    active = items.length ? 0 : -1;
    if (!query.trim()) return close();
    let html = "", lastKind = "";
    items.forEach((it, i) => {
      if (it.kind !== lastKind) { html += `<li role="presentation" class="gs-head">${it.kind === "hub" ? "Hubs" : "People"}</li>`; lastKind = it.kind; }
      html += `<li role="option" id="gs-o${i}" class="gs-opt" data-i="${i}" aria-selected="${i === active}"><b>${esc(it.label)}</b><span>${esc(it.sub)}</span></li>`;
    });
    if (!items.length) html = `<li role="presentation" class="gs-none">${loading ? "Searching…" : `No people or hubs match “${esc(query.trim())}”`}</li>`;
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    mark();
    announce(items.length ? `${items.length} result${items.length === 1 ? "" : "s"}` : "No results");
  }

  function mark() {
    list.querySelectorAll("[role=option]").forEach((o) => o.setAttribute("aria-selected", String(+o.dataset.i === active)));
    if (active >= 0) { input.setAttribute("aria-activedescendant", `gs-o${active}`); list.querySelector(`#gs-o${active}`)?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }

  function close() {
    list.hidden = true; list.innerHTML = ""; items = []; active = -1;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  }

  function open(it) {
    if (!it) return;
    close(); input.value = ""; input.blur();
    navigate(it.href);
  }

  input.addEventListener("focus", () => { load().then(() => { if (input.value.trim() && document.activeElement === input) draw(input.value); }); });
  input.addEventListener("input", () => { load().then(() => { if (document.activeElement === input) draw(input.value); }); draw(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) draw(input.value); else { active = items.length ? (active + 1) % items.length : -1; mark(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; mark(); } }
    else if (e.key === "Enter") { if (active >= 0) { e.preventDefault(); open(items[active]); } }
    else if (e.key === "Escape") { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } else if (input.value) input.value = ""; }
    else if (e.key === "Tab") close();
  });
  // mousedown, not click, so the input does not lose focus (and close the list) before the choice registers
  list.addEventListener("mousedown", (e) => { const o = e.target.closest("[role=option]"); if (o) { e.preventDefault(); open(items[+o.dataset.i]); } });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));

  // "/" or Ctrl/Cmd+K from anywhere that is not already a text field
  if (window.__gsKey) document.removeEventListener("keydown", window.__gsKey);
  window.__gsKey = (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      if (!host.isConnected || host.offsetParent === null) return;
      e.preventDefault(); input.focus(); input.select();
    }
  };
  document.addEventListener("keydown", window.__gsKey);
}
