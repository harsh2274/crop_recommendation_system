// Contracts shared by every module. OUTPUTS.md documents the output fields in prose.

export type Position = [number, number]; // [lon, lat] after reprojection
export type Ring = Position[];
export type PolygonCoords = Ring[]; // outer ring + holes

// ---------------------------------------------------------------- input

/** Normalized request. `input.ts` maps the teammate's GeoJSON onto this. */
export interface FieldRequest {
  fieldId: string;
  polygons: PolygonCoords[]; // WGS84 lon/lat, one or more polygons (MultiPolygon)
  sourceCrs: string;
  farmer: Record<string, unknown>; // passed through untouched to the output
  currentRotation: RotationEntry[]; // crop ids resolved against the catalog
  currentSeason: CurrentSeason | null;
  observedIssues: string[];
  priorities: Priorities;
  constraints: Constraints;
  soilTest: SoilTest | null; // farmer lab values override SSURGO / SoilGrids
  farmerOutcomes: unknown[]; // harvest outcomes the farmer reported, passed through for calibration
  unresolvedCrops: string[]; // names we could not match to the catalog
}

export interface RotationEntry {
  crop: string; // main crop harvested in this rotation year
  cover?: string; // cover crop grown in the gap after the main crop
}

export interface CurrentSeason {
  crop: string | null;
  plantingDate: string | null; // ISO date
  growthStage: string | null; // free text, e.g. "V6", "flowering"
  schedule: unknown; // passed through
}

/** 0 (ignore) .. 5 (top priority). Market/income is scored downstream. */
export interface Priorities {
  soilHealth: number;
  water: number;
  resilience: number;
  pest: number;
  erosion: number;
  income: number; // pass-through for the marketing pipeline
}

export interface Constraints {
  irrigation: "none" | "limited" | "full";
  irrigationCapacityMm: number; // seasonal water available when "limited"
  excludeCrops: string[];
  slopePct: number | null; // farmer-supplied fallback if SRTM unavailable
}

export interface SoilTest {
  ph?: number;
  organicMatterPct?: number;
  clayPct?: number;
  sandPct?: number;
}

// ---------------------------------------------------------------- raw data

export interface DailyWeather {
  dates: string[]; // YYYYMMDD
  tmax: number[]; // degC
  tmin: number[];
  precip: number[]; // mm/day
  rh: number[]; // %
  rootZoneWetness: number[]; // 0..1 (MERRA-2 GWETROOT)
  radiation: number[]; // MJ m-2 day-1 (CERES/MERRA-2 all-sky surface shortwave)
  wind: number[]; // m/s at 2 m
  elevationM: number | null;
}

export interface NdviSeries {
  dates: string[]; // YYYY-MM-DD
  ndvi: number[]; // field-mean NDVI per 16-day composite
  pixelsUsed: number;
  requestsFailed: number; // of requestsTotal; > 0 means some periods are missing
  requestsTotal: number;
}

export interface SoilProfile {
  source: "ssurgo" | "soilgrids";
  clayPct: number;
  sandPct: number;
  siltPct: number;
  socPct: number; // soil organic carbon, %
  ph: number;
  awcMmPerM: number | null; // measured available water (SSURGO); null -> texture lookup
  drainageClass: string | null; // SSURGO, e.g. "Poorly drained"
  hydrologicGroup: string | null; // SSURGO A..D
}

export interface StationRecord {
  id: string;
  name: string;
  distanceKm: number;
  dates: string[]; // YYYY-MM-DD
  tmax: number[];
  tmin: number[];
}

export interface FieldHistoryYear {
  year: number;
  code: number; // USDA CDL class
  category: string;
  cropId: string | null; // catalog id when the class maps to one
}

export interface NaturalEvent {
  title: string;
  category: string;
  date: string;
  distanceKm: number;
}

export interface Terrain {
  elevationM: number;
  slopeMeanPct: number;
  slopeP90Pct: number;
  lowSpotSharePct: number; // share of the field with a high topographic wetness index
  cellsUsed: number;
}

export type SourceStatus = "ok" | "degraded" | "unavailable";

export interface DataSourceReport {
  id: string;
  dataset: string;
  provider: string;
  variables: string[];
  spatialResolution: string;
  temporalCoverage: string;
  status: SourceStatus;
  note?: string;
}

// ---------------------------------------------------------------- output

