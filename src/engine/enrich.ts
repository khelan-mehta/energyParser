/* ============================================================
 *  ROW ENRICHMENT — fold rate/carbon/water/source config into a row
 * ============================================================ */
import type { Row } from "./sim";
import { round1 } from "./columns";
import {
  RateConfig, cambiumTouFactor, GAS_CARBON_KG_PER_THERM,
} from "./rates";

const KWH_TO_KBTU = 3.412, THERM_TO_KBTU = 100;

export function enrichRow(data: Row, cfg: RateConfig): Row {
  const elec_kbtu = data.electricity_kbtu || 0, gas_kbtu = data.gas_kbtu || 0;
  const cond_area = data.conditioned_floor_area || data.total_floor_area || 1;

  /* ---- RATES: model (flat) → manual/suggested → 0 ---- */
  let elec_rate_per_kbtu = 0, gas_rate_per_kbtu = 0;
  let rate_source = "", rate_structure = "";
  if (data.inp_elec_rate_per_kbtu != null && data.inp_elec_rate_per_kbtu > 0) {
    elec_rate_per_kbtu = data.inp_elec_rate_per_kbtu;
    rate_structure = data.inp_rate_structure || "flat (model)";
    rate_source = `Energy model UTILITY-RATE (${data.inp_rate_is_flat ? "flat" : rate_structure})`;
  } else if (cfg.elec_per_kwh != null) {
    elec_rate_per_kbtu = cfg.elec_per_kwh / KWH_TO_KBTU;
    rate_structure = cfg.rate_structure || "manual";
    rate_source = cfg.rate_source || "Manually entered";
  }
  if (data.inp_gas_rate_per_kbtu != null && data.inp_gas_rate_per_kbtu > 0) {
    gas_rate_per_kbtu = data.inp_gas_rate_per_kbtu;
  } else if (cfg.gas_per_therm != null) {
    gas_rate_per_kbtu = cfg.gas_per_therm / THERM_TO_KBTU;
  }

  const computed_cost = elec_kbtu * elec_rate_per_kbtu + gas_kbtu * gas_rate_per_kbtu
    + (data.district_cooling_kbtu || 0) * (cfg.dc_rate_per_kbtu || 0)
    + (data.district_heating_kbtu || 0) * (cfg.dh_rate_per_kbtu || 0);
  // Prefer the model's reported total energy cost (e.g. TRACE Table EAp2-7) when present;
  // otherwise fall back to energy × virtual rate.
  const total_cost = (typeof data.model_total_cost === "number" && data.model_total_cost > 0) ? data.model_total_cost : computed_cost;
  const cost_intensity = cond_area > 0 ? total_cost / cond_area : 0;

  /* ---- CARBON: eGRID | Cambium-TOU | manual ---- */
  let elec_carbon_per_kbtu = 0, gas_carbon_per_kbtu = 0, carbon_method = cfg.carbon_method, carbon_source = "";
  if (cfg.carbon_method === "cambium-tou" && cfg.state) {
    const { factor, effMult } = cambiumTouFactor(cfg.state, cfg.tou_profile);
    elec_carbon_per_kbtu = factor / KWH_TO_KBTU;
    carbon_source = `NREL Cambium 2023 TOU (${cfg.state}, ${cfg.tou_profile} profile, ×${effMult.toFixed(2)} of annual avg)`;
  } else if (cfg.carbon_method === "manual" && cfg.elec_carbon_per_kwh != null) {
    elec_carbon_per_kbtu = cfg.elec_carbon_per_kwh / KWH_TO_KBTU;
    carbon_source = cfg.carbon_source || "Manually entered";
  } else if (cfg.elec_carbon_per_kwh != null) {
    elec_carbon_per_kbtu = cfg.elec_carbon_per_kwh / KWH_TO_KBTU;
    carbon_method = "egrid";
    carbon_source = cfg.carbon_source || "EPA eGRID2022 state factor";
  }
  const gasCarbonTherm = cfg.gas_carbon_per_therm != null ? cfg.gas_carbon_per_therm : GAS_CARBON_KG_PER_THERM;
  gas_carbon_per_kbtu = gasCarbonTherm / THERM_TO_KBTU;

  const total_carbon = elec_kbtu * elec_carbon_per_kbtu + gas_kbtu * gas_carbon_per_kbtu
    + (data.district_cooling_kbtu || 0) * (cfg.dc_carbon_per_kbtu || 0)
    + (data.district_heating_kbtu || 0) * (cfg.dh_carbon_per_kbtu || 0);
  const carbon_intensity = cond_area > 0 ? total_carbon / cond_area : 0;

  /* ---- WATER ---- */
  const water_rate_per_kgal = cfg.water_per_kgal != null ? cfg.water_per_kgal : 0;
  const total_water_kgal = data.total_water_kgal || 0;
  const total_water_cost = total_water_kgal * water_rate_per_kgal;
  const water_use_intensity = cond_area > 0 ? total_water_kgal / cond_area : 0;

  /* ---- GLASS ---- */
  const glass_shgc = (data.inp_glass_shgc != null ? data.inp_glass_shgc : (data.glass_shgc || 0));
  const glass_u = (data.glass_u_value || data.inp_glass_u || 0);
  let glass_vlt = (data.inp_glass_vlt != null ? data.inp_glass_vlt : (data.glass_vlt || 0));
  if (!glass_vlt && glass_u > 0) glass_vlt = cfg.default_vlt != null ? cfg.default_vlt : 0.9;
  const glass_lsg = glass_shgc > 0 ? glass_vlt / glass_shgc : 0;

  /* ---- ENVELOPE U-VALUES + area-weighted assemblies ---- */
  const wall_u = data.wall_u_value || 0, roof_u = data.roof_u_value || 0;
  const slab_u = data.slab_u_value || 0, exposed_floor_u = data.exposed_floor_u_value || 0;
  const wall_area = data.gross_wall_area || data.above_ground_wall_area || 0;
  const win_area = data.total_window_area || 0;
  const roof_area = data.gross_roof_area || 0;
  const opaque_wall = Math.max(wall_area - win_area, 0);
  // Vertical-weighted U = (opaque wall·U + window·U) ÷ gross wall area. Honor a parser-
  // supplied value first (SIM provides one from LV-D); else derive it.
  let vert_weighted_u = data.vert_weighted_u || 0;
  if (!vert_weighted_u && wall_u > 0 && wall_area > 0) vert_weighted_u = (opaque_wall * wall_u + win_area * glass_u) / wall_area;
  const vert_weighted_r = vert_weighted_u > 0 ? 1 / vert_weighted_u : 0;
  // Assembly U = area-weighted opaque wall + roof.
  let assembly_u_value = data.assembly_u_value || 0;
  if (!assembly_u_value && wall_u > 0 && roof_u > 0 && (opaque_wall + roof_area) > 0)
    assembly_u_value = (opaque_wall * wall_u + roof_area * roof_u) / (opaque_wall + roof_area);

  const chiller_cop = data.inp_chiller_cop || 0;
  const boiler_cop = data.inp_boiler_cop || 0;

  const extra: Row = {
    total_cost, cost_intensity,
    elec_rate_per_kbtu, gas_rate_per_kbtu, rate_structure, rate_source,
    add_fuel_rate_per_kbtu: 0, dc_rate_per_kbtu: cfg.dc_rate_per_kbtu || 0, dh_rate_per_kbtu: cfg.dh_rate_per_kbtu || 0,
    total_carbon_kg: total_carbon, carbon_intensity, carbon_method, carbon_source,
    elec_carbon_rate: elec_carbon_per_kbtu, gas_carbon_rate: gas_carbon_per_kbtu,
    add_fuel_carbon_rate: 0, dc_carbon_rate: cfg.dc_carbon_per_kbtu || 0, dh_carbon_rate: cfg.dh_carbon_per_kbtu || 0,
    water_rate_per_kgal, total_water_cost, water_use_intensity,
    location_name: cfg.location_name || "",
    additional_fuel_kbtu: 0, district_cooling_kbtu: data.district_cooling_kbtu || 0, district_heating_kbtu: data.district_heating_kbtu || 0,
    htg_add_fuel_kbtu: 0, htg_dist_htg_kbtu: 0, clg_dist_kbtu: 0,
    int_equip_gas_kbtu: 0, int_equip_add_kbtu: 0, ext_equip_kbtu: 0,
    humid_elec_kbtu: 0, heat_recov_kbtu: 0, water_sys_add_kbtu: 0, water_sys_dist_kbtu: 0,
    gen_kbtu: 0, misc1_kbtu: 0, misc2_kbtu: 0,
    hr_water_kgal: 0, humid_water_kgal: 0, ws_water_kgal: 0,
    north_wwr_nominal: round1(data.north_wwr_actual || 0), east_wwr_nominal: round1(data.east_wwr_actual || 0),
    south_wwr_nominal: round1(data.south_wwr_actual || 0), west_wwr_nominal: round1(data.west_wwr_actual || 0),
    glass_shgc, glass_vlt, glass_u_value: glass_u, glass_lsg,
    wall_u_value: wall_u, roof_u_value: roof_u, slab_u_value: slab_u, exposed_floor_u_value: exposed_floor_u,
    vert_weighted_u, vert_weighted_r, assembly_u_value,
    chiller_cop, boiler_cop, hp_cooling_cop: 0, hp_heating_cop: 0,
    north_shading_type: data.inp_north_shading_type || "None", north_shading_ratio: round1(data.inp_north_shading_ratio || 0),
    west_shading_type: data.inp_west_shading_type || "None", west_shading_ratio: round1(data.inp_west_shading_ratio || 0),
    south_shading_type: data.inp_south_shading_type || "None", south_shading_ratio: round1(data.inp_south_shading_ratio || 0),
    east_shading_type: data.inp_east_shading_type || "None", east_shading_ratio: round1(data.inp_east_shading_ratio || 0),
    wall2_u_value: data.wall2_u_value || 0,
    infil_cfm_ft2: data.infil_cfm_ft2 || 0, total_pump_kw: data.total_pump_kw || 0,
  };

  const merged: Row = { ...extra, ...data };
  for (const k of [
    "total_cost", "cost_intensity", "elec_rate_per_kbtu", "gas_rate_per_kbtu", "rate_structure", "rate_source",
    "total_carbon_kg", "carbon_intensity", "elec_carbon_rate", "gas_carbon_rate", "carbon_method", "carbon_source",
    "dc_carbon_rate", "dh_carbon_rate", "dc_rate_per_kbtu", "dh_rate_per_kbtu",
    "water_rate_per_kgal", "total_water_cost", "water_use_intensity", "location_name",
    "glass_shgc", "glass_vlt", "glass_u_value", "glass_lsg", "chiller_cop", "boiler_cop",
    "assembly_u_value", "vert_weighted_u", "vert_weighted_r",
    "north_wwr_nominal", "east_wwr_nominal", "south_wwr_nominal", "west_wwr_nominal",
  ]) {
    merged[k] = extra[k];
  }
  return merged;
}
