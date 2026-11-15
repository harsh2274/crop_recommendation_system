// Workers AI, used for exactly two narrow jobs:
//   understand(): turn a farmer's message into structured fields (never free text to the farmer)
//   translate():  translate code-written messages; every number must survive or the English original is used
// Neither can introduce facts: facts are written by code (facts.ts, flow.ts) from the pipeline result.
import type { Env } from "../env";

/** Fast (~1.6 s per call in our benchmark), multilingual, reliable structured output via tool calls. */
export const MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
/**
 * Retries rejected translations. The main model garbles some Devanagari letters every time (Hindi "सुझाव" comes back
 * with U+FFFD); in our test this model translated the same Hindi messages correctly 3 of 3 times in ~5 s.
 */
const FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { arguments: unknown }; arguments?: unknown }[] } }[];
  response?: string | object;
  tool_calls?: { function?: { arguments: unknown }; arguments?: unknown }[];
}

async function run(env: Env, body: Record<string, unknown>, model = MODEL): Promise<ChatResponse> {
  return (await env.AI.run(model as Parameters<Ai["run"]>[0], body as never)) as unknown as ChatResponse;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Ask for a JSON object matching `schema` (via a required tool call, falling back to JSON in the text). */
export async function extract(env: Env, system: string, user: string, schema: Record<string, unknown>, maxTokens = 800, model = MODEL): Promise<Record<string, unknown>> {
  const res = await run(env, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{ type: "function", function: { name: "record", description: "Record the result.", parameters: schema } }],
    tool_choice: "required",
    max_completion_tokens: maxTokens,
  }, model);
  const msg = res.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0] ?? res.tool_calls?.[0];
  const obj = parseObject(call?.function?.arguments ?? call?.arguments) ?? parseObject(msg?.content ?? res.response);
  if (!obj) throw new Error("model returned no structured output");
  return obj;
}

// Numbers compared by value ("05" = "5", "64,0" = "64.0"), so a correct translation of a date or decimal passes.
const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(",", ".")))).sort();
const sameNumbers = (a: string, b: string) => numbers(a).join("|") === numbers(b).join("|");

const MAX_SINGLE_RETRIES = 12; // rejected messages retried one per call (in parallel), at most this many

// Code point of "0" in scripts with their own digits (Arabic-Indic, Devanagari, Bengali, Gurmukhi, Gujarati, Tamil,
// Telugu, Kannada, Malayalam, Thai, Myanmar, Khmer), so "१५" can be written "15" as the prompt asks.
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0x1040, 0x17e0];
const westernDigits = (s: string) =>
  s.replace(/\p{Nd}/gu, (c) => {
    const zero = DIGIT_ZEROS.find((z) => c.codePointAt(0)! - z >= 0 && c.codePointAt(0)! - z <= 9);
    return zero === undefined ? c : String(c.codePointAt(0)! - zero);
  });

/** One translation entry, with Western digits; some models wrap it as '{"translations": ["..."]}' inside the string. */
function unwrap(entry: unknown): string {
  const s = String(entry);
  const inner = /^\s*\{/.test(s) ? parseObject(s)?.translations : null;
  return westernDigits(Array.isArray(inner) && inner.length === 1 ? String(inner[0]) : s);
}

/**
 * Translate messages into `language`. A translation is accepted only if it keeps exactly the same numbers as the
 * English source, has no web address or garbled character and is not an echo of the English; a rejected message is
 * retried once on its own with FALLBACK_MODEL, and if that fails too the English source is sent unchanged.
 */
export async function translate(env: Env, language: string | null, texts: string[]): Promise<string[]> {
  if (!language || /^english\b/i.test(language) || texts.length === 0) return texts;
  if (!/^[\p{L}][\p{L}()' -]{1,29}$/u.test(language)) return texts; // only a plain language name may enter the instruction
  const system =
    `Translate each message from English into ${language} for a farmer who may read with difficulty. ` +
    "Translate faithfully: do not add, remove or change any information. Keep every number exactly as written, with Western digits. " +
    "Do not add numbers: keep approximate times such as 'mid February' or 'late September' as words, never as exact dates. " +
    "Plain text only, no markdown. Return {\"translations\": [...]} with one entry per message, in the same order.";
  const attempt = async (batch: string[], model = MODEL) => {
    const out = await extract(env, system, JSON.stringify({ messages: batch }), {
      type: "object",
      properties: { translations: { type: "array", items: { type: "string" } } },
      required: ["translations"],
    }, 3000, model);
    return Array.isArray(out.translations) ? out.translations.map(unwrap) : [];
  };
  // Accept only translations with the same numbers, no links, no garbled characters (U+FFFD) and a plausible length
  // (catches added or dropped text; short labels may shrink, "Corn (maize)" -> "Maíz"). Returns why it was rejected.
  const problem = (src: string, t: string | undefined): string | null =>
    !t?.trim() ? "missing" : t.trim().length < (src.length < 20 ? 1 : 0.4 * src.length) || t.length > 2.5 * src.length + 20 ? "length"
      : !sameNumbers(src, t) ? "numbers" : /https?:\/\//i.test(t) ? "link" : t.includes("\uFFFD") ? "garbled"
      : src.length >= 20 && t.trim() === src.trim() ? "untranslated" // the model echoed the English
      : /^\s*[{[]|"translations"/.test(t) ? "format" : null; // JSON instead of a message
  const run = (batch: string[], model = MODEL) => attempt(batch, model).catch((e) => (console.error("translation failed", e), [] as string[]));

  const why = (src: string, t: string | undefined) => {
    const p = problem(src, t);
    return p === "numbers" ? `numbers ${numbers(src).join(",")} vs ${numbers(t!).join(",")}` : p; // numbers only, never text
  };

  const out = await run(texts);
  const reasons = new Map<number, string | null>(texts.map((src, i) => [i, why(src, out[i])]));
  // Rejected messages: one more try each, on its own (the fallback model returns one entry for a multi-message batch).
  const retry = texts.map((_, i) => i).filter((i) => reasons.get(i)).slice(0, MAX_SINGLE_RETRIES);
  await Promise.all(retry.map(async (i) => {
    const [again] = await run([texts[i]], FALLBACK_MODEL);
    if (!problem(texts[i], again)) out[i] = again;
    else reasons.set(i, `${reasons.get(i)}; retry: ${why(texts[i], again)}`);
  }));
  return texts.map((src, i) => {
    if (!problem(src, out[i])) return out[i].trim();
    console.log(`translation rejected (${reasons.get(i)}), sending English`); // visible in `wrangler tail`
    return src;
  });
}
