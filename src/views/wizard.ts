/* ============================================================
 *  GUIDED PROJECT WIZARD  (runs ALONGSIDE the classic Marcus flow)
 *  A linear 5-step path that carries EVERYTHING from the existing flow:
 *    1 · Software & naming   — name, client, address/ZIP, model type
 *    2 · Upload, parse & details — the full Marcus workspace (embedded) +
 *        the Word-report "Report Details" form (Parser Test.docx comments)
 *    3 · Utility rates       — the Utility Rates screen (embedded, identical UI)
 *    4 · Excel generation    — build/download the workbook + upload slots
 *    5 · Report generation   — the Word Report screen (embedded)
 *  The classic "New Project → Marcus" path is untouched and remains the default.
 * ============================================================ */
import { store, emit } from "../store";
import type { ProjectInfo } from "../store";
import { Projects, Project } from "../api";
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { renderMarcus } from "./marcus";
import { renderRates } from "./rates";
import { renderWordReport } from "./wordreport";
import type { ReportFields } from "../engine/wordreport";
import { buildWorkbook, downloadWorkbook } from "../engine/workbook";
import { geocodeAddress } from "../engine/rates";

/* ---- model types (mirrors marcus.ts) ---- */
const MODELS: { key: Project["modelType"]; name: string; icon: string; sub: string; soon?: boolean }[] = [
  { key: "equest", name: "eQUEST", icon: "🏢", sub: ".SIM / .inp (DOE-2.2)" },
  { key: "trace", name: "TRACE 3D Plus", icon: "📑", sub: "report PDF" },
  { key: "iesve", name: "IES-VE", icon: "🧪", sub: "under development", soon: true },
];

const STEPS = [
  { n: 1, title: "Software & naming", sub: "model type + project details" },
  { n: 2, title: "Upload & details", sub: "parse model + report fields" },
  { n: 3, title: "Utility rates", sub: "electricity · gas · carbon · water" },
  { n: 4, title: "Excel", sub: "generate the comparison workbook" },
  { n: 5, title: "Report", sub: "generate the Word report" },
];

/* ---- module state (a single wizard at a time) ---- */
let STEP = 1;
let excelBuf: ArrayBuffer | null = null;   // last-generated workbook, reused by step 5

function excelName(name: string): string {
  const clean = String(name || "Project").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean}_Energy Results Comparision`;
}

/* ============================================================ */
export function renderWizard(root: HTMLElement) {
  // No project yet → always start at naming. A live project can resume mid-flow.
  if (!store.currentProject) STEP = 1;
  if (STEP < 1 || STEP > 5) STEP = 1;

  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Guided Project <span class="pill pill-red" style="font-size:10px;vertical-align:middle">new</span></h1>
      <p>One linear flow — name the project, parse the model, set rates, then generate the Excel &amp; Word report.</p></div>
    </div>`));

  root.appendChild(stepper(root));
  const content = h(`<div id="wz-content" style="margin-top:18px"></div>`);
  root.appendChild(content);
  root.appendChild(footerNav(root));
  renderStep(content);
}

/* ---------- stepper header ---------- */
function stepper(root: HTMLElement): HTMLElement {
  const wrap = h(`<div class="wz-stepper" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"></div>`);
  STEPS.forEach((s) => {
    const state = s.n === STEP ? "active" : s.n < STEP ? "done" : "todo";
    const bg = state === "active" ? "var(--red)" : state === "done" ? "#1a1a1d" : "var(--g100)";
    const fg = state === "todo" ? "var(--g500)" : "#fff";
    const chip = h(`<button class="wz-step" data-n="${s.n}" style="flex:1;min-width:150px;text-align:left;border:1px solid var(--g200);border-radius:12px;padding:10px 14px;background:#fff;cursor:pointer;display:flex;gap:10px;align-items:center">
      <span style="width:26px;height:26px;border-radius:50%;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:0 0 auto">${state === "done" ? "✓" : s.n}</span>
      <span><span style="display:block;font-family:var(--font);font-weight:800;font-size:12.5px">${esc(s.title)}</span><span style="display:block;font-size:11px;color:var(--g500)">${esc(s.sub)}</span></span>
    </button>`);
    chip.addEventListener("click", () => goStep(root, s.n));
    wrap.appendChild(chip);
  });
  return wrap;
}

