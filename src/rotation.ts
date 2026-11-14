// Rotation strategies: build candidates (current, +cover crops, diversified, water-wise),
// lay each out on a day-by-day timeline, and score it on five agronomic criteria.
import { DAYS, type ClimateData } from "./climate";
import { CROPS, getCrop, type Crop } from "./crops";
import { unmetWaterShare, type SeasonStats } from "./simulate";
import type { Constraints, CropSuitability, Hazard, Priorities, RotationEntry, RotationScores, RotationStrategy, SoilSummary } from "./types";
import { clamp01, mean, median, round } from "./stats";

export interface RotationContext {
  stats: Map<string, SeasonStats>;
  suitability: Map<string, CropSuitability>;
  climate: ClimateData;
  soil: SoilSummary;
  lsFactor: number;
  inUnitedStates: boolean; // conservation-program hints are US (NRCS) programs
  constraints: Constraints;
  priorities: Priorities;
}

const GOOD_SUITABILITY = 60;
const TOLERABLE_LOSS_T_HA = 11.2; // USDA "T", 5 t/acre/yr
const IRRIGATION_REF_MM = 400; // need at which the water score reaches 0
const COVER_PLANT_DELAY = 3; // days after harvest
const COVER_TERMINATION_LEAD = 14; // days before the next crop is planted
const MIN_COVER_WINDOW = 30;

// RUSLE cover-management (C) factor per ground state
const BARE = 0, CROP = 1, COVER = 2, RESIDUE = 3, PERENNIAL = 4;
const C_FACTOR = [0.5, 0.2, 0.05, 0.15, 0.02];

interface Layout {
  states: Uint8Array; // ground state per day of the whole cycle
  rows: { crop: Crop; cover: Crop | null; sow: number; harvest: number | null }[];
  conflicts: string[];
}

// ---------------------------------------------------------------- timeline

type Row = Layout["rows"][number];

/** Bare gap after row i: from its harvest to the next crop's sowing (absolute days in the cycle). */
function gapAfter(rows: Row[], i: number): { end: number; nextSow: number } {
  const r = rows[i];
  const next = rows[(i + 1) % rows.length];
  return {
    end: r.harvest ?? r.sow + 150, // crop that rarely matures: assume ~5 months in the ground
    nextSow: next.sow + (i === rows.length - 1 ? rows.length * DAYS : 0),
  };
}

function layout(entries: RotationEntry[], ctx: RotationContext): Layout {
  const n = entries.length;
  const L = n * DAYS;
  const states = new Uint8Array(L);
  const at = (abs: number) => ((abs % L) + L) % L;
  const conflicts: string[] = [];

  const rows = entries.map((e, i) => {
    const crop = getCrop(e.crop);
    const s = ctx.stats.get(crop.id)!;
    if (crop.perennial) return { crop, cover: null, sow: i * DAYS, harvest: i * DAYS + DAYS - 1 };
    const sow = i * DAYS + s.sowDoy - (crop.sowing === "fall" ? DAYS : 0);
    const harvest = s.harvestDoy === null ? null : i * DAYS + s.harvestDoy + (crop.sowing !== "fall" && s.harvestDoy < s.sowDoy ? DAYS : 0);
    return { crop, cover: e.cover ? getCrop(e.cover) : null, sow, harvest };
  });

  rows.forEach((r, i) => {
    const { end, nextSow } = gapAfter(rows, i);
    for (let d = r.sow; d <= end; d++) states[at(d)] = r.crop.perennial ? PERENNIAL : CROP;
    const next = rows[(i + 1) % n];
    if (n > 1 && nextSow <= end) {
      conflicts.push(`${r.crop.name} is harvested around ${ctx.climate.date(end % DAYS)} but ${next.crop.name} should be sown by ${ctx.climate.date(((next.sow % DAYS) + DAYS) % DAYS)}`);
    }
    if (r.cover && coverFits(r.cover, end, nextSow, ctx)) {
      const coverStart = end + COVER_PLANT_DELAY;
      const coverEnd = nextSow - COVER_TERMINATION_LEAD;
      const killDoy = r.cover.winterKill ? firstFrostAbs(coverStart, ctx) : Infinity;
      for (let d = coverStart; d <= coverEnd; d++) if (states[at(d)] === BARE) states[at(d)] = d < killDoy ? COVER : RESIDUE;
    }
  });
  return { states, rows, conflicts };
}

