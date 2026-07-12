/* ============================================================
 *  GUIDED PROJECT WIZARD  (runs ALONGSIDE the classic Marcus flow)
 *  A linear 3-section path:
 *    1 · Basic Info      — details, certification, weather, code (create popup)
 *    2 · Utility Rates   — the Utility Rates / Profile screen (embedded)
 *    3 · Model & Results — parse model + remaining values + Excel + Word report
 *  The classic "New Project → Marcus" path is untouched and remains the default.
 * ============================================================ */
import { store, emit } from "../store";
import type { ProjectInfo } from "../store";
import { Projects, Project, authUser } from "../api";
import { renderAnalysis } from "./analysis";
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { renderMarcus } from "./marcus";
import { renderRates } from "./rates";
import { renderWordReport } from "./wordreport";
import type { ReportFields } from "../engine/wordreport";
import { buildWorkbook, downloadWorkbook } from "../engine/workbook";
import { geocodeAddress, STATE_NAMES } from "../engine/rates";
import { nearestWeatherFiles, WeatherFile } from "../engine/weather";
import { ZT_BUILDING_TYPES } from "../engine/zerotool";

/* ---- model types (mirrors marcus.ts) ---- */
const MODELS: { key: Project["modelType"]; name: string; icon: string; sub: string; soon?: boolean }[] = [
  { key: "equest", name: "eQUEST", icon: "🏢", sub: ".SIM / .inp (DOE-2.2)" },
  { key: "trace", name: "TRACE 3D Plus", icon: "📑", sub: "report PDF" },
  { key: "iesve", name: "IES-VE", icon: "🧪", sub: "under development", soon: true },
];

