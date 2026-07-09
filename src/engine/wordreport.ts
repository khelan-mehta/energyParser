/* ============================================================
 *  WORD REPORT BUILDER
 *  Takes the user's QA/QC-ed "Energy Results Comparison" workbook and the
 *  "Energy Model Report Template.docx", and produces a filled report:
 *    • Data tables (Result Summary, Unmet Hours, Virtual Rates, and the
 *      End-Use Energy / Carbon / Cost breakdowns) are populated from the
 *      workbook's report-ready "Report" and "Input Summary" sheets.
 *    • The Site / Source / Carbon / Cost charts are lifted verbatim from
 *      the workbook as NATIVE Office charts (exact colours, fonts & UI)
 *      and dropped in next to their tables.
 *    • Derivable [bracket] text placeholders are filled.
 *
 *  We edit the .docx as a zip and only touch cell text / add chart parts,
 *  so the document's styling and structure stay intact.
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import { subregionFor, espmElecCarbonPerKwh, ESPM_GAS_KG_PER_THERM, ESPM_DISTRICT_KG_PER_MBTU, STATE_NAMES } from "./rates";
import { COLUMNS } from "./columns";

/* ---------- small helpers ---------- */
const norm = (s: any) => String(s ?? "").replace(/ /g, " ").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
const escXml = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A <w:t> open tag is "<w:t>" or "<w:t ...attrs...>" — NOT <w:tc>/<w:tcPr>/etc.
const WT = "<w:t(?:\\s[^>]*)?>";
const num = (v: any): number | null => (typeof v === "number" && isFinite(v)) ? v : (v != null && v !== "" && !isNaN(+v) ? +v : null);
const comma = (n: number) => Math.round(n).toLocaleString("en-US");

/* number → display string, mirroring the report's conventions */
function fmtInt(v: any) { const n = num(v); return n == null ? "-" : comma(n); }
function fmtDec(v: any, d = 2) { const n = num(v); return n == null ? "-" : n.toFixed(d); }
function fmtMoney(v: any) { const n = num(v); return n == null ? "-" : "$" + comma(n); }
function fmtPct(v: any) { const n = num(v); return n == null ? "0.0%" : (n * 100).toFixed(1) + "%"; }

type Grid = any[][];
function gridOf(ws: XLSX.WorkSheet): Grid {
  if (!ws || !ws["!ref"]) return [];
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const g: Grid = [];
  for (let row = 0; row <= r.e.r; row++) {
    const line: any[] = [];
    for (let col = 0; col <= r.e.c; col++) line.push(ws[XLSX.utils.encode_cell({ r: row, c: col })]);
    g.push(line);
  }
  return g;
}
/** raw value of a grid cell */
const rv = (cell: any) => (cell ? cell.v : undefined);
/** Excel-formatted display string of a grid cell (".w"), trimmed — exactly
    what Excel shows (e.g. " 34.8 " → "34.8", "0.062", "N/A"). */
const rw = (cell: any) => cell == null ? "" : (cell.w != null ? String(cell.w).trim() : (cell.v != null ? String(cell.v).trim() : ""));

/* ============================================================
 *  1. READ THE WORKBOOK INTO A STRUCTURED MODEL
 * ============================================================ */
export interface EndUseRow { leed: any; code: any; proposed: any; leedPct: any; codePct: any; }
export interface ReportData {
  eui: any; cei: any; eci: any;
  unmetHeating: any[]; unmetCooling: any[];          // [leed, code, proposed]
  energy: Record<string, EndUseRow>;
  carbon: Record<string, EndUseRow>;
  cost: Record<string, EndUseRow>;
  source: Record<string, EndUseRow>;
  co2eRates: any[]; costRates: any[];                 // [elec, gas, addl, dc, dh]
  summary: Record<string, { c: string; d: string }>; // Report "summary" block: norm(label) → {col C, col D} display strings
  params: Record<string, string[]>;                  // label → [leed, code, proposed] (Excel-formatted)
  totalFloorArea: any; climateZone: string; climateFile: string; location: string; projectName: string;
  projectLocation: string;   // Project Info "Project Location" (e.g. "San Marcos, California")
  climateFileClean: string;  // weather-file name with the run-name / climate-zone / WMO noise stripped
  wmo: string;               // WMO station number parsed from the weather file (e.g. "722860")
  dataSource: string;        // Project Info "Source of Cost and Emissions Data"
  hasCode: boolean;          // a Code/Compliance baseline model is present
  hasLeed: boolean;          // a LEED baseline model is present
  tool: "equest" | "trace" | "honeybee" | null;
}

