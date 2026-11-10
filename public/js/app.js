// App shell: auth gate, router, sidebar/topbar layout and shared state.
import { get, post, setUnauthorizedHandler } from "./api.js";
import { $, $$, esc, icon, initials, monthName, toast, announce, confirmDialog } from "./ui.js";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const state = {
  user: null,
  period: store.get("pr.period") || new Date().toISOString().slice(0, 7),
  hub: store.get("pr.hub") || "",
  hubs: [],
  settings: {},
  pending: 0,
};
export const can = (perm) => !!state.user?.permissions?.includes(perm);
export const scopeHub = () => state.user?.hub || state.hub || "";

const NAV = [
  { group: "Overview" },
  { path: "/", label: "Dashboard", icon: "dashboard", page: "dashboard" },
  { group: "Data entry" },
  { path: "/daily", label: "Daily sheet", icon: "sheet", page: "daily" },
  { path: "/weekly", label: "Weekly sheet", icon: "calendar", page: "weekly" },
  { path: "/stock", label: "Stock count", icon: "box", page: "stock" },
  { path: "/branch-stock", label: "Branch stock", icon: "store", page: "hubstock" },
  { path: "/allowances", label: "Allowances", icon: "gift", page: "allowances" },
  { group: "Payroll" },
  { path: "/payroll", label: "Payroll run", icon: "play", page: "payroll" },
  { path: "/approvals", label: "Approvals", icon: "shield", page: "approvals", badge: true },
  { path: "/payslips", label: "Payslips", icon: "file", page: "payslips" },
  { group: "People" },
  { path: "/employees", label: "Employees", icon: "users", page: "employees" },
  { path: "/hubs", label: "Hubs", icon: "store", page: "hubs" },
  { group: "Insights" },
  { path: "/reports", label: "Reports", icon: "chart", page: "reports" },
  { path: "/audit", label: "Audit trail", icon: "history", page: "audit" },
  { group: "My account", perm: "self" },
  { path: "/me", label: "My page", icon: "users", page: "portal", perm: "self" },
  { group: "Administration", perm: "manage_users" },
  { path: "/users", label: "Users & roles", icon: "key", page: "users", perm: "manage_users" },
  { path: "/settings", label: "Settings", icon: "settings", page: "settings", perm: "settings" },
];
const EXTRA_ROUTES = [
  { re: /^\/employees\/([\w.-]+)$/, page: "employee", nav: "/employees" },
  { re: /^\/account$/, page: "account", nav: null },
];
// A staff-portal login (a distributor, supervisor or group manager) gets one page about themselves and nothing else.
const isStaff = () => state.user?.role === "staff";
const roleText = (r) => (r === "staff" ? "Staff portal" : r);
const groupOf = (path) => {
  let g = "";
  for (const n of NAV) { if (n.group) g = n.group; else if (n.path === path) return g; }
  return "";
};

const pageCache = {};
async function loadPage(name) {
  if (!pageCache[name]) pageCache[name] = (await import(`./pages/${name}.js`)).default;
  return pageCache[name];
}

// ---------------------------------------------------------------- unsaved-changes guard
// Sheet pages register a function returning how many rows have unsaved edits.
let dirtyCheck = null;
export const setDirtyCheck = (fn) => (dirtyCheck = fn);
const dirtyCount = () => { try { return dirtyCheck ? Number(dirtyCheck()) || 0 : 0; } catch { return 0; } };
async function confirmLeave() {
  const n = dirtyCount();
  if (!n) return true;
  const ok = await confirmDialog({
    title: "Leave without saving?",
    message: `${n} row${n > 1 ? "s have" : " has"} unsaved changes on this page. They will be lost if you leave now.`,
    confirmText: "Discard changes", danger: true,
  });
  if (ok) dirtyCheck = null;
  return !!ok;
}
window.addEventListener("beforeunload", (e) => { if (dirtyCount()) { e.preventDefault(); e.returnValue = ""; } });

export async function navigate(path, replace = false) {
  if (!(await confirmLeave())) return;
  if (location.pathname === path && !replace) return render({ moveFocus: true });
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  render({ moveFocus: true });
}

function resolve(pathname) {
  const n = NAV.find((x) => x.path === pathname && x.page);
  if (n) return { page: n.page, nav: n.path, params: [], perm: n.perm };
  for (const r of EXTRA_ROUTES) {
    const m = r.re.exec(pathname);
    if (m) return { page: r.page, nav: r.nav, params: m.slice(1) };
  }
  return { page: null, nav: null, params: [] };
}

