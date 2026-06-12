/* ============================================================
 *  Marcus — unified model-parser hub.
 *  Projects → model selection (eQUEST / TRACE / IES-VE) → parse →
 *  logs → Project Analysis → utility rates → AI search.
 * ============================================================ */
import { store, emit, logClear, logLine } from "../store";
import { Projects, Rates, Project, RateSet } from "../api";
import { h, esc, toast, fmt, fmtCompact } from "../ui/util";
import { ICON } from "../ui/icons";
import { SIMParser, Row } from "../engine/sim";
import { INPParser } from "../engine/inp";
import { loadTracePages } from "../engine/trace-load";
import { parseTrace, traceModels } from "../engine/trace";
import { enrichRow } from "../engine/enrich";
import { buildWorkbook, downloadWorkbook } from "../engine/workbook";
import { COLUMNS } from "../engine/columns";
import { renderAnalysis } from "./analysis";
import { navigate } from "../ui/shell";
import { infoBoxes } from "../ui/infoboxes";

const MODELS: { key: Project["modelType"]; name: string; icon: string; sub: string; soon?: boolean }[] = [
  { key: "equest", name: "eQUEST", icon: "🏢", sub: ".SIM / .inp (DOE-2.2)" },
  { key: "trace", name: "TRACE 3D Plus", icon: "📑", sub: "report PDF" },
  { key: "iesve", name: "IES-VE", icon: "🧪", sub: "under development", soon: true },
];

export async function renderMarcus(root: HTMLElement) {
  if (!store.currentProject) return renderPicker(root);
  renderWorkspace(root, store.currentProject);
}

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
  emit(); rerender(root);
}