function firstFrostAbs(from: number, ctx: RotationContext): number {
  const frost = median(ctx.climate.firstFallFrost.map((d) => d ?? DAYS));
  const base = from - (from % DAYS);
  return frost >= DAYS ? Infinity : base + frost + (base + frost < from ? DAYS : 0);
}

/** A cover fits a gap if it gets enough growing degree days and (if meant to overwinter) survives winter. */
function coverFits(cover: Crop, harvest: number, nextSow: number, ctx: RotationContext): boolean {
  const start = harvest + COVER_PLANT_DELAY;
  const end = Math.min(nextSow - COVER_TERMINATION_LEAD, cover.winterKill ? firstFrostAbs(start, ctx) : Infinity);
  if (end - start < MIN_COVER_WINDOW) return false;
  let gddSum = 0;
  for (let d = start; d < end; d++) gddSum += Math.max(0, ctx.climate.climTmean[d % DAYS] - cover.tBaseC);
  const survives = cover.winterKill || ctx.stats.get(cover.id)!.frostKillProbability <= 0.2;
  return gddSum >= cover.gddToMaturity && survives;
}

// ---------------------------------------------------------------- scoring

function evaluate(entries: RotationEntry[], ctx: RotationContext) {
  const { states, rows, conflicts } = layout(entries, ctx);
  const n = rows.length;
  const mains = rows.map((r) => ctx.stats.get(r.crop.id)!);
  const covers = rows.filter((r) => r.cover).map((r) => r.cover!);
  const coverActive = covers.length > 0 && states.some((s) => s === COVER || s === RESIDUE);

  let weightedC = 0, bareErosivity = 0, bareDays = 0;
  states.forEach((s, d) => {
    const e = ctx.climate.erosivityByDoy[d % DAYS];
    weightedC += C_FACTOR[s] * e;
    if (s === BARE) { bareErosivity += e; bareDays++; }
  });
  const R = ctx.climate.summary.annual.rainfallErosivity;
  const soilLoss = (R * ctx.soil.erodibilityK * ctx.lsFactor * weightedC) / n;

  const families = new Set(rows.map((r) => r.crop.family));
  let repeats = 0;
  rows.forEach((r, i) => {
    const next = rows[(i + 1) % n];
    const perennialStand = r.crop.perennial && next.crop.id === r.crop.id;
    if (next.crop.family === r.crop.family && !perennialStand) repeats++;
  });

  const legumeShare = clamp01(rows.filter((r) => r.crop.nFixing || (r.cover?.nFixing && coverActive)).length / n);
  const organic = clamp01(
    (rows.reduce((a, r) => a + r.crop.residue, 0) + (coverActive ? covers.reduce((a, c) => a + c.residue, 0) : 0)) / (3 * n),
  );
  const deepRoots = [...rows.map((r) => r.crop), ...(coverActive ? covers : [])].some((c) => c.rootDepthM >= 1.5) ? 1 : 0.5;
  const coverFraction = 1 - bareDays / states.length;
  const irrigation = mean(mains.map((s) => s.irrigationMedianMm));
  const meanFit = mean(mains.map((s) => s.fitProbability));
  const heatPenalty = mean(mains.map((s) => Math.min(1, s.heatDays / 20) * 0.4));
  const unmet = mean(mains.map((s) => unmetWaterShare(s, ctx.constraints)));

  const scores = {
    soilHealth: 100 * (0.35 * coverFraction + 0.25 * legumeShare + 0.2 * organic + 0.2 * deepRoots),
    water: 100 * (1 - Math.min(1, irrigation / IRRIGATION_REF_MM)),
    resilience: 100 * meanFit * (1 - heatPenalty) * (1 - 0.5 * unmet) * (conflicts.length ? 0.7 : 1),
    pest: 100 * clamp01(Math.min(1, families.size / 3) - 0.3 * repeats),
    erosion: 100 * clamp01(1 - soilLoss / (2 * TOLERABLE_LOSS_T_HA)), // 50 at the tolerable loss T
  };
  const p = ctx.priorities;
  const weights = [p.soilHealth, p.water, p.resilience, p.pest, p.erosion];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const values = [scores.soilHealth, scores.water, scores.resilience, scores.pest, scores.erosion];
  const overall = totalWeight > 0 ? values.reduce((a, v, i) => a + v * weights[i], 0) / totalWeight : mean(values);

  const rounded = Object.fromEntries(Object.entries({ ...scores, overall }).map(([k, v]) => [k, round(v)])) as unknown as RotationScores;
  return {
    rows,
    conflicts,
    scores: rounded,
    bareErosivityShare: bareErosivity / n,
    metrics: {
      soilCoverFraction: round(coverFraction, 2),
      estimatedSoilLossTHaYr: round(soilLoss, 1),
      irrigationNeedMmYr: round(irrigation),
      legumeShare: round(legumeShare, 2),
      distinctFamilies: families.size,
      meanSeasonFitProbability: round(meanFit, 2),
    },
  };
}

