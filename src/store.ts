/* ============================================================
 *  Central app state — tiny pub/sub store, no framework.
 * ============================================================ */
import type { Row } from "./engine/sim";
import { RateConfig, defaultRateConfig } from "./engine/rates";
import type { TraceReport } from "./engine/trace";
import type { Project } from "./api";

export interface FileSet { blSim: File[]; blInp: File[]; propSim: File[]; propInp: File[]; }

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
  openaiKey: localStorage.getItem("ep_openai_key") || "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",
  openaiModel: localStorage.getItem("ep_openai_model") || "gpt-4o-mini",
  trace: null,
  currentProject: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach((fn) => fn()); }

export function allRows(): Row[] { return [...store.blRows, ...store.propRows]; }
export function logLine(s: string) { store.log.push(s); }
export function logClear() { store.log = []; }
