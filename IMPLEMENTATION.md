# Implementation

A single Cloudflare Worker in TypeScript, with two runtime dependencies (`proj4`, `agents`) and no framework. State lives in two places:
- a KV cache of upstream responses
- one Agent (a Durable Object) per farmer

## Design rules
1. **Black box.** `runPipeline(body)` is an async generator: request in, sections out. HTTP and SMS only consume it.
2. **One place per concern.** Upstream input format → `input.ts`. Each external API → one file in `sources/`. Each analysis step → one module. Thresholds are named constants next to the code that uses them.
3. **Pure analysis, thin I/O.** Everything except `sources/*`, the KV cache and the SMS layer is a pure function of its inputs, so it's testable offline.
4. **Degrade, don't fail.** Only NASA POWER is required. Every other source can be missing; the gap shows in `dataSources`, `confidence` and `informationGaps`.
5. **Explainable, no hallucination.** Deterministic rules and published formulas (FAO-56, RUSLE, EPIC, extension degree-day models). Every fact a farmer reads is written by code. The model only reads messages into validated fields and translates code-written text under a number-preservation check (SMS.md).

## File map
```
src/
  index.ts            HTTP: POST /analyze (SSE or ?format=json) · POST /sms (Twilio) · GET|POST /map/:farmer/:token · GET /report/:farmer/:token[/pdf] · POST|GET /api/chat (browser SMS simulator)
  env.ts              Bindings and secrets
  pipeline.ts         Orchestrator: startFetches (parallel, cached; also used by prefetch), section order,
                      rotation fallback (farmer > CDL > current crop > best crop), robustness re-runs,
                      data-source report, information gaps, recommendation, confidence
  input.ts            GeoJSON → FieldRequest
  types.ts            Input/output contracts (OUTPUTS.md describes them)
  geo.ts              CRS → WGS84 (proj4), area, centroid, bbox, point-in-polygon
  climate.ts          Station correction, season years (N/S), current-climate baseline, Penman-Monteith ET0,
                      frost, GDD, monthly table, extremes, trends
  land.ts             Soil summary (texture, AWC, K, drainage), RUSLE LS, NDVI summary + observed season
  crops.ts            Crop catalog (19 crops incl. paddy rice, variety GDD ranges) + name resolution
  simulate.ts         Crop × season replay: sowing rules incl. rainfall onset, soil-water bucket, variety choice
  pests.ts            Degree-day pest scouting calendar
  market/
    ingest.ts         Monthly ingestion (Cron + POST /admin/ingest): prices, CPI, USDA PSD -> D1
    engine.ts         Harvest-month price ranges, backtest, best sell month, demand signals, revenue, ranking
  rotation.ts         Strategy generators, day-by-day layout, five scores, programs, narrative fields
  hazards.ts          Hazard rules + farmer-issue matching
  stats.ts            mean / percentile / median / round / clamp01
  sources/
    http.ts           fetch with timeout + retry on 5xx/network errors
    power.ts          NASA POWER daily point API
    stations.ts       NOAA GHCN-Daily nearest station (NCEI search + data APIs)
    soil.ts           USDA SSURGO (Soil Data Access) with SoilGrids fallback
    elevation.ts      OpenTopography SRTM → Horn slope, D8 flow accumulation, wetness index
    modis.ts          ORNL MOD13Q1 subset API, polygon pixel mask
    cdl.ts            USDA Cropland Data Layer history (CropScape) + rotation inference
    eonet.ts          NASA EONET natural events
    prices.ts         IMF world prices + US CPI (DBnomics)
    psd.ts            USDA PSD bulk zips, streamed (DecompressionStream) and filtered to US rows
    census.ts         US Census geocoder: state and county
  sms/                SMS assistant (SMS.md)
    session.ts        FarmerSession Agent: queued turns, reply assembly (translate + code-appended link), analysis, prefetch, RESET
    flow.ts           Conversation state machine and texts; understand() (model -> validated fields); parseDirect(); apply()
    facts.ts          Report messages and follow-up answer snippets written from the result
    ai.ts             Workers AI: extract() (structured output) and translate() (checked; one retry on a second model; English fallback)
    profile.ts        FarmerProfile, required fields, boundary validation, profile → pipeline input
    mappage.ts        Boundary-drawing page (Leaflet + Esri imagery), translatable texts (icons added by the page)
  report/
    content.ts        PDF report content from the result (text, tables, chart data) + translation
    pdf.ts            PDF drawing with pdf-lib: layout, charts, satellite map with the farm outline
    page.ts           Page the PDF link opens (view + download)
    twilio.ts         Signature verification, outbound SMS
test/                 geo-input · pipeline (stubbed APIs) · methods (Penman-Monteith, rotation inference) · sms · sms-flow (translation guard, facts, flow) · market · report (PDF content and rendering)
public/               demo page served as static assets: index.html, style.css, app.js (draw a field, stream /analyze) · chat.html (SMS simulator, /chat)
examples/             sample-input.json (Iowa field, UTM 15N) and its live sample-output.json
```
Dependency direction: `index → {pipeline, sms} → analysis modules → sources`. There are no cycles.

