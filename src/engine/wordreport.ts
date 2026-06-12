/* ============================================================
 *  WORD REPORT BUILDER
 *  Takes the user's QA/QC-ed "Energy Results Comparison" workbook and the
 *  "Energy Model Report Template.docx", and produces a filled report:
 *    • Data tables (Result Summary, Unmet Hours, Virtual Rates, and the
 *      End-Use Energy / Carbon / Cost breakdowns) are populated from the
 *      workbook's report-ready "Report" and "Input Summary" sheets.
 *    • The Site / Source / Carbon / Cost charts are lifted verbatim from
 *      the workbook as NATIVE Office charts (exact colours, fonts & UI)
 *      and dropped in next to their tables.
 *    • Derivable [bracket] text placeholders are filled.
 *
 *  We edit the .docx as a zip and only touch cell text / add chart parts,
 *  so the document's styling and structure stay intact.
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";

/* ---------- small helpers ---------- */
const norm = (s: any) => String(s ?? "").replace(/ /g, " ").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
const escXml = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A <w:t> open tag is "<w:t>" or "<w:t ...attrs...>" — NOT <w:tc>/<w:tcPr>/etc.
const WT = "<w:t(?:\\s[^>]*)?>";
const num = (v: any): number | null => (typeof v === "number" && isFinite(v)) ? v : (v != null && v !== "" && !isNaN(+v) ? +v : null);
const comma = (n: number) => Math.round(n).toLocaleString("en-US");

/* number → display string, mirroring the report's conventions */
function fmtInt(v: any) { const n = num(v); return n == null ? "-" : comma(n); }
function fmtDec(v: any, d = 2) { const n = num(v); return n == null ? "-" : n.toFixed(d); }
function fmtMoney(v: any) { const n = num(v); return n == null ? "-" : "$" + comma(n); }
function fmtPct(v: any) { const n = num(v); return n == null ? "0.0%" : (n * 100).toFixed(1) + "%"; }

type Grid = any[][];
function gridOf(ws: XLSX.WorkSheet): Grid {
  if (!ws || !ws["!ref"]) return [];
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const g: Grid = [];
  for (let row = 0; row <= r.e.r; row++) {
    const line: any[] = [];
    for (let col = 0; col <= r.e.c; col++) line.push(ws[XLSX.utils.encode_cell({ r: row, c: col })]);
    g.push(line);
  }
  return g;
}
/** raw value of a grid cell */
const rv = (cell: any) => (cell ? cell.v : undefined);
/** Excel-formatted display string of a grid cell (".w"), trimmed — exactly
    what Excel shows (e.g. " 34.8 " → "34.8", "0.062", "N/A"). */
const rw = (cell: any) => cell == null ? "" : (cell.w != null ? String(cell.w).trim() : (cell.v != null ? String(cell.v).trim() : ""));

/* ============================================================
 *  1. READ THE WORKBOOK INTO A STRUCTURED MODEL
 * ============================================================ */
export interface EndUseRow { leed: any; code: any; proposed: any; leedPct: any; codePct: any; }
export interface ReportData {
  eui: any; cei: any; eci: any;
  unmetHeating: any[]; unmetCooling: any[];          // [leed, code, proposed]
  energy: Record<string, EndUseRow>;
  carbon: Record<string, EndUseRow>;
  cost: Record<string, EndUseRow>;
  source: Record<string, EndUseRow>;
  co2eRates: any[]; costRates: any[];                 // [elec, gas, addl, dc, dh]
  params: Record<string, string[]>;                  // label → [leed, code, proposed] (Excel-formatted)
  totalFloorArea: any; climateZone: string; climateFile: string; location: string; projectName: string;
  tool: "equest" | "trace" | "honeybee" | null;
}

/** Scan an end-use block: labelCol holds the row name, then 5 value cols. */
function readEndUse(g: Grid, labelCol: number): Record<string, EndUseRow> {
  const out: Record<string, EndUseRow> = {};
  for (let r = 0; r < g.length; r++) {
    const label = rv(g[r][labelCol]);
    if (label == null || label === "" || label === 0) continue;
    out[norm(label)] = {
      leed: rv(g[r][labelCol + 2]), code: rv(g[r][labelCol + 3]), proposed: rv(g[r][labelCol + 4]),
      leedPct: rv(g[r][labelCol + 5]), codePct: rv(g[r][labelCol + 6]),
    };
  }
  return out;
}

