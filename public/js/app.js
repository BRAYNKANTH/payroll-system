// App shell: auth gate, router, sidebar/topbar layout and shared state.
import { get, post, setUnauthorizedHandler } from "./api.js";
import { $, $$, esc, icon, initials, monthName, toast } from "./ui.js";

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
  { group: "Administration", perm: "manage_users" },
  { path: "/users", label: "Users & roles", icon: "key", page: "users", perm: "manage_users" },
  { path: "/settings", label: "Settings", icon: "settings", page: "settings", perm: "settings" },
];
const EXTRA_ROUTES = [
  { re: /^\/employees\/([\w.-]+)$/, page: "employee", nav: "/employees" },
  { re: /^\/account$/, page: "account", nav: null },
];

const pageCache = {};
async function loadPage(name) {
  if (!pageCache[name]) pageCache[name] = (await import(`./pages/${name}.js`)).default;
  return pageCache[name];
}

export function navigate(path, replace = false) {
  if (location.pathname === path && !replace) return render();
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  render();
}

function resolve(pathname) {
  const n = NAV.find((x) => x.path === pathname && x.page);
  if (n) return { page: n.page, nav: n.path, params: [] };
  for (const r of EXTRA_ROUTES) {
    const m = r.re.exec(pathname);
    if (m) return { page: r.page, nav: r.nav, params: m.slice(1) };
  }
  return { page: "dashboard", nav: "/", params: [] };
}

// ---------------------------------------------------------------- layout

function shell() {
  const u = state.user;
  const hubOpts = state.hubs.map((h) => `<option value="${esc(h.code)}" ${state.hub === h.code ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  document.body.innerHTML = `
  <div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><div class="brand-mark">₨</div><div><div class="brand-name">${esc(state.settings.company_name || "Payroll")}</div><div class="brand-sub">Payroll & hub accounts</div></div></div>
      <nav class="nav" id="nav">${NAV.filter((n) => !n.perm || can(n.perm)).map((n) => n.group
        ? `<div class="nav-group">${esc(n.group)}</div>`
        : `<a href="${n.path}" data-link data-nav="${n.path}">${icon(n.icon)}<span>${esc(n.label)}</span>${n.badge ? `<span class="count" id="pending-count" hidden></span>` : ""}</a>`).join("")}
      </nav>
      <div class="sidebar-foot">Signed in as <b style="color:#e2e8f0">${esc(u.username)}</b><br>${esc(u.role)}${u.hub ? ` · hub ${esc(u.hub)}` : ""}</div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn ghost icon menu-btn" id="menu-btn" aria-label="Menu">${icon("menu")}</button>
        <div><div class="crumb" id="crumb"></div><div class="title" id="page-title"></div></div>
        <div class="spacer"></div>
        ${u.hub ? `<span class="badge indigo plain">${icon("store")} ${esc(u.hub)}</span>` : `
        <select class="input sm" id="hub-filter" style="width:auto;min-width:140px" aria-label="Hub filter">
          <option value="">All hubs</option>${hubOpts}</select>`}
        <div class="period-picker" title="Pay period">
          <button id="prev-period" aria-label="Previous month">${icon("left")}</button>
          <input type="month" id="period" value="${esc(state.period)}" aria-label="Pay period">
          <button id="next-period" aria-label="Next month">${icon("right")}</button>
        </div>
        <button class="btn ghost icon" id="theme-btn" aria-label="Toggle theme">${icon("moon")}</button>
        <div class="user-chip" id="user-chip" tabindex="0">
          <div class="avatar">${esc(initials(u.full_name))}</div>
          <div class="who"><b>${esc(u.full_name)}</b><span>${esc(u.role)}</span></div>
        </div>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;

  $("#menu-btn").onclick = () => $("#sidebar").classList.toggle("open");
  $("#period").onchange = (e) => setPeriod(e.target.value);
  $("#prev-period").onclick = () => setPeriod(shift(state.period, -1));
  $("#next-period").onclick = () => setPeriod(shift(state.period, 1));
  $("#hub-filter")?.addEventListener("change", (e) => { state.hub = e.target.value; store.set("pr.hub", state.hub); render(); });
  $("#theme-btn").onclick = toggleTheme;
  $("#user-chip").onclick = userMenu;
  applyTheme();
}

function shift(p, d) {
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
}
function setPeriod(p) {
  if (!/^\d{4}-\d{2}$/.test(p)) return;
  state.period = p;
  store.set("pr.period", p);
  $("#period").value = p;
  render();
}

function applyTheme() {
  const t = store.get("pr.theme");
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const b = $("#theme-btn");
  if (b) b.innerHTML = icon(dark ? "sun" : "moon");
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  store.set("pr.theme", dark ? "light" : "dark");
  applyTheme();
}

function userMenu(e) {
  e.stopPropagation();
  const chip = $("#user-chip");
  if ($(".menu", chip)) return $(".menu", chip).remove();
  const m = document.createElement("div");
  m.className = "menu";
  m.innerHTML = `<div style="padding:8px 10px"><b>${esc(state.user.full_name)}</b><div class="faint" style="font-size:12px">${esc(state.user.username)} · ${esc(state.user.role)}</div></div><hr>
    <a href="/account" data-link>${icon("lock")} Change password</a>
    <button id="logout">${icon("logout")} Sign out</button>`;
  chip.append(m);
  m.querySelector("#logout").onclick = async () => { await post("/api/auth/logout").catch(() => {}); location.href = "/"; };
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }));
}

export async function refreshPending() {
  try {
    const q = await get("/api/review-queue");
    state.pending = q.length;
    const el = $("#pending-count");
    if (el) { el.textContent = q.length; el.hidden = !q.length; }
  } catch { /* ignore */ }
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const { page, nav, params } = resolve(location.pathname);
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
  $("#sidebar")?.classList.remove("open");
  // Fresh element each time so listeners attached by the previous page don't pile up.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  view.innerHTML = `<div class="loading-screen"><div class="spinner"></div></div>`;
  try {
    const mod = await loadPage(page);
    if (seq !== renderSeq) return;
    $("#page-title").textContent = mod.title;
    $("#crumb").textContent = mod.periodic ? monthName(state.period) : (NAV.find((n) => n.path === nav)?.label === mod.title ? "" : "");
    document.title = `${mod.title} · ${state.settings.company_name || "Payroll"}`;
    await mod.render({ el: view, params, isCurrent: () => seq === renderSeq });
  } catch (err) {
    if (seq !== renderSeq) return;
    view.innerHTML = `<div class="alert err">${icon("alert")}<div><b>Couldn't load this page.</b><br>${esc(err.message)}</div></div>`;
  }
}

// ---------------------------------------------------------------- boot

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target === "_blank") return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", () => state.user && render());
setUnauthorizedHandler(() => { if (state.user) { toast("Your session ended — please sign in again", "warn"); state.user = null; boot(); } });

export async function boot() {
  applyTheme();
  const s = await get("/api/auth/state");
  if (!s.user) {
    const login = (await import("./pages/login.js")).default;
    return login.render({ needsSetup: s.needs_setup, onDone: boot });
  }
  state.user = s.user;
  [state.hubs, state.settings] = await Promise.all([get("/api/hubs"), get("/api/settings")]);
  if (state.user.hub) state.hub = state.user.hub;
  else if (state.hub && !state.hubs.some((h) => h.code === state.hub)) state.hub = "";
  shell();
  await render();
  refreshPending();
}

boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">Could not start the app: ${esc(e.message)}</div>`;
});
