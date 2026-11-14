# Output contract

The analysis is a black box: **one request in, one stream of results out.** `schemaVersion: "1.0"`.

A real example is [`examples/sample-output.json`](examples/sample-output.json), produced from [`examples/sample-input.json`](examples/sample-input.json). In that run MODIS was down (`vegetation: null`) and no OpenTopography key was set (`slopePct: null`).

The SMS assistant (SMS.md) calls the same pipeline in-process and texts an explanation of the `result`.

## 1. Transport

| Call | Response | Use it for |
|---|---|---|
| `POST /analyze` (body = GeoJSON) | `text/event-stream` (Server-Sent Events) | A UI that renders each section as it arrives |
| `POST /analyze?format=json` | `application/json` = the final `result` | Server-to-server (marketing pipeline), scripts |

Errors:
- `400 {"error": "..."}` for bad JSON, bad geometry, or a CRS that doesn't match the coordinates.
- `502` in JSON mode, or `event: error` mid-stream, when NASA POWER is unreachable.
- Optional sources never fail the request. They appear as `dataSources[].status = "unavailable"`.

### Stream events (in order)
Each event's `data` is exactly the matching part of the final result.

| `event:` | `data` | Typical arrival |
|---|---|---|
| `field` | `{ field, context }` | instant |
| `soil` | `soil` | < 1 s |
| `climate` | `climate` | 1–3 s |
| `terrain` | `{ elevationM, slopePct, lowSpotSharePct }` | 1–3 s |
| `cropSuitability` | `cropSuitability[]` | right after climate |
| `fieldHistory` | `fieldHistory` or `null` | ~2 s |
| `vegetation` | `vegetation` or `null` | up to 40 s (MODIS) |
| `hazards` | `hazards[]` | right after vegetation |
| `pestCalendar` | `pestCalendar[]` | same |
| `rotations` | `{ rotations, recommendation }` | same |
| `market` | `market` or `null` | right after rotations (reads D1) |
| `result` | full `PipelineOutput` | last |
| `error` | `{ message }` | on failure |

Slow sources are cached in KV, and the SMS flow starts fetching them when the farmer draws the farm, so a typical analysis finishes in a few seconds.

Browser example (`EventSource` only supports GET, so read the POST body):
```js
const res = await fetch(`${API}/analyze`, { method: "POST", body: JSON.stringify(geojson) });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    onEvent(block.match(/^event: (.*)$/m)[1], JSON.parse(block.match(/^data: (.*)$/m)[1]));
  }
}
```

## 2. Input
A GeoJSON `Feature` (or `FeatureCollection`, first polygon feature) with `Polygon`/`MultiPolygon` geometry. Only the geometry is required.

```jsonc
{
  "type": "Feature",
  "crs": { "type": "name", "properties": { "name": "EPSG:32615" } }, // or "crs": "EPSG:32615"; default EPSG:4326
  "geometry": { "type": "Polygon", "coordinates": [[[437584, 4660751], ...]] },
  "properties": {
    "fieldId": "demo-iowa-001",
    "farmer": { "...": "passed through untouched" },
    "currentRotation": [{ "crop": "corn" }, { "crop": "soybean", "cover": "rye" }], // or ["corn", "soybean"]
    "currentSeason": { "crop": "corn", "plantingDate": "2026-05-02", "growthStage": "V6", "schedule": [] },
    "observedIssues": ["standing water in low spots every spring"],
    "farmerOutcomes": [{ "date": "2026-10-20", "crop": "corn", "text": "yield lower in wet corner" }],
    "priorities": { "soilHealth": 5, "water": 2, "resilience": 4, "pest": 4, "erosion": 4, "income": 4 }, // 0-5, default 3
    "constraints": { "irrigation": "none|limited|full", "irrigationCapacityMm": 150, "excludeCrops": ["potato"], "slopePct": 3 },
    "soilTest": { "ph": 6.4, "organicMatterPct": 3.8, "clayPct": 26, "sandPct": 38 }
  }
}
```

- **CRS:** EPSG:4326/CRS84, 3857, 4269, WGS84 UTM (326xx/327xx), NAD83 UTM (269xx), proj4 strings or WKT.
- **Crop names:** free text, matched with aliases. Unknown names go to `context.unresolvedCrops`.
- **Missing `currentRotation`:** in the US the USDA crop map supplies it.

## 3. Result reference
`MM-DD` dates are typical-year (climatological) dates.