// ---------------------------------------------------------------- layout

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isMobile = () => matchMedia("(max-width: 860px)").matches;

function periodPicker() {
  const [y, m] = state.period.split("-").map(Number);
  const now = new Date().getFullYear();
  const years = [];
  for (let yy = Math.min(y, now - 3); yy <= Math.max(y, now + 1); yy++) years.push(yy);
  return `<div class="period-picker" role="group" aria-label="Pay period">
    <button type="button" id="prev-period" aria-label="Previous month">${icon("left")}</button>
    <select id="period-month" aria-label="Month">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? "selected" : ""}>${n}</option>`).join("")}</select>
    <span class="sep"></span>
    <select id="period-year" aria-label="Year">${years.map((yy) => `<option ${yy === y ? "selected" : ""}>${yy}</option>`).join("")}</select>
    <button type="button" id="next-period" aria-label="Next month">${icon("right")}</button>
  </div>`;
}

// The five things people open most, as a bar at the bottom of a phone. "More" opens the full menu.
function bottomNav() {
  const items = [["/", "Home", "dashboard"], can("enter_data") ? ["/daily", "Daily", "sheet"] : ["/reports", "Reports", "chart"], ["/payroll", "Payroll", "play"], ["/employees", "People", "users"]];
  return `<nav class="bottom-nav" id="bnav" aria-label="Main">${items.map(([path, label, ic]) =>
    `<a href="${path}" data-link data-nav="${path}">${icon(ic)}<span>${label}</span></a>`).join("")}
    <button type="button" id="bnav-more" aria-controls="sidebar" aria-haspopup="true">${icon("menu")}<span>More</span><span class="dot" id="more-dot" hidden></span></button></nav>`;
}

function shell() {
  const u = state.user;
  const hubOpts = state.hubs.map((h) => `<option value="${esc(h.code)}" ${state.hub === h.code ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  document.body.innerHTML = `
  <a class="skip-link" href="#view">Skip to main content</a>
  <div class="shell ${isStaff() ? "" : "has-bnav"}">
    <aside class="sidebar" id="sidebar" aria-label="Main menu">
      <div class="brand"><div class="brand-mark" aria-hidden="true">₨</div><div><div class="brand-name">${esc(state.settings.company_name || "Payroll")}</div><div class="brand-sub">Payroll & hub accounts</div></div></div>
      <button type="button" class="btn ghost icon sidebar-close" id="sidebar-close" aria-label="Close menu">${icon("x")}</button>
      <nav class="nav" id="nav" aria-label="Sections">${NAV.filter((n) => (isStaff() ? n.perm === "self" : !n.perm || can(n.perm))).map((n) => n.group
        ? `<div class="nav-group" aria-hidden="true">${esc(n.group)}</div>`
        : `<a href="${n.path}" data-link data-nav="${n.path}" title="${esc(n.label)}">${icon(n.icon)}<span>${esc(n.label)}</span>${n.badge ? `<span class="count" id="pending-count" hidden></span>` : ""}</a>`).join("")}
      </nav>
      <div class="sidebar-foot">Signed in as <b>${esc(u.username)}</b><br>${esc(roleText(u.role))}${u.hub ? ` · hub ${esc(u.hub)}` : ""}</div>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
    <div class="main">
      <header class="topbar">
        <button type="button" class="btn ghost icon menu-btn" id="menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
        <div class="crumbs" id="crumbs"></div>
        <div class="spacer"></div>
        <div class="filters" id="filters">
          ${isStaff() ? "" : u.hub ? `<span class="badge indigo plain">${icon("store")} ${esc(u.hub)}</span>` : `
          <select class="input sm" id="hub-filter" style="width:auto;min-width:140px" aria-label="Hub filter">
            <option value="">All hubs</option>${hubOpts}</select>`}
          ${periodPicker()}
        </div>
        <button type="button" class="btn ghost icon" id="theme-btn" aria-label="Switch to dark theme">${icon("moon")}</button>
        <div class="user-wrap" style="position:relative">
          <button type="button" class="user-chip" id="user-chip" aria-haspopup="true" aria-expanded="false" aria-controls="user-menu" aria-label="Account menu for ${esc(u.full_name)}">
            <span class="avatar" aria-hidden="true">${esc(initials(u.full_name))}</span>
            <span class="who"><b>${esc(u.full_name)}</b><span>${esc(roleText(u.role))}</span></span>
          </button>
          <div class="menu" id="user-menu" hidden>
            <div style="padding:8px 10px"><b>${esc(u.full_name)}</b><div class="faint text-sm">${esc(u.username)} · ${esc(roleText(u.role))}</div></div><hr>
            <a href="/account" data-link id="menu-account">${icon("lock")} Change password</a>
            <button type="button" id="logout">${icon("logout")} Sign out</button>
          </div>
        </div>
      </header>
      <div class="filterbar" id="filterbar"></div>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
  </div>
  ${isStaff() ? "" : bottomNav()}`;

  // Mobile: the hub/month filters move below the header so the sticky bar stays one row tall.
  const placeFilters = () => {
    const f = $("#filters");
    if (isMobile()) $("#filterbar").append(f); else $(".topbar .spacer").after(f);
  };
  matchMedia("(max-width: 860px)").addEventListener("change", () => { placeFilters(); syncSidebar(); });
  placeFilters();

  $("#menu-btn").onclick = () => (isMobile() ? setSidebar(true) : setRail(!rail));
  $("#sidebar-close").onclick = () => setSidebar(false);
  $("#bnav-more")?.addEventListener("click", () => setSidebar(true));
  $("#sidebar-backdrop").onclick = () => setSidebar(false);
  $("#sidebar").addEventListener("keydown", (e) => { if (e.key === "Escape" && isMobile()) { e.stopPropagation(); setSidebar(false); } });
  syncSidebar();

  $("#period-month").onchange = $("#period-year").onchange = () =>
    setPeriod(`${$("#period-year").value}-${String($("#period-month").value).padStart(2, "0")}`);
  $("#prev-period").onclick = () => setPeriod(shift(state.period, -1));
  $("#next-period").onclick = () => setPeriod(shift(state.period, 1));
  $("#hub-filter")?.addEventListener("change", async (e) => {
    if (!(await confirmLeave())) { e.target.value = state.hub; return; }
    state.hub = e.target.value; store.set("pr.hub", state.hub); render();
  });
  $("#theme-btn").onclick = toggleTheme;
  setupUserMenu();
  applyTheme();
}

