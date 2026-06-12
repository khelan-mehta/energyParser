/* ============================================================
 *  App shell — sidebar nav, topbar, client-side routing.
 * ============================================================ */
import { store, subscribe } from "../store";
import { authUser, logout } from "../api";
import { h, esc } from "./util";
import { ICON } from "./icons";

export type Route = "dashboard" | "marcus" | "mepc" | "report" | "rates" | "leed" | "docs" | "admin";

type RenderFn = (root: HTMLElement) => void | Promise<void>;
const routes: Partial<Record<Route, RenderFn>> = {};
export function registerRoute(name: Route, fn: RenderFn) { routes[name] = fn; }

let current: Route = "dashboard";
let contentEl: HTMLElement;
let navContainer: HTMLElement;

const NAV: { route: Route; label: string; icon: (c?: string) => string; group: string; adminOnly?: boolean }[] = [
  { route: "dashboard", label: "Dashboard", icon: ICON.dashboard, group: "menu" },
  { route: "marcus", label: "Marcus", icon: ICON.trace, group: "menu" },
  { route: "mepc", label: "MEPC", icon: ICON.table, group: "menu" },
  { route: "report", label: "Word Report", icon: ICON.book, group: "menu" },
  { route: "rates", label: "Utility Rates", icon: ICON.rates, group: "menu" },
  { route: "leed", label: "LEED Guidance", icon: ICON.leed, group: "general" },
  { route: "docs", label: "Documentation", icon: ICON.book, group: "general" },
  { route: "admin", label: "Admin", icon: ICON.settings, group: "general", adminOnly: true },
];

export function navigate(route: Route) {
  current = route;
  renderNav();
  renderContent();
  window.scrollTo({ top: 0 });
}

function renderContent() {
  if (!contentEl) return;
  contentEl.innerHTML = "";
  const fn = routes[current];
  if (fn) Promise.resolve(fn(contentEl)).catch((e) => { contentEl.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message || e)}</div>`)); });
}

function renderNav() {
  if (!navContainer) return;
  navContainer.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.route === current);
  });
}

export function mountShell(app: HTMLElement) {
  app.innerHTML = "";
  const isAdmin = authUser?.role === "admin";

  // ----- sidebar -----
  const sidebar = h(`<aside class="sidebar"></aside>`);
  sidebar.appendChild(h(`<div class="brand"><div class="brand-mark">M</div><div class="brand-name">Marc<b>us</b></div></div>`));
  navContainer = h(`<nav style="flex:1"></nav>`);
  for (const group of ["menu", "general"]) {
    navContainer.appendChild(h(`<div class="nav-label">${group === "menu" ? "Workspace" : "More"}</div>`));
    NAV.filter((x) => x.group === group && (!x.adminOnly || isAdmin)).forEach((item) => {
      const btn = h(`<button class="nav-item ${item.route === current ? "active" : ""}" data-route="${item.route}">${item.icon()} <span>${item.label}</span></button>`);
      btn.addEventListener("click", () => navigate(item.route));
      navContainer.appendChild(btn);
    });
  }
  sidebar.appendChild(navContainer);
  sidebar.appendChild(h(`
    <div class="sidebar-card">
      <h4><span class="dot"></span>Signed in</h4>
      <p>${esc(authUser?.name || "")} · ${esc(authUser?.role || "user")}</p>
      <button class="btn btn-sm" id="sb-logout" style="width:100%;justify-content:center;background:rgba(255,255,255,.1);color:#fff;border:none">Log out</button>
    </div>
  `));
  sidebar.querySelector("#sb-logout")!.addEventListener("click", () => logout());

  // ----- main -----
  const main = h(`<div class="main"></div>`);
  const initial = (authUser?.name || authUser?.email || "U").slice(0, 1).toUpperCase();
  const topbar = h(`
    <div class="topbar">
      <div class="search">${ICON.search()}<input id="global-search" placeholder="Search…" /></div>
      <div class="topbar-spacer"></div>
      <button class="icon-btn" title="Notifications">${ICON.bell()}<span class="ping"></span></button>
      <div class="user">
        <div class="avatar">${esc(initial)}</div>
        <div class="user-meta"><div class="n">${esc(authUser?.name || "User")}</div><div class="e">${esc(authUser?.email || "")}</div></div>
      </div>
    </div>
  `);
  contentEl = h(`<div class="content"></div>`);
  main.appendChild(topbar);
  main.appendChild(contentEl);
  app.appendChild(sidebar);
  app.appendChild(main);

  subscribe(() => { /* reserved for live badges */ });
  renderContent();
}
