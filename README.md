# Crop Recommendation System: NASA Space Apps 2026, *Adapting Farms with NASA Data*

Farmers text a phone number in their own language. The assistant asks a few simple questions, has them mark their farm on a one-page satellite map, and texts back plain-language advice built from NASA and USDA data:

1. **Their crops**: how well each current and alternative crop fits this field, with probabilities from 20 real seasons, and the variety length that fits the local season.
2. **Recommended growing cycle**: at least 3 rotation strategies (the current one plus alternatives) with planting and harvest months, cover crops, evidence, benefits, risks, and a stability check.
3. **Hazards and when to act**:
   - frost, heat, drought at flowering, waterlogging, erosion, disease, pest cycles, soil limits, nearby fires/floods and long-term trends
   - a pest-scouting calendar
4. **Market potential, on request**: when the farmer asks how, where or when to sell, the crops that fit their field ranked by value per hectare after harvest (sold right away or stored until prices usually peak), harvest-month price ranges, US supply signals and where to sell.

**No hallucinated facts:** every number, date, link and recommendation the farmer reads is written by code from the data. The language model only reads the farmer's replies into fields and translates code-written text; a translation that changes any number is rejected. It supports, and does not replace, farmer judgment and local expertise.

## Live deployment
| What | Where |
|---|---|
| Public demo page | `https://farm-rotation-pipeline.rshaspaceapps.workers.dev` (draw a field, watch the analysis stream in) |
| Backend (Cloudflare Worker) | same address; API description at `/api` |
| Analysis API | `POST /analyze` (streams results) · `POST /analyze?format=json` (one JSON result) |
| SMS webhook (Twilio) | `POST /sms` (only accepts Twilio-signed requests) |
| Farm-drawing page | `/map/<farmer>/<token>`, sent to the farmer by text |
| Service phone number | the Twilio number whose SMS webhook points at `/sms` (see the Twilio console of the account that owns it) |

