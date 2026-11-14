// End-to-end run of the stream with upstream APIs stubbed: synthetic Midwest-like weather,
// a loam soil, and a MODIS outage. Checks the contract, not exact agronomic numbers.
import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "../examples/sample-input.json";
import { runPipeline, type PipelineEvent } from "../src/pipeline";
import type { PipelineOutput } from "../src/types";

const TODAY = new Date("2026-11-14T12:00:00Z");

function syntheticPower(): unknown {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const p: Record<string, Record<string, number>> = { T2M_MAX: {}, T2M_MIN: {}, PRECTOTCORR: {}, RH2M: {}, GWETROOT: {}, ALLSKY_SFC_SW_DWN: {}, WS2M: {} };
  for (let t = Date.UTC(2006, 0, 1); t <= Date.UTC(2025, 11, 31); t += 86_400_000) {
    const d = new Date(t);
    const key = d.toISOString().slice(0, 10).replace(/-/g, "");
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
    const tmean = 10 - 14 * Math.cos((2 * Math.PI * (doy - 15)) / 365) + (rand() - 0.5) * 8;
    p.T2M_MAX[key] = tmean + 6;
    p.T2M_MIN[key] = tmean - 6;
    p.PRECTOTCORR[key] = rand() < 0.3 ? rand() * 20 : rand() < 0.02 ? 40 : 0;
    p.RH2M[key] = 70;
    p.GWETROOT[key] = 0.6;
    p.ALLSKY_SFC_SW_DWN[key] = 15 - 9 * Math.cos((2 * Math.PI * (doy - 15)) / 365);
    p.WS2M[key] = 3;
  }
  return { geometry: { coordinates: [-93.75, 42.1, 300] }, properties: { parameter: p } };
}

const soilGrids = {
  properties: {
    layers: [["clay", 250], ["sand", 380], ["silt", 370], ["soc", 200], ["phh2o", 65]].map(([name, v]) => ({
      name, unit_measure: { d_factor: 10 }, depths: [0, 1, 2].map(() => ({ values: { mean: v } })),
    })),
  },
};

function stubFetch() {
  const power = JSON.stringify(syntheticPower());
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("power.larc.nasa.gov")) return new Response(power);
    if (url.includes("isric.org")) return new Response(JSON.stringify(soilGrids));
    return new Response("unavailable", { status: 503 }); // MODIS outage
  });
}

async function collect(): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const ev of runPipeline(sample, { today: TODAY })) events.push(ev);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe("pipeline stream", () => {
  it("emits every section in order and ends with the full result", async () => {
    stubFetch();
    const events = await collect();
    expect(events.map((e) => e.event)).toEqual([
      "field", "soil", "climate", "terrain", "cropSuitability", "fieldHistory", "vegetation", "hazards", "pestCalendar", "rotations", "market", "result",
    ]);
    const result = events.at(-1)!.data as PipelineOutput;
    // streamed sections are identical to the final result
    expect(events.find((e) => e.event === "climate")!.data).toEqual(result.climate);
    expect(events.find((e) => e.event === "hazards")!.data).toEqual(result.hazards);
  });

  it("produces a coherent, degraded-but-usable result", async () => {
    stubFetch();
    const r = (await collect()).at(-1)!.data as PipelineOutput;

    expect(r.climate.period).toEqual({ startYear: 2006, endYear: 2025, years: 20 });
    expect(r.soil.source).toBe("soilgrids+soil_test"); // sample carries a soil test
    expect(r.vegetation).toBeNull();
    expect(r.dataSources.find((s) => s.id === "modis_ndvi")!.status).toBe("unavailable");
    expect(r.confidence.level).toBe("low"); // MODIS, station and SSURGO down + no SRTM key
    expect(r.climate.baseline.stationCorrection).toBeNull();
    expect(r.recommendation.stability.runs).toBe(8);
    expect(r.cropSuitability.find((c) => c.cropId === "corn")!.maturityClass).not.toBe("fixed");
    expect(r.pestCalendar.some((e) => e.crops.includes("corn"))).toBe(true);

    // at least three strategies, the farmer's own first
    expect(r.rotations.length).toBeGreaterThanOrEqual(3);
    expect(r.rotations[0]).toMatchObject({ id: "current", isCurrent: true });
    expect(r.context.rotationSource).toBe("farmer");
    for (const s of r.rotations) {
      for (const v of Object.values(s.scores)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.informationGaps.length).toBeGreaterThan(0);
    }
    expect(r.rotations.map((s) => s.id)).toContain(r.recommendation.rotationId);

    // cover crops raise soil cover over the bare corn-soy baseline
    const current = r.rotations.find((s) => s.id === "current")!;
    const cover = r.rotations.find((s) => s.id === "cover")!;
    expect(cover.metrics.soilCoverFraction).toBeGreaterThan(current.metrics.soilCoverFraction);

    // every hazard references real crops; farmer reports are linked
    const ids = new Set(r.cropSuitability.map((c) => c.cropId));
    for (const h of r.hazards) for (const a of h.affectedCrops) expect(ids.has(a.cropId)).toBe(true);
    expect(r.hazards.some((h) => h.corroboratedByFarmer.length > 0)).toBe(true);

    // excluded crops never enter a rotation
    expect(r.rotations.flatMap((s) => s.sequence.map((e) => e.crop))).not.toContain("potato");
  });

  it("fails loudly when NASA POWER is down", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    await expect(collect()).rejects.toThrow(/NASA POWER unavailable/);
  });
});
