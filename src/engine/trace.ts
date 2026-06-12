/* ============================================================
 *  TRACE 3D Plus / TRACE 700 PDF report parser.
 *  Reads a (very large) TRACE output PDF entirely in the browser via
 *  pdf.js, locates the relevant report sections, and extracts the data.
 *
 *  Relevant reports (per request):
 *    • Input / General Information  (LEED Energy Performance Summary §1.1)
 *    • LEED summary                 (Overall Annual Energy Consumption)
 *    • Energy consumption summary   (Site Consumption Summary, by end-use)
 *    • Lighting & Daylighting       (WWR, window/skylight areas)
 *  Bonus: Economic Comparison · Monthly Energy End Use · Unmet hours.
 * ============================================================ */
/* This module is PURE (no pdf.js import) so it is testable in Node.
   PDF loading lives in ./trace-load.ts (browser-only worker URL). */
import type { Row } from "./sim";

export interface TracePage { n: number; text: string; alt: string; }

export interface TraceGeneral {
  simulation: string; energyCode: string; buildingType: string; climateZone: string;
  floors: string; grossFloorArea: number; weatherFile: string; hdd: number; cdd: number;
  calculatedAt: string; sourceFile: string;
}
export interface AnnualEnergyRow { alternative: string; electricity: number; gas: number; addlFuel: number; districtClg: number; districtHtg: number; water: number; }
export interface SiteComponent {
  name: string; elec_kwh: number; gas_mmbtu: number; dc_mmbtu: number; dh_mmbtu: number; other_mmbtu: number;
  site_mbtu: number; site_eui: number; source_mbtu: number; source_eui: number; water_gal: number;
}
export interface SiteConsumption {
  alternative: string; components: SiteComponent[];
  grossFloorArea: number; region: string; buildingType: string; benchmarkEui: number;
}
export interface LightingDaylight {
  alternative: string;
  wallArea: Dir; wwrGross: Dir; windowOpening: Dir;
  grossRoofArea: number; skylightArea: number; skylightRatio: number;
  interiorLpd: number | null;
}
export interface Dir { north: number; east: number; south: number; west: number; total: number; }
export interface EconomicRow { alternative: string; yearlySavings: number; operatingCost: number; utilityCost: number; }

/** "Project Summary" report — one per alternative. Cleanly formatted
    "Label value unit" pairs that fill ~16 columns the consumption tables
    don't cover (areas, densities, airflows, peaks, unmet hours). */
export interface ProjectSummary {
  alternative: string;
  conditionedArea: number; totalArea: number; grossWallArea: number; wwr: number;
  grossRoofArea: number; skylightRatio: number;
  plugLoadDensity: number; lightingDensity: number; peakOccupancy: number;
  siteVentilation: number; coolingAirflow: number; heatingAirflow: number;
  peakCoolingTons: number; peakHeatingMBh: number; peakElecKw: number;
  unmetCooling: number; unmetHeating: number;
}

/** One rotation of the PRM baseline (Section 1.6, Table EAp2-4). Field names
    match the Row schema so they can be spread straight onto a baseline row. */
export interface BaselineRotation {
  rotation: number;
  total_energy_kbtu: number; electricity_kbtu: number; gas_kbtu: number;
  clg_elec_kbtu: number; fans_kbtu: number; htg_elec_kbtu: number; htg_gas_kbtu: number;
  int_lighting_kbtu: number; ext_lighting_kbtu: number; int_equip_kbtu: number; ext_equip_kbtu: number;
}

