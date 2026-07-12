/* ============================================================
 *  Marcus — unified model-parser hub.
 *  Projects → model selection (eQUEST / TRACE / IES-VE) → parse →
 *  logs → Project Analysis → utility rates → AI search.
 * ============================================================ */
import { store, emit, logClear, logLine } from "../store";
import type { ProjectInfo } from "../store";
import { Projects, Rates, Project, RateSet, authUser } from "../api";
import { h, esc, toast, fmt, fmtCompact } from "../ui/util";
import { ICON } from "../ui/icons";
import { SIMParser, Row } from "../engine/sim";
import { INPParser } from "../engine/inp";
import { loadTracePages } from "../engine/trace-load";
import { parseTrace, traceModels } from "../engine/trace";
import type { TraceReport } from "../engine/trace";
import { geocodeAddress, subregionFor, espmElecCarbonPerKwh, ESPM_GAS_KG_PER_THERM, ESPM_SOURCE } from "../engine/rates";
import { gatherElectricity, gatherGas, gatherCarbon, pickMax, GatherOpts, openaiChat } from "../engine/sources";
import { enrichRow } from "../engine/enrich";
import { buildWorkbook, downloadWorkbook } from "../engine/workbook";
import { calcBenchmarkEui, guessBuildingType, ZT_BUILDING_TYPES } from "../engine/zerotool";
import { COLUMNS } from "../engine/columns";
import { renderAnalysis } from "./analysis";
import { navigate } from "../ui/shell";
import { infoBoxes } from "../ui/infoboxes";

const MODELS: { key: Project["modelType"]; name: string; icon: string; sub: string; soon?: boolean }[] = [
  { key: "equest", name: "eQUEST", icon: "🏢", sub: ".SIM / .inp (DOE-2.2)" },
  { key: "trace", name: "TRACE 3D Plus", icon: "📑", sub: "report PDF" },
  { key: "iesve", name: "IES-VE", icon: "🧪", sub: "under development", soon: true },
];

/** When true, Marcus is hosted inside the guided wizard: it drops its own
    page-head / "← Projects" back button (the wizard supplies that chrome) but
    keeps every tool (parse, setup, logs, analysis, rates, AI search, export). */
let EMBED = false;
// In the wizard, the "Document & cost details" card is injected right after the
// files/parse card. Provided by the host so Marcus stays self-contained.
let EMBED_EXTRA: (() => HTMLElement) | null = null;
export async function renderMarcus(root: HTMLElement, opts: { embedded?: boolean; extraCard?: () => HTMLElement } = {}) {
  EMBED = !!opts.embedded;
  EMBED_EXTRA = opts.extraCard || null;
  if (!store.currentProject) return renderPicker(root);
  renderWorkspace(root, store.currentProject);
}

// Models parsed but not yet committed — drives the INLINE setup form (embed mode
// replaces the setup popup with an inline card that must be completed to continue).
let pendingSetup: { models: ParsedModel[]; modelRates: ModelRates | null } | null = null;

