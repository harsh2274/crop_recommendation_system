// What the PDF report says: blocks of text, tables and charts written by code from the pipeline result. Same rule
// as the SMS texts: every value comes from result fields, nothing from a model. Strings are English here; the
// farmer's agent translates them once (localizeReport) and the PDF renderer only draws what it is given.
import { resolveCropId } from "../crops";
import type { Env } from "../env";
import type { PipelineOutput, RotationScores } from "../types";
import { translate } from "../sms/ai";
import { cropName, dateWords, farmSize, hazardTitle, marketMessages, planSentence, reportMessages } from "../sms/facts";
import { WATER_WORDS } from "../sms/flow";
import { toWinAnsi } from "./pdf";

export type Tone = "good" | "warn" | "bad" | "blue" | "amber" | "accent" | "grey";

export type Block =
  | { kind: "title"; text: string; sub: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "map"; caption: string }
  | { kind: "facts"; rows: [string, string][] }
  | { kind: "table"; header: string[]; rows: string[][]; widths: number[] } // widths: shares of the line
  | { kind: "bars"; title: string; unit: string; max: number; items: { label: string; value: number; low?: number; high?: number; tone: Tone; note: string }[] }
  | { kind: "monthly"; title: string; months: string[]; series: { label: string; tone: Tone; values: (number | null)[] }[] }
  | { kind: "calendar"; title: string; months: string[]; rows: { label: string; start: number; end: number; tone: Tone }[] }; // day of year 0..364

