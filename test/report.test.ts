import { describe, expect, it } from "vitest";
import sample from "../examples/sample-output.json";
import { buildReport, mapStrings, type Block } from "../src/report/content";
import { mapView, renderPdf, toWinAnsi } from "../src/report/pdf";
import { reportMessages } from "../src/sms/facts";
import { parseDirect } from "../src/sms/flow";
import type { PipelineOutput } from "../src/types";

const result = sample as unknown as PipelineOutput;
const [w, s, e, n] = result.field.bbox;
const ring: [number, number][] = [[w, s], [e, s], [e, n], [w, n]];

describe("PDF report content", () => {
  const doc = buildReport(result, ring);
  const kinds = doc.blocks.map((b) => b.kind);
  const text = JSON.stringify(doc.blocks);

  it("has the map, basic information, charts, every analysis section and the report texts", () => {
    expect(kinds[0]).toBe("title");
    expect(kinds).toContain("map");
    for (const k of ["facts", "bars", "monthly", "calendar", "table"] as Block["kind"][]) expect(kinds).toContain(k);
    const headings = doc.blocks.filter((b) => b.kind === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(expect.arrayContaining(["Your farm", "Which crops fit this field", "Crop plans compared", "Weather and water", "Dangers to watch", "Your text-message report", "Where the data comes from"]));
    if (result.market) expect(headings).toContain("Market: what crops are worth after harvest");
    for (const t of reportMessages(result)) expect(text).toContain(JSON.stringify(t).slice(1, -1)); // same texts as the SMS
  });

  it("takes its numbers from the result", () => {
    expect(text).toContain(`${result.climate.annual.precipMm} mm of rain a year`);
    const plans = doc.blocks.find((b) => b.kind === "bars" && b.title.startsWith("Overall score")) as Extract<Block, { kind: "bars" }>;
    expect(plans.items.map((i) => i.value)).toEqual(result.rotations.map((r) => r.scores.overall));
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("translation touches only strings with letters", () => {
    const seen: string[] = [];
    mapStrings(doc, (x) => (seen.push(x), x));
    expect(seen.every((x) => /\p{L}/u.test(x))).toBe(true);
    expect(mapStrings(doc, (x) => x)).toEqual(doc);
  });
});

describe("PDF rendering", () => {
  it("keeps Latin-script translations and rejects scripts the PDF font cannot draw", () => {
    expect(toWinAnsi("Maíz – 3 años “bueno”")).toBe('Maíz - 3 años "bueno"');
    expect(toWinAnsi("玉米")).toBeNull();
    expect(toWinAnsi("кукуруза")).toBeNull();
  });

  it("projects the farm into the middle of the satellite image", () => {
    const v = mapView(ring);
    expect(v.url).toContain("World_Imagery/MapServer/export?bbox=");
    const pts = ring.map(v.toUnit);
    for (const [x, y] of pts) expect(x > 0.05 && x < 0.95 && y > 0.05 && y < 0.95).toBe(true);
  });

  it("draws a multi-page PDF (also without the satellite image)", async () => {
    const pdf = await renderPdf(buildReport(result, ring), null);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});

describe("PDF requests", () => {
  it("PDF keywords are routed without the model", () => {
    for (const t of ["PDF", "pdf please", "el PDF", "Pdf!"]) expect(parseDirect("done", t)).toMatchObject({ intent: "pdf_report" });
    expect(parseDirect("done", "yes")).toMatchObject({ intent: "yes" }); // YES after the offer -> PDF link (session.ts)
  });
});
