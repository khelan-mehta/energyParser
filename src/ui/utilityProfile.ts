/* ============================================================
 *  Project Utility Profile — the gradient-bar graphic from the SUNY
 *  deck, now rendered PER UTILITY (shown in each rate row's "View").
 *    • green (US lowest state) → yellow (US avg) → red (US highest)
 *    • dashed grey = US average · dashed black = project state average
 *    • solid black = local value
 *  Value labels never overlap (they stack onto a second row when close).
 *  PPT export uses native, editable shapes (not a rasterised image).
 * ============================================================ */
import { store } from "../store";
import { h, toast } from "./util";
import { EIA_COMM_CENTS_PER_KWH, EIA_GAS_DOLLARS_PER_THERM, WATER_DOLLARS_PER_KGAL } from "../engine/sources";
import { EGRID_STATE_KG_PER_KWH, STATE_NAMES } from "../engine/rates";

export type Entity = "electricity" | "gas" | "carbon" | "water";
export const PROFILE_ENTITIES: Entity[] = ["electricity", "gas", "carbon", "water"];

const GREEN = "#3bb54a", YELLOW = "#f7e017", RED = "#ed1c24";

export interface ProfileBar {
  entity: Entity;
  name: string;         // "Electricity"
  unit1: string;        // top unit, e.g. "kWh"
  unit2: string;        // bottom unit, e.g. "kBtu"
  factor2: number;      // primary × factor2 → unit2 value
  min: number; max: number; usAvg: number;
  stateAvg: number | null;
  local: number | null;
  digits: number; digits2: number;
}

/* ---------- data ---------- */
function stats(table: Record<string, number>, factor = 1) {
  const vals = Object.values(table).filter((v) => isFinite(v)).map((v) => v * factor);
  return { min: Math.min(...vals), max: Math.max(...vals), usAvg: vals.reduce((a, b) => a + b, 0) / vals.length };
}
function stateVal(table: Record<string, number>, factor = 1): number | null {
  const s = store.rates.state; const v = s ? table[s] : undefined;
  return typeof v === "number" && isFinite(v) ? v * factor : null;
}

export function barFor(e: Entity): ProfileBar {
  const c = store.rates;
  const elecTbl = Object.fromEntries(Object.entries(EIA_COMM_CENTS_PER_KWH).map(([k, v]) => [k, v / 100]));
  if (e === "electricity") return { entity: e, name: "Electricity", unit1: "$/kWh", unit2: "$/kBtu", factor2: 1 / 3.412, ...stats(elecTbl), stateAvg: stateVal(elecTbl), local: c.elec_per_kwh ?? null, digits: 3, digits2: 3 };
  if (e === "gas") return { entity: e, name: "Natural Gas", unit1: "$/therm", unit2: "$/kBtu", factor2: 0.01, ...stats(EIA_GAS_DOLLARS_PER_THERM), stateAvg: stateVal(EIA_GAS_DOLLARS_PER_THERM), local: c.gas_per_therm ?? null, digits: 2, digits2: 3 };
  if (e === "carbon") return { entity: e, name: "Grid Carbon", unit1: "kgCO₂e/kWh", unit2: "kgCO₂e/kBtu", factor2: 1 / 3.412, ...stats(EGRID_STATE_KG_PER_KWH), stateAvg: stateVal(EGRID_STATE_KG_PER_KWH), local: c.elec_carbon_per_kwh ?? null, digits: 3, digits2: 3 };
  return { entity: e, name: "Water", unit1: "$/kGal", unit2: "$/CCF", factor2: 0.748, ...stats(WATER_DOLLARS_PER_KGAL), stateAvg: stateVal(WATER_DOLLARS_PER_KGAL), local: c.water_per_kgal ?? null, digits: 2, digits2: 2 };
}

const fmtN = (v: number, d: number) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