/* ---------- footer Back / Next ---------- */
function footerNav(root: HTMLElement): HTMLElement {
  const bar = h(`<div style="display:flex;justify-content:space-between;gap:10px;margin-top:22px;border-top:1px solid var(--g150);padding-top:16px">
    <button class="btn" id="wz-back" ${STEP === 1 ? "disabled" : ""}>← Back</button>
    <button class="btn btn-primary" id="wz-next" ${STEP === 5 ? "disabled" : ""}>Next →</button>
  </div>`);
  bar.querySelector("#wz-back")!.addEventListener("click", () => goStep(root, STEP - 1));
  bar.querySelector("#wz-next")!.addEventListener("click", () => {
    if (STEP === 1) { toast("Create the project below to continue"); return; }  // step 1 advances via its own button
    goStep(root, STEP + 1);
  });
  return bar;
}

function goStep(root: HTMLElement, n: number) {
  if (n < 1 || n > 5) return;
  if (n > 1 && !store.currentProject) { toast("Create the project first"); return; }
  STEP = n;
  root.innerHTML = "";
  renderWizard(root);
  window.scrollTo({ top: 0 });
}

/* ============================================================ STEP DISPATCH */
function renderStep(content: HTMLElement) {
  content.innerHTML = "";
  if (STEP === 1) return stepNaming(content);
  if (STEP === 2) return stepDetails(content);
  if (STEP === 3) return stepRates(content);
  if (STEP === 4) return stepExcel(content);
  if (STEP === 5) return stepReport(content);
}

/* ---------- STEP 1 · Software & naming ---------- */
function stepNaming(content: HTMLElement) {
  const p = store.currentProject;
  const pi: ProjectInfo = store.projectInfo || {};
  let sel: Project["modelType"] = p?.modelType || "equest";

  const card = h(`<div class="card">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.bolt()}</div><h3>1 · Software &amp; project details</h3><span class="sub">${p ? "editing the current project" : "creates a new project"}</span></div>
    <div class="grid cards-2" style="gap:12px;margin-top:6px">
      <div class="field"><label>Project name</label><input id="wz-name" placeholder="e.g. KP Parker Hospital" value="${esc(p?.name || "")}" /></div>
      <div class="field"><label>Client name <span style="color:var(--g400)">(report footer)</span></label><input id="wz-client" placeholder="e.g. Kaiser Permanente" value="${esc(pi.clientName || "")}" /></div>
      <div class="field"><label>Project address</label><input id="wz-addr" placeholder="City, State, Country, ZIP" value="${esc(p?.address || "")}" /></div>
      <div class="field"><label>Pincode / ZIP</label><input id="wz-zip" placeholder="e.g. 92054" value="${esc(pi.pincode || store.rates.pincode || "")}" /></div>
    </div>
    <div class="field" style="margin-top:6px"><label>Model type</label></div>
    <div class="model-tiles" id="wz-models" style="margin-top:8px"></div>
    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn btn-primary" id="wz-create" style="flex:1;justify-content:center">${p ? "Save & continue →" : "Create project & continue →"}</button>
    </div>
  </div>`);
  const tiles = card.querySelector("#wz-models")!;
  MODELS.forEach((m) => {
    const t = h(`<div class="model-tile ${m.key === sel ? "active" : ""} ${m.soon ? "soon" : ""}" data-k="${m.key}"><div class="mt-ico">${m.icon}</div><h4>${esc(m.name)}</h4><p>${esc(m.sub)}</p></div>`);
    if (!m.soon) t.addEventListener("click", () => { sel = m.key; tiles.querySelectorAll(".model-tile").forEach((x) => x.classList.remove("active")); t.classList.add("active"); });
    tiles.appendChild(t);
  });

  card.querySelector("#wz-create")!.addEventListener("click", async () => {
    const name = (card.querySelector("#wz-name") as HTMLInputElement).value.trim() || "Untitled Project";
    const addr = (card.querySelector("#wz-addr") as HTMLInputElement).value.trim();
    const client = (card.querySelector("#wz-client") as HTMLInputElement).value.trim();
    const zip = (card.querySelector("#wz-zip") as HTMLInputElement).value.trim();
    const btn = card.querySelector("#wz-create") as HTMLButtonElement; btn.disabled = true;
    try {
      let proj: Project | null = store.currentProject;
      if (!proj) {
        const res = await Projects.create(name, addr, sel);
        proj = res.project as Project;
      } else {
        proj.name = name; proj.address = addr; proj.modelType = sel;
        await Projects.update(proj.id, { name, address: addr, modelType: sel });
      }
      if (!proj) { toast("Create failed"); btn.disabled = false; return; }
      store.currentProject = proj;
      // seed project info + rates pincode
      const info: ProjectInfo = { ...(store.projectInfo || {}), projectName: name, clientName: client || undefined, pincode: zip || undefined };
      store.projectInfo = info;
      if (zip) store.rates.pincode = zip;
      await Projects.update(proj.id, { projectInfo: info } as any);
      (proj as any).projectInfo = info;
      emit();
      const root = content.closest(".content") as HTMLElement || (content.parentElement as HTMLElement);
      goStep(root, 2);
    } catch (e: any) { toast("Create failed — " + e.message); btn.disabled = false; }
  });

  content.appendChild(card);
}

