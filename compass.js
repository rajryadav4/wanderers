/* WANDERERS Sky Compass: landing -> "where are you in the universe" intro -> one-step flat calibration ->
 * augmented-reality sky with a compass tape, tilt scale, mini radar and live telemetry.
 * Motion: orient.js (gyro drives movement, compass sets north). Sky: sky.js. Intro: intro.js (three.js). */
import { playIntro, earthFacts } from "./intro.js?v=20261114d";

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const SEATTLE = { lat: 47.61, lon: -122.33, approx: true };
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const F = new Orient.Fusion();
const S = {
  targets: [], sel: null, loc: null, locNote: "location not shared yet", place: null, cities: null,
  camOn: false, sensors: false, manual: { az: 180, alt: 25 }, vfovNoCam: 60, regionImg: null, lastTele: 0, buzzed: {},
};

const STARS = [
  ["Polaris", 37.95, 89.26], ["Vega", 279.23, 38.78], ["Arcturus", 213.92, 19.18], ["Capella", 79.17, 46.0],
  ["Sirius", 101.29, -16.72], ["Betelgeuse", 88.79, 7.41], ["Rigel", 78.63, -8.2], ["Aldebaran", 68.98, 16.51],
  ["Altair", 297.7, 8.87], ["Deneb", 310.36, 45.28], ["Spica", 201.3, -11.16], ["Antares", 247.35, -26.43],
  ["Procyon", 114.83, 5.22], ["Pollux", 116.33, 28.03], ["Regulus", 152.09, 11.97], ["Fomalhaut", 344.41, -29.62],
].map(([name, ra, dec]) => ({ name, ra, dec }));
const BODIES = [{ name: "Sun", body: "sun" }, { name: "Moon", body: "moon" }];
const LANDMARKS = [
  { name: "Space Needle", lat: 47.6205, lon: -122.3493 }, { name: "Columbia Center", lat: 47.6045, lon: -122.3306 },
  { name: "Mount Rainier", lat: 46.8529, lon: -121.7604 }, { name: "Mount Baker", lat: 48.7767, lon: -121.8144 },
  { name: "Olympic Mtns (Mt Constance)", lat: 47.7726, lon: -123.1293 },
];

const vec = (az, alt) => [Math.sin(az * D2R) * Math.cos(alt * D2R), Math.cos(az * D2R) * Math.cos(alt * D2R), Math.sin(alt * D2R)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180;
const compassPt = (az) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
const loc = () => S.loc || SEATTLE;
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  return ((Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D2R) + 360) % 360;
}
function distKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
  return 12742 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- data ----------
Sky.loadDeclination("data/declination.json").then(updateDecl);
fetch("data/index.json").then((r) => r.json()).then((list) => {
  S.targets = list;
  const want = new URLSearchParams(location.search).get("target");
  S.sel = list.find((t) => t.id === want) || null;
  renderTargets();
});
function updateDecl() { const d = Sky.declination(loc().lat, loc().lon); F.decl = d == null ? 0 : d; }

async function nearestCity(lat, lon) {
  try {
    if (!S.cities) S.cities = await (await fetch("data/earth/cities.json")).json();
    let best = null, bd = 1e9;
    for (const c of S.cities) { const d = distKm(lat, lon, c[2], c[3]); if (d < bd) { bd = d; best = c; } }
    return best ? { city: bd < 40 ? best[0] : `near ${best[0]}`, region: best[1], km: bd } : null;
  } catch { return null; }
}

