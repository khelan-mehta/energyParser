/* ============================================================
 *  MEPC — eQUEST/DOE-2 .SIM → LEED v4 Minimum Energy Performance
 *  Calculator (.xlsm) auto-fill + copy-paste tables.
 *
 *  This is a faithful, line-for-line port of mepc_excel_parser.html:
 *  the SIM/QA/envelope parsers, the SheetJS copy-paste workbook, and
 *  the experimental .xlsm cell-injection fill are byte-identical in
 *  logic. Only the I/O shell changed — DOM `$()`/FileReader globals are
 *  replaced by pure functions that take file text/buffers and a `log`
 *  callback, so the same engine runs inside the Marcus app.
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";

export type LogFn = (msg: string) => void;

/* ---- DOE-2 end-use order (BEPU/PS-E columns) ---- */
const COLS = ["LIGHTS", "TASK", "MISC", "SP_HEAT", "SP_COOL", "HEAT_REJ", "PUMPS", "FANS", "REFRIG", "HP_SUP", "DHW", "EXT", "TOTAL"];
/* ---- target columns on the "Results from eQuest" sheet ---- */
const KWH_COLS = ["L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X"];      // 13 incl TOTAL
const KW_COLS = ["Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ"];  // 12 (non-coincident peak)
const THERM_COLS = ["AX", "AY", "AZ", "BA", "BB", "BC", "BD", "BE", "BF", "BG", "BH", "BI", "BJ"]; // 13 incl TOTAL
const BASE_ROWS = [8, 9, 10, 11];      // baseline 0/90/180/270°
const PROP_ROW = 13;                   // proposed

/* ===================== SIM PARSER ===================== */
function numlist(s: string) { return s.trim().split(/\s+/).map(parseFloat).filter((n) => !isNaN(n)); }
export function parseSIM(text: string, label: string): any {
  const o: any = { label, kwh: {}, kw: {}, therm: {} };
  // --- BEPU: annual kWh & therms by end use ---
  const bi = text.indexOf("REPORT- BEPU"); const bb = text.slice(bi, bi + 3000);
  let m = bb.match(/ELECTRICITY[\s\S]*?\n\s*KWH\s+([\d.\s]+?)\n/);
  if (m) { const v = numlist(m[1]); COLS.forEach((c, i) => o.kwh[c] = v[i] || 0); }
  m = bb.match(/NATURAL-GAS[\s\S]*?\n\s*THERM\s+([\d.\s]+?)\n/);
  if (m) { const v = numlist(m[1]); COLS.forEach((c, i) => o.therm[c] = v[i] || 0); } else COLS.forEach((c) => o.therm[c] = 0);
  // --- PS-E electric: non-coincident peak kW = max of monthly MAX KW per end use ---
  const pi = text.indexOf("REPORT- PS-E Energy End-Use Summary for all Electric Meters");
  if (pi >= 0) {
    const pe = text.slice(pi, pi + 4500);
    const peak = new Array(13).fill(0);
    [...pe.matchAll(/MAX KW\s+([\d.\s]+?)\n/g)].forEach((x) => numlist(x[1]).forEach((v, i) => { if (v > peak[i]) peak[i] = v; }));
    COLS.forEach((c, i) => o.kw[c] = peak[i] || 0);
  } else COLS.forEach((c) => o.kw[c] = 0);
  // --- BEPS: site MBtu, EUI, gross area, unmet hours ---
  const si = text.indexOf("REPORT- BEPS"); const be = text.slice(si, si + 3000);
  m = be.match(/TOTAL SITE ENERGY\s+([\d.]+)\s+MBTU\s+([\d.]+)\s+KBTU\/SQFT-YR GROSS-AREA/);
  if (m) { o.mbtu = +m[1]; o.eui = +m[2]; o.area = Math.round(+m[1] * 1000 / +m[2]); }
  m = be.match(/OUTSIDE OF THROTTLING RANGE\s*=\s*([\d.]+)/); o.pctOut = m ? +m[1] : "";
  m = be.match(/PLANT LOAD NOT SATISFIED\s*=\s*([\d.]+)/); o.pctPlant = m ? +m[1] : "";
  m = be.match(/HOURS ANY ZONE ABOVE COOLING THROTTLING RANGE\s*=\s*(\d+)/); o.coolUnmet = m ? +m[1] : "";
  m = be.match(/HOURS ANY ZONE BELOW HEATING THROTTLING RANGE\s*=\s*(\d+)/); o.heatUnmet = m ? +m[1] : "";
  // --- ES-D: annual electricity cost ---
  const ei = text.indexOf("REPORT- ES-D");
  if (ei >= 0) {
    const es = text.slice(ei, ei + 1800);
    m = es.match(/ELECTRICITY\s+EM1\s+[\d.]+\.\s+KWH\s+([\d.]+)\./); o.elecCost = m ? +m[1] : 0;
    m = es.match(/NATURAL-GAS\s+FM1\s+[\d.]+\.\s+THERM\s+([\d.]+)\./); o.gasCost = m ? +m[1] : 0;
  }
  // --- header meta ---
  m = text.match(/WEATHER FILE-\s*(.+)$/m); o.weather = m ? m[1].replace(/\s+/g, " ").trim() : "";
  m = text.match(/DOE-2\.2-(\w+)/); o.engine = m ? ("DOE-2.2-" + m[1]) : "DOE-2.2";
  m = text.match(/^(.*?\S)\s{2,}DOE-2\.2-\w+\s+\d/m); o.title = m ? m[1].trim() : "";
  return o;
}

/* ===================== QA EXPORT ("Results Path" TSV) PARSER =====================
   Maps the validated metrics export (baseline rotations + proposed) to the
   calculator. kBtu→kWh (/3.412) and kBtu→therm (/100). */