/** Parse the WMO station number out of a weather-file string ("…WMO#=722860"). */
export function parseWmo(s: string): string {
  const m = String(s || "").match(/WMO#?\s*=?\s*(\d{4,6})/i);
  return m ? m[1] : "";
}
/** Clean a weather-file string down to the climate-file name. TRACE exports
 *  prepend the run name + CEC climate zone and append the WMO tag, e.g.
 *  "ASHRAE 90.1 2010 BASELINE ** Climate Zone 10 CA USA CTZRV2 WMO#=722860"
 *  → "CA USA CTZRV2". eQUEST strings ("Baltimore MD TMY2") pass through. */
export function cleanClimateFile(s: string): string {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*WMO#?\s*=?\s*\d{4,6}\s*$/i, "");                 // drop trailing WMO tag
  t = t.replace(/^.*?\bClimate Zone\s+\d+[A-C]?\s*/i, "");           // drop run-name + CEC climate-zone prefix
  return t.trim();
}

/* ============================================================
 *  RAW-DATA FALLBACK
 *  Compute the end-use Energy / Carbon / Cost tables directly from the
 *  BL Data and Proposed Data sheets. Used when the formula-driven "Report"
 *  sheet is broken — e.g. its Proposed selector ("Proposed Design") doesn't
 *  match the actual proposed model's name ("Primary 0°"), so the whole
 *  Proposed/Carbon/Cost set comes back as 0. The raw sheets are always
 *  populated by the parser, so we recompute from them.
 * ============================================================ */
const KWH_KBTU = 3.412, THERM_KBTU = 100, MBTU_KBTU = 1000;

/* each report end-use → BL/Proposed-Data column-header prefixes per fuel */
const RAW_ENDUSE: { label: string; elec?: string[]; gas?: string[]; dc?: string[]; dh?: string[]; addl?: string[] }[] = [
  { label: "Heating", elec: ["Heating - Electricity"], gas: ["Heating - Gas"], addl: ["Heating - Additonal Fuel"], dh: ["Heating - District Heating"] },
  { label: "Cooling", elec: ["Cooling - Electricity"], dc: ["Cooling - District"] },
  { label: "Lighting", elec: ["Interior Lighting - Electricity"] },
  { label: "Exterior Lighting", elec: ["Exterior Lighting - Electricity"] },
  { label: "Equipment", elec: ["Interior Equipment - Electricity"], gas: ["Interior Equipment - Gas"], addl: ["Interior Equipment - Additional Fuel"] },
  { label: "Exterior Equipment", elec: ["Exterior Equipment - Energy Use"] },
  { label: "Fans", elec: ["Fans - Electricity"] },
  { label: "Pumps", elec: ["Pumps - Electricity"] },
  { label: "Heat Rejection", elec: ["Heat Rejection - Electricity"] },
  { label: "Humidification", elec: ["Humidification - Electricity"] },
  { label: "Heat Recovery", elec: ["Heat Recovery - Electricity"] },
  { label: "Water Systems", elec: ["Water Systems - Electricity"], gas: ["Water Systems - Gas"], addl: ["Water Systems - Additional Fuel"], dh: ["Water Systems - District Heating"] },
  { label: "Refrigeration", elec: ["Refrigeration - Electricity"] },
  { label: "Generators", elec: ["Generators"] },
];

interface FuelSplit { elec: number; gas: number; dc: number; dh: number; addl: number; energy: number; }
/** Average the named fuel components across a set of data rows of a sheet grid. */
function rawModel(g: Grid, rowIdxs: number[]): { eu: Record<string, FuelSplit>; totalCost: number | null; area: number } {
  const header = (g[0] || []).map((c) => String(rv(c) ?? ""));
  const colOf = (prefix: string) => header.findIndex((h) => h.startsWith(prefix));
  const sumCols = (r: number, prefixes?: string[]) => (prefixes || []).reduce((a, p) => { const ci = colOf(p); return a + (ci >= 0 ? (num(rv(g[r][ci])) || 0) : 0); }, 0);
  const n = rowIdxs.length || 1;
  const eu: Record<string, FuelSplit> = {};
  for (const d of RAW_ENDUSE) {
    let elec = 0, gas = 0, dc = 0, dh = 0, addl = 0;
    for (const r of rowIdxs) { elec += sumCols(r, d.elec); gas += sumCols(r, d.gas); dc += sumCols(r, d.dc); dh += sumCols(r, d.dh); addl += sumCols(r, d.addl); }
    elec /= n; gas /= n; dc /= n; dh /= n; addl /= n;
    eu[norm(d.label)] = { elec, gas, dc, dh, addl, energy: elec + gas + dc + dh + addl };
  }
  const costCol = colOf("Total Energy Cost");
  let totalCost: number | null = null;
  if (costCol >= 0) { let s = 0, c = 0; for (const r of rowIdxs) { const v = num(rv(g[r][costCol])); if (v != null) { s += v; c++; } } totalCost = c ? s / c : null; }
  const areaCol = colOf("Conditioned Floor Area");
  let area = 0; if (areaCol >= 0) for (const r of rowIdxs) { const v = num(rv(g[r][areaCol])); if (v) { area = v; break; } }
  return { eu, totalCost, area };
}

/** Parse a US state abbreviation from a weather/climate-file string ("… CA USA …"). */
function stateFromClimateFile(s: string): string {
  const m = String(s || "").match(/\b([A-Z]{2})\s+USA\b/);
  if (m && STATE_NAMES[m[1]]) return m[1];
  const m2 = String(s || "").match(/\b([A-Z]{2})\b/g);
  if (m2) for (const x of m2) if (STATE_NAMES[x]) return x;
  return "";
}

/** Build the Energy / Carbon / Cost end-use maps + EUI/CEI/ECI from the raw
 *  sheets. Returns null when the raw sheets aren't usable. */
function computeRawReportData(wb: XLSX.WorkBook, proj: Grid, climateFile: string): null | {
  energy: Record<string, EndUseRow>; carbon: Record<string, EndUseRow>; cost: Record<string, EndUseRow>;
  eui: number; cei: number; eci: number; hasCode: boolean;
} {
  const bl = gridOf(wb.Sheets["BL Data"]); const pr = gridOf(wb.Sheets["Proposed Data"]);
  if (!bl.length || !pr.length) return null;
  const dataRows = (g: Grid) => { const out: number[] = []; for (let r = 1; r < g.length; r++) if (String(rv(g[r][0]) ?? "").trim()) out.push(r); return out; };
  const blRows = dataRows(bl), prRows = dataRows(pr);
  if (!blRows.length || !prRows.length) return null;

  const leed = rawModel(bl, blRows);     // LEED baseline = avg of baseline rotations
  const prop = rawModel(pr, prRows);     // Proposed = avg of proposed rows
  const area = prop.area || leed.area || 1;

  // rates ($/unit) — Project Info I29 elec, J29 gas (rows are 1-based → grid idx 28)
  const pcell = (r: number, c: number) => num(rv((proj[r - 1] || [])[c - 1]));
  const elecPerKwh = pcell(29, 9) || 0;       // I29
  const gasPerTherm = pcell(29, 10) || 0;     // J29
  // carbon factor (kg/kWh): Project Info I22, else ENERGY STAR eGRID subregion by state
  let elecCarbonKwh = pcell(22, 9) || 0;      // I22
  if (!elecCarbonKwh) { const st = stateFromClimateFile(climateFile); const sub = subregionFor(st, ""); if (sub) elecCarbonKwh = espmElecCarbonPerKwh(sub); }
  const er = elecPerKwh / KWH_KBTU, gr = gasPerTherm / THERM_KBTU;            // $/kBtu
  const ec = elecCarbonKwh / KWH_KBTU, gc = ESPM_GAS_KG_PER_THERM / THERM_KBTU; // kg/kBtu
  const dcC = ESPM_DISTRICT_KG_PER_MBTU.chilledWaterElectric / MBTU_KBTU, dhC = ESPM_DISTRICT_KG_PER_MBTU.hotWater / MBTU_KBTU;
  const costOf = (f: FuelSplit) => f.elec * er + f.gas * gr; // district/addl rates unknown → 0
  const carbonOf = (f: FuelSplit) => f.elec * ec + f.gas * gc + f.dc * dcC + f.dh * dhC;

  const energy: Record<string, EndUseRow> = {}, carbon: Record<string, EndUseRow> = {}, cost: Record<string, EndUseRow> = {};
  const pct = (b: number, p: number) => (b > 0 ? (b - p) / b : 0);
  let eTotL = 0, eTotP = 0, cTotL = 0, cTotP = 0, kTotL = 0, kTotP = 0;
  for (const d of RAW_ENDUSE) {
    const k = norm(d.label); const L = leed.eu[k], P = prop.eu[k];
    const eL = L.energy, eP = P.energy; eTotL += eL; eTotP += eP;
    const kL = carbonOf(L), kP = carbonOf(P); kTotL += kL; kTotP += kP;
    const $L = costOf(L), $P = costOf(P); cTotL += $L; cTotP += $P;
    energy[k] = { leed: eL, code: 0, proposed: eP, leedPct: pct(eL, eP), codePct: 0 };
    carbon[k] = { leed: kL, code: 0, proposed: kP, leedPct: pct(kL, kP), codePct: 0 };
    cost[k] = { leed: $L, code: 0, proposed: $P, leedPct: pct($L, $P), codePct: 0 };
  }
  // totals (use the raw Total Energy Cost columns for cost totals when present)
  const costL = leed.totalCost ?? cTotL, costP = prop.totalCost ?? cTotP;
  const totalRow = (l: number, p: number): EndUseRow => ({ leed: l, code: 0, proposed: p, leedPct: pct(l, p), codePct: 0 });
  energy["total site energy use"] = energy["total energy use"] = totalRow(eTotL, eTotP);
  energy["energy use intensity"] = totalRow(eTotL / area, eTotP / area);
  carbon["total carbon emissions"] = totalRow(kTotL, kTotP);
  carbon["carbon emissions intensity"] = totalRow(kTotL / area, kTotP / area);
  cost["total energy cost"] = totalRow(costL, costP);
  cost["energy cost intensity"] = totalRow(costL / area, costP / area);

  return { energy, carbon, cost, eui: eTotP / area, cei: kTotP / area, eci: costP / area, hasCode: false };
}

/** Average a COLUMNS field across data rows of a BL/Proposed-Data grid. */
function rawFieldAvg(g: Grid, rowIdxs: number[], key: string): number | null {
  const def = COLUMNS.find((c) => c[1] === key); if (!def) return null;
  const header = (g[0] || []).map((c) => norm(rv(c)));
  const ci = header.indexOf(norm(def[0])); if (ci < 0) return null;
  let s = 0, c = 0; for (const r of rowIdxs) { const v = num(rv(g[r][ci])); if (v != null) { s += v; c++; } }
  return c ? s / c : null;
}
/** Map an Input-Summary parameter label (no units) → a COLUMNS field key. */
function keyForParamLabel(labelNorm: string): string | null {
  if (!labelNorm) return null;
  for (const [h, k] of COLUMNS) { const hn = norm(h); if (hn === labelNorm || hn.startsWith(labelNorm + " ") || hn.startsWith(labelNorm)) return k; }
  return null;
}
/** Format a number with the same decimal precision as a sample string. */
function fmtLike(sample: string, val: number): string {
  const s = String(sample || "").replace(/,/g, "").trim();
  let dec = 1;
  if (/^-?\d+(\.\d+)?$/.test(s)) { const dot = s.indexOf("."); dec = dot >= 0 ? s.length - dot - 1 : 0; }
  return val.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
/** Fill the Proposed (and any missing LEED) simulation-parameter values from the
 *  raw BL/Proposed Data sheets — used when the Input Summary's formula-driven
 *  Proposed column is blank/0 (broken proposed selector). */
function fillRawParams(params: Record<string, string[]>, bl: Grid, pr: Grid): void {
  const dr = (g: Grid) => { const o: number[] = []; for (let r = 1; r < g.length; r++) if (String(rv(g[r][0]) ?? "").trim()) o.push(r); return o; };
  const blRows = dr(bl), prRows = dr(pr);
  if (!prRows.length) return;
  const blank = (v: string | undefined) => v == null || v === "" || v === "-" || /^\$?\s*0(\.0+)?%?$/.test(String(v).replace(/,/g, ""));
  for (const [labelNorm, vals] of Object.entries(params)) {
    const key = keyForParamLabel(labelNorm); if (!key) continue;
    if (blank(vals[2])) { const pv = rawFieldAvg(pr, prRows, key); if (pv != null && isFinite(pv)) vals[2] = fmtLike(vals[0] && !blank(vals[0]) ? vals[0] : "0.0", pv); }
    if (blank(vals[0])) { const bv = rawFieldAvg(bl, blRows, key); if (bv != null && isFinite(bv)) vals[0] = fmtLike("0.0", bv); }
  }
}

/** Scan an end-use block: labelCol holds the row name, then 5 value cols. */
function readEndUse(g: Grid, labelCol: number): Record<string, EndUseRow> {
  const out: Record<string, EndUseRow> = {};
  for (let r = 0; r < g.length; r++) {
    const label = rv(g[r][labelCol]);
    if (label == null || label === "" || label === 0) continue;
    out[norm(label)] = {
      leed: rv(g[r][labelCol + 2]), code: rv(g[r][labelCol + 3]), proposed: rv(g[r][labelCol + 4]),
      leedPct: rv(g[r][labelCol + 5]), codePct: rv(g[r][labelCol + 6]),
    };
  }
  return out;
}

/** City, ST from a weather-file string like "Baltimore    MD TMY2". */
function deriveLocation(climateFile: string): string {
  const t = String(climateFile || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Za-z .'\-]+?)\s+([A-Z]{2})\b/);
  return m ? `${m[1].trim()}, ${m[2]}` : t;
}
/** Best-effort project location from a weather-file string. eQUEST strings
 *  ("Baltimore MD TMY2") yield "Baltimore, MD"; polluted TRACE strings
 *  ("ASHRAE … Climate Zone 10 CA USA CTZRV2 WMO#=722860") fall back to the
 *  state name ("California"). The modeler can override via Project Info. */
function resolveLocation(climateFile: string): string {
  const loc = deriveLocation(climateFile);
  if (/baseline|climate zone|wmo#|\*\*/i.test(loc) || loc.length > 40) {
    const st = stateFromClimateFile(climateFile);
    return st ? STATE_NAMES[st] : "";
  }
  return loc;
}

export function readWorkbook(buf: ArrayBuffer): ReportData {
  const wb = XLSX.read(buf, { cellStyles: false });
  const rep = gridOf(wb.Sheets["Report"]);
  const inp = gridOf(wb.Sheets["Input Summary"]);
  const proj = gridOf(wb.Sheets["Project Info"]);
  const bl = wb.Sheets["BL Data"], pr = wb.Sheets["Proposed Data"];
  const find = (g: Grid, col: number, label: string, valCol: number) => {
    const key = norm(label);
    for (let r = 0; r < g.length; r++) if (norm(rv(g[r][col])).includes(key)) return rv(g[r][valCol]);
    return null;
  };
  // Result summary: column B label, column D value
  const eui = find(rep, 1, "energy use intensity", 3);
  const cei = find(rep, 1, "carbon emissions intensity", 3);
  const eci = find(rep, 1, "energy cost intensity", 3);
  // Unmet hours: label col BO(66), values BP/BQ/BR (67/68/69)
  const unmetRow = (label: string) => {
    for (let r = 0; r < rep.length; r++) if (norm(rv(rep[r][66])).includes(norm(label))) return [rv(rep[r][67]), rv(rep[r][68]), rv(rep[r][69])];
    return [null, null, null];
  };
  // Virtual rates from Input Summary: row with "Unit CO2e" / "Unit Energy Cost", values L..P (11..15)
  const rateRow = (label: string) => {
    for (let r = 0; r < inp.length; r++) if (norm(rv(inp[r][9])).includes(norm(label))) return [rv(inp[r][11]), rv(inp[r][12]), rv(inp[r][13]), rv(inp[r][14]), rv(inp[r][15])];
    return [null, null, null, null, null];
  };
  // Simulation parameters (envelope/loads + HVAC/exterior) — keyed by label,
  // values taken as Excel-formatted strings so they read exactly like the workbook.
  const params: Record<string, string[]> = {};
  const addParams = (labelCol: number, valCols: number[]) => {
    for (let r = 0; r < inp.length; r++) {
      const label = rv(inp[r][labelCol]);
      if (label == null || label === "" || (typeof label === "number")) continue;
      const key = norm(label); if (!key) continue;
      params[key] = valCols.map((c) => rw(inp[r][c]));
    }
  };
  addParams(1, [5, 6, 7]);   // B label → F/G/H  (envelope + loads)
  addParams(9, [11, 12, 13]); // J label → L/M/N  (HVAC + exterior)

  const climateZone = String(find(proj, 1, "climate zone", 3) || (bl && bl["E2"]?.v) || (pr && pr["E2"]?.v) || "").trim();
  const climateFile = String((bl && bl["D2"]?.v) || (pr && pr["D2"]?.v) || "").replace(/\s+/g, " ").trim();
  const projectName = String(find(proj, 1, "project name", 3) || "").trim();
  const projectLocation = String(find(proj, 1, "project location", 3) || "").trim();
  const dataSource = String(find(proj, 1, "source of cost", 3) || find(proj, 1, "cost and emissions data", 3) || "").trim();
  const wmo = parseWmo(climateFile);
  const climateFileClean = cleanClimateFile(climateFile);
  // which simulation tool produced the model (drives the Software paragraph)
  const rp = String((pr && pr["B2"]?.v) || (bl && bl["B2"]?.v) || "").toLowerCase();
  const tool: ReportData["tool"] = /honeybee|\.hbjson/.test(rp) ? "honeybee"
    : /\.pdf\b|trace/.test(rp) ? "trace"
    : /\.sim\b|equest|doe-?2/.test(rp) ? "equest" : null;

  // Result-summary block from the Report sheet: col B (1) label → col C (2) & col D
  // (3) display strings. Feeds the LEED Energy Credit + AIA 2030 summary tables.
  const summary: Record<string, { c: string; d: string }> = {};
  for (let r = 0; r < rep.length; r++) {
    const label = rv(rep[r][1]);
    if (label == null || label === "" || typeof label === "number") continue;
    const key = norm(label); if (!key) continue;
    summary[key] = { c: rw(rep[r][2]), d: rw(rep[r][3]) };
  }

  const energy = readEndUse(rep, 6);    // G..M
  const source = readEndUse(rep, 21);   // V..AB
  const carbon = readEndUse(rep, 36);   // AK..AQ
  const cost = readEndUse(rep, 51);     // AZ..BF
  // A LEED / Code baseline exists only if some end-use carries a non-zero value
  // in that column (a project may have just one baseline — e.g. Code/Title 24).
  const anyIn = (m: Record<string, EndUseRow>, key: keyof EndUseRow) => Object.values(m).some((r) => { const v = num(r[key]); return v != null && v !== 0; });
  let hasCode = anyIn(energy, "code") || anyIn(carbon, "code") || anyIn(cost, "code");
  let hasLeed = anyIn(energy, "leed") || anyIn(carbon, "leed") || anyIn(cost, "leed");

  // The "Report" sheet is formula-driven and silently returns 0 when the
  // workbook's Proposed selector doesn't match the proposed model's name (or
  // carbon factors are missing). Detect THAT — proposed all zero, or carbon zero
  // for BOTH baselines — and recompute from the raw sheets. A legitimately-absent
  // LEED column (Code-only project) must NOT trigger this, or the code data gets
  // mislabeled as LEED.
  const allZero = (m: Record<string, EndUseRow>, key: keyof EndUseRow) => Object.values(m).every((r) => !num(r[key]));
  let energyM = energy, carbonM = carbon, costM = cost, euiV = eui, ceiV = cei, eciV = eci;
  if (allZero(energy, "proposed") || (allZero(carbon, "leed") && allZero(carbon, "code")) || allZero(cost, "proposed")) {
    const raw = computeRawReportData(wb, proj, climateFile);
    if (raw) {
      energyM = raw.energy; carbonM = raw.carbon; costM = raw.cost;
      euiV = raw.eui; ceiV = raw.cei; eciV = raw.eci;
      // the raw recompute lumps all baseline rows into the LEED column
      hasCode = anyIn(energyM, "code") || anyIn(carbonM, "code") || anyIn(costM, "code");
      hasLeed = anyIn(energyM, "leed") || anyIn(carbonM, "leed") || anyIn(costM, "leed");
      // also recover the Proposed simulation-parameter values from raw data
      fillRawParams(params, gridOf(wb.Sheets["BL Data"]), gridOf(wb.Sheets["Proposed Data"]));
    }
  }

  return {
    eui: euiV, cei: ceiV, eci: eciV, tool,
    unmetHeating: unmetRow("unmet heating"), unmetCooling: unmetRow("unmet cooling"),
    energy: energyM, source, carbon: carbonM, cost: costM,
    co2eRates: rateRow("unit co2e"), costRates: rateRow("unit energy cost"),
    summary,
    params,
    totalFloorArea: find(inp, 1, "total floor area", 5),
    climateZone, climateFile, location: resolveLocation(climateFile), projectName,
    projectLocation, dataSource, wmo, climateFileClean, hasCode, hasLeed,
  };
}

/* ============================================================
 *  2. FILL TABLE CELLS  (surgical: only replace placeholder <w:t> text)
 * ============================================================ */
const PLACEHOLDER = /^[\s ]*(?:-|0\.0%|\$[\s ]*-|\$[\s ]*0(?:\.00)?|0(?:\.0+)?%?|N\/A)?[\s ]*$/;

/** Replace, left-to-right, the placeholder value-cells in one table-row XML.
    Rebuilt positionally so identical adjacent cells fill correctly. */
function fillRow(rowXml: string, values: string[]): string {
  if (!values.length) return rowXml;
  let vi = 0, started = false, last = 0, result = "";
  const re = /<w:tc>[\s\S]*?<\/w:tc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml))) {
    const cellXml = m[0];
    result += rowXml.slice(last, m.index);
    last = m.index + cellXml.length;
    let cell = cellXml;
    if (vi < values.length) {
      const tMatch = cellXml.match(new RegExp(WT + "([\\s\\S]*?)</w:t>"));
      const text = tMatch ? tMatch[1] : "";
      const isPlaceholder = PLACEHOLDER.test(text);
      if (!started && isPlaceholder && text.trim() !== "") started = true; // first "-"/"0.0%" cell
      if (started && isPlaceholder && tMatch) {
        cell = cellXml.replace(new RegExp("(" + WT + ")[\\s\\S]*?(</w:t>)"), (_x, a, b) => a + escXml(values[vi++]) + b);
      } else if (started && !isPlaceholder) {
        vi = values.length; // passed the value block → stop
      }
    }
    result += cell;
  }
  result += rowXml.slice(last);
  return result;
}

