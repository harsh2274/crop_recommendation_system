// NASA EONET natural events (no key): wildfires, floods, severe storms, drought... within ~50 km in the past year.
import type { NaturalEvent } from "../types";
import { fetchJson } from "./http";

const RADIUS_DEG = 0.5;

interface EonetResponse {
  events: { title: string; categories: { id: string }[]; geometry: { date: string; type: string; coordinates: unknown }[] }[];
}

export async function fetchNaturalEvents(lat: number, lon: number): Promise<NaturalEvent[]> {
  const r = RADIUS_DEG;
  const data = await fetchJson<EonetResponse>(
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=365" +
      `&bbox=${(lon - r).toFixed(3)},${(lat + r).toFixed(3)},${(lon + r).toFixed(3)},${(lat - r).toFixed(3)}`,
  );
  return data.events.flatMap((e) => {
    const g = e.geometry.at(-1);
    if (!g) return [];
    const point = g.type === "Point" ? (g.coordinates as number[]) : (g.coordinates as number[][][])[0]?.[0];
    if (!point) return [];
    const km = 111 * Math.hypot(point[1] - lat, (point[0] - lon) * Math.cos((lat * Math.PI) / 180));
    return [{ title: e.title, category: e.categories[0]?.id ?? "unknown", date: g.date.slice(0, 10), distanceKm: Math.round(km) }];
  });
}
