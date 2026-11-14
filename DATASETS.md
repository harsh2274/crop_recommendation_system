# Dataset audit

Reliability notes come from live calls made on 2026-11-14.

## 1. What the product is for

> Let farmers know **their crops**, the **recommended growing cycle**, the **possible hazards**, and the **market potential** of their crops.

This backend covers objectives 1–3 and produces the inputs for objective 4. The marketing pipeline scores market potential on top of our output.

| # | Objective | Output section | Main evidence |
|---|---|---|---|
| 1 | **Their crops** | `cropSuitability[]` (score, season-fit probability, variety length, limiting factors), `fieldHistory` | NASA POWER + NOAA station correction, SSURGO / SoilGrids, USDA CDL |
| 2 | **Recommended growing cycle** | `rotations[]`, `recommendation` (with stability), per-crop planting/harvest dates | NASA POWER frost dates, GDD, rainfall onset, soil water; MODIS observed season; SRTM slope |
| 3 | **Possible hazards** | `hazards[]`, `pestCalendar[]` | NASA POWER, MODIS, SSURGO drainage, SRTM low spots, NASA EONET, farmer reports |
| 4 | **Market potential** | `market` (harvest-month price ranges, best month to sell, US supply/demand, gross revenue, combined ranking); texted when the farmer asks how/where/when to sell | IMF world prices + US CPI (DBnomics), USDA PSD, US Census region |

## 2. Datasets used

| Dataset | Provider / access | Variables | Resolution | Coverage requested | Reliability (2026-11-14) | Objectives |
|---|---|---|---|---|---|---|
| **NASA POWER Daily** (MERRA-2 based) | NASA LaRC, `power.larc.nasa.gov`, no key | `T2M_MAX`, `T2M_MIN`, `PRECTOTCORR`, `RH2M`, `GWETROOT`, `ALLSKY_SFC_SW_DWN`, `WS2M` | 0.5° × 0.625° | Last 20 complete years, daily | ✅ ~1 s per request | 1, 2, 3 |
| **NOAA GHCN-Daily** | NOAA NCEI Access/Search APIs, no key | `TMAX`, `TMIN` at the nearest station ≤ ~50 km | station | Last 10 years | ✅ Search + 10-year download ~3 s | 1, 2, 3 (local temperature correction) |
| **MODIS MOD13Q1 v061 NDVI** | NASA LP DAAC via ORNL DAAC subset API, no key | `250m_16_days_NDVI` | 250 m, 16-day | Last 3 years + current | ⚠️ Unreliable: 502/503 errors and 30–60 s responses. The pipeline waits ≤ 40 s, then continues and caches the late result | 2 (observed season, bare months), 3 (recent stress) |
| **USDA SSURGO** | USDA NRCS Soil Data Access (`SDMDataAccess`), no key, **US only** | sand, clay, organic matter, pH, available water, drainage class, hydrologic group | survey map units | Static | ✅ Fast | 1 (pH, water holding), 3 (waterlogging, erosion K) |
| **SoilGrids v2.0** | ISRIC, no key, global | clay, sand, silt, SOC, pH | 250 m | Static | ✅ Works; null over urban/water pixels | Soil outside the US or when SSURGO has no data |
| **SRTM GL1** | NASA/USGS via OpenTopography, **free key** | elevation → slope, topographic wetness index | 30 m | Static (2000) | 🔑 Needs `OPENTOPO_API_KEY` | 3 (erosion LS, low spots) |
| **USDA Cropland Data Layer** | USDA NASS via CropScape `GetCDLValue`, no key, **US only** | crop class at the field centroid | 30 m | Last 8 years | ✅ ~1 s per year (parallel) | 1, 2 (actual rotation history) |
| **IMF commodity prices + US CPI** | IMF PCPS and BLS CPI-U via DBnomics (`api.db.nomics.world`), no key; loaded monthly into D1 | corn, soybean, wheat USD/t; CPI | world benchmark | 1990 → latest DBnomics update (prices through 2025-06, CPI through 2025-01 at the last load) | ✅ ~4 s ingestion. FRED serves the same series but rejects requests from Cloudflare | 4 |
| **USDA FAS PSD** | USDA bulk CSV zips (`apps.fas.usda.gov/psdonline/downloads`), no key; streamed and loaded monthly into D1 | US production, exports, domestic consumption, ending stocks, yield | United States | 1960 → current projection | ✅ 2 zips (129 MB uncompressed) processed in ~3 s | 4 |
| **US Census geocoder** | `geocoding.geo.census.gov`, no key | state, county (FIPS) | point | current | ✅ fast | 4 (market region) |
| **NASA EONET** | NASA, `eonet.gsfc.nasa.gov`, no key | wildfires, floods, severe storms, drought… | event points | Past 365 days, ~50 km | ✅ Fast | 3 (natural-events hazard) |
| **Farmer input** | SMS conversation / GeoJSON | boundary, crops, rotation, stage, issues, water, priorities, soil test, harvest outcomes | field | current | ✅ | all |

