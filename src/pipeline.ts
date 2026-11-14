// The black box: request JSON in -> a stream of output sections -> one final `result`.
// All upstream fetches start at once (and can be started early with `prefetch`); sections are
// yielded as soon as their inputs exist.
import { buildClimate, type ClimateData } from "./climate";
import { CROPS, getCrop, type Crop } from "./crops";
import { areaHa, bbox, centroid } from "./geo";
import { assessHazards } from "./hazards";
import { parseRequest } from "./input";
import { slopeLengthFactor, summarizeSoil, summarizeVegetation } from "./land";
import { pestCalendar } from "./pests";
import { annotate, buildStrategies, type RotationContext } from "./rotation";
import { simulateAll, suitability, type SeasonStats } from "./simulate";
import { buildMarket, loadMarketData } from "./market/engine";
import { fetchRegion } from "./sources/census";
import { fetchFieldHistory, inferRotation } from "./sources/cdl";
import { fetchTerrain } from "./sources/elevation";
import { fetchNaturalEvents } from "./sources/eonet";
import { fetchNdvi } from "./sources/modis";
import { fetchPower } from "./sources/power";
import { fetchSoil, inUnitedStates } from "./sources/soil";
import { fetchStation } from "./sources/stations";
import type {
  CropSuitability, DataSourceReport, FieldHistoryYear, FieldRequest, NaturalEvent, NdviSeries, PipelineOutput,
  Region, RotationEntry, RotationStrategy, SoilProfile, StationRecord, Terrain, VegetationSummary,
} from "./types";
import { round } from "./stats";

export interface PipelineDeps {
  kv?: KVNamespace; // cache for upstream responses
  opentopoKey?: string; // enables SRTM slope and low-spot detection
  today?: Date; // injectable for tests
  waitUntil?: (p: Promise<unknown>) => void; // lets a slow fetch finish (and fill the cache) after we stop waiting
  db?: D1Database; // market data (prices, CPI, USDA PSD), loaded by the scheduled ingestion
}

/** Every event's `data` is exactly the matching part of the final PipelineOutput. */
export type PipelineEvent =
  | { event: "field"; data: Pick<PipelineOutput, "field" | "context"> }
  | { event: "soil"; data: PipelineOutput["soil"] }
  | { event: "climate"; data: PipelineOutput["climate"] }
  | { event: "terrain"; data: { elevationM: number | null; slopePct: number | null; lowSpotSharePct: number | null } }
  | { event: "cropSuitability"; data: PipelineOutput["cropSuitability"] }
  | { event: "fieldHistory"; data: PipelineOutput["fieldHistory"] }
  | { event: "vegetation"; data: PipelineOutput["vegetation"] }
  | { event: "hazards"; data: PipelineOutput["hazards"] }
  | { event: "pestCalendar"; data: PipelineOutput["pestCalendar"] }
  | { event: "rotations"; data: Pick<PipelineOutput, "rotations" | "recommendation"> }
  | { event: "market"; data: PipelineOutput["market"] }
  | { event: "result"; data: PipelineOutput };

const CLIMATE_YEARS = 20;
const NDVI_YEARS = 3;
const DEFAULT_SLOPE_PCT = 2;
const DAY_S = 86_400;
const SLOW_WAIT_MS = 40_000; // optional sources never block the stream longer than this
const ROBUSTNESS_RUNS = 8; // re-runs with crop parameters perturbed by up to +/-20%

const DISCLAIMER =
  "Decision support only. Results come from satellite, reanalysis and survey data and generic crop parameters; " +
  "they highlight patterns and options but do not replace farmer judgment, a soil test or local agronomic advice.";

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: String(e?.message ?? e) }));