// ---------------------------------------------------------------- strategy builders

const signature = (entries: RotationEntry[]) => entries.map((e) => `${e.crop}+${e.cover ?? ""}`).join(">");

function candidates(ctx: RotationContext, role: "main" | "cover"): Crop[] {
  return CROPS.filter(
    (c) =>
      (role === "cover" ? c.role === "cover" : c.role !== "cover") &&
      !ctx.constraints.excludeCrops.includes(c.id) &&
      (role === "cover" || (ctx.suitability.get(c.id)?.suitability ?? 0) >= GOOD_SUITABILITY),
  );
}

/** Put the best-fitting cover crop into every gap that does not already have one. */
function withCovers(entries: RotationEntry[], ctx: RotationContext): RotationEntry[] {
  const { rows } = layout(entries, ctx);
  const n = entries.length;
  const arid = ctx.climate.summary.annual.aridityIndex < 0.5;
  return entries.map((e, i) => {
    if (e.cover || rows[i].crop.perennial) return e;
    const { end, nextSow } = gapAfter(rows, i);
    const next = rows[(i + 1) % n];
    let best: Crop | null = null;
    let bestScore = -Infinity;
    for (const cover of candidates(ctx, "cover")) {
      if (!coverFits(cover, end, nextSow, ctx)) continue;
      const score =
        (next.crop.nDemanding && cover.nFixing ? 1 : 0) +
        (ctx.priorities.erosion / 5) * (cover.residue / 3) +
        (cover.winterKill && (arid || next.crop.sowing === "spring") ? 0.5 : 0) + // no spring termination, saves soil water
        (ctx.soil.clayPct > 35 && cover.rootDepthM >= 1.5 ? 0.3 : 0); // deep taproots for heavy soils
      if (score > bestScore) [best, bestScore] = [cover, score];
    }
    return best ? { ...e, cover: best.id } : e;
  });
}

function bestBy(options: RotationEntry[][], ctx: RotationContext): RotationEntry[] | null {
  let best: RotationEntry[] | null = null;
  let bestScore = -Infinity;
  for (const entries of options) {
    const score = evaluate(entries, ctx).scores.overall;
    if (score > bestScore) [best, bestScore] = [entries, score];
  }
  return best;
}

/** Add one crop from a family not yet in the rotation, at the position that scores best. */
function diversify(current: RotationEntry[], ctx: RotationContext): { entries: RotationEntry[]; added: Crop } | null {
  const families = new Set(current.map((e) => getCrop(e.crop).family));
  const newCrops = candidates(ctx, "main")
    .filter((c) => !families.has(c.family))
    .sort((a, b) => ctx.suitability.get(b.id)!.suitability - ctx.suitability.get(a.id)!.suitability)
    .slice(0, 5);
  const options = newCrops.flatMap((crop) =>
    current.map((_, pos) => withCovers([...current.slice(0, pos + 1), { crop: crop.id }, ...current.slice(pos + 1)], ctx)),
  );
  const best = bestBy(options, ctx);
  if (!best) return null;
  const added = best.map((e) => getCrop(e.crop)).find((c) => !families.has(c.family))!;
  return { entries: best, added };
}