## Try it in two minutes
**Analysis API** (no account needed):
```bash
git clone https://github.com/harsh2274/crop_recommendation_system.git && cd crop_recommendation_system
curl -X POST "https://farm-rotation-pipeline.rshaspaceapps.workers.dev/analyze?format=json" \
  --data-binary @examples/sample-input.json -o my-result.json
```
The result format is described in [OUTPUTS.md](OUTPUTS.md); a full example is [`examples/sample-output.json`](examples/sample-output.json). The first run for a new field can take up to about a minute (NASA's MODIS service is slow); repeats are cached.

**As a farmer, by SMS** (Twilio Dev Phone):
```bash
npm install -g twilio-cli
twilio login                       # Account SID + Auth Token of the Twilio account that owns the numbers
twilio profiles:use <your-profile>
twilio plugins:install @twilio-labs/plugin-dev-phone
twilio dev-phone                   # pick a number that is NOT the service number, then text the service number
```

## What a farmer can text
The conversation is a fixed sequence. One question at a time:
- crops
- the map link
- past crops
- crop stage (1–5)
- problems (or NO)
- water (1–3)
- what matters most (1–5)
- summary, then **YES**

| Farmer sends | What happens |
|---|---|
| Anything, in any language | The reply comes in that language (the language of the latest written message) |
| `YES` (sí, oui, ja…) at the summary | The report starts: 4 texts about a minute later |
| `LINK`, "send the map again", "I drew the wrong field" | The map link is resent; a new drawing replaces the old one |
| "How and where should I sell my crops?", "When should I sell my corn?", `sell` / `precio` / `mercado`… | 4 market texts: which crops pay the most after harvest (value per hectare, at harvest or stored), prices at harvest, best month to sell, where to sell |
| A question ("why sunflower?", "when do I plant corn?") | An answer picked from pre-written facts of their report, or "I do not have that information" |
| New information ("now I grow wheat") | Saved; the summary is shown again for a new report |
| `NEW` | Start a new report with the current information |
| "My harvest was lower in the wet corner" | Saved in the farmer's own words and sent with future analyses |
| `RESET` | Delete this farmer's profile (useful for testing) |

## Architecture (one Cloudflare Worker)
```
Twilio SMS ─► /sms ─► FarmerSession Agent (Agents SDK, one per phone number; durable queue)
                         │ Workers AI: message → validated fields; translation of code-written texts
                         │ map link ─► /map page (Leaflet) ─► boundary saved (+ data prefetch)
                         └─ YES ─► /analyze via self service binding
/analyze ─► pipeline: NASA POWER (+ NOAA station correction), MODIS NDVI, SRTM, NASA EONET,
            USDA SSURGO / SoilGrids, USDA Cropland Data Layer, US Census region ─► KV cache
          ─► 18-crop × 20-season simulation ─► rotations + robustness ─► hazards, pest calendar
          ─► market engine (D1: IMF prices, US CPI, USDA PSD; refreshed monthly by Cron)
```

| Cloudflare product | Used for |
|---|---|
| Workers | the whole backend; SSE streaming |
| Agents SDK / Durable Objects | per-farmer state and ordered message processing |
| Workers AI | reading messages, translation (`@cf/mistralai/mistral-small-3.1-24b-instruct`) |
| KV | cache of NASA/USDA responses |
| D1 | market data |
| Cron Triggers | monthly market ingestion |
| Service binding | the agent runs the analysis in its own invocation |

## Repository layout
```
src/
  index.ts          HTTP routes, Cron handler, admin ingestion
  pipeline.ts       the analysis (one async generator: request in, result sections out)
  climate.ts simulate.ts rotation.ts hazards.ts pests.ts land.ts crops.ts geo.ts input.ts
  sources/          one file per external dataset (POWER, NOAA, MODIS, SRTM, SSURGO, CDL, EONET, Census, prices, PSD)
  market/           ingest.ts (D1 loader), engine.ts (price ranges, ranking)
  sms/              session.ts (Agent), flow.ts (conversation), facts.ts (all farmer-facing texts),
                    ai.ts (Workers AI), mappage.ts, profile.ts, twilio.ts
migrations/         D1 schema
test/               offline tests (npm test)
examples/           sample input and its live output
public/             demo page (index.html, app.js, style.css), served as Cloudflare static assets
```

## Getting access (for teammates)
1. **Code:** this repo.
2. **Cloudflare** (deploy, logs, D1, Workers AI):
   - The owner invites you: dash.cloudflare.com → *Manage Account* → *Members* → *Invite*, with role **Administrator** (or Workers Admin plus D1/KV access).
   - You accept the email, then run `npx wrangler login`. `wrangler.jsonc` already points at the account (`account_id`).
3. **Twilio** (the SMS numbers): use the Twilio account that owns the service number. Its Account SID, Auth Token and number are stored as Worker secrets.
4. **Secrets are never in git:**
   - They live on the deployed Worker, and deploys keep them.
   - List names with `npx wrangler secret list`; secrets can't be read back.
   - The `ADMIN_TOKEN` for manual market ingestion is shared privately. Anyone with Cloudflare access can set a new one with `npx wrangler secret put ADMIN_TOKEN`.

## Develop locally
```bash
npm install
npm test                       # offline tests, no network
npm run typecheck
cp .dev.vars.example .dev.vars # fill in what you need (ALLOW_UNSIGNED_SMS=true lets you curl /sms)
npx wrangler login             # Workers AI and D1 bindings run on Cloudflare even in dev
npm run dev                    # http://localhost:8787
curl -N -X POST localhost:8787/analyze --data-binary @examples/sample-input.json   # streamed sections
curl -X POST localhost:8787/sms -d "From=%2B15551230000&Body=Hi%2C%20I%20grow%20corn&MessageSid=SM1"   # replies print in the log
```

## Deploy
**To the existing account** (after accepting the invite):
```bash
npm run deploy                 # resources, bindings and secrets are already set up
npm run tail                   # live logs while testing
```

**Your own copy, from scratch:**
```bash
npx wrangler login                                   # your account needs a workers.dev subdomain
npx wrangler kv namespace create CACHE               # put the id in wrangler.jsonc
npx wrangler d1 create farm-market                   # put the database_id in wrangler.jsonc
#   also set "account_id" in wrangler.jsonc to your account
npm run db:migrate                                   # creates the market tables
npx wrangler secret put TWILIO_ACCOUNT_SID           # and TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, ADMIN_TOKEN, OPENTOPO_API_KEY (optional)
npm run deploy
curl -X POST https://<your-worker>.workers.dev/admin/ingest -H "Authorization: Bearer <ADMIN_TOKEN>"   # first market data load
twilio phone-numbers:update <SERVICE_NUMBER> --sms-url https://<your-worker>.workers.dev/sms
```
**Plan:** an uncached analysis uses about 50 ms of CPU, which is above the Workers free plan's 10 ms. Use **Workers Paid**; it's free for 12 months for US students with a .edu email (cloudflare.com/students).

**API token permissions** (for CI instead of `wrangler login`):
- Account: Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Workers AI Read, Account Settings Read
- User: User Details Read, Memberships Read
- Optional: Workers Tail Read

## Operations
- **Market data** refreshes on the 15th of each month (Cron). To load it now: `curl -X POST <worker>/admin/ingest -H "Authorization: Bearer <ADMIN_TOKEN>"`.
- **Logs:** `npm run tail` shows every webhook, map submission, model tool call and error.
- **Reset a test farmer:** text `RESET` from that phone.
- **Check the data:** `npx wrangler d1 execute farm-market --remote --command "SELECT crop_id, MAX(month) FROM price_monthly GROUP BY crop_id"`.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| A report takes ~40 s | NASA's MODIS service (ORNL) is slow or down; the pipeline waits at most 40 s, continues without NDVI, and caches the result when it arrives |
| `/sms` returns 403 | Webhook signature mismatch: the `TWILIO_AUTH_TOKEN` secret must belong to the Twilio account that owns the number, and the webhook URL must be the deployed `workers.dev` URL |
| "I do not have market prices for your crops yet" | D1 is empty or the crop isn't priced (only corn, soybean, wheat): run `/admin/ingest` |
| A reply arrives in English instead of the farmer's language | The translation failed the number check, so the original English was sent (by design) |
| `wrangler dev` fails with a workers.dev subdomain error | Register a subdomain once in the Cloudflare dashboard (Workers → onboarding) |
| "CPU time exceeded" | The account is on the free plan; switch to Workers Paid |

## Documentation
| File | What's inside |
|---|---|
| [SMS.md](SMS.md) | the no-hallucination design, conversation flow, map page, market questions, Twilio setup, secrets |
| [OUTPUTS.md](OUTPUTS.md) | API contract: input schema, stream events, every output field, marketing handoff |
| [PIPELINE.md](PIPELINE.md) | every step, formula and threshold, including the market method; evaluation standard and validation results |
| [DATASETS.md](DATASETS.md) | dataset audit: what each source contributes, verified reliability, limits, what's not included and why |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | code structure, Cloudflare products and limits, how to extend |
| [description.md](description.md) | the Space Apps challenge text |

## License
MIT; see [LICENSE](LICENSE).
