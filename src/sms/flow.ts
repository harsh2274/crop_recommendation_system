// The SMS conversation as a deterministic state machine. Code decides what to ask and writes every
// text (in English; ai.translate() localizes it). The model is used only by understand(), which turns
// the farmer's message into validated fields.
import type { Env } from "../env";
import { extract } from "./ai";
import { dateWords, farmSize, type Snippet } from "./facts";
import { PRIORITIES, rotationOf, type FarmerProfile, type Priority } from "./profile";

export type Step = "crops" | "map" | "rotation" | "stage" | "issues" | "water" | "priorities" | "confirm" | "done";
const OPTIONAL_STEPS = ["rotation", "stage", "issues", "water", "priorities"] as const;

const STAGES = ["just planted", "growing", "flowering", "ready to harvest", "harvested"] as const;
const WATER = ["none", "limited", "full"] as const;
const PRIORITY_CHOICES: Priority[] = ["income", "water", "soil", "pests", "weather"];
const PRIORITY_WORDS: Record<Priority, string> = { income: "more income", water: "saving water", soil: "healthier soil", pests: "fewer pests", weather: "less weather risk", erosion: "less soil washing away" };
export const WATER_WORDS = { none: "rain only", limited: "some irrigation", full: "enough irrigation" } as const;

export const TEXT = {
  intro: "Hello! I am Farm Helper. I use NASA satellite and weather data to help you plan your crops.",
  notUnderstood: "Sorry, I did not understand.",
  busy: "I am still calculating your farm report. It will arrive soon.",
  running: "Thank you. I am calculating your farm report now. This takes about one minute.",
  outcomeSaved: "Thank you for telling me how it went. I saved it to improve future advice.",
  answerLater: "I can answer questions once your farm report is ready.",
  noInfo: "I do not have that information in your farm report. A local farm advisor can help with that question.",
  noMarket: "I do not have market prices for your crops yet. Ask nearby grain elevators, cooperatives or processors for their prices and compare them before you sell.",
  askMore: "You can ask me about your crops, the suggested plan, dangers, pests, soil or weather. Reply PDF for the complete report, or NEW to make a new report.",
  failed: "Sorry, I could not finish your farm report because of a problem on our side. Please reply YES later to try again.",
  reset: "Your information was deleted. Send any message to start again.",
  turnFailed: "Sorry, something went wrong on our side. Please send your message again.",
  redraw: "Here is your map link again. Draw your farm again and press Continue: I will use the new shape. If you do not need to change it, just answer my last question.",
  redrawLater: "I am calculating your farm report now. After it arrives, reply LINK if you want to redraw your farm.",
  shapeChanged: "Your farm shape changed while I was calculating, so this report is for the old shape. Reply YES to make a new report with the new shape.",
  pdfOffer: "Would you like a complete report as a PDF, with a map of your farm, charts and all the results? Reply YES or PDF and I will send you a link.",
  pdfPreparing: "I am preparing your complete report now. The link will arrive in a moment.",
  pdfLink: "Here is your complete farm report. Open the link to see it and download the PDF:",
  boundary: (ha: number) => `Thank you! I received your farm: ${farmSize(ha)}.`,
};

export function nextStep(p: FarmerProfile): Step {
  if (p.crops.length === 0) return "crops";
  if (!p.boundary) return "map";
  for (const s of OPTIONAL_STEPS) if (!p.asked.includes(s)) return s;
  return p.analysisStatus === "done" || p.analysisStatus === "running" ? "done" : "confirm";
}

export function question(step: Step, p: FarmerProfile): string | null {
  const crop = p.crops[0] ?? "crop";
  switch (step) {
    case "crops": return "What crop or crops are you growing on this field now?";
    case "map": return "Please mark your farm on the map: open the link, allow location, tap each corner of your farm, then press Continue. If the link does not work, reply LINK.";
    case "rotation": return "What did you grow on this field last year, and the year before?";
    case "stage": return `How far along is your ${crop}? Reply 1 just planted, 2 growing, 3 flowering, 4 ready to harvest, 5 harvested. Or tell me the planting date.`;
    case "issues": return "Do you see any problems, like pests, yellow or sick leaves, standing water, very dry soil, or soil washing away? Reply NO if none.";
    case "water": return "How does this field get water? Reply 1 rain only, 2 some irrigation, 3 enough irrigation.";
    case "priorities": return "What matters most to you? Reply one or more numbers: 1 more income, 2 saving water, 3 healthier soil, 4 fewer pests, 5 less weather risk.";
    case "confirm": return summary(p);
    case "done": return null;
  }
}