/** City, ST from a weather-file string like "Baltimore    MD TMY2". */
function deriveLocation(climateFile: string): string {
  const t = String(climateFile || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Za-z .'\-]+?)\s+([A-Z]{2})\b/);
  return m ? `${m[1].trim()}, ${m[2]}` : t;
}

export function readWorkbook(buf: ArrayBuffer): ReportData {
  const wb = XLSX.read(buf, { cellStyles: false });
  const rep = gridOf(wb.Sheets["Report"]);
  const inp = gridOf(wb.Sheets["Input Summary"]);
  const proj = gridOf(wb.Sheets["Project Info"]);
  const bl = wb.Sheets["BL Data"], pr = wb.Sheets["Proposed Data"];
  const find = (g: Grid, col: number, label: string, valCol: number) => {
    const key = norm(label);
    for (let r = 0; r < g.length; r++) if (norm(rv(g[r][col])).includes(key)) return rv(g[r][valCol]);
    return null;
  };
  // Result summary: column B label, column D value
  const eui = find(rep, 1, "energy use intensity", 3);
  const cei = find(rep, 1, "carbon emissions intensity", 3);
  const eci = find(rep, 1, "energy cost intensity", 3);
  // Unmet hours: label col BO(66), values BP/BQ/BR (67/68/69)
  const unmetRow = (label: string) => {
    for (let r = 0; r < rep.length; r++) if (norm(rv(rep[r][66])).includes(norm(label))) return [rv(rep[r][67]), rv(rep[r][68]), rv(rep[r][69])];
    return [null, null, null];
  };
  // Virtual rates from Input Summary: row with "Unit CO2e" / "Unit Energy Cost", values L..P (11..15)
  const rateRow = (label: string) => {
    for (let r = 0; r < inp.length; r++) if (norm(rv(inp[r][9])).includes(norm(label))) return [rv(inp[r][11]), rv(inp[r][12]), rv(inp[r][13]), rv(inp[r][14]), rv(inp[r][15])];
    return [null, null, null, null, null];
  };
  // Simulation parameters (envelope/loads + HVAC/exterior) — keyed by label,
  // values taken as Excel-formatted strings so they read exactly like the workbook.
  const params: Record<string, string[]> = {};
  const addParams = (labelCol: number, valCols: number[]) => {
    for (let r = 0; r < inp.length; r++) {
      const label = rv(inp[r][labelCol]);
      if (label == null || label === "" || (typeof label === "number")) continue;
      const key = norm(label); if (!key) continue;
      params[key] = valCols.map((c) => rw(inp[r][c]));
    }
  };
  addParams(1, [5, 6, 7]);   // B label → F/G/H  (envelope + loads)
  addParams(9, [11, 12, 13]); // J label → L/M/N  (HVAC + exterior)

  const climateZone = String(find(proj, 1, "climate zone", 3) || (bl && bl["E2"]?.v) || (pr && pr["E2"]?.v) || "").trim();
  const climateFile = String((bl && bl["D2"]?.v) || (pr && pr["D2"]?.v) || "").replace(/\s+/g, " ").trim();
  const projectName = String(find(proj, 1, "project name", 3) || "").trim();
  // which simulation tool produced the model (drives the Software paragraph)
  const rp = String((pr && pr["B2"]?.v) || (bl && bl["B2"]?.v) || "").toLowerCase();
  const tool: ReportData["tool"] = /honeybee|\.hbjson/.test(rp) ? "honeybee"
    : /\.pdf\b|trace/.test(rp) ? "trace"
    : /\.sim\b|equest|doe-?2/.test(rp) ? "equest" : null;

  return {
    eui, cei, eci, tool,
    unmetHeating: unmetRow("unmet heating"), unmetCooling: unmetRow("unmet cooling"),
    energy: readEndUse(rep, 6),    // G..M
    source: readEndUse(rep, 21),   // V..AB
    carbon: readEndUse(rep, 36),   // AK..AQ
    cost: readEndUse(rep, 51),     // AZ..BF
    co2eRates: rateRow("unit co2e"), costRates: rateRow("unit energy cost"),
    params,
    totalFloorArea: find(inp, 1, "total floor area", 5),
    climateZone, climateFile, location: deriveLocation(climateFile), projectName,
  };
}

/* ============================================================
 *  2. FILL TABLE CELLS  (surgical: only replace placeholder <w:t> text)
 * ============================================================ */
const PLACEHOLDER = /^[\s ]*(?:-|0\.0%|\$[\s ]*-|\$[\s ]*0(?:\.00)?|0(?:\.0+)?%?|N\/A)?[\s ]*$/;

/** Replace, left-to-right, the placeholder value-cells in one table-row XML.
    Rebuilt positionally so identical adjacent cells fill correctly. */
function fillRow(rowXml: string, values: string[]): string {
  if (!values.length) return rowXml;
  let vi = 0, started = false, last = 0, result = "";
  const re = /<w:tc>[\s\S]*?<\/w:tc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml))) {
    const cellXml = m[0];
    result += rowXml.slice(last, m.index);
    last = m.index + cellXml.length;
    let cell = cellXml;
    if (vi < values.length) {
      const tMatch = cellXml.match(new RegExp(WT + "([\\s\\S]*?)</w:t>"));
      const text = tMatch ? tMatch[1] : "";
      const isPlaceholder = PLACEHOLDER.test(text);
      if (!started && isPlaceholder && text.trim() !== "") started = true; // first "-"/"0.0%" cell
      if (started && isPlaceholder && tMatch) {
        cell = cellXml.replace(new RegExp("(" + WT + ")[\\s\\S]*?(</w:t>)"), (_x, a, b) => a + escXml(values[vi++]) + b);
      } else if (started && !isPlaceholder) {
        vi = values.length; // passed the value block → stop
      }
    }
    result += cell;
  }
  result += rowXml.slice(last);
  return result;
}

