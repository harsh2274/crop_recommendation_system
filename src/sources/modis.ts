// MODIS MOD13Q1 NDVI (250 m, 16-day) from the ORNL DAAC subset REST service (no key).
// We request a small window around the field and average only pixels whose centres fall
// inside the polygon (falls back to the nearest pixel for fields smaller than a pixel).
import { contains, metresPerDegree } from "../geo";
import type { NdviSeries, PolygonCoords } from "../types";
import { fetchJson } from "./http";

const BASE = "https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset";
const SIN_RADIUS = 6371007.181; // MODIS sinusoidal sphere
const COMPOSITES_PER_REQUEST = 10; // service limit
const FILL = -3000;
const TIMEOUT_MS = 45_000; // the service can be slow; a retry would only double the wait

interface SubsetResponse {
  xllcorner: string;
  yllcorner: string;
  cellsize: number;
  nrows: number;
  ncols: number;
  subset: { calendar_date: string; data: number[] }[];
}

export async function fetchNdvi(
  polygons: PolygonCoords[],
  center: { lat: number; lon: number },
  bbox: [number, number, number, number],
  startYear: number,
  today: Date,
): Promise<NdviSeries> {
  const m = metresPerDegree(center.lat);
  const kmUpDown = clampKm(((bbox[3] - bbox[1]) * m.y) / 2000);
  const kmLeftRight = clampKm(((bbox[2] - bbox[0]) * m.x) / 2000);

  const chunks = compositeChunks(startYear, today);
  const responses = await Promise.allSettled(
    chunks.map(([start, end]) =>
      fetchJson<SubsetResponse>(
        `${BASE}?latitude=${center.lat.toFixed(5)}&longitude=${center.lon.toFixed(5)}&band=250m_16_days_NDVI` +
          `&startDate=${start}&endDate=${end}&kmAboveBelow=${kmUpDown}&kmLeftRight=${kmLeftRight}`,
        TIMEOUT_MS,
        0,
      ),
    ),
  );
  const ok = responses.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0) throw new Error("MODIS subset service returned no data");

  const pixels = fieldPixels(ok[0], polygons, center);
  const rows = ok.flatMap((r) => r.subset).sort((a, b) => a.calendar_date.localeCompare(b.calendar_date));
  const dates: string[] = [];
  const ndvi: number[] = [];
  for (const row of rows) {
    const values = pixels.map((i) => row.data[i]).filter((v) => v !== FILL && v >= -2000 && v <= 10000);
    if (values.length === 0) continue;
    dates.push(row.calendar_date);
    ndvi.push(values.reduce((a, b) => a + b, 0) / values.length / 10000);
  }
  return { dates, ndvi, pixelsUsed: pixels.length, requestsFailed: chunks.length - ok.length, requestsTotal: chunks.length };
}

/** Half-window in whole km. Fields under ~1.5 km across use the single pixel at the centroid. */
function clampKm(km: number): number {
  return Math.min(4, Math.max(0, Math.round(km)));
}

/** Indices of grid cells whose centre lies inside the field; nearest cell if none. */
function fieldPixels(grid: SubsetResponse, polygons: PolygonCoords[], center: { lat: number; lon: number }): number[] {
  const xll = Number(grid.xllcorner);
  const yll = Number(grid.yllcorner);
  const inside: number[] = [];
  let nearest = 0;
  let best = Infinity;
  for (let r = 0; r < grid.nrows; r++) {
    for (let col = 0; col < grid.ncols; col++) {
      const x = xll + (col + 0.5) * grid.cellsize;
      const y = yll + (grid.nrows - r - 0.5) * grid.cellsize; // data is row-major from the top
      const lat = y / SIN_RADIUS;
      const lon = x / (SIN_RADIUS * Math.cos(lat));
      const latDeg = (lat * 180) / Math.PI;
      const lonDeg = (lon * 180) / Math.PI;
      const idx = r * grid.ncols + col;
      if (contains(polygons, [lonDeg, latDeg])) inside.push(idx);
      const d = (latDeg - center.lat) ** 2 + (lonDeg - center.lon) ** 2;
      if (d < best) [best, nearest] = [d, idx];
    }
  }
  return inside.length > 0 ? inside : [nearest];
}

/** MOD13Q1 composites start on DOY 1, 17, 33, ... Group them into service-sized requests. */
function compositeChunks(startYear: number, today: Date): [string, string][] {
  const lastAvailable = new Date(today.getTime() - 20 * 86_400_000); // processing lag
  const composites: string[] = [];
  for (let year = startYear; year <= lastAvailable.getUTCFullYear(); year++) {
    for (let doy = 1; doy <= 353; doy += 16) {
      if (new Date(Date.UTC(year, 0, doy)) > lastAvailable) break;
      composites.push(`A${year}${String(doy).padStart(3, "0")}`);
    }
  }
  const chunks: [string, string][] = [];
  for (let i = 0; i < composites.length; i += COMPOSITES_PER_REQUEST) {
    const part = composites.slice(i, i + COMPOSITES_PER_REQUEST);
    chunks.push([part[0], part[part.length - 1]]);
  }
  return chunks;
}
