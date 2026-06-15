/* ============================================================
 *  RATE + CARBON + WATER + LOCATION INTELLIGENCE
 *  All lookups run in the browser. Every value carries a `source`.
 * ============================================================ */

export interface RateConfig {
  // electricity / gas ($/unit) — manual or suggested
  elec_per_kwh: number | null;
  gas_per_therm: number | null;
  rate_source: string;        // citation for the electricity rate
  gas_source: string;         // citation for the gas rate
  rate_structure: string;     // flat | tiered/block | time-of-use | suggested | manual

  // carbon
  carbon_method: "egrid" | "cambium-tou" | "manual";
  elec_carbon_per_kwh: number | null; // kg CO2e/kWh
  gas_carbon_per_therm: number | null; // kg CO2e/therm
  carbon_source: string;
  tou_profile: "flat" | "office" | "residential" | "247";

  // water
  water_per_kgal: number | null;       // $/kGal
  water_source: string;

  // district energy (LEED)
  dc_carbon_per_kbtu: number;  // district cooling
  dh_carbon_per_kbtu: number;  // district heating
  dc_rate_per_kbtu: number;
  dh_rate_per_kbtu: number;

  // location / project address
  location_name: string;   // full project address (label: "Project Address")
  city: string;
  country: string;
  pincode: string;
  state: string;
  lat: number | null;
  lon: number | null;

  // detailed water charges (Bentonville-style breakdown)
  water_meter_charge: number | null;       // $/month water service meter
  water_consumption_per_kgal: number | null;
  irrigation_meter_charge: number | null;
  irrigation_per_kgal: number | null;
  sewer_meter_charge: number | null;
  sewer_per_kgal: number | null;

  default_vlt: number;
}

export function defaultRateConfig(): RateConfig {
  return {
    elec_per_kwh: null, gas_per_therm: null, rate_source: "", gas_source: "", rate_structure: "",
    carbon_method: "egrid", elec_carbon_per_kwh: null, gas_carbon_per_therm: null,
    carbon_source: "", tou_profile: "office",
    water_per_kgal: null, water_source: "",
    dc_carbon_per_kbtu: 0, dh_carbon_per_kbtu: 0, dc_rate_per_kbtu: 0, dh_rate_per_kbtu: 0,
    location_name: "", city: "", country: "USA", pincode: "", state: "", lat: null, lon: null,
    water_meter_charge: null, water_consumption_per_kgal: null,
    irrigation_meter_charge: null, irrigation_per_kgal: null,
    sewer_meter_charge: null, sewer_per_kgal: null,
    default_vlt: 0.9,
  };
}

/* ============================================================
 *  eGRID 2022 — state total output CO2e emission rate (kg CO2e/kWh)
 *  Source: EPA eGRID2022 (state aggregation, total output rate).
 *  Reference values for estimation — verify against project subregion.
 * ============================================================ */
export const EGRID_STATE_KG_PER_KWH: Record<string, number> = {
  AL: 0.37, AK: 0.44, AZ: 0.38, AR: 0.46, CA: 0.21, CO: 0.50, CT: 0.24, DE: 0.36,
  DC: 0.29, FL: 0.39, GA: 0.34, HI: 0.69, ID: 0.10, IL: 0.27, IN: 0.65, IA: 0.36,
  KS: 0.40, KY: 0.74, LA: 0.36, ME: 0.16, MD: 0.30, MA: 0.27, MI: 0.45, MN: 0.39,
  MS: 0.42, MO: 0.66, MT: 0.45, NE: 0.49, NV: 0.32, NH: 0.13, NJ: 0.23, NM: 0.50,
  NY: 0.21, NC: 0.32, ND: 0.62, OH: 0.51, OK: 0.40, OR: 0.13, PA: 0.34, RI: 0.42,
  SC: 0.26, SD: 0.25, TN: 0.31, TX: 0.39, UT: 0.62, VT: 0.01, VA: 0.29, WA: 0.10,
  WV: 0.82, WI: 0.50, WY: 0.79,
};

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/* ============================================================
 *  ENERGY STAR Portfolio Manager — GHG emission factors.
 *  Source: "Greenhouse Gas Emissions Technical Reference" (EPA / ENERGY STAR,
 *  Aug 2025), which applies EPA eGRID2023 by eGRID SUBREGION (mapped from the
 *  building ZIP/pincode). Electricity factors are kg CO2e per MBtu of SITE
 *  energy (Figure 5); gas is direct (Figure 1); district is Figure 3.
 * ============================================================ */
