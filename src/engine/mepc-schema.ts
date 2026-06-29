/* ============================================================
 *  MEPC SCHEMA ENGINE
 *  Parses the LEED v4 Minimum Energy Performance Calculator (.xlsm)
 *  into a structured, per-sheet field schema — the foundation for the
 *  interactive mockup UI, auto-fill, AI digest, and the populate/download.
 *
 *  How input fields are detected (robust, generic — works for any version):
 *   • The calculator protects every sheet; the user-editable cells are the
 *     UNLOCKED ones (cellXf <protection locked="0"/>).
 *   • We drop cells in HIDDEN rows/columns (formula-helper area).
 *   • Merged cells collapse to their anchor (top-left) → one field.
 *   • A label is the nearest text to the LEFT in the same row, else ABOVE.
 *   • Type comes from the cell's data-validation (dropdown) or number format
 *     (percent/number); options resolve from inline lists or named ranges.
 * ============================================================ */
import JSZip from "jszip";

export type MepcFieldType = "text" | "number" | "percent" | "dropdown" | "checkbox";

export interface MepcField {
  sheet: string;
  cell: string;            // anchor cell, e.g. "E10"
  ref: string;             // merged range if any, e.g. "E10:H10" (else == cell)
  row: number;
  col: number;             // 1-based
  label: string;           // associated label text
  type: MepcFieldType;
  options?: string[];      // for dropdown
  value: string | number | null;   // current/default value in the template
  filled: boolean;         // has a non-empty, non-formula value
  source?: string;         // provenance once auto/AI/manually filled
  hidden?: boolean;        // lives in a collapsed/conditional row in the template
  help?: string;           // calculator's own guidance (data-validation prompt)
}

/* A display cell in the Excel-faithful grid (anchors only; merged members omitted). */
export interface MepcGridCell {
  r: number; c: number;          // 1-based row/col of the anchor
  text: string;                  // shown text (empty for input cells — a control renders)
  input: boolean;                // editable field cell
  fieldCell?: string;            // anchor address linking to the MepcField
  rowspan: number; colspan: number;
  bold: boolean; fill: string; align: "" | "left" | "center" | "right";
  hidden: boolean;               // in a collapsed/conditional row
}
export interface MepcGrid {
  maxRow: number; maxCol: number;
  cols: number[];                // visible column numbers, in order
  rows: number[];                // visible row numbers, in order
  colWidths: Record<number, number>;  // px per visible column
  cells: MepcGridCell[];
}
export interface MepcSheetSchema { name: string; index: number; path: string; fields: MepcField[]; grid: MepcGrid; }
export interface MepcSchema { sheets: MepcSheetSchema[]; }

/* Sheets we surface in the mockup — everything AFTER "EFLH Calculator"
   (General Information / Multiple Buildings / Schedules / EFLH are excluded). */
// The sheets surfaced in the mockup, in display order. The model-derived
// sheets (energy results, envelope, lighting) come first so the auto-fill is
// front-and-centre; "Performance Outputs" (utility rates / renewables /
// exceptional calcs — mostly manual) comes last.
const SHEET_ORDER = [
  "General Information", "Results from eQuest", "Shading and Fenestration",
  "Opaque Assemblies", "Lighting", "Process Loads", "Performance_Outputs_1",
];
const INPUT_SHEETS = new Set(SHEET_ORDER);
/** Friendly tab title for a raw sheet name. */
export const SHEET_TITLE: Record<string, string> = {
  "General Information": "General Information",
  "Results from eQuest": "Energy Results",
  "Shading and Fenestration": "Shading & Fenestration",
  "Opaque Assemblies": "Opaque Assemblies",
  "Lighting": "Lighting",
  "Process Loads": "Process Loads",
  "Performance_Outputs_1": "Performance Outputs",
};

