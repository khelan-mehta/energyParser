/* ============================================================
 *  MEPC FIELD INTELLIGENCE
 *  For any field — especially an incomplete one — produce human guidance
 *  on what it is and how to fill it, plus a best-guess suggested value.
 *  Sources, in priority: the calculator's own data-validation prompt →
 *  label/type heuristics. Suggestions come from the parsed-model context.
 * ============================================================ */
import type { MepcField } from "./mepc-schema";

export interface FieldGuidance { tip: string; unit?: string; suggestion?: string | number; suggestionLabel?: string; }

const has = (l: string, ...k: string[]) => k.some((x) => l.includes(x));

/** Heuristic explanation of a field from its label + type. */
function heuristicTip(f: MepcField): string {
  const l = (f.label || "").toLowerCase();
  if (has(l, "u-value", "u-factor", "u value")) return "Assembly U-factor (Btu/h·ft²·F) from the envelope inputs — lower = better insulated.";
  if (has(l, "r-value", "r value")) return "Assembly R-value (ft²·h·F/Btu) — the inverse of the U-factor.";
  if (has(l, "shgc")) return "Glazing Solar Heat Gain Coefficient (0–1).";
  if (has(l, "vlt")) return "Glazing Visible Light Transmittance (0–1).";
  if (has(l, "wwr", "window-wall", "window to wall")) return "Window-to-wall ratio (%) — glazing area ÷ gross wall area for this orientation.";
  if (has(l, "skylight")) return "Skylight-to-roof ratio (%).";
  if (has(l, "infiltration")) return "Design infiltration rate (CFM/ft² of façade, at the stated pressure).";
  if (has(l, "lighting power density", "lpd")) return "Lighting Power Density (W/ft²) from the lighting inputs.";
  if (has(l, "equipment power density", "plug", "epd")) return "Equipment / plug-load power density (W/ft²).";
  if (has(l, "occupant", "occupancy")) return "Occupant density (ft²/person).";
  if (has(l, "fan power")) return "Total fan power (kW) = sum of supply + exhaust fans.";
  if (has(l, "fan power per cfm")) return "Fan power intensity (W/CFM).";
  if (has(l, "pump")) return "Total pump power (kW).";
  if (has(l, "ventilation", "airflow", "air flow") || (has(l, "cfm") && !has(l, "ft²"))) return "Airflow rate (CFM) from the model.";
  if (has(l, "chiller")) return "Chiller efficiency (COP) from the equipment schedule.";
  if (has(l, "boiler")) return "Boiler efficiency / thermal efficiency.";
  if (has(l, "cop", "hspf", "efficiency")) return "Equipment efficiency (COP / HSPF) from the mechanical schedule.";
  if (has(l, "climate zone")) return "ASHRAE climate zone (e.g. 3B) from the weather file.";
  if (has(l, "weather", "climate file")) return "Weather / climate file name used in the model.";
  if (has(l, "energy code", "energy standard")) return "Energy code used (e.g. ASHRAE 90.1-2010 Appendix G).";
  if (has(l, "energy modeler")) return "Name of the person who built the energy model.";
  if (has(l, "energy model based on")) return "Design phase the model represents (e.g. 100% Construction Documents).";
  if (has(l, "simulation program")) return "Energy-simulation software (eQuest, Trace, EnergyPlus…).";
  if (has(l, "project name")) return "LEED project name.";
  if (has(l, "project id")) return "LEED Online project ID (optional).";
  if (has(l, "conditioned", "floor area", "building area")) return "Floor area in ft² (matches the energy model).";
  if (has(l, "wall area", "roof area", "gross")) return "Surface area in ft² from the model geometry.";
  if (has(l, "consumption", "kwh", "therm", "energy use", "mbtu")) return "Annual energy consumption for this source / end use.";
  if (has(l, "demand")) return "Peak demand (kW) for this source.";
  if (has(l, "rate", "cost", "$")) return "Utility rate / cost for this source.";
  if (has(l, "renewable")) return "On-site renewable energy production.";
  if (f.type === "dropdown") return "Choose the option that matches the project.";
  if (f.type === "checkbox") return "Select Yes or No for the project.";
  if (f.type === "percent") return "Enter a percentage.";
  if (f.type === "number") return "Enter a numeric value from the model.";
  return "Enter the value for this field.";
}

/** Pull a unit hint out of the label, e.g. "(Btu/h·ft²·F)" or "(W/ft²)". */
function unitOf(label: string): string | undefined {
  const m = (label || "").match(/\(([^)]*(?:ft|kw|kwh|therm|cfm|cop|%|btu|\$|w\/|kbtu|mbtu)[^)]*)\)/i);
  return m ? m[1] : undefined;
}

export interface GuidanceCtx {
  climateZone?: string; conditionedArea?: number; weatherFile?: string;
  energyCode?: string; simulationProgram?: string; modeler?: string; projectName?: string;
}

/** Full guidance for a field: tip + (when derivable) a suggested value. */
export function fieldGuidance(f: MepcField, ctx: GuidanceCtx = {}): FieldGuidance {
  const tip = f.help || heuristicTip(f);
  const unit = unitOf(f.label);
  const l = (f.label || "").toLowerCase();
  let suggestion: string | number | undefined; let suggestionLabel: string | undefined;

  // model-derived suggestions for the common General-Information fields
  if (has(l, "climate zone") && ctx.climateZone) { suggestion = ctx.climateZone; suggestionLabel = "from model"; }
  else if (has(l, "weather", "climate file") && ctx.weatherFile) { suggestion = ctx.weatherFile; suggestionLabel = "from model"; }
  else if (has(l, "conditioned", "floor area") && ctx.conditionedArea) { suggestion = ctx.conditionedArea; suggestionLabel = "from model"; }
  else if (has(l, "simulation program") && ctx.simulationProgram) { suggestion = ctx.simulationProgram; suggestionLabel = "detected"; }
  else if (has(l, "energy modeler") && ctx.modeler) { suggestion = ctx.modeler; suggestionLabel = "project"; }
  else if (has(l, "project name") && ctx.projectName) { suggestion = ctx.projectName; suggestionLabel = "project"; }
  else if (has(l, "energy code", "energy standard") && ctx.energyCode) { suggestion = "ASHRAE 90.1 2010 Appendix G"; suggestionLabel = "common"; }
  // dropdown with no model value → offer the first real option as a starting point
  else if ((f.type === "dropdown") && f.options && f.options.length) { suggestion = f.options[0]; suggestionLabel = "option"; }

  return { tip, unit, suggestion, suggestionLabel };
}
