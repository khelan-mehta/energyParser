/* ============================================================
 *  Central app state — tiny pub/sub store, no framework.
 * ============================================================ */
import type { Row } from "./engine/sim";
import { RateConfig, defaultRateConfig } from "./engine/rates";
import type { TraceReport } from "./engine/trace";
import type { Project } from "./api";

export interface FileSet { blSim: File[]; blInp: File[]; propSim: File[]; propInp: File[]; }

/** Human-in-the-loop "Project Info" inputs collected after parsing. Most are
 *  auto-populated from the parsed model / project; the rest are optional blanks.
 *  These are written straight into the workbook's Project Info sheet on export. */
export interface ProjectInfo {
  projectName?: string;
  climateZone?: string;
  programType?: string;
  floorArea?: number;            // ft²
  benchmarkEui?: number;         // AIA 2030 BmEUI (kBtu/ft²)
  targetSavings?: number;        // AIA 2030 target savings, fraction (0.9 = 90%)
  leedVersion?: string;
  leedType?: string;
  leedSubcategory?: string;
  energyCodeStandard?: string;
  energyCodeProcessLoads?: string; // "Yes" | "No"
  // Performance Goals table (LEED / Code columns), each a fraction (0.9 = 90%)
  energyGoalLeed?: number;
  energyGoalCode?: number;
  carbonGoalLeed?: number;
  carbonGoalCode?: number;
  costGoalLeed?: number;
  costGoalCode?: number;
  author?: string;
  date?: string;
  uncertaintyFactor?: number;    // fraction (0.05 = 5%)

  // ---- Word-report fields (Parser Test.docx comment IDs). Collected in the
  //      guided wizard's "details" step and consumed by buildWordReport. All
  //      optional; derived ones are pre-filled but remain user-editable. ----
  clientName?: string;            // #5  footer "Client | Project"
  pincode?: string;               // #11/#25/#30/#31 drives location/CZ/code/ASHRAE
  projectLocation?: string;       // #11/#30 "City, State" (derived from pincode)
  leedRegistrationDate?: string;  // #18 controls which LEED tables appear
  ashraeVersion?: string;         // #24/#25 derived from LEED version + reg date / energy code
  referenceDocument?: string;     // #23 reference document name
  documentPhase?: string;         // #23 e.g. "Schematic Design"
  adjacentShading?: boolean;      // #26 add overshadowing buildings/trees sentence
  costDataSource?: string;        // #36 "Default software rates" | "Manually input by modeler" | "Client-provided" | "EIA reference"
  costDataSourceNote?: string;    // #36 free-text qualifier for the chosen source
  weatherFileType?: string;       // #32 e.g. "TMY3" (derived from parsed weather file)
  reportDate?: string;            // #2  report download date (defaults to today)
}

export interface AppState {
  files: FileSet;
  option: string;
  climateZone: string;
  outputName: string;
  autoPair: boolean;
  rates: RateConfig;
  blRows: Row[];
  propRows: Row[];
  log: string[];
  nrelKey: string;
  eiaKey: string;
  openaiKey: string;
  openaiModel: string;
  trace: TraceReport | null;
  currentProject: Project | null;
  projectInfo: ProjectInfo | null;
}

export const store: AppState = {
  files: { blSim: [], blInp: [], propSim: [], propInp: [] },
  option: "",
  climateZone: "",
  outputName: "energy_results.xlsx",
  autoPair: true,
  rates: defaultRateConfig(),
  blRows: [],
  propRows: [],
  log: [],
  // Hardcoded data-source keys (overridable via the settings popup).
  nrelKey: localStorage.getItem("ep_nrel_key") || "dYog29kfBgadw04fZZ9SfIZs76naSgMYubOwR9C6",
  eiaKey: localStorage.getItem("ep_eia_key") || "dcOTZpVO8P7hPsBKiv9PJvmqGw3gSjxuWa4jqrcV",
  openaiKey: localStorage.getItem("ep_openai_key") || "",
  openaiModel: localStorage.getItem("ep_openai_model") || "gpt-4o-mini",
  trace: null,
  currentProject: null,
  projectInfo: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach((fn) => fn()); }

export function allRows(): Row[] { return [...store.blRows, ...store.propRows]; }
export function logLine(s: string) { store.log.push(s); }
export function logClear() { store.log = []; }
