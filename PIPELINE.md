# Data pipeline

How a field polygon becomes crop suitability, a growing cycle, hazards, a pest calendar and rotation strategies. Every number below is a named constant in `src/`.

```
 field GeoJSON + farmer context
        │ input.ts: parse, reproject to WGS84, resolve crop names
        ▼
 startFetches (pipeline.ts): all requests in parallel, cached in KV; SMS sessions start it when the farm is drawn
 ┌──────────┬───────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
 NASA POWER  NOAA GHCN   SSURGO /   SRTM      MODIS     USDA CDL   NASA EONET
 20 yr daily station     SoilGrids  30 m DEM  NDVI      8 yr crop  events
             10 yr                                       history    past year
 └────┬──────┘           │          │         │          │          │
 climate.ts              land.ts    elevation land.ts    cdl.ts     eonet.ts
 station correction ·    texture,   slope,    observed   rotation
 season years ·          AWC, K,    low spots season,    inference
 current-climate         drainage             bare months
 baseline · PM ET0
        ▼
 simulate.ts: 18 crops × 20 seasons, variety choice, rainfall-onset sowing, daily soil-water bucket
        ├──► cropSuitability                     pests.ts: degree-day scouting calendar
        ▼
 rotation.ts: current / +cover / diversified / water-wise → day-by-day layout → 5 scores + programs
        ├──► robustness: 8 re-runs with crop parameters perturbed ±20 % → recommendation stability
        ▼
 hazards.ts: 11 rule families + farmer reports → annotate strategies → result
```

## 1. Input (`input.ts`, `geo.ts`)
- **Accepted geometry:** a Feature or FeatureCollection with Polygon or MultiPolygon. The CRS comes from the GeoJSON `crs` member, a string, or `properties.crs`; the default is EPSG:4326.
- **Reprojection:** proj4 converts to WGS84. A result outside the Earth's coordinate range is rejected (HTTP 400).
- **Area and centroid:** geodesic area minus holes; area-weighted centroid.
- **Crop names** are matched to catalog ids through aliases. Priorities are 0–5 (default 3); irrigation defaults to `none`. `farmerOutcomes` is passed through.

## 2. Climate (`climate.ts`)
1. **Inputs:** NASA POWER daily `T2M_MAX, T2M_MIN, PRECTOTCORR, RH2M, GWETROOT, ALLSKY_SFC_SW_DWN, WS2M` for the last **20** complete years. Fill values are forward-filled; missing rain counts as 0.
2. **Station correction:**
   - The nearest NOAA GHCN-Daily station within ~50 km that has data through the last year is used, over the last 10 years.
   - Monthly mean offsets (station − POWER) for Tmax and Tmin are added to POWER, clipped to ±5 °C.
   - Every calendar month needs at least 30 overlapping days and the station at least 3 years of data; otherwise no correction is made and the gap is reported.
3. **Season years:** 365-day years (Feb 29 dropped) starting **Jan 1 in the northern hemisphere, Jul 1 in the southern**. Frost, sowing and phenology logic works on season-year days; output dates are converted back to calendar `MM-DD`.
4. **Current-climate baseline:** if annual mean temperature has a significant warming trend (|t| ≥ 2), each earlier year's temperatures are shifted up by `trend × (last year − year)`, so all 20 seasons represent today's temperature level. `climate.trends.tmeanC` keeps the observed trend.
5. **Reference ET0:** **FAO-56 Penman-Monteith**, daily, G = 0. Net radiation comes from POWER shortwave with FAO-56 clear-sky and long-wave terms; Ra from FAO-56 eq. 21; elevation from POWER.

| Derived quantity | Method |
|---|---|
| GDD | `((clamp(Tmax) + clamp(Tmin)) / 2) − Tbase`, clamped to [Tbase, 30 °C] |
| Frost dates | Per season year: last day ≤ 0 °C before mid-year, first after. Median, 90th percentile (spring) and 10th percentile (fall) |
| Monthly table | Means of temperatures, precipitation, ET0, P − ET0, root-zone wetness, frost days, days ≥ 35 °C, days ≥ 25 mm, humid-warm days (RH ≥ 85 %, 15–30 °C) |
| Erosivity | Annual R from Renard & Freimund (1994); monthly share ∝ Σ P² over days ≥ 12.7 mm |
| Extremes | 95th percentile of wet days, median annual max 5-day rain, median longest dry spell in the warm half of the season year |
| Trends | OLS slope per decade; `significant` when \|t\| ≥ 2 |