/* ---------- STEP 2 · Upload, parse & details ---------- */
function stepDetails(content: HTMLElement) {
  // The full Marcus workspace (parse + setup popup + logs + analysis + rates
  // accordion + AI search + export) — embedded so nothing is lost.
  const mk = h(`<div></div>`);
  content.appendChild(mk);
  renderMarcus(mk, { embedded: true });

  // Report Details form (the Word-report fields → projectInfo).
  content.appendChild(reportDetailsCard());
}

const LEED_CERT_TYPES = ["New Construction", "Major Renovation", "Core and Shell", "New Construction — Healthcare", "Schools"];

/* ASHRAE 90.1 version mandated by the LEED version (#24). Reg date refines v5. */
const ASHRAE_BY_LEED: [RegExp, string][] = [
  [/v2009|2009/i, "ASHRAE 90.1-2007"],
  [/v4\.1/i, "ASHRAE 90.1-2016"],
  [/v4/i, "ASHRAE 90.1-2010"],
  [/v5/i, "ASHRAE 90.1-2019"],
];
function ashraeForLeed(v?: string): string { if (!v) return ""; for (const [re, a] of ASHRAE_BY_LEED) if (re.test(v)) return a; return ""; }
/* TMY type / weather-file family parsed from the model's weather string (#32). */
function weatherTypeFromModel(): string {
  const r: any = store.blRows[0] || store.propRows[0]; if (!r) return "";
  const s = String(r.weather_file || r.weather || r.climate_file || r.weatherFile || "");
  const m = s.match(/TMY3|TMY2|TMY|CTZ\w*|CZ\d+/i);
  return m ? m[0].toUpperCase() : "";
}
const COST_SOURCES = [
  "Default Energy Modelling Software Energy Rates",
  "Manually input by Energy Modeler",
  "Provided by client",
  "EIA reference rates for the region",
];