function qaNum(s: any) { s = (s == null ? "" : String(s)).trim(); if (s === "" || s === "-") return 0; s = s.replace(/[$,\s]/g, ""); const n = parseFloat(s); return isNaN(n) ? 0 : n; }
export function parseQA(tsv: string): any {
  const lines = tsv.replace(/\r/g, "").split("\n").filter((l) => l.indexOf("\t") >= 0);
  if (lines.length < 2) return null;
  const hdr = lines[0].split("\t").map((s) => s.trim()); const idx: any = {}; hdr.forEach((h, i) => { if (idx[h] == null) idx[h] = i; });
  if (idx["Option"] == null) return null;
  const K = 3.412;
  const G = (cells: any, name: string) => { const i = idx[name]; return i == null ? 0 : qaNum(cells[i]); };
  const cases: any[] = [];
  for (let k = 1; k < lines.length; k++) {
    const cells = lines[k].split("\t"); const opt = (cells[idx["Option"]] || "").trim(); if (!opt) continue;
    const kwh = {
      LIGHTS: G(cells, "Interior Lighting - Electricity Energy Use (kBtu)") / K, TASK: 0,
      MISC: G(cells, "Interior Equipment - Electricity Energy Use (kBtu)") / K,
      SP_HEAT: G(cells, "Heating - Electricity Energy Use (kBtu)") / K,
      SP_COOL: G(cells, "Cooling - Electricity Energy Use (kBtu)") / K,
      HEAT_REJ: G(cells, "Heat Rejection - Electricity Energy Use (kBtu)") / K,
      PUMPS: G(cells, "Pumps - Electricity Energy Use (kBtu)") / K,
      FANS: G(cells, "Fans - Electricity Energy Use (kBtu)") / K,
      REFRIG: G(cells, "Refrigeration - Electricity Energy Use (kBtu)") / K, HP_SUP: 0,
      DHW: G(cells, "Water Systems - Electricity Energy Use (kBtu)") / K,
      EXT: (G(cells, "Exterior Lighting - Electricity Energy Use (kBtu)") + G(cells, "Exterior Equipment - Energy Use (kBtu)")) / K,
      TOTAL: G(cells, "Electricity (kBtu)") / K,
    };
    const therm = {
      LIGHTS: 0, TASK: 0, MISC: G(cells, "Interior Equipment - Gas Energy Use (kBtu)") / 100,
      SP_HEAT: G(cells, "Heating - Gas Energy Use (kBtu)") / 100, SP_COOL: 0, HEAT_REJ: 0, PUMPS: 0, FANS: 0, REFRIG: 0, HP_SUP: 0,
      DHW: G(cells, "Water Systems - Gas Energy Use (kBtu)") / 100, EXT: 0, TOTAL: G(cells, "Gas (kBtu)") / 100,
    };
    cases.push({
      option: opt, kwh, therm, kw: {},
      mbtu: G(cells, "Total Energy Use (kBtu)") / 1000, eui: G(cells, "Energy Use Intensity (kBtu/ft²)"),
      elecCost: G(cells, "Total Energy Cost ($)"), coolUnmet: G(cells, "Cooling Unmet Hours"), heatUnmet: G(cells, "Heating Unmet Hours"),
      area: G(cells, "Conditioned Floor Area (ft²)"), climate: (cells[idx["Climate Zone"]] || "").trim(),
      lpd: G(cells, "Conditioned Lighting Power Density (W/ft²)") || G(cells, "Lighting Power Density (W/ft²)"),
      epd: G(cells, "Conditioned Equipment Power Density (W/ft²)") || G(cells, "Equipment Power Density (W/ft²)"),
      vent: G(cells, "Total Ventilation Air Flow Rate (CFM)"), chillerCOP: G(cells, "Chiller Efficiency (COP)"),
      boilerCOP: G(cells, "Boiler Efficiency (COP)"), fanKW: G(cells, "Total Fan Power (kW)"), pumpKW: G(cells, "Total Pump Power (kW)"),
      shwEff: G(cells, "Service Hot Water Thermal Efficiency (COP)"), extLightKW: G(cells, "Exterior Lighting (kW)"),
      glassU: G(cells, "Glass U-Value (Btu/h·ft²·F)"), glassSHGC: G(cells, "Glass SHGC"), glassVLT: G(cells, "Glass VLT"),
      wallU: G(cells, "Wall U-Value (Btu/h·ft²·F)"), roofU: G(cells, "Roof U-Value (Btu/h·ft²·F)"),
      heatAir: G(cells, "Total Heating Airflow Rate (CFM)"), coolAir: G(cells, "Total Cooling Airflow Rate (CFM)"),
      peakElec: G(cells, "Peak Electrical Load (W)"), roofArea: G(cells, "Gross Roof Area (ft²)"),
      skyRatio: G(cells, "Skylight Roof Ratio (%)"),
      wallN: G(cells, "Above Ground North Wall Area (ft²)"), wallE: G(cells, "Above Ground East Wall Area (ft²)"),
      wallS: G(cells, "Above Ground South Wall Area (ft²)"), wwrN: G(cells, "North WWR Actual (%)"),
      wwrE: G(cells, "East WWR Actual (%)"), wwrS: G(cells, "South WWR Actual (%)"), wwrW: G(cells, "West WWR Actual (%)"),
    });
  }
  const f = (re: RegExp) => cases.find((c) => re.test(c.option));
  return {
    base0: f(/^LEED Baseline$/i) || f(/^Baseline$/i) || cases.find((c) => /baseline/i.test(c.option) && !/9|18|27|compliance/i.test(c.option)),
    base90: f(/Baseline 90/i), base180: f(/Baseline 180/i), base270: f(/Baseline 270/i), proposed: f(/proposed/i), all: cases,
  };
}

