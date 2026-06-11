/* ============================================================
 *  MULTI-SOURCE RATE / CARBON / WATER AGGREGATION
 *  Pulls from every reachable source, normalizes units, attaches a
 *  citation + reference URL to each candidate, and can pick the max.
 *  Live APIs:  NREL URDB · EIA OpenData · NREL Cambium
 *  Embedded:   EIA EPM · EPA eGRID2022 · Circle of Blue (water)
 *  Fallback:   OpenAI (ChatGPT) with user key — returns value + source.
 * ============================================================ */
import { EGRID_STATE_KG_PER_KWH, STATE_NAMES, cambiumTouFactor } from "./rates";

export interface RateCandidate {
  kind: "elec" | "gas" | "carbon" | "water";
  value: number;     // normalized: elec $/kWh · gas $/therm · carbon kgCO2e/kWh · water $/kGal
  unit: string;
  label: string;     // human description (utility / dataset)
  source: string;    // citation text
  url: string;       // reference URL
  live: boolean;     // live API vs embedded reference vs AI
  year?: string;
}

/* Canonical reference URLs (shown next to each value). */
export const REF = {
  eiaEPM: "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_b",
  eiaAPI: "https://www.eia.gov/opendata/",
  eiaGas: "https://www.eia.gov/dnav/ng/ng_pri_sum_dcu_nus_m.htm",
  egrid: "https://www.epa.gov/egrid",
  cambium: "https://www.nrel.gov/analysis/cambium.html",
  urdb: "https://openei.org/wiki/Utility_Rate_Database",
  water: "https://www.circleofblue.org/waterpricing/",
  epaGhg: "https://www.epa.gov/climateleadership/ghg-emission-factors-hub",
  openai: "https://platform.openai.com/docs/api-reference/chat",
};

const MCF_TO_THERM = 10.37; // 1 Mcf natural gas ≈ 10.37 therms

/* ============================================================
 *  EMBEDDED — EIA Electric Power Monthly, commercial avg ¢/kWh (2023)
 *  Source: EIA EPM Table 5.6.B. Reference figures; prefer the live API.
 * ============================================================ */
export const EIA_COMM_CENTS_PER_KWH: Record<string, number> = {
  AL: 12.6, AK: 21.0, AZ: 11.4, AR: 9.6, CA: 24.0, CO: 11.4, CT: 21.5, DE: 11.6,
  DC: 13.5, FL: 11.2, GA: 11.5, HI: 39.5, ID: 8.6, IL: 11.2, IN: 11.6, IA: 10.0,
  KS: 11.1, KY: 11.0, LA: 10.4, ME: 16.5, MD: 12.4, MA: 22.0, MI: 12.6, MN: 11.6,
  MS: 11.6, MO: 9.8, MT: 11.0, NE: 9.7, NV: 9.9, NH: 18.5, NJ: 13.8, NM: 11.2,
  NY: 19.5, NC: 9.8, ND: 9.9, OH: 11.0, OK: 9.6, OR: 10.7, PA: 10.8, RI: 21.0,
  SC: 11.6, SD: 10.9, TN: 11.6, TX: 9.4, UT: 9.3, VT: 17.5, VA: 9.7, WA: 9.9,
  WV: 10.3, WI: 12.2, WY: 10.6,
};