/* ============================================================ WORKSPACE */
function renderWorkspace(root: HTMLElement, p: Project) {
  const m = MODELS.find((x) => x.key === p.modelType)!;
  root.appendChild(h(`
    <div class="page-head">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-sm" id="mk-back">← Projects</button>
        <div><h1 style="font-size:23px">${esc(p.name)}</h1><p>${esc(p.address || "no address")} · <span class="pt-badge pt-${p.modelType}">${esc(m.name)}</span></p></div>
      </div>
      <div class="actions">
        <button class="btn" id="mk-edit">Edit</button>
        <button class="btn btn-primary ${store.blRows.length + store.propRows.length ? "" : "hide"}" id="mk-export">${ICON.download()} Export Excel</button>
      </div>
    </div>
  `));
  root.appendChild(infoBoxes(
    [
      "Pick the <b>model type</b> below (eQUEST / TRACE / IES-VE) to match your files.",
      "Upload the baseline &amp; proposed <b>.SIM / .inp</b> (or the TRACE report PDF) and hit <b>Parse</b>.",
      "Review <b>Project Analysis</b>, confirm the <b>Utility Rates</b>, then <b>Export Excel</b>.",
      "Use <b>AI Search</b> to pull any value out of the parsed model.",
    ],
    [
      "A normalized set of baseline &amp; proposed energy results.",
      "Dashboards (EUI, energy, carbon, cost) identical across model types.",
      "A downloadable Excel workbook with every metric.",
      "Rates and citations carried straight into cost &amp; carbon.",
    ],
  ));

  root.querySelector("#mk-back")!.addEventListener("click", () => { store.currentProject = null; rerender(root); });
  root.querySelector("#mk-edit")!.addEventListener("click", () => editProjectModal(root, p));
  root.querySelector("#mk-export")?.addEventListener("click", async () => {
    try {
      const wb = await buildWorkbook(store.blRows, store.propRows, store.rates, { projectName: p.name });
      downloadWorkbook(wb, `${p.name.replace(/\W+/g, "_")}_energy_results.xlsx`);
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

  // files
  root.appendChild(fileSection(root, p));

  // logs
  root.appendChild(logsAccordion());

  // project analysis (expandable, after logs)
  root.appendChild(analysisAccordion(root));

  // utility rates used
  root.appendChild(ratesAccordion(root, p));

  // AI search
  root.appendChild(aiAccordion());
}

/* ---------- files ---------- */
function fileSection(root: HTMLElement, p: Project): HTMLElement {
  const isPdf = p.modelType !== "equest";
  const card = h(`<div class="card" style="margin-top:16px"><div class="card-hd"><h3>Files</h3><span class="sub">${isPdf ? "TRACE report PDF" : "Baseline & Proposed .SIM / .inp"}</span><div class="right"><button class="btn btn-primary btn-sm" id="mk-parse">${ICON.bolt()} Parse</button></div></div></div>`);

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
  logClear();
  const prog = document.getElementById("mk-prog")!; const bar = document.getElementById("mk-prog-b") as HTMLElement;
  const pl = document.getElementById("mk-prog-l")!; const pp = document.getElementById("mk-prog-p")!;
  prog.classList.remove("hide");
  try {
    let models: ParsedModel[] = [];
    if (p.modelType === "equest") {
      pl.textContent = "Parsing eQUEST models…";
      models = await parseEquestModels(p);
      bar.style.width = "100%"; pp.textContent = "100%";
    } else if (p.modelType === "trace") {
      const pdf = p.files.find((f) => f.ext === ".pdf");
      if (!pdf) throw new Error("upload a TRACE PDF first");
      const buf = await Projects.fileBlob(p.id, pdf.id);
      const pages = await loadTracePages(buf, (d, t) => { const x = Math.round((d / t) * 100); bar.style.width = x + "%"; pp.textContent = x + "%"; pl.textContent = `Reading page ${d}/${t}…`; });
      const report = parseTrace(pages, pdf.name); store.trace = report;
      // Section 1.6 supplies the baseline's 0/90/180/270 rotations — expand & pre-tag them
      models = traceModels(report).map((m) => ({ name: m.name, row: m.row, cat: m.cat, rot: m.rot }));
    } else throw new Error("IES-VE parser is under development");

    if (!models.length) throw new Error("no models parsed — check the uploaded files");
    prog.classList.add("hide");
    logLine(`<span class="ok">✓ Parsed ${models.length} model(s) — assign each below</span>`); paintLog();
    classifyModal(root, p, models);            // human-in-the-loop assignment
  } catch (e: any) {
    logLine(`<span class="err">✗ ${esc(e.message)}</span>`);
    toast("Parse failed — " + e.message); paintLog();
  }
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

/* ---------- classification modal (human in the loop) ---------- */
function classifyModal(root: HTMLElement, p: Project, models: ParsedModel[]) {
  const rowHtml = (m: ParsedModel, i: number) => {
    const g = guessClass(m.name);
    const cat = m.cat ?? g.cat;          // engine-supplied (e.g. TRACE §1.6 rotations) wins over the name guess
    const rot = m.rot ?? g.rot;
    const rotSel = `<select class="unit-pick cm-rot" data-i="${i}" ${cat === "proposed" ? "disabled" : ""}>${[0, 90, 180, 270].map((d) => `<option value="${d}" ${d === rot ? "selected" : ""}>${d}°</option>`).join("")}</select>`;
    return `<div style="display:grid;grid-template-columns:1fr 148px 84px;gap:10px;align-items:center;margin-bottom:9px">
      <div style="font-size:12.5px;font-weight:600;word-break:break-word">${esc(m.name)}</div>
      <select class="unit-pick cm-cat" data-i="${i}">
        <option value="leed" ${cat === "leed" ? "selected" : ""}>LEED Baseline</option>
        <option value="code" ${cat === "code" ? "selected" : ""}>Code Baseline</option>
        <option value="proposed" ${cat === "proposed" ? "selected" : ""}>Proposed</option>
      </select>${rotSel}</div>`;
  };
  const overlay = h(`
    <div class="modal-overlay"><div class="modal" style="max-width:660px"><div class="modal-hd"><h3>Assign models</h3><span class="x">${ICON.close("x")}</span></div>
      <div class="modal-body">
        <p style="font-size:12.5px;color:var(--g500);margin-bottom:14px">Tell us what each parsed model is. <b>LEED</b> rotations fill the first 4 rows of <b>BL Data</b> (0°/90°/180°/270°), <b>Code</b> rotations the next 4; <b>Proposed</b> cases fill the <b>Proposed Data</b> sheet in order.</p>
        <div style="display:grid;grid-template-columns:1fr 148px 84px;gap:10px;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--g400);margin-bottom:8px"><div>Model</div><div>Category</div><div>Rotation</div></div>
        ${models.map(rowHtml).join("")}
        <button class="btn btn-primary" id="cm-go" style="width:100%;justify-content:center;margin-top:16px">${ICON.bolt()} Populate</button>
      </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.querySelectorAll<HTMLSelectElement>(".cm-cat").forEach((sel) => sel.addEventListener("change", () => {
    (overlay.querySelector(`.cm-rot[data-i="${sel.dataset.i}"]`) as HTMLSelectElement).disabled = sel.value === "proposed";
  }));
  overlay.querySelector("#cm-go")!.addEventListener("click", () => {
    const bl: Row[] = [], prop: Row[] = [];
    models.forEach((m, i) => {
      const cat = (overlay.querySelector(`.cm-cat[data-i="${i}"]`) as HTMLSelectElement).value as "leed" | "code" | "proposed";
      const rot = +(overlay.querySelector(`.cm-rot[data-i="${i}"]`) as HTMLSelectElement).value;
      m.row._cat = cat; m.row._rot = cat === "proposed" ? 0 : rot;
      (cat === "proposed" ? prop : bl).push(m.row);
    });
    close();
    finishParse(root, p, bl, prop);
  });
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

async function finishParse(root: HTMLElement, p: Project, bl: Row[], prop: Row[]) {
  // proposed rotations → one averaged final proposed
  if (prop.length > 1) { logLine(`<span class="dim">› averaged ${prop.length} proposed rotations → 1 final proposed</span>`); prop = [averageRows(prop)]; }
  store.blRows = bl; store.propRows = prop;
  logLine(`<span class="ok">✓ Assigned ${bl.length} baseline · ${prop.length} proposed</span>`);
  const summary = computeSummary(bl, prop);
  await Projects.update(p.id, { parsed: { bl, prop, summary }, modelType: p.modelType });
  p.parsed = { bl, prop, summary } as any;
  emit(); toast(`✓ Populated ${bl.length + prop.length} model(s)`);
  rerender(root);
  setTimeout(() => { const a = document.getElementById("acc-analysis"); a?.classList.add("open"); document.getElementById("acc-analysis-body") && drawAnalysis(); a?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
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
  const acc = simpleAcc("acc-logs", "Logs", "parse output", body, true);
  setTimeout(paintLog, 0);
  return acc;
}
function paintLog() { const el = document.getElementById("mk-log"); if (el) el.innerHTML = store.log.length ? store.log.join("\n") : `<span class="dim">Upload files and click Parse.</span>`; }

let analysisRoot: HTMLElement | null = null;
function analysisAccordion(root: HTMLElement): HTMLElement {
  const body = h(`<div id="mk-analysis"></div>`);
  analysisRoot = body;
  const acc = simpleAcc("acc-analysis", "Project Analysis", "dashboards (same for every model type)", body, store.blRows.length + store.propRows.length > 0, () => drawAnalysis());
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
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${store.openaiKey}` },
    body: JSON.stringify({
      model: store.openaiModel,
      messages: [
        { role: "system", content: "You answer questions about a parsed building energy model. Use ONLY the provided JSON data. Reply as JSON {\"answer\":\"one sentence\",\"value\":\"the number with units, or empty\",\"where\":\"which field/model it came from\"}." },
        { role: "user", content: `Data: ${JSON.stringify(ctx)}\n\nQuestion: ${query}` },
      ],
      temperature: 0, response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
  const data = await resp.json();
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

function rerender(root: HTMLElement) { root.innerHTML = ""; renderMarcus(root); }
