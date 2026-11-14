// The single adapter between the teammate's GeoJSON and the pipeline.
// If the upstream format changes, only this file should need to change.
import { resolveCropId } from "./crops";
import { toWgs84 } from "./geo";
import type { Constraints, CurrentSeason, FieldRequest, PolygonCoords, Priorities, RotationEntry, SoilTest } from "./types";

export class InputError extends Error {}

type Json = Record<string, any>;

const DEFAULT_PRIORITY = 3;

export function parseRequest(body: unknown): FieldRequest {
  if (!body || typeof body !== "object") throw new InputError("Body must be a GeoJSON Feature or FeatureCollection.");
  const root = body as Json;
  const feature: Json | undefined =
    root.type === "Feature" ? root : root.type === "FeatureCollection" ? root.features?.find(isPolygonFeature) : undefined;
  if (!feature || !isPolygonFeature(feature)) throw new InputError("Expected a Feature with Polygon or MultiPolygon geometry.");

  const props: Json = feature.properties ?? {};
  const sourceCrs = crsName(root.crs) ?? crsName(feature.crs) ?? crsName(props.crs) ?? "EPSG:4326";
  const raw: PolygonCoords[] =
    feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;

  let polygons: PolygonCoords[];
  try {
    polygons = toWgs84(raw, sourceCrs);
  } catch (e) {
    throw new InputError((e as Error).message);
  }

  const unresolved = new Set<string>();
  const resolve = (name: unknown): string | null => {
    if (typeof name !== "string" || !name.trim()) return null;
    const id = resolveCropId(name);
    if (!id) unresolved.add(name);
    return id;
  };

  const currentRotation: RotationEntry[] = (Array.isArray(props.currentRotation) ? props.currentRotation : [])
    .map((e: unknown): RotationEntry | null => {
      const entry = typeof e === "string" ? { crop: e } : (e as Json);
      const crop = resolve(entry?.crop);
      const cover = resolve(entry?.cover);
      return crop ? (cover ? { crop, cover } : { crop }) : null;
    })
    .filter((e: RotationEntry | null): e is RotationEntry => e !== null);

  const season: Json | undefined = props.currentSeason;
  const currentSeason: CurrentSeason | null = season
    ? {
        crop: resolve(season.crop),
        plantingDate: typeof season.plantingDate === "string" ? season.plantingDate : null,
        growthStage: typeof season.growthStage === "string" ? season.growthStage : null,
        schedule: season.schedule ?? null,
      }
    : null;

  const p: Json = props.priorities ?? {};
  const priorities: Priorities = {
    soilHealth: priority(p.soilHealth),
    water: priority(p.water),
    resilience: priority(p.resilience),
    pest: priority(p.pest),
    erosion: priority(p.erosion),
    income: priority(p.income),
  };

  const k: Json = props.constraints ?? {};
  const constraints: Constraints = {
    irrigation: ["none", "limited", "full"].includes(k.irrigation) ? k.irrigation : "none",
    irrigationCapacityMm: num(k.irrigationCapacityMm) ?? 0,
    excludeCrops: (Array.isArray(k.excludeCrops) ? k.excludeCrops : []).map(resolve).filter(Boolean) as string[],
    slopePct: num(k.slopePct),
  };

  const s: Json | undefined = props.soilTest;
  const soilTest: SoilTest | null = s
    ? { ph: num(s.ph) ?? undefined, organicMatterPct: num(s.organicMatterPct) ?? undefined,
        clayPct: num(s.clayPct) ?? undefined, sandPct: num(s.sandPct) ?? undefined }
    : null;

  const issues = props.observedIssues;
  return {
    fieldId: String(props.fieldId ?? feature.id ?? "field"),
    polygons,
    sourceCrs,
    farmer: (props.farmer ?? props.user ?? {}) as Record<string, unknown>,
    currentRotation,
    currentSeason,
    observedIssues: Array.isArray(issues) ? issues.map(String) : typeof issues === "string" ? [issues] : [],
    priorities,
    constraints,
    soilTest,
    farmerOutcomes: Array.isArray(props.farmerOutcomes) ? props.farmerOutcomes : [],
    unresolvedCrops: [...unresolved],
  };
}

function isPolygonFeature(f: Json): boolean {
  return f?.type === "Feature" && (f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon");
}

/** Accepts legacy GeoJSON `{type:"name",properties:{name}}` or a plain string. */
function crsName(crs: unknown): string | null {
  if (typeof crs === "string") return crs;
  const name = (crs as Json)?.properties?.name;
  return typeof name === "string" ? name : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function priority(v: unknown): number {
  const n = num(v);
  return n === null ? DEFAULT_PRIORITY : Math.max(0, Math.min(5, n));
}
