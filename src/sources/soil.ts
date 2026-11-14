// Soil at the field centroid, 0-30 cm.
//   USDA SSURGO (US, survey-based, with drainage class and measured available water) via Soil Data Access;
//   ISRIC SoilGrids v2 (global 250 m model) everywhere else, or when SSURGO has no answer.
import type { SoilProfile } from "../types";
import { fetchJson, USER_AGENT } from "./http";

const TOP_CM = 30;

/** Rough CONUS + Alaska + Hawaii test: decides whether US-only datasets can answer. */
export const inUnitedStates = (lat: number, lon: number) =>
  (lat > 24 && lat < 50 && lon > -125 && lon < -66) || (lat > 51 && lat < 72 && lon > -170 && lon < -129) || (lat > 18 && lat < 23 && lon > -161 && lon < -154);

export async function fetchSoil(lat: number, lon: number): Promise<SoilProfile | null> {
  if (inUnitedStates(lat, lon)) {
    const ssurgo = await fetchSsurgo(lat, lon).catch(() => null);
    if (ssurgo) return ssurgo;
  }
  return fetchSoilGrids(lat, lon);
}

// ---------------------------------------------------------------- SSURGO

interface SdaResponse { Table?: (string | null)[][] }

async function fetchSsurgo(lat: number, lon: number): Promise<SoilProfile | null> {
  const point = `point(${lon.toFixed(6)} ${lat.toFixed(6)})`;
  const query =
    "SELECT c.comppct_r, c.drainagecl, c.hydgrp, ch.hzdept_r, ch.hzdepb_r, ch.sandtotal_r, ch.claytotal_r, ch.om_r, ch.ph1to1h2o_r, ch.awc_r " +
    "FROM mapunit mu INNER JOIN component c ON c.mukey = mu.mukey INNER JOIN chorizon ch ON ch.cokey = c.cokey " +
    `WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${point}')) ` +
    "AND c.majcompflag = 'Yes' ORDER BY c.comppct_r DESC, ch.hzdept_r";
  const res = await fetch("https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ format: "JSON+COLUMNNAME", query }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Soil Data Access HTTP ${res.status}`);
  const rows = ((await res.json()) as SdaResponse).Table;
  if (!rows || rows.length < 2) return null;
  const [header, ...data] = rows;
  const col = (name: string) => header.indexOf(name);
  const num = (r: (string | null)[], name: string) => (r[col(name)] === null ? NaN : Number(r[col(name)]));

  // Dominant component = first rows (sorted by comppct_r); thickness-weighted horizons within 0-30 cm.
  const pct = data[0][col("comppct_r")];
  const horizons = data.filter((r) => r[col("comppct_r")] === pct && num(r, "hzdept_r") < TOP_CM);
  const acc = { sand: 0, clay: 0, om: 0, ph: 0, awc: 0 };
  let w = 0;
  for (const h of horizons) {
    const thick = Math.min(TOP_CM, num(h, "hzdepb_r")) - num(h, "hzdept_r");
    const v = { sand: num(h, "sandtotal_r"), clay: num(h, "claytotal_r"), om: num(h, "om_r"), ph: num(h, "ph1to1h2o_r"), awc: num(h, "awc_r") };
    if (!(thick > 0) || Object.values(v).some((x) => !Number.isFinite(x))) continue;
    for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += v[k] * thick;
    w += thick;
  }
  if (w === 0) return null;
  const sand = acc.sand / w;
  const clay = acc.clay / w;
  return {
    source: "ssurgo",
    clayPct: clay,
    sandPct: sand,
    siltPct: Math.max(0, 100 - sand - clay),
    socPct: acc.om / w / 1.724,
    ph: acc.ph / w,
    awcMmPerM: (acc.awc / w) * 1000, // cm/cm -> mm/m
    drainageClass: data[0][col("drainagecl")],
    hydrologicGroup: data[0][col("hydgrp")],
  };
}

// ---------------------------------------------------------------- SoilGrids

const DEPTHS = ["0-5cm", "5-15cm", "15-30cm"];
const DEPTH_WEIGHTS = [5, 10, 15]; // cm thickness -> 0-30 cm weighted mean

interface SoilGridsResponse {
  properties: {
    layers: { name: string; unit_measure: { d_factor: number }; depths: { values: { mean: number | null } }[] }[];
  };
}

/** Returns null when SoilGrids has no data (urban, water) at the point. */
async function fetchSoilGrids(lat: number, lon: number): Promise<SoilProfile | null> {
  const url =
    `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}` +
    ["clay", "sand", "silt", "soc", "phh2o"].map((p) => `&property=${p}`).join("") +
    DEPTHS.map((d) => `&depth=${d}`).join("") +
    "&value=mean";
  const data = await fetchJson<SoilGridsResponse>(url);

  const value = (name: string): number | null => {
    const layer = data.properties.layers.find((l) => l.name === name);
    if (!layer) return null;
    let sum = 0, weight = 0;
    layer.depths.forEach((d, i) => {
      if (d.values.mean !== null) {
        sum += (d.values.mean / layer.unit_measure.d_factor) * DEPTH_WEIGHTS[i];
        weight += DEPTH_WEIGHTS[i];
      }
    });
    return weight > 0 ? sum / weight : null;
  };

  const clay = value("clay"), sand = value("sand"), silt = value("silt"), soc = value("soc"), ph = value("phh2o");
  if (clay === null || sand === null || silt === null || soc === null || ph === null) return null;
  // clay/sand/silt arrive in %, soc in g/kg -> %
  return { source: "soilgrids", clayPct: clay, sandPct: sand, siltPct: silt, socPct: soc / 10, ph, awcMmPerM: null, drainageClass: null, hydrologicGroup: null };
}