/* ---------- on-screen bar (SVG-free, DOM) ---------- */
export function renderProfileBar(bar: ProfileBar): HTMLElement {
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - bar.min) / (bar.max - bar.min || 1)) * 100));
  const wrap = h(`<div style="padding:34px 8px 30px;position:relative"></div>`);
  const track = h(`<div style="position:relative;height:26px;border-radius:4px;background:linear-gradient(90deg, ${GREEN} 0%, ${YELLOW} 50%, ${RED} 100%)"></div>`);

  // endpoint labels (min/max in both units)
  const ends = h(`<div>
    <div style="position:absolute;left:8px;top:8px;font-size:12px;color:#3a3a3f">${fmtN(bar.min, bar.digits)} ${esc2(bar.unit1)}</div>
    <div style="position:absolute;right:8px;top:8px;font-size:12px;color:#3a3a3f;text-align:right">${fmtN(bar.max, bar.digits)} ${esc2(bar.unit1)}</div>
    <div style="position:absolute;left:8px;bottom:8px;font-size:12px;color:#8a8a8f">${fmtN(bar.min * bar.factor2, bar.digits2)} ${esc2(bar.unit2)}</div>
    <div style="position:absolute;right:8px;bottom:8px;font-size:12px;color:#8a8a8f;text-align:right">${fmtN(bar.max * bar.factor2, bar.digits2)} ${esc2(bar.unit2)}</div>
  </div>`);
  wrap.appendChild(ends);

  // markers (line + top label). Labels are de-overlapped after mount.
  const markers: { v: number; label: string; color: string; dashed: boolean; bold: boolean; tip: string }[] = [];
  markers.push({ v: bar.usAvg, label: fmtN(bar.usAvg, bar.digits), color: "#9a9a9f", dashed: true, bold: false, tip: `US average` });
  if (bar.stateAvg != null) markers.push({ v: bar.stateAvg, label: fmtN(bar.stateAvg, bar.digits), color: "#0c0c0d", dashed: true, bold: false, tip: `State avg (${STATE_NAMES[store.rates.state] || store.rates.state || "—"})` });
  if (bar.local != null) markers.push({ v: bar.local, label: fmtN(bar.local, bar.digits), color: "#0c0c0d", dashed: false, bold: true, tip: `Local value` });

  const labelEls: HTMLElement[] = [];
  markers.forEach((m) => {
    const x = pos(m.v);
    track.appendChild(h(`<div title="${esc2(m.tip)}: ${esc2(m.label)} ${esc2(bar.unit1)}" style="position:absolute;left:${x}%;top:-10px;bottom:-10px;width:0;border-left:${m.bold ? 3 : 2}px ${m.dashed ? "dashed" : "solid"} ${m.color};transform:translateX(-50%)"></div>`));
    const lbl = h(`<div class="pb-label" style="position:absolute;left:${x}%;transform:translateX(-50%);font-size:12px;font-weight:${m.bold ? 800 : 400};color:${m.color};white-space:nowrap">${esc2(m.label)}</div>`);
    wrap.appendChild(lbl);
    labelEls.push(lbl);
  });

  // De-overlap: keep labels above their marker; stack onto a 2nd row if they'd collide.
  requestAnimationFrame(() => {
    const base = wrap.getBoundingClientRect();
    const items = labelEls.map((el) => { const r = el.getBoundingClientRect(); return { el, left: r.left - base.left, right: r.right - base.left }; }).sort((a, b) => a.left - b.left);
    let rowRight = [-1e9, -1e9];
    for (const it of items) {
      const row = (it.left > rowRight[0] + 6) ? 0 : (it.left > rowRight[1] + 6 ? 1 : 0);
      it.el.style.top = row === 0 ? "8px" : "-10px";
      rowRight[row] = it.right;
    }
  });

  wrap.appendChild(track);
  return wrap;
}
function esc2(s: string) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function profileLegend(): HTMLElement {
  const row = (sw: string, t: string) => `<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="flex:0 0 auto">${sw}</span><span style="font-size:12px;color:#3a3a3f">${t}</span></div>`;
  const box = (c: string) => `<span style="display:inline-block;width:26px;height:12px;border-radius:2px;background:${c}"></span>`;
  const line = (c: string, d: boolean, w: number) => `<span style="display:inline-block;width:26px;border-top:${w}px ${d ? "dashed" : "solid"} ${c};vertical-align:middle"></span>`;
  const st = STATE_NAMES[store.rates.state] || store.rates.state || "state";
  const loc = store.rates.city || store.rates.pincode || "local";
  return h(`<div style="margin-top:10px;display:flex;gap:22px;flex-wrap:wrap">
    ${row(box(GREEN), "US State Lowest")}${row(box(YELLOW), "US State Average")}${row(box(RED), "US State Highest")}
    ${row(line("#9a9a9f", true, 2), "US Average")}${row(line("#0c0c0d", true, 2), "State Avg: " + esc2(st))}${row(line("#0c0c0d", false, 3), "Local: " + esc2(loc))}
  </div>`);
}

/* ---------- editable PPT export (native shapes, not an image) ---------- */
function hex(n: number) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0"); }
function lerp(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "" + hex(pa[0] + (pb[0] - pa[0]) * t) + hex(pa[1] + (pb[1] - pa[1]) * t) + hex(pa[2] + (pb[2] - pa[2]) * t);
}
function gradColor(t: number) { return t < 0.5 ? lerp(GREEN, YELLOW, t / 0.5) : lerp(YELLOW, RED, (t - 0.5) / 0.5); }