function summary(p: FarmerProfile): string {
  const show = (v: string | null | undefined) => v || "not given";
  return [
    "Please check:",
    `crops now: ${show(p.crops.join(", "))};`,
    `rotation: ${show(rotationOf(p).join(" then "))};`,
    `stage: ${show(p.plantingDate ? `planted around ${dateWords(p.plantingDate.slice(5))}` : p.growthStage)};`,
    `problems: ${show(p.issues.join(", ") || (p.asked.includes("issues") ? "none" : ""))};`,
    `water: ${show(p.irrigation ? WATER_WORDS[p.irrigation] : "")};`,
    `most important: ${show(p.priorities.map((x) => PRIORITY_WORDS[x]).join(", "))};`,
    `farm: ${p.boundary ? farmSize(p.boundary.areaHa) : "not marked"}.`,
    "Reply YES to start the report, or tell me what to change.",
  ].join(" ");
}

// ---------------------------------------------------------------- understanding the farmer

export interface Understanding {
  language: string;
  intent: "answer" | "dont_know" | "yes" | "no" | "question" | "resend_link" | "new_report" | "report_outcome" | "market" | "pdf_report" | "other";
  crops: string[];
  pastCrops: string[];
  growthStage: string;
  plantingDate: string;
  issues: string[];
  irrigation: string;
  priorities: string[];
  topics: string[];
}

const EMPTY: Understanding = { language: "", intent: "other", crops: [], pastCrops: [], growthStage: "", plantingDate: "", issues: [], irrigation: "", priorities: [], topics: [] };
const INTENTS = ["answer", "dont_know", "yes", "no", "question", "resend_link", "new_report", "report_outcome", "market", "pdf_report", "other"] as const;

export async function understand(env: Env, p: FarmerProfile, step: Step, text: string, snippets: Snippet[]): Promise<Understanding> {
  const system = [
    "You read one text message from a farmer and record only what it explicitly says. Never guess or add information. Leave a field empty when the message does not state it.",
    `The farmer was just asked: ${JSON.stringify(question(step, p) ?? (p.pdfOffered ? TEXT.pdfOffer : "nothing in particular"))}`,
    "language: the language the message is written in, as an English name (e.g. Spanish).",
    "intent: answer (gives information), dont_know, yes, no, question (asks something), resend_link (asks for the map link, says the link does not work, or wants to mark, fix, change or redraw the farm boundary or field shape), new_report (wants a new report), market (asks how, where or when to sell, about crop prices, buyers, markets or which crop earns the most money), pdf_report (wants the complete or full report, a PDF, or a document to download or print), report_outcome (tells how a past season or harvest went), other.",
    "crops: crops grown on this field NOW, as English common names (e.g. maiz -> corn). pastCrops: crops of past years, oldest first, English names.",
    `growthStage: one of ${STAGES.join(", ")}. plantingDate: YYYY-MM-DD only if a full date is given. issues: problems the farmer sees, short English phrases.`,
    `irrigation: none (rain only), limited, or full. priorities: any of ${PRIORITIES.join(", ")}.`,
    snippets.length ? `topics: for a question, the ids below whose title answers it (empty if none fits):\n${snippets.map((s) => `${s.id}: ${s.title}`).join("\n")}` : "topics: always empty.",
  ].join("\n");
  const schema = {
    type: "object",
    properties: {
      language: { type: "string" },
      intent: { type: "string", enum: [...INTENTS] },
      crops: { type: "array", items: { type: "string" } },
      pastCrops: { type: "array", items: { type: "string" } },
      growthStage: { type: "string" },
      plantingDate: { type: "string" },
      issues: { type: "array", items: { type: "string" } },
      irrigation: { type: "string" },
      priorities: { type: "array", items: { type: "string" } },
      topics: { type: "array", items: { type: "string" } },
    },
    required: ["language", "intent"],
  };
  const raw = await extract(env, system, text, schema);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
  const ids = new Set(snippets.map((s) => s.id));
  return {
    language: safeLanguage(raw.language),
    intent: (INTENTS as readonly string[]).includes(raw.intent as string) ? (raw.intent as Understanding["intent"]) : "other",
    crops: strs(raw.crops),
    pastCrops: strs(raw.pastCrops),
    growthStage: (STAGES as readonly string[]).includes(raw.growthStage as string) ? (raw.growthStage as string) : "",
    plantingDate: typeof raw.plantingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.plantingDate) ? raw.plantingDate : "",
    issues: strs(raw.issues),
    irrigation: (WATER as readonly string[]).includes(raw.irrigation as string) ? (raw.irrigation as string) : "",
    priorities: strs(raw.priorities).filter((x) => (PRIORITIES as readonly string[]).includes(x)),
    topics: strs(raw.topics).filter((t) => ids.has(t)).slice(0, 3), // only pre-written answers can be chosen
  };
}

