/* ============================================================
 *  Project Setup — the project hub. Create a new (guided) project or
 *  open an existing one from the cards. Selecting a project loads it
 *  so the sidebar tools operate on it. Portfolio stats now live in
 *  their own "Portfolio Overview" tab.
 * ============================================================ */
import { store } from "../store";
import { Projects, Project, authUser } from "../api";
import { h, esc, fmt } from "../ui/util";
import { ICON } from "../ui/icons";
import { navigate, Route } from "../ui/shell";

export async function renderDashboard(root: HTMLElement) {
  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Project Setup</h1><p>Start a new guided project or open an existing one${authUser?.role === "admin" ? " · admin sees all users" : ""}.</p></div>
    </div>
  `));

  /* ---------- entry box: New Project · Existing Projects ---------- */
  const entry = h(`
    <div class="card" style="margin-top:16px">
      <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.bolt()}</div><h3>Get started</h3><span class="sub">create a project (guided) or open an existing one</span></div>
      <div class="grid cards-2" style="gap:12px;margin-top:6px">
        <button class="btn btn-primary" id="ps-new" style="justify-content:center;padding:16px;font-size:14px">${ICON.plus()} New Project</button>
        <button class="btn" id="ps-existing" style="justify-content:center;padding:16px;font-size:14px">${ICON.dashboard()} Existing Projects</button>
      </div>
    </div>
  `);
  root.appendChild(entry);
  entry.querySelector("#ps-new")!.addEventListener("click", () => { store.currentProject = null; navigate("wizard"); });

  let projects: Project[] = [];
  try { projects = (await Projects.list()).projects; }
  catch (e: any) { root.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message)}</div>`)); return; }

  /* ---------- selected-project banner + quick links ---------- */
  const selCard = h(`<div class="card" style="margin-top:16px;display:none" id="ps-sel">
    <div id="ps-selinfo" style="font-size:12.5px;color:var(--g500)"></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap" id="ps-links"></div>
  </div>`);
  const QUICK: { route: Route; label: string }[] = [
    { route: "rates", label: "Utility Data" },
    { route: "marcus", label: "Energy Comparison" },
    { route: "report", label: "Report" },
    { route: "mepc", label: "MEPC" },
  ];
  const links = selCard.querySelector("#ps-links")!;
  QUICK.forEach((q) => { const b = h(`<button class="btn btn-sm">${esc(q.label)} →</button>`); b.addEventListener("click", () => navigate(q.route)); links.appendChild(b); });
  root.appendChild(selCard);

  /* ---------- existing projects (cards, revealed on demand) ---------- */
  const existingWrap = h(`<div id="ps-existing-wrap" style="display:none;margin-top:16px"></div>`);
  root.appendChild(existingWrap);
  const existingBtn = entry.querySelector("#ps-existing") as HTMLButtonElement;
  existingBtn.addEventListener("click", () => {
    const open = existingWrap.style.display !== "none";
    existingWrap.style.display = open ? "none" : "block";
    if (!open) existingWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  if (!projects.length) {
    existingWrap.appendChild(h(`<div class="card"><div class="empty"><div class="big">🏢</div><div style="font-weight:600;color:var(--g600);margin-bottom:6px">No projects yet</div><button class="btn btn-primary btn-sm" id="ps-first">${ICON.plus()} Create your first project</button></div></div>`));
    existingWrap.querySelector("#ps-first")?.addEventListener("click", () => navigate("wizard"));
    return;
  }

  const selectProject = async (id: string) => {
    selCard.style.display = "block";
    const info = selCard.querySelector("#ps-selinfo")!;
    info.innerHTML = `<span class="spinner" style="width:12px;height:12px;vertical-align:middle"></span> Loading…`;
    try {
      const { project } = await Projects.get(id);
      store.currentProject = project;
      store.blRows = project.parsed?.bl || [];
      store.propRows = project.parsed?.prop || [];
      if (project.rates) store.rates = { ...store.rates, ...project.rates };
      const m = project.modelType, parsed = !!project.parsed;
      info.innerHTML = `▸ <b>${esc(project.name)}</b> · <span class="pt-badge pt-${m}">${esc(m)}</span> · ${esc(project.address || "no address")} · ${parsed ? `<span class="pill pill-red" style="font-size:9px">parsed</span>` : `<span class="pill pill-gray" style="font-size:9px">not parsed</span>`} — open a tool:`;
      existingWrap.querySelectorAll<HTMLElement>(".proj-tile").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
      selCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e: any) { info.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
  };

  existingWrap.appendChild(h(`<div style="font-family:var(--font);font-weight:800;font-size:14px;margin:2px 0 10px">Your projects <span style="color:var(--g400);font-weight:500">(${projects.length})</span></div>`));
  const grid = h(`<div class="proj-grid"></div>`);
  projects.sort((a, b) => b.updatedAt - a.updatedAt).forEach((p) => {
    const card = h(`<div class="proj-tile" data-id="${p.id}" style="cursor:pointer">
      <h4 style="margin:0">${esc(p.name)}</h4>
      <div class="pt-meta" style="margin-top:6px;line-height:1.5">${esc(p.address || "no address")}</div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="pt-badge pt-${p.modelType}">${esc(p.modelType)}</span>
        ${p.summary ? `<span class="pill pill-red" style="font-size:9px">EUI ${fmt(p.summary.eui, 1)}</span>` : `<span class="pill pill-gray" style="font-size:9px">not parsed</span>`}
      </div>
    </div>`);
    card.addEventListener("click", () => selectProject(p.id));
    grid.appendChild(card);
  });
  existingWrap.appendChild(grid);

  // If a project was already active, reveal the cards + its banner.
  const preId = store.currentProject && projects.some((p) => p.id === store.currentProject!.id) ? store.currentProject!.id : "";
  if (preId) { existingWrap.style.display = "block"; selectProject(preId); }
}
