-- Market data, loaded by the scheduled ingestion (src/market/ingest.ts) and read by the market engine.
CREATE TABLE IF NOT EXISTS price_monthly (
  crop_id TEXT NOT NULL,      -- catalog crop id (corn, soybean, winter_wheat)
  month TEXT NOT NULL,        -- YYYY-MM
  usd_per_t REAL NOT NULL,    -- nominal USD per metric ton (IMF, via DBnomics)
  PRIMARY KEY (crop_id, month)
);

CREATE TABLE IF NOT EXISTS cpi_monthly (
  month TEXT PRIMARY KEY,     -- YYYY-MM
  cpi REAL NOT NULL           -- US CPI-U, all items, US city average (BLS, via DBnomics)
);

CREATE TABLE IF NOT EXISTS supply_annual (
  crop_id TEXT NOT NULL,
  country TEXT NOT NULL,      -- ISO2 as used by PSD ("US")
  market_year INTEGER NOT NULL,
  attribute TEXT NOT NULL,    -- production | exports | consumption | endingStocks (1000 t) | yieldTHa (t/ha)
  value REAL NOT NULL,
  PRIMARY KEY (crop_id, country, market_year, attribute)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  source TEXT PRIMARY KEY,    -- prices | psd
  updated_at TEXT NOT NULL,
  rows INTEGER NOT NULL
);