// ---------- begin: permissions in one tap ----------
let placeResolve; const placePromise = new Promise((ok) => (placeResolve = ok));
$("go").onclick = async () => {
  $("goMsg").textContent = "";
  try {   // iOS needs this from the tap itself, before anything async
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") $("goMsg").textContent = "Motion access declined: you can still drag the sky to look around.";
    }
  } catch (e) { /* not available */ }
  window.addEventListener("deviceorientation", (e) => { F.feed(e); S.sensors = S.sensors || e.beta != null; }, true);
  window.addEventListener("deviceorientationabsolute", (e) => F.feed({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true }), true);
  if ($("useCam").checked) startCamera();
  locate();
  $("landing").hidden = true; $("cosmos").hidden = false;
  $("skipIntro").onclick = () => $("cosmosStage").skip && $("cosmosStage").skip();
  try {
    const qs = new URLSearchParams(location.search);
    await playIntro({ container: $("cosmosStage"), caption: $("cosmosTitle"), sub: $("cosmosSub"), reduced,
      slow: qs.get("intro") === "slow" ? 2.5 : 1, from: qs.get("introFrom") || "universe",
      getPlace: () => placePromise, getRegionImage: () => S.regionPromise || Promise.resolve(null), onDone: afterIntro });
  } catch (e) { console.warn("intro failed", e); afterIntro(S.place || SEATTLE); }
};

async function startCamera() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("cam").srcObject = st; S.camOn = true;
  } catch { S.camOn = false; }
}

