/* ============================================================
 *  Portfolio Overview — aggregate stats + charts across all of the
 *  user's parsed projects. Moved out of the Project Setup page into
 *  its own sidebar tab.
 * ============================================================ */
import { Projects, Project, authUser } from "../api";
import { h, esc, fmt, fmtCompact } from "../ui/util";
import { ICON } from "../ui/icons";
import { makeChart, gridOpts, PALETTE } from "../ui/charts";

export async function renderPortfolio(root: HTMLElement) {
  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Portfolio Overview</h1><p>Aggregated stats across your parsed projects${authUser?.role === "admin" ? " · admin sees all users" : ""}.</p></div>
    </div>
  `));

  let projects: Project[] = [];
  try { projects = (await Projects.list()).projects; }
  catch (e: any) { root.appendChild(h(`<div class="source-note" style="border-left-color:var(--red)">${esc(e.message)}</div>`)); return; }

  if (!projects.length) {
    root.appendChild(h(`<div class="card" style="margin-top:16px"><div class="empty"><div class="big">📊</div><div style="color:var(--g500)">No projects yet — create one from Project Setup.</div></div></div>`));
    return;
  }
  root.appendChild(overview(projects));
}

function sectionTitle(text: string): HTMLElement {
  return h(`<div style="font-family:var(--font);font-weight:800;font-size:15px;margin:22px 0 10px;display:flex;align-items:center;gap:8px"><span style="width:4px;height:16px;background:var(--red);border-radius:3px;display:inline-block"></span>${esc(text)}</div>`);
}

function overview(projects: Project[]): HTMLElement {
  const wrap = h(`<div></div>`);
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
