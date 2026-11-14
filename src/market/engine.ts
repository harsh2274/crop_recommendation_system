// Market engine: harvest-time price ranges, demand signals, gross revenue and the combined
// agronomic + market ranking. Pure computation over data loaded from D1 (loadMarketData).
//
// Forecast method (explainable, backtested): the crop's price in its harvest month over the last
// 10 years, adjusted to today's dollars with US CPI; P10/P50/P90 of those values form the range.
import { PRICE_SERIES } from "../sources/prices";
import type { CropSuitability, MarketCrop, MarketSection, PriceRange, Priorities, Region, RotationStrategy } from "../types";
import { mean, percentile, round } from "../stats";

const YEARS = 10; // history per forecast
const BACKTEST_YEARS = 5;
const SUPPLY_HISTORY = 20; // years of stocks-to-use to judge "usual"
const BUSHELS_PER_TONNE: Record<string, number> = { corn: 39.368, soybean: 36.744, winter_wheat: 36.744 }; // 56 / 60 / 60 lb bushels
const BASIS = "IMF world benchmark price (via DBnomics), adjusted with US CPI";

interface SupplyYear { production?: number; exports?: number; consumption?: number; endingStocks?: number; yieldTHa?: number }

export interface MarketData {
  prices: Map<string, Map<string, number>>; // cropId -> YYYY-MM -> nominal USD/t
  cpi: Map<string, number>; // YYYY-MM -> CPI
  supply: Map<string, Map<number, SupplyYear>>; // cropId -> market year -> attributes
  updated: string | null;
}

export async function loadMarketData(db: D1Database): Promise<MarketData | null> {
  const [prices, cpi, supply, log] = await db.batch([
    db.prepare("SELECT crop_id, month, usd_per_t FROM price_monthly"),
    db.prepare("SELECT month, cpi FROM cpi_monthly"),
    db.prepare("SELECT crop_id, market_year, attribute, value FROM supply_annual WHERE country = 'US'"),
    db.prepare("SELECT MAX(updated_at) AS updated FROM ingest_log"),
  ]);
  const data: MarketData = { prices: new Map(), cpi: new Map(), supply: new Map(), updated: (log.results[0] as { updated: string | null })?.updated ?? null };
  for (const r of prices.results as { crop_id: string; month: string; usd_per_t: number }[]) {
    (data.prices.get(r.crop_id) ?? data.prices.set(r.crop_id, new Map()).get(r.crop_id)!).set(r.month, r.usd_per_t);
  }
  for (const r of cpi.results as { month: string; cpi: number }[]) data.cpi.set(r.month, r.cpi);
  for (const r of supply.results as { crop_id: string; market_year: number; attribute: keyof SupplyYear; value: number }[]) {
    const byYear = data.supply.get(r.crop_id) ?? data.supply.set(r.crop_id, new Map()).get(r.crop_id)!;
    (byYear.get(r.market_year) ?? byYear.set(r.market_year, {}).get(r.market_year)!)[r.attribute] = r.value;
  }
  return data.prices.size && data.cpi.size ? data : null;
}

const range = (values: number[]): PriceRange => ({ p10: percentile(values, 0.1), p50: percentile(values, 0.5), p90: percentile(values, 0.9) });
const scale = (r: PriceRange, k: number): PriceRange => ({ p10: r.p10 * k, p50: r.p50 * k, p90: r.p90 * k });
const rounded = (r: PriceRange, digits = 0): PriceRange => ({ p10: round(r.p10, digits), p50: round(r.p50, digits), p90: round(r.p90, digits) });

/** Real (today's-dollar) price of a crop in a given month of each year, oldest first. */
function realSeries(data: MarketData, cropId: string, month: number): { year: number; value: number }[] {
  const prices = data.prices.get(cropId);
  if (!prices) return [];
  const latestCpi = data.cpi.get([...data.cpi.keys()].sort().at(-1)!)!;
  const mm = String(month).padStart(2, "0");
  const years = [...new Set([...prices.keys()].map((k) => Number(k.slice(0, 4))))].sort((a, b) => a - b);
  return years.flatMap((year) => {
    const key = `${year}-${mm}`;
    const p = prices.get(key);
    const c = data.cpi.get(key);
    return p !== undefined && c ? [{ year, value: (p * latestCpi) / c }] : [];
  });
}

