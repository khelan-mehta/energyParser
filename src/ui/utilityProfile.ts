/* ============================================================
 *  Project Utility Profile — the gradient-bar graphic from the
 *  SUNY deck (slides 6 & 7). A single canvas draw routine powers both
 *  the on-screen graphic (crisp + tooltips) and the PPT export, so the
 *  two are guaranteed pixel-identical.
 *
 *    Slide 6 · Electricity · Natural Gas · Grid Carbon
 *    Slide 7 · Water · Sewer · Irrigation
 *
 *  Each bar: green (US lowest state) → yellow (US average) → red (US
 *  highest state); a dashed line marks the project's state average, a
 *  solid black line marks the local value; carbon adds a blue marker
 *  for natural-gas carbon.
 * ============================================================ */
import { store } from "../store";
import { h, toast } from "./util";
import { EIA_COMM_CENTS_PER_KWH, EIA_GAS_DOLLARS_PER_THERM, WATER_DOLLARS_PER_KGAL } from "../engine/sources";
import { EGRID_STATE_KG_PER_KWH, STATE_NAMES } from "../engine/rates";

const W = 1280, H = 720;              // 16:9, matches a 13.333"×7.5" slide
const GREEN = "#3bb54a", YELLOW = "#f7e017", RED = "#ed1c24", BLUE = "#2f6fed";

export interface ProfileBar {
  cat: string;          // "Utility Rate" / "Grid" caption line
  name: string;         // "Electricity"
  unitNote: string;     // "Values in kBtu"
  unit1: string;        // top unit label, e.g. "kWh"
  unit2: string;        // bottom unit label, e.g. "kBtu"
  factor2: number;      // primary value × factor2 → unit2 value
  min: number; max: number; usAvg: number;   // US state low / high / average (primary unit)
  stateAvg?: number | null;                   // project state average (dashed)
  local?: number | null;                      // local sourced value (solid black)
  blue?: { value: number; label: string } | null; // extra marker (gas carbon)
  digits: number;       // decimals for primary unit
  digits2: number;      // decimals for secondary unit
}
export interface ProfileSlide { title: string; bars: ProfileBar[]; sources: string[]; }

/* ---------- data ---------- */
function stats(table: Record<string, number>, factor = 1) {
  const vals = Object.values(table).filter((v) => isFinite(v)).map((v) => v * factor);
  const min = Math.min(...vals), max = Math.max(...vals);
  const usAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min, max, usAvg };
}
function stateVal(table: Record<string, number>, factor = 1): number | null {
  const s = store.rates.state; const v = s ? table[s] : undefined;
  return typeof v === "number" && isFinite(v) ? v * factor : null;
}

