// Daily NASA POWER weather -> per-season-year arrays (used by the crop simulation) and the climate
// summary in the output.
//   1. Station correction: monthly Tmax/Tmin offsets from the nearest NOAA GHCN station.
//   2. Season years: 365 days (Feb 29 dropped) starting Jan 1 (north) or Jul 1 (south), so day-of-
//      season-year d indexes the same point of the growing calendar everywhere.
//   3. Current-climate baseline: with a significant warming trend, earlier years are shifted to
//      the latest year's temperature level.
//   4. FAO-56 Penman-Monteith reference ET0 from temperature, humidity, wind and solar radiation.
import type { ClimateSummary, DailyWeather, MonthlyClimate, StationRecord, Trend } from "./types";
import { mean, median, percentile, round } from "./stats";

export interface YearSeries {
  year: number; // calendar year in which the season year starts
  tmax: number[];
  tmin: number[];
  tmean: number[];
  precip: number[];
  et0: number[];
  rh: number[];
  wetness: number[];
}

export interface ClimateData {
  years: YearSeries[];
  yearStart: number; // calendar DOY (0-based) of season-year day 0
  monthOf: number[]; // month (1..12) of each season-year day
  date: (d: number) => string; // season-year day -> MM-DD
  climTmean: number[]; // 365-day smoothed multi-year mean
  lastSpringFrost: (number | null)[]; // season-year day per year
  firstFallFrost: (number | null)[];
  erosivityByDoy: number[]; // share of annual erosivity per season-year day, sums to 1
  summary: ClimateSummary;
}

export const DAYS = 365;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CAL_MONTH: number[] = MONTH_LENGTHS.flatMap((len, m) => Array(len).fill(m + 1));
const MID_YEAR = 181; // splits spring and fall frosts within a season year
const SOUTH_START = 181; // Jul 1

export const HEAVY_RAIN_MM = 25;
export const EXTREME_HEAT_C = 35;
const EROSIVE_RAIN_MM = 12.7;
const MAX_STATION_OFFSET_C = 5;

export function doyToDate(calendarDoy: number): string {
  const d = new Date(Date.UTC(2001, 0, 1 + (((Math.round(calendarDoy) % DAYS) + DAYS) % DAYS)));
  return d.toISOString().slice(5, 10);
}

/** Growing degree days, both temperatures clamped to [base, 30 degC]. */
export function gdd(tmax: number, tmin: number, base: number, cap = 30): number {
  const clamp = (t: number) => Math.min(cap, Math.max(base, t));
  return (clamp(tmax) + clamp(tmin)) / 2 - base;
}