export interface ReportDoc {
  generatedAt: string; // of the pipeline result the report is made from
  language: string | null; // language the strings are in (null = English)
  ring: [number, number][]; // farm boundary, WGS84 [lon, lat]
  ui: { title: string; open: string; download: string; fallback: string; note: string }; // texts of the web page that holds the PDF; note: "" unless the PDF stays in English
  blocks: Block[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const doy = (mmdd: string) => MONTH_START[Number(mmdd.slice(0, 2)) - 1] + Number(mmdd.slice(3, 5)) - 1;
const CLASS_TONE = { good: "good", marginal: "warn", poor: "bad" } as const;
const CLASS_WORDS = { good: "good fit", marginal: "possible, some risk", poor: "poor fit" } as const;
const SEVERITY_WORDS = { high: "serious", moderate: "some", low: "small" } as const;
const SCORE_WORDS: [Exclude<keyof RotationScores, "overall">, string][] = [
  ["soilHealth", "Soil health"], ["erosion", "Less erosion"], ["pest", "Fewer pests"], ["water", "Less water"], ["resilience", "Less weather risk"],
];
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const price = (v: number, perBushel: boolean) => (perBushel ? `$${v.toFixed(2)}` : usd(v));

/** The whole report for one pipeline result and the farm boundary it was made for. */
export function buildReport(r: PipelineOutput, ring: [number, number][]): ReportDoc {
  const blocks: Block[] = [];
  const add = (...b: Block[]) => blocks.push(...b);
  const current = [...new Set(r.context.currentRotation.map((e) => e.crop))];
  const best = r.rotations.find((s) => s.id === r.recommendation.rotationId)!;
  const region = r.field.region;
  const season = r.context.currentSeason?.crop ?? null; // as the farmer named it

  // ---- farm
  add({ kind: "title", text: "Farm report", sub: `Made on ${r.generatedAt.slice(0, 10)} from NASA satellite and weather data` });
  add({ kind: "map", caption: `Your farm, ${farmSize(r.field.areaHa)}. Satellite image: Esri World Imagery.` });
  add({ kind: "heading", text: "Your farm" });
  const frost = r.climate.frost;
  add({
    kind: "facts",
    rows: [
      ["Location", `${r.field.centroid.lat.toFixed(4)}, ${r.field.centroid.lon.toFixed(4)}` + (region ? ` (${[region.county, region.admin1, region.country].filter(Boolean).join(", ")})` : "")],
      ["Size", farmSize(r.field.areaHa)],
      ...(season ? [["Crop this season", resolveCropId(season) ? cropName(resolveCropId(season)!) : season] as [string, string]] : []),
      ["Rotation checked", r.context.currentRotation.map((e) => cropName(e.crop)).join(" then ") +
        (r.context.rotationSource === "usda_cdl" ? " (from satellite crop maps)" : r.context.rotationSource === "assumed" ? " (example, crops not given)" : "")],
      ["Water", WATER_WORDS[r.context.constraints.irrigation]],
      ...(r.field.elevationM !== null ? [["Height and slope", `${Math.round(r.field.elevationM)} m above sea level` + (r.field.slopePct !== null ? `, average slope ${r.field.slopePct}%` : "")] as [string, string]] : []),
      ["Soil", `${r.soil.texture}, pH ${r.soil.ph}, ${r.soil.organicMatterPct}% organic matter` + (r.soil.drainageClass ? `, ${r.soil.drainageClass.toLowerCase()}` : "")],
      ["Climate", `${r.climate.annual.precipMm} mm of rain a year, average ${r.climate.annual.tmeanC} degrees C`],
      ["Frost", frost.lastSpringMedian ? `last spring frost around ${dateWords(frost.lastSpringMedian)}, first fall frost around ${dateWords(frost.firstFallMedian)}` : "frost is rare here"],
      ["Report confidence", r.confidence.level],
    ],
  });
  if (r.fieldHistory?.length) {
    add({ kind: "paragraph", text: "Crops seen on this field in past years (USDA satellite crop maps):" });
    add({ kind: "table", header: ["Year", "Crop"], widths: [0.2, 0.8], rows: r.fieldHistory.map((h) => [String(h.year), h.category]) });
  }

  // ---- crops
  add({ kind: "heading", text: "Which crops fit this field" });
  const main = r.cropSuitability.filter((c) => c.role !== "cover").sort((a, b) => b.suitability - a.suitability);
  add({
    kind: "bars", title: "How well each crop fits this field (0 to 100)", unit: "", max: 100,
    items: main.map((c) => ({ label: cropName(c.cropId), value: c.suitability, tone: CLASS_TONE[c.class], note: CLASS_WORDS[c.class] })),
  });
  const shown = [...new Set([...current, ...main.slice(0, 8).map((c) => c.cropId)])].flatMap((id) => r.cropSuitability.filter((c) => c.cropId === id));
  add({
    kind: "table", header: ["Crop", "Fit", "Reached harvest", "Plant", "Harvest", "Extra water needed"], widths: [0.2, 0.17, 0.15, 0.15, 0.15, 0.18],
    rows: shown.map((c) => [cropName(c.cropId), CLASS_WORDS[c.class], `${Math.round(c.seasonFitProbability * 10)} of 10 years`, dateWords(c.plantingDate),
      c.harvestDate ? dateWords(c.harvestDate) : "-", `${c.irrigationNeedMm.median} mm`]),
  });
  for (const c of shown.filter((x) => current.includes(x.cropId) && x.limitingFactors.length)) {
    add({ kind: "paragraph", text: `${cropName(c.cropId)}, what limits it here: ${c.limitingFactors.join("; ")}.` });
  }

  // ---- calendar
  const rows: Extract<Block, { kind: "calendar" }>["rows"] = [];
  for (const id of [...new Set([...current, ...best.sequence.map((e) => e.crop)])]) {
    const c = r.cropSuitability.find((x) => x.cropId === id);
    if (c?.harvestDate) rows.push({ label: cropName(id), start: doy(c.plantingDate), end: doy(c.harvestDate), tone: "good" });
  }
  // A cover crop stays on the field until it is ended about 2 weeks before the next main crop is planted.
  best.sequence.forEach((e, i) => {
    const next = best.sequence[(i + 1) % best.sequence.length];
    const cover = e.cover && r.cropSuitability.find((x) => x.cropId === e.cover);
    const label = cover ? `${cropName(cover.cropId)} (cover crop)` : "";
    if (cover && !rows.some((x) => x.label === label)) rows.push({ label, start: doy(cover.plantingDate), end: (doy(next.plantDate) - 14 + 365) % 365, tone: "accent" });
  });
  if (rows.length) add({ kind: "calendar", title: "When to plant and harvest (bar = planting to harvest; cover crops: planting to ending it in spring)", months: MONTHS, rows });

  // ---- plans
  add({ kind: "heading", text: "Crop plans compared" });
  add({
    kind: "bars", title: "Overall score of each plan for what matters to you (0 to 100)", unit: "", max: 100,
    items: r.rotations.map((s) => ({
      label: s.name, value: s.scores.overall, tone: s.id === best.id ? "good" : "blue",
      note: s.id === best.id ? "suggested" : s.isCurrent ? "what you do now" : "",
    })),
  });
  add({
    kind: "table", header: ["Plan", ...SCORE_WORDS.map(([, w]) => w), "Overall"], widths: [0.25, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125],
    rows: r.rotations.map((s) => [s.name, ...SCORE_WORDS.map(([k]) => String(s.scores[k])), String(s.scores.overall)]),
  });
  for (const s of r.rotations) {
    const tag = s.id === best.id ? " (suggested)" : s.isCurrent ? " (what you do now)" : "";
    add({ kind: "paragraph", text: `${s.name}${tag}: ${planSentence(r, s.id)}` + (s.benefits.length ? ` Benefits: ${s.benefits.slice(0, 2).join(" ")}` : "") + (s.risks.length ? ` Risks: ${s.risks.slice(0, 2).join(" ")}` : "") });
  }
  const stab = r.recommendation.stability;
  add({ kind: "paragraph", text: `The suggested plan stayed the best in ${Math.round(stab.agreement * stab.runs)} of ${stab.runs} tests with changed weather and crop values.` });

  // ---- weather
  add({ kind: "heading", text: "Weather and water" });
  const m = r.climate.monthly;
  add({
    kind: "monthly", title: "Rain and the water crops lose to the air, by month (mm)", months: MONTHS,
    series: [{ label: "Rain", tone: "blue", values: m.map((x) => x.precipMm) }, { label: "Water demand (ET0)", tone: "amber", values: m.map((x) => x.et0Mm) }],
  });
  add({
    kind: "monthly", title: "Temperature by month (degrees C)", months: MONTHS,
    series: [{ label: "Night low", tone: "blue", values: m.map((x) => x.tminC) }, { label: "Day high", tone: "bad", values: m.map((x) => x.tmaxC) }],
  });
  const ex = r.climate.extremes;
  add({
    kind: "facts",
    rows: [
      ["Frost-free days", `${frost.frostFreeDaysMedian} in a typical year`],
      ["Longest dry spell", `${ex.longestDrySpellDays} days in a typical April to September`],
      ["Wettest 5 days", `${ex.max5DayPrecipMm} mm in a typical year`],
      ["Last year's rain", `${r.climate.recentYear.precipAnomalyPct > 0 ? "+" : ""}${r.climate.recentYear.precipAnomalyPct}% compared with normal (${r.climate.recentYear.year})`],
      ...(r.climate.trends.tmeanC.significant ? [["Warming", `${r.climate.trends.tmeanC.perDecade} degrees C per 10 years`] as [string, string]] : []),
    ],
  });

  // ---- vegetation
  const v = r.vegetation;
  if (v && v.monthlyNdvi.some((x) => x !== null)) {
    add({ kind: "heading", text: "How green your field is (NASA MODIS)" });
    add({ kind: "monthly", title: "Greenness by month (NDVI: 0 = bare soil, 1 = dense green crop)", months: MONTHS, series: [{ label: "Greenness (NDVI)", tone: "good", values: v.monthlyNdvi }] });
    const notes = [
      v.peakMonth ? `Your field is usually greenest in ${MONTHS[v.peakMonth - 1]}.` : "",
      v.bareMonths.length ? `It is mostly bare in ${v.bareMonths.map((x) => MONTHS[x - 1]).join(", ")}.` : "",
      v.latestSeasonAnomaly !== null && Math.abs(v.latestSeasonAnomaly) >= 0.03 ? `In the last 12 months it was ${v.latestSeasonAnomaly > 0 ? "greener" : "less green"} than usual (NDVI ${v.latestSeasonAnomaly > 0 ? "+" : ""}${v.latestSeasonAnomaly}).` : "",
    ].filter(Boolean);
    if (notes.length) add({ kind: "paragraph", text: notes.join(" ") });
  }

  // ---- dangers and pests
  add({ kind: "heading", text: "Dangers to watch" });
  const hazards = [...r.hazards].sort((a, b) => ["high", "moderate", "low"].indexOf(a.severity) - ["high", "moderate", "low"].indexOf(b.severity));
  if (hazards.length) {
    add({
      kind: "table", header: ["Danger", "Risk", "When", "What to do"], widths: [0.24, 0.1, 0.22, 0.44],
      rows: hazards.map((h) => [hazardTitle(h), SEVERITY_WORDS[h.severity], h.months.length >= 6 ? "most months" : h.months.map((x) => MONTHS[x - 1]).join(", ") || "-", h.mitigation[0] ?? "-"]),
    });
  } else add({ kind: "paragraph", text: "No serious dangers found for this field." });
  if (r.pestCalendar.length) {
    add({ kind: "paragraph", text: "Pest checks (from degree-day models; local trap counts come first):" });
    add({
      kind: "table", header: ["Pest", "Check around", "Window", "What to do"], widths: [0.2, 0.16, 0.24, 0.4],
      rows: r.pestCalendar.map((e) => [e.pest, dateWords(e.date), `${dateWords(e.earliest)} to ${dateWords(e.latest)}`, e.action]),
    });
  }

  // ---- market
  const mk = r.market;
  if (mk && mk.crops.length) {
    add({ kind: "heading", text: "Market: what crops are worth after harvest" });
    const valued = mk.crops.filter((c) => c.grossRevenuePerHa).sort((a, b) => b.grossRevenuePerHa!.p50 - a.grossRevenuePerHa!.p50);
    if (valued.length) {
      add({
        kind: "bars", title: `Value per hectare if sold at harvest, before costs (US dollars of ${mk.dollarsOf.slice(0, 4)}; line = usual range)`, unit: "$", max: 0,
        items: valued.map((c) => ({ label: cropName(c.cropId), value: c.grossRevenuePerHa!.p50, low: c.grossRevenuePerHa!.p10, high: c.grossRevenuePerHa!.p90, tone: "accent", note: "" })),
      });
    }
    add({
      kind: "table", header: ["Crop", "Price at harvest (usual)", "Range", "Best month to sell", "Value per hectare, sold in the best month"], widths: [0.18, 0.22, 0.2, 0.2, 0.2],
      rows: mk.crops.map((c) => {
        const bu = !!c.price.usdPerBushel;
        const p = c.price.usdPerBushel ?? c.price.usdPerTonne;
        const b = c.bestSellMonth;
        return [
          cropName(c.cropId),
          `${price(p.p50, bu)} per ${bu ? "bushel" : "tonne"} (${MONTHS[c.harvestMonth - 1]})`,
          `${price(p.p10, bu)} to ${price(p.p90, bu)}`,
          b && b.premiumPct >= 2 ? `${MONTHS[b.month - 1]}, about ${Math.round(b.premiumPct)}% more` : "at harvest",
          c.grossRevenuePerHa ? usd(Math.max(c.grossRevenuePerHa.p50, c.bestMonthRevenuePerHa ?? 0)) : "-",
        ];
      }),
    });
    for (const n of mk.notes) add({ kind: "paragraph", text: n });
  }

  // ---- the texts the farmer received
  add({ kind: "heading", text: "Your text-message report" });
  for (const t of [...reportMessages(r), ...(marketMessages(r) ?? [])]) add({ kind: "paragraph", text: t });

  // ---- sources
  add({ kind: "heading", text: "Where the data comes from" });
  add({
    kind: "table", header: ["Data", "From", "Status"], widths: [0.5, 0.3, 0.2],
    rows: r.dataSources.map((s) => [s.dataset, s.provider, s.status === "ok" ? "used" : s.status === "degraded" ? "partly used" : "not available"]),
  });
  add({ kind: "paragraph", text: `Report confidence: ${r.confidence.level}. ${r.confidence.reasons.join(" ")}` });
  add({ kind: "paragraph", text: r.disclaimer });

  return {
    generatedAt: r.generatedAt,
    language: null,
    ring,
    ui: {
      title: "Your farm report", open: "Open the PDF", download: "Download the PDF", fallback: "If the report does not show here, use the buttons above.",
      note: "",
    },
    blocks,
  };
}

// ---------------------------------------------------------------- translation

/** Apply f to every string a reader sees (numbers-only strings are left as they are). */
export function mapStrings(doc: ReportDoc, f: (s: string) => string): ReportDoc {
  const t = (s: string) => (/\p{L}/u.test(s) ? f(s) : s);
  const blocks = doc.blocks.map((b): Block => {
    switch (b.kind) {
      case "title": return { ...b, text: t(b.text), sub: t(b.sub) };
      case "heading": case "paragraph": return { ...b, text: t(b.text) };
      case "map": return { ...b, caption: t(b.caption) };
      case "facts": return { ...b, rows: b.rows.map(([k, v]): [string, string] => [t(k), t(v)]) };
      case "table": return { ...b, header: b.header.map(t), rows: b.rows.map((row) => row.map(t)) };
      case "bars": return { ...b, title: t(b.title), items: b.items.map((i) => ({ ...i, label: t(i.label), note: i.note && t(i.note) })) };
      case "monthly": return { ...b, title: t(b.title), months: b.months.map(t), series: b.series.map((s) => ({ ...s, label: t(s.label) })) };
      case "calendar": return { ...b, title: t(b.title), months: b.months.map(t), rows: b.rows.map((x) => ({ ...x, label: t(x.label) })) };
    }
  });
  return { ...doc, blocks, ui: { title: t(doc.ui.title), open: t(doc.ui.open), download: t(doc.ui.download), fallback: t(doc.ui.fallback), note: t(doc.ui.note) } };
}

const CHUNK_CHARS = 1800; // English per translation call
const ENGLISH_PDF_NOTE = "The PDF is in English because it cannot show the letters of your language yet. Your text messages are in your language.";

/**
 * Translate every string once (unique strings, in parallel batches, number-checked by translate()). The web page
 * (HTML) shows any script, so its texts are translated first. The PDF font draws Latin scripts only (WinAnsi): for
 * other scripts (e.g. Hindi) the PDF stays in English, without translating it, and the page says so. A single PDF
 * string the font cannot draw also stays in English, so the PDF never shows broken characters.
 */
export async function localizeReport(env: Env, language: string | null, doc: ReportDoc): Promise<ReportDoc> {
  if (!language || /^english\b/i.test(language)) return doc;
  const uiKeys = Object.keys(doc.ui) as (keyof ReportDoc["ui"])[];
  const uiEnglish = [...uiKeys.filter((k) => doc.ui[k]).map((k) => doc.ui[k]), ENGLISH_PDF_NOTE];
  const uiTranslated = await translate(env, language, uiEnglish);
  const page = new Map(uiEnglish.map((s, i) => [s, uiTranslated[i]]));
  const ui = Object.fromEntries(uiKeys.map((k) => [k, page.get(doc.ui[k]) ?? doc.ui[k]])) as ReportDoc["ui"];
  const englishPdf = { ...doc, language: null, ui: { ...ui, note: page.get(ENGLISH_PDF_NOTE)! } };
  if (uiTranslated.some((t, i) => t !== uiEnglish[i] && toWinAnsi(t) === null)) return englishPdf; // a script the PDF cannot draw

  const unique = new Set<string>();
  mapStrings(doc, (s) => (unique.add(s), s));
  const list = [...unique];
  const batches: string[][] = [];
  let size = Infinity;
  for (const s of list) {
    if (size + s.length > CHUNK_CHARS) batches.push([]), (size = 0);
    batches.at(-1)!.push(s);
    size += s.length;
  }
  const translated = (await Promise.all(batches.map((b) => translate(env, language, b)))).flat();
  const pdf = new Map(list.map((s, i) => [s, toWinAnsi(translated[i] ?? s) ?? s]));
  const blocks = mapStrings(doc, (s) => pdf.get(s) ?? s).blocks;
  if (JSON.stringify(blocks) === JSON.stringify(doc.blocks)) return englishPdf; // nothing could be translated
  return { ...doc, blocks, language, ui: { ...ui, note: "" } };
}