// ---- mobile sidebar
let sidebarOpen = false;
let rail = store.get("pr.rail") === "1"; // desktop: icons-only sidebar, frees width for the sheets
function setRail(on) {
  rail = on;
  store.set("pr.rail", on ? "1" : "0");
  syncSidebar();
}
function syncSidebar() {
  const sb = $("#sidebar");
  if (!sb) return;
  const mobile = isMobile();
  $(".shell").classList.toggle("rail", rail && !mobile);
  $("#menu-btn").setAttribute("aria-label", mobile ? "Open menu" : rail ? "Expand menu" : "Collapse menu");
  sb.classList.toggle("open", mobile && sidebarOpen);
  sb.inert = mobile && !sidebarOpen;                 // closed off-canvas menu: not focusable
  $("#sidebar-backdrop").classList.toggle("show", mobile && sidebarOpen);
  $("#menu-btn").setAttribute("aria-expanded", String(mobile ? sidebarOpen : !rail));
  $("#bnav-more")?.setAttribute("aria-expanded", String(mobile && sidebarOpen));
  $$(".shell > .main").forEach((m) => (m.inert = mobile && sidebarOpen)); // page behind the open menu
}
function setSidebar(open) {
  sidebarOpen = open;
  syncSidebar();
  if (open) setTimeout(() => $("#nav a.active, #nav a")?.focus(), 50);
  else if (isMobile()) ($("#bnav-more") || $("#menu-btn"))?.focus();
}

function shift(p, d) {
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
}
async function setPeriod(p) {
  if (!/^\d{4}-\d{2}$/.test(p) || p === state.period) return;
  if (!(await confirmLeave())) { syncPeriodPicker(); return; }
  state.period = p;
  store.set("pr.period", p);
  syncPeriodPicker();
  announce(`Pay period ${monthName(p)}`);
  render();
}
function syncPeriodPicker() {
  const [y, m] = state.period.split("-").map(Number);
  const ys = $("#period-year");
  if (!ys) return;
  if (![...ys.options].some((o) => +o.value === y)) ys.insertAdjacentHTML("beforeend", `<option>${y}</option>`);
  ys.value = String(y);
  $("#period-month").value = String(m);
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark"; // light unless the user chose dark
}
function applyTheme() {
  const t = store.get("pr.theme");
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#faf8f4";
  const b = $("#theme-btn");
  if (b) { b.innerHTML = icon(isDark() ? "sun" : "moon"); b.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme"); }
}
function toggleTheme() {
  store.set("pr.theme", isDark() ? "light" : "dark");
  applyTheme();
}

// ---- user menu (disclosure button: Enter/Space opens, Escape closes, focus returns)
function setupUserMenu() {
  const btn = $("#user-chip"), menu = $("#user-menu");
  const items = () => [...menu.querySelectorAll("a, button")];
  const open = (focusFirst) => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); if (focusFirst) items()[0].focus(); };
  const close = (returnFocus) => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); if (returnFocus) btn.focus(); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden ? open(e.detail === 0) : close(false); });
  btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); open(true); } });
  menu.addEventListener("keydown", (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === "Escape") { e.stopPropagation(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === "Tab" && !e.shiftKey && i === list.length - 1) close(false);
  });
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) close(false); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".user-wrap")) close(false); });
  $("#logout").onclick = async () => {
    if (!(await confirmLeave())) return;
    await post("/api/auth/logout").catch(() => {});
    location.href = "/";
  };
}

