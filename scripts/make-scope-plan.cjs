// Generates "Energy Modelling Parser Tool - Scope Plan.xlsx"
// Future scope of work, subtasks + hours evened out to a 400-hour target.
const XLSX = require("xlsx-js-style");

const goals = [
  {
    goal: "Automated Energy Results Comparison Excel",
    tasks: [
      ["Define comparison template & metrics schema (end-uses, EUI, cost)", 6],
      ["Parse baseline vs proposed model outputs into common structure", 8],
      ["Side-by-side end-use / EUI comparison tables + % savings", 10],
      ["Charts & styled .xlsx export", 6],
      ["Testing & validation against sample projects", 4],
    ],
  },
  {
    goal: "Automated Energy Results Template Word File",
    tasks: [
      ["Word template & comment-ID field mapping", 6],
      ["Extract narrative & results data from model", 8],
      ["Populate tables, figures & charts into template", 10],
      ["Formatting, TOC automation & .docx export", 5],
      ["QA against Parser Test.docx", 4],
    ],
  },
  {
    goal: "Project Info and Utility Dashboard",
    tasks: [
      ["Project info intake + utility bill ingestion & normalization", 20],
      ["Graph extraction from utility bills / charts (image → data)", 28],
      ["Rate structure, cost calcs & reconciliation vs modeled", 22],
      ["Dashboard UI (KPIs, charts, drill-downs)", 22],
      ["Persistence, integration & testing", 8],
    ],
  },
  {
    goal: "Energy Model QAQC Dashboard",
    tasks: [
      ["QAQC rules catalog + input/output validation checks", 22],
      ["ML training over historical model data (anomaly detection)", 30],
      ["ML-driven flagging & severity scoring", 20],
      ["Dashboard visualization of issues", 20],
      ["Report export & testing", 8],
    ],
  },
  {
    goal: "Automated MEPC Calculator",
    tasks: [
      ["Finalize MEPC schema engine (.xlsm input fields)", 18],
      ["Prefilled mockup Excel UI (interactive)", 26],
      ["Document-driven auto-population of full workbook", 26],
      ["Calculation logic, formulas & compliance pass/fail", 20],
      ["UI integration, export & testing", 10],
    ],
  },
  {
    goal: "Automated Reporting of AIA 2030 Parameters",
    tasks: [
      ["Zero Tool API integration (benchmark EUI)", 8],
      ["Map outputs to AIA 2030 metrics + reduction % vs baseline", 8],
      ["Carbon from ESPM eGRID subregion integration", 8],
      ["Reporting template (EUI, energy, carbon) & export", 6],
      ["Testing", 3],
    ],
  },
];

// Extra future scope — hours to be scoped later (not counted in the 400).
const extras = [
  {
    goal: "Medical Equipment Parser",
    tasks: [
      ["Parse medical equipment schedules / specs into structured data", "TBD"],
      ["Map equipment loads to energy model inputs", "TBD"],
    ],
  },
  {
    goal: "RAG from Hospital Documents",
    tasks: [
      ["Ingest & index hospital documents (vector store)", "TBD"],
      ["Retrieval-augmented Q&A / data extraction over corpus", "TBD"],
    ],
  },
];

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
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
};
const goalStyle = {
  font: { bold: true, sz: 11, color: { rgb: "1F4E78" } },
  fill: { fgColor: { rgb: "DDEBF7" } },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
};
const goalHrsStyle = {
  font: { bold: true, sz: 11, color: { rgb: "1F4E78" } },
  fill: { fgColor: { rgb: "DDEBF7" } },
  alignment: { vertical: "center", horizontal: "center" },
  border,
};
const cell = (extra = {}) => ({
  font: { sz: 11 },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
  ...extra,
});
const hrsCell = {
  font: { sz: 11 },
  alignment: { vertical: "center", horizontal: "center" },
  border,
};
const totalStyle = {
  font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1F4E78" } },
  alignment: { vertical: "center", horizontal: "center" },
  border,
};

const s = (v, style) => ({ v, t: typeof v === "number" ? "n" : "s", s: style });