export async function exportProfilePptxEditable(entities: Entity[] = PROFILE_ENTITIES) {
  try {
    const { default: PptxGenJS } = await import("pptxgenjs");
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "EMP169", width: 13.333, height: 7.5 });
    pptx.layout = "EMP169";
    const slide = pptx.addSlide();
    slide.addText("Project Utility Profile", { x: 0.4, y: 0.25, w: 9, h: 0.6, fontSize: 30, bold: true, fontFace: "Arial" });

    const bars = entities.map(barFor);
    const barX = 3.0, barW = 6.0, barH = 0.34, seg = 30;
    bars.forEach((b, i) => {
      const cy = 1.5 + i * 1.35;                 // bar top
      slide.addText([{ text: b.name, options: { bold: true, fontSize: 15 } }], { x: 0.4, y: cy - 0.12, w: 2.4, h: 0.5, fontFace: "Arial" });
      // gradient as editable segments
      for (let s = 0; s < seg; s++) {
        slide.addShape(pptx.ShapeType.rect, { x: barX + (barW / seg) * s, y: cy, w: barW / seg + 0.01, h: barH, fill: { color: gradColor(s / (seg - 1)) }, line: { type: "none" } });
      }
      // endpoints
      slide.addText(`${fmtN(b.min, b.digits)} ${b.unit1}`, { x: barX - 0.6, y: cy - 0.42, w: 1.6, h: 0.3, fontSize: 10, align: "left" });
      slide.addText(`${fmtN(b.max, b.digits)} ${b.unit1}`, { x: barX + barW - 1.0, y: cy - 0.42, w: 1.6, h: 0.3, fontSize: 10, align: "right" });
      slide.addText(`${fmtN(b.min * b.factor2, b.digits2)} ${b.unit2}`, { x: barX - 0.6, y: cy + barH + 0.02, w: 1.6, h: 0.3, fontSize: 10, align: "left", color: "8a8a8f" });
      slide.addText(`${fmtN(b.max * b.factor2, b.digits2)} ${b.unit2}`, { x: barX + barW - 1.0, y: cy + barH + 0.02, w: 1.6, h: 0.3, fontSize: 10, align: "right", color: "8a8a8f" });
      // markers
      const mx = (v: number) => barX + Math.max(0, Math.min(1, (v - b.min) / (b.max - b.min || 1))) * barW;
      const mark = (v: number | null, color: string, dash: any, wpt: number, label: string, bold: boolean) => {
        if (v == null) return;
        slide.addShape(pptx.ShapeType.line, { x: mx(v), y: cy - 0.14, w: 0, h: barH + 0.28, line: { color, width: wpt, dashType: dash } });
        slide.addText(label, { x: mx(v) - 0.5, y: cy - 0.44, w: 1.0, h: 0.3, fontSize: 11, bold, align: "center", color });
      };
      mark(b.usAvg, "9a9a9f", "dash", 1, fmtN(b.usAvg, b.digits), false);
      mark(b.stateAvg, "0c0c0d", "dash", 1, fmtN(b.stateAvg!, b.digits), false);
      mark(b.local, "0c0c0d", "solid", 2, b.local != null ? fmtN(b.local, b.digits) : "", true);
    });

    // legend
    const lx = 10.0; let ly = 1.5;
    slide.addText("Legend", { x: lx, y: ly - 0.4, w: 2.6, h: 0.3, bold: true, fontSize: 13 });
    const swatch = (color: string, text: string, isLine: boolean, dash?: any) => {
      if (isLine) slide.addShape(pptx.ShapeType.line, { x: lx, y: ly + 0.09, w: 0.4, h: 0, line: { color, width: 2, dashType: dash || "solid" } });
      else slide.addShape(pptx.ShapeType.rect, { x: lx, y: ly, w: 0.4, h: 0.18, fill: { color }, line: { type: "none" } });
      slide.addText(text, { x: lx + 0.55, y: ly - 0.08, w: 2.6, h: 0.32, fontSize: 11 });
      ly += 0.42;
    };
    swatch(GREEN.slice(1), "US State Lowest", false);
    swatch(YELLOW.slice(1), "US State Average", false);
    swatch(RED.slice(1), "US State Highest", false);
    swatch("9a9a9f", "US Average", true, "dash");
    swatch("0c0c0d", "State Average", true, "dash");
    swatch("0c0c0d", "Local Value", true, "solid");

    const name = `${(store.currentProject?.name || "Project").replace(/[\\/:*?"<>|]+/g, " ").trim()}_Utility Profile.pptx`;
    await pptx.writeFile({ fileName: name });
    toast("✓ Editable PPT exported");
  } catch (e: any) { toast("PPT export failed — " + e.message); }
}
