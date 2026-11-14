// Replays every crop through each historical season year of (station-corrected) NASA POWER weather:
// sow by rule -> daily soil-water bucket and GDD to maturity -> record killing frost, heat stress,
// water deficit and stress around flowering. Aggregating across years turns weather history into
// probabilities ("fits in 14 of 15 years").
import { DAYS, type ClimateData, gdd } from "./climate";
import { CROPS, type Crop } from "./crops";
import type { Constraints, CropSuitability, SoilSummary } from "./types";
import { clamp01, median, percentile, round } from "./stats";

const FROST_SAFE_QUANTILE = 0.8; // sow after the last spring frost of 8 in 10 years
const FALL_SOW_LEAD_DAYS = 35; // fall crops sown ~5 weeks before the median first frost
const MAX_SEASON_DAYS = 330;
const DEFAULT_FROST_SAFE_DAYS = 10; // seed in the ground is not killed by frost
const DRY_DOWN_DAYS = 14; // grain crops: physiological maturity -> harvest
const TARGET_FIT = 0.85; // variety choice: longest maturity that matures in >= 85% of years
const VARIETY_STEP_GDD = 100;
const DROUGHT_SENSITIVITY = { 1: 1.0, 2: 0.7, 3: 0.4 } as const;
const DEPLETION_FRACTION = { 1: 0.4, 2: 0.5, 3: 0.6 } as const; // FAO-56 p: share of available water usable without stress
const STRESS_KS = 0.7; // Ks below this = a water-stress day
const FLOWERING = [0.45, 0.65] as const; // share of the season around flowering
// rainfall onset: >= 20 mm in 3 days, then no 10-day dry spell in the next 30 days
const ONSET_RAIN_MM = 20, ONSET_DRY_SPELL = 10, ONSET_CHECK_DAYS = 30;

export type SowingRule = CropSuitability["sowingRule"];

export interface SeasonStats {
  crop: Crop; // as simulated (variety GDD and any robustness-test adjustment applied)
  sowingRule: SowingRule;
  sowDoy: number; // median season-year day; fall crops: in the season year before harvest
  harvestDoy: number | null; // median, maturity + dry-down for grain crops
  seasonDays: number | null; // sowing -> maturity
  maturityClass: CropSuitability["maturityClass"];
  fitProbability: number;
  frostKillProbability: number;
  heatDays: number;
  waterUseMm: number;
  irrigationMedianMm: number; // water deficit: crop demand the soil and rain could not meet
  irrigationP90Mm: number;
  floweringStressDays: number;
}

export interface SimOptions {
  adjust?: (crop: Crop) => Crop; // robustness test: perturbed parameters
  fixedGdd?: Map<string, number>; // reuse a variety choice instead of searching again
}

function firstWarmDay(climate: ClimateData, t: number): number {
  const d = climate.climTmean.findIndex((v, i) => i < 250 && v >= t);
  return d < 0 ? 0 : d;
}

/** Temperature/frost-based sowing day, and whether rainfall rather than temperature limits sowing. */
function sowingPlan(crop: Crop, climate: ClimateData): { doy: number; rule: SowingRule } {
  if (crop.sowing === "fall") {
    const fall = median(climate.firstFallFrost.map((d) => d ?? DAYS));
    return { doy: Math.min(DAYS - 1, (fall >= DAYS ? 300 : fall) - FALL_SOW_LEAD_DAYS), rule: "fall" };
  }
  let doy = firstWarmDay(climate, crop.sowTempC);
  let rule: SowingRule = "soil_temperature";
  if (crop.sowing === "after_frost") {
    const frostSafe = Math.round(percentile(climate.lastSpringFrost.map((d) => d ?? -1), FROST_SAFE_QUANTILE) + 1);
    if (frostSafe >= doy) [doy, rule] = [frostSafe, "after_frost"];
  }
  const month = climate.summary.monthly[climate.monthOf[doy] - 1];
  const frostFree = climate.lastSpringFrost.filter((d) => d === null).length > climate.years.length / 2;
  if (frostFree || month.precipMm < 0.5 * month.et0Mm) rule = "rainfall_onset";
  return { doy, rule };
}

/** First reliable rainy-season start on or after `from` in season year i, or null. */
function rainOnset(climate: ClimateData, i: number, from: number): number | null {
  const p = (d: number) => {
    const y = climate.years[i + Math.floor(d / DAYS)];
    return y ? y.precip[d % DAYS] : NaN;
  };
  for (let d = from; d < from + 240; d++) {
    if (!(p(d) + p(d + 1) + p(d + 2) >= ONSET_RAIN_MM)) continue;
    let run = 0, dry = false;
    for (let k = d + 3; k < d + 3 + ONSET_CHECK_DAYS; k++) {
      run = p(k) < 1 ? run + 1 : 0;
      if (run >= ONSET_DRY_SPELL) { dry = true; break; }
    }
    if (!dry && Number.isFinite(p(d + 3 + ONSET_CHECK_DAYS))) return d;
  }
  return null;
}

