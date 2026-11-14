// Workers AI, used for exactly two narrow jobs:
//   understand(): turn a farmer's message into structured fields (never free text to the farmer)
//   translate():  translate code-written messages; every number must survive or the English original is used
// Neither can introduce facts: facts are written by code (facts.ts, flow.ts) from the pipeline result.
import type { Env } from "../env";

/** Fast (~1.6 s per call in our benchmark), multilingual, reliable structured output via tool calls. */
export const MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { arguments: unknown }; arguments?: unknown }[] } }[];
  response?: string | object;
  tool_calls?: { function?: { arguments: unknown }; arguments?: unknown }[];
}

async function run(env: Env, body: Record<string, unknown>): Promise<ChatResponse> {
  return (await env.AI.run(MODEL as Parameters<Ai["run"]>[0], body as never)) as unknown as ChatResponse;
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
export async function extract(env: Env, system: string, user: string, schema: Record<string, unknown>, maxTokens = 800): Promise<Record<string, unknown>> {
  const res = await run(env, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{ type: "function", function: { name: "record", description: "Record the result.", parameters: schema } }],
    tool_choice: "required",
    max_completion_tokens: maxTokens,
  });
  const msg = res.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0] ?? res.tool_calls?.[0];
  const obj = parseObject(call?.function?.arguments ?? call?.arguments) ?? parseObject(msg?.content ?? res.response);
  if (!obj) throw new Error("model returned no structured output");
  return obj;
}

// Numbers compared by value ("05" = "5", "64,0" = "64.0"), so a correct translation of a date or decimal passes.
const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(",", ".")))).sort();
const sameNumbers = (a: string, b: string) => numbers(a).join("|") === numbers(b).join("|");

/**
 * Translate messages into `language`. A translation is accepted only if it keeps exactly the same numbers
 * as the English source and contains no web address; otherwise the English source is sent unchanged.
 */
export async function translate(env: Env, language: string | null, texts: string[]): Promise<string[]> {
  if (!language || /^english\b/i.test(language) || texts.length === 0) return texts;
  if (!/^[\p{L}][\p{L}()' -]{1,29}$/u.test(language)) return texts; // only a plain language name may enter the instruction
  const system =
    `Translate each message from English into ${language} for a farmer who may read with difficulty. ` +
    "Translate faithfully: do not add, remove or change any information. Keep every number exactly as written, with Western digits. " +
    "Plain text only, no markdown. Return {\"translations\": [...]} with one entry per message, in the same order.";
  const attempt = async (batch: string[]) => {
    const out = await extract(env, system, JSON.stringify({ messages: batch }), {
      type: "object",
      properties: { translations: { type: "array", items: { type: "string" } } },
      required: ["translations"],
    }, 3000);
    return Array.isArray(out.translations) ? out.translations.map(String) : [];
  };
  // Accept only translations with the same numbers, no links, and a plausible length (catches added or dropped text).
  const ok = (src: string, t: string | undefined) =>
    !!t && t.trim().length >= 0.4 * src.length && t.length <= 2.5 * src.length + 20 && sameNumbers(src, t) && !/https?:\/\//i.test(t);

  const out = await attempt(texts).catch((e) => (console.error("translation failed", e), [] as string[]));
  return texts.map((src, i) => {
    if (ok(src, out[i])) return out[i].trim();
    console.log("translation rejected, sending English"); // visible in `wrangler tail`
    return src;
  });
}
