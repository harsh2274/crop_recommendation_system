// Rule-based hazard screening. Each rule turns climate/soil/vegetation metrics into a hazard,
// lists the crops of interest it affects (from the crop simulation) and links farmer reports.
// Thresholds are documented in PIPELINE.md ("Hazard rules").
import type { ClimateData } from "./climate";
import { getCrop } from "./crops";
import { unmetWaterShare, type SeasonStats } from "./simulate";
import type { Constraints, Hazard, NaturalEvent, RotationEntry, RotationStrategy, Severity, SoilSummary, VegetationSummary } from "./types";
import { round } from "./stats";

export interface HazardInput {
  climate: ClimateData;
  soil: SoilSummary;
  vegetation: VegetationSummary | null;
  slopePct: number | null;
  lowSpotSharePct: number | null;
  naturalEvents: NaturalEvent[] | null;
  stats: Map<string, SeasonStats>;
  cropsOfInterest: string[];
  currentRotation: RotationEntry[];
  currentStrategy: RotationStrategy;
  constraints: Constraints;
  observedIssues: string[];
  today: Date;
}

const TOLERABLE_LOSS_T_HA = 11.2;

const ISSUE_PATTERNS: Record<string, RegExp> = {
  frost: /frost|freez|cold snap/i,
  heat: /heat|hot|scorch/i,
  drought: /drought|dry|wilt|irrigat/i,
  heavy_rain: /flood|standing water|waterlog|ponding|too wet|saturat/i,
  natural_events: /fire|smoke|hail|storm|tornado|hurricane/i,
  erosion: /erosion|gull|rill|runoff|wash/i,
  disease: /disease|blight|mold|mildew|rot\b|rust|leaf spot|fung/i,
  pest_cycle: /pest|insect|rootworm|beetle|aphid|nematode|borer|weevil|worm/i,
  vegetation_stress: /yellow|stunt|poor stand|low yield|stress|thin/i,
  soil_ph: /\bph\b|acid|lime|alkalin|salin/i,
  soil_organic_matter: /compaction|crust|organic matter|hardpan|tilth/i,
};

const level = (v: number, moderate: number, high: number): Severity => (v >= high ? "high" : v >= moderate ? "moderate" : "low");
const bump = (s: Severity): Severity => (s === "low" ? "moderate" : "high");
const monthsWhere = (pred: (m: number) => boolean) => Array.from({ length: 12 }, (_, i) => i + 1).filter(pred);
const monthOf = (mmdd: string | null) => (mmdd ? Number(mmdd.slice(0, 2)) : null);

