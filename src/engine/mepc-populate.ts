/* ============================================================
 *  MEPC POPULATE
 *  Writes a filled MepcSchema back into the calculator .xlsm. Only
 *  user/auto-filled values are written; each cell keeps the template's
 *  original style (locked/format), and a full recalc is forced on open.
 *  This runs ONLY when the user clicks "Populate" — the mockup UI is the
 *  working surface up to that point.
 * ============================================================ */
import JSZip from "jszip";
import type { MepcSchema, MepcField } from "./mepc-schema";

function escXml(s: any) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function colToNum(c: string) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

/** Set a cell's value in a worksheet XML, preserving its style (s="N").
    Numbers write as <v>; strings as inline strings. Inserts the cell in column
    order if it isn't present. */
function setCell(xml: string, addr: string, value: string | number, isStr: boolean): string {
  const styleOf = (a: string) => { const m = a.match(/ s="(\d+)"/); return m ? m[0] : ""; };
  const make = (s: string) => isStr
    ? `<c r="${addr}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`
    : `<c r="${addr}"${s}><v>${value}</v></c>`;
  let re = new RegExp(`<c r="${addr}"([^>]*?)/>`);                  // empty self-closing
  if (re.test(xml)) return xml.replace(re, (_m, a) => make(styleOf(a)));
  re = new RegExp(`<c r="${addr}"([^>]*?)>[\\s\\S]*?</c>`);          // has a body
  if (re.test(xml)) return xml.replace(re, (_m, a) => make(styleOf(a)));
  // cell not present → insert into its row in column order
  const row = addr.match(/\d+/)![0], col = addr.match(/[A-Z]+/)![0], colN = colToNum(col);
  const rowRe = new RegExp(`(<row r="${row}"[^>]*?)(/?>)`);
  const rm = xml.match(rowRe); if (!rm) return xml;                  // row missing — skip
  if (rm[2] === "/>") return xml.replace(rowRe, `$1>${make("")}</row>`);
  const bodyRe = new RegExp(`(<row r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  return xml.replace(bodyRe, (_full, open, body, close) => {
    const cells = [...body.matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)];
    let idx = body.length;
    for (const cm of cells) { if (colToNum(cm[1]) > colN) { idx = cm.index!; break; } }
    return open + body.slice(0, idx) + make("") + body.slice(idx) + close;
  });
}

/** A field's value is "written" only when the user/auto/AI gave it one. */
export function isWritable(f: MepcField): boolean {
  return f.value != null && f.value !== "";
}

/** Convert a field's UI value into the cell value + string-ness for injection.
    Percent fields hold a fraction in the cell (UI shows ×100). */
function cellValueFor(f: MepcField): { value: string | number; isStr: boolean } | null {
  if (!isWritable(f)) return null;
  // any genuine number → write as a number (so the calculator's SUM/AVG formulas
  // keep working), regardless of the cell's detected display type.
  if (typeof f.value === "number" && isFinite(f.value)) return { value: f.value, isStr: false };
  if (f.type === "number" || f.type === "percent") {
    const n = parseFloat(String(f.value).replace(/[%,\s$]/g, ""));
    if (isFinite(n)) return { value: n, isStr: false };
  }
  return { value: String(f.value), isStr: true };
}

export interface PopulateResult { blob: Blob; name: string; written: number }

/** Write every filled field of `schema` into the .xlsm and return the blob. */
export async function populateMepc(xlsmBuf: ArrayBuffer, schema: MepcSchema, projectName = "MEPC"): Promise<PopulateResult> {
  const zip = await JSZip.loadAsync(xlsmBuf);
  let written = 0;
  for (const sheet of schema.sheets) {
    const writable = sheet.fields.filter(isWritable);
    if (!writable.length) continue;
    const file = zip.file(sheet.path);
    if (!file) continue;
    let xml = await file.async("string");
    for (const f of writable) {
      const cv = cellValueFor(f); if (!cv) continue;
      xml = setCell(xml, f.cell, cv.value, cv.isStr);
      written++;
    }
    zip.file(sheet.path, xml);
  }
  // force full recalc on open so dependent formulas/outputs refresh
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    let wb = await wbFile.async("string");
    wb = /<calcPr[^>]*\/>/.test(wb)
      ? wb.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>')
      : wb.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
    zip.file("xl/workbook.xml", wb);
  }
  const blob = await zip.generateAsync({
    type: "blob", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    compression: "DEFLATE", compressionOptions: { level: 6 },
  });
  const clean = String(projectName || "MEPC").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "MEPC";
  return { blob, name: `${clean}_MEPC.xlsm`, written };
}