## 3. Soil, terrain, vegetation, history, events
- **Soil** (`sources/soil.ts`, `land.ts`):
  - **USDA SSURGO** in the US: the dominant map-unit component, thickness-weighted over 0–30 cm. It gives sand, clay, organic matter, pH, *measured* available water, drainage class and hydrologic group.
  - **SoilGrids** elsewhere, or when SSURGO has no answer, with available water from a USDA-texture lookup.
  - A lab soil test overrides values; a generic loam is used only when nothing is available.
  - Organic matter = SOC × 1.724. **K** comes from EPIC (Williams 1995), in SI units.
- **Terrain** (`sources/elevation.ts`, needs an OpenTopography key): SRTM 30 m grid over the field plus ~300 m.
  - Horn slope gives mean and p90 → RUSLE **LS** (McCool, slope length 50 m).
  - **D8 flow accumulation** gives the topographic wetness index `ln(a / tan β)`. The share of in-field cells with TWI > 11 is reported as `lowSpotSharePct`.
  - Without a key, the farmer's slope (or 2 %) is used.
- **Vegetation** (`sources/modis.ts`, `land.ts`): MOD13Q1 NDVI averaged over pixels inside the polygon (the centroid pixel for fields under ~1.5 km across).
  - Monthly normal (median of composites older than 12 months); bare months (NDVI < 0.3); last-12-months anomaly.
  - **Observed season:** median green-up and brown-down, where NDVI crosses the midpoint between the year's minimum and peak, in years with ≥ 18 composites and an amplitude ≥ 0.2.
- **Field history** (`sources/cdl.ts`): USDA CDL class at the centroid for the last 8 years, mapped to catalog crops.
  - `inferRotation` finds the shortest repeating cycle (period 1–3) in the last 6 mapped crops, or else takes the last 3.
- **Natural events** (`sources/eonet.ts`): NASA EONET events of the past 365 days within ±0.5°, with their distance.

## 4. Crop-season simulation (`simulate.ts`, `crops.ts`)
For **each catalog crop × each historical season year**:

1. **Sowing:**
   - `after_frost`: the later of the 80 %-safe last-frost date + 1 and the first day the 15-day-smoothed mean temperature reaches `sowTempC`.
   - `spring`: the first day the mean temperature reaches `sowTempC`.
   - `fall`: median first frost − 35 days.
   - **Rainfall onset** replaces the temperature rule when the climate is frost-free, or when the sowing month gets less than half its ET0 as rain. Each year, sowing is the first day (searching from 30 days before the temperature date) with ≥ 20 mm in 3 days and no 10-day dry spell in the next 30 days. If the rains never become reliable, that year counts as a failed season.
2. **Soil water:**
   - Total available water = `availableWater × rootDepth`.
   - Readily available water = `p × TAW`, with p = 0.4 / 0.5 / 0.6 by drought tolerance.
   - The bucket starts full if P − ET0 over the previous 90 days was positive, otherwise half-depleted.
   - Each day: `Ks = 1` while depletion ≤ RAW, else `(TAW − Dr) / (TAW − RAW)`. Actual ET = `Ks × Kc × ET0`; depletion `Dr = clamp(Dr − P + ETa, 0, TAW)`, with excess rain draining away.
   - Deficit = Σ (ETc − ETa). Flowering stress = days with Ks < 0.7 in the 45–65 % part of the season.
3. **Day loop** (≤ 330 days):
   - A killing frost (`Tmin ≤ frostKillC`) after `frostSafeDays` ends the season (default 10 days; corn and sorghum 28).
   - Heat days are days with `Tmax ≥ heatStressC`. GDD accumulates to `gddToMaturity`.
   - Overwintering cover crops must also survive to the median last spring frost.
