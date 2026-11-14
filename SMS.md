# SMS assistant (Twilio + Cloudflare Workers AI + Agents SDK)

Farmers use the product entirely by text message, plus one simple map page for marking the farm. The assistant replies in the language of the farmer's latest written message; short replies ("YES", "3") keep the current language.

## The rule: facts come from code, words from the model
The model **never writes facts**: no links, numbers, dates, recommendations or advice. Its two jobs are narrow and checked:

| Job | Who | Guarantee |
|---|---|---|
| Recommendations, risks, dates, numbers | The deterministic analysis pipeline | No model involved |
| Report texts and follow-up answers | `facts.ts` templates filled from result fields | Every sentence comes from data; answers to questions are pre-written snippets |
| What to ask next, and every question text | `flow.ts` state machine | Fixed English texts; the model doesn't choose what to say |
| Reading the farmer's message | `flow.understand()` → structured fields only | Values validated (enums, dates, crop names resolved against the catalog, the language must be a plain language name); numbered replies, YES/NO, `LINK`, `NEW`, `RESET` parsed by code; everything echoed back in a summary the farmer confirms before any analysis |
| Answering a question | Model may only **pick snippet ids** from the list | The reply is the snippet text; no match → "I do not have that information…" |
| Translation | `ai.translate()` | Accepted only if it has the same numbers as the English source (compared by value), no URL, and a plausible length (no added or dropped sentences); otherwise the English original is sent |
| Links | Code appends the map link after translation | The model never sees or writes a link |
| Harvest reports | Stored in the farmer's own words | No model summary |

## Conversation
```
Farmer texts the service number ("Hola, cultivo maíz")
  │ Twilio → POST /sms (signature checked) → FarmerSession Agent (one per phone number)
  ▼ this.queue(): durable, one message at a time, in order
understand() → fields → apply() → nextStep() → code-written English texts → translate() → (+ map link) → SMS
  1. intro + "What crop or crops are you growing on this field now?"
  2. "Please mark your farm on the map…" + link ──► /map/<farmer>/<token>
                                                    📍 Find my farm → ✏️ Start drawing → tap corners → ✓ Continue
                                                    "✅ We took note of the footprint of your farm…"
     ◄── boundary saved: "Thank you! I received your farm: about 64.0 hectares (158.0 acres)." (slow datasets start downloading)
  3. past crops · 4. crop stage (1-5) · 5. problems (or NO) · 6. water (1-3) · 7. what matters most (1-5)
  8. summary of everything collected → "Reply YES to start the report, or tell me what to change."
  ▼ YES → "I am calculating your farm report now…" → analysis pipeline (same Worker)
  4 report texts (facts.ts): your crops · suggested plan + stability + programs · things to watch + next pest check · advisor note (which also says they can ask which crops sell best and where to sell)
  ▼
Questions → snippet answers · "how / where / when should I sell?" → market texts · new information → summary again · NEW → new report · RESET → delete profile
```
Every optional question accepts "don't know" or "no" and moves on.

**Map link requests** ("LINK", "send the map again", "I drew the wrong field", one-word "map/mapa/enlace/lien/karte…"):
- before the farm is drawn: the link is resent with the drawing instructions
- after it is drawn: "Draw your farm again and press Continue: I will use the new shape", and the conversation continues when the new shape arrives; after a report, a new shape makes the report outdated, so the summary is shown again for a new report
- while a report is calculating: "reply LINK after it arrives"; a shape submitted from an older link during a calculation is kept, and the farmer is offered a new report afterwards
- an expired link (72 h) is replaced automatically

**Market questions** ("how should I sell my corn?", "where can I sell?", "when should I sell?", "what are prices?", "which crop sells best?", one-word "sell / price / market / vender / precio / mercado / prix…"): after a report, 4 texts written by code from `result.market`:
1. crops that pay the most after harvest on this field: the crops that fit, ranked by value per hectare before costs, each with its value if sold at harvest and, when storing pays, if sold in the month prices are usually highest
2. prices at harvest: P10–P90 range and typical price per bushel (US) or tonne, in dollars of the latest CPI month
3. when to sell: the month prices are usually highest and how much above harvest time, plus US stock signals when unusual
4. where to sell: no local buyer list; compare several elevators, cooperatives or processors; ranges are not promises