/* ===================== ENVELOPE PARSER (LV-C/LV-D + INP) =====================
   Validated against a known QA row: WWR by orientation, roof area, wall/roof/
   glass U-factors all matched exactly. */
export function parseEnv(simText: string, inpText: string): any {
  const t = simText, inp = inpText || "";
  const reg = t.slice(t.indexOf("REPORT- LV-D"), (t.indexOf("REPORT- SV-A") > 0 ? t.indexOf("REPORT- SV-A") : t.length));
  const O: any = { NORTH: mk(), EAST: mk(), SOUTH: mk(), WEST: mk() };
  function mk() { return { wall: 0, win: 0, wu: 0, wuA: 0, winU: 0, winUA: 0 }; }
  const re = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(NORTH|EAST|SOUTH|WEST)\s*$/gm;
  let m: any;
  while ((m = re.exec(reg))) {
    const winU = +m[1], winA = +m[2], wallU = +m[3], wallA = +m[4], o = O[m[7]];
    o.wall += wallA; o.win += winA; o.wu += wallU * wallA; o.wuA += wallA;
    if (winA > 0) { o.winU += winU * winA; o.winUA += winA; }
  }
  // roofs (LV-C per-space "…Roof (…) mult area Construction U QUICK"), dedupe by surface name
  let roofArea = 0, roofU = 0; const seen = new Set();
  for (const ln of t.split(/\r?\n/)) {
    if (!/Roof/.test(ln) || !/\b(QUICK|DELAYED)\b/.test(ln)) continue;
    const id = (ln.match(/^(.*?Roof[^)]*\))/) || [])[1]; if (!id || seen.has(id)) continue;
    const tok = ln.trim().split(/\s+/), qi = Math.max(tok.indexOf("QUICK"), tok.indexOf("DELAYED")); if (qi < 2) continue;
    const u = parseFloat(tok[qi - 1]), area = Math.max(...tok.map(parseFloat).filter((x) => !isNaN(x) && x > 10));
    if (!isFinite(area) || isNaN(u)) continue;
    seen.add(id); roofArea += area; roofU += u * area;
  }
  const sum = (f: any) => ["NORTH", "EAST", "SOUTH", "WEST"].reduce((a, k) => a + f(O[k]), 0);
  const wallUA = sum((o: any) => o.wuA), wallUw = sum((o: any) => o.wu);
  const winUA = sum((o: any) => o.winU), winA = sum((o: any) => o.winUA);
  const sc = (inp.match(/SHADING-COEF\s*=\s*([\d.]+)/) || [])[1];
  return {
    O, roofArea: Math.round(roofArea), roofU: roofArea ? +(roofU / roofArea).toFixed(3) : null,
    wallU: wallUA ? +(wallUw / wallUA).toFixed(3) : null,
    glassU: winA ? +(winUA / winA).toFixed(3) : null,
    glassSHGC: sc ? +(+sc * 0.87).toFixed(3) : null, glassVLT: 0.90,
    orient(az: string) { const o = O[az]; return { wall: Math.round(o.wall + o.win), glaze: Math.round(o.win) }; },
  };
}

/* ===================== XLSX CELL INJECTION ===================== */
function escXml(s: any) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function colToNum(c: string) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

/* yellow-highlight engine: when HL is set, every cell setCell writes keeps its
   original formatting but gets a yellow fill (a derived cellXf is created). */
let HL: ((origIdx: number) => number) | null = null;
function makeStyleHL(stylesXml: string) {
  let xml = stylesXml;
  const yellowFill = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF200"/><bgColor indexed="64"/></patternFill></fill>';
  const fc = +xml.match(/<fills count="(\d+)"/)![1];
  const yellowFillId = fc;
  xml = xml.replace(/<fills count="\d+"/, '<fills count="' + (fc + 1) + '"').replace("</fills>", yellowFill + "</fills>");
  const cxm = xml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/)!;
  let xfCount = +cxm[1];
  const xfs = cxm[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
  const cache: any = {}, added: string[] = [];
  function yellowFor(origIdx: number) {
    if (cache[origIdx] != null) return cache[origIdx];
    const base = xfs[origIdx] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    let nx = /fillId="\d+"/.test(base) ? base.replace(/fillId="\d+"/, 'fillId="' + yellowFillId + '"') : base.replace(/<xf\b/, '<xf fillId="' + yellowFillId + '"');
    nx = nx.replace(/\sapplyFill="[01]"/, "").replace(/<xf\b/, '<xf applyFill="1"');
    const id = xfCount++; cache[origIdx] = id; added.push(nx); return id;
  }
  function finalize() { return xml.replace(/<cellXfs count="\d+">/, '<cellXfs count="' + xfCount + '">').replace("</cellXfs>", added.join("") + "</cellXfs>"); }
  return { yellowFor, finalize };
}

function unhideRows(xml: string, rows: number[]) { for (const r of rows) xml = xml.replace(new RegExp('(<row r="' + r + '"[^>]*?) hidden="1"'), "$1"); return xml; }