export interface TraceReport {
  fileName: string; pageCount: number; alternatives: string[];
  general: TraceGeneral | null;
  baselineRotations: BaselineRotation[] | null;
  annualEnergy: AnnualEnergyRow[];
  siteConsumption: SiteConsumption[];
  lighting: LightingDaylight[];
  projectSummary: ProjectSummary[];
  economic: EconomicRow[];
  monthlyElectricity: { months: string[]; total: number[] } | null;
  unmetHeatingHours: number | null;
  warnings: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nums(s: string): number[] {
  const m = s.match(/-?[\d,]+\.?\d*/g);
  if (!m) return [];
  return m.map((x) => parseFloat(x.replace(/,/g, ""))).filter((x) => !isNaN(x));
}
function num(s: string): number { const a = nums(s); return a.length ? a[0] : 0; }
function after(text: string, label: string, re = /([^\s].*?)(?:\s{2,}|$)/): string {
  const i = text.indexOf(label);
  if (i < 0) return "";
  const rest = text.slice(i + label.length).trimStart();
  const m = rest.match(re);
  return m ? m[1].trim() : "";
}
function altOf(text: string): string {
  const m = text.match(/Alternative:\s*(.+?)\s*Calculated at:/);
  return m ? m[1].trim() : "";
}

export { altOf };

export function parseTrace(pages: TracePage[], fileName: string): TraceReport {
  const warnings: string[] = [];
  const report: TraceReport = {
    fileName, pageCount: pages.length, alternatives: [],
    general: null, baselineRotations: null, annualEnergy: [], siteConsumption: [], lighting: [], projectSummary: [], economic: [],
    monthlyElectricity: null, unmetHeatingHours: null, warnings,
  };

  // ---- General Information (input/LEED summary) ----
  const gp = pages.find((p) => p.text.includes("LEED Energy Performance Summary") || p.text.includes("Section 1.1 - General Information"));
  if (gp) report.general = parseGeneral(gp.text);
  else warnings.push("General Information / LEED summary section not found.");

  // ---- Overall Annual Energy Consumption ----
  const ap = pages.find((p) => p.text.includes("Overall Annual Energy Consumption"));
  if (ap) report.annualEnergy = parseAnnual(ap.text);
  else warnings.push("Overall Annual Energy Consumption table not found.");

  // ---- Site Consumption Summary (every alternative) ----
  for (const p of pages.filter((x) => x.text.startsWith("Site Consumption Summary"))) {
    const sc = parseSiteConsumption(p.text, p.alt || altOf(p.text));
    if (sc.components.length) report.siteConsumption.push(sc);
  }
  if (!report.siteConsumption.length) warnings.push("Site Consumption Summary (energy-consumption) not found.");

  // ---- Lighting & Daylighting (every alternative) ----
  for (const p of pages.filter((x) => x.text.startsWith("Lighting and Daylighting Summary"))) {
    report.lighting.push(parseLighting(p.text, p.alt || altOf(p.text)));
  }
  if (!report.lighting.length) warnings.push("Lighting and Daylighting Summary not found.");

  // ---- Project Summary (every alternative) — fills areas, densities,
  //      airflows, peaks, and unmet hours that the consumption tables omit ----
  for (const p of pages.filter((x) => x.text.startsWith("Project Summary"))) {
    report.projectSummary.push(parseProjectSummary(p.text, p.alt || altOf(p.text)));
  }
  if (!report.projectSummary.length) warnings.push("Project Summary not found.");

  // ---- Section 1.6 PRM Compliance: the baseline's 4 rotations (0/90/180/270) ----
  const s16 = pages.find((p) => /Table EAp2-4 - Baseline Performance/.test(p.text));
  if (s16) report.baselineRotations = parseBaselineRotations(s16.text);

  // ---- Economic ----
  const ec = pages.find((p) => p.text.startsWith("Economic Alternative Comparison"));
  if (ec) report.economic = parseEconomic(ec.text);

  // ---- Monthly electricity (for charting) ----
  const mp = pages.find((p) => p.text.startsWith("Monthly Energy End Use") && p.text.includes("Grand Total"));
  if (mp) report.monthlyElectricity = parseMonthly(mp.text);

  // ---- Unmet heating hours (sum across zones, first temp-range table) ----
  const up = pages.find((p) => p.text.includes("Time spent in each temperature range"));
  if (up) report.unmetHeatingHours = parseUnmet(up.text);

  // alternatives list
  const alts = new Set<string>();
  report.general && report.annualEnergy.forEach((r) => alts.add(r.alternative));
  report.siteConsumption.forEach((s) => s.alternative && alts.add(s.alternative));
  report.alternatives = [...alts].filter(Boolean);
  return report;
}

function parseGeneral(t: string): TraceGeneral {
  const fa = t.match(/Total gross floor area\s+([\d,.]+)\s*ft/);
  const cz = t.match(/Climate Zone\s+([0-9]+)\s*([A-C])\b/);
  const wf = t.match(/Weather File\s+(.+?)\s+Heating Degree Days/);
  const cal = t.match(/Calculated at:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4}[^]*?[AP]M)/);
  const src = t.match(/([A-Za-z0-9_.\-]+\.mdf)/);
  return {
    simulation: after(t, "Simulation Program", /([^]*?)\s+Energy Code/) || "TRACE 3D Plus",
    energyCode: after(t, "Energy Code", /([^]*?)\s+(?:Baseline|Building Type)/) || "",
    buildingType: after(t, "Building Type", /([^]*?)\s+Percent/) || "",
    climateZone: cz ? cz[1] + cz[2] : "",
    floors: after(t, "Quantity of Floors", /(\d+)/) || "",
    grossFloorArea: fa ? parseFloat(fa[1].replace(/,/g, "")) : 0,
    weatherFile: wf ? wf[1].trim() : "",
    hdd: num((t.match(/Heating Degree Days\s+([\d,]+)/) || [, "0"])[1]),
    cdd: num((t.match(/Cooling Degree Days\s+([\d,]+)/) || [, "0"])[1]),
    calculatedAt: cal ? cal[1].trim() : "",
    sourceFile: src ? src[1] : "",
  };
}