/** Locate a table by an anchor (heading text or a first-column label) and fill
    its rows from a label→values map. Returns updated document xml. */
function fillTableByRows(
  xml: string, anchor: { headingStyle?: string; text: string },
  rowValues: (label: string) => string[] | null,
): string {
  // find anchor position
  const esc = anchor.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pos = -1;
  if (anchor.headingStyle) {
    // pStyle + text must be in the SAME paragraph (don't cross </w:p> into the TOC)
    const re = new RegExp(`<w:pStyle w:val="${anchor.headingStyle}"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
    const m = xml.match(re);
    if (m) pos = m.index!;
  }
  if (pos < 0) {
    const t = new RegExp(`${WT}\\s*${esc}\\s*</w:t>`, "i");
    const m = xml.match(t); if (m) pos = m.index!;
  }
  if (pos < 0) return xml;
  // Heading anchors sit BEFORE the table → search forward. Label anchors sit
  // INSIDE the table → use the table that contains the anchor.
  let tblStart: number;
  if (anchor.headingStyle) tblStart = xml.indexOf("<w:tbl>", pos);
  else tblStart = xml.lastIndexOf("<w:tbl>", pos);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  const tbl = xml.slice(tblStart, tblEnd);
  const newTbl = tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const firstCell = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/) || [""])[0];
    const label = [...firstCell.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim();
    const vals = rowValues(label);
    return vals && vals.length ? fillRow(row, vals) : row;
  });
  return xml.slice(0, tblStart) + newTbl + xml.slice(tblEnd);
}

/* End-use rows that may be dropped when entirely zero (normalized labels). Total/
   intensity/regulated and non-end-use rows are never in this set, so they stay. */
const DROP_ENDUSE = new Set([
  "heating", "cooling", "lighting", "exterior lighting", "equipment", "exterior equipment",
  "fans", "pumps", "heat rejection", "humidification", "heat recovery", "water systems",
  "refrigeration", "generators", "renewable energy", "shw", "pv", "wind", "uncertainty",
]);

/* map document end-use label → workbook key (handles aliases/typos) */
function endUseLookup(map: Record<string, EndUseRow>, label: string): EndUseRow | null {
  const n = norm(label);
  if (!n) return null;
  if (map[n]) return map[n];
  const alias: Record<string, string> = {
    "total site energy use": "total energy use", "total energy use": "total energy use",
    "energy use intensity": "energy use intensity", "carbon emissions intensity": "carbon emissions intensity",
    "regulated loads": "regulated loads", "total carbon emissions": "total carbon emissions",
    "total energy cost": "total energy cost",
  };
  if (alias[n] && map[alias[n]]) return map[alias[n]];
  // loose contains match
  for (const k of Object.keys(map)) if (k && (k === n || k.includes(n) || n.includes(k))) return map[k];
  return null;
}

/** concatenated lower-cased text of a table cell */
function tcText(cellXml: string): string {
  return [...cellXml.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim();
}
/** Fill an end-use breakdown table by COLUMN POSITION (read from the header
 *  row), not by placeholder scanning. The breakdown tables have BLANK value
 *  cells (no "-"), so placeholder logic mis-aligns them — this maps each header
 *  column ("LEED Baseline", "Code Baseline", "Proposed", "LEED", "Code") to a
 *  field and writes the formatted value into that exact cell. */
function fillEndUseSection(xml: string, heading: string, data: Record<string, EndUseRow>, unit: "energy" | "carbon" | "cost"): string {
  let pos = headingPos(xml, "Heading3", heading);
  if (pos < 0) { const m = xml.match(new RegExp(WT + "\\s*" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*</w:t>", "i")); pos = m ? m.index! : -1; }
  if (pos < 0) return xml;
  const tblStart = xml.indexOf("<w:tbl>", pos);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  const tbl = xml.slice(tblStart, tblEnd);
  const fmtVal = unit === "cost" ? fmtMoney : fmtInt;

  let colMap: Record<number, keyof EndUseRow> | null = null;
  let width = 0, headerSeen = false, out = "", last = 0;
  const re = /<w:tr\b[\s\S]*?<\/w:tr>/g; let m: RegExpExecArray | null;
  while ((m = re.exec(tbl))) {
    out += tbl.slice(last, m.index); last = m.index + m[0].length;
    let row = m[0];
    const cells = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
    const texts = cells.map((c) => tcText(c[0]).toLowerCase());
    if (!headerSeen) {
      if (texts.includes("proposed") || texts.includes("leed baseline")) {
        headerSeen = true; width = cells.length; colMap = {};
        texts.forEach((t, i) => {
          if (t === "leed baseline") colMap![i] = "leed";
          else if (t === "code baseline") colMap![i] = "code";
          else if (t === "proposed") colMap![i] = "proposed";
          else if (t === "leed") colMap![i] = "leedPct";
          else if (t === "code") colMap![i] = "codePct";
        });
      }
    } else if (colMap && cells.length === width) {
      const label = tcText(cells[0][0]);
      const r = endUseLookup(data, label);
      // Drop entirely-zero rows: any end-use row (incl. Renewable Energy and
      // blank/"-" placeholders) whose values are all zero or absent. Totals,
      // intensities, Regulated Loads and non-end-use rows are always kept.
      const n = norm(label);
      const isTotal = /total|intensity|regulated/i.test(label);
      const droppable = n === "" || DROP_ENDUSE.has(n);
      const zero = !r || (!num(r.leed) && !num(r.code) && !num(r.proposed));
      if (!isTotal && droppable && zero) continue; // skip this row entirely
      if (r) {
        let ci = 0;
        row = row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => {
          const field = colMap![ci++];
          if (!field) return c;
          const val = (field === "leedPct" || field === "codePct") ? fmtPct(r[field]) : fmtVal(r[field]);
          return setCellText(c, val);
        });
      }
    }
    out += row;
  }
  out += tbl.slice(last);
  return xml.slice(0, tblStart) + out + xml.slice(tblEnd);
}

/* ---------- Simulation-parameter tables: value cells are EMPTY, so we
   inject a run (reusing the cell's run-properties) or replace any existing
   placeholder text. ---------- */
function setCellText(cellXml: string, val: string): string {
  if (new RegExp(WT).test(cellXml))
    return cellXml.replace(new RegExp("(" + WT + ")[\\s\\S]*?(</w:t>)"), (_x, a, b) => a + escXml(val) + b);
  const rPr = (cellXml.match(/<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/) || [])[1] || "";
  const run = `<w:r>${rPr}<w:t xml:space="preserve">${escXml(val)}</w:t></w:r>`;
  return cellXml.replace("</w:p>", run + "</w:p>");
}

/** position of a heading paragraph (pStyle + text in the same <w:p>). */
function headingPos(xml: string, style: string, text: string): number {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:pStyle w:val="${style}"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
  const m = xml.match(re); return m ? m.index! : -1;
}

/** Fill every parameter table (WWR / U-values / HVAC / loads / exterior) that
    lives between the "Simulation Parameters" and "Detailed Results" headings.
    Rows are matched by label; LEED/Code/Proposed go into cells 2,3,4. */
function fillParamRegion(xml: string, params: Record<string, string[]>): string {
  const s = headingPos(xml, "Heading2", "Simulation Parameters"); if (s < 0) return xml;
  let e = headingPos(xml, "Heading1", "Detailed Results"); if (e < 0 || e < s) e = xml.length;
  const region = xml.slice(s, e);
  const filled = region.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
    if (cells.length < 5) return row;
    const label = [...cells[0][0].matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim();
    const vals = params[norm(label)];
    if (!vals) return row;
    let ci = 0;
    return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => {
      const idx = ci++;
      return (idx >= 2 && idx <= 4 && vals[idx - 2] != null && vals[idx - 2] !== "") ? setCellText(c, vals[idx - 2]) : c;
    });
  });
  return xml.slice(0, s) + filled + xml.slice(e);
}

/** Fill EVERY table whose first-row first cell equals `title`, writing each row's
    values into the cells starting at column index `valueColStart`. Used for the
    fixed-layout Result-Summary tables (LEED Energy Credit, AIA 2030) whose value
    cells aren't reliable "-" placeholders. `rowVals(label)` → values or null. */
function fillSummaryTable(xml: string, title: string, valueColStart: number, rowVals: (label: string) => (string | null)[] | null): string {
  const titleN = norm(title);
  return xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const firstRow = (tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/) || [""])[0];
    const titleCell = (firstRow.match(/<w:tc>[\s\S]*?<\/w:tc>/) || [""])[0];
    if (norm(tcText(titleCell)) !== titleN) return tbl;
    return tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
      const cells = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
      if (!cells.length) return row;
      const vals = rowVals(tcText(cells[0][0]));
      if (!vals || !vals.length) return row;
      let ci = 0;
      return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => {
        const vi = ci++ - valueColStart;
        return (vi >= 0 && vi < vals.length && vals[vi] != null && vals[vi] !== "") ? setCellText(c, vals[vi] as string) : c;
      });
    });
  });
}

/** AIA 2030 Summary row value (Report col D display string) for a document label. */
function aiaValueFor(summary: Record<string, { c: string; d: string }>, label: string): (string | null)[] | null {
  const n = norm(label);
  const d = (k: string) => (summary[k] ? [summary[k].d] : null);
  if (n.includes("gross peui")) return d("gross peui design eui");
  if (n.includes("net peui")) return d("net peui w renewable offset");
  if (n.includes("benchmark eui")) return d("aia 2030 benchmark eui bmeui");
  if (n.includes("target eui")) return d("target eui based on 90 savings");
  if (n === "savings") return d("peui savings vs bmeui");
  if (n.includes("grid electricity")) return d("predicted annual grid electricity use");
  if (n.includes("annual gas")) return d("predicted annual gas use");
  if (n.includes("district use")) return d("predicted district use");
  if (n.includes("fossil fuel")) return d("predicted other fossil fuel source");
  if (n.includes("renewable use")) return d("predicted on site renewable use");
  return null;
}

/** LEED Energy Credit Summary row values [Savings, Points] for a document label. */
function leedValuesFor(summary: Record<string, { c: string; d: string }>, label: string): (string | null)[] | null {
  const n = norm(label);
  const cd = (k: string) => (summary[k] ? [summary[k].c, summary[k].d] : null);
  if (n.includes("optimize energy cost")) return cd("optimize energy performance");
  if (n.includes("optimize energy carbon")) return cd("optimize energy carbon performance"); // no workbook row yet → left as-is
  if (n.includes("eapc95")) return cd("eapc95 alternative metric");
  if (n.includes("renewable energy percentage")) return cd("renewable energy production");
  return null;
}

/** Rebuild a paragraph keeping its style/run-props but replacing the visible text. */
function setParaText(para: string, text: string): string {
  const open = (para.match(/^<w:p\b[^>]*>/) || ["<w:p>"])[0];
  const pPr = (para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0];
  const rPr = (para.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [])[1] || "";
  return `${open}${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;
}

/** Clone a Heading3 section (its heading paragraph + the table that follows) and
    re-insert it right after that table, with the heading re-titled `newText`. The
    clone keeps the source table's placeholders so it can be filled like any other.
    Used to add the "Source Energy" end-use breakdown the template lacks. */
function cloneSectionAfter(xml: string, srcHeading: string, newText: string): string {
  if (headingPos(xml, "Heading3", newText) >= 0) return xml; // already present
  const pos = headingPos(xml, "Heading3", srcHeading);
  if (pos < 0) return xml;
  const hStart = Math.max(xml.lastIndexOf("<w:p ", pos), xml.lastIndexOf("<w:p>", pos));
  if (hStart < 0) return xml;
  const hEnd = xml.indexOf("</w:p>", pos) + "</w:p>".length;
  const headingPara = xml.slice(hStart, hEnd);
  const tblStart = xml.indexOf("<w:tbl>", hEnd);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  const tbl = xml.slice(tblStart, tblEnd);
  // No leading page break: the Site charts inserted before this section already
  // end with a page break, so the Source heading starts cleanly on a new page.
  const clone = setParaText(headingPara, newText) + tbl;
  return xml.slice(0, tblEnd) + clone + xml.slice(tblEnd);
}

/** Replace [bracket] tokens inside the paragraph containing `anchor`, even when
    a token is split across runs — the whole paragraph is rebuilt as one run. */
/** Index of the first paragraph whose CONCATENATED visible text contains
 *  `needle` (handles tokens split across runs / fields). -1 if none. */
function paraIndexByText(xml: string, needle: string): number {
  const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) if (paraText(m[0]).includes(needle)) return m.index;
  return -1;
}
function fillParagraphTokens(xml: string, anchor: string, repl: Record<string, string>, prefix = ""): string {
  let ai = xml.indexOf(anchor);
  if (ai < 0) ai = paraIndexByText(xml, anchor);   // anchor may be split across runs
  if (ai < 0) return xml;
  const ps = Math.max(xml.lastIndexOf("<w:p ", ai), xml.lastIndexOf("<w:p>", ai)); if (ps < 0) return xml;
  const pe = xml.indexOf("</w:p>", ai) + "</w:p>".length;
  const para = xml.slice(ps, pe);
  let text = [...para.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((m) => m[1]).join("");
  for (const [k, v] of Object.entries(repl)) if (v) text = text.split(k).join(escXml(v));
  if (prefix) text = escXml(prefix) + text;
  const open = (para.match(/^<w:p\b[^>]*>/) || ["<w:p>"])[0];
  const pPr = (para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0];
  const rPr = (para.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [])[1] || "";
  const merged = `${open}${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  return xml.slice(0, ps) + merged + xml.slice(pe);
}

/** concatenated visible text of a paragraph block. */
function paraText(p: string): string {
  return [...p.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((m) => m[1]).join("");
}

/** Delete whole body paragraphs whose concatenated text matches `pred`
    (never a paragraph carrying section properties). */
function removeParagraphsWhere(xml: string, pred: (t: string) => boolean): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => (!/<w:sectPr/.test(p) && pred(paraText(p)) ? "" : p));
}

/** Collapse runs of blank paragraphs (≥2 in a row → 1) from `fromText` onward,
    so the report doesn't carry the template's big empty gaps / blank pages.
    Structural paragraphs (breaks, section props, drawings, bookmarks, fields,
    tabs) are never treated as blank. */
function collapseBlankParagraphs(xml: string, fromIndex: number): string {
  const i = fromIndex; if (i < 0) return xml;
  const isBlank = (p: string) =>
    !new RegExp(WT + "[\\s\\S]*?</w:t>").test(p) &&
    !/<w:drawing|<w:br\b|<w:sectPr|<w:bookmarkStart|<w:fldChar|<w:instrText|<w:pict|<w:object|<w:tab\b/.test(p);
  let prevBlank = false;
  const tail = xml.slice(i).replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
    if (isBlank(p)) { if (prevBlank) return ""; prevBlank = true; return p; }
    prevBlank = false; return p;
  });
  return xml.slice(0, i) + tail;
}

/** Remove footer-only blank pages: any run of "<page break> … empty paragraphs …
 *  <page break>" (no text, drawing, table, section break, bookmark or field in
 *  between) collapses to a SINGLE page break. This kills the blank pages created
 *  where an inserted chart block's trailing break meets the template's own break.
 *  Content is never removed — only empty paragraphs and the redundant break. */
function removeBlankPages(xml: string): string {
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const isBreak = (b: string) => !b.startsWith("<w:tbl") && /<w:br w:type="page"\/>/.test(b);
  const isContent = (b: string) =>
    b.startsWith("<w:tbl") || new RegExp(WT).test(b) ||
    /<w:drawing|<w:pict|<w:object|<w:sectPr|<w:bookmarkStart|<w:fldChar|<w:instrText/.test(b);
  for (let guard = 0; guard < 200; guard++) {
    const blocks: { s: number; e: number; xml: string }[] = [];
    let m: RegExpExecArray | null; blockRe.lastIndex = 0;
    while ((m = blockRe.exec(xml))) blocks.push({ s: m.index, e: m.index + m[0].length, xml: m[0] });
    let didChange = false;
    for (let i = 0; i < blocks.length; i++) {
      if (!isBreak(blocks[i].xml)) continue;
      let j = i + 1;
      while (j < blocks.length && !isBreak(blocks[j].xml) && !isContent(blocks[j].xml)) j++;
      if (j < blocks.length && isBreak(blocks[j].xml)) {
        // keep blocks[i] (first break); drop the empties + the second break (i+1 … j)
        xml = xml.slice(0, blocks[i + 1].s) + xml.slice(blocks[j].e);
        didChange = true; break;
      }
    }
    if (!didChange) break;
  }
  return xml;
}

/* ============================================================
 *  3. EMBED NATIVE CHARTS  (copied verbatim from the workbook)
 * ============================================================ */
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";

function inlineChartXml(rId: string, docPrId: number, name: string): string {
  // ~6.3" x 3.5" inline chart
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="5760720" cy="3200400"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="${escXml(name)}"/>` +
    `<wp:cNvGraphicFramePr/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rId}"/>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Insert a chart paragraph right after the table that follows `heading`. */
function insertChartAfterTable(xml: string, heading: string, chartParagraph: string): string {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:pStyle w:val="Heading3"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
  const m = xml.match(re);
  let pos = m ? m.index! : -1;
  if (pos < 0) { const t = new RegExp(`${WT}\\s*${esc}\\s*</w:t>`, "i"); const mm = xml.match(t); pos = mm ? mm.index! : -1; }
  if (pos < 0) return xml;
  const tblStart = xml.indexOf("<w:tbl>", pos);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  return xml.slice(0, tblEnd) + chartParagraph + xml.slice(tblEnd);
}

/* ============================================================
 *  3b. STRUCTURAL EDITS  (README, zoning page, images, code columns, captions)
 * ============================================================ */
const EMU_PER_PX = 9525;        // 96 dpi
const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

/** Pixel dimensions of a PNG or JPEG from its header bytes. */
function imageDims(buf: ArrayBuffer): { w: number; h: number } {
  const b = new Uint8Array(buf);
  // PNG: width/height are big-endian uint32 at bytes 16..24 (after IHDR)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    const rd = (o: number) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
    return { w: rd(16), h: rd(20) };
  }
  // JPEG: scan SOF0..SOF15 markers (skip APPn/DQT etc.)
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6]; const w = (b[i + 7] << 8) | b[i + 8];
        return { w, h };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return { w: 600, h: 400 }; // fallback aspect
}

/** Inline-image drawing paragraph, scaled to fit maxWidth (EMU), centered. */
function inlineImageXml(rId: string, docPrId: number, name: string, buf: ArrayBuffer, maxWidthEmu = 5486400): string {
  const { w, h } = imageDims(buf);
  let cx = w * EMU_PER_PX, cy = h * EMU_PER_PX;
  if (cx > maxWidthEmu) { cy = Math.round(cy * (maxWidthEmu / cx)); cx = maxWidthEmu; }
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="${escXml(name)}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>` +
    `<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** A "Figure N: title" caption paragraph (Caption style). */
function captionXml(n: number, title: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="left"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">Figure ${n}: ${escXml(title)}</w:t></w:r></w:p>`;
}

/** Find the OUTER <w:p>…</w:p> that encloses byte `idx`, honoring nested
 *  paragraphs (e.g. text boxes), and remove it. */
function removeOuterParagraphAt(xml: string, idx: number): string {
  const start = Math.max(xml.lastIndexOf("<w:p>", idx), xml.lastIndexOf("<w:p ", idx));
  if (start < 0) return xml;
  let depth = 0, i = start;
  const open = /<w:p\b[^>]*?>/g, openSelf = /<w:p\b[^>]*?\/>/;
  // walk tags from start, tracking <w:p> open/close depth
  const tagRe = /<\/?w:p\b[^>]*?>/g; tagRe.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const tag = m[0];
    if (/\/>$/.test(tag)) { if (depth === 0) { i = m.index + tag.length; break; } continue; }
    if (tag[1] === "/") { depth--; if (depth === 0) { i = m.index + tag.length; break; } }
    else depth++;
  }
  void open; void openSelf;
  return xml.slice(0, start) + xml.slice(i);
}

/** Remove the README text-box block(s) from the cover. The README lives inside a
 *  floating text box (mc:AlternateContent / w:pict), so we anchor on the box
 *  start — its nearest enclosing <w:p> is the body paragraph hosting the
 *  drawing — and drop that whole paragraph (Choice + Fallback together). */
function removeReadme(xml: string): string {
  let out = xml, guard = 0;
  while (guard++ < 4) {
    const i = out.indexOf("README");
    if (i < 0) break;
    const box = Math.max(out.lastIndexOf("<mc:AlternateContent", i), out.lastIndexOf("<w:drawing", i), out.lastIndexOf("<w:pict", i));
    const next = removeOuterParagraphAt(out, box >= 0 ? box : i);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Remove the "Figure 2: Energy Model Zoning" image + caption paragraphs and
 *  the trailing page break, so that whole page drops out of the report. */
function removeZoningPage(xml: string): string {
  let out = xml;
  // The zoning image paragraph sits AFTER the "Figure 1: Energy Model" caption
  // and BEFORE the "Figure 2: Energy Model Zoning" caption. Remove that drawing
  // paragraph first (anchored off Figure 1's caption so we never touch Fig 1's
  // own image, which precedes its caption).
  const fig1 = out.search(new RegExp(WT + "[^<]*Energy Model</w:t>", "i"));
  if (fig1 >= 0) {
    const fig1End = out.indexOf("</w:t>", fig1) + 6;
    const draw = out.indexOf("<w:drawing", fig1End);
    const zoneCap = out.search(new RegExp(WT + "[^<]*Energy Model Zoning[^<]*</w:t>", "i"));
    if (draw >= 0 && (zoneCap < 0 || draw < zoneCap)) {
      const next = removeOuterParagraphAt(out, draw);
      if (next !== out) out = next;
    }
  }
  // delete the zoning caption paragraph(s) (caption uses a SEQ field, so
  // "Energy Model Zoning" sits in its own <w:t> run).
  let guard = 0;
  while (guard++ < 4) {
    const m = out.match(new RegExp(WT + "[^<]*Energy Model Zoning[^<]*</w:t>", "i"));
    if (!m) break;
    const next = removeOuterParagraphAt(out, m.index!);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Drop one baseline's columns — the "<which> Baseline" value column and its
 *  matching "<which>" percent column — from every row of any table whose header
 *  carries that label. `which` = "leed" or "code". */
export function dropBaselineColumns(xml: string, which: "leed" | "code"): string {
  const baseLabel = `${which} baseline`;
  const cellTexts = (row: string) => [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) =>
    [...c[0].matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim().toLowerCase());
  return xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)];
    const headerCells = rows.map((r) => cellTexts(r[0]));
    const hIdx = headerCells.findIndex((c) => c.includes(baseLabel));
    if (hIdx < 0) return tbl;
    const h = headerCells[hIdx];
    const width = h.length;
    const baseCol = h.indexOf(baseLabel);
    const pctCol = h.findIndex((t, i) => i > baseCol && t === which);
    const drop = new Set([baseCol, pctCol].filter((i) => i >= 0));
    return tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
      // only touch rows with the same column count (skip merged title/spacer rows)
      if ([...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].length !== width) return row;
      let ci = 0;
      return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => (drop.has(ci++) ? "" : c));
    });
  });
}
/** Drop the "Code Baseline" + "Code" columns (no Code/Compliance baseline). */
export function dropCodeColumns(xml: string): string { return dropBaselineColumns(xml, "code"); }

