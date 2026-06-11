/* ============================================================
 *  MEPC — eQUEST/DOE-2 .SIM → LEED v4 Minimum Energy Performance
 *  Calculator. Standalone tool that mirrors mepc_excel_parser.html:
 *  load the sim files (+ optional rotations / .INP / QA export), then
 *  download the copy-paste tables (.xlsx) or fill the official .xlsm.
 *  All parsing/IO logic lives in engine/mepc.ts (byte-identical port).
 * ============================================================ */
import { h, esc, toast } from "../ui/util";
import { ICON } from "../ui/icons";
import { infoBoxes } from "../ui/infoboxes";
import { makeChart } from "../ui/charts";
import { parseAll, buildDataWorkbook, fillXlsm, MepcInputs } from "../engine/mepc";

/* ---- module state (mirrors the HTML's globals) ---- */
const files: { tpl: File | null; base: File | null; prop: File | null; rot: File[]; inp: File[] | File | null } = {
  tpl: null, base: null, prop: null, rot: [], inp: null,
};
let RESULT: any = null;
let MODEL_ENV: any = null;
let logbuf = "";

const readText = (f: File): Promise<string> => new Promise((r) => { const x = new FileReader(); x.onload = () => r(x.result as string); x.readAsText(f); });
const readBuf = (f: File): Promise<ArrayBuffer> => new Promise((r) => { const x = new FileReader(); x.onload = () => r(x.result as ArrayBuffer); x.readAsArrayBuffer(f); });
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ============================================================ */
export function renderMepc(root: HTMLElement) {
  RESULT = null; MODEL_ENV = null; logbuf = "";
  files.tpl = files.base = files.prop = files.inp = null; files.rot = [];

  root.appendChild(h(`<div class="page-head"><div><h1>MEPC</h1><p>eQUEST / DOE-2 <b>.SIM</b> → LEED v4 Minimum Energy Performance Calculator. Load the simulation files, Process, then download clean copy-paste tables or fill the official <code>.xlsm</code>.</p></div></div>`));
  root.appendChild(infoBoxes(
    [
      "Load the blank calculator <b>.xlsm</b> template + the baseline &amp; proposed <b>.SIM</b> (required).",
      "Optionally add 90/180/270° rotation runs, the proposed <b>.INP</b>, and a QA “Results Path” export.",
      "Click <b>Process files</b> to parse, then <b>Download copy-paste tables</b> (the reliable output).",
      "Or try <b>Fill official .xlsm</b> for a best-effort direct fill (every written cell is highlighted yellow).",
    ],
    [
      "5 clean sheets — Performance Outputs (4 rotations), General Info, Fenestration, Opaque, Lighting.",
      "Baseline end-use kWh/therm + peak demand, proposed energy, cost &amp; unmet hours (kBtu→kWh/therm).",
      "Envelope: WWR by orientation, roof area, glazing U/SHGC/VLT, opaque U-factors.",
      "An experimental <code>.xlsm</code> filled in place, ready to open in Excel.",
    ],
  ));

  root.appendChild(loadCard(root));
  root.appendChild(generateCard(root));
  root.appendChild(logCard());

  paintLog();
  checkReady(root);
}