/** Re-forecast each of the last years from the 10 before it: P10-P90 hit rate, and P50 error vs "same month last year". */
function backtest(series: { year: number; value: number }[]): MarketCrop["backtest"] {
  const hits: boolean[] = [], errors: number[] = [], naive: number[] = [];
  for (let i = Math.max(YEARS, series.length - BACKTEST_YEARS); i < series.length; i++) {
    const r = range(series.slice(i - YEARS, i).map((s) => s.value));
    const actual = series[i].value;
    hits.push(actual >= r.p10 && actual <= r.p90);
    errors.push(Math.abs(r.p50 - actual) / actual);
    naive.push(Math.abs(series[i - 1].value - actual) / actual);
  }
  return {
    years: hits.length,
    coverage: round(hits.filter(Boolean).length / Math.max(1, hits.length), 2),
    mapePct: round(100 * mean(errors), 1),
    naiveMapePct: round(100 * mean(naive), 1),
  };
}

/** The month whose 10-year median real price is highest, and its premium over the harvest-month median. */
function bestSellMonth(data: MarketData, cropId: string, harvestMonth: number, harvestP50: number): MarketCrop["bestSellMonth"] {
  let best: { month: number; p50: number } | null = null;
  for (let m = 1; m <= 12; m++) {
    const s = realSeries(data, cropId, m).slice(-YEARS);
    if (s.length < YEARS) continue;
    const p50 = percentile(s.map((x) => x.value), 0.5);
    if (!best || p50 > best.p50) best = { month: m, p50 };
  }
  if (!best || best.month === harvestMonth) return best ? { month: harvestMonth, usdPerTonneP50: round(harvestP50), premiumPct: 0 } : null;
  return { month: best.month, usdPerTonneP50: round(best.p50), premiumPct: round((100 * (best.p50 - harvestP50)) / harvestP50, 1) };
}

function demandSignals(data: MarketData, cropId: string): MarketCrop["demand"] {
  const byYear = data.supply.get(cropId);
  if (!byYear) return null;
  const stu = [...byYear.entries()].sort((a, b) => a[0] - b[0]).flatMap(([year, s]) =>
    s.endingStocks !== undefined && s.consumption !== undefined && s.exports !== undefined && s.consumption + s.exports > 0
      ? [{ year, stu: s.endingStocks / (s.consumption + s.exports), exports: s.exports }] : []);
  if (stu.length < 5) return null;
  const latest = stu[stu.length - 1];
  const history = stu.slice(-SUPPLY_HISTORY - 1, -1).map((s) => s.stu);
  const rank = history.filter((v) => v < latest.stu).length / Math.max(1, history.length);
  const exports = stu.slice(-10).map((s) => s.exports);
  const slope = trendSlope(exports) / Math.max(1, mean(exports)); // share of the mean per year
  return {
    marketYear: latest.year,
    stocksToUse: round(latest.stu, 3),
    stocksVsUsual: rank < 1 / 3 ? "lower" : rank > 2 / 3 ? "higher" : "normal",
    exportsTrend: slope > 0.01 ? "rising" : slope < -0.01 ? "falling" : "flat",
  };
}

function trendSlope(values: number[]): number {
  const xs = values.map((_, i) => i);
  const mx = mean(xs), my = mean(values);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return sxx ? xs.reduce((a, x, i) => a + (x - mx) * (values[i] - my), 0) / sxx : 0;
}

