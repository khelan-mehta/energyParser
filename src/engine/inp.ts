/* ============================================================
 *  INP PARSER — glass, chiller/boiler COP, utility rates, shading
 *  Also surfaces flat-rate recognition metadata (tiers / TOU flags).
 * ============================================================ */
import type { Row } from "./sim";

const HDR_RE = /^\s*"([^"]+)"\s*=\s*([A-Z][A-Z0-9\-]+)\s*$/;
const BARE_HDR_RE = /^\s*([A-Z][A-Z0-9\-]+)\s*$/;
const PROP_RE = /^\s*([A-Z][A-Z0-9\-]+)\s*=\s*(.+?)\s*$/;

function cleanValue(v: string): any {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("(") && v.endsWith(")")) {
    const inner = v.slice(1, -1).trim();
    return inner.split(",").map((x) => {
      x = x.trim().replace(/^"|"$/g, "");
      const n = parseFloat(x);
      return !isNaN(n) && /^-?\d+\.?\d*$/.test(x) ? n : x;
    });
  }
  const n = parseFloat(v);
  if (!isNaN(n) && /^-?\d+\.?\d*([eE][-+]?\d+)?$/.test(v)) return n;
  return v;
}

export class INPParser {
  text: string;
  name: string;
  blocks: any[];
  byType: Record<string, any[]>;
  byName: Record<string, any>;

  constructor(text: string, name: string) {
    this.text = text; this.name = name;
    this.blocks = []; this.byType = {}; this.byName = {};
  }

  parse(): Row {
    if (!this.text) return {};
    this._parseBlocks();
    return {
      ...this._extractProject(), ...this._extractSite(), ...this._extractRates(),
      ...this._extractGlass(), ...this._extractEquip(), ...this._extractShading(),
    };
  }

