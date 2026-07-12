/* ============================================================
 *  Utility Rates — single final table with inline comparison charts,
 *  source tags, copy-to-clipboard, and in-table rate selection.
 *  Locate → auto-sources electricity / gas / carbon / water.
 * ============================================================ */
import { store, emit } from "../store";
import { h, esc, toast, fmt } from "../ui/util";
import { ICON } from "../ui/icons";
import { infoBoxes } from "../ui/infoboxes";
import { makeChart, PALETTE } from "../ui/charts";
import { geocodeAddress, STATE_NAMES, EGRID_STATE_KG_PER_KWH, computeDesOption1Rates, RateConfig, subregionFor, espmElecCarbonPerKwh, ESPM_GAS_KG_PER_THERM, ESPM_SOURCE } from "../engine/rates";
import {
  gatherElectricity, gatherGas, gatherCarbon, gatherWater, pickMax, chatgptWaterCharges,
  GatherOpts, RateCandidate, EIA_COMM_CENTS_PER_KWH, EIA_GAS_DOLLARS_PER_THERM, WATER_DOLLARS_PER_KGAL,
} from "../engine/sources";
import { Rates, RateHistory, RateSnapshot, RateSet, authUser } from "../api";
import { barFor, renderProfileBar, profileLegend, exportProfilePptxEditable, Entity as ProfEntity } from "../ui/utilityProfile";

type Entity = "electricity" | "gas" | "carbon" | "water";
const ENTITIES: Entity[] = ["electricity", "gas", "carbon", "water"];

const unitState: Record<Entity, number> = { electricity: 0, gas: 0, carbon: 0, water: 0 };
const gathered: Record<Entity, RateCandidate[]> = { electricity: [], gas: [], carbon: [], water: [] };

const UNITS: Record<Entity, { opts: [string, number][] }> = {
  electricity: { opts: [["$/kWh", 1], ["¢/kWh", 100], ["$/kBtu", 1 / 3.412]] },
  gas: { opts: [["$/therm", 1], ["$/kBtu", 0.01], ["$/Mcf", 10.37]] },
  carbon: { opts: [["kg CO₂e/kWh", 1], ["lb/MWh", 2204.62], ["kg/kBtu", 1 / 3.412]] },
  water: { opts: [["$/kGal", 1], ["$/gal", 0.001], ["$/m³", 0.264172], ["$/CCF", 0.748]] },
};
const META: Record<Entity, { name: string; desc: string; icon: (c?: string) => string; color: string }> = {
  electricity: { name: "Electricity", desc: "grid retail rate", icon: ICON.rates, color: "#E4002B" },
  gas: { name: "Natural Gas", desc: "commercial rate", icon: ICON.bolt, color: "#52525b" },
  carbon: { name: "Carbon", desc: "grid emission factor", icon: ICON.carbon, color: "#0c0c0d" },
  water: { name: "Water", desc: "water + sewer", icon: ICON.water, color: "#71717a" },
};

function baseVal(e: Entity): number | null { const c = store.rates; return e === "electricity" ? c.elec_per_kwh : e === "gas" ? c.gas_per_therm : e === "carbon" ? c.elec_carbon_per_kwh : c.water_per_kgal; }
function setBase(e: Entity, v: number | null) { const c = store.rates; if (e === "electricity") c.elec_per_kwh = v; else if (e === "gas") c.gas_per_therm = v; else if (e === "carbon") c.elec_carbon_per_kwh = v; else c.water_per_kgal = v; }
function dispVal(e: Entity): string { const v = baseVal(e); const [l, f] = UNITS[e].opts[unitState[e]]; return v == null ? `— ${l}` : `${(v * f).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${l}`; }
function srcOf(e: Entity): string { const c = store.rates; return e === "electricity" ? c.rate_source : e === "gas" ? c.gas_source : e === "carbon" ? c.carbon_source : c.water_source; }
function compTable(e: Entity): Record<string, number> { return e === "electricity" ? mapVals(EIA_COMM_CENTS_PER_KWH, 1 / 100) : e === "gas" ? EIA_GAS_DOLLARS_PER_THERM : e === "carbon" ? EGRID_STATE_KG_PER_KWH : WATER_DOLLARS_PER_KGAL; }
function mapVals(t: Record<string, number>, f: number) { const o: Record<string, number> = {}; for (const k in t) o[k] = t[k] * f; return o; }

/* source category tags */
function sourceTag(src: string, url = ""): { label: string; color: string; bg: string } {
  const s = (src || "").toLowerCase(), u = (url || "").toLowerCase();
  if (!src) return { label: "—", color: "var(--g400)", bg: "var(--g100)" };
  if (s.includes("manual")) return { label: "Manual", color: "#52525b", bg: "#e4e4e7" };
  if (s.includes("chatgpt") || s.includes("openai") || s.includes("ai estimate")) return { label: "ChatGPT", color: "#E4002B", bg: "rgba(228,0,43,.10)" };
  if (u.includes(".gov") || u.includes("openei.org") || /\beia\b|epa|egrid|cambium|nrel|urdb|openei|government/.test(s)) return { label: "Government", color: "#15803d", bg: "#dcfce7" };
  return { label: "Article/Blog", color: "#a16207", bg: "#fef9c3" };
}
function tagPill(src: string, url = ""): string { const t = sourceTag(src, url); return `<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;background:${t.bg};color:${t.color};text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">${t.label}</span>`; }
function refUrl(src: string): string { const m = (src || "").match(/ref:\s*(https?:\/\/[^)\s]+)/i); return m ? m[1] : ""; }

/* ============================================================ */
/** When embedded in the guided wizard, drop the page-head title (the wizard
    supplies the step chrome) but keep the identical rates UI underneath. */
let RATES_EMBED = false;
export function renderRates(root: HTMLElement, opts: { embedded?: boolean } = {}) {
  RATES_EMBED = !!opts.embedded;
  if (!RATES_EMBED) root.appendChild(h(`<div class="page-head"><div><h1>Utility Rates</h1><p>Locate your project and EMP sources the best electricity, gas, carbon &amp; water rates — with citations.</p></div><div class="actions"><button class="btn btn-sm" id="r-saveset">Save rate set</button></div></div>`));
  root.appendChild(infoBoxes(
    [
      "Type your <b>project address</b> and hit <b>Locate</b>.",
      "EMP auto-sources every rate and fills the table below.",
      "Expand <b>Source</b> to pick another value, <b>use another source</b>, copy the chosen citation, or hit ✎ to type your own.",
      "Choose your <b>units</b>; the rates flow into every project's Excel.",
    ],
    [
      "Live electricity, gas, water rates + a grid carbon factor.",
      "An inline chart comparing your state to others, per utility.",
      "Colour-coded, copy-pasteable sources (gov / blog / AI / manual).",
      "Save a rate set and reuse it on any project.",
    ],
  ));
  root.appendChild(addressCard(root));
  root.appendChild(finalTable(root));
  root.appendChild(waterCard(root));
  root.appendChild(districtCard());
  root.appendChild(savedSetsCard(root));
  root.appendChild(sourcesFooter());

  root.querySelector("#r-saveset")?.addEventListener("click", () => saveCurrentAsNew(root));
}