function locate() {
  if (!navigator.geolocation) { S.locNote = "no GPS: using Seattle"; placeResolve(null); return; }
  let first = true;
  navigator.geolocation.watchPosition(async (p) => {
    S.loc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    S.locNote = `GPS ±${Math.round(p.coords.accuracy)} m`;
    updateDecl();
    if (first) {
      first = false;
      const c = await nearestCity(S.loc.lat, S.loc.lon);
      S.place = { lat: S.loc.lat, lon: S.loc.lon, ...(c || {}) };
      S.regionPromise = regionImage(S.loc.lat, S.loc.lon);
      placeResolve(S.place);
    }
  }, () => { S.locNote = "location declined: using Seattle"; placeResolve(null); },
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// NASA GIBS regional view (Blue Marble), +-150 km around you, Web Mercator
async function regionImage(lat, lon) {
  lat = Math.round(lat * 2) / 2; lon = Math.round(lon * 2) / 2;   // privacy: NASA only sees your area to ~50 km
  const R = 6378137, x = lon * D2R * R, y = Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) * R, h = 150000 / Math.cos(lat * D2R);
  const url = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&STYLES=" +
    `&CRS=EPSG:3857&BBOX=${x - h},${y - h},${x + h},${y + h}&WIDTH=720&HEIGHT=720&FORMAT=image/jpeg&LAYERS=BlueMarble_NextGeneration`;
  try { const r = await fetch(url); if (!r.ok) return null; return URL.createObjectURL(await r.blob()); } catch { return null; }
}

// ---------- after the intro: calibration, then AR ----------
function afterIntro(place) {
  if (place && !S.place) S.place = place;
  $("cosmos").hidden = true; $("ar").hidden = false; $("hud").hidden = false;
  if (S.camOn) { $("cam").hidden = false; $("cam").play().catch(() => {}); }
  fit(); requestAnimationFrame(loop);
  setTimeout(() => (S.sensors ? showCalibration() : desktopMode()), 300);
}
function desktopMode() {
  $("guideSub").textContent = "No motion sensors here: drag the sky or use the arrow keys to look around.";
}

function showCalibration() {
  $("calib").hidden = false; $("calDone").hidden = true; $("calSkip").hidden = false;
  $("calTitle").textContent = "Lay your phone flat on a table";
  $("calText").textContent = "Screen up, hands off. Hold still for 3 seconds while we line up its gyroscope with its compass.";
  F.startFlatCalibration();
  F.onCalibrated = (r) => {
    $("ringFill").style.strokeDashoffset = 0;
    const msg = {
      good: `Calibrated. Your compass is steady (±${r.compassScatter.toFixed(1)}°).`,
      fair: `Calibrated. Some magnetic interference nearby (±${r.compassScatter.toFixed(1)}°): for best accuracy use North check once.`,
      poor: `Calibrated, but there is strong magnetic interference here (metal nearby). Use North check on the Moon, a star or a landmark.`,
      nocompass: "Level set. This phone did not report a compass: use North check on the Moon, a star or a landmark.",
    }[r.quality];
    $("calTitle").textContent = "✓ Calibrated";
    $("calText").textContent = msg + " Now pick up your phone and point the camera at the sky.";
    $("calDone").hidden = false; $("calSkip").hidden = true;
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
  };
}
$("calDone").onclick = () => { $("calib").hidden = true; };
$("calSkip").onclick = () => { F.cancelCalibration(); $("calib").hidden = true; };
$("recalBtn").onclick = () => showCalibration();
function calibrationTick() {
  const c = F.calibrationState();
  if (!c || $("calib").hidden) return;
  $("ringFill").style.strokeDashoffset = 327 * (1 - c.progress);
  if (c.state === "tilted") { $("calTitle").textContent = "Lay your phone flat on a table"; }
  else if (c.state === "moving") { $("calTitle").textContent = "Hold still…"; }
  else if (c.state === "ok") { $("calTitle").textContent = `Calibrating… ${Math.round(c.progress * 100)}%`; }
}

// ---------- pointing: sensors, or drag on desktop ----------
function pose() {
  const p = S.sensors ? F.pointing() : null;
  if (p) return p;
  const f = vec(S.manual.az, S.manual.alt);
  let up = [0, 0, 1].map((z, i) => z - f[2] * f[i]); const n = Math.hypot(...up) || 1; up = up.map((x) => x / n);
  const right = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  return { az: S.manual.az, alt: S.manual.alt, forward: f, up, right, ready: true };
}
let drag = null;
$("hud").addEventListener("pointerdown", (e) => { if (!S.sensors) { drag = { x: e.clientX, y: e.clientY, az: S.manual.az, alt: S.manual.alt }; $("hud").setPointerCapture(e.pointerId); } });
$("hud").addEventListener("pointermove", (e) => {
  if (!drag) return;
  const k = 70 / innerHeight;
  S.manual.az = (drag.az - (e.clientX - drag.x) * k + 360) % 360;
  S.manual.alt = Math.max(-85, Math.min(85, drag.alt + (e.clientY - drag.y) * k));
});
$("hud").addEventListener("pointerup", () => (drag = null));
window.addEventListener("keydown", (e) => {
  if (S.sensors || e.target.tagName === "INPUT") return;
  const s = e.shiftKey ? 10 : 2;
  if (e.key === "ArrowLeft") S.manual.az = (S.manual.az - s + 360) % 360;
  if (e.key === "ArrowRight") S.manual.az = (S.manual.az + s) % 360;
  if (e.key === "ArrowUp") S.manual.alt = Math.min(85, S.manual.alt + s);
  if (e.key === "ArrowDown") S.manual.alt = Math.max(-85, S.manual.alt - s);
});

// ---------- camera model ----------
const LONG_SIDE_FOV = 67;   // typical main phone camera: field of view along the image's long side
function focalPx(W, H) {
  const v = $("cam");
  if (S.camOn && v.videoWidth) {
    const vw = v.videoWidth, vh = v.videoHeight, scale = Math.max(W / vw, H / vh);      // object-fit: cover
    return (Math.max(vw, vh) / 2) / Math.tan(LONG_SIDE_FOV / 2 * D2R) * scale;
  }
  return (H / 2) / Math.tan(S.vfovNoCam / 2 * D2R);
}

// ---------- drawing ----------
const cv = $("hud"), g = cv.getContext("2d");
let DPR = 1;
function fit() {
  DPR = Math.min(2, window.devicePixelRatio || 1); cv.width = innerWidth * DPR; cv.height = innerHeight * DPR;
  const probe = document.createElement("div");      // real size of the iPhone notch / status bar area
  probe.style.cssText = "position:fixed;top:0;padding-top:env(safe-area-inset-top);visibility:hidden";
  document.body.appendChild(probe); S.sat = parseFloat(getComputedStyle(probe).paddingTop) || 0; probe.remove();
}
window.addEventListener("resize", fit);

function loop() { draw(); calibrationTick(); requestAnimationFrame(loop); }

function draw() {
  const W = innerWidth, H = innerHeight, now = new Date(), L = loc();
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, W, H);
  const P = pose(), f = focalPx(W, H), cx = W / 2, cy = H / 2;
  const proj = (v) => {
    const z = dot(v, P.forward); if (z < 0.02) return null;
    return [cx + f * dot(v, P.right) / z, cy - f * dot(v, P.up) / z];
  };

  // virtual sky when there is no camera: sky above the horizon, ground below
  if (!S.camOn) {
    g.fillStyle = "#040914"; g.fillRect(0, 0, W, H);
    const a = proj(vec(P.az - 30, 0)), b = proj(vec(P.az + 30, 0));
    if (a && b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1, nx = -dy / n, ny = dx / n;  // normal pointing to ground
      const far = 4000;
      g.fillStyle = "rgba(30, 22, 16, 0.85)";
      g.beginPath(); g.moveTo(a[0] - dx * far / n, a[1] - dy * far / n); g.lineTo(b[0] + dx * far / n, b[1] + dy * far / n);
      g.lineTo(b[0] + dx * far / n + nx * far, b[1] + dy * far / n + ny * far); g.lineTo(a[0] - dx * far / n + nx * far, a[1] - dy * far / n + ny * far);
      g.closePath(); g.fill();
    } else if (P.alt < 0) { g.fillStyle = "rgba(30, 22, 16, 0.85)"; g.fillRect(0, 0, W, H); }
  }

  // altitude rings and azimuth lines
  const poly = (pts, style, w, dash) => {
    g.strokeStyle = style; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath();
    let on = false;
    for (const v of pts) { const q = proj(v); if (!q) { on = false; continue; } on ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); on = true; }
    g.stroke(); g.setLineDash([]);
  };
  for (const alt of [30, 60]) poly(Array.from({ length: 73 }, (_, i) => vec(i * 5, alt)), "rgba(108,196,255,.18)", 1);
  for (let az = 0; az < 360; az += 30) poly(Array.from({ length: 19 }, (_, i) => vec(az, -5 + i * 5)), "rgba(108,196,255,.12)", 1);
  poly(Array.from({ length: 145 }, (_, i) => vec(i * 2.5, 0)), "rgba(255,255,255,.7)", 1.5);
  g.font = "600 13px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.textBaseline = "bottom";
  for (let az = 0; az < 360; az += 45) {
    const q = proj(vec(az, 0)); if (!q) continue;
    g.fillStyle = az === 0 ? "#ff5a4e" : "rgba(255,255,255,.85)"; g.fillText(compassPt(az), q[0], q[1] - 6);
  }

  // Sun, Moon, bright stars (real positions now)
  g.textAlign = "left"; g.textBaseline = "middle";
  for (const o of [...BODIES, ...STARS]) {
    const s = Sky.observe(o, now, L.lat, L.lon), q = proj(vec(s.az, s.alt)); if (!q) continue;
    const below = s.alt < 0;
    if (o.body) {
      g.fillStyle = below ? "rgba(160,170,190,.35)" : o.body === "sun" ? "#ffd84a" : "#eef2fb";
      g.beginPath(); g.arc(q[0], q[1], 10, 0, 7); g.fill();
      g.font = "600 13px 'Space Grotesk', sans-serif"; g.fillStyle = "#fff"; g.fillText(o.name + (below ? " (below horizon)" : ""), q[0] + 14, q[1]);
    } else {
      g.fillStyle = below ? "rgba(160,170,190,.35)" : "rgba(255,255,255,.95)";
      g.beginPath(); g.arc(q[0], q[1], 2.6, 0, 7); g.fill();
      g.font = "12px 'Space Grotesk', sans-serif"; g.fillStyle = below ? "rgba(200,210,230,.5)" : "rgba(220,230,250,.9)"; g.fillText(o.name, q[0] + 7, q[1]);
    }
  }

  // WANDERERS targets
  for (const t of S.targets) {
    const s = Sky.observe({ ra: t.ra, dec: t.dec }, now, L.lat, L.lon), v = vec(s.az, s.alt);
    t._az = s.az; t._alt = s.alt; t._sep = Math.acos(Math.max(-1, Math.min(1, dot(v, P.forward)))) / D2R; t._v = v;
    const el = $("tp_" + t.id); if (el) el.textContent = `${compassPt(s.az)} ${Math.round(s.az)}° · ${s.alt >= 0 ? "up" : "below"} ${Math.abs(Math.round(s.alt))}°`;
    const q = proj(v); if (!q) continue;
    const sel = S.sel && S.sel.id === t.id, r = sel ? 20 : 14, col = s.alt < 0 ? "#9aa6bf" : "#ffb547";
    g.strokeStyle = col; g.lineWidth = sel ? 2.5 : 1.8;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {   // corner brackets
      g.beginPath(); g.moveTo(q[0] + sx * r, q[1] + sy * (r - 7)); g.lineTo(q[0] + sx * r, q[1] + sy * r); g.lineTo(q[0] + sx * (r - 7), q[1] + sy * r); g.stroke();
    }
    g.font = `${sel ? "700" : "600"} 13px 'Space Grotesk', sans-serif`; g.fillStyle = col;
    g.fillText(t.name, q[0] + r + 6, q[1] - 6);
    g.font = "11px 'JetBrains Mono', monospace"; g.fillStyle = "rgba(220,230,250,.8)";
    g.fillText(s.alt < 0 ? "below horizon" : `${Math.round(s.alt)}° up`, q[0] + r + 6, q[1] + 9);
  }

  // edge arrow toward an off-screen selected target
  const T = S.sel && S.targets.find((t) => t.id === S.sel.id);
  if (T && T._v) {
    // keep the arrow inside the clear part of the screen (below the readouts, above the guide panel)
    const top = (S.sat || 0) + 175, bottom = H - 250, left = 26, right = W - 72;
    const q = proj(T._v), inside = q && q[0] > left && q[0] < right && q[1] > top && q[1] < bottom;
    if (!inside) {
      const x = dot(T._v, P.right), y = dot(T._v, P.up), ang = Math.atan2(x, y);
      const ex = (left + right) / 2 + Math.sin(ang) * (right - left) / 2, ey = (top + bottom) / 2 - Math.cos(ang) * (bottom - top) / 2;
      g.save(); g.translate(ex, ey); g.rotate(ang); g.fillStyle = "#ffb547";
      g.beginPath(); g.moveTo(0, -18); g.lineTo(13, 8); g.lineTo(-13, 8); g.closePath(); g.fill(); g.restore();
    }
  }

  // centre reticle
  g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, 22, 0, 7); g.stroke();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.beginPath(); g.moveTo(cx + dx * 28, cy + dy * 28); g.lineTo(cx + dx * 40, cy + dy * 40); g.stroke(); }

  drawTape(W, P, T);
  drawPitch(W, H, P, T);
  drawRadar(P, now, L);
  guide(T);
  if (performance.now() - S.lastTele > 250) { S.lastTele = performance.now(); telemetry(now, L, P); }
}

