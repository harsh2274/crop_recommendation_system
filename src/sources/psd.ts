// USDA FAS PSD (Production, Supply and Distribution) bulk CSV downloads, no key. Each file is a
// single-entry zip; we stream-decompress it and keep only US rows for our crops and attributes.

import { USER_AGENT } from "./http";

/** Catalog crop id -> PSD commodity code and the zip that holds it. */
export const PSD_COMMODITIES: Record<string, { code: string; file: string }> = {
  corn: { code: "0440000", file: "psd_grains_pulses_csv.zip" },
  winter_wheat: { code: "0410000", file: "psd_grains_pulses_csv.zip" }, // all US wheat
  soybean: { code: "2222000", file: "psd_oilseeds_csv.zip" },
  rice: { code: "0422110", file: "psd_grains_pulses_csv.zip" }, // "Rice, Milled": tonnes are milled, yield is rough (paddy)
};
const ATTRIBUTES: Record<string, string> = { "028": "production", "054": "roughProduction", "088": "exports", "125": "consumption", "176": "endingStocks", "184": "yieldTHa" };

export interface PsdRow { cropId: string; marketYear: number; attribute: string; value: number }

// 0440000,"Corn",US,"United States",2024,2026,10,176,"Ending Stocks",08,"(1000 MT)",1234.0000
const LINE = /^(\d{7}),"[^"]*",US,"United States",(\d{4}),\d{4},\d{2},(\d{3}),"[^"]*",\d+,"[^"]*",(-?[\d.]+)/;

export function parsePsdLine(line: string, byCode: Map<string, string>): PsdRow | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const cropId = byCode.get(m[1]);
  const attribute = ATTRIBUTES[m[3]];
  return cropId && attribute ? { cropId, marketYear: Number(m[2]), attribute, value: Number(m[4]) } : null;
}

/** Download one PSD zip and return the US rows for our crops. */
export async function fetchPsdUs(file: string): Promise<PsdRow[]> {
  const res = await fetch(`https://apps.fas.usda.gov/psdonline/downloads/${file}`, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`PSD ${file}: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const byCode = new Map(Object.entries(PSD_COMMODITIES).filter(([, v]) => v.file === file).map(([cropId, v]) => [v.code, cropId]));

  const text = new Blob([zipEntry(zip)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).pipeThrough(new TextDecoderStream());
  const rows: PsdRow[] = [];
  let carry = "";
  for await (const chunk of text as unknown as AsyncIterable<string>) {
    const lines = (carry + chunk).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.indexOf(",US,") < 0) continue; // cheap pre-filter: ~1% of lines are US
      const row = parsePsdLine(line, byCode);
      if (row) rows.push(row);
    }
  }
  if (rows.length === 0) throw new Error(`PSD ${file}: no US rows found`);
  return rows;
}

/** The compressed bytes of the first entry of a zip (method 8 = deflate), located via the central directory. */
function zipEntry(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const cd = view.getUint32(eocd + 16, true);
  if (view.getUint32(cd, true) !== 0x02014b50) throw new Error("bad zip central directory");
  if (view.getUint16(cd + 10, true) !== 8) throw new Error("zip entry is not deflate-compressed");
  const size = view.getUint32(cd + 20, true);
  const local = view.getUint32(cd + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  return zip.subarray(start, start + size);
}