interface Run { matured: boolean; killed: boolean; sow: number; days: number; heat: number; etc: number; deficit: number; flowerStress: number }

function runSeasons(crop: Crop, climate: ClimateData, soil: SoilSummary, plan: { doy: number; rule: SowingRule }): Run[] {
  const taw = soil.availableWaterMmPerM * crop.rootDepthM;
  const raw = DEPLETION_FRACTION[crop.droughtTolerance] * taw;
  const frostSafeDays = crop.frostSafeDays ?? DEFAULT_FROST_SAFE_DAYS;
  const springDoy = median(climate.lastSpringFrost.map((d) => d ?? 60));
  const surviveDays = crop.sowing === "fall" && !crop.winterKill ? DAYS - plan.doy + springDoy : 0; // overwintering covers must reach spring
  const day = (i: number, abs: number) => {
    const year = climate.years[i + Math.floor(abs / DAYS)];
    return year ? { year, d: ((abs % DAYS) + DAYS) % DAYS } : null;
  };
  const runs: Run[] = [];

  for (let i = 0; i < climate.years.length; i++) {
    const sow = plan.rule === "rainfall_onset" ? rainOnset(climate, i, Math.max(0, plan.doy - 30)) : plan.doy;
    if (sow === null) { // the rains never became reliable: no season this year
      runs.push({ matured: false, killed: false, sow: plan.doy, days: 0, heat: 0, etc: 0, deficit: 0, flowerStress: 0 });
      continue;
    }
    // soil profile full at sowing if the 90 days before were wetter than ET0, else half depleted
    let pre = 0;
    for (let k = -90; k < 0; k++) {
      const x = day(i, sow + k);
      if (x) pre += x.year.precip[x.d] - x.year.et0[x.d];
    }
    let depletion = pre > 0 ? 0 : 0.5 * taw;
    let gddSum = 0, heat = 0, etc = 0, deficit = 0, killed = false, matured = false, days = 0, k = 0;
    const ks: number[] = [];
    for (; k < MAX_SEASON_DAYS; k++) {
      const x = day(i, sow + k);
      if (!x) break;
      const { year, d } = x;
      if (k >= frostSafeDays && year.tmin[d] <= crop.frostKillC) { killed = true; break; }
      if (!matured) {
        if (year.tmax[d] >= crop.heatStressC) heat++;
        const demand = crop.kc * year.et0[d];
        const stress = depletion > raw ? Math.max(0, (taw - depletion) / Math.max(1e-6, taw - raw)) : 1; // FAO-56 Ks
        const actual = stress * demand;
        depletion = Math.min(taw, Math.max(0, depletion - year.precip[d] + actual)); // excess rain drains away
        etc += demand;
        deficit += demand - actual;
        ks.push(stress);
        gddSum += gdd(year.tmax[d], year.tmin[d], crop.tBaseC);
        if (gddSum >= crop.gddToMaturity) { matured = true; days = k; }
      }
      if (matured && k >= surviveDays) break;
    }
    if (!killed && k < MAX_SEASON_DAYS && !(matured && k >= surviveDays)) continue; // record ended mid-season
    const window = ks.slice(Math.floor(FLOWERING[0] * ks.length), Math.ceil(FLOWERING[1] * ks.length));
    runs.push({ matured: matured && !killed, killed, sow, days, heat, etc, deficit, flowerStress: window.filter((s) => s < STRESS_KS).length });
  }
  return runs;
}

function summarizeRuns(crop: Crop, plan: { doy: number; rule: SowingRule }, runs: Run[], cls: SeasonStats["maturityClass"]): SeasonStats {
  const ok = runs.filter((r) => r.matured);
  const typical = ok.length ? ok : runs; // season statistics describe seasons that completed
  const sowDoy = Math.round(median(typical.map((r) => r.sow)));
  const days = ok.length ? Math.round(median(ok.map((r) => r.days))) : null;
  return {
    crop,
    sowingRule: plan.rule,
    sowDoy,
    harvestDoy: days === null ? null : (sowDoy + days + (crop.role === "cash" ? DRY_DOWN_DAYS : 0)) % DAYS,
    seasonDays: days,
    maturityClass: cls,
    fitProbability: ok.length / runs.length,
    frostKillProbability: runs.filter((r) => r.killed).length / runs.length,
    heatDays: median(typical.map((r) => r.heat)),
    waterUseMm: median(typical.map((r) => r.etc)),
    irrigationMedianMm: median(typical.map((r) => r.deficit)),
    irrigationP90Mm: percentile(typical.map((r) => r.deficit), 0.9),
    floweringStressDays: median(typical.map((r) => r.flowerStress)),
  };
}

function maturityClass([min, max]: [number, number], g: number): SeasonStats["maturityClass"] {
  const pos = (g - min) / (max - min);
  return pos < 1 / 3 ? "early" : pos < 2 / 3 ? "medium" : "full";
}

