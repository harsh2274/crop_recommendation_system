// Soil, terrain and vegetation summaries, plus the RUSLE soil (K) and slope (LS) factors.
import type { NdviSeries, SoilProfile, SoilSummary, SoilTest, VegetationSummary } from "./types";
import { mean, median, round } from "./stats";

const DEFAULT_SOIL: Omit<SoilProfile, "source"> = { clayPct: 20, sandPct: 40, siltPct: 40, socPct: 1.45, ph: 6.5, awcMmPerM: null, drainageClass: null, hydrologicGroup: null };
const OM_PER_SOC = 1.724; // van Bemmelen factor
const ASSUMED_SLOPE_LENGTH_M = 50; // RUSLE lambda; field-specific value unknown
export const BARE_NDVI = 0.3;

// Plant-available water by USDA texture class (mm water per m of soil), typical values.
const AWC_MM_PER_M: Record<string, number> = {
  sand: 70, "loamy sand": 90, "sandy loam": 120, loam: 170, "silt loam": 200, silt: 200,
  "sandy clay loam": 150, "clay loam": 170, "silty clay loam": 180, "sandy clay": 130, "silty clay": 160, clay: 150,
};

export function usdaTexture(sand: number, silt: number, clay: number): string {
  if (silt + 1.5 * clay < 15) return "sand";
  if (silt + 2 * clay < 30) return "loamy sand";
  if ((clay >= 7 && clay < 20 && sand > 52) || (clay < 7 && silt < 50)) return "sandy loam";
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "loam";
  if (silt >= 80 && clay < 12) return "silt";
  if (silt >= 50 && clay < 27) return "silt loam";
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "sandy clay loam";
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "clay loam";
  if (clay >= 27 && clay < 40 && sand <= 20) return "silty clay loam";
  if (clay >= 35 && sand > 45) return "sandy clay";
  if (clay >= 40 && silt >= 40) return "silty clay";
  if (clay >= 40) return "clay";
  return "loam";
}

/** EPIC (Williams 1995) erodibility from texture and organic carbon, converted to SI units. */
export function erodibilityK(sand: number, silt: number, clay: number, socPct: number): number {
  const sn1 = 1 - sand / 100;
  const fcsand = 0.2 + 0.3 * Math.exp(-0.256 * sand * (1 - silt / 100));
  const fclsi = (silt / Math.max(1, clay + silt)) ** 0.3;
  const forgc = 1 - (0.25 * socPct) / (socPct + Math.exp(3.72 - 2.95 * socPct));
  const fhisand = 1 - (0.7 * sn1) / (sn1 + Math.exp(-5.51 + 22.9 * sn1));
  return 0.1317 * fcsand * fclsi * forgc * fhisand;
}

/** RUSLE LS factor (McCool et al.) for a slope in percent and an assumed slope length. */
export function slopeLengthFactor(slopePct: number): number {
  const theta = Math.atan(slopePct / 100);
  const sin = Math.sin(theta);
  const beta = sin / 0.0896 / (3 * sin ** 0.8 + 0.56);
  const m = beta / (1 + beta);
  const L = (ASSUMED_SLOPE_LENGTH_M / 22.13) ** m;
  const S = slopePct < 9 ? 10.8 * sin + 0.03 : 16.8 * sin - 0.5;
  return L * S;
}

