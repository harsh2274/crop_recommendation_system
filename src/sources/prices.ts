// Monthly world commodity prices and US CPI from DBnomics (open API, no key), which mirrors
//   IMF Primary Commodity Price System (PCPS): USD per metric ton, monthly
//   US BLS CPI-U, all items, US city average (for "today's dollars")
// (FRED serves the same IMF series but rejects requests coming from Cloudflare's network.)
import { fetchJson } from "./http";

/** Catalog crop id -> DBnomics series of its IMF world benchmark price. */
export const PRICE_SERIES: Record<string, string> = {
  corn: "IMF/PCPS/M.W00.PMAIZMT.USD", // Maize, US No.2 Yellow, FOB Gulf of Mexico
  soybean: "IMF/PCPS/M.W00.PSOYB.USD", // Soybeans, US No.1 Yellow, CIF Rotterdam
  winter_wheat: "IMF/PCPS/M.W00.PWHEAMT.USD", // Wheat, No.1 Hard Red Winter, FOB Gulf of Mexico
};
export const CPI_SERIES = "BLS/cu/CUUR0000SA0";

interface DbnomicsResponse { series?: { docs?: { period?: string[]; value?: (number | string | null)[] }[] } }

/** Monthly observations as [YYYY-MM, value]; missing values ("NA", null) are skipped. */
export function parseDbnomics(data: DbnomicsResponse): [string, number][] {
  const doc = data.series?.docs?.[0];
  if (!doc?.period || !doc.value) return [];
  return doc.period.flatMap((period, i) => {
    const v = doc.value![i];
    return /^\d{4}-\d{2}$/.test(period) && typeof v === "number" && Number.isFinite(v) ? [[period, v] as [string, number]] : [];
  });
}

export async function fetchMonthly(series: string): Promise<[string, number][]> {
  const rows = parseDbnomics(await fetchJson<DbnomicsResponse>(`https://api.db.nomics.world/v22/series/${series}?observations=1&format=json`, 40_000));
  if (rows.length < 24) throw new Error(`DBnomics ${series}: only ${rows.length} rows`);
  return rows;
}