function parseAnnual(t: string): AnnualEnergyRow[] {
  // header order: Electricity, Natural Gas, Additional Fuel, District Cooling, District Heating, Water (kGal)
  const i = t.indexOf("Water (kGal)");
  if (i < 0) return [];
  const tail = t.slice(i + "Water (kGal)".length);
  const vals = nums(tail);
  // legend names appear before the numbers in this layout
  const altNames = extractAltNames(t);
  const rows: AnnualEnergyRow[] = [];
  for (let k = 0; k + 6 <= vals.length && rows.length < 3; k += 6) {
    rows.push({
      alternative: altNames[rows.length] || `Alternative ${rows.length + 1}`,
      electricity: vals[k], gas: vals[k + 1], addlFuel: vals[k + 2],
      districtClg: vals[k + 3], districtHtg: vals[k + 4], water: vals[k + 5],
    });
  }
  return rows;
}
function extractAltNames(t: string): string[] {
  // Legend reads: "Baseline: <X> Comparison 1: <Y> Comparison 2: <Z> Electricity (MBtu)"
  const m = t.match(/Baseline:\s*(.+?)\s*Comparison 1:\s*(.+?)\s*Comparison 2:\s*(.+?)\s*Electricity \(MBtu\)/);
  if (m) return [clean(m[1]), clean(m[2]), clean(m[3])];
  return ["Baseline", "Comparison 1 (Proposed)", "Comparison 2 (Code)"];
}
function clean(s: string): string { return s.replace(/\s+/g, " ").trim().slice(0, 60); }

const SITE_COMPONENTS = [
  "Heating", "Cooling", "Fans", "Pumps", "Heat Rejection", "Humidification", "Air-Side Heat Recovery",
  "HVAC", "Water Systems", "Interior Lighting", "Exterior Lighting", "Interior Equipment",
  "Exterior Equipment", "Refrigeration", "Non-HVAC", "Generators", "Site Generation", "Grand Total",
];
function parseSiteConsumption(t: string, alt: string): SiteConsumption {
  const components: SiteComponent[] = [];
  for (const name of SITE_COMPONENTS) {
    // match "Name <10 numbers>" — be careful that longer names are matched first by ordering
    const re = new RegExp(name.replace(/[-]/g, "\\-") + "\\s+(-?[\\d,]+(?:\\.\\d+)?(?:\\s+-?[\\d,]+(?:\\.\\d+)?){9})");
    const m = t.match(re);
    if (m) {
      const v = nums(m[1]);
      if (v.length >= 10) components.push({
        name, elec_kwh: v[0], gas_mmbtu: v[1], dc_mmbtu: v[2], dh_mmbtu: v[3], other_mmbtu: v[4],
        site_mbtu: v[5], site_eui: v[6], source_mbtu: v[7], source_eui: v[8], water_gal: v[9],
      });
    }
  }
  const fa = t.match(/Gross Floor Area:\s*([\d,]+)/);
  const be = t.match(/Benchmark EUI:\s*([\d.]+)/);
  const rg = t.match(/Region:\s*([A-Za-z ]+?)\s+Building Type/);
  const bt = t.match(/Building Type:\s*([A-Za-z ]+?)\s+CBECS/);
  return {
    alternative: alt, components,
    grossFloorArea: fa ? parseFloat(fa[1].replace(/,/g, "")) : 0,
    region: rg ? rg[1].trim() : "", buildingType: bt ? bt[1].trim() : "",
    benchmarkEui: be ? parseFloat(be[1]) : 0,
  };
}