function withTimeout<T>(p: Promise<Settled<T>>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<Settled<T>>((r) => (timer = setTimeout(() => r({ ok: false, error: "timed out; the fetch finishes in the background and is cached" }), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function cached<T>(kv: KVNamespace | undefined, key: string, ttlS: number, load: () => Promise<T>): Promise<T> {
  const hit = kv ? await kv.get<T>(key, "json").catch(() => null) : null;
  if (hit !== null) return hit;
  const value = await load();
  if (kv && value !== null) await kv.put(key, JSON.stringify(value), { expirationTtl: ttlS }).catch(() => {});
  return value;
}

/** Start every upstream request for a field. Shared by the pipeline and `prefetch`. */
function startFetches(req: FieldRequest, deps: PipelineDeps, today: Date) {
  const c = centroid(req.polygons);
  const box = bbox(req.polygons);
  const endYear = today.getUTCFullYear() - 1;
  const loc = `${c.lat.toFixed(3)}:${c.lon.toFixed(3)}`;
  const boxKey = box.map((v) => v.toFixed(4)).join(":");
  const us = inUnitedStates(c.lat, c.lon);
  const job = <T>(key: string, ttlDays: number, load: () => Promise<T>) => {
    const p = settle(cached(deps.kv, key, ttlDays * DAY_S, load));
    deps.waitUntil?.(p);
    return p;
  };
  return {
    center: c, box, endYear, us,
    power: job(`power:v2:${loc}:${endYear}`, 30, () => fetchPower(c.lat, c.lon, endYear - CLIMATE_YEARS + 1, endYear)),
    soil: job<SoilProfile | null>(`soil:v2:${loc}`, 90, () => fetchSoil(c.lat, c.lon)),
    station: job<StationRecord | null>(`station:v1:${loc}:${endYear}`, 30, () => fetchStation(c.lat, c.lon, endYear)),
    ndvi: job<NdviSeries>(`ndvi:v2:${boxKey}:${today.toISOString().slice(0, 7)}`, 7, () => fetchNdvi(req.polygons, c, box, today.getUTCFullYear() - NDVI_YEARS, today)),
    terrain: deps.opentopoKey
      ? job<Terrain>(`srtm:v2:${boxKey}`, 365, () => fetchTerrain(req.polygons, box, deps.opentopoKey!))
      : Promise.resolve<Settled<Terrain>>({ ok: false, error: "OPENTOPO_API_KEY not configured" }),
    history: us
      ? job<FieldHistoryYear[]>(`cdl:v1:${loc}:${endYear}`, 90, () => fetchFieldHistory(c.lat, c.lon, endYear))
      : Promise.resolve<Settled<FieldHistoryYear[]>>({ ok: false, error: "USDA Cropland Data Layer covers the US only" }),
    region: us
      ? job<Region | null>(`region:v1:${loc}`, 365, () => fetchRegion(c.lat, c.lon))
      : Promise.resolve<Settled<Region | null>>({ ok: true, value: null }),
    events: job<NaturalEvent[]>(`eonet:v1:${loc}:${today.toISOString().slice(0, 10)}`, 1, () => fetchNaturalEvents(c.lat, c.lon)),
  };
}

/** Warm the cache for a field (e.g. as soon as the farmer draws it), without computing anything. */
export async function prefetch(body: unknown, deps: PipelineDeps = {}): Promise<void> {
  const f = startFetches(parseRequest(body), deps, deps.today ?? new Date());
  await Promise.allSettled([f.power, f.soil, f.station, f.ndvi, f.terrain, f.history, f.events]);
}

export async function* runPipeline(body: unknown, deps: PipelineDeps = {}): AsyncGenerator<PipelineEvent> {
  const today = deps.today ?? new Date();
  const req = parseRequest(body); // throws InputError -> 400
  const f = startFetches(req, deps, today);
  const ndviStart = today.getUTCFullYear() - NDVI_YEARS;

  const field: PipelineOutput["field"] = {
    fieldId: req.fieldId,
    centroid: { lat: round(f.center.lat, 5), lon: round(f.center.lon, 5) },
    areaHa: round(areaHa(req.polygons), 2),
    bbox: f.box.map((v) => round(v, 6)) as PipelineOutput["field"]["bbox"],
    elevationM: null,
    slopePct: null,
    lowSpotSharePct: null,
    region: null,
    sourceCrs: req.sourceCrs,
  };
  const context: PipelineOutput["context"] = {
    farmer: req.farmer,
    priorities: req.priorities,
    constraints: req.constraints,
    currentRotation: req.currentRotation,
    rotationSource: "farmer",
    currentSeason: req.currentSeason,
    observedIssues: req.observedIssues,
    farmerOutcomes: req.farmerOutcomes,
    unresolvedCrops: req.unresolvedCrops,
  };
  yield { event: "field", data: { field, context } };

  // ---- soil (SSURGO in the US, SoilGrids elsewhere; a soil test overrides)
  const soilRes = await withTimeout(f.soil, SLOW_WAIT_MS);
  const soil = summarizeSoil(soilRes.ok ? soilRes.value : null, req.soilTest);
  yield { event: "soil", data: soil };

  // ---- climate (required): POWER, corrected to the nearest NOAA station when one is close
  const powerRes = await f.power;
  if (!powerRes.ok) throw new Error(`NASA POWER unavailable: ${powerRes.error}`);
  const stationRes = await withTimeout(f.station, SLOW_WAIT_MS);
  const climate: ClimateData = buildClimate(powerRes.value, f.center.lat, powerRes.value.elevationM ?? 0, stationRes.ok ? stationRes.value : null);
  yield { event: "climate", data: climate.summary };

  // ---- terrain
  const terrainRes = await withTimeout(f.terrain, SLOW_WAIT_MS);
  field.elevationM = terrainRes.ok ? round(terrainRes.value.elevationM) : powerRes.value.elevationM;
  field.slopePct = terrainRes.ok ? round(terrainRes.value.slopeMeanPct, 1) : req.constraints.slopePct;
  field.lowSpotSharePct = terrainRes.ok ? round(terrainRes.value.lowSpotSharePct, 0) : null;
  yield { event: "terrain", data: { elevationM: field.elevationM, slopePct: field.slopePct, lowSpotSharePct: field.lowSpotSharePct } };

  // ---- crop suitability
  const stats = simulateAll(climate, soil);
  const cropSuitability = rankCrops(stats, soil, req, climate);
  yield { event: "cropSuitability", data: cropSuitability };

  // ---- field history (USDA CDL)
  const historyRes = await withTimeout(f.history, SLOW_WAIT_MS);
  const fieldHistory = historyRes.ok ? historyRes.value : null;
  yield { event: "fieldHistory", data: fieldHistory };

  // ---- current rotation: farmer > satellite crop map > current crop > best suited crop
  const gaps: string[] = [];
  const mapped = fieldHistory ? inferRotation(fieldHistory) : [];
  let current: RotationEntry[] = req.currentRotation;
  let rotationSource: PipelineOutput["context"]["rotationSource"] = "farmer";
  if (current.length === 0 && mapped.length) {
    rotationSource = "usda_cdl";
    current = mapped.map((crop) => ({ crop }));
    gaps.push(`Current rotation not provided; taken from the USDA crop map: ${mapped.map((c) => getCrop(c).name).join(" -> ")}.`);
  } else if (current.length === 0) {
    rotationSource = "assumed";
    const fallback = req.currentSeason?.crop ?? cropSuitability.find((s) => s.role === "cash")!.cropId;
    current = [{ crop: fallback }];
    gaps.push(`Current rotation not provided; the baseline assumes continuous ${getCrop(fallback).name}.`);
  } else if (mapped.length && !mapped.every((c) => current.some((e) => e.crop === c))) {
    gaps.push(`The USDA crop map shows ${mapped.map((c) => getCrop(c).name).join(" -> ")} on this spot; please confirm the rotation.`);
  }

  // ---- rotations + robustness test
  const ctx: RotationContext = {
    stats, suitability: new Map(cropSuitability.map((s) => [s.cropId, s])), climate, soil,
    lsFactor: slopeLengthFactor(field.slopePct ?? DEFAULT_SLOPE_PCT), inUnitedStates: f.us,
    constraints: req.constraints, priorities: req.priorities,
  };
  const rotations = buildStrategies(current, ctx);
  const bestId = best(rotations).id;
  const agreement = robustness(current, ctx, req, bestId);

  // ---- vegetation, natural events
  const ndviRes = await withTimeout(f.ndvi, SLOW_WAIT_MS);
  const vegetation: VegetationSummary | null = ndviRes.ok && ndviRes.value.dates.length >= 12 ? summarizeVegetation(ndviRes.value) : null;
  yield { event: "vegetation", data: vegetation };
  const eventsRes = await withTimeout(f.events, SLOW_WAIT_MS);

  // ---- hazards and pest calendar
  const cropsOfInterest = [...new Set([
    ...rotations.flatMap((r) => r.sequence.flatMap((e) => (e.cover ? [e.crop, e.cover] : [e.crop]))),
    ...(req.currentSeason?.crop ? [req.currentSeason.crop] : []),
  ])];
  const hazards = assessHazards({
    climate, soil, vegetation, slopePct: field.slopePct, lowSpotSharePct: field.lowSpotSharePct,
    naturalEvents: eventsRes.ok ? eventsRes.value : null, stats, cropsOfInterest, currentRotation: current,
    currentStrategy: rotations[0], constraints: req.constraints, observedIssues: req.observedIssues, today,
  });
  yield { event: "hazards", data: hazards };
  const pests = pestCalendar(climate, cropsOfInterest);
  yield { event: "pestCalendar", data: pests };

  // ---- data quality, gaps, recommendation
  const dataSources = sourceReports(f.endYear, ndviStart, { soil: soilRes, ndvi: ndviRes, terrain: terrainRes, station: stationRes, history: historyRes, events: eventsRes }, soil, vegetation, climate);
  gaps.push(...informationGaps(dataSources, soil, field.slopePct === null, req.unresolvedCrops, climate));
  const seasonGap = seasonCheck(vegetation, current, stats, climate);
  if (seasonGap) gaps.push(seasonGap);
  if (agreement < 0.7) gaps.push(`The recommendation changed in ${Math.round((1 - agreement) * 100)}% of runs with crop parameters varied by +/-20%; treat it as tentative.`);
  annotate(rotations, hazards, gaps);

  const recommendation = recommend(rotations, { runs: ROBUSTNESS_RUNS, agreement: round(agreement, 2) });
  yield { event: "rotations", data: { rotations, recommendation } };

  // ---- market (D1 data from the scheduled ingestion; null when not loaded)
  const regionRes = await withTimeout(f.region, SLOW_WAIT_MS);
  field.region = regionRes.ok ? regionRes.value : null;
  const marketData = deps.db ? await loadMarketData(deps.db).catch(() => null) : null;
  const market = marketData ? buildMarket(marketData, { cropSuitability, rotations, priorities: req.priorities, region: field.region }) : null;
  yield { event: "market", data: market };
  const marketNote = !deps.db ? "no market database bound" : marketData ? undefined : "market data not loaded yet (run the ingestion)";
  dataSources.push(
    { id: "market_prices", dataset: "IMF world commodity prices + US CPI (via DBnomics)", provider: "IMF / US BLS via DBnomics",
      variables: ["corn, soybean, wheat USD/t", "CPI-U"], spatialResolution: "world benchmark", temporalCoverage: "1990-latest DBnomics update, monthly",
      status: marketData ? "ok" : "unavailable", note: marketNote ?? (marketData?.updated ? `updated ${marketData.updated.slice(0, 10)}` : undefined) },
    { id: "usda_psd", dataset: "USDA FAS PSD supply and demand (US)", provider: "USDA FAS",
      variables: ["production", "exports", "domestic consumption", "ending stocks", "yield"], spatialResolution: "United States", temporalCoverage: "1960-present (incl. current projection), annual",
      status: marketData?.supply.size ? "ok" : "unavailable", note: marketNote },
  );

  yield {
    event: "result",
    data: {
      schemaVersion: "1.0",
      generatedAt: today.toISOString(),
      field,
      context: { ...context, currentRotation: current, rotationSource },
      dataSources,
      climate: climate.summary,
      soil,
      vegetation,
      fieldHistory,
      cropSuitability,
      pestCalendar: pests,
      hazards,
      rotations,
      recommendation,
      market,
      confidence: confidence(dataSources, req.currentRotation.length === 0 && mapped.length === 0, agreement),
      disclaimer: DISCLAIMER,
    },
  };
}

function rankCrops(stats: Map<string, SeasonStats>, soil: PipelineOutput["soil"], req: FieldRequest, climate: ClimateData): CropSuitability[] {
  return CROPS.map((crop) => suitability(stats.get(crop.id)!, soil, req.constraints, climate)).sort((a, b) => b.suitability - a.suitability);
}

const best = (rotations: RotationStrategy[]) => rotations.reduce((a, b) => (b.scores.overall > a.scores.overall ? b : a));

/** Share of runs, with crop parameters perturbed (GDD and Kc +/-20 %, frost and heat limits +/-2 degC), that keep the same recommendation. */
function robustness(current: RotationEntry[], ctx: RotationContext, req: FieldRequest, bestId: string): number {
  let seed = 20261114;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let same = 0;
  for (let run = 0; run < ROBUSTNESS_RUNS; run++) {
    const fixedGdd = new Map([...ctx.stats].map(([id, s]) => [id, s.crop.gddToMaturity * (0.8 + 0.4 * rand())]));
    const factors = new Map(CROPS.map((c) => [c.id, { kc: 0.8 + 0.4 * rand(), frost: 4 * rand() - 2, heat: 4 * rand() - 2 }]));
    const adjust = (c: Crop): Crop => {
      const k = factors.get(c.id)!;
      return { ...c, kc: c.kc * k.kc, frostKillC: c.frostKillC + k.frost, heatStressC: c.heatStressC + k.heat };
    };
    const stats = simulateAll(ctx.climate, ctx.soil, { adjust, fixedGdd });
    const suit = new Map(rankCrops(stats, ctx.soil, req, ctx.climate).map((s) => [s.cropId, s]));
    if (best(buildStrategies(current, { ...ctx, stats, suitability: suit })).id === bestId) same++;
  }
  return same / ROBUSTNESS_RUNS;
}

/** Compare the simulated calendar of the current crop with the green-up MODIS observed on the field. */
function seasonCheck(veg: VegetationSummary | null, current: RotationEntry[], stats: Map<string, SeasonStats>, climate: ClimateData): string | null {
  if (!veg?.observedSeason) return null;
  const s = stats.get(current[current.length - 1].crop)!;
  if (s.crop.sowing === "fall" || s.crop.perennial) return null;
  const toDoy = (mmdd: string) => Math.round((Date.UTC(2001, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3, 5))) - Date.UTC(2001, 0, 1)) / 86_400_000);
  const expectedGreenUp = toDoy(climate.date(s.sowDoy)) + 30; // canopy greens up roughly a month after sowing
  const diff = toDoy(veg.observedSeason.greenUp) - expectedGreenUp;
  if (Math.abs(diff) <= 30) return null;
  return `MODIS shows this field greening up around ${veg.observedSeason.greenUp}, ${Math.abs(diff)} days ${diff > 0 ? "later" : "earlier"} than the simulated ${s.crop.name} calendar; planting dates may differ locally.`;
}

function sourceReports(
  endYear: number,
  ndviStart: number,
  res: { soil: Settled<SoilProfile | null>; ndvi: Settled<NdviSeries>; terrain: Settled<Terrain>; station: Settled<StationRecord | null>; history: Settled<FieldHistoryYear[]>; events: Settled<NaturalEvent[]> },
  soil: PipelineOutput["soil"],
  vegetation: VegetationSummary | null,
  climate: ClimateData,
): DataSourceReport[] {
  const status = (r: Settled<unknown>) => (r.ok ? "ok" : "unavailable") as DataSourceReport["status"];
  const note = (r: Settled<unknown>) => (r.ok ? undefined : r.error);
  const fromSsurgo = soil.source.startsWith("ssurgo");
  const station = climate.summary.baseline.stationCorrection;
  return [
    { id: "nasa_power", dataset: "NASA POWER daily point data (MERRA-2 based)", provider: "NASA LaRC",
      variables: ["T2M_MAX", "T2M_MIN", "PRECTOTCORR", "RH2M", "GWETROOT", "ALLSKY_SFC_SW_DWN", "WS2M"], spatialResolution: "0.5 x 0.625 deg",
      temporalCoverage: `${climate.summary.period.startYear}-${climate.summary.period.endYear}, daily`, status: "ok" },
    { id: "noaa_ghcn", dataset: "NOAA GHCN-Daily nearest station (temperature correction)", provider: "NOAA NCEI", variables: ["TMAX", "TMIN"],
      spatialResolution: "station point", temporalCoverage: `${endYear - 9}-${endYear}, daily`,
      status: station ? "ok" : "unavailable", note: station ? `${station.stationId}, ${station.distanceKm} km` : note(res.station) ?? "no station with enough data within ~50 km" },
    { id: "modis_ndvi", dataset: "MODIS MOD13Q1 v061 NDVI", provider: "NASA LP DAAC via ORNL DAAC",
      variables: ["250m_16_days_NDVI"], spatialResolution: "250 m", temporalCoverage: `${ndviStart}-present, 16-day`, ...ndviStatus(res.ndvi, vegetation) },
    { id: "soil", dataset: fromSsurgo ? "USDA SSURGO (Soil Data Access), 0-30 cm" : "SoilGrids v2.0, 0-30 cm", provider: fromSsurgo ? "USDA NRCS" : "ISRIC",
      variables: fromSsurgo ? ["sand", "clay", "om", "pH", "awc", "drainage class", "hydrologic group"] : ["clay", "sand", "silt", "soc", "phh2o"],
      spatialResolution: fromSsurgo ? "survey map units (1:12,000-1:24,000)" : "250 m", temporalCoverage: "static",
      status: soil.source === "default" || soil.source === "soil_test" ? "unavailable" : "ok", note: note(res.soil) ?? (soilRes(res.soil) ? undefined : "no data at this point") },
    { id: "srtm", dataset: "SRTM GL1 elevation", provider: "NASA/USGS via OpenTopography", variables: ["elevation", "slope", "topographic wetness index"],
      spatialResolution: "30 m", temporalCoverage: "static (2000)", status: status(res.terrain), note: note(res.terrain) },
    { id: "usda_cdl", dataset: "USDA NASS Cropland Data Layer (field history)", provider: "USDA NASS via CropScape", variables: ["crop class at field centroid"],
      spatialResolution: "30 m", temporalCoverage: "last 8 years, yearly", status: status(res.history), note: note(res.history) },
    { id: "eonet", dataset: "NASA EONET natural events within ~50 km", provider: "NASA", variables: ["wildfires", "floods", "severe storms", "drought"],
      spatialResolution: "event locations", temporalCoverage: "past 365 days", status: status(res.events), note: note(res.events) },
  ];
}

const soilRes = (r: Settled<SoilProfile | null>) => r.ok && r.value !== null;

function ndviStatus(r: Settled<NdviSeries>, vegetation: VegetationSummary | null): Pick<DataSourceReport, "status" | "note"> {
  if (!r.ok) return { status: "unavailable", note: r.error };
  if (!vegetation) return { status: "unavailable", note: "too few valid composites" };
  if (r.value.requestsFailed > 0) {
    return { status: "degraded", note: `${r.value.requestsFailed} of ${r.value.requestsTotal} MODIS requests failed; some months are missing` };
  }
  return { status: "ok" };
}

function informationGaps(sources: DataSourceReport[], soil: PipelineOutput["soil"], slopeUnknown: boolean, unresolved: string[], climate: ClimateData): string[] {
  const gaps = [
    "Variety length is fitted to the local season; other crop parameters are generic and benefit from local variety data.",
    "Market prices and demand are not scored here; they are added by the marketing pipeline.",
  ];
  const off = (id: string) => sources.find((s) => s.id === id)?.status !== "ok";
  if (!climate.summary.baseline.stationCorrection) gaps.push("No nearby weather station: temperatures come from the ~50 km NASA POWER grid, so frost pockets are not resolved.");
  if (off("modis_ndvi")) gaps.push("MODIS NDVI missing or incomplete: bare-soil periods and recent crop stress rely partly on crop calendars.");
  if (soil.source === "default") gaps.push("No soil data: a generic loam was assumed. A soil test is strongly recommended.");
  else if (soil.source === "soilgrids") gaps.push("Soil properties are modelled (SoilGrids 250 m); a lab soil test would replace them.");
  if (slopeUnknown) gaps.push(`Field slope unknown: erosion estimate assumes ${DEFAULT_SLOPE_PCT}% slope and low spots are not mapped.`);
  if (unresolved.length) gaps.push(`Crops not in the catalog and ignored: ${unresolved.join(", ")}.`);
  return gaps;
}

function recommend(rotations: RotationStrategy[], stability: PipelineOutput["recommendation"]["stability"]): PipelineOutput["recommendation"] {
  const top = best(rotations);
  const current = rotations.find((r) => r.isCurrent)!;
  const summary = top === current
    ? `Your current rotation scores highest (${top.scores.overall}/100) for your priorities; the alternatives list what each would change.`
    : `${top.name} scores ${top.scores.overall}/100 vs ${current.scores.overall}/100 for your current rotation. ${top.benefits[0] ?? ""}`.trim();
  return { rotationId: top.id, summary, stability };
}

function confidence(sources: DataSourceReport[], rotationAssumed: boolean, agreement: number): PipelineOutput["confidence"] {
  const core = ["noaa_ghcn", "modis_ndvi", "soil", "srtm"];
  const missing = sources.filter((s) => core.includes(s.id) && s.status !== "ok");
  const reasons = [
    `Climate statistics use ${CLIMATE_YEARS} years of daily NASA POWER data.`,
    ...missing.map((s) => `${s.dataset} ${s.status}${s.note ? ` (${s.note})` : ""}.`),
    `Recommendation unchanged in ${Math.round(agreement * 100)}% of robustness runs.`,
  ];
  if (rotationAssumed) reasons.push("Current rotation was assumed, not provided or mapped.");
  const penalty = missing.length + (rotationAssumed ? 1 : 0) + (agreement < 0.7 ? 1 : 0);
  return { level: penalty === 0 ? "high" : penalty <= 1 ? "medium" : "low", reasons };
}