/* ============================================================ PICKER */
async function renderPicker(root: HTMLElement) {
  root.appendChild(h(`<div class="page-head"><div><h1>Marcus</h1><p>Your energy-model projects. Create a new one or open an existing project to parse.</p></div></div>`));
  const grid = h(`<div class="proj-grid"></div>`);
  grid.appendChild(newTile());
  root.appendChild(grid);
  grid.querySelector("#new-proj")!.addEventListener("click", () => newProjectModal(root));
  try {
    const { projects } = await Projects.list();
    (projects as Project[]).sort((a, b) => b.updatedAt - a.updatedAt).forEach((p) => grid.appendChild(projTile(root, p)));
  } catch (e: any) { root.appendChild(h(`<div class="source-note" style="border-left-color:var(--red);margin-top:14px">${esc(e.message)}</div>`)); }
}
function newTile(): HTMLElement {
  return h(`<div class="proj-tile new" id="new-proj"><div><div style="font-size:30px">${ICON.plus()}</div><div style="font-weight:600;margin-top:8px">New Project</div></div></div>`);
}
function projTile(root: HTMLElement, p: Project): HTMLElement {
  const m = MODELS.find((x) => x.key === p.modelType)!;
  const tile = h(`
    <div class="proj-tile" data-id="${p.id}">
      <span class="pt-del" title="Delete">${ICON.close("x")}</span>
      <div class="pt-top"><span class="pt-badge pt-${p.modelType}">${esc(m.name)}</span>${p.hasParsed ? `<span class="pill pill-red" style="font-size:9px">parsed</span>` : ""}</div>
      <h4>${esc(p.name)}</h4>
      <div class="pt-meta">${esc(p.address || "no address")} · ${p.files.length} file(s)</div>
      ${p.summary ? `<div class="pt-meta" style="margin-top:8px;color:var(--g600)">EUI ${fmt(p.summary.eui, 1)} · ${fmtCompact(p.summary.totalEnergy)} kBtu</div>` : ""}
    </div>
  `);
  tile.addEventListener("click", () => openProject(root, p.id));
  tile.querySelector(".pt-del")!.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}"? This removes its files.`)) return;
    await Projects.remove(p.id); toast("Project deleted"); rerender(root);
  });
  return tile;
}
function newProjectModal(root: HTMLElement) {
  const overlay = h(`
    <div class="modal-overlay"><div class="modal"><div class="modal-hd"><h3>New Project</h3><span class="x">${ICON.close("x")}</span></div>
      <div class="modal-body">
        <div class="field" style="margin-bottom:12px"><label>Project name</label><input id="np-name" placeholder="e.g. KP Parker Hospital" /></div>
        <div class="field" style="margin-bottom:12px"><label>Project address</label><input id="np-addr" placeholder="City, State, Country, ZIP" /></div>
        <div class="field"><label>Model type</label></div>
        <div class="model-tiles" id="np-models" style="margin-top:8px"></div>
        <button class="btn btn-primary" id="np-create" style="width:100%;justify-content:center;margin-top:18px">Create project</button>
      </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  let sel: Project["modelType"] = "equest";
  const tiles = overlay.querySelector("#np-models")!;
  MODELS.forEach((m) => {
    const t = h(`<div class="model-tile ${m.key === sel ? "active" : ""} ${m.soon ? "soon" : ""}" data-k="${m.key}"><div class="mt-ico">${m.icon}</div><h4>${esc(m.name)}</h4><p>${esc(m.sub)}</p></div>`);
    if (!m.soon) t.addEventListener("click", () => { sel = m.key; tiles.querySelectorAll(".model-tile").forEach((x) => x.classList.remove("active")); t.classList.add("active"); });
    tiles.appendChild(t);
  });
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#np-create")!.addEventListener("click", async () => {
    const name = (overlay.querySelector("#np-name") as HTMLInputElement).value.trim() || "Untitled Project";
    const addr = (overlay.querySelector("#np-addr") as HTMLInputElement).value.trim();
    try { const { project } = await Projects.create(name, addr, sel); close(); openProjectObj(root, project); }
    catch (e: any) { toast("Create failed — " + e.message); }
  });
}
async function openProject(root: HTMLElement, id: string) {
  try { const { project } = await Projects.get(id); openProjectObj(root, project); }
  catch (e: any) { toast("Open failed — " + e.message); }
}
function openProjectObj(root: HTMLElement, project: Project) {
  store.currentProject = project;
  // restore parsed rows + rates if present
  if (project.parsed) { store.blRows = project.parsed.bl || []; store.propRows = project.parsed.prop || []; }
  else { store.blRows = []; store.propRows = []; }
  if (project.rates) store.rates = { ...store.rates, ...project.rates };
  store.projectInfo = (project as any).projectInfo || null;
  emit(); rerender(root);
}

/* ============================================================ WORKSPACE */
function renderWorkspace(root: HTMLElement, p: Project) {
  const m = MODELS.find((x) => x.key === p.modelType)!;
  root.appendChild(h(`
    <div class="page-head"${EMBED ? ' style="display:none"' : ""}>
      <div style="display:flex;align-items:center;gap:12px">
        ${EMBED ? "" : `<button class="btn btn-sm" id="mk-back">← Projects</button>`}
        <div><h1 style="font-size:23px">${esc(p.name)}</h1><p>${esc(p.address || "no address")} · <span class="pt-badge pt-${p.modelType}">${esc(m.name)}</span></p></div>
      </div>
      <div class="actions">
        <button class="btn" id="mk-edit">Edit</button>
        <button class="btn ${(p as any).setupDraft && store.blRows.length + store.propRows.length ? "" : "hide"}" id="mk-resume">${ICON.rates("x")} Resume setup</button>
        <button class="btn btn-primary ${store.blRows.length + store.propRows.length ? "" : "hide"}" id="mk-export">${ICON.download()} Export Excel</button>
      </div>
    </div>
  `));
  root.appendChild(infoBoxes(
    [
      "Pick the <b>model type</b> below (eQUEST / TRACE / IES-VE) to match your files.",
      "Upload the baseline &amp; proposed <b>.SIM / .inp</b> (or the TRACE report PDF) and hit <b>Parse</b>.",
      "Complete the <b>Project Setup</b> form — rates, model assignment &amp; Project Info (or <b>Save as draft</b>), then <b>Export Excel</b>.",
      "Use <b>AI Search</b> to pull any value out of the parsed model.",
    ],
    [
      "A normalized set of baseline &amp; proposed energy results.",
      "Dashboards (EUI, energy, carbon, cost) identical across model types.",
      "A downloadable Excel workbook with every metric.",
      "Rates and citations carried straight into cost &amp; carbon.",
    ],
  ));

  root.querySelector("#mk-back")?.addEventListener("click", () => { store.currentProject = null; rerender(root); });
  root.querySelector("#mk-edit")!.addEventListener("click", () => editProjectModal(root, p));
  root.querySelector("#mk-resume")?.addEventListener("click", () => {
    if (!store.blRows.length && !store.propRows.length) { toast("Parse a model first"); return; }
    runSetup(root, p, modelsFromStore(), null);
  });
  root.querySelector("#mk-export")?.addEventListener("click", async () => {
    try {
      const info = store.projectInfo || { projectName: p.name };
      const wb = await buildWorkbook(store.blRows, store.propRows, store.rates, { projectName: p.name, projectInfo: info });
      downloadWorkbook(wb, `${excelName(info.projectName || p.name)}.xlsx`);
      toast("✓ Excel downloaded");
    } catch (e: any) { toast("Export failed — " + e.message); }
  });

  // model selection (reparse with another model)
  const modelCard = h(`<div class="card"><div class="card-hd"><h3>Model Parser</h3><span class="sub">switch model type to re-parse</span></div><div class="model-tiles" id="mk-models"></div></div>`);
  const tiles = modelCard.querySelector("#mk-models")!;
  MODELS.forEach((mm) => {
    const t = h(`<div class="model-tile ${mm.key === p.modelType ? "active" : ""} ${mm.soon ? "soon" : ""}"><div class="mt-ico">${mm.icon}</div><h4>${esc(mm.name)}</h4><p>${esc(mm.sub)}</p></div>`);
    if (!mm.soon) t.addEventListener("click", async () => { p.modelType = mm.key; await Projects.update(p.id, { modelType: mm.key }); toast(`Model set to ${mm.name}`); rerender(root); });
    tiles.appendChild(t);
  });
  root.appendChild(modelCard);

  // files + parse
  root.appendChild(fileSection(root, p));

  if (EMBED) {
    // Section-3 layout: inline setup (no popup) → rates recap → AI (collapsed) →
    // logs (collapsed). Project Analysis is now its own wizard section (step 4).
    if (pendingSetup) root.appendChild(inlineSetupCard(root, p));
    root.appendChild(ratesAccordion(root, p));
    root.appendChild(aiAccordion());
    root.appendChild(logsAccordion());
  } else {
    root.appendChild(logsAccordion());
    root.appendChild(analysisAccordion(root));
    root.appendChild(ratesAccordion(root, p));
    root.appendChild(aiAccordion());
  }
}

/* Utility rates are considered set once electricity, gas & carbon all have values.
   In the wizard, parsing is gated on this (rates are chosen in step 2). */
function ratesReady(): boolean {
  const c = store.rates;
  return c.elec_per_kwh != null && c.gas_per_therm != null && c.elec_carbon_per_kwh != null;
}

/* ---------- files ---------- */
function fileSection(root: HTMLElement, p: Project): HTMLElement {
  const isPdf = p.modelType !== "equest";
  const gate = EMBED && !ratesReady();
  const card = h(`<div class="card" style="margin-top:16px"><div class="card-hd"><h3>Files</h3><span class="sub">${isPdf ? "TRACE report PDF" : "Baseline & Proposed .SIM / .inp"}</span><div class="right"><button class="btn btn-primary btn-sm" id="mk-parse" ${gate ? 'disabled title="Set utility rates in step 2 first"' : ""}>${ICON.bolt()} Parse</button></div></div></div>`);
  if (gate) card.appendChild(h(`<div class="source-note" style="border-left-color:var(--red);margin-top:10px">Select the <b>utility rates</b> in step 2 before parsing the model.</div>`));

  if (p.modelType === "iesve") { card.appendChild(h(`<div class="empty"><div class="big">🧪</div><div style="color:var(--g500)">IES-VE parser is under development.</div></div>`)); return card; }

  const zones = h(`<div class="drop-grid"></div>`);
  if (isPdf) zones.appendChild(uploadZone(root, p, "model", "Model PDF", ".pdf"));
  else { zones.appendChild(uploadZone(root, p, "baseline", "Baseline .SIM / .inp", ".sim,.inp")); zones.appendChild(uploadZone(root, p, "proposed", "Proposed .SIM / .inp", ".sim,.inp")); }
  card.appendChild(zones);

  // file list
  const list = h(`<div class="chips" style="margin-top:14px"></div>`);
  p.files.forEach((f) => {
    const chip = h(`<span class="chip"><b style="font-weight:600">${esc(f.role)}</b> ${esc(f.name)} <span class="x">×</span></span>`);
    chip.querySelector(".x")!.addEventListener("click", async () => { await Projects.deleteFile(p.id, f.id); const { project } = await Projects.get(p.id); store.currentProject = project; rerender(root); });
    list.appendChild(chip);
  });
  card.appendChild(list);

  const prog = h(`<div id="mk-prog" class="hide" style="margin-top:14px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--g500);margin-bottom:6px"><span id="mk-prog-l">Working…</span><span id="mk-prog-p">0%</span></div><div style="height:8px;background:var(--g150);border-radius:20px;overflow:hidden"><div id="mk-prog-b" style="height:100%;width:0;background:var(--red);transition:width .2s"></div></div></div>`);
  card.appendChild(prog);
  card.querySelector("#mk-parse")!.addEventListener("click", () => parseProject(root, p));
  return card;
}
function uploadZone(root: HTMLElement, p: Project, role: string, label: string, accept: string): HTMLElement {
  const g = h(`<div><div class="dz-label">${esc(label)}</div><label class="dropzone"><input type="file" multiple accept="${accept}" /><div class="dz-ico">📄</div><div class="dz-t">Drop or click to upload</div><div class="dz-h">${esc(accept)}</div></label></div>`);
  const input = g.querySelector("input") as HTMLInputElement;
  const dz = g.querySelector(".dropzone") as HTMLElement;
  const doUpload = async (files: FileList) => {
    if (!files.length) return;
    dz.classList.add("drag");
    try { const { project } = await Projects.upload(p.id, Array.from(files), role); store.currentProject = project; toast(`✓ Uploaded ${files.length} file(s)`); rerender(root); }
    catch (e: any) { toast("Upload failed — " + e.message); dz.classList.remove("drag"); }
  };
  input.addEventListener("change", (e) => { const t = e.target as HTMLInputElement; if (t.files?.length) doUpload(t.files); });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const dt = (e as DragEvent).dataTransfer; if (dt?.files.length) doUpload(dt.files); });
  return g;
}

/* ---------- parse ---------- */
type ParsedModel = { name: string; row: Row; cat?: "leed" | "code" | "proposed"; rot?: number };

async function parseProject(root: HTMLElement, p: Project) {
  if (EMBED && !ratesReady()) { toast("Select the utility rates in step 2 first"); return; }
  logClear();
  const prog = document.getElementById("mk-prog")!; const bar = document.getElementById("mk-prog-b") as HTMLElement;
  const pl = document.getElementById("mk-prog-l")!; const pp = document.getElementById("mk-prog-p")!;
  const setProg = (x: number, label: string) => { bar.style.width = x + "%"; pp.textContent = x + "%"; pl.textContent = label; };
  prog.classList.remove("hide");
  try {
    // ── Phase 1 — pre-read the model's own utility rates (if any), so the setup
    //    popup can offer them and never overwrite them with a fetch. ──
    let modelRates: ModelRates | null = null;
    let report: TraceReport | null = null;
    let models: ParsedModel[] = [];
    if (p.modelType === "equest") {
      setProg(40, "Reading model…");
      modelRates = await readEquestModelRates(p);
      setProg(60, "Parsing eQUEST models…");
      models = await parseEquestModels(p);
      setProg(100, "Parsed");
    } else if (p.modelType === "trace") {
      const pdf = p.files.find((f) => f.ext === ".pdf");
      if (!pdf) throw new Error("upload a TRACE PDF first");
      const buf = await Projects.fileBlob(p.id, pdf.id);
      const pages = await loadTracePages(buf, (d, t) => setProg(Math.round((d / t) * 100), `Reading page ${d}/${t}…`));
      report = parseTrace(pages, pdf.name); store.trace = report;
      // Section 1.5 (Table EAp2-3) supplies the model's utility rates — prefer proposed, else baseline
      const u = report.utilityRates;
      if (u) modelRates = { elec: u.elecProposed || u.elecBaseline, gas: u.gasProposed || u.gasBaseline, descr: u.description };
      // Section 1.6 supplies the baseline's 0/90/180/270 rotations — expand & pre-tag them
      models = traceModels(report).map((m) => ({ name: m.name, row: m.row, cat: m.cat, rot: m.rot }));
    } else throw new Error("IES-VE parser is under development");
    prog.classList.add("hide");
    if (!models.length) throw new Error("no models parsed — check the uploaded files");
    logLine(`<span class="ok">✓ Parsed ${models.length} model(s) — complete the setup below</span>`); paintLog();

    // ── Phase 2 — setup. Embed: inline card (no popup). Standalone: the popup. ──
    if (EMBED) { pendingSetup = { models, modelRates }; rerender(root); }
    else await runSetup(root, p, models, modelRates);
  } catch (e: any) {
    prog.classList.add("hide");
    logLine(`<span class="err">✗ ${esc(e.message)}</span>`);
    toast("Parse failed — " + e.message); paintLog();
  }
}

/** Lightweight pre-read: pull ONLY the UTILITY-RATE block from the project's
    .inp file(s) so we can offer "from the energy model" rates before parsing the
    full SIM results. Prefers the proposed model's rate, else the first found. */
async function readEquestModelRates(p: Project): Promise<ModelRates | null> {
  const inps = p.files.filter((f) => f.ext === ".inp");
  const ordered = [...inps.filter((f) => /proposed/i.test(f.name) || f.role === "proposed"), ...inps];
  for (const inp of ordered) {
    try {
      const r = new INPParser(await Projects.fileText(p.id, inp.id), inp.name).parse();
      if (r.inp_elec_rate_per_kwh != null && r.inp_elec_rate_per_kwh > 0) {
        return {
          elec: r.inp_elec_rate_per_kwh,
          gas: (r.inp_gas_rate_per_therm != null ? r.inp_gas_rate_per_therm : 0),
          descr: `model UTILITY-RATE${r.inp_rate_structure ? ` (${r.inp_rate_structure})` : ""}`,
        };
      }
    } catch { /* ignore unreadable .inp */ }
  }
  return null;
}

/** Parse every eQUEST .SIM (pairing a matching .inp) into a flat model list. */
async function parseEquestModels(p: Project): Promise<ParsedModel[]> {
  const sims = p.files.filter((f) => f.ext === ".sim");
  const inps = p.files.filter((f) => f.ext === ".inp");
  const base = (n: string) => n.replace(/\.[^.]+$/, "").toLowerCase();
  const models: ParsedModel[] = [];
  for (const sim of sims) {
    const text = await Projects.fileText(p.id, sim.id);
    const r = new SIMParser(text, sim.name).parse();
    r.option_name = sim.name.replace(/\.[Ss][Ii][Mm].*$/, "").trim() || sim.name;
    r.results_path = sim.name;
    logLine(`<span class="dim">› SIM:</span> <span class="info">${esc(sim.name)}</span>`);
    const inp = inps.find((i) => base(i.name) === base(sim.name)) || inps.find((i) => i.role === sim.role);
    if (inp) { try { Object.assign(r, new INPParser(await Projects.fileText(p.id, inp.id), inp.name).parse()); } catch { /* ignore */ } }
    models.push({ name: sim.name, row: r });
  }
  return models;
}

/** Best-effort category + rotation guess from a model/file name (user can override). */
function guessClass(name: string): { cat: "leed" | "code" | "proposed"; rot: number } {
  const n = name.toLowerCase();
  let cat: "leed" | "code" | "proposed" = "proposed";
  if (/proposed/.test(n)) cat = "proposed";
  else if (/leed/.test(n)) cat = "leed";
  else if (/code|compliance|appx|90\.1/.test(n)) cat = "code";
  else if (/baseline/.test(n)) cat = "leed";
  const m = n.match(/(?:^|[_\s\-(])(0|90|180|270)(?:[_\s\-)°]|deg|$)/);
  return { cat, rot: m ? +m[1] : 0 };
}

/* ---------- combined setup popup (rates + assignment + project info) ---------- */
type ModelRates = { elec: number; gas: number; descr: string };

const LEED_VERSIONS = ["None", "LEED v2009", "LEED v4", "LEED v4 Energy Update", "LEED v4.1", "LEED v5 (registered before 1/1/2028)", "LEED v5 (registered after 1/1/2028)"];
const LEED_TYPES = ["New Construction", "Major Renovation", "Core and Shell"];
const LEED_SUBCATS = ["All but Healthcare + Schools", "Healthcare", "School"];
const YES_NO = ["Yes", "No"];

/** Build a download-safe base filename: "<project>_Energy Results Comparision". */
function excelName(name: string): string {
  const clean = String(name || "Project").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean}_Energy Results Comparision`;
}

/** Reconstruct the parsed-model list from the rows already in the store (used to
    re-open the setup popup when resuming a draft, without re-parsing the files). */
function modelsFromStore(): ParsedModel[] {
  return [...store.blRows, ...store.propRows].map((r) => ({
    name: r.option_name || r.results_path || "Model",
    row: r, cat: r._cat as any, rot: r._rot as number,
  }));
}

/** Pull the utility rates that AREN'T in the energy model from all our sources
    (NREL / EIA / Cambium for $/kWh & $/therm, eGRID for the carbon factor), keyed
    by pincode. Returns the values; the caller fills only the non-model fields. */
async function fetchRatesForPincode(pincode: string): Promise<{ elec?: number; gas?: number; carbon?: number; state?: string }> {
  const c = store.rates;
  let state = c.state, lat = c.lat, lon = c.lon;
  try { const info = await geocodeAddress({ pincode }); if (info.state) { state = info.state; lat = info.lat; lon = info.lon; } } catch { /* offline — fall through */ }
  const o: GatherOpts = {
    state, lat, lon, nrelKey: store.nrelKey, eiaKey: store.eiaKey,
    openaiKey: store.openaiKey, openaiModel: store.openaiModel,
    locationText: c.location_name || state, touProfile: c.tou_profile,
  };
  const [e, g, cb] = await Promise.all([
    gatherElectricity(o).catch(() => ({ candidates: [], errors: [] })),
    gatherGas(o).catch(() => ({ candidates: [], errors: [] })),
    gatherCarbon(o).catch(() => ({ candidates: [], errors: [] })),
  ]);
  const me = pickMax(e.candidates), mg = pickMax(g.candidates), mc = pickMax(cb.candidates);
  let carbon = mc ? mc.value : undefined;
  if (carbon == null) { const sub = subregionFor(state || "", pincode); if (sub) carbon = espmElecCarbonPerKwh(sub); }
  return { elec: me?.value, gas: mg?.value, carbon, state };
}

/** Small sub-prompt for the Benchmark-EUI Calculate button: asks the AIA 2030
    target percentage and confirms the Zero Tool building type. Resolves the chosen
    values, or null if cancelled. */
function benchmarkCalcModal(defType: string, defTarget: number): Promise<{ buildingType: string; targetPercent: number } | null> {
  return new Promise((resolve) => {
    const opts = ZT_BUILDING_TYPES.map((b) => `<option value="${esc(b)}" ${b === defType ? "selected" : ""}>${esc(b)}</option>`).join("");
    const overlay = h(`
      <div class="modal-overlay"><div class="modal" style="max-width:440px"><div class="modal-hd"><h3>Calculate Benchmark EUI</h3><span class="x">${ICON.close("x")}</span></div>
        <div class="modal-body">
          <p style="font-size:12.5px;color:var(--g500);margin-bottom:14px">Uses the AIA 2030 / Zero Tool baseline calculator with this project's floor area &amp; location. Confirm the building type and enter your target reduction.</p>
          <div class="field" style="margin-bottom:12px"><label>Building type (Zero Tool)</label><select class="unit-pick" id="bc-type" style="width:100%">${opts}</select></div>
          <div class="field"><label>AIA 2030 Target Savings (% better than median)</label><input id="bc-target" type="number" step="0.1" min="0" max="100" value="${esc(String(defTarget))}" placeholder="90" /></div>
          <button class="btn btn-primary" id="bc-go" style="width:100%;justify-content:center;margin-top:18px">${ICON.bolt()} Calculate benchmark EUI</button>
        </div></div></div>`);
    document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
    let done = false;
    const close = (r: { buildingType: string; targetPercent: number } | null) => { if (done) return; done = true; overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); resolve(r); };
    overlay.querySelector(".x")!.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector("#bc-go")!.addEventListener("click", () => {
      const buildingType = (overlay.querySelector("#bc-type") as HTMLSelectElement).value;
      const tv = (overlay.querySelector("#bc-target") as HTMLInputElement).value.trim();
      close({ buildingType, targetPercent: tv === "" ? 90 : +tv });
    });
  });
}

