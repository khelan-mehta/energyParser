/* ============================================================
 *  Dashboard — project hub. Pick a project, then reach its tools:
 *    1. Project Utility Data        → Utility Rates
 *    2. Project Energy Data         → a. Energy Results Comparison (Marcus)
 *                                     b. Energy Results Report (Word Report)
 *                                     c. MEPC Calculator
 *  A small portfolio overview (stats + charts) sits below the hub.
 * ============================================================ */
import { store } from "../store";
import { Projects, Project, authUser } from "../api";
import { h, esc, fmt, fmtCompact, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { makeChart, gridOpts, PALETTE } from "../ui/charts";
import { navigate, Route } from "../ui/shell";

type Tool = { icon: string; title: string; desc: string; route: Route };

export async function renderDashboard(root: HTMLElement) {
  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Select a project to open its utility &amp; energy tools${authUser?.role === "admin" ? " · admin sees all users" : ""}.</p></div>
      <div class="actions"><button class="btn btn-primary" id="db-new">${ICON.plus()} New Project</button></div>
    </div>
  `));
  root.querySelector("#db-new")!.addEventListener("click", () => { store.currentProject = null; navigate("marcus"); });

  let projects: Project[] = [];
  try { projects = (await Projects.list()).projects; }
  catch (e: any) { root.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message)}</div>`)); return; }

  if (!projects.length) {
    root.appendChild(h(`<div class="card" style="margin-top:16px"><div class="empty"><div class="big">🏢</div><div style="font-weight:600;color:var(--g600);margin-bottom:6px">No projects yet</div><button class="btn btn-primary btn-sm" id="db-go">${ICON.plus()} Create your first project</button></div></div>`));
    root.querySelector("#db-go")?.addEventListener("click", () => navigate("marcus"));
    return;
  }

  /* ---------- project selector ---------- */
  const preId = store.currentProject && projects.some((p) => p.id === store.currentProject!.id) ? store.currentProject!.id : "";
  const selCard = h(`
    <div class="card" style="margin-top:16px">
      <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.bolt()}</div><h3>Select a project</h3><span class="sub">its tools unlock once a project is chosen</span></div>
      <select id="db-proj" class="unit-pick" style="width:100%;max-width:460px">
        <option value="">— choose a project —</option>
        ${projects.sort((a, b) => b.updatedAt - a.updatedAt).map((p) => `<option value="${p.id}" ${p.id === preId ? "selected" : ""}>${esc(p.name)} — ${esc(p.address || "no address")}${p.summary ? ` · EUI ${fmt(p.summary.eui, 1)}` : " · not parsed"}</option>`).join("")}
      </select>
      <div id="db-selinfo" style="margin-top:10px;font-size:12.5px;color:var(--g500)"></div>
    </div>
  `);
  root.appendChild(selCard);

  /* ---------- tool sections ---------- */
  const utilityTools: Tool[] = [
    { icon: ICON.rates("x"), title: "Project Utility Data", desc: "Electricity, gas, carbon &amp; water rates + citations for this project.", route: "rates" },
  ];
  const energyTools: Tool[] = [
    { icon: ICON.chart("x"), title: "Energy Results Comparison", desc: "Parse the models &amp; compare baseline vs proposed (EUI, energy, carbon, cost) · export Excel.", route: "marcus" },
    { icon: ICON.book("x"), title: "Energy Results Report", desc: "Auto-fill the formatted Energy Model Report (.docx) from the comparison workbook.", route: "report" },
    { icon: ICON.table("x"), title: "MEPC Calculator", desc: "eQUEST/DOE-2 .SIM → LEED v4 Minimum Energy Performance Calculator.", route: "mepc" },
  ];

  root.appendChild(sectionTitle("1 · Project Utility Data"));
  root.appendChild(toolGrid(utilityTools));
  root.appendChild(sectionTitle("2 · Project Energy Data"));
  root.appendChild(toolGrid(energyTools));

  const setEnabled = (on: boolean) => {
    root.querySelectorAll<HTMLElement>(".tool-card").forEach((el) => {
      el.classList.toggle("disabled", !on);
      el.style.opacity = on ? "1" : ".5";
      el.style.pointerEvents = on ? "auto" : "none";
    });
  };

  const selectProject = async (id: string) => {
    const info = selCard.querySelector("#db-selinfo")!;
    if (!id) { store.currentProject = null; info.textContent = "No project selected — pick one above to enable the tools."; setEnabled(false); return; }
    info.innerHTML = `<span class="spinner" style="width:12px;height:12px;vertical-align:middle"></span> Loading…`;
    try {
      const { project } = await Projects.get(id);
      store.currentProject = project;
      store.blRows = project.parsed?.bl || [];
      store.propRows = project.parsed?.prop || [];
      if (project.rates) store.rates = { ...store.rates, ...project.rates };
      const m = project.modelType, parsed = !!project.parsed;
      info.innerHTML = `▸ <b>${esc(project.name)}</b> · <span class="pt-badge pt-${m}">${esc(m)}</span> · ${esc(project.address || "no address")} · ${parsed ? `<span class="pill pill-red" style="font-size:9px">parsed</span>` : `<span class="pill pill-gray" style="font-size:9px">not parsed</span>`}`;
      setEnabled(true);
    } catch (e: any) { info.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; setEnabled(false); }
  };

  selCard.querySelector("#db-proj")!.addEventListener("change", (e) => selectProject((e.target as HTMLSelectElement).value));
  selectProject(preId); // honor a pre-selected project, else show the disabled state

  /* ---------- portfolio overview ---------- */
  root.appendChild(overview(projects));
}