/** Swap the thirstiest crop for a suitable crop that needs at least 25% less irrigation (only when water matters). */
function saveWater(current: RotationEntry[], ctx: RotationContext): { entries: RotationEntry[]; from: Crop; to: Crop } | null {
  const need = (id: string) => ctx.stats.get(id)!.irrigationMedianMm;
  const idx = current.reduce((m, e, i) => (need(e.crop) > need(current[m].crop) ? i : m), 0);
  const from = getCrop(current[idx].crop);
  const waterMatters = need(from.id) >= 50 || ctx.priorities.water >= 4;
  if (!waterMatters || need(from.id) < 10) return null; // water is not the limiting factor here
  const options = candidates(ctx, "main")
    .filter((c) => c.id !== from.id && need(c.id) <= 0.75 * need(from.id))
    .map((c) => withCovers(current.map((e, i) => (i === idx ? { crop: c.id } : e)), ctx));
  const best = bestBy(options, ctx);
  return best ? { entries: best, from, to: getCrop(best[idx].crop) } : null;
}

// ---------------------------------------------------------------- public API

export function buildStrategies(current: RotationEntry[], ctx: RotationContext): RotationStrategy[] {
  const base = evaluate(current, ctx);
  const names = (entries: RotationEntry[]) => entries.map((e) => getCrop(e.crop).name).join(" -> ");
  const drafts: { id: RotationStrategy["id"]; name: string; entries: RotationEntry[]; rationale: string }[] = [
    { id: "current", name: "Current rotation", entries: current, rationale: `The rotation you farm today (${names(current)}), scored as the baseline.` },
  ];

  const covered = withCovers(current, ctx);
  drafts.push({
    id: "cover",
    name: "Current rotation + cover crops",
    entries: covered,
    rationale:
      `Keeps your cash crops and fills bare gaps with cover crops. ` +
      `Today ${Math.round(base.bareErosivityShare * 100)}% of annual rainfall erosivity lands on bare soil.`,
  });

  const div = diversify(current, ctx);
  if (div) {
    drafts.push({
      id: "diversified",
      name: `Diversified with ${div.added.name}`,
      entries: div.entries,
      rationale:
        `Adds ${div.added.name} (${div.added.family}), a plant family not in your rotation, to interrupt pest and disease cycles ` +
        `(${div.added.keyPests || "family-specific pests"}). It is suitable here (${ctx.suitability.get(div.added.id)!.suitability}/100).`,
    });
  }

  const water = saveWater(current, ctx);
  if (water) {
    drafts.push({
      id: "water_wise",
      name: `Water-wise: ${water.to.name} instead of ${water.from.name}`,
      entries: water.entries,
      rationale:
        `${water.from.name} has the highest water deficit in your rotation (median ${round(ctx.stats.get(water.from.id)!.irrigationMedianMm)} mm/season ` +
        `beyond rainfall). ${water.to.name} needs ${round(ctx.stats.get(water.to.id)!.irrigationMedianMm)} mm.`,
    });
  }

  const seen = new Set<string>();
  return drafts
    .filter((d) => !seen.has(signature(d.entries)) && seen.add(signature(d.entries)))
    .map((d) => toStrategy(d, evaluate(d.entries, ctx), base, ctx));
}

