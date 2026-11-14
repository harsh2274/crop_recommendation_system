// Coordinate handling: reproject to WGS84, then small-field geometry on lon/lat.
import proj4 from "proj4";
import type { PolygonCoords, Position, Ring } from "./types";

const EARTH_RADIUS_M = 6371008.8;

/** proj4 definition for an EPSG code, CRS URN, proj4 string or WKT. */
function projDefinition(crs: string): string {
  const s = crs.trim();
  if (s.startsWith("+proj") || s.includes("[")) return s; // proj4 string or WKT
  // "EPSG:32615", "urn:ogc:def:crs:EPSG::32615" and "32615" all end in the code
  const code = Number(s.match(/(\d{4,5})\s*$/)?.[1]);
  if (/CRS84/i.test(s) || code === 4326) return "EPSG:4326";
  if (code === 3857 || code === 900913) return "EPSG:3857";
  if (code === 4269) return "EPSG:4269";
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 26901 && code <= 26923) return `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`;
  throw new Error(`Unsupported CRS "${crs}". Send EPSG:4326/3857/4269, a UTM EPSG code, a proj4 string or WKT.`);
}

/** Reproject polygons to WGS84 [lon, lat]. Throws if the result is not on Earth. */
export function toWgs84(polygons: PolygonCoords[], crs: string): PolygonCoords[] {
  const def = projDefinition(crs);
  const project = def === "EPSG:4326" ? (p: Position) => p : (p: Position) => proj4(def, "EPSG:4326", p) as Position;
  const out = polygons.map((poly) => poly.map((ring) => ring.map((p) => project([p[0], p[1]]))));
  for (const [lon, lat] of out.flat(2)) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new Error(`Coordinates do not fit CRS "${crs}" (got lon=${lon}, lat=${lat}).`);
    }
  }
  return out;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Geodesic area of a ring on a sphere (m^2), sign ignored. */
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    sum += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function areaHa(polygons: PolygonCoords[]): number {
  const m2 = polygons.reduce((acc, [outer, ...holes]) => acc + ringArea(outer) - holes.reduce((h, r) => h + ringArea(r), 0), 0);
  return m2 / 10_000;
}

export function bbox(polygons: PolygonCoords[]): [number, number, number, number] {
  const pts = polygons.flat(2);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Area-weighted centroid of the outer rings (planar on lon/lat; fine at field scale). */
export function centroid(polygons: PolygonCoords[]): { lat: number; lon: number } {
  let a = 0, cx = 0, cy = 0;
  for (const [outer] of polygons) {
    for (let i = 0; i < outer.length - 1; i++) {
      const [x1, y1] = outer[i];
      const [x2, y2] = outer[i + 1];
      const cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
  }
  if (Math.abs(a) < 1e-15) {
    const [w, s, e, n] = bbox(polygons);
    return { lon: (w + e) / 2, lat: (s + n) / 2 };
  }
  return { lon: cx / (3 * a), lat: cy / (3 * a) };
}

function inRing([x, y]: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function contains(polygons: PolygonCoords[], p: Position): boolean {
  return polygons.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

/** Metres per degree of longitude/latitude at a latitude. */
export function metresPerDegree(lat: number): { x: number; y: number } {
  return { x: 111_320 * Math.cos(rad(lat)), y: 110_540 };
}