// compass tape across the top
function drawTape(W, P, T) {
  const top = (S.sat || 0) + 8, h = 50, span = 90;
  const pxPerDeg = W / span;
  g.fillStyle = "rgba(6,12,24,.78)"; g.fillRect(0, top, W, h);
  g.strokeStyle = "rgba(108,196,255,.35)"; g.beginPath(); g.moveTo(0, top + h); g.lineTo(W, top + h); g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle";
  const start = Math.floor((P.az - span / 2) / 5) * 5;
  for (let d = start; d <= P.az + span / 2; d += 5) {
    const x = W / 2 + wrap180(d - P.az) * pxPerDeg, deg = ((d % 360) + 360) % 360, major = deg % 15 === 0;
    g.strokeStyle = "rgba(220,235,255,.7)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, top + h); g.lineTo(x, top + h - (major ? 12 : 6)); g.stroke();
    if (deg % 45 === 0) { g.font = "700 15px 'Space Grotesk', sans-serif"; g.fillStyle = deg === 0 ? "#ff5a4e" : "#fff"; g.fillText(compassPt(deg), x, top + 16); }
    else if (major) { g.font = "11px 'JetBrains Mono', monospace"; g.fillStyle = "rgba(200,215,240,.8)"; g.fillText(deg, x, top + 17); }
  }
  if (T && T._az != null) {
    const dx = wrap180(T._az - P.az);
    const x = Math.abs(dx) < span / 2 ? W / 2 + dx * pxPerDeg : dx > 0 ? W - 10 : 10;
    g.fillStyle = "#ffb547"; g.beginPath(); g.moveTo(x, top + h - 2); g.lineTo(x - 7, top + h - 13); g.lineTo(x + 7, top + h - 13); g.closePath(); g.fill();
  }
  // heading box
  g.fillStyle = "#6cc4ff"; g.fillRect(W / 2 - 34, top + h - 4, 68, 22);
  g.fillStyle = "#021220"; g.font = "700 13px 'JetBrains Mono', monospace";
  g.fillText(`${String(Math.round(P.az) % 360).padStart(3, "0")}° ${compassPt(P.az)}`, W / 2, top + h + 7);
}

