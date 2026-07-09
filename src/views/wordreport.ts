/* ============================================================
 *  WORD REPORT — auto-fill the "Energy Model Report" .docx.
 *  The user uploads their QA/QC-ed Energy Results Comparison workbook;
 *  we fill the report's data tables and drop in the Site / Source /
 *  Carbon / Cost charts (native, exact colours), then download the .docx.
 * ============================================================ */
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { infoBoxes } from "../ui/infoboxes";
import { buildWordReport, ReportFields } from "../engine/wordreport";
import templateUrl from "../assets/report_template.docx?url";

let xlsxFile: File | null = null;
let renderingFile: File | null = null;
let modelSnipFile: File | null = null;
let busy = false;
// When launched from the wizard's step 5, the workbook generated in step 4 and
// the stored report fields are supplied here so no re-upload is required.
let providedXlsx: { buf: ArrayBuffer; name: string } | null = null;
let providedFields: ReportFields | null = null;

const readBuf = (f: File): Promise<ArrayBuffer> =>
  new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(f); });
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function renderWordReport(root: HTMLElement, opts: { embedded?: boolean; excel?: { buf: ArrayBuffer; name: string } | null; projectInfo?: ReportFields } = {}) {
  xlsxFile = null; renderingFile = null; modelSnipFile = null; busy = false;
  providedXlsx = opts.excel || null;
  providedFields = opts.projectInfo || null;

  if (!opts.embedded) root.appendChild(h(`
    <div class="page-head">
      <div>
        <h1>Word Report <span class="pill pill-red" style="font-size:10px;vertical-align:middle">new</span></h1>
        <p>Upload your QA/QC-ed <b>Energy Results Comparison</b> workbook and auto-generate the formatted
        <b>Energy Model Report</b> — data tables filled and the Site, Source, Carbon &amp; Cost charts dropped in, exactly as styled.</p>
      </div>
    </div>
  `));

  root.appendChild(infoBoxes(
    [
      "Finish &amp; <b>QA/QC the comparison workbook</b> (the Excel exported from Marcus).",
      "Drop that <b>.xlsx</b> below and click <b>Generate report</b>.",
      "Open the downloaded <b>.docx</b>, fill the remaining narrative <span class='muted-tag'>[bracketed]</span> text, and ship it.",
    ],
    [
      "Result Summary, Unmet Hours, Virtual Rates &amp; the Energy / Carbon / Cost end-use tables — filled.",
      "Native <b>Site, Source, Carbon &amp; Cost charts</b> inserted next to their tables — exact colours &amp; UI.",
      "A ready-to-edit Word document built on your firm's template.",
    ],
  ));

  root.appendChild(uploadCard(root));
  root.appendChild(imagesCard(root));
  root.appendChild(genCard(root));
  refresh(root);
}

/* ---------- optional images (project rendering + model snip) ---------- */
function imageDrop(id: string, title: string, hint: string): string {
  return `<div>
    <div style="font-weight:700;font-size:13px;margin-bottom:6px">${title}</div>
    <label class="dropzone" id="${id}-dz" style="padding:18px">
      <input type="file" accept="image/png,image/jpeg" hidden />
      <div class="dz-ico">🖼️</div>
      <div class="dz-t">Drop a PNG/JPEG or click to browse</div>
      <div class="dz-h">${hint}</div>
    </label>
    <div class="chips" id="${id}-file" style="margin-top:10px"></div>
  </div>`;
}
function imagesCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" style="margin-bottom:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">🖼️</div>
      <h3>2 · Insert images <span style="font-weight:500;color:var(--g400);font-size:12px">(optional)</span></h3><span class="sub">project rendering &amp; a snip of your model</span></div>
    <div class="grid cards-2" style="margin-top:6px;gap:18px">
      ${imageDrop("wr-render", "Project Rendering", "shown on the cover (replaces “[Insert Project Rendering]”)")}
      ${imageDrop("wr-snip", "Model Snip", "shown as Figure 1: Energy Model")}
    </div>
  </div>`);
  const bindImg = (id: string, set: (f: File | null) => void) => {
    const dz = card.querySelector(`#${id}-dz`) as HTMLElement;
    const input = dz.querySelector("input") as HTMLInputElement;
    const pick = (files?: FileList | null) => {
      const f = files && files[0];
      if (!f) return;
      if (!/\.(png|jpe?g)$/i.test(f.name)) { toast("Please upload a PNG or JPEG image"); return; }
      set(f); refresh(root);
    };
    input.addEventListener("change", (e) => pick((e.target as HTMLInputElement).files));
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => pick((e as DragEvent).dataTransfer?.files));
  };
  bindImg("wr-render", (f) => renderingFile = f);
  bindImg("wr-snip", (f) => modelSnipFile = f);
  return card;
}