/** Remove a whole section — from the given heading paragraph to the end of the
    body — while preserving the trailing body <w:sectPr> (page setup). Used to
    delete the unused "Design Alternatives" section at the end of the template. */
function removeSectionToEnd(xml: string, style: string, text: string): string {
  const pos = headingPos(xml, style, text);
  if (pos < 0) return xml;
  const start = Math.max(xml.lastIndexOf("<w:p ", pos), xml.lastIndexOf("<w:p>", pos));
  if (start < 0) return xml;
  const sect = xml.lastIndexOf("<w:sectPr");        // keep the final body sectPr
  const end = sect > start ? sect : xml.indexOf("</w:body>");
  if (end < 0 || end <= start) return xml;
  return xml.slice(0, start) + xml.slice(end);
}

/** Remove blank paragraphs at the TOP of a page — those immediately after an
    explicit page break, or immediately before a pageBreakBefore paragraph — so a
    page's content starts at the top margin. Inter-content "breathing" blanks
    (not at a page boundary) are preserved. */
function trimTopOfPageBlanks(xml: string): string {
  const blocks = [...xml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)];
  const isBlank = (p: string) =>
    !new RegExp(WT + "[\\s\\S]*?</w:t>").test(p) &&
    !/<w:drawing|<w:br\b|<w:sectPr|<w:bookmarkStart|<w:fldChar|<w:instrText|<w:pict|<w:object|<w:tab\b/.test(p);
  const remove = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    if (/<w:br w:type="page"\/>/.test(blocks[i][0])) { let j = i + 1; while (j < blocks.length && isBlank(blocks[j][0])) { remove.add(j); j++; } }
    if (/<w:pageBreakBefore\/>/.test(blocks[i][0])) { let j = i - 1; while (j >= 0 && isBlank(blocks[j][0])) { remove.add(j); j--; } }
  }
  if (!remove.size) return xml;
  let out = "", last = 0;
  blocks.forEach((b, idx) => { if (remove.has(idx)) { out += xml.slice(last, b.index!); last = b.index! + b[0].length; } });
  out += xml.slice(last);
  return out;
}