// tilt scale on the right
function drawPitch(W, H, P, T) {
  const x = W - 16, cy = H / 2, span = 50, pxPerDeg = (H * 0.42) / span;
  g.strokeStyle = "rgba(220,235,255,.55)"; g.fillStyle = "rgba(200,215,240,.85)"; g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "right";
  for (let a = Math.ceil((P.alt - span / 2) / 10) * 10; a <= P.alt + span / 2; a += 10) {
    if (a < -90 || a > 90) continue;
    const y = cy - (a - P.alt) * pxPerDeg;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x - (a === 0 ? 16 : 8), y); g.stroke();
    g.fillText(`${a}°`, x - 20, y);
  }
  if (T && T._alt != null) {
    const y = Math.max(cy - span / 2 * pxPerDeg, Math.min(cy + span / 2 * pxPerDeg, cy - (T._alt - P.alt) * pxPerDeg));
    g.fillStyle = "#ffb547"; g.beginPath(); g.moveTo(x - 2, y); g.lineTo(x - 12, y - 6); g.lineTo(x - 12, y + 6); g.closePath(); g.fill();
  }
  g.fillStyle = "#6cc4ff"; g.textAlign = "right"; g.font = "700 12px 'JetBrains Mono', monospace";
  g.fillText(`${P.alt >= 0 ? "+" : ""}${Math.round(P.alt)}°`, x, cy - span / 2 * pxPerDeg - 10);
}