4. **Variety choice:** for crops with a `gddRange` (corn, soybean, sorghum, sunflower, cotton), the longest variety, in 100 GDD steps, that matures in ≥ 85 % of years is chosen. It's reported as `maturityGdd` and `maturityClass` (early/medium/full).

Aggregated over years:
- season-fit and frost-kill probability
- median sowing date
- harvest = maturity + 14 days of dry-down for cash crops
- median heat days, crop water use, deficit median/p90, and flowering-stress days

**Suitability** = `100 × fit × (1 − 0.4·min(1, heat/20)) × pHFactor × (1 − unmetWater × droughtSensitivity) × (1 − 0.3·min(1, floweringStress/10))`
- `unmetWater` = deficit left after the farmer's irrigation (none, limited capacity or full) ÷ crop ET
- `droughtSensitivity` = 1.0 / 0.7 / 0.4
- the flowering term is skipped with full irrigation
- classes: ≥ 70 good, ≥ 40 marginal, otherwise poor

## 5. Pest calendar (`pests.ts`)
Degree-day models from US extension thresholds, converted to °C and run on the season-year temperatures. Median, 10th and 90th percentile dates, listed only for crops in play:

| Pest | Event | Base | Threshold | From |
|---|---|---|---|---|
| Corn rootworm | larvae begin hatching | 11.1 °C | 380 °C·d (684 °F·d) | season start |
| European corn borer | first moth flight | 10 °C | 208 °C·d (374 °F·d) | season start |
| European corn borer | second moth flight | 10 °C | 778 °C·d (1400 °F·d) | season start |
| Western bean cutworm | 25 % moth flight | 10 °C | 733 °C·d (1319 °F·d) | May 1 (N) / Nov 1 (S) |
| Alfalfa weevil | larval feeding begins | 8.9 °C | 167 °C·d (300 °F·d) | season start |

Air temperature stands in for soil temperature (rootworm). A model is omitted where its threshold is reached in fewer than half the years.