Before a report the reply is "I can answer questions once your farm report is ready"; without market data, an honest "I do not have market prices for your crops yet".

**Code-parsed replies** (no model): numbers for stage, water and priorities; YES/NO words in common languages; LINK, NEW, RESET. Twilio opt-out words (STOP, UNSUBSCRIBE, …) are left to Twilio.

**Consistency:** the boundary and the report status always come from the latest stored state, so a map submitted while a message is being processed, or a report finishing during a turn, is never overwritten. RESET during a calculation drops the old report.

## Map page
- **Two steps:** find the farm, then draw.
- **Can't be submitted wrong:** Continue stays disabled below 3 corners, crossing lines are rejected in the browser, and implausible sizes are rejected on the server.
- **Language:** page texts are in the farmer's current language (`profile.language`), translated by `translate()` (checked like messages) in the same model call as the message that carries the link, and inserted with `textContent`. If the language changes later, the same link is re-translated when opened.
- **Links:** expire after 72 hours and are tied to one farmer by an unguessable token. The URL uses the Agent's name, a keyed hash of the phone number, never the number itself.

## Privacy and state
- The phone number stays in the farmer's Agent state. The analysis payload carries an opaque id.
- No public Agent routes are mounted; state is reachable only through the Worker's RPC calls.
- Twilio retries are de-duplicated by `MessageSid`. Queued turns are not retried (that would double-text).

## Code
| File | Role |
|---|---|
| `src/index.ts` | Routes `/sms` (webhook) and `/map/:farmer/:token` (page + submit) |
| `src/sms/session.ts` | `FarmerSession` Agent: queued turns, reply assembly (translate + link), analysis, prefetch, RESET |
| `src/sms/flow.ts` | State machine, all conversation texts, `understand()` (model → validated fields), `parseDirect()` (code), `apply()` |
| `src/sms/facts.ts` | Report messages and follow-up snippets, written from the result |
| `src/sms/ai.ts` | Workers AI: `extract()` (structured output) and `translate()` (number-checked) |
| `src/sms/profile.ts` | `FarmerProfile`, boundary validation, profile → pipeline input |
| `src/sms/mappage.ts` | Map page HTML (Leaflet + Esri satellite tiles) and its texts |
| `src/sms/twilio.ts` | Signature verification and outbound SMS (printed to the console when Twilio isn't configured) |

**Model:** Workers AI `@cf/mistralai/mistral-small-3.1-24b-instruct`: about 1.6 s per call with correct structured output and accented Spanish in our benchmark (faster and more reliable than the other function-calling models tested). Each turn makes at most two calls (read the message, translate the reply), and the analysis runs detached from the message queue (`keepAliveWhile`), so a new text is never stuck behind it. Change `MODEL` in `src/sms/ai.ts`.

## Demo setup with the Twilio CLI
You need two Twilio numbers in the same account:
- **Service number:** farmers text it; its SMS webhook is the Worker.
- **Dev Phone number:** plays the farmer.

```bash
npm install -g twilio-cli
twilio login                                    # Account SID + Auth Token; pick any profile name
twilio profiles:use <profile>
twilio plugins:install @twilio-labs/plugin-dev-phone
twilio phone-numbers:update <SERVICE_NUMBER> --sms-url https://<worker>.workers.dev/sms
twilio dev-phone                                # choose the other number, text the service number
npx wrangler tail                               # live logs, from the project folder
```
- Restart the Dev Phone with Ctrl+C and `twilio dev-phone`.
- Text `RESET` to clear a test farmer's stored profile.
- Trial accounts prefix messages and can only text verified numbers. Carrier filtering of outbound texts may require A2P 10DLC registration or a toll-free number.

## Secrets
| Name | Value | Required |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account that owns the service number | yes |
| `TWILIO_AUTH_TOKEN` | same account (also verifies webhook signatures) | yes |
| `TWILIO_PHONE_NUMBER` | service number, E.164, e.g. `+15551234567` | yes |
| `OPENTOPO_API_KEY` | opentopography.org (free) | optional (slope, low spots) |

Set each with `npx wrangler secret put <NAME>`. For local runs, put the same names in `.dev.vars` (plus `ALLOW_UNSIGNED_SMS=true` for curl testing without Twilio).
