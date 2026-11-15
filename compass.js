/* WANDERERS Sky Compass: landing -> "where are you in the universe" intro -> one-step flat calibration ->
 * augmented-reality sky with a compass tape, tilt scale, mini radar and live telemetry.
 * Motion: orient.js (gyro drives movement, compass sets north). Sky: sky.js. Intro: intro.js (three.js). */
// The intro needs three.js from a CDN: load it on the side, so the compass still works when the CDN cannot be reached.
const introLib = import("./intro.js?v=20261115b").catch((e) => { console.warn("intro unavailable", e); return null; });
let earthFacts = null; introLib.then((m) => { if (m) earthFacts = m.earthFacts; });

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const SEATTLE = { lat: 47.61, lon: -122.33, approx: true };
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const F = new Orient.Fusion();
const S = {
  targets: [], sel: null, loc: null, locNote: "location not shared yet", place: null, cities: null,
  camOn: false, sensors: false, manual: { az: 180, alt: 25 }, vfovNoCam: 60, regionImg: null, lastTele: 0, buzzed: {},
};
window.__wanderers = { F, S };   // debug handle for automated tests (feed sensor events with exact timestamps)

const STARS = [
  ["Polaris", 37.95, 89.26], ["Vega", 279.23, 38.78], ["Arcturus", 213.92, 19.18], ["Capella", 79.17, 46.0],
  ["Sirius", 101.29, -16.72], ["Betelgeuse", 88.79, 7.41], ["Rigel", 78.63, -8.2], ["Aldebaran", 68.98, 16.51],
  ["Altair", 297.7, 8.87], ["Deneb", 310.36, 45.28], ["Spica", 201.3, -11.16], ["Antares", 247.35, -26.43],
  ["Procyon", 114.83, 5.22], ["Pollux", 116.33, 28.03], ["Regulus", 152.09, 11.97], ["Fomalhaut", 344.41, -29.62],
].map(([name, ra, dec]) => ({ name, ra, dec }));
const BODIES = [{ name: "Sun", body: "sun" }, { name: "Moon", body: "moon" }];
// Landmarks for the sight check; h = height of the top above sea level (m)
const LANDMARKS = [
  { name: "Space Needle", lat: 47.6205, lon: -122.3493, h: 215 }, { name: "Columbia Center", lat: 47.6045, lon: -122.3306, h: 320 },
  { name: "Mount Rainier", lat: 46.8529, lon: -121.7604, h: 4392 }, { name: "Mount Baker", lat: 48.7767, lon: -121.8144, h: 3286 },
  { name: "Mt Constance (Olympics)", lat: 47.7726, lon: -123.1293, h: 2369 },
];
// direction and height above the horizon of a landmark's top, from your position (Earth curvature included)
function landmarkAzAlt(l) {
  const L = loc(), dKm = distKm(L.lat, L.lon, l.lat, l.lon), d = dKm * 1000, hUser = S.alt != null ? S.alt : 40;
  const alt = (Math.atan2(l.h - hUser, d) - d / (2 * 6371000)) / D2R;
  return { az: bearing(L.lat, L.lon, l.lat, l.lon), alt, km: dKm };
}

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
  renderTargets(); if (S.sel) $("aboutBtn").hidden = false;
  const wantStar = new URLSearchParams(location.search).get("star");     // e.g. compass.html?star=Sirius from the console
  if (wantStar) StarSearch.load().then(() => { const st = StarSearch.search(wantStar, 1)[0]; if (st) { selectStar(st); $("findIn").value = st.name; } });
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
  window.addEventListener("deviceorientationabsolute", (e) => {   // phones without a gyroscope only have this stream
    F.feed({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true }); S.sensors = S.sensors || e.beta != null;
  }, true);
  if ($("useCam").checked) startCamera();
  locate();
  $("landing").hidden = true; $("cosmos").hidden = false;
  $("skipIntro").onclick = () => $("cosmosStage").skip && $("cosmosStage").skip();
  try {
    const qs = new URLSearchParams(location.search), lib = await introLib;
    if (!lib) throw new Error("three.js could not be loaded");
    await lib.playIntro({ container: $("cosmosStage"), caption: $("cosmosTitle"), sub: $("cosmosSub"), reduced,
      slow: qs.get("intro") === "slow" ? 2.5 : 1,
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
    if (p.coords.altitude != null) S.alt = p.coords.altitude;
    S.locNote = `GPS ±${Math.round(p.coords.accuracy)} m`;
    updateDecl();
    if (first) {
      first = false;
      const c = await nearestCity(S.loc.lat, S.loc.lon);
      S.place = { lat: S.loc.lat, lon: S.loc.lon, ...(c || {}) };
      S.regionPromise = regionImage(S.loc.lat, S.loc.lon);
      placeResolve(S.place);
    }
  }, (err) => {   // also called for a later timeout while a GPS fix is already in use: keep that note then
    if (!S.loc) S.locNote = err && err.code === 1 ? "location declined: using Seattle" : "no GPS fix yet: using Seattle";
    placeResolve(null);
  },
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
  $("calib").hidden = false; $("calDone").hidden = true; $("calSkip").hidden = false; $("calEnough").hidden = true;
  document.querySelectorAll(".stops span").forEach((el) => { el.innerHTML = "<i></i>"; });
  $("calTitle").textContent = "Lay your phone flat on a table";
  F.startFlatCalibration();
  F.onCalibrated = (r) => {
    document.querySelectorAll(".stops i").forEach((el) => (el.style.width = r.stops > [...document.querySelectorAll(".stops i")].indexOf(el) ? "100%" : "0"));
    const sp = r.spread != null ? r.spread.toFixed(1) : "?";
    const msg = {
      good: `Your compass agrees with itself in all 4 directions (within ${sp}°). North is set. If you are inside a steel building, one Sight check on a landmark makes it exact.`,
      fair: `Something nearby bends your compass by up to ${sp}° depending on direction (a magnetic case or wallet, a laptop, a metal desk). We averaged it out, but do a Sight check for best accuracy.`,
      poor: `Strong magnetic interference: your compass is off by up to ${sp}°. Remove magnetic cases or wallets, move away from metal, and recalibrate, or use a Sight check.`,
      partial: `North set from ${r.stops} direction${r.stops > 1 ? "s" : ""} only, so a magnetic case or nearby metal could not be checked. Do a Sight check for best accuracy.`,
      nocompass: "Level set. This phone did not report a compass, so set north with a Sight check on the Moon, a star or a landmark.",
    }[r.quality];
    $("calTitle").textContent = r.quality === "good" ? "✓ Calibrated" : r.quality === "poor" ? "⚠ Calibrated, with interference" : "✓ Calibrated";
    $("calText").textContent = msg;
    $("calDone").hidden = false; $("calSkip").hidden = true; $("calEnough").hidden = true;
    $("phoneIcon").classList.remove("turn");
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
  };
}
$("calDone").onclick = () => { $("calib").hidden = true; };
$("calSkip").onclick = () => { F.cancelCalibration(); $("calib").hidden = true; };
$("calEnough").onclick = () => F.finishCalibrationNow();
$("recalBtn").onclick = () => {   // calibration needs the motion sensors; without them it would wait forever
  if (S.sensors) return showCalibration();
  $("guideSub").textContent = "Calibration needs a phone's motion sensors: open this page on your phone. Here, drag the sky or use the arrow keys.";
};
let lastStops = -1;
function calibrationTick() {
  const c = F.calibrationState();
  if (!c || $("calib").hidden) return;
  const bars = document.querySelectorAll(".stops i");
  bars.forEach((el, i) => (el.style.width = `${Math.max(0, Math.min(1, c.progress * 4 - i)) * 100}%`));
  if (c.stops !== lastStops && c.stops > 0 && navigator.vibrate) navigator.vibrate(30);
  lastStops = c.stops;
  $("calEnough").hidden = c.stops < 1;
  $("phoneIcon").classList.toggle("turn", c.state === "turn");
  const t = {
    tilted: ["Lay your phone flat on a table", "Screen up, hands off, away from laptops and magnets."],
    moving: ["Hold still…", "Take your hand off the phone for a moment."],
    ok: [`Hold still… direction ${c.stops + 1} of 4`, "Reading the compass."],
    turn: [`✓ ${c.stops} of 4. Now give it a quarter turn`, "Rotate the phone about 90° on the table, then let go and hold still."],
  }[c.state] || ["Lay your phone flat on a table", ""];
  $("calTitle").textContent = t[0]; $("calText").textContent = t[1];
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
  S.manual.az = ((drag.az - (e.clientX - drag.x) * k) % 360 + 360) % 360;   // a long drag can pass a full turn
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

  // landmarks (teal): where WANDERERS thinks they are; compare with the real ones for a sight check
  for (const l of LANDMARKS) {
    const a = landmarkAzAlt(l); if (a.km < 0.2 || a.km > 150) continue;
    const q = proj(vec(a.az, a.alt)); if (!q) continue;
    g.strokeStyle = "#3fe0d0"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(q[0], q[1] - 9); g.lineTo(q[0] + 7, q[1]); g.lineTo(q[0], q[1] + 9); g.lineTo(q[0] - 7, q[1]); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(q[0], q[1] + 9); g.lineTo(q[0], q[1] + 26); g.stroke();
    g.font = "600 12px 'Space Grotesk', sans-serif"; g.fillStyle = "#3fe0d0"; g.textAlign = "left";
    g.fillText(`${l.name} · ${a.km < 10 ? a.km.toFixed(1) : Math.round(a.km)} km`, q[0] + 11, q[1] - 2);
  }

  // Webb (JWST) pointings around where you look: small gold squares
  if (S.webbAround && S.webbAround.length) {
    g.font = "600 10px 'JetBrains Mono', monospace"; g.textAlign = "left"; g.textBaseline = "middle";
    for (const w of S.webbAround) {
      const s = Sky.observe({ ra: w.ra, dec: w.dec }, now, L.lat, L.lon), q = proj(vec(s.az, s.alt)); if (!q) continue;
      const hot = S.webbHere && S.webbHere.obs === w.obs;
      g.strokeStyle = s.alt < 0 ? "rgba(255,210,122,.35)" : hot ? "#ffd27a" : "rgba(255,210,122,.75)"; g.lineWidth = hot ? 2 : 1.2;
      g.strokeRect(q[0] - (hot ? 6 : 4), q[1] - (hot ? 6 : 4), hot ? 12 : 8, hot ? 12 : 8);
      if (hot) { g.fillStyle = "#ffd27a"; g.fillText("JWST · " + w.target, q[0] + 10, q[1]); }
    }
  }

  // the selected star's path through the sky: blue behind it, green dashed ahead (the star-path model)
  const selKey = S.sel ? `${S.sel.id}:${S.sel.name}` : "";
  if (selKey !== S.trailFor) {
    S.trailFor = selKey; S.trail = null;
    if (S.sel && window.PathView) PathView.trail(pathQuery(S.sel)).then((tr) => { if (S.trailFor === selKey) S.trail = tr; }).catch(() => {});
  }
  if (S.trail) {
    const pts = S.trail.pts.map((p) => { const o = Sky.observe(p, now, L.lat, L.lon); return { year: p.year, q: proj(vec(o.az, o.alt)) }; });
    const seg = (arr, style, dash) => { g.strokeStyle = style; g.lineWidth = 2; g.setLineDash(dash); g.beginPath(); let on = false;
      for (const p of arr) { if (!p.q) { on = false; continue; } on ? g.lineTo(p.q[0], p.q[1]) : g.moveTo(p.q[0], p.q[1]); on = true; } g.stroke(); g.setLineDash([]); };
    seg(pts.filter((p) => p.year <= S.trail.now), "rgba(124,196,255,.9)", []);
    seg(pts.filter((p) => p.year >= S.trail.now), "rgba(126,231,135,.9)", [7, 5]);
    g.font = "600 11px 'JetBrains Mono', monospace"; g.textAlign = "left"; g.textBaseline = "middle";
    const boxes = [];   // thin the labels: a year whose text would overlap one already drawn is left out (its dot stays)
    const lab = (p, txt, col) => {
      if (!p || !p.q) return;
      g.fillStyle = col; g.beginPath(); g.arc(p.q[0], p.q[1], 3, 0, 7); g.fill();
      const b = [p.q[0] + 6, p.q[1] - 8, g.measureText(txt).width, 16];
      if (boxes.some((o) => b[0] < o[0] + o[2] + 4 && o[0] < b[0] + b[2] + 4 && b[1] < o[1] + o[3] && o[1] < b[1] + b[3])) return;
      boxes.push(b); g.fillText(txt, p.q[0] + 6, p.q[1]);
    };
    const h = S.trail.half, yrTxt = (y) => (y <= 0 ? `${Math.round(1 - y).toLocaleString()} BCE` : `${Math.round(y)} CE`);
    lab(pts[0], yrTxt(pts[0].year), "#7cc4ff"); lab(pts.at(-1), yrTxt(pts.at(-1).year), "#7ee787");
    lab(pts[Math.round(pts.length / 4)], yrTxt(pts[Math.round(pts.length / 4)].year), "#7cc4ff");
    lab(pts[Math.round(3 * pts.length / 4)], yrTxt(pts[Math.round(3 * pts.length / 4)].year), "#7ee787");
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

  // centre reticle (big and gold while aiming for a sight check)
  if (S.aim) {
    g.strokeStyle = "#ffb547"; g.lineWidth = 2.5;
    g.beginPath(); g.arc(cx, cy, 34, 0, 7); g.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.beginPath(); g.moveTo(cx + dx * 12, cy + dy * 12); g.lineTo(cx + dx * 70, cy + dy * 70); g.stroke(); }
    g.font = "700 13px 'Space Grotesk', sans-serif"; g.textAlign = "center"; g.fillStyle = "#ffb547";
    g.fillText(S.aim.dir ? `camera → ${S.aim.dir}` : `put ${S.aim.label} here`, cx, cy - 82);
  }
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
    inv.hidden = false;
    if (T.found) { inv.textContent = "About this star →"; inv.removeAttribute("href"); inv.onclick = () => showDetails(T); }
    else { inv.textContent = "Investigate →"; inv.href = `observatory.html?target=${T.id}`; inv.onclick = null; }
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
  const cal = F.compassFrozen ? "SIGHT ✓" : F.calibrated ? (F.result ? F.result.quality.toUpperCase() : "OK") : S.sensors ? "NOT CALIBRATED" : "DRAG MODE";
  $("telemetry").innerHTML = [
    ["LAT", `${Math.abs(L.lat).toFixed(3)}°${L.lat >= 0 ? "N" : "S"}`], ["LON", `${Math.abs(L.lon).toFixed(3)}°${L.lon >= 0 ? "E" : "W"}`],
    ["LOCAL", `${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${tz.split("/").pop().replace(/_/g, " ")}`],
    ["UTC", now.toISOString().slice(11, 19)], ["LST", hm(lst)], ["DECL", `${F.decl >= 0 ? "+" : ""}${F.decl.toFixed(1)}°`], ["CAL", cal],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join("");
  if (!$("info").hidden) renderInfo(now, L, lst, tz);
  webbTick(P, now, L, lst);
}

// ---------- Webb (JWST): which telescope frames are where the phone points ----------
// crosshair direction -> J2000 RA/Dec (inverse of Sky.observe, refraction ignored: under 0.5 deg above 10 deg)
function crosshairRaDec(P, now, L, lst) {
  const la = L.lat * D2R, al = P.alt * D2R, az = P.az * D2R;
  const dec = Math.asin(Math.sin(la) * Math.sin(al) + Math.cos(la) * Math.cos(al) * Math.cos(az)) / D2R;
  const H = Math.atan2(-Math.sin(az) * Math.cos(al), Math.cos(la) * Math.sin(al) - Math.sin(la) * Math.cos(al) * Math.cos(az)) / D2R;
  const ra = ((lst - H) % 360 + 360) % 360;
  return Sky.unprecess(ra, dec, Sky.jd(now));   // undo precession exactly (catalogue frames are J2000)
}
let webbReady = null;
function webbTick(P, now, L, lst) {
  if (!webbReady) webbReady = Webb.load().catch(() => null);
  if (!window.Webb || !Webb.near || !P) return;
  const c = crosshairRaDec(P, now, L, lst);
  S.crosshair = c;
  S.webbAround = Webb.near(c.ra, c.dec, 40, 80);
  // The chip must not change under your finger: keep the frame it shows until you move clearly away (4.5 deg),
  // and when choosing a new one inside the crosshair (3 deg), prefer frames with a real Webb image and a real name.
  // (measured directly: in crowded fields such as COSMOS, 500+ frames lie within 4.5 deg, far more than the 60 listed)
  const cands = Webb.near(c.ra, c.dec, 4.5, 60);
  let here = S.webbHere && Webb.sep(c.ra, c.dec, S.webbHere.ra, S.webbHere.dec) <= 4.5 ? S.webbHere : null;
  if (!here) {
    const inside = cands.filter((p) => p.dist <= 3);
    here = inside.sort((a, b) => Webb.appeal(a, a.dist) - Webb.appeal(b, b.dist))[0] || null;
  }
  S.webbHere = here || null;
  const chip = $("webbChip");
  if (here) {
    const key = here.obs + (P.alt < 0 ? "-" : "+");
    if (chip.dataset.key !== key || chip.hidden) {
      const pix = { preview: "Webb image", live: "Webb image", outline: "frame outline" }[Webb.source(here)];
      chip.innerHTML = `🔭 Webb looked here: ${Webb.esc(Webb.name(here))}<span>${Webb.esc(here.inst)} · ${Webb.dateOf(here.mjd).slice(0, 4)} · ` +
        `${P.alt < 0 ? "below your horizon · " : ""}${pix} · tap to see it</span>`;
      chip.dataset.key = key; chip.hidden = false;
    }
  } else { chip.hidden = true; chip.dataset.key = ""; }
}
$("webbChip").onclick = () => { const h = S.webbHere; if (h) openWebb(h.ra, h.dec, Webb.name(h), null, h); };

// details sheet: did Webb image this star?
async function webbDetails(st) {
  const box = $("dWebb"); box.hidden = true;
  try { await Webb.load(); } catch { return; }
  const f = Webb.framesAt(st.ra, st.dec);
  if (f.length) {
    const inst = [...new Set(f.map((p) => p.inst))].join(", "), yrs = [...new Set(f.map((p) => Webb.dateOf(p.mjd).slice(0, 4)))].sort().join(", ");
    box.innerHTML = `<b>🔭 Webb has imaged this spot</b> in ${f.length} frame${f.length > 1 ? "s" : ""} (${Webb.esc(inst)}; ${yrs}).
      <br><button class="btn" id="dWebbGo">See it through Webb</button>`;
  } else {
    const n = Webb.near(st.ra, st.dec, 3, 1)[0];
    box.innerHTML = n ? `<b>🔭 Webb has not imaged this star.</b> Its nearest Webb frame, “${Webb.esc(Webb.name(n))}”, is ${n.dist.toFixed(2)}° away.
      <br><button class="btn" id="dWebbGo">Show the nearest Webb frame</button>`
      : `<b>🔭 Webb has not imaged this part of the sky</b> (no public Webb image within 3°).`;
    if (n) f.push(n);
  }
  box.hidden = false;
  const go = box.querySelector("button"); if (go) go.onclick = () => openWebb(st.ra, st.dec, st.name, f.length && Webb.framesAt(st.ra, st.dec).length ? f : null, f[0]);
}

// the Webb viewer sheet
async function openWebb(ra, dec, label, frames, focus) {
  await Webb.load();
  // every frame overlapping the spot we show (the star, or the centre of the chosen frame)
  const contains = frames && frames.length;
  const cRa = contains ? ra : focus.ra, cDec = contains ? dec : focus.dec;
  let list = Webb.best(contains ? frames : Webb.framesAt(focus.ra, focus.dec));
  if (!list.length) list = [focus];
  const sel = contains ? list[0] : list.find((p) => p.obs === focus.obs) || list[0];
  list = [sel, ...list.filter((p) => p !== sel)];
  $("details").hidden = true; $("webb").hidden = false;
  $("wTitle").textContent = contains ? `${label} through Webb` : `Webb frame: ${Webb.name(focus)}`;
  $("wSub").textContent = contains ? `RA ${StarSearch.hms(ra)}  Dec ${StarSearch.dms(dec)} · the red cross is ${label}; the gold outline is the Webb frame shown`
    : `${label && label !== Webb.name(focus) ? `${label} is ${Webb.sep(ra, dec, focus.ra, focus.dec).toFixed(2)}° away. ` : ""}Frame centre RA ${StarSearch.hms(focus.ra)}  Dec ${StarSearch.dms(focus.dec)}`;
  $("wCount").textContent = `${(await Webb.load()).count.toLocaleString()} frames`;
  const path = contains && S.sel && window.PathView ? await PathView.sky(pathQuery(S.sel)).catch(() => null) : null;
  const show = async (p) => {
    $("wFrames").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.obs === p.obs));
    const d = Webb.describe(p);
    // the red cross goes where the star was when Webb took this frame (catalogue positions are for 2000 or 2016)
    const then = p.mjd ? pathAt(path, 2000 + (p.mjd - 51544.5) / 365.25) : null;
    $("wNote").innerHTML = `<b>${Webb.esc(d.title)}</b><br>${Webb.esc(d.line)}` + ({ preview: "<br>Showing Webb's own image of this frame (MAST preview, placed on the sky with its WCS).",
       live: "<br>Showing ESA ESASky's live Webb map: zoom in for full resolution.",
       outline: `<br><span class="warn">No Webb pixels can be streamed for this frame yet, so the gold outline shows exactly where Webb looked.
       Open the full Webb image below.</span>` })[Webb.source(p)] +
      (then ? `<br>The red cross is ${Webb.esc(label)} on ${Webb.dateOf(p.mjd)}, moved from its catalogue position by its known motion.` : "") +
      `<div class="webb-links"><a href="${Webb.full(p)}" target="_blank" rel="noopener">Full Webb image (large) ↗</a>
       <a href="${Webb.progUrl(p)}" target="_blank" rel="noopener">Programme ${Webb.esc(p.pid)} at STScI ↗</a></div>`;
    try {
      await Webb.render($("wView"), contains ? ra : p.ra, contains ? dec : p.dec, [p, ...list.filter((x) => x !== p)],
        { label, mark: then || { ra, dec }, path, base: $("wBase").value, webbOpacity: +$("wOpacity").value });   // path: drawn when the star is in the frame
    } catch (e) { $("wView").innerHTML = `<p class="small warn" style="padding:12px">Sky viewer could not load: ${Webb.esc(e.message)}</p>`; }
  };
  $("wFrames").innerHTML = list.slice(0, 12).map((p) => {
    const d = Webb.describe(p);
    return `<button data-obs="${Webb.esc(p.obs)}"><img loading="lazy" alt="" src="${Webb.thumb(p)}"><div>${Webb.esc(d.title)}<span>${Webb.esc(d.line)}</span></div></button>`;
  }).join("");
  $("wFrames").querySelectorAll("button").forEach((b) => (b.onclick = () => show(list.find((p) => p.obs === b.dataset.obs))));
  show(sel);
}
$("wClose").onclick = () => { $("webb").hidden = true; };
$("wOpacity").oninput = (e) => Webb.setOpacity(+e.target.value);
$("wBase").onchange = (e) => Webb.setBase(e.target.value);

