/* ============================================================
 *  WORKBOOK BUILDER — clones the styled .xlsx template, clears its
 *  data rows, and populates them. The template (src/assets/
 *  energy_template.xlsx) owns ALL formatting — headers, colours,
 *  fonts, borders, number formats. We edit the .xlsx as a zip and
 *  inject ONLY cell values into the worksheet XML; styles.xml and the
 *  header row are never rewritten, so the download is byte-for-byte the
 *  company sample with the values swapped in. (xlsx-js-style cannot
 *  round-trip this Excel-authored file's fills, hence the zip surgery.)
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import type { Row } from "./sim";
import { COLUMNS } from "./columns";
import { enrichRow } from "./enrich";
import type { RateConfig } from "./rates";
import { siteToSourceFor, subregionFor, espmElecCarbonPerKwh, EGRID_STATE_KG_PER_KWH, STATE_NAMES } from "./rates";
import { EIA_COMM_CENTS_PER_KWH, EIA_GAS_DOLLARS_PER_THERM } from "./sources";

/** Parse a US state abbreviation from a weather/climate-file string. */
function stateFromWeather(s?: string): string {
  const t = String(s || "");
  const m = t.match(/\b([A-Z]{2})\s+USA\b/) || t.match(/\b([A-Z]{2})\b/);
  return m && STATE_NAMES[m[1]] ? m[1] : "";
}
/** Resolve effective utility rates, auto-sourcing any that are missing/zero
 *  from the embedded reference tables (EIA rates · ENERGY STAR/eGRID carbon),
 *  keyed by the project state/ZIP. Returns the values to write to Project Info. */
function resolveRates(cfg: RateConfig, sample: Row | undefined): { elec: number; gas: number; carbon: number } {
  const st = (cfg.state || stateFromWeather(sample?.weather_file)).toUpperCase();
  const zip = cfg.pincode || "";
  const elec = (cfg.elec_per_kwh && cfg.elec_per_kwh > 0) ? cfg.elec_per_kwh
    : (EIA_COMM_CENTS_PER_KWH[st] != null ? EIA_COMM_CENTS_PER_KWH[st] / 100 : 0.137);
  const gas = (cfg.gas_per_therm && cfg.gas_per_therm > 0) ? cfg.gas_per_therm
    : (EIA_GAS_DOLLARS_PER_THERM[st] != null ? EIA_GAS_DOLLARS_PER_THERM[st] : 0.95);
  let carbon = (cfg.elec_carbon_per_kwh && cfg.elec_carbon_per_kwh > 0) ? cfg.elec_carbon_per_kwh : 0;
  if (!carbon) { const sub = subregionFor(st, zip); carbon = sub ? espmElecCarbonPerKwh(sub) : (EGRID_STATE_KG_PER_KWH[st] || 0); }
  return { elec: +elec.toFixed(4), gas: +gas.toFixed(4), carbon: +carbon.toFixed(4) };
}
import templateUrl from "../assets/energy_template.xlsx?url";

/* fetch the bundled template once and reuse the buffer */
let _tplBuf: Promise<ArrayBuffer> | null = null;
function loadTemplate(): Promise<ArrayBuffer> {
  if (!_tplBuf) _tplBuf = fetch(templateUrl).then((r) => {
    if (!r.ok) throw new Error(`template fetch failed (HTTP ${r.status})`);
    return r.arrayBuffer();
  });
  return _tplBuf;
}

function escXml(s: any) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- chart-legend pruning ----------
   The Site / Source / Carbon / Cost charts carry one series PER end use, so the
   legend shows a colour for every end use even when a model has none of it. Map
   each series label → its end-use energy fields; an end use with zero energy
   across all cases gets its legend entry hidden (the bar is already zero). Labels
   we don't populate at all (SHW / PV / Wind / Uncertainty / blanks) are treated
   as zero too, so the legend shows ONLY the non-zero colours. */