function setCell(xml: string, addr: string, value: any, isStr?: boolean) {
  const styleOf = (a: string) => { const m = a.match(/ s="(\d+)"/); const idx = m ? +m[1] : 0; return HL ? ' s="' + HL(idx) + '"' : (m ? m[0] : ""); };
  const make = (s: string) => isStr
    ? `<c r="${addr}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`
    : `<c r="${addr}"${s}><v>${value}</v></c>`;
  let re = new RegExp(`<c r="${addr}"([^>]*?)/>`);           // empty self-closing
  if (re.test(xml)) return xml.replace(re, (_, a) => make(styleOf(a)));
  re = new RegExp(`<c r="${addr}"([^>]*?)>[^]*?</c>`);  // has body
  if (re.test(xml)) return xml.replace(re, (_, a) => make(styleOf(a)));
  // not present → insert into its row in column order
  const row = addr.match(/\d+/)![0], col = addr.match(/[A-Z]+/)![0], colN = colToNum(col);
  const rowRe = new RegExp(`(<row r="${row}"[^>]*?)(/?>)`);
  const rm = xml.match(rowRe); if (!rm) return xml; // give up silently
  if (rm[2] === "/>") { // empty self-closing row → expand
    return xml.replace(rowRe, `$1>${make("")}</row>`);
  }
  // find insertion point among existing cells
  const bodyRe = new RegExp(`(<row r="${row}"[^>]*>)([^]*?)(</row>)`);
  return xml.replace(bodyRe, (_full, open, body, close) => {
    const cells = [...body.matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)];
    let idx = body.length;
    for (const cm of cells) { if (colToNum(cm[1]) > colN) { idx = cm.index!; break; } }
    return open + body.slice(0, idx) + make("") + body.slice(idx) + close;
  });
}

/* ===================== BUILD INJECTIONS ===================== */
function rowData(c: any) {
  const d: any[] = [];
  KWH_COLS.forEach((col, i) => d.push([col, Math.round(c.kwh[COLS[i]] || 0), false]));
  if (c.kw && Object.keys(c.kw).length)
    KW_COLS.forEach((col, i) => d.push([col, Math.round((c.kw[COLS[i]] || 0) * 100) / 100, false]));
  THERM_COLS.forEach((col, i) => d.push([col, Math.round(c.therm[COLS[i]] || 0), false]));
  if (c.mbtu != null) d.push(["BK", Math.round(c.mbtu * 100) / 100, false]);
  if (c.eui != null) d.push(["BL", Math.round(c.eui * 100) / 100, false]);
  if (c.elecCost != null) d.push(["BO", Math.round(c.elecCost), false]);
  d.push(["BP", Math.round(c.gasCost || 0), false]);
  if (c.pctOut !== "") d.push(["BS", c.pctOut, false]);
  if (c.pctPlant !== "") d.push(["BT", c.pctPlant, false]);
  if (c.coolUnmet !== "") d.push(["BW", c.coolUnmet, false]);
  if (c.heatUnmet !== "") d.push(["BX", c.heatUnmet, false]);
  return d;
}

/* ===================== MAIN PARSE ===================== */
export interface MepcInputs {
  baseTxt: string;
  propTxt: string;
  rotTxts: string[];
  inpTxt: string;
  qaText: string;
}