/** FAO-56 extraterrestrial radiation Ra (MJ m-2 day-1), calendar doy 1-based. */
function extraterrestrialRadiation(latDeg: number, doy: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  return ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

/** FAO-56 Penman-Monteith reference evapotranspiration (mm/day), daily step, G = 0. */
export function et0PenmanMonteith(tmax: number, tmin: number, rh: number, wind: number, rs: number, ra: number, elevationM: number): number {
  const t = (tmax + tmin) / 2;
  const sat = (x: number) => 0.6108 * Math.exp((17.27 * x) / (x + 237.3));
  const es = (sat(tmax) + sat(tmin)) / 2;
  const ea = es * Math.min(100, Math.max(0, rh)) / 100;
  const delta = (4098 * sat(t)) / (t + 237.3) ** 2;
  const gamma = 0.000665 * 101.3 * ((293 - 0.0065 * elevationM) / 293) ** 5.26;
  const rso = (0.75 + 2e-5 * elevationM) * ra;
  const rnl = 4.903e-9 * (((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2) * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * Math.min(1, rs / Math.max(rso, 0.1)) - 0.35);
  const rn = 0.77 * rs - rnl;
  const et0 = (0.408 * delta * rn + gamma * (900 / (t + 273)) * wind * (es - ea)) / (delta + gamma * (1 + 0.34 * wind));
  return Math.max(0, et0);
}

function forwardFill(values: number[], fallback: number): number[] {
  let last = fallback;
  return values.map((v) => (Number.isFinite(v) ? (last = v) : last));
}

/** Monthly mean (station - POWER) Tmax/Tmin over the days both have. */
function stationOffsets(weather: DailyWeather, tmax: number[], tmin: number[], station: StationRecord) {
  const idx = new Map(weather.dates.map((d, i) => [d, i]));
  const sums = Array.from({ length: 12 }, () => ({ dx: 0, dn: 0, n: 0 }));
  station.dates.forEach((date, k) => {
    const i = idx.get(date.replace(/-/g, ""));
    if (i === undefined) return;
    const s = sums[Number(date.slice(5, 7)) - 1];
    s.dx += station.tmax[k] - tmax[i];
    s.dn += station.tmin[k] - tmin[i];
    s.n++;
  });
  if (sums.some((s) => s.n < 30)) return null; // need roughly a month of overlap in every month
  const clip = (v: number) => Math.max(-MAX_STATION_OFFSET_C, Math.min(MAX_STATION_OFFSET_C, v));
  return { tmax: sums.map((s) => round(clip(s.dx / s.n), 2)), tmin: sums.map((s) => round(clip(s.dn / s.n), 2)) };
}

export function buildClimate(weather: DailyWeather, lat: number, elevationM: number, station: StationRecord | null): ClimateData {
  const yearStart = lat < 0 ? SOUTH_START : 0;
  let tmaxAll = forwardFill(weather.tmax, 15);
  let tminAll = forwardFill(weather.tmin, 5);
  const precipAll = weather.precip.map((v) => (Number.isFinite(v) ? v : 0));
  const rhAll = forwardFill(weather.rh, 70);
  const wetAll = forwardFill(weather.rootZoneWetness, 0.5);
  const radAll = forwardFill(weather.radiation, 15);
  const windAll = forwardFill(weather.wind, 2);

  // 1. station correction
  const offsets = station ? stationOffsets(weather, tmaxAll, tminAll, station) : null;
  if (offsets) {
    const month = weather.dates.map((d) => Number(d.slice(4, 6)) - 1);
    tmaxAll = tmaxAll.map((t, i) => t + offsets.tmax[month[i]]);
    tminAll = tminAll.map((t, i) => t + offsets.tmin[month[i]]);
  }

  // 2. season years
  const buckets = new Map<number, number[]>();
  const calDoy: number[] = [];
  weather.dates.forEach((d, i) => {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(4, 6));
    const day = Number(d.slice(6, 8));
    if (m === 2 && day === 29) return;
    const doy = MONTH_LENGTHS.slice(0, m - 1).reduce((a, b) => a + b, 0) + day - 1;
    calDoy[i] = doy;
    const seasonYear = doy >= yearStart ? y : y - 1;
    (buckets.get(seasonYear) ?? buckets.set(seasonYear, []).get(seasonYear)!).push(i);
  });
  const full = [...buckets.entries()].filter(([, idx]) => idx.length === DAYS).sort((a, b) => a[0] - b[0]);
  if (full.length < 5) throw new Error(`Only ${full.length} complete years of POWER data; need at least 5.`);

  // 3. current-climate baseline
  const rawTmean = full.map(([, idx]) => mean(idx.map((i) => (tmaxAll[i] + tminAll[i]) / 2)));
  const warming = trend(rawTmean);
  const perYear = warming.significant && warming.perDecade > 0 ? warming.perDecade / 10 : 0;
  const lastYear = full[full.length - 1][0];

  const ra = Array.from({ length: DAYS }, (_, d) => extraterrestrialRadiation(lat, d + 1));
  const years: YearSeries[] = full.map(([year, idx]) => {
    const shift = perYear * (lastYear - year);
    const tmax = idx.map((i) => tmaxAll[i] + shift);
    const tmin = idx.map((i) => tminAll[i] + shift);
    return {
      year,
      tmax,
      tmin,
      tmean: tmax.map((t, d) => (t + tmin[d]) / 2),
      precip: idx.map((i) => precipAll[i]),
      et0: idx.map((i, d) => et0PenmanMonteith(tmax[d], tmin[d], rhAll[i], windAll[i], radAll[i], ra[calDoy[i]], elevationM)),
      rh: idx.map((i) => rhAll[i]),
      wetness: idx.map((i) => wetAll[i]),
    };
  });

  const monthOf = Array.from({ length: DAYS }, (_, d) => CAL_MONTH[(d + yearStart) % DAYS]);
  const date = (d: number) => doyToDate(d + yearStart);

  const lastSpringFrost = years.map((y) => {
    for (let d = MID_YEAR; d >= 0; d--) if (y.tmin[d] <= 0) return d;
    return null;
  });
  const firstFallFrost = years.map((y) => {
    for (let d = MID_YEAR + 1; d < DAYS; d++) if (y.tmin[d] <= 0) return d;
    return null;
  });

  const climTmean = smoothCircular(Array.from({ length: DAYS }, (_, d) => mean(years.map((y) => y.tmean[d]))), 15);
  const monthly = monthlyClimate(years, monthOf);
  const monthDays = (m: number) => MONTH_LENGTHS[m - 1];
  const erosivityByDoy = monthOf.map((m) => monthly[m - 1].erosivityShare / monthDays(m));

  const baseline: ClimateSummary["baseline"] = {
    hemisphere: lat < 0 ? "south" : "north",
    stationCorrection: offsets && station
      ? { stationId: station.id, name: station.name, distanceKm: station.distanceKm, overlapYears: round(station.dates.length / 365, 1), tmaxOffsetC: offsets.tmax, tminOffsetC: offsets.tmin }
      : null,
    warmingAdjustmentCPerDecade: perYear ? round(perYear * 10, 2) : null,
  };

  return {
    years, yearStart, monthOf, date, climTmean, lastSpringFrost, firstFallFrost, erosivityByDoy,
    summary: summarize(years, monthly, lastSpringFrost, firstFallFrost, date, baseline, rawTmean),
  };
}

function smoothCircular(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += values[(i + k + values.length) % values.length];
    return sum / (2 * half + 1);
  });
}