export type SetupResult = { action: "finish" | "draft"; bl: Row[]; prop: Row[]; info: ProjectInfo } | null;

/** The single human-in-the-loop popup shown after parsing. It bundles everything
    that drives the workbook into one savable form:
      • Utility rates — a pincode + Fetch button that pulls any rate NOT supplied by
        the model from all sources; fetched values are editable and never replace
        the model's own rates.
      • Model assignment — category (LEED / Code / Proposed) + rotation per model.
      • Project Info — the full sheet incl. the Performance Goals table + QA/QC.
    Applies the rates to store.rates and resolves the rows + ProjectInfo with the
    chosen action ("finish" or "draft"), or null if the user closes it. */
/** Builds the shared setup form (rates + model assignment + project info) into a
    detached element. The Populate / Save-as-draft buttons call onSubmit with the
    gathered result; the caller wires any cancel → onSubmit(null). */
function buildSetupForm(p: Project, models: ParsedModel[], modelRates: ModelRates | null, onSubmit: (r: SetupResult) => void, hideRates = false): HTMLElement {
    const c = store.rates;
    const todayStr = new Date().toISOString().slice(0, 10);
    const prev = store.projectInfo || {};
    // a "from the model" rate must never be overwritten by a fetch
    const fromModel = !!modelRates || c.rate_structure === "from model";
    const elec0 = modelRates?.elec ?? c.elec_per_kwh;
    const gas0 = modelRates && modelRates.gas > 0 ? modelRates.gas : c.gas_per_therm;
    const carbon0 = c.elec_carbon_per_kwh;

    // ---- auto-populate Project Info from the proposed model (falls back to first)
    const sample = (models.find((m) => (m.cat ?? guessClass(m.name).cat) === "proposed")?.row) || models[0]?.row;
    const area = prev.floorArea ?? (sample?.conditioned_floor_area || sample?.total_floor_area);
    const d = {
      projectName: prev.projectName ?? p.name,
      climateZone: prev.climateZone ?? (sample?.climate_zone != null ? String(sample.climate_zone) : ""),
      programType: prev.programType ?? "",
      floorArea: typeof area === "number" && area > 0 ? area : undefined,
      benchmarkEui: prev.benchmarkEui,
      targetSavings: prev.targetSavings ?? 0.9,
      leedVersion: prev.leedVersion ?? "LEED v4",
      leedType: prev.leedType ?? "New Construction",
      leedSubcategory: prev.leedSubcategory ?? "School",
      energyCodeStandard: prev.energyCodeStandard ?? "ASHRAE 2010/IECC 2012",
      energyCodeProcessLoads: prev.energyCodeProcessLoads ?? "Yes",
      author: prev.author ?? "",
      date: prev.date ?? "",
      uncertaintyFactor: prev.uncertaintyFactor ?? 0,
    };
    const sel = (id: string, opts: string[], val: string) =>
      `<select class="unit-pick" id="${id}" style="width:100%">${opts.map((o) => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    const txt = (id: string, val: any, ph = "") => `<input id="${id}" value="${val == null ? "" : esc(String(val))}" placeholder="${esc(ph)}" />`;
    const numf = (id: string, val: any, step = "any", ph = "") => `<input id="${id}" type="number" step="${step}" value="${val == null ? "" : esc(String(val))}" placeholder="${esc(ph)}" />`;
    const pctf = (id: string, frac: any) => numf(id, frac != null ? +(frac * 100).toFixed(2) : "", "0.1", "%");

    // ---- model assignment rows
    const asgHtml = models.map((m, i) => {
      const g = guessClass(m.name);
      const cat = m.cat ?? g.cat;          // engine-supplied (e.g. TRACE §1.6 rotations) wins over the name guess
      const rot = m.rot ?? g.rot;
      const rotSel = `<select class="unit-pick cm-rot" data-i="${i}" ${cat === "proposed" ? "disabled" : ""}>${[0, 90, 180, 270].map((deg) => `<option value="${deg}" ${deg === rot ? "selected" : ""}>${deg}°</option>`).join("")}</select>`;
      return `<div style="display:grid;grid-template-columns:1fr 148px 84px;gap:10px;align-items:center;margin-bottom:9px">
        <div style="font-size:12.5px;font-weight:600;word-break:break-word">${esc(m.name)}</div>
        <select class="unit-pick cm-cat" data-i="${i}">
          <option value="leed" ${cat === "leed" ? "selected" : ""}>LEED Baseline</option>
          <option value="code" ${cat === "code" ? "selected" : ""}>Code Baseline</option>
          <option value="proposed" ${cat === "proposed" ? "selected" : ""}>Proposed</option>
        </select>${rotSel}</div>`;
    }).join("");

    const sec = (t: string) => `<div style="font-family:var(--font);font-weight:800;font-size:13px;margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--g150)">${t}</div>`;
    const modelNote = fromModel ? ` <span style="color:var(--g400);font-weight:400">(from model — kept)</span>` : "";

    const host = h(`
      <div>
          <p style="font-size:12.5px;color:var(--g500);margin-bottom:6px">Everything that drives the workbook in one place. Confirm or edit, then <b>Populate</b> — or <b>Save as draft</b> to finish later. Values are written straight into the <b>Project Info</b> sheet.</p>

          ${hideRates ? "" : `<div style="font-family:var(--font);font-weight:800;font-size:13px;margin:6px 0 8px">Utility rates</div>
          <div class="field" style="margin-bottom:10px"><label>Pincode / ZIP</label>
            <div style="display:flex;gap:8px">
              <input id="setup-zip" placeholder="e.g. 92054" value="${esc(c.pincode || "")}" style="flex:1" />
              <button class="btn btn-sm" id="setup-fetch" type="button">${ICON.rates("x")} Fetch</button>
            </div>
            <div style="font-size:11px;color:var(--g400);margin-top:4px">Fetch pulls any rate not in the model from NREL / EIA / Cambium + eGRID. Fetched values are editable; model rates are kept.</div>
          </div>
          <div class="grid cards-3" style="gap:10px">
            <div class="field"><label>Electricity ($/kWh)${modelNote}</label>${numf("setup-elec", elec0, "0.001", "0.137")}</div>
            <div class="field"><label>Natural Gas ($/therm)${modelNote}</label>${numf("setup-gas", gas0, "0.001", "0.49")}</div>
            <div class="field"><label>Carbon (kg CO2e/kWh)</label>${numf("setup-carbon", carbon0, "0.001", "0.45")}</div>
          </div>
          <div id="setup-rate-status" style="font-size:12px;color:var(--g500);margin-top:6px"></div>`}

          ${sec("Model assignment")}
          <p style="font-size:11.5px;color:var(--g500);margin:-4px 0 10px"><b>LEED</b> rotations fill BL Data rows 1–4 (0/90/180/270°), <b>Code</b> the next 4; <b>Proposed</b> cases go to Proposed Data (rotations averaged).</p>
          <div style="display:grid;grid-template-columns:1fr 148px 84px;gap:10px;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--g400);margin-bottom:8px"><div>Model</div><div>Category</div><div>Rotation</div></div>
          ${asgHtml}

          ${sec("Project information")}
          <div class="grid cards-2" style="gap:10px">
            <div class="field"><label>Gross Conditioned Floor Area (ft²)</label>${numf("pi-area", d.floorArea, "1", "13652")}</div>
          </div>

          ${sec("AIA information")}
          <div class="grid cards-2" style="gap:10px">
            <div class="field"><label>AIA 2030 Benchmark EUI (kBtu/ft²)</label>
              <div style="display:flex;gap:8px">
                <input id="pi-bmeui" type="number" step="0.1" value="${d.benchmarkEui == null ? "" : esc(String(d.benchmarkEui))}" placeholder="from Zero Tool" style="flex:1" />
                <button class="btn btn-sm" id="pi-bmeui-calc" type="button">${ICON.bolt()} Calculate</button>
              </div>
              <div id="pi-bmeui-status" style="font-size:11px;color:var(--g400);margin-top:4px">AIA 2030 / Zero Tool benchmark from building type + location.</div>
            </div>
            <div class="field"><label>AIA 2030 Target Savings (%)</label>${pctf("pi-target", d.targetSavings)}</div>
            <div class="field"><label>LEED Version</label>${sel("pi-leedver", LEED_VERSIONS, d.leedVersion)}</div>
            <div class="field"><label>LEED Type</label>${sel("pi-leedtype", LEED_TYPES, d.leedType)}</div>
            <div class="field"><label>LEED Subcategory</label>${sel("pi-leedsub", LEED_SUBCATS, d.leedSubcategory)}</div>
            <div class="field"><label>Energy Code Standard</label>${txt("pi-code", d.energyCodeStandard)}</div>
          </div>

          ${sec("Performance goals")}
          <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:10px;align-items:center;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--g400);margin-bottom:6px"><div></div><div>LEED</div><div>Code</div></div>
          <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:10px;align-items:center;margin-bottom:8px"><div style="font-size:12.5px;font-weight:600">Energy Savings Goal (%)</div>${pctf("pi-egl", prev.energyGoalLeed)}${pctf("pi-egc", prev.energyGoalCode)}</div>
          <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:10px;align-items:center;margin-bottom:8px"><div style="font-size:12.5px;font-weight:600">Carbon Savings Goal (%)</div>${pctf("pi-cgl", prev.carbonGoalLeed)}${pctf("pi-cgc", prev.carbonGoalCode)}</div>
          <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:10px;align-items:center;margin-bottom:8px"><div style="font-size:12.5px;font-weight:600">Energy Cost Savings Goal (%)</div>${pctf("pi-ecl", prev.costGoalLeed)}${pctf("pi-ecc", prev.costGoalCode)}</div>

          ${sec("QA/QC")}
          <div class="grid cards-3" style="gap:10px">
            <div class="field"><label>Author</label><input id="pi-author" value="${esc(d.author || authUser?.name || "")}" placeholder="${esc(authUser?.name || "your name")}" /></div>
            <div class="field"><label>Date</label><input id="pi-date" value="${esc(d.date || todayStr)}" placeholder="${esc(todayStr)}" /></div>
            <div class="field"><label>Uncertainty Factor (%)</label>${pctf("pi-unc", d.uncertaintyFactor)}</div>
          </div>
          <div class="grid cards-2" style="gap:10px;margin-top:10px">
            <div class="field"><label>Energy Code Includes Process Loads?</label>${sel("pi-procload", YES_NO, d.energyCodeProcessLoads)}</div>
            <div class="field"><label>Model type <span style="color:var(--g400)">(extracted)</span></label><input value="${esc(String(p.modelType))}" disabled style="background:var(--g50)" /></div>
          </div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:13px;cursor:pointer"><input type="checkbox" id="pi-shading" ${prev.adjacentShading ? "checked" : ""} /> Model includes adjacent shading structures (neighboring buildings &amp; trees)</label>

          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn" id="setup-draft" style="flex:1;justify-content:center">Save as draft</button>
            <button class="btn btn-primary" id="setup-go" style="flex:2;justify-content:center">${ICON.bolt()} Populate</button>
          </div>
      </div>`);
    host.querySelectorAll<HTMLSelectElement>(".cm-cat").forEach((s) => s.addEventListener("change", () => {
      (host.querySelector(`.cm-rot[data-i="${s.dataset.i}"]`) as HTMLSelectElement).disabled = s.value === "proposed";
    }));

    // ---- Fetch rates (never overwrites the model's own electricity/gas)
    const rstatus = host.querySelector("#setup-rate-status") as HTMLElement;
    host.querySelector("#setup-fetch")?.addEventListener("click", async () => {
      const btn = host.querySelector("#setup-fetch") as HTMLButtonElement;
      const zip = (host.querySelector("#setup-zip") as HTMLInputElement).value.trim();
      if (!zip) { rstatus.innerHTML = `<span style="color:var(--red)">enter a pincode / ZIP first</span>`; return; }
      btn.disabled = true; rstatus.innerHTML = `<span class="spinner" style="width:12px;height:12px;vertical-align:middle"></span> Fetching rates from all sources…`;
      try {
        const got = await fetchRatesForPincode(zip);
        store.rates.pincode = zip;
        if (got.state) { store.rates.state = got.state; }
        const elecEl = host.querySelector("#setup-elec") as HTMLInputElement;
        const gasEl = host.querySelector("#setup-gas") as HTMLInputElement;
        const carbonEl = host.querySelector("#setup-carbon") as HTMLInputElement;
        const filled: string[] = [];
        if (!fromModel && got.elec != null) { elecEl.value = String(+got.elec.toFixed(4)); filled.push("electricity"); }
        if (!fromModel && got.gas != null) { gasEl.value = String(+got.gas.toFixed(4)); filled.push("gas"); }
        if (got.carbon != null) { carbonEl.value = String(+got.carbon.toFixed(4)); filled.push("carbon"); }
        rstatus.innerHTML = filled.length
          ? `<span style="color:var(--green,#16a34a)">✓ Fetched ${filled.join(", ")} — editable${fromModel ? "; model electricity/gas kept" : ""}</span>`
          : `<span style="color:var(--g500)">No rates found for ${esc(zip)}${fromModel ? " (model rates kept)" : ""}</span>`;
      } catch (e: any) { rstatus.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
      btn.disabled = false;
    });

    // ---- Calculate Benchmark EUI via Zero Tool (asks the target %, then fills the field)
    const bstatus = host.querySelector("#pi-bmeui-status") as HTMLElement;
    host.querySelector("#pi-bmeui-calc")!.addEventListener("click", async () => {
      const gv = (id: string) => (host.querySelector(id) as HTMLInputElement)?.value.trim();
      const curTarget = (() => { const v = gv("#pi-target"); return v ? +v : (d.targetSavings != null ? +(d.targetSavings * 100).toFixed(2) : 90); })();
      const guess = guessBuildingType(gv("#pi-prog"), gv("#pi-leedsub"));
      const ask = await benchmarkCalcModal(guess, curTarget);
      if (!ask) return;
      const calcBtn = host.querySelector("#pi-bmeui-calc") as HTMLButtonElement;
      calcBtn.disabled = true;
      bstatus.innerHTML = `<span class="spinner" style="width:11px;height:11px;vertical-align:middle"></span> Calculating from Zero Tool…`;
      try {
        const gfa = +(gv("#pi-area") || 0);
        const postalCode = gv("#setup-zip") || store.rates.pincode || "";
        // need the state for the Zero Tool lookup — derive from the pincode if unknown
        let state = store.rates.state || "";
        if (!state && postalCode) { try { const info = await geocodeAddress({ pincode: postalCode }); if (info.state) { state = info.state; store.rates.state = state; } } catch { /* offline */ } }
        const r = await calcBenchmarkEui({ buildingType: ask.buildingType, gfa, postalCode, state, targetPercent: ask.targetPercent });
        (host.querySelector("#pi-bmeui") as HTMLInputElement).value = String(r.benchmarkEui);
        // mirror the entered AIA 2030 target into its field
        (host.querySelector("#pi-target") as HTMLInputElement).value = String(ask.targetPercent);
        bstatus.innerHTML = `<span style="color:var(--green,#16a34a)">✓ Benchmark ${r.benchmarkEui} kBtu/ft² (${esc(ask.buildingType)}, ${esc(state || postalCode)}) · target ${ask.targetPercent}%</span>`;
      } catch (e: any) { bstatus.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
      calcBtn.disabled = false;
    });

    // ---- gather form → result
    const buildResult = (action: "finish" | "draft"): SetupResult => {
      const gv = (id: string) => (host.querySelector(id) as HTMLInputElement)?.value.trim();
      const gnum = (id: string) => { const v = gv(id); return v === "" || v == null ? undefined : +v; };
      const pct = (id: string) => { const v = gnum(id); return v == null ? undefined : v / 100; };

      // apply utility rates → store.rates (skipped when the rates block is hidden —
      // the wizard sets them in step 2). Model rates are never overwritten above.
      if (!hideRates) {
        const zip = gv("#setup-zip"); if (zip) c.pincode = zip;
        const e = gnum("#setup-elec"), ga = gnum("#setup-gas"), cb = gnum("#setup-carbon");
        if (e != null) c.elec_per_kwh = e;
        if (ga != null) c.gas_per_therm = ga;
        // Persist the "from model" provenance so a later Resume + Fetch still keeps the
        // model's own electricity/gas rates (modelRates isn't re-read on resume).
        if (fromModel) { c.rate_structure = "from model"; if (!c.rate_source) c.rate_source = `Energy model${modelRates?.descr ? ` — ${modelRates.descr}` : ""}`; }
        else if (e != null && !c.rate_source) { c.rate_source = "Entered / fetched in setup"; c.rate_structure = c.rate_structure || "manual"; }
        if (cb != null) { c.elec_carbon_per_kwh = cb; c.carbon_method = "manual"; if (!c.carbon_source) c.carbon_source = "Entered / fetched in setup"; }
      }
      emit();

      // model assignment → baseline / proposed rows
      const bl: Row[] = [], prop: Row[] = [];
      models.forEach((m, i) => {
        const cat = (host.querySelector(`.cm-cat[data-i="${i}"]`) as HTMLSelectElement).value as "leed" | "code" | "proposed";
        const rot = +(host.querySelector(`.cm-rot[data-i="${i}"]`) as HTMLSelectElement).value;
        m.row._cat = cat; m.row._rot = cat === "proposed" ? 0 : rot;
        (cat === "proposed" ? prop : bl).push(m.row);
      });

      // Merge onto existing projectInfo so Basic-Info fields (client, rating,
      // weather, building type, location …) captured earlier are preserved.
      const info: ProjectInfo = {
        ...(store.projectInfo || {}),
        projectName: store.projectInfo?.projectName || p.name,
        floorArea: gnum("#pi-area"),
        benchmarkEui: gnum("#pi-bmeui"),
        targetSavings: pct("#pi-target"),
        leedVersion: gv("#pi-leedver") || undefined,
        leedType: gv("#pi-leedtype") || undefined,
        leedSubcategory: gv("#pi-leedsub") || undefined,
        energyCodeStandard: gv("#pi-code") || undefined,
        energyCodeProcessLoads: gv("#pi-procload") || undefined,
        energyGoalLeed: pct("#pi-egl"), energyGoalCode: pct("#pi-egc"),
        carbonGoalLeed: pct("#pi-cgl"), carbonGoalCode: pct("#pi-cgc"),
        costGoalLeed: pct("#pi-ecl"), costGoalCode: pct("#pi-ecc"),
        author: gv("#pi-author") || undefined,
        date: gv("#pi-date") || undefined,
        uncertaintyFactor: pct("#pi-unc"),
        adjacentShading: (host.querySelector("#pi-shading") as HTMLInputElement)?.checked,
      };
      return { action, bl, prop, info };
    };

    host.querySelector("#setup-go")!.addEventListener("click", () => onSubmit(buildResult("finish")));
    host.querySelector("#setup-draft")!.addEventListener("click", () => onSubmit(buildResult("draft")));
    return host;
}

/** The setup popup (standalone Marcus view) — wraps the shared form in a modal. */
function setupModal(p: Project, models: ParsedModel[], modelRates: ModelRates | null): Promise<SetupResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: SetupResult) => { if (done) return; done = true; overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); resolve(r); };
    const form = buildSetupForm(p, models, modelRates, finish);
    const overlay = h(`<div class="modal-overlay"><div class="modal" style="max-width:720px"><div class="modal-hd"><h3>Project setup</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body" style="max-height:74vh;overflow:auto" id="sm-host"></div></div></div>`);
    (overlay.querySelector("#sm-host") as HTMLElement).appendChild(form);
    document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
    overlay.querySelector(".x")!.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
  });
}

