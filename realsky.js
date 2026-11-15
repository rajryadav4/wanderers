/* WANDERERS Sky Compass: the real sky behind the AR view (docs/specs/sky-compass-real-sky.md).
 *   Eye:  the stars a person can see (data/skystars.json, from the star database), constellation lines and the
 *         planets, drawn in the camera's own projection. Not a photograph.
 *   Deep: survey photographs (DSS2 visible or 2MASS infrared) as HiPS tiles, drawn by Aladin Lite in the TAN
 *         projection, which is the projection of a camera, so the photographs sit under the drawn sky exactly.
 * Also: pictures kept on the phone (sw.js), "Save the sky for a place", and "Drag the sky" calibration.
 * compass.js calls RealSky.init() once and RealSky.draw() every frame, under its own markers. */
(function (root) {
  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180;
  const Q = new URLSearchParams(location.search);
  const SURVEYS = {
    visible: { name: "Digitized Sky Survey 2 (visible light)", hosts: ["https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color",
      "https://cdn.skies.esac.esa.int/DSSColor"], tile: 38000, allsky: 810000, credit: SkyView.CREDITS.deep },
    infrared: { name: "2MASS near-infrared (1.2 to 2.2 µm), shown in false colour", hosts: ["https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color",
      "https://cdn.skies.esac.esa.int/2MASSColor"], tile: 59000, allsky: 1030000, credit: SkyView.CREDITS.infrared },
  };   // tile / allsky: mean tile and Norder3/Allsky.jpg in bytes, measured 2026-11-14 (for the save estimate)
  const surveyOf = (n) => SURVEYS[n] || SURVEYS.visible;
  const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
  const CACHE_AUTO = "wanderers-sky-v1", CACHE_SAVED = "wanderers-sky-saved-v1", TILE_BYTES = 38000;
  const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const pick = (k, ok, d) => (ok(Q.get(k)) ? Q.get(k) : d);

  const R = {
    sky: pick("sky", (v) => ["off", "eye", "deep"].includes(v), load("wanderers.sky", "eye")),
    limit: pick("limit", (v) => SkyView.LIMITS[v], load("wanderers.skyLimit", "dark")),
    survey: pick("survey", (v) => SURVEYS[v], load("wanderers.skySurvey", "visible")),
    lines: load("wanderers.skyLines", true), mix: load("wanderers.skyMix", 0.8), msg: "", calDrag: null,
  };
  let C = null;            // what compass.js gives: pose(), focal(), loc(), now(), camOn(), F, S, onStar(key), openSight()
  let LAST = null;         // the latest frame: pose, focal, size, time, place (for taps, the drag and the self-check)

  // ---------- the camera's projection (the same formula as compass.js) ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((x) => x / n); };
  const vec = (az, alt) => [Math.sin(az * D2R) * Math.cos(alt * D2R), Math.cos(az * D2R) * Math.cos(alt * D2R), Math.sin(alt * D2R)];
  function projector(P, f, W, H) {
    return (v) => { const z = dot(v, P.forward); if (z < 0.02) return null; return [W / 2 + (f * dot(v, P.right)) / z, H / 2 - (f * dot(v, P.up)) / z]; };
  }
  const unproject = (P, f, W, H, x, y) => norm(P.forward.map((c, i) => f * c + (x - W / 2) * P.right[i] + (H / 2 - y) * P.up[i]));
  // how far the screen's "up" leans from "towards the zenith", clockwise, in degrees
  function rollOf(P) {
    const fw = P.forward;
    let u0 = [-fw[2] * fw[0], -fw[2] * fw[1], 1 - fw[2] * fw[2]];
    if (Math.hypot(...u0) < 1e-6) u0 = vec(P.az, 0);
    u0 = norm(u0);
    const r0 = [fw[1] * u0[2] - fw[2] * u0[1], fw[2] * u0[0] - fw[0] * u0[2], fw[0] * u0[1] - fw[1] * u0[0]];
    return Math.atan2(dot(P.up, r0), dot(P.up, u0)) / D2R;
  }

  // ---------- Eye: stars, lines, planets ----------
  const EYE = { stars: null, cons: [], xyz: null, loading: false, failed: false, key: "", vecs: [] };
  function loadStars() {
    if (EYE.stars || EYE.loading) return;
    EYE.loading = true;
    fetch("data/skystars.json").then((r) => r.json()).then((d) => {
      EYE.xyz = new Float32Array(d.stars.length * 3);
      d.stars.forEach((s, i) => EYE.xyz.set(Sky.unit(s[0], s[1]), 3 * i));
      EYE.cons = d.meta.cons; EYE.stars = d.stars; EYE.key = ""; EYE.failed = false;
    }).catch(() => { EYE.failed = true; }).finally(() => { EYE.loading = false; });
  }
  // stars above the horizon down to a faintness: [east, north, up, mag, letter, row]
  function starsUp(now, L, mag) {
    const fr = Sky.frame(now, L.lat, L.lon), n = SkyView.countToLimit(EYE.stars, mag), out = [], a = EYE.xyz;
    for (let i = 0; i < n; i++) {
      const v = fr.toHorizon(a[3 * i], a[3 * i + 1], a[3 * i + 2]);
      if (v[2] < 0) continue;
      v.push(EYE.stars[i][2], EYE.stars[i][3], i); out.push(v);
    }
    return out;
  }
  const CON = { list: null, loading: false, key: "", figs: [] };
  function loadLines() {
    if (CON.list || CON.loading) return;
    CON.loading = true;
    fetch("data/constellations.json").then((r) => r.json()).then((d) => { CON.list = d.list; CON.key = ""; })
      .catch(() => {}).finally(() => { CON.loading = false; });
  }
  const PLANETS = { t: -1, list: [] };
  function planetsNow(now) {
    const t = Math.floor(now.getTime() / 60000);
    if (t !== PLANETS.t) { PLANETS.t = t; PLANETS.list = Sky.planets(now); }
    return PLANETS.list;
  }

  function drawEye(g, proj, now, L, f) {
    if (!EYE.stars) { loadStars(); return; }
    const key = `${R.limit}|${L.lat.toFixed(2)}|${L.lon.toFixed(2)}|${Math.floor(now.getTime() / 1000)}`;
    if (key !== EYE.key) { EYE.key = key; EYE.vecs = starsUp(now, L, SkyView.limitMag(R.limit)); }
    const zoom = Math.max(0.6, Math.min(1.6, f / 700));             // dots grow a little with a longer lens
    const fade = C.camOn() ? 0.35 + 0.65 * R.mix : 1;
    for (const s of EYE.vecs) {
      const q = proj(s); if (!q) continue;
      g.globalAlpha = SkyView.starAlpha(s[3]) * fade; g.fillStyle = SkyView.starColour(s[4]);
      g.beginPath(); g.arc(q[0], q[1], Math.max(0.7, SkyView.starRadius(s[3], 60) * 0.5 * zoom), 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  }
  function drawLines(g, proj, now, L) {
    if (!CON.list) { loadLines(); return; }
    const key = `${L.lat.toFixed(2)}|${L.lon.toFixed(2)}|${Math.floor(now.getTime() / 1000)}`;
    if (key !== CON.key) {
      CON.key = key;
      const fr = Sky.frame(now, L.lat, L.lon);
      CON.figs = CON.list.map((c) => ({ name: c.name, at: fr.toHorizon(...Sky.unit(c.ra, c.dec)),
        strokes: c.lines.map((l) => { const v = []; for (let i = 0; i < l.length; i += 2) v.push(fr.toHorizon(...Sky.unit(l[i], l[i + 1]))); return v; }) }));
    }
    g.strokeStyle = "rgba(124,196,255,.34)"; g.lineWidth = 1; g.beginPath();
    for (const c of CON.figs) for (const st of c.strokes) for (let i = 1; i < st.length; i++) {
      if (st[i - 1][2] < 0 && st[i][2] < 0) continue;              // under the ground
      const a = proj(st[i - 1]), b = proj(st[i]); if (!a || !b) continue;
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
    g.fillStyle = "rgba(124,196,255,.6)"; g.font = "600 10px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const c of CON.figs) { if (c.at[2] < 0) continue; const q = proj(c.at); if (q) g.fillText(c.name.toUpperCase(), q[0], q[1]); }
    g.textAlign = "left";
  }
  function drawPlanets(g, proj, now, L) {
    g.font = "600 12px 'Space Grotesk', sans-serif"; g.textBaseline = "middle"; g.textAlign = "left";
    for (const pl of planetsNow(now)) {
      const s = Sky.observe(pl, now, L.lat, L.lon), q = proj(vec(s.az, s.alt)); if (!q) continue;
      g.fillStyle = s.alt < 0 ? "rgba(160,170,190,.45)" : "#ffe9b0";
      g.beginPath(); g.arc(q[0], q[1], 4.5, 0, 7); g.fill(); g.fillText(pl.name, q[0] + 8, q[1]);
    }
  }

  // ---------- Deep: survey photographs under the canvas ----------
  const DEEP = { state: "idle", aladin: null, last: null, base: null, survey: null, A: null };
  async function pickHost(name) {
    for (const h of surveyOf(name).hosts) {
      if (await fetch(h + "/properties", { signal: AbortSignal.timeout(6000) }).then((r) => r.ok).catch(() => false)) return h;
    }
    throw new Error("archive");
  }
  async function startDeep() {
    if (DEEP.state !== "idle") return;
    DEEP.state = "loading"; note();
    try {
      const base = await pickHost(R.survey);
      DEEP.base = base; DEEP.survey = R.survey;
      const A = (await import(ALADIN_URL)).default; await A.init; DEEP.A = A;
      // log: false. By default Aladin Lite reports this page's full address to a CDS logging server on start.
      DEEP.aladin = A.aladin("#skyDeep", { survey: base, projection: "TAN", fov: 60, cooFrame: "ICRSd", log: false,
        showReticle: false, showLayersControl: false, showGotoControl: false, showFullscreenControl: false, showCooGridControl: false,
        showSimbadPointerControl: false, showProjectionControl: false, showFrame: false, showZoomControl: false, showCooLocation: false,
        showFov: false, showStatusBar: false, showShareControl: false, showContextMenu: false, showSettingsControl: false });
      DEEP.aladin.setBaseImageLayer(A.imageHiPS(base, { name: R.survey, imgFormat: "jpeg" }));
      DEEP.state = "ready"; DEEP.last = null; note();
    } catch {
      DEEP.state = "idle";
      if (R.sky === "deep") setSky("eye", "Sky photographs are not reachable. Showing the Eye view.");
    }
  }
  async function setSurvey(name) {
    R.survey = SURVEYS[name] ? name : "visible"; store("wanderers.skySurvey", R.survey); setSky(R.sky);
    if (DEEP.state !== "ready" || DEEP.survey === R.survey) return;
    DEEP.state = "loading"; note();
    try {
      const base = await pickHost(R.survey);
      DEEP.aladin.setBaseImageLayer(DEEP.A.imageHiPS(base, { name: R.survey, imgFormat: "jpeg" }));
      DEEP.base = base; DEEP.survey = R.survey; DEEP.state = "ready"; DEEP.last = null; note();
    } catch {
      DEEP.state = "ready";                          // the old photographs are still on screen
      const want = R.survey; R.survey = DEEP.survey; store("wanderers.skySurvey", R.survey);
      setSky(R.sky, `The ${want} photographs are not reachable. Kept the ${DEEP.survey} ones.`);
    }
  }
  // Aladin's box is the whole screen. TAN with focal length f: the full width is 2·atan(W / 2f).
  // setRotation takes MINUS the position angle of the screen's "up" (measured 2026-11-14 in the radar version).
  function syncDeep(P, f, W, H, now, L) {
    if (DEEP.state === "idle") startDeep();
    if (DEEP.state !== "ready") return;
    if (DEEP.survey !== R.survey) { setSurvey(R.survey); return; }
    const c = Sky.unobserve(P.az, P.alt, now, L.lat, L.lon), rot = Sky.zenithAngle(P.az, P.alt, now, L.lat, L.lon) - rollOf(P);
    const fov = (2 * Math.atan(W / 2 / f)) / D2R, last = DEEP.last;
    if (last && Math.abs(last.fov - fov) < 0.01 && Math.abs(((rot - last.rot + 540) % 360) - 180) < 0.05 &&
        Math.hypot((c.ra - last.c.ra) * Math.cos(c.dec * D2R), c.dec - last.c.dec) < 0.01) return;
    DEEP.last = { c, rot, fov };
    DEEP.aladin.setFoV(fov); DEEP.aladin.gotoRaDec(c.ra, c.dec); DEEP.aladin.setRotation(-rot);
  }

  // ---------- one frame, called by compass.js before its own markers ----------
  // Returns true when the photographs are showing, so compass.js leaves out its dark backdrop.
  function draw(g, P, f, W, H, now, L) {
    LAST = { P, f, W, H, now, L };
    const deepShows = R.sky === "deep" && DEEP.state === "ready";
    if (R.sky === "deep") syncDeep(P, f, W, H, now, L);
    if (R.sky === "off") { note(); return false; }
    const proj = projector(P, f, W, H);
    if (R.lines) drawLines(g, proj, now, L);
    if (R.sky === "eye") drawEye(g, proj, now, L, f);
    drawPlanets(g, proj, now, L);
    note();
    return deepShows;
  }

  // ---------- controls ----------
  function seg(id, attr, value) { $(id).querySelectorAll("button").forEach((b) => { const on = b.dataset[attr] === String(value); b.classList.toggle("on", on); b.setAttribute("aria-checked", on); }); }
  function setSky(mode, msg) {
    R.sky = mode; R.msg = msg || ""; store("wanderers.sky", mode);
    seg("skySeg", "sky", mode); seg("limitSeg", "limit", R.limit); seg("surveySeg", "survey", R.survey);
    $("limitSeg").hidden = mode !== "eye"; $("surveySeg").hidden = mode !== "deep";
    $("linesBtn").hidden = mode === "off"; $("linesBtn").classList.toggle("on", R.lines); $("linesBtn").setAttribute("aria-pressed", R.lines);
    if (mode !== "off") { loadStars(); if (R.lines) loadLines(); }   // Deep needs the star list too, for taps
    $("skyDeep").hidden = mode !== "deep";
    $("mixWrap").hidden = !C.camOn() || mode === "off";
    $("mix").value = Math.round(R.mix * 100);
    $("skyDeep").style.opacity = C.camOn() ? R.mix : 1;
    DEEP.last = null; NOTE = ""; note();
  }
  let NOTE = "";
  function note() {
    const F = C.F, pt = SkyView.pointing({ haveSensor: C.S.sensors, accuracy: F.compassAccuracy, calibrated: !!F.compassFrozen });
    const state = R.sky === "deep" && DEEP.state === "loading" ? "Loading sky photographs… " : R.sky === "eye" && EYE.failed ? "The star list could not be loaded. " : "";
    const text = [R.msg, state + (R.sky === "deep" ? `Background: ${surveyOf(R.survey).name}. ` : "") + SkyView.LABELS[R.sky], pt.text].filter(Boolean).join(" · ");
    const key = text + pt.needsCal;
    if (key === NOTE) return;
    NOTE = key;
    const el = $("skyNote"); el.textContent = text;
    if (pt.needsCal) { const b = document.createElement("button"); b.textContent = "Sight check"; b.onclick = C.openSight; el.append(" ", b); }
  }

  // ---------- taps: a planet, the Moon or the Sun gets a small card; a star opens the star sheet ----------
  function pickAt(x, y) {
    if (!LAST) return null;
    const { P, f, W, H, now, L } = LAST, proj = projector(P, f, W, H), reach = 22;
    const off = (o) => { const s = Sky.observe(o, now, L.lat, L.lon), q = proj(vec(s.az, s.alt)); return q ? Math.hypot(q[0] - x, q[1] - y) : 1e9; };
    const where = (o) => { const a = Math.round(Sky.observe(o, now, L.lat, L.lon).alt); return a >= 0 ? `${a}° above the horizon now.` : "Below the horizon now."; };
    for (const b of [{ name: "Moon", body: "moon" }, { name: "Sun", body: "sun" }]) if (off(b) < reach) return { kind: "body", title: b.name, lines: [where(b), "Its place is worked out for this moment, not taken from a picture."] };
    for (const pl of planetsNow(now)) if (off(pl) < reach) return { kind: "planet", title: pl.name, lines: ["A planet. " + where(pl), "Its place is worked out from JPL's orbital elements, not taken from a picture."] };
    if (EYE.stars && R.sky !== "off") {
      let best = null;
      for (const s of starsUp(now, L, R.sky === "eye" ? SkyView.limitMag(R.limit) : 6.5)) {
        const q = proj(s); if (!q) continue;
        if (Math.hypot(q[0] - x, q[1] - y) < 18 && (!best || s[3] < best[3])) best = s;   // the brightest one within reach
      }
      if (best) { const row = EYE.stars[best[5]], card = SkyView.starCard(row, EYE.cons); return { kind: "star", key: card.key, title: card.title, lines: card.lines, ra: row[0], dec: row[1] }; }
    }
    return null;
  }
  function showCard(pk) {
    $("skyCard").hidden = !pk;
    if (!pk) return;
    $("skyCardName").textContent = pk.title;
    $("skyCardLines").replaceChildren(...pk.lines.map((t) => { const p = document.createElement("p"); p.textContent = t; return p; }));
  }
  function onTap(x, y) {
    const pk = pickAt(x, y);
    if (pk && pk.kind === "star") { showCard(null); C.onStar(pk); } else showCard(pk);
    return pk;
  }

  // ---------- drag the sky: the sky point under the finger stays under the finger ----------
  // With motion sensors it moves the sight-check offsets (F.fineAz, F.fineAlt), like tapping a landmark does;
  // without them it aims the view. A small 2-by-2 Newton solve, so it is exact whatever the phone's roll.
  // The pose after turning by A degrees of azimuth (about the vertical) and then tilting by T degrees about the
  // camera's right axis: what F.fineAz and F.fineAlt do in orient.js, and what a change of S.manual does.
  function turned(P, A, T) {
    const ca = Math.cos(A * D2R), sa = Math.sin(A * D2R), ct = Math.cos(T * D2R), st = Math.sin(T * D2R);
    const rz = (v) => [v[0] * ca + v[1] * sa, -v[0] * sa + v[1] * ca, v[2]];      // clockwise seen from above
    const f0 = rz(P.forward), u0 = rz(P.up);
    const fw = norm(f0.map((x, i) => x * ct + u0[i] * st)), up = norm(u0.map((x, i) => x * ct - f0[i] * st));
    const right = [fw[1] * up[2] - fw[2] * up[1], fw[2] * up[0] - fw[0] * up[2], fw[0] * up[1] - fw[1] * up[0]];
    return { forward: fw, up, right };
  }
  // Find (A, T) that draws the grabbed point v at the finger (tx, ty): a 2-by-2 Newton solve on the modelled pose.
  // The motion sensors are smoothed, so the real pose catches up a few frames later.
  function follow(g, tx, ty) {
    const W = innerWidth, H = innerHeight, f = C.focal(W, H), at = (A, T) => projector(turned(g.P0, A, T), f, W, H)(g.v), h = 0.05;
    let A = g.A, T = g.T;
    for (let i = 0; i < 6; i++) {
      const q0 = at(A, T); if (!q0) break;
      const ex = tx - q0[0], ey = ty - q0[1]; if (Math.hypot(ex, ey) < 0.05) break;
      const qa = at(A + h, T), qb = at(A, T + h); if (!qa || !qb) break;
      const a = (qa[0] - q0[0]) / h, c = (qa[1] - q0[1]) / h, b = (qb[0] - q0[0]) / h, d = (qb[1] - q0[1]) / h, det = a * d - b * c;
      if (Math.abs(det) < 1e-9) break;
      const lim = (x) => Math.max(-20, Math.min(20, x));
      A += lim((d * ex - b * ey) / det); T += lim((a * ey - c * ex) / det);
    }
    g.A = A; g.T = T;
    if (C.S.sensors) { C.F.fineAz = Orient.wrap180(g.fine[0] + A); C.F.fineAlt = Math.max(-30, Math.min(30, g.fine[1] + T)); }
    else { const m = C.S.manual; m.az = (g.manual.az + A + 720) % 360; m.alt = Math.max(-85, Math.min(85, g.manual.alt + T)); }
  }
  function startDrag() {
    if (R.sky === "off") setSky("eye");
    R.calDrag = { az: C.F.fineAz, alt: C.F.fineAlt, frozen: C.F.compassFrozen, manual: { ...C.S.manual } };
    $("north").hidden = true; $("dragBar").hidden = false;
  }
  function endDrag(keep) {
    const b = R.calDrag; R.calDrag = null; $("dragBar").hidden = true;
    if (!b) return;
    if (!keep) { C.F.fineAz = b.az; C.F.fineAlt = b.alt; C.F.compassFrozen = b.frozen; Object.assign(C.S.manual, b.manual); return; }
    if (C.S.sensors) C.F.compassFrozen = true;      // the sky the user sees is the truth now, as after a sight check
  }

  // ---------- pictures kept on the phone, and "Save the sky for a place" ----------
  const cacheOk = "caches" in window;
  async function cacheStats(name) {
    if (!cacheOk || !(await caches.has(name))) return { n: 0, bytes: 0 };
    const c = await caches.open(name), keys = (await c.keys()).filter((k) => /\.jpg$/.test(k.url));
    let bytes = 0;
    for (const k of keys) { const r = await c.match(k); bytes += +(r && r.headers.get("content-length")) || TILE_BYTES; }
    return { n: keys.length, bytes };
  }
  const DETAIL = { 1: "Basic", 2: "Standard", 3: "Sharp" };
  const planFor = (lat, order, survey) => { const v = surveyOf(survey); return Hips.plan(v.hosts[0], lat, order, v); };
  const SAVE = { order: 2, running: false, stop: false };
  async function renderSaved() {
    if (!cacheOk) { $("savedRow").textContent = "This browser cannot keep pictures on the device."; $("saveGo").disabled = true; return; }
    const [auto, saved] = await Promise.all([cacheStats(CACHE_AUTO), cacheStats(CACHE_SAVED)]), places = load("wanderers.skySaved", []);
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    $("savedRow").textContent =
      `Recent: ${auto.n ? `${auto.n} pictures, ${SkyView.fmtBytes(auto.bytes)} (cleared after 7 days)` : "none"}. ` +
      `Saved places: ${saved.n ? (places.map((p) => `latitude ${SkyView.fmtLat(p.lat)}, ${DETAIL[p.order]}${p.survey === "infrared" ? ", infrared" : ""}, saved ${day(p.savedAt)}`).join("; ") || "a save that is not finished") + ` (${saved.n} pictures, ${SkyView.fmtBytes(saved.bytes)})` : "none"}.`;
    $("removeSaved").hidden = !saved.n; $("clearAuto").disabled = !auto.n;
    seg("saveSeg", "order", SAVE.order);
    planSave();
  }
  function saveLat() {
    const t = $("savePlace").value.trim();
    if (!t) return C.loc().lat;
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m && Math.abs(+m[0]) <= 90 ? +m[0] : null;
  }
  async function planSave() {
    const lat = saveLat();
    if (lat == null) { $("savePlan").textContent = "Type a latitude between -90 and 90, or coordinates like 47.62, -122.35."; return null; }
    const plan = planFor(lat, SAVE.order, R.survey), est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
    $("savePlan").textContent = `Latitude ${SkyView.fmtLat(lat)}, ${R.survey === "infrared" ? "Infrared" : "Visible"}: ${plan.tiles} pictures, about ${SkyView.fmtBytes(plan.bytes)}` +
      ` (${Math.round(Hips.skyShare(lat) * 100)}% of the whole sky). It also works anywhere near this latitude, on any night.` +
      (est && est.quota ? ` Free space here: ${SkyView.fmtBytes(Math.max(0, est.quota - (est.usage || 0)))}.` : "");
    return { lat, plan };
  }
  async function saveSky() {
    if (SAVE.running) return;
    const got = await planSave(); if (!got) return;
    const { lat, plan } = got, net = navigator.connection, survey = R.survey;
    if (net && (net.saveData || net.type === "cellular") && !SAVE.askedData) {   // ask once (a page dialog may be blocked)
      SAVE.askedData = true; $("saveMsg").textContent = `This uses about ${SkyView.fmtBytes(plan.bytes)} of mobile data. Press Save again to go ahead.`; return;
    }
    SAVE.running = true; SAVE.stop = false; $("saveGo").disabled = true; $("saveStop").hidden = false;
    const cache = await caches.open(CACHE_SAVED), urls = [ALADIN_URL, ...plan.urls], total = urls.length;
    let next = 0, done = 0, row = 0, halted = "";
    const failed = [], recent = await caches.open(CACHE_AUTO);
    const say = () => { $("saveMsg").textContent = `${done} of ${total} pictures`; };
    const worker = async () => {
      while (next < total && !SAVE.stop && !halted) {
        const u = urls[next++];
        try {
          if (!(await cache.match(u))) {
            const r = await fetch(u, { mode: "cors", credentials: "omit" });
            if (r.ok) await cache.put(u, r);
            else if (/Npix\d+\.jpg$/.test(u)) throw new Error(String(r.status));   // only the tiles are required
          }
          done++; row = 0; say();
        } catch { failed.push(u); if (++row >= 3) halted = "The archive is not answering. Your saved pictures are kept. Try again later."; }
      }
    };
    say();
    await Promise.all([1, 2, 3, 4].map(worker));
    if (failed.length && !halted && !SAVE.stop) { urls.push(...failed.splice(0)); row = 0; await Promise.all([1, 2].map(worker)); }
    await new Promise((r) => setTimeout(r, 400));   // a saved picture needs no "recent" copy from the service worker
    for (const u of urls) if (await cache.match(u)) await recent.delete(u, { ignoreVary: true });
    SAVE.running = false; $("saveGo").disabled = false; $("saveStop").hidden = true;
    if (done === total) {
      const same = (p) => Math.round(p.lat) === Math.round(lat) && p.order === SAVE.order && (p.survey || "visible") === survey;
      const places = load("wanderers.skySaved", []).filter((p) => !same(p));
      places.push({ lat, order: SAVE.order, survey, tiles: plan.tiles, savedAt: new Date().toISOString() });
      store("wanderers.skySaved", places);
      const kept = navigator.storage && navigator.storage.persist ? await navigator.storage.persist().catch(() => false) : false;
      $("saveMsg").textContent = `Saved for latitude ${SkyView.fmtLat(lat)}.` + (kept ? "" :
        " On an iPhone, add this page to the Home Screen, or Safari may delete saved pictures after 7 days without a visit.");
    } else $("saveMsg").textContent = halted || (SAVE.stop ? `Paused at ${done} of ${total}. Press Save to carry on from here.`
      : `${total - done} of ${total} pictures could not be fetched. Press Save to try those again.`);
    renderSaved();
  }

  // ---------- self-check: do the photographs and the canvas put stars on the same pixel? ----------
  function selfTest() {
    const { P, f, W, H, now, L } = LAST, proj = projector(P, f, W, H), box = $("skyDeep").getBoundingClientRect(), rows = [];
    const bright = EYE.stars ? EYE.stars.slice(0, 400).map((s) => ({ name: s[7] || "star", ra: s[0], dec: s[1] })) : [];
    for (const o of [...bright, ...planetsNow(now)]) {
      const s = Sky.observe(o, now, L.lat, L.lon), q = proj(vec(s.az, s.alt));
      // Near the horizon refraction lifts the drawn stars (by 0.5° at the horizon); the photographs cannot follow that.
      if (s.alt < 5) continue;
      if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H) continue;
      const a = DEEP.aladin.world2pix(o.ra, o.dec); if (!a) continue;
      const ax = a[0] + box.left, ay = a[1] + box.top;
      rows.push({ name: o.name, canvas: [Math.round(q[0]), Math.round(q[1])], aladin: [Math.round(ax), Math.round(ay)], off: +Math.hypot(ax - q[0], ay - q[1]).toFixed(1) });
    }
    return { worst: Math.max(0, ...rows.map((r) => r.off)), stars: rows, roll: +rollOf(P).toFixed(1), fov: DEEP.aladin.getFov(), base: DEEP.base,
      pxPerDeg: +(f * Math.tan(D2R)).toFixed(1) };
  }

  // ---------- wiring ----------
  function init(ctx) {
    C = ctx;
    $("skySeg").querySelectorAll("button").forEach((b) => (b.onclick = () => setSky(b.dataset.sky)));
    $("limitSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { R.limit = b.dataset.limit; store("wanderers.skyLimit", R.limit); EYE.key = ""; setSky(R.sky); }));
    $("surveySeg").querySelectorAll("button").forEach((b) => (b.onclick = () => setSurvey(b.dataset.survey)));
    $("linesBtn").onclick = () => { R.lines = !R.lines; store("wanderers.skyLines", R.lines); setSky(R.sky); };
    $("mix").oninput = (e) => { R.mix = e.target.value / 100; store("wanderers.skyMix", R.mix); $("skyDeep").style.opacity = R.mix; };
    $("skyCardClose").onclick = () => showCard(null);
    $("dragSky").onclick = startDrag;
    $("dragDone").onclick = () => endDrag(true);
    $("dragCancel").onclick = () => endDrag(false);
    $("saveGo").onclick = saveSky;
    $("saveStop").onclick = () => { SAVE.stop = true; };
    $("savePlace").oninput = planSave;
    $("saveSeg").querySelectorAll("button").forEach((b) => (b.onclick = () => { SAVE.order = +b.dataset.order; renderSaved(); }));
    $("clearAuto").onclick = async () => { await caches.delete(CACHE_AUTO); renderSaved(); };
    $("removeSaved").onclick = async () => { await caches.delete(CACHE_SAVED); store("wanderers.skySaved"); $("saveMsg").textContent = ""; renderSaved(); };
    $("skyCredit").textContent = [SkyView.CREDITS.eye, SkyView.CREDITS.deep, SkyView.CREDITS.infrared].join(" ");

    // Gestures on the AR canvas. Registered before compass.js's own drag-to-look, so "drag the sky" can take them.
    let grab = null, tap = null;
    const hud = $("hud");
    hud.addEventListener("pointerdown", (e) => {
      tap = { x: e.clientX, y: e.clientY, t: Date.now() };
      if (!R.calDrag || !LAST) return;
      e.stopImmediatePropagation(); hud.setPointerCapture(e.pointerId);
      const W = innerWidth, H = innerHeight;
      const P0 = C.pose();
      grab = { P0, A: 0, T: 0, v: unproject(P0, C.focal(W, H), W, H, e.clientX, e.clientY), fine: [C.F.fineAz, C.F.fineAlt], manual: { ...C.S.manual } };
    });
    hud.addEventListener("pointermove", (e) => { if (grab) { e.stopImmediatePropagation(); follow(grab, e.clientX, e.clientY); } });
    hud.addEventListener("pointerup", (e) => {
      if (grab) { e.stopImmediatePropagation(); grab = null; }
      if (tap && Date.now() - tap.t < 600 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8) onTap(e.clientX, e.clientY);
      tap = null;
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    setSky(R.sky);
  }

  const api = { init, draw, setSky, renderSaved, R, DEEP, EYE, CON, SAVE, selfTest, pickAt, onTap, rollOf, surveyOf, projector };
  root.RealSky = api;
})(window);