export const ESPM_ELEC_KG_PER_MBTU: Record<string, number> = {
  AKGD: 120.32, AKMS: 69.45, AZNM: 93.88, CAMX: 57.16, ERCT: 97.92, FRCC: 104.33,
  HIMS: 150.65, HIOA: 199.26, MROE: 186.77, MROW: 123.17, NEWE: 72.21, NWPP: 84.45,
  NYCW: 115.09, NYLI: 158.10, NYUP: 32.27, PRMS: 205.85, RFCE: 79.65, RFCM: 129.74,
  RFCW: 121.78, RMPA: 138.59, SPNO: 115.35, SPSO: 116.39, SRMV: 98.60, SRMW: 165.98,
  SRSO: 112.46, SRTV: 120.08, SRVC: 79.27,
};
export const ESPM_NATIONAL_ELEC_KG_PER_MBTU = 102.48;
export const ESPM_GAS_KG_PER_MBTU = 53.11;          // direct natural gas (US) → ÷10 = kg/therm
export const ESPM_DISTRICT_KG_PER_MBTU = { steam: 66.40, hotWater: 66.40, chilledWaterElectric: 52.70 };
export const ESPM_SOURCE = "ENERGY STAR Portfolio Manager — EPA eGRID2023 (Aug 2025 GHG Technical Reference)";

const MBTU_TO_KWH = 1e6 / 3412.14; // 1 MBtu (million Btu) ≈ 293.07 kWh

/* ENERGY STAR source-to-site ratios. These are NATIONAL sets (one for the U.S.,
   a different one for Canada) — ESPM does NOT vary them by eGRID subregion/ZIP,
   so every U.S. project shares the U.S. set. We only have the U.S. values, so
   non-U.S. / undetermined locations resolve to null → the cells are left blank. */
export interface SiteToSource { elec: number; gas: number; addFuel: number | null; dc: number; dh: number; source: string; }
export const ESPM_SITE_TO_SOURCE_US: SiteToSource = {
  elec: 2.80, gas: 1.05, addFuel: null, dc: 0.91, dh: 1.20,
  source: "Energy Star US and Canadian Source to Site Ratios",
};
/** Resolve the source-to-site ratio set from a pincode (preferred) / US state.
 *  US ZIP or a US state → U.S. set; Canadian postal / foreign / unknown → null. */
export function siteToSourceFor(pincode?: string, state?: string): SiteToSource | null {
  const zip = (pincode || "").trim();
  if (/^\d{5}(-\d{4})?$/.test(zip)) return ESPM_SITE_TO_SOURCE_US;        // U.S. ZIP
  if (/^[A-Za-z]\d[A-Za-z]/.test(zip)) return null;                        // Canadian postal — no provided set
  if (state && Object.prototype.hasOwnProperty.call(STATE_NAMES, state.toUpperCase())) return ESPM_SITE_TO_SOURCE_US;
  return null;                                                             // undetermined → leave blank
}

/** State → dominant eGRID subregion. ESPM maps by ZIP; split states are refined
 *  by ZIP prefix in subregionFor(). Approximate for states spanning subregions. */
export const STATE_TO_EGRID_SUBREGION: Record<string, string> = {
  AL: "SRSO", AK: "AKGD", AZ: "AZNM", AR: "SRMV", CA: "CAMX", CO: "RMPA", CT: "NEWE",
  DE: "RFCE", DC: "RFCE", FL: "FRCC", GA: "SRSO", HI: "HIOA", ID: "NWPP", IL: "RFCW",
  IN: "RFCW", IA: "MROW", KS: "SPNO", KY: "SRTV", LA: "SRMV", ME: "NEWE", MD: "RFCE",
  MA: "NEWE", MI: "RFCM", MN: "MROW", MS: "SRMV", MO: "SRMW", MT: "NWPP", NE: "MROW",
  NV: "NWPP", NH: "NEWE", NJ: "RFCE", NM: "AZNM", NY: "NYUP", NC: "SRVC", ND: "MROW",
  OH: "RFCW", OK: "SPSO", OR: "NWPP", PA: "RFCE", RI: "NEWE", SC: "SRVC", SD: "MROW",
  TN: "SRTV", TX: "ERCT", UT: "NWPP", VT: "NEWE", VA: "SRVC", WA: "NWPP", WV: "RFCW",
  WI: "MROW", WY: "RMPA",
};

