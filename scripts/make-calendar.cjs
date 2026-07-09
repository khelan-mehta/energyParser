// Generates "Energy Modelling Parser Tool - Daily Calendar.xlsx"
// Schedules efforts 1..6 in order, 8 h/day across business days. Extras excluded.
const XLSX = require("xlsx-js-style");

const HOURS_PER_DAY = 3;
const START = new Date(2026, 6, 6); // 2026-07-06 (month is 0-based)

// Effort colour palette (light fills) + dark text
const palette = [
  { fill: "DDEBF7", text: "1F4E78" }, // 1 blue
  { fill: "E2EFDA", text: "375623" }, // 2 green
  { fill: "FCE4D6", text: "833C00" }, // 3 orange
  { fill: "FFF2CC", text: "7F6000" }, // 4 yellow
  { fill: "E4DFEC", text: "5C3F86" }, // 5 purple
  { fill: "D6E4F0", text: "1F3864" }, // 6 steel
];

// [effort name, [ [subtask, hours], ... ] ]  — same order & hours as the scope plan
const efforts = [
  ["1. Automated Energy Results Comparison Excel", [
    ["Define comparison template & metrics schema", 6],
    ["Parse baseline vs proposed model outputs", 8],
    ["Side-by-side end-use / EUI tables + % savings", 10],
    ["Charts & styled .xlsx export", 6],
    ["Testing & validation against sample projects", 4],
  ]],
  ["2. Automated Energy Results Template Word File", [
    ["Word template & comment-ID field mapping", 6],
    ["Extract narrative & results data from model", 8],
    ["Populate tables, figures & charts into template", 10],
    ["Formatting, TOC automation & .docx export", 5],
    ["QA against Parser Test.docx", 4],
  ]],
  ["3. Project Info and Utility Dashboard", [
    ["Project info intake + utility bill ingestion & normalization", 20],
    ["Graph extraction from utility bills / charts (image -> data)", 28],
    ["Rate structure, cost calcs & reconciliation vs modeled", 22],
    ["Dashboard UI (KPIs, charts, drill-downs)", 22],
    ["Persistence, integration & testing", 8],
  ]],
  ["4. Energy Model QAQC Dashboard", [
    ["QAQC rules catalog + input/output validation checks", 22],
    ["ML training over historical model data (anomaly detection)", 30],
    ["ML-driven flagging & severity scoring", 20],
    ["Dashboard visualization of issues", 20],
    ["Report export & testing", 8],
  ]],
  ["5. Automated MEPC Calculator", [
    ["Finalize MEPC schema engine (.xlsm input fields)", 18],
    ["Prefilled mockup Excel UI (interactive)", 26],
    ["Document-driven auto-population of full workbook", 26],
    ["Calculation logic, formulas & compliance pass/fail", 20],
    ["UI integration, export & testing", 10],
  ]],
  ["6. Automated Reporting of AIA 2030 Parameters", [
    ["Zero Tool API integration (benchmark EUI)", 8],
    ["Map outputs to AIA 2030 metrics + reduction %", 8],
    ["Carbon from ESPM eGRID subregion integration", 8],
    ["Reporting template (EUI, energy, carbon) & export", 6],
    ["Testing", 3],
  ]],
];

// ---- flatten into a queue of work segments ----
const queue = [];
efforts.forEach(([name, tasks], ei) => {
  tasks.forEach(([task, hrs]) => queue.push({ ei, effort: name, task, remaining: hrs }));
});

// ---- schedule day by day ----
function nextBusinessDay(d) {
  const n = new Date(d);
  do { n.setDate(n.getDate() + 1); } while (n.getDay() === 0 || n.getDay() === 6);
  return n;
}
const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let day = new Date(START);
while (day.getDay() === 0 || day.getDay() === 6) day = nextBusinessDay(day);

