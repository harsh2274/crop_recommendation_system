// HTTP surface.
//   POST /analyze                  analysis black box: SSE stream (or ?format=json for one JSON result)
//   POST /sms                      Twilio inbound-SMS webhook -> the farmer's Durable Object
//   GET|POST /map/:farmer/:token   boundary-drawing page and its submit endpoint
//   GET /report/:farmer/:token     page holding the farmer's PDF report; /pdf serves the PDF itself
import { getAgentByName } from "agents";
import type { Env } from "./env";
import { InputError } from "./input";
import { ingestAll } from "./market/ingest";
import { prefetch, runPipeline, type PipelineEvent } from "./pipeline";
import type { ReportDoc } from "./report/content";
import { renderReportPage } from "./report/page";
import { mapView, renderPdf } from "./report/pdf";
import { USER_AGENT } from "./sources/http";
import { renderMapPage, type MapPageConfig } from "./sms/mappage";
import { emptyTwiml, verifySignature } from "./sms/twilio";

export { FarmerSession } from "./sms/session";
export type { Env };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

const MAP_PATH = /^\/map\/([0-9a-f]{64})\/([0-9a-f]{32})$/;
const REPORT_PATH = /^\/report\/([0-9a-f]{64})\/([0-9a-f]{32})(\/pdf)?$/;
const PDF_CACHE_TTL_S = 30 * 24 * 3600;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/analyze" && request.method === "POST") return analyze(request, env, ctx, url);
    if (url.pathname === "/sms" && request.method === "POST") return sms(request, env, url);
    const map = url.pathname.match(MAP_PATH);
    if (map) return mapPage(request, env, ctx, map[1], map[2]);
    const report = url.pathname.match(REPORT_PATH);
    if (report && request.method === "GET") return reportPage(env, url, report[1], report[2], !!report[3]);
    if (url.pathname === "/admin/ingest" && request.method === "POST") return adminIngest(request, env);
    // "/" is the public demo page (static assets); /api describes the API.
    if (url.pathname === "/api") return json({ service: "farm-rotation-pipeline", endpoints: ["POST /analyze", "POST /sms (Twilio webhook)", "GET /map/:farmer/:token", "GET /report/:farmer/:token"], demo: "/" });
    return json({ error: "Not found", api: "/api" }, 404);
  },

  /** Monthly Cron Trigger: refresh market data in D1. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ingestAll(env.DB).then((r) => console.log("market ingestion", JSON.stringify(r))));
  },
};

// ------------------------------------------------------------------ admin

/** Run the market ingestion now (first load, or after a source update). Requires the ADMIN_TOKEN secret. */
async function adminIngest(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401);
  return json(await ingestAll(env.DB));
}

// ------------------------------------------------------------------ analysis

async function analyze(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }

  const events = runPipeline(body, { kv: env.CACHE, db: env.DB, opentopoKey: env.OPENTOPO_API_KEY, waitUntil: (p) => ctx.waitUntil(p) });
  let first: IteratorResult<PipelineEvent>;
  try {
    first = await events.next(); // input validation happens here, so bad input gets a real 400
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof InputError ? 400 : 500);
  }

  if (url.searchParams.get("format") === "json") {
    try {
      for await (const ev of events) if (ev.event === "result") return json(ev.data);
      return json({ error: "Pipeline ended without a result" }, 500);
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  ctx.waitUntil(
    (async () => {
      try {
        if (!first.done) await send(first.value.event, first.value.data);
        for await (const ev of events) await send(ev.event, ev.data);
      } catch (e) {
        await send("error", { message: (e as Error).message });
      } finally {
        await writer.close();
      }
    })(),
  );

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS },
  });
}

// ------------------------------------------------------------------ SMS