/* ---------- small column helpers ---------- */
export function colToNum(c: string): number { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
export function numToCol(n: number): string { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function splitAddr(a: string): { col: string; row: number } { const m = a.match(/^([A-Z]+)(\d+)$/)!; return { col: m[1], row: +m[2] }; }

/* ---------- read shared strings ---------- */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g))
    out.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
  return out.map(decodeXml);
}
function decodeXml(s: string): string {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/* ---------- styles: unlocked + number-format kind + display (bold/fill/align) ---------- */
interface StyleInfo {
  unlocked: Set<number>;
  numFmtKind: Map<number, "percent" | "number" | "text" | "other">;
  bold: Map<number, boolean>;
  fill: Map<number, string>;       // "#RRGGBB" or ""
  align: Map<number, "" | "left" | "center" | "right">;
}
function argbToHex(rgb?: string): string {
  if (!rgb) return ""; const h = rgb.length === 8 ? rgb.slice(2) : rgb;
  return /^[0-9a-fA-F]{6}$/.test(h) ? "#" + h.toUpperCase() : "";
}
function parseStyles(xml: string): StyleInfo {
  // custom number formats
  const fmtCode = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) fmtCode.set(+m[1], decodeXml(m[2]));
  const kindOfFmt = (id: number): "percent" | "number" | "text" | "other" => {
    if (id === 0) return "other";
    if (id === 9 || id === 10) return "percent";
    if (id === 49) return "text";
    if ((id >= 1 && id <= 8) || (id >= 37 && id <= 44)) return "number";
    const code = fmtCode.get(id);
    if (code) { if (/%/.test(code)) return "percent"; if (/@/.test(code)) return "text"; if (/[0#]/.test(code)) return "number"; }
    return "other";
  };
  // fonts → bold flag
  const fontBold: boolean[] = [];
  const fontsBlock = (xml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/) || [, ""])[1];
  for (const fm of fontsBlock.matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)) fontBold.push(/<b\s*\/>|<b\s*>/.test(fm[1] || ""));
  // fills → solid fgColor hex
  const fillColor: string[] = [];
  const fillsBlock = (xml.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/) || [, ""])[1];
  for (const fm of fillsBlock.matchAll(/<fill>([\s\S]*?)<\/fill>|<fill\/>/g)) {
    const b = fm[1] || ""; const solid = /patternType="solid"/.test(b);
    fillColor.push(solid ? argbToHex((b.match(/<fgColor[^>]*rgb="([0-9A-Fa-f]+)"/) || [])[1]) : "");
  }
  const cxm = xml.match(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/);
  const unlocked = new Set<number>(); const numFmtKind = new Map<number, "percent" | "number" | "text" | "other">();
  const bold = new Map<number, boolean>(); const fill = new Map<number, string>(); const align = new Map<number, "" | "left" | "center" | "right">();
  if (cxm) {
    const xfs = cxm[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
    xfs.forEach((xf, i) => {
      if (/<protection[^>]*locked="0"/.test(xf)) unlocked.add(i);
      numFmtKind.set(i, kindOfFmt(+(xf.match(/numFmtId="(\d+)"/) || [])[1] || 0));
      const fontId = +(xf.match(/fontId="(\d+)"/) || [])[1] || 0;
      const fillId = +(xf.match(/fillId="(\d+)"/) || [])[1] || 0;
      bold.set(i, !!fontBold[fontId]);
      fill.set(i, fillColor[fillId] || "");
      const ha = (xf.match(/<alignment[^>]*horizontal="([^"]+)"/) || [])[1] as any;
      align.set(i, ha === "center" || ha === "right" || ha === "left" ? ha : "");
    });
  }
  return { unlocked, numFmtKind, bold, fill, align };
}

/* ---------- workbook: sheet name → path, plus defined names ---------- */
async function sheetMap(zip: JSZip): Promise<{ paths: { name: string; path: string }[]; defined: Map<string, string> }> {
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const rid2tgt: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) { const id = (m[0].match(/Id="([^"]+)"/) || [])[1]; const tgt = (m[0].match(/Target="([^"]+)"/) || [])[1]; if (id && tgt) rid2tgt[id] = tgt; }
  const paths: { name: string; path: string }[] = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = decodeXml((m[0].match(/name="([^"]+)"/) || [])[1] || "");
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    const tgt = rid && rid2tgt[rid];
    if (name && tgt) paths.push({ name, path: tgt.startsWith("/") ? tgt.slice(1) : "xl/" + tgt.replace(/^\.\//, "") });
  }
  const defined = new Map<string, string>();
  for (const m of wbXml.matchAll(/<definedName\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/definedName>/g))
    if (!defined.has(m[1])) defined.set(m[1], decodeXml(m[2]));
  return { paths, defined };
}

/* ---------- per-sheet cell index ---------- */
interface Cell { addr: string; col: string; row: number; style: number; value: string | number | null; isFormula: boolean; }
function indexCells(xml: string, ss: string[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const cm of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const col = cm[1], row = +cm[2], attrs = cm[3], body = cm[4] || "";
    const style = +(attrs.match(/ s="(\d+)"/) || [])[1] || 0;
    const t = (attrs.match(/ t="([^"]+)"/) || [])[1];
    const vm = body.match(/<v>([\s\S]*?)<\/v>/);
    const isM = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/);
    const isFormula = /<f[ >]/.test(body);
    let value: string | number | null = null;
    if (t === "s" && vm) value = ss[+vm[1]] ?? null;
    else if (isM) value = decodeXml(isM[1]);
    else if (vm) { const n = +vm[1]; value = isNaN(n) ? decodeXml(vm[1]) : n; }
    cells.set(col + row, { addr: col + row, col, row, style, value, isFormula });
  }
  return cells;
}

/* ---------- merged ranges ---------- */
function parseMerges(xml: string): { anchorOf: Map<string, string>; refOf: Map<string, string> } {
  const anchorOf = new Map<string, string>(); // any member addr → anchor addr
  const refOf = new Map<string, string>();     // anchor addr → full ref
  for (const m of xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"\/>/g)) {
    const a = m[1], b = m[2]; refOf.set(a, `${a}:${b}`);
    const ca = splitAddr(a), cb = splitAddr(b);
    for (let r = ca.row; r <= cb.row; r++) for (let c = colToNum(ca.col); c <= colToNum(cb.col); c++) anchorOf.set(numToCol(c) + r, a);
  }
  return { anchorOf, refOf };
}

/* ---------- hidden rows / columns ---------- */
function parseHidden(xml: string): { cols: Set<number>; rows: Set<number> } {
  const cols = new Set<number>(); const rows = new Set<number>();
  for (const cm of xml.matchAll(/<col\b[^>]*\/>/g)) if (/hidden="1"/.test(cm[0])) { const mn = +(cm[0].match(/min="(\d+)"/) || [])[1], mx = +(cm[0].match(/max="(\d+)"/) || [])[1]; for (let c = mn; c <= mx; c++) cols.add(c); }
  for (const rm of xml.matchAll(/<row r="(\d+)"([^>]*)>/g)) if (/hidden="1"/.test(rm[2])) rows.add(+rm[1]);
  return { cols, rows };
}

/* ---------- data validations: cell → {type,options} ---------- */
function resolveListRef(ref: string, sheetCells: Map<string, Map<string, Cell>>, defined: Map<string, string>): string[] | null {
  let r = ref.trim();
  if (defined.has(r)) r = defined.get(r)!;            // named range → its definition
  // range like  SheetName!$A$2:$A$8   or  'Sheet Name'!$A$2:$A$8
  const m = r.match(/^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/);
  if (!m) return null;
  const sheet = m[1], c1 = colToNum(m[2]), r1 = +m[3], c2 = colToNum(m[4]), r2 = +m[5];
  const cells = sheetCells.get(sheet); if (!cells) return null;
  const out: string[] = [];
  for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) { const cell = cells.get(numToCol(cc) + rr); const v = cell?.value; if (v != null && v !== "") out.push(String(v)); }
  return out.length ? out : null;
}
function parseValidations(xml: string, sheetCells: Map<string, Map<string, Cell>>, defined: Map<string, string>): Map<string, { type: string; options?: string[]; prompt?: string }> {
  const out = new Map<string, { type: string; options?: string[]; prompt?: string }>();
  for (const m of xml.matchAll(/<dataValidation\b([^>]*)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
    const head = m[1], body = m[2] || "";
    const type = (head.match(/type="([^"]+)"/) || [])[1] || "";
    const sqref = (head.match(/sqref="([^"]+)"/) || [])[1] || "";
    const promptRaw = (head.match(/\bprompt="([^"]*)"/) || [])[1];
    const prompt = promptRaw ? decodeXml(promptRaw).replace(/\s+/g, " ").trim() : undefined;
    const f1 = (body.match(/<formula1>([\s\S]*?)<\/formula1>/) || [])[1];
    let options: string[] | undefined;
    if (type === "list" && f1) {
      const raw = decodeXml(f1).trim();
      if (/^".*"$/.test(raw)) options = raw.slice(1, -1).split(",").map((s) => s.trim());
      else { const r = resolveListRef(raw, sheetCells, defined); if (r) options = r; }
    }
    if (!sqref) continue;
    for (const part of sqref.split(/\s+/)) {
      // expand ranges to single anchors only (first cell)
      const a = part.split(":")[0];
      if (!/^[A-Z]+\d+$/.test(a)) continue;
      const prev = out.get(a);
      // never let a broken/option-less validation (e.g. a stray #REF!) clobber one
      // that successfully resolved its dropdown options
      if (prev && prev.options && prev.options.length && !(options && options.length)) continue;
      out.set(a, { type, options, prompt: prompt || prev?.prompt });
    }
  }
  return out;
}

/* ---------- column widths (Excel width units → px) ---------- */
function parseColWidths(xml: string): Record<number, number> {
  const w: Record<number, number> = {};
  for (const m of xml.matchAll(/<col\b[^>]*\/>/g)) {
    const width = parseFloat((m[0].match(/width="([\d.]+)"/) || [])[1]);
    if (!isFinite(width)) continue;
    const mn = +(m[0].match(/min="(\d+)"/) || [])[1], mx = +(m[0].match(/max="(\d+)"/) || [])[1];
    const px = Math.round(width * 7 + 5);
    for (let c = mn; c <= mx && c <= 80; c++) w[c] = px;
  }
  return w;
}

/* ---------- build the Excel-faithful display grid ---------- */
function buildGrid(
  cells: Map<string, Cell>, anchorOf: Map<string, string>, refOf: Map<string, string>,
  hidden: { cols: Set<number>; rows: Set<number> }, style: StyleInfo,
  fieldByCell: Map<string, MepcField>, colWidths: Record<number, number>,
): MepcGrid {
  // rows that hold at least one input field (so we keep conditional hidden rows)
  const inputRows = new Set<number>(); for (const f of fieldByCell.values()) inputRows.add(f.row);
  let maxRow = 1, maxCol = 1;
  for (const cell of cells.values()) {
    const cn = colToNum(cell.col);
    if (hidden.cols.has(cn)) continue;
    if (hidden.rows.has(cell.row) && !inputRows.has(cell.row)) continue;   // skip pure hidden helper rows
    const meaningful = (cell.value != null && cell.value !== "") || style.unlocked.has(cell.style);
    if (meaningful) { if (cell.row > maxRow) maxRow = cell.row; if (cn > maxCol) maxCol = cn; }
  }
  maxCol = Math.min(maxCol, 80); // safety cap against stray far columns (the energy-results sheet reaches col BX=76)
  const cols: number[] = []; for (let c = 1; c <= maxCol; c++) if (!hidden.cols.has(c)) cols.push(c);
  // visible rows + any hidden row that carries an input (conditional sections)
  const rows: number[] = []; for (let r = 1; r <= maxRow; r++) { if (!hidden.rows.has(r) || inputRows.has(r)) rows.push(r); }
  const colSet = new Set(cols), rowSet = new Set(rows);
  const covered = new Set<string>(); for (const [member, anchor] of anchorOf) if (member !== anchor) covered.add(member);
  const cw: Record<number, number> = {}; for (const c of cols) cw[c] = colWidths[c] || 64;

  const out: MepcGridCell[] = [];
  for (const r of rows) for (const c of cols) {
    const addr = numToCol(c) + r;
    if (covered.has(addr)) continue;
    const cell = cells.get(addr);
    const f = fieldByCell.get(addr);
    let colspan = 1, rowspan = 1;
    const ref = refOf.get(addr);
    if (ref) { const cb = splitAddr(ref.split(":")[1]); colspan = cols.filter((x) => x >= c && x <= colToNum(cb.col) && colSet.has(x)).length || 1; rowspan = rows.filter((x) => x >= r && x <= cb.row && rowSet.has(x)).length || 1; }
    const si = cell?.style ?? 0;
    out.push({
      r, c, input: !!f, fieldCell: f?.cell,
      text: f ? "" : (cell && cell.value != null ? String(cell.value).replace(/\s+/g, " ").trim() : ""),
      colspan, rowspan,
      bold: !!style.bold.get(si), fill: style.fill.get(si) || "", align: style.align.get(si) || "",
      hidden: hidden.rows.has(r),
    });
  }
  return { maxRow, maxCol, cols, rows, colWidths: cw, cells: out };
}

/* ---------- label association ---------- */
function findLabel(cells: Map<string, Cell>, col: number, row: number, unlocked: Set<number>): string {
  const isText = (c?: Cell) => c && typeof c.value === "string" && c.value.trim() !== "" && !unlocked.has(c.style);
  // nearest text to the LEFT in same row
  for (let c = col - 1; c >= 1; c--) { const cell = cells.get(numToCol(c) + row); if (isText(cell)) return String(cell!.value).replace(/\s+/g, " ").trim(); if (cell && cell.value != null && cell.value !== "") break; }
  // nearest text ABOVE in same column
  for (let r = row - 1; r >= 1 && r >= row - 6; r--) { const cell = cells.get(numToCol(col) + r); if (isText(cell)) return String(cell!.value).replace(/\s+/g, " ").trim(); }
  return "";
}

/* ============================================================ MAIN */
export async function extractMepcSchema(xlsmBuf: ArrayBuffer): Promise<MepcSchema> {
  const zip = await JSZip.loadAsync(xlsmBuf);
  const ss = parseSharedStrings(await (zip.file("xl/sharedStrings.xml")?.async("string") ?? Promise.resolve("")));
  const style = parseStyles(await zip.file("xl/styles.xml")!.async("string"));
  const { paths, defined } = await sheetMap(zip);

  // pre-index every sheet's cells (needed to resolve dropdown ranges that point at other sheets)
  const allCells = new Map<string, Map<string, Cell>>();
  const sheetXml = new Map<string, string>();
  for (const { name, path } of paths) { const xml = await zip.file(path)!.async("string"); sheetXml.set(name, xml); allCells.set(name, indexCells(xml, ss)); }

  const sheets: MepcSheetSchema[] = [];
  paths.forEach(({ name, path }, index) => {
    if (!INPUT_SHEETS.has(name)) return;
    const xml = sheetXml.get(name)!; const cells = allCells.get(name)!;
    const { anchorOf, refOf } = parseMerges(xml);
    const hidden = parseHidden(xml);
    const validations = parseValidations(xml, allCells, defined);
    // columns holding the optional "Additional Notes" entries — skip them entirely
    const noteCols = new Set<number>();
    for (const cell of cells.values()) if (typeof cell.value === "string" && /^additional notes/i.test(cell.value)) noteCols.add(colToNum(cell.col));
    const seen = new Set<string>();
    const fields: MepcField[] = [];

    for (const cell of cells.values()) {
      if (!style.unlocked.has(cell.style)) continue;                 // only user-editable cells
      // drop hidden HELPER COLUMNS (formula/scratch area) — but KEEP hidden ROWS,
      // which hold the calculator's conditional input sections (e.g. the Lighting
      // Building-Area-Method table, Opaque construction rows). Those are real inputs.
      if (hidden.cols.has(colToNum(cell.col))) continue;
      // collapse merged members to the anchor
      const anchor = anchorOf.get(cell.addr) || cell.addr;
      if (anchor !== cell.addr) continue;                            // only emit the anchor once
      if (seen.has(anchor)) continue; seen.add(anchor);
      const { col, row } = splitAddr(anchor); const colN = colToNum(col);

      const dv = validations.get(anchor);
      const fmtKind = style.numFmtKind.get(cell.style) || "other";
      let type: MepcFieldType = "text";
      if (dv && dv.type === "list" && dv.options && dv.options.length) {
        type = (dv.options.length === 2 && dv.options.every((o) => /^(yes|no)$/i.test(o.trim()))) ? "checkbox" : "dropdown";
      } else if (fmtKind === "percent") type = "percent";
      else if (fmtKind === "number") type = "number";

      const value = cell.isFormula ? null : cell.value;              // ignore formula-driven defaults
      const filled = value != null && value !== "";
      if (noteCols.has(colN)) continue;                              // optional "Additional Notes" column — skip
      const label = findLabel(cells, colN, row, style.unlocked);
      fields.push({
        sheet: name, cell: anchor, ref: refOf.get(anchor) || anchor, row, col: colN,
        label, type, options: dv?.options,
        value, filled, hidden: hidden.rows.has(row),
        help: dv?.prompt,
      });
    }
    fields.sort((a, b) => a.row - b.row || a.col - b.col);
    const fieldByCell = new Map(fields.map((f) => [f.cell, f]));
    const grid = buildGrid(cells, anchorOf, refOf, hidden, style, fieldByCell, parseColWidths(xml));
    sheets.push({ name, index, path, fields, grid });
  });

  // present the tabs in the requested order, not workbook order
  sheets.sort((a, b) => SHEET_ORDER.indexOf(a.name) - SHEET_ORDER.indexOf(b.name));
  return { sheets };
}