/* EIA natural-gas commercial price, $/therm (2023, national-ish refs). */
export const EIA_GAS_DOLLARS_PER_THERM: Record<string, number> = {
  AL: 1.30, AK: 0.95, AZ: 1.25, AR: 1.05, CA: 1.45, CO: 0.95, CT: 1.40, DE: 1.15,
  DC: 1.20, FL: 1.55, GA: 1.30, HI: 4.50, ID: 0.90, IL: 0.95, IN: 0.95, IA: 0.95,
  KS: 1.05, KY: 1.10, LA: 1.05, ME: 1.45, MD: 1.20, MA: 1.55, MI: 1.00, MN: 0.95,
  MS: 1.15, MO: 1.15, MT: 0.95, NE: 1.00, NV: 1.10, NH: 1.55, NJ: 1.10, NM: 0.95,
  NY: 1.40, NC: 1.25, ND: 0.90, OH: 1.00, OK: 0.95, OR: 1.10, PA: 1.20, RI: 1.55,
  SC: 1.30, SD: 1.00, TN: 1.15, TX: 1.00, UT: 0.90, VT: 1.45, VA: 1.20, WA: 1.20,
  WV: 1.10, WI: 1.00, WY: 0.95,
};

/* Embedded water+sewer combined, $/kGal — Circle of Blue 30-city survey + utility
   tariffs, generalized by region. Reference; verify with local tariff. */
export const WATER_DOLLARS_PER_KGAL: Record<string, number> = {
  CA: 14.5, AZ: 12.0, NV: 11.0, TX: 11.5, FL: 11.0, GA: 13.0, NC: 10.5, WA: 16.0,
  OR: 14.0, CO: 12.5, IL: 13.5, NY: 12.0, MA: 13.0, PA: 11.5, OH: 11.0, MI: 12.5,
  MD: 12.0, DC: 13.5, MN: 10.0, WI: 9.5,
};
const WATER_NATIONAL = 12.0;

/* ============================================================
 *  Fetch helper with CORS-proxy fallback.
 * ============================================================ */
async function fetchJson(url: string): Promise<any> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    // fall back through a public CORS proxy
    const proxied = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const pr = await fetch(proxied);
    if (!pr.ok) throw new Error(`proxy HTTP ${pr.status}`);
    const wrap = await pr.json();
    return JSON.parse(wrap.contents);
  }
}

/* ============================================================
 *  LIVE — EIA OpenData v2
 * ============================================================ */
export async function eiaElectricity(state: string, key: string): Promise<RateCandidate> {
  const url = `https://api.eia.gov/v2/electricity/retail-sales/data/?api_key=${encodeURIComponent(key)}` +
    `&frequency=monthly&data[0]=price&facets[stateid][]=${state}&facets[sectorid][]=COM` +
    `&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1`;
  const d = await fetchJson(url);
  const rows = d?.response?.data;
  if (!rows || !rows.length || rows[0].price == null) throw new Error("EIA: no price");
  const cents = parseFloat(rows[0].price);
  return {
    kind: "elec", value: +(cents / 100).toFixed(4), unit: "$/kWh",
    label: `EIA commercial avg — ${STATE_NAMES[state] || state}`,
    source: `EIA OpenData API · retail-sales · commercial · ${rows[0].period}`,
    url: REF.eiaAPI, live: true, year: String(rows[0].period || "").slice(0, 4),
  };
}

export async function eiaGas(state: string, key: string): Promise<RateCandidate> {
  // commercial price series ($/Mcf): duoarea S{STATE}, process PCS
  const url = `https://api.eia.gov/v2/natural-gas/pri/sum/data/?api_key=${encodeURIComponent(key)}` +
    `&frequency=monthly&data[0]=value&facets[duoarea][]=S${state}&facets[process][]=PCS` +
    `&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1`;
  const d = await fetchJson(url);
  const rows = d?.response?.data;
  if (!rows || !rows.length || rows[0].value == null) throw new Error("EIA: no gas price");
  const perMcf = parseFloat(rows[0].value);
  return {
    kind: "gas", value: +(perMcf / MCF_TO_THERM).toFixed(4), unit: "$/therm",
    label: `EIA commercial gas — ${STATE_NAMES[state] || state}`,
    source: `EIA OpenData API · natural-gas commercial price · ${rows[0].period} ($${perMcf}/Mcf)`,
    url: REF.eiaAPI, live: true, year: String(rows[0].period || "").slice(0, 4),
  };
}