const rows = [];
rows.push([s("Energy Modelling Parser Tool — Future Scope of Work", titleStyle), s("", titleStyle), s("", titleStyle), s("", titleStyle)]);
rows.push([s("Target: 400 hours", { font: { italic: true, sz: 10, color: { rgb: "808080" } } }), s("", {}), s("", {}), s("", {})]);
rows.push([s("Goal", headStyle), s("Subtask", headStyle), s("Hours", headStyle), s("Notes / Owner", headStyle)]);

let grand = 0;
const merges = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, // title
];
for (const g of goals) {
  const gTotal = g.tasks.reduce((a, [, h]) => a + h, 0);
  grand += gTotal;
  const startRow = rows.length;
  g.tasks.forEach(([task, hrs], i) => {
    rows.push([
      s(i === 0 ? `${g.goal}  (${gTotal} h)` : "", i === 0 ? goalStyle : cell()),
      s(task, cell()),
      s(hrs, hrsCell),
      s("", cell()),
    ]);
  });
  // merge the goal cell down its task rows
  merges.push({ s: { r: startRow, c: 0 }, e: { r: rows.length - 1, c: 0 } });
}
rows.push([s("TOTAL", totalStyle), s("", totalStyle), s(grand, totalStyle), s("", totalStyle)]);

// ---- extras (no hours) ----
const extraHeadStyle = {
  font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "7F6000" } },
  alignment: { vertical: "center", horizontal: "left" },
  border,
};
const extraGoalStyle = {
  font: { bold: true, sz: 11, color: { rgb: "7F6000" } },
  fill: { fgColor: { rgb: "FFF2CC" } },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
};
const extraCell = (extra = {}) => ({
  font: { sz: 11 },
  fill: { fgColor: { rgb: "FFF9E6" } },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border,
  ...extra,
});
const extraHrsCell = {
  font: { sz: 11, italic: true, color: { rgb: "808080" } },
  fill: { fgColor: { rgb: "FFF9E6" } },
  alignment: { vertical: "center", horizontal: "center" },
  border,
};
const extraTitleRow = rows.length;
rows.push([s("Extra Future Scope — hours to be scoped later", extraHeadStyle), s("", extraHeadStyle), s("", extraHeadStyle), s("", extraHeadStyle)]);
merges.push({ s: { r: extraTitleRow, c: 0 }, e: { r: extraTitleRow, c: 3 } });
for (const g of extras) {
  const startRow = rows.length;
  g.tasks.forEach(([task, hrs], i) => {
    rows.push([
      s(i === 0 ? g.goal : "", i === 0 ? extraGoalStyle : extraCell()),
      s(task, extraCell()),
      s(hrs, extraHrsCell),
      s("", extraCell()),
    ]);
  });
  merges.push({ s: { r: startRow, c: 0 }, e: { r: rows.length - 1, c: 0 } });
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!merges"] = merges;
ws["!cols"] = [{ wch: 40 }, { wch: 55 }, { wch: 8 }, { wch: 22 }];
ws["!rows"] = rows.map((_, i) => ({ hpt: i === 0 ? 28 : i === 2 ? 22 : 18 }));

// ---- summary sheet ----
const sumRows = [
  [s("Summary by Goal", titleStyle), s("", titleStyle)],
  [s("Goal", headStyle), s("Hours", headStyle)],
];
for (const g of goals) {
  const t = g.tasks.reduce((a, [, h]) => a + h, 0);
  sumRows.push([s(g.goal, cell()), s(t, hrsCell)]);
}
sumRows.push([s("TOTAL", totalStyle), s(grand, totalStyle)]);
for (const g of extras) {
  sumRows.push([s(g.goal, extraCell()), s("TBD", extraHrsCell)]);
}
const wsSum = XLSX.utils.aoa_to_sheet(sumRows);
wsSum["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
wsSum["!cols"] = [{ wch: 48 }, { wch: 10 }];
wsSum["!rows"] = sumRows.map((_, i) => ({ hpt: i === 0 ? 28 : 18 }));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Scope Plan");
XLSX.utils.book_append_sheet(wb, wsSum, "Summary");
const out = "Energy Modelling Parser Tool - Scope Plan.xlsx";
XLSX.writeFile(wb, out);
console.log("Wrote", out, "— grand total", grand, "hours");