## 6. Rotation strategies (`rotation.ts`)
**Timeline.**
- Each rotation year holds the main crop harvested that year; fall-sown crops start the season year before. Perennials cover the whole year.
- Every day of the cycle is bare, crop, cover, winter-killed residue or perennial.
- Overlaps (harvest after the next crop's sowing) are reported as timing conflicts.

**Cover-crop fit for a gap.**
- The cover is planted 3 days after harvest and terminated 14 days before the next planting, with ≥ 30 days in between.
- It must reach its GDD target (counted only until first frost for winter-killed covers), and overwintering covers must survive in ≥ 80 % of winters.

**Choosing a cover.**
- +1 for a legume before an N-demanding crop
- + erosion priority × residue
- +0.5 for a winter-killed cover in dry climates or before spring crops
- +0.3 for a deep taproot on clay soils

**Scores (0–100).**

| Score | Formula |
|---|---|
| Soil health | `0.35·coverFraction + 0.25·legumeShare + 0.20·residue/3 + 0.20·(deep roots ≥ 1.5 m ? 1 : 0.5)` |
| Water | `1 − min(1, deficit / 400 mm)` |
| Resilience | `meanFit × (1 − meanHeatPenalty) × (1 − 0.5·unmetWater) × (timing conflict ? 0.7 : 1)` |
| Pest disruption | `min(1, families/3) − 0.3 × consecutive same-family pairs` (a perennial stand doesn't count) |
| Erosion | `1 − soilLoss / (2T)`, RUSLE `A = R·K·LS·ΣC·erosivity`, T = 11.2 t/ha/yr; C: bare 0.5, crop 0.2, cover 0.05, residue 0.15, perennial 0.02 |
| Overall | Mean of the five, weighted by the farmer's priorities (0–5) |

**Generators** (excluded crops never used; duplicates dropped):
1. **current**: the farmer's rotation; otherwise the CDL-inferred rotation; otherwise the current crop; otherwise the best cash crop (each fallback is flagged).
2. **cover**: current rotation plus the best cover in each gap.
3. **diversified**: one crop from a new plant family (top 5 with suitability ≥ 60), inserted at the best position, with covers.
4. **water_wise**: only when the thirstiest crop has a deficit ≥ 50 mm or water priority ≥ 4. That crop is replaced by a suitable crop with ≤ 75 % of its deficit.

**Conservation programs (US):** strategies with cover crops list NRCS practice 340 (Cover Crop); strategies with ≥ 3 plant families list practice 328 (Conservation Crop Rotation). These are eligibility hints for the income side; the farmer confirms locally.

**Robustness:**
- The whole crop simulation and strategy build is re-run **8 times**, with each crop's GDD and Kc multiplied by U(0.8, 1.2) and its frost and heat limits shifted by U(−2, +2) °C.
- `recommendation.stability.agreement` is the share of runs that recommend the same strategy. Below 0.7, the recommendation is flagged as tentative.

## 7. Hazard rules (`hazards.ts`)
| Hazard | Severity (moderate / high) | Affected crops |
|---|---|---|
| `frost` | worst crop frost-kill ≥ 10 % / ≥ 30 % | crops with frost-kill ≥ 10 % |
| `heat` | worst crop heat days ≥ 5 / ≥ 15; raised by a significant upward trend in heat days | crops with ≥ 5 heat days |
| `drought` | worst unmet-water share ≥ 15 % / ≥ 35 %; raised if last year's root-zone wetness z ≤ −1 | crops with ≥ 15 % unmet (flowering stress noted) |
| `heavy_rain` (waterlogging) | days ≥ 25 mm per year ≥ 5 / ≥ 10; raised by clay > 35 %, poor drainage or hydrologic group D (SSURGO), low spots ≥ 15 % of the field, or a significant upward trend | waterlogging-sensitive crops |
| `erosion` | RUSLE loss of the current rotation ≥ 0.5T / ≥ T | current crops without a cover |
| `disease` | humid-warm days in the warm season ≥ 20 / ≥ 40 | crops with known humid-weather diseases |
| `pest_cycle` | 2 families / 1 family in the current rotation | current crops (key pests listed) |
| `vegetation_stress` | NDVI anomaly ≤ −0.05 / ≤ −0.10 | current crops |
| `soil_ph`, `soil_organic_matter` | pH outside the range (> 0.5 off = high); OM < 2 % (< 1 % = high) | crops with misfit pH |
| `trend_warming`, `trend_drying` | significant trend → moderate | cool-season / drought-sensitive crops |
| `natural_events` | any wildfire/flood within ~50 km in the past year / ≥ 3 of them; other events = low | current crops |

Farmer `observedIssues` are keyword-matched to hazards. A match goes in `corroboratedByFarmer` and raises `low` to `moderate`. Unmatched issues become `farmer_reported_N` hazards for local review.

## 8. Market (`market/ingest.ts`, `market/engine.ts`)
**Data (D1, refreshed monthly by a Cron Trigger):** IMF world benchmark prices for corn (US No.2 Yellow, Gulf), soybeans and wheat (HRW, Gulf), US CPI-U (both via DBnomics), and USDA PSD US production, exports, domestic consumption, ending stocks and yield. Field region from the US Census geocoder.

For each priced crop that suits the field (class not poor):
1. **Harvest-month price:** the crop's price in its harvest month (`cropSuitability.harvestDate`) in each of the last 10 years with data, adjusted to the latest CPI month's dollars. P10/P50/P90 of those values form the range. US crops are also shown per bushel (corn 39.368, soybean and wheat 36.744 bu/t).
2. **Backtest:** each of the last 5 years is re-forecast from the 10 years before it: P10–P90 coverage, and P50 error vs the naive "same month last year".
3. **Best month to sell:** the month with the highest 10-year median real price, and its premium over the harvest month.
4. **Demand signals (USDA PSD):** stocks-to-use = ending stocks / (domestic consumption + exports) in the latest market year (the current USDA projection), compared with the previous 20 years: lower / normal / higher (thirds). Exports trend = OLS slope of the last 10 years relative to their mean (> +1 %/yr rising, < −1 %/yr falling).
5. **Gross revenue per ha (before costs):** US national yield (median of the last 5 years) × the field's season-fit probability × price range. The same with the best month's median price gives the value if the crop is stored and sold then (`bestMonthRevenuePerHa`); the SMS answer ranks crops by the better of the two ("which crops pay the most after harvest").
6. **Market score:** revenue relative to the best candidate × (1 − 0.3 · min(1, (P90 − P10) / P50)).
7. **Ranking:** `final = (1 − w)·suitability + w·marketScore`, `w = priorities.income / 10`. Rotations are ranked the same way using the mean revenue of their years; a rotation containing an unpriced crop gets no final market score and is listed after the ranked ones.

The SMS assistant texts the market answer only when the farmer asks how, where or when to sell.

## 9. Evaluation standard

### 9.1 Decision rubric (in every output)
- All strategies are scored on the same five transparent 0–100 criteria (§6), weighted by the farmer, not by us.
- Every strategy carries a `rationale`, `evidence`, `benefits` vs current, `risks`, `informationGaps` and `programs`.
- The current rotation is always first, so every claim is relative to what the farmer does now.

### 9.2 Data confidence (in every output)
- `dataSources[].status` covers every dataset. `confidence.level` comes from four core sources (NOAA, MODIS, soil, SRTM), whether the rotation is known, and recommendation stability.
- Probabilities come from 20 real seasons; `recommendation.stability` says how much the answer depends on generic crop parameters.
- The calendar is cross-checked against MODIS green-up and the rotation against the USDA crop map. Disagreements become information gaps.

### 9.3 Model validation
| Check | Reference | Acceptance | Status |
|---|---|---|---|
| Penman-Monteith | FAO-56 daily worked example (Uccle, 6 July) | 3.9 mm/day ± 0.5 | ✅ unit test |
| Frost dates | NOAA station normals | median within ±10 days | Iowa sample, station-corrected: last spring 04-19, first fall 10-22 (station 9 km away); formal normals comparison **to do** |
| Planting/harvest | USDA NASS Crop Progress active weeks | inside the active window | Iowa sample: corn 04-27 → 10-04, soybean 04-27 → 10-07, winter wheat harvest 07-09, all inside typical Iowa windows; NASS comparison **to do** |
| Pest timing | Extension degree-day calendars | within ±1 week of published regional dates | Iowa sample: corn borer flight 05-07, rootworm hatch 06-03, bean cutworm flight 07-11; formal comparison **to do** |
| Rotation history | USDA CDL | inferred cycle equals the farmer's report | ✅ Iowa sample: corn → soybean on both |
| Known infeasibilities | Agronomy | infeasible crops score `poor` | ✅ cotton 0 in Iowa; crimson clover fails Iowa winters |
| Robustness | ±20 % parameter perturbation | agreement ≥ 0.7, else flagged | ✅ Iowa sample: 8/8 |
| Harvest-price forecast | Rolling backtest, last 5 years | P50 error below the naive "same month last year"; P10–P90 coverage near 80 % | ✅ live (Iowa sample): corn 15.9 % vs 26.3 %, soybean 10.5 % vs 13.3 %, wheat 22.4 % vs 24.6 %; coverage 0.6 / 0.8 / 0.8 |
| Bare months vs calendar | MODIS NDVI | observed green-up within 30 days of simulated | runs automatically when MODIS answers |
| Hazard back-test | Last 3 years held out vs US Drought Monitor / NOAA storm events | flagged years over-represent observed events | **to do** |
| Expert review | Extension agronomist reads 3 sample outputs | no agronomically wrong recommendation | **to do** |
| Contract tests | `npm test` | stream order, sections equal the result, ≥ 3 strategies, scores in [0,100], hazards reference real crops, exclusions respected, POWER outage → error, signatures, boundaries, SMS flow, translation guard, report texts, market parsers / engine / texts | ✅ 39/39 passing |

### 9.4 Known limitations
- **Regional climate:** POWER is ~50 km. Station correction fixes temperature bias but not microclimate, and rainfall stays grid-based.
- **Crop parameters:** variety length is fitted locally; other parameters are generic (see robustness).
- **RUSLE:** a screening estimate (assumed slope length, simple C factors) for comparing strategies.
- **US-only data:** SSURGO and CDL; elsewhere soil comes from SoilGrids and there's no field history.
- **Market:** world benchmark prices, not local buyer prices (basis); revenue before costs; only corn, soybean and wheat are priced; the DBnomics mirror lags the IMF release by months.