function dir(t: string, label: string): Dir {
  const i = t.indexOf(label);
  if (i < 0) return { north: 0, east: 0, south: 0, west: 0, total: 0 };
  const v = nums(t.slice(i + label.length, i + label.length + 80));
  return { north: v[0] || 0, east: v[1] || 0, south: v[2] || 0, west: v[3] || 0, total: v[4] || 0 };
}
function parseLighting(t: string, alt: string): LightingDaylight {
  const roof = t.match(/Gross Roof Area\s*ft²?\s*([\d,]+)/);
  const sky = t.match(/Skylight Area\s*ft²?\s*([\d,]+)/);
  const skyR = t.match(/Skylight-Roof Ratio\s*%\s*([\d.]+)/);
  return {
    alternative: alt,
    wallArea: dir(t, "Above Ground Wall Area ft²"),
    wwrGross: dir(t, "Gross Window-Wall Ratio %"),
    windowOpening: dir(t, "Window Opening Area ft²"),
    grossRoofArea: roof ? parseFloat(roof[1].replace(/,/g, "")) : 0,
    skylightArea: sky ? parseFloat(sky[1].replace(/,/g, "")) : 0,
    skylightRatio: skyR ? parseFloat(skyR[1]) : 0,
    interiorLpd: null,
  };
}

function parseProjectSummary(t: string, alt: string): ProjectSummary {
  const n = (re: RegExp) => { const m = t.match(re); return m ? parseFloat(m[1].replace(/,/g, "")) : 0; };
  return {
    alternative: alt,
    conditionedArea: n(/Conditioned Floor Area\s+([\d,]+(?:\.\d+)?)\s*ft/),
    totalArea: n(/Total Building Area\s+([\d,]+(?:\.\d+)?)\s*ft/),
    grossWallArea: n(/Gross Wall Area\s+([\d,]+(?:\.\d+)?)\s*ft/),
    wwr: n(/Window-Wall Ratio\s+([\d.]+)\s*%/),
    grossRoofArea: n(/Gross Roof Area\s+([\d,]+(?:\.\d+)?)\s*ft/),
    skylightRatio: n(/Skylight-Roof Ratio\s+([\d.]+)\s*%/),
    plugLoadDensity: n(/Average Plug Load Density\s+([\d.]+)/),
    lightingDensity: n(/Average Lighting Density\s+([\d.]+)/),
    peakOccupancy: n(/Peak Occupancy\s+([\d,]+(?:\.\d+)?)/),
    siteVentilation: n(/Site Ventilation\s+([\d,]+(?:\.\d+)?)\s*cfm/),
    coolingAirflow: n(/Cooling Specific Air Flow\s+([\d,]+(?:\.\d+)?)\s*cfm/),
    heatingAirflow: n(/Heating Specific Air Flow\s+([\d,]+(?:\.\d+)?)\s*cfm/),
    peakCoolingTons: n(/Site Peak Cooling Load\s+([\d,]+(?:\.\d+)?)\s*tons/),
    peakHeatingMBh: n(/Site Peak Heating Load\s+([\d,]+(?:\.\d+)?)\s*MBh/),
    peakElecKw: n(/Annual Peak Electrical Demand\s+([\d,]+(?:\.\d+)?)\s*kW/),
    unmetCooling: n(/Unmet cooling load hours[\s\S]*?This Building:\s*([\d,]+)/),
    unmetHeating: n(/Unmet heating load hours[\s\S]*?This Building:\s*([\d,]+)/),
  };
}