export interface MonthlyClimate {
  month: number; // 1..12
  tmeanC: number;
  tmaxC: number;
  tminC: number;
  precipMm: number;
  et0Mm: number;
  waterBalanceMm: number; // precip - ET0
  rootZoneWetness: number;
  frostDays: number; // Tmin <= 0
  extremeHeatDays: number; // Tmax >= 35
  heavyRainDays: number; // precip >= 25 mm
  diseaseRiskDays: number; // RH >= 85 and 15 <= Tmean <= 30
  erosivityShare: number; // fraction of annual rainfall erosivity
}

export interface Trend {
  perDecade: number;
  significant: boolean; // |t| >= 2 on an OLS fit across years
}

export interface ClimateSummary {
  period: { startYear: number; endYear: number; years: number };
  baseline: {
    hemisphere: "north" | "south";
    stationCorrection: { stationId: string; name: string; distanceKm: number; overlapYears: number; tmaxOffsetC: number[]; tminOffsetC: number[] } | null;
    warmingAdjustmentCPerDecade: number | null; // earlier years shifted to today's temperature level
  };
  annual: {
    tmeanC: number;
    precipMm: number;
    et0Mm: number;
    aridityIndex: number; // precip / ET0
    gddBase10: number;
    rainfallErosivity: number; // RUSLE R, MJ mm ha-1 h-1 yr-1
  };
  frost: {
    lastSpringMedian: string | null; // MM-DD
    lastSpring90: string | null; // frost-free after this date in 9 of 10 years
    firstFallMedian: string | null;
    firstFall10: string | null; // first frost after this date in 9 of 10 years
    frostFreeDaysMedian: number;
  };
  extremes: {
    wetDayP95Mm: number;
    max5DayPrecipMm: number; // median annual maximum
    longestDrySpellDays: number; // median, Apr-Sep, < 1 mm/day
  };
  recentYear: { year: number; precipAnomalyPct: number; rootZoneWetnessZ: number };
  trends: {
    tmeanC: Trend;
    precipMm: Trend;
    heavyRainDays: Trend;
    extremeHeatDays: Trend;
    rootZoneWetness: Trend;
  };
  monthly: MonthlyClimate[];
}

export interface SoilSummary {
  source: "soil_test" | "ssurgo" | "ssurgo+soil_test" | "soilgrids" | "soilgrids+soil_test" | "default";
  clayPct: number;
  sandPct: number;
  siltPct: number;
  texture: string;
  organicMatterPct: number;
  ph: number;
  availableWaterMmPerM: number;
  erodibilityK: number; // RUSLE K, t ha h ha-1 MJ-1 mm-1
  drainageClass: string | null;
  hydrologicGroup: string | null;
}

export interface VegetationSummary {
  source: string;
  years: number;
  pixelsUsed: number;
  monthlyNdvi: (number | null)[]; // index 0 = January, multi-year median
  bareMonths: number[]; // months with median NDVI < 0.3
  peakMonth: number | null;
  latestSeasonAnomaly: number | null; // latest 12 months vs baseline, NDVI units
  observedSeason: { greenUp: string; brownDown: string } | null; // median MM-DD the field turns green / senesces
}

export interface CropSuitability {
  cropId: string;
  name: string;
  family: string;
  role: "cash" | "cover" | "forage";
  suitability: number; // 0..100
  class: "good" | "marginal" | "poor";
  seasonFitProbability: number; // share of historical years crop reached maturity unharmed
  frostKillProbability: number;
  sowingRule: "after_frost" | "soil_temperature" | "rainfall_onset" | "fall";
  plantingDate: string; // MM-DD, median
  harvestDate: string | null; // MM-DD, median
  seasonDays: number | null;
  maturityGdd: number; // variety length chosen to fit the local season
  maturityClass: "early" | "medium" | "full" | "fixed";
  floweringStressDays: number; // median days of water stress around flowering
  heatStressDays: number; // median per season
  waterUseMm: number; // median seasonal crop ET
  irrigationNeedMm: { median: number; p90: number };
  phFit: boolean;
  limitingFactors: string[];
}

export type Severity = "low" | "moderate" | "high";

export interface Hazard {
  id: string;
  category: "climate" | "water" | "soil" | "biotic" | "vegetation" | "trend";
  title: string;
  severity: Severity;
  likelihood: number | null; // 0..1 share of years, when meaningful
  months: number[];
  upcoming: boolean; // overlaps the next 90 days
  metrics: Record<string, number | string | null>;
  affectedCrops: { cropId: string; impact: string }[];
  mitigation: string[];
  sources: string[];
  corroboratedByFarmer: string[]; // matching observedIssues
}

