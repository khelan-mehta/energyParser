/* ============================================================
 *  WORD REPORT — auto-fill the "Energy Model Report" .docx.
 *  The user uploads their QA/QC-ed Energy Results Comparison workbook;
 *  we fill the report's data tables and drop in the Site / Source /
 *  Carbon / Cost charts (native, exact colours), then download the .docx.
 * ============================================================ */
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { infoBoxes } from "../ui/infoboxes";
import { buildWordReport } from "../engine/wordreport";
import templateUrl from "../assets/report_template.docx?url";

let xlsxFile: File | null = null;
let busy = false;

const readBuf = (f: File): Promise<ArrayBuffer> =>
  new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(f); });
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function renderWordReport(root: HTMLElement) {
  xlsxFile = null; busy = false;

  root.appendChild(h(`
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
  root.appendChild(genCard(root));
  refresh(root);
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
      <h3>2 · Generate the report</h3><span class="sub">fills tables + embeds charts</span></div>
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
    <div style="font-family:'Syne';font-weight:800;font-size:14px">${title}</div>
    <div style="font-size:12px;color:var(--g500);margin-top:2px">${sub}</div></div>`;
}

function refresh(root: HTMLElement) {
  const list = root.querySelector("#wr-file");
  if (list) {
    list.innerHTML = "";
    if (xlsxFile) {
      const chip = h(`<span class="chip"><b style="font-weight:600">workbook</b> ${esc(xlsxFile.name)} <span class="x">×</span></span>`);
      chip.querySelector(".x")!.addEventListener("click", () => { xlsxFile = null; refresh(root); });
      list.appendChild(chip);
    }
  }
  const go = root.querySelector("#wr-go") as HTMLButtonElement | null;
  if (go) go.disabled = !xlsxFile || busy;
  root.querySelectorAll<HTMLElement>("#wr-feats > div").forEach((el) => { el.style.opacity = xlsxFile ? "1" : ".55"; el.style.transition = "opacity .2s"; });
}

async function generate(root: HTMLElement) {
  if (!xlsxFile || busy) return;
  busy = true;
  const status = root.querySelector("#wr-status") as HTMLElement;
  const go = root.querySelector("#wr-go") as HTMLButtonElement;
  go.disabled = true;
  status.innerHTML = `<span class="spinner" style="width:13px;height:13px;vertical-align:middle"></span> Reading workbook & building report…`;
  try {
    const [xlsxBuf, tplResp] = await Promise.all([readBuf(xlsxFile), fetch(templateUrl)]);
    if (!tplResp.ok) throw new Error(`report template not found (HTTP ${tplResp.status})`);
    const docxBuf = await tplResp.arrayBuffer();
    const blob = await buildWordReport(xlsxBuf, docxBuf);
    const base = xlsxFile.name.replace(/\.xlsx$/i, "").replace(/\W+/g, "_");
    downloadBlob(blob, `${base}_Energy_Report.docx`);
    status.innerHTML = `<span style="color:var(--g700)">✓ Report generated — check your downloads.</span>`;
    toast("✓ Word report downloaded");
  } catch (e: any) {
    status.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message || String(e))}</span>`;
    toast("Generate failed — " + (e.message || e));
  } finally {
    busy = false; go.disabled = false;
  }
}
