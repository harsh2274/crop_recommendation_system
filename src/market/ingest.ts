// Scheduled ingestion (Cron Trigger, monthly; also POST /admin/ingest): download market data and
// upsert it into D1. Farmer requests only ever read D1, so a slow source never delays a report.
import { CPI_SERIES, fetchMonthly, PRICE_SERIES } from "../sources/prices";
import { fetchPsdUs, PSD_COMMODITIES } from "../sources/psd";

const BATCH = 200; // statements per D1 batch

async function writeBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH));
}

async function logged(db: D1Database, source: string, rows: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO ingest_log (source, updated_at, rows) VALUES (?, ?, ?)").bind(source, new Date().toISOString(), rows).run();
}

export async function ingestPrices(db: D1Database): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const [cropId, series] of Object.entries(PRICE_SERIES)) {
    for (const [month, value] of await fetchMonthly(series)) {
      statements.push(db.prepare("INSERT OR REPLACE INTO price_monthly (crop_id, month, usd_per_t) VALUES (?, ?, ?)").bind(cropId, month, value));
    }
  }
  for (const [month, value] of await fetchMonthly(CPI_SERIES)) {
    statements.push(db.prepare("INSERT OR REPLACE INTO cpi_monthly (month, cpi) VALUES (?, ?)").bind(month, value));
  }
  await writeBatched(db, statements);
  await logged(db, "prices", statements.length);
  return statements.length;
}

export async function ingestSupply(db: D1Database): Promise<number> {
  const files = [...new Set(Object.values(PSD_COMMODITIES).map((c) => c.file))];
  const rows = (await Promise.all(files.map(fetchPsdUs))).flat();
  await writeBatched(db, rows.map((r) =>
    db.prepare("INSERT OR REPLACE INTO supply_annual (crop_id, country, market_year, attribute, value) VALUES (?, 'US', ?, ?, ?)").bind(r.cropId, r.marketYear, r.attribute, r.value)));
  await logged(db, "psd", rows.length);
  return rows.length;
}

/** Run both ingestions; one failing source does not stop the other. */
export async function ingestAll(db: D1Database): Promise<Record<string, number | string>> {
  const [prices, supply] = await Promise.allSettled([ingestPrices(db), ingestSupply(db)]);
  const show = (r: PromiseSettledResult<number>) => (r.status === "fulfilled" ? r.value : `failed: ${String(r.reason)}`);
  return { prices: show(prices), psd: show(supply) };
}
