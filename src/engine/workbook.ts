/* ============================================================
 *  WORKBOOK BUILDER — clones the styled .xlsx template, clears its
 *  data rows, and populates them. The template (src/assets/
 *  energy_template.xlsx) owns ALL formatting — headers, colours,
 *  fonts, borders, number formats. We edit the .xlsx as a zip and
 *  inject ONLY cell values into the worksheet XML; styles.xml and the
 *  header row are never rewritten, so the download is byte-for-byte the
 *  company sample with the values swapped in. (xlsx-js-style cannot
 *  round-trip this Excel-authored file's fills, hence the zip surgery.)
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import type { Row } from "./sim";
import { COLUMNS } from "./columns";
import { enrichRow } from "./enrich";
import type { RateConfig } from "./rates";
import templateUrl from "../assets/energy_template.xlsx?url";

/* fetch the bundled template once and reuse the buffer */
let _tplBuf: Promise<ArrayBuffer> | null = null;
function loadTemplate(): Promise<ArrayBuffer> {
  if (!_tplBuf) _tplBuf = fetch(templateUrl).then((r) => {
    if (!r.ok) throw new Error(`template fetch failed (HTTP ${r.status})`);
    return r.arrayBuffer();
  });
  return _tplBuf;
}

function escXml(s: any) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 0-based column index → spreadsheet letters (0→A, 25→Z, 26→AA, 131→EB). */
function colLetter(n: number): string {
  let s = ""; n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** display-name → worksheet xml path, via workbook.xml + its rels. */
async function sheetPathMap(zip: JSZip): Promise<Record<string, string>> {
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const rid2tgt: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const tgt = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && tgt) rid2tgt[id] = tgt;
  }
  const map: Record<string, string> = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = (m[0].match(/name="([^"]+)"/) || [])[1];
    const rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    let tgt = rid && rid2tgt[rid];
    if (name && tgt) map[name] = tgt.startsWith("/") ? tgt.slice(1) : "xl/" + tgt.replace(/^\.\//, "");
  }
  return map;
}

/* Rebuild a worksheet's <sheetData> by keeping the header row (r="1")
   verbatim and cloning the template's first data row (r="2") — with its
   per-column style indices — once per data row, injecting values. */
function injectSheet(xml: string, rows: Row[], cfg: RateConfig): string {
  const sd = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sd) return xml;
  const headerRow = (sd[1].match(/<row r="1"[\s\S]*?<\/row>/) || [""])[0];
  const proto = sd[1].match(/<row r="2"([^>]*)>([\s\S]*?)<\/row>/);
  if (!proto) return xml;
  const protoAttrs = proto[1];

  // map column-letter → ONLY the style attr (s="N") from the prototype data row.
  // The row may be SPARSE (Excel omits empty cells) so we key by real column
  // letter. We deliberately drop any cell TYPE (t="s"/"str"/…) and value the
  // prototype carried — otherwise a leftover t="s" collides with the type we add
  // and produces malformed XML that Excel silently "repairs" (wiping the sheet).
  const protoAttrByCol: Record<string, string> = {};
  for (const cm of proto[2].matchAll(/<c r="([A-Z]+)2"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g))
    protoAttrByCol[cm[1]] = (cm[2].match(/\ss="\d+"/) || [""])[0];

  const lastCol = COLUMNS.length - 1;
  const dataRows: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const R = i + 2; // header is row 1; data starts at row 2
    const merged = enrichRow(rows[i], cfg);
    let cs = "";
    for (let c = 0; c <= lastCol; c++) {
      const col = colLetter(c);
      const attrs = protoAttrByCol[col] || "";
      const fmt = COLUMNS[c][2];
      let v: any = merged[COLUMNS[c][1]];
      if (v === undefined || v === null) v = fmt === "@" ? "" : 0;
      const ref = `${col}${R}`;
      if (typeof v === "number" && isFinite(v)) cs += `<c r="${ref}"${attrs}><v>${v}</v></c>`;
      else if (v === "") cs += `<c r="${ref}"${attrs}/>`;
      else cs += `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }
    dataRows.push(`<row r="${R}"${protoAttrs}>${cs}</row>`);
  }

  const lastColLetter = colLetter(lastCol);
  const lastRow = Math.max(rows.length + 1, 1);
  return xml
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, () => `<sheetData>${headerRow}${dataRows.join("")}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\/>/, () => `<dimension ref="A1:${lastColLetter}${lastRow}"/>`);
}

/** Set a single existing cell's value in a worksheet's XML, keeping its style
    (s="N") and choosing the correct type (number vs inline string). Used for the
    handful of "Project Info" metadata inputs. */
