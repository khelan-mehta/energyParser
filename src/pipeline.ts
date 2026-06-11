/* ============================================================
 *  Pipeline — parse SIM (+ optional INP) files into rows.
 * ============================================================ */
import { SIMParser, Row } from "./engine/sim";
import { INPParser } from "./engine/inp";
import { buildWorkbook, downloadWorkbook } from "./engine/workbook";
import { store, logLine, logClear, emit } from "./store";

function readFileText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

async function processRun(simFile: File, inpFile: File | null, label: string, cz: string): Promise<Row> {
  logLine(`<span class="dim">  › SIM:</span> <span class="info">${simFile.name}</span> <span class="dim">(${(simFile.size / 1024).toFixed(0)} KB)</span>`);
  const simText = await readFileText(simFile);
  const r = new SIMParser(simText, simFile.name).parse();
  r.option_name = label || simFile.name.replace(/\.[Ss][Ii][Mm]$/, "");
  r.results_path = simFile.name;
  r.climate_zone = cz || "";
  if (inpFile) {
    logLine(`<span class="dim">  › INP:</span> <span class="info">${inpFile.name}</span> <span class="dim">(${(inpFile.size / 1024).toFixed(0)} KB)</span>`);
    try {
      const inpText = await readFileText(inpFile);
      Object.assign(r, new INPParser(inpText, inpFile.name).parse());
      r.inp_file = inpFile.name;
    } catch (e: any) { logLine(`<span class="warn">  ⚠ inp parse failed: ${e.message}</span>`); }
  }
  return r;
}

export async function runParse(): Promise<boolean> {
  const f = store.files;
  if (!f.blSim.length && !f.propSim.length) return false;
  logClear();
  const cz = store.climateZone;
  const option = store.option;
  const autoPair = store.autoPair;
  const pair = (sims: File[], inps: File[]) => sims.map((s, i) => autoPair && inps[i] ? [s, inps[i]] : [s, null]) as [File, File | null][];

  store.blRows = [];
  if (f.blSim.length) {
    logLine(`<span class="ok">▲ Baseline runs (${f.blSim.length})</span>`);
    for (const [i, [s, inp]] of pair(f.blSim, f.blInp).entries())
      store.blRows.push(await processRun(s, inp, f.blSim.length > 1 ? `${option} BL ${i + 1}` : option, cz));
  }
  store.propRows = [];
  if (f.propSim.length) {
    logLine(`<span class="ok">▲ Proposed runs (${f.propSim.length})</span>`);
    for (const [i, [s, inp]] of pair(f.propSim, f.propInp).entries())
      store.propRows.push(await processRun(s, inp, f.propSim.length > 1 ? `${option} Prop ${i + 1}` : option, cz));
  }
  logLine(`<span class="ok">✓ Parsed ${store.blRows.length + store.propRows.length} model(s)</span>`);
  emit();
  return true;
}

export async function generateExcel() {
  const out = store.outputName || "energy_results.xlsx";
  const wb = await buildWorkbook(store.blRows, store.propRows, store.rates);
  downloadWorkbook(wb, out);
  logLine(`<span class="ok">✓ Saved → ${out}</span>`);
}