/* ============================================================
 *  4. MAIN
 * ============================================================ */
/** Wizard-collected fields (subset of the app's ProjectInfo) that supplement the
 *  workbook when filling the report's narrative placeholders. Each maps to a
 *  Parser Test.docx QA comment ID. All optional — a missing value is left as-is. */
export interface ReportFields {
  projectName?: string;        // #8
  clientName?: string;         // #5  footer
  floorArea?: number;          // #10
  projectLocation?: string;    // #11/#30
  climateZone?: string;        // #31
  leedCertType?: string;       // #9  e.g. "New Construction"
  ashraeVersion?: string;      // #24/#25
  referenceDocument?: string;  // #23
  documentPhase?: string;      // #23
  adjacentShading?: boolean;   // #26
  costDataSource?: string;     // #36
  costDataSourceNote?: string; // #36
  reportDate?: string;         // #2
}

export interface WordReportOptions {
  projectRendering?: { buf: ArrayBuffer; ext: string } | null; // cover image
  modelSnip?: { buf: ArrayBuffer; ext: string } | null;        // Figure 1 model image
  exportDate?: Date;       // report date (defaults to today)
  fallbackTitle?: string;  // used for [Project Title] when the workbook has no project name
  projectInfo?: ReportFields; // wizard-collected narrative fields (supplement the workbook)
}