/** Soil test values override the mapped soil (SSURGO in the US, SoilGrids elsewhere). */
export function summarizeSoil(mapped: SoilProfile | null, test: SoilTest | null): SoilSummary {
  const base = mapped ?? DEFAULT_SOIL;
  const hasTest = !!test && Object.values(test).some((v) => v !== undefined);
  const clay = test?.clayPct ?? base.clayPct;
  const sand = test?.sandPct ?? base.sandPct;
  const silt = test?.clayPct !== undefined || test?.sandPct !== undefined ? Math.max(0, 100 - clay - sand) : base.siltPct;
  const socPct = test?.organicMatterPct !== undefined ? test.organicMatterPct / OM_PER_SOC : base.socPct;
  const texture = usdaTexture(sand, silt, clay);
  const textureChanged = test?.clayPct !== undefined || test?.sandPct !== undefined;
  return {
    source: mapped ? (hasTest ? `${mapped.source}+soil_test` as SoilSummary["source"] : mapped.source) : hasTest ? "soil_test" : "default",
    clayPct: round(clay, 1),
    sandPct: round(sand, 1),
    siltPct: round(silt, 1),
    texture,
    organicMatterPct: round(socPct * OM_PER_SOC, 2),
    ph: round(test?.ph ?? base.ph, 1),
    availableWaterMmPerM: round(base.awcMmPerM !== null && !textureChanged ? base.awcMmPerM : AWC_MM_PER_M[texture]),
    erodibilityK: round(erodibilityK(sand, silt, clay, socPct), 4),
    drainageClass: base.drainageClass,
    hydrologicGroup: base.hydrologicGroup,
  };
}

export function summarizeVegetation(series: NdviSeries): VegetationSummary {
  const latest = new Date(series.dates[series.dates.length - 1]).getTime();
  const isRecent = (d: string) => latest - new Date(d).getTime() < 365 * 86_400_000;
  const month = (d: string) => Number(d.slice(5, 7));

  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  series.dates.forEach((d, i) => !isRecent(d) && byMonth[month(d) - 1].push(series.ndvi[i]));
  const monthly = byMonth.map((v) => (v.length ? round(median(v), 3) : null));

  const anomalies = series.dates.flatMap((d, i) => {
    const base = monthly[month(d) - 1];
    return isRecent(d) && base !== null ? [series.ndvi[i] - base] : [];
  });
  const valid = monthly.map((v, m) => [v, m + 1] as const).filter(([v]) => v !== null) as [number, number][];

  return {
    source: "MODIS MOD13Q1 v061 NDVI (ORNL DAAC)",
    years: new Set(series.dates.map((d) => d.slice(0, 4))).size,
    pixelsUsed: series.pixelsUsed,
    monthlyNdvi: monthly,
    bareMonths: valid.filter(([v]) => v < BARE_NDVI).map(([, m]) => m),
    peakMonth: valid.length ? valid.reduce((a, b) => (b[0] > a[0] ? b : a))[1] : null,
    latestSeasonAnomaly: anomalies.length ? round(mean(anomalies), 3) : null,
    observedSeason: observedSeason(series),
  };
}

/**
 * Median green-up and brown-down dates: when NDVI first rises above / last stays above the midpoint
 * between the year's minimum and peak. Used to check the simulated calendar against the real field.
 */
function observedSeason(series: NdviSeries): VegetationSummary["observedSeason"] {
  const byYear = new Map<string, { doy: number; v: number }[]>();
  series.dates.forEach((d, i) => {
    const doy = Math.round((Date.parse(d) - Date.parse(`${d.slice(0, 4)}-01-01`)) / 86_400_000);
    (byYear.get(d.slice(0, 4)) ?? byYear.set(d.slice(0, 4), []).get(d.slice(0, 4))!).push({ doy, v: series.ndvi[i] });
  });
  const ups: number[] = [];
  const downs: number[] = [];
  for (const pts of byYear.values()) {
    if (pts.length < 18) continue; // need a nearly complete year of 16-day composites
    const lo = Math.min(...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v));
    if (hi - lo < 0.2) continue; // no clear crop cycle
    const mid = (lo + hi) / 2;
    const above = pts.filter((p) => p.v >= mid);
    ups.push(above[0].doy);
    downs.push(above[above.length - 1].doy);
  }
  if (ups.length === 0) return null;
  const toDate = (doy: number) => new Date(Date.UTC(2001, 0, 1 + Math.round(doy))).toISOString().slice(5, 10);
  return { greenUp: toDate(median(ups)), brownDown: toDate(median(downs)) };
}