### What each dataset does and its limits
- **NASA POWER** is the only required source. It provides daily temperature, rain, humidity, root-zone wetness, solar radiation and wind for:
  - FAO-56 Penman-Monteith ET0, frost dates and growing degree days
  - rainfall onset, extremes, trends and erosivity
  - the crop-season replay
  - *Limit:* it's a ~50 km reanalysis grid. `GWETROOT` is modelled soil wetness, not SMAP observations.
- **NOAA GHCN** removes the grid's local temperature bias with monthly Tmax/Tmin offsets from the nearest station. Frost dates are the main beneficiary.
  - *Limit:* temperature only. A point station is still not the field itself.
- **MODIS NDVI** is averaged over the pixels inside the polygon (the centroid pixel for small fields). It gives the greenness climatology, bare months, the last-12-months anomaly, and the observed green-up and brown-down dates, which are checked against the simulated calendar.
  - *Limit:* 250 m pixels; no cloud QA (the multi-year median absorbs noise).
- **SSURGO / SoilGrids** provide texture, available water (measured in SSURGO), organic matter, pH, EPIC erodibility K, and, from SSURGO, drainage class and hydrologic group. A lab soil test always overrides them.
- **SRTM** gives mean and p90 slope (RUSLE LS) and the share of the field with a topographic wetness index above 11 (low spots).
  - *Limit:* 2000 data, ~30 m vertical noise on flat land.
- **USDA CDL** gives the crop mapped at the field centroid for 8 years. It supplies the rotation when the farmer doesn't, and flags disagreement when they do.
  - *Limit:* US only; one point, so mixed-edge fields can be misread.
- **NASA EONET** lists natural events near the field in the past year.
  - *Limit:* it covers notable events, not every local storm.

## 3. Datasets not included, and what they would need

| Dataset | Would add | Needs |
|---|---|---|
| HLS (Harmonized Landsat-Sentinel-2, 30 m) | Within-field zones; higher-resolution observed season | NASA Earthdata login (LP DAAC cloud COGs) |
| SMAP L4 soil moisture | Observed root-zone moisture | NASA Earthdata login (AppEEARS, asynchronous) |
| GRACE-DA drought indicators | Groundwater/soil-moisture percentiles (US weekly) | Earthdata login / GeoTIFF processing |
| GPM IMERG / CHIRPS | Higher-resolution rainfall in the tropics | Earthdata login (IMERG) or ClimateSERV asynchronous jobs (CHIRPS) |
| ECOSTRESS, OpenET | Field-scale actual ET and canopy heat | Earthdata login (ECOSTRESS); OpenET API key |
| FIRMS active fires | Satellite fire detections | FIRMS MAP_KEY |
| NRT Global Flood product | Observed flooding | GeoTIFF tile processing |
| iSDAsoil | Better soil for Africa | iSDA API account |
| NRCS payment rates | Dollar amounts for conservation programs | No API (state PDF schedules) |

All of these fit the existing structure: a new file in `src/sources/` and an entry in `startFetches` (`src/pipeline.ts`). The output contract stays the same.

## 4. Data-quality handling in the output
- `dataSources[]` reports every dataset with `status: ok | degraded | unavailable` and the reason.
- `confidence.level` is `high` when NOAA, MODIS, soil and SRTM all succeed, the rotation is known (from the farmer or the crop map) and the recommendation is stable; `medium` with one gap; `low` with two or more.
- Each rotation's `informationGaps[]` lists what a farmer or agronomist should verify, including crop-map disagreements, calendar mismatches against MODIS, and unstable recommendations.
- A NASA POWER failure is the only hard error.

## 5. Market datasets not included yet

| Dataset | Would add | Needs |
|---|---|---|
| USDA NASS Quick Stats | State/county **prices received** and yields (local prices instead of the world benchmark) | free NASS API key |
| USDA AMS Market News | Local cash bids and arrivals, specialty crops | free API key |
| USDA ERS cost of production | Net margins (revenue minus costs) | Excel downloads → D1 |
| FAOSTAT / FAO GIEWS FPMA | Producer and domestic prices outside the US | open APIs |
| NOAA CPC / ECMWF seasonal outlooks | Conditions expected at harvest | open (CPC) / Copernicus key |