function monthlyClimate(years: YearSeries[], monthOf: number[]): MonthlyClimate[] {
  const erosivity = Array(12).fill(0);
  const rows = Array.from({ length: 12 }, (_, m) => {
    const days = monthOf.flatMap((month, d) => (month === m + 1 ? [d] : []));
    const perYear = years.map((y) => {
      const sum = (arr: number[]) => days.reduce((a, d) => a + arr[d], 0);
      const count = (pred: (d: number) => boolean) => days.filter(pred).length;
      erosivity[m] += days.reduce((a, d) => a + (y.precip[d] >= EROSIVE_RAIN_MM ? y.precip[d] ** 2 : 0), 0);
      return {
        tmean: sum(y.tmean) / days.length,
        tmax: sum(y.tmax) / days.length,
        tmin: sum(y.tmin) / days.length,
        precip: sum(y.precip),
        et0: sum(y.et0),
        wet: sum(y.wetness) / days.length,
        frost: count((d) => y.tmin[d] <= 0),
        heat: count((d) => y.tmax[d] >= EXTREME_HEAT_C),
        heavy: count((d) => y.precip[d] >= HEAVY_RAIN_MM),
        disease: count((d) => y.rh[d] >= 85 && y.tmean[d] >= 15 && y.tmean[d] <= 30),
      };
    });
    const avg = (k: keyof (typeof perYear)[number]) => mean(perYear.map((p) => p[k]));
    return {
      month: m + 1,
      tmeanC: round(avg("tmean"), 1),
      tmaxC: round(avg("tmax"), 1),
      tminC: round(avg("tmin"), 1),
      precipMm: round(avg("precip"), 0),
      et0Mm: round(avg("et0"), 0),
      waterBalanceMm: round(avg("precip") - avg("et0"), 0),
      rootZoneWetness: round(avg("wet"), 2),
      frostDays: round(avg("frost"), 1),
      extremeHeatDays: round(avg("heat"), 1),
      heavyRainDays: round(avg("heavy"), 1),
      diseaseRiskDays: round(avg("disease"), 1),
      erosivityShare: 0,
    };
  });
  const total = erosivity.reduce((a, b) => a + b, 0) || 1;
  rows.forEach((r, m) => (r.erosivityShare = round(erosivity[m] / total, 3)));
  return rows;
}

/** Renard & Freimund (1994) annual rainfall erosivity from annual precipitation. */
function rainfallErosivity(precipMm: number): number {
  return precipMm <= 850 ? 0.0483 * precipMm ** 1.61 : 587.8 - 1.219 * precipMm + 0.004105 * precipMm ** 2;
}

