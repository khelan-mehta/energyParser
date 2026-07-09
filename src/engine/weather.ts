/* ============================================================
 *  Weather files — open-source EPW station lookup.
 *  Given a project's lat/lon (geocoded from its pincode), rank the
 *  nearest stations by great-circle distance so the user can pick the
 *  closest EPW/TMY weather file. The station list is a curated subset of
 *  the DOE/EnergyPlus (TMY3) US set; the download link points at the
 *  open Ladybug Tools EPW map, filtered to the chosen station.
 * ============================================================ */
export interface WeatherStation {
  name: string;   // "City, ST"
  state: string;  // 2-letter
  lat: number;
  lon: number;
  wmo?: string;   // WMO / USAF id where known (helps locate the EPW)
}

/* Curated US TMY3 stations (accurate coordinates). Not exhaustive — covers the
 * major metro of most states so a nearest-5 lookup is meaningful nationwide.
 * Expand freely; the ranking below is source-agnostic. */
export const US_WEATHER_STATIONS: WeatherStation[] = [
  { name: "Birmingham, AL", state: "AL", lat: 33.566, lon: -86.745, wmo: "722280" },
  { name: "Anchorage, AK", state: "AK", lat: 61.174, lon: -149.996, wmo: "702730" },
  { name: "Phoenix, AZ", state: "AZ", lat: 33.427, lon: -112.004, wmo: "722780" },
  { name: "Tucson, AZ", state: "AZ", lat: 32.131, lon: -110.955, wmo: "722740" },
  { name: "Little Rock, AR", state: "AR", lat: 34.727, lon: -92.239, wmo: "723403" },
  { name: "Los Angeles, CA", state: "CA", lat: 33.938, lon: -118.389, wmo: "722950" },
  { name: "San Francisco, CA", state: "CA", lat: 37.619, lon: -122.365, wmo: "724940" },
  { name: "Sacramento, CA", state: "CA", lat: 38.507, lon: -121.495, wmo: "724835" },
  { name: "San Diego, CA", state: "CA", lat: 32.734, lon: -117.183, wmo: "722900" },
  { name: "Fresno, CA", state: "CA", lat: 36.780, lon: -119.719, wmo: "723890" },
  { name: "Denver, CO", state: "CO", lat: 39.833, lon: -104.658, wmo: "725650" },
  { name: "Hartford, CT", state: "CT", lat: 41.938, lon: -72.683, wmo: "725080" },
  { name: "Wilmington, DE", state: "DE", lat: 39.673, lon: -75.601, wmo: "724089" },
  { name: "Miami, FL", state: "FL", lat: 25.788, lon: -80.317, wmo: "722020" },
  { name: "Orlando, FL", state: "FL", lat: 28.434, lon: -81.325, wmo: "722050" },
  { name: "Tampa, FL", state: "FL", lat: 27.962, lon: -82.540, wmo: "722110" },
  { name: "Jacksonville, FL", state: "FL", lat: 30.495, lon: -81.694, wmo: "722060" },
  { name: "Atlanta, GA", state: "GA", lat: 33.640, lon: -84.427, wmo: "722190" },
  { name: "Honolulu, HI", state: "HI", lat: 21.324, lon: -157.929, wmo: "911820" },
  { name: "Boise, ID", state: "ID", lat: 43.567, lon: -116.240, wmo: "726810" },
  { name: "Chicago, IL", state: "IL", lat: 41.995, lon: -87.934, wmo: "725300" },
  { name: "Indianapolis, IN", state: "IN", lat: 39.725, lon: -86.282, wmo: "724380" },
  { name: "Des Moines, IA", state: "IA", lat: 41.534, lon: -93.653, wmo: "725460" },
  { name: "Wichita, KS", state: "KS", lat: 37.650, lon: -97.433, wmo: "724500" },
  { name: "Louisville, KY", state: "KY", lat: 38.181, lon: -85.739, wmo: "724230" },
  { name: "New Orleans, LA", state: "LA", lat: 29.993, lon: -90.258, wmo: "722310" },
  { name: "Portland, ME", state: "ME", lat: 43.642, lon: -70.304, wmo: "726060" },
  { name: "Baltimore, MD", state: "MD", lat: 39.173, lon: -76.684, wmo: "724060" },
  { name: "Boston, MA", state: "MA", lat: 42.361, lon: -71.010, wmo: "725090" },
  { name: "Detroit, MI", state: "MI", lat: 42.231, lon: -83.331, wmo: "725370" },
  { name: "Minneapolis, MN", state: "MN", lat: 44.883, lon: -93.229, wmo: "726580" },
  { name: "Jackson, MS", state: "MS", lat: 32.319, lon: -90.078, wmo: "722350" },
  { name: "Kansas City, MO", state: "MO", lat: 39.297, lon: -94.731, wmo: "724460" },
  { name: "St. Louis, MO", state: "MO", lat: 38.753, lon: -90.374, wmo: "724340" },
  { name: "Billings, MT", state: "MT", lat: 45.807, lon: -108.543, wmo: "726770" },
  { name: "Omaha, NE", state: "NE", lat: 41.310, lon: -95.899, wmo: "725500" },
  { name: "Las Vegas, NV", state: "NV", lat: 36.080, lon: -115.163, wmo: "723860" },
  { name: "Reno, NV", state: "NV", lat: 39.484, lon: -119.771, wmo: "724880" },
  { name: "Manchester, NH", state: "NH", lat: 42.933, lon: -71.436, wmo: "743945" },
  { name: "Newark, NJ", state: "NJ", lat: 40.723, lon: -74.169, wmo: "725020" },
  { name: "Albuquerque, NM", state: "NM", lat: 35.040, lon: -106.609, wmo: "723650" },
  { name: "New York, NY", state: "NY", lat: 40.779, lon: -73.969, wmo: "725033" },
  { name: "Buffalo, NY", state: "NY", lat: 42.941, lon: -78.736, wmo: "725280" },
  { name: "Syracuse, NY", state: "NY", lat: 43.111, lon: -76.104, wmo: "725190" },
  { name: "Albany, NY", state: "NY", lat: 42.743, lon: -73.809, wmo: "725180" },
  { name: "Charlotte, NC", state: "NC", lat: 35.214, lon: -80.943, wmo: "723140" },
  { name: "Raleigh, NC", state: "NC", lat: 35.892, lon: -78.782, wmo: "723060" },
  { name: "Bismarck, ND", state: "ND", lat: 46.773, lon: -100.760, wmo: "727640" },
  { name: "Columbus, OH", state: "OH", lat: 39.996, lon: -82.883, wmo: "724280" },
  { name: "Cleveland, OH", state: "OH", lat: 41.405, lon: -81.852, wmo: "725240" },
  { name: "Cincinnati, OH", state: "OH", lat: 39.104, lon: -84.419, wmo: "724210" },
  { name: "Oklahoma City, OK", state: "OK", lat: 35.389, lon: -97.601, wmo: "723540" },
  { name: "Portland, OR", state: "OR", lat: 45.591, lon: -122.600, wmo: "726980" },
  { name: "Philadelphia, PA", state: "PA", lat: 39.868, lon: -75.231, wmo: "724080" },
  { name: "Pittsburgh, PA", state: "PA", lat: 40.500, lon: -80.213, wmo: "725200" },
  { name: "Providence, RI", state: "RI", lat: 41.722, lon: -71.432, wmo: "725070" },
  { name: "Columbia, SC", state: "SC", lat: 33.942, lon: -81.118, wmo: "723100" },
  { name: "Sioux Falls, SD", state: "SD", lat: 43.581, lon: -96.742, wmo: "726510" },
  { name: "Nashville, TN", state: "TN", lat: 36.119, lon: -86.689, wmo: "723270" },
  { name: "Memphis, TN", state: "TN", lat: 35.056, lon: -89.987, wmo: "723340" },
  { name: "Houston, TX", state: "TX", lat: 29.980, lon: -95.360, wmo: "722430" },
  { name: "Dallas, TX", state: "TX", lat: 32.898, lon: -97.019, wmo: "722590" },
  { name: "Austin, TX", state: "TX", lat: 30.183, lon: -97.680, wmo: "722540" },
  { name: "San Antonio, TX", state: "TX", lat: 29.533, lon: -98.470, wmo: "722530" },
  { name: "Salt Lake City, UT", state: "UT", lat: 40.778, lon: -111.969, wmo: "725720" },
  { name: "Burlington, VT", state: "VT", lat: 44.468, lon: -73.150, wmo: "726170" },
  { name: "Richmond, VA", state: "VA", lat: 37.505, lon: -77.320, wmo: "724010" },
  { name: "Norfolk, VA", state: "VA", lat: 36.904, lon: -76.192, wmo: "723080" },
  { name: "Seattle, WA", state: "WA", lat: 47.445, lon: -122.314, wmo: "727930" },
  { name: "Spokane, WA", state: "WA", lat: 47.622, lon: -117.528, wmo: "727850" },
  { name: "Charleston, WV", state: "WV", lat: 38.379, lon: -81.590, wmo: "724140" },
  { name: "Milwaukee, WI", state: "WI", lat: 42.955, lon: -87.904, wmo: "726400" },
  { name: "Madison, WI", state: "WI", lat: 43.141, lon: -89.345, wmo: "726410" },
  { name: "Cheyenne, WY", state: "WY", lat: 41.156, lon: -104.812, wmo: "725640" },
  { name: "Washington, DC", state: "DC", lat: 38.848, lon: -77.034, wmo: "724050" },
];

/** Great-circle distance between two lat/lon points, in statute miles. */
export function haversineMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.7613; // Earth radius (mi)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface NearbyStation { station: WeatherStation; miles: number; }

/** The `n` closest weather stations to a point, nearest first. */
export function nearestStations(lat: number, lon: number, n = 5): NearbyStation[] {
  return US_WEATHER_STATIONS
    .map((station) => ({ station, miles: haversineMiles(lat, lon, station.lat, station.lon) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, n);
}

/** Open EPW map, centred on the station, so the user can download the file. */
export function epwMapUrl(s: WeatherStation): string {
  return `https://www.ladybug.tools/epwmap/#${s.lat},${s.lon},10z`;
}