export interface RotationScores {
  soilHealth: number;
  water: number;
  resilience: number;
  pest: number;
  erosion: number;
  overall: number; // priority-weighted mean of the five above
}

export interface RotationStrategy {
  id: "current" | "cover" | "diversified" | "water_wise";
  name: string;
  isCurrent: boolean;
  sequence: {
    year: number;
    crop: string;
    cover: string | null;
    plantDate: string;
    harvestDate: string | null;
  }[];
  scores: RotationScores;
  metrics: {
    soilCoverFraction: number;
    estimatedSoilLossTHaYr: number;
    irrigationNeedMmYr: number;
    legumeShare: number;
    distinctFamilies: number;
    meanSeasonFitProbability: number;
  };
  programs: string[]; // conservation programs it may qualify for (US); eligibility to confirm locally
  rationale: string;
  evidence: string[];
  benefits: string[];
  risks: string[];
  informationGaps: string[];
}

export interface PestEvent {
  pestId: string;
  pest: string;
  crops: string[];
  event: string;
  date: string; // median MM-DD
  earliest: string; // 10th percentile
  latest: string; // 90th percentile
  action: string;
}

export interface Region {
  country: string;
  countryIso3: string;
  admin1: string; // state / province
  admin1Code: string | null; // e.g. "IA"
  county: string | null;
  countyFips: string | null; // 5-digit US county FIPS
}

export interface PriceRange { p10: number; p50: number; p90: number }

export interface MarketCrop {
  cropId: string;
  harvestMonth: number; // 1..12, from cropSuitability.harvestDate
  price: {
    basis: string; // what the price is: market + source
    usdPerTonne: PriceRange; // in today's dollars (CPI-adjusted)
    usdPerBushel: PriceRange | null; // US crops only
    yearsUsed: number;
  };
  backtest: { years: number; coverage: number; mapePct: number; naiveMapePct: number }; // P10-P90 hit rate; P50 error vs "same month last year"
  bestSellMonth: { month: number; usdPerTonneP50: number; premiumPct: number } | null; // month with the highest 10-year median price vs harvest month
  demand: { marketYear: number; stocksToUse: number; stocksVsUsual: "lower" | "normal" | "higher"; exportsTrend: "rising" | "falling" | "flat" } | null;
  yieldTHa: number | null; // US national median of the last 5 years (USDA PSD)
  grossRevenuePerHa: PriceRange | null; // yield x season fit x price, before costs
  marketScore: number; // 0..100
}

export interface MarketSection {
  basis: string;
  dataUpdated: string | null; // when the ingestion last ran
  pricesThrough: string; // latest price month in the data (YYYY-MM)
  dollarsOf: string; // prices are adjusted to this month's US dollars (latest CPI month, YYYY-MM)
  crops: MarketCrop[];
  ranking: { cropId: string; agronomic: number; market: number; final: number }[];
  rotationRanking: { rotationId: string; agronomic: number; market: number | null; final: number | null }[]; // final null = a crop without market data (not ranked)
  incomeWeight: number; // weight of the market score in `final` (from priorities.income)
  notes: string[];
}

export interface PipelineOutput {
  schemaVersion: "1.0";
  generatedAt: string;
  field: {
    fieldId: string;
    centroid: { lat: number; lon: number };
    areaHa: number;
    bbox: [number, number, number, number];
    elevationM: number | null;
    slopePct: number | null;
    lowSpotSharePct: number | null;
    region: Region | null; // US Census geocoder (US only)
    sourceCrs: string;
  };
  context: {
    farmer: Record<string, unknown>;
    priorities: Priorities;
    constraints: Constraints;
    currentRotation: RotationEntry[];
    rotationSource: "farmer" | "usda_cdl" | "assumed"; // where currentRotation came from
    currentSeason: CurrentSeason | null;
    observedIssues: string[];
    farmerOutcomes: unknown[];
    unresolvedCrops: string[];
  };
  dataSources: DataSourceReport[];
  climate: ClimateSummary;
  soil: SoilSummary;
  vegetation: VegetationSummary | null;
  fieldHistory: FieldHistoryYear[] | null;
  cropSuitability: CropSuitability[];
  pestCalendar: PestEvent[];
  hazards: Hazard[];
  rotations: RotationStrategy[];
  recommendation: { rotationId: string; summary: string; stability: { runs: number; agreement: number } };
  market: MarketSection | null; // null when no market data is loaded
  confidence: { level: "high" | "medium" | "low"; reasons: string[] };
  disclaimer: string;
}
