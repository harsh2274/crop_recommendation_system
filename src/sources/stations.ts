// Nearest NOAA GHCN-Daily weather station (NCEI Access APIs, no key, global). Used to correct the
// ~50 km NASA POWER grid toward local temperatures; frost dates are very sensitive to this.
import type { StationRecord } from "../types";
import { fetchJson } from "./http";

const SEARCH_RADIUS_DEG = 0.45; // ~50 km
const OVERLAP_YEARS = 10;

interface SearchResponse {
  results?: { location?: { coordinates: [number, number] }; stations?: { id: string; name?: string }[]; name?: string; endDate?: string }[];
}
type DailyRow = { DATE: string; TMAX?: string; TMIN?: string };

export async function fetchStation(lat: number, lon: number, endYear: number): Promise<StationRecord | null> {
  const r = SEARCH_RADIUS_DEG;
  const startYear = endYear - OVERLAP_YEARS + 1;
  const search = await fetchJson<SearchResponse>(
    "https://www.ncei.noaa.gov/access/services/search/v1/data?dataset=daily-summaries&dataTypes=TMIN,TMAX&limit=25" +
      `&bbox=${(lat + r).toFixed(3)},${(lon - r).toFixed(3)},${(lat - r).toFixed(3)},${(lon + r).toFixed(3)}` +
      `&startDate=${startYear}-01-01&endDate=${endYear}-12-31`,
  );
  const best = (search.results ?? [])
    .filter((s) => s.location && s.stations?.[0]?.id && (s.endDate ?? "") >= `${endYear}`)
    .map((s) => ({ id: s.stations![0].id, name: s.stations![0].name ?? s.name ?? s.stations![0].id, km: distanceKm(lat, lon, s.location!.coordinates[1], s.location!.coordinates[0]) }))
    .sort((a, b) => a.km - b.km)[0];
  if (!best) return null;

  const rows = await fetchJson<DailyRow[]>(
    `https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=${best.id}` +
      `&startDate=${startYear}-01-01&endDate=${endYear}-12-31&dataTypes=TMAX,TMIN&format=json&units=metric`,
    40_000,
  );
  const valid = rows.filter((x) => x.TMAX && x.TMIN && Number.isFinite(Number(x.TMAX)) && Number.isFinite(Number(x.TMIN)));
  if (valid.length < 365 * 3) return null; // too little overlap to estimate monthly biases
  return {
    id: best.id,
    name: best.name,
    distanceKm: Math.round(best.km),
    dates: valid.map((x) => x.DATE),
    tmax: valid.map((x) => Number(x.TMAX)),
    tmin: valid.map((x) => Number(x.TMIN)),
  };
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
