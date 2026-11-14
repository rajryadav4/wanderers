/* WANDERERS Sky Compass.
 * Where the phone points: back-camera direction from DeviceOrientation (alpha/beta/gamma, W3C
 * Z-X'-Y'' Euler angles) plus a compass heading (absolute alpha on Android, webkitCompassHeading on iOS).
 * Where a target is: RA/Dec -> altitude/azimuth from GPS position and the current sidereal time.
 * Everything runs on the phone. Without motion sensors (desktop) you drag the radar instead. */
(() => {
  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const FOV = 60;            // radar radius in degrees
  const LOCK = 12;           // "locked on" when the target is this close to where you point
  const SEATTLE = { lat: 47.61, lon: -122.33 };

  // Bright stars to orient by (J2000 RA/Dec in degrees).
  const STARS = [
    ["Polaris", 37.95, 89.26], ["Vega", 279.23, 38.78], ["Arcturus", 213.92, 19.18], ["Capella", 79.17, 46.00],
    ["Sirius", 101.29, -16.72], ["Betelgeuse", 88.79, 7.41], ["Rigel", 78.63, -8.20], ["Aldebaran", 68.98, 16.51],
    ["Altair", 297.70, 8.87], ["Deneb", 310.36, 45.28], ["Spica", 201.30, -11.16], ["Antares", 247.35, -26.43],
    ["Procyon", 114.83, 5.22], ["Pollux", 116.33, 28.03], ["Regulus", 152.09, 11.97], ["Fomalhaut", 344.41, -29.62],
  ];

  const S = {
    targets: [], sel: null, loc: null, locNote: "", az: 0, alt: 20, haveSensor: false, source: "none",
    decl: 0, smooth: null, lastEvt: 0,
  };
  try { S.decl = parseFloat(localStorage.getItem("wanderers.decl")) || 0; } catch {}

  // ---------- astronomy ----------
  function lstDeg(date, lon) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
    return (((gmst + lon) % 360) + 360) % 360;
  }
  function altAz(ra, dec, lat, lst) {
    const H = (lst - ra) * D2R, d = dec * D2R, p = lat * D2R;
    const sinAlt = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    const az = Math.atan2(-Math.sin(H) * Math.cos(d), Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(H));
    return { alt: alt * R2D, az: ((az * R2D) + 360) % 360 };
  }
  // east, north, up unit vector for an az/alt
  const vec = (az, alt) => [Math.sin(az * D2R) * Math.cos(alt * D2R), Math.cos(az * D2R) * Math.cos(alt * D2R), Math.sin(alt * D2R)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((x) => x / n); };
  const sep = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
  const wrap180 = (x) => ((x + 540) % 360) - 180;
  const compass = (az) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];

  // ---------- phone orientation ----------
  // Back-camera direction for W3C Euler angles (alpha about Z, beta about X', gamma about Y'').
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
      alpha = 360 - e.webkitCompassHeading; S.source = "iOS compass";       // iOS: heading clockwise from north
    } else if (absolute || e.absolute) {
      alpha = e.alpha; S.source = "absolute orientation";
    } else if (S.source === "none" || S.source === "relative (no compass)") {
      alpha = e.alpha; S.source = "relative (no compass)";
    } else return;
    if (alpha == null) return;
    const c = cameraAzAlt(alpha, e.beta, e.gamma || 0);
    c.az = (c.az + S.decl + 360) % 360;
    // circular low-pass filter so the radar does not jitter
    if (!S.smooth) S.smooth = { x: Math.sin(c.az * D2R), y: Math.cos(c.az * D2R), alt: c.alt };
    const k = 0.25;
    S.smooth.x += k * (Math.sin(c.az * D2R) - S.smooth.x);
    S.smooth.y += k * (Math.cos(c.az * D2R) - S.smooth.y);
    S.smooth.alt += k * (c.alt - S.smooth.alt);
    S.az = ((Math.atan2(S.smooth.x, S.smooth.y) * R2D) + 360) % 360;
    S.alt = S.smooth.alt;
    S.haveSensor = true; S.lastEvt = performance.now();
  }

  // ---------- start ----------
  fetch("data/index.json").then((r) => r.json()).then((list) => {
    S.targets = list;
    const want = new URLSearchParams(location.search).get("target");
    S.sel = list.find((t) => t.id === want) || null;
    renderTargets();
  });

  $("start").onclick = async () => {
    $("introMsg").textContent = "";
    // iOS 13+ needs an explicit permission request from a tap.
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") $("introMsg").textContent = "Motion access was declined, so you can drag the radar instead.";
      }
    } catch (err) { $("introMsg").textContent = "Motion access is not available here: " + err.message; }
    window.addEventListener("deviceorientationabsolute", (e) => onOrient(e, true), true);
    window.addEventListener("deviceorientation", (e) => onOrient(e, false), true);

    if ($("useCam").checked && navigator.mediaDevices) {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        $("cam").srcObject = st; $("cam").hidden = false;
      } catch { /* camera is optional */ }
    }
    locate();
    $("intro").hidden = true; $("hud").hidden = false; fit();
    setTimeout(() => { if (!S.haveSensor) { S.source = "drag to aim (no motion sensors)"; } }, 2500);
    requestAnimationFrame(loop);
  };

  function locate() {
    S.loc = SEATTLE; S.locNote = "using Seattle until GPS answers";
    if (!navigator.geolocation) { S.locNote = "no GPS, using Seattle"; return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { S.loc = { lat: p.coords.latitude, lon: p.coords.longitude }; S.locNote = `GPS ±${Math.round(p.coords.accuracy)} m`; },
      () => { S.locNote = "location declined, using Seattle"; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  // ---------- drag to aim (desktop / no sensors) ----------
  let drag = null;
  $("radar").addEventListener("pointerdown", (e) => { if (!S.haveSensor) { drag = { x: e.clientX, y: e.clientY, az: S.az, alt: S.alt }; $("radar").setPointerCapture(e.pointerId); } });
  $("radar").addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = 120 / $("radar").clientWidth;
    S.az = (drag.az - (e.clientX - drag.x) * k + 360) % 360;
    S.alt = Math.max(-89, Math.min(89, drag.alt + (e.clientY - drag.y) * k));
  });
  $("radar").addEventListener("pointerup", () => (drag = null));
  window.addEventListener("keydown", (e) => {
    if (S.haveSensor) return;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") S.az = (S.az - step + 360) % 360;
    if (e.key === "ArrowRight") S.az = (S.az + step) % 360;
    if (e.key === "ArrowUp") S.alt = Math.min(89, S.alt + step);
    if (e.key === "ArrowDown") S.alt = Math.max(-89, S.alt - step);
  });

  // ---------- UI ----------
  function renderTargets() {
    $("targets").innerHTML = S.targets.map((t) =>
      `<button data-id="${t.id}" class="${S.sel && S.sel.id === t.id ? "on" : ""}" role="option"><b>${t.name}</b><span id="tp_${t.id}">${t.teaser}</span></button>`).join("");
    $("targets").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      S.sel = S.targets.find((t) => t.id === b.dataset.id); renderTargets();
      const u = new URL(location); u.searchParams.set("target", S.sel.id); history.replaceState(null, "", u);
    }));
  }

  $("settingsBtn").onclick = () => { $("settings").hidden = false; };
  $("closeSettings").onclick = () => { $("settings").hidden = true; };
  $("decl").value = S.decl; $("declVal").textContent = `${S.decl > 0 ? "+" : ""}${S.decl}°`;
  $("decl").oninput = (e) => {
    S.decl = +e.target.value; $("declVal").textContent = `${S.decl > 0 ? "+" : ""}${S.decl}°`;
    try { localStorage.setItem("wanderers.decl", S.decl); } catch {}
  };

  // Fit the square radar inside whatever space the stage has (phones differ a lot).
  function fit() {
    const st = document.querySelector(".stage"), s = Math.max(120, Math.min(st.clientWidth - 32, st.clientHeight - 16));
    $("radar").style.width = $("radar").style.height = s + "px";
  }
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", () => setTimeout(fit, 300));

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }

  function draw() {
    const c = $("radar"), g = c.getContext("2d"), W = c.width, cx = W / 2, cy = W / 2, R = W / 2 - 14;
    g.clearRect(0, 0, W, W);
    const now = new Date(), loc = S.loc || SEATTLE, lst = lstDeg(now, loc.lon);
    const p = vec(S.az, S.alt);
    const zen = [0, 0, 1];
    let up = [zen[0] - dot(zen, p) * p[0], zen[1] - dot(zen, p) * p[1], zen[2] - dot(zen, p) * p[2]];
    if (Math.hypot(...up) < 1e-3) up = [Math.sin(S.az * D2R), Math.cos(S.az * D2R), 0];   // pointing straight up/down
    up = norm(up);
    const right = cross(p, up);
    const project = (v) => {
      const d = sep(p, v), x = dot(v, right), y = dot(v, up), h = Math.hypot(x, y) || 1;
      const r = (d / FOV) * R;
      return { d, X: cx + (r * x) / h, Y: cy - (r * y) / h, ux: x / h, uy: y / h };
    };

    // background disc + rings
    g.fillStyle = "rgba(7, 11, 20, 0.55)"; g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = "rgba(124,196,255,.18)"; g.lineWidth = 1.5;
    for (const r of [15, 30, 45, 60]) { g.beginPath(); g.arc(cx, cy, (r / FOV) * R, 0, 2 * Math.PI); g.stroke(); }
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.clip();

    // horizon (alt = 0) and ground shading
    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 2; g.beginPath();
    let first = true;
    for (let az = 0; az <= 360; az += 2) {
      const q = project(vec(az, 0));
      if (q.d > FOV + 5) { first = true; continue; }
      first ? g.moveTo(q.X, q.Y) : g.lineTo(q.X, q.Y); first = false;
    }
    g.stroke();
    // cardinal points on the horizon
    g.font = "bold 26px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const [lab, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const q = project(vec(az, 0));
      if (q.d < FOV) { g.fillStyle = lab === "N" ? "#ff8080" : "rgba(255,255,255,.8)"; g.fillText(lab, q.X, q.Y - 18); }
    }
    // bright stars
    g.font = "20px system-ui"; g.textAlign = "left";
    let near = null;
    for (const [name, ra, dec] of STARS) {
      const s = altAz(ra, dec, loc.lat, lst), v = vec(s.az, s.alt), q = project(v);
      if (!near || q.d < near.d) near = { name, d: q.d };
      if (q.d > FOV) continue;
      g.fillStyle = s.alt < 0 ? "rgba(141,155,184,.45)" : "rgba(255,255,255,.9)";
      g.beginPath(); g.arc(q.X, q.Y, 4, 0, 2 * Math.PI); g.fill();
      g.fillText(name, q.X + 8, q.Y);
    }
    // targets
    for (const t of S.targets) {
      const s = altAz(t.ra, t.dec, loc.lat, lst); t._alt = s.alt; t._az = s.az;
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

    // edge arrow towards the selected target when it is outside the radar
    const sel = S.sel;
    if (sel && sel._d != null && sel._d > FOV - 4) {
      const q = project(vec(sel._az, sel._alt));
      const ang = Math.atan2(q.ux, q.uy), ex = cx + Math.sin(ang) * (R - 24), ey = cy - Math.cos(ang) * (R - 24);
      g.save(); g.translate(ex, ey); g.rotate(ang); g.fillStyle = "#ffb547";
      g.beginPath(); g.moveTo(0, -22); g.lineTo(16, 10); g.lineTo(-16, 10); g.closePath(); g.fill(); g.restore();
    }

    // header + guidance
    $("ptDir").textContent = `Pointing ${compass(S.az)} ${Math.round(S.az)}° · ${S.alt >= 0 ? "up" : "down"} ${Math.abs(Math.round(S.alt))}°`;
    $("ptNear").textContent = near && near.d < 25 ? `Near ${near.name} · ${S.locNote}` : S.locNote;
    $("diag").textContent = `sensor: ${S.source} · location ${loc.lat.toFixed(1)}°, ${loc.lon.toFixed(1)}° · correction ${S.decl}°`;
    guide(sel);
  }

  function guide(t) {
    const main = $("guideMain"), sub = $("guideSub"), inv = $("investigate");
    if (!t || t._d == null) {
      main.textContent = "Pick a target below"; main.classList.remove("locked"); inv.hidden = true;
      sub.textContent = S.haveSensor ? "Hold the phone up like you are taking a photo of the sky." : "No motion sensors here: drag the radar or use the arrow keys.";
      return;
    }
    const dAz = wrap180(t._az - S.az), dAlt = t._alt - S.alt;
    if (t._d <= LOCK) {
      main.textContent = `Locked on: ${t.name}`; main.classList.add("locked");
      sub.textContent = t._alt < 0 ? "It is below your horizon right now, on the other side of the Earth." : `${Math.round(t._alt)}° above your horizon.`;
      inv.hidden = false; inv.href = `index.html?target=${t.id}`;
      if (!t._buzzed && navigator.vibrate) { navigator.vibrate(60); t._buzzed = true; }
    } else {
      t._buzzed = false;
      main.classList.remove("locked"); inv.hidden = true;
      const h = Math.abs(dAz) < 3 ? "" : `Turn ${dAz > 0 ? "right" : "left"} ${Math.abs(Math.round(dAz))}°`;
      const v = Math.abs(dAlt) < 3 ? "" : `tilt ${dAlt > 0 ? "up" : "down"} ${Math.abs(Math.round(dAlt))}°`;
      main.textContent = [h, v].filter(Boolean).join(" · ") || "Almost there";
      sub.textContent = `${t.name} is ${t._alt >= 0 ? "above" : "below"} the horizon, ${Math.round(t._d)}° from where you point.`;
    }
  }
})();