const ENDUSE_FIELDS: Record<string, string[]> = {
  "heating": ["htg_elec_kbtu", "htg_gas_kbtu", "htg_add_fuel_kbtu", "htg_dist_htg_kbtu"],
  "cooling": ["clg_elec_kbtu", "clg_dist_kbtu"],
  "lighting": ["int_lighting_kbtu"],
  "exterior lighting": ["ext_lighting_kbtu"],
  "equipment": ["int_equip_kbtu", "int_equip_gas_kbtu", "int_equip_add_kbtu"],
  "exterior equipment": ["ext_equip_kbtu"],
  "fans": ["fans_kbtu"],
  "pumps": ["pumps_kbtu"],
  "heat rejection": ["heat_reject_kbtu"],
  "humidification": ["humid_elec_kbtu"],
  "heat recovery": ["heat_recov_kbtu"],
  "water systems": ["water_sys_elec_kbtu", "water_sys_gas_kbtu", "water_sys_add_kbtu", "water_sys_dist_kbtu"],
  "refrigeration": ["refrig_kbtu"],
  "generators": ["gen_kbtu"],
};
// Labels that mark a chart as an "end-use" chart (so the case-name charts —
// LEED/Code/Proposed — are never touched).
const ENDUSE_LABELS = new Set([...Object.keys(ENDUSE_FIELDS), "shw", "uncertainty", "pv", "wind", ""]);
const normLabel = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** End-use labels (normalized) that carry non-zero energy across the given rows. */
function presentEndUses(rows: Row[]): Set<string> {
  const present = new Set<string>();
  for (const [label, keys] of Object.entries(ENDUSE_FIELDS)) {
    let sum = 0;
    for (const r of rows) for (const k of keys) { const v = (r as any)[k]; if (typeof v === "number" && isFinite(v)) sum += v; }
    if (Math.abs(sum) > 1e-6) present.add(label);
  }
  return present;
}

/** Hide legend entries for entirely-zero series in every end-use chart (Site /
    Source / Carbon / Cost). Edits the chart parts in place — which also fixes the
    same charts when the Word report copies them out of this workbook. */
async function pruneChartLegends(zip: JSZip, present: Set<string>): Promise<void> {
  for (const f of zip.file(/^xl\/charts\/chart\d+\.xml$/) as JSZip.JSZipObject[]) {
    let xml = await f.async("string");
    const sers = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)];
    if (!sers.length) continue;
    const labels = sers.map((s) => {
      const tx = s[0].match(/<c:tx>[\s\S]*?<\/c:tx>/);
      return tx ? normLabel([...tx[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => m[1]).join("")) : "";
    });
    if (!ENDUSE_LABELS.has(labels[0])) continue;          // case-name charts → leave alone
    const hidden = labels.map((l, i) => (present.has(l) ? -1 : i)).filter((i) => i >= 0);
    if (!hidden.length || !/<c:legend>/.test(xml)) continue;
    const entries = hidden.map((i) => `<c:legendEntry><c:idx val="${i}"/><c:delete val="1"/></c:legendEntry>`).join("");
    // CT_Legend order: legendPos, legendEntry*, … — insert right after legendPos.
    xml = /<c:legendPos[^>]*\/>/.test(xml)
      ? xml.replace(/(<c:legendPos[^>]*\/>)/, `$1${entries}`)
      : xml.replace(/<c:legend>/, `<c:legend>${entries}`);
    zip.file(f.name, xml);
  }
}

/** 0-based column index → spreadsheet letters (0→A, 25→Z, 26→AA, 131→EB). */
function colLetter(n: number): string {
  let s = ""; n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** display-name → worksheet xml path, via workbook.xml + its rels. */
async function sheetPathMap(zip: JSZip): Promise<Record<string, string>> {
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const rid2tgt: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const tgt = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && tgt) rid2tgt[id] = tgt;
  }
  const map: Record<string, string> = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = (m[0].match(/name="([^"]+)"/) || [])[1];
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    let tgt = rid && rid2tgt[rid];
    if (name && tgt) map[name] = tgt.startsWith("/") ? tgt.slice(1) : "xl/" + tgt.replace(/^\.\//, "");
  }
  return map;
}