// mini radar (bottom-left)
function drawRadar(P, now, L) {
  const c = $("radar"), r = c.getContext("2d"), W = c.width, R = W / 2 - 8, cx = W / 2, cy = W / 2;
  r.clearRect(0, 0, W, W);
  r.strokeStyle = "rgba(108,196,255,.3)"; r.lineWidth = 2;
  for (const k of [1, 2 / 3, 1 / 3]) { r.beginPath(); r.arc(cx, cy, R * k, 0, 7); r.stroke(); }
  // zenith-centred map; rotate so the phone's heading is up
  const place = (az, alt) => { const rr = (90 - Math.max(-10, alt)) / 100 * R, a = (az - P.az) * D2R; return [cx + rr * Math.sin(a), cy - rr * Math.cos(a)]; };
  r.font = "bold 20px 'Space Grotesk', sans-serif"; r.textAlign = "center"; r.textBaseline = "middle";
  for (const [lab, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) { const q = place(az, -6); r.fillStyle = lab === "N" ? "#ff5a4e" : "#cfe3ff"; r.fillText(lab, q[0], q[1]); }
  for (const t of S.targets) {
    if (t._az == null) continue;
    const q = place(t._az, t._alt), sel = S.sel && S.sel.id === t.id;
    r.fillStyle = t._alt < 0 ? "#7f8aa3" : "#ffb547"; r.beginPath(); r.arc(q[0], q[1], sel ? 9 : 6, 0, 7); r.fill();
  }
  const me = place(P.az, P.alt);
  r.strokeStyle = "#6cc4ff"; r.lineWidth = 3; r.beginPath(); r.arc(me[0], me[1], 12, 0, 7); r.stroke();
}

function guide(T) {
  const main = $("guideMain"), sub = $("guideSub"), inv = $("investigate");
  if (!T || T._sep == null) { main.textContent = "Pick a target below"; main.classList.remove("locked"); inv.hidden = true; return; }
  const P = pose(), dAz = wrap180(T._az - P.az), dAlt = T._alt - P.alt;
  if (T._sep <= 6) {
    main.textContent = `Locked on: ${T.name}`; main.classList.add("locked");
    sub.textContent = T._alt < 0 ? "Below your horizon right now, on the other side of the Earth." : `${Math.round(T._alt)}° above your horizon.`;
    inv.hidden = false; inv.href = `index.html?target=${T.id}`;
    if (!S.buzzed[T.id] && navigator.vibrate) { navigator.vibrate(60); S.buzzed[T.id] = true; }
  } else {
    S.buzzed[T.id] = false; main.classList.remove("locked"); inv.hidden = true;
    const h = Math.abs(dAz) < 2 ? "" : `Turn ${dAz > 0 ? "right" : "left"} ${Math.abs(Math.round(dAz))}°`;
    const v = Math.abs(dAlt) < 2 ? "" : `tilt ${dAlt > 0 ? "up" : "down"} ${Math.abs(Math.round(dAlt))}°`;
    main.textContent = [h, v].filter(Boolean).join(" · ") || "Almost there";
    if (S.sensors) sub.textContent = `${T.name} is ${Math.round(T._sep)}° from your crosshair.`;
  }
}

function telemetry(now, L, P) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lst = ((Sky.gmst(Sky.jd(now)) + L.lon) % 360 + 360) % 360;
  const hm = (d) => `${String(Math.floor(d / 15)).padStart(2, "0")}:${String(Math.floor((d / 15 % 1) * 60)).padStart(2, "0")}`;
  const cal = F.calibrated ? (F.result ? F.result.quality.toUpperCase() : "OK") : S.sensors ? "NOT CALIBRATED" : "DRAG MODE";
  $("telemetry").innerHTML = [
    ["LAT", `${Math.abs(L.lat).toFixed(3)}°${L.lat >= 0 ? "N" : "S"}`], ["LON", `${Math.abs(L.lon).toFixed(3)}°${L.lon >= 0 ? "E" : "W"}`],
    ["LOCAL", `${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${tz.split("/").pop().replace("_", " ")}`],
    ["UTC", now.toISOString().slice(11, 19)], ["LST", hm(lst)], ["DECL", `${F.decl >= 0 ? "+" : ""}${F.decl.toFixed(1)}°`], ["CAL", cal],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join("");
  if (!$("info").hidden) renderInfo(now, L, lst, tz);
}

// ---------- targets ----------
function renderTargets() {
  $("targets").innerHTML = S.targets.map((t) =>
    `<button data-id="${t.id}" class="${S.sel && S.sel.id === t.id ? "on" : ""}" role="option"><b>${t.name}</b><span id="tp_${t.id}">${t.teaser}</span></button>`).join("");
  $("targets").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    S.sel = S.targets.find((t) => t.id === b.dataset.id); renderTargets();
    const u = new URL(location); u.searchParams.set("target", S.sel.id); history.replaceState(null, "", u);
  }));
}