export function buildProfileSlides(): { slide6: ProfileSlide; slide7: ProfileSlide } {
  const c = store.rates;
  const elecTbl = Object.fromEntries(Object.entries(EIA_COMM_CENTS_PER_KWH).map(([k, v]) => [k, v / 100])); // ¢→$
  const eS = stats(elecTbl), gS = stats(EIA_GAS_DOLLARS_PER_THERM), cS = stats(EGRID_STATE_KG_PER_KWH), wS = stats(WATER_DOLLARS_PER_KGAL);

  const slide6: ProfileSlide = {
    title: "Project Utility Profile",
    bars: [
      { cat: "Utility Rate", name: "Electricity", unitNote: "Values in kBtu", unit1: "kWh", unit2: "kBtu", factor2: 1 / 3.412,
        ...eS, stateAvg: stateVal(elecTbl), local: c.elec_per_kwh ?? null, digits: 2, digits2: 2 },
      { cat: "Utility Rate", name: "Natural Gas", unitNote: "Values in $/kBtu", unit1: "$/therm", unit2: "$/kBtu", factor2: 0.01,
        ...gS, stateAvg: stateVal(EIA_GAS_DOLLARS_PER_THERM), local: c.gas_per_therm ?? null, digits: 2, digits2: 3 },
      { cat: "Grid", name: "Carbon Emissions", unitNote: "Values in kgCO2e/kBtu", unit1: "kgCO2e/kWh", unit2: "kgCO2e/kBtu", factor2: 1 / 3.412,
        ...cS, stateAvg: stateVal(EGRID_STATE_KG_PER_KWH), local: c.elec_carbon_per_kwh ?? null, digits: 3, digits2: 3,
        blue: c.gas_carbon_per_therm ? { value: (c.gas_carbon_per_therm / 100) * 3.412, label: "Natural Gas Carbon" } : null },
    ],
    sources: [
      "Electricity Utility Rates: OpenEI Utility Rate Database (IURDB), U.S. Department of Energy (2026)",
      "Natural Gas Utility Rates: Opendata — U.S. Energy Information Administration (EIA)",
      "Grid Carbon Emissions: NREL — Government website",
    ],
  };

  // Sewer & irrigation have no per-state table; use municipal-survey estimate ranges.
  const sewer = { min: 3.0, max: 14.0, usAvg: 6.5 }, irrig = { min: 1.5, max: 10.0, usAvg: 4.5 };
  const slide7: ProfileSlide = {
    title: "Project Utility Profile",
    bars: [
      { cat: "Utility Rate", name: "Water Service", unitNote: "Values in $/kGal", unit1: "$/kGal", unit2: "$/CCF", factor2: 0.748,
        ...wS, stateAvg: stateVal(WATER_DOLLARS_PER_KGAL), local: c.water_per_kgal ?? null, digits: 2, digits2: 2 },
      { cat: "Utility Rate", name: "Sewer", unitNote: "Values in $/kGal", unit1: "$/kGal", unit2: "$/CCF", factor2: 0.748,
        ...sewer, stateAvg: null, local: c.sewer_per_kgal ?? null, digits: 2, digits2: 2 },
      { cat: "Utility Rate", name: "Irrigation", unitNote: "Values in $/kGal", unit1: "$/kGal", unit2: "$/CCF", factor2: 0.748,
        ...irrig, stateAvg: null, local: c.irrigation_per_kgal ?? null, digits: 2, digits2: 2 },
    ],
    sources: [
      "Water Utility Rates: Circle of Blue — Water Pricing (2026)",
      "Sewer & Irrigation Rates: Estimated from municipal utility rate surveys",
    ],
  };
  return { slide6, slide7 };
}

/* ---------- draw ---------- */
export interface Hotspot { x: number; y: number; w: number; h: number; text: string; }

const BAR_X = 300, BAR_W = 520, ROW_H = 150, ROW_TOP = 150, BAR_H = 26;