const STEPS = [
  { n: 1, title: "Basic Info", sub: "project details + certification" },
  { n: 2, title: "Utility Rates", sub: "electricity · gas · carbon · water" },
  { n: 3, title: "Model", sub: "upload & parse + setup" },
  { n: 4, title: "Project Analysis", sub: "dashboards (EUI · energy · carbon · cost)" },
  { n: 5, title: "Excel", sub: "generate the comparison workbook" },
  { n: 6, title: "Report", sub: "generate the Word report" },
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
  if (STEP < 1 || STEP > 6) STEP = 1;

  root.appendChild(h(`
    <div class="page-head">
      <div><h1>Guided Project <span class="pill pill-red" style="font-size:10px;vertical-align:middle">new</span></h1>
      <p>Three steps — basic info, utility rates, then parse the model &amp; generate the Excel &amp; Word report.</p></div>
    </div>`));

  root.appendChild(stepper(root));
  const content = h(`<div id="wz-content" style="margin-top:18px"></div>`);
  root.appendChild(content);
  root.appendChild(footerNav(root));
  renderStep(content);

  // Fresh start (no project yet) → collect Basic Info in a popup first; the
  // editable step-1 form sits underneath as the fallback / landing surface.
  if (!store.currentProject && STEP === 1) openBasicInfoModal(root);
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
    <button class="btn btn-primary" id="wz-next" ${STEP === 6 ? "disabled" : ""}>Next →</button>
  </div>`);
  bar.querySelector("#wz-back")!.addEventListener("click", () => goStep(root, STEP - 1));
  bar.querySelector("#wz-next")!.addEventListener("click", () => {
    if (STEP === 1) { toast("Create the project below to continue"); return; }  // step 1 advances via its own button
    goStep(root, STEP + 1);
  });
  return bar;
}

function goStep(root: HTMLElement, n: number) {
  if (n < 1 || n > 6) return;
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
  if (STEP === 2) return stepRates(content);
  if (STEP === 3) return stepModel(content);
  if (STEP === 4) return stepAnalysis(content);
  if (STEP === 5) return stepExcel(content);
  if (STEP === 6) return stepReport(content);
}

/* ---------- STEP 4 · Project Analysis ---------- */
function stepAnalysis(content: HTMLElement) {
  const haveRows = store.blRows.length + store.propRows.length > 0;
  if (!haveRows) { content.appendChild(h(`<div class="card"><div class="empty"><div class="big">📊</div><div style="color:var(--g500)">Parse a model in step 3 first — no results yet.</div></div></div>`)); return; }
  const card = h(`<div class="card"><div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.chart("x")}</div><h3>Project Analysis</h3><span class="sub">baseline vs proposed — EUI · energy · carbon · cost</span></div><div id="wz-analysis"></div></div>`);
  content.appendChild(card);
  renderAnalysis(card.querySelector("#wz-analysis") as HTMLElement, store.blRows, store.propRows, "wz");
}

/* ---------- Basic Info (shared by the create popup + editable step 1) ---------- */
const RATING_SYSTEMS = ["NA", "LEED", "GRIHA", "IGBC", "BREEAM", "Estidama", "Manual input"];

/** Build the Basic Info form into `host` and wire it. The primary button
 *  creates (or updates) the project, seeds projectInfo/rates, then calls
 *  `onSaved`. Used both inside the create popup and as the editable step 1. */
function renderBasicInfo(host: HTMLElement, opts: { primaryLabel: string; onSaved: () => void }) {
  const p = store.currentProject;
  const pi: ProjectInfo = store.projectInfo || {};
  const modelType: Project["modelType"] = p?.modelType || "equest"; // model type is chosen later (section 3)
  const c = store.rates;

  const ratingOpts = (v?: string) => RATING_SYSTEMS.map((r) => `<option ${r === v ? "selected" : ""}>${esc(r)}</option>`).join("");
  const stateOpts = (v?: string) => `<option value="">— select —</option>` + Object.keys(STATE_NAMES).map((s) => `<option value="${s}" ${s === v ? "selected" : ""}>${s} — ${esc(STATE_NAMES[s])}</option>`).join("");
  const countryOpts = (v?: string) => ["USA", "Canada"].map((k) => `<option ${k === (v || "USA") ? "selected" : ""}>${k}</option>`).join("");
  const cityOpt = (v?: string) => v ? `<option value="${esc(v)}" selected>${esc(v)}</option>` : `<option value="">— locate to fill —</option>`;
  const btypeList = ZT_BUILDING_TYPES.map((b) => `<option value="${esc(b)}"></option>`).join("");
  const initCity = (pi.projectLocation ? pi.projectLocation.split(",")[0].trim() : "") || c.city || "";

  const card = h(`<div class="card">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.bolt()}</div><h3>Basic Info</h3><span class="sub">${p ? "editing the current project" : "creates a new project"}</span></div>
    <div class="grid cards-2" style="gap:12px;margin-top:6px">
      <div class="field"><label>Project name</label><input id="wz-name" placeholder="e.g. KP Parker Hospital" value="${esc(p?.name || "")}" /></div>
      <div class="field"><label>Client name <span style="color:var(--g400)">(report footer)</span></label><input id="wz-client" placeholder="e.g. Kaiser Permanente" value="${esc(pi.clientName || "")}" /></div>
      <div class="field"><label>Document phase</label><input id="wz-dphase" placeholder="e.g. Schematic Design" value="${esc(pi.documentPhase || "")}" /></div>
      <div class="field"><label>Document name</label><input id="wz-dname" placeholder="e.g. Architectural set Rev 3" value="${esc(pi.referenceDocument || "")}" /></div>
    </div>
    <div class="field" style="margin-top:12px"><label>Project building type <span style="color:var(--g400)">(AIA / Zero Tool — pick or type your own)</span></label>
      <input id="wz-btype" list="wz-btype-list" placeholder="e.g. Office, K12School, Hospital" value="${esc(pi.programType || "")}" />
      <datalist id="wz-btype-list">${btypeList}</datalist>
    </div>

    <div class="subsection" style="margin-top:16px">Project Location <span class="line"></span></div>
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:6px">
      <div class="field" style="flex:1;min-width:180px"><label>Pincode / ZIP</label><input id="wz-zip" placeholder="e.g. 92069" value="${esc(pi.pincode || c.pincode || "")}" /></div>
      <button class="btn btn-sm btn-dark" id="wz-locate" type="button">${ICON.pin("x")} Locate</button>
      <span id="wz-loc-status" style="font-size:12px;color:var(--g500);flex-basis:100%"></span>
    </div>
    <div class="grid cards-3" style="gap:12px;margin-top:8px">
      <div class="field"><label>City</label><select id="wz-city" class="unit-pick" style="width:100%">${cityOpt(initCity)}</select></div>
      <div class="field"><label>State</label><select id="wz-state" class="unit-pick" style="width:100%">${stateOpts(c.state)}</select></div>
      <div class="field"><label>Country</label><select id="wz-country" class="unit-pick" style="width:100%">${countryOpts(c.country)}</select></div>
    </div>

    <div class="subsection" style="margin-top:16px">Green Building Certification <span class="line"></span></div>
    <div class="grid cards-3" style="gap:12px;margin-top:6px">
      <div class="field"><label>Rating system</label><select id="wz-rsys" class="unit-pick" style="width:100%"><option value="">— select —</option>${ratingOpts(pi.ratingSystem)}</select></div>
      <div class="field"><label>Version</label><input id="wz-rver" placeholder="e.g. v4.1" value="${esc(pi.ratingVersion || "")}" /></div>
      <div class="field"><label>Type</label><input id="wz-rtype" placeholder="e.g. New Construction" value="${esc(pi.ratingType || "")}" /></div>
    </div>

    <div class="subsection" style="margin-top:16px">Weather File <span class="line"></span></div>
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:6px">
      <div class="field" style="flex:1;min-width:260px"><label>Nearest EPW file (name · type · distance to pincode)</label>
        <select id="wz-weather" class="unit-pick" style="width:100%"><option value="">${pi.weatherFile ? esc(pi.weatherFile) + (pi.weatherFileType ? ` · ${esc(pi.weatherFileType)}` : "") : "— find nearest to a pincode —"}</option></select></div>
      <button class="btn btn-sm" id="wz-weather-find" type="button">${ICON.pin("x")} Find nearest 5</button>
      <a class="btn btn-sm" id="wz-weather-dl" href="#" download target="_blank" rel="noopener" title="Download all weather files (.zip)" style="pointer-events:none;opacity:.5">${ICON.download()} Download</a>
    </div>

    <div class="subsection" style="margin-top:16px">Code Compliance <span class="line"></span></div>
    <div class="grid cards-2" style="gap:12px;margin-top:6px">
      <div class="field"><label>Energy Code Name <span style="color:var(--g400)">(manual)</span></label><input id="wz-code" placeholder="e.g. ASHRAE 90.1-2019 / IECC 2021" value="${esc(pi.energyCodeStandard || "")}" /></div>
      <div class="field"><label>Reference ASHRAE version</label><input id="wz-ashrae" placeholder="e.g. ASHRAE 90.1-2019" value="${esc(pi.ashraeVersion || "")}" /></div>
    </div>

    <div style="display:flex;gap:10px;margin-top:20px">
      <button class="btn btn-primary" id="wz-create" style="flex:1;justify-content:center">${esc(opts.primaryLabel)}</button>
    </div>
  </div>`);

  const citySel = card.querySelector("#wz-city") as HTMLSelectElement;
  const stateSel = card.querySelector("#wz-state") as HTMLSelectElement;
  const countrySel = card.querySelector("#wz-country") as HTMLSelectElement;

  // Locate — derive city / state / country from the pincode.
  card.querySelector("#wz-locate")!.addEventListener("click", async () => {
    const zip = (card.querySelector("#wz-zip") as HTMLInputElement).value.trim();
    if (!zip) { toast("Enter a pincode / ZIP first"); return; }
    const status = card.querySelector("#wz-loc-status") as HTMLElement;
    status.innerHTML = `<span class="spinner" style="width:11px;height:11px;vertical-align:middle"></span> Locating…`;
    try {
      const info = await geocodeAddress({ pincode: zip });
      if (info.city) citySel.innerHTML = `<option value="${esc(info.city)}" selected>${esc(info.city)}</option>`;
      if (info.state) stateSel.value = info.state;
      if (info.country) countrySel.value = /canada/i.test(info.country) ? "Canada" : "USA";
      c.pincode = zip; c.lat = info.lat; c.lon = info.lon; c.state = info.state || c.state; c.city = info.city || c.city; c.country = countrySel.value;
      status.innerHTML = `<span style="color:var(--green,#16a34a)">✓ ${esc([info.city, info.stateName, info.country].filter(Boolean).join(", "))}</span>`;
    } catch (e: any) { status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
  });

  // Weather picker — geocode the pincode, then rank the nearest real EPW files.
  const weatherSel = card.querySelector("#wz-weather") as HTMLSelectElement;
  const dlLink = card.querySelector("#wz-weather-dl") as HTMLAnchorElement;
  let nearFiles: WeatherFile[] = [];
  const selectedFile = () => nearFiles.find((f) => f.name === weatherSel.value) || null;
  const refreshLinks = () => {
    const f = selectedFile();
    const href = f ? (f.zipUrl || f.epwUrl) : "";        // whole-station .zip preferred
    dlLink.href = href || "#"; dlLink.style.pointerEvents = href ? "auto" : "none"; dlLink.style.opacity = href ? "1" : ".5";
  };
  weatherSel.addEventListener("change", refreshLinks);

  const findWeather = async () => {
    const zip = (card.querySelector("#wz-zip") as HTMLInputElement).value.trim();
    if (!zip) { toast("Enter a pincode / ZIP first"); return; }
    const btn = card.querySelector("#wz-weather-find") as HTMLButtonElement; btn.disabled = true; const label = btn.innerHTML; btn.innerHTML = `<span class="spinner" style="width:11px;height:11px"></span> Finding…`;
    try {
      const info = await geocodeAddress({ pincode: zip });
      nearFiles = await nearestWeatherFiles(info.lat, info.lon, 5);
      if (!nearFiles.length) { toast("No weather files found nearby"); return; }
      const prev = weatherSel.value || pi.weatherFile || "";
      weatherSel.innerHTML = `<option value="">— select a weather file —</option>` +
        nearFiles.map((f) => `<option value="${esc(f.name)}" ${f.name === prev ? "selected" : ""}>${esc(f.title)} · ${esc(f.type)} · ${Math.round(f.miles)} mi</option>`).join("");
      if (!weatherSel.value) weatherSel.selectedIndex = 1; // default to the nearest
      refreshLinks();
      toast(`✓ ${nearFiles.length} nearest weather files`);
    } catch (e: any) { toast("Weather lookup failed — " + e.message); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  };
  card.querySelector("#wz-weather-find")!.addEventListener("click", findWeather);

  card.querySelector("#wz-create")!.addEventListener("click", async () => {
    const gv = (id: string) => (card.querySelector("#" + id) as HTMLInputElement).value.trim();
    const name = gv("wz-name") || "Untitled Project";
    const zip = gv("wz-zip");
    const city = citySel.value, state = stateSel.value, country = countrySel.value;
    const addr = [city, STATE_NAMES[state] || state, country].filter(Boolean).join(", ");
    const btn = card.querySelector("#wz-create") as HTMLButtonElement; btn.disabled = true;
    try {
      let proj: Project | null = store.currentProject;
      if (!proj) {
        const res = await Projects.create(name, addr, modelType);
        proj = res.project as Project;
      } else {
        proj.name = name; proj.address = addr; proj.modelType = modelType;
        await Projects.update(proj.id, { name, address: addr, modelType });
      }
      if (!proj) { toast("Create failed"); btn.disabled = false; return; }
      store.currentProject = proj;
      const info: ProjectInfo = {
        ...(store.projectInfo || {}),
        projectName: name,
        clientName: gv("wz-client") || undefined,
        documentPhase: gv("wz-dphase") || undefined,
        referenceDocument: gv("wz-dname") || undefined,
        programType: gv("wz-btype") || undefined,
        pincode: zip || undefined,
        projectLocation: [city, state].filter(Boolean).join(", ") || undefined,
        ratingSystem: (card.querySelector("#wz-rsys") as HTMLSelectElement).value || undefined,
        ratingVersion: gv("wz-rver") || undefined,
        ratingType: gv("wz-rtype") || undefined,
        weatherFile: weatherSel.value || undefined,
        weatherFileType: selectedFile()?.type || (store.projectInfo || {}).weatherFileType,
        energyCodeStandard: gv("wz-code") || undefined,
        ashraeVersion: gv("wz-ashrae") || undefined,
      };
      store.projectInfo = info;
      if (zip) c.pincode = zip;
      if (state) c.state = state;
      if (city) c.city = city;
      if (country) c.country = country;
      await Projects.update(proj.id, { projectInfo: info } as any);
      (proj as any).projectInfo = info;
      emit();
      opts.onSaved();
    } catch (e: any) { toast("Create failed — " + e.message); btn.disabled = false; }
  });

  host.appendChild(card);
}

/* ---------- STEP 1 · Basic Info (pre-filled, editable) ---------- */
function stepNaming(content: HTMLElement) {
  const root = () => (content.closest(".content") as HTMLElement) || (content.parentElement as HTMLElement);
  renderBasicInfo(content, {
    primaryLabel: store.currentProject ? "Save & continue →" : "Create project & continue →",
    onSaved: () => goStep(root(), 2),
  });
}

/* ---------- Basic Info create popup ---------- */
let basicInfoModalOpen = false;
function openBasicInfoModal(root: HTMLElement) {
  if (basicInfoModalOpen) return;
  basicInfoModalOpen = true;
  const overlay = h(`<div class="modal-overlay"><div class="modal" style="width:min(720px,95vw)"><div class="modal-hd"><h3>New Project — Basic Info</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body" id="bi-body"></div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); basicInfoModalOpen = false; setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  // Intentionally NO backdrop-click close — the user must fill Basic Info or hit X.
  renderBasicInfo(overlay.querySelector("#bi-body") as HTMLElement, {
    primaryLabel: "Create & open wizard →",
    onSaved: () => { close(); goStep(root, 1); }, // land on step 1, now pre-filled
  });
}