export function assessHazards(x: HazardInput): Hazard[] {
  const c = x.climate.summary;
  const monthly = c.monthly;
  const interest = x.cropsOfInterest.map((id) => ({ id, crop: getCrop(id), s: x.stats.get(id)! }));
  const nowMonth = x.today.getUTCMonth() + 1;
  const upcomingMonths = [0, 1, 2].map((k) => ((nowMonth - 1 + k) % 12) + 1);
  const hazards: Hazard[] = [];

  const add = (h: Omit<Hazard, "upcoming" | "corroboratedByFarmer"> | null) => {
    if (h) hazards.push({ ...h, upcoming: h.months.some((m) => upcomingMonths.includes(m)), corroboratedByFarmer: [] });
  };

  // 1. Killing frost inside the growing season
  {
    const hit = interest.filter((i) => i.s.frostKillProbability >= 0.1);
    const worst = Math.max(0, ...interest.map((i) => i.s.frostKillProbability));
    add({
      id: "frost", category: "climate", title: "Killing frost during the growing season",
      severity: level(worst, 0.1, 0.3), likelihood: round(worst, 2),
      months: [monthOf(c.frost.lastSpring90), monthOf(c.frost.firstFall10)].filter((m): m is number => m !== null),
      metrics: { lastSpringFrostMedian: c.frost.lastSpringMedian, lastSpringFrost90: c.frost.lastSpring90, firstFallFrostMedian: c.frost.firstFallMedian, firstFallFrost10: c.frost.firstFall10, frostFreeDaysMedian: c.frost.frostFreeDaysMedian },
      affectedCrops: hit.map((i) => ({ cropId: i.id, impact: `killing frost (<= ${i.crop.frostKillC} degC) before maturity in ${Math.round(i.s.frostKillProbability * 100)}% of years` })),
      mitigation: ["Plant frost-sensitive crops after the 90% last-frost date", "Choose shorter-season varieties", "Watch 7-day forecasts around planting and harvest"],
      sources: ["nasa_power"],
    });
  }

  // 2. Heat stress at yield-forming stages
  {
    const hit = interest.filter((i) => i.s.heatDays >= 5);
    const worst = Math.max(0, ...interest.map((i) => i.s.heatDays));
    const sev = level(worst, 5, 15);
    add({
      id: "heat", category: "climate", title: "Heat stress during crop development",
      severity: c.trends.extremeHeatDays.significant && c.trends.extremeHeatDays.perDecade > 0 && sev !== "low" ? bump(sev) : sev,
      likelihood: null,
      months: monthsWhere((m) => monthly[m - 1].extremeHeatDays >= 0.5),
      metrics: { extremeHeatDaysPerYear: round(monthly.reduce((a, m) => a + m.extremeHeatDays, 0), 1), trendDaysPerDecade: c.trends.extremeHeatDays.perDecade },
      affectedCrops: hit.map((i) => ({ cropId: i.id, impact: `~${round(i.s.heatDays)} days above ${i.crop.heatStressC} degC per season` })),
      mitigation: ["Shift planting so flowering avoids the hottest weeks", "Use heat-tolerant hybrids/varieties", "Keep residue to lower soil temperature"],
      sources: ["nasa_power"],
    });
  }

  // 3. Growing-season water deficit / drought
  {
    const unmet = interest.map((i) => ({ ...i, u: unmetWaterShare(i.s, x.constraints) }));
    const hit = unmet.filter((i) => i.u >= 0.15);
    const worst = Math.max(0, ...unmet.map((i) => i.u));
    const sev = level(worst, 0.15, 0.35);
    const recentDry = c.recentYear.rootZoneWetnessZ <= -1;
    add({
      id: "drought", category: "water", title: "Growing-season water deficit",
      severity: recentDry && sev !== "high" ? bump(sev) : sev,
      likelihood: null,
      months: monthsWhere((m) => monthly[m - 1].waterBalanceMm <= -30),
      metrics: {
        aprSepWaterBalanceMm: monthly.slice(3, 9).reduce((a, m) => a + m.waterBalanceMm, 0),
        longestDrySpellDays: c.extremes.longestDrySpellDays,
        aridityIndex: c.annual.aridityIndex,
        recentYearRootZoneWetnessZ: c.recentYear.rootZoneWetnessZ,
        irrigation: x.constraints.irrigation,
      },
      affectedCrops: hit.map((i) => ({
        cropId: i.id,
        impact: `${Math.round(i.u * 100)}% of water demand unmet in a median year` + (i.s.floweringStressDays >= 3 ? `, ~${Math.round(i.s.floweringStressDays)} stress days around flowering` : ""),
      })),
      mitigation: ["Favour drought-tolerant crops in the driest slot", "Keep residue / no-till to conserve soil water", "Schedule irrigation by soil moisture, not calendar"],
      sources: ["nasa_power"],
    });
  }

  // 4. Extreme rainfall and waterlogging
  {
    const perYear = monthly.reduce((a, m) => a + m.heavyRainDays, 0);
    const poorlyDrained = /poorly/i.test(x.soil.drainageClass ?? "") || /D/.test(x.soil.hydrologicGroup ?? "");
    const lowSpots = (x.lowSpotSharePct ?? 0) >= 15;
    let sev = level(perYear, 5, 10);
    if (sev !== "high" && (x.soil.clayPct > 35 || poorlyDrained || lowSpots || (c.trends.heavyRainDays.significant && c.trends.heavyRainDays.perDecade > 0))) sev = bump(sev);
    add({
      id: "heavy_rain", category: "water", title: "Extreme rainfall and waterlogging",
      severity: sev, likelihood: null,
      months: monthsWhere((m) => monthly[m - 1].heavyRainDays >= 0.7),
      metrics: {
        heavyRainDaysPerYear: round(perYear, 1), max5DayPrecipMm: c.extremes.max5DayPrecipMm, wetDayP95Mm: c.extremes.wetDayP95Mm,
        trendDaysPerDecade: c.trends.heavyRainDays.perDecade, clayPct: x.soil.clayPct, drainageClass: x.soil.drainageClass,
        hydrologicGroup: x.soil.hydrologicGroup, lowSpotSharePct: x.lowSpotSharePct === null ? null : round(x.lowSpotSharePct, 0),
      },
      affectedCrops: interest.filter((i) => i.crop.wetTolerance === 1).map((i) => ({ cropId: i.id, impact: "sensitive to waterlogging and root diseases in saturated soil" })),
      mitigation: ["Check field drainage before wet months", "Avoid working wet soil (compaction)", "Prefer waterlogging-tolerant crops on low spots"],
      sources: ["nasa_power", "soil", "srtm"],
    });
  }

  // 5. Soil erosion (RUSLE screening estimate for the current rotation)
  {
    const loss = x.currentStrategy.metrics.estimatedSoilLossTHaYr;
    const months = x.vegetation?.bareMonths.filter((m) => monthly[m - 1].erosivityShare >= 0.08) ?? [];
    const bareCrops = x.currentRotation.filter((e) => !e.cover && !getCrop(e.crop).perennial);
    add({
      id: "erosion", category: "soil", title: "Soil erosion by water",
      severity: level(loss / TOLERABLE_LOSS_T_HA, 0.5, 1), likelihood: null,
      months: months.length ? months : monthsWhere((m) => monthly[m - 1].erosivityShare >= 0.12),
      metrics: { estimatedSoilLossTHaYr: loss, tolerableLossTHaYr: TOLERABLE_LOSS_T_HA, slopePct: x.slopePct, erodibilityK: x.soil.erodibilityK, rainfallErosivity: c.annual.rainfallErosivity, soilCoverFraction: x.currentStrategy.metrics.soilCoverFraction },
      affectedCrops: bareCrops.map((e) => ({ cropId: e.crop, impact: "soil left bare after harvest until the next planting" })),
      mitigation: ["Plant a cover crop after harvest", "Reduce tillage and keep residue", "Contour farming or grassed waterways on steeper zones"],
      sources: ["nasa_power", "soilgrids", "srtm", "modis_ndvi"],
    });
  }

  // 6. Humid-weather disease pressure
  {
    const seasonDays = monthly.slice(4, 9).reduce((a, m) => a + m.diseaseRiskDays, 0);
    add({
      id: "disease", category: "biotic", title: "Disease pressure from warm, humid weather",
      severity: level(seasonDays, 20, 40), likelihood: null,
      months: monthsWhere((m) => monthly[m - 1].diseaseRiskDays >= 4),
      metrics: { humidWarmDaysMaySep: round(seasonDays, 0) },
      affectedCrops: interest.filter((i) => i.crop.humidDiseases).map((i) => ({ cropId: i.id, impact: i.crop.humidDiseases })),
      mitigation: ["Rotate away from the same family for 2+ years", "Choose resistant varieties", "Scout after humid spells"],
      sources: ["nasa_power"],
    });
  }

  // 7. Pest/disease build-up from a narrow rotation
  {
    const fams = x.currentRotation.map((e) => getCrop(e.crop).family);
    const distinct = new Set(fams).size;
    if (fams.length && distinct <= 2) {
      add({
        id: "pest_cycle", category: "biotic", title: "Pest and disease build-up from a narrow rotation",
        severity: distinct === 1 ? "high" : "moderate", likelihood: null, months: [],
        metrics: { distinctFamilies: distinct, rotationLengthYears: fams.length },
        affectedCrops: x.currentRotation.map((e) => getCrop(e.crop)).filter((cr) => cr.keyPests).map((cr) => ({ cropId: cr.id, impact: `pests adapted to short rotations: ${cr.keyPests}` })),
        mitigation: ["Add a crop from a third plant family", "Use a cover crop from a different family"],
        sources: ["farmer"],
      });
    }
  }

  // 8. Recent vegetation stress seen from space
  if (x.vegetation?.latestSeasonAnomaly != null && x.vegetation.latestSeasonAnomaly <= -0.05) {
    const a = x.vegetation.latestSeasonAnomaly;
    add({
      id: "vegetation_stress", category: "vegetation", title: "Below-normal greenness in the last 12 months (MODIS NDVI)",
      severity: a <= -0.1 ? "high" : "moderate", likelihood: null, months: [],
      metrics: { ndviAnomaly: a, pixelsUsed: x.vegetation.pixelsUsed },
      affectedCrops: x.currentRotation.map((e) => ({ cropId: e.crop, impact: "recent canopy weaker than the multi-year normal for the same months" })),
      mitigation: ["Ground-truth: compare with yield maps and scouting notes", "Check for drought, nutrient or drainage problems in the low-NDVI period"],
      sources: ["modis_ndvi"],
    });
  }

  // 9. Soil chemistry constraints
  {
    const misfit = interest.filter((i) => x.soil.ph < i.crop.phMin || x.soil.ph > i.crop.phMax);
    if (misfit.length) {
      const gap = Math.max(...misfit.map((i) => Math.max(i.crop.phMin - x.soil.ph, x.soil.ph - i.crop.phMax)));
      add({
        id: "soil_ph", category: "soil", title: "Soil pH outside the preferred range of some crops",
        severity: gap > 0.5 ? "high" : "moderate", likelihood: null, months: [],
        metrics: { ph: x.soil.ph, source: x.soil.source },
        affectedCrops: misfit.map((i) => ({ cropId: i.id, impact: `prefers pH ${i.crop.phMin}-${i.crop.phMax}` })),
        mitigation: ["Confirm with a lab soil test", x.soil.ph < 6 ? "Lime to raise pH" : "Use acidifying fertilizers / elemental sulfur where economical"],
        sources: ["soil"],
      });
    }
    if (x.soil.organicMatterPct < 2) {
      add({
        id: "soil_organic_matter", category: "soil", title: "Low soil organic matter",
        severity: x.soil.organicMatterPct < 1 ? "high" : "moderate", likelihood: null, months: [],
        metrics: { organicMatterPct: x.soil.organicMatterPct, source: x.soil.source },
        affectedCrops: [],
        mitigation: ["High-residue crops and cover crops", "Reduce tillage", "Add manure or compost where available"],
        sources: ["soil"],
      });
    }
  }

  // 10. Long-term trends (POWER record; GRACE groundwater would strengthen the water signal)
  const t = c.trends;
  if (t.tmeanC.significant && t.tmeanC.perDecade > 0) {
    add({
      id: "trend_warming", category: "trend", title: "Warming trend", severity: "moderate", likelihood: null, months: [],
      metrics: { degCPerDecade: t.tmeanC.perDecade },
      affectedCrops: interest.filter((i) => i.crop.heatStressC <= 30).map((i) => ({ cropId: i.id, impact: "cool-season crop; heat stress likely to increase" })),
      mitigation: ["Revisit planting dates every few seasons", "Trial heat-tolerant varieties"],
      sources: ["nasa_power"],
    });
  }
  if ((t.rootZoneWetness.significant && t.rootZoneWetness.perDecade < 0) || (t.precipMm.significant && t.precipMm.perDecade < 0)) {
    add({
      id: "trend_drying", category: "trend", title: "Drying trend in rainfall or root-zone soil moisture", severity: "moderate", likelihood: null, months: [],
      metrics: { precipMmPerDecade: t.precipMm.perDecade, rootZoneWetnessPerDecade: t.rootZoneWetness.perDecade },
      affectedCrops: interest.filter((i) => i.crop.droughtTolerance === 1).map((i) => ({ cropId: i.id, impact: "drought-sensitive crop" })),
      mitigation: ["Build soil organic matter to raise water holding", "Plan for a drought-tolerant crop in the rotation"],
      sources: ["nasa_power"],
    });
  }

  // 11. Natural events reported nearby in the past year (NASA EONET)
  if (x.naturalEvents?.length) {
    const kinds = [...new Set(x.naturalEvents.map((e) => e.category))];
    const fireOrFlood = x.naturalEvents.filter((e) => e.category === "wildfires" || e.category === "floods");
    add({
      id: "natural_events", category: "climate", title: `Natural events nearby in the past year: ${kinds.join(", ")}`,
      severity: fireOrFlood.length >= 3 ? "high" : fireOrFlood.length > 0 ? "moderate" : "low", likelihood: null, months: [],
      metrics: { events: x.naturalEvents.length, nearestKm: Math.min(...x.naturalEvents.map((e) => e.distanceKm)), latest: x.naturalEvents.map((e) => e.date).sort().at(-1) ?? null },
      affectedCrops: x.currentRotation.map((e) => ({ cropId: e.crop, impact: x.naturalEvents!.slice(0, 2).map((e) => `${e.title} (${e.date}, ~${e.distanceKm} km)`).join("; ") })),
      mitigation: ["Keep firebreaks / clear dry residue near field edges", "Check insurance and local emergency alerts during the season"],
      sources: ["eonet"],
    });
  }

  // Farmer observations: attach to matching hazards, or report as their own hazard.
  for (const issue of x.observedIssues) {
    const ids = Object.entries(ISSUE_PATTERNS).filter(([, re]) => re.test(issue)).map(([id]) => id);
    const matched = hazards.filter((h) => ids.includes(h.id) || ids.some((id) => h.id.startsWith(id)));
    matched.forEach((h) => {
      h.corroboratedByFarmer.push(issue);
      if (h.severity === "low") h.severity = "moderate"; // field observation outweighs a regional signal
    });
    if (matched.length === 0) {
      hazards.push({
        id: `farmer_reported_${hazards.length}`, category: "biotic", title: `Farmer-reported: ${issue}`,
        severity: "moderate", likelihood: null, months: [], upcoming: false, metrics: {}, affectedCrops: [],
        mitigation: ["Needs local expert review: not detectable in the satellite/climate data used"], sources: ["farmer"],
        corroboratedByFarmer: [issue],
      });
    }
  }

  const order: Record<Severity, number> = { high: 0, moderate: 1, low: 2 };
  return hazards.sort((a, b) => order[a.severity] - order[b.severity]);
}

