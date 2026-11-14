// Deterministic plain-language texts from the pipeline result. This is the ONLY place where facts
// shown to the farmer are written: every sentence is filled in from result fields, never by a model.
import { getCrop } from "../crops";
import type { Hazard, PipelineOutput, RotationScores } from "../types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "04-27" -> "late April" */
export function dateWords(mmdd: string | null): string {
  if (!mmdd) return "an unknown date";
  const m = Number(mmdd.slice(0, 2));
  const d = Number(mmdd.slice(3, 5));
  return `${d <= 10 ? "early" : d <= 20 ? "mid" : "late"} ${MONTHS[m - 1]}`;
}

const monthList = (months: number[]) => months.map((m) => MONTHS[m - 1]).join(", ");
const cropName = (id: string) => getCrop(id).name.replace(/ \(.*\)$/, "");

const HAZARD_WORDS: Record<string, string> = {
  frost: "Frost", heat: "Very hot days", drought: "Dry periods", heavy_rain: "Heavy rain and standing water",
  erosion: "Soil washing away", disease: "Plant diseases in warm, wet weather", pest_cycle: "Pests building up because the same crops repeat",
  vegetation_stress: "Crops weaker than normal in the last year", soil_ph: "Soil acidity", soil_organic_matter: "Low soil organic matter",
  trend_warming: "Warming over the years", trend_drying: "Drying over the years", natural_events: "Fires, floods or storms nearby",
};
const SEVERITY_WORDS = { high: "serious", moderate: "some", low: "small" } as const;
const BENEFIT_WORDS: Record<Exclude<keyof RotationScores, "overall">, string> = {
  soilHealth: "healthier soil", erosion: "less soil washing away", pest: "fewer pest and disease problems", water: "less water needed", resilience: "less weather risk",
};

function hazardTitle(h: Hazard): string {
  return HAZARD_WORDS[h.id] ?? h.title.replace(/^Farmer-reported: /, "What you reported: ");
}

function cropSentence(r: PipelineOutput, id: string): string {
  const c = r.cropSuitability.find((x) => x.cropId === id);
  if (!c) return `${cropName(id)}: not checked.`;
  const fit = c.class === "good" ? "a good fit" : c.class === "marginal" ? "possible, with some risk" : "a poor fit";
  const parts = [
    `${cropName(id)} is ${fit} for this field.`,
    `In past seasons it reached harvest in ${Math.round(c.seasonFitProbability * 10)} of 10 years.`,
    c.harvestDate ? `Plant around ${dateWords(c.plantingDate)}, harvest around ${dateWords(c.harvestDate)}.` : `Plant around ${dateWords(c.plantingDate)}.`,
  ];
  if (c.frostKillProbability >= 0.1) parts.push(`Frost can kill it in about ${Math.round(c.frostKillProbability * 10)} of 10 years.`);
  if (c.heatStressDays >= 5) parts.push(`It gets about ${Math.round(c.heatStressDays)} very hot days in a season.`);
  if (c.floweringStressDays >= 3) parts.push(`It often lacks water around flowering, about ${Math.round(c.floweringStressDays)} days.`);
  if (!c.phFit) parts.push("Your soil acidity is outside what it likes.");
  return parts.join(" ");
}

function planSentence(r: PipelineOutput, id: string): string {
  const s = r.rotations.find((x) => x.id === id);
  if (!s) return "";
  return s.sequence.map((e) =>
    `Year ${e.year}: ${cropName(e.crop)} (plant ${dateWords(e.plantDate)}, harvest ${dateWords(e.harvestDate)})` +
    (e.cover ? `, then ${cropName(e.cover).toLowerCase()} as a cover crop` : "") + ".",
  ).join(" ");
}

function hazardSentence(h: Hazard): string {
  const crops = [...new Set(h.affectedCrops.map((a) => cropName(a.cropId)))];
  return [
    `${hazardTitle(h)}: ${SEVERITY_WORDS[h.severity]} risk.`,
    h.months.length >= 6 ? "Can happen in most months." : h.months.length ? `Most likely in ${monthList(h.months)}.` : "",
    crops.length ? `Affects ${crops.join(", ")}.` : "",
    h.mitigation[0] ? `What to do: ${h.mitigation[0]}.` : "",
  ].filter(Boolean).join(" ");
}