/** Replace every occurrence of a literal bracket `token` (sitting inside a single
 *  <w:t> run) with `val`. No-op when `val` is empty or the token is absent. */
function replaceTokenGlobal(xml: string, token: string, val: string | undefined | null): string {
  if (val == null || val === "") return xml;
  return xml.split(token).join(escXml(val));
}

/** #45/#46 — when a simulation-parameter row is blank in the workbook, substitute
 *  a stock value: efficiency rows → "N/A"; fan-power / exterior-equipment rows →
 *  "Not included in energy model". Mutates the params map in place. */
function applyEmptyParamDefaults(params: Record<string, string[]>): void {
  const blank = (v: string | undefined) => v == null || v === "" || v === "-" || /^\$?\s*0(\.0+)?%?$/.test(String(v).replace(/,/g, ""));
  const NA = /efficiency|\bcop\b|\beer\b|\bseer\b|iplv|kw\s*\/\s*ton/i;          // chiller…heat-pump efficiencies
  const NIM = /fan power|exterior lighting|service (?:hot )?water|\bswh\b|elevator|process load|domestic hot water/i;
  for (const [labelNorm, vals] of Object.entries(params)) {
    if (vals.every(blank)) {
      const def = NA.test(labelNorm) ? "N/A" : NIM.test(labelNorm) ? "Not included in energy model" : "";
      if (def) for (let i = 0; i < vals.length; i++) vals[i] = def;
    }
  }
}