/* Rebuild a worksheet's <sheetData> by keeping the header row (r="1")
   verbatim and cloning the template's first data row (r="2") — with its
   per-column style indices — once per data row, injecting values. */
function injectSheet(xml: string, rows: (Row | null)[], cfg: RateConfig): string {
  const sd = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sd) return xml;
  const headerRow = (sd[1].match(/<row r="1"[\s\S]*?<\/row>/) || [""])[0];
  const proto = sd[1].match(/<row r="2"([^>]*)>([\s\S]*?)<\/row>/);
  if (!proto) return xml;
  const protoAttrs = proto[1];

  // map column-letter → ONLY the style attr (s="N") from the prototype data row.
  // The row may be SPARSE (Excel omits empty cells) so we key by real column
  // letter. We deliberately drop any cell TYPE (t="s"/"str"/…) and value the
  // prototype carried — otherwise a leftover t="s" collides with the type we add
  // and produces malformed XML that Excel silently "repairs" (wiping the sheet).
  const protoAttrByCol: Record<string, string> = {};
  for (const cm of proto[2].matchAll(/<c r="([A-Z]+)2"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g))
    protoAttrByCol[cm[1]] = (cm[2].match(/\ss="\d+"/) || [""])[0];

  const lastCol = COLUMNS.length - 1;
  const dataRows: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const R = i + 2; // header is row 1; data starts at row 2
    // a null slot → a blank (but styled) row, so e.g. LEED@row2 / Code@row6 line
    // up with the workbook's formulas even when some rotations are missing.
    const merged = rows[i] ? enrichRow(rows[i] as Row, cfg) : null;
    let cs = "";
    for (let c = 0; c <= lastCol; c++) {
      const col = colLetter(c);
      const attrs = protoAttrByCol[col] || "";
      const ref = `${col}${R}`;
      if (!merged) { cs += `<c r="${ref}"${attrs}/>`; continue; }
      const fmt = COLUMNS[c][2];
      let v: any = merged[COLUMNS[c][1]];
      if (v === undefined || v === null) v = fmt === "@" ? "" : 0;
      if (typeof v === "number" && isFinite(v)) cs += `<c r="${ref}"${attrs}><v>${v}</v></c>`;
      else if (v === "") cs += `<c r="${ref}"${attrs}/>`;
      else cs += `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }
    dataRows.push(`<row r="${R}"${protoAttrs}>${cs}</row>`);
  }

  const lastColLetter = colLetter(lastCol);
  const lastRow = Math.max(rows.length + 1, 1);
  return xml
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, () => `<sheetData>${headerRow}${dataRows.join("")}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\/>/, () => `<dimension ref="A1:${lastColLetter}${lastRow}"/>`);
}

/** Set a single existing cell's value in a worksheet's XML, keeping its style
    (s="N") and choosing the correct type (number vs inline string). Used for the
    handful of "Project Info" metadata inputs. */
function setSheetCellValue(xml: string, addr: string, value: string | number): string {
  const isNum = typeof value === "number" && isFinite(value);
  const re = new RegExp(`<c r="${addr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const body = isNum ? `<v>${value}</v>` : `t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is>`;
  if (re.test(xml)) {
    return xml.replace(re, (_m, attrs) => {
      const s = (String(attrs).match(/\ss="\d+"/) || [""])[0];
      return isNum ? `<c r="${addr}"${s}>${body}</c>` : `<c r="${addr}"${s} ${body}</c>`;
    });
  }
  return xml; // cell not present — skip rather than risk a malformed insert
}

/** Blank an existing cell's value (keep its style), so it renders empty. */
function clearSheetCell(xml: string, addr: string): string {
  const re = new RegExp(`<c r="${addr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  return xml.replace(re, (_m, attrs) => {
    const s = (String(attrs).match(/\ss="\d+"/) || [""])[0];
    return `<c r="${addr}"${s}/>`;
  });
}