function trend(values: number[]): Trend {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const mx = mean(xs), my = mean(values);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (values[i] - my), 0) / sxx;
  const resid = values.reduce((a, v, i) => a + (v - (my + slope * (xs[i] - mx))) ** 2, 0);
  const se = Math.sqrt(resid / Math.max(1, n - 2) / sxx);
  return { perDecade: round(slope * 10, 3), significant: se > 0 ? Math.abs(slope / se) >= 2 : false };
}

function summarize(
  years: YearSeries[],
  monthly: MonthlyClimate[],
  lastSpring: (number | null)[],
  firstFall: (number | null)[],
  date: (d: number) => string,
  baseline: ClimateSummary["baseline"],
  rawTmean: number[],
): ClimateSummary {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const annualPrecip = years.map((y) => sum(y.precip));
  const annualEt0 = years.map((y) => sum(y.et0));
  const annualWet = years.map((y) => mean(y.wetness));
  const precipMm = mean(annualPrecip);

  // A year without spring frost counts as "earliest", without fall frost as "latest".
  const frostFree = lastSpring.filter((d) => d === null).length > years.length / 2;
  const spring = lastSpring.map((d) => d ?? -1);
  const fall = firstFall.map((d) => d ?? DAYS);
  const asDate = (d: number) => (frostFree || d < 0 || d >= DAYS ? null : date(d));

  const wetDays = years.flatMap((y) => y.precip.filter((p) => p >= 1));
  const max5 = years.map((y) => Math.max(...y.precip.map((_, d) => sum(y.precip.slice(d, d + 5)))));
  // longest dry spell in the warm half of the season year (Apr-Sep north, Oct-Mar south)
  const drySpell = years.map((y) => {
    let best = 0, run = 0;
    for (let d = 90; d < 273; d++) {
      run = y.precip[d] < 1 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  });

  const last = years.length - 1;
  const priorPrecip = annualPrecip.slice(0, last);
  const priorWet = annualWet.slice(0, last);
  const sdWet = Math.sqrt(mean(priorWet.map((w) => (w - mean(priorWet)) ** 2))) || 1;

  return {
    period: { startYear: years[0].year, endYear: years[last].year, years: years.length },
    baseline,
    annual: {
      tmeanC: round(mean(years.map((y) => mean(y.tmean))), 1),
      precipMm: round(precipMm, 0),
      et0Mm: round(mean(annualEt0), 0),
      aridityIndex: round(precipMm / mean(annualEt0), 2),
      gddBase10: round(mean(years.map((y) => sum(y.tmax.map((t, d) => gdd(t, y.tmin[d], 10))))), 0),
      rainfallErosivity: round(rainfallErosivity(precipMm), 0),
    },
    frost: {
      lastSpringMedian: asDate(median(spring)),
      lastSpring90: asDate(percentile(spring, 0.9)),
      firstFallMedian: asDate(median(fall)),
      firstFall10: asDate(percentile(fall, 0.1)),
      frostFreeDaysMedian: round(median(fall.map((f, i) => f - spring[i] - 1)), 0),
    },
    extremes: {
      wetDayP95Mm: round(percentile(wetDays, 0.95), 1),
      max5DayPrecipMm: round(median(max5), 0),
      longestDrySpellDays: round(median(drySpell), 0),
    },
    recentYear: {
      year: years[last].year,
      precipAnomalyPct: round((100 * (annualPrecip[last] - mean(priorPrecip))) / mean(priorPrecip), 0),
      rootZoneWetnessZ: round((annualWet[last] - mean(priorWet)) / sdWet, 2),
    },
    trends: {
      tmeanC: trend(rawTmean), // the observed trend, before the baseline adjustment
      precipMm: trend(annualPrecip),
      heavyRainDays: trend(years.map((y) => y.precip.filter((p) => p >= HEAVY_RAIN_MM).length)),
      extremeHeatDays: trend(years.map((y) => y.tmax.filter((t) => t >= EXTREME_HEAT_C).length)),
      rootZoneWetness: trend(annualWet),
    },
    monthly,
  };
}