// ---------- targets ----------
// ---------- find any star ----------
StarSearch.attach($("findIn"), $("findList"), (star) => { $("findIn").blur(); selectStar(star); });
function selectStar(star) {
  let t = star.wanderers && S.targets.find((x) => x.id === star.wanderers);
  if (!t) {
    S.targets = S.targets.filter((x) => !x.found);           // keep one searched star at a time
    t = { id: "found", found: true, name: star.name, ra: star.ra, dec: star.dec, teaser: "your search", star };
    S.targets.unshift(t);
  } else t.star = star;
  S.sel = t; renderTargets(); $("aboutBtn").hidden = false;
  const u = new URL(location); u.searchParams.set("target", star.wanderers || "found"); u.searchParams.set("star", star.name); history.replaceState(null, "", u);
}
function showDetails(T) {
  const st = T.star || { name: T.name, alt: [], ra: T.ra, dec: T.dec, wanderers: T.id };
  $("dTag").textContent = st.wanderers ? "WANDERERS TARGET" : "STAR";
  $("dName").textContent = st.name;
  $("dAlt").textContent = (st.alt || []).slice(0, 4).join(" · ");
  const facts = st.spect || st.mag != null ? StarSearch.describe(st) : ["One of the WANDERERS test targets: open the full analysis for its motion, spectrum and brightness change."];
  $("dFacts").innerHTML = facts.map((f) => `<li>${f}</li>`).join("");
  $("dWhere").textContent = `RA ${StarSearch.hms(st.ra)}  Dec ${StarSearch.dms(st.dec)}` + (T._alt != null ? ` · right now ${compassPt(T._az)} ${Math.round(T._az)}°, ${T._alt >= 0 ? `${Math.round(T._alt)}° above` : `${Math.abs(Math.round(T._alt))}° below`} your horizon` : "");
  $("dMap").href = `observatory.html?ra=${st.ra.toFixed(5)}&dec=${st.dec.toFixed(5)}`;
  $("dFull").hidden = !st.wanderers; if (st.wanderers) $("dFull").href = `observatory.html?target=${st.wanderers}`;
  $("details").hidden = false;
  webbDetails(st);
  if (window.PathView) PathView.render($("dPathBody"), pathQuery(T), { explorerHref: (k) => `observatory.html?star=${encodeURIComponent(k)}` });
}
// which star the path model should use: a prepared target by id, else the star found by name
function pathQuery(T) { return T.star && !T.star.wanderers ? { star: T.star } : { target: (T.star && T.star.wanderers) || T.id }; }
// position on a PathView.sky() path at a decimal year (linear between its points); null when no path is known
function pathAt(path, year) {
  const P = path && path.pts;
  if (!P || P.length < 2 || !Number.isFinite(year)) return null;
  let i = P.findIndex((q) => q.year >= year);
  i = i < 0 ? P.length - 1 : Math.max(1, i);
  const a = P[i - 1], b = P[i], k = (year - a.year) / (b.year - a.year);
  return { ra: (a.ra + (((b.ra - a.ra + 540) % 360) - 180) * k + 360) % 360, dec: a.dec + (b.dec - a.dec) * k };
}
$("aboutBtn").onclick = () => S.sel && showDetails(S.sel);
$("dClose").onclick = () => { $("details").hidden = true; };