/* ---------- saved rate sets (reusable across projects) ---------- */
function owns(rs: RateSet): boolean { return !!authUser && (rs.ownerId === authUser.id || authUser.role === "admin"); }

async function saveCurrentAsNew(root: HTMLElement) {
  const c = store.rates;
  if (c.elec_per_kwh == null && c.gas_per_therm == null && c.elec_carbon_per_kwh == null && c.water_per_kgal == null) {
    toast("Nothing to save yet — source or enter a rate first"); return;
  }
  const name = prompt("Name this rate set:", c.location_name || [c.city, c.state].filter(Boolean).join(", ") || "My rates");
  if (!name) return;
  try { await Rates.save(name.trim(), store.rates); await recordSnapshot(root, true); toast(`✓ Saved "${name.trim()}"`); loadSavedSets(root); }
  catch (e: any) { toast("Save failed — " + e.message); }
}

function savedSetsCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" id="saved-sets-card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.rates("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Saved Rate Sets</h3><span class="sub">reusable rate sets — load onto any project or pick during parsing</span><div class="right"><button class="btn btn-sm btn-dark" id="ss-savenew">${ICON.plus()} Save current as set</button></div></div>
    <div id="ss-body"><div style="color:var(--g400);font-size:13px;padding:8px 0">Loading…</div></div>
  </div>`);
  card.querySelector("#ss-savenew")!.addEventListener("click", () => saveCurrentAsNew(root));
  requestAnimationFrame(() => loadSavedSets(root)); // defer until the card is mounted in root
  return card;
}

function setVal(rs: RateSet, key: string): number | null { const v = rs.config ? rs.config[key] : null; return (typeof v === "number" && isFinite(v)) ? v : null; }
function setCell(v: number | null, digits = 4): string { return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits }); }

async function loadSavedSets(root: HTMLElement) {
  const body = root.querySelector("#ss-body") as HTMLElement; if (!body) return;
  let sets: RateSet[] = [];
  try { const res = await Rates.list(); sets = (res.rateSets || []) as RateSet[]; }
  catch (e: any) { body.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`; return; }
  if (!sets.length) { body.innerHTML = `<div style="color:var(--g400);font-size:13px;padding:8px 0">No saved sets yet — set your rates above and hit “Save current as set”.</div>`; return; }
  sets.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

  body.innerHTML = "";
  const scroll = h(`<div style="overflow-x:auto"></div>`);
  const table = h(`<table class="final-table mepc-table"><thead><tr>
    <th style="text-align:left">Name</th>
    <th>Elec<br><span style="font-weight:400;color:var(--g400);font-size:10px">$/kWh</span></th>
    <th>Gas<br><span style="font-weight:400;color:var(--g400);font-size:10px">$/therm</span></th>
    <th>Carbon<br><span style="font-weight:400;color:var(--g400);font-size:10px">kg/kWh</span></th>
    <th>Water<br><span style="font-weight:400;color:var(--g400);font-size:10px">$/kGal</span></th>
    <th style="text-align:left">Updated</th><th></th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector("tbody")!;
  sets.forEach((rs) => {
    const mine = owns(rs);
    const when = new Date(rs.updatedAt || rs.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const loc = rs.config?.location_name || rs.config?.state || "";
    const ownerTag = rs.shared && !mine ? ` <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;background:#dcfce7;color:#15803d">shared · ${esc(rs.ownerName || "")}</span>` : (rs.shared ? ` <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;background:#dcfce7;color:#15803d">shared</span>` : "");
    const tr = h(`<tr>
      <td class="l" style="max-width:220px"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(rs.name)}">${esc(rs.name)}${ownerTag}</div>${loc ? `<div style="font-size:11px;color:var(--g400);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(loc))}</div>` : ""}</td>
      <td>${setCell(setVal(rs, "elec_per_kwh"))}</td>
      <td>${setCell(setVal(rs, "gas_per_therm"))}</td>
      <td>${setCell(setVal(rs, "elec_carbon_per_kwh"))}</td>
      <td>${setCell(setVal(rs, "water_per_kgal"), 3)}</td>
      <td class="l" style="white-space:nowrap;color:var(--g500)">${esc(when)}</td>
      <td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
        <button class="btn btn-sm ss-load" title="Apply to current rates">Load</button>
        ${mine ? `<button class="btn btn-sm ss-update" title="Overwrite with current rates">Update</button>
        <button class="btn btn-sm ss-rename" title="Rename">✎</button>
        <button class="btn btn-sm ss-share" title="${rs.shared ? "Make private" : "Share with team"}">${rs.shared ? "Unshare" : "Share"}</button>
        <button class="btn btn-sm ss-del" title="Delete">✕</button>` : ""}
      </div></td>
    </tr>`);
    tr.querySelector(".ss-load")!.addEventListener("click", () => {
      store.rates = { ...store.rates, ...rs.config }; emit(); toast(`✓ Loaded "${rs.name}"`); rerender(root);
    });
    tr.querySelector(".ss-update")?.addEventListener("click", async () => {
      if (!confirm(`Overwrite "${rs.name}" with the current rates?`)) return;
      try { await Rates.update(rs.id, { config: store.rates }); toast(`✓ Updated "${rs.name}"`); loadSavedSets(root); } catch (e: any) { toast("Update failed — " + e.message); }
    });
    tr.querySelector(".ss-rename")?.addEventListener("click", async () => {
      const name = prompt("Rename rate set:", rs.name); if (!name || name.trim() === rs.name) return;
      try { await Rates.update(rs.id, { name: name.trim() }); toast("✓ Renamed"); loadSavedSets(root); } catch (e: any) { toast("Rename failed — " + e.message); }
    });
    tr.querySelector(".ss-share")?.addEventListener("click", async () => {
      try { await Rates.update(rs.id, { shared: !rs.shared }); toast(rs.shared ? "Set to private" : "✓ Shared with team"); loadSavedSets(root); } catch (e: any) { toast("Failed — " + e.message); }
    });
    tr.querySelector(".ss-del")?.addEventListener("click", async () => {
      if (!confirm(`Delete rate set "${rs.name}"?`)) return;
      try { await Rates.remove(rs.id); toast("Deleted"); loadSavedSets(root); } catch (e: any) { toast("Delete failed — " + e.message); }
    });
    tb.appendChild(tr);
  });
  scroll.appendChild(table); body.appendChild(scroll);
}

// Address is captured in Basic Info now; here we only surface the pincode/location
// and a button to locate + source rates from it.
function addressCard(root: HTMLElement): HTMLElement {
  const cfg = store.rates;
  const loc = cfg.location_name || [cfg.city, cfg.state].filter(Boolean).join(", ");
  const card = h(`
    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.pin("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Project Location</h3><div class="right"><button class="gear-btn" id="r-gear" title="Coordinates & API keys">${ICON.settings("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--g600);width:17px;height:17px;fill:none;stroke-width:1.8"')}</button></div></div>
      <div style="font-size:13px;color:var(--g600)">Pincode / ZIP <b>${esc(cfg.pincode || "—")}</b>${loc ? ` · ${esc(loc)}` : ""} <span style="color:var(--g400)">— set in Basic Info</span></div>
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-dark" id="ad-locate">${ICON.pin("x")} Locate &amp; source rates</button>
        <span id="ad-status" style="font-size:13px;color:var(--g600)">${cfg.location_name ? "📍 " + esc(cfg.location_name.slice(0, 80)) : cfg.pincode ? "Ready — hit Locate to source rates." : "Set the pincode in Basic Info first."}</span>
      </div>
    </div>`);
  card.querySelector("#ad-locate")!.addEventListener("click", () => locate(root, card));
  card.querySelector("#r-gear")!.addEventListener("click", () => openSettings(root));
  return card;
}

async function locate(root: HTMLElement, card: HTMLElement) {
  const cfg = store.rates;
  const btn = card.querySelector("#ad-locate") as HTMLButtonElement;
  const status = card.querySelector("#ad-status")!;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Locating…`;
  try {
    const info = await geocodeAddress({ city: cfg.city, state: cfg.state, country: cfg.country, pincode: cfg.pincode });
    cfg.lat = info.lat; cfg.lon = info.lon; cfg.location_name = info.name; if (info.state) cfg.state = info.state;
    autoCarbon();
    btn.innerHTML = `<span class="spinner"></span> Sourcing rates…`;
    status.textContent = `📍 ${info.name.slice(0, 70)} — sourcing best rates…`;
    const n = await autoSourceAll();
    status.textContent = `📍 ${info.name.slice(0, 70)} (${info.lat.toFixed(3)}, ${info.lon.toFixed(3)}) · ${n} rates applied`;
    toast(`✓ Located · ${n} rates applied`);
    await recordSnapshot(root);
    emit(); rerender(root);
  } catch (e: any) { status.textContent = "❌ " + e.message; toast("Locate failed — " + e.message); btn.disabled = false; btn.innerHTML = `${ICON.pin("x")} Locate & source rates`; }
}

/* ---------- final table ---------- */
function finalTable(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card"><div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.table("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Final Rates &amp; Sources</h3></div></div>`);
  const scroll = h(`<div style="overflow-x:auto"></div>`);
  const table = h(`<table class="final-table"><thead><tr><th>Utility Rate</th><th>Rate</th><th>Unit</th><th>Vs. other states</th><th>Source</th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector("tbody")!;
  ENTITIES.forEach((e) => tb.appendChild(finalRow(root, e)));
  scroll.appendChild(table); card.appendChild(scroll);
  return card;
}
function finalRow(root: HTMLElement, e: Entity): HTMLElement {
  const m = META[e];
  const tr = h(`
    <tr>
      <td><div class="final-cat"><div class="fc-ico" style="background:${e === "electricity" ? "var(--red-soft)" : "var(--g100)"}">${m.icon().replace('class="nav-ico"', `class="x" style="width:19px;height:19px;fill:none;stroke-width:2;stroke:${m.color}"`)}</div><div><div class="fc-name">${esc(m.name)}</div><div class="fc-desc">${esc(m.desc)}</div></div></div></td>
      <td><span class="final-val" id="ftval-${e}">${baseVal(e) == null ? "—" : esc(dispVal(e))}</span> <button class="btn btn-sm ftedit" title="Enter manually" style="padding:3px 8px;margin-left:4px">✎</button></td>
      <td><select class="unit-pick" id="ftunit-${e}">${UNITS[e].opts.map(([l], i) => `<option value="${i}" ${unitState[e] === i ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></td>
      <td><button class="btn btn-sm ftgraph" title="Compare to other states">${ICON.chart("x")} <span style="margin-left:2px">View</span></button></td>
      <td style="min-width:240px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-dark ftfind" title="Find from all sources">${ICON.refresh()} Find</button>
          <span id="fttag-${e}">${tagPill(srcOf(e), refUrl(srcOf(e)))}</span>
          <button class="btn btn-sm ftsources" title="View available sources">${ICON.book("x")} Sources</button>
          <button class="btn btn-sm ftcopy" title="Copy selected source">${ICON.copy("x")}</button>
        </div>
      </td>
    </tr>`);
  tr.querySelector(`#ftunit-${e}`)!.addEventListener("change", (ev) => { unitState[e] = parseInt((ev.target as HTMLSelectElement).value, 10); updateRow(root, e); });
  tr.querySelector(".ftfind")!.addEventListener("click", () => runFind(root, e));
  tr.querySelector(".ftsources")!.addEventListener("click", () => openSourcesModal(root, e));
  tr.querySelector(".ftcopy")!.addEventListener("click", () => copySources(e));
  tr.querySelector(".ftgraph")!.addEventListener("click", () => openCompareModal(e));
  tr.querySelector(".ftedit")!.addEventListener("click", () => manualEdit(root, tr, e));
  return tr;
}
function manualEdit(root: HTMLElement, tr: HTMLElement, e: Entity) {
  const cell = tr.querySelector(`#ftval-${e}`)!.parentElement as HTMLElement;
  const [unitLabel, factor] = UNITS[e].opts[unitState[e]];
  const cur = baseVal(e);
  cell.innerHTML = `<input type="number" step="any" class="ftedit-in" value="${cur == null ? "" : +(cur * factor).toFixed(6)}" style="width:110px;padding:6px 8px;border:1px solid var(--red);border-radius:8px" /> <span style="font-size:11px;color:var(--g400)">${esc(unitLabel)}</span>`;
  const inp = cell.querySelector(".ftedit-in") as HTMLInputElement; inp.focus(); inp.select();
  // A manual value must carry a source — ask for it in a popup before accepting.
  const commit = () => { const v = parseFloat(inp.value); if (isNaN(v)) { rerender(root); return; } openManualSourceModal(root, e, v / factor); };
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") inp.blur(); if ((ev as KeyboardEvent).key === "Escape") rerender(root); });
}
function buildSrcList(root: HTMLElement, e: Entity, list: HTMLElement) {
  list.innerHTML = "";
  const chosen = srcOf(e);
  const curVal = baseVal(e);
  // Currently-selected source, highlighted, with the FULL citation (never clipped).
  if (chosen) list.appendChild(h(`<div style="background:var(--red-soft);border:1px solid var(--red);border-radius:8px;padding:8px 10px;margin-bottom:10px;color:var(--black);font-weight:600;display:flex;align-items:flex-start;gap:8px"><span>✓</span> ${tagPill(chosen, refUrl(chosen))} <span style="flex:1;min-width:0;word-break:break-word;line-height:1.5">${esc(chosen)}</span></div>`));
  if (!gathered[e].length && !chosen) { list.appendChild(h(`<div style="color:var(--g400)">No source yet — hit Find.</div>`)); return; }
  gathered[e].forEach((c) => {
    const isCur = curVal === c.value;
    // Full source label — wraps instead of truncating mid-text; the in-use one is highlighted.
    const item = h(`<div class="src-item" style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:4px;${isCur ? "background:var(--red-soft);border:1px solid var(--red)" : "border:1px solid var(--g150)"}">
      <span style="min-width:92px;font-variant-numeric:tabular-nums;font-weight:${isCur ? "700" : "400"};color:${isCur ? "var(--red)" : "var(--g700)"}">${c.value} ${esc(c.unit)}</span>
      ${tagPill(c.source, c.url)}
      <span style="flex:1;min-width:0;font-size:11.5px;color:var(--g600);word-break:break-word;line-height:1.5">${esc(c.label)}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">ref ↗</a>` : ""}</span>
      ${isCur ? `<span style="font-size:9px;font-weight:700;color:var(--red);white-space:nowrap;letter-spacing:.4px">✓ IN USE</span>` : `<button class="btn btn-sm use-one">Use</button>`}
    </div>`);
    item.querySelector(".use-one")?.addEventListener("click", () => { applyCandidate(c); toast(`✓ Applied ${c.value} ${c.unit}`); updateRow(root, e); buildSrcList(root, e, list); });
    list.appendChild(item);
  });
  // "Use another source" — let the user supply their own value + citation.
  list.appendChild(otherSourceRow(root, e));
  // Definitions + source-reliability reference, shown as the last layer of each source list.
  list.appendChild(srcReferenceLayer(e));
}

/* Inline "use another source" form appended to each source list. */
function otherSourceRow(root: HTMLElement, e: Entity): HTMLElement {
  const [unitLabel, factor] = UNITS[e].opts[unitState[e]];
  const wrap = h(`<div class="src-other" style="padding:6px 0 2px 14px"></div>`);
  const trigger = h(`<button class="btn btn-sm" title="Enter your own value and citation">${ICON.plus()} Use another source…</button>`);
  wrap.appendChild(trigger);
  trigger.addEventListener("click", () => {
    const form = h(`
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <input class="os-val" type="number" step="any" placeholder="value (${esc(unitLabel)})" style="width:140px;padding:6px 8px;border:1px solid var(--g200);border-radius:8px" />
          <input class="os-src" placeholder="source / citation" style="flex:1;min-width:160px;padding:6px 8px;border:1px solid var(--g200);border-radius:8px" />
        </div>
        <input class="os-url" placeholder="reference URL (optional)" style="padding:6px 8px;border:1px solid var(--g200);border-radius:8px" />
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-dark os-apply">Apply</button>
          <button class="btn btn-sm os-cancel">Cancel</button>
        </div>
      </div>`);
    wrap.replaceChildren(form);
    (form.querySelector(".os-val") as HTMLInputElement).focus();
    form.querySelector(".os-cancel")!.addEventListener("click", () => buildSrcList(root, e, wrap.parentElement as HTMLElement));
    form.querySelector(".os-apply")!.addEventListener("click", () => {
      const val = parseFloat((form.querySelector(".os-val") as HTMLInputElement).value);
      if (isNaN(val)) { toast("Enter a numeric value"); return; }
      const srcText = (form.querySelector(".os-src") as HTMLInputElement).value.trim() || "Custom source";
      const url = (form.querySelector(".os-url") as HTMLInputElement).value.trim();
      setBase(e, val / factor);
      setSource(e, url ? `${srcText} (ref: ${url})` : srcText);
      toast(`✓ ${META[e].name} set from custom source`);
      emit(); updateRow(root, e);
      buildSrcList(root, e, wrap.parentElement as HTMLElement); // refresh so the custom source is highlighted
    });
  });
  return wrap;
}

/* Last layer: what the rate means + how trustworthy each source category is. */
function srcReferenceLayer(e: Entity): HTMLElement {
  return h(`
    <div class="src-ref" style="margin-top:10px;padding:8px 0 2px 14px;border-top:1px dashed var(--g200);font-size:11px;line-height:1.7;color:var(--g500)">
      <div style="font-weight:700;color:var(--g700);text-transform:uppercase;letter-spacing:.5px;font-size:10px;margin-bottom:2px">Definition</div>
      <div>${esc(DEFINITIONS[e])}</div>
      <div style="font-weight:700;color:var(--g700);text-transform:uppercase;letter-spacing:.5px;font-size:10px;margin:6px 0 2px">Source reliability (most → least)</div>
      <div>🟢 Government live/API · 🟢 Government reference · 🟡 Article/Blog &amp; utility tariff · 🔴 ChatGPT (verify) · ⚪ Manual (your input)</div>
    </div>`);
}

const DEFINITIONS: Record<Entity, string> = {
  electricity: "Commercial grid retail price per kWh used for energy cost.",
  gas: "Commercial natural-gas price per therm used for energy cost.",
  carbon: "Grid CO₂e emission factor per kWh used for operational carbon.",
  water: "Combined water + sewer charge per 1,000 gallons (kGal).",
};
function copySources(e: Entity) {
  // Copy only the currently selected source — not the whole candidate list.
  const chosen = srcOf(e); const v = baseVal(e); const [ul, f] = UNITS[e].opts[unitState[e]];
  if (v == null && !chosen) { toast("No source selected yet"); return; }
  const text = `${META[e].name}: ${v == null ? "—" : (v * f).toFixed(4)} ${ul}${chosen ? " | " + chosen : ""}`;
  navigator.clipboard?.writeText(text).then(() => toast("✓ Selected source copied")).catch(() => { prompt("Copy:", text); });
}

/* ---------- Project Utility Profile (per-utility gradient bar, expandable modal) ---------- */
function openCompareModal(e: Entity) {
  const bar = barFor(e as ProfEntity);
  const overlay = h(`<div class="modal-overlay"><div class="modal" style="width:min(760px,95vw)"><div class="modal-hd"><h3>${esc(bar.name)} — Project Utility Profile</h3><span class="x">${ICON.close("x")}</span></div>
    <div class="modal-body">
      <div style="font-size:12.5px;color:var(--g500);margin-bottom:6px">Where this project's rate sits between the US-lowest and US-highest state values.</div>
      <div id="pb-host"></div>
      <div id="pb-legend"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-sm btn-dark" id="pb-ppt">⬇ Export PPT (editable)</button></div>
    </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  (overlay.querySelector("#pb-host") as HTMLElement).appendChild(renderProfileBar(bar));
  (overlay.querySelector("#pb-legend") as HTMLElement).appendChild(profileLegend());
  overlay.querySelector("#pb-ppt")!.addEventListener("click", () => exportProfilePptxEditable());
}

/* ---------- water detail card ---------- */
function waterCard(root: HTMLElement): HTMLElement {
  const cfg = store.rates;
  const acc = h(`<div class="subacc" style="margin-top:16px"></div>`);
  const head = h(`<div class="subacc-head">${ICON.water("x").replace('class="nav-ico"', 'class="x" style="width:16px;height:16px;stroke:var(--red);fill:none;stroke-width:2"')} Water charges detail (water · irrigation · sewer) <span class="chev">▶</span></div>`);
  const body = h(`<div class="subacc-body"></div>`);
  body.appendChild(h(`
    <div style="display:flex;gap:10px;margin:4px 0 8px;flex-wrap:wrap">
      <button class="btn btn-dark btn-sm" id="wc-ai">${ICON.refresh()} Auto-fill (AI) for ${esc(cfg.city || cfg.state || "location")}</button>
    </div>
    <div class="water-tri">
      ${svc("water", "Water Service", "🚰", cfg.water_meter_charge, cfg.water_consumption_per_kgal)}
      ${svc("irrig", "Irrigation Service", "💦", cfg.irrigation_meter_charge, cfg.irrigation_per_kgal)}
      ${svc("sewer", "Sewer Service", "🛁", cfg.sewer_meter_charge, cfg.sewer_per_kgal)}
    </div>
    <div class="source-note">Combined $/kGal used by the model = water consumption + sewer consumption.</div>`));
  head.addEventListener("click", () => acc.classList.toggle("open"));
  const bind = (id: string, set: (n: number | null) => void) => body.querySelector(id)!.addEventListener("input", (e) => { set(num(e.target as HTMLInputElement)); recomputeWater(); updateRow(root, "water"); });
  bind("#w-water-meter", (n) => cfg.water_meter_charge = n); bind("#w-water-cons", (n) => cfg.water_consumption_per_kgal = n);
  bind("#w-irrig-meter", (n) => cfg.irrigation_meter_charge = n); bind("#w-irrig-cons", (n) => cfg.irrigation_per_kgal = n);
  bind("#w-sewer-meter", (n) => cfg.sewer_meter_charge = n); bind("#w-sewer-cons", (n) => cfg.sewer_per_kgal = n);
  body.querySelector("#wc-ai")!.addEventListener("click", () => fillWaterAI(root, body));
  acc.appendChild(head); acc.appendChild(body);
  return acc;
}
function svc(key: string, title: string, icon: string, meter: number | null, cons: number | null): string {
  const mid = `w-${key}-meter`, cid = `w-${key}-cons`;
  return `<div class="water-svc"><div class="ws-ico">${icon}</div><h5>${esc(title)}</h5><div class="ws-field"><label>Monthly Facility Charge ($/meter)</label><input id="${mid}" type="number" step="0.01" placeholder="—" value="${meter ?? ""}" /></div><div class="ws-field"><label>Per 1,000 Gallons</label><input id="${cid}" type="number" step="0.01" placeholder="—" value="${cons ?? ""}" /></div></div>`;
}
function recomputeWater() { const c = store.rates; const combined = (c.water_consumption_per_kgal || 0) + (c.sewer_per_kgal || 0); if (combined > 0) { c.water_per_kgal = +combined.toFixed(3); if (!c.water_source || c.water_source.includes("Manually")) c.water_source = "Local utility rate sheet (water + sewer)"; } }
async function fillWaterAI(root: HTMLElement, body: HTMLElement) {
  const cfg = store.rates; const loc = cfg.location_name || [cfg.city, cfg.state, cfg.country].filter(Boolean).join(", ");
  if (!loc) { toast("Enter the project address first"); return; }
  const btn = body.querySelector("#wc-ai") as HTMLButtonElement; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Asking ChatGPT…`;
  try {
    const w = await chatgptWaterCharges(loc, store.openaiKey, store.openaiModel);
    cfg.water_meter_charge = w.water_meter; cfg.water_consumption_per_kgal = w.water_per_kgal;
    cfg.irrigation_meter_charge = w.irrigation_meter; cfg.irrigation_per_kgal = w.irrigation_per_kgal;
    cfg.sewer_meter_charge = w.sewer_meter; cfg.sewer_per_kgal = w.sewer_per_kgal;
    cfg.water_source = `${w.source} (ref: ${w.url})`; recomputeWater();
    toast("✓ Water charges filled"); emit(); rerender(root);
  } catch (e: any) { toast("AI fill failed — " + e.message); btn.disabled = false; btn.innerHTML = `${ICON.refresh()} Auto-fill (AI)`; }
}

/* ---------- district ---------- */
function districtCard(): HTMLElement {
  const cfg = store.rates;
  const acc = h(`<div class="subacc" style="margin-top:12px"></div>`);
  const head = h(`<div class="subacc-head">${ICON.leed("x").replace('class="nav-ico"', 'class="x" style="width:16px;height:16px;stroke:var(--g600);fill:none;stroke-width:2"')} District energy (LEED Option 1, optional) <span class="chev">▶</span></div>`);
  const proj = store.currentProject ? `<b>${esc(store.currentProject.name)}</b>` : "the selected project";
  const body = h(`<div class="subacc-body">
    <div class="source-note" style="margin-bottom:10px">Derive virtual DES rates from your electricity &amp; gas rates above (USGBC DES Guidance §2.4.2.1, Option 1). Pick the district service(s) ${proj} uses, then <b>Compute</b>. Rates flow into the cost &amp; carbon roll-up via District Cooling/Heating consumption (kBtu) from the model.</div>
    <div class="form-grid" style="margin-bottom:8px">
      <div class="field"><label>District cooling (chilled water)</label><select id="d-svc-c"><option value="0">— not used —</option><option value="1" ${cfg.des_cooling ? "selected" : ""}>Yes · chilled water (×71)</option></select></div>
      <div class="field"><label>District heating medium</label><select id="d-svc-h">
        <option value="">— not used —</option>
        <option value="hotwater" ${cfg.des_heating === "hotwater" ? "selected" : ""}>Hot water (fuel ×1.59 + elec ×3)</option>
        <option value="steam" ${cfg.des_heating === "steam" ? "selected" : ""}>Steam (fuel ×1.81 + elec ×3)</option>
      </select></div>
    </div>
    <div style="display:flex;gap:10px;margin:4px 0 10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-dark btn-sm" id="d-compute">${ICON.refresh()} Compute from utility rates</button>
      <span id="d-compute-note" style="font-size:12px;color:var(--g500)"></span>
    </div>
    <div id="d-steps" style="font-size:11.5px;color:var(--g600);font-family:'DM Mono',monospace;line-height:1.8;margin-bottom:8px"></div>
    <div class="form-grid">
      <div class="field"><label>District cooling rate ($/kBtu)</label><input id="d-dc-r" type="number" step="0.00001" value="${cfg.dc_rate_per_kbtu || ""}" /></div>
      <div class="field"><label>District heating rate ($/kBtu)</label><input id="d-dh-r" type="number" step="0.00001" value="${cfg.dh_rate_per_kbtu || ""}" /></div>
      <div class="field"><label>District cooling carbon (kg/kBtu)</label><input id="d-dc-c" type="number" step="0.0001" value="${cfg.dc_carbon_per_kbtu || ""}" placeholder="≈ 0.0527" /></div>
      <div class="field"><label>District heating carbon (kg/kBtu)</label><input id="d-dh-c" type="number" step="0.0001" value="${cfg.dh_carbon_per_kbtu || ""}" placeholder="≈ 0.0664" /></div>
    </div>
    <div class="source-note" style="margin-top:10px;border-left-color:var(--g300)">Carbon factors: ENERGY STAR Portfolio Manager district factors (chilled water 52.70, steam/hot water 66.40 kg/MBtu). Computed values are editable — override with actual DES plant data when available.</div>
  </div>`);
  head.addEventListener("click", () => acc.classList.toggle("open"));

  const setNum = (id: string, v: number) => { const el = body.querySelector(id) as HTMLInputElement; el.value = v ? String(+v.toFixed(6)) : ""; };
  const bind = (id: string, set: (n: number) => void) => body.querySelector(id)!.addEventListener("input", (e) => { set(num(e.target as HTMLInputElement) || 0); emit(); });
  bind("#d-dc-c", (n) => cfg.dc_carbon_per_kbtu = n); bind("#d-dh-c", (n) => cfg.dh_carbon_per_kbtu = n);
  bind("#d-dc-r", (n) => cfg.dc_rate_per_kbtu = n); bind("#d-dh-r", (n) => cfg.dh_rate_per_kbtu = n);
  body.querySelector("#d-svc-c")!.addEventListener("change", (e) => cfg.des_cooling = (e.target as HTMLSelectElement).value === "1");
  body.querySelector("#d-svc-h")!.addEventListener("change", (e) => cfg.des_heating = (e.target as HTMLSelectElement).value as RateConfig["des_heating"]);

  body.querySelector("#d-compute")!.addEventListener("click", () => {
    cfg.des_cooling = (body.querySelector("#d-svc-c") as HTMLSelectElement).value === "1";
    cfg.des_heating = (body.querySelector("#d-svc-h") as HTMLSelectElement).value as RateConfig["des_heating"];
    const res = computeDesOption1Rates({ elec_per_kwh: cfg.elec_per_kwh, gas_per_therm: cfg.gas_per_therm, cooling: cfg.des_cooling, heating: cfg.des_heating });
    cfg.dc_rate_per_kbtu = res.dc_rate_per_kbtu; cfg.dh_rate_per_kbtu = res.dh_rate_per_kbtu;
    cfg.dc_carbon_per_kbtu = res.dc_carbon_per_kbtu; cfg.dh_carbon_per_kbtu = res.dh_carbon_per_kbtu;
    setNum("#d-dc-r", res.dc_rate_per_kbtu); setNum("#d-dh-r", res.dh_rate_per_kbtu);
    setNum("#d-dc-c", res.dc_carbon_per_kbtu); setNum("#d-dh-c", res.dh_carbon_per_kbtu);
    const steps = body.querySelector("#d-steps")!;
    steps.innerHTML = [
      ...res.steps.map((s) => `<div>✓ ${esc(s)}</div>`),
      ...res.warnings.map((w) => `<div style="color:var(--red)">⚠ ${esc(w)}</div>`),
    ].join("") || "";
    const note = body.querySelector("#d-compute-note")!;
    note.textContent = res.warnings.length ? "Resolve the warnings, then recompute." : "✓ Virtual DES rates applied.";
    if (!res.warnings.length) toast("✓ DES Option-1 rates computed");
    emit();
  });

  acc.appendChild(head); acc.appendChild(body);
  return acc;
}

function sourcesFooter(): HTMLElement {
  return h(`<div class="card" style="margin-top:16px;background:var(--g50)"><div class="card-hd"><h3 style="font-size:13px">Sources</h3></div>
    <div style="font-size:11.5px;color:var(--g500);font-family:'DM Mono',monospace;line-height:1.9">
      <div>🟢 Government — EIA OpenData · EPA eGRID2022 · NREL Cambium · NREL/OpenEI URDB</div>
      <div>🟡 Article/Blog — Circle of Blue water survey · local utility tariffs</div>
      <div>🔴 ChatGPT — AI fallback estimates (flagged "verify")</div>
      <div>⚪ Manual — values you typed</div>
      <div style="margin-top:6px"><a href="https://www.eia.gov/opendata/" target="_blank" rel="noopener">eia.gov</a> · <a href="https://www.epa.gov/egrid" target="_blank" rel="noopener">epa.gov/egrid</a> · <a href="https://openei.org/wiki/Utility_Rate_Database" target="_blank" rel="noopener">openei.org</a> · <a href="https://www.circleofblue.org/waterpricing/" target="_blank" rel="noopener">circleofblue.org</a></div>
      <div class="subsection" style="margin-top:16px">Definitions <span class="line"></span></div>
      <div>⚡ Electricity — ${esc(DEFINITIONS.electricity)}</div>
      <div>🔥 Natural Gas — ${esc(DEFINITIONS.gas)}</div>
      <div>🌫 Carbon — ${esc(DEFINITIONS.carbon)}</div>
      <div>💧 Water — ${esc(DEFINITIONS.water)}</div>
      <div class="subsection" style="margin-top:16px">Source reliability (most → least trusted) <span class="line"></span></div>
      <div>1. 🟢 Government live/API — EIA OpenData, NREL URDB (authoritative, current).</div>
      <div>2. 🟢 Government reference — embedded EIA EPM, EPA eGRID2022, NREL Cambium (recent, not live).</div>
      <div>3. 🟡 Article/Blog &amp; utility tariff — Circle of Blue, local tariffs (verify locally).</div>
      <div>4. 🔴 ChatGPT — AI estimate, always flagged "verify".</div>
      <div>5. ⚪ Manual — your own input; reliability is your responsibility.</div>
    </div></div>`);
}

/* ---------- rate history (per-user audit trail) ---------- */
let lastSnapKey = "";
function snapshotPayload(): Partial<RateSnapshot> {
  const c = store.rates;
  return {
    location: c.location_name || [c.city, c.state].filter(Boolean).join(", "),
    state: c.state || "",
    elec: c.elec_per_kwh ?? null, elecSrc: c.rate_source || "",
    gas: c.gas_per_therm ?? null, gasSrc: c.gas_source || "",
    carbon: c.elec_carbon_per_kwh ?? null, carbonSrc: c.carbon_source || "",
    water: c.water_per_kgal ?? null, waterSrc: c.water_source || "",
  };
}
function snapKey(p: Partial<RateSnapshot>): string { return [p.elec, p.gas, p.carbon, p.water, p.location].join("|"); }
async function recordSnapshot(root: HTMLElement, force = false): Promise<boolean> {
  const p = snapshotPayload();
  if (p.elec == null && p.gas == null && p.carbon == null && p.water == null) { if (force) toast("No rates to snapshot yet"); return false; }
  const key = snapKey(p);
  if (!force && key === lastSnapKey) return false;   // skip identical consecutive auto-snapshots
  lastSnapKey = key;
  try { await RateHistory.add(p); loadHistory(root); return true; } catch { return false; }
}

const HIST: { e: Entity; label: string; unit: string; color: string; key: keyof RateSnapshot }[] = [
  { e: "electricity", label: "Electricity", unit: "$/kWh", color: "#E4002B", key: "elec" },
  { e: "gas", label: "Gas", unit: "$/therm", color: "#52525b", key: "gas" },
  { e: "carbon", label: "Carbon", unit: "kg/kWh", color: "#0c0c0d", key: "carbon" },
  { e: "water", label: "Water", unit: "$/kGal", color: "#71717a", key: "water" },
];
function histVal(v: number | null): string { return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 4 }); }

function historyCard(root: HTMLElement): HTMLElement {
  const card = h(`<div class="card" id="rate-history-card" style="margin-top:16px">
    <div class="card-hd"><div class="list-ico" style="background:var(--g100)">${ICON.chart("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--g700);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Rate History</h3><span class="sub">timestamped snapshots of the rates you've sourced</span><div class="right" style="display:flex;gap:8px"><button class="btn btn-sm" id="rh-snap">Snapshot current rates</button><button class="btn btn-sm" id="rh-clear">Clear</button></div></div>
    <div id="rh-body"><div style="color:var(--g400);font-size:13px;padding:8px 0">Loading…</div></div>
  </div>`);
  card.querySelector("#rh-snap")!.addEventListener("click", async () => { const ok = await recordSnapshot(root, true); if (ok) toast("✓ Snapshot saved"); });
  card.querySelector("#rh-clear")!.addEventListener("click", async () => {
    if (!confirm("Clear all rate history?")) return;
    try { await RateHistory.clear(); lastSnapKey = ""; loadHistory(root); toast("History cleared"); } catch (e: any) { toast("Clear failed — " + e.message); }
  });
  requestAnimationFrame(() => loadHistory(root)); // defer until the card is mounted in root
  return card;
}

async function loadHistory(root: HTMLElement) {
  const body = root.querySelector("#rh-body") as HTMLElement; if (!body) return;
  let items: RateSnapshot[] = [];
  try { const res = await RateHistory.list(); items = (res.history || []) as RateSnapshot[]; }
  catch (e: any) { body.innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`; return; }
  if (!items.length) { body.innerHTML = `<div style="color:var(--g400);font-size:13px;padding:8px 0">No history yet — Locate &amp; source rates, or hit “Snapshot current rates”.</div>`; return; }

  body.innerHTML = "";
  // table (newest first)
  const scroll = h(`<div style="overflow-x:auto"></div>`);
  const table = h(`<table class="final-table mepc-table"><thead><tr><th style="text-align:left">When</th><th style="text-align:left">Location</th>${HIST.map((x) => `<th>${esc(x.label)}<br><span style="font-weight:400;color:var(--g400);font-size:10px">${esc(x.unit)}</span></th>`).join("")}<th></th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector("tbody")!;
  items.forEach((s) => {
    const when = new Date(s.ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const tr = h(`<tr>
      <td class="l" style="white-space:nowrap">${esc(when)}</td>
      <td class="l" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.location)}">${esc(s.location || "—")}</td>
      <td title="${esc(s.elecSrc)}">${histVal(s.elec)}</td>
      <td title="${esc(s.gasSrc)}">${histVal(s.gas)}</td>
      <td title="${esc(s.carbonSrc)}">${histVal(s.carbon)}</td>
      <td title="${esc(s.waterSrc)}">${histVal(s.water)}</td>
      <td><button class="btn btn-sm rh-del" title="Delete snapshot">✕</button></td>
    </tr>`);
    tr.querySelector(".rh-del")!.addEventListener("click", async () => { try { await RateHistory.remove(s.id); loadHistory(root); } catch (e: any) { toast("Delete failed — " + e.message); } });
    tb.appendChild(tr);
  });
  scroll.appendChild(table); body.appendChild(scroll);
}

/* ---------- settings modal ---------- */
function openSettings(root: HTMLElement) {
  const cfg = store.rates;
  const overlay = h(`<div class="modal-overlay"><div class="modal"><div class="modal-hd"><h3>Coordinates &amp; API Keys</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body">
    <div class="subsection" style="margin-top:0">Manual coordinates <span class="line"></span></div>
    <div class="form-grid"><div class="field"><label>Latitude</label><input id="set-lat" type="number" step="0.001" value="${cfg.lat ?? ""}" /></div><div class="field"><label>Longitude</label><input id="set-lon" type="number" step="0.001" value="${cfg.lon ?? ""}" /></div></div>
    <div class="subsection">API keys <span class="line"></span></div>
    <div class="field" style="margin-bottom:12px"><label>NREL / OpenEI</label><input id="set-nrel" value="${esc(store.nrelKey)}" /></div>
    <div class="field" style="margin-bottom:12px"><label>EIA OpenData</label><input id="set-eia" value="${esc(store.eiaKey)}" /></div>
    <div class="field" style="margin-bottom:12px"><label>OpenAI</label><input id="set-oai" type="password" value="${esc(store.openaiKey)}" /></div>
    <div class="field"><label>ChatGPT model</label><select id="set-model">${["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"].map((m) => `<option ${store.openaiModel === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    <button class="btn btn-primary" id="set-save" style="width:100%;justify-content:center;margin-top:18px">Save</button>
  </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#set-save")!.addEventListener("click", () => {
    cfg.lat = num(overlay.querySelector("#set-lat") as HTMLInputElement); cfg.lon = num(overlay.querySelector("#set-lon") as HTMLInputElement);
    store.nrelKey = (overlay.querySelector("#set-nrel") as HTMLInputElement).value.trim(); localStorage.setItem("ep_nrel_key", store.nrelKey);
    store.eiaKey = (overlay.querySelector("#set-eia") as HTMLInputElement).value.trim(); localStorage.setItem("ep_eia_key", store.eiaKey);
    store.openaiKey = (overlay.querySelector("#set-oai") as HTMLInputElement).value.trim(); localStorage.setItem("ep_openai_key", store.openaiKey);
    store.openaiModel = (overlay.querySelector("#set-model") as HTMLSelectElement).value; localStorage.setItem("ep_openai_model", store.openaiModel);
    toast("✓ Saved"); close();
  });
}

/* ---------- find / apply ---------- */
function gatherOpts(): GatherOpts {
  const c = store.rates;
  return { state: c.state, lat: c.lat, lon: c.lon, nrelKey: store.nrelKey, eiaKey: store.eiaKey, openaiKey: store.openaiKey, openaiModel: store.openaiModel, locationText: c.location_name || [c.city, c.state, c.country].filter(Boolean).join(", ") || STATE_NAMES[c.state] || c.state, touProfile: c.tou_profile };
}
const RUNNERS: Record<Entity, (o: GatherOpts) => Promise<{ candidates: RateCandidate[]; errors: string[] }>> = { electricity: gatherElectricity, gas: gatherGas, carbon: gatherCarbon, water: gatherWater };
async function runFind(root: HTMLElement, e: Entity) {
  if (!store.rates.state && store.rates.lat == null) { toast("Locate the project first"); return; }
  // The source list now lives in a popup; refresh it there if it's open.
  const list = document.getElementById(`ftsrc-modal-${e}`) as HTMLElement | null;
  if (list) { list.classList.add("open"); list.innerHTML = `<div style="color:var(--g400)">Searching…</div>`; }
  try {
    const res = await RUNNERS[e](gatherOpts()); gathered[e] = res.candidates;
    const max = pickMax(res.candidates); if (max) applyCandidate(max);
    updateRow(root, e);
    if (list) buildSrcList(root, e, list);
    if (max) toast(`✓ ${META[e].name}: ${max.value} ${max.unit}`);
  } catch (err: any) { if (list) list.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`; else toast("Find failed — " + err.message); }
}

/* Available-sources popup — clearly lists every sourced value + "use your own". */
function openSourcesModal(root: HTMLElement, e: Entity) {
  const overlay = h(`<div class="modal-overlay"><div class="modal" style="width:min(660px,94vw)"><div class="modal-hd"><h3>${esc(META[e].name)} — available sources</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body">
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap"><button class="btn btn-sm btn-dark" id="sm-find">${ICON.refresh()} Find from all sources</button><span style="font-size:12px;color:var(--g500)">pick a value to use, or add your own below</span></div>
    <div class="src-list open" id="ftsrc-modal-${e}"></div>
  </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  const list = overlay.querySelector(`#ftsrc-modal-${e}`) as HTMLElement;
  buildSrcList(root, e, list);
  overlay.querySelector("#sm-find")!.addEventListener("click", () => runFind(root, e));
}

/* Manual entry always asks for a source + link before the value is accepted. */
function openManualSourceModal(root: HTMLElement, e: Entity, baseValue: number) {
  const [ul, f] = UNITS[e].opts[unitState[e]];
  const disp = `${(baseValue * f).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${ul}`;
  const overlay = h(`<div class="modal-overlay"><div class="modal" style="width:min(460px,94vw)"><div class="modal-hd"><h3>Source for ${esc(META[e].name)}</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body">
    <div style="font-size:12.5px;color:var(--g500);margin-bottom:12px">You entered <b>${esc(disp)}</b>. Add where this value came from.</div>
    <div class="field" style="margin-bottom:10px"><label>Source name</label><input id="ms-src" placeholder="e.g. Local utility tariff 2026" /></div>
    <div class="field" style="margin-bottom:16px"><label>Link to source</label><input id="ms-url" placeholder="https://…" /></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="ms-cancel">Cancel</button><button class="btn btn-primary" id="ms-apply">Apply</button></div>
  </div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  let done = false;
  const finish = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  const cancel = () => { if (done) return; finish(); rerender(root); };  // discard the typed value
  overlay.querySelector(".x")!.addEventListener("click", cancel);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) cancel(); });
  overlay.querySelector("#ms-cancel")!.addEventListener("click", cancel);
  overlay.querySelector("#ms-apply")!.addEventListener("click", () => {
    const src = (overlay.querySelector("#ms-src") as HTMLInputElement).value.trim() || "Manually entered";
    const url = (overlay.querySelector("#ms-url") as HTMLInputElement).value.trim();
    setBase(e, baseValue);
    setSource(e, url ? `${src} (ref: ${url})` : src);
    done = true; emit(); finish(); toast(`✓ ${META[e].name} set from your source`); rerender(root);
  });
  (overlay.querySelector("#ms-src") as HTMLInputElement).focus();
}
async function autoSourceAll(): Promise<number> {
  const o = gatherOpts();
  const [e, g, c, w] = await Promise.all([
    gatherElectricity(o).catch(() => ({ candidates: [], errors: [] })), gatherGas(o).catch(() => ({ candidates: [], errors: [] })),
    gatherCarbon(o).catch(() => ({ candidates: [], errors: [] })), gatherWater(o).catch(() => ({ candidates: [], errors: [] })),
  ]);
  gathered.electricity = e.candidates; gathered.gas = g.candidates; gathered.carbon = c.candidates; gathered.water = w.candidates;
  let n = 0; for (const arr of [e.candidates, g.candidates, c.candidates, w.candidates]) { const m = pickMax(arr); if (m) { applyCandidate(m); n++; } }
  return n;
}
function applyCandidate(c: RateCandidate) {
  const cfg = store.rates; const cite = `${c.source} (ref: ${c.url})`;
  if (c.kind === "elec") { cfg.elec_per_kwh = c.value; cfg.rate_source = cite; cfg.rate_structure = c.live ? "aggregated (live)" : "aggregated (ref)"; }
  else if (c.kind === "gas") { cfg.gas_per_therm = c.value; cfg.gas_source = cite; }
  else if (c.kind === "carbon") { cfg.carbon_method = "manual"; cfg.elec_carbon_per_kwh = c.value; cfg.carbon_source = cite; }
  else if (c.kind === "water") { cfg.water_per_kgal = c.value; cfg.water_source = cite; }
  emit();
}
function markManual(e: Entity) {
  const c = store.rates;
  if (e === "electricity") { c.rate_source = "Manually entered"; c.rate_structure = "manual"; }
  else if (e === "gas") c.gas_source = "Manually entered";
  else if (e === "carbon") { c.carbon_method = "manual"; c.carbon_source = "Manually entered"; }
  else c.water_source = "Manually entered";
}
function setSource(e: Entity, src: string) {
  const c = store.rates;
  if (e === "electricity") { c.rate_source = src; c.rate_structure = "custom"; }
  else if (e === "gas") c.gas_source = src;
  else if (e === "carbon") { c.carbon_method = "manual"; c.carbon_source = src; }
  else c.water_source = src;
}
/* Auto-populate the grid carbon factor. Prefer the ENERGY STAR Portfolio
 * Manager eGRID-subregion factor resolved from the project ZIP (the method in
 * the GHG Technical Reference / Emissions.pdf); fall back to the state-level
 * eGRID factor when no ZIP/subregion is available. Never overwrite a value the
 * user already set. */
function autoCarbon() {
  const c = store.rates;
  if (c.elec_carbon_per_kwh != null) return;
  const sub = subregionFor(c.state || "", c.pincode);
  if (sub) {
    c.elec_carbon_per_kwh = +espmElecCarbonPerKwh(sub).toFixed(4);
    c.gas_carbon_per_therm = ESPM_GAS_KG_PER_THERM;
    c.carbon_method = "manual";
    c.carbon_source = `${ESPM_SOURCE} · eGRID ${sub} (ZIP ${c.pincode || "—"})`;
    return;
  }
  if (!c.state) return;
  const f = EGRID_STATE_KG_PER_KWH[c.state];
  if (f != null) { c.elec_carbon_per_kwh = f; c.carbon_source = `EPA eGRID2022 — ${STATE_NAMES[c.state]} (ref: https://www.epa.gov/egrid)`; }
}

function updateRow(root: HTMLElement, e: Entity) {
  const fv = root.querySelector(`#ftval-${e}`); if (fv) fv.textContent = baseVal(e) == null ? "—" : dispVal(e);
  const tag = root.querySelector(`#fttag-${e}`); if (tag) tag.innerHTML = tagPill(srcOf(e), refUrl(srcOf(e)));
  const tog = root.querySelector(`#ftsrctog-${e}`); if (tog) { const lbl = gathered[e].length ? gathered[e].length + " sources" : "source"; const last = tog.childNodes[tog.childNodes.length - 1]; if (last) last.textContent = " " + lbl; }
  const list = root.querySelector(`#ftsrc-${e}`) as HTMLElement; if (list) buildSrcList(root, e, list);
  emit();
}
function num(el: HTMLInputElement): number | null { const v = el.value.trim(); if (!v) return null; const n = parseFloat(v); return isNaN(n) ? null : n; }
function rerender(root: HTMLElement) { root.innerHTML = ""; renderRates(root, { embedded: RATES_EMBED }); }
