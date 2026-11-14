import { describe, expect, it } from "vitest";
import sample from "../examples/sample-output.json";
import { buildMarket, type MarketData } from "../src/market/engine";
import { parseDbnomics } from "../src/sources/prices";
import { parsePsdLine } from "../src/sources/psd";
import { marketMessages } from "../src/sms/facts";
import { parseDirect } from "../src/sms/flow";
import type { PipelineOutput } from "../src/types";

const result = sample as unknown as PipelineOutput;

/** Synthetic market: constant CPI (real = nominal), corn peaks in June, soybean flat; yearly 2% drift. */
function syntheticData(): MarketData {
  const prices = new Map<string, Map<string, number>>([["corn", new Map()], ["soybean", new Map()]]);
  const cpi = new Map<string, number>();
  for (let y = 2010; y <= 2025; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const drift = 1 + 0.02 * (y - 2010);
      prices.get("corn")!.set(key, (200 + (m === 6 ? 30 : 0)) * drift);
      prices.get("soybean")!.set(key, 450 * drift);
      cpi.set(key, 100);
    }
  }
  const supply = new Map<string, Map<number, Record<string, number>>>([["corn", new Map()]]);
  for (let y = 2000; y <= 2025; y++) {
    supply.get("corn")!.set(y, { production: 350000, exports: 50000 + 1000 * (y - 2000), consumption: 300000, endingStocks: y === 2025 ? 20000 : 40000, yieldTHa: 11 });
  }
  return { prices, cpi, supply, updated: "2026-11-15T00:00:00Z" } as MarketData;
}

const input = {
  cropSuitability: result.cropSuitability.map((c) => (c.cropId === "corn" || c.cropId === "soybean" ? { ...c, harvestDate: "10-05" } : c)),
  rotations: result.rotations,
  priorities: { ...result.context.priorities, income: 5 },
  region: { country: "United States", countryIso3: "USA", admin1: "Iowa", admin1Code: "IA", county: "Boone County", countyFips: "19015" },
};

describe("market sources", () => {
  it("parses DBnomics series and skips missing values", () => {
    expect(parseDbnomics({ series: { docs: [{ period: ["2025-05", "2025-06"], value: [236.9, "NA"] }] } })).toEqual([["2025-05", 236.9]]);
  });
  it("parses only US PSD rows for our crops and attributes", () => {
    const codes = new Map([["0440000", "corn"]]);
    expect(parsePsdLine('0440000,"Corn",US,"United States",2024,2026,10,176,"Ending Stocks",08,"(1000 MT)",1234.5000\r', codes))
      .toEqual({ cropId: "corn", marketYear: 2024, attribute: "endingStocks", value: 1234.5 });
    expect(parsePsdLine('0440000,"Corn",BR,"Brazil",2024,2026,10,176,"Ending Stocks",08,"(1000 MT)",1.0', codes)).toBeNull();
    expect(parsePsdLine('0440000,"Corn",US,"United States",2024,2026,10,004,"Area Harvested",04,"(1000 HA)",1.0', codes)).toBeNull();
  });
});

describe("market engine", () => {
  const m = buildMarket(syntheticData(), input)!;
  const corn = m.crops.find((c) => c.cropId === "corn")!;

  it("forecasts the harvest-month range from the last 10 years", () => {
    // October prices 2016-2025 = 200 * (1.12 .. 1.30); median of those 10 values = 200 * 1.21
    expect(corn.price.usdPerTonne.p50).toBeCloseTo(242, 0);
    expect(corn.price.usdPerBushel!.p50).toBeCloseTo(242 / 39.368, 1);
    expect(corn.backtest.years).toBe(5);
  });
  it("finds the month prices are usually highest", () => {
    expect(corn.bestSellMonth).toMatchObject({ month: 6 });
    expect(corn.bestSellMonth!.premiumPct).toBeCloseTo(15, 0);
  });
  it("flags tight stocks and rising exports", () => {
    expect(corn.demand).toMatchObject({ marketYear: 2025, stocksVsUsual: "lower", exportsTrend: "rising" });
  });
  it("ranks with the income weight and never averages rotations with missing crops", () => {
    expect(m.incomeWeight).toBe(0.5);
    for (const r of m.ranking) expect(r.final).toBe(Math.round(0.5 * r.agronomic + 0.5 * r.market));
    const withUnpriced = result.rotations.find((r) => r.sequence.some((e) => !["corn", "soybean"].includes(e.crop)));
    if (withUnpriced) {
      const row = m.rotationRanking.find((r) => r.rotationId === withUnpriced.id)!;
      expect(row.market).toBeNull();
      expect(row.final).toBeNull(); // not ranked against fully priced rotations
      expect(m.rotationRanking.at(-1)!.final).toBeNull(); // listed after the ranked ones
    }
  });
});

describe("market texts", () => {
  const withMarket = { ...result, market: buildMarket(syntheticData(), input) } as PipelineOutput;

  it("are written from market numbers, with no links", () => {
    const msgs = marketMessages(withMarket)!;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    const corn = withMarket.market!.crops.find((c) => c.cropId === "corn")!;
    expect(msgs[0]).toContain(`$${corn.price.usdPerBushel!.p50.toFixed(2)}`);
    expect(msgs[1]).toContain("June");
    expect(msgs.join(" ")).not.toMatch(/https?:\/\//);
  });
  it("say nothing when there is no market data", () => {
    expect(marketMessages({ ...result, market: null })).toBeNull();
  });
  it("one-word market questions are routed without the model", () => {
    for (const w of ["sell", "prices?", "Mercado", "vender", "prix"]) expect(parseDirect("done", w)).toMatchObject({ intent: "market" });
  });
});
