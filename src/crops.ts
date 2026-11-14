// Crop knowledge base. Values are generic, temperate-zone approximations drawn from
// FAO-56 (crop coefficients), FAO ECOCROP (temperature/pH limits) and US extension
// guides (GDD, sowing rules, winter hardiness). They are starting points that need
// local calibration; the output says so in every strategy's informationGaps.

export interface Crop {
  id: string;
  name: string;
  aliases: string[];
  family: string; // botanical family: pests and diseases largely follow family
  role: "cash" | "cover" | "forage";
  /**
   * after_frost: frost-sensitive, sown once frost risk is low and soil is warm
   * spring:      frost-tolerant, sown as soon as the soil warms past sowTempC
   * fall:        sown ~5 weeks before the median first fall frost, overwinters
   */
  sowing: "after_frost" | "spring" | "fall";
  sowTempC: number; // smoothed daily mean air temperature needed to sow
  tBaseC: number; // growing-degree-day base
  gddToMaturity: number; // degC-days of a typical variety; for cover crops: GDD for useful biomass
  gddRange?: [number, number]; // available variety lengths (early..full season); the site picks the longest that fits
  frostKillC: number; // air Tmin that kills the emerged crop; for fall crops an air-temperature
                      // hardiness equivalent that assumes typical snow/residue insulation
  frostSafeDays?: number; // days after sowing that frost cannot kill (seed, underground growing point); default 10
  winterKill?: boolean; // cover crop meant to die over winter once it has made its biomass
  heatStressC: number; // Tmax above which yield formation suffers
  kc: number; // season-average FAO-56 crop coefficient
  droughtTolerance: 1 | 2 | 3;
  wetTolerance: 1 | 2 | 3; // tolerance of waterlogging
  rootDepthM: number;
  nFixing: boolean;
  nDemanding: boolean; // benefits most from a preceding legume
  residue: 1 | 2 | 3; // organic-matter return
  phMin: number;
  phMax: number;
  perennial?: boolean;
  keyPests: string;
  humidDiseases: string;
}

const c = (crop: Crop): Crop => crop;