// ---------- North check (fine-tune on something you can see) ----------
$("northBtn").onclick = () => {
  const now = new Date(), L = loc();
  const sky = [...BODIES, ...STARS].map((o) => ({ o, p: Sky.observe(o, now, L.lat, L.lon) })).filter((x) => x.p.alt > 3)
    .sort((a, b) => (b.o.body ? 1 : 0) - (a.o.body ? 1 : 0) || b.p.alt - a.p.alt).slice(0, 8);
  const lms = LANDMARKS.map((l) => ({ ...l, km: distKm(L.lat, L.lon, l.lat, l.lon) })).filter((l) => l.km > 0.2 && l.km < 150).sort((a, b) => a.km - b.km);
  const items = [
    ...sky.map((x) => ({ label: x.o.name, sub: `${compassPt(x.p.az)} · ${Math.round(x.p.alt)}° up`, az: x.p.az, alt: x.p.alt, sun: x.o.body === "sun" })),
    ...lms.map((l) => ({ label: l.name, sub: `${compassPt(bearing(L.lat, L.lon, l.lat, l.lon))} · ${l.km < 10 ? l.km.toFixed(1) : Math.round(l.km)} km`, az: bearing(L.lat, L.lon, l.lat, l.lon), alt: null })),
  ];
  $("northList").innerHTML = items.map((x, i) => `<button data-i="${i}">${x.label}<span>${x.sub}</span></button>`).join("") ||
    "<p class='small dim'>Nothing bright is up right now. Use a landmark or paste map coordinates below.</p>";
  $("northList").querySelectorAll("button").forEach((b) => (b.onclick = () => applyFine(items[+b.dataset.i])));
  $("northMsg").textContent = S.sensors ? "Put the crosshair on the object first, then tap its name." + (items.some((x) => x.sun) ? " Never look at the Sun: watch the screen." : "") : "This needs a phone's motion sensors.";
  $("north").hidden = false;
};
function applyFine(x) {
  if (!S.sensors) return;
  const before = { az: F.fineAz, alt: F.fineAlt }, r = F.fineTune(x.az, x.alt);
  if (!r) return;
  if (Math.abs(r.dAz) > 45 || Math.abs(r.dAlt) > 20) {
    F.fineAz = before.az; F.fineAlt = before.alt;
    $("northMsg").textContent = `That is ${Math.round(Math.abs(r.dAz))}° away from where ${x.label} really is. Is the crosshair on it? Try again.`;
    return;
  }
  $("northMsg").textContent = `Fine-tuned on ${x.label}: direction ${r.dAz >= 0 ? "+" : ""}${r.dAz.toFixed(1)}°${x.alt != null ? `, tilt ${r.dAlt >= 0 ? "+" : ""}${r.dAlt.toFixed(1)}°` : ""}.`;
  if (navigator.vibrate) navigator.vibrate(40);
}
$("lmUse").onclick = () => {
  const m = $("lmCoords").value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) { $("northMsg").textContent = "Paste coordinates like 47.6205, -122.3493"; return; }
  const L = loc(); applyFine({ label: "your landmark", az: bearing(L.lat, L.lon, +m[1], +m[2]), alt: null });
};
$("northReset").onclick = () => { F.fineAz = 0; F.fineAlt = 0; $("northMsg").textContent = "Fine-tune cleared."; };
$("northClose").onclick = () => { $("north").hidden = true; };