/** Locate a table by an anchor (heading text or a first-column label) and fill
    its rows from a label→values map. Returns updated document xml. */
function fillTableByRows(
  xml: string, anchor: { headingStyle?: string; text: string },
  rowValues: (label: string) => string[] | null,
): string {
  // find anchor position
  const esc = anchor.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pos = -1;
  if (anchor.headingStyle) {
    // pStyle + text must be in the SAME paragraph (don't cross </w:p> into the TOC)
    const re = new RegExp(`<w:pStyle w:val="${anchor.headingStyle}"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
    const m = xml.match(re);
    if (m) pos = m.index!;
  }
  if (pos < 0) {
    const t = new RegExp(`${WT}\\s*${esc}\\s*</w:t>`, "i");
    const m = xml.match(t); if (m) pos = m.index!;
  }
  if (pos < 0) return xml;
  // Heading anchors sit BEFORE the table → search forward. Label anchors sit
  // INSIDE the table → use the table that contains the anchor.
  let tblStart: number;
  if (anchor.headingStyle) tblStart = xml.indexOf("<w:tbl>", pos);
  else tblStart = xml.lastIndexOf("<w:tbl>", pos);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  const tbl = xml.slice(tblStart, tblEnd);
  const newTbl = tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const firstCell = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/) || [""])[0];
    const label = [...firstCell.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim();
    const vals = rowValues(label);
    return vals && vals.length ? fillRow(row, vals) : row;
  });
  return xml.slice(0, tblStart) + newTbl + xml.slice(tblEnd);
}

/* map document end-use label → workbook key (handles aliases/typos) */
function endUseLookup(map: Record<string, EndUseRow>, label: string): EndUseRow | null {
  const n = norm(label);
  if (!n) return null;
  if (map[n]) return map[n];
  const alias: Record<string, string> = {
    "total site energy use": "total energy use", "total energy use": "total energy use",
    "energy use intensity": "energy use intensity", "carbon emissions intensity": "carbon emissions intensity",
    "regulated loads": "regulated loads", "total carbon emissions": "total carbon emissions",
    "total energy cost": "total energy cost",
  };
  if (alias[n] && map[alias[n]]) return map[alias[n]];
  // loose contains match
  for (const k of Object.keys(map)) if (k && (k === n || k.includes(n) || n.includes(k))) return map[k];
  return null;
}

function fillEndUseSection(xml: string, heading: string, data: Record<string, EndUseRow>, unit: "energy" | "carbon" | "cost"): string {
  const fmtVal = unit === "cost" ? fmtMoney : fmtInt;
  return fillTableByRows(xml, { headingStyle: "Heading3", text: heading }, (label) => {
    const row = endUseLookup(data, label);
    if (!row) return null;
    return [fmtVal(row.leed), fmtVal(row.code), fmtVal(row.proposed), fmtPct(row.leedPct), fmtPct(row.codePct)];
  });
}

/* ---------- Simulation-parameter tables: value cells are EMPTY, so we
   inject a run (reusing the cell's run-properties) or replace any existing
   placeholder text. ---------- */
function setCellText(cellXml: string, val: string): string {
  if (new RegExp(WT).test(cellXml))
    return cellXml.replace(new RegExp("(" + WT + ")[\\s\\S]*?(</w:t>)"), (_x, a, b) => a + escXml(val) + b);
  const rPr = (cellXml.match(/<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/) || [])[1] || "";
  const run = `<w:r>${rPr}<w:t xml:space="preserve">${escXml(val)}</w:t></w:r>`;
  return cellXml.replace("</w:p>", run + "</w:p>");
}

/** position of a heading paragraph (pStyle + text in the same <w:p>). */
function headingPos(xml: string, style: string, text: string): number {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:pStyle w:val="${style}"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
  const m = xml.match(re); return m ? m.index! : -1;
}

/** Fill every parameter table (WWR / U-values / HVAC / loads / exterior) that
    lives between the "Simulation Parameters" and "Detailed Results" headings.
    Rows are matched by label; LEED/Code/Proposed go into cells 2,3,4. */
function fillParamRegion(xml: string, params: Record<string, string[]>): string {
  const s = headingPos(xml, "Heading2", "Simulation Parameters"); if (s < 0) return xml;
  let e = headingPos(xml, "Heading1", "Detailed Results"); if (e < 0 || e < s) e = xml.length;
  const region = xml.slice(s, e);
  const filled = region.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
    if (cells.length < 5) return row;
    const label = [...cells[0][0].matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((x) => x[1]).join("").trim();
    const vals = params[norm(label)];
    if (!vals) return row;
    let ci = 0;
    return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => {
      const idx = ci++;
      return (idx >= 2 && idx <= 4 && vals[idx - 2] != null && vals[idx - 2] !== "") ? setCellText(c, vals[idx - 2]) : c;
    });
  });
  return xml.slice(0, s) + filled + xml.slice(e);
}

/** Replace [bracket] tokens inside the paragraph containing `anchor`, even when
    a token is split across runs — the whole paragraph is rebuilt as one run. */
function fillParagraphTokens(xml: string, anchor: string, repl: Record<string, string>): string {
  const ai = xml.indexOf(anchor); if (ai < 0) return xml;
  const ps = Math.max(xml.lastIndexOf("<w:p ", ai), xml.lastIndexOf("<w:p>", ai)); if (ps < 0) return xml;
  const pe = xml.indexOf("</w:p>", ai) + "</w:p>".length;
  const para = xml.slice(ps, pe);
  let text = [...para.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((m) => m[1]).join("");
  for (const [k, v] of Object.entries(repl)) if (v) text = text.split(k).join(escXml(v));
  const open = (para.match(/^<w:p\b[^>]*>/) || ["<w:p>"])[0];
  const pPr = (para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0];
  const rPr = (para.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [])[1] || "";
  const merged = `${open}${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  return xml.slice(0, ps) + merged + xml.slice(pe);
}

/** concatenated visible text of a paragraph block. */
function paraText(p: string): string {
  return [...p.matchAll(new RegExp(WT + "([\\s\\S]*?)</w:t>", "g"))].map((m) => m[1]).join("");
}

/** Delete whole body paragraphs whose concatenated text matches `pred`
    (never a paragraph carrying section properties). */
function removeParagraphsWhere(xml: string, pred: (t: string) => boolean): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => (!/<w:sectPr/.test(p) && pred(paraText(p)) ? "" : p));
}

/** Collapse runs of blank paragraphs (≥2 in a row → 1) from `fromText` onward,
    so the report doesn't carry the template's big empty gaps / blank pages.
    Structural paragraphs (breaks, section props, drawings, bookmarks, fields,
    tabs) are never treated as blank. */
function collapseBlankParagraphs(xml: string, fromIndex: number): string {
  const i = fromIndex; if (i < 0) return xml;
  const isBlank = (p: string) =>
    !new RegExp(WT + "[\\s\\S]*?</w:t>").test(p) &&
    !/<w:drawing|<w:br\b|<w:sectPr|<w:bookmarkStart|<w:fldChar|<w:instrText|<w:pict|<w:object|<w:tab\b/.test(p);
  let prevBlank = false;
  const tail = xml.slice(i).replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
    if (isBlank(p)) { if (prevBlank) return ""; prevBlank = true; return p; }
    prevBlank = false; return p;
  });
  return xml.slice(0, i) + tail;
}