## Cloudflare products
| Product | Use |
|---|---|
| **Workers** | Whole backend at the edge; SSE streaming for `/analyze` |
| **Agents SDK** (`FARMER`, Durable Objects) | One Agent per phone number. The profile lives in Agent state. `this.queue()` runs each SMS turn and the analysis durably and in order after Twilio has been answered. No public Agent routes are mounted |
| **Workers AI** (`AI`) | `@cf/mistralai/mistral-small-3.1-24b-instruct` reads farmer messages into structured fields and translates code-written texts (multilingual, ~1.6 s per call) |
| **Service binding to itself** (`SELF`) | The farmer agent runs the analysis by calling `/analyze?format=json` through it, so the ~24 data downloads use a separate invocation's connections (a Cloudflare invocation holds at most 6 open connections; downloads inside the agent would delay its replies). The map handler prefetches data in its own request for the same reason |
| **D1** (`DB`, `farm-market`) | Market data: monthly prices, CPI, US supply/demand, ingestion log (`migrations/0001_market.sql`). Farmer requests only read it |
| **Cron Trigger** (`0 6 15 * *`) | Monthly market ingestion; `POST /admin/ingest` with `Authorization: Bearer <ADMIN_TOKEN>` runs it on demand |
| **KV** (`CACHE`) | Upstream response cache: POWER 30 d, station 30 d, soil 90 d, CDL 90 d, SRTM 365 d, NDVI 7 d (monthly key), EONET 1 d |
| **`waitUntil`** | Slow sources keep downloading (and fill the cache) after the stream stops waiting; SMS sessions prefetch when the farm is drawn |
| **Secrets** | `TWILIO_*`, `OPENTOPO_API_KEY` |
| **Observability** | `observability.enabled` |

**Limits checked:**
- **Subrequests per analysis:** POWER 1, NOAA 2, soil 1–2, SRTM 1, MODIS ≈ 9, CDL 8, EONET 1 (≈ 24), plus KV operations.
- **CPU:** measured at about 45–50 ms per uncached analysis (POWER parsing, 19 crops × 20 seasons with variety search, 8 robustness re-runs). That's above the free plan's 10 ms, so use **Workers Paid** (30 s), which is free for 12 months for US students.

## Local development
```bash
npm install
npm test                 # offline tests (no network)
npm run typecheck
npx wrangler login       # Workers AI runs on Cloudflare even in dev; the account needs a workers.dev subdomain
npx wrangler dev         # http://localhost:8787
curl -N -X POST localhost:8787/analyze --data-binary @examples/sample-input.json
```
`.dev.vars` (gitignored) holds local secrets: `OPENTOPO_API_KEY`, and `ALLOW_UNSIGNED_SMS=true` to test the SMS flow without Twilio:
```bash
curl -X POST localhost:8787/sms -d "From=%2B15551230000&Body=Hola&MessageSid=SM1"   # replies print in the wrangler log
```

## Deploying
```bash
npx wrangler kv namespace create CACHE      # paste the id into wrangler.jsonc
npx wrangler secret put TWILIO_ACCOUNT_SID  # + TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OPENTOPO_API_KEY
npx wrangler deploy                         # → https://farm-rotation-pipeline.<subdomain>.workers.dev
```
Then point the Twilio service number at `/sms` (SMS.md).

## How to extend
| Change | Where |
|---|---|
| Input format | `input.ts` only |
| A crop | one entry in `CROPS` (`crops.ts`); add `gddRange` if varieties differ in length |
| A dataset | a new `sources/<name>.ts`, started in `startFetches`, consumed where needed, plus a `dataSources` entry |
| A hazard | one block in `assessHazards`; document thresholds in PIPELINE.md §7 |
| A pest model | one entry in `MODELS` (`pests.ts`) |
| A strategy | one generator in `rotation.ts` |
| The SMS model | `MODEL` in `sms/ai.ts` |
| A question or message text | `TEXT` / `question()` in `sms/flow.ts`; report wording in `sms/facts.ts` |
| CORS | `CORS` in `index.ts` (set your frontend origin instead of `*`) |

## Deliberately not built
- **Market scoring:** owned by the marketing pipeline (OUTPUTS.md §4).
- **Model-written facts:** neither the analysis nor any farmer-facing fact comes from a model.
- **Public Agent routes:** state is reachable only through the Worker's own RPC calls.
