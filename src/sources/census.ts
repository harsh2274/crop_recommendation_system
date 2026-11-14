// US Census Bureau geocoder (no key): state and county for a point in the United States.
import type { Region } from "../types";
import { fetchJson } from "./http";

interface CensusResponse {
  result?: { geographies?: Record<string, { NAME?: string; STUSAB?: string; STATE?: string; COUNTY?: string }[]> };
}

export async function fetchRegion(lat: number, lon: number): Promise<Region | null> {
  const data = await fetchJson<CensusResponse>(
    "https://geocoding.geo.census.gov/geocoder/geographies/coordinates" +
      `?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties,States&format=json`,
  );
  const g = data.result?.geographies ?? {};
  const state = g["States"]?.[0];
  if (!state?.NAME) return null; // outside the US
  const county = g["Counties"]?.[0];
  return {
    country: "United States",
    countryIso3: "USA",
    admin1: state.NAME,
    admin1Code: state.STUSAB ?? null,
    county: county?.NAME ?? null,
    countyFips: county?.STATE && county?.COUNTY ? county.STATE + county.COUNTY : null,
  };
}
