/* ============================================================
 *  Shared "Project Analysis" — identical layout for any model type
 *  (eQUEST / TRACE / IES-VE) because all parsers yield the same Row[].
 *  Used by Marcus (per-project) and the Dashboard (company-wide).
 * ============================================================ */
import type { Row } from "../engine/sim";
import { enrichRow } from "../engine/enrich";
import { store } from "../store";
import { h, esc, fmt, fmtCompact } from "../ui/util";
import { ICON } from "../ui/icons";
import { makeChart, gridOpts, PALETTE } from "../ui/charts";

export function renderAnalysis(container: HTMLElement, blRows: Row[], propRows: Row[], idPrefix: string) {
  const rows = [...blRows, ...propRows].map((r) => enrichRow(r, store.rates));
  if (!rows.length) { container.appendChild(h(`<div class="empty"><div class="big">📊</div><div style="color:var(--g500)">No parsed data yet.</div></div>`)); return; }

  const totalEnergy = rows.reduce((a, r) => a + (r.total_energy_kbtu || 0), 0);
  const avgEui = rows.reduce((a, r) => a + (r.eui_kbtu_ft2 || 0), 0) / rows.length;
  const totalCarbon = rows.reduce((a, r) => a + (r.total_carbon_kg || 0), 0);
  const totalCost = rows.reduce((a, r) => a + (r.total_cost || 0), 0);

  const cards = h(`<div class="grid cards-4"></div>`);
  cards.appendChild(stat("Models", String(rows.length), "", true, `${blRows.length} BL · ${propRows.length} Prop`));
  cards.appendChild(stat("Avg EUI", fmt(avgEui, 1), "kBtu/ft²", false, "site intensity"));
  cards.appendChild(stat("Total Energy", fmtCompact(totalEnergy), "kBtu", false, "all models"));
  cards.appendChild(stat("Total Carbon", fmtCompact(totalCarbon), "kg CO₂e", false, totalCost > 0 ? "$" + fmtCompact(totalCost) + " cost" : "set rates"));
  container.appendChild(cards);

  const grid = h(`<div class="dash-grid" style="margin-top:16px"></div>`);
  const euCard = h(`<div class="card"><div class="card-hd"><h3>End-Use Breakdown</h3><span class="sub">${esc(rows[0].option_name || "model 1")}</span></div><div class="chart-box"><canvas id="${idPrefix}-eu"></canvas></div></div>`);
  const cmpCard = h(`<div class="card"><div class="card-hd"><h3>EUI by Model</h3></div><div class="chart-box"><canvas id="${idPrefix}-eui"></canvas></div></div>`);
  grid.appendChild(euCard); grid.appendChild(cmpCard);
  container.appendChild(grid);

  // key metrics table
  const card = h(`<div class="card" style="margin-top:16px"><div class="card-hd"><h3>Key Metrics</h3></div></div>`);
  const keys: [string, string, number][] = [
    ["Total Energy (kBtu)", "total_energy_kbtu", 0], ["EUI (kBtu/ft²)", "eui_kbtu_ft2", 1],
    ["Electricity (kBtu)", "electricity_kbtu", 0], ["Gas (kBtu)", "gas_kbtu", 0],
    ["Total Cost ($)", "total_cost", 0], ["Carbon (kg)", "total_carbon_kg", 0],
    ["Water (kGal)", "total_water_kgal", 1], ["Floor Area (ft²)", "total_floor_area", 0],
    ["Building WWR (%)", "building_wwr", 1], ["Peak Elec (W)", "peak_elec_w", 0],
  ];
  const scroll = h(`<div class="tbl-scroll"></div>`);
  const table = h(`<table class="data"></table>`);
  table.appendChild(h(`<thead><tr><th>Metric</th>${rows.map((r) => `<th>${esc(r.option_name || "model")}</th>`).join("")}</tr></thead>`));
  const tb = h(`<tbody></tbody>`);
  keys.forEach(([label, key, dec]) => tb.appendChild(h(`<tr><td style="font-weight:600">${esc(label)}</td>${rows.map((r) => `<td>${fmt(r[key] || 0, dec)}</td>`).join("")}</tr>`)));
  table.appendChild(tb); scroll.appendChild(table); card.appendChild(scroll);
  container.appendChild(card);

  requestAnimationFrame(() => { drawEndUse(rows[0], `${idPrefix}-eu`); drawEui(rows, `${idPrefix}-eui`); });
}

function stat(label: string, value: string, unit: string, feature: boolean, delta: string): HTMLElement {
  return h(`<div class="card stat ${feature ? "feature" : ""}"><div class="top"><span class="label">${esc(label)}</span><span class="arrow">${ICON.arrow()}</span></div><div><span class="value">${esc(value)}</span><span class="unit">${esc(unit)}</span></div><div class="delta">${esc(delta)}</div></div>`);
}
function drawEndUse(r: Row, id: string) {
  const c = document.getElementById(id) as HTMLCanvasElement; if (!c) return;
  const cats: [string, number][] = [
    ["Int Lighting", r.int_lighting_kbtu], ["Ext Lighting", r.ext_lighting_kbtu], ["Equipment", r.int_equip_kbtu],
    ["Heating", (r.htg_elec_kbtu || 0) + (r.htg_gas_kbtu || 0)], ["Cooling", r.clg_elec_kbtu], ["Fans", r.fans_kbtu],
    ["Pumps", r.pumps_kbtu], ["Heat Rej", r.heat_reject_kbtu], ["Water Sys", (r.water_sys_elec_kbtu || 0) + (r.water_sys_gas_kbtu || 0)],
  ].filter(([, v]) => (v as number) > 0) as [string, number][];
  makeChart(c, { type: "bar", data: { labels: cats.map((x) => x[0]), datasets: [{ data: cats.map((x) => Math.round(x[1])), backgroundColor: cats.map((_, i) => i === 0 ? PALETTE[0] : "#1a1a1d"), borderRadius: 6, maxBarThickness: 32 }] }, options: gridOpts(false) });
}
function drawEui(rows: Row[], id: string) {
  const c = document.getElementById(id) as HTMLCanvasElement; if (!c) return;
  makeChart(c, { type: "bar", data: { labels: rows.map((r) => r.option_name || "model"), datasets: [{ data: rows.map((r) => +(r.eui_kbtu_ft2 || 0).toFixed(1)), backgroundColor: rows.map((_, i) => i === 0 ? PALETTE[0] : "#1a1a1d"), borderRadius: 6, maxBarThickness: 46 }] }, options: gridOpts(false) });
}
