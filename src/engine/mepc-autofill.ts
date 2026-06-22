/* ============================================================
 *  MEPC AUTO-FILL
 *  Maps everything we already know (the parsed model + the project's
 *  Project Setup info, and the user-supplied project stage) into the
 *  MepcSchema fields, tagging each with its source. Runs on the schema
 *  in memory — nothing is written to the .xlsm until "Populate".
 * ============================================================ */
import type { MepcSchema, MepcField } from "./mepc-schema";

export interface MepcAutofillContext {
  projectName?: string;
  climateZone?: string;          // e.g. "3B"
  conditionedArea?: number;      // ft²
  unconditionedArea?: number;
  weatherFile?: string;
  energyCode?: string;           // raw, e.g. "ASHRAE 2010/IECC 2012"
  ratingSystem?: string;         // explicit override
  leedVersion?: string;
  leedType?: string;             // "New Construction" | "Major Renovation" | "Core and Shell"
  leedSubcategory?: string;      // "School" | "Healthcare" | …
  simulationProgram?: string;    // "eQuest" | "Trace" | …
  modelType?: string;            // "equest" | "trace" | "iesve"
  modeler?: string;
  stage?: string;                // "Energy model based on" (asked before parsing)
  unit?: string;                 // "IP units" | "SI units"
  pctNew?: number;               // fraction (1 = 100%)
  multipleBuildings?: string;    // "Yes" | "No"
  dwellingUnits?: string;        // "Yes" | "No"
  numFloors?: number;
}

const norm = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Coerce a value to the closest allowed dropdown option (case/space-insensitive,
    then substring), so auto-filled selects always land on a valid choice. */
function coerceOption(value: string, options?: string[]): string | null {
  if (!options || !options.length) return value;
  const n = norm(value);
  let hit = options.find((o) => norm(o) === n);
  if (!hit) hit = options.find((o) => norm(o).includes(n) || n.includes(norm(o)));
  return hit || null;
}

function deriveRatingSystem(ctx: MepcAutofillContext, options?: string[]): string | null {
  if (ctx.ratingSystem) return coerceOption(ctx.ratingSystem, options);
  const sub = norm(ctx.leedSubcategory), type = norm(ctx.leedType);
  let target = "LEED v4 BD+C: New Construction";
  if (sub.includes("school")) target = "LEED v4 BD+C: Schools";
  else if (sub.includes("health")) target = "LEED v4 BD+C: Healthcare";
  else if (type.includes("core")) target = "LEED v4 BD+C: Core and Shell";
  return coerceOption(target, options);
}
function mapEnergyCode(raw?: string, options?: string[]): string | null {
  const r = norm(raw);
  let target = "ASHRAE 90.1 2010 Appendix G";
  if (/title.?24/.test(r)) target = "California Title-24 2013, Part 6";
  else if (r && !/90\.?1|ashrae|2010|iecc/.test(r)) target = "Other approved code";
  return coerceOption(target, options);
}
function mapSimProgram(ctx: MepcAutofillContext, options?: string[]): string | null {
  const v = ctx.simulationProgram || (ctx.modelType === "trace" ? "Trace" : ctx.modelType === "equest" ? "eQuest" : "");
  return v ? coerceOption(v, options) : null;
}

/** Find the General Information field whose label matches `pred`. */
function giField(schema: MepcSchema, pred: (label: string) => boolean): MepcField | undefined {
  const gi = schema.sheets.find((s) => s.name === "General Information");
  return gi?.fields.find((f) => pred(norm(f.label)));
}

