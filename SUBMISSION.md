# NASA Space Apps 2026 submission: Farm Helper

Challenge: *Adapting Farms with NASA Data*

## 1. In one sentence
*What did you build, and for whom?*

We built a text-message assistant that tells farmers which crops fit their field, what rotation to plant, which risks to watch and what prices usually look like at harvest. It's built from 20 years of NASA data, for farmers with basic phones and limited reading or digital literacy.

## 2. What you did
*The problem you took on and how your project addresses it.* (Judged: relevance)

Picking a new crop for a rotation is a bet. A crop that helps the soil can still get hit by frost, run out of water, bring in disease or fall outside the season. Most farm decision tools are dashboards that assume a laptop, English and comfort with maps, and a lot of farmers have none of that.

So we put the whole thing behind SMS. The farmer texts in their own language and marks their field on a one-page map (find my farm, tap the corners, continue). Then they answer a few short questions: past crops, crop stage, problems they see, water, what matters most. After they reply YES, about a minute later they get 4 texts:
- how well their crops fit this field
- a suggested rotation with planting and harvest months and cover crops
- the 2–3 biggest dangers with what to do
- a reminder to check it against their own experience

Every plan is compared against what they already grow, and each one comes with why, the evidence, the benefits, the risks and what to verify, which is what the challenge asked for. If they text "how and where should I sell my crops?", they get harvest-time price ranges, the month prices are usually highest and expected earnings per hectare.

## 3. Data you used
*Name each NASA dataset or resource and how you used it. Add any other data.* (Judged: relevance, science)

NASA:
- **POWER:** 20 years of daily temperature, rain, humidity, solar radiation, wind and root-zone soil wetness. We use it for frost dates, growing degree days, FAO-56 Penman-Monteith water demand, a daily soil-water model, heat days, heavy-rain days, dry spells and long-term trends.
- **MODIS NDVI** (MOD13Q1, via ORNL DAAC): how green the field is month by month, when it's bare, the actual green-up date (we check our planting calendar against it) and whether last year was weaker than normal.
- **SRTM** (via OpenTopography): slope for the erosion estimate, and a wetness index that finds low spots where water sits.
- **EONET:** fires, floods and storms within about 50 km in the past year.

Other:
- **NOAA GHCN** station temperatures, to correct the ~50 km POWER grid toward the nearest weather station.
- **USDA SSURGO** soil (drainage class, water holding) in the US, and ISRIC SoilGrids elsewhere.
- **USDA Cropland Data Layer**, for what actually grew on the field over the last 8 years.
- **IMF commodity prices and US CPI** (via DBnomics), **USDA PSD** supply and demand, and the **US Census geocoder** for the market answer.

## 4. The science
*The question your project asks or answers, and why the data fits it.* (Judged: science)

Our question is: given this field's real weather history, soil and slope, which crops would have made it to harvest and how often, and which rotation protects the soil and water best for what this farmer cares about?

Rotation decisions come down to the frost-free window, the water balance, heat at flowering and how long the soil sits bare during heavy rain. POWER measures those daily, for 20 years, anywhere on Earth. MODIS shows when the field is actually bare, and SRTM gives the slope that drives erosion.

How we use the data:
1. We replay 18 crops through each of the 20 real seasons: sow by frost, soil temperature or rainfall onset; count growing degree days to maturity; run an FAO-56 daily soil-water bucket; check for killing frost and heat days. That gives answers like "reached harvest in 9 of 10 years" instead of a vague score.
2. Rotations are laid out day by day to get soil cover, a RUSLE erosion estimate, legume share and pest-family repeats.
3. We re-run everything 8 times with crop parameters shifted ±20%, to see if the recommendation holds.

What we checked:
- Our Penman-Monteith code matches the FAO-56 worked example.
- On an Iowa test field, planting and harvest dates land in typical Iowa windows.
- The harvest-price forecast beats a naive "same month last year" guess for corn (15.9% vs 26.3% error), soybean (10.5% vs 13.3%) and wheat (22.4% vs 24.6%).

The limits we tell the farmer about: POWER is a ~50 km grid (we correct temperatures with the nearest NOAA station), and crop parameters are generic apart from variety length.

## 5. What it is and how it works
*What it looks like and does. Tools, code, APIs. A screenshot link helps.* (Judged: coding)

For the farmer, it's a text conversation plus one map page. For everyone else there's a public demo page where you draw a field and watch the analysis stream in section by section: https://farm-rotation-pipeline.rshaspaceapps.workers.dev

Everything runs on one Cloudflare Worker in TypeScript:
- **Agents SDK** (Durable Objects): one agent per phone number, holding the farmer's profile and handling messages in order.
- **Workers AI** (Mistral Small 3.1): reads replies into fields and translates.
- **KV:** caches NASA and USDA responses.
- **D1:** holds the market data, refreshed monthly by a Cron Trigger.

Twilio handles the SMS and Leaflet draws the map. The analysis is a public API (`POST /analyze`) that streams results as Server-Sent Events. There are 39 automated tests. Code: https://github.com/harsh2274/crop_recommendation_system

Screenshot: *(add link)*

## 6. What is new here
*The idea, approach or presentation that is different.* (Judged: creativity)

The model never writes a fact. Code writes every number, date, link and recommendation the farmer reads; the AI only reads their replies and translates our text. A translation that changes any number gets rejected and the English original is sent instead. We built it that way after the model made up a fake map link in our first test.

The rest:
- It runs over SMS and one map page in the farmer's language, so there's no dashboard to learn.
- Advice comes as odds from real seasons ("9 of 10 years"), and we tell the farmer when a plan only holds under some assumptions.
- It cross-checks itself against reality: the USDA crop map against what the farmer says, MODIS green-up against our planting calendar, and NOAA stations against the NASA grid.
- Market info shows up only when the farmer asks. The price ranges are backtested, and where we have no buyer list we say so.
