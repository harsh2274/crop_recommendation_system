import { describe, expect, it } from "vitest";
import sample from "../examples/sample-input.json";
import { areaHa, centroid } from "../src/geo";
import { InputError, parseRequest } from "../src/input";

describe("input + geometry", () => {
  it("reprojects the UTM sample field and measures it", () => {
    const req = parseRequest(sample);
    const c = centroid(req.polygons);
    expect(c.lat).toBeCloseTo(42.1, 2);
    expect(c.lon).toBeCloseTo(-93.75, 2);
    expect(areaHa(req.polygons)).toBeGreaterThan(60); // 800 m x 800 m = 64 ha
    expect(areaHa(req.polygons)).toBeLessThan(68);
    expect(req.sourceCrs).toBe("EPSG:32615");
  });

  it("resolves crop names and fills defaults", () => {
    const req = parseRequest({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[-93.76, 42.09], [-93.75, 42.09], [-93.75, 42.1], [-93.76, 42.09]]] },
        properties: { currentRotation: ["Maize", { crop: "Soybeans", cover: "rye" }, "dragonfruit"] },
      }],
    });
    expect(req.currentRotation).toEqual([{ crop: "corn" }, { crop: "soybean", cover: "cereal_rye" }]);
    expect(req.unresolvedCrops).toEqual(["dragonfruit"]);
    expect(req.priorities.soilHealth).toBe(3);
    expect(req.constraints.irrigation).toBe("none");
    expect(req.sourceCrs).toBe("EPSG:4326");
  });

  it("rejects coordinates that do not match the declared CRS", () => {
    const bad = { ...sample, crs: "EPSG:4326" };
    expect(() => parseRequest(bad)).toThrow(InputError);
  });
});