### `field`
`fieldId`, `centroid {lat, lon}`, `areaHa`, `bbox`, `elevationM`, `slopePct` (SRTM mean, else farmer value, else `null`), `lowSpotSharePct` (% of field with topographic wetness index > 11; `null` without SRTM), `region` (`{country, countryIso3, admin1, admin1Code, county, countyFips}` from the US Census geocoder; `null` outside the US), `sourceCrs`.

### `context`
Normalized input: `farmer`, `priorities`, `constraints`, `currentRotation` (as used), `rotationSource` (`farmer`, `usda_cdl` when taken from the USDA crop map, or `assumed`), `currentSeason`, `observedIssues`, `farmerOutcomes`, `unresolvedCrops`.

### `dataSources[]`
`{ id, dataset, provider, variables[], spatialResolution, temporalCoverage, status, note? }` for `nasa_power`, `noaa_ghcn`, `modis_ndvi`, `soil`, `srtm`, `usda_cdl`, `eonet`, `market_prices`, `usda_psd` (DATASETS.md).

### `climate`
| Field | Meaning |
|---|---|
| `period` | `{startYear, endYear, years}` |
| `baseline` | `hemisphere`; `stationCorrection` (`stationId`, `name`, `distanceKm`, `overlapYears`, monthly `tmaxOffsetC[12]`, `tminOffsetC[12]`) or `null`; `warmingAdjustmentCPerDecade` (set when earlier years were shifted to today's level) |
| `annual` | `tmeanC`, `precipMm`, `et0Mm` (FAO-56 Penman-Monteith), `aridityIndex` (P/ET0), `gddBase10`, `rainfallErosivity` |
| `frost` | `lastSpringMedian`, `lastSpring90`, `firstFallMedian`, `firstFall10`, `frostFreeDaysMedian` |
| `extremes` | `wetDayP95Mm`, `max5DayPrecipMm`, `longestDrySpellDays` |
| `recentYear` | `precipAnomalyPct`, `rootZoneWetnessZ` |
| `trends` | `tmeanC` (observed), `precipMm`, `heavyRainDays`, `extremeHeatDays`, `rootZoneWetness`: `{perDecade, significant}` |
| `monthly[12]` | `tmeanC, tmaxC, tminC, precipMm, et0Mm, waterBalanceMm, rootZoneWetness, frostDays, extremeHeatDays, heavyRainDays, diseaseRiskDays, erosivityShare` |

### `soil`
`source` (one of `ssurgo`, `ssurgo+soil_test`, `soilgrids`, `soilgrids+soil_test`, `soil_test`, `default`), `clayPct`, `sandPct`, `siltPct`, `texture` (USDA), `organicMatterPct`, `ph`, `availableWaterMmPerM`, `erodibilityK`, `drainageClass` and `hydrologicGroup` (SSURGO; `null` elsewhere).

### `vegetation` (MODIS, or `null`)
`monthlyNdvi[12]`, `bareMonths`, `peakMonth`, `latestSeasonAnomaly`, `observedSeason {greenUp, brownDown}` (median `MM-DD`, or `null`), `pixelsUsed`, `years`.

### `fieldHistory` (USDA CDL, US only; otherwise `null`)
`[{ year, code, category, cropId }]`: what was mapped on the field each of the last 8 years (`cropId` is `null` for classes outside the catalog, e.g. pasture).

### `cropSuitability[]` (objective 1), best first
| Field | Meaning |
|---|---|
| `cropId, name, family, role` | `role`: `cash`, `forage` or `cover` |
| `suitability` 0–100, `class` | `good` ≥ 70, `marginal` ≥ 40, otherwise `poor` |
| `seasonFitProbability`, `frostKillProbability` | from 20 simulated seasons |
| `sowingRule` | `after_frost`, `soil_temperature`, `rainfall_onset` or `fall` |
| `plantingDate`, `harvestDate`, `seasonDays` | typical calendar (harvest = maturity + 14 days for grain; for covers, when useful biomass is reached) |
| `maturityGdd`, `maturityClass` | variety length chosen to fit the season (`early`, `medium`, `full`; `fixed` for single-type crops) |
| `floweringStressDays` | median days of water stress around flowering |
| `heatStressDays` | median days above the crop's heat threshold |
| `waterUseMm`, `irrigationNeedMm {median, p90}` | crop ET and the water deficit (demand that rain and soil water didn't meet) |
| `phFit`, `limitingFactors[]` | plain-language reasons the score isn't 100 |

Excluded crops stay in this list but never enter a rotation.

### `pestCalendar[]`
`{ pestId, pest, crops[], event, date, earliest, latest, action }`: when to scout, from degree-day models, for crops in play.

### `hazards[]` (objective 3), high → low
| Field | Meaning |
|---|---|
| `id` | `frost`, `heat`, `drought`, `heavy_rain`, `erosion`, `disease`, `pest_cycle`, `vegetation_stress`, `soil_ph`, `soil_organic_matter`, `trend_warming`, `trend_drying`, `natural_events`, `farmer_reported_N` |
| `category`, `title`, `severity` | severity `low`, `moderate` or `high` (PIPELINE.md §7) |
| `likelihood`, `months[]`, `upcoming` | `upcoming` = within the next 3 months |
| `metrics`, `affectedCrops[] {cropId, impact}`, `mitigation[]`, `sources[]`, `corroboratedByFarmer[]` | |

### `rotations[]` (objective 2)
Up to 4 strategies: `current` (always first), `cover`, `diversified`, `water_wise` (only when water is limiting).

| Field | Meaning |
|---|---|
| `sequence[]` | `{year, crop, cover, plantDate, harvestDate}` |
| `scores` | `soilHealth, water, resilience, pest, erosion` and `overall` (priority-weighted) |
| `metrics` | `soilCoverFraction`, `estimatedSoilLossTHaYr`, `irrigationNeedMmYr`, `legumeShare`, `distinctFamilies`, `meanSeasonFitProbability` |
| `programs[]` | US conservation practices it may qualify for (NRCS 340 Cover Crop, 328 Conservation Crop Rotation) |
| `rationale`, `evidence[]`, `benefits[]`, `risks[]`, `informationGaps[]` | why, the data behind it, gains vs current, what could go wrong, what to verify |

### `recommendation`, `confidence`, `disclaimer`
- `recommendation`: `{rotationId, summary, stability {runs, agreement}}`. `agreement` is the share of the ±20 % parameter re-runs that keep the same recommendation.
- `confidence`: `{level, reasons[]}`.
- `disclaimer`: always show it.

### `market` (objective 4), or `null` when no market data is loaded
World benchmark prices for corn, soybean and wheat, computed with every report. The SMS assistant shows them only when the farmer asks how, where or when to sell (SMS.md).

| Field | Meaning |
|---|---|
| `basis`, `pricesThrough`, `dollarsOf`, `dataUpdated` | price source; latest price month; prices are adjusted to this month's US dollars (latest CPI month); last ingestion run |
| `crops[]` | per priced crop that suits the field: `harvestMonth` (from `cropSuitability.harvestDate`); `price.usdPerTonne` / `price.usdPerBushel` (US) as `{p10, p50, p90}` over the last 10 years; `backtest {years, coverage, mapePct, naiveMapePct}`; `bestSellMonth {month, usdPerTonneP50, premiumPct}`; `demand {marketYear, stocksToUse, stocksVsUsual, exportsTrend}` (USDA PSD, US); `yieldTHa` (US national, median of 5 years); `grossRevenuePerHa` (before costs, sold at harvest); `bestMonthRevenuePerHa` (typical value per hectare if stored and sold in `bestSellMonth`); `marketScore` 0–100 |
| `ranking[]` | `{cropId, agronomic, market, final}`: `final = (1 − incomeWeight)·agronomic + incomeWeight·market` |
| `rotationRanking[]` | the same per rotation; `final` is `null` (and listed last) when a rotation contains a crop without market data |
| `incomeWeight` | `priorities.income / 10` (0–0.5) |
| `notes[]` | data age, basis (local prices differ), revenue before costs, crops without market data |

## 4. Marketing handoff (objective 4)
The `market` section is the demo version of the marketing pipeline. Fields a fuller marketing pipeline would extend:

| Need | Field |
|---|---|
| Market region | `field.region` (state, county FIPS), `field.centroid` |
| Agronomically viable crops | `cropSuitability[]` where `role != "cover"` and `class != "poor"` |
| When produce reaches market | `cropSuitability[].harvestDate`, `market.crops[].harvestMonth` |
| Price ranges and timing | `market.crops[].price`, `bestSellMonth` |
| Production risk | `hazards[]`, `seasonFitProbability`, `recommendation.stability` |
| Extra income | `rotations[].programs` |
| Weight of income | `context.priorities.income` → `market.incomeWeight` |