export async function buildWordReport(xlsxBuf: ArrayBuffer, docxBuf: ArrayBuffer, opts: WordReportOptions = {}): Promise<Blob> {
  const data = readWorkbook(xlsxBuf);
  const pi = opts.projectInfo || {};
  // report date: explicit Date wins, else a parseable ProjectInfo.reportDate, else today
  const reportDate = opts.exportDate || (pi.reportDate && !isNaN(Date.parse(pi.reportDate)) ? new Date(pi.reportDate) : new Date());

  const docZip = await JSZip.loadAsync(docxBuf);
  const xlZip = await JSZip.loadAsync(xlsxBuf);
  let doc = await docZip.file("word/document.xml")!.async("string");

  /* ---- content-types + relationships (shared by images and charts) ---- */
  let ct = await docZip.file("[Content_Types].xml")!.async("string");
  let rels = await docZip.file("word/_rels/document.xml.rels")!.async("string");
  let maxRid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]));
  const ctOverrides: string[] = [];
  const newRels: string[] = [];
  let mediaIdx = 1, docPr = 900;
  const haveExt = new Set([...ct.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const ensureExt = (ext: string, type: string) => { const e = ext.toLowerCase(); if (!haveExt.has(e)) { haveExt.add(e); ctOverrides.push(`<Default Extension="${e}" ContentType="${type}"/>`); } };
  /** Add an image media part, return its inline-image paragraph XML. */
  const addImage = (img: { buf: ArrayBuffer; ext: string }, name: string): string => {
    const ext = img.ext.replace(/^\./, "").toLowerCase();
    ensureExt(ext === "jpg" ? "jpg" : ext, ext === "png" ? "image/png" : "image/jpeg");
    const part = `media/rptimg${mediaIdx}.${ext}`;
    docZip.file(`word/${part}`, img.buf);
    const rId = `rId${++maxRid}`;
    newRels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${part}"/>`);
    mediaIdx++;
    return inlineImageXml(rId, docPr++, name, img.buf);
  };

  /* ---- cover: remove README box, fill title block, insert rendering ---- */
  doc = removeReadme(doc);
  const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const projName = data.projectName || pi.projectName || opts.fallbackTitle || "";
  doc = fillParagraphTokens(doc, "Project Title", { "[Project Title]": projName });
  doc = fillParagraphTokens(doc, "Analysis Title", { "[Analysis Title]": "Energy Analysis" });
  doc = fillParagraphTokens(doc, "Month Day, Year", { "Month Day, Year": fmtDate(reportDate) });
  // Project rendering — replace the "[Insert Project Rendering]" placeholder with
  // the modeler's uploaded image; if none, just drop the placeholder paragraph.
  {
    const m = doc.match(new RegExp(WT + "\\s*Insert Project Rendering\\s*</w:t>"));
    if (m) {
      const repl = opts.projectRendering ? addImage(opts.projectRendering, "Project Rendering") : "";
      const start = Math.max(doc.lastIndexOf("<w:p>", m.index!), doc.lastIndexOf("<w:p ", m.index!));
      const end = doc.indexOf("</w:p>", m.index!) + "</w:p>".length;
      doc = doc.slice(0, start) + repl + doc.slice(end);
    }
  }
  // Model snip (Figure 1: Energy Model) — replace the template's sample model
  // image paragraph with the modeler's snip, keeping the caption.
  if (opts.modelSnip) {
    // Figure 1 caption run ends with "Energy Model" (Figure 2 ends with "Zoning").
    const cap = doc.search(new RegExp(WT + "[^<]*Energy Model</w:t>"));
    if (cap >= 0) {
      const drawStart = doc.lastIndexOf("<w:drawing>", cap);
      if (drawStart >= 0) {
        const ps = Math.max(doc.lastIndexOf("<w:p>", drawStart), doc.lastIndexOf("<w:p ", drawStart));
        const pe = doc.indexOf("</w:p>", drawStart) + "</w:p>".length;
        doc = doc.slice(0, ps) + addImage(opts.modelSnip, "Energy Model") + doc.slice(pe);
      }
    }
  }
  // Omit the Energy Model Zoning page
  doc = removeZoningPage(doc);

  /* ---- fill the data tables ---- */
  // Result Summary (EUI / CEI / ECI) — match by row label, single value cell
  doc = fillTableByRows(doc, { text: "Energy Use Intensity (EUI)" }, (label) => {
    const n = norm(label);
    if (n.includes("energy use intensity")) return [fmtDec(data.eui)];
    if (n.includes("carbon emissions intensity")) return [fmtDec(data.cei)];
    if (n.includes("energy cost intensity")) return [fmtDec(data.eci)];
    return null;
  });
  // LEED Energy Credit Summary — both variants (pre / post-2024 · v4.1) are filled
  // from the workbook's LEED block; Savings in col 1, Points in col 2.
  doc = fillSummaryTable(doc, "LEED Energy Credit Summary", 1, (label) => leedValuesFor(data.summary, label));
  // AIA 2030 Summary — single value column (col 2), straight from the Report sheet.
  doc = fillSummaryTable(doc, "AIA 2030 Summary", 2, (label) => aiaValueFor(data.summary, label));
  // Unmet hours
  doc = fillTableByRows(doc, { headingStyle: "Heading2", text: "Unmet Hours" }, (label) => {
    const n = norm(label);
    if (n.includes("heating")) return data.unmetHeating.map(fmtInt);
    if (n.includes("cooling")) return data.unmetCooling.map(fmtInt);
    return null;
  });
  // Virtual rates — anchor on the heading (the "Unit CO2e Emissions" cell text
  // is split across runs, so it can't be matched directly)
  doc = fillTableByRows(doc, { headingStyle: "Heading3", text: "Virtual Rates" }, (label) => {
    const n = norm(label);
    if (n.includes("co2e")) return data.co2eRates.map((v) => fmtDec(v, 4));
    if (n.includes("energy cost") || n.includes("unit energy")) return data.costRates.map(fmtMoney);
    return null;
  });
  // Climate paragraph (location / zone / weather file). Location prefers the
  // Project Info "Project Location" field; the climate-file name is cleaned of
  // run-name / CEC-zone / WMO noise; a parsed WMO# is prepended when present.
  doc = fillParagraphTokens(doc, "The project is based", {
    "[location]": pi.projectLocation || data.projectLocation || data.location,
    "[zone designation]": data.climateZone || pi.climateZone || "",
    "[insert name of climate file]": data.climateFileClean || data.climateFile,
  }, data.wmo ? `WMO#=${data.wmo}. ` : "");
  // Source of cost & emissions data (#36). Prefer the workbook's Project Info
  // value; else the wizard-collected cost source (+ optional qualifier note).
  const costSrc = data.dataSource || [pi.costDataSource, pi.costDataSourceNote].filter(Boolean).join(" — ");
  if (costSrc) {
    doc = fillParagraphTokens(doc, "source of the cost and emissions data", {
      "[Please note the source of the cost and emissions data]": costSrc,
    });
  }

  /* ---- wizard-collected narrative fields (#5/#8/#9/#10/#11/#23/#24/#25/#26) ----
     These supplement the workbook for placeholders it doesn't carry; each no-ops
     when its value is absent or its token isn't in the template. ---- */
  doc = replaceTokenGlobal(doc, "[insert project name]", projName || undefined);
  const areaNum = pi.floorArea != null ? pi.floorArea : num(data.totalFloorArea);
  doc = replaceTokenGlobal(doc, "[insert project area]", areaNum != null ? comma(areaNum) : undefined);
  doc = replaceTokenGlobal(doc, "[insert project location]", pi.projectLocation || data.projectLocation || data.location || undefined);
  doc = replaceTokenGlobal(doc, "[insert ASHRAE version]", pi.ashraeVersion);
  doc = replaceTokenGlobal(doc, "[new construction/refurbishment project]", pi.leedCertType);
  doc = replaceTokenGlobal(doc, "[insert document phase. i.e. Schematic Design etc.]", pi.documentPhase || pi.referenceDocument);
  doc = replaceTokenGlobal(doc, "[insert document phase]", pi.documentPhase || pi.referenceDocument);
  // #26 Adjacent shading: TRUE → keep the sentence, drop the "[If applicable:]"
  // label; FALSE → remove the whole sentence; undefined → leave as authored.
  if (pi.adjacentShading === true) {
    doc = replaceTokenGlobal(doc, "[If applicable:]", " ");
  } else if (pi.adjacentShading === false) {
    doc = removeParagraphsWhere(doc, (t) => /Adjacent shading structures were included/i.test(t));
  }
  // #5 footer — "Client Name" / "Project Name" literals → real values.
  if (pi.clientName || projName) {
    const fp = "word/footer1.xml";
    const ff = docZip.file(fp);
    if (ff) {
      let footer = await ff.async("string");
      if (pi.clientName) footer = footer.split("Client Name").join(escXml(pi.clientName));
      if (projName) footer = footer.split("Project Name").join(escXml(projName));
      docZip.file(fp, footer);
    }
  }
  // Software paragraph — keep only the description for the detected tool, drop
  // the others, the "[If …]" labels and the "[Choose …]" instruction line.
  if (data.tool) {
    doc = removeParagraphsWhere(doc, (t) => {
      const s = t.trim();
      if (/Choose the correct description/i.test(s)) return true;
      if (/^\[If [^\]]*\]$/i.test(s)) return true;
      if (/simulated using Honeybee/i.test(s) && data.tool !== "honeybee") return true;
      if (/simulated using TRACE 3D Plus/i.test(s) && data.tool !== "trace") return true;
      if (/simulated using eQUEST/i.test(s) && data.tool !== "equest") return true;
      return false;
    });
  }
  // Simulation Parameters — envelope, loads, HVAC & exterior-lighting tables.
  // #45/#46: substitute "N/A" / "Not included in energy model" for blank rows.
  applyEmptyParamDefaults(data.params);
  doc = fillParamRegion(doc, data.params);
  // Drop the unused baseline column so the headers read correctly:
  //   • only a LEED baseline (no Code)  → drop the "Code Baseline"/"Code" columns
  //   • only a Code/Title-24 baseline   → drop the "LEED Baseline"/"LEED" columns
  //     so the single baseline reads "Code Baseline" (not the template's default).
  if (data.hasCode && !data.hasLeed) doc = dropBaselineColumns(doc, "leed");
  else if (!data.hasCode) doc = dropCodeColumns(doc);
  // End-use breakdowns (the page-9-onward detail) — filled by column position.
  doc = fillEndUseSection(doc, "Energy Consumption", data.energy, "energy");
  doc = fillEndUseSection(doc, "Carbon Emissions", data.carbon, "carbon");
  doc = fillEndUseSection(doc, "Energy Cost", data.cost, "cost");

  /* ---- embed the native charts ----
     Per request, keep ONE chart per metric: Site = EUI (intensity), Carbon =
     absolute use, Cost = absolute cost (no Source charts, no intensity for carbon/
     cost). Each is placed on the page AFTER its table. ---- */
  const chartSheets: { heading: string; src: string; title: string }[] = [
    { heading: "Energy Consumption", src: "xl/charts/chart2.xml", title: "Site Energy Use Intensity by End Use (kBtu/ft²)" },
    { heading: "Carbon Emissions", src: "xl/charts/chart5.xml", title: "Carbon Emissions by End Use (kg CO2e)" },
    { heading: "Energy Cost", src: "xl/charts/chart7.xml", title: "Energy Cost by End Use ($/yr)" },
  ];
  let chartIdx = 1, figNo = 1; // Figure 1 = Energy Model (kept on the Model page)
  const embedChart = async (src: string, title: string): Promise<string> => {
    const srcFile = xlZip.file(src);
    if (!srcFile) return "";
    const chartXml = await srcFile.async("string");
    const partName = `word/charts/chart${chartIdx}.xml`;
    docZip.file(partName, chartXml);
    ctOverrides.push(`<Override PartName="/${partName}" ContentType="${CT_CHART}"/>`);
    const rId = `rId${++maxRid}`;
    newRels.push(`<Relationship Id="${rId}" Type="${REL_CHART}" Target="charts/chart${chartIdx}.xml"/>`);
    chartIdx++;
    return inlineChartXml(rId, docPr++, title) + captionXml(++figNo, title);
  };
  for (const s of chartSheets) {
    const c = await embedChart(s.src, s.title);
    if (c) doc = insertChartAfterTable(doc, s.heading, PAGE_BREAK + c + PAGE_BREAK);
  }
  if (ctOverrides.length) ct = ct.replace("</Types>", ctOverrides.join("") + "</Types>");
  if (newRels.length) rels = rels.replace("</Relationships>", newRels.join("") + "</Relationships>");

  // Remove the unused "Design Alternatives" section (last page) entirely.
  doc = removeSectionToEnd(doc, "Heading1", "Design Alternatives");
  // tidy up the template's excessive blank-paragraph gaps from the Detailed
  // Results heading onward (where the empty pages / top padding came from).
  // Anchored on the real Heading1 — never the TOC entry or the page-2 floating
  // tables — so those layouts are untouched.
  doc = collapseBlankParagraphs(doc, headingPos(doc, "Heading1", "Detailed Results"));
  // Drop footer-only blank pages (e.g. where a chart block's trailing page break
  // meets the template's own break between metric sections).
  doc = removeBlankPages(doc);
  // Remove dead vertical space at the top of pages (content starts at the margin).
  doc = trimTopOfPageBlanks(doc);

  docZip.file("[Content_Types].xml", ct);
  docZip.file("word/_rels/document.xml.rels", rels);
  docZip.file("word/document.xml", doc);

  return docZip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}