const segments = []; // { dayNo, date, weekday, ei, effort, task, hours }
let dayNo = 0;
let qi = 0;
while (qi < queue.length) {
  dayNo++;
  let cap = HOURS_PER_DAY;
  const dateStr = fmt(day);
  const weekday = wd[day.getDay()];
  while (cap > 0 && qi < queue.length) {
    const item = queue[qi];
    const take = Math.min(cap, item.remaining);
    segments.push({ dayNo, date: dateStr, weekday, ei: item.ei, effort: item.effort, task: item.task, hours: take });
    item.remaining -= take;
    cap -= take;
    if (item.remaining === 0) qi++;
  }
  day = nextBusinessDay(day);
}

// ---- styles ----
const border = {
  top: { style: "thin", color: { rgb: "D9D9D9" } },
  bottom: { style: "thin", color: { rgb: "D9D9D9" } },
  left: { style: "thin", color: { rgb: "D9D9D9" } },
  right: { style: "thin", color: { rgb: "D9D9D9" } },
};
const titleStyle = {
  font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1F4E78" } },
  alignment: { vertical: "center", horizontal: "left" },
};
const headStyle = {
  font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "2E75B6" } },
  alignment: { vertical: "center", horizontal: "center", wrapText: true },
  border,
};
const s = (v, style) => ({ v, t: typeof v === "number" ? "n" : "s", s: style });
const base = (fill, extra = {}) => ({
  font: { sz: 11, color: { rgb: palette[fill].text } },
  fill: { fgColor: { rgb: palette[fill].fill } },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
  ...extra,
});
const centered = (fill) => base(fill, { alignment: { vertical: "center", horizontal: "center" } });

// ---- build rows ----
const rows = [];
rows.push([s("Energy Modelling Parser Tool — Daily Calendar (8 h/day, business days)", titleStyle),
  ...Array(5).fill(s("", titleStyle))]);
rows.push([s("Day", headStyle), s("Date", headStyle), s("Weekday", headStyle),
  s("Effort", headStyle), s("Subtask", headStyle), s("Hours", headStyle)]);

const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
const HEADER_ROWS = 2;

// group segments by day for merging Day/Date/Weekday cells
let i = 0;
while (i < segments.length) {
  const dayStart = rows.length;
  const curDay = segments[i].dayNo;
  const daySegs = [];
  while (i < segments.length && segments[i].dayNo === curDay) daySegs.push(segments[i++]);
  daySegs.forEach((seg, k) => {
    rows.push([
      s(k === 0 ? seg.dayNo : "", centered(seg.ei)),
      s(k === 0 ? seg.date : "", centered(seg.ei)),
      s(k === 0 ? seg.weekday : "", centered(seg.ei)),
      s(seg.effort, base(seg.ei)),
      s(seg.task, base(seg.ei)),
      s(seg.hours, centered(seg.ei)),
    ]);
  });
  if (daySegs.length > 1) {
    for (const c of [0, 1, 2]) merges.push({ s: { r: dayStart, c }, e: { r: rows.length - 1, c } });
  }
}
// total row
const totalStyle = {
  font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1F4E78" } },
  alignment: { vertical: "center", horizontal: "center" },
  border,
};
const grand = segments.reduce((a, x) => a + x.hours, 0);
const tr = rows.length;
rows.push([s("TOTAL", totalStyle), ...Array(4).fill(s("", totalStyle)), s(grand, totalStyle)]);
merges.push({ s: { r: tr, c: 0 }, e: { r: tr, c: 4 } });

const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!merges"] = merges;
ws["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 9 }, { wch: 42 }, { wch: 55 }, { wch: 7 }];
ws["!rows"] = rows.map((_, r) => ({ hpt: r === 0 ? 28 : r === 1 ? 22 : 18 }));
ws["!freeze"] = { xSplit: 0, ySplit: HEADER_ROWS };
ws["!autofilter"] = { ref: `A2:F${rows.length}` };

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Daily Calendar");
const out = "Energy Modelling Parser Tool - Daily Calendar.xlsx";
XLSX.writeFile(wb, out);
console.log("Wrote", out, "—", dayNo, "working days,", grand, "hours, ends", segments[segments.length - 1].date);