function reportDetailsCard(): HTMLElement {
  const pi: ProjectInfo = store.projectInfo || {};
  const txt = (id: string, val: any, ph = "") => `<input id="${id}" value="${val == null ? "" : esc(String(val))}" placeholder="${esc(ph)}" />`;
  const sel = (id: string, opts: string[], val: string) => `<select class="unit-pick" id="${id}" style="width:100%"><option value="">— select —</option>${opts.map((o) => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;

  const card = h(`<div class="card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.book()}</div><h3>Report details</h3><span class="sub">fills the Word report's narrative fields — all optional</span>
      <div class="right"><button class="btn btn-sm" id="wz-derive" type="button">${ICON.rates("x")} Derive from ZIP</button></div></div>
    <div class="grid cards-2" style="gap:12px;margin-top:6px">
      <div class="field"><label>Client name (footer)</label>${txt("rd-client", pi.clientName, "e.g. Kaiser Permanente")}</div>
      <div class="field"><label>Pincode / ZIP</label>${txt("rd-zip", pi.pincode || store.rates.pincode, "e.g. 92054")}</div>
      <div class="field"><label>Project location</label>${txt("rd-loc", pi.projectLocation, "City, State (from ZIP)")}</div>
      <div class="field"><label>LEED certification type</label>${sel("rd-cert", LEED_CERT_TYPES, pi.programType || "")}</div>
      <div class="field"><label>LEED registration date</label>${txt("rd-regdate", pi.leedRegistrationDate, "YYYY-MM-DD")}</div>
      <div class="field"><label>ASHRAE version</label>${txt("rd-ashrae", pi.ashraeVersion, "e.g. ASHRAE 90.1-2010")}</div>
      <div class="field"><label>Reference document name</label>${txt("rd-refdoc", pi.referenceDocument, "e.g. Architectural set Rev 3")}</div>
      <div class="field"><label>Document phase</label>${txt("rd-phase", pi.documentPhase, "e.g. Schematic Design")}</div>
      <div class="field"><label>Energy cost data source</label>${sel("rd-costsrc", COST_SOURCES, pi.costDataSource || "")}</div>
      <div class="field"><label>Cost source note</label>${txt("rd-costnote", pi.costDataSourceNote, "optional qualifier")}</div>
      <div class="field"><label>Weather file type</label>${txt("rd-tmy", pi.weatherFileType, "e.g. TMY3")}</div>
      <div class="field"><label>Report date</label>${txt("rd-date", pi.reportDate, "defaults to today")}</div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;cursor:pointer"><input type="checkbox" id="rd-shading" ${pi.adjacentShading ? "checked" : ""} /> Model includes adjacent shading structures (neighboring buildings &amp; trees)</label>
    <div style="display:flex;gap:10px;margin-top:16px;align-items:center"><button class="btn btn-primary" id="rd-save">${ICON.bolt()} Save report details</button><span id="rd-status" style="font-size:12px;color:var(--g500)"></span></div>
  </div>`);

  const gv = (id: string) => (card.querySelector("#" + id) as HTMLInputElement)?.value.trim();
  card.querySelector("#wz-derive")!.addEventListener("click", async () => {
    const status = card.querySelector("#rd-status") as HTMLElement;
    const set = (id: string, val: string) => { if (val) (card.querySelector("#" + id) as HTMLInputElement).value = val; };
    const done: string[] = [];
    // ASHRAE version from the LEED version chosen in step 2; weather type from the model.
    const ashrae = ashraeForLeed((store.projectInfo || {}).leedVersion);
    if (ashrae) { set("rd-ashrae", ashrae); done.push("ASHRAE version"); }
    const wt = weatherTypeFromModel();
    if (wt) { set("rd-tmy", wt); done.push("weather type"); }
    // Location from ZIP (needs a network call).
    const zip = gv("rd-zip");
    status.innerHTML = `<span class="spinner" style="width:11px;height:11px;vertical-align:middle"></span> Deriving…`;
    try {
      if (zip) {
        const info = await geocodeAddress({ pincode: zip });
        if (info.name) { set("rd-loc", info.name); done.push("location"); }
        if (info.state) store.rates.state = info.state;
      }
      status.innerHTML = done.length
        ? `<span style="color:var(--green,#16a34a)">✓ Derived ${done.join(", ")} — review &amp; save</span>`
        : `<span style="color:var(--g500)">Nothing to derive yet — set a ZIP / LEED version / parse a model first</span>`;
    } catch (e: any) { status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
  });

  card.querySelector("#rd-save")!.addEventListener("click", async () => {
    const info: ProjectInfo = {
      ...(store.projectInfo || {}),
      clientName: gv("rd-client") || undefined,
      pincode: gv("rd-zip") || undefined,
      projectLocation: gv("rd-loc") || undefined,
      programType: gv("rd-cert") || (store.projectInfo || {}).programType,
      leedRegistrationDate: gv("rd-regdate") || undefined,
      ashraeVersion: gv("rd-ashrae") || undefined,
      referenceDocument: gv("rd-refdoc") || undefined,
      documentPhase: gv("rd-phase") || undefined,
      costDataSource: gv("rd-costsrc") || undefined,
      costDataSourceNote: gv("rd-costnote") || undefined,
      weatherFileType: gv("rd-tmy") || undefined,
      reportDate: gv("rd-date") || undefined,
      adjacentShading: (card.querySelector("#rd-shading") as HTMLInputElement).checked,
    };
    if (gv("rd-zip")) store.rates.pincode = gv("rd-zip");
    store.projectInfo = info; emit();
    const status = card.querySelector("#rd-status") as HTMLElement;
    try {
      if (store.currentProject) { await Projects.update(store.currentProject.id, { projectInfo: info } as any); (store.currentProject as any).projectInfo = info; }
      status.innerHTML = `<span style="color:var(--green,#16a34a)">✓ Saved</span>`;
      toast("✓ Report details saved");
    } catch (e: any) { status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
  });

  return card;
}

/* ---------- STEP 3 · Utility rates ---------- */
function stepRates(content: HTMLElement) {
  const r = h(`<div></div>`);
  content.appendChild(r);
  renderRates(r, { embedded: true });
}

/* ---------- STEP 4 · Excel generation ---------- */
function stepExcel(content: HTMLElement) {
  const haveRows = store.blRows.length + store.propRows.length > 0;
  const card = h(`<div class="card">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.table()}</div><h3>4 · Generate the Excel workbook</h3><span class="sub">Energy Results Comparison (.xlsx)</span></div>
    <p class="muted-tag" style="margin-top:4px">${haveRows ? "Builds the comparison workbook from the parsed models, the utility rates, and your project info." : "Parse a model in step 2 first — there are no results yet."}</p>
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-primary" id="wz-xlsx" ${haveRows ? "" : "disabled"}>${ICON.download()} Generate &amp; download Excel</button>
      <span id="wz-xlsx-status" style="font-size:13px;color:var(--g500)"></span>
    </div>
  </div>`);
  card.querySelector("#wz-xlsx")!.addEventListener("click", async () => {
    const status = card.querySelector("#wz-xlsx-status") as HTMLElement;
    const btn = card.querySelector("#wz-xlsx") as HTMLButtonElement; btn.disabled = true;
    status.innerHTML = `<span class="spinner" style="width:13px;height:13px;vertical-align:middle"></span> Building…`;
    try {
      const info = store.projectInfo || { projectName: store.currentProject?.name };
      const blob = await buildWorkbook(store.blRows, store.propRows, store.rates, { projectName: store.currentProject?.name || info.projectName, projectInfo: info });
      excelBuf = await blob.arrayBuffer();   // keep for step 5
      downloadWorkbook(blob, `${excelName(info.projectName || store.currentProject?.name || "Project")}.xlsx`);
      status.innerHTML = `<span style="color:var(--g700)">✓ Excel generated — also available to the report step.</span>`;
      toast("✓ Excel downloaded");
    } catch (e: any) { status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; btn.disabled = false; }
  });
  content.appendChild(card);

  content.appendChild(uploadsCard());
}

/* Upload slots — attach any supporting files to the project (stored server-side). */
function uploadsCard(): HTMLElement {
  const card = h(`<div class="card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--g100)">📎</div><h3>Supporting uploads <span style="font-weight:500;color:var(--g400);font-size:12px">(optional)</span></h3><span class="sub">attach the QA'd workbook or any source files to the project</span></div>
    <label class="dropzone" id="wz-up-dz" style="margin-top:6px"><input type="file" multiple hidden /><div class="dz-ico">📎</div><div class="dz-t">Drop files or click to upload</div><div class="dz-h">stored on the project record</div></label>
    <div class="chips" id="wz-up-list" style="margin-top:12px"></div>
  </div>`);
  const dz = card.querySelector("#wz-up-dz") as HTMLElement;
  const input = dz.querySelector("input") as HTMLInputElement;
  const list = card.querySelector("#wz-up-list") as HTMLElement;
  const doUpload = async (files: FileList) => {
    if (!files.length || !store.currentProject) { if (!store.currentProject) toast("Create the project first"); return; }
    dz.classList.add("drag");
    try { const { project } = await Projects.upload(store.currentProject.id, Array.from(files), "model"); store.currentProject = project; toast(`✓ Uploaded ${files.length} file(s)`); paintUploads(list); }
    catch (e: any) { toast("Upload failed — " + e.message); }
    finally { dz.classList.remove("drag"); }
  };
  input.addEventListener("change", (e) => { const t = e.target as HTMLInputElement; if (t.files?.length) doUpload(t.files); });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const dt = (e as DragEvent).dataTransfer; if (dt?.files.length) doUpload(dt.files); });
  paintUploads(list);
  return card;
}
function paintUploads(list: HTMLElement) {
  const p = store.currentProject; if (!p) return;
  list.innerHTML = "";
  p.files.forEach((f) => list.appendChild(h(`<span class="chip"><b style="font-weight:600">${esc(f.role)}</b> ${esc(f.name)}</span>`)));
}

/* ---------- STEP 5 · Report generation ---------- */
function stepReport(content: HTMLElement) {
  // The Word Report screen, embedded — auto-using the step-4 Excel + the stored
  // report-detail fields, so no re-upload is required (an upload still overrides).
  const pi: ProjectInfo = store.projectInfo || {};
  const fields: ReportFields = {
    projectName: pi.projectName, clientName: pi.clientName, floorArea: pi.floorArea,
    projectLocation: pi.projectLocation, climateZone: pi.climateZone,
    leedCertType: pi.programType, ashraeVersion: pi.ashraeVersion,
    referenceDocument: pi.referenceDocument, documentPhase: pi.documentPhase,
    adjacentShading: pi.adjacentShading, costDataSource: pi.costDataSource,
    costDataSourceNote: pi.costDataSourceNote, reportDate: pi.reportDate,
  };
  const excel = excelBuf ? { buf: excelBuf, name: `${excelName(pi.projectName || store.currentProject?.name || "Project")}.xlsx` } : null;
  const r = h(`<div></div>`);
  content.appendChild(r);
  renderWordReport(r, { embedded: true, excel, projectInfo: fields });
}
