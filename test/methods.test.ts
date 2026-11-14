import { describe, expect, it } from "vitest";
import { et0PenmanMonteith } from "../src/climate";
import { inferRotation } from "../src/sources/cdl";

describe("FAO-56 Penman-Monteith", () => {
  it("reproduces the FAO-56 daily worked example (Uccle, 6 July: 3.9 mm/day)", () => {
    // Tmax 21.5, Tmin 12.3, RH mean ~73.5 %, u2 2.078 m/s, Rs 22.07 MJ/m2, Ra 41.09 MJ/m2, z = 100 m
    expect(et0PenmanMonteith(21.5, 12.3, 73.5, 2.078, 22.07, 41.09, 100)).toBeCloseTo(3.9, 0);
  });
});

describe("rotation from the USDA crop map", () => {
  const h = (crops: (string | null)[]) => crops.map((cropId, i) => ({ year: 2018 + i, code: 0, category: "", cropId }));
  it("finds the repeating cycle", () => {
    expect(inferRotation(h(["soybean", "corn", "soybean", "corn", "soybean", "corn"]))).toEqual(["soybean", "corn"]);
    expect(inferRotation(h(["corn", "corn", "corn", "corn"]))).toEqual(["corn"]);
    expect(inferRotation(h(["corn", null, "soybean", "winter_wheat"]))).toEqual(["corn", "soybean", "winter_wheat"]);
  });
});
