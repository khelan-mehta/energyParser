/* ============================================================
 *  Weather files — real EPW lookup from the DOE / EnergyPlus master
 *  index (github: NREL/EnergyPlus/weather/master.geojson). Each entry
 *  carries the actual weather-file name, its type (TMY / TMY3 / IWEC /
 *  CWEC …), coordinates, and the .epw download URL. Given a project's
 *  lat/lon we rank the nearest files by great-circle distance.
 * ============================================================ */
export interface WeatherFile {
  name: string;    // full file name, e.g. "USA_NY_Syracuse-Hancock.Intl.AP.725190_TMY3.epw"
  title: string;   // name without the .epw extension
  type: string;    // "TMY3" | "TMY" | "IWEC" | "CWEC" | … (suffix of the title)
  lat: number;
  lon: number;
  epwUrl: string;  // direct .epw download URL (may be "")
  zipUrl: string;  // bundle of all files (.epw/.ddy/.stat/.mos) as a .zip (may be "")
  miles: number;   // distance to the query point (filled by nearestWeatherFiles)
}

const MASTER_URL = "https://raw.githubusercontent.com/NREL/EnergyPlus/develop/weather/master.geojson";

type Station = Omit<WeatherFile, "miles">;
let CACHE: Station[] | null = null;
let CACHE_PROMISE: Promise<Station[]> | null = null;

/** Fetch + parse the DOE master index once, cached for the session. */
function loadStations(): Promise<Station[]> {
  if (CACHE) return Promise.resolve(CACHE);
  if (!CACHE_PROMISE) {
    CACHE_PROMISE = fetch(MASTER_URL)
      .then((r) => { if (!r.ok) throw new Error(`weather index ${r.status}`); return r.json(); })
      .then((g: any) => {
        const feats: any[] = g?.features || [];
        CACHE = feats.map((f) => {
          const title: string = f?.properties?.title || "";
          const coords: number[] = f?.geometry?.coordinates || [];
          const type = (title.split("_").pop() || "").toUpperCase();
          const href = (prop: string) => String(f?.properties?.[prop] || "").match(/href=([^\s>]+)/i)?.[1] || "";
          return { title, name: title ? title + ".epw" : "", type, lon: +coords[0], lat: +coords[1], epwUrl: href("epw"), zipUrl: href("all") };
        }).filter((s) => s.title && isFinite(s.lat) && isFinite(s.lon));
        return CACHE!;
      })
      .catch((e) => { CACHE_PROMISE = null; throw e; }); // allow a retry after failure
  }
  return CACHE_PROMISE;
}

/** Great-circle distance between two lat/lon points, in statute miles. */
export function haversineMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.7613; // Earth radius (mi)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The `n` closest real weather files to a point, nearest first. */
export async function nearestWeatherFiles(lat: number, lon: number, n = 5): Promise<WeatherFile[]> {
  const stations = await loadStations();
  return stations
    .map((s) => ({ ...s, miles: haversineMiles(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, n);
}

/** Map link that actually drops a pin at the station's coordinates. */
export function mapUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}