/** A language name is used inside the translation instruction, so only accept a plain name ("Spanish", "Haitian Creole"). */
export function safeLanguage(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[\p{L}][\p{L}()' -]{1,29}$/u.test(s) && s.split(/\s+/).length <= 3 && !/\b(and|or|then|also|add|ignore)\b/i.test(s) ? s : "";
}

/** Numbered replies ("3", "1 and 4") and keywords are parsed by code, not by the model. */
export function parseDirect(step: Step, text: string): Partial<Understanding> | null {
  const t = text.trim();
  if (LINK_WORDS.test(t)) return { intent: "resend_link" };
  if (MARKET_WORDS.test(t)) return { intent: "market" };
  if (PDF_WORDS.test(t)) return { intent: "pdf_report" };
  if (/^new$/i.test(t)) return { intent: "new_report" };
  if (YES_WORDS.test(t)) return { intent: "yes" };
  if (NO_WORDS.test(t)) return { intent: "no" };
  const nums = t.match(/^[\d\s,.;&+y-]+$|^(\d+\s*(and|y|et|e)\s*)+\d+$/i) ? (t.match(/\d+/g) ?? []).map(Number) : [];
  if (nums.length === 0) return null;
  if (step === "stage" && nums.length === 1 && nums[0] >= 1 && nums[0] <= 5) return { intent: "answer", growthStage: STAGES[nums[0] - 1] };
  if (step === "water" && nums.length === 1 && nums[0] >= 1 && nums[0] <= 3) return { intent: "answer", irrigation: WATER[nums[0] - 1] };
  if (step === "priorities" && nums.every((n) => n >= 1 && n <= 5)) return { intent: "answer", priorities: [...new Set(nums.map((n) => PRIORITY_CHOICES[n - 1]))] };
  return null;
}

// One-word requests for the map link in common languages (anything longer goes through understand()).
// One-word market questions in common languages.
const MARKET_WORDS = /^(sell|selling|price|prices|market|markets|vender|venta|precio|precios|mercado|vendre|prix|marché|verkaufen|preis|preise|vendere|prezzo|preço|mercado)[?.!]*$/i;

// "PDF", "the pdf", "pdf please" (in a few languages).
const PDF_WORDS = /^(the |el |la |le |o |das |il )?pdf( please| por favor| s'il vous plaît| svp| bitte| per favore)?[.!?]*$/i;

const LINK_WORDS = /^(link|map|redraw|enlace|mapa|liga|lien|carte|karte|mappa|ligação|ссылка|карта|地图|链接|मानचित्र|लिंक|خريطة|رابط)[.!?]*$/i;

// One-word yes/no in common languages, so confirming never depends on the model.
const YES_WORDS = /^(yes|y|yeah|ok|okay|si|sí|oui|ja|sim|да|是|好|हाँ|haan|ndiyo|naam|نعم|evet|tak|igen)[.!]*$/i;
const NO_WORDS = /^(no|n|nope|non|nein|não|nao|нет|不|नहीं|nahi|hapana|لا|hayır|nie|nem|none|nothing|nada|rien)[.!]*$/i;

export const emptyUnderstanding = (): Understanding => ({ ...EMPTY, crops: [], pastCrops: [], issues: [], priorities: [], topics: [] });

/** Apply validated fields to the profile. Returns true if any farm information changed. */
export function apply(p: FarmerProfile, step: Step, u: Understanding, rawText: string): boolean {
  const facts = () => JSON.stringify([p.crops, p.pastCrops, p.growthStage, p.plantingDate, p.issues, p.irrigation, p.priorities]);
  const before = facts();
  // Reply in the language of the latest written message; short replies ("YES", "ok", "3") keep the current one.
  // A message without Latin letters is never English (the model sometimes says so for Hindi).
  const notEnglish = /^english\b/i.test(u.language) && !/[A-Za-z]/.test(rawText);
  if (u.language && !notEnglish && (!p.language || rawText.trim().split(/\s+/).length >= 3)) p.language = u.language;
  if (u.crops.length) p.crops = u.crops;
  if (u.pastCrops.length) {
    p.pastCrops = u.pastCrops;
    mark(p, "rotation");
  }
  if (u.growthStage || u.plantingDate) {
    if (u.growthStage) p.growthStage = u.growthStage;
    if (u.plantingDate) p.plantingDate = u.plantingDate;
    mark(p, "stage");
  }
  if (u.issues.length) { p.issues = [...new Set([...p.issues, ...u.issues])]; mark(p, "issues"); }
  if (u.irrigation) { p.irrigation = u.irrigation as FarmerProfile["irrigation"]; mark(p, "water"); }
  if (u.priorities.length) { p.priorities = u.priorities as Priority[]; mark(p, "priorities"); }
  if ((u.intent === "dont_know" || u.intent === "no") && (OPTIONAL_STEPS as readonly string[]).includes(step)) mark(p, step);
  if (u.intent === "report_outcome") {
    p.outcomes = [...p.outcomes, { date: new Date().toISOString().slice(0, 10), crop: p.crops[0] ?? null, text: rawText }].slice(-20); // farmer's own words
  }
  return before !== facts();
}

function mark(p: FarmerProfile, step: string): void {
  if (!p.asked.includes(step)) p.asked = [...p.asked, step];
}
