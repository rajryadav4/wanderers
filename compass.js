/* WANDERERS Sky Compass.
 * Where the phone points: back-camera direction from DeviceOrientation (alpha/beta/gamma, W3C Z-X'-Y''
 * Euler angles) plus a compass heading (absolute alpha on Android, webkitCompassHeading on iOS), which
 * is MAGNETIC. True azimuth = magnetic + declination (WMM2025 at your GPS position) + your calibration.
 * Where things are: sky.js (UTC time, sidereal time, precession, Sun/Moon, refraction).
 * Everything runs on the phone. Without motion sensors (desktop) you drag the radar instead. */
(() => {
  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const FOV = 60, LOCK = 12;
  const SEATTLE = { lat: 47.61, lon: -122.33, acc: null };

  // Bright reference objects (J2000 RA/Dec, degrees). Also used for calibration.
  const STARS = [
    ["Polaris", 37.95, 89.26], ["Vega", 279.23, 38.78], ["Arcturus", 213.92, 19.18], ["Capella", 79.17, 46.00],
    ["Sirius", 101.29, -16.72], ["Betelgeuse", 88.79, 7.41], ["Rigel", 78.63, -8.20], ["Aldebaran", 68.98, 16.51],
    ["Altair", 297.70, 8.87], ["Deneb", 310.36, 45.28], ["Spica", 201.30, -11.16], ["Antares", 247.35, -26.43],
    ["Procyon", 114.83, 5.22], ["Pollux", 116.33, 28.03], ["Regulus", 152.09, 11.97], ["Fomalhaut", 344.41, -29.62],
  ].map(([name, ra, dec]) => ({ name, ra, dec }));
  const BODIES = [{ name: "Moon", body: "moon" }, { name: "Sun", body: "sun" }];
  // Landmarks for cloud-proof direction calibration (shown when within 150 km of you).
  const LANDMARKS = [
    { name: "Space Needle", lat: 47.6205, lon: -122.3493 }, { name: "Mount Rainier", lat: 46.8529, lon: -121.7604 },
    { name: "Columbia Center", lat: 47.6045, lon: -122.3306 }, { name: "Mount Baker", lat: 48.7767, lon: -121.8144 },
    { name: "Olympic Mtns (Mt Constance)", lat: 47.7726, lon: -123.1293 },
  ];
  function bearing(lat1, lon1, lat2, lon2) {          // great-circle initial bearing, degrees from true north
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) * R2D) + 360) % 360;
  }
  function distKm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };

  const S = {
    targets: [], sel: null, loc: null, locNote: "", az: 0, alt: 20, rawAz: 0, rawAlt: 20,
    haveSensor: false, source: "none", accuracy: null, smooth: null,
    autoDecl: load("wanderers.autoDecl", true), extra: load("wanderers.extra", 0), cal: load("wanderers.cal", null),
    calTarget: null,
  };

  const vec = (az, alt) => [Math.sin(az * D2R) * Math.cos(alt * D2R), Math.cos(az * D2R) * Math.cos(alt * D2R), Math.sin(alt * D2R)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((x) => x / n); };
  const sep = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
  const wrap180 = (x) => ((x + 540) % 360) - 180;
  const compass = (az) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
  const fmtSigned = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}°`;

  // ---------- corrections ----------
  function declination() {
    if (!S.autoDecl) return 0;
    const loc = S.loc || SEATTLE, d = Sky.declination(loc.lat, loc.lon);
    return d == null ? 0 : d;
  }
  function applyCorrections() {
    const azOff = declination() + S.extra + (S.cal ? S.cal.dAz : 0);
    S.az = (S.rawAz + azOff + 360) % 360;
    S.alt = Math.max(-90, Math.min(90, S.rawAlt + (S.cal ? S.cal.dAlt : 0)));
  }

  // ---------- phone orientation ----------
  function cameraAzAlt(alpha, beta, gamma) {
    const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    const E = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
    const N = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
    const U = -Math.cos(b) * Math.cos(g);
    return { az: ((Math.atan2(E, N) * R2D) + 360) % 360, alt: Math.asin(Math.max(-1, Math.min(1, U))) * R2D };
  }
  function onOrient(e, absolute) {
    if (e.beta == null) return;
    let alpha = null;
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      alpha = 360 - e.webkitCompassHeading; S.source = "iOS compass (magnetic)";
      if (typeof e.webkitCompassAccuracy === "number" && e.webkitCompassAccuracy >= 0) S.accuracy = e.webkitCompassAccuracy;
    } else if (absolute || e.absolute) {
      alpha = e.alpha; S.source = "Android absolute orientation (magnetic)";
    } else if (S.source === "none" || S.source.startsWith("relative")) {
      alpha = e.alpha; S.source = "relative only (no compass): calibrate before use";
    } else return;
    if (alpha == null) return;
    const c = cameraAzAlt(alpha, e.beta, e.gamma || 0);
    if (!S.smooth) S.smooth = { x: Math.sin(c.az * D2R), y: Math.cos(c.az * D2R), alt: c.alt };
    const k = 0.25;
    S.smooth.x += k * (Math.sin(c.az * D2R) - S.smooth.x);
    S.smooth.y += k * (Math.cos(c.az * D2R) - S.smooth.y);
    S.smooth.alt += k * (c.alt - S.smooth.alt);
    S.rawAz = ((Math.atan2(S.smooth.x, S.smooth.y) * R2D) + 360) % 360;
    S.rawAlt = S.smooth.alt;
    S.haveSensor = true;
  }

  // ---------- start ----------
  Sky.loadDeclination("data/declination.json");
  fetch("data/index.json").then((r) => r.json()).then((list) => {
    S.targets = list;
    const want = new URLSearchParams(location.search).get("target");
    S.sel = list.find((t) => t.id === want) || null;
    renderTargets();
  });

  $("start").onclick = async () => {
    $("introMsg").textContent = "";
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") $("introMsg").textContent = "Motion access was declined, so you can drag the radar instead.";
      }
    } catch (err) { $("introMsg").textContent = "Motion access is not available here: " + err.message; }
    window.addEventListener("deviceorientationabsolute", (e) => onOrient(e, true), true);
    window.addEventListener("deviceorientation", (e) => onOrient(e, false), true);
    if ($("useCam").checked) startCamera();
    locate();
    $("intro").hidden = true; $("hud").hidden = false; fit();
    setTimeout(() => { if (!S.haveSensor) S.source = "drag to aim (no motion sensors)"; }, 2500);
    requestAnimationFrame(loop);
  };

  async function startCamera() {
    if (!navigator.mediaDevices || $("cam").srcObject) return;
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      $("cam").srcObject = st; $("cam").hidden = false;
    } catch { /* optional */ }
  }

  function locate() {
    S.loc = SEATTLE; S.locNote = "using Seattle until GPS answers";
    if (!navigator.geolocation) { S.locNote = "no GPS, using Seattle"; return; }
    navigator.geolocation.watchPosition(
      (p) => { S.loc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; S.locNote = `GPS ±${Math.round(p.coords.accuracy)} m`; },
      () => { S.locNote = "location declined, using Seattle"; },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  // ---------- drag to aim (desktop / no sensors) ----------
  let drag = null;
  $("radar").addEventListener("pointerdown", (e) => { if (!S.haveSensor) { drag = { x: e.clientX, y: e.clientY, az: S.rawAz, alt: S.rawAlt }; $("radar").setPointerCapture(e.pointerId); } });
  $("radar").addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = 120 / $("radar").clientWidth;
    S.rawAz = (drag.az - (e.clientX - drag.x) * k + 360) % 360;
    S.rawAlt = Math.max(-89, Math.min(89, drag.alt + (e.clientY - drag.y) * k));
  });
  $("radar").addEventListener("pointerup", () => (drag = null));
  window.addEventListener("keydown", (e) => {
    if (S.haveSensor || e.target.tagName === "INPUT") return;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") S.rawAz = (S.rawAz - step + 360) % 360;
    if (e.key === "ArrowRight") S.rawAz = (S.rawAz + step) % 360;
    if (e.key === "ArrowUp") S.rawAlt = Math.min(89, S.rawAlt + step);
    if (e.key === "ArrowDown") S.rawAlt = Math.max(-89, S.rawAlt - step);
  });

  // ---------- targets ----------
  function renderTargets() {
    $("targets").innerHTML = S.targets.map((t) =>
      `<button data-id="${t.id}" class="${S.sel && S.sel.id === t.id ? "on" : ""}" role="option"><b>${t.name}</b><span id="tp_${t.id}">${t.teaser}</span></button>`).join("");
    $("targets").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      S.sel = S.targets.find((t) => t.id === b.dataset.id); renderTargets();
      const u = new URL(location); u.searchParams.set("target", S.sel.id); history.replaceState(null, "", u);
    }));
  }

  // ---------- calibration ----------
  $("calBtn").onclick = () => { openCal(); };
  $("closeCal").onclick = () => { $("cal").hidden = true; S.calTarget = null; };
  $("autoDecl").checked = S.autoDecl;
  $("autoDecl").onchange = (e) => { S.autoDecl = e.target.checked; store("wanderers.autoDecl", S.autoDecl); };
  $("extra").value = S.extra;
  $("extra").oninput = (e) => { S.extra = +e.target.value; store("wanderers.extra", S.extra); };
  $("resetCal").onclick = () => { S.cal = null; store("wanderers.cal"); S.extra = 0; $("extra").value = 0; store("wanderers.extra", 0); $("calResult").textContent = "Calibration cleared."; };

  function openCal() {
    $("cal").hidden = false;
    renderLandmarks();
    const now = new Date(), loc = S.loc || SEATTLE;
    const up = [...BODIES, ...STARS].map((o) => ({ o, p: Sky.observe(o, now, loc.lat, loc.lon) }))
      .filter((x) => x.p.alt > 3).sort((a, b) => (a.o.body ? -1 : 0) - (b.o.body ? -1 : 0) || b.p.alt - a.p.alt).slice(0, 8);
    $("calList").innerHTML = up.length ? up.map((x, i) => `<button data-i="${i}">${x.o.name}<span>${compass(x.p.az)} · ${Math.round(x.p.alt)}° up</span></button>`).join("")
      : "<p class='small'>Nothing bright is above your horizon right now. Use the slider below instead.</p>";
    $("calList").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      S.calTarget = up[+b.dataset.i].o;
      $("calList").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      $("calStep").hidden = false;
      $("calStepText").textContent = S.calTarget.body === "sun"
        ? "Do not look at the Sun. Hold the phone so its camera faces the Sun (watch the screen, not the sky), centre the Sun in the circle, then tap."
        : `Put ${S.calTarget.name} in the centre circle of the camera view, hold still, then tap.`;
      if (!$("cam").srcObject) startCamera();
    }));
  }
  $("calConfirm").onclick = () => {
    if (!S.calTarget) return;
    const loc = S.loc || SEATTLE, truth = Sky.observe(S.calTarget, new Date(), loc.lat, loc.lon);
    // what the phone reports after declination + manual slider, before any old calibration
    const azBefore = (S.rawAz + declination() + S.extra + 360) % 360;
    const dAz = wrap180(truth.az - azBefore), dAlt = truth.alt - S.rawAlt;
    if (Math.abs(dAz) > 45 || Math.abs(dAlt) > 25) {
      $("calResult").textContent = `That is ${Math.round(Math.abs(dAz))}° / ${Math.round(Math.abs(dAlt))}° away from where ${S.calTarget.name} really is. ` +
        "Check you picked the right object, wave the phone in a figure 8 to reset its compass, and try again.";
      return;
    }
    S.cal = { dAz, dAlt, with: S.calTarget.name, at: new Date().toISOString() };
    store("wanderers.cal", S.cal);
    $("calResult").textContent = `Calibrated on ${S.calTarget.name}: direction ${fmtSigned(dAz)}, tilt ${fmtSigned(dAlt)}. ` +
      "Re-calibrate if you move to a different room or the phone case has magnets.";
  };

  // ---------- cloud-proof calibration ----------
  $("calWall").onclick = () => {
    // Back of the phone on a vertical wall: the camera points exactly horizontally (altitude 0).
    if (!S.haveSensor) { $("calResult2").textContent = "This needs the phone's motion sensors."; return; }
    const dAlt = 0 - S.rawAlt;
    if (Math.abs(dAlt) > 15) { $("calResult2").textContent = `The phone reads ${Math.round(S.rawAlt)}°, too far from level. Press it flat against the wall and try again.`; return; }
    S.cal = { dAz: S.cal ? S.cal.dAz : 0, dAlt, with: (S.cal && S.cal.with ? S.cal.with + " + " : "") + "wall" };
    store("wanderers.cal", S.cal);
    $("calResult2").textContent = `Tilt calibrated: ${fmtSigned(dAlt)}.`;
  };
  let lmPick = null;
  function renderLandmarks() {
    const loc = S.loc || SEATTLE;
    const near = LANDMARKS.map((l) => ({ ...l, km: distKm(loc.lat, loc.lon, l.lat, l.lon) })).filter((l) => l.km < 150 && l.km > 0.2)
      .sort((a, b) => a.km - b.km);
    $("landmarks").innerHTML = near.map((l, i) => `<button data-i="${i}">${l.name}<span>${compass(bearing(loc.lat, loc.lon, l.lat, l.lon))} · ${l.km < 10 ? l.km.toFixed(1) : Math.round(l.km)} km</span></button>`).join("");
    $("landmarks").querySelectorAll("button").forEach((b) => (b.onclick = () => pickLandmark(near[+b.dataset.i], b)));
  }
  function pickLandmark(l, btn) {
    lmPick = l;
    $("landmarks").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === btn));
    $("lmStep").hidden = false;
    $("lmText").textContent = `Centre ${l.name} in the camera view (hold the phone level), then tap.` +
      (S.loc && S.loc.acc != null ? "" : " Turn on location for this to be accurate.");
    if (!$("cam").srcObject) startCamera();
  }
  $("lmUse").onclick = () => {
    const m = $("lmCoords").value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) { $("calResult2").textContent = "Paste coordinates like 47.6205, -122.3493"; return; }
    pickLandmark({ name: "your landmark", lat: +m[1], lon: +m[2] }, null);
  };
  $("lmConfirm").onclick = () => {
    if (!lmPick) return;
    const loc = S.loc || SEATTLE, truth = bearing(loc.lat, loc.lon, lmPick.lat, lmPick.lon);
    const azBefore = (S.rawAz + declination() + S.extra + 360) % 360, dAz = wrap180(truth - azBefore);
    if (Math.abs(dAz) > 45) { $("calResult2").textContent = `That is ${Math.round(Math.abs(dAz))}° from where ${lmPick.name} really is. Wave the phone in a figure 8 and try again.`; return; }
    S.cal = { dAz, dAlt: S.cal ? S.cal.dAlt : 0, with: lmPick.name + (S.cal && /wall/.test(S.cal.with || "") ? " + wall" : "") };
    store("wanderers.cal", S.cal);
    $("calResult2").textContent = `Direction calibrated on ${lmPick.name}: ${fmtSigned(dAz)}.`;
  };

  // ---------- info: where the numbers come from ----------
  $("infoBtn").onclick = () => { $("info").hidden = false; };
  $("closeInfo").onclick = () => { $("info").hidden = true; };
  function renderInfo(now, loc, lst) {
    if ($("info").hidden && $("cal").hidden) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone, off = -now.getTimezoneOffset() / 60;
    const h = Math.floor(lst / 15), m = Math.floor(((lst / 15) % 1) * 60);
    const d = declination(), mdl = Sky.model();
    const rows = [
      ["Your position", `${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}° · ${S.locNote}`],
      ["Your time", `${now.toLocaleTimeString()} ${tz} (UTC${off >= 0 ? "+" : ""}${off}) · ${now.toISOString().slice(11, 19)} UTC`],
      ["Earth's rotation", `Local sidereal time ${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}m (IAU 1982 GMST)`],
      ["True vs magnetic north", S.autoDecl ? `${fmtSigned(d)} from ${mdl ? `${mdl.model}, epoch ${mdl.epoch}` : "loading…"}` : "off"],
      ["Your calibration", S.cal ? `${fmtSigned(S.cal.dAz)} direction, ${fmtSigned(S.cal.dAlt)} tilt (on ${S.cal.with})` : "none yet"],
      ["Extra correction", fmtSigned(S.extra)],
      ["Compass sensor", `${S.source}${S.accuracy != null ? ` · accuracy ±${Math.round(S.accuracy)}°` : ""}`],
    ];
    $("infoRows").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    $("calStatus").innerHTML = rows.slice(3, 7).map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join("") +
      (S.accuracy != null && S.accuracy > 15 ? `<div class="warn">Compass accuracy is poor (±${Math.round(S.accuracy)}°). Wave the phone in a figure 8 for a few seconds.</div>` : "");
  }

  // ---------- drawing ----------
  function fit() {
    const st = document.querySelector(".stage"), s = Math.max(120, Math.min(st.clientWidth - 32, st.clientHeight - 16));
    $("radar").style.width = $("radar").style.height = s + "px";
  }
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", () => setTimeout(fit, 300));

  function loop() { applyCorrections(); draw(); requestAnimationFrame(loop); }

  function draw() {
    const c = $("radar"), g = c.getContext("2d"), W = c.width, cx = W / 2, cy = W / 2, R = W / 2 - 14;
    g.clearRect(0, 0, W, W);
    const now = new Date(), loc = S.loc || SEATTLE;
    const p = vec(S.az, S.alt), zen = [0, 0, 1];
    let up = [zen[0] - dot(zen, p) * p[0], zen[1] - dot(zen, p) * p[1], zen[2] - dot(zen, p) * p[2]];
    if (Math.hypot(...up) < 1e-3) up = [Math.sin(S.az * D2R), Math.cos(S.az * D2R), 0];
    up = norm(up);
    const right = cross(p, up);
    const project = (v) => {
      const d = sep(p, v), x = dot(v, right), y = dot(v, up), h = Math.hypot(x, y) || 1, r = (d / FOV) * R;
      return { d, X: cx + (r * x) / h, Y: cy - (r * y) / h, ux: x / h, uy: y / h };
    };

    g.fillStyle = "rgba(7, 11, 20, 0.55)"; g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = "rgba(124,196,255,.18)"; g.lineWidth = 1.5;
    for (const r of [15, 30, 45, 60]) { g.beginPath(); g.arc(cx, cy, (r / FOV) * R, 0, 2 * Math.PI); g.stroke(); }
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.clip();

    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 2; g.beginPath();
    let first = true;
    for (let az = 0; az <= 360; az += 2) {
      const q = project(vec(az, 0));
      if (q.d > FOV + 5) { first = true; continue; }
      first ? g.moveTo(q.X, q.Y) : g.lineTo(q.X, q.Y); first = false;
    }
    g.stroke();
    g.font = "bold 26px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const [lab, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const q = project(vec(az, 0));
      if (q.d < FOV) { g.fillStyle = lab === "N" ? "#ff8080" : "rgba(255,255,255,.8)"; g.fillText(lab, q.X, q.Y - 18); }
    }
    g.textAlign = "left";
    let near = null, lst = 0;
    for (const o of [...BODIES, ...STARS]) {
      const s = Sky.observe(o, now, loc.lat, loc.lon); lst = s.lst;
      const q = project(vec(s.az, s.alt));
      if (!o.body && (!near || q.d < near.d)) near = { name: o.name, d: q.d };
      if (q.d > FOV) continue;
      const below = s.alt < 0;
      if (o.body) {
        g.fillStyle = below ? "rgba(141,155,184,.5)" : o.body === "sun" ? "#ffd84a" : "#e8ecf5";
        g.beginPath(); g.arc(q.X, q.Y, 12, 0, 2 * Math.PI); g.fill();
        g.font = "bold 22px system-ui"; g.fillText(o.name, q.X + 16, q.Y);
      } else {
        g.fillStyle = below ? "rgba(141,155,184,.45)" : "rgba(255,255,255,.9)";
        g.beginPath(); g.arc(q.X, q.Y, 4, 0, 2 * Math.PI); g.fill();
        g.font = "20px system-ui"; g.fillText(o.name, q.X + 8, q.Y);
      }
    }
    for (const t of S.targets) {
      const s = Sky.observe({ ra: t.ra, dec: t.dec }, now, loc.lat, loc.lon); t._alt = s.alt; t._az = s.az;
      const q = project(vec(s.az, s.alt)); t._d = q.d;
      const el = document.getElementById("tp_" + t.id);
      if (el) el.textContent = `${s.alt >= 0 ? "above" : "below"} horizon · ${compass(s.az)} ${Math.round(s.alt)}°`;
      if (q.d > FOV) continue;
      const isSel = S.sel && S.sel.id === t.id;
      g.strokeStyle = s.alt < 0 ? "#8d9bb8" : "#ffb547"; g.lineWidth = isSel ? 4 : 2.5;
      g.beginPath(); g.arc(q.X, q.Y, isSel ? 16 : 11, 0, 2 * Math.PI); g.stroke();
      g.fillStyle = s.alt < 0 ? "#b6c0d4" : "#ffd28a"; g.font = `${isSel ? "bold " : ""}22px system-ui`;
      g.fillText(t.name, q.X + 20, q.Y + 1);
    }
    g.restore();

    const sel = S.sel;
    if (sel && sel._d != null && sel._d > FOV - 4) {
      const q = project(vec(sel._az, sel._alt));
      const ang = Math.atan2(q.ux, q.uy), ex = cx + Math.sin(ang) * (R - 24), ey = cy - Math.cos(ang) * (R - 24);
      g.save(); g.translate(ex, ey); g.rotate(ang); g.fillStyle = "#ffb547";
      g.beginPath(); g.moveTo(0, -22); g.lineTo(16, 10); g.lineTo(-16, 10); g.closePath(); g.fill(); g.restore();
    }

    $("ptDir").textContent = `Pointing ${compass(S.az)} ${Math.round(S.az)}° · ${S.alt >= 0 ? "up" : "down"} ${Math.abs(Math.round(S.alt))}°`;
    $("ptNear").textContent = `${near && near.d < 25 ? `Near ${near.name} · ` : ""}${S.cal ? "calibrated" : "not calibrated"} · ${S.locNote}`;
    $("calBtn").classList.toggle("needs", !S.cal);
    renderInfo(now, loc, lst);
    guide(sel);
  }

  function guide(t) {
    const main = $("guideMain"), sub = $("guideSub"), inv = $("investigate");
    if (!t || t._d == null) {
      main.textContent = "Pick a target below"; main.classList.remove("locked"); inv.hidden = true;
      sub.textContent = S.haveSensor ? (S.cal ? "Hold the phone up like you are taking a photo of the sky." : "Tip: tap 🎯 Calibrate first for accurate directions.")
        : "No motion sensors here: drag the radar or use the arrow keys.";
      return;
    }
    const dAz = wrap180(t._az - S.az), dAlt = t._alt - S.alt;
    if (t._d <= LOCK) {
      main.textContent = `Locked on: ${t.name}`; main.classList.add("locked");
      sub.textContent = t._alt < 0 ? "It is below your horizon right now, on the other side of the Earth." : `${Math.round(t._alt)}° above your horizon.`;
      inv.hidden = false; inv.href = `index.html?target=${t.id}`;
      if (!t._buzzed && navigator.vibrate) { navigator.vibrate(60); t._buzzed = true; }
    } else {
      t._buzzed = false; main.classList.remove("locked"); inv.hidden = true;
      const h = Math.abs(dAz) < 3 ? "" : `Turn ${dAz > 0 ? "right" : "left"} ${Math.abs(Math.round(dAz))}°`;
      const v = Math.abs(dAlt) < 3 ? "" : `tilt ${dAlt > 0 ? "up" : "down"} ${Math.abs(Math.round(dAlt))}°`;
      main.textContent = [h, v].filter(Boolean).join(" · ") || "Almost there";
      sub.textContent = `${t.name} is ${t._alt >= 0 ? "above" : "below"} the horizon, ${Math.round(t._d)}° from where you point.`;
    }
  }
})();