function setSheetCellValue(xml: string, addr: string, value: string | number): string {
  const isNum = typeof value === "number" && isFinite(value);
  const re = new RegExp(`<c r="${addr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const body = isNum ? `<v>${value}</v>` : `t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is>`;
  if (re.test(xml)) {
    return xml.replace(re, (_m, attrs) => {
      const s = (String(attrs).match(/\ss="\d+"/) || [""])[0];
      return isNum ? `<c r="${addr}"${s}>${body}</c>` : `<c r="${addr}"${s} ${body}</c>`;
    });
  }
  return xml; // cell not present — skip rather than risk a malformed insert
}

export interface WorkbookMeta { projectName?: string; }

/** Clone the styled template and populate its BL / Proposed sheets (+ a few
    Project Info inputs). Returns a ready-to-download .xlsx Blob. */
export async function buildWorkbook(blRows: Row[], propRows: Row[], cfg: RateConfig, meta: WorkbookMeta = {}): Promise<Blob> {
  const zip = await JSZip.loadAsync(await loadTemplate());
  const paths = await sheetPathMap(zip);
  const blName = Object.keys(paths).find((n) => /^bl\s*data/i.test(n)) || Object.keys(paths).find((n) => /^bl/i.test(n));
  const propName = Object.keys(paths).find((n) => /^proposed\s*data/i.test(n)) || Object.keys(paths).find((n) => /proposed/i.test(n));
  if (blName) zip.file(paths[blName], injectSheet(await zip.file(paths[blName])!.async("string"), blRows, cfg));
  if (propName) zip.file(paths[propName], injectSheet(await zip.file(paths[propName])!.async("string"), propRows, cfg));

  // Project Info metadata — overwrite the template's stale sample values with the
  // current project's. (D4 name · D5 ASHRAE climate zone · D7 conditioned area)
  const piName = Object.keys(paths).find((n) => /project\s*info/i.test(n));
  if (piName) {
    const sample = propRows[0] || blRows[0];
    let pi = await zip.file(paths[piName])!.async("string");
    if (meta.projectName) pi = setSheetCellValue(pi, "D4", meta.projectName);
    const cz = sample?.climate_zone;
    if (cz != null && cz !== "") pi = setSheetCellValue(pi, "D5", String(cz));
    const area = sample?.conditioned_floor_area || sample?.total_floor_area;
    if (typeof area === "number" && area > 0) pi = setSheetCellValue(pi, "D7", area);
    zip.file(paths[piName], pi);
  }

  // Force Excel to recompute every formula (and thus refresh the SiteE/SourceE/
  // Carbon/Cost charts and Report/Input-Summary tables) the moment it opens.
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    let wbXml = await wbFile.async("string");
    wbXml = /<calcPr[^>]*\/>/.test(wbXml)
      ? wbXml.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="191028" fullCalcOnLoad="1"/>')
      : wbXml.replace("</workbook>", '<calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>');
    zip.file("xl/workbook.xml", wbXml);
  }

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}

/** Generic builder for the customizable-tables view: arbitrary columns + AOA. */
export function buildCustomSheet(headers: string[], aoaBody: any[][], sheetName = "Custom") {
  const wb = XLSX.utils.book_new();
  const aoa = [headers, ...aoaBody];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const hStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
    fill: { patternType: "solid", fgColor: { rgb: "E4002B" } },
    alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  const widths: any[] = [];
  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = hStyle;
    let maxLen = String(headers[c]).length;
    for (let r = 1; r < aoa.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      cell.s = {
        alignment: { horizontal: typeof cell.v === "number" ? "right" : "left", vertical: "center" },
        border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
      };
      const sv = cell.v == null ? "" : String(cell.v);
      if (sv.length > maxLen) maxLen = sv.length;
    }
    widths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 40) });
  }
  ws["!cols"] = widths;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

export function downloadWorkbook(wbOrBlob: any, filename: string) {
  if (typeof Blob !== "undefined" && wbOrBlob instanceof Blob) {
    const url = URL.createObjectURL(wbOrBlob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  XLSX.writeFile(wbOrBlob, filename, { bookType: "xlsx", cellStyles: true });
}

/** Build a workbook with several styled sheets (used by the TRACE export). */
export function buildMultiSheet(sheets: { name: string; headers: string[]; rows: any[][] }[]) {
  const wb = XLSX.utils.book_new();
  const hStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
    fill: { patternType: "solid", fgColor: { rgb: "E4002B" } },
    alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  for (const s of sheets) {
    const aoa = [s.headers, ...s.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const widths: any[] = [];
    for (let c = 0; c < s.headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = hStyle;
      let maxLen = String(s.headers[c]).length;
      for (let r = 1; r < aoa.length; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        cell.s = {
          alignment: { horizontal: typeof cell.v === "number" ? "right" : "left", vertical: "center" },
          border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
        };
        const sv = cell.v == null ? "" : String(cell.v);
        if (sv.length > maxLen) maxLen = sv.length;
      }
      widths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 44) });
    }
    ws["!cols"] = widths;
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return wb;
}