export function simulateCrop(base: Crop, climate: ClimateData, soil: SoilSummary, opts: SimOptions = {}): SeasonStats {
  const crop = opts.adjust ? opts.adjust(base) : base;
  const plan = sowingPlan(crop, climate);
  const fixed = opts.fixedGdd?.get(base.id);
  if (!base.gddRange || fixed !== undefined) {
    const c = fixed !== undefined ? { ...crop, gddToMaturity: fixed } : crop;
    const cls = base.gddRange && fixed !== undefined ? maturityClass(base.gddRange, fixed) : "fixed";
    return summarizeRuns(c, plan, runSeasons(c, climate, soil, plan), cls);
  }
  // Variety choice: the longest maturity that still matures in TARGET_FIT of years (more yield potential).
  let best: SeasonStats | null = null;
  for (let g = base.gddRange[1]; g >= base.gddRange[0]; g -= VARIETY_STEP_GDD) {
    const c = { ...crop, gddToMaturity: g };
    const s = summarizeRuns(c, plan, runSeasons(c, climate, soil, plan), maturityClass(base.gddRange, g));
    if (!best || s.fitProbability > best.fitProbability) best = s;
    if (s.fitProbability >= TARGET_FIT) return s;
  }
  return best!;
}

export function simulateAll(climate: ClimateData, soil: SoilSummary, opts: SimOptions = {}): Map<string, SeasonStats> {
  return new Map(CROPS.map((crop) => [crop.id, simulateCrop(crop, climate, soil, opts)]));
}

/** Share of the crop's water use left unmet after the irrigation the farmer can apply. */
export function unmetWaterShare(s: SeasonStats, constraints: Constraints): number {
  if (s.waterUseMm <= 0 || constraints.irrigation === "full") return 0;
  const supply = constraints.irrigation === "limited" ? constraints.irrigationCapacityMm : 0;
  return clamp01(Math.max(0, s.irrigationMedianMm - supply) / s.waterUseMm);
}

export function suitability(s: SeasonStats, soil: SoilSummary, constraints: Constraints, climate: ClimateData): CropSuitability {
  const { crop } = s;
  const limiting: string[] = [];

  if (s.fitProbability < 0.9) {
    limiting.push(
      s.frostKillProbability > 0.1
        ? `killing frost before maturity in ${pct(s.frostKillProbability)} of years`
        : s.sowingRule === "rainfall_onset" && s.seasonDays === null
          ? "rains too unreliable to establish the crop"
          : `season too short or too dry to reach maturity in ${pct(1 - s.fitProbability)} of years`,
    );
  }
  const heatPenalty = Math.min(1, s.heatDays / 20) * 0.4;
  if (s.heatDays >= 5) limiting.push(`${round(s.heatDays)} days above ${crop.heatStressC} degC in a typical season`);

  const phFit = soil.ph >= crop.phMin && soil.ph <= crop.phMax;
  const phGap = phFit ? 0 : Math.min(Math.abs(soil.ph - crop.phMin), Math.abs(soil.ph - crop.phMax));
  if (!phFit) limiting.push(`soil pH ${soil.ph} outside ${crop.phMin}-${crop.phMax}`);

  const unmet = unmetWaterShare(s, constraints);
  if (unmet > 0.15) limiting.push(`${pct(unmet)} of crop water demand unmet without (more) irrigation`);
  const flowerPenalty = constraints.irrigation === "full" ? 0 : 0.3 * Math.min(1, s.floweringStressDays / 10);
  if (flowerPenalty > 0 && s.floweringStressDays >= 3) limiting.push(`${round(s.floweringStressDays)} dry-stress days around flowering in a typical season`);

  const score =
    100 * s.fitProbability * (1 - heatPenalty) * Math.max(0.5, 1 - 0.5 * phGap) *
    (1 - unmet * DROUGHT_SENSITIVITY[crop.droughtTolerance]) * (1 - flowerPenalty);

  return {
    cropId: crop.id,
    name: crop.name,
    family: crop.family,
    role: crop.role,
    suitability: round(score),
    class: score >= 70 ? "good" : score >= 40 ? "marginal" : "poor",
    seasonFitProbability: round(s.fitProbability, 2),
    frostKillProbability: round(s.frostKillProbability, 2),
    sowingRule: s.sowingRule,
    plantingDate: climate.date(s.sowDoy),
    harvestDate: s.harvestDoy === null ? null : climate.date(s.harvestDoy),
    seasonDays: s.seasonDays,
    maturityGdd: crop.gddToMaturity,
    maturityClass: s.maturityClass,
    floweringStressDays: round(s.floweringStressDays, 1),
    heatStressDays: round(s.heatDays, 1),
    waterUseMm: round(s.waterUseMm),
    irrigationNeedMm: { median: round(s.irrigationMedianMm), p90: round(s.irrigationP90Mm) },
    phFit,
    limitingFactors: limiting,
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