/** The 4 messages sent when an analysis finishes. */
export function reportMessages(r: PipelineOutput): string[] {
  const current = [...new Set(r.context.currentRotation.map((e) => e.crop))];
  const names = current.map(cropName).join(" and ");
  const source = r.context.rotationSource === "usda_cdl" ? `Satellite crop maps show ${names} on this field in past years. `
    : r.context.rotationSource === "assumed" ? `I could not check the crops you named, so as an example I checked ${names}. ` : "";
  const crops = source + current.slice(0, 2).map((id) => cropSentence(r, id)).join(" ");
  const unresolved = r.context.unresolvedCrops.length ? ` I could not check ${r.context.unresolvedCrops.join(", ")} yet.` : "";

  const best = r.rotations.find((s) => s.id === r.recommendation.rotationId)!;
  const now = r.rotations[0];
  let plan: string;
  if (best.isCurrent) {
    plan = "Your current plan is already the best choice for what matters to you.";
  } else {
    const gains = (Object.keys(BENEFIT_WORDS) as (keyof typeof BENEFIT_WORDS)[])
      .map((k) => [k, best.scores[k] - now.scores[k]] as const).filter(([, d]) => d >= 5).sort((a, b) => b[1] - a[1]);
    plan = `Suggested plan: ${planSentence(r, best.id)}` + (gains.length ? ` Main benefit: ${gains.slice(0, 2).map(([k]) => BENEFIT_WORDS[k]).join(" and ")}.` : "");
  }
  plan += ` This plan stayed the best in ${Math.round(r.recommendation.stability.agreement * r.recommendation.stability.runs)} of ${r.recommendation.stability.runs} tests.`;
  if (best.programs.length) plan += " It may qualify for US farm support programs (NRCS) for this practice.";

  const dangers = [...r.hazards].filter((h) => h.severity !== "low")
    .sort((a, b) => Number(b.upcoming) - Number(a.upcoming)).slice(0, 2).map(hazardSentence);
  const pest = r.pestCalendar[0] ? [`Check for ${r.pestCalendar[0].pest.toLowerCase()} around ${dateWords(r.pestCalendar[0].date)}: ${r.pestCalendar[0].action}.`] : [];
  const watch = dangers.length || pest.length ? [...dangers, ...pest].join(" ") : "No serious dangers found for this field.";

  return [
    `Your farm report. ${crops}${unresolved}`,
    plan,
    `Things to watch: ${watch}`,
    "These are suggestions from satellite and weather data. Please compare them with your own experience or a local farm advisor. You can reply with any question, for example which crops sell best and where to sell.",
  ];
}

const money = (v: number, perUnit: boolean) => `$${perUnit && v < 100 ? v.toFixed(2) : Math.round(v)}`;

/**
 * Answer to "how / where / when should I sell?": written from result.market only (null when no market data).
 * Covers the farmer's own crops that have market data, plus the best-earning crop.
 */