import type { ProjectInfo } from "../store";
export interface WorkbookMeta { projectName?: string; projectInfo?: ProjectInfo | null; }

/** Reset a worksheet so it opens at the top-left: drop any saved scroll position
 *  (topLeftCell), and on un-frozen sheets snap the active cell back to A1. Frozen-
 *  pane sheets keep their pane selection (so we don't desync the pane), but lose
 *  the scroll offset. `tabSelected` is forced on only for the active (PI) sheet. */
function resetSheetView(xml: string, isActive: boolean): string {
  // strip saved scroll offsets on both <sheetView> and any <pane>
  let out = xml.replace(/\stopLeftCell="[^"]*"/g, "");
  // normalise tabSelected so exactly the active sheet is selected
  out = out.replace(/\stabSelected="[^"]*"/g, "");
  out = out.replace(/<sheetView\b([^>]*?)(\/?)>/g, (_m, attrs, selfClose) => {
    let a = String(attrs);
    if (isActive && !/\stabSelected=/.test(a)) a = ` tabSelected="1"` + a;
    return `<sheetView${a}${selfClose}>`;
  });
  // on sheets without a frozen pane, move the cursor back to A1
  out = out.replace(/<sheetView\b([^>]*)>([\s\S]*?)<\/sheetView>/g, (m, attrs, body) => {
    if (/<pane\b/.test(body)) return m;
    let nb = body.replace(/<selection\b[^>]*\/>/g, '<selection activeCell="A1" sqref="A1"/>');
    if (!/<selection/.test(nb)) nb += '<selection activeCell="A1" sqref="A1"/>';
    return `<sheetView${attrs}>${nb}</sheetView>`;
  });
  // a self-closing <sheetView .../> has no children — give it an explicit A1 cursor
  out = out.replace(/<sheetView\b([^>]*)\/>/g, '<sheetView$1><selection activeCell="A1" sqref="A1"/></sheetView>');
  return out;
}

/* Order the baseline rows into the workbook's fixed 8-row layout when the rows
   are human-classified (_cat = leed|code, _rot = 0|90|180|270):
     rows 2-5  = LEED   rotations 0 / 90 / 180 / 270
     rows 6-9  = Code    rotations 0 / 90 / 180 / 270
   Empty slots become blank rows. If the rows aren't classified, fall back to
   their natural order (older projects / the non-project pipeline). */
const ROT_INDEX: Record<number, number> = { 0: 0, 90: 1, 180: 2, 270: 3 };
function baselineLayout(blRows: Row[]): (Row | null)[] {
  if (!blRows.some((r) => r && r._cat)) return blRows;
  const slots: (Row | null)[] = new Array(8).fill(null);
  for (const r of blRows) {
    const block = r._cat === "code" ? 4 : 0;
    let idx = block + (ROT_INDEX[r._rot as number] ?? 0);
    if (slots[idx]) { idx = block; while (idx < block + 4 && slots[idx]) idx++; } // collision → next free in block
    if (idx < block + 4) slots[idx] = r;
  }
  return slots;
}

/** Clone the styled template and populate its BL / Proposed sheets (+ a few
    Project Info inputs). Returns a ready-to-download .xlsx Blob. */