/* ---- parse everything, return the RESULT bundle (and the live env) ---- */
export function parseAll(inp: MepcInputs, log: LogFn) {
  log("Reading simulation files…");
  const base = parseSIM(inp.baseTxt, "baseline 0°");
  const prop = parseSIM(inp.propTxt, "proposed");
  const rots = inp.rotTxts.map((t, i) => parseSIM(t, "baseline rot " + (i + 1)));
  const qaText = (inp.qaText || "").trim();
  const qa = qaText ? parseQA(qaText) : null;
  let baseRowsData: any[], propData: any, dispBase: any, source: string;
  if (qa && qa.base0) {
    source = "QA export";
    baseRowsData = [qa.base0, qa.base90 || qa.base0, qa.base180 || qa.base0, qa.base270 || qa.base0];
    propData = qa.proposed || prop; dispBase = qa.base0;
    log("QA export parsed: " + qa.all.length + " rows · " + (qa.base90 ? "4 rotations" : "0° only") + " + " + (qa.proposed ? "proposed" : "(SIM proposed)"));
  } else {
    source = "SIM"; dispBase = base;
    baseRowsData = [base, rots[0] || base, rots[1] || base, rots[2] || base];
    propData = prop;
    log("  baseline: " + Math.round(base.kwh.TOTAL).toLocaleString() + " kWh · " + base.mbtu + " MBtu · " + base.area.toLocaleString() + " sf");
    if (rots.length) log("  rotations loaded: " + rots.length + " (90/180/270°)");
  }
  log("  proposed (" + source + "): " + Math.round(propData.kwh.TOTAL).toLocaleString() + " kWh · " + (propData.mbtu || 0).toFixed(0) + " MBtu");
  const sav = ((dispBase.mbtu - propData.mbtu) / dispBase.mbtu * 100).toFixed(1);
  const csav = dispBase.elecCost ? (((dispBase.elecCost - propData.elecCost) / dispBase.elecCost * 100).toFixed(1)) : "n/a";
  log("  site-energy savings ≈ " + sav + "%   cost savings ≈ " + csav + "%  [source: " + source + "]");
  const env = parseEnv(inp.propTxt, inp.inpTxt);
  const qp = qa && qa.proposed ? qa.proposed : null;
  let inpLPD: number | null = null;
  if (inp.inpTxt) {
    const lp = [...inp.inpTxt.matchAll(/LIGHTING-W\/AREA\s*=\s*\(?\s*([\d.]+)/g)].map((m) => +m[1]).filter((v) => v > 0);
    if (lp.length) inpLPD = +(lp.reduce((a, b) => a + b, 0) / lp.length).toFixed(3);
  }
  let inpEPD: number | null = null;
  if (inp.inpTxt) {
    const ep = [...inp.inpTxt.matchAll(/EQUIPMENT-W\/AREA\s*=\s*\(?\s*([\d.]+)/g)].map((m) => +m[1]).filter((v) => v > 0);
    if (ep.length) inpEPD = +(ep.reduce((a, b) => a + b, 0) / ep.length).toFixed(3);
  }
  const lLPD = (qp && qp.lpd) || inpLPD;
  const lArea = (qp && qp.area) || (dispBase && dispBase.area) || base.area;
  const ePD = (qp && qp.epd) || inpEPD;
  const proj = (base.title || "").replace(/\s*(LEED|Baseline|Proposed|90\.1.*|Electric.*|v\d+).*/i, "").trim() || "MSU";
  const cz = (qa && qa.base0 && qa.base0.climate) || climateZone(base.weather);
  return { base, prop, rots, qa, qp, baseRowsData, propData, dispBase, source, sav, csav, env, lLPD, lArea, ePD, proj, cz, inpTxt: inp.inpTxt };
}

/* ---- best-effort fill of the official .xlsm — returns {blob,name} ---- */
export async function fillXlsm(R: any, tplBuf: ArrayBuffer, log: LogFn): Promise<{ blob: Blob; name: string }> {
  const { base, rots, baseRowsData, propData, qa, qp, env, lLPD, lArea, ePD, proj, cz } = R;
  log("Opening template & injecting cells (JSZip)…");
  const zip = await JSZip.loadAsync(tplBuf);
  HL = null;  // no highlighting — written cells keep the template's original formatting

  /* --- General Information (sheet3.xml) --- */
  let gi = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
  gi = setCell(gi, "E8", proj, true);
  gi = setCell(gi, "C42", "eQUEST", true);              // SimTool → activates eQUEST path
  gi = setCell(gi, "C44", "ASHRAE 90.1-2010", true);
  gi = setCell(gi, "C46", base.weather, true);
  gi = setCell(gi, "C48", cz, true);
  gi = setCell(gi, "F23", base.area, false);            // conditioned area
  gi = setCell(gi, "F25", 0, false);                    // unconditioned
  zip.file("xl/worksheets/sheet3.xml", gi);
  log("  General Information: name, SimTool=eQUEST, code, weather='" + base.weather + "', CZ=" + cz + ", area=" + base.area.toLocaleString());

  /* --- Results from eQuest (sheet18.xml) --- */
  let rq = await zip.file("xl/worksheets/sheet18.xml")!.async("string");
  let nCells = 0;
  BASE_ROWS.forEach((row, k) => { rowData(baseRowsData[k]).forEach(([col, val, isStr]) => { rq = setCell(rq, col + row, val, isStr); nCells++; }); });
  rowData(propData).forEach(([col, val, isStr]) => { rq = setCell(rq, col + PROP_ROW, val, isStr); nCells++; });
  zip.file("xl/worksheets/sheet18.xml", rq);
  log("  Results-from-eQuest: rows 8–11 (baseline) + row 13 (proposed) → " + nCells + " cells");
  if (rots.length === 0) log("    (no extra rotations supplied — 0° baseline used for all four rotation rows)");

  /* --- Envelope: Shading & Fenestration (sheet9) + Opaque Assemblies (sheet8) --- */
  let f9 = await zip.file("xl/worksheets/sheet9.xml")!.async("string");
  const ORROW: any = { NORTH: 21, EAST: 22, SOUTH: 23, WEST: 24 };
  let totWall = 0, totGlz = 0;
  for (const az in ORROW) {
    const r = ORROW[az], o = env.orient(az);
    const wwr = o.wall ? +(o.glaze / o.wall).toFixed(4) : 0;
    f9 = setCell(f9, "F" + r, o.wall, false);   // above-grade gross wall area
    f9 = setCell(f9, "G" + r, o.glaze, false);  // baseline glazing area
    f9 = setCell(f9, "H" + r, wwr, false);      // baseline WWR %  (computed, % number format)
    f9 = setCell(f9, "J" + r, o.glaze, false);  // proposed glazing (identical geometry)
    f9 = setCell(f9, "K" + r, wwr, false);      // proposed WWR %
    totWall += o.wall; totGlz += o.glaze;
  }
  const totWWR = totWall ? +(totGlz / totWall).toFixed(4) : 0;
  f9 = setCell(f9, "F25", totWall, false); f9 = setCell(f9, "G25", totGlz, false); f9 = setCell(f9, "H25", totWWR, false);  // baseline totals + WWR
  f9 = setCell(f9, "I25", totWall, false); f9 = setCell(f9, "J25", totGlz, false); f9 = setCell(f9, "K25", totWWR, false);  // proposed totals + WWR
  f9 = setCell(f9, "F28", env.roofArea, false);            // roof area
  const skyArea = (qa && qa.proposed && qa.proposed.skyRatio) ? Math.round(env.roofArea * qa.proposed.skyRatio / 100) : 0;
  const skyPct = env.roofArea ? +(skyArea / env.roofArea).toFixed(4) : 0;
  f9 = setCell(f9, "G28", skyArea, false); f9 = setCell(f9, "H28", skyPct, false);   // skylight area + %
  f9 = setCell(f9, "J28", skyArea, false); f9 = setCell(f9, "K28", skyPct, false);
  // Building-massing requirement attestations (100% new construction, compliant Appendix G model)
  ["L7", "L8", "L9", "L11"].forEach((c) => f9 = setCell(f9, c, "Yes", true));
  f9 = setCell(f9, "L10", "N/A", true);                    // no existing fenestration (all-new)
  f9 = setCell(f9, "F30", ">100", true);                   // conditioned thermal blocks (875 zones)
  // proposed vertical glazing — prefer QA export (has SHGC), else SIM/INP
  const gU = qp && qp.glassU ? qp.glassU : env.glassU;
  const gSHGC = qp && qp.glassSHGC ? qp.glassSHGC : env.glassSHGC;
  const gVLT = qp && qp.glassVLT ? qp.glassVLT : env.glassVLT;
  if (gU != null) {
    f9 = setCell(f9, "I46", "Double glazing, low-e, thermally-broken frame", true);
    f9 = setCell(f9, "J46", gU, false);
    f9 = setCell(f9, "K46", gSHGC != null ? gSHGC : "", false);
    f9 = setCell(f9, "L46", gVLT, false);
  }
  zip.file("xl/worksheets/sheet9.xml", f9);
  log("  Shading & Fenestration: WWR by orientation, roof " + env.roofArea.toLocaleString() + " sf, glazing U " + gU + " / SHGC " + (gSHGC || "—") + " / VLT " + gVLT);

  let f8 = await zip.file("xl/worksheets/sheet8.xml")!.async("string");
  // requirement attestations (100% new, all-electric, compliant Appendix G)
  f8 = setCell(f8, "G9", "N/A (no residential spaces)", true);
  f8 = setCell(f8, "G11", "No", true);    // no existing space-conditioning changes
  f8 = setCell(f8, "G13", "Yes", true); f8 = setCell(f8, "G15", "Yes", true);
  f8 = setCell(f8, "K17", "Yes", true); f8 = setCell(f8, "K19", "N/A", true);
  f8 = setCell(f8, "K21", "Yes", true); f8 = setCell(f8, "K23", "Yes", true);
  // constructions: [row, New/Existing, Space-Cond, Proposed desc, Proposed U/C/F]
  const opaque: any[] = [
    ["34", "New", "Nonresidential", "Built-up roof; 3in polyurethane c.i. (~R-19) + R-2.8; plywood deck", env.roofU],
    ["44", "New", "Nonresidential", "Stucco; 3/4in board (R-5) + R-16.3 cavity insulation; gypsum board", env.wallU],
    ["74", "New", "Nonresidential", "Unheated 6in concrete slab on grade, no perimeter insulation", 0.730],
    ["84", "New", "Nonresidential", "Double-layer uninsulated metal swinging door", 0.700]];
  opaque.forEach(([r, ne, sc, desc, u]) => {
    f8 = setCell(f8, "C" + r, ne, true); f8 = setCell(f8, "D" + r, sc, true);
    f8 = setCell(f8, "H" + r, desc, true); if (u != null) f8 = setCell(f8, "I" + r, u, false);
  });
  f8 = setCell(f8, "H54", "N/A — no below-grade exterior walls (underground = slab)", true);
  f8 = setCell(f8, "H64", "N/A — no exposed floors", true);
  f8 = setCell(f8, "K34", 0.30, false); f8 = setCell(f8, "L34", 0.40, false);   // roof reflectance baseline/proposed
  zip.file("xl/worksheets/sheet8.xml", f8);
  log("  Opaque Assemblies: roof " + env.roofU + " / wall " + env.wallU + " / slab 0.730 / door 0.700 + 8 attestations + roof reflectance");

  /* --- Lighting (sheet11) — Building Area Method (works from SIM/INP even without QA) --- */
  if (lLPD) {
    let f11 = await zip.file("xl/worksheets/sheet11.xml")!.async("string");
    f11 = setCell(f11, "Z24", 1, false);                       // radio link → Building Area Method (was Space-by-Space)
    f11 = unhideRows(f11, [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]); // reveal the BAM table
    f11 = setCell(f11, "C33", "School/university", true);       // Table 9.5.1 building-area type (MSU)
    f11 = setCell(f11, "D33", Math.round(lArea), false);        // total building area
    f11 = setCell(f11, "H33", lLPD, false);                     // proposed design LPD
    zip.file("xl/worksheets/sheet11.xml", f11);
    log("  Lighting: Building Area Method (School/university) · area " + Math.round(lArea).toLocaleString() + " sf · design LPD " + lLPD + " W/sf" + ((qp && qp.lpd) ? " (QA)" : " (INP avg — paste QA for the exact area-weighted value)"));
  }

  /* --- Process Loads (sheet13) — receptacle modeling method (EPD is unregulated/documentation) --- */
  {
    let f13 = await zip.file("xl/worksheets/sheet13.xml")!.async("string");
    f13 = setCell(f13, "G16", "Building average equipment power density", true);
    zip.file("xl/worksheets/sheet13.xml", f13);
    log("  Process Loads: method = Building average" + (ePD != null ? (" · EPD " + ePD + " W/sf (enter in table; unregulated)") : ""));
  }

  /* --- force full recalc on open --- */
  let wb = await zip.file("xl/workbook.xml")!.async("string");
  wb = /<calcPr[^>]*\/>/.test(wb) ? wb.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>')
    : wb.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
  zip.file("xl/workbook.xml", wb);
  log("  workbook.xml: calcId=0 + fullCalcOnLoad=1 (forces full recalc of all formulas on open)");

  log("Re-zipping .xlsm…");
  const blob = await zip.generateAsync({
    type: "blob", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    compression: "DEFLATE", compressionOptions: { level: 6 },
  });
  const name = (proj || "MEPC").replace(/[^\w\-]+/g, "_") + "_MEPC_filled.xlsm";
  log("✓ .xlsm written → " + name + ". Open in Excel, Enable Content, press Ctrl+Alt+F9 if formulas show 0.");
  return { blob, name };
}

export function climateZone(w: string) {
  const T: [RegExp, string][] = [[/baltimore|washington|new york|central park/i, "4A"], [/chicago|boston/i, "5A"],
  [/minneapolis/i, "6A"], [/atlanta/i, "3A"], [/miami/i, "1A"], [/houston/i, "2A"],
  [/phoenix/i, "2B"], [/los angeles/i, "3B"], [/denver/i, "5B"], [/seattle/i, "4C"]];
  for (const [re, cz] of T) if (re.test(w || "")) return cz; return "";
}

/* ===================== COPY-PASTE WORKBOOK (SheetJS) ===================== */
const PERF: [string, string | null, string, string][] = [
  ["Interior lighting", "LIGHTS", "Electricity", ""], ["Exterior lighting", "EXT", "Electricity", ""],
  ["Space heating", "SP_HEAT", "Natural Gas", ""], ["Space cooling", "SP_COOL", "Electricity", ""],
  ["Pumps", "PUMPS", "Electricity", ""], ["Heat rejection", "HEAT_REJ", "Electricity", ""],
  ["Fans - interior ventilation", "FANS", "Electricity", ""], ["Fans - parking garage", null, "Electricity", "x"],
  ["Service water heating", "DHW", "Electricity", "set type=Electricity"], ["Receptacle equipment", "MISC", "Electricity", "x"],
  ["IT equipment", null, "Electricity", "x"], ["Interior lighting - process", "TASK", "Electricity", "x"],
  ["Refrigeration equipment", "REFRIG", "Electricity", "x"], ["Fans - Kitchen Ventilation", null, "Electricity", "x"],
  ["Cooking", null, "Electricity", "x"], ["Industrial Process", null, "Electricity", "x"],
  ["Elevators and escalators", null, "Electricity", "x"], ["Heat Pump Supplementary", "HP_SUP", "Electricity", ""],
  ["Space Heating (Electricity)", "SP_HEAT", "Electricity", ""], ["Misc Equipment (Natural Gas)", "MISC", "Natural Gas", ""],
  ["Auxilary (Natural Gas)", null, "Natural Gas", ""], ["Cooling (Natural Gas)", null, "Natural Gas", ""]];

export function buildDataWorkbook(R: any, log: LogFn) {
  if (!R) { log("Process files first."); return; }
  const XS = XLSX;
  const { baseRowsData: BL, propData: PR, env, proj, cz, base, lLPD, lArea, ePD, qp } = R;
  const wb = XS.utils.book_new();
  const avg = (a: any[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const cons = (c: any, col: string | null, et: string) => !col ? 0 : Math.round(et === "Natural Gas" ? (c.therm[col] || 0) : (c.kwh[col] || 0));
  const dem = (c: any, col: string | null, et: string) => (!col || et === "Natural Gas") ? "" : (c.kw && Object.keys(c.kw).length ? Math.round((c.kw[col] || 0) * 10) / 10 : "");

  /* Sheet 1 — Performance Outputs replica */
  const A: any[] = [], P = (r: any[]) => A.push(r);
  P(["Performance Rating Method Outputs — copy each value block into Performance_Outputs_1"]); P([]);
  P(["TABLE: Baseline energy summary by end use (4 rotations)"]);
  P(["End Use", "Unreg?", "Energy Type", "Units", "Baseline 0°", "Baseline 90°", "Baseline 180°", "Baseline 270°", "Design Total (avg)"]);
  for (const [n, col, et, u] of PERF) {
    const cv = BL.map((c: any) => cons(c, col, et));
    P([n, u, et, "Consumption (" + (et === "Natural Gas" ? "therm" : "kWh") + ")", cv[0], cv[1], cv[2], cv[3], Math.round(avg(cv))]);
    const dv = BL.map((c: any) => dem(c, col, et)), have = dv[0] !== "";
    P(["", "", "", "Demand (" + (et === "Natural Gas" ? "Btuh x 10^6" : "kW") + ")", dv[0], dv[1], dv[2], dv[3], have ? Math.round(avg(dv.map(Number)) * 10) / 10 : ""]);
  }
  const costs = BL.map((c: any) => Math.round(c.elecCost || 0));
  P(["Total electricity", "", "Electricity", "kWh", ...BL.map((c: any) => Math.round(c.kwh.TOTAL || 0)), Math.round(avg(BL.map((c: any) => c.kwh.TOTAL || 0)))]);
  P([]); P(["TABLE: Baseline annual energy cost by energy type"]);
  P(["Energy Type", "Units", "Baseline 0°", "Baseline 90°", "Baseline 180°", "Baseline 270°", "Design Total"]);
  P(["Electricity", "kWh", costs[0], costs[1], costs[2], costs[3], Math.round(avg(costs))]); P(["Natural Gas", "therm", 0, 0, 0, 0, 0]);
  P([]); P(["TABLE: Proposed energy summary by end use"]);
  P(["End Use", "Unreg?", "Energy Type", "Units", "Baseline (avg)", "Proposed", "Savings"]);
  for (const [n, col, et, u] of PERF) {
    const bavg = Math.round(avg(BL.map((c: any) => cons(c, col, et)))), pv = cons(PR, col, et);
    P([n, u, et, "Consumption (" + (et === "Natural Gas" ? "therm" : "kWh") + ")", bavg, pv, bavg - pv]);
    const bd = BL.map((c: any) => dem(c, col, et)), have = bd[0] !== "", pd = dem(PR, col, et);
    const ba = have ? Math.round(avg(bd.map(Number)) * 10) / 10 : "";
    P(["", "", "", "Demand", ba, pd, (ba === "" || pd === "") ? "" : Math.round(((ba as number) - (pd as number)) * 10) / 10]);
  }
  P([]); P(["TABLE: Unmet load hours"]); P(["Unmet Loads", "Baseline (avg)", "Proposed"]);
  P(["Hours heating loads not met", Math.round(avg(BL.map((c: any) => +c.heatUnmet || 0))), +PR.heatUnmet || 0]);
  P(["Hours cooling loads not met", Math.round(avg(BL.map((c: any) => +c.coolUnmet || 0))), +PR.coolUnmet || 0]);
  P([]);
  const bMb = avg(BL.map((c: any) => c.mbtu || 0)), pMb = PR.mbtu || 0, bC = avg(costs), pC = Math.round(PR.elecCost || 0);
  P(["SUMMARY"]); P(["Baseline site (avg)", Math.round(bMb) + " MBtu"]); P(["Proposed site", Math.round(pMb) + " MBtu"]);
  P(["Site energy savings", (bMb ? ((bMb - pMb) / bMb * 100).toFixed(1) : "0") + "%"]);
  P(["Baseline cost (avg)", "$" + Math.round(bC).toLocaleString()]); P(["Proposed cost", "$" + pC.toLocaleString()]);
  P(["Cost savings", (bC ? ((bC - pC) / bC * 100).toFixed(1) : "0") + "%"]);
  const ws1 = XS.utils.aoa_to_sheet(A); ws1["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 14 }, { wch: 22 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
  XS.utils.book_append_sheet(wb, ws1, "Performance Outputs");

  /* Sheet 2 — General Info */
  XS.utils.book_append_sheet(wb, XS.utils.aoa_to_sheet([
    ["General Information", "Value"], ["LEED Project Name", proj], ["Rating system", "LEED v4 BD+C: New Construction"],
    ["Unit of measurement", "IP units"], ["Simulation program", "eQUEST (" + (base.engine || "DOE-2.2") + ")"],
    ["Energy code used", "ASHRAE 90.1-2010"], ["Simulation weather file", base.weather], ["Climate zone", cz],
    ["Conditioned building area (sq ft)", base.area]]), "General Info");

  /* Sheet 3 — Shading & Fenestration */
  const ev: any[] = [], PE = (r: any[]) => ev.push(r);
  PE(["Shading & Fenestration"]); PE([]); PE(["Wall & glazing by orientation"]);
  PE(["Orientation", "Above-Grade Wall (sf)", "Vertical Glazing (sf)", "WWR %"]);
  let tw = 0, tg = 0; for (const az of ["NORTH", "EAST", "SOUTH", "WEST"]) {
    const o = env.orient(az); tw += o.wall; tg += o.glaze;
    PE([az, o.wall, o.glaze, o.wall ? (o.glaze / o.wall * 100).toFixed(1) + "%" : ""]);
  }
  PE(["Total", tw, tg, tw ? (tg / tw * 100).toFixed(1) + "%" : ""]); PE([]);
  PE(["Roof area (sf)", env.roofArea]); PE(["Thermal blocks (conditioned)", ">100"]); PE([]);
  PE(["Proposed vertical glazing — Description", "U-factor", "SHGC", "VLT"]);
  PE(["Double glazing, low-e, thermally-broken", (qp && qp.glassU) || env.glassU, (qp && qp.glassSHGC) || env.glassSHGC || "", (qp && qp.glassVLT) || env.glassVLT]);
  PE([]); PE(["Massing requirements"]); PE(["Baseline same shape/orientation as proposed", "Yes"]);
  PE(["Thermal blocks modeled identically", "Yes"]); PE(["Existing fenestration", "N/A (100% new)"]);
  XS.utils.book_append_sheet(wb, XS.utils.aoa_to_sheet(ev), "Shading & Fenestration");

  /* Sheet 4 — Opaque Assemblies */
  XS.utils.book_append_sheet(wb, XS.utils.aoa_to_sheet([
    ["Opaque Assemblies — fill New/Existing, Space-Cond, Proposed Desc & U; baseline auto-generates"], [],
    ["Construction", "New/Existing", "Space-Conditioning", "Proposed Description", "Proposed U/C/F"],
    ["Roof", "New", "Nonresidential", "Built-up + 3in polyurethane c.i. (~R-19) + R-2.8, plywood deck", env.roofU],
    ["Above-grade wall", "New", "Nonresidential", "Stucco + 3/4in board (R-5) + R-16.3 cavity + gypsum", env.wallU],
    ["Below-grade wall", "N/A", "N/A", "N/A — none (underground = slab)", "N/A"],
    ["Exposed floor", "N/A", "N/A", "N/A — none", "N/A"],
    ["Slab-on-grade", "New", "Nonresidential", "Unheated 6in slab, no perimeter insulation", "0.730 (F)"],
    ["Opaque door", "New", "Nonresidential", "Double-layer uninsulated metal swinging door", "0.700"], [],
    ["Roof solar reflectance / emittance", "Baseline 0.30 / 0.90", "Proposed 0.40 / 0.90"]]), "Opaque Assemblies");

  /* Sheet 5 — Lighting */
  XS.utils.book_append_sheet(wb, XS.utils.aoa_to_sheet([
    ["Lighting — Building Area Method"], [],
    ["Building ID", "Table 9.5.1 Building Area Type", "Total Area (sf)", "Design LPD (W/sf)"],
    [proj, "School/university", Math.round(lArea), lLPD || ""], [],
    ["Receptacle (Process) method", "Building average equipment power density"],
    ["Equipment Power Density (W/sf)", ePD != null ? ePD : ""]]), "Lighting");

  XS.writeFile(wb, (proj || "MEPC").replace(/[^\w\-]+/g, "_") + "_copypaste_tables.xlsx");
  log("✓ Downloaded copy-paste tables (.xlsx) → 5 sheets: Performance Outputs · General Info · Fenestration · Opaque · Lighting.");
}
