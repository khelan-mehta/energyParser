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
import { geocodeAddress, STATE_NAMES, EGRID_STATE_KG_PER_KWH } from "../engine/rates";
import {
  gatherElectricity, gatherGas, gatherCarbon, gatherWater, pickMax, chatgptWaterCharges,
  GatherOpts, RateCandidate, EIA_COMM_CENTS_PER_KWH, EIA_GAS_DOLLARS_PER_THERM, WATER_DOLLARS_PER_KGAL,
} from "../engine/sources";
import { Rates, RateHistory, RateSnapshot, RateSet, authUser } from "../api";

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
export function renderRates(root: HTMLElement) {
  root.appendChild(h(`<div class="page-head"><div><h1>Utility Rates</h1><p>Locate your project and Marcus sources the best electricity, gas, carbon &amp; water rates — with citations.</p></div><div class="actions"><button class="btn btn-sm" id="r-saveset">Save rate set</button></div></div>`));
  root.appendChild(infoBoxes(
    [
      "Type your <b>project address</b> and hit <b>Locate</b>.",
      "Marcus auto-sources every rate and fills the table below.",
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
  root.appendChild(historyCard(root));
  root.appendChild(sourcesFooter());

  root.querySelector("#r-saveset")!.addEventListener("click", () => saveCurrentAsNew(root));
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

function addressCard(root: HTMLElement): HTMLElement {
  const cfg = store.rates;
  const card = h(`
    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.pin("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Project Address</h3><div class="right"><button class="gear-btn" id="r-gear" title="Coordinates & API keys">${ICON.settings("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--g600);width:17px;height:17px;fill:none;stroke-width:1.8"')}</button></div></div>
      <div class="form-grid">
        <div class="field"><label>City</label><input id="ad-city" placeholder="e.g. Bentonville" value="${esc(cfg.city)}" /></div>
        <div class="field"><label>State</label><select id="ad-state"><option value="">— select —</option>${Object.keys(STATE_NAMES).map((s) => `<option value="${s}" ${cfg.state === s ? "selected" : ""}>${s} — ${STATE_NAMES[s]}</option>`).join("")}</select></div>
        <div class="field"><label>Country</label><input id="ad-country" value="${esc(cfg.country || "USA")}" /></div>
        <div class="field"><label>Pincode / ZIP</label><input id="ad-pin" placeholder="e.g. 72712" value="${esc(cfg.pincode)}" /></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-dark" id="ad-locate">${ICON.pin("x")} Locate &amp; source rates</button>
        <span id="ad-status" style="font-size:13px;color:var(--g600)">${cfg.location_name ? "📍 " + esc(cfg.location_name.slice(0, 80)) : "Enter an address to begin."}</span>
      </div>
    </div>`);
  const v = (s: string) => (card.querySelector(s) as HTMLInputElement).value;
  card.querySelector("#ad-city")!.addEventListener("input", () => cfg.city = v("#ad-city"));
  card.querySelector("#ad-state")!.addEventListener("change", () => { cfg.state = v("#ad-state"); autoCarbon(); rerender(root); });
  card.querySelector("#ad-country")!.addEventListener("input", () => cfg.country = v("#ad-country"));
  card.querySelector("#ad-pin")!.addEventListener("input", () => cfg.pincode = v("#ad-pin"));
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
  const card = h(`<div class="card"><div class="card-hd"><div class="list-ico" style="background:var(--red-soft)">${ICON.table("x").replace('class="nav-ico"', 'class="x" style="stroke:var(--red);width:16px;height:16px;fill:none;stroke-width:2"')}</div><h3>Final Rates &amp; Sources</h3><span class="sub">comparison vs other states · pick units · expand to choose or copy a source</span></div></div>`);
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
          <span class="src-toggle" id="ftsrctog-${e}"><span class="chev">▶</span> <span id="fttag-${e}">${tagPill(srcOf(e), refUrl(srcOf(e)))}</span> ${gathered[e].length ? gathered[e].length + " sources" : "source"}</span>
          <button class="btn btn-sm ftcopy" title="Copy selected source">${ICON.copy("x")}</button>
        </div>
        <div class="src-list" id="ftsrc-${e}"></div>
      </td>
    </tr>`);
  tr.querySelector(`#ftunit-${e}`)!.addEventListener("change", (ev) => { unitState[e] = parseInt((ev.target as HTMLSelectElement).value, 10); updateRow(root, e); });
  const tog = tr.querySelector(`#ftsrctog-${e}`)!; const list = tr.querySelector(`#ftsrc-${e}`)! as HTMLElement;
  tog.addEventListener("click", () => { tog.classList.toggle("open"); list.classList.toggle("open"); });
  tr.querySelector(".ftfind")!.addEventListener("click", () => runFind(root, e));
  tr.querySelector(".ftcopy")!.addEventListener("click", () => copySources(e));
  tr.querySelector(".ftgraph")!.addEventListener("click", () => openCompareModal(e));
  tr.querySelector(".ftedit")!.addEventListener("click", () => manualEdit(root, tr, e));
  // initial source list
  buildSrcList(root, e, list);
  return tr;
}
function manualEdit(root: HTMLElement, tr: HTMLElement, e: Entity) {
  const cell = tr.querySelector(`#ftval-${e}`)!.parentElement as HTMLElement;
  const [unitLabel, factor] = UNITS[e].opts[unitState[e]];
  const cur = baseVal(e);
  cell.innerHTML = `<input type="number" step="any" class="ftedit-in" value="${cur == null ? "" : +(cur * factor).toFixed(6)}" style="width:110px;padding:6px 8px;border:1px solid var(--red);border-radius:8px" /> <span style="font-size:11px;color:var(--g400)">${esc(unitLabel)}</span>`;
  const inp = cell.querySelector(".ftedit-in") as HTMLInputElement; inp.focus(); inp.select();
  const commit = () => { const v = parseFloat(inp.value); if (!isNaN(v)) { setBase(e, v / factor); markManual(e); toast(`✓ ${META[e].name} set manually`); } emit(); rerender(root); };
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") inp.blur(); if ((ev as KeyboardEvent).key === "Escape") rerender(root); });
}
function buildSrcList(root: HTMLElement, e: Entity, list: HTMLElement) {
  list.innerHTML = "";
  const chosen = srcOf(e);
  if (chosen) list.appendChild(h(`<div style="color:var(--black);font-weight:600;display:flex;align-items:center;gap:6px;margin-bottom:4px">✓ ${tagPill(chosen, refUrl(chosen))} <span>${esc(chosen)}</span></div>`));
  if (!gathered[e].length && !chosen) { list.appendChild(h(`<div style="color:var(--g400)">No source yet — hit Find.</div>`)); return; }
  gathered[e].forEach((c) => {
    const isCur = baseVal(e) === c.value;
    const item = h(`<div class="src-item" style="display:flex;align-items:center;gap:8px;padding:4px 0 4px 14px"><span style="min-width:80px;font-variant-numeric:tabular-nums;color:${isCur ? "var(--red)" : "var(--g700)"}">${c.value} ${esc(c.unit)}</span> ${tagPill(c.source, c.url)} <span style="flex:1;min-width:0;font-size:11px;color:var(--g500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.label)} · <a href="${esc(c.url)}" target="_blank" rel="noopener">ref ↗</a></span> <button class="btn btn-sm use-one">Use</button></div>`);
    item.querySelector(".use-one")!.addEventListener("click", () => { applyCandidate(c); toast(`✓ Applied ${c.value} ${c.unit}`); updateRow(root, e); });
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

/* ---------- comparison graph (expandable modal) ---------- */
function openCompareModal(e: Entity) {
  const [unitLabel, factor] = UNITS[e].opts[unitState[e]];
  const table = compTable(e);
  const cur = store.rates.state;
  // include current state + a broad comparison set; sort ascending; add US avg
  const SET = ["CA", "TX", "NY", "FL", "IL", "WA", "CO", "OH", "GA", "MA", "PA", "AZ", "NV"];
  const states = new Set(SET); if (cur && table[cur] != null) states.add(cur);
  const rows = [...states].filter((s) => table[s] != null).map((s) => ({ s, v: table[s] * factor })).sort((a, b) => a.v - b.v);
  const all = Object.values(table); const avg = (all.reduce((a, b) => a + b, 0) / all.length) * factor;
  const labels = [...rows.map((r) => r.s), "US avg"];
  const values = [...rows.map((r) => +r.v.toFixed(3)), +avg.toFixed(3)];
  const colors = labels.map((l) => l === cur ? PALETTE[0] : l === "US avg" ? "#a1a1aa" : "#1a1a1d");

  const overlay = h(`<div class="modal-overlay"><div class="modal" style="width:min(640px,94vw)"><div class="modal-hd"><h3>${esc(META[e].name)} — vs other states</h3><span class="x">${ICON.close("x")}</span></div><div class="modal-body"><div style="font-size:12.5px;color:var(--g500);margin-bottom:12px">Commercial ${esc(META[e].name.toLowerCase())} rate in <b>${esc(unitLabel)}</b>${cur ? ` · your state <b style="color:var(--red)">${esc(cur)}</b> highlighted` : ""}.</div><div style="height:340px"><canvas id="cmp-modal"></canvas></div></div></div></div>`);
  document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("show"));
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector(".x")!.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  requestAnimationFrame(() => {
    const c = overlay.querySelector("#cmp-modal") as HTMLCanvasElement;
    makeChart(c, {
      type: "bar",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 5, maxBarThickness: 30 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x: any) => `${x.label}: ${x.raw} ${unitLabel}` } } }, scales: { x: { grid: { display: false }, border: { display: false } }, y: { grid: { color: "#f0f0f1" }, border: { display: false } } } },
    });
  });
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
  const head = h(`<div class="subacc-head">${ICON.leed("x").replace('class="nav-ico"', 'class="x" style="width:16px;height:16px;stroke:var(--g600);fill:none;stroke-width:2"')} District energy (LEED, optional) <span class="chev">▶</span></div>`);
  const body = h(`<div class="subacc-body"><div class="form-grid">
    <div class="field"><label>District cooling carbon (kg/kBtu)</label><input id="d-dc-c" type="number" step="0.001" value="${cfg.dc_carbon_per_kbtu || ""}" placeholder="≈ 0.020" /></div>
    <div class="field"><label>District heating carbon (kg/kBtu)</label><input id="d-dh-c" type="number" step="0.001" value="${cfg.dh_carbon_per_kbtu || ""}" placeholder="≈ 0.060" /></div>
    <div class="field"><label>District cooling rate ($/kBtu)</label><input id="d-dc-r" type="number" step="0.0001" value="${cfg.dc_rate_per_kbtu || ""}" /></div>
    <div class="field"><label>District heating rate ($/kBtu)</label><input id="d-dh-r" type="number" step="0.0001" value="${cfg.dh_rate_per_kbtu || ""}" /></div>
  </div></div>`);
  head.addEventListener("click", () => acc.classList.toggle("open"));
  const bind = (id: string, set: (n: number) => void) => body.querySelector(id)!.addEventListener("input", (e) => set(num(e.target as HTMLInputElement) || 0));
  bind("#d-dc-c", (n) => cfg.dc_carbon_per_kbtu = n); bind("#d-dh-c", (n) => cfg.dh_carbon_per_kbtu = n);
  bind("#d-dc-r", (n) => cfg.dc_rate_per_kbtu = n); bind("#d-dh-r", (n) => cfg.dh_rate_per_kbtu = n);
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
  // trend chart (chronological)
  const asc = [...items].sort((a, b) => a.ts - b.ts);
  body.appendChild(h(`<div style="height:280px;margin:4px 0 8px"><canvas id="rh-chart"></canvas></div>`));
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
  body.appendChild(h(`<div class="source-note" style="border-left-color:var(--g300)">Tip: click a series in the legend to isolate it — rates sit on very different scales.</div>`));

  const labels = asc.map((s) => new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  requestAnimationFrame(() => {
    const c = root.querySelector("#rh-chart") as HTMLCanvasElement; if (!c) return;
    makeChart(c, {
      type: "line",
      data: {
        labels,
        datasets: HIST.map((x) => ({
          label: `${x.label} (${x.unit})`, color: x.color,
          data: asc.map((s) => s[x.key] as number | null),
          borderColor: x.color, backgroundColor: x.color, tension: 0.25, spanGaps: true, pointRadius: 3, borderWidth: 2,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } },
        scales: { x: { grid: { display: false }, border: { display: false } }, y: { grid: { color: "#f0f0f1" }, border: { display: false } } },
      },
    });
  });
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
  const list = document.getElementById(`ftsrc-${e}`) as HTMLElement; list.classList.add("open"); list.innerHTML = `<div style="color:var(--g400)">Searching…</div>`;
  try { const res = await RUNNERS[e](gatherOpts()); gathered[e] = res.candidates; const max = pickMax(res.candidates); if (max) applyCandidate(max); updateRow(root, e); if (max) toast(`✓ ${META[e].name}: ${max.value} ${max.unit}`); }
  catch (err: any) { list.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`; }
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
function autoCarbon() { const c = store.rates; if (!c.state) return; const f = EGRID_STATE_KG_PER_KWH[c.state]; if (f != null && c.elec_carbon_per_kwh == null) { c.elec_carbon_per_kwh = f; c.carbon_source = `EPA eGRID2022 — ${STATE_NAMES[c.state]} (ref: https://www.epa.gov/egrid)`; } }

function updateRow(root: HTMLElement, e: Entity) {
  const fv = root.querySelector(`#ftval-${e}`); if (fv) fv.textContent = baseVal(e) == null ? "—" : dispVal(e);
  const tag = root.querySelector(`#fttag-${e}`); if (tag) tag.innerHTML = tagPill(srcOf(e), refUrl(srcOf(e)));
  const tog = root.querySelector(`#ftsrctog-${e}`); if (tog) { const lbl = gathered[e].length ? gathered[e].length + " sources" : "source"; const last = tog.childNodes[tog.childNodes.length - 1]; if (last) last.textContent = " " + lbl; }
  const list = root.querySelector(`#ftsrc-${e}`) as HTMLElement; if (list) buildSrcList(root, e, list);
  emit();
}
function num(el: HTMLInputElement): number | null { const v = el.value.trim(); if (!v) return null; const n = parseFloat(v); return isNaN(n) ? null : n; }
function rerender(root: HTMLElement) { root.innerHTML = ""; renderRates(root); }