/* ============================================================
 *  LIVE — NREL URDB (all usable commercial tariffs near a point)
 * ============================================================ */
export async function urdbCandidates(apiKey: string, lat: number, lon: number): Promise<RateCandidate[]> {
  const url = `https://api.openei.org/utility_rates?version=8&format=json&detail=full&api_key=${encodeURIComponent(apiKey)}&lat=${lat}&lon=${lon}&sector=Commercial&limit=12`;
  const d = await fetchJson(url);
  if (d.error) throw new Error(d.error.message || "URDB error");
  const out: RateCandidate[] = [];
  for (const item of d.items || []) {
    const ers = item.energyratestructure;
    if (Array.isArray(ers) && ers[0] && ers[0][0] && ers[0][0].rate != null) {
      const rate = parseFloat(ers[0][0].rate);
      if (!isNaN(rate) && rate > 0) {
        out.push({
          kind: "elec", value: +rate.toFixed(4), unit: "$/kWh",
          label: `URDB — ${item.utility || item.name || "tariff"}`,
          source: `NREL/OpenEI URDB · ${item.name || item.utility || "tariff"} (tier-1 energy rate)`,
          url: item.uri || REF.urdb, live: true,
        });
      }
    }
  }
  if (!out.length) throw new Error("URDB: no usable tariffs");
  return out;
}

/* ============================================================
 *  LIVE — NREL Cambium (grid emission factor by GEA region/year)
 *  Falls back to embedded eGRID when the API is unavailable.
 * ============================================================ */
export async function cambiumCandidate(state: string, profile: string): Promise<RateCandidate> {
  const { factor, effMult } = cambiumTouFactor(state, profile);
  return {
    kind: "carbon", value: +factor.toFixed(4), unit: "kgCO2e/kWh",
    label: `Cambium TOU — ${state} (${profile})`,
    source: `NREL Cambium 2023 hourly LRMER, TOU-weighted ×${effMult.toFixed(2)} of annual avg`,
    url: REF.cambium, live: false,
  };
}

/* ============================================================
 *  EMBEDDED candidates
 * ============================================================ */
export function embeddedElec(state: string): RateCandidate | null {
  const c = EIA_COMM_CENTS_PER_KWH[state];
  if (c == null) return null;
  return {
    kind: "elec", value: +(c / 100).toFixed(4), unit: "$/kWh",
    label: `EIA EPM commercial — ${STATE_NAMES[state] || state}`,
    source: "EIA Electric Power Monthly, Table 5.6.B (2023 commercial avg)",
    url: REF.eiaEPM, live: false, year: "2023",
  };
}
export function embeddedGas(state: string): RateCandidate | null {
  const v = EIA_GAS_DOLLARS_PER_THERM[state];
  if (v == null) return null;
  return {
    kind: "gas", value: v, unit: "$/therm",
    label: `EIA commercial gas — ${STATE_NAMES[state] || state}`,
    source: "EIA natural gas commercial price (2023 reference)", url: REF.eiaGas, live: false, year: "2023",
  };
}
export function embeddedCarbon(state: string): RateCandidate | null {
  const v = EGRID_STATE_KG_PER_KWH[state];
  if (v == null) return null;
  return {
    kind: "carbon", value: v, unit: "kgCO2e/kWh",
    label: `eGRID2022 — ${STATE_NAMES[state] || state}`,
    source: "EPA eGRID2022 state total output emission rate", url: REF.egrid, live: false, year: "2022",
  };
}
export function embeddedWater(state: string): RateCandidate {
  const v = WATER_DOLLARS_PER_KGAL[state] ?? WATER_NATIONAL;
  return {
    kind: "water", value: v, unit: "$/kGal",
    label: WATER_DOLLARS_PER_KGAL[state] ? `Water — ${STATE_NAMES[state] || state}` : "Water — US national avg",
    source: "Circle of Blue annual water-pricing survey + utility tariffs (combined water+sewer)",
    url: REF.water, live: false,
  };
}