/* ============================================================
 *  3. EMBED NATIVE CHARTS  (copied verbatim from the workbook)
 * ============================================================ */
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";

function inlineChartXml(rId: string, docPrId: number, name: string): string {
  // ~6.3" x 3.5" inline chart
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="5760720" cy="3200400"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="${escXml(name)}"/>` +
    `<wp:cNvGraphicFramePr/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rId}"/>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Insert a chart paragraph right after the table that follows `heading`. */
function insertChartAfterTable(xml: string, heading: string, chartParagraph: string): string {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:pStyle w:val="Heading3"\\/>(?:(?!</w:p>)[\\s\\S])*?${WT}\\s*${esc}\\s*</w:t>`, "i");
  const m = xml.match(re);
  let pos = m ? m.index! : -1;
  if (pos < 0) { const t = new RegExp(`${WT}\\s*${esc}\\s*</w:t>`, "i"); const mm = xml.match(t); pos = mm ? mm.index! : -1; }
  if (pos < 0) return xml;
  const tblStart = xml.indexOf("<w:tbl>", pos);
  if (tblStart < 0) return xml;
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  return xml.slice(0, tblEnd) + chartParagraph + xml.slice(tblEnd);
}

/* ============================================================
 *  4. MAIN
 * ============================================================ */
export async function buildWordReport(xlsxBuf: ArrayBuffer, docxBuf: ArrayBuffer): Promise<Blob> {
  const data = readWorkbook(xlsxBuf);

  const docZip = await JSZip.loadAsync(docxBuf);
  const xlZip = await JSZip.loadAsync(xlsxBuf);
  let doc = await docZip.file("word/document.xml")!.async("string");

  /* ---- fill the data tables ---- */
  // Result Summary (EUI / CEI / ECI) — match by row label, single value cell
  doc = fillTableByRows(doc, { text: "Energy Use Intensity (EUI)" }, (label) => {
    const n = norm(label);
    if (n.includes("energy use intensity")) return [fmtDec(data.eui)];
    if (n.includes("carbon emissions intensity")) return [fmtDec(data.cei)];
    if (n.includes("energy cost intensity")) return [fmtDec(data.eci)];
    return null;
  });
  // Unmet hours
  doc = fillTableByRows(doc, { headingStyle: "Heading2", text: "Unmet Hours" }, (label) => {
    const n = norm(label);
    if (n.includes("heating")) return data.unmetHeating.map(fmtInt);
    if (n.includes("cooling")) return data.unmetCooling.map(fmtInt);
    return null;
  });
  // Virtual rates — anchor on the heading (the "Unit CO2e Emissions" cell text
  // is split across runs, so it can't be matched directly)
  doc = fillTableByRows(doc, { headingStyle: "Heading3", text: "Virtual Rates" }, (label) => {
    const n = norm(label);
    if (n.includes("co2e")) return data.co2eRates.map((v) => fmtDec(v, 4));
    if (n.includes("energy cost") || n.includes("unit energy")) return data.costRates.map(fmtMoney);
    return null;
  });
  // Climate paragraph (location / zone / weather file)
  doc = fillParagraphTokens(doc, "The project is based", {
    "[location]": data.location,
    "[zone designation]": data.climateZone,
    "[insert name of climate file]": data.climateFile,
  });
  // Software paragraph — keep only the description for the detected tool, drop
  // the others, the "[If …]" labels and the "[Choose …]" instruction line.
  if (data.tool) {
    doc = removeParagraphsWhere(doc, (t) => {
      const s = t.trim();
      if (/Choose the correct description/i.test(s)) return true;
      if (/^\[If [^\]]*\]$/i.test(s)) return true;
      if (/simulated using Honeybee/i.test(s) && data.tool !== "honeybee") return true;
      if (/simulated using TRACE 3D Plus/i.test(s) && data.tool !== "trace") return true;
      if (/simulated using eQUEST/i.test(s) && data.tool !== "equest") return true;
      return false;
    });
  }
  // Simulation Parameters — envelope, loads, HVAC & exterior-lighting tables
  doc = fillParamRegion(doc, data.params);
  // End-use breakdowns (the page-9-onward detail)
  doc = fillEndUseSection(doc, "Energy Consumption", data.energy, "energy");
  doc = fillEndUseSection(doc, "Carbon Emissions", data.carbon, "carbon");
  doc = fillEndUseSection(doc, "Energy Cost", data.cost, "cost");

  /* ---- embed the native charts ---- */
  // copy content types
  let ct = await docZip.file("[Content_Types].xml")!.async("string");
  let rels = await docZip.file("word/_rels/document.xml.rels")!.async("string");
  let maxRid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]));
  const ctOverrides: string[] = [];
  const newRels: string[] = [];

  // chart map: workbook chart part → (doc heading to anchor after, friendly name)
  const charts: { src: string; heading: string; name: string }[] = [
    { src: "xl/charts/chart1.xml", heading: "Energy Consumption", name: "Site Energy" },
    { src: "xl/charts/chart3.xml", heading: "Energy Consumption", name: "Source Energy" },
    { src: "xl/charts/chart5.xml", heading: "Carbon Emissions", name: "Carbon Emissions" },
    { src: "xl/charts/chart7.xml", heading: "Energy Cost", name: "Energy Cost" },
  ];

  let chartIdx = 1, docPr = 900;
  for (const c of charts) {
    const srcFile = xlZip.file(c.src);
    if (!srcFile) continue;
    const chartXml = await srcFile.async("string");
    const partName = `word/charts/chart${chartIdx}.xml`;
    docZip.file(partName, chartXml);
    ctOverrides.push(`<Override PartName="/${partName}" ContentType="${CT_CHART}"/>`);
    const rId = `rId${++maxRid}`;
    newRels.push(`<Relationship Id="${rId}" Type="${REL_CHART}" Target="charts/chart${chartIdx}.xml"/>`);
    doc = insertChartAfterTable(doc, c.heading, inlineChartXml(rId, docPr++, c.name));
    chartIdx++;
  }
  if (ctOverrides.length) ct = ct.replace("</Types>", ctOverrides.join("") + "</Types>");
  if (newRels.length) rels = rels.replace("</Relationships>", newRels.join("") + "</Relationships>");

  // tidy up the template's excessive blank-paragraph gaps from the Detailed
  // Results heading onward (where the empty pages / top padding came from).
  // Anchored on the real Heading1 — never the TOC entry or the page-2 floating
  // tables — so those layouts are untouched.
  doc = collapseBlankParagraphs(doc, headingPos(doc, "Heading1", "Detailed Results"));

  docZip.file("[Content_Types].xml", ct);
  docZip.file("word/_rels/document.xml.rels", rels);
  docZip.file("word/document.xml", doc);

  return docZip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}