  _parseBlocks() {
    let name: string | null = null, otype: string | null = null, props: Row = {}, inBlock = false;
    const commit = () => {
      if (otype !== null) {
        this.blocks.push([name, otype, props]);
        if (!this.byType[otype]) this.byType[otype] = [];
        this.byType[otype].push([name, props]);
        if (name) this.byName[name] = [otype, props];
      }
      name = null; otype = null; props = {}; inBlock = false;
    };
    for (let raw of this.text.split(/\r?\n/)) {
      let line = raw.replace(/\s+$/, ""); const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("$")) continue;
      if (trimmed === "..") { commit(); continue; }
      if (line.replace(/\s+$/, "").endsWith("..")) line = line.slice(0, line.lastIndexOf("..")).replace(/\s+$/, "");
      let m = line.match(HDR_RE);
      if (m) { if (inBlock) commit(); name = m[1]; otype = m[2]; props = {}; inBlock = true; continue; }
      m = line.match(BARE_HDR_RE);
      if (m && !inBlock) { otype = m[1]; name = null; props = {}; inBlock = true; continue; }
      m = line.match(PROP_RE);
      if (m && inBlock) props[m[1]] = cleanValue(m[2]);
    }
    commit();
  }

  _extractProject(): Row {
    const out: Row = { inp_title: "", inp_run_period: "" };
    for (const [, props] of (this.byType.TITLE || [])) { if (props["LINE-1"]) { out.inp_title = String(props["LINE-1"]).replace(/\*/g, ""); break; } }
    for (const [, props] of (this.byType["RUN-PERIOD-PD"] || [])) { const bm = props["BEGIN-MONTH"], bd = props["BEGIN-DAY"], by = props["BEGIN-YEAR"], em = props["END-MONTH"], ed = props["END-DAY"], ey = props["END-YEAR"]; if (bm && em) out.inp_run_period = `${bm}/${bd}/${by} - ${em}/${ed}/${ey}`; break; }
    return out;
  }

  _extractSite(): Row {
    const out: Row = {};
    for (const [, props] of (this.byType["SITE-PARAMETERS"] || [])) { if (props.ALTITUDE !== undefined) out.inp_altitude_ft = props.ALTITUDE; if (props.LATITUDE !== undefined) out.inp_latitude = props.LATITUDE; if (props.LONGITUDE !== undefined) out.inp_longitude = props.LONGITUDE; break; }
    for (const [, props] of (this.byType["BUILD-PARAMETERS"] || [])) { if (props.AZIMUTH !== undefined) out.inp_building_azimuth = props.AZIMUTH; break; }
    return out;
  }

  /* Rate extraction + flat-rate recognition.
     A model rate is "flat" when it has a single energy tier and no
     seasonal/TOU schedule reference (SCHEDULE / QUALIFY / RATCHET). */
  _extractRates(): Row {
    const out: Row = {
      inp_elec_rate_per_kwh: null, inp_elec_rate_per_kbtu: null,
      inp_gas_rate_per_therm: null, inp_gas_rate_per_kbtu: null,
      inp_utility_rates: [], inp_rate_is_flat: null, inp_rate_structure: "",
    };
    for (const [name, props] of (this.byType["UTILITY-RATE"] || [])) {
      const fuel = String(props.TYPE || "").toUpperCase();
      let refs = props["BLOCK-CHARGES"] || []; if (typeof refs === "string") refs = [refs];
      let tier1 = 0, tierCount = 0;
      for (const ref of refs) {
        if (this.byName[ref]) {
          const bprops = this.byName[ref][1];
          let costs = bprops["COSTS-1"];
          if (Array.isArray(costs) && costs.length) { tier1 += parseFloat(costs[0]) || 0; tierCount += costs.length; }
          else if (typeof costs === "number") { tier1 += costs; tierCount += 1; }
        }
      }
      const hasSchedule = props["SCHEDULE"] !== undefined || props["COST-SCHEDULE"] !== undefined;
      const hasRatchet = props["RATCHET"] !== undefined || props["QUALIFY"] !== undefined;
      const isFlat = tierCount <= 1 && !hasSchedule && !hasRatchet;
      out.inp_utility_rates.push({ name, fuel, tier1_cost: tier1, tiers: tierCount, flat: isFlat });
      if (fuel.includes("ELEC")) {
        out.inp_elec_rate_per_kwh = tier1; out.inp_elec_rate_per_kbtu = tier1 ? tier1 / 3.412 : null;
        out.inp_rate_is_flat = isFlat;
        out.inp_rate_structure = isFlat ? "flat" : (hasSchedule ? "time-of-use" : (tierCount > 1 ? "tiered/block" : "flat"));
      } else if (fuel.includes("GAS") || fuel === "NATURAL-GAS") {
        out.inp_gas_rate_per_therm = tier1; out.inp_gas_rate_per_kbtu = tier1 ? tier1 / 100 : null;
      }
    }
    return out;
  }

  _extractGlass(): Row {
    const out: Row = { inp_glass_shgc: null, inp_glass_vlt: null, inp_glass_u: null, inp_glass_type_names: [] };
    const shgcs: number[] = [], vlts: number[] = [], us: number[] = [];
    for (const [name, props] of (this.byType["GLASS-TYPE"] || [])) {
      out.inp_glass_type_names.push(name);
      const sc = props["SHADING-COEF"]; const cond = props["GLASS-CONDUCT"];
      const vt = props["VIS-TRANS"] !== undefined ? props["VIS-TRANS"] : (props["VLT"] !== undefined ? props["VLT"] : null);
      if (typeof sc === "number") shgcs.push(sc * 0.87);
      if (typeof cond === "number") us.push(cond);
      if (typeof vt === "number") vlts.push(vt);
    }
    if (shgcs.length) out.inp_glass_shgc = shgcs.reduce((a, b) => a + b, 0) / shgcs.length;
    if (us.length) out.inp_glass_u = us.reduce((a, b) => a + b, 0) / us.length;
    if (vlts.length) out.inp_glass_vlt = vlts.reduce((a, b) => a + b, 0) / vlts.length;
    return out;
  }

  _extractEquip(): Row {
    const out: Row = { inp_chiller_cop: 0, inp_boiler_cop: 0 };
    const cops: number[] = [];
    for (const [, props] of (this.byType["CHILLER"] || [])) {
      const eir = props["ELEC-INPUT-RATIO"];
      if (typeof eir === "number" && eir > 0) cops.push(1 / eir);
    }
    if (cops.length) out.inp_chiller_cop = cops.reduce((a, b) => a + b, 0) / cops.length;
    const boilerCops: number[] = [];
    for (const [, props] of (this.byType["BOILER"] || [])) {
      const type = String(props["TYPE"] || "").toUpperCase();
      const hir = props["HEAT-INPUT-RATIO"];
      if (type.includes("ELEC")) boilerCops.push(0.98);
      else if (typeof hir === "number" && hir > 0) boilerCops.push(1 / hir);
    }
    if (boilerCops.length) out.inp_boiler_cop = boilerCops.reduce((a, b) => a + b, 0) / boilerCops.length;
    return out;
  }

  _extractShading(): Row {
    let bldgAz = 0;
    for (const [, props] of (this.byType["BUILD-PARAMETERS"] || [])) { bldgAz = parseFloat(props.AZIMUTH || 0) || 0; break; }
    const azToFacade = (az: number) => { az = ((az % 360) + 360) % 360; if (az < 45 || az >= 315) return "north"; if (az < 135) return "east"; if (az < 225) return "south"; return "west"; };
    let curType: string | null = null, curProps: Row = {}, curWallAz: number | null = null;
    const facades: Record<string, any> = { north: { w: 0, s: 0, o: 0, f: 0 }, east: { w: 0, s: 0, o: 0, f: 0 }, south: { w: 0, s: 0, o: 0, f: 0 }, west: { w: 0, s: 0, o: 0, f: 0 } };
    for (const raw of this.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("$")) continue;
      if (line === "..") {
        if (curType === "EXTERIOR-WALL") curWallAz = (parseFloat(curProps.AZIMUTH || 0) || 0) + bldgAz;
        else if (curType === "WINDOW" && curWallAz !== null) {
          const fc = facades[azToFacade(curWallAz)]; fc.w++;
          const keys = Object.keys(curProps);
          const hasOH = keys.some((k) => k.startsWith("OVERHANG-"));
          const hasFin = keys.some((k) => ["FIN-A", "FIN-B", "FIN-C", "FIN-D"].includes(k));
          if (hasOH) fc.o++; if (hasFin) fc.f++; if (hasOH || hasFin) fc.s++;
        }
        curType = null; curProps = {}; continue;
      }
      let m = line.match(HDR_RE);
      if (m) { curType = m[2]; curProps = {}; continue; }
      m = line.match(PROP_RE);
      if (m && curType) curProps[m[1]] = cleanValue(m[2]);
    }
    const out: Row = {};
    for (const f of ["north", "east", "south", "west"]) {
      const b = facades[f], pct = b.w ? (b.s / b.w * 100) : 0;
      out[`inp_${f}_shading_type`] = (b.o && b.f) ? "Overhang+Fin" : b.o ? "Overhang" : b.f ? "Fin" : "None";
      out[`inp_${f}_shading_ratio`] = Math.round(pct * 10) / 10;
    }
    return out;
  }
}
