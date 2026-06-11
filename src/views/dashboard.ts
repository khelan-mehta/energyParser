/* ============================================================
 *  Dashboard — company-wide combined analysis across all projects.
 * ============================================================ */
import { store } from "../store";
import { Projects, Project, authUser } from "../api";
import { h, esc, fmt, fmtCompact } from "../ui/util";
import { ICON } from "../ui/icons";
import { makeChart, gridOpts, PALETTE } from "../ui/charts";
import { navigate } from "../ui/shell";

export async function renderDashboard(root: HTMLElement) {
  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Company Dashboard</h1><p>Combined analysis across every project${authUser?.role === "admin" ? " (all users)" : ""}.</p></div>
      <div class="actions"><button class="btn btn-primary" id="db-new">${ICON.plus()} New Project</button></div>
    </div>
  `));
  root.querySelector("#db-new")!.addEventListener("click", () => { store.currentProject = null; navigate("marcus"); });

  let projects: Project[] = [];
  try { projects = (await Projects.list()).projects; } catch (e: any) { root.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message)}</div>`)); return; }

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
  root.appendChild(cards);

  if (!projects.length) {
    root.appendChild(h(`<div class="card" style="margin-top:16px"><div class="empty"><div class="big">🏢</div><div style="font-weight:600;color:var(--g600);margin-bottom:6px">No projects yet</div><button class="btn btn-primary btn-sm" id="db-go">${ICON.plus()} Create your first project</button></div></div>`));
    root.querySelector("#db-go")?.addEventListener("click", () => navigate("marcus"));
    return;
  }

  // charts
  const grid = h(`<div class="dash-grid" style="margin-top:16px"></div>`);
  grid.appendChild(h(`<div class="card"><div class="card-hd"><h3>EUI by Project</h3><span class="sub">kBtu/ft²</span></div><div class="chart-box"><canvas id="db-eui"></canvas></div></div>`));
  grid.appendChild(h(`<div class="card"><div class="card-hd"><h3>Energy by Project</h3><span class="sub">kBtu</span></div><div class="chart-box"><canvas id="db-energy"></canvas></div></div>`));
  root.appendChild(grid);

  // project list
  const listCard = h(`<div class="card" style="margin-top:16px"><div class="card-hd"><h3>Projects</h3><span class="sub">${projects.length} total</span></div><div id="db-list"></div></div>`);
  const list = listCard.querySelector("#db-list")!;
  projects.sort((a, b) => b.updatedAt - a.updatedAt).forEach((p) => {
    const row = h(`
      <div class="list-row" style="cursor:pointer">
        <div class="list-ico">${ICON.bolt()}</div>
        <div class="meta"><div class="t">${esc(p.name)} <span class="pt-badge pt-${p.modelType}">${esc(p.modelType)}</span></div><div class="s">${esc(p.address || "no address")} · ${esc(p.ownerName || "")}</div></div>
        <span class="end">${p.summary ? `<b>${fmt(p.summary.eui, 1)}</b> <span style="color:var(--g400);font-size:11px">EUI</span>` : `<span class="pill pill-gray">not parsed</span>`}</span>
      </div>`);
    row.addEventListener("click", async () => {
      try { const { project } = await Projects.get(p.id); store.currentProject = project; if (project.parsed) { store.blRows = project.parsed.bl || []; store.propRows = project.parsed.prop || []; } navigate("marcus"); }
      catch { navigate("marcus"); }
    });
    list.appendChild(row);
  });
  root.appendChild(listCard);

  requestAnimationFrame(() => {
    drawBar("db-eui", parsed.map((p) => p.name), parsed.map((p) => +(p.summary.eui || 0).toFixed(1)));
    drawBar("db-energy", parsed.map((p) => p.name), parsed.map((p) => Math.round(p.summary.totalEnergy || 0)));
  });
}

function stat(label: string, value: string, unit: string, feature: boolean, delta: string): HTMLElement {
  return h(`<div class="card stat ${feature ? "feature" : ""}"><div class="top"><span class="label">${esc(label)}</span><span class="arrow">${ICON.arrow()}</span></div><div><span class="value">${esc(value)}</span><span class="unit">${esc(unit)}</span></div><div class="delta">${esc(delta)}</div></div>`);
}
function drawBar(id: string, labels: string[], data: number[]) {
  const c = document.getElementById(id) as HTMLCanvasElement; if (!c) return;
  makeChart(c, { type: "bar", data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => i === 0 ? PALETTE[0] : "#1a1a1d"), borderRadius: 6, maxBarThickness: 44 }] }, options: gridOpts(false) });
}