export async function buildWorkbook(blRows: Row[], propRows: Row[], cfg: RateConfig, meta: WorkbookMeta = {}): Promise<Blob> {
  const zip = await JSZip.loadAsync(await loadTemplate());
  const paths = await sheetPathMap(zip);
  // Does the project actually use additional fuel / district energy? When it does
  // not, the Additional-Fuel / District-Cooling / District-Heating factor columns
  // must read "-" (not the template's bogus 1.00 / 0.91 defaults).
  const allRows = [...blRows, ...propRows];
  const usesFuel = (k: keyof Row) => allRows.some((r) => typeof r[k] === "number" && (r[k] as number) > 0);
  const hasAddFuel = usesFuel("additional_fuel_kbtu");
  const hasDistCool = usesFuel("district_cooling_kbtu");
  const hasDistHeat = usesFuel("district_heating_kbtu");
  const blName = Object.keys(paths).find((n) => /^bl\s*data/i.test(n)) || Object.keys(paths).find((n) => /^bl/i.test(n));
  const propName = Object.keys(paths).find((n) => /^proposed\s*data/i.test(n)) || Object.keys(paths).find((n) => /proposed/i.test(n));
  if (blName) zip.file(paths[blName], injectSheet(await zip.file(paths[blName])!.async("string"), baselineLayout(blRows), cfg));
  if (propName) zip.file(paths[propName], injectSheet(await zip.file(paths[propName])!.async("string"), propRows, cfg));

  // Project Info — overwrite the template's stale sample inputs with the current
  // project's, so the whole calc chain (cost/carbon savings → LEED summary) is
  // driven by THIS project. Metadata: D4 name · D5 climate zone · D7 cond. area.
  // Prerequisite rate inputs (the "Enter Flat Rate" cells the summary uses):
  // I29 electricity $/kWh · J29 gas $/therm · I22 electricity kg CO2e/kWh.
  const piName = Object.keys(paths).find((n) => /project\s*info/i.test(n));
  if (piName) {
    const sample = propRows[0] || blRows[0];
    let pi = await zip.file(paths[piName])!.async("string");
    // Project Info metadata — prefer the human-confirmed values from the post-parse
    // popup (meta.projectInfo); otherwise fall back to the project name / parsed model.
    const info = meta.projectInfo || {};
    const name = info.projectName || meta.projectName;
    if (name) pi = setSheetCellValue(pi, "D4", name);
    const cz = info.climateZone ?? sample?.climate_zone;
    if (cz != null && cz !== "") pi = setSheetCellValue(pi, "D5", String(cz));
    if (info.programType) pi = setSheetCellValue(pi, "D6", info.programType);
    const area = info.floorArea ?? sample?.conditioned_floor_area ?? sample?.total_floor_area;
    if (typeof area === "number" && area > 0) pi = setSheetCellValue(pi, "D7", area);
    // Baseline / LEED / code metadata (only written when supplied so the template's
    // sensible defaults survive when the popup was skipped).
    if (typeof info.benchmarkEui === "number" && info.benchmarkEui > 0) pi = setSheetCellValue(pi, "D10", info.benchmarkEui);
    if (typeof info.targetSavings === "number") pi = setSheetCellValue(pi, "D11", info.targetSavings);
    if (info.leedVersion) pi = setSheetCellValue(pi, "D12", info.leedVersion);
    if (info.leedType) pi = setSheetCellValue(pi, "D13", info.leedType);
    if (info.leedSubcategory) pi = setSheetCellValue(pi, "D14", info.leedSubcategory);
    if (info.energyCodeStandard) pi = setSheetCellValue(pi, "D15", info.energyCodeStandard);
    if (info.energyCodeProcessLoads) pi = setSheetCellValue(pi, "D16", info.energyCodeProcessLoads);
    // Performance Goals table — D=LEED, E=Code; rows 20 energy / 21 carbon / 22 cost.
    if (typeof info.energyGoalLeed === "number") pi = setSheetCellValue(pi, "D20", info.energyGoalLeed);
    if (typeof info.energyGoalCode === "number") pi = setSheetCellValue(pi, "E20", info.energyGoalCode);
    if (typeof info.carbonGoalLeed === "number") pi = setSheetCellValue(pi, "D21", info.carbonGoalLeed);
    if (typeof info.carbonGoalCode === "number") pi = setSheetCellValue(pi, "E21", info.carbonGoalCode);
    if (typeof info.costGoalLeed === "number") pi = setSheetCellValue(pi, "D22", info.costGoalLeed);
    if (typeof info.costGoalCode === "number") pi = setSheetCellValue(pi, "E22", info.costGoalCode);
    // QA/QC
    if (info.author) pi = setSheetCellValue(pi, "D26", info.author);
    if (info.date) pi = setSheetCellValue(pi, "D27", info.date);
    if (typeof info.uncertaintyFactor === "number") pi = setSheetCellValue(pi, "D28", info.uncertaintyFactor);
    // Auto-source any missing/zero rate from our utility-rate tables so the
    // workbook's cost/carbon calc chain is never left blank.
    const rr = resolveRates(cfg, sample);
    if (rr.elec > 0) pi = setSheetCellValue(pi, "I29", rr.elec);
    if (rr.gas > 0) pi = setSheetCellValue(pi, "J29", rr.gas);
    if (rr.carbon > 0) {
      // Carbon Emissions Method (I19) → "Enter Flat Rate" so the workbook uses the
      // flat electricity carbon factor we supply (resolved from the ZIP/eGRID
      // subregion) rather than a virtual rate that can't be derived.
      pi = setSheetCellValue(pi, "I19", "Enter Flat Rate");
      pi = setSheetCellValue(pi, "I22", rr.carbon);   // kg CO2e / kWh
    }
    // Site-to-Source ratios (Project Info row 16: I=Electricity, J=Gas, K=Additional
    // Fuel, L=District Cooling, M=District Heating). ENERGY STAR source-to-site
    // ratios are national (one U.S. set, one Canadian); resolve the set from the
    // project pincode/state — falling back to the state parsed from the model's
    // weather file (e.g. "… CA USA …") so the Source Energy charts aren't left
    // empty when no address was entered.
    const stForSts = cfg.state || stateFromWeather(sample?.weather_file);
    const sts = siteToSourceFor(cfg.pincode, stForSts);
    if (sts) {
      pi = setSheetCellValue(pi, "I16", sts.elec);
      pi = setSheetCellValue(pi, "J16", sts.gas);
      pi = sts.addFuel != null ? setSheetCellValue(pi, "K16", sts.addFuel) : clearSheetCell(pi, "K16");
      pi = setSheetCellValue(pi, "L16", sts.dc);
      pi = setSheetCellValue(pi, "M16", sts.dh);
      pi = setSheetCellValue(pi, "N16", sts.source);
    } else {
      for (const a of ["I16", "J16", "K16", "L16", "M16", "N16"]) pi = clearSheetCell(pi, a);
    }
    // When a fuel/utility isn't used by the project, blank its factor columns across
    // Site-to-Source (row 16), Carbon kg CO2e (row 22) and Unit Cost (row 29) so they
    // render "-" instead of the template's leftover values (K=Add. Fuel, L=District
    // Cooling, M=District Heating).
    if (!hasAddFuel) for (const a of ["K16", "K22", "K29"]) pi = clearSheetCell(pi, a);
    if (!hasDistCool) for (const a of ["L16", "L22", "L29"]) pi = clearSheetCell(pi, a);
    if (!hasDistHeat) for (const a of ["M16", "M22", "M29"]) pi = clearSheetCell(pi, a);
    zip.file(paths[piName], pi);
  }

  // Input Summary — the "Building Parameters" area cells (F4 Conditioned · F5 Total)
  // are driven by fragile INDEX/MATCH formulas that key on the "(ft²)" unit string;
  // they collide and BOTH return blank on recalc. Write the areas directly (they're
  // already correct on the Proposed Data tab) so the summary isn't empty.
  const isName = Object.keys(paths).find((n) => /input\s*summary/i.test(n));
  if (isName) {
    const sample = propRows[0] || blRows[0];
    const cond = (meta.projectInfo?.floorArea) ?? sample?.conditioned_floor_area;
    const total = sample?.total_floor_area ?? cond;
    let is = await zip.file(paths[isName])!.async("string");
    let touched = false;
    if (typeof cond === "number" && cond > 0) { is = setSheetCellValue(is, "F4", cond); touched = true; }
    if (typeof total === "number" && total > 0) { is = setSheetCellValue(is, "F5", total); touched = true; }
    if (touched) zip.file(paths[isName], is);
  }

  // Force Excel to recompute every formula (and thus refresh the SiteE/SourceE/
  // Carbon/Cost charts and Report/Input-Summary tables) the moment it opens, and
  // open the workbook on the Project Info sheet (sheet index 1, after Home).
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    let wbXml = await wbFile.async("string");
    wbXml = /<calcPr[^>]*\/>/.test(wbXml)
      ? wbXml.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="191028" fullCalcOnLoad="1"/>')
      : wbXml.replace("</workbook>", '<calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>');
    const piIndex = Object.keys(paths).findIndex((n) => /project\s*info/i.test(n));
    if (piIndex >= 0) {
      wbXml = wbXml.replace(/(<workbookView\b[^>]*?)\s*\/>/, (_m, head) => {
        let h = String(head).replace(/\sfirstSheet="[^"]*"/, "").replace(/\sactiveTab="[^"]*"/, "");
        return `${h} firstSheet="0" activeTab="${piIndex}"/>`;
      });
    }
    zip.file("xl/workbook.xml", wbXml);
  }

  // Open every sheet scrolled to its top-left corner: strip any saved scroll
  // position (topLeftCell) and, for un-frozen sheets, reset the active cell to A1.
  // Make Project Info the only tab-selected sheet so it matches activeTab above.
  const piPath = piName ? paths[piName] : "";
  for (const f of zip.file(/^xl\/worksheets\/sheet\d+\.xml$/) as JSZip.JSZipObject[]) {
    let sx = await f.async("string");
    sx = resetSheetView(sx, f.name === piPath);
    zip.file(f.name, sx);
  }

  // Hide legend entries for end uses with no energy, so each Site/Source/Carbon/
  // Cost chart's legend shows only the colours that actually appear.
  await pruneChartLegends(zip, presentEndUses(allRows));

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}