function parseEconomic(t: string): EconomicRow[] {
  // Data table follows the "USD ($) ($) ($) ($)" header; each row is
  // "<tag> <name> <savings> <operating> <utility> <lifecycle>".
  const rows: EconomicRow[] = [];
  const hdr = t.lastIndexOf("USD ($)");
  const body = hdr >= 0 ? t.slice(hdr) : t;
  for (const tag of ["Baseline", "Comparison 1", "Comparison 2"]) {
    const re = new RegExp(tag + "\\s+(.+?)\\s+(-?[\\d,]+\\.\\d{2})\\s+(-?[\\d,]+\\.\\d{2})\\s+(-?[\\d,]+\\.\\d{2})\\s+(-?[\\d,]+\\.\\d{2})");
    const m = body.match(re);
    if (m) rows.push({
      alternative: `${tag}: ${clean(m[1]).slice(0, 40)}`,
      yearlySavings: parseFloat(m[2].replace(/,/g, "")),
      operatingCost: parseFloat(m[3].replace(/,/g, "")),
      utilityCost: parseFloat(m[4].replace(/,/g, "")),
    });
  }
  return rows;
}

function parseMonthly(t: string): { months: string[]; total: number[] } | null {
  const i = t.lastIndexOf("Grand Total");
  if (i < 0) return null;
  const v = nums(t.slice(i + "Grand Total".length, i + "Grand Total".length + 160));
  if (v.length < 12) return null;
  return { months: MONTHS, total: v.slice(0, 12) };
}

/* ============================================================
 *  MAP a parsed TRACE report → the SAME Row schema the SIM parser
 *  produces, so it feeds enrichRow + COLUMNS + buildWorkbook and yields
 *  the identical energy_results.xlsx (BL Data / Proposed Data tabs).
 * ============================================================ */
const KWH_TO_KBTU = 3.412;
const MMBTU_TO_KBTU = 1000;
const ZERO_COMP: SiteComponent = {
  name: "", elec_kwh: 0, gas_mmbtu: 0, dc_mmbtu: 0, dh_mmbtu: 0, other_mmbtu: 0,
  site_mbtu: 0, site_eui: 0, source_mbtu: 0, source_eui: 0, water_gal: 0,
};

function matchLighting(r: TraceReport, alt: string, idx: number): LightingDaylight | undefined {
  return r.lighting.find((l) => l.alternative && alt && l.alternative === alt) || r.lighting[idx] || r.lighting[0];
}