export async function refreshPending() {
  try {
    const q = await get("/api/review-queue");
    state.pending = q.length;
    const el = $("#pending-count");
    if (el) { el.textContent = q.length; el.hidden = !q.length; el.setAttribute("aria-label", `${q.length} waiting`); }
    const dot = $("#more-dot");
    if (dot) { dot.hidden = !(q.length && can("review")); dot.setAttribute("aria-label", `${q.length} entries need review`); }
  } catch { /* ignore */ }
}

// Every tab bar becomes a real tablist: roles, selected state, one tab stop, arrow keys (Enter or Space opens the focused tab).
let tabSeq = 0;
function enhanceTabs(root) {
  root.querySelectorAll(".tabs").forEach((bar) => {
    if (bar.dataset.aria) return;
    bar.dataset.aria = "1";
    bar.setAttribute("role", "tablist");
    const panel = root.querySelector("#pane");
    const tabs = () => [...bar.querySelectorAll("button")];
    const sync = () => tabs().forEach((b) => {
      const on = b.classList.contains("on");
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && panel) panel.setAttribute("aria-labelledby", b.id);
    });
    tabs().forEach((b) => { b.setAttribute("role", "tab"); b.id ||= `tab-${++tabSeq}`; if (panel) b.setAttribute("aria-controls", "pane"); });
    if (panel) { panel.setAttribute("role", "tabpanel"); panel.tabIndex = 0; }
    sync();
    new MutationObserver(sync).observe(bar, { subtree: true, attributes: true, attributeFilter: ["class"] });
    bar.addEventListener("keydown", (e) => {
      const list = tabs(), i = list.indexOf(document.activeElement);
      const to = { ArrowRight: (i + 1) % list.length, ArrowLeft: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
      if (to === undefined || i < 0) return;
      e.preventDefault();
      list[to].focus();
    });
  });
}
// A tab bar wider than the screen fades at the edge that has more, so people know to swipe.
function fadeScrollers(root) {
  root.querySelectorAll(".tabs:not(.portal-tabs)").forEach((bar) => {
    const update = () => {
      bar.classList.toggle("fade-r", bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 4);
      bar.classList.toggle("fade-l", bar.scrollLeft > 4);
    };
    bar.addEventListener("scroll", update, { passive: true });
    new ResizeObserver(update).observe(bar);
    const on = bar.querySelector("button.on");
    if (on) bar.scrollLeft = Math.max(0, on.offsetLeft - 24);
    update();
  });
}

let renderSeq = 0;
// Give every table an accessible name from the nearest heading above it (or the page title).
function nameTables(root) {
  root.querySelectorAll("table").forEach((t) => {
    if (t.querySelector("caption") || t.hasAttribute("aria-label") || t.hasAttribute("aria-labelledby")) return;
    const h = t.closest(".card")?.querySelector("h3, h2") || root.querySelector("h1");
    if (h?.textContent.trim()) t.setAttribute("aria-label", h.textContent.trim());
  });
}

