// The one web page in the product: the farmer marks the farm's corners on a satellite map.
// Two big steps (find my farm -> draw), only Redraw / Continue while drawing, no way to submit
// fewer than 3 corners or crossing lines. Texts arrive translated by the intake agent.

export const MAP_UI_DEFAULTS = {
  title: "Mark your farm",
  findMe: "📍 Find my farm",
  locating: "Finding where you are…",
  locationFailed: "Could not find your location. Move the map to your farm.",
  ready: "When you see your farm, press Start drawing.",
  start: "✏️ Start drawing",
  hint: "Tap each corner of your farm on the map.",
  redraw: "↺ Redraw",
  continue: "✓ Continue",
  needMore: "Tap at least 3 corners.",
  crossing: "The lines cross. Please press Redraw and try again.",
  badSize: "That shape looks too small or too big. Please redraw.",
  saving: "Saving…",
  failed: "Something went wrong. Please press Continue again.",
  done: "✅ We took note of the footprint of your farm. You can close this page now and go back to your text messages: your next question is waiting there.",
  expired: "This link has expired. Send us a text message to get a new one.",
};
export type MapUi = typeof MAP_UI_DEFAULTS;
export const MAP_UI_KEYS = Object.keys(MAP_UI_DEFAULTS) as (keyof MapUi)[];

export function mergeUi(ui: Partial<MapUi> | undefined): MapUi {
  const out = { ...MAP_UI_DEFAULTS };
  for (const k of MAP_UI_KEYS) {
    const v = ui?.[k];
    if (typeof v === "string" && v.trim() && v.length < 300) out[k] = v.trim();
  }
  return out;
}

export interface MapPageConfig { ui: MapUi; center: [number, number]; zoom: number; lang: string }

export function renderMapPage(cfg: MapPageConfig | null): Response {
  const json = JSON.stringify(cfg ?? { ui: MAP_UI_DEFAULTS, expired: true }).replace(/</g, "\\u003c");
  return new Response(PAGE.replace("__CONFIG__", json), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Farm map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
  html,body{margin:0;height:100%;font:18px/1.35 system-ui,sans-serif;background:#111;color:#111}
  #map{position:absolute;inset:0 0 150px 0}
  #panel{position:absolute;left:0;right:0;bottom:0;height:150px;background:#fff;padding:12px 16px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px}
  #msg{min-height:2.6em;font-size:17px}
  .row{display:flex;gap:10px}
  button{flex:1;font-size:20px;font-weight:600;padding:14px 8px;border:0;border-radius:14px;background:#1f6feb;color:#fff}
  button.alt{background:#e7e7e7;color:#111}
  button.go{background:#1a7f37}
  button:disabled{opacity:.4}
  .hide{display:none!important}
  #panel{z-index:1000}
  #done{position:fixed;inset:0;z-index:2000;background:#fff;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;font-size:24px;line-height:1.4}
</style></head>
<body>
<div id="map"></div>
<div id="panel">
  <div id="msg"></div>
  <div class="row" id="step1"><button class="alt" id="find"></button><button id="start"></button></div>
  <div class="row hide" id="step2"><button class="alt" id="redraw"></button><button class="go" id="cont" disabled></button></div>
</div>
<div id="done" class="hide"></div>
<script>
const CFG = __CONFIG__, S = CFG.ui, $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };
document.title = S.title; document.documentElement.lang = CFG.lang || "en";
for (const [id, key] of [["find","findMe"],["start","start"],["redraw","redraw"],["cont","continue"]]) $(id).textContent = S[key];
if (CFG.expired) { $("done").textContent = S.expired; $("done").classList.remove("hide"); throw 0; }

const map = L.map("map", { attributionControl: true }).setView(CFG.center, CFG.zoom);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" }).addTo(map);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }).addTo(map);

let fix = null, drawing = false, pts = [], layer = L.layerGroup().addTo(map);

function locate() {
  if (!navigator.geolocation) return say(S.locationFailed);
  say(S.locating);
  navigator.geolocation.getCurrentPosition((p) => {
    fix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: p.coords.accuracy };
    map.setView([fix.lat, fix.lon], p.coords.accuracy < 300 ? 17 : 15);
    L.circleMarker([fix.lat, fix.lon], { radius: 8, color: "#fff", fillColor: "#1f6feb", fillOpacity: 1 }).addTo(map);
    say(S.ready);
  }, () => say(S.locationFailed), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function render() {
  layer.clearLayers();
  const ll = pts.map(([x, y]) => [y, x]);
  if (ll.length >= 2) L.polygon(ll, { color: "#ffd33d", weight: 3, fillOpacity: 0.25 }).addTo(layer);
  ll.forEach((p) => L.circleMarker(p, { radius: 9, color: "#000", weight: 2, fillColor: "#ffd33d", fillOpacity: 1 }).addTo(layer));
  $("cont").disabled = pts.length < 3;
  say(S.hint);
}

function crosses(p) { // any two non-adjacent edges intersect?
  const n = p.length, seg = (i) => [p[i], p[(i + 1) % n]];
  const o = (a, b, c) => Math.sign((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    const [a, b] = seg(i), [c, d] = seg(j);
    if (o(a,b,c) !== o(a,b,d) && o(c,d,a) !== o(c,d,b)) return true;
  }
  return false;
}

map.on("click", (e) => { if (drawing) { pts.push([e.latlng.lng, e.latlng.lat]); render(); } });
$("find").onclick = locate;
$("start").onclick = () => { drawing = true; pts = []; $("step1").classList.add("hide"); $("step2").classList.remove("hide"); render(); };
$("redraw").onclick = () => { pts = []; render(); };
$("cont").onclick = async () => {
  if (pts.length < 3) return say(S.needMore);
  if (crosses(pts)) return say(S.crossing);
  $("cont").disabled = true; say(S.saving);
  try {
    const res = await fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ring: pts, location: fix }) });
    const out = await res.json();
    if (out.ok) { drawing = false; $("done").textContent = S.done; $("done").classList.remove("hide"); return; }
    say(out.error === "expired" ? S.expired : out.error === "small" || out.error === "big" ? S.badSize : out.error === "points" ? S.needMore : S.failed);
  } catch { say(S.failed); }
  $("cont").disabled = false;
};
locate();
</script>
</body></html>`;