async function sms(request: Request, env: Env, url: URL): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => (params[k] = String(v)));

  const signed =
    env.ALLOW_UNSIGNED_SMS === "true" ||
    (!!env.TWILIO_AUTH_TOKEN && (await verifySignature(env.TWILIO_AUTH_TOKEN, request.url, params, request.headers.get("x-twilio-signature"))));
  if (!signed) return new Response("Invalid Twilio signature", { status: 403 });

  const from = params.From;
  const text = params.Body?.trim();
  if (!from || !text) return emptyTwiml();

  const farmer = await getAgentByName(env.FARMER, farmerName(env, from)); // one Agent per phone number
  await farmer.inbound(from, text, params.MessageSid ?? crypto.randomUUID(), url.origin);
  return emptyTwiml();
}

/** Agent name for a phone number: the namespace's keyed hash, so URLs never reveal the number. */
function farmerName(env: Env, phone: string): string {
  return env.FARMER.idFromName(`phone:${phone}`).toString();
}

// ------------------------------------------------------------------ map page

async function mapPage(request: Request, env: Env, ctx: ExecutionContext, farmerHex: string, token: string): Promise<Response> {
  const farmer = await getAgentByName(env.FARMER, farmerHex); // unknown names hold no link, so they get "expired"

  if (request.method === "GET") {
    const cf = request.cf as { latitude?: string; longitude?: string } | undefined;
    const ip = cf?.latitude && cf?.longitude ? ([Number(cf.latitude), Number(cf.longitude)] as [number, number]) : null;
    return renderMapPage((await farmer.mapContext(token, ip)) as MapPageConfig | null);
  }
  if (request.method === "POST") {
    let body: { ring?: unknown; location?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "points" }, 400);
    }
    if (!Array.isArray(body.ring)) return json({ ok: false, error: "points" }, 400);
    const ring = body.ring.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN])) as [number, number][];
    const loc = body.location as { lat: number; lon: number; accuracyM: number } | null;
    const out = await farmer.saveBoundary(token, ring, loc && typeof loc === "object" ? loc : null);
    if (out.ok) {
      // Warm the data cache for this field while the farmer answers the remaining questions. This runs in this
      // request (its own connection pool), never inside the farmer's agent, so it can't delay their texts.
      const field = { type: "Feature", geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] }, properties: {} };
      ctx.waitUntil(prefetch(field, { kv: env.CACHE, opentopoKey: env.OPENTOPO_API_KEY }).catch(() => {}));
    }
    return json(out, out.ok ? 200 : 400);
  }
  return json({ error: "Use GET or POST" }, 405);
}

// ------------------------------------------------------------------ PDF report

/** The report page, or the PDF itself (rendered once per link, then served from KV). */
async function reportPage(env: Env, url: URL, farmerHex: string, token: string, wantPdf: boolean): Promise<Response> {
  const farmer = await getAgentByName(env.FARMER, farmerHex);
  const doc = (await farmer.reportDoc(token)) as ReportDoc | null;
  if (!wantPdf) return renderReportPage(doc, `/report/${farmerHex}/${token}/pdf`);
  if (!doc) return new Response("This link has expired.", { status: 404 });

  const key = `pdf:${farmerHex}:${token}`;
  let bytes = (await env.CACHE?.get(key, "arrayBuffer")) ?? null;
  if (!bytes) {
    const pdf = await renderPdf(doc, doc.ring.length >= 3 ? await satelliteImage(mapView(doc.ring).url) : null);
    bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
    await env.CACHE?.put(key, bytes, { expirationTtl: PDF_CACHE_TTL_S });
  }
  const disposition = url.searchParams.has("download") ? "attachment" : "inline";
  return new Response(bytes, {
    headers: { "content-type": "application/pdf", "content-disposition": `${disposition}; filename="farm-report.pdf"`, "cache-control": "private, max-age=3600", "x-robots-tag": "noindex" },
  });
}

/** Esri World Imagery JPEG for the PDF map, or null (the PDF then shows the outline without imagery). */
async function satelliteImage(src: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": USER_AGENT } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("jpeg")) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}