/** Generic builder for the customizable-tables view: arbitrary columns + AOA. */
export function buildCustomSheet(headers: string[], aoaBody: any[][], sheetName = "Custom") {
  const wb = XLSX.utils.book_new();
  const aoa = [headers, ...aoaBody];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const hStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
    fill: { patternType: "solid", fgColor: { rgb: "E4002B" } },
    alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  const widths: any[] = [];
  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = hStyle;
    let maxLen = String(headers[c]).length;
    for (let r = 1; r < aoa.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      cell.s = {
        alignment: { horizontal: typeof cell.v === "number" ? "right" : "left", vertical: "center" },
        border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
      };
      const sv = cell.v == null ? "" : String(cell.v);
      if (sv.length > maxLen) maxLen = sv.length;
    }
    widths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 40) });
  }
  ws["!cols"] = widths;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

export function downloadWorkbook(wbOrBlob: any, filename: string) {
  if (typeof Blob !== "undefined" && wbOrBlob instanceof Blob) {
    const url = URL.createObjectURL(wbOrBlob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  XLSX.writeFile(wbOrBlob, filename, { bookType: "xlsx", cellStyles: true });
}

/** Build a workbook with several styled sheets (used by the TRACE export). */
export function buildMultiSheet(sheets: { name: string; headers: string[]; rows: any[][] }[]) {
  const wb = XLSX.utils.book_new();
  const hStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
    fill: { patternType: "solid", fgColor: { rgb: "E4002B" } },
    alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  for (const s of sheets) {
    const aoa = [s.headers, ...s.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const widths: any[] = [];
    for (let c = 0; c < s.headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = hStyle;
      let maxLen = String(s.headers[c]).length;
      for (let r = 1; r < aoa.length; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        cell.s = {
          alignment: { horizontal: typeof cell.v === "number" ? "right" : "left", vertical: "center" },
          border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
        };
        const sv = cell.v == null ? "" : String(cell.v);
        if (sv.length > maxLen) maxLen = sv.length;
      }
      widths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 44) });
    }
    ws["!cols"] = widths;
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return wb;
}
