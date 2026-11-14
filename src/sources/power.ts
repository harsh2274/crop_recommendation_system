// NASA POWER daily point API (no key). MERRA-2 meteorology + bias-corrected precipitation,
// ~0.5 x 0.625 degree grid: regional climate, not field-scale weather.
import type { DailyWeather } from "../types";
import { fetchJson } from "./http";

const PARAMS = {
  tmax: "T2M_MAX", tmin: "T2M_MIN", precip: "PRECTOTCORR", rh: "RH2M", rootZoneWetness: "GWETROOT",
  radiation: "ALLSKY_SFC_SW_DWN", wind: "WS2M",
} as const;

interface PowerResponse {
  geometry: { coordinates: [number, number, number?] };
  properties: { parameter: Record<string, Record<string, number>> };
}

export async function fetchPower(lat: number, lon: number, startYear: number, endYear: number): Promise<DailyWeather> {
  const url =
    "https://power.larc.nasa.gov/api/temporal/daily/point" +
    `?parameters=${Object.values(PARAMS).join(",")}&community=AG` +
    `&latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start=${startYear}0101&end=${endYear}1231&format=JSON`;
  const data = await fetchJson<PowerResponse>(url, 60_000);
  const p = data.properties.parameter;
  const dates = Object.keys(p[PARAMS.tmax]);
  const series = (name: string) => dates.map((d) => (p[name][d] <= -998 ? NaN : p[name][d])); // -999 = fill value
  return {
    dates,
    tmax: series(PARAMS.tmax),
    tmin: series(PARAMS.tmin),
    precip: series(PARAMS.precip),
    rh: series(PARAMS.rh),
    rootZoneWetness: series(PARAMS.rootZoneWetness),
    radiation: series(PARAMS.radiation),
    wind: series(PARAMS.wind),
    elevationM: data.geometry.coordinates[2] ?? null,
  };
}