/* ---------- 1 · Load files ---------- */
function loadCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" style="margin-bottom:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.files("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>1 · Load files</h3><span class="sub">three required · three optional</span></div>
    <div class="form-grid mepc-slots">
      ${slot("tpl", "① Calculator template (.xlsm)", "required", "The blank v4_Minimum_Energy_Performance_Calculator-v06.xlsm", ".xlsm", false)}
      ${slot("base", "② Baseline simulation (.SIM)", "required", "e.g. …LEED_0 - Baseline Design.SIM (0° rotation)", ".sim,.SIM", false)}
      ${slot("prop", "③ Proposed simulation (.SIM)", "required", "e.g. …Proposed_Final - Baseline Design.SIM", ".sim,.SIM", false)}
      ${slot("rot", "④ Extra baseline rotations (.SIM)", "optional", "90/180/270° runs, if simulated. Pick 1–3. If omitted, the 0° run is used for all four.", ".sim,.SIM", true)}
      ${slot("inp", "⑤ Proposed .INP", "optional", "Used for glazing SHGC and construction descriptions on the Envelope sheets.", ".inp", false)}
    </div>
    <div class="mepc-slot" style="margin-top:12px">
      <label>⑥ QA “Results Path” export <span class="muted-tag">optional — overrides energy with the real rotations</span></label>
      <div class="slot-hint">Paste the tab-separated rows (header line + the <code>LEED Baseline</code>, <code>… 90°/180°/270°</code> and <code>Proposed Design</code> rows), or load the .csv/.tsv. When present, the 4 baseline rotations + proposed energy come from here; the .SIM still supplies the envelope.</div>
      <textarea id="mepc-qa" rows="4" placeholder="Option&#9;Results Path&#9;…&#9;(paste header row + data rows here)" style="width:100%;font:11px 'DM Mono',monospace;border:1px solid var(--g200);border-radius:8px;padding:8px;resize:vertical"></textarea>
      <input type="file" id="mepc-qa-file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="margin-top:6px;font-size:12px" />
      <div class="fn" id="mepc-fn-qa"></div>
    </div>
  </div>`);

  wire(card, root, "tpl", false);
  wire(card, root, "base", false);
  wire(card, root, "prop", false);
  wire(card, root, "rot", true);
  wire(card, root, "inp", false);

  // QA file → textarea
  card.querySelector("#mepc-qa-file")!.addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
    const fn = card.querySelector("#mepc-fn-qa")!;
    fn.textContent = f.name;
    if (/\.(csv|tsv|txt)$/i.test(f.name)) {
      const r = new FileReader();
      r.onload = (ev) => { let s = ev.target!.result as string; if (s.indexOf("\t") < 0) s = s.replace(/,/g, "\t"); (card.querySelector("#mepc-qa") as HTMLTextAreaElement).value = s; };
      r.readAsText(f);
    } else fn.textContent = f.name + " — please copy the rows and paste into the box above (.xls not read directly).";
  });
  return card;
}
function slot(key: string, label: string, badge: "required" | "optional", hint: string, accept: string, multi: boolean): string {
  const req = badge === "required";
  return `<div class="mepc-slot ${req ? "req" : ""}" data-slot="${key}">
    <label>${label} <span class="${req ? "pill-req" : "muted-tag"}">${badge}</span></label>
    <div class="slot-hint">${hint}</div>
    <input type="file" id="mepc-f-${key}" accept="${accept}" ${multi ? "multiple" : ""} />
    <div class="fn" id="mepc-fn-${key}"></div>
  </div>`;
}
function wire(card: HTMLElement, root: HTMLElement, key: "tpl" | "base" | "prop" | "rot" | "inp", multi: boolean) {
  const input = card.querySelector(`#mepc-f-${key}`) as HTMLInputElement;
  input.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (multi) files[key] = [...(t.files || [])] as any;
    else (files as any)[key] = t.files?.[0] || null;
    const slotEl = card.querySelector(`[data-slot="${key}"]`)!;
    const fn = card.querySelector(`#mepc-fn-${key}`)!;
    if (multi) { const arr = files[key] as File[]; fn.textContent = arr.map((f) => f.name).join(", "); slotEl.classList.toggle("ok", arr.length > 0); }
    else { const f = (files as any)[key] as File | null; fn.textContent = f ? f.name : ""; slotEl.classList.toggle("ok", !!f); }
    checkReady(root);
  });
}