/** Fill the schema in place. Returns how many fields were auto-filled. */
export function autofillSchema(schema: MepcSchema, ctx: MepcAutofillContext): number {
  let n = 0;
  const set = (f: MepcField | undefined, value: string | number | null, source: string) => {
    if (!f || value == null || value === "") return;
    f.value = value; f.filled = true; f.source = source; n++;
  };
  const setOpt = (f: MepcField | undefined, value: string | null, source: string) => {
    if (!f || !value) return; const v = coerceOption(value, f.options); if (v) set(f, v, source);
  };

  set(giField(schema, (l) => l.includes("leed project name")), ctx.projectName ?? null, "Project");
  setOpt(giField(schema, (l) => l === "rating system" || l.includes("rating system")), deriveRatingSystem(ctx, giField(schema, (l) => l.includes("rating system"))?.options), "Project Setup");
  setOpt(giField(schema, (l) => l.includes("unit of measurement")), ctx.unit || "IP units", "Default (IP)");
  set(giField(schema, (l) => l.includes("percent new construction")), ctx.pctNew ?? 1, "Default (100%)");
  setOpt(giField(schema, (l) => l.includes("multiple buildings")), ctx.multipleBuildings || "No", "Default (No)");
  set(giField(schema, (l) => l.includes("conditioned building area") && !l.includes("un")), ctx.conditionedArea ?? null, "Energy model");
  set(giField(schema, (l) => l.includes("unconditioned building area")), ctx.unconditionedArea ?? 0, "Default (0)");
  setOpt(giField(schema, (l) => l.includes("dwelling units")), ctx.dwellingUnits || null, "You");
  set(giField(schema, (l) => l === "energy modeler" || l.includes("energy modeler")), ctx.modeler ?? null, "Project Setup");
  setOpt(giField(schema, (l) => l.includes("energy model based on")), ctx.stage || null, "Project stage (you)");
  setOpt(giField(schema, (l) => l.includes("simulation program")), mapSimProgram(ctx, giField(schema, (l) => l.includes("simulation program"))?.options), "Energy model");
  setOpt(giField(schema, (l) => l.includes("energy code used")), mapEnergyCode(ctx.energyCode, giField(schema, (l) => l.includes("energy code used"))?.options), "Project Setup");
  set(giField(schema, (l) => l.includes("simulation weather file")), ctx.weatherFile ?? null, "Energy model");
  setOpt(giField(schema, (l) => l === "climate zone" || l.includes("climate zone")), ctx.climateZone || null, "Energy model");
  set(giField(schema, (l) => l.includes("number of floors")), ctx.numFloors ?? null, "Energy model");

  return n;
}

/* ============================================================
 *  MODELING-SHEET AUTO-FILL  (from the parsed eQUEST/DOE-2 result, R)
 *  Maps the real computed values — end-use energy (Results), envelope
 *  areas & U-factors (Shading/Opaque), lighting (BAM) — onto the actual
 *  input fields, skipping any cell that is a formula/locked (not a field).
 * ============================================================ */
const COLS = ["LIGHTS", "TASK", "MISC", "SP_HEAT", "SP_COOL", "HEAT_REJ", "PUMPS", "FANS", "REFRIG", "HP_SUP", "DHW", "EXT", "TOTAL"];
const KWH_COLS = ["L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X"];
const KW_COLS = ["Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ"];
const THERM_COLS = ["AX", "AY", "AZ", "BA", "BB", "BC", "BD", "BE", "BF", "BG", "BH", "BI", "BJ"];
const BASE_ROWS = [8, 9, 10, 11], PROP_ROW = 13;

/** Set a field by sheet+cell (only if that input field exists). */
function putField(schema: MepcSchema, sheet: string, cell: string, value: string | number | null, source: string): boolean {
  if (value == null || value === "") return false;
  const sh = schema.sheets.find((s) => s.name === sheet); if (!sh) return false;
  const f = sh.fields.find((x) => x.cell === cell); if (!f) return false;
  let v: string | number | null = value;
  if (f.type === "dropdown" || f.type === "checkbox") { v = coerceOption(String(value), f.options); if (v == null) return false; }
  f.value = v; f.filled = true; f.source = source; return true;
}