/** Convert one Site Consumption alternative (+ matching lighting) into a Row. */
function siteToRow(r: TraceReport, site: SiteConsumption, idx: number): Row {
  const comp = (n: string) => site.components.find((c) => c.name === n) || ZERO_COMP;
  const gt = comp("Grand Total");
  const htg = comp("Heating"), clg = comp("Cooling"), ws = comp("Water Systems");
  const gfa = site.grossFloorArea || (r.general?.grossFloorArea || 0);
  const g = r.general;
  const light = matchLighting(r, site.alternative, idx);

  const row: Row = {
    // identity / meta — same keys the SIM parser sets
    option_name: site.alternative || `TRACE ${idx + 1}`,
    results_path: r.fileName,
    timestamp: g?.calculatedAt || "",
    weather_file: g?.weatherFile || "",
    climate_zone: g?.climateZone || "",
    project_name: g?.sourceFile || r.fileName,

    // unmet
    unmet_heating_hrs: r.unmetHeatingHours || 0,
    unmet_cooling_hrs: 0,

    // top-line energy (site_mbtu values are already kBtu in TRACE)
    total_energy_kbtu: gt.site_mbtu,
    eui_kbtu_ft2: gt.site_eui,
    electricity_kbtu: gt.elec_kwh * KWH_TO_KBTU,
    gas_kbtu: gt.gas_mmbtu * MMBTU_TO_KBTU,
    additional_fuel_kbtu: 0,
    district_cooling_kbtu: gt.dc_mmbtu * MMBTU_TO_KBTU,
    district_heating_kbtu: gt.dh_mmbtu * MMBTU_TO_KBTU,

    // end-use breakdown (site kBtu)
    htg_elec_kbtu: htg.elec_kwh * KWH_TO_KBTU,
    htg_gas_kbtu: htg.gas_mmbtu * MMBTU_TO_KBTU,
    htg_dist_htg_kbtu: htg.dh_mmbtu * MMBTU_TO_KBTU,
    clg_elec_kbtu: clg.elec_kwh * KWH_TO_KBTU,
    clg_dist_kbtu: clg.dc_mmbtu * MMBTU_TO_KBTU,
    int_lighting_kbtu: comp("Interior Lighting").site_mbtu,
    ext_lighting_kbtu: comp("Exterior Lighting").site_mbtu,
    int_equip_kbtu: comp("Interior Equipment").site_mbtu,
    ext_equip_kbtu: comp("Exterior Equipment").site_mbtu,
    fans_kbtu: comp("Fans").site_mbtu,
    pumps_kbtu: comp("Pumps").site_mbtu,
    heat_reject_kbtu: comp("Heat Rejection").site_mbtu,
    heat_recov_kbtu: comp("Air-Side Heat Recovery").site_mbtu,
    humid_elec_kbtu: comp("Humidification").site_mbtu,
    refrig_kbtu: comp("Refrigeration").site_mbtu,
    water_sys_elec_kbtu: ws.elec_kwh * KWH_TO_KBTU,
    water_sys_gas_kbtu: ws.gas_mmbtu * MMBTU_TO_KBTU,

    // water (gal → kGal)
    total_water_kgal: gt.water_gal / 1000,

    // areas
    total_floor_area: gfa,
    conditioned_floor_area: gfa,
  };

  // envelope / WWR from the Lighting & Daylighting report
  if (light) {
    row.gross_wall_area = light.wallArea.total;
    row.above_ground_wall_area = light.wallArea.total;
    row.above_ground_north_wall = light.wallArea.north;
    row.above_ground_east_wall = light.wallArea.east;
    row.above_ground_south_wall = light.wallArea.south;
    row.above_ground_west_wall = light.wallArea.west;
    row.total_window_area = light.windowOpening.total;
    row.building_wwr = light.wwrGross.total;
    row.north_wwr_actual = light.wwrGross.north;
    row.east_wwr_actual = light.wwrGross.east;
    row.south_wwr_actual = light.wwrGross.south;
    row.west_wwr_actual = light.wwrGross.west;
    row.gross_roof_area = light.grossRoofArea;
    row.skylight_area = light.skylightArea;
    row.skylight_ratio = light.skylightRatio;
    if (gfa > 0) {
      row.wall_to_floor_ratio = light.wallArea.total / gfa;
      row.roof_to_floor_ratio = light.grossRoofArea / gfa;
      row.envelope_to_floor_ratio = row.wall_to_floor_ratio + row.roof_to_floor_ratio;
    }
  }

  // Project Summary — areas, densities, airflows, peaks, unmet hours
  const ps = r.projectSummary.find((p) => p.alternative && site.alternative && p.alternative === site.alternative)
    || r.projectSummary[idx] || r.projectSummary[0];
  if (ps) {
    const area = ps.conditionedArea || gfa || 1;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    if (ps.conditionedArea) row.conditioned_floor_area = ps.conditionedArea;
    if (ps.totalArea) row.total_floor_area = ps.totalArea;
    if (ps.grossWallArea) { row.gross_wall_area = ps.grossWallArea; if (!row.above_ground_wall_area) row.above_ground_wall_area = ps.grossWallArea; }
    if (ps.wwr && !row.building_wwr) row.building_wwr = ps.wwr;
    if (ps.grossRoofArea && !row.gross_roof_area) row.gross_roof_area = ps.grossRoofArea;
    if (ps.skylightRatio) row.skylight_ratio = ps.skylightRatio;
    if (ps.lightingDensity) { row.lpd_w_ft2 = ps.lightingDensity; row.lpd_total_w_ft2 = ps.lightingDensity; }
    if (ps.plugLoadDensity) { row.epd_w_ft2 = ps.plugLoadDensity; row.epd_total_w_ft2 = ps.plugLoadDensity; }
    if (ps.peakOccupancy) { row.occ_density_ft2_person = r1(area / ps.peakOccupancy); row.cond_occ_density_ft2_person = row.occ_density_ft2_person; }
    if (ps.siteVentilation) { row.total_supply_cfm = ps.siteVentilation; row.vent_cfm_per_ft2 = r3(ps.siteVentilation / area); }
    if (ps.coolingAirflow) { row.total_clg_cfm = ps.coolingAirflow; row.clg_cfm_per_ft2 = r3(ps.coolingAirflow / area); }
    if (ps.heatingAirflow) { row.total_htg_cfm = ps.heatingAirflow; row.htg_cfm_per_ft2 = r3(ps.heatingAirflow / area); }
    if (ps.peakCoolingTons) { row.peak_cooling_kbtuh = r1(ps.peakCoolingTons * 12); row.peak_cooling_btuh_ft2 = r1(ps.peakCoolingTons * 12000 / area); }
    if (ps.peakHeatingMBh) { row.peak_heating_kbtuh = r1(ps.peakHeatingMBh); row.peak_heating_btuh_ft2 = r1(ps.peakHeatingMBh * 1000 / area); }
    if (ps.peakElecKw) { row.peak_elec_w = ps.peakElecKw * 1000; row.peak_elec_w_per_ft2 = r1(ps.peakElecKw * 1000 / area); }
    if (ps.unmetCooling) row.unmet_cooling_hrs = ps.unmetCooling;
    if (ps.unmetHeating) row.unmet_heating_hrs = ps.unmetHeating;
  }
  return row;
}