export async function render({ moveFocus = false } = {}) {
  const seq = ++renderSeq;
  dirtyCheck = null;
  if (isStaff() && !["/me", "/account"].includes(location.pathname)) history.replaceState({}, "", "/me");
  const { page, nav, params, perm } = resolve(location.pathname);
  $$("#nav a, #bnav a").forEach((a) => {
    const on = a.dataset.nav === nav;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (sidebarOpen) { sidebarOpen = false; syncSidebar(); }
  // Fresh element each time so listeners attached by the previous page don't pile up.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  view.setAttribute("aria-busy", "true");
  view.innerHTML = `<div class="loading-screen"><div class="spinner" role="img" aria-label="Loading"></div></div>`;
  const blocked = !page ? ["Page not found", "There is no page at this address."] : perm && !can(perm) ? ["No access", `Your role (${state.user.role}) cannot open this page.`] : null;
  if (blocked) {
    view.removeAttribute("aria-busy");
    document.title = `${blocked[0]} · ${state.settings.company_name || "Payroll"}`;
    $("#crumbs").innerHTML = `<b>${esc(blocked[0])}</b>`;
    view.innerHTML = `<div class="page-head"><div><h1>${esc(blocked[0])}</h1><p>${esc(blocked[1])}</p></div></div><a class="btn" href="${isStaff() ? "/me" : "/"}" data-link>${isStaff() ? "Back to my page" : "Back to the dashboard"}</a>`;
    if (moveFocus) { const h = view.querySelector("h1"); h.tabIndex = -1; h.focus({ preventScroll: true }); }
    return;
  }
  try {
    const mod = await loadPage(page);
    if (seq !== renderSeq) return;
    const group = groupOf(nav);
    $("#crumbs").innerHTML = `${group ? `<span class="crumb-group">${esc(group)}</span><span class="crumb-sep" aria-hidden="true">›</span>` : ""}<b>${esc(mod.title)}</b>`;
    document.title = `${mod.title} · ${state.settings.company_name || "Payroll"}`;
    await mod.render({ el: view, params, isCurrent: () => seq === renderSeq });
    if (seq !== renderSeq) return;
    view.removeAttribute("aria-busy");
    view.classList.add("page-in");
    nameTables(view);
    enhanceTabs(view);
    fadeScrollers(view);
    if (moveFocus) {
      // Move focus to the new page's heading so screen readers announce it and Tab starts at the content.
      const h1 = view.querySelector("h1");
      if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); } else view.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    view.removeAttribute("aria-busy");
    view.innerHTML = `<div class="alert err" role="alert">${icon("alert")}<div><b>Couldn't load this page.</b><br>${esc(err.message)}</div></div>`;
  }
}

// ---------------------------------------------------------------- boot

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target === "_blank") return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
// Back/forward: if the page has unsaved edits, stay put unless the user confirms.
let currentPath = location.pathname;
const _push = history.pushState.bind(history);
history.pushState = (s, t, url) => { _push(s, t, url); currentPath = location.pathname; };
window.addEventListener("popstate", async () => {
  if (!state.user) return;
  const target = location.pathname;
  if (dirtyCount()) {
    _push({}, "", currentPath);              // undo the URL change while we ask
    if (!(await confirmLeave())) return;
    history.pushState({}, "", target);
  }
  currentPath = location.pathname;
  render({ moveFocus: true });
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebarOpen) setSidebar(false); });
setUnauthorizedHandler(() => { if (state.user) { toast("Your session ended — please sign in again", "warn"); state.user = null; boot(); } });

export async function boot() {
  applyTheme();
  const s = await get("/api/auth/state");
  if (!s.user) {
    const login = (await import("./pages/login.js")).default;
    return login.render({ needsSetup: s.needs_setup, onDone: boot, company: s.company_name });
  }
  state.user = s.user;
  if (isStaff()) { state.hubs = []; state.settings = { company_name: s.company_name }; }
  else if (s.hubs && s.settings) { state.hubs = s.hubs; state.settings = s.settings; }
  else [state.hubs, state.settings] = await Promise.all([get("/api/hubs"), get("/api/settings")]);
  if (state.user.hub) state.hub = state.user.hub;
  else if (state.hub && !state.hubs.some((h) => h.code === state.hub)) state.hub = "";
  shell();
  await render();
  if (!isStaff()) refreshPending();
  warmPages();
}

// Once the first screen is up, fetch the code of the other pages in the background so the next tap has nothing to download.
function warmPages() {
  const names = [...new Set(NAV.filter((n) => n.page && (isStaff() ? n.perm === "self" : !n.perm || can(n.perm))).map((n) => n.page)), "employee"];
  const run = () => names.forEach((n) => loadPage(n).catch(() => {}));
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 3000 }); else setTimeout(run, 1500);
}

// Start downloading this address's page code now, in parallel with the sign-in check, instead of after it.
{ const first = resolve(location.pathname).page; if (first) loadPage(first).catch(() => {}); }
boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui" role="alert">Could not start the app: ${esc(e.message)}</div>`;
});