function renderTargets() {
  $("targets").innerHTML = S.targets.map((t) =>
    `<button data-id="${t.id}" class="${S.sel && S.sel.id === t.id ? "on" : ""}" role="option"><b>${t.name}</b><span id="tp_${t.id}">${t.teaser}</span></button>`).join("");
  $("targets").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    S.sel = S.targets.find((t) => t.id === b.dataset.id); renderTargets(); $("aboutBtn").hidden = false;
    const u = new URL(location); u.searchParams.set("target", S.sel.id);
    if (S.sel.found) u.searchParams.set("star", S.sel.name); else u.searchParams.delete("star");   // no stale ?star=
    history.replaceState(null, "", u);
  }));
}

// ---------- North check (fine-tune on something you can see) ----------
$("northBtn").onclick = () => {
  const now = new Date(), L = loc();
  const sky = [...BODIES, ...STARS].map((o) => ({ o, p: Sky.observe(o, now, L.lat, L.lon) })).filter((x) => x.p.alt > 3)
    .sort((a, b) => (b.o.body ? 1 : 0) - (a.o.body ? 1 : 0) || b.p.alt - a.p.alt).slice(0, 8);
  const lms = LANDMARKS.map((l) => ({ ...l, ...landmarkAzAlt(l) })).filter((l) => l.km > 0.2 && l.km < 150).sort((a, b) => a.km - b.km);
  const items = [
    ...sky.map((x) => ({ label: x.o.name, sub: `${compassPt(x.p.az)} · ${Math.round(x.p.alt)}° up`, az: x.p.az, alt: x.p.alt, sun: x.o.body === "sun" })),
    ...lms.map((l) => ({ label: l.name, sub: `${compassPt(l.az)} · ${l.km < 10 ? l.km.toFixed(1) : Math.round(l.km)} km`, az: l.az, alt: null, landmark: true, top: true })),
  ];
  $("northList").innerHTML = items.map((x, i) => `<button data-i="${i}">${x.label}<span>${x.sub}</span></button>`).join("") ||
    "<p class='small dim'>Nothing bright is up right now. Use a landmark or paste map coordinates below.</p>";
  $("northList").querySelectorAll("button").forEach((b) => (b.onclick = () => startAim(items[+b.dataset.i])));
  $("northMsg").textContent = S.sensors ? "Tap what you can see. Then you aim the crosshair at it and tap Calibrate." + (items.some((x) => x.sun) ? " Never look at the Sun: watch the screen." : "") : "This needs a phone's motion sensors.";
  $("north").hidden = false;
};
// Aim mode: the sheet closes, a big gold crosshair asks you to put it on the real object, and nothing changes
// until you tap Calibrate (then applyFine). Cancel leaves north as it was.
function startAim(x) {
  clearTimeout(S.aimDone); $("aimCancel").hidden = false;
  S.aim = x; $("north").hidden = true; $("aimBar").hidden = false; document.body.classList.add("aiming");
  $("aimTitle").textContent = x.dir ? `Point the camera ${x.dir}` : `Aim at ${x.label}`;
  $("aimText").textContent = x.dir ? `Hold the phone upright with the camera facing exactly ${x.dir} (along a street or wall you know), then tap Calibrate.`
    : `Move the phone until the big gold crosshair sits on ${x.top ? `the top of ${x.label}` : x.label} in the camera view, then tap Calibrate.` +
      (x.landmark ? " Ignore the teal marker: it shows where the app currently thinks it is." : "") + (x.sun ? " Never look at the Sun directly: watch the screen." : "");
  $("aimMsg").textContent = S.sensors ? "" : "This needs a phone's motion sensors (open this page on your phone).";
  $("aimMsg").className = "small"; $("aimGo").disabled = false; $("aimGo").textContent = "Calibrate";
}
function endAim() { clearTimeout(S.aimDone); S.aim = null; $("aimBar").hidden = true; $("aimCancel").hidden = false; document.body.classList.remove("aiming"); }
$("aimCancel").onclick = endAim;
$("aimGo").onclick = () => {
  if (!S.aim) return endAim();
  if ($("aimGo").textContent === "Done") return endAim();
  const ok = applyFine(S.aim, $("aimMsg"));
  $("aimMsg").className = "small " + (ok ? "ok" : "warn");
  if (ok) { $("aimGo").textContent = "Done"; $("aimCancel").hidden = true; S.aimDone = setTimeout(endAim, 4000); }
};
function applyFine(x, out = $("northMsg")) {
  if (!S.sensors) { out.textContent = "This needs a phone's motion sensors (open this page on your phone)."; return false; }
  const before = { az: F.fineAz, alt: F.fineAlt, frozen: F.compassFrozen }, r = F.fineTune(x.az, x.alt);
  if (!r) { out.textContent = "The motion sensors are not ready yet. Hold still a moment and try again."; return false; }
  if (Math.abs(r.dAlt) > 20) {
    F.fineAz = before.az; F.fineAlt = before.alt; F.compassFrozen = before.frozen;   // a rejected aim changes nothing
    out.textContent = `That is ${Math.round(Math.abs(r.dAlt))}° higher or lower than ${x.label} really is. Is the crosshair on it? Aim again and tap Calibrate.`;
    return false;
  }
  const big = Math.abs(r.dAz) > 30 ? ` Your compass was ${Math.round(Math.abs(r.dAz))}° off; it is now ignored.` : "";
  out.textContent = `Calibrated on ${x.label}: north corrected ${r.dAz >= 0 ? "+" : ""}${r.dAz.toFixed(1)}°` +
    `${x.alt != null ? `, tilt ${r.dAlt >= 0 ? "+" : ""}${r.dAlt.toFixed(1)}°` : ""}.${big} The gyroscope now keeps north.`;
  if (navigator.vibrate) navigator.vibrate(40);
  if (out !== $("northMsg")) $("northMsg").textContent = out.textContent;
  return true;
}
// "This is North / East / South / West": the camera is facing a known true direction (no compass needed)
document.querySelectorAll(".dirs button").forEach((b) => (b.onclick = () => {
  const az = +b.dataset.az;
  const dir = ["north", "east", "south", "west"][az / 90];
  startAim({ label: `you facing ${dir}`, dir, az, alt: null });
}));
$("lmUse").onclick = () => {
  const m = $("lmCoords").value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) { $("northMsg").textContent = "Paste coordinates like 47.6205, -122.3493"; return; }
  const L = loc(); startAim({ label: "your landmark", landmark: true, az: bearing(L.lat, L.lon, +m[1], +m[2]), alt: null });
};
$("northReset").onclick = () => { F.clearFineTune(); $("northMsg").textContent = "Sight check cleared: back to the compass."; };
$("northClose").onclick = () => { $("north").hidden = true; };

