/* Long-range view for the Star database tab: where a star goes over thousands of years.
 * Three linked views driven by one year slider:
 *   1. Sky globe: orthographic view of the celestial sphere with a curved RA/Dec grid and real background
 *      stars; the path bends as a great circle and its 1,000-year ticks spread out as the star speeds up.
 *   2. 3D map: the Sun (and Earth, 1 AU away, the same point at this scale) at the centre, the star's path
 *      through space, its closest approach, and the nearby stars of the database. Drag to rotate, scroll to zoom.
 *   3. Distance through time, with apparent brightness.
 * Maths in starcore.js; this file only draws. Uncertainty: Monte Carlo cloud from the starting state's errors.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const C = StarCore;
  const NOW = 2000 + (Date.now() / 86400000 + 2440587.5 - 2451545) / 365.25;   // current Julian year
  const LR = { st: null, row: null, stars: [], span: 10000, year: NOW + 5000, clones: [], view: { yaw: -0.6, pitch: 0.45, zoom: 1 }, timer: null };

  // ---------- canvas helpers ----------
  function ctx(id) {
    const c = $(id), r = window.devicePixelRatio || 1, w = c.clientWidth || c.width, h = Math.round(w * (+c.dataset.aspect || 0.62));
    if (c.width !== Math.round(w * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); c.style.height = h + "px"; }
    const g = c.getContext("2d"); g.setTransform(r, 0, 0, r, 0, 0);
    return { g, w, h };
  }
  // Labels are queued while drawing and placed afterwards, most important first; a label that would overlap
  // one already placed is skipped, so markers win over ticks and ticks over background star names.
  function labeler(g, w, h) {
    const q = [];
    return {
      add: (text, x, y, color, prio = 1, font = "11px system-ui") => q.push({ text, x, y, color, prio, font }),
      flush(boxes = []) {
        const placed = boxes.slice();
        for (const L of q.sort((a, b) => b.prio - a.prio)) {
          g.font = L.font; const tw = g.measureText(L.text).width, r = { x: L.x, y: L.y - 11, w: tw, h: 14 };
          if (r.x < 0 || r.x + r.w > w || r.y < 0 || r.y + r.h > h) continue;
          if (placed.some((b) => r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h)) continue;
          placed.push(r); g.fillStyle = L.color; g.fillText(L.text, L.x, L.y);
        }
      },
    };
  }
  // Tick years that read as round calendar years: 2000 CE, 4000 BCE (astronomical year 1 - 4000).
  function ticks(y0, y1, step) {
    const out = [];
    for (let k = Math.floor(y0 / step) - 1; k * step <= y1 + step; k++) {
      const cal = k * step, astro = cal > 0 ? cal : cal + 1;
      if (cal !== 0 && astro >= y0 && astro <= y1) out.push({ astro, label: cal > 0 ? `${cal}` : `${-cal} BCE` });
    }
    return out;
  }
  const COL = { past: "#7cc4ff", future: "#7ee787", now: "#ffb547", sel: "#ff7bd5", ca: "#ffd166", grid: "rgba(124,196,255,.16)", text: "#c9d4e8", mut: "#8d9bb8" };

  // ---------- public entry ----------
  function show(pred, row, stars) {
    LR.row = row; LR.stars = stars || [];
    const s0 = C.startState(pred, row);
    $("lrWarn").innerHTML = (s0.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
    if (!s0.star) { $("starLong").hidden = false; $("lrBody").hidden = true; return; }
    LR.st = s0; LR.clones = C.samples(s0.star, s0.err, 300, 7);
    LR.ca = C.closestApproach(s0.star);
    LR.today = C.propagate(s0.star, NOW);
    $("lrBody").hidden = false; $("starLong").hidden = false;
    $("lrSrc").textContent = `Start: position and motion ${s0.sources.motion}; parallax ${s0.sources.parallax}; radial velocity ${s0.sources.rv}.`;
    // first view may come from the link: &span=20000&sky=radec&year=11736
    const q = new URLSearchParams(location.search), first = !LR.urlDone; LR.urlDone = true;
    if (first && [...$("lrSpan").options].some((o) => o.value === q.get("span"))) $("lrSpan").value = q.get("span");
    if (first && ["globe", "radec"].includes(q.get("sky"))) $("lrProj").value = q.get("sky");
    setSpan(+$("lrSpan").value || 10000, true);
    if (first && Number.isFinite(+q.get("year")) && q.get("year")) { LR.year = Math.min(+$("lrYear").max, Math.max(+$("lrYear").min, +q.get("year"))); $("lrYear").value = LR.year; render(); }
  }

  function setSpan(span, resetYear) {
    LR.span = span;
    const sl = $("lrYear");
    sl.min = Math.round(NOW - span); sl.max = Math.round(NOW + span); sl.step = Math.max(1, Math.round(span / 500));
    if (resetYear || LR.year < +sl.min || LR.year > +sl.max) LR.year = NOW + span / 2;
    sl.value = LR.year;
    LR.path = C.track(LR.st.star, NOW - span, NOW + span, 400);
    render();
  }

  function render() {
    const s = LR.st.star, at = C.propagate(s, LR.year), sp = C.spreadAt(LR.clones, LR.year);
    $("lrYearLbl").textContent = C.fmtYear(LR.year);
    drawSky(at, sp); draw3d(at); drawDist(at);
    const m0 = LR.row && LR.row.mag, ca = LR.ca;
    const mag = C.magAt(m0, LR.today.distLy, at.distLy), caMag = ca && C.magAt(m0, LR.today.distLy, ca.distLy);
    const rows = [
      [`In ${C.fmtYear(LR.year)}`, `RA ${StarDB.hms(at.ra)} · Dec ${StarDB.dms(at.dec)}`],
      ["Distance", `${at.distLy.toFixed(2)} light-years (68%: ${sp.dist16.toFixed(2)}–${sp.dist84.toFixed(2)})` + (mag != null ? ` · would look V ≈ ${mag.toFixed(1)} (today ${m0})` : "")],
      ["Moved on the sky since today", C.fmtAngle(C.separationArcsec(LR.today, at)) + ` · uncertainty ±${C.fmtAngle(sp.sky68)} (68%)`],
      ["Seen moving at", `${(Math.hypot(at.pmra, at.pmdec) / 1000).toFixed(2)}″/yr across the sky (today ${(Math.hypot(LR.today.pmra, LR.today.pmdec) / 1000).toFixed(2)}″/yr)`],
      ["Speed through space", `${at.speedKms.toFixed(0)} km/s relative to the Sun (radial ${at.rv >= 0 ? "+" : ""}${at.rv.toFixed(1)} km/s: ${at.rv < 0 ? "approaching" : "receding"})`],
      ["Closest to the Sun", ca ? `${C.fmtYear(ca.year)} at ${ca.distLy.toFixed(2)} light-years` + (caMag != null ? ` (V ≈ ${caMag.toFixed(1)})` : "") + (ca.year < NOW ? " — already passed; it is moving away" : "") : "—"],
    ];
    $("lrCard").innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  }

  // ---------- 1. sky globe ----------
  function drawSky(at, sp) {
    const { g, w, h } = ctx("lrSky");
    const P = LR.path, ctr = C.centre(P), radec = $("lrProj").value === "radec";
    // Globe: orthographic view of the sphere. RA/Dec chart: RA and Dec as straight axes (east left), where the
    // great-circle track shows as the curve familiar from star atlases.
    const wrap = (d) => ((d + 540) % 360) - 180;
    const pr = radec ? (ra, dec) => ({ x: -wrap(ra - ctr.ra), y: dec - ctr.dec, front: true }) : (ra, dec) => C.ortho(ra, dec, ctr.ra, ctr.dec);
    const pts = P.map((p) => pr(p.ra, p.dec));
    let span = Math.max(...pts.map((q) => Math.max(Math.abs(q.x), Math.abs(q.y))), 0.02);
    span = Math.max(span * 1.15, sp.sky68 / 3600 * 1.5);
    const k = Math.min(w, h) / 2 / span, X = (q) => w / 2 + q.x * k, Y = (q) => h / 2 - q.y * k;
    g.fillStyle = "#03060d"; g.fillRect(0, 0, w, h);
    const lab = labeler(g, w, h);

    // RA/Dec grid: drawn as true curves of the sphere
    const step = C.gridStep(2 * span), fieldR = span * Math.SQRT2 * 1.2;
    g.strokeStyle = COL.grid; g.lineWidth = 1; g.fillStyle = COL.mut; g.font = "11px ui-monospace, monospace";
    const decLo = Math.max(-90, ctr.dec - fieldR), decHi = Math.min(90, ctr.dec + fieldR);
    const raHalf = radec ? fieldR : Math.min(180, fieldR / Math.max(Math.cos(Math.min(89, Math.abs(ctr.dec) + fieldR) * C.DEG), 0.02));
    const raStep = radec ? step : C.gridStep(2 * span / Math.max(Math.cos(ctr.dec * C.DEG), 0.05));
    const line = (fn, n) => { g.beginPath(); let on = false; for (let i = 0; i <= n; i++) { const q = fn(i / n); if (!q.front) { on = false; continue; } on ? g.lineTo(X(q), Y(q)) : g.moveTo(X(q), Y(q)); on = true; } g.stroke(); };
    for (let d = Math.ceil(decLo / step) * step; d <= decHi; d += step) {
      line((f) => pr(ctr.ra - raHalf + 2 * raHalf * f, d), 120);
      const q = pr(ctr.ra + raHalf * 0.98, d); if (q.front) lab.add(fmtDeg(d), Math.max(4, X(q)) + 2, Y(q) - 3, COL.mut, 1, "11px ui-monospace, monospace");
    }
    for (let a = Math.ceil((ctr.ra - raHalf) / raStep) * raStep; a <= ctr.ra + raHalf; a += raStep) {
      line((f) => pr(a, decLo + (decHi - decLo) * f), 120);
      const q = pr(a, decLo + 0.02 * (decHi - decLo)); if (q.front) lab.add(fmtRa(a), X(q) + 3, Math.min(h - 22, Y(q)), COL.mut, 1, "11px ui-monospace, monospace");
    }

    // background stars from the database (positions at 2000), brighter limit for wider fields
    const lim = span > 15 ? 4 : span > 4 ? 5.5 : 7;
    for (const s of LR.stars) {
      if (s.mag == null || s.mag > lim || s === LR.row) continue;
      const q = pr(s.ra, s.dec); if (!q.front || Math.abs(q.x) > span * 1.3 || Math.abs(q.y) > span * 1.3) continue;
      const r = Math.max(0.6, 3.2 - 0.45 * (s.mag + 1));
      g.fillStyle = "rgba(230,237,247,.8)"; g.beginPath(); g.arc(X(q), Y(q), r, 0, 7); g.fill();
      if (s.mag < 3 && /^[A-Z][a-z]/.test(s.name) && !/^(HIP|Gl|HD|HR) /.test(s.name)) lab.add(s.name, X(q) + 5, Y(q) + 4, COL.mut, 2 - s.mag / 10);
    }

    // the path: past solid, future dashed; ticks with year labels
    const split = P.findIndex((p) => p.year >= NOW);
    const poly = (a, b, col, dash) => { g.strokeStyle = col; g.lineWidth = 2.2; g.setLineDash(dash); g.beginPath(); pts.slice(a, b).forEach((q, i) => (i ? g.lineTo(X(q), Y(q)) : g.moveTo(X(q), Y(q)))); g.stroke(); g.setLineDash([]); };
    poly(0, split + 1, COL.past, []); poly(split, pts.length, COL.future, [7, 5]);
    const tick = [500, 1000, 2000, 5000, 10000].find((t) => (2 * LR.span) / t <= 12) || 10000;
    for (const t of ticks(NOW - LR.span, NOW + LR.span, tick)) {
      const p = C.propagate(LR.st.star, t.astro), q = pr(p.ra, p.dec); if (!q.front) continue;
      g.fillStyle = t.astro < NOW ? COL.past : COL.future; g.fillRect(X(q) - 2, Y(q) - 2, 4, 4);
      lab.add(t.label, X(q) + 7, Y(q) + 12, COL.text, 5, "11px ui-monospace, monospace");
    }
    // uncertainty cloud at the selected year
    g.fillStyle = "rgba(255,123,213,.28)";
    for (const p of sp.points) { const q = pr(p.ra, p.dec); if (q.front) g.fillRect(X(q) - 1, Y(q) - 1, 2, 2); }
    const mark = (p, col, label, r, prio) => { const q = pr(p.ra, p.dec); if (!q.front) return; g.fillStyle = col; g.beginPath(); g.arc(X(q), Y(q), r, 0, 7); g.fill(); lab.add(label, X(q) - g.measureText(label).width - 16, Y(q) + 4, col, prio, "bold 12px system-ui"); };
    if (LR.ca && LR.ca.year > NOW - LR.span && LR.ca.year < NOW + LR.span) mark(LR.ca, COL.ca, "closest to Sun", 4, 8);
    mark(LR.today, COL.now, "today", 5, 9); mark(at, COL.sel, C.fmtYear(LR.year), 5, 10);
    const foot = `N ↑  E ←  ·  ${radec ? `${(2 * span).toFixed(1)}° of RA/Dec shown` : `field ${C.fmtAngle(2 * span * 3600)} across`}  ·  stars to V ${lim}`;
    g.font = "11px system-ui"; const fw = g.measureText(foot).width;
    g.fillStyle = "rgba(3,6,13,.85)"; g.fillRect(0, h - 22, fw + 16, 22); g.fillStyle = COL.mut; g.fillText(foot, 8, h - 8);
    lab.flush([{ x: 0, y: h - 22, w: fw + 16, h: 22 }]);
  }
  const fmtDeg = (d) => (Math.abs(d - Math.round(d)) < 1e-6 ? `${d >= 0 ? "+" : ""}${Math.round(d)}°` : `${d >= 0 ? "+" : "−"}${Math.floor(Math.abs(d))}°${Math.round((Math.abs(d) % 1) * 60)}′`);
  const fmtRa = (a) => { const hr = (((a % 360) + 360) % 360) / 15, H = Math.floor(hr + 1e-9), m = Math.round((hr - H) * 60); return m === 60 ? `${H + 1}h` : m ? `${H}h${m}m` : `${H}h`; };

  // ---------- 2. 3D map ----------
  function draw3d(at) {
    const { g, w, h } = ctx("lr3d"), V = LR.view;
    const path = LR.path.map((p) => p.xyzLy);
    const R = Math.max(...path.map((p) => Math.hypot(...p)), at.distLy, 1) * 1.15;
    const cy = Math.cos(V.yaw), sy = Math.sin(V.yaw), cp = Math.cos(V.pitch), spch = Math.sin(V.pitch);
    const rot = ([x, y, z]) => { const x1 = x * cy - y * sy, y1 = x * sy + y * cy; return [x1, y1 * cp - z * spch, y1 * spch + z * cp]; };  // [screen x, depth, screen up]
    const s = Math.min(w, h) / 2 / R * V.zoom, D = 4 * R;
    const P = (p) => { const [x, d, z] = rot(p), f = D / (D + d); return { x: w / 2 + x * s * f, y: h / 2 - z * s * f, d }; };
    g.fillStyle = "#03060d"; g.fillRect(0, 0, w, h);
    const lab = labeler(g, w, h);

    // equatorial-plane rings and axes
    const ringStep = [1, 2, 5, 10, 20, 50, 100].find((r) => R / r <= 4) || 100;
    g.font = "11px system-ui";
    for (let r = ringStep; r <= R; r += ringStep) {
      g.strokeStyle = "rgba(124,196,255,.14)"; g.beginPath();
      for (let i = 0; i <= 96; i++) { const a = i / 96 * 2 * Math.PI, q = P([r * Math.cos(a), r * Math.sin(a), 0]); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }
      g.stroke(); const q = P([r, 0, 0]); lab.add(`${r} ly`, q.x + 3, q.y - 3, COL.mut, 2);
    }
    const axis = (v, label) => { const o = P([0, 0, 0]), q = P(v.map((c) => c * R)); g.strokeStyle = "rgba(201,212,232,.25)"; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(q.x, q.y); g.stroke(); g.setLineDash([]); lab.add(label, q.x + 4, q.y, COL.mut, 1); };
    axis([1, 0, 0], "toward RA 0h"); axis([0, 1, 0], "RA 6h"); axis([0, 0, 1], "north celestial pole");

    // nearby stars of the database, for scale (positions at 2000)
    // the 150 nearest database stars inside the view, for scale; names only for the 12 nearest named ones
    const near = LR.stars.filter((x) => x.dist_pc && x.dist_pc * C.LY <= R && x !== LR.row).sort((a, b) => a.dist_pc - b.dist_pc).slice(0, 150);
    let named = 0;
    for (const x of near) {
      const u = C.basis(x.ra, x.dec).u, d = x.dist_pc * C.LY, q = P(u.map((c) => c * d));
      g.fillStyle = "rgba(230,237,247,.55)"; g.beginPath(); g.arc(q.x, q.y, 1.8, 0, 7); g.fill();
      if (named < 12 && /^[A-Z][a-z]/.test(x.name) && !/^(HIP|Gl|HD|HR) /.test(x.name)) { named++; lab.add(x.name, q.x + 4, q.y - 3, "rgba(141,155,184,.85)", 3 - x.dist_pc / 100); }
    }

    // the Sun (Earth is 1 AU from it: 0.000016 ly, the same point at this scale)
    const sun = P([0, 0, 0]);
    g.fillStyle = "#ffd166"; g.beginPath(); g.arc(sun.x, sun.y, 6, 0, 7); g.fill();
    lab.add("Sun · Earth", sun.x + 9, sun.y + 4, "#ffe8a3", 9, "bold 12px system-ui");

    // star path through space, coloured past -> future, with drop lines to the equatorial plane
    const n = path.length, split = LR.path.findIndex((p) => p.year >= NOW);
    for (let i = 1; i < n; i++) {
      const a = P(path[i - 1]), b = P(path[i]); g.strokeStyle = i <= split ? COL.past : COL.future; g.lineWidth = 2.2;
      g.setLineDash(i <= split ? [] : [6, 4]); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    g.setLineDash([]);
    const drop = (xyz, col) => { const a = P(xyz), b = P([xyz[0], xyz[1], 0]); g.strokeStyle = col; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.globalAlpha = 1; };
    const dot = (xyz, col, label, r, prio) => { const q = P(xyz); drop(xyz, col); g.fillStyle = col; g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.fill(); lab.add(label, q.x + 8, q.y - 7, col, prio, "bold 12px system-ui"); };
    if (LR.ca && LR.ca.year > NOW - LR.span && LR.ca.year < NOW + LR.span) dot(LR.ca.xyzLy, COL.ca, `closest ${C.fmtYear(LR.ca.year)}`, 4, 7);
    dot(LR.today.xyzLy, COL.now, "today", 5, 8);
    // the selected year, with the line of sight from the Sun and its distance
    const q = P(at.xyzLy);
    g.strokeStyle = COL.sel; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(sun.x, sun.y); g.lineTo(q.x, q.y); g.stroke(); g.setLineDash([]);
    dot(at.xyzLy, COL.sel, `${C.fmtYear(LR.year)} · ${at.distLy.toFixed(2)} ly`, 6, 10);
    const foot = "Drag to rotate · scroll to zoom · double-click to reset"; g.font = "11px system-ui";
    const fw = g.measureText(foot).width; g.fillStyle = "rgba(3,6,13,.85)"; g.fillRect(0, h - 22, fw + 16, 22); g.fillStyle = COL.mut; g.fillText(foot, 8, h - 8);
    lab.flush([{ x: 0, y: h - 22, w: fw + 16, h: 22 }]);
  }

  // ---------- 3. distance through time ----------
  function drawDist(at) {
    const { g, w, h } = ctx("lrDist"), pad = { l: 46, r: 12, t: 10, b: 24 };
    const P = LR.path, ys = P.map((p) => p.distLy), lo = Math.min(...ys) * 0.95, hi = Math.max(...ys) * 1.05;
    const X = (y) => pad.l + (y - P[0].year) / (P[P.length - 1].year - P[0].year) * (w - pad.l - pad.r), Y = (d) => h - pad.b - (d - lo) / (hi - lo || 1) * (h - pad.t - pad.b);
    g.fillStyle = "#03060d"; g.fillRect(0, 0, w, h);
    g.fillStyle = COL.mut; g.font = "11px ui-monospace, monospace"; g.strokeStyle = COL.grid;
    for (let i = 0; i <= 3; i++) { const d = lo + (hi - lo) * i / 3; g.beginPath(); g.moveTo(pad.l, Y(d)); g.lineTo(w - pad.r, Y(d)); g.stroke(); g.fillText(d.toFixed(d < 10 ? 2 : 1), 4, Y(d) + 4); }
    for (const y of [P[0].year, NOW, P[P.length - 1].year]) g.fillText(C.fmtYear(y), Math.min(w - 80, Math.max(pad.l, X(y) - 30)), h - 6);
    g.save(); g.translate(12, pad.t + 40); g.restore();
    g.lineWidth = 2; g.strokeStyle = COL.future; g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(X(p.year), Y(p.distLy)) : g.moveTo(X(p.year), Y(p.distLy)))); g.stroke();
    const mk = (y, d, col, r) => { g.fillStyle = col; g.beginPath(); g.arc(X(y), Y(d), r, 0, 7); g.fill(); };
    if (LR.ca && LR.ca.year > P[0].year && LR.ca.year < P[P.length - 1].year) mk(LR.ca.year, LR.ca.distLy, COL.ca, 4);
    mk(NOW, LR.today.distLy, COL.now, 4); mk(LR.year, at.distLy, COL.sel, 5);
    g.fillStyle = COL.text; g.fillText("light-years from the Sun", pad.l + 6, pad.t + 12);
  }

  // ---------- controls ----------
  $("lrSpan").onchange = (e) => setSpan(+e.target.value, true);
  $("lrProj").onchange = () => render();
  $("lrYear").oninput = (e) => { LR.year = +e.target.value; render(); };
  $("lrPlay").onclick = () => {
    if (LR.timer) { clearInterval(LR.timer); LR.timer = null; $("lrPlay").textContent = "▶ Play"; return; }
    $("lrPlay").textContent = "❚❚ Pause";
    if (LR.year >= NOW + LR.span - 1) LR.year = NOW - LR.span;
    LR.timer = setInterval(() => {
      LR.year = Math.min(NOW + LR.span, LR.year + LR.span / 150); $("lrYear").value = LR.year; render();
      if (LR.year >= NOW + LR.span) $("lrPlay").click();
    }, 50);
  };
  const c3 = $("lr3d"); let drag = null;
  c3.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, yaw: LR.view.yaw, pitch: LR.view.pitch }; c3.setPointerCapture(e.pointerId); };
  c3.onpointermove = (e) => { if (!drag) return; LR.view.yaw = drag.yaw - (e.clientX - drag.x) * 0.01; LR.view.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch + (e.clientY - drag.y) * 0.01)); render(); };
  c3.onpointerup = () => (drag = null);
  c3.onwheel = (e) => { e.preventDefault(); LR.view.zoom = Math.max(0.3, Math.min(8, LR.view.zoom * (e.deltaY < 0 ? 1.12 : 0.89))); render(); };
  c3.ondblclick = () => { LR.view = { yaw: -0.6, pitch: 0.45, zoom: 1 }; render(); };
  c3.onkeydown = (e) => {
    const m = { ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[e.key];
    if (!m) return; e.preventDefault(); LR.view.yaw += m[0]; LR.view.pitch = Math.max(-1.5, Math.min(1.5, LR.view.pitch + m[1])); render();
  };
  window.addEventListener("resize", () => LR.st && LR.st.star && render());

  window.LongRange = { show, NOW };
})();
