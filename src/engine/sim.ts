/* ============================================================
 *  epAutomate — DOE-2.2 SIM → row engine (ported to TS)
 *    BEPS/BEPU  → energy end-uses (exact kBtu + kWh) + EUI + areas
 *    LV-D       → envelope summary, WWR, weighted U-values
 *    LV-E       → underground / slab-on-grade U-values
 *    LV-B       → space inventory: conditioned area, people, LPD, EPD
 *    SV-A       → supply/return fan kW, supply CFM, OA CFM
 *    SS-A       → per-system peak heating/cooling
 *    PS-B       → peak electric kW + peak hour
 * ============================================================ */

export type Row = Record<string, any>;

const MONTH_NAMES: Record<number, string> = {
  1: "JAN", 2: "FEB", 3: "MAR", 4: "APR", 5: "MAY", 6: "JUN",
  7: "JUL", 8: "AUG", 9: "SEP", 10: "OCT", 11: "NOV", 12: "DEC",
};
const KWH_TO_KBTU = 3.412, THERM_TO_KBTU = 100, MBTU_TO_KBTU = 1000;

function floats(line: string): number[] {
  const m = line.match(/[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?/g);
  return m ? m.map(parseFloat) : [];
}

export class SIMParser {
  text: string;
  name: string;
  lines: string[];
  r: Row;

  constructor(text: string, name: string) {
    this.text = text;
    this.name = name;
    this.lines = text.split(/\r?\n/);
    this.r = {};
  }

  parse(): Row {
    this._header();
    this._psb();
    this._beps_bepu();
    this._pse_fallback();
    this._ssr();
    this._ssa_peaks();
    this._lvb();
    this._lvd();
    this._lve();
    this._sva();
    this._derived();
    return this.r;
  }

  _header() {
    const r = this.r;
    const line1 = this.lines[0] || "";
    r.project_name = line1.slice(0, 65).trim();
    const tm = line1.match(/(\d+\/\d+\/\d{4})\s+(\d+:\d+:\d+)/);
    r.timestamp = tm ? `${tm[1]} ${tm[2]}` : "";
    r.weather_file = "";
    for (let i = 0; i < Math.min(40, this.lines.length); i++) {
      const wm = this.lines[i].match(/WEATHER FILE-\s+(.+?)(?:\s{2,}|$)/);
      if (wm) { r.weather_file = wm[1].trim(); break; }
    }
  }

  _psb() {
    const r = this.r;
    Object.assign(r, { kwh_annual: 0, max_kw: 0, peak_elec_mon_day: "", therm_annual: 0, max_therm_hr: 0 });
    let in_psb = false, in_em1 = false, in_fm1 = false, after_max = false;
    for (const line of this.lines) {
      if (line.includes("REPORT- PS-B")) { in_psb = true; in_em1 = in_fm1 = after_max = false; continue; }
      if (!in_psb) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("PS-B")) { in_psb = false; continue; }
      const s = line.trim();
      if (s.startsWith("EM1")) { in_em1 = true; in_fm1 = false; after_max = false; continue; }
      if (s.startsWith("FM1")) { in_fm1 = true; in_em1 = false; continue; }
      if (in_em1) {
        if (s.startsWith("KWH")) { const n = floats(s.replace("KWH", "")); if (n.length) r.kwh_annual = n[n.length - 1]; }
        else if (s.startsWith("MAX KW")) { const n = floats(s.replace("MAX KW", "")); if (n.length) r.max_kw = n[n.length - 1]; after_max = true; }
        else if (after_max && s.startsWith("DAY/HR")) { const t = s.split(/\s+/); if (t.length) r.peak_elec_mon_day = t[t.length - 1]; after_max = false; in_em1 = false; }
      }
      if (in_fm1) {
        if (s.startsWith("THERM")) { const n = floats(s.replace("THERM", "")); if (n.length) r.therm_annual = n[n.length - 1]; }
        else if (s.startsWith("MAX THERM/HR")) { const n = floats(s.replace("MAX THERM/HR", "")); if (n.length) r.max_therm_hr = n[n.length - 1]; in_fm1 = false; }
      }
    }
  }

  _beps_bepu() {
    const r = this.r;
    r._has_beps = false;
    let in_beps = false, grabbed_elec = false;
    for (const line of this.lines) {
      if (line.includes("REPORT- BEPS")) { in_beps = true; grabbed_elec = false; continue; }
      if (!in_beps) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("BEPS")) { in_beps = false; continue; }
      const s = line.trim();
      if (s.startsWith("MBTU") && !grabbed_elec) {
        const n = floats(s.replace("MBTU", ""));
        if (n.length >= 13) {
          r.beps_lights_mbtu = n[0]; r.beps_task_mbtu = n[1]; r.beps_misc_mbtu = n[2];
          r.beps_heat_mbtu = n[3]; r.beps_cool_mbtu = n[4]; r.beps_reject_mbtu = n[5];
          r.beps_pumps_mbtu = n[6]; r.beps_fans_mbtu = n[7]; r.beps_refrig_mbtu = n[8];
          r.beps_htpump_mbtu = n[9]; r.beps_dhw_mbtu = n[10]; r.beps_ext_mbtu = n[11];
          r.beps_total_mbtu = n[12]; r._has_beps = true; grabbed_elec = true;
        }
      }
      const eu = s.match(/TOTAL SITE ENERGY\s+([\d.]+)\s+MBTU\s+([\d.]+)\s+KBTU\/SQFT-YR GROSS-AREA\s+([\d.]+)\s+KBTU\/SQFT-YR NET-AREA/);
      if (eu) { r.beps_site_mbtu = parseFloat(eu[1]); r.beps_eui_gross = parseFloat(eu[2]); r.beps_eui_net = parseFloat(eu[3]); }
    }
    let in_bepu = false, grabbed_kwh = false, grabbed_therm = false;
    for (const line of this.lines) {
      if (line.includes("REPORT- BEPU")) { in_bepu = true; grabbed_kwh = grabbed_therm = false; continue; }
      if (!in_bepu) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("BEPU")) { in_bepu = false; continue; }
      const s = line.trim();
      if (s.startsWith("KWH") && !grabbed_kwh) {
        const n = floats(s.replace("KWH", ""));
        if (n.length >= 13) {
          r.bepu_lights_kwh = n[0]; r.bepu_task_kwh = n[1]; r.bepu_misc_kwh = n[2];
          r.bepu_heat_kwh = n[3]; r.bepu_cool_kwh = n[4]; r.bepu_reject_kwh = n[5];
          r.bepu_pumps_kwh = n[6]; r.bepu_fans_kwh = n[7]; r.bepu_refrig_kwh = n[8];
          r.bepu_htpump_kwh = n[9]; r.bepu_dhw_kwh = n[10]; r.bepu_ext_kwh = n[11];
          r.bepu_total_kwh = n[12]; grabbed_kwh = true;
        }
      }
      if (s.startsWith("THERM") && !grabbed_therm) {
        const n = floats(s.replace("THERM", ""));
        if (n.length >= 13) { r.bepu_heat_therm = n[3]; r.bepu_dhw_therm = n[10]; r.bepu_total_therm = n[12]; grabbed_therm = true; }
      }
    }
  }

  _pse_fallback() {
    const r = this.r;
    if (r._has_beps) return;
    Object.assign(r, {
      ps_e_lights_kwh: 0, ps_e_misc_kwh: 0, ps_e_htg_kwh: 0, ps_e_clg_kwh: 0,
      ps_e_heat_reject_kwh: 0, ps_e_pumps_kwh: 0, ps_e_fans_kwh: 0, ps_e_dhw_kwh: 0,
      ps_e_ext_kwh: 0, ps_e_total_kwh: 0, ps_e_htg_mbtu: 0, ps_e_dhw_mbtu: 0, ps_e_total_mbtu: 0,
    });
    let in_e = false, in_f = false, sep_e = false, sep_f = false;
    for (const line of this.lines) {
      const cont = line.includes("CONTINUED");
      if (line.includes("REPORT- PS-E Energy End-Use Summary for all Electric")) { if (!cont) sep_e = false; in_e = true; in_f = false; continue; }
      if (line.includes("REPORT- PS-E Energy End-Use Summary for all Fuel")) { if (!cont) sep_f = false; in_f = true; in_e = false; continue; }
      if (/^REPORT-\s/.test(line) && !line.includes("PS-E")) { in_e = in_f = false; continue; }
      const s = line.trim();
      if (in_e) {
        if (s.includes("=======")) { sep_e = true; continue; }
        if (sep_e && s.startsWith("KWH")) {
          const n = floats(s.replace("KWH", ""));
          if (n.length >= 13) { r.ps_e_lights_kwh = n[0]; r.ps_e_misc_kwh = n[2]; r.ps_e_htg_kwh = n[3]; r.ps_e_clg_kwh = n[4]; r.ps_e_heat_reject_kwh = n[5]; r.ps_e_pumps_kwh = n[6]; r.ps_e_fans_kwh = n[7]; r.ps_e_dhw_kwh = n[10]; r.ps_e_ext_kwh = n[11]; r.ps_e_total_kwh = n[12]; }
          in_e = false;
        }
      }
      if (in_f) {
        if (s.includes("=======")) { sep_f = true; continue; }
        if (sep_f && s.startsWith("MBTU")) { const n = floats(s.replace("MBTU", "")); if (n.length >= 13) { r.ps_e_htg_mbtu = n[3]; r.ps_e_dhw_mbtu = n[10]; r.ps_e_total_mbtu = n[12]; } in_f = false; }
      }
    }
  }

  _ssr() {
    const r = this.r;
    r.unmet_heating_hrs = 0; r.unmet_cooling_hrs = 0;
    for (const line of this.lines) {
      let m = line.match(/HOURS ANY ZONE ABOVE COOLING THROTTLING RANGE\s+=\s+(\d+)/);
      if (m) r.unmet_cooling_hrs = parseInt(m[1], 10);
      m = line.match(/HOURS ANY ZONE BELOW HEATING THROTTLING RANGE\s+=\s+(\d+)/);
      if (m) r.unmet_heating_hrs = parseInt(m[1], 10);
    }
  }

  _ssa_peaks() {
    const r = this.r;
    r.peak_cooling_kbtuh = 0; r.peak_heating_kbtuh = 0;
    r.peak_cooling_time = ""; r.peak_heating_time = "";
    let in_block = false;
    let bestCoolMon = "", bestCoolDy = 0, bestCoolHr = 0, bestCoolVal = 0;
    let bestHeatMon = "", bestHeatDy = 0, bestHeatHr = 0, bestHeatVal = 0;
    let curCoolMax = 0, curHeatMax = 0;
    let curCoolMon = "", curCoolDy = 0, curCoolHr = 0;
    let curHeatMon = "", curHeatDy = 0, curHeatHr = 0;

    const flush = () => {
      r.peak_cooling_kbtuh += curCoolMax;
      r.peak_heating_kbtuh += Math.abs(curHeatMax);
      if (curCoolMax > bestCoolVal) { bestCoolVal = curCoolMax; bestCoolMon = curCoolMon; bestCoolDy = curCoolDy; bestCoolHr = curCoolHr; }
      if (Math.abs(curHeatMax) > bestHeatVal) { bestHeatVal = Math.abs(curHeatMax); bestHeatMon = curHeatMon; bestHeatDy = curHeatDy; bestHeatHr = curHeatHr; }
      curCoolMax = curHeatMax = 0;
    };

    for (const line of this.lines) {
      if (line.includes("REPORT- SS-A System Loads Summary")) {
        if (in_block) flush();
        in_block = true; curCoolMax = curHeatMax = 0;
        continue;
      }
      if (!in_block) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("SS-A System Loads")) { flush(); in_block = false; continue; }
      const s = line.trim();
      const mm = s.match(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(.+)$/);
      if (mm) {
        const n = floats(mm[2]);
        if (n.length >= 12) {
          const coolLoad = n[5], coolDy = Math.trunc(n[1]), coolHr = Math.trunc(n[2]);
          const heatLoad = n[11], heatDy = Math.trunc(n[7]), heatHr = Math.trunc(n[8]);
          if (coolLoad > curCoolMax) { curCoolMax = coolLoad; curCoolMon = mm[1]; curCoolDy = coolDy; curCoolHr = coolHr; }
          if (heatLoad < curHeatMax) { curHeatMax = heatLoad; curHeatMon = mm[1]; curHeatDy = heatDy; curHeatHr = heatHr; }
        }
        continue;
      }
    }
    if (in_block) flush();
    if (bestCoolMon) r.peak_cooling_time = `${bestCoolMon} ${String(bestCoolDy).padStart(2, "0")} ${String(bestCoolHr).padStart(2, "0")}:00`;
    if (bestHeatMon) r.peak_heating_time = `${bestHeatMon} ${String(bestHeatDy).padStart(2, "0")} ${String(bestHeatHr).padStart(2, "0")}:00`;

    r.peak_elec_kw = r.max_kw || 0;
    if (r.peak_elec_mon_day && r.peak_elec_mon_day.includes("/")) {
      const [mn, d] = r.peak_elec_mon_day.split("/").map((x: string) => parseInt(x, 10));
      const monName = MONTH_NAMES[mn] || "";
      r.peak_elec_time = monName ? `${monName} ${String(d).padStart(2, "0")} 13:00` : "";
    } else r.peak_elec_time = "";
  }

  _lvb() {
    const r = this.r;
    Object.assign(r, { total_area: 0, total_volume: 0, total_people: 0, conditioned_area: 0, conditioned_people: 0, lpd_sum: 0, epd_sum: 0, spaces: [] });
    for (const line of this.lines) {
      if (line.startsWith("BUILDING TOTALS")) {
        const n = floats(line.replace("BUILDING TOTALS", ""));
        if (n.length >= 3) { r.total_people = n[0]; r.total_area = n[1]; r.total_volume = n[2]; }
        else if (n.length === 2) { r.total_area = n[0]; r.total_volume = n[1]; }
        break;
      }
    }
    const sp_re = /^(.{1,50}?)\s{2,}([\d.]+)\s+(EXT|INT)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+\S+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/;
    for (const line of this.lines) {
      const m = line.match(sp_re);
      if (m) {
        const name = m[1].trim();
        const mult = parseFloat(m[2]), lights = parseFloat(m[5]), people = parseFloat(m[6]), equip = parseFloat(m[7]);
        const area = parseFloat(m[9]) * mult;
        const volume = parseFloat(m[10]) * mult;
        const isUncond = /unconditioned|plnm|plenum|spcplen|\bplen\b/i.test(name);
        const cond = lights > 0 && !isUncond;
        r.spaces.push({ name, mult, type: m[3], lights, people, equip, area, volume, conditioned: cond });
        if (cond) {
          r.conditioned_area += area;
          r.conditioned_people += people * mult;
          r.lpd_sum += lights * area;
          r.epd_sum += equip * area;
        }
      }
    }
    if (!r.total_area && r.spaces.length) r.total_area = r.spaces.reduce((a: number, s: any) => a + s.area, 0);
  }

  _lvd() {
    const r = this.r;
    const orient: Record<string, any> = {};
    const ORIENT_KEYS = ["NORTH-EAST", "NORTH-WEST", "SOUTH-EAST", "SOUTH-WEST", "NORTH", "EAST", "SOUTH", "WEST", "ROOF", "ALL WALLS", "WALLS+ROOFS", "UNDERGRND", "BUILDING"];
    let in_lvd = false;
    for (const line of this.lines) {
      if (line.includes("REPORT- LV-D")) { in_lvd = true; continue; }
      if (!in_lvd) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("LV-D")) { in_lvd = false; continue; }
      const s = line.trim();
      for (const key of ORIENT_KEYS) {
        if (s.startsWith(key + " ") || s === key) {
          const rest = s.slice(key.length);
          const n = floats(rest);
          if (n.length >= 6) {
            orient[key] = { uWin: n[0], uWall: n[1], uWW: n[2], winArea: n[3], wallArea: n[4], wwArea: n[5] };
          }
          break;
        }
      }
    }
    r._lvd = orient;
    const facadeMap: Record<string, string> = { NORTH: "north", "NORTH-EAST": "ne", EAST: "east", "SOUTH-EAST": "se", SOUTH: "south", "SOUTH-WEST": "sw", WEST: "west", "NORTH-WEST": "nw" };
    for (const [k, short] of Object.entries(facadeMap)) {
      if (orient[k]) {
        r[`${short}_wall_wwarea`] = orient[k].wwArea;
        r[`${short}_win_area`] = orient[k].winArea;
        r[`${short}_wall_area_net`] = orient[k].wallArea;
      }
    }
    r.above_ground_north_wall = orient["NORTH"] ? orient["NORTH"].wwArea : 0;
    r.above_ground_east_wall = orient["EAST"] ? orient["EAST"].wwArea : 0;
    r.above_ground_south_wall = orient["SOUTH"] ? orient["SOUTH"].wwArea : 0;
    r.above_ground_west_wall = orient["WEST"] ? orient["WEST"].wwArea : 0;
    if (orient["ALL WALLS"]) {
      r.total_window_area = orient["ALL WALLS"].winArea;
      r.total_wall_net_area = orient["ALL WALLS"].wallArea;
      r.gross_wall_area = orient["ALL WALLS"].wwArea;
      r.above_ground_wall_area = orient["ALL WALLS"].wwArea;
      r.wall_u_value = orient["ALL WALLS"].uWall;
      r.glass_u_value = orient["ALL WALLS"].uWin;
      r.vert_weighted_u = orient["ALL WALLS"].uWW;
      r.building_wwr = r.gross_wall_area > 0 ? (r.total_window_area / r.gross_wall_area * 100) : 0;
    }
    if (orient["ROOF"]) {
      r.gross_roof_area = orient["ROOF"].wwArea;
      r.roof_u_value = orient["ROOF"].uWall;
      r.skylight_area = orient["ROOF"].winArea;
      r.skylight_ratio = r.gross_roof_area > 0 ? (orient["ROOF"].winArea / r.gross_roof_area * 100) : 0;
    }
    if (orient["UNDERGRND"]) {
      r.lvd_slab_u = orient["UNDERGRND"].uWall;
      r.underground_area = orient["UNDERGRND"].wwArea;
    }
    for (const [k, short] of Object.entries(facadeMap)) {
      if (orient[k] && orient[k].wwArea > 0) {
        r[`${short}_wwr_actual`] = orient[k].winArea / orient[k].wwArea * 100;
      }
    }
  }

  _lve() {
    const r = this.r;
    let in_lve = false, area_w = 0, area_sum = 0;
    const re = /^\s+(\S.+?)\s+([\d.]+)\s+([\d.]+)\s+(\S.+?)\s+([\d.]+)\s*$/;
    for (const line of this.lines) {
      if (line.includes("REPORT- LV-E")) { in_lve = true; continue; }
      if (!in_lve) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("LV-E")) { in_lve = false; continue; }
      const m = line.match(re);
      if (m) {
        const mult = parseFloat(m[2]), area = parseFloat(m[3]) * mult, u = parseFloat(m[5]);
        if (area > 0) { area_w += u * area; area_sum += area; }
      }
    }
    r.slab_u_value = (r.lvd_slab_u != null && r.lvd_slab_u > 0) ? r.lvd_slab_u : (area_sum > 0 ? area_w / area_sum : 0);
    if (area_sum > 0) r.underground_area = area_sum;
  }

  _sva() {
    const r = this.r;
    Object.assign(r, {
      total_supply_cfm: 0, total_oa_cfm: 0, supply_fan_kw: 0, return_fan_kw: 0,
      cooling_eir_list: [], heating_eir_list: [],
    });
    let in_sva = false;
    for (const line of this.lines) {
      if (line.includes("REPORT- SV-A")) { in_sva = true; continue; }
      if (!in_sva) continue;
      if (/^REPORT-\s/.test(line) && !line.includes("SV-A")) { in_sva = false; continue; }
      const s = line.trim();
      const sysm = s.match(/^(VAVS?|PVAVS?|PSZ|SZRH|PTAC|PTHP|FPFC?|HVSYS|RESYS2?|DDS|MZS|PMZS|PIU|CBVAV|SUM|UHT|FC)\s+(.+)$/);
      if (sysm && !s.startsWith("SUPPLY") && !s.startsWith("RETURN")) {
        const n = floats(sysm[2]);
        if (n.length >= 9) {
          const ce = n[7], he = n[8];
          if (ce > 0) r.cooling_eir_list.push(1 / ce);
          if (he > 0) r.heating_eir_list.push(1 / he);
        }
        continue;
      }
      let m = s.match(/^SUPPLY\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      if (m) { r.total_supply_cfm += parseFloat(m[1]); r.supply_fan_kw += parseFloat(m[3]); continue; }
      m = s.match(/^RETURN\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      if (m) { r.return_fan_kw += parseFloat(m[3]); continue; }
      const zm = line.match(/^\s{2,}(\S.+?)\s+([\d.]+)\.\s+([\d.]+)\.\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\./);
      if (zm) r.total_oa_cfm += parseFloat(zm[6]);
    }
    r.dx_cooling_cop = r.cooling_eir_list.length ? r.cooling_eir_list.reduce((a: number, b: number) => a + b, 0) / r.cooling_eir_list.length : 0;
    r.dx_heating_cop = r.heating_eir_list.length ? r.heating_eir_list.reduce((a: number, b: number) => a + b, 0) / r.heating_eir_list.length : 0;
    r.total_fan_kw = r.supply_fan_kw + r.return_fan_kw;
    r.total_fan_kw_supply_only = r.supply_fan_kw;
  }

  _derived() {
    const r = this.r;
    if (r._has_beps) {
      r.int_lighting_kbtu = (r.beps_lights_mbtu || 0) * MBTU_TO_KBTU;
      r.int_equip_kbtu = (r.beps_misc_mbtu || 0) * MBTU_TO_KBTU;
      r.htg_elec_kbtu = (r.beps_heat_mbtu || 0) * MBTU_TO_KBTU;
      r.clg_elec_kbtu = (r.beps_cool_mbtu || 0) * MBTU_TO_KBTU;
      r.heat_reject_kbtu = (r.beps_reject_mbtu || 0) * MBTU_TO_KBTU;
      r.pumps_kbtu = (r.beps_pumps_mbtu || 0) * MBTU_TO_KBTU;
      r.fans_kbtu = (r.beps_fans_mbtu || 0) * MBTU_TO_KBTU;
      r.water_sys_elec_kbtu = (r.beps_dhw_mbtu || 0) * MBTU_TO_KBTU;
      r.ext_lighting_kbtu = (r.beps_ext_mbtu || 0) * MBTU_TO_KBTU;
      r.refrig_kbtu = (r.beps_refrig_mbtu || 0) * MBTU_TO_KBTU;
      r.electricity_kbtu = (r.kwh_annual || r.bepu_total_kwh || 0) * KWH_TO_KBTU;
      r.gas_kbtu = (r.therm_annual || r.bepu_total_therm || 0) * THERM_TO_KBTU;
      r.htg_gas_kbtu = (r.bepu_heat_therm || 0) * THERM_TO_KBTU;
      r.water_sys_gas_kbtu = (r.bepu_dhw_therm || 0) * THERM_TO_KBTU;
      r.total_energy_kbtu = r.beps_total_mbtu ? r.beps_total_mbtu * MBTU_TO_KBTU : (r.electricity_kbtu + r.gas_kbtu);
    } else {
      r.electricity_kbtu = (r.kwh_annual || 0) * KWH_TO_KBTU;
      r.gas_kbtu = (r.therm_annual || 0) * THERM_TO_KBTU;
      r.int_lighting_kbtu = (r.ps_e_lights_kwh || 0) * KWH_TO_KBTU;
      r.int_equip_kbtu = (r.ps_e_misc_kwh || 0) * KWH_TO_KBTU;
      r.htg_elec_kbtu = (r.ps_e_htg_kwh || 0) * KWH_TO_KBTU;
      r.clg_elec_kbtu = (r.ps_e_clg_kwh || 0) * KWH_TO_KBTU;
      r.heat_reject_kbtu = (r.ps_e_heat_reject_kwh || 0) * KWH_TO_KBTU;
      r.pumps_kbtu = (r.ps_e_pumps_kwh || 0) * KWH_TO_KBTU;
      r.fans_kbtu = (r.ps_e_fans_kwh || 0) * KWH_TO_KBTU;
      r.water_sys_elec_kbtu = (r.ps_e_dhw_kwh || 0) * KWH_TO_KBTU;
      r.ext_lighting_kbtu = (r.ps_e_ext_kwh || 0) * KWH_TO_KBTU;
      r.htg_gas_kbtu = (r.ps_e_htg_mbtu || 0) * MBTU_TO_KBTU;
      r.water_sys_gas_kbtu = (r.ps_e_dhw_mbtu || 0) * MBTU_TO_KBTU;
      r.refrig_kbtu = 0;
      r.total_energy_kbtu = r.electricity_kbtu + r.gas_kbtu;
    }

    const total_area = r.total_area || 0;
    let cond = r.conditioned_area || 0;
    if (cond === 0) cond = total_area;
    r.conditioned_floor_area = cond;
    r.total_floor_area = total_area;

    const denom = cond > 0 ? cond : (total_area > 0 ? total_area : 1);
    r.eui_kbtu_ft2 = r.beps_eui_net ? r.beps_eui_net : (r.total_energy_kbtu / denom);

    r.peak_elec_w = (r.peak_elec_kw || r.max_kw || 0) * 1000;
    r.peak_elec_w_per_ft2 = r.peak_elec_w / denom;
    r.peak_cooling_btuh_ft2 = (r.peak_cooling_kbtuh || 0) * 1000 / denom;
    r.peak_heating_btuh_ft2 = (r.peak_heating_kbtuh || 0) * 1000 / denom;

    r.lpd_w_ft2 = cond > 0 ? (r.lpd_sum || 0) / cond : 0;
    r.epd_w_ft2 = cond > 0 ? (r.epd_sum || 0) / cond : 0;
    r.lpd_total_w_ft2 = r.lpd_w_ft2;
    r.epd_total_w_ft2 = r.epd_w_ft2;

    r.occ_density_ft2_person = r.conditioned_people > 0 ? cond / r.conditioned_people : 0;
    r.cond_occ_density_ft2_person = r.conditioned_people > 0 ? cond / r.conditioned_people : 0;

    r.wall_r_value = r.wall_u_value > 0 ? 1 / r.wall_u_value : 0;
    r.vert_weighted_r = r.vert_weighted_u > 0 ? 1 / r.vert_weighted_u : 0;

    if (r.glass_shgc === undefined) r.glass_shgc = 0;
    if (r.glass_vlt === undefined) r.glass_vlt = 0;
    if (r.glass_lsg === undefined) r.glass_lsg = r.glass_shgc > 0 ? r.glass_vlt / r.glass_shgc : 0;

    r.vent_cfm_per_ft2 = denom > 0 ? r.total_supply_cfm / denom : 0;
    r.total_clg_cfm = r.total_supply_cfm;
    r.clg_cfm_per_ft2 = r.vent_cfm_per_ft2;
    r.total_htg_cfm = r.total_supply_cfm;
    r.htg_cfm_per_ft2 = r.vent_cfm_per_ft2;

    r.wall_to_floor_ratio = denom > 0 ? (r.gross_wall_area || 0) / denom : 0;
    r.roof_to_floor_ratio = denom > 0 ? (r.gross_roof_area || 0) / denom : 0;
    r.envelope_to_floor_ratio = r.wall_to_floor_ratio + r.roof_to_floor_ratio;

    r.dhw_efficiency = (r.therm_annual > 0 || r.bepu_dhw_therm > 0) ? 0.82 : 1.0;
    r.ext_lighting_kw = 0;
  }
}