function toStrategy(
  draft: { id: RotationStrategy["id"]; name: string; entries: RotationEntry[]; rationale: string },
  ev: ReturnType<typeof evaluate>,
  base: ReturnType<typeof evaluate>,
  ctx: RotationContext,
): RotationStrategy {
  const period = `${ctx.climate.summary.period.startYear}-${ctx.climate.summary.period.endYear}`;
  const evidence = [
    `Soil is covered ${Math.round(ev.metrics.soilCoverFraction * 100)}% of the year; ${Math.round(ev.bareErosivityShare * 100)}% of rainfall erosivity falls on bare soil (NASA POWER rainfall).`,
    ...ev.rows.map((r) => {
      const s = ctx.stats.get(r.crop.id)!;
      return `${r.crop.name}: reached maturity in ${Math.round(s.fitProbability * 100)}% of ${period} seasons; needs ~${round(s.irrigationMedianMm)} mm beyond effective rainfall in a median year.`;
    }),
  ];

  const labels: Record<keyof RotationScores, string> = {
    soilHealth: "Soil health", water: "Water use", resilience: "Climate resilience", pest: "Pest-cycle disruption", erosion: "Erosion protection", overall: "Overall",
  };
  const benefits = draft.id === "current"
    ? ["Known system: no new equipment, seed sources or markets needed."]
    : (Object.keys(labels) as (keyof RotationScores)[])
        .filter((k) => k !== "overall" && ev.scores[k] - base.scores[k] >= 5)
        .map((k) => `${labels[k]} +${ev.scores[k] - base.scores[k]} vs current (${base.scores[k]} -> ${ev.scores[k]}).`);
  if (draft.id !== "current" && ev.metrics.estimatedSoilLossTHaYr < base.metrics.estimatedSoilLossTHaYr - 0.5) {
    benefits.push(`Estimated soil loss ${base.metrics.estimatedSoilLossTHaYr} -> ${ev.metrics.estimatedSoilLossTHaYr} t/ha/yr.`);
  }

  const risks = [...ev.conflicts.map((c) => `Timing conflict: ${c}.`)];
  const newCrops = ev.rows.filter((r) => !base.rows.some((b) => b.crop.id === r.crop.id)).map((r) => r.crop.name);
  if (newCrops.length) risks.push(`New crop(s) ${newCrops.join(", ")}: check equipment, seed, storage and local buyers before committing.`);
  const covers = ev.rows.filter((r) => r.cover).map((r) => r.cover!);
  if (covers.length && ctx.climate.summary.annual.aridityIndex < 0.65) {
    risks.push("Dry climate: cover crops use stored soil water; terminate early if spring soil moisture is low.");
  }
  if (covers.some((c) => !c.winterKill)) risks.push("Overwintering covers must be terminated on time (~2 weeks before planting) to avoid yield drag.");

  return {
    id: draft.id,
    name: draft.name,
    isCurrent: draft.id === "current",
    sequence: ev.rows.map((r, i) => ({
      year: i + 1,
      crop: r.crop.id,
      cover: r.cover?.id ?? null,
      plantDate: ctx.climate.date(((r.sow % DAYS) + DAYS) % DAYS),
      harvestDate: r.harvest === null ? null : ctx.climate.date(r.harvest % DAYS),
    })),
    scores: ev.scores,
    metrics: ev.metrics,
    programs: programs(ev, ctx),
    rationale: draft.rationale,
    evidence,
    benefits,
    risks,
    informationGaps: [],
  };
}

/** Smallest repeating cycle at the end of a crop sequence: corn,soy,corn,soy -> [corn, soy]; otherwise the last 3. */
export function repeatingCycle(seq: string[]): string[] {
  const crops = seq.slice(-6);
  for (const period of [1, 2, 3]) {
    if (crops.length < period * 2) break;
    const tail = crops.slice(-period * 2);
    if (tail.every((c, i) => c === tail[i % period])) return tail.slice(0, period);
  }
  return crops.slice(-3);
}

/** USDA NRCS practices the strategy may qualify for (cost-share income); eligibility is decided locally. */
function programs(ev: ReturnType<typeof evaluate>, ctx: RotationContext): string[] {
  if (!ctx.inUnitedStates) return [];
  const out: string[] = [];
  if (ev.rows.some((r) => r.cover)) out.push("NRCS EQIP/CSP practice 340: Cover Crop");
  if (ev.metrics.distinctFamilies >= 3) out.push("NRCS EQIP/CSP practice 328: Conservation Crop Rotation");
  return out;
}

/** Append hazard-driven risks and global information gaps once hazards are known. */
export function annotate(strategies: RotationStrategy[], hazards: Hazard[], gaps: string[]): void {
  for (const s of strategies) {
    const crops = new Set(s.sequence.flatMap((e) => (e.cover ? [e.crop, e.cover] : [e.crop])));
    for (const h of hazards) {
      if (h.severity === "low") continue;
      const hit = h.affectedCrops.filter((a) => crops.has(a.cropId));
      if (hit.length) s.risks.push(`${h.title} (${h.severity}): ${hit.map((a) => `${getCrop(a.cropId).name}: ${a.impact}`).join("; ")}.`);
    }
    s.informationGaps.push(...gaps);
  }
}