function sectionTitle(text: string): HTMLElement {
  return h(`<div style="font-family:var(--font);font-weight:800;font-size:15px;margin:22px 0 10px;display:flex;align-items:center;gap:8px"><span style="width:4px;height:16px;background:var(--red);border-radius:3px;display:inline-block"></span>${esc(text)}</div>`);
}
function toolGrid(tools: Tool[]): HTMLElement {
  const grid = h(`<div class="proj-grid"></div>`);
  for (const t of tools) {
    const card = h(`<div class="proj-tile tool-card" data-route="${t.route}" style="transition:opacity .15s">
      <div style="font-size:24px;color:var(--red)">${t.icon}</div>
      <h4 style="margin-top:8px">${t.title}</h4>
      <div class="pt-meta" style="margin-top:6px;line-height:1.5">${t.desc}</div>
    </div>`);
    card.addEventListener("click", () => {
      if (!store.currentProject) { toast("Select a project first"); return; }
      navigate(t.route);
    });
    grid.appendChild(card);
  }
  return grid;
}

/* ---------- portfolio overview (stats + charts) ---------- */
function overview(projects: Project[]): HTMLElement {
  const wrap = h(`<div></div>`);
  wrap.appendChild(sectionTitle("Portfolio overview"));
  const parsed = projects.filter((p) => p.summary);
  const totalEnergy = parsed.reduce((a, p) => a + (p.summary.totalEnergy || 0), 0);
  const totalCarbon = parsed.reduce((a, p) => a + (p.summary.totalCarbon || 0), 0);
  const totalCost = parsed.reduce((a, p) => a + (p.summary.totalCost || 0), 0);
  const avgEui = parsed.length ? parsed.reduce((a, p) => a + (p.summary.eui || 0), 0) / parsed.length : 0;
  const models = parsed.reduce((a, p) => a + (p.summary.models || 0), 0);

  const cards = h(`<div class="grid cards-4"></div>`);
  cards.appendChild(stat("Projects", String(projects.length), "", true, `${models} models parsed`));
  cards.appendChild(stat("Avg EUI", fmt(avgEui, 1), "kBtu/ft²", false, "portfolio average"));
  cards.appendChild(stat("Total Energy", fmtCompact(totalEnergy), "kBtu", false, "all projects"));
  cards.appendChild(stat("Total Carbon", fmtCompact(totalCarbon), "kg CO₂e", false, totalCost > 0 ? "$" + fmtCompact(totalCost) + " cost" : "—"));
  wrap.appendChild(cards);

  if (parsed.length) {
    const grid = h(`<div class="dash-grid" style="margin-top:16px"></div>`);
    grid.appendChild(h(`<div class="card"><div class="card-hd"><h3>EUI by Project</h3><span class="sub">kBtu/ft²</span></div><div class="chart-box"><canvas id="db-eui"></canvas></div></div>`));
    grid.appendChild(h(`<div class="card"><div class="card-hd"><h3>Energy by Project</h3><span class="sub">kBtu</span></div><div class="chart-box"><canvas id="db-energy"></canvas></div></div>`));
    wrap.appendChild(grid);
    requestAnimationFrame(() => {
      drawBar("db-eui", parsed.map((p) => p.name), parsed.map((p) => +(p.summary.eui || 0).toFixed(1)));
      drawBar("db-energy", parsed.map((p) => p.name), parsed.map((p) => Math.round(p.summary.totalEnergy || 0)));
    });
  }
  return wrap;
}

function stat(label: string, value: string, unit: string, feature: boolean, delta: string): HTMLElement {
  return h(`<div class="card stat ${feature ? "feature" : ""}"><div class="top"><span class="label">${esc(label)}</span><span class="arrow">${ICON.arrow()}</span></div><div><span class="value">${esc(value)}</span><span class="unit">${esc(unit)}</span></div><div class="delta">${esc(delta)}</div></div>`);
}
function drawBar(id: string, labels: string[], data: number[]) {
  const c = document.getElementById(id) as HTMLCanvasElement; if (!c) return;
  makeChart(c, { type: "bar", data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => i === 0 ? PALETTE[0] : "#1a1a1d"), borderRadius: 6, maxBarThickness: 44 }] }, options: gridOpts(false) });
}
