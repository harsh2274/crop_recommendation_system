// NASA SRTM GL1 (30 m) via the OpenTopography global DEM API (free key required).
// From the grid around the field: Horn slope, and a topographic wetness index (TWI = ln(a / tan b),
// D8 flow accumulation) that marks low spots where water collects.
import { contains, metresPerDegree } from "../geo";
import type { PolygonCoords, Terrain } from "../types";
import { fetchText } from "./http";

const BUFFER_DEG = 0.003; // ~300 m around the field so upslope area draining into it is counted
const WET_TWI = 11; // TWI above this is commonly wetness-prone

export async function fetchTerrain(polygons: PolygonCoords[], bbox: [number, number, number, number], apiKey: string): Promise<Terrain> {
  const [w, s, e, n] = bbox;
  const url =
    "https://portal.opentopography.org/API/globaldem?demtype=SRTMGL1&outputFormat=AAIGrid" +
    `&south=${s - BUFFER_DEG}&north=${n + BUFFER_DEG}&west=${w - BUFFER_DEG}&east=${e + BUFFER_DEG}&API_Key=${apiKey}`;
  const g = parseAsciiGrid(await fetchText(url, 30_000));

  const m = metresPerDegree((s + n) / 2);
  const dx = g.cellsize * m.x;
  const dy = g.cellsize * m.y;
  const { nrows: R, ncols: C } = g;
  const z = (r: number, c: number) => g.values[r * C + c];
  const valid = (r: number, c: number) => r >= 0 && c >= 0 && r < R && c < C && z(r, c) !== g.nodata;

  // Horn slope (rise/run) for interior cells
  const slope = new Float64Array(R * C).fill(NaN);
  for (let r = 1; r < R - 1; r++) {
    for (let c = 1; c < C - 1; c++) {
      const win = [z(r - 1, c - 1), z(r - 1, c), z(r - 1, c + 1), z(r, c - 1), z(r, c + 1), z(r + 1, c - 1), z(r + 1, c), z(r + 1, c + 1)];
      if (win.some((v) => v === g.nodata) || z(r, c) === g.nodata) continue;
      const [a, b, cc, d, f, gg, h, i] = win;
      slope[r * C + c] = Math.hypot((cc + 2 * f + i - (a + 2 * d + gg)) / (8 * dx), (gg + 2 * h + i - (a + 2 * b + cc)) / (8 * dy));
    }
  }

  // D8 flow accumulation: process cells from high to low, pass area to the steepest lower neighbour
  const acc = new Float64Array(R * C).fill(1);
  const order = [...Array(R * C).keys()].filter((k) => g.values[k] !== g.nodata).sort((p, q) => g.values[q] - g.values[p]);
  for (const k of order) {
    const r = Math.floor(k / C), c = k % C;
    let best = -1, drop = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((dr || dc) && valid(r + dr, c + dc)) {
          const dist = Math.hypot(dr * dy, dc * dx);
          const d = (z(r, c) - z(r + dr, c + dc)) / dist;
          if (d > drop) [drop, best] = [d, (r + dr) * C + c + dc];
        }
      }
    }
    if (best >= 0) acc[best] += acc[k];
  }

  const elevations: number[] = [];
  const slopes: number[] = [];
  let wet = 0;
  for (let r = 1; r < R - 1; r++) {
    for (let c = 1; c < C - 1; c++) {
      const k = r * C + c;
      const lon = g.xll + (c + 0.5) * g.cellsize;
      const lat = g.yll + (R - r - 0.5) * g.cellsize;
      if (Number.isNaN(slope[k]) || !contains(polygons, [lon, lat])) continue;
      const twi = Math.log((acc[k] * dx * dy) / Math.sqrt(dx * dy) / Math.max(slope[k], 0.001));
      if (twi > WET_TWI) wet++;
      slopes.push(100 * slope[k]);
      elevations.push(z(r, c));
    }
  }
  if (slopes.length === 0) throw new Error("No SRTM cells inside the field");
  slopes.sort((x, y) => x - y);
  return {
    elevationM: elevations.reduce((x, y) => x + y, 0) / elevations.length,
    slopeMeanPct: slopes.reduce((x, y) => x + y, 0) / slopes.length,
    slopeP90Pct: slopes[Math.floor(0.9 * (slopes.length - 1))],
    lowSpotSharePct: (100 * wet) / slopes.length,
    cellsUsed: slopes.length,
  };
}

function parseAsciiGrid(text: string) {
  const lines = text.trim().split(/\r?\n/);
  const header: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length && /^[a-zA-Z]/.test(lines[i]); i++) {
    const [key, value] = lines[i].trim().split(/\s+/);
    header[key.toLowerCase()] = Number(value);
  }
  if (!header.ncols) throw new Error(`OpenTopography did not return a grid: ${text.slice(0, 120)}`);
  return {
    ncols: header.ncols,
    nrows: header.nrows,
    xll: header.xllcorner ?? header.xllcenter - header.cellsize / 2,
    yll: header.yllcorner ?? header.yllcenter - header.cellsize / 2,
    cellsize: header.cellsize,
    nodata: header.nodata_value ?? -9999,
    values: lines.slice(i).join(" ").trim().split(/\s+/).map(Number),
  };
}