// ---------- info ----------
$("infoBtn").onclick = () => { $("info").hidden = false; renderInfo(new Date(), loc(), null, Intl.DateTimeFormat().resolvedOptions().timeZone); };
$("infoClose").onclick = () => { $("info").hidden = true; };
function renderInfo(now, L, lst, tz) {
  if (lst == null) lst = ((Sky.gmst(Sky.jd(now)) + L.lon) % 360 + 360) % 360;
  const off = -now.getTimezoneOffset() / 60, ef = earthFacts(now), r = F.result;
  const rows = [
    ["You", `${L.lat.toFixed(4)}°, ${L.lon.toFixed(4)}° · ${S.locNote}${S.place && S.place.city ? ` · ${S.place.city}, ${S.place.region}` : ""}`],
    ["Your time", `${now.toLocaleString()} · ${tz} (UTC${off >= 0 ? "+" : ""}${off})`],
    ["UTC", now.toISOString().replace("T", " ").slice(0, 19)],
    ["Earth's rotation", `local sidereal time ${(lst / 15).toFixed(3)} h`],
    ["Earth's orbit", `${ef.distanceAU.toFixed(4)} AU from the Sun, ${ef.speedKms.toFixed(2)} km/s`],
    ["Magnetic north", `${F.decl >= 0 ? "+" : ""}${F.decl.toFixed(2)}° (WMM2025 at your position)`],
    ["Calibration", F.calibrated ? `${r ? r.quality : "ok"}${r && r.compassScatter != null ? `, compass scatter ±${r.compassScatter.toFixed(1)}°` : ""}${r ? `, table tilt ${r.tiltDeg.toFixed(1)}°` : ""}` : "not done (coarse compass alignment)"],
    ["Fine-tune", `${F.fineAz.toFixed(1)}° direction, ${F.fineAlt.toFixed(1)}° tilt`],
    ["Sensors", `${F.platform}${F.compassAccuracy != null ? `, compass accuracy ±${Math.round(F.compassAccuracy)}°` : ""} · camera ${S.camOn ? `on (${LONG_SIDE_FOV}° lens assumed)` : "off"}`],
  ];
  $("infoRows").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}