/** The per-case Results-from-eQuest cell/value pairs (mirrors the calculator's columns). */
function resultRow(c: any): [string, number][] {
  const d: [string, number][] = [];
  KWH_COLS.forEach((col, i) => d.push([col, Math.round(c.kwh?.[COLS[i]] || 0)]));
  if (c.kw && Object.keys(c.kw).length) KW_COLS.forEach((col, i) => d.push([col, Math.round((c.kw[COLS[i]] || 0) * 100) / 100]));
  THERM_COLS.forEach((col, i) => d.push([col, Math.round(c.therm?.[COLS[i]] || 0)]));
  if (c.mbtu != null) d.push(["BK", Math.round(c.mbtu * 100) / 100]);
  if (c.eui != null) d.push(["BL", Math.round(c.eui * 100) / 100]);
  if (c.elecCost != null) d.push(["BO", Math.round(c.elecCost)]);
  d.push(["BP", Math.round(c.gasCost || 0)]);
  if (c.pctOut !== "" && c.pctOut != null) d.push(["BS", c.pctOut]);
  if (c.pctPlant !== "" && c.pctPlant != null) d.push(["BT", c.pctPlant]);
  if (c.coolUnmet !== "" && c.coolUnmet != null) d.push(["BW", c.coolUnmet]);
  if (c.heatUnmet !== "" && c.heatUnmet != null) d.push(["BX", c.heatUnmet]);
  return d;
}

export function autofillModeling(schema: MepcSchema, R: any): number {
  if (!R) return 0;
  let n = 0; const put = (sheet: string, cell: string, v: any, src = "Energy model") => { if (putField(schema, sheet, cell, v, src)) n++; };

  // ---- Results from eQuest: baseline rotations (rows 8–11) + proposed (row 13)
  const RS = "Results from eQuest";
  if (R.baseRowsData) BASE_ROWS.forEach((row, k) => { const c = R.baseRowsData[k]; if (c) resultRow(c).forEach(([col, val]) => put(RS, col + row, val)); });
  if (R.propData) resultRow(R.propData).forEach(([col, val]) => put(RS, col + PROP_ROW, val));

  // ---- Shading and Fenestration: wall/glazing areas by orientation + roof + glazing props
  const SF = "Shading and Fenestration";
  if (R.env && typeof R.env.orient === "function") {
    const ORROW: Record<string, number> = { NORTH: 21, EAST: 22, SOUTH: 23, WEST: 24 };
    for (const az of Object.keys(ORROW)) { const r = ORROW[az], o = R.env.orient(az); put(SF, "F" + r, o.wall); put(SF, "G" + r, o.glaze); put(SF, "J" + r, o.glaze); }
    put(SF, "F28", R.env.roofArea);
    const gU = (R.qp && R.qp.glassU) || R.env.glassU, gSHGC = (R.qp && R.qp.glassSHGC) || R.env.glassSHGC, gVLT = (R.qp && R.qp.glassVLT) || R.env.glassVLT;
    if (gU != null) { put(SF, "J46", gU); if (gSHGC != null) put(SF, "K46", gSHGC); if (gVLT != null) put(SF, "L46", gVLT); }
    ["L7", "L8", "L9", "L11"].forEach((c) => put(SF, c, "Yes", "Default (Appendix G)"));
    put(SF, "L10", "N/A", "Default");
  }

  // ---- Opaque Assemblies: roof & wall U-factors + reflectance + attestations
  const OA = "Opaque Assemblies";
  if (R.env) {
    if (R.env.roofU != null) { put(OA, "I34", R.env.roofU); put(OA, "C34", "New", "Default"); put(OA, "D34", "Nonresidential", "Default"); }
    if (R.env.wallU != null) { put(OA, "I44", R.env.wallU); put(OA, "C44", "New", "Default"); put(OA, "D44", "Nonresidential", "Default"); }
    put(OA, "K34", 0.30, "Default"); put(OA, "L34", 0.40, "Default");
    ["G13", "G15", "K17", "K21", "K23"].forEach((c) => put(OA, c, "Yes", "Default (Appendix G)"));
    put(OA, "G11", "No", "Default");
  }

  // ---- Lighting: Building Area Method — total area + design LPD
  if (R.lArea) put("Lighting", "D33", Math.round(R.lArea));
  if (R.lLPD) put("Lighting", "H33", R.lLPD);

  return n;
}