function fmtN(v: number, d: number): string { return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

/** Draw one slide onto ctx (W×H). Returns tooltip hotspots (canvas coords). */
export function drawProfileSlide(ctx: CanvasRenderingContext2D, slide: ProfileSlide): Hotspot[] {
  const hs: Hotspot[] = [];
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // title
  ctx.fillStyle = "#0c0c0d"; ctx.font = "800 42px 'Libre Franklin', sans-serif";
  ctx.fillText(slide.title, 44, 74);

  slide.bars.forEach((b, i) => {
    const cy = ROW_TOP + i * ROW_H + 40;      // bar vertical centre
    const barY = cy - BAR_H / 2;

    // left label block
    ctx.fillStyle = "#0c0c0d"; ctx.font = "800 22px 'Libre Franklin', sans-serif";
    ctx.fillText(b.cat, 44, cy - 6);
    ctx.fillText(b.name, 44, cy + 20);
    ctx.fillStyle = "#8a8a8f"; ctx.font = "400 13px 'Libre Franklin', sans-serif";
    ctx.fillText(b.unitNote, 44, cy + 42);

    // gradient bar
    const grad = ctx.createLinearGradient(BAR_X, 0, BAR_X + BAR_W, 0);
    grad.addColorStop(0, GREEN); grad.addColorStop(0.5, YELLOW); grad.addColorStop(1, RED);
    ctx.fillStyle = grad; roundRect(ctx, BAR_X, barY, BAR_W, BAR_H, 3); ctx.fill();

    // endpoint labels (min left, max right — both units)
    ctx.fillStyle = "#3a3a3f"; ctx.font = "400 15px 'Libre Franklin', sans-serif"; ctx.textAlign = "start";
    ctx.fillText(`${fmtN(b.min, b.digits)} ${b.unit1}`, BAR_X - 4, barY - 8);
    ctx.fillText(`${fmtN(b.min * b.factor2, b.digits2)} ${b.unit2}`, BAR_X - 4, barY + BAR_H + 20);
    ctx.textAlign = "end";
    ctx.fillText(`${fmtN(b.max, b.digits)} ${b.unit1}`, BAR_X + BAR_W + 4, barY - 8);
    ctx.fillText(`${fmtN(b.max * b.factor2, b.digits2)} ${b.unit2}`, BAR_X + BAR_W + 4, barY + BAR_H + 20);
    ctx.textAlign = "start";

    const xAt = (val: number) => BAR_X + Math.max(0, Math.min(1, (val - b.min) / (b.max - b.min))) * BAR_W;

    // US average (grey dashed)
    marker(ctx, hs, xAt(b.usAvg), barY, `${fmtN(b.usAvg, b.digits)}`, "#9a9a9f", true, false, `US average · ${fmtN(b.usAvg, b.digits)} ${b.unit1}`);
    // state average (black dashed)
    if (b.stateAvg != null) marker(ctx, hs, xAt(b.stateAvg), barY, `${fmtN(b.stateAvg, b.digits)}`, "#0c0c0d", true, false, `State avg (${STATE_NAMES[store.rates.state] || store.rates.state}) · ${fmtN(b.stateAvg, b.digits)} ${b.unit1}`);
    // local value (solid black, bold)
    if (b.local != null) marker(ctx, hs, xAt(b.local), barY, `${fmtN(b.local, b.digits)}`, "#0c0c0d", false, true, `Local value · ${fmtN(b.local, b.digits)} ${b.unit1}`);
    // gas carbon (blue)
    if (b.blue) marker(ctx, hs, xAt(b.blue.value), barY, ``, BLUE, false, false, `${b.blue.label} · ${fmtN(b.blue.value, b.digits)} ${b.unit1}`);
  });

  legend(ctx, slide);
  // sources
  ctx.fillStyle = "#9a9a9f"; ctx.font = "400 12px 'Libre Franklin', sans-serif"; ctx.textAlign = "start";
  ctx.fillText("Source:", 44, H - 74);
  slide.sources.forEach((s, i) => ctx.fillText(s, 44, H - 54 + i * 18));
  return hs;
}

function marker(ctx: CanvasRenderingContext2D, hs: Hotspot[], x: number, barY: number, label: string, color: string, dashed: boolean, bold: boolean, tip: string) {
  const top = barY - 16, bot = barY + BAR_H + 16;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = bold ? 3 : 2;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
  ctx.restore();
  if (label) {
    ctx.fillStyle = color; ctx.textAlign = "center";
    ctx.font = `${bold ? 800 : 400} 15px 'Libre Franklin', sans-serif`;
    ctx.fillText(label, x, top - 5);
    ctx.textAlign = "start";
  }
  hs.push({ x: x - 10, y: top, w: 20, h: bot - top, text: tip });
}

function legend(ctx: CanvasRenderingContext2D, slide: ProfileSlide) {
  const x = 1000; let y = 200;
  ctx.textAlign = "start";
  ctx.fillStyle = "#0c0c0d"; ctx.font = "800 18px 'Libre Franklin', sans-serif";
  ctx.fillText("Legend", x, y); y += 26;
  const swatch = (draw: () => void, text: string) => {
    draw();
    ctx.fillStyle = "#3a3a3f"; ctx.font = "400 14px 'Libre Franklin', sans-serif";
    ctx.fillText(text, x + 42, y + 5); y += 28;
  };
  const box = (col: string) => { ctx.fillStyle = col; roundRect(ctx, x, y - 8, 30, 14, 2); ctx.fill(); };
  const line = (col: string, dash: boolean, lw: number) => { ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash(dash ? [5, 4] : []); ctx.beginPath(); ctx.moveTo(x, y - 1); ctx.lineTo(x + 30, y - 1); ctx.stroke(); ctx.restore(); };
  swatch(() => box(GREEN), "US State Lowest Value");
  swatch(() => box(YELLOW), "US State Average Value");
  swatch(() => box(RED), "US State Highest Value");
  const stName = STATE_NAMES[store.rates.state] || store.rates.state || "state";
  const locName = store.rates.city || store.rates.location_name?.split(",")[0] || "local";
  swatch(() => line("#0c0c0d", true, 2), `State Average: ${stName}`);
  swatch(() => line("#0c0c0d", false, 3), `Local Value: ${locName}`);
  if (slide.bars.some((b) => b.blue)) swatch(() => line(BLUE, false, 2), "Natural Gas Carbon");
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------- on-screen card ---------- */
export function utilityProfileCard(): HTMLElement {
  const { slide6, slide7 } = buildProfileSlides();
  const card = h(`<div class="card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">📊</div><h3>Project Utility Profile</h3>
      <div class="right"><button class="btn btn-sm btn-dark" id="up-ppt">⬇ Export PPT</button></div></div>
    <div id="up-canvases"></div>
  </div>`);
  const holder = card.querySelector("#up-canvases") as HTMLElement;
  [slide6, slide7].forEach((slide) => holder.appendChild(profileCanvas(slide)));
  card.querySelector("#up-ppt")!.addEventListener("click", () => exportProfilePptx([slide6, slide7]));
  return card;
}

function profileCanvas(slide: ProfileSlide): HTMLElement {
  const wrap = h(`<div style="position:relative;margin-top:8px"></div>`);
  const cv = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = "100%"; cv.style.height = "auto"; cv.style.border = "1px solid var(--g150)"; cv.style.borderRadius = "10px";
  const ctx = cv.getContext("2d")!; ctx.scale(dpr, dpr);
  const hs = drawProfileSlide(ctx, slide);
  wrap.appendChild(cv);

  // tooltip
  const tip = h(`<div style="position:absolute;pointer-events:none;background:#0c0c0d;color:#fff;font-size:12px;padding:5px 9px;border-radius:6px;white-space:nowrap;opacity:0;transition:opacity .1s;z-index:5"></div>`);
  wrap.appendChild(tip);
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = W / r.width, sy = H / r.height;
    const mx = (e.clientX - r.left) * sx, my = (e.clientY - r.top) * sy;
    const hit = hs.find((z) => mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h);
    if (hit) { tip.textContent = hit.text; tip.style.left = (e.clientX - r.left + 12) + "px"; tip.style.top = (e.clientY - r.top - 8) + "px"; tip.style.opacity = "1"; }
    else tip.style.opacity = "0";
  });
  cv.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
  return wrap;
}

/* ---------- PPT export ---------- */
export async function exportProfilePptx(slides: ProfileSlide[]) {
  try {
    const { default: PptxGenJS } = await import("pptxgenjs");
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "EMP16x9", width: 13.333, height: 7.5 });
    pptx.layout = "EMP16x9";
    for (const slide of slides) {
      const cv = document.createElement("canvas"); cv.width = W * 2; cv.height = H * 2;
      const ctx = cv.getContext("2d")!; ctx.scale(2, 2);
      drawProfileSlide(ctx, slide);
      const png = cv.toDataURL("image/png");
      const s = pptx.addSlide();
      s.addImage({ data: png, x: 0, y: 0, w: 13.333, h: 7.5 });
    }
    const name = `${(store.currentProject?.name || "Project").replace(/[\\/:*?"<>|]+/g, " ").trim()}_Utility Profile.pptx`;
    await pptx.writeFile({ fileName: name });
    toast("✓ PPT exported");
  } catch (e: any) { toast("PPT export failed — " + e.message); }
}
