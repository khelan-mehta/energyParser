/* ============================================================
 *  Zero Tool (AIA 2030) baseline calculator client.
 *  POST {array of buildings} → median (benchmark) site EUI for a
 *  building type + location. Proxied through our server to dodge CORS
 *  (see server: POST /api/zerotool/baseline). No upstream auth needed.
 *  Docs: zerotool/ folder · https://github.com/Maalka/Benchmark
 * ============================================================ */
import { ZeroTool } from "../api";

/** Building-type enum accepted by the Zero Tool API (from zeroSchemaRequest.json). */
export const ZT_BUILDING_TYPES: string[] = [
  "AdultEducation", "College", "PreSchool", "VocationalSchool", "OtherEducation", "K12School",
  "ConventionCenter", "MovieTheater", "Museum", "PerformingArts",
  "BowlingAlley", "FitnessCenter", "IceRink", "RollerRink", "SwimmingPool", "OtherRecreation", "Stadium",
  "FinancialOffice", "Office", "MedicalOffice", "VeterinaryOffice", "Courthouse",
  "DistributionCenter", "WarehouseRefrigerated", "WarehouseUnRefrigerated", "SelfStorageFacility",
  "SpecialtyHospital", "Hospital", "OutpatientCenter", "PhysicalTherapyCenter", "SeniorCare",
  "UrgentCareCenter", "AmbulatorySurgicalCenter",
  "Barracks", "Hotel", "MultiFamily", "Prison", "ResidenceHall", "OtherResidentialLodging",
  "SingleFamilyDetached", "SingleFamilyAttached", "MobileHome",
  "MixedUseProperty", "OtherUtility", "StripMall", "Retail", "EnclosedMall",
  "PowerStation", "EnergyStation", "BankBranch", "IndoorArena", "RaceTrack", "Aquarium",
  "Bar", "Nightclub", "Casino", "OtherEntertainment",
  "ConvenienceStoreAndGas", "ConvenienceStore", "FastFoodRestaurant", "Restaurant",
  "Supermarket", "WholesaleClub", "FoodSales", "FoodService",
  "DrinkingWaterTreatment", "FireStation", "Library", "PostOffice", "PoliceStation", "MeetingHall",
  "TransportationTerminal", "WastewaterCenter", "OtherPublicServices", "WorshipCenter",
  "AutoDealership", "DataCenter", "PersonalServices", "RepairServices", "OtherServices", "Zoo", "Other",
];

/** Best-effort building type from the project's program type / LEED subcategory. */
export function guessBuildingType(programType?: string, leedSub?: string): string {
  const t = (programType || "").toLowerCase();
  const s = (leedSub || "").toLowerCase();
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, "");
  // exact-ish match of the program text against an enum value
  if (t.length > 3) {
    const hit = ZT_BUILDING_TYPES.find((b) => norm(b) === norm(t) || norm(b).includes(norm(t)));
    if (hit) return hit;
  }
  if (s.includes("school") || t.includes("school") || t.includes("k-12") || t.includes("k12")) return "K12School";
  if (s.includes("health") || t.includes("hospital") || t.includes("health")) return "Hospital";
  if (t.includes("office")) return "Office";
  if (t.includes("hotel") || t.includes("lodging")) return "Hotel";
  if (t.includes("retail") || t.includes("store") || t.includes("shop")) return "Retail";
  if (t.includes("warehouse")) return "WarehouseUnRefrigerated";
  if (t.includes("lab")) return "College";
  if (t.includes("residen") || t.includes("apartment") || t.includes("multi") || t.includes("dorm")) return "MultiFamily";
  if (t.includes("worship") || t.includes("church") || t.includes("temple")) return "WorshipCenter";
  if (t.includes("restaurant") || t.includes("dining")) return "Restaurant";
  if (t.includes("library")) return "Library";
  return "Office";
}

export interface ZeroToolParams {
  buildingType: string;
  gfa: number;            // gross floor area, ft²
  postalCode: string;
  state: string;          // 2-letter US/Canadian code
  country?: string;       // "USA" | "Canada" (default USA)
  targetPercent?: number | null; // percentBetterThanMedian (AIA 2030 target)
}

/** Build the single-building request array the Zero Tool API expects. */
function buildRequest(p: ZeroToolParams): any[] {
  return [{
    buildingType: p.buildingType,
    GFA: p.gfa,
    areaUnits: "ftSQ",
    country: p.country || "USA",
    postalCode: p.postalCode,
    state: p.state,
    reportingUnits: "us",
    defaultValues: true,
    percentBetterThanMedian: p.targetPercent ?? null,
  }];
}

/** Flatten the API's `values: [{...},{...}]` array of singletons into one object. */
function flatten(resp: any): Record<string, any> {
  const flat: Record<string, any> = {};
  for (const o of (resp?.values || [])) Object.assign(flat, o);
  return flat;
}

export interface BenchmarkResult {
  benchmarkEui: number;       // medianSiteEUI (kBtu/ft²) — the AIA 2030 benchmark
  medianSourceEui?: number;
  raw: Record<string, any>;
}

/** Call Zero Tool and return the median (benchmark) site EUI for the building. */
export async function calcBenchmarkEui(p: ZeroToolParams): Promise<BenchmarkResult> {
  if (!p.buildingType) throw new Error("pick a building type");
  if (!(p.gfa > 0)) throw new Error("set the gross conditioned floor area first");
  if (!p.postalCode) throw new Error("enter a pincode / ZIP first");
  if (!p.state) throw new Error("project state unknown — fetch rates from the pincode first");
  const resp = await ZeroTool.baseline(buildRequest(p));
  const flat = flatten(resp);
  const eui = flat.medianSiteEUI;
  if (typeof eui !== "number" || !isFinite(eui))
    throw new Error("Zero Tool returned no benchmark EUI — check the building type & location");
  return {
    benchmarkEui: +eui.toFixed(2),
    medianSourceEui: typeof flat.medianSourceEUI === "number" ? +flat.medianSourceEUI.toFixed(2) : undefined,
    raw: flat,
  };
}