/** Resolve an eGRID subregion from state + ZIP. ZIP prefixes refine the few metros
 *  that straddle subregions (NYC vs Long Island vs Upstate NY). */
export function subregionFor(state: string, zip?: string): string {
  const z3 = (zip || "").replace(/\D/g, "").slice(0, 3);
  if (state === "NY" && z3) {
    if (/^(100|101|102|103|104|111|112|113)$/.test(z3)) return "NYCW"; // NYC metro
    if (/^(005|110|114|115|116|117|118|119)$/.test(z3)) return "NYLI"; // Long Island
    return "NYUP";
  }
  return STATE_TO_EGRID_SUBREGION[state] || "";
}

/** ENERGY STAR Portfolio Manager electricity emission factor for a subregion (kg CO2e/kWh). */
export function espmElecCarbonPerKwh(subregion: string): number {
  const f = ESPM_ELEC_KG_PER_MBTU[subregion] ?? ESPM_NATIONAL_ELEC_KG_PER_MBTU;
  return f / MBTU_TO_KWH;
}
/** ENERGY STAR Portfolio Manager natural-gas emission factor (kg CO2e/therm). */
export const ESPM_GAS_KG_PER_THERM = ESPM_GAS_KG_PER_MBTU / 10;

/* ============================================================
 *  Cambium — diurnal (time-of-use) emission multipliers.
 *  Normalized 24-hour shape applied to the annual-average factor.
 *  Reference: NREL Cambium 2023 hourly long-run marginal emission
 *  rates, generalized to representative regional shapes.
 * ============================================================ */
const TOU_SHAPE_SOLAR = [ // CA/NV/AZ "duck-curve": low midday, high evening
  1.05, 1.05, 1.04, 1.03, 1.02, 1.02, 1.04, 1.05, 0.98, 0.85, 0.72, 0.62,
  0.58, 0.58, 0.64, 0.78, 0.98, 1.22, 1.42, 1.48, 1.40, 1.28, 1.18, 1.10,
];
const TOU_SHAPE_THERMAL = [ // coal/gas grids: flatter, slight evening peak
  0.92, 0.90, 0.89, 0.89, 0.90, 0.94, 1.00, 1.05, 1.07, 1.06, 1.04, 1.03,
  1.02, 1.02, 1.03, 1.05, 1.08, 1.12, 1.14, 1.12, 1.08, 1.02, 0.97, 0.94,
];

function regionShape(state: string): number[] {
  if (["CA", "NV", "AZ", "NM", "HI"].includes(state)) return TOU_SHAPE_SOLAR;
  return TOU_SHAPE_THERMAL;
}

/* Load-share profiles (fraction of annual electricity by hour, sums to 1). */
const LOAD_PROFILES: Record<string, number[]> = {
  flat: Array(24).fill(1 / 24),
  office: [ // weekday office-dominant
    0.020, 0.018, 0.017, 0.017, 0.018, 0.022, 0.030, 0.045, 0.060, 0.068, 0.072, 0.072,
    0.068, 0.070, 0.070, 0.066, 0.058, 0.048, 0.038, 0.030, 0.026, 0.024, 0.022, 0.021,
  ],
  residential: [ // morning + evening peaks
    0.030, 0.026, 0.024, 0.023, 0.024, 0.030, 0.045, 0.055, 0.050, 0.042, 0.038, 0.036,
    0.036, 0.036, 0.038, 0.044, 0.056, 0.068, 0.072, 0.068, 0.058, 0.050, 0.042, 0.034,
  ],
  "247": Array(24).fill(1 / 24),
};
function normalize(a: number[]): number[] { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / s); }

/** TOU-weighted effective annual electricity carbon factor (kg/kWh). */
export function cambiumTouFactor(state: string, profile: string): { factor: number; effMult: number } {
  const base = EGRID_STATE_KG_PER_KWH[state] ?? 0.4;
  const shape = regionShape(state);
  const load = normalize(LOAD_PROFILES[profile] || LOAD_PROFILES.flat);
  // effective multiplier = sum_h (load_share_h * shape_h)
  const effMult = shape.reduce((acc, m, h) => acc + m * load[h], 0);
  return { factor: base * effMult, effMult };
}