export const CROPS: Crop[] = [
  c({ id: "corn", name: "Corn (maize)", aliases: ["maize", "field corn", "grain corn"], family: "Poaceae", role: "cash",
      sowing: "after_frost", sowTempC: 10, tBaseC: 10, gddToMaturity: 1550, gddRange: [1250, 1700], frostKillC: -2, frostSafeDays: 28, heatStressC: 35, kc: 0.85,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 1.2, nFixing: false, nDemanding: true, residue: 3, phMin: 5.8, phMax: 7.5,
      keyPests: "corn rootworm, European corn borer", humidDiseases: "gray leaf spot, northern corn leaf blight" }),
  c({ id: "soybean", name: "Soybean", aliases: ["soy", "soybeans", "soya"], family: "Fabaceae", role: "cash",
      sowing: "after_frost", sowTempC: 12, tBaseC: 10, gddToMaturity: 1450, gddRange: [1150, 1650], frostKillC: -1, heatStressC: 35, kc: 0.8,
      droughtTolerance: 2, wetTolerance: 1, rootDepthM: 1.0, nFixing: true, nDemanding: false, residue: 1, phMin: 6.0, phMax: 7.0,
      keyPests: "soybean cyst nematode, soybean aphid", humidDiseases: "white mold, sudden death syndrome" }),
  c({ id: "winter_wheat", name: "Winter wheat", aliases: ["wheat"], family: "Poaceae", role: "cash",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 2500, frostKillC: -28, heatStressC: 32, kc: 0.75,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 1.5, nFixing: false, nDemanding: true, residue: 3, phMin: 6.0, phMax: 7.5,
      keyPests: "Hessian fly, aphids", humidDiseases: "Fusarium head blight, rusts" }),
  c({ id: "oats", name: "Oats", aliases: ["oat", "spring oats"], family: "Poaceae", role: "cash",
      sowing: "spring", sowTempC: 5, tBaseC: 0, gddToMaturity: 1350, frostKillC: -9, heatStressC: 30, kc: 0.75,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 1.0, nFixing: false, nDemanding: false, residue: 2, phMin: 5.5, phMax: 7.0,
      keyPests: "aphids (barley yellow dwarf)", humidDiseases: "crown rust" }),
  c({ id: "barley", name: "Spring barley", aliases: ["barley"], family: "Poaceae", role: "cash",
      sowing: "spring", sowTempC: 5, tBaseC: 0, gddToMaturity: 1300, frostKillC: -9, heatStressC: 30, kc: 0.75,
      droughtTolerance: 2, wetTolerance: 1, rootDepthM: 1.0, nFixing: false, nDemanding: false, residue: 2, phMin: 6.0, phMax: 8.0,
      keyPests: "aphids, wireworms", humidDiseases: "net blotch, Fusarium head blight" }),
  c({ id: "sorghum", name: "Grain sorghum", aliases: ["milo", "sorghum"], family: "Poaceae", role: "cash",
      sowing: "after_frost", sowTempC: 15, tBaseC: 10, gddToMaturity: 1400, gddRange: [1150, 1550], frostKillC: -1, frostSafeDays: 28, heatStressC: 38, kc: 0.75,
      droughtTolerance: 3, wetTolerance: 2, rootDepthM: 1.8, nFixing: false, nDemanding: true, residue: 3, phMin: 5.5, phMax: 8.0,
      keyPests: "sugarcane aphid, sorghum midge", humidDiseases: "anthracnose" }),
  c({ id: "sunflower", name: "Sunflower", aliases: ["sunflowers"], family: "Asteraceae", role: "cash",
      sowing: "after_frost", sowTempC: 10, tBaseC: 6, gddToMaturity: 1500, gddRange: [1250, 1650], frostKillC: -2, heatStressC: 35, kc: 0.75,
      droughtTolerance: 3, wetTolerance: 1, rootDepthM: 2.0, nFixing: false, nDemanding: false, residue: 2, phMin: 6.0, phMax: 7.5,
      keyPests: "sunflower moth, stem weevil", humidDiseases: "Sclerotinia white mold" }),
  c({ id: "canola", name: "Spring canola", aliases: ["rapeseed", "canola"], family: "Brassicaceae", role: "cash",
      sowing: "spring", sowTempC: 5, tBaseC: 5, gddToMaturity: 1100, frostKillC: -7, heatStressC: 30, kc: 0.8,
      droughtTolerance: 1, wetTolerance: 1, rootDepthM: 1.0, nFixing: false, nDemanding: true, residue: 2, phMin: 5.5, phMax: 7.5,
      keyPests: "flea beetle", humidDiseases: "Sclerotinia stem rot, blackleg" }),
  c({ id: "dry_bean", name: "Dry bean", aliases: ["beans", "dry beans", "pinto bean", "black bean"], family: "Fabaceae", role: "cash",
      sowing: "after_frost", sowTempC: 15, tBaseC: 10, gddToMaturity: 1000, frostKillC: 0, heatStressC: 32, kc: 0.8,
      droughtTolerance: 1, wetTolerance: 1, rootDepthM: 0.8, nFixing: true, nDemanding: false, residue: 1, phMin: 6.0, phMax: 7.5,
      keyPests: "bean leaf beetle, western bean cutworm", humidDiseases: "white mold, bacterial blight" }),
  c({ id: "field_pea", name: "Field pea", aliases: ["peas", "pea", "dry pea"], family: "Fabaceae", role: "cash",
      sowing: "spring", sowTempC: 5, tBaseC: 4, gddToMaturity: 950, frostKillC: -7, heatStressC: 28, kc: 0.75,
      droughtTolerance: 2, wetTolerance: 1, rootDepthM: 0.8, nFixing: true, nDemanding: false, residue: 1, phMin: 5.8, phMax: 7.5,
      keyPests: "pea aphid, pea leaf weevil", humidDiseases: "Ascochyta blight, root rots" }),
  c({ id: "cotton", name: "Cotton", aliases: ["upland cotton"], family: "Malvaceae", role: "cash",
      sowing: "after_frost", sowTempC: 18, tBaseC: 15.6, gddToMaturity: 1250, gddRange: [1100, 1450], frostKillC: -1, heatStressC: 38, kc: 0.8,
      droughtTolerance: 3, wetTolerance: 1, rootDepthM: 1.5, nFixing: false, nDemanding: true, residue: 2, phMin: 5.8, phMax: 8.0,
      keyPests: "bollworm, thrips", humidDiseases: "boll rot, target spot" }),
  c({ id: "potato", name: "Potato", aliases: ["potatoes"], family: "Solanaceae", role: "cash",
      sowing: "spring", sowTempC: 10, tBaseC: 7, gddToMaturity: 1100, frostKillC: -2, heatStressC: 30, kc: 0.85,
      droughtTolerance: 1, wetTolerance: 1, rootDepthM: 0.5, nFixing: false, nDemanding: true, residue: 1, phMin: 5.0, phMax: 6.5,
      keyPests: "Colorado potato beetle", humidDiseases: "late blight, early blight" }),
  c({ id: "alfalfa", name: "Alfalfa", aliases: ["lucerne", "hay"], family: "Fabaceae", role: "forage",
      sowing: "spring", sowTempC: 8, tBaseC: 5, gddToMaturity: 1600, frostKillC: -25, heatStressC: 38, kc: 0.95,
      droughtTolerance: 3, wetTolerance: 1, rootDepthM: 3.0, nFixing: true, nDemanding: false, residue: 2, phMin: 6.5, phMax: 7.8,
      perennial: true, keyPests: "alfalfa weevil, potato leafhopper", humidDiseases: "anthracnose, Phytophthora root rot" }),

  // ---- cover crops (gddToMaturity = GDD needed for useful biomass before winter/termination)
  c({ id: "cereal_rye", name: "Cereal rye (cover)", aliases: ["rye", "winter rye"], family: "Poaceae", role: "cover",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 400, frostKillC: -34, heatStressC: 32, kc: 0.6,
      droughtTolerance: 3, wetTolerance: 2, rootDepthM: 1.5, nFixing: false, nDemanding: false, residue: 3, phMin: 5.0, phMax: 7.5,
      keyPests: "", humidDiseases: "" }),
  c({ id: "crimson_clover", name: "Crimson clover (cover)", aliases: ["clover"], family: "Fabaceae", role: "cover",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 600, frostKillC: -18, heatStressC: 30, kc: 0.6,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 0.8, nFixing: true, nDemanding: false, residue: 2, phMin: 5.5, phMax: 7.0,
      keyPests: "", humidDiseases: "" }),
  c({ id: "hairy_vetch", name: "Hairy vetch (cover)", aliases: ["vetch"], family: "Fabaceae", role: "cover",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 600, frostKillC: -28, heatStressC: 30, kc: 0.6,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 1.0, nFixing: true, nDemanding: false, residue: 2, phMin: 5.5, phMax: 7.5,
      keyPests: "", humidDiseases: "" }),
  c({ id: "oats_cover", name: "Oats (winter-killed cover)", aliases: ["cover oats"], family: "Poaceae", role: "cover",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 400, frostKillC: -7, winterKill: true, heatStressC: 30, kc: 0.6,
      droughtTolerance: 2, wetTolerance: 2, rootDepthM: 1.0, nFixing: false, nDemanding: false, residue: 2, phMin: 5.5, phMax: 7.0,
      keyPests: "", humidDiseases: "" }),
  c({ id: "radish", name: "Forage radish (cover)", aliases: ["tillage radish", "daikon"], family: "Brassicaceae", role: "cover",
      sowing: "fall", sowTempC: 0, tBaseC: 0, gddToMaturity: 350, frostKillC: -6, winterKill: true, heatStressC: 30, kc: 0.6,
      droughtTolerance: 2, wetTolerance: 1, rootDepthM: 1.8, nFixing: false, nDemanding: false, residue: 1, phMin: 6.0, phMax: 7.5,
      keyPests: "", humidDiseases: "" }),
];

const BY_ID = new Map(CROPS.map((crop) => [crop.id, crop]));

export function getCrop(id: string): Crop {
  const crop = BY_ID.get(id);
  if (!crop) throw new Error(`Unknown crop id: ${id}`);
  return crop;
}

/** Resolve a free-text crop name ("Soybeans", "maize") to a catalog id, or null. */
export function resolveCropId(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const plain = key.replace(/_/g, " ");
  for (const crop of CROPS) {
    if (crop.id === key || crop.name.toLowerCase() === plain || crop.aliases.includes(plain)) return crop.id;
  }
  return null;
}
