# NASA Space Apps 2026 submission: Farm Helper

Challenge: *Adapting Farms with NASA Data*

## 1. In one sentence
*What did you build, and for whom?*

We built a text-message assistant that tells farmers which crops fit their field, what rotation to plant, which risks to watch and which crops pay the most after harvest. It's built from 20 years of NASA data plus market data, for farmers with basic phones and limited reading or digital literacy.

## 2. What you did
*The problem you took on and how your project addresses it.* (Judged: relevance)

Picking a new crop for a rotation is a bet. A crop that helps the soil can still get hit by frost, run out of water, bring in disease or fall outside the season. Even when it grows fine, it might not sell well. Most farm decision tools are dashboards that assume a laptop, English and comfort with maps, and a lot of farmers have none of that.

So we put the whole thing behind SMS. The project has two parts.

**Part 1: what grows well here.** The farmer texts in their own language and marks their field on a one-page map (find my farm, tap the corners, continue). Then they answer a few short questions: past crops, crop stage, problems they see, water, what matters most. After they reply YES, about a minute later they get 4 texts:
- how well their crops fit this field
- a suggested rotation with planting and harvest months and cover crops
- the 2–3 biggest dangers with what to do
- a reminder to check it against their own experience

The last text asks if they want the complete report as a PDF. If they say yes, they get a link to a page with the PDF: a satellite map of their farm with its outline, charts of crop fit, rain and temperature by month, the plans side by side, the dangers, the market numbers and the texts they got. It's something they can keep or show a farm advisor.

Every plan is compared against what they already grow, and each one comes with why, the evidence, the benefits, the risks and what to verify, which is what the challenge asked for.