/* ============================================================
 *  ChatGPT (OpenAI) fallback — returns one candidate w/ citation.
 * ============================================================ */
export async function chatgptLookup(
  kind: RateCandidate["kind"], locationText: string, openaiKey: string, model: string
): Promise<RateCandidate> {
  if (!openaiKey) throw new Error("no OpenAI key");
  const unit = kind === "elec" ? "$/kWh" : kind === "gas" ? "$/therm" : kind === "carbon" ? "kgCO2e/kWh" : "$/kGal";
  const what = kind === "elec" ? "average commercial electricity price"
    : kind === "gas" ? "average commercial natural gas price"
    : kind === "carbon" ? "average grid electricity CO2e emission factor"
    : "combined water and sewer rate";
  const prompt = `Give the most recent typical ${what} for ${locationText}. ` +
    `Respond ONLY as compact JSON: {"value": <number in ${unit}>, "year": "<year>", "source": "<dataset/utility name>", "url": "<reference url>"}. ` +
    `Use authoritative sources (EIA, EPA eGRID, NREL, the local utility tariff). Value must be a plain number in ${unit}.`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an energy-data assistant. Answer with authoritative, recent figures and a real citation URL. JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${resp.status} ${t.slice(0, 120)}`);
  }
  const data = await resp.json();
  const txt = data?.choices?.[0]?.message?.content || "{}";
  let parsed: any;
  try { parsed = JSON.parse(txt); } catch { throw new Error("OpenAI: unparseable response"); }
  const value = parseFloat(parsed.value);
  if (isNaN(value)) throw new Error("OpenAI: no numeric value");
  return {
    kind, value: +value.toFixed(4), unit,
    label: `ChatGPT (${model}) — ${locationText}`,
    source: `AI estimate via ${parsed.source || "ChatGPT"} (verify)`,
    url: parsed.url || REF.openai, live: true, year: parsed.year ? String(parsed.year) : undefined,
  };
}

/* ChatGPT — structured water/irrigation/sewer charges for a city. */
export interface WaterCharges {
  water_meter: number; water_per_kgal: number;
  irrigation_meter: number; irrigation_per_kgal: number;
  sewer_meter: number; sewer_per_kgal: number;
  source: string; url: string;
}
export async function chatgptWaterCharges(locationText: string, openaiKey: string, model: string): Promise<WaterCharges> {
  if (!openaiKey) throw new Error("no OpenAI key");
  const prompt = `For ${locationText}, give the commercial utility water-related charges from the local utility rate sheet. ` +
    `Respond ONLY as compact JSON with numbers (USD): ` +
    `{"water_meter":<monthly water-service facility charge $/month>,"water_per_kgal":<water consumption $ per 1000 gallons inside city>,` +
    `"irrigation_meter":<irrigation monthly facility charge $/month>,"irrigation_per_kgal":<irrigation $ per 1000 gallons>,` +
    `"sewer_meter":<sewer monthly facility charge $/month>,"sewer_per_kgal":<sewer $ per 1000 gallons>,` +
    `"source":"<utility rate sheet name & year>","url":"<reference url>"}. Use a typical commercial meter size. Numbers only.`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a utility-rate analyst. Return real, recent figures from the local water utility tariff with a citation. JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0, response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
  const data = await resp.json();
  let p: any; try { p = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { throw new Error("unparseable"); }
  const n = (x: any) => { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
  return {
    water_meter: n(p.water_meter), water_per_kgal: n(p.water_per_kgal),
    irrigation_meter: n(p.irrigation_meter), irrigation_per_kgal: n(p.irrigation_per_kgal),
    sewer_meter: n(p.sewer_meter), sewer_per_kgal: n(p.sewer_per_kgal),
    source: `AI estimate via ${p.source || "ChatGPT"} (verify with utility tariff)`, url: p.url || REF.water,
  };
}

/* ============================================================
 *  AGGREGATORS — gather everything, de-dupe, return candidates+errors.
 * ============================================================ */
export interface GatherOpts {
  state: string; lat: number | null; lon: number | null;
  nrelKey: string; eiaKey: string; openaiKey: string; openaiModel: string;
  locationText: string; touProfile: string;
}

async function settle<T>(p: Promise<T>, errs: string[], tag: string): Promise<T | null> {
  try { return await p; } catch (e: any) { errs.push(`${tag}: ${e.message}`); return null; }
}

export async function gatherElectricity(o: GatherOpts): Promise<{ candidates: RateCandidate[]; errors: string[] }> {
  const errs: string[] = []; const cands: RateCandidate[] = [];
  const jobs: Promise<any>[] = [];
  if (o.eiaKey && o.state) jobs.push(settle(eiaElectricity(o.state, o.eiaKey), errs, "EIA").then((c) => c && cands.push(c)));
  if (o.nrelKey && o.lat != null && o.lon != null) jobs.push(settle(urdbCandidates(o.nrelKey, o.lat, o.lon), errs, "URDB").then((cs) => cs && cands.push(...cs)));
  await Promise.all(jobs);
  if (o.state) { const e = embeddedElec(o.state); if (e) cands.push(e); }
  if (!cands.length && o.openaiKey) { const c = await settle(chatgptLookup("elec", o.locationText || o.state, o.openaiKey, o.openaiModel), errs, "ChatGPT"); if (c) cands.push(c); }
  return { candidates: dedupe(cands), errors: errs };
}

export async function gatherGas(o: GatherOpts): Promise<{ candidates: RateCandidate[]; errors: string[] }> {
  const errs: string[] = []; const cands: RateCandidate[] = [];
  if (o.eiaKey && o.state) { const c = await settle(eiaGas(o.state, o.eiaKey), errs, "EIA"); if (c) cands.push(c); }
  if (o.state) { const e = embeddedGas(o.state); if (e) cands.push(e); }
  if (!cands.length && o.openaiKey) { const c = await settle(chatgptLookup("gas", o.locationText || o.state, o.openaiKey, o.openaiModel), errs, "ChatGPT"); if (c) cands.push(c); }
  return { candidates: dedupe(cands), errors: errs };
}

export async function gatherCarbon(o: GatherOpts): Promise<{ candidates: RateCandidate[]; errors: string[] }> {
  const errs: string[] = []; const cands: RateCandidate[] = [];
  if (o.state) {
    const cam = await settle(cambiumCandidate(o.state, o.touProfile), errs, "Cambium"); if (cam) cands.push(cam);
    const e = embeddedCarbon(o.state); if (e) cands.push(e);
  }
  if (!cands.length && o.openaiKey) { const c = await settle(chatgptLookup("carbon", o.locationText || o.state, o.openaiKey, o.openaiModel), errs, "ChatGPT"); if (c) cands.push(c); }
  return { candidates: dedupe(cands), errors: errs };
}

export async function gatherWater(o: GatherOpts): Promise<{ candidates: RateCandidate[]; errors: string[] }> {
  const errs: string[] = []; const cands: RateCandidate[] = [];
  if (o.state) cands.push(embeddedWater(o.state));
  if (o.openaiKey) { const c = await settle(chatgptLookup("water", o.locationText || o.state, o.openaiKey, o.openaiModel), errs, "ChatGPT"); if (c) cands.push(c); }
  return { candidates: dedupe(cands), errors: errs };
}

function dedupe(cands: RateCandidate[]): RateCandidate[] {
  const seen = new Set<string>(); const out: RateCandidate[] = [];
  for (const c of cands) { const k = `${c.label}|${c.value}`; if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

export function pickMax(cands: RateCandidate[]): RateCandidate | null {
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.value > a.value ? b : a));
}