/** Inline setup card (wizard section 3) — the same form, no popup. Completing it
    commits the parse and unlocks the Excel step. */
function inlineSetupCard(root: HTMLElement, p: Project): HTMLElement {
  const card = h(`<div class="card" style="margin-top:16px;border-color:var(--red-soft)"><div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.bolt()}</div><h3>Complete setup to continue</h3><span class="sub">rates · model assignment · project info — required before Excel</span></div><div id="is-host"></div></div>`);
  const pending = pendingSetup!;
  const form = buildSetupForm(p, pending.models, pending.modelRates, async (res) => {
    if (!res) return;
    store.projectInfo = res.info;
    pendingSetup = null;
    await commitParse(root, p, res.bl, res.prop, res.action === "draft");
  }, true); // hideRates — the wizard sets utility rates in step 2
  (card.querySelector("#is-host") as HTMLElement).appendChild(form);
  return card;
}

/** Open the setup popup for a project's parsed models, then commit (finish) or
    save a draft. Used by both a fresh parse and the "Resume setup" action. */
async function runSetup(root: HTMLElement, p: Project, models: ParsedModel[], modelRates: ModelRates | null) {
  const res = await setupModal(p, models, modelRates);
  if (!res) { logLine(`<span class="dim">› setup cancelled</span>`); paintLog(); return; }
  store.projectInfo = res.info;
  await commitParse(root, p, res.bl, res.prop, res.action === "draft");
}