function medianYield(data: MarketData, cropId: string): number | null {
  const ys = [...(data.supply.get(cropId)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).flatMap(([, s]) => (s.yieldTHa ? [s.yieldTHa] : [])).slice(-5);
  return ys.length ? percentile(ys, 0.5) : null;
}

export interface MarketInput {
  cropSuitability: CropSuitability[];
  rotations: RotationStrategy[];
  priorities: Priorities;
  region: Region | null;
}

export function buildMarket(data: MarketData, input: MarketInput): MarketSection | null {
  const inUs = input.region?.countryIso3 === "USA";
  const candidates = input.cropSuitability.filter((c) => c.role !== "cover" && c.class !== "poor" && PRICE_SERIES[c.cropId] && c.harvestDate);
  const crops: MarketCrop[] = candidates.flatMap((c) => {
    const month = Number(c.harvestDate!.slice(0, 2));
    const series = realSeries(data, c.cropId, month);
    if (series.length < YEARS + 1) return [];
    const price = range(series.slice(-YEARS).map((s) => s.value));
    const yieldTHa = medianYield(data, c.cropId);
    return [{
      cropId: c.cropId,
      harvestMonth: month,
      price: {
        basis: BASIS,
        usdPerTonne: rounded(price),
        usdPerBushel: inUs && BUSHELS_PER_TONNE[c.cropId] ? rounded(scale(price, 1 / BUSHELS_PER_TONNE[c.cropId]), 2) : null,
        yearsUsed: YEARS,
      },
      backtest: backtest(series),
      bestSellMonth: bestSellMonth(data, c.cropId, month, price.p50),
      demand: demandSignals(data, c.cropId),
      yieldTHa: yieldTHa === null ? null : round(yieldTHa, 2),
      grossRevenuePerHa: yieldTHa === null ? null : rounded(scale(price, yieldTHa * c.seasonFitProbability)),
      bestMonthRevenuePerHa: null,
      marketScore: 0,
    }];
  });
  if (crops.length === 0) return null;
  const pricesThrough = [...data.prices.values()].flatMap((m) => [...m.keys()]).sort().at(-1)!;
  const dollarsOf = [...data.cpi.keys()].sort().at(-1)!;

  for (const m of crops) {
    if (m.grossRevenuePerHa && m.bestSellMonth) m.bestMonthRevenuePerHa = round((m.grossRevenuePerHa.p50 * m.bestSellMonth.usdPerTonneP50) / m.price.usdPerTonne.p50);
  }

  // Market score: expected revenue relative to the best candidate, lowered for wide (risky) price ranges.
  const best = Math.max(...crops.map((m) => m.grossRevenuePerHa?.p50 ?? 0));
  for (const m of crops) {
    const spread = (m.price.usdPerTonne.p90 - m.price.usdPerTonne.p10) / m.price.usdPerTonne.p50;
    m.marketScore = best > 0 && m.grossRevenuePerHa ? round(100 * (m.grossRevenuePerHa.p50 / best) * (1 - 0.3 * Math.min(1, spread))) : 0;
  }

  const incomeWeight = round(input.priorities.income / 10, 2); // income priority 0..5 -> 0..0.5
  const combine = (agronomic: number, market: number | null) => round(market === null ? agronomic : (1 - incomeWeight) * agronomic + incomeWeight * market);
  const ranking = crops
    .map((m) => {
      const agronomic = input.cropSuitability.find((c) => c.cropId === m.cropId)!.suitability;
      return { cropId: m.cropId, agronomic, market: m.marketScore, final: combine(agronomic, m.marketScore) };
    })
    .sort((a, b) => b.final - a.final);

  // Rotations: market part only when every main crop has market data (no silent partial averages).
  const revenue = new Map(crops.map((m) => [m.cropId, m.grossRevenuePerHa?.p50 ?? null]));
  const perRotation = input.rotations.map((r) => {
    const values = r.sequence.map((e) => revenue.get(e.crop) ?? null);
    return { rotationId: r.id, agronomic: r.scores.overall, revenue: values.every((v) => v !== null) ? mean(values as number[]) : null };
  });
  const bestRotation = Math.max(0, ...perRotation.map((r) => r.revenue ?? 0));
  const rotationRanking = perRotation
    .map((r) => {
      const market = r.revenue === null || bestRotation === 0 ? null : round((100 * r.revenue) / bestRotation);
      return { rotationId: r.rotationId, agronomic: r.agronomic, market, final: market === null ? null : combine(r.agronomic, market) };
    })
    .sort((a, b) => (b.final ?? -1) - (a.final ?? -1)); // unpriced rotations last, never mixed into the ranking

  const missing = candidates.filter((c) => !crops.some((m) => m.cropId === c.cropId)).map((c) => c.cropId);
  const noData = input.cropSuitability.filter((c) => c.role !== "cover" && c.class !== "poor" && !PRICE_SERIES[c.cropId]).map((c) => c.name);
  return {
    basis: `${BASIS} to ${dollarsOf} US dollars`,
    dataUpdated: data.updated,
    pricesThrough,
    dollarsOf,
    crops,
    ranking,
    rotationRanking,
    incomeWeight,
    notes: [
      `Price history through ${pricesThrough}, in ${dollarsOf} US dollars.`,
      "Prices are world benchmark prices; prices at your local buyer differ by transport, quality and season (basis).",
      "Revenue is before costs, using the US national yield and this field's season-fit probability.",
      ...(noData.length ? [`No market data yet for: ${noData.join(", ")}.`] : []),
      ...(missing.length ? [`Too little price history for: ${missing.join(", ")}.`] : []),
    ],
  };
}
