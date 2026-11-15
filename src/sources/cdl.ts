// USDA NASS Cropland Data Layer (US, 30 m, yearly): what was actually grown on the field.
// CropScape's GetCDLValue takes US Albers (EPSG:5070) coordinates.
import proj4 from "proj4";
import { repeatingCycle } from "../rotation";
import type { FieldHistoryYear } from "../types";
import { fetchText } from "./http";

const ALBERS = "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs";
const HISTORY_YEARS = 8;

// CDL class -> catalog crop id (other classes keep cropId null)
const CDL_TO_CROP: Record<number, string> = {
  1: "corn", 2: "cotton", 3: "rice", 4: "sorghum", 5: "soybean", 6: "sunflower", 21: "barley", 24: "winter_wheat", 27: "cereal_rye",
  28: "oats", 31: "canola", 36: "alfalfa", 42: "dry_bean", 43: "potato", 53: "field_pea",
};

export async function fetchFieldHistory(lat: number, lon: number, endYear: number): Promise<FieldHistoryYear[]> {
  const [x, y] = proj4("EPSG:4326", ALBERS, [lon, lat]).map(Math.round);
  const years = Array.from({ length: HISTORY_YEARS }, (_, i) => endYear - HISTORY_YEARS + 1 + i);
  const results = await Promise.allSettled(
    years.map(async (year) => {
      const xml = await fetchText(`https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLValue?year=${year}&x=${x}&y=${y}`, 25_000, 0);
      const m = xml.match(/value:\s*(\d+),\s*category:\s*"([^"]*)"/);
      if (!m) throw new Error(`no CDL value for ${year}`);
      const code = Number(m[1]);
      return { year, code, category: m[2], cropId: CDL_TO_CROP[code] ?? null };
    }),
  );
  const history = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (history.length === 0) throw new Error("CropScape returned no years");
  return history.sort((a, b) => a.year - b.year);
}

/** Smallest repeating crop cycle in the most recent years, e.g. corn,soy,corn,soy -> [corn, soybean]. */
export function inferRotation(history: FieldHistoryYear[]): string[] {
  return repeatingCycle(history.map((h) => h.cropId).filter((c): c is string => c !== null));
}