/* ---------- 2 · Generate ---------- */
function generateCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" style="margin-bottom:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--g100)">${ICON.bolt()}</div><h3>2 · Generate</h3></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" id="mepc-go" disabled>${ICON.bolt()} Process files</button>
      <button class="btn btn-dark" id="mepc-data" disabled>${ICON.download()} Download copy-paste tables (.xlsx)</button>
      <button class="btn" id="mepc-xlsm" disabled>${ICON.download()} Fill official .xlsm (experimental)</button>
      <span class="muted-tag" id="mepc-note"> — load the three required files first.</span>
    </div>
    <p class="muted-tag" style="margin-top:8px">The <b>copy-paste tables</b> are the reliable output: one clean sheet per calculator tab. The .xlsm fill is best-effort (Excel macros/formulas can interfere).</p>
    <div id="mepc-summary"></div>
  </div>`);

  card.querySelector("#mepc-go")!.addEventListener("click", async () => {
    const go = card.querySelector("#mepc-go") as HTMLButtonElement;
    try {
      logbuf = ""; paintLog(); go.disabled = true;
      const inputs: MepcInputs = {
        baseTxt: await readText(files.base!),
        propTxt: await readText(files.prop!),
        rotTxts: await Promise.all(files.rot.map(readText)),
        inpTxt: files.inp ? await readText(files.inp as File) : "",
        qaText: (root.querySelector("#mepc-qa") as HTMLTextAreaElement)?.value || "",
      };
      RESULT = parseAll(inputs, log);
      MODEL_ENV = RESULT.env;
      (card.querySelector("#mepc-data") as HTMLButtonElement).disabled = false;
      (card.querySelector("#mepc-xlsm") as HTMLButtonElement).disabled = false;
      log("\n✓ Parsed. Click ‘Download copy-paste tables (.xlsx)’ — that's the reliable output.");
      renderSummary(card, RESULT.dispBase, RESULT.propData, RESULT.sav, RESULT.csav);
    } catch (err: any) { log("✗ ERROR: " + err.message); console.error(err); }
    finally { go.disabled = false; }
  });

  card.querySelector("#mepc-data")!.addEventListener("click", () => {
    try { buildDataWorkbook(RESULT, log); toast("✓ Copy-paste tables downloaded"); }
    catch (e: any) { log("✗ " + e.message); console.error(e); }
  });

  card.querySelector("#mepc-xlsm")!.addEventListener("click", async () => {
    const btn = card.querySelector("#mepc-xlsm") as HTMLButtonElement;
    if (!files.tpl) { toast("Load the .xlsm template first"); return; }
    btn.disabled = true;
    try {
      const tplBuf = await readBuf(files.tpl);
      const { blob, name } = await fillXlsm(RESULT, tplBuf, log);
      downloadBlob(blob, name);
      toast("✓ .xlsm written");
    } catch (e: any) { log("✗ " + e.message); console.error(e); }
    finally { btn.disabled = false; }
  });

  return card;
}

function checkReady(root: HTMLElement) {
  const ok = !!(files.tpl && files.base && files.prop);
  const go = root.querySelector("#mepc-go") as HTMLButtonElement | null;
  const note = root.querySelector("#mepc-note");
  if (go) go.disabled = !ok;
  if (note) note.textContent = ok ? " — ready." : " — load the three required files first.";
}

/* ---------- log ---------- */
function logCard(): HTMLElement {
  return h(`<div class="card"><div class="card-hd"><h3 style="font-size:13px">Log</h3></div><pre class="log mepc-log" id="mepc-log"></pre></div>`);
}
function log(m: string) { logbuf += m + "\n"; paintLog(); }
function paintLog() { const el = document.getElementById("mepc-log"); if (el) { el.textContent = logbuf || "Waiting for files…"; el.scrollTop = el.scrollHeight; } }

/* ---------- summary ---------- */
function renderSummary(card: HTMLElement, b: any, p: any, sav: string, csav: string) {
  const out = card.querySelector("#mepc-summary") as HTMLElement;
  const row = (lbl: string, bv: number, pv: number, u: string) => `<tr><td class="l">${esc(lbl)}</td><td>${Math.round(bv).toLocaleString()}</td><td>${Math.round(pv).toLocaleString()}</td><td>${esc(u)}</td></tr>`;
  out.innerHTML = `
    <div class="grid cards-4" style="margin-top:14px">
      ${kpi(sav + "%", "Site energy savings")}
      ${kpi(csav + "%", "Cost savings (ES-D)")}
      ${kpi(Math.round(b.kwh.TOTAL).toLocaleString(), "Baseline kWh")}
      ${kpi(Math.round(p.kwh.TOTAL).toLocaleString(), "Proposed kWh")}
    </div>
    <div style="overflow-x:auto;margin-top:14px"><table class="final-table mepc-table"><thead><tr><th style="text-align:left">End use (kWh)</th><th>Baseline</th><th>Proposed</th><th></th></tr></thead><tbody>
      ${row("Interior lighting", b.kwh.LIGHTS, p.kwh.LIGHTS, "kWh")}
      ${row("Exterior usage", b.kwh.EXT, p.kwh.EXT, "kWh")}
      ${row("Space cooling", b.kwh.SP_COOL, p.kwh.SP_COOL, "kWh")}
      ${row("Space heating", b.kwh.SP_HEAT, p.kwh.SP_HEAT, "kWh")}
      ${row("Pumps & aux", b.kwh.PUMPS, p.kwh.PUMPS, "kWh")}
      ${row("Ventilation fans", b.kwh.FANS, p.kwh.FANS, "kWh")}
      ${row("Misc / receptacle", b.kwh.MISC, p.kwh.MISC, "kWh")}
      ${row("Domestic hot water", b.kwh.DHW, p.kwh.DHW, "kWh")}
      ${row("Heat rejection", b.kwh.HEAT_REJ, p.kwh.HEAT_REJ, "kWh")}
      ${row("TOTAL", b.kwh.TOTAL, p.kwh.TOTAL, "kWh")}
    </tbody></table></div>
    <p class="muted-tag" style="margin-top:10px">Annual cost — baseline $${Math.round(b.elecCost || 0).toLocaleString()} · proposed $${Math.round(p.elecCost || 0).toLocaleString()} (ES-D). Unmet hrs — baseline cool ${esc(b.coolUnmet)}/heat ${esc(b.heatUnmet)}, proposed cool ${esc(p.coolUnmet)}/heat ${esc(p.heatUnmet)}.</p>
    ${MODEL_ENV ? envTable(MODEL_ENV) : ""}
    <div style="height:300px;margin-top:14px"><canvas id="mepc-chart"></canvas></div>`;

  // end-use comparison chart
  const ck = ["LIGHTS", "EXT", "SP_COOL", "SP_HEAT", "PUMPS", "FANS", "MISC", "DHW", "HEAT_REJ"];
  const labels = ["Int. light", "Ext.", "Cooling", "Heating", "Pumps", "Fans", "Misc", "DHW", "Heat rej."];
  requestAnimationFrame(() => {
    const c = out.querySelector("#mepc-chart") as HTMLCanvasElement; if (!c) return;
    makeChart(c, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Baseline", data: ck.map((k) => Math.round(b.kwh[k] || 0)), backgroundColor: "#1a1a1d", borderRadius: 4, maxBarThickness: 26 },
          { label: "Proposed", data: ck.map((k) => Math.round(p.kwh[k] || 0)), backgroundColor: "#E4002B", borderRadius: 4, maxBarThickness: 26 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: "bottom" } }, scales: { x: { grid: { display: false }, border: { display: false } }, y: { grid: { color: "#f0f0f1" }, border: { display: false } } } },
    });
  });
}
function kpi(v: string, l: string): string {
  return `<div style="border:1px solid var(--g200);border-radius:12px;padding:14px 16px"><div style="font-family:'Syne';font-weight:800;font-size:22px;color:var(--red)">${esc(v)}</div><div style="font-size:11px;color:var(--g500);margin-top:2px">${esc(l)}</div></div>`;
}
function envTable(e: any): string {
  const o = (az: string) => { const x = e.orient(az); return x.wall ? (x.glaze / x.wall * 100).toFixed(1) + "%" : "—"; };
  return `<h4 style="margin:16px 0 4px;font-family:'Syne';font-weight:800">Envelope (proposed) — written to Shading/Fenestration + Opaque</h4>
  <div style="overflow-x:auto"><table class="final-table mepc-table"><thead><tr><th style="text-align:left">Orientation</th><th>Gross wall (sf)</th><th>Glazing (sf)</th><th>WWR</th></tr></thead><tbody>
   ${["NORTH", "EAST", "SOUTH", "WEST"].map((az) => { const x = e.orient(az); return `<tr><td class="l">${az}</td><td>${x.wall.toLocaleString()}</td><td>${x.glaze.toLocaleString()}</td><td>${o(az)}</td></tr>`; }).join("")}
  </tbody></table></div>
  <p class="muted-tag" style="margin-top:8px">Roof ${e.roofArea.toLocaleString()} sf · Wall U ${e.wallU} · Roof U ${e.roofU} · Glass U ${e.glassU} / SHGC ${e.glassSHGC == null ? "(needs .INP)" : e.glassSHGC} / VLT ${e.glassVLT}</p>`;
}