**Part 2: what sells well (my teammate's part).** Once the farmer knows which crops fit, the next question is which of them will bring the most money. When they text something like "how and where should I sell my crops?", they get the crops that fit their field ranked by value per hectare after harvest, sold right away or stored until the month prices are usually highest. For our Iowa test field the answer was:
- corn: about $2,201 per hectare if sold at harvest in October, about $2,333 if stored and sold in June
- soybean: about $1,351 at harvest, about $1,406 if sold in July
- winter wheat: about $613, best sold at harvest

Rice is priced too, as milled export rice. The same reply gives the usual price range at harvest, whether US stocks are tighter than usual, and an honest line on where to sell: we don't have a list of local buyers, so compare offers from nearby elevators and cooperatives.

## 3. Data you used
*Name each NASA dataset or resource and how you used it. Add any other data.* (Judged: relevance, science)

NASA:
- **POWER:** 20 years of daily temperature, rain, humidity, solar radiation, wind and root-zone soil wetness. We use it for frost dates, growing degree days, FAO-56 Penman-Monteith water demand, a daily soil-water model, heat days, heavy-rain days, dry spells and long-term trends.
- **MODIS NDVI** (MOD13Q1, via ORNL DAAC): how green the field is month by month, when it's bare, the actual green-up date (we check our planting calendar against it) and whether last year was weaker than normal.
- **SRTM** (via OpenTopography): slope for the erosion estimate, and a wetness index that finds low spots where water sits.
- **EONET:** fires, floods and storms within about 50 km in the past year.

Other data, part 1:
- **NOAA GHCN** station temperatures, to correct the ~50 km POWER grid toward the nearest weather station.
- **USDA SSURGO** soil (drainage class, water holding) in the US, and ISRIC SoilGrids elsewhere.
- **USDA Cropland Data Layer**, for what actually grew on the field over the last 8 years.

Other data, part 2 (market):
- **IMF monthly commodity prices** for corn, soybeans, wheat and rice since 1990 (via DBnomics), for the price range in each crop's harvest month and the month prices are usually highest.
- **US CPI** (BLS, via DBnomics), to put every year's prices in the same dollars.
- **USDA PSD** supply and demand: US production, exports, domestic use and ending stocks give a stocks-to-use signal (tight stocks tend to support prices), and US yields turn prices into value per hectare.
- **US Census geocoder**, for the field's state and county.

## 4. The science
*The question your project asks or answers, and why the data fits it.* (Judged: science)

Part 1 asks: given this field's real weather history, soil and slope, which crops would have made it to harvest and how often, and which rotation protects the soil and water best for what this farmer cares about?

Rotation decisions come down to the frost-free window, the water balance, heat at flowering and how long the soil sits bare during heavy rain. POWER measures those daily, for 20 years, anywhere on Earth. MODIS shows when the field is actually bare, and SRTM gives the slope that drives erosion.

How we use the data:
1. We replay 19 crops (rice as a flooded paddy) through each of the 20 real seasons: sow by frost, soil temperature or rainfall onset; count growing degree days to maturity; run an FAO-56 daily soil-water bucket; check for killing frost and heat days. That gives answers like "reached harvest in 9 of 10 years" instead of a vague score.
2. Rotations are laid out day by day to get soil cover, a RUSLE erosion estimate, legume share and pest-family repeats.
3. We re-run everything 8 times with crop parameters shifted ±20%, to see if the recommendation holds.

Part 2 asks: of the crops that fit this field, which are likely to bring the most money after harvest, and is it worth storing them?

The price question depends on when the crop is harvested, which part 1 already computes for this field. For each crop we take the price in its harvest month over the last 10 years, adjusted to the same dollars, and use the low, middle and high values as the expected range. We do the same for every month to find when prices usually peak. Value per hectare is the US yield times how often the crop reaches harvest on this field times the price.

What we checked:
- Our Penman-Monteith code matches the FAO-56 worked example.
- On an Iowa test field, planting and harvest dates land in typical Iowa windows.
- We re-forecast each of the last 5 years from the 10 years before it. The harvest-price forecast beat a naive "same month last year" guess for corn (15.9% vs 26.3% error), soybean (10.5% vs 13.3%) and wheat (22.4% vs 24.6%).

The limits we tell the farmer about:
- POWER is a ~50 km grid; we correct temperatures with the nearest NOAA station.
- Crop parameters are generic apart from variety length.
- Prices are world benchmark prices, not the local elevator's price.
- Values are before costs, and the price data runs through mid-2025.

## 5. What it is and how it works
*What it looks like and does. Tools, code, APIs. A screenshot link helps.* (Judged: coding)

For the farmer, it's a text conversation plus one map page, and a PDF if they want it. For everyone else there's a public demo page where you draw a field and watch the analysis stream in section by section, ending with the table of which crops pay the most after harvest: https://farm-rotation-pipeline.rshaspaceapps.workers.dev

To try the farmer side without a phone, there's an SMS simulator: the same assistant, map, report and PDF, with the texts showing up in a chat window: https://farm-rotation-pipeline.rshaspaceapps.workers.dev/chat

Everything runs on one Cloudflare Worker in TypeScript:
- **Agents SDK** (Durable Objects): one agent per phone number, holding the farmer's profile and handling messages in order.
- **Workers AI** (Mistral Small 3.1): reads replies into fields and translates. When a translation fails our checks, Llama 4 Scout gets a second try (Mistral garbles some Hindi letters).
- **KV:** caches NASA and USDA responses.
- **D1:** holds the market data (prices, CPI, USDA supply and demand), refreshed monthly by a Cron Trigger, so a farmer never waits on a market website.

Twilio handles the SMS and Leaflet draws the map. The analysis is a public API (`POST /analyze`) that streams results as Server-Sent Events, with the market ranking as its own section. PDFs are drawn with pdf-lib inside the Worker. There are 56 automated tests. Code: https://github.com/harsh2274/crop_recommendation_system

Screenshot: *(add link)*

## 6. What is new here
*The idea, approach or presentation that is different.* (Judged: creativity)

The model never writes a fact. Code writes every number, date, link and recommendation the farmer reads; the AI only reads their replies and translates our text. A translation that changes any number gets rejected and the English original is sent instead. We built it that way after the model made up a fake map link in our first test.

The rest:
- It runs over SMS and one map page in the farmer's language, so there's no dashboard to learn.
- Advice comes as odds from real seasons ("9 of 10 years"), and we tell the farmer when a plan only holds under some assumptions.
- It cross-checks itself against reality: the USDA crop map against what the farmer says, MODIS green-up against our planting calendar, and NOAA stations against the NASA grid.
- The market ranking uses this field's own harvest month and harvest odds from part 1. So "which crop pays the most" is about this field, not the average US farm, and it shows whether storing until a better month is worth it.
- Market info shows up only when the farmer asks. The price ranges are backtested, and where we have no buyer list we say so.