/* ---------- STEP 3 · Model (upload/parse + inline setup + values) ---------- */
function stepModel(content: HTMLElement) {
  // The full Marcus workspace embedded (parse + inline setup + rates recap +
  // graphs + collapsed analysis/AI). The Document & cost details card is
  // injected right after the file/parse card by renderMarcus in embed mode.
  const mk = h(`<div></div>`);
  content.appendChild(mk);
  renderMarcus(mk, { embedded: true });
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

/* The remaining Document-Phase values (Image #9), collected inline in Section 3
 * alongside the parsed model values — no separate popup. Client, certification,
 * ASHRAE, weather etc. were already captured in Basic Info (step 1). */
function remainingValuesCard(): HTMLElement {
  const pi: ProjectInfo = store.projectInfo || {};
  const modelType = store.currentProject?.modelType || pi.programType || "—";
  const txt = (id: string, val: any, ph = "") => `<input id="${id}" value="${val == null ? "" : esc(String(val))}" placeholder="${esc(ph)}" />`;
  const sel = (id: string, opts: string[], val: string) => `<select class="unit-pick" id="${id}" style="width:100%"><option value="">— select —</option>${opts.map((o) => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;

  const card = h(`<div class="card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.book()}</div><h3>Document &amp; cost details</h3><span class="sub">completes the values that feed the Excel &amp; report</span></div>
    <div class="grid cards-2" style="gap:12px;margin-top:6px">
      <div class="field"><label>Document phase</label>${txt("rd-phase", pi.documentPhase, "e.g. Schematic Design")}</div>
      <div class="field"><label>Document name</label>${txt("rd-refdoc", pi.referenceDocument, "e.g. Architectural set Rev 3")}</div>
      <div class="field"><label>Report date</label>${txt("rd-date", pi.reportDate, "defaults to today")}</div>
      <div class="field"><label>Model type</label><input value="${esc(String(modelType))}" disabled style="background:var(--g50)" /></div>
      <div class="field"><label>Energy cost data source</label>${sel("rd-costsrc", COST_SOURCES, pi.costDataSource || "")}</div>
      <div class="field"><label>Cost source note</label>${txt("rd-costnote", pi.costDataSourceNote, "optional qualifier")}</div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;cursor:pointer"><input type="checkbox" id="rd-shading" ${pi.adjacentShading ? "checked" : ""} /> Model includes adjacent shading structures (neighboring buildings &amp; trees)</label>
    <div style="display:flex;gap:10px;margin-top:16px;align-items:center"><button class="btn btn-primary" id="rd-save">${ICON.bolt()} Save details</button><span id="rd-status" style="font-size:12px;color:var(--g500)"></span></div>
  </div>`);

  const gv = (id: string) => (card.querySelector("#" + id) as HTMLInputElement)?.value.trim();
  card.querySelector("#rd-save")!.addEventListener("click", async () => {
    const info: ProjectInfo = {
      ...(store.projectInfo || {}),
      documentPhase: gv("rd-phase") || undefined,
      referenceDocument: gv("rd-refdoc") || undefined,
      reportDate: gv("rd-date") || undefined,
      costDataSource: gv("rd-costsrc") || undefined,
      costDataSourceNote: gv("rd-costnote") || undefined,
      adjacentShading: (card.querySelector("#rd-shading") as HTMLInputElement).checked,
    };
    store.projectInfo = info; emit();
    const status = card.querySelector("#rd-status") as HTMLElement;
    try {
      if (store.currentProject) { await Projects.update(store.currentProject.id, { projectInfo: info } as any); (store.currentProject as any).projectInfo = info; }
      status.innerHTML = `<span style="color:var(--green,#16a34a)">✓ Saved</span>`;
      toast("✓ Details saved");
    } catch (e: any) { status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || e)}</span>`; }
  });

  return card;
}

/* ---------- STEP 2 · Utility rates ---------- */
function stepRates(content: HTMLElement) {
  const r = h(`<div></div>`);
  content.appendChild(r);
  renderRates(r, { embedded: true });
}

/* ---------- STEP 4 · Excel generation ---------- */
function stepExcel(content: HTMLElement) {
  const haveRows = store.blRows.length + store.propRows.length > 0;
  const card = h(`<div class="card">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.table()}</div><h3>Generate the Excel workbook</h3><span class="sub">Energy Results Comparison (.xlsx)</span></div>
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