/** Hourly absolute factors for charting (kg/kWh by hour). */
export function cambiumHourly(state: string): number[] {
  const base = EGRID_STATE_KG_PER_KWH[state] ?? 0.4;
  return regionShape(state).map((m) => base * m);
}

/* Natural-gas combustion CO2e (EPA): ~5.30 kg CO2e per therm. */
export const GAS_CARBON_KG_PER_THERM = 5.30;

/* ============================================================
 *  Water rates — US reference combined water + sewer.
 * ============================================================ */
export const DEFAULT_WATER_RATE_PER_KGAL = 12.0; // $/kGal combined (US reference)
export const WATER_SOURCE_DEFAULT =
  "US reference combined water+sewer ≈ $12/kGal (verify with local utility tariff)";

/* ============================================================
 *  LEED district-energy guidance (v4 EAp2/EAc2 DES treatment).
 * ============================================================ */
export interface LeedGuidance { title: string; body: string[]; factors: { label: string; value: string }[]; source: string; }

export const LEED_DES_GUIDANCE: LeedGuidance = {
  title: "Treatment of District / Campus Thermal Energy in LEED (DES Guidance)",
  body: [
    "When a building is connected to a district or campus thermal energy system (DES), the project must account for that plant's performance in EA Prerequisite 2 and EA Credit 1 (Optimize Energy Performance). All downstream equipment (heat exchangers, pressure-reduction stations, pumps, valves, pipes, controls) is ALWAYS in scope; upstream (central-plant) equipment is included or excluded depending on the option chosen.",
    "Option 1 — Cost-neutral purchased energy: the DES energy source is modeled identically in the Baseline and Proposed as purchased heat / purchased chilled water (Tables 2 & 3). Upstream plant is excluded. Simpler, but EAc1 points are capped (e.g. LEED-NC 2009: max 10 of 19 points).",
    "Option 2 — Aggregate building + DES scenario: a virtual on-site DES-equivalent plant is constructed for the Proposed case and compared to a code-minimum on-site plant for the Baseline (Table 4). Upstream plant is included. Required to exceed the Option 1 points cap (Option 2 has a points floor, e.g. 6 of 19 for LEED-NC 2009).",
    "Follow ASHRAE 90.1 Appendix G modeling, except as modified by the DES guidance §2.4.3–2.4.5. Account for transmission & distribution losses, secondary pumping, leaks and thermal losses between the central plant and the building in both directions in the Proposed Option-2 case.",
    "Virtual energy rates: if a FLAT rate structure is used for all energy sources, the flat rates become the virtual energy rates directly. Otherwise run a preliminary Option-1 Baseline model to derive the virtual electric and fuel rates, then compute the district rates with the formulas below.",
  ],
  factors: [
    { label: "DES heating plant default efficiency", value: "70% (Higher Heating Value) — total boiler-plant average" },
    { label: "DES cooling plant default efficiency", value: "COP 4.4 — total plant incl. cooling towers & primary pumps" },
    { label: "Thermal distribution losses", value: "use seasonal default loss factors (DES §2.4.1.2.3) when actual data unavailable" },
    { label: "District chilled-water rate", value: "$/MBTU = Virtual Electric Rate ($/kWh) × 71  ·  $/ton-hr = ×0.85" },
    { label: "District hot-water rate", value: "$/MBTU = Virtual Fuel Rate ($/MBTU) × 1.59 + Virtual Electric Rate ($/kWh) × 3" },
    { label: "District steam rate", value: "$/MBTU = Virtual Fuel Rate ($/MBTU) × 1.81 + Virtual Electric Rate ($/kWh) × 3" },
    { label: "EAc1 points (LEED-NC 2009)", value: "Option 1 cap = 10/19 · Option 2 floor = 6/19" },
  ],
  source: "USGBC — Treatment of District or Campus Thermal Energy in LEED v2 and LEED 2009 Design & Construction, v2.0 (Aug 13, 2010). Default efficiencies §2.4.1.2.3; virtual rate formulas §2.4 (Energy Rates). [DES Guidance.pdf]",
};

