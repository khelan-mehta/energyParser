/* ============================================================
 *  WORKBOOK BUILDER — styled .xlsx via xlsx-js-style
 * ============================================================ */
import * as XLSX from "xlsx-js-style";
import type { Row } from "./sim";
import { COLUMNS, ColDef } from "./columns";
import { enrichRow } from "./enrich";
import type { RateConfig } from "./rates";

export function buildWorkbook(blRows: Row[], propRows: Row[], cfg: RateConfig) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of [["BL Data", blRows], ["Proposed Data", propRows]] as [string, Row[]][]) {
    XLSX.utils.book_append_sheet(wb, buildSheet(rows, cfg), name);
  }
  return wb;
}

function buildSheet(rows: Row[], cfg: RateConfig) {
  const aoa: any[][] = [];
  aoa.push(COLUMNS.map((c) => c[0]));
  for (const row of rows) {
    const merged = enrichRow(row, cfg);
    aoa.push(COLUMNS.map(([, key, fmt]) => {
      let v = merged[key];
      if (v === undefined || v === null) v = fmt === "@" ? "" : 0;
      return v;
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const hStyle = (color: string) => ({
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 9, name: "Calibri" },
    fill: { patternType: "solid", fgColor: { rgb: color } },
    alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  });
  const dStyle = (fmt: string) => ({
    alignment: { horizontal: fmt === "@" ? "left" : "right", vertical: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  });
  const colWidths: any[] = [];
  for (let c = 0; c < COLUMNS.length; c++) {
    const [hdr, , fmt, color] = COLUMNS[c] as ColDef;
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = hStyle(color);
    let maxLen = hdr.length;
    for (let row = 1; row < aoa.length; row++) {
      const ca = XLSX.utils.encode_cell({ r: row, c });
      const cell = ws[ca];
      if (!cell) continue;
      cell.s = dStyle(fmt);
      if (fmt !== "@") cell.z = fmt;
      const sv = cell.v == null ? "" : String(cell.v);
      if (sv.length > maxLen) maxLen = sv.length;
    }
    colWidths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 40) });
  }
  ws["!cols"] = colWidths;
  ws["!rows"] = [{ hpx: 60 }];
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: COLUMNS.length - 1 } });
  return ws;
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

export function downloadWorkbook(wb: any, filename: string) {
  XLSX.writeFile(wb, filename, { bookType: "xlsx", cellStyles: true });
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
