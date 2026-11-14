// Pest scouting calendar from degree-day models (US land-grant extension thresholds, converted to
// degC). Air temperature stands in for soil temperature where a model uses soil; local trap counts
// and scouting reports always take precedence.
import { DAYS, type ClimateData, gdd } from "./climate";
import type { PestEvent } from "./types";
import { percentile } from "./stats";

interface PestModel {
  id: string;
  pest: string;
  crops: string[];
  event: string;
  baseC: number;
  targetGdd: number; // degC-days
  startMonthOffset: number; // months after the season-year start to begin counting (Jan 1 north / Jul 1 south)
  action: string;
}

const MODELS: PestModel[] = [
  { id: "corn_rootworm_hatch", pest: "Corn rootworm", crops: ["corn"], event: "larvae begin hatching (684 degF-days base 52 degF)",
    baseC: 11.1, targetGdd: 380, startMonthOffset: 0, action: "Dig and check roots of corn planted after corn about 2 weeks after this date" },
  { id: "european_corn_borer_1", pest: "European corn borer", crops: ["corn"], event: "first moth flight (374 degF-days base 50 degF)",
    baseC: 10, targetGdd: 208, startMonthOffset: 0, action: "Scout leaves for shot-hole feeding about 1-2 weeks after this date" },
  { id: "european_corn_borer_2", pest: "European corn borer", crops: ["corn"], event: "second moth flight (1400 degF-days base 50 degF)",
    baseC: 10, targetGdd: 778, startMonthOffset: 0, action: "Scout for egg masses on the underside of leaves" },
  { id: "western_bean_cutworm", pest: "Western bean cutworm", crops: ["corn", "dry_bean"], event: "25% moth flight (1319 degF-days base 50 degF from May 1)",
    baseC: 10, targetGdd: 733, startMonthOffset: 4, action: "Check 20 plants in 5 spots for egg masses each week" },
  { id: "alfalfa_weevil", pest: "Alfalfa weevil", crops: ["alfalfa"], event: "larval feeding begins (300 degF-days base 48 degF)",
    baseC: 8.9, targetGdd: 167, startMonthOffset: 0, action: "Sweep-net or bucket-check stems weekly until first cutting" },
];

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function pestCalendar(climate: ClimateData, crops: string[]): PestEvent[] {
  return MODELS.filter((m) => m.crops.some((c) => crops.includes(c))).flatMap((m) => {
    const start = MONTH_START[m.startMonthOffset];
    const days = climate.years.flatMap((y) => {
      let sum = 0;
      for (let d = start; d < DAYS; d++) {
        sum += gdd(y.tmax[d], y.tmin[d], m.baseC);
        if (sum >= m.targetGdd) return [d];
      }
      return [];
    });
    if (days.length < climate.years.length / 2) return []; // threshold rarely reached here
    return [{
      pestId: m.id,
      pest: m.pest,
      crops: m.crops.filter((c) => crops.includes(c)),
      event: m.event,
      date: climate.date(Math.round(percentile(days, 0.5))),
      earliest: climate.date(Math.round(percentile(days, 0.1))),
      latest: climate.date(Math.round(percentile(days, 0.9))),
      action: m.action,
    }];
  });
}