/* ============================================================
 *  Location identification (lat/lon → place + state) via Nominatim.
 *  CORS-friendly; degrades gracefully when offline.
 * ============================================================ */
export interface LocationInfo {
  name: string; state: string; stateName: string;
  egrid_kg_per_kwh: number | null; source: string;
}

export async function identifyLocation(lat: number, lon: number): Promise<LocationInfo> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=8&addressdetails=1`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`reverse-geocode HTTP ${resp.status}`);
  const data = await resp.json();
  const a = data.address || {};
  const stateName: string = a.state || "";
  const state = stateAbbr(stateName);
  const place = a.city || a.town || a.village || a.county || a.suburb || "";
  const name = [place, state || stateName, a.country_code ? String(a.country_code).toUpperCase() : ""].filter(Boolean).join(", ");
  const egrid = state ? (EGRID_STATE_KG_PER_KWH[state] ?? null) : null;
  return {
    name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    state, stateName,
    egrid_kg_per_kwh: egrid,
    source: "OpenStreetMap Nominatim reverse-geocode + EPA eGRID2022 state factor",
  };
}

/** Forward geocode a Project Address (city/state/country/pincode) → lat/lon. */
export async function geocodeAddress(parts: { city?: string; state?: string; country?: string; pincode?: string }): Promise<LocationInfo & { lat: number; lon: number }> {
  const q = [parts.city, parts.state, parts.pincode, parts.country].filter(Boolean).join(", ");
  if (!q.trim()) throw new Error("enter a city, state or pincode first");
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&addressdetails=1&limit=1`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`geocode HTTP ${resp.status}`);
  const arr = await resp.json();
  if (!arr || !arr.length) throw new Error(`no match for "${q}"`);
  const item = arr[0];
  const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
  const a = item.address || {};
  const stateName: string = a.state || parts.state || "";
  const state = stateAbbr(stateName);
  const place = a.city || a.town || a.village || a.county || parts.city || "";
  const name = item.display_name || q;
  return {
    name, state, stateName,
    egrid_kg_per_kwh: state ? (EGRID_STATE_KG_PER_KWH[state] ?? null) : null,
    source: "OpenStreetMap Nominatim forward-geocode + EPA eGRID2022 state factor",
    lat, lon,
  };
}

function stateAbbr(name: string): string {
  const raw = name.trim();
  const up = raw.toUpperCase();
  if (STATE_NAMES[up]) return up; // already a 2-letter code
  const n = raw.toLowerCase();
  for (const [abbr, full] of Object.entries(STATE_NAMES)) {
    if (full.toLowerCase() === n) return abbr;
  }
  return "";
}

/* ============================================================
 *  NREL URDB rate lookup (suggest a flat $/kWh by location).
 * ============================================================ */
export interface RateSuggestion { rate: number; name: string; utility: string; source: string; }

export async function nrelUrdbLookup(apiKey: string, lat: number, lon: number): Promise<RateSuggestion> {
  const directUrl = `https://api.openei.org/utility_rates?version=8&format=json&detail=full&api_key=${encodeURIComponent(apiKey)}&lat=${lat}&lon=${lon}&sector=Commercial&limit=5`;
  const isFileOrigin = location.protocol === "file:";
  let data: any;
  if (isFileOrigin) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`;
    const proxyResp = await fetch(proxyUrl);
    if (!proxyResp.ok) throw new Error(`Proxy HTTP ${proxyResp.status}. Serve over http to use direct NREL lookup.`);
    const wrapper = await proxyResp.json();
    data = JSON.parse(wrapper.contents);
  } else {
    const resp = await fetch(directUrl);
    if (!resp.ok) throw new Error(`URDB HTTP ${resp.status}`);
    data = await resp.json();
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (!data.items || !data.items.length) throw new Error("no rates found for location");
  for (const item of data.items) {
    const ers = item.energyratestructure;
    if (Array.isArray(ers) && ers.length && Array.isArray(ers[0]) && ers[0].length) {
      const rate = parseFloat(ers[0][0].rate);
      if (!isNaN(rate) && rate > 0) {
        return {
          rate, name: item.name || item.utility || "URDB rate", utility: item.utility || "",
          source: `NREL/OpenEI URDB — ${item.utility || item.name || "utility tariff"} (tier-1 energy rate)`,
        };
      }
    }
  }
  throw new Error("rates found but no usable energy rate structure");
}