/** Average proposed rotations into a single final proposed row. Numeric fields
    that every row supplies are averaged; text/identity fields keep the first. */
function averageRows(rows: Row[]): Row {
  if (rows.length <= 1) return rows[0];
  const out: Row = { ...rows[0] };
  const keys = new Set<string>(); rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  for (const k of keys) {
    if (k.startsWith("_")) continue;
    const nums = rows.map((r) => r[k]).filter((v) => typeof v === "number" && isFinite(v));
    if (nums.length === rows.length) out[k] = nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  out._cat = "proposed"; out._rot = 0;
  out.option_name = rows[0].option_name || "Proposed Design";
  return out;
}

async function commitParse(root: HTMLElement, p: Project, bl: Row[], prop: Row[], isDraft: boolean) {
  // proposed rotations → one averaged final proposed (only when finalizing, so a
  // resumed draft can still re-assign the individual rotations).
  if (!isDraft && prop.length > 1) { logLine(`<span class="dim">› averaged ${prop.length} proposed rotations → 1 final proposed</span>`); prop = [averageRows(prop)]; }
  store.blRows = bl; store.propRows = prop;
  logLine(isDraft ? `<span class="dim">› draft saved (${bl.length} baseline · ${prop.length} proposed)</span>` : `<span class="ok">✓ Assigned ${bl.length} baseline · ${prop.length} proposed</span>`);
  const summary = computeSummary(bl, prop);
  await Projects.update(p.id, { parsed: { bl, prop, summary }, rates: store.rates, modelType: p.modelType, projectInfo: store.projectInfo, setupDraft: isDraft } as any);
  p.parsed = { bl, prop, summary } as any; p.rates = store.rates as any; (p as any).projectInfo = store.projectInfo; (p as any).setupDraft = isDraft;
  emit(); toast(isDraft ? "✓ Draft saved — resume any time" : `✓ Populated ${bl.length + prop.length} model(s)`);
  rerender(root);
  if (!isDraft && !EMBED) setTimeout(() => { const a = document.getElementById("acc-analysis"); a?.classList.add("open"); document.getElementById("acc-analysis-body") && drawAnalysis(); a?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
}
function computeSummary(bl: Row[], prop: Row[]) {
  const rows = [...bl, ...prop].map((r) => enrichRow(r, store.rates));
  const n = rows.length || 1;
  return {
    models: rows.length,
    eui: rows.reduce((a, r) => a + (r.eui_kbtu_ft2 || 0), 0) / n,
    totalEnergy: rows.reduce((a, r) => a + (r.total_energy_kbtu || 0), 0),
    totalCarbon: rows.reduce((a, r) => a + (r.total_carbon_kg || 0), 0),
    totalCost: rows.reduce((a, r) => a + (r.total_cost || 0), 0),
  };
}

/* ---------- accordions ---------- */
function simpleAcc(id: string, title: string, sub: string, body: HTMLElement, open = false, onOpen?: () => void): HTMLElement {
  const acc = h(`<div class="accordion ${open ? "open" : ""}" id="${id}" style="margin-top:16px"></div>`);
  const head = h(`<div class="acc-head"><div class="acc-ico">${ICON.chart("x").replace('class="nav-ico"', 'class="x" style="width:20px;height:20px;fill:none;stroke-width:2;stroke:var(--red)"')}</div><div><div class="acc-title">${esc(title)}</div><div class="acc-sub">${esc(sub)}</div></div><div class="acc-right"><span class="acc-chev">${ICON.chevron("x")}</span></div></div>`);
  const bodyWrap = h(`<div class="acc-body" id="${id}-body"></div>`); bodyWrap.appendChild(body);
  head.addEventListener("click", () => { const o = !acc.classList.contains("open"); acc.classList.toggle("open", o); if (o && onOpen) requestAnimationFrame(onOpen); });
  acc.appendChild(head); acc.appendChild(bodyWrap);
  if (open && onOpen) requestAnimationFrame(onOpen);
  return acc;
}
function logsAccordion(): HTMLElement {
  const body = h(`<pre class="log" id="mk-log"></pre>`);
  const acc = simpleAcc("acc-logs", "Logs", "parse output", body, !EMBED); // collapsed inside the wizard
  setTimeout(paintLog, 0);
  return acc;
}
function paintLog() { const el = document.getElementById("mk-log"); if (el) el.innerHTML = store.log.length ? store.log.join("\n") : `<span class="dim">Upload files and click Parse.</span>`; }

let analysisRoot: HTMLElement | null = null;
function analysisAccordion(root: HTMLElement): HTMLElement {
  const body = h(`<div id="mk-analysis"></div>`);
  analysisRoot = body;
  // Collapsed by default inside the wizard (embed); auto-open in the standalone view.
  const acc = simpleAcc("acc-analysis", "Project Analysis", "dashboards (same for every model type)", body, !EMBED && store.blRows.length + store.propRows.length > 0, () => drawAnalysis());
  return acc;
}
function drawAnalysis() { if (!analysisRoot) return; analysisRoot.innerHTML = ""; renderAnalysis(analysisRoot, store.blRows, store.propRows, "mk"); }

/* ---------- utility rates used ---------- */
function ratesAccordion(root: HTMLElement, p: Project): HTMLElement {
  const body = h(`<div></div>`);
  const c = store.rates;
  const items: [string, string, string][] = [
    ["Electricity", c.elec_per_kwh != null ? `$${fmt(c.elec_per_kwh, 4)}/kWh` : "—", "var(--red)"],
    ["Natural Gas", c.gas_per_therm != null ? `$${fmt(c.gas_per_therm, 4)}/therm` : "—", "#52525b"],
    ["Carbon", c.elec_carbon_per_kwh != null ? `${fmt(c.elec_carbon_per_kwh, 4)} kg/kWh` : "—", "#0c0c0d"],
    ["Water", c.water_per_kgal != null ? `$${fmt(c.water_per_kgal, 3)}/kGal` : "—", "#71717a"],
  ];
  const grid = h(`<div class="grid cards-4" style="margin-top:6px"></div>`);
  items.forEach(([cat, val, color]) => grid.appendChild(h(`<div style="border:1px solid var(--g200);border-radius:12px;padding:14px 16px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="width:9px;height:9px;border-radius:3px;background:${color};display:inline-block"></span><span style="font-family:var(--font);font-weight:800;font-size:14px">${esc(cat)}</span></div><div style="font-size:15px;font-weight:500;color:var(--g700)">${esc(val)}</div></div>`)));
  body.appendChild(grid);
  const bar = h(`<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center"><button class="btn btn-sm" id="ra-edit">${ICON.rates("x")} Edit / find rates</button><button class="btn btn-sm" id="ra-save">Save these rates to project</button><select class="unit-pick" id="ra-load" style="min-width:200px"><option value="">— load a saved rate set —</option></select></div>`);
  body.appendChild(bar);
  bar.querySelector("#ra-edit")!.addEventListener("click", () => navigate("rates"));
  bar.querySelector("#ra-save")!.addEventListener("click", async () => { await Projects.update(p.id, { rates: store.rates }); toast("✓ Rates saved to project"); });
  // load saved rate sets
  Rates.list().then(({ rateSets }: { rateSets: RateSet[] }) => {
    const sel = bar.querySelector("#ra-load") as HTMLSelectElement;
    rateSets.forEach((rs) => sel.appendChild(h(`<option value="${rs.id}">${esc(rs.name)}</option>`)));
    sel.addEventListener("change", () => { const rs = rateSets.find((x) => x.id === sel.value); if (rs) { store.rates = { ...store.rates, ...rs.config }; emit(); toast(`✓ Loaded "${rs.name}"`); rerender(root); } });
  }).catch(() => {});
  return simpleAcc("acc-rates", "Utility Rates Used", "applied to cost & carbon", body, false);
}

/* ---------- AI search ---------- */
function aiAccordion(): HTMLElement {
  const body = h(`
    <div class="ai-search">${ICON.search()}<input id="ai-q" placeholder="Ask anything — e.g. “cooling EUI”, “total fan power”, “WWR south”…" /><button class="btn btn-sm btn-dark" id="ai-go">Search</button></div>
    <div id="ai-out"></div>
  `);
  const go = async () => {
    const q = (body.querySelector("#ai-q") as HTMLInputElement).value.trim();
    if (!q) return;
    const out = body.querySelector("#ai-out") as HTMLElement;
    out.innerHTML = `<div class="ai-answer"><span class="spinner"></span> Searching…</div>`;
    try { const ans = await aiSearch(q); out.innerHTML = `<div class="ai-answer"><div>${esc(ans.answer)}</div>${ans.value ? `<div style="margin-top:6px;font-size:18px;font-family:var(--font);font-weight:800;color:#fff">${esc(ans.value)}</div>` : ""}<div class="where">↳ ${esc(ans.where || "")}</div></div>`; }
    catch (e: any) { out.innerHTML = `<div class="ai-answer" style="background:var(--red-dark)">Search failed: ${esc(e.message)}</div>`; }
  };
  body.querySelector("#ai-go")!.addEventListener("click", go);
  body.querySelector("#ai-q")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go(); });
  return simpleAcc("acc-ai", "AI Search", "find any value across the parsed model", body, false);
}
async function aiSearch(query: string): Promise<{ answer: string; value: string; where: string }> {
  const rows = [...store.blRows, ...store.propRows].map((r) => enrichRow(r, store.rates));
  if (!rows.length) throw new Error("parse a model first");
  // build a labelled context from the column schema (first 2 models to bound size)
  const ctx = rows.slice(0, 2).map((r) => {
    const o: any = { model: r.option_name };
    for (const [label, key] of COLUMNS) { const v = r[key]; if (v !== undefined && v !== "" && v !== 0) o[label] = typeof v === "number" ? +Number(v).toFixed(3) : v; }
    return o;
  });
  if (!store.openaiKey) throw new Error("no OpenAI key set (Utility Rates → settings)");
  const data = await openaiChat({
    model: store.openaiModel,
    messages: [
      { role: "system", content: "You answer questions about a parsed building energy model. Use ONLY the provided JSON data. Reply as JSON {\"answer\":\"one sentence\",\"value\":\"the number with units, or empty\",\"where\":\"which field/model it came from\"}." },
      { role: "user", content: `Data: ${JSON.stringify(ctx)}\n\nQuestion: ${query}` },
    ],
    temperature: 0, response_format: { type: "json_object" },
  }, store.openaiKey);
  try { return JSON.parse(data.choices[0].message.content); } catch { return { answer: data.choices?.[0]?.message?.content || "no answer", value: "", where: "" }; }
}

/* ---------- edit ---------- */
function editProjectModal(root: HTMLElement, p: Project) {
  const overlay = h(`
    <div class="modal-overlay"><div class="modal"><div class="modal-hd"><h3>Edit Project</h3><span class="x">${ICON.close("x")}</span></div>
      <div class="modal-body">
        <div class="field" style="margin-bottom:12px"><label>Project name</label><input id="ep-name" value="${esc(p.name)}" /></div>
        <div class="field"><label>Project address</label><input id="ep-addr" value="${esc(p.address)}" /></div>
        <button class="btn btn-primary" id="ep-save" style="width:100%;justify-content:center;margin-top:18px">Save</button>
      </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#ep-save")!.addEventListener("click", async () => {
    p.name = (overlay.querySelector("#ep-name") as HTMLInputElement).value.trim() || p.name;
    p.address = (overlay.querySelector("#ep-addr") as HTMLInputElement).value.trim();
    await Projects.update(p.id, { name: p.name, address: p.address });
    close(); toast("✓ Saved"); rerender(root);
  });
}

function rerender(root: HTMLElement) { root.innerHTML = ""; renderMarcus(root, { embedded: EMBED }); }