export function marketMessages(r: PipelineOutput): string[] | null {
  const m = r.market;
  if (!m || m.crops.length === 0) return null;
  const own = new Set(r.context.currentRotation.map((e) => e.crop));
  const picked = [...m.crops.filter((c) => own.has(c.cropId)), ...m.crops.filter((c) => c.cropId === m.ranking[0]?.cropId && !own.has(c.cropId))].slice(0, 3);
  const crops = picked.length ? picked : m.crops.slice(0, 2);

  const prices = crops.map((c) => {
    const unit = c.price.usdPerBushel ? "bushel" : "tonne";
    const p = c.price.usdPerBushel ?? c.price.usdPerTonne;
    return `${cropName(c.cropId)} in ${MONTHS[c.harvestMonth - 1]}: usually ${money(p.p10, true)} to ${money(p.p90, true)} per ${unit}, most often about ${money(p.p50, true)}.`;
  });

  const timing = crops.map((c) => {
    const b = c.bestSellMonth;
    if (!b || b.premiumPct < 2) return `${cropName(c.cropId)}: selling at harvest is usually about as good as selling later.`;
    return `${cropName(c.cropId)}: prices are usually highest in ${MONTHS[b.month - 1]}, about ${Math.round(b.premiumPct)}% above harvest time. Storing until then can pay if storage costs less than that.`;
  });

  // Which crops pay the most after harvest: ranked by the better of selling at harvest or in the usual best month.
  const value = (c: (typeof m.crops)[number]) => Math.max(c.grossRevenuePerHa?.p50 ?? 0, c.bestMonthRevenuePerHa ?? 0);
  const best = m.crops.filter((c) => c.grossRevenuePerHa).sort((a, b) => value(b) - value(a)).slice(0, 3);
  const ranked = best.map((c, i) => {
    const atHarvest = `about ${money(c.grossRevenuePerHa!.p50, false)} if sold at harvest (${MONTHS[c.harvestMonth - 1]})`;
    const later = c.bestMonthRevenuePerHa && c.bestSellMonth && c.bestSellMonth.premiumPct >= 2
      ? `, about ${money(c.bestMonthRevenuePerHa, false)} if stored and sold in ${MONTHS[c.bestSellMonth.month - 1]}` : "";
    return `${i + 1}. ${cropName(c.cropId)}: ${atHarvest}${later}.`;
  });
  const demand = crops.flatMap((c) => {
    if (!c.demand || c.demand.stocksVsUsual === "normal") return [];
    return [`US ${cropName(c.cropId).toLowerCase()} stocks are ${c.demand.stocksVsUsual} than usual, which tends to ${c.demand.stocksVsUsual === "lower" ? "support" : "weigh on"} prices.`];
  });

  return [
    ranked.length ? `Crops that pay the most after harvest on this field (per hectare, before costs): ${ranked.join(" ")}` : "",
    `Prices at harvest (world market, ${m.dollarsOf.slice(0, 4)} dollars): ${prices.join(" ")}`,
    `When to sell: ${timing.join(" ")}` + (demand.length ? ` ${demand.join(" ")}` : ""),
    "Where to sell: I do not have a list of local buyers. Ask several nearby grain elevators, cooperatives or processors for their price before you sell, and compare. These are ranges from past prices, not promises.",
  ].filter((t) => t.trim().length > 0);
}

export interface Snippet { id: string; title: string; text: string }

/** Pre-written answers for follow-up questions; the model may only choose among these ids. */
export function factSnippets(r: PipelineOutput): Snippet[] {
  const out: Snippet[] = [];
  for (const c of r.cropSuitability) out.push({ id: `crop:${c.cropId}`, title: `How ${cropName(c.cropId)} would do here, planting and harvest dates`, text: cropSentence(r, c.cropId) });
  for (const s of r.rotations) {
    out.push({ id: `plan:${s.id}`, title: `${s.name}${s.isCurrent ? " (what you do now)" : ""}`, text: `${s.isCurrent ? "Your current plan" : s.name}: ${planSentence(r, s.id)}` + (s.benefits[0] && !s.isCurrent ? ` ${s.benefits[0]}` : "") });
  }
  for (const h of r.hazards) out.push({ id: `hazard:${h.id}`, title: hazardTitle(h), text: hazardSentence(h) });
  for (const e of r.pestCalendar) out.push({ id: `pest:${e.pestId}`, title: `${e.pest} timing`, text: `${e.pest}: ${e.event.replace(/ \(.*\)$/, "")} around ${dateWords(e.date)} (between ${dateWords(e.earliest)} and ${dateWords(e.latest)}). ${e.action}.` });
  out.push({
    id: "soil", title: "Soil type, drainage, acidity",
    text: `Your soil is ${r.soil.texture}` + (r.soil.drainageClass ? `, ${r.soil.drainageClass.toLowerCase()}` : "") + `, with pH ${r.soil.ph} and ${r.soil.organicMatterPct}% organic matter.`,
  });
  out.push({
    id: "climate", title: "Frost dates, rain, hot days",
    text: (r.climate.frost.lastSpringMedian ? `The last spring frost is usually around ${dateWords(r.climate.frost.lastSpringMedian)} and the first fall frost around ${dateWords(r.climate.frost.firstFallMedian)}. ` : "Frost is rare here. ") +
      `Rain is about ${r.climate.annual.precipMm} mm a year.`,
  });
  out.push({ id: "reliability", title: "How reliable this report is", text: `Confidence: ${r.confidence.level}. ${r.disclaimer}` });
  return out;
}

/** "about 64.0 hectares (158.0 acres)" */
export function farmSize(areaHa: number): string {
  return `about ${areaHa.toFixed(1)} hectares (${(areaHa * 2.471).toFixed(1)} acres)`;
}