/** Parse Section 1.6 (Table EAp2-4 Baseline Performance) → the baseline's 4
    rotations, by end use. Use values are kWh (×3.412→kBtu) or therms (×100). */
function parseBaselineRotations(t: string): BaselineRotation[] | null {
  if (!/Table EAp2-4 - Baseline Performance/.test(t)) return null;
  const labels = ["Cooling", "Exterior Equipment", "Exterior Lighting", "Fans", "Heating", "Interior Equipment", "Interior Lighting"];
  const bounds: { l: string; i: number }[] = [];
  labels.forEach((l) => { const i = t.indexOf(l + " --"); if (i >= 0) bounds.push({ l, i }); });
  bounds.sort((a, b) => a.i - b.i);
  const totI = t.indexOf("Total Energy Use (MMBtu");
  const elec: Record<string, number[]> = {}, gas: Record<string, number[]> = {};
  bounds.forEach((b, k) => {
    const s = t.slice(b.i, k + 1 < bounds.length ? bounds[k + 1].i : totI);
    const em = s.match(/Electricity Use kWh\s+([\d.\s]+?)\s+Demand/);
    if (em) elec[b.l] = em[1].trim().split(/\s+/).map(Number).slice(0, 4);
    const gm = s.match(/Gas Use therms\s+([\d.\s]+?)\s+Demand/);
    if (gm) gas[b.l] = gm[1].trim().split(/\s+/).map(Number).slice(0, 4);
  });
  const tm = t.match(/Total Energy Use \(MMBtu\/year\)\s+([\d.\s]+?)\s+Annual/);
  const totals = tm ? tm[1].trim().split(/\s+/).map(Number).slice(0, 4) : null;
  if (!totals || totals.length < 4) return null;
  const E = (l: string, r: number) => (elec[l] && elec[l][r] != null) ? elec[l][r] : 0;
  const G = (l: string, r: number) => (gas[l] && gas[l][r] != null) ? gas[l][r] : 0;
  return [0, 90, 180, 270].map((rotation, r) => ({
    rotation,
    total_energy_kbtu: totals[r] * MMBTU_TO_KBTU,
    electricity_kbtu: labels.reduce((a, l) => a + E(l, r), 0) * KWH_TO_KBTU,
    gas_kbtu: G("Heating", r) * 100,
    clg_elec_kbtu: E("Cooling", r) * KWH_TO_KBTU, fans_kbtu: E("Fans", r) * KWH_TO_KBTU,
    htg_elec_kbtu: E("Heating", r) * KWH_TO_KBTU, htg_gas_kbtu: G("Heating", r) * 100,
    int_lighting_kbtu: E("Interior Lighting", r) * KWH_TO_KBTU, ext_lighting_kbtu: E("Exterior Lighting", r) * KWH_TO_KBTU,
    int_equip_kbtu: E("Interior Equipment", r) * KWH_TO_KBTU, ext_equip_kbtu: E("Exterior Equipment", r) * KWH_TO_KBTU,
  }));
}

