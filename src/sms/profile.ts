// The farmer profile built up over the SMS conversation, and its translation into pipeline input.
import { areaHa } from "../geo";
import { repeatingCycle } from "../rotation";

export const PRIORITIES = ["income", "water", "soil", "pests", "weather", "erosion"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface FarmerProfile {
  phone: string;
  language: string | null; // e.g. "Spanish": language of the latest written message
  name: string | null;
  crops: string[]; // grown on this field this season
  pastCrops: string[]; // crops of past years on this field, oldest first (the rotation is derived: rotationOf)
  cropAreaHa: number | null; // as the farmer stated it
  growthStage: string | null;
  plantingDate: string | null; // ISO date if known
  issues: string[];
  irrigation: "none" | "limited" | "full" | null;
  priorities: Priority[];
  boundary: { ring: [number, number][]; areaHa: number; savedAt: string } | null; // WGS84 [lon, lat]
  location: { lat: number; lon: number; accuracyM: number | null; source: "gps" | "ip" } | null;
  analysisStatus: "none" | "running" | "done" | "failed" | "stale"; // stale = information changed after the last report
  asked: string[]; // optional questions answered or skipped (flow.ts steps)
  outcomes: { date: string; crop: string | null; text: string }[]; // what happened after a season, in the farmer's own words
  createdAt: string;
}

export function newProfile(phone: string): FarmerProfile {
  return {
    phone, language: null, name: null, crops: [], pastCrops: [], cropAreaHa: null, growthStage: null,
    plantingDate: null, issues: [], irrigation: null, priorities: [], boundary: null, location: null,
    analysisStatus: "none", asked: [], outcomes: [], createdAt: new Date().toISOString(),
  };
}

const MIN_HA = 0.01;
const MAX_HA = 10_000;

/** Validate a drawn ring; returns its area or an error code the map page understands. */
export function checkBoundary(ring: [number, number][]): { areaHa: number } | { error: "points" | "small" | "big" } {
  if (ring.length < 3 || ring.length > 200 || ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)) {
    return { error: "points" };
  }
  const ha = areaHa([[[...ring, ring[0]]]]);
  if (ha < MIN_HA) return { error: "small" };
  if (ha > MAX_HA) return { error: "big" };
  return { areaHa: ha };
}

const MAX_ROTATION_YEARS = 4;

/**
 * Rotation from what the farmer said: several crops grown now means they rotate between those crops;
 * otherwise past years (oldest first) + this season, reduced to the shortest repeating cycle.
 */
export function normalizeRotation(past: string[], current: string[]): string[] {
  if (current.length >= 2) return [...new Set(current)].slice(0, MAX_ROTATION_YEARS);
  return repeatingCycle([...past, ...current.slice(0, 1)]).slice(-MAX_ROTATION_YEARS);
}

/** The rotation used for analysis and shown in the summary: always derived from past + current crops. */
export const rotationOf = (p: FarmerProfile): string[] => normalizeRotation(p.pastCrops, p.crops);

/** Profile -> the GeoJSON Feature the analysis pipeline accepts (see OUTPUTS.md §2). */
export function toPipelineInput(p: FarmerProfile, farmerId: string): unknown {
  if (!p.boundary) throw new Error("No boundary");
  const priorities = p.priorities.length
    ? {
        income: p.priorities.includes("income") ? 5 : 2,
        water: p.priorities.includes("water") ? 5 : 2,
        soilHealth: p.priorities.includes("soil") ? 5 : 2,
        pest: p.priorities.includes("pests") ? 5 : 2,
        resilience: p.priorities.includes("weather") ? 5 : 2,
        erosion: p.priorities.includes("erosion") ? 5 : 2,
      }
    : undefined; // pipeline defaults every priority to 3
  return {
    type: "Feature",
    crs: "EPSG:4326",
    geometry: { type: "Polygon", coordinates: [[...p.boundary.ring, p.boundary.ring[0]]] },
    properties: {
      fieldId: `sms-${farmerId.slice(0, 12)}`,
      farmer: { id: farmerId, name: p.name, language: p.language, statedAreaHa: p.cropAreaHa, channel: "sms" },
      currentRotation: rotationOf(p),
      currentSeason: { crop: p.crops[0] ?? null, plantingDate: p.plantingDate, growthStage: p.growthStage },
      observedIssues: p.issues,
      farmerOutcomes: p.outcomes,
      priorities,
      constraints: { irrigation: p.irrigation ?? "none" },
    },
  };
}
