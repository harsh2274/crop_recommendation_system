import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/input";
import { checkBoundary, newProfile, toPipelineInput } from "../src/sms/profile";
import { mergeUi, MAP_UI_DEFAULTS } from "../src/sms/mappage";
import { verifySignature } from "../src/sms/twilio";

// ~800 m square near Ames, Iowa
const RING: [number, number][] = [[-93.7549, 42.0964], [-93.7451, 42.0964], [-93.7451, 42.1036], [-93.7549, 42.1036]];

describe("twilio signature", () => {
  const token = "test-auth-token";
  const url = "https://farm.example.workers.dev/sms";
  const params = { From: "+15551230000", Body: "Hola", MessageSid: "SM123" };
  // Reference per Twilio's spec: URL followed by params sorted by name, each key immediately followed by its value.
  const reference = async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url + "BodyHolaFrom+15551230000MessageSidSM123"));
    return btoa(String.fromCharCode(...new Uint8Array(mac)));
  };

  it("accepts Twilio's HMAC-SHA1 signature", async () => {
    expect(await verifySignature(token, url, params, await reference())).toBe(true);
  });
  it("rejects a tampered body, wrong token or missing header", async () => {
    const sig = await reference();
    expect(await verifySignature(token, url, { ...params, Body: "Hi" }, sig)).toBe(false);
    expect(await verifySignature("other", url, params, sig)).toBe(false);
    expect(await verifySignature(token, url, params, null)).toBe(false);
  });
});

describe("farm boundary", () => {
  it("measures a valid field and rejects bad shapes", () => {
    const ok = checkBoundary(RING);
    expect("areaHa" in ok && ok.areaHa > 60 && ok.areaHa < 68).toBe(true);
    expect(checkBoundary(RING.slice(0, 2))).toEqual({ error: "points" });
    expect(checkBoundary([[0, 0], [0.000001, 0], [0, 0.000001]])).toEqual({ error: "small" });
    expect(checkBoundary([[-100, 30], [-90, 30], [-90, 40]])).toEqual({ error: "big" });
  });
});

describe("profile -> pipeline input", () => {
  it("produces a request the analysis pipeline accepts", () => {
    const p = newProfile("+15551230000");
    Object.assign(p, {
      language: "Spanish", crops: ["maize"], pastCrops: ["soybean"], issues: ["standing water"],
      irrigation: "none", priorities: ["soil", "income"],
      boundary: { ring: RING, areaHa: 64, savedAt: "2026-11-14T00:00:00Z" },
    });
    const req = parseRequest(toPipelineInput(p, "a".repeat(64)));
    expect(req.currentRotation).toEqual([{ crop: "soybean" }, { crop: "corn" }]);
    expect(req.currentSeason?.crop).toBe("corn");
    expect(req.priorities).toMatchObject({ soilHealth: 5, income: 5, water: 2 });
    expect(req.observedIssues).toEqual(["standing water"]);
    expect(JSON.stringify(req.farmer)).not.toContain("+1555"); // phone number never leaves the profile
  });
});

describe("map page texts", () => {
  it("keeps defaults for missing or oversized translations", () => {
    const ui = mergeUi({ start: "✏️ Empezar a dibujar", done: "x".repeat(500) });
    expect(ui.start).toBe("✏️ Empezar a dibujar");
    expect(ui.done).toBe(MAP_UI_DEFAULTS.done);
  });
});