// ---------- info ----------
$("infoBtn").onclick = () => { $("info").hidden = false; renderInfo(new Date(), loc(), null, Intl.DateTimeFormat().resolvedOptions().timeZone); };
$("infoClose").onclick = () => { $("info").hidden = true; };
function renderInfo(now, L, lst, tz) {
  if (lst == null) lst = ((Sky.gmst(Sky.jd(now)) + L.lon) % 360 + 360) % 360;
  const off = -now.getTimezoneOffset() / 60, ef = earthFacts ? earthFacts(now) : null, r = F.result;
  const rows = [
    ["You", `${L.lat.toFixed(4)}°, ${L.lon.toFixed(4)}° · ${S.locNote}${S.place && S.place.city ? ` · ${S.place.city}, ${S.place.region}` : ""}`],
    ["Your time", `${now.toLocaleString()} · ${tz} (UTC${off >= 0 ? "+" : ""}${off})`],
    ["UTC", now.toISOString().replace("T", " ").slice(0, 19)],
    ["Earth's rotation", `local sidereal time ${(lst / 15).toFixed(3)} h`],
    ["Earth's orbit", ef ? `${ef.distanceAU.toFixed(4)} AU from the Sun, ${ef.speedKms.toFixed(2)} km/s` : "not available offline"],
    ["Magnetic north", `${F.decl >= 0 ? "+" : ""}${F.decl.toFixed(2)}° (WMM2025 at your position)`],
    ["Calibration", F.calibrated ? `${r ? r.quality : "ok"}${r ? `, ${r.stops} direction(s)` : ""}${r && r.spread != null ? `, compass disagreement ${r.spread.toFixed(1)}°` : ""}${r ? `, table tilt ${r.tiltDeg.toFixed(1)}°` : ""}` : "not done (coarse compass alignment)"],
    ["Sight check", F.compassFrozen ? `applied: ${F.fineAz.toFixed(1)}° direction, ${F.fineAlt.toFixed(1)}° tilt (compass no longer used)` : "not done"],
    ["Sensors", `${F.platform}${F.compassAccuracy != null ? `, compass accuracy ±${Math.round(F.compassAccuracy)}°` : ""} · camera ${S.camOn ? `on (${LONG_SIDE_FOV}° lens assumed)` : "off"}`],
  ];
  $("infoRows").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}
