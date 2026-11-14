// Live demo: draw a field, run POST /analyze (Server-Sent Events) and render each section as it arrives.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const when = (mmdd) => {
    if (!mmdd) return "–";
    const d = Number(mmdd.slice(3, 5));
    return `${d <= 10 ? "early" : d <= 20 ? "mid" : "late"} ${MONTHS[Number(mmdd.slice(0, 2)) - 1]}`;
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const bar = (v) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;

  // ------------------------------------------------------------ form
  const CROPS = [["corn", "Corn"], ["soybean", "Soybean"], ["winter_wheat", "Winter wheat"], ["oats", "Oats"], ["barley", "Barley"], ["sorghum", "Sorghum"],
    ["sunflower", "Sunflower"], ["canola", "Canola"], ["dry_bean", "Dry bean"], ["field_pea", "Field pea"], ["cotton", "Cotton"], ["potato", "Potato"], ["alfalfa", "Alfalfa"]];
  const PRIORITIES = [["income", "More income"], ["soilHealth", "Healthier soil"], ["water", "Saving water"], ["pest", "Fewer pests"], ["resilience", "Less weather risk"], ["erosion", "Less erosion"]];
  const cropOrder = ["corn", "soybean"];
  const chosen = new Set(["soilHealth", "income"]);
  const cropNames = Object.fromEntries(CROPS);

  function renderCropChips() {
    $("crops").innerHTML = CROPS.map(([id, name]) => {
      const i = cropOrder.indexOf(id);
      return `<button type="button" class="chip" data-crop="${id}" aria-pressed="${i >= 0}">${i >= 0 ? `<span class="ord">${i + 1}</span>` : ""}${esc(name)}</button>`;
    }).join("");
  }
  $("crops").addEventListener("click", (e) => {
    const id = e.target.closest("[data-crop]")?.dataset.crop;
    if (!id) return;
    const i = cropOrder.indexOf(id);
    if (i >= 0) cropOrder.splice(i, 1); else cropOrder.push(id);
    renderCropChips();
    updateRun();
  });
  $("priorities").innerHTML = PRIORITIES.map(([id, name]) => `<button type="button" class="chip" data-p="${id}" aria-pressed="${chosen.has(id)}">${esc(name)}</button>`).join("");
  $("priorities").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    chosen.has(b.dataset.p) ? chosen.delete(b.dataset.p) : chosen.add(b.dataset.p);
    b.setAttribute("aria-pressed", chosen.has(b.dataset.p));
  });
  renderCropChips();

  // ------------------------------------------------------------ map
  const SAMPLE = [[-93.754879, 42.096363], [-93.74512, 42.096363], [-93.74512, 42.103631], [-93.754879, 42.103631]]; // 64 ha, Boone County, Iowa
  const map = L.map("map").setView([42.1, -93.75], 14);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let ring = [];
  let drawing = false;

  function renderRing() {
    layer.clearLayers();
    const ll = ring.map(([x, y]) => [y, x]);
    if (ll.length >= 2) L.polygon(ll, { color: "#ffd33d", weight: 3, fillOpacity: 0.25 }).addTo(layer);
    ll.forEach((p) => L.circleMarker(p, { radius: 6, color: "#000", weight: 1, fillColor: "#ffd33d", fillOpacity: 1 }).addTo(layer));
    $("map-msg").textContent = drawing ? (ring.length < 3 ? "Tap each corner of the field." : "Keep tapping corners, or press Analyze.") : ring.length ? "" : "Use the sample field or draw one.";
    updateRun();
  }
  function crosses(p) {
    const n = p.length, o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
      if (o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)) return true;
    }
    return false;
  }
  map.on("click", (e) => { if (drawing) { ring.push([e.latlng.lng, e.latlng.lat]); renderRing(); } });
  $("sample").onclick = () => { drawing = false; ring = SAMPLE.slice(); map.fitBounds(ring.map(([x, y]) => [y, x]), { padding: [40, 40] }); renderRing(); };
  $("draw").onclick = () => { drawing = true; ring = []; renderRing(); };
  $("clear").onclick = () => { drawing = false; ring = []; renderRing(); };
  const updateRun = () => { $("run").disabled = ring.length < 3 || cropOrder.length === 0 || busy; };
  let busy = false;
  renderRing();

  // ------------------------------------------------------------ run
  const STEPS = ["field", "soil", "climate", "terrain", "cropSuitability", "fieldHistory", "vegetation", "hazards", "pestCalendar", "rotations", "market", "result"];
  const LABELS = { field: "Field", soil: "Soil", climate: "Climate (20 yr)", terrain: "Terrain", cropSuitability: "Crop fit", fieldHistory: "Field history",
    vegetation: "Satellite greenness", hazards: "Hazards", pestCalendar: "Pest calendar", rotations: "Rotation plans", market: "Market", result: "Done" };
  const state = {};

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (crosses(ring)) { $("map-msg").textContent = "The field outline crosses itself. Please redraw."; return; }
    busy = true; updateRun();
    drawing = false;
    for (const k of Object.keys(state)) delete state[k];
    $("progress").innerHTML = STEPS.map((s) => `<li id="p-${s}">${LABELS[s]}</li>`).join("");
    $("results").hidden = false;
    for (const id of ["r-summary", "r-climate", "r-soil", "r-crops", "r-rotations", "r-hazards", "r-pests", "r-market", "r-sources"]) $(id).innerHTML = "";
    const priorities = chosen.size ? Object.fromEntries(PRIORITIES.map(([id]) => [id, chosen.has(id) ? 5 : 2])) : undefined;
    const body = {
      type: "Feature",
      crs: "EPSG:4326",
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      properties: { fieldId: "web-demo", currentRotation: cropOrder.slice(), priorities, constraints: { irrigation: $("irrigation").value } },
    };
    try {
      const res = await fetch("/analyze", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (ev && data) onEvent(ev, JSON.parse(data));
        }
      }
    } catch (err) {
      $("r-summary").innerHTML = `<h2>Something went wrong</h2><p class="muted">${esc(err.message)}</p>`;
    }
    busy = false; updateRun();
  });

  function onEvent(ev, data) {
    if (ev === "error") { $("r-summary").innerHTML = `<h2>Analysis failed</h2><p class="muted">${esc(data.message)}</p>`; return; }
    $(`p-${ev}`)?.classList.add("done");
    state[ev] = data;
    if (ev === "field" || ev === "terrain" || ev === "result") renderSummary();
    if (ev === "climate") renderClimate(data);
    if (ev === "soil") renderSoil(data);
    if (ev === "cropSuitability") renderCrops(data);
    if (ev === "rotations") renderRotations(data);
    if (ev === "hazards") renderHazards(data);
    if (ev === "pestCalendar") renderPests(data);
    if (ev === "market") renderMarket(data);
    if (ev === "result") { renderSources(data); renderMarket(data.market); }
  }

  // ------------------------------------------------------------ renderers
  function renderSummary() {
    const f = state.result?.field ?? state.field?.field;
    if (!f) return;
    const t = state.terrain ?? f;
    const r = state.result;
    $("r-summary").innerHTML = `
      <h2>Your field</h2>
      <div class="stats">
        <div class="stat"><b>${esc(f.areaHa)} ha</b><span>${esc((f.areaHa * 2.471).toFixed(1))} acres</span></div>
        <div class="stat"><b>${f.region ? esc(f.region.county ?? f.region.admin1) : `${f.centroid.lat.toFixed(3)}, ${f.centroid.lon.toFixed(3)}`}</b><span>${f.region ? esc(`${f.region.admin1}, ${f.region.country}`) : "location"}</span></div>
        <div class="stat"><b>${t.slopePct ?? "–"}${t.slopePct != null ? "%" : ""}</b><span>mean slope (SRTM)</span></div>
        <div class="stat"><b>${t.elevationM != null ? esc(Math.round(t.elevationM)) + " m" : "–"}</b><span>elevation</span></div>
      </div>
      ${r ? `<p><strong>Recommendation:</strong> ${esc(r.recommendation.summary)} <span class="muted">(held in ${esc(Math.round(r.recommendation.stability.agreement * r.recommendation.stability.runs))} of ${esc(r.recommendation.stability.runs)} robustness tests)</span></p>
             <p class="muted">Confidence: <span class="badge ${esc(r.confidence.level === "high" ? "good" : r.confidence.level === "medium" ? "moderate" : "poor")}">${esc(r.confidence.level)}</span> · ${esc(r.disclaimer)}</p>` : `<p class="muted">Analyzing…</p>`}`;
  }

  function renderClimate(c) {
    const m = c.monthly;
    const max = Math.max(...m.map((x) => Math.max(x.precipMm, x.et0Mm)), 1);
    const w = 600, h = 160, bw = w / 12;
    const bars = m.map((x, i) => {
      const ph = (x.precipMm / max) * (h - 20), eh = (x.et0Mm / max) * (h - 20);
      return `<rect x="${i * bw + 6}" y="${h - 16 - ph}" width="${bw / 2 - 6}" height="${ph}" fill="#3b82c4" rx="2"><title>${MONTHS[i]}: rain ${x.precipMm} mm</title></rect>
              <rect x="${i * bw + bw / 2}" y="${h - 16 - eh}" width="${bw / 2 - 6}" height="${eh}" fill="#c98a1b" rx="2"><title>${MONTHS[i]}: crop water demand (ET0) ${x.et0Mm} mm</title></rect>
              <text x="${i * bw + bw / 2}" y="${h - 2}" font-size="11" text-anchor="middle" fill="currentColor">${MONTHS[i][0]}</text>`;
    }).join("");
    const st = c.baseline.stationCorrection;
    $("r-climate").innerHTML = `
      <h2>Climate (${esc(c.period.startYear)}–${esc(c.period.endYear)})</h2>
      <div class="stats">
        <div class="stat"><b>${esc(c.annual.precipMm)} mm</b><span>rain per year</span></div>
        <div class="stat"><b>${esc(c.annual.tmeanC)} °C</b><span>average temperature</span></div>
        <div class="stat"><b>${esc(when(c.frost.lastSpringMedian))}</b><span>last spring frost</span></div>
        <div class="stat"><b>${esc(when(c.frost.firstFallMedian))}</b><span>first fall frost</span></div>
      </div>
      <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Monthly rain and crop water demand">${bars}</svg>
      <p class="legend"><i style="background:#3b82c4"></i>rain <i style="background:#c98a1b"></i>water demand (FAO-56 Penman-Monteith)</p>
      <p class="muted">${st ? `Temperatures corrected to NOAA station ${esc(st.name)} (${esc(st.distanceKm)} km).` : "No nearby weather station: NASA POWER grid values."}
      Warming trend: ${esc(c.trends.tmeanC.perDecade)} °C per decade${c.trends.tmeanC.significant ? "" : " (not significant)"}.</p>`;
  }

  function renderSoil(s) {
    $("r-soil").innerHTML = `
      <h2>Soil</h2>
      <div class="stats">
        <div class="stat"><b>${esc(s.texture)}</b><span>texture</span></div>
        <div class="stat"><b>${esc(s.ph)}</b><span>pH</span></div>
        <div class="stat"><b>${esc(s.organicMatterPct)}%</b><span>organic matter</span></div>
        <div class="stat"><b>${esc(s.drainageClass ?? "–")}</b><span>drainage</span></div>
      </div>
      <p class="muted">Source: ${esc(s.source)} · available water ${esc(s.availableWaterMmPerM)} mm per metre of soil.</p>`;
  }

  function renderCrops(list) {
    const rows = list.filter((c) => c.role !== "cover").map((c) => `
      <tr><td><strong>${esc(c.name)}</strong>${c.maturityClass !== "fixed" ? `<br><span class="muted">${esc(c.maturityClass)}-season variety</span>` : ""}</td>
      <td><span class="badge ${esc(c.class)}">${esc(c.class)}</span></td>
      <td>${bar(c.suitability)}<span class="muted">${esc(c.suitability)}</span></td>
      <td>${esc(Math.round(c.seasonFitProbability * 10))}/10 years</td>
      <td>${esc(when(c.plantingDate))} → ${esc(when(c.harvestDate))}</td>
      <td class="muted">${esc(c.limitingFactors.slice(0, 2).join("; ") || "–")}</td></tr>`).join("");
    $("r-crops").innerHTML = `<h2>Which crops fit this field</h2>
      <p class="muted">Each crop replayed through 20 real seasons: frost, heat, water stress at flowering, soil pH.</p>
      <div class="scroll"><table><thead><tr><th>Crop</th><th>Fit</th><th>Score</th><th>Reached harvest</th><th>Plant → harvest</th><th>Limits</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const SCORE_LABELS = { soilHealth: "Soil health", water: "Water use", resilience: "Weather resilience", pest: "Pest disruption", erosion: "Erosion control" };
  function renderRotations({ rotations, recommendation }) {
    $("r-rotations").innerHTML = `<h2>Rotation plans compared</h2>` + rotations.map((r) => `
      <div class="rot ${r.id === recommendation.rotationId ? "best" : ""}">
        <strong>${esc(r.name)}</strong> ${r.id === recommendation.rotationId ? `<span class="badge good">recommended</span>` : ""} <span class="muted">overall ${esc(r.scores.overall)}/100</span>
        <div class="seq">${r.sequence.map((e) => `<span>Year ${esc(e.year)}: ${esc(cropNames[e.crop] ?? e.crop)}${e.cover ? ` + ${esc(e.cover.replace(/_/g, " "))} cover` : ""}</span>`).join("")}</div>
        <div class="scores">${Object.entries(SCORE_LABELS).map(([k, label]) => `<span>${label}</span>${bar(r.scores[k])}<span>${esc(r.scores[k])}</span>`).join("")}</div>
        ${r.benefits.length ? `<p>${esc(r.benefits.slice(0, 2).join(" "))}</p>` : ""}
        ${r.programs.length ? `<p class="muted">May qualify for: ${esc(r.programs.join("; "))}</p>` : ""}
      </div>`).join("");
  }

  function renderHazards(list) {
    const shown = list.filter((h) => h.severity !== "low").slice(0, 6);
    $("r-hazards").innerHTML = `<h2>Things to watch</h2>` + (shown.length ? shown.map((h) => `
      <p><span class="badge ${esc(h.severity)}">${esc(h.severity)}</span> <strong>${esc(h.title)}</strong>${h.upcoming ? ` <span class="badge moderate">coming soon</span>` : ""}<br>
      <span class="muted">${h.months.length ? (h.months.length >= 6 ? "Most months. " : `${esc(h.months.map((m) => MONTHS[m - 1].slice(0, 3)).join(", "))}. `) : ""}${esc(h.mitigation[0] ?? "")}</span></p>`).join("") : `<p class="muted">No serious hazards found.</p>`);
  }

  function renderPests(list) {
    $("r-pests").innerHTML = `<h2>Pest scouting calendar</h2>` + (list.length ? list.map((p) => `
      <p><strong>${esc(p.pest)}</strong>: ${esc(when(p.date))} <span class="muted">(${esc(when(p.earliest))} – ${esc(when(p.latest))})</span><br><span class="muted">${esc(p.action)}</span></p>`).join("")
      : `<p class="muted">No degree-day pest models apply to these crops.</p>`);
  }

  function renderMarket(m) {
    if (!m) { $("r-market").innerHTML = `<h2>Market</h2><p class="muted">No market data for these crops.</p>`; return; }
    const rows = m.crops.map((c) => {
      const p = c.price.usdPerBushel ?? c.price.usdPerTonne, unit = c.price.usdPerBushel ? "bu" : "t";
      return `<tr><td><strong>${esc(cropNames[c.cropId] ?? c.cropId)}</strong></td><td>${esc(MONTHS[c.harvestMonth - 1])}</td>
        <td>$${esc(p.p10)} – $${esc(p.p90)}/${unit}<br><span class="muted">typical $${esc(p.p50)}</span></td>
        <td>${c.bestSellMonth && c.bestSellMonth.premiumPct >= 2 ? `${esc(MONTHS[c.bestSellMonth.month - 1])} (+${esc(Math.round(c.bestSellMonth.premiumPct))}%)` : "at harvest"}</td>
        <td>${c.grossRevenuePerHa ? `$${esc(c.grossRevenuePerHa.p50)}` : "–"}</td>
        <td class="muted">${esc(c.backtest.mapePct)}% vs ${esc(c.backtest.naiveMapePct)}%</td></tr>`;
    }).join("");
    $("r-market").innerHTML = `<h2>Market (what the farmer gets when asking "how and where should I sell?")</h2>
      <div class="scroll"><table><thead><tr><th>Crop</th><th>Harvest</th><th>Price at harvest</th><th>Usually best month</th><th>Revenue/ha before costs</th><th>Backtest error vs naive</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted">${esc(m.notes.join(" "))}</p>`;
  }

  function renderSources(r) {
    $("r-sources").innerHTML = `<h2>Data used for this field</h2>
      <div class="chips">${r.dataSources.map((s) => `<span class="chip" title="${esc(s.note ?? "")}"><span class="badge ${esc(s.status)}">${esc(s.status)}</span> ${esc(s.dataset)}</span>`).join("")}</div>
      <p class="muted">${esc(r.confidence.reasons.join(" "))}</p>`;
  }
})();