export interface TraceModel { name: string; row: Row; cat: "leed" | "code" | "proposed"; rot: number; }

/** Build the classification model list. When Section 1.6 supplied the baseline's
    rotations, the (LEED/PRM) baseline is expanded into 4 rotation rows pre-tagged
    leed + 0/90/180/270; other alternatives map straight through. */
export function traceModels(report: TraceReport): TraceModel[] {
  const out: TraceModel[] = [];
  for (const row of traceAllRows(report)) {
    const name = String(row.option_name || "");
    const proposed = /proposed/i.test(name);
    const code = !proposed && /code/i.test(name);
    if (!proposed && !code && report.baselineRotations && report.baselineRotations.length) {
      const area = row.conditioned_floor_area || row.total_floor_area || 0;
      for (const rot of report.baselineRotations) {
        const { rotation, ...over } = rot;
        const r: Row = { ...row, ...over };
        if (area > 0) r.eui_kbtu_ft2 = Math.round((r.total_energy_kbtu / area) * 100) / 100;
        r.option_name = `${name} ${rotation}°`;
        out.push({ name: r.option_name, row: r, cat: "leed", rot: rotation });
      }
    } else {
      out.push({ name, row, cat: proposed ? "proposed" : code ? "code" : "leed", rot: 0 });
    }
  }
  return out;
}

/** All TRACE alternatives as rows (one per alternative, unsplit) — each row's
    option_name is the alternative name, for human classification. */
export function traceAllRows(r: TraceReport): Row[] {
  return r.siteConsumption.map((site, i) => {
    const row = siteToRow(r, site, i);
    row.option_name = site.alternative || `Alternative ${i + 1}`;
    return row;
  });
}

/** Split TRACE alternatives into baseline vs proposed rows (same shape as SIM). */
export function traceToRows(r: TraceReport): { blRows: Row[]; propRows: Row[] } {
  const blRows: Row[] = [], propRows: Row[] = [];
  r.siteConsumption.forEach((site, i) => {
    const row = siteToRow(r, site, i);
    if (/proposed/i.test(site.alternative || "")) propRows.push(row);
    else blRows.push(row);
  });
  // if the report had no per-alternative split, keep whatever we built as baseline
  return { blRows, propRows };
}

function parseUnmet(t: string): number {
  // sum the "Hours Heating Unmet" column — first number after each zone name.
  // Heuristic: this report lists per-zone rows; total heating-unmet hours is the
  // sum of the first numeric of each zone row. We approximate via the largest
  // plausible column. For a quick metric, sum numbers that look like unmet-hours.
  // Conservative: report the max single-zone unmet to avoid overcounting.
  const m = t.match(/Mean Temperature[^]*$/);
  const body = m ? m[0] : t;
  const rows = body.split(/(?=VAV-|RTU-|CUHZ-|AHU-|ZONE_|PSZ-)/);
  let sum = 0;
  for (const r of rows) {
    const v = nums(r);
    if (v.length >= 3) sum += v[0]; // first col = Hours Heating Unmet
  }
  return Math.round(sum);
}