/* ---------- upload ---------- */
function uploadCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" style="margin-bottom:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.table().replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div>
      <h3>1 · Upload the comparison workbook</h3><span class="sub">Energy Results Comparison (.xlsx)</span></div>
    <label class="dropzone" id="wr-dz" style="margin-top:6px">
      <input type="file" accept=".xlsx" hidden />
      <div class="dz-ico">📊</div>
      <div class="dz-t">Drop the .xlsx here or click to browse</div>
      <div class="dz-h">the workbook you exported &amp; QA/QC-ed in Marcus</div>
    </label>
    ${providedXlsx ? `<div class="source-note" style="margin-top:12px;border-left-color:var(--green,#16a34a)">Using <b>${esc(providedXlsx.name)}</b> generated in Step 4 — drop a file above to override.</div>` : ""}
    <div class="chips" id="wr-file" style="margin-top:14px"></div>
  </div>`);
  const dz = card.querySelector("#wr-dz") as HTMLElement;
  const input = dz.querySelector("input") as HTMLInputElement;
  const pick = (files?: FileList | null) => {
    const f = files && files[0];
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { toast("Please upload a .xlsx workbook"); return; }
    xlsxFile = f; refresh(root);
  };
  input.addEventListener("change", (e) => pick((e.target as HTMLInputElement).files));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => pick((e as DragEvent).dataTransfer?.files));
  return card;
}

/* ---------- generate ---------- */
function genCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.book().replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div>
      <h3>3 · Generate the report</h3><span class="sub">fills tables + embeds charts</span></div>
    <div class="grid cards-4" id="wr-feats" style="margin-top:6px">
      ${feat("📈", "Site &amp; Source", "End-use energy charts")}
      ${feat("🟢", "Carbon", "Emissions by end use")}
      ${feat("💲", "Cost", "Energy cost by end use")}
      ${feat("🧮", "Data tables", "Summary · unmet · rates")}
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap">
      <button class="btn btn-primary" id="wr-go" disabled>${ICON.bolt()} Generate report</button>
      <span id="wr-status" style="font-size:13px;color:var(--g500)"></span>
    </div>
  </div>`);
  card.querySelectorAll<HTMLElement>("#wr-feats > div").forEach((el) => { el.style.opacity = ".55"; });
  card.querySelector("#wr-go")!.addEventListener("click", () => generate(root));
  return card;
}
function feat(icon: string, title: string, sub: string): string {
  return `<div style="border:1px solid var(--g200);border-radius:12px;padding:14px 16px">
    <div style="font-size:20px;margin-bottom:6px">${icon}</div>
    <div style="font-family:var(--font);font-weight:800;font-size:14px">${title}</div>
    <div style="font-size:12px;color:var(--g500);margin-top:2px">${sub}</div></div>`;
}

function fileChip(root: HTMLElement, sel: string, label: string, file: File | null, clear: () => void) {
  const list = root.querySelector(sel);
  if (!list) return;
  list.innerHTML = "";
  if (file) {
    const chip = h(`<span class="chip"><b style="font-weight:600">${esc(label)}</b> ${esc(file.name)} <span class="x">×</span></span>`);
    chip.querySelector(".x")!.addEventListener("click", () => { clear(); refresh(root); });
    list.appendChild(chip);
  }
}
function refresh(root: HTMLElement) {
  fileChip(root, "#wr-file", "workbook", xlsxFile, () => xlsxFile = null);
  fileChip(root, "#wr-render-file", "rendering", renderingFile, () => renderingFile = null);
  fileChip(root, "#wr-snip-file", "model snip", modelSnipFile, () => modelSnipFile = null);
  const ready = !!xlsxFile || !!providedXlsx;
  const go = root.querySelector("#wr-go") as HTMLButtonElement | null;
  if (go) go.disabled = !ready || busy;
  root.querySelectorAll<HTMLElement>("#wr-feats > div").forEach((el) => { el.style.opacity = ready ? "1" : ".55"; el.style.transition = "opacity .2s"; });
}

async function generate(root: HTMLElement) {
  if ((!xlsxFile && !providedXlsx) || busy) return;
  busy = true;
  const status = root.querySelector("#wr-status") as HTMLElement;
  const go = root.querySelector("#wr-go") as HTMLButtonElement;
  go.disabled = true;
  status.innerHTML = `<span class="spinner" style="width:13px;height:13px;vertical-align:middle"></span> Reading workbook & building report…`;
  try {
    const extOf = (f: File) => (f.name.match(/\.(png|jpe?g)$/i)?.[1] || "png").toLowerCase().replace("jpeg", "jpg");
    // Use the uploaded workbook when present, else the one generated in step 4.
    const srcName = xlsxFile ? xlsxFile.name : providedXlsx!.name;
    const [xlsxBuf, tplResp, renderBuf, snipBuf] = await Promise.all([
      xlsxFile ? readBuf(xlsxFile) : Promise.resolve(providedXlsx!.buf), fetch(templateUrl),
      renderingFile ? readBuf(renderingFile) : Promise.resolve(null),
      modelSnipFile ? readBuf(modelSnipFile) : Promise.resolve(null),
    ]);
    if (!tplResp.ok) throw new Error(`report template not found (HTTP ${tplResp.status})`);
    const docxBuf = await tplResp.arrayBuffer();
    const blob = await buildWordReport(xlsxBuf, docxBuf, {
      projectRendering: renderBuf && renderingFile ? { buf: renderBuf, ext: extOf(renderingFile) } : null,
      modelSnip: snipBuf && modelSnipFile ? { buf: snipBuf, ext: extOf(modelSnipFile) } : null,
      exportDate: new Date(),
      fallbackTitle: srcName.replace(/\.xlsx$/i, "").replace(/[_-]+/g, " "),
      projectInfo: providedFields || undefined,
    });
    // Name the report "<projectName>_Energy Results Comparision Report.docx".
    // The workbook is "<projectName>_Energy Results Comparision.xlsx", so strip
    // that trailing tag (any spacing/spelling) to recover the project name.
    const stem = srcName.replace(/\.xlsx$/i, "").trim();
    const projName = (stem.replace(/[_\s]*Energy[_\s]*Results[_\s]*Compar\w*.*$/i, "").trim() || stem)
      .replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    downloadBlob(blob, `${projName}_Energy Results Comparision Report.docx`);
    status.innerHTML = `<span style="color:var(--g700)">✓ Report generated — check your downloads.</span>`;
    toast("✓ Word report downloaded");
  } catch (e: any) {
    status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || String(e))}</span>`;
    toast("Generate failed — " + (e.message || e));
  } finally {
    busy = false; go.disabled = false;
  }
}
