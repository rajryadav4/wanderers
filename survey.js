/* WANDERERS Sky Survey page (app/survey.html).
 * Reads data/survey/summary.json and data/survey/leaderboard.json (shapes: docs/survey-contract.md) and shows the
 * scale of the automated search, an all-sky map of the tiles searched, how the search was validated, the ranked
 * candidates and, for one candidate, its NEOWISE track, a live Aladin Lite view and ways to investigate it.
 * The pure helpers (HEALPix, projection, formatting, filters, track plot) are shared with the Node tests as
 * SurveyCore: require("app/survey.js") in Node, window.SurveyCore in the page. */
(function (root) {
  "use strict";
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // ---------- HEALPix, nested scheme (Gorski et al. 2005), as in healpix_base xyf2loc ----------
  const NSIDE = 32, N_TILES = 12 * NSIDE * NSIDE, TILE_AREA_DEG2 = 41252.96124941928 / N_TILES;
  const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
  function compress(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> (2 * i)) & 1) << i; return r; }
  // x, y: position across a base face, 0..1 each. Returns degrees.
  function xyf2ang(x, y, face) {
    const jr = JRLL[face] - x - y;
    let nr, z;
    if (jr < 1) { nr = jr; z = 1 - (nr * nr) / 3; }
    else if (jr > 3) { nr = 4 - jr; z = (nr * nr) / 3 - 1; }
    else { nr = 1; z = ((2 - jr) * 2) / 3; }
    let t = JPLL[face] * nr + x - y;
    if (t < 0) t += 8;
    if (t >= 8) t -= 8;
    const phi = nr < 1e-15 ? 0 : (Math.PI / 4) * t / nr;
    return { ra: ((phi * R2D) % 360 + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, z))) * R2D };
  }
  function faceXY(k, nside) {
    const n2 = nside * nside, face = Math.floor(k / n2), p = k % n2;
    return { face, ix: compress(p), iy: compress(p >>> 1) };
  }
  // Centre of nested pixel k (default: order 5, nside 32, the survey's tiles).
  function pix2ang(k, nside = NSIDE) {
    const { face, ix, iy } = faceXY(k, nside);
    return xyf2ang((ix + 0.5) / nside, (iy + 0.5) / nside, face);
  }
  // A point inside tile k: fx, fy run 0..1 across it (0.5, 0.5 is the centre)
  function tilePoint(k, fx, fy, nside = NSIDE) {
    const { face, ix, iy } = faceXY(k, nside);
    return xyf2ang((ix + fx) / nside, (iy + fy) / nside, face);
  }
  // The four corners, in the order north, west, south, east (as astropy_healpix boundaries_lonlat with step=1).
  function corners(k, nside = NSIDE) {
    const { face, ix, iy } = faceXY(k, nside);
    return [[1, 1], [0, 1], [0, 0], [1, 0]].map(([dx, dy]) => xyf2ang((ix + dx) / nside, (iy + dy) / nside, face));
  }

  // ---------- all-sky map: Hammer equal-area projection, RA 0h in the middle, east (RA increasing) to the left ----------
  const MAP_W = 1000, MAP_H = 500, MAP_A = 490, MAP_B = 245;
  const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  // lon: degrees east of the centre meridian (may run a little past ±180 for a tile on the edge), lat: degrees
  function hammerXY(lon, lat) {
    const l = -lon * D2R, b = lat * D2R, d = Math.sqrt(1 + Math.cos(b) * Math.cos(l / 2));
    return [(2 * Math.SQRT2 * Math.cos(b) * Math.sin(l / 2)) / d, (Math.SQRT2 * Math.sin(b)) / d];
  }
  const toPx = ([X, Y]) => [MAP_W / 2 + (MAP_A * X) / (2 * Math.SQRT2), MAP_H / 2 - (MAP_B * Y) / Math.SQRT2];
  const project = (ra, dec) => toPx(hammerXY(wrap180(ra), dec));
  // A tile as a polygon that never jumps across the map edge: corners are unwrapped around the tile centre.
  function tilePolygon(k) {
    const c = pix2ang(k), lc = wrap180(c.ra);
    return { centre: toPx(hammerXY(lc, c.dec)), poly: corners(k).map((p) => toPx(hammerXY(lc + wrap180(p.ra - c.ra), p.dec))) };
  }
  // Galactic plane and ecliptic as RA/Dec lines (IAU J2000 rotation; obliquity 23.4393°)
  const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.44482963, 0.7469822445], [-0.867666149, -0.1980763734, 0.4559837762]];
  const radec = (x, y, z) => ({ ra: ((Math.atan2(y, x) * R2D) % 360 + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, z))) * R2D });
  function galToEq(l, b) {
    const v = [Math.cos(b * D2R) * Math.cos(l * D2R), Math.cos(b * D2R) * Math.sin(l * D2R), Math.sin(b * D2R)];
    return radec(GAL[0][0] * v[0] + GAL[1][0] * v[1] + GAL[2][0] * v[2], GAL[0][1] * v[0] + GAL[1][1] * v[1] + GAL[2][1] * v[2], GAL[0][2] * v[0] + GAL[1][2] * v[1] + GAL[2][2] * v[2]);
  }
  function eclToEq(lam) {
    const e = 23.4393 * D2R, l = lam * D2R;
    return radec(Math.cos(l), Math.sin(l) * Math.cos(e), Math.sin(l) * Math.sin(e));
  }
  // SVG path of a sky line given as RA/Dec points; breaks where the line crosses the map edge
  function skyPath(pts) {
    let d = "", prev = null;
    for (const p of pts) {
      const [x, y] = project(p.ra, p.dec);
      d += (prev && Math.abs(x - prev[0]) < MAP_W / 3 ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      prev = [x, y];
    }
    return d;
  }

  // ---------- formatting ----------
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  function fmtInt(n) {
    n = num(n);
    if (!Number.isFinite(n)) return "—";
    const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (n < 0 ? "−" : "") + s;
  }
  const trim0 = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  function fmtBig(n) {
    n = num(n);
    if (!Number.isFinite(n)) return "—";
    for (const [v, w] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]]) if (Math.abs(n) >= v) return `${trim0((n / v).toPrecision(3))} ${w}`;
    return fmtInt(n);
  }
  function fmtPct(f) {
    f = num(f);
    if (!Number.isFinite(f)) return "—";
    const p = f * 100;
    if (p === 0) return "0%";
    if (p < 1) return `${trim0(p.toPrecision(2))}%`;
    return `${trim0(p.toFixed(1))}%`;
  }
  function fmtHours(h) {
    h = num(h);
    if (!Number.isFinite(h)) return "—";
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
    if (h < 48) return `${trim0(h.toFixed(1))} hours`;
    return `${trim0((h / 24).toFixed(1))} days`;
  }
  const fmtFix = (v, d) => (fin(num(v)) ? num(v).toFixed(d) : "—");
  // mas/yr -> arcsec/yr text (no unit)
  const fmtPm = (mas) => (fin(num(mas)) ? (num(mas) / 1000).toFixed(num(mas) < 1000 ? 3 : 2) : "—");
  // Sexagesimal, rounded once (so 59.999 s becomes the next minute, never "60.00")
  function sexa(ra, dec) {
    const cs = Math.round(((((ra % 360) + 360) % 360) / 15) * 360000) % 8640000;   // centiseconds of time
    const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = (cs % 6000) / 100;
    const ds = Math.round(Math.abs(dec) * 36000), sg = dec < 0 && ds > 0 ? "-" : "+";   // deci-arcseconds
    const d = Math.floor(ds / 36000), dm = Math.floor((ds % 36000) / 600), dsec = (ds % 600) / 10;
    const p2 = (v) => String(v).padStart(2, "0");
    const raS = `${p2(h)}h${p2(m)}m${s.toFixed(2).padStart(5, "0")}s`, decS = `${sg}${p2(d)}d${p2(dm)}m${dsec.toFixed(1).padStart(4, "0")}s`;
    const pretty = `${p2(h)}ʰ ${p2(m)}ᵐ ${s.toFixed(2).padStart(5, "0")}ˢ  ${sg === "-" ? "−" : "+"}${p2(d)}° ${p2(dm)}′ ${dsec.toFixed(1).padStart(4, "0")}″`;
    return { ra: raS, dec: decS, pretty };
  }
  // Position angle of the motion, degrees east of north (0 = north, 90 = east)
  const posAngle = (pmra, pmdec) => ((Math.atan2(num(pmra), num(pmdec)) * R2D) % 360 + 360) % 360;
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (pa) => COMPASS[Math.round(pa / 45) % 8];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- candidates ----------
  const CLASSES = ["unexplained", "known (Gaia)", "likely artefact", "not checked"];
  const BADGE = { unexplained: "b-unex", "known (Gaia)": "b-known", "likely artefact": "b-art", "not checked": "b-nc" };
  // Red: W1−W2 ≥ 0.5 (cold brown dwarf colour), or seen in W2 but not at all in W1 (redder than can be measured).
  function isRed(m) {
    const c = num(m.w1w2);
    if (Number.isFinite(c)) return c >= 0.5;
    return !Number.isFinite(num(m.w1)) && Number.isFinite(num(m.w2));
  }
  function gaiaText(g) {
    if (!g || g.checked === false) return "Not checked";
    if (g.match) return fin(num(g.sep_arcsec)) ? `Match · ${num(g.sep_arcsec).toFixed(1)}″` : "Match";
    return "No match";
  }
  const gaiaRankOf = (g) => (!g || g.checked === false ? 2 : g.match ? 1 : 0);   // no match first: the interesting ones
  function applyFilters(rows, f) {
    const q = String(f.q || "").trim().toLowerCase(), minPm = (num(f.minPm) || 0) * 1000;
    return rows.filter((m) => (f.cls === "all" || !f.cls || m.class === f.cls)
      && (minPm <= 0 || num(m.pm) >= minPm)
      && (!f.red || isRed(m))
      && (f.tile === null || f.tile === undefined || num(m.k5) === f.tile)
      && (!q || String(m.id).toLowerCase().includes(q) || String((m.gaia && m.gaia.source_id) || "").includes(q)));
  }
  const SORTS = {
    rank: { get: (m) => num(m.rank), dir: 1 },
    id: { get: (m) => String(m.id), dir: 1 },
    class: { get: (m) => { const i = CLASSES.indexOf(m.class); return i < 0 ? 9 : i; }, dir: 1 },
    pm: { get: (m) => num(m.pm), dir: -1 },
    pa: { get: (m) => posAngle(m.pmra, m.pmdec), dir: 1 },
    visits: { get: (m) => num(m.n_visits), dir: -1 },
    w1w2: { get: (m) => num(m.w1w2), dir: -1 },
    gaia: { get: (m) => gaiaRankOf(m.gaia), dir: 1 },
    score: { get: (m) => num(m.score), dir: -1 },
  };
  // Sort a copy; missing values always last; ties keep the rank order.
  function sortRows(rows, key, dir) {
    const s = SORTS[key] || SORTS.rank, d = dir || s.dir;
    return rows.slice().sort((a, b) => {
      const x = s.get(a), y = s.get(b);
      const xm = typeof x === "number" ? !Number.isFinite(x) : x === "", ym = typeof y === "number" ? !Number.isFinite(y) : y === "";
      if (xm !== ym) return xm ? 1 : -1;
      if (!xm && x !== y) return (x < y ? -1 : 1) * d;
      return (num(a.rank) || 0) - (num(b.rank) || 0);
    });
  }

  // ---------- data shapes (tolerant: the producers may add or rename a little) ----------
  function normTiles(list) {
    return (Array.isArray(list) ? list : []).map((t) => (Array.isArray(t)
      ? { k5: num(t[0]), movers: num(t[1]) || 0, unexplained: num(t[2]) || 0 }
      : { k5: num(t && t.k5), movers: num(t && (t.movers ?? t.n_movers)) || 0, unexplained: num(t && t.unexplained) || 0 }))
      .filter((t) => Number.isInteger(t.k5) && t.k5 >= 0 && t.k5 < N_TILES);
  }
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  function normBins(list, unit) {
    return (Array.isArray(list) ? list : []).map((b) => {
      const lo = num(pick(b, ["lo", "min", "pm_min", "mag_min", "w2_min"])), hi = num(pick(b, ["hi", "max", "pm_max", "mag_max", "w2_max"]));
      const n = num(pick(b, ["n", "n_injected", "injected"])), rec = num(pick(b, ["recovered", "n_recovered", "found"]));
      let c = num(pick(b, ["completeness", "fraction", "frac"]));
      if (!Number.isFinite(c) && n > 0 && Number.isFinite(rec)) c = rec / n;
      const at = num(pick(b, ["pm", "mag", "w2", "x", "center"]));
      const u = (x) => (unit === "pm" ? trim0((x / 1000).toFixed(3)) : trim0(x.toFixed(1)));
      const label = b.label || (Number.isFinite(lo) && Number.isFinite(hi) ? `${u(lo)}–${u(hi)}` : Number.isFinite(at) ? u(at) : "");
      return { label, completeness: c, n, recovered: rec };
    }).filter((b) => Number.isFinite(b.completeness));
  }
  // A star checked twice (a small test cut-out and its full survey tile) is one star: keep the survey-tile check,
  // else the last one listed, at the place of the first, so "8 of 9 stars" counts stars, not checks.
  function oneRowPerStar(rows) {
    const at = new Map(), out = [];
    const better = (a, b) => /survey tile/.test(b.note) || !/survey tile/.test(a.note);
    for (const r of rows) {
      const k = r.name.toLowerCase();
      if (!at.has(k)) { at.set(k, out.length); out.push(r); }
      else if (better(out[at.get(k)], r)) out[at.get(k)] = r;
    }
    return out;
  }
  function normValidation(v) {
    if (!v || typeof v !== "object") return null;
    const inj = v.injection || v.recovery || v;
    const known = Array.isArray(v.known) ? v.known : Array.isArray(v.known_movers) ? v.known_movers
      : v.known_movers && typeof v.known_movers === "object"
        ? [...(v.known_movers.recovered || []).map((k) => ({ ...k, recovered: true })), ...(v.known_movers.missed || []).map((k) => ({ ...k, recovered: false }))]
        : [];
    const fp = v.false_positives ?? inj.false_positives;
    const nInj = num(pick(inj, ["n_injected", "injected"])), nRec = num(pick(inj, ["n_recovered", "recovered"]));
    return {
      byPm: normBins(pick(inj, ["by_pm", "completeness_vs_pm", "pm_bins"]), "pm"),
      byMag: normBins(pick(inj, ["by_mag", "completeness_vs_mag", "mag_bins", "by_w2"]), "mag"),
      nInjected: nInj, nRecovered: nRec,
      overall: num(pick(inj, ["completeness"])) || (nInj > 0 && Number.isFinite(nRec) ? nRec / nInj : NaN),
      pmErr: num(pick(inj, ["pm_error_median", "pm_err_median", "median_pm_error"])),
      pmRel: num(pick(inj, ["pm_rel_error_median", "median_pm_rel_error"])),
      fp: fp === undefined || fp === null ? null : typeof fp === "object"
        ? { n: num(pick(fp, ["n", "count", "false_positives"])), tiles: num(pick(fp, ["tiles", "n_tiles"])), note: fp.note || fp.data || "" }
        : { n: num(fp), tiles: num(pick(v, ["fp_tiles"])), note: "" },
      known: oneRowPerStar(known.map((k) => ({
        name: String(k.name || k.id || "?"), recovered: !!(k.recovered ?? k.found),
        pmTrue: num(pick(k, ["pm_true", "pm_expected", "pm_catalog", "pm_cat"])), pmMeas: num(pick(k, ["pm_measured", "pm_meas", "pm"])),
        note: k.note || k.reason || "", id: k.mover_id || k.candidate || null,
      }))),
      note: v.note || "",
    };
  }

  // ---------- the NEOWISE track: straight-line fit and a small SVG plot ----------
  function trackPoints(m) {
    return (Array.isArray(m && m.track) ? m.track : []).map((p) => ({ t: num(p[0]), ra: num(p[1]), dec: num(p[2]) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.ra) && Number.isFinite(p.dec)).sort((a, b) => a.t - b.t);
  }
  // Least-squares straight line x(t), y(t); returns slopes in units per year and the rms scatter about the line.
  function fitLine(ts, xs, ys) {
    const n = ts.length;
    if (n < 2) return null;
    const mt = ts.reduce((a, b) => a + b, 0) / n, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let stt = 0, stx = 0, sty = 0;
    for (let i = 0; i < n; i++) { const dt = ts[i] - mt; stt += dt * dt; stx += dt * (xs[i] - mx); sty += dt * (ys[i] - my); }
    if (stt <= 0) return null;
    const vx = stx / stt, vy = sty / stt;
    let ss = 0;
    for (let i = 0; i < n; i++) { const dt = ts[i] - mt; ss += (xs[i] - mx - vx * dt) ** 2 + (ys[i] - my - vy * dt) ** 2; }
    return { t0: mt, x0: mx, y0: my, vx, vy, rms: Math.sqrt(ss / n), at: (t) => [mx + vx * (t - mt), my + vy * (t - mt)] };
  }
  function niceStep(span) {
    const raw = span / 4, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  // Offsets in arcseconds from the mean position: x = ΔRA·cos δ (east positive), y = ΔDec (north positive)
  function trackOffsets(pts) {
    const n = pts.length, ra0 = pts[0].ra, cd = Math.cos((pts.reduce((a, p) => a + p.dec, 0) / n) * D2R);
    const dra = pts.map((p) => wrap180(p.ra - ra0)), mra = dra.reduce((a, b) => a + b, 0) / n, mdec = pts.reduce((a, p) => a + p.dec, 0) / n;
    return { xs: dra.map((d) => (d - mra) * cd * 3600), ys: pts.map((p) => (p.dec - mdec) * 3600), ts: pts.map((p) => p.t) };
  }
  const W = 400, H = 320, ML = 48, MR = 14, MT = 14, MB = 40;
  function trackSvg(m) {
    const pts = trackPoints(m);
    if (pts.length < 2) return { svg: "", n: pts.length, fit: null };
    const { xs, ys, ts } = trackOffsets(pts), fit = fitLine(ts, xs, ys);
    const span = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.25;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const iw = W - ML - MR, ih = H - MT - MB, sc = Math.min(iw, ih) / span;
    const px = (x) => ML + iw / 2 - (x - cx) * sc;   // east is left
    const py = (y) => MT + ih / 2 - (y - cy) * sc;
    const step = niceStep(span), lab = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${trim0(Math.abs(v).toFixed(step < 1 ? 1 : 0))}″`;
    let g = "";
    const x0 = cx - (iw / 2) / sc, x1 = cx + (iw / 2) / sc, y0 = cy - (ih / 2) / sc, y1 = cy + (ih / 2) / sc;
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) g += `<line class="tg" x1="${px(v).toFixed(1)}" x2="${px(v).toFixed(1)}" y1="${MT}" y2="${H - MB}"/><text class="tl" x="${px(v).toFixed(1)}" y="${H - MB + 14}" text-anchor="middle">${lab(Math.abs(v) < step / 1e6 ? 0 : v)}</text>`;
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) g += `<line class="tg" x1="${ML}" x2="${W - MR}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}"/><text class="tl" x="${ML - 6}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end">${lab(Math.abs(v) < step / 1e6 ? 0 : v)}</text>`;
    let fitS = "";
    if (fit) {
      const [ax, ay] = fit.at(ts[0]), [bx, by] = fit.at(ts[ts.length - 1]);
      const X1 = px(ax), Y1 = py(ay), X2 = px(bx), Y2 = py(by), a = Math.atan2(Y2 - Y1, X2 - X1);
      const head = [[X2, Y2], [X2 - 9 * Math.cos(a - 0.45), Y2 - 9 * Math.sin(a - 0.45)], [X2 - 9 * Math.cos(a + 0.45), Y2 - 9 * Math.sin(a + 0.45)]];
      fitS = `<line class="fit" x1="${X1.toFixed(1)}" y1="${Y1.toFixed(1)}" x2="${X2.toFixed(1)}" y2="${Y2.toFixed(1)}"/>`
        + `<polygon class="fit-head" points="${head.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
    }
    const n = pts.length, mid = Math.floor((n - 1) / 2), label = new Set([0, mid, n - 1]);
    const dots = pts.map((p, i) => `<circle class="tp" cx="${px(xs[i]).toFixed(1)}" cy="${py(ys[i]).toFixed(1)}" r="4" opacity="${(0.35 + 0.65 * (i / Math.max(1, n - 1))).toFixed(2)}"><title>${p.t.toFixed(2)}</title></circle>`).join("");
    const yrs = [...label].map((i) => `<text class="ty" x="${(px(xs[i]) + 7).toFixed(1)}" y="${(py(ys[i]) - 7).toFixed(1)}">${pts[i].t.toFixed(1)}</text>`).join("");
    const svg = `<rect class="tbg" x="${ML}" y="${MT}" width="${iw}" height="${ih}"/>${g}${fitS}${dots}${yrs}`
      + `<text class="ta" x="${ML + iw / 2}" y="${H - 6}" text-anchor="middle">← east · ΔRA cos δ · west →</text>`
      + `<text class="ta" x="12" y="${MT + ih / 2}" text-anchor="middle" transform="rotate(-90 12 ${MT + ih / 2})">south · ΔDec · north →</text>`;
    return { svg, n, fit, points: pts.map((p, i) => ({ t: p.t, x: px(xs[i]), y: py(ys[i]) })) };
  }

  // ---------- links ----------
  const BYW = "https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9";
  const deg = (v, d = 5) => num(v).toFixed(d);
  function links(m) {
    const ra = num(m.ra), dec = num(m.dec), q = `ra=${deg(ra)}&dec=${deg(dec)}`;
    const years = 2026 - 2000, radiusArcmin = Math.max(1, Math.ceil((num(m.pm) || 0) * years / 60000 + 0.5));   // wide enough for where it was in 2000
    return {
      map: `observatory.html?${q}`,
      webb: `observatory.html?${q}`,          // the console has no deep link to its Webb tab yet
      byw: BYW,
      simbad: `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${deg(ra)}%20${dec < 0 ? "" : "%2B"}${deg(dec)}&Radius=${radiusArcmin}&Radius.unit=arcmin`,
      radiusArcmin,
    };
  }
  function copyText(m) {
    const s = sexa(num(m.ra), num(m.dec));
    return `${s.ra} ${s.dec} (RA ${deg(m.ra)}°, Dec ${deg(m.dec)}°)`;
  }

  const Core = {
    NSIDE, N_TILES, TILE_AREA_DEG2, MAP_W, MAP_H, pix2ang, corners, tilePoint, xyf2ang, hammerXY, project, tilePolygon, galToEq, eclToEq, skyPath,
    fmtInt, fmtBig, fmtPct, fmtHours, fmtPm, fmtFix, sexa, posAngle, compass, esc, isRed, gaiaText, applyFilters, sortRows, SORTS, CLASSES,
    normTiles, normValidation, oneRowPerStar, trackPoints, fitLine, trackOffsets, trackSvg, links, copyText, BYW,
  };
  if (typeof module === "object" && module && module.exports) module.exports = Core;
  root.SurveyCore = Core;
  if (typeof document === "undefined" || !document.getElementById || !document.getElementById("svMain")) return;

  // =====================================================================================================
  // The page
  // =====================================================================================================
  const $ = (id) => document.getElementById(id);
  const DATA = "data/survey/";
  const ALADIN = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
  const HIPS = {
    spherex: "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube",
    wise: "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1",
  };
  const S = {
    summary: null, board: null, state: { summary: "loading", board: "loading" }, rows: [], view: [], tiles: [], tileIndex: new Map(),
    sort: { key: "rank", dir: 1 }, page: 0, size: 50, f: { cls: "all", minPm: 0, red: false, q: "", tile: null },
    open: null, opener: null, hover: null, loadSeq: 0,
  };
  const SKY = { aladin: null, layers: {}, track: null, ends: null, src: "spherex", loading: null, seq: 0 };

  // ---------- loading ----------
  async function getJSON(url) {
    let r;
    try { r = await fetch(url, { cache: "no-store" }); } catch (e) { return { state: "error", error: "the network request failed" }; }
    if (!r || r.status === 404) return { state: "missing" };
    if (!r.ok) return { state: "error", error: `the server answered ${r.status}` };
    try { return { state: "ok", data: await r.json() }; } catch (e) { return { state: "error", error: "the file is not valid JSON" }; }
  }
  const okSummary = (s) => s && typeof s === "object" && !Array.isArray(s) && Number.isFinite(num(s.tiles_done));
  const okBoard = (b) => b && typeof b === "object" && Array.isArray(b.candidates);
  async function load() {
    const me = ++S.loadSeq;
    $("retry").hidden = true;
    if (!S.summary) { $("mapNote").textContent = "Loading…"; $("valBody").innerHTML = `<p class="sv-empty">Loading…</p>`; }
    if (!S.board) { S.state.board = "loading"; renderTable(); }
    const [s, b] = await Promise.all([getJSON(DATA + "summary.json"), getJSON(DATA + "leaderboard.json")]);
    if (me !== S.loadSeq) return;
    if (s.state === "ok" && !okSummary(s.data)) Object.assign(s, { state: "error", error: "summary.json does not have the expected fields" });
    if (b.state === "ok" && !okBoard(b.data)) Object.assign(b, { state: "error", error: "leaderboard.json does not have a candidate list" });
    S.state = { summary: s.state, board: b.state, error: s.error || b.error || "" };
    S.summary = s.state === "ok" ? s.data : null;
    S.board = b.state === "ok" ? b.data : null;
    S.rows = S.board ? S.board.candidates.filter((m) => m && typeof m === "object").map((m, i) => ({ ...m, rank: Number.isFinite(num(m.rank)) ? num(m.rank) : i + 1, id: String(m.id ?? `#${i + 1}`) })) : [];
    S.tiles = S.summary ? normTiles(S.summary.tiles) : [];
    S.tileIndex = new Map(S.tiles.map((t) => [t.k5, t]));
    renderBanners(); renderHero(); renderMap(); renderValidation(); renderLimits();
    readUrl();
    renderTable();
    const want = new URLSearchParams(location.search).get("id");
    if (want && !S.open) { const m = S.rows.find((r) => r.id === want); if (m) openCandidate(m.id); }
  }

  // ---------- banners: demo data, run in progress, nothing yet, failures ----------
  function renderBanners() {
    const s = S.summary, out = [], st = S.state;
    if ((s && s.demo) || (S.board && S.board.demo))
      out.push(`<p class="sv-banner demo"><b>Sample data.</b> These numbers and candidates are made up to show how this page works. They are not survey results; the real run replaces them.</p>`);
    if (st.summary === "error" || st.board === "error")
      out.push(`<p class="sv-banner err" role="alert"><b>Could not load the survey results:</b> ${esc(st.error)}. Check your connection and try again.</p>`);
    else if (st.summary === "missing")
      out.push(`<p class="sv-banner empty"><b>No survey results yet.</b> The automated search has not published a summary. When the first run finishes, its numbers appear here.</p>`);
    if (s) {
      const done = num(s.tiles_done), total = num(s.tiles_total), running = s.status === "running" || (s.status !== "done" && done < total);
      if (running) out.push(`<p class="sv-banner run"><b>Run in progress:</b> ${fmtInt(done)} of ${fmtInt(total)} tiles searched so far. The numbers below are results so far; reload later for more.</p>`);
      else if (done < total) out.push(`<p class="sv-banner run"><b>Partial survey:</b> this run searched ${fmtInt(done)} of ${fmtInt(total)} tiles.</p>`);
    }
    $("banners").innerHTML = out.join("");
    $("retry").hidden = !(st.summary === "error" || st.board === "error");
  }

  // ---------- hero: the scale ----------
  function renderHero() {
    const s = S.summary;
    if (!s) {
      $("heroTitle").innerHTML = "Billions of infrared detections. Which ones move?";
      for (const id of ["statDet", "statTracks", "statSky", "statMovers", "statUnex", "statTime"]) $(id).innerHTML = "—";
      $("funnel").innerHTML = "";
      $("funnel").hidden = true;
      return;
    }
    const det = num(s.detections);
    $("heroTitle").innerHTML = Number.isFinite(det) && det > 0
      ? `<span class="hl">${fmtBig(det)}</span> infrared detections, searched for anything that moves.`
      : "Billions of infrared detections. Which ones move?";
    const sub = (t) => `<span class="sub">${t}</span>`;
    const area = num(s.sky_deg2), frac = num(s.sky_fraction);
    $("statDet").innerHTML = `${fmtInt(det)}${Number.isFinite(num(s.good_detections)) ? sub(`${fmtInt(s.good_detections)} passed the quality cuts`) : ""}`;
    $("statTracks").innerHTML = `${fmtInt(s.tracks)}${Number.isFinite(num(s.visit_sources)) ? sub(`from ${fmtInt(s.visit_sources)} per-visit sources`) : ""}`;
    $("statSky").innerHTML = `${fmtInt(s.tiles_done)} tiles${sub(`${Number.isFinite(area) ? fmtInt(area) + " deg²" : ""}${Number.isFinite(area) && Number.isFinite(frac) ? " · " : ""}${Number.isFinite(frac) ? fmtPct(frac) + " of the sky" : ""}`)}`;
    $("statMovers").innerHTML = `${fmtInt(s.movers)}${sub(Number.isFinite(num(s.min_pm)) ? `move ≥ ${trim0((num(s.min_pm) / 1000).toFixed(3))}″ a year, steadily` : "move steadily across the years")}`;
    const pending = num(s.gaia_unchecked) || 0;   // movers the Gaia check has not reached yet (service busy or offline)
    $("statUnex").innerHTML = `${fmtInt(s.unexplained)}${sub(pending > 0
      ? `no Gaia DR3 counterpart · ${fmtInt(pending)} of ${fmtInt(s.movers)} movers still to check`
      : "no Gaia DR3 counterpart")}`;
    const tp = [Number.isFinite(num(s.tiles_per_hour)) ? `${fmtInt(s.tiles_per_hour)} tiles/hour` : "", Number.isFinite(num(s.detections_per_second)) ? `${fmtInt(s.detections_per_second)} detections/s` : ""].filter(Boolean).join(" · ");
    $("statTime").innerHTML = `${fmtHours(s.runtime_hours)}${tp ? sub(tp) : ""}`;
    const steps = [
      ["detections", "NEOWISE detections read"], ["good_detections", "passed quality cuts"], ["visit_sources", "sources in single visits"],
      ["tracks", "linked across the years"], ["movers", "move steadily"], ["unexplained", "not in Gaia DR3"],
    ].filter(([k]) => Number.isFinite(num(s[k])));
    $("funnel").innerHTML = steps.map(([k, t]) => `<li data-k="${k}"><b class="mono">${fmtBig(s[k])}</b><span>${t}</span></li>`).join("")
      + `<li data-k="people" class="you"><b class="mono">You</b><span><a href="#candidates">check the ranked list</a></span></li>`;
    $("funnel").hidden = false;
  }

  // ---------- all-sky coverage map ----------
  function tokens() {
    const css = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
    const v = (k, d) => (css && css.getPropertyValue(k).trim()) || d;
    return { accent: v("--accent", "#2864C5"), cand: v("--cand", "#9A5A00"), sky: v("--surface-2", "#EEF2F7"), line: v("--line-strong", "#C3CFDC"), text: v("--text", "#172B45"), bg: v("--surface", "#FFFFFF") };
  }
  function mapTiles() {
    return S.tiles.map((t) => {
      const { centre, poly } = tilePolygon(t.k5);
      return { ...t, x: centre[0], y: centre[1], poly, kind: t.unexplained > 0 ? "unexplained" : t.movers > 0 ? "movers" : "none" };
    });
  }
  function drawMap() {
    const cv = $("skyMap"), ctx = cv.getContext && cv.getContext("2d");
    if (!ctx) return;
    const cssW = cv.clientWidth || (cv.getBoundingClientRect && cv.getBoundingClientRect().width) || MAP_W;
    const dpr = root.devicePixelRatio || 1, scale = (cssW * dpr) / MAP_W;
    cv.width = Math.round(MAP_W * scale); cv.height = Math.round(MAP_H * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const c = tokens();
    ctx.clearRect(0, 0, MAP_W, MAP_H);
    ctx.beginPath(); ctx.ellipse(MAP_W / 2, MAP_H / 2, MAP_A, MAP_B, 0, 0, 2 * Math.PI);
    ctx.fillStyle = c.sky; ctx.fill();
    ctx.save(); ctx.clip();
    for (const t of S.drawn || []) {
      ctx.beginPath();
      t.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      if (t.kind === "unexplained") { ctx.globalAlpha = 1; ctx.fillStyle = c.cand; }
      else if (t.kind === "movers") { ctx.globalAlpha = Math.min(1, 0.45 + 0.12 * Math.log2(1 + t.movers)); ctx.fillStyle = c.accent; }
      else { ctx.globalAlpha = 0.28; ctx.fillStyle = c.accent; }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const sel = S.f.tile !== null ? (S.drawn || []).find((t) => t.k5 === S.f.tile) : null;
    for (const t of [sel, S.hover].filter(Boolean)) {
      ctx.beginPath(); t.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.lineWidth = t === sel ? 2.5 : 1.5; ctx.strokeStyle = c.text; ctx.stroke();
      if (t === sel) { ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, 2 * Math.PI); ctx.stroke(); }
    }
    ctx.restore();
  }
  function renderGrid() {
    let g = `<ellipse class="g-edge" cx="${MAP_W / 2}" cy="${MAP_H / 2}" rx="${MAP_A}" ry="${MAP_B}"/>`;
    for (const d of [-60, -30, 0, 30, 60]) g += `<path class="g-line${d === 0 ? " eq" : ""}" d="${skyPath(Array.from({ length: 73 }, (_, i) => ({ ra: -179.999 + (i * 359.998) / 72, dec: d })))}"/>`;
    for (const h of [4, 8, 16, 20, 0]) g += `<path class="g-line" d="${skyPath(Array.from({ length: 37 }, (_, i) => ({ ra: h * 15, dec: -90 + i * 5 })))}"/>`;
    g += `<path class="g-gal" d="${skyPath(Array.from({ length: 361 }, (_, i) => galToEq(i, 0)))}"/>`;
    g += `<path class="g-ecl" d="${skyPath(Array.from({ length: 361 }, (_, i) => eclToEq(i)))}"/>`;
    for (const h of [0, 4, 8, 16, 20]) { const [x, y] = project(h * 15, 0); g += `<text class="g-lab" x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}" text-anchor="middle">${h}h</text>`; }
    for (const d of [-60, -30, 30, 60]) { const [x, y] = project(180.001, d); g += `<text class="g-lab" x="${(x + 6).toFixed(1)}" y="${(y + 4).toFixed(1)}">${d > 0 ? "+" : "−"}${Math.abs(d)}°</text>`; }
    $("mapGrid").innerHTML = g;
  }
  function renderMap() {
    S.drawn = mapTiles();
    renderGrid();
    drawMap();
    const n = S.tiles.length, unex = S.tiles.filter((t) => t.unexplained > 0).length, mov = S.tiles.filter((t) => t.movers > 0).length;
    $("skyMap").setAttribute("aria-label", n
      ? `All-sky map in equatorial coordinates: ${fmtInt(n)} of ${fmtInt(N_TILES)} tiles searched; ${fmtInt(mov)} tiles with movers, ${fmtInt(unex)} with unexplained candidates.`
      : "All-sky map: no tiles searched yet.");
    $("mapNote").textContent = n ? `${fmtInt(n)} tiles searched (${fmtPct(n / N_TILES)} of the sky). Click or tap a tile to list its candidates.`
      : S.state.summary === "loading" ? "Loading…" : "No tiles searched yet.";
    renderTileInfo();
  }
  function tileNear(lx, ly, maxDist = 14) {
    let best = null, bd = maxDist * maxDist;
    for (const t of S.drawn || []) { const d = (t.x - lx) ** 2 + (t.y - ly) ** 2; if (d < bd) { bd = d; best = t; } }
    return best;
  }
  function mapPoint(e) {
    const cv = $("skyMap"), r = cv.getBoundingClientRect();
    const w = r.width || MAP_W, h = r.height || MAP_H;
    const ox = e.offsetX !== undefined ? e.offsetX : e.clientX - r.left, oy = e.offsetY !== undefined ? e.offsetY : e.clientY - r.top;
    return [(ox * MAP_W) / w, (oy * MAP_H) / h];
  }
  function tileTip(t) {
    const c = pix2ang(t.k5);
    return `Tile ${t.k5} · ${fmtInt(t.movers)} mover${t.movers === 1 ? "" : "s"} · ${fmtInt(t.unexplained)} unexplained · centre RA ${c.ra.toFixed(1)}°, Dec ${c.dec.toFixed(1)}°`;
  }
  function renderTileInfo() {
    const k = S.f.tile, info = $("tileInfo");
    $("tileClear").hidden = k === null;
    if (k === null) { info.textContent = ""; return; }
    const t = S.tileIndex.get(k), inBoard = S.rows.filter((m) => num(m.k5) === k).length;
    info.innerHTML = t
      ? `<b>Tile ${k}</b>: ${fmtInt(t.movers)} mover${t.movers === 1 ? "" : "s"}, ${fmtInt(t.unexplained)} unexplained; ${fmtInt(inBoard)} in the ranked list. <a href="#candidates">Show in the table ↓</a>`
      : `<b>Tile ${k}</b> was not searched in this run.`;
  }
  function setTile(k) {
    S.f.tile = k === null || k === undefined || k === "" || !Number.isFinite(num(k)) ? null : Math.round(num(k));
    $("fTile").value = S.f.tile === null ? "" : String(S.f.tile);
    S.page = 0;
    renderTileInfo(); drawMap(); renderTable(); writeUrl();
  }

  // ---------- validation ----------
  function bars(list, unitLabel) {
    if (!list.length) return "";
    return `<ul class="sv-bars" aria-label="${esc(unitLabel)}">${list.map((b) => {
      const pct = Math.max(0, Math.min(100, b.completeness * 100));
      return `<li><span class="bl">${esc(b.label)}</span><span class="bar" aria-hidden="true"><i style="width:${pct.toFixed(1)}%"></i></span>`
        + `<b class="mono">${Math.round(pct)}%</b>${Number.isFinite(b.n) && Number.isFinite(b.recovered) ? `<small>${fmtInt(b.recovered)} of ${fmtInt(b.n)}</small>` : ""}</li>`;
    }).join("")}</ul>`;
  }
  function renderValidation() {
    const v = normValidation(S.summary && S.summary.validation);
    if (!v || (!v.byPm.length && !v.byMag.length && !v.known.length && !v.fp)) {
      $("valBody").innerHTML = `<p class="sv-empty">${S.summary ? "Validation results are not available for this run yet." : "No validation results yet."} Until they are, treat every number on this page as unchecked.</p>`;
      return;
    }
    let h = "";
    if (v.byPm.length || v.byMag.length) {
      h += `<div class="sv-val-card"><h3>Completeness: how many fake movers it found</h3>`
        + `<p class="hint">We hid ${Number.isFinite(v.nInjected) ? fmtInt(v.nInjected) : "a set of"} fake moving sources among the detections, at NEOWISE's own visit dates and with realistic position errors, and ran the same search.${Number.isFinite(v.overall) ? ` It found <b>${fmtPct(v.overall)}</b> of them.` : ""} Real objects in crowded or messy fields can be harder to find than these.</p>`
        + (v.byPm.length ? `<h4>By motion (″/yr)</h4>${bars(v.byPm, "Completeness by motion")}` : "")
        + (v.byMag.length ? `<h4>By W2 brightness (mag, larger is fainter)</h4>${bars(v.byMag, "Completeness by brightness")}` : "")
        + (Number.isFinite(v.pmErr) ? `<p class="hint">Measured motions of recovered fakes are off by a median of ${fmtFix(v.pmErr, 1)} mas/yr${Number.isFinite(v.pmRel) ? ` (${fmtPct(v.pmRel)})` : ""}.</p>` : "")
        + `</div>`;
    }
    if (v.fp) {
      const n = v.fp.n, t = v.fp.tiles;
      h += `<div class="sv-val-card"><h3>False alarms</h3><p class="sv-fp"><b class="mono">${fmtInt(n)}</b> false mover${n === 1 ? "" : "s"}${Number.isFinite(t) ? ` in ${fmtInt(t)} test tile${t === 1 ? "" : "s"} with no real movers` : " on data with no real movers"}.</p>`
        + `<p class="hint">${v.fp.note ? esc(String(v.fp.note).replace(/[.\s]+$/, "")) + ". " : ""}A false alarm is something the search called a mover when nothing was moving. That is why every candidate is checked by people before anyone calls it real.</p></div>`;
    }
    if (v.known.length) {
      const rec = v.known.filter((k) => k.recovered).length;
      h += `<div class="sv-val-card wide"><h3>Famous fast stars: did it find them on its own?</h3><p class="hint">${rec} of ${v.known.length} known high-motion stars in the searched tiles were picked up without being told where they are.</p>`
        + `<div class="sv-scroll"><table class="sv-known"><caption class="visually-hidden">Known high-motion objects and whether the search recovered them</caption>`
        + `<thead><tr><th scope="col">Object</th><th scope="col">Found?</th><th scope="col">Catalogue motion</th><th scope="col">Measured</th><th scope="col">Difference</th></tr></thead><tbody>`
        + v.known.map((k) => {
          const diff = Number.isFinite(k.pmTrue) && Number.isFinite(k.pmMeas) && k.pmTrue > 0 ? (k.pmMeas - k.pmTrue) / k.pmTrue : NaN;
          return `<tr class="${k.recovered ? "found" : "missed"}"><th scope="row">${esc(k.name)}</th><td>${k.recovered ? "✓ found" : "✗ missed"}${k.note ? `<small>${esc(k.note)}</small>` : ""}</td>`
            + `<td class="num">${Number.isFinite(k.pmTrue) ? fmtPm(k.pmTrue) + "″/yr" : "—"}</td><td class="num">${k.recovered && Number.isFinite(k.pmMeas) ? fmtPm(k.pmMeas) + "″/yr" : "—"}</td>`
            + `<td class="num">${k.recovered && Number.isFinite(diff) ? (diff >= 0 ? "+" : "−") + fmtPct(Math.abs(diff)) : "—"}</td></tr>`;
        }).join("") + `</tbody></table></div></div>`;
    }
    if (v.note) h += `<p class="hint">${esc(v.note)}</p>`;
    $("valBody").innerHTML = h;
  }

  // ---------- limits, method, dates ----------
  function renderLimits() {
    const s = S.summary, lim = s && Array.isArray(s.limits) ? s.limits : [];
    $("limitsList").innerHTML = lim.length ? lim.map((l) => `<li>${esc(l)}</li>`).join("") : `<li>The run has not listed its limits yet.</li>`;
    $("methodText").textContent = s && s.method ? String(s.method) : "";
    $("methodBox").hidden = !(s && s.method);
    const when = (S.summary && S.summary.generated) || (S.board && S.board.generated);
    $("genTime").textContent = when ? `Results generated ${String(when).replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, " UTC")}.` : "";
  }

  // ---------- candidate table ----------
  const COLS = [
    ["rank", "Rank", "num"], ["id", "Candidate", ""], ["class", "Class", ""], ["pm", "Motion ″/yr", "num"], ["pa", "Direction", "hide-sm"],
    ["visits", "Visits · span", "num hide-sm"], ["w1w2", "W1−W2", "num"], ["gaia", "Gaia DR3", ""], ["score", "Score", "num"],
  ];
  function renderHead() {
    $("candHead").innerHTML = `<tr>${COLS.map(([k, label, cls]) => {
      const on = S.sort.key === k, sort = on ? (S.sort.dir > 0 ? "ascending" : "descending") : "none";
      return `<th scope="col" class="${cls}" aria-sort="${sort}"><button type="button" class="sorter" data-sort="${k}">${label}<span class="arrow" aria-hidden="true">${on ? (S.sort.dir > 0 ? "▲" : "▼") : ""}</span></button></th>`;
    }).join("")}</tr>`;
  }
  function rowHtml(m) {
    const pa = posAngle(m.pmra, m.pmdec), hasPa = Number.isFinite(pa) && (num(m.pmra) || num(m.pmdec));
    const c = num(m.w1w2), w = Number.isFinite(c) ? c.toFixed(2) : !Number.isFinite(num(m.w1)) && Number.isFinite(num(m.w2)) ? "no W1" : "—";
    return `<tr data-id="${esc(m.id)}" class="${m.class === "unexplained" ? "is-unex" : ""}">`
      + `<td class="num">${fmtInt(m.rank)}</td>`
      + `<th scope="row"><button type="button" class="cid mono" data-id="${esc(m.id)}" aria-haspopup="dialog">${esc(m.id)}</button></th>`
      + `<td><span class="badge ${BADGE[m.class] || "b-nc"}">${esc(m.class || "not checked")}</span></td>`
      + `<td class="num">${fmtPm(m.pm)}</td>`
      + `<td class="hide-sm">${hasPa ? `${Math.round(pa)}° ${compass(pa)}` : "—"}</td>`
      + `<td class="num hide-sm">${fmtInt(m.n_visits)} · ${fmtFix(m.span_yr, 1)} yr</td>`
      + `<td class="num${isRed(m) ? " red" : ""}">${w}</td>`
      + `<td>${esc(gaiaText(m.gaia))}</td>`
      + `<td class="num">${fmtFix(m.score, 2)}</td></tr>`;
  }
  function renderTable() {
    renderHead();
    const st = S.state.board;
    if (!S.board) {
      $("candBody").innerHTML = "";
      $("tEmpty").hidden = false;
      $("tEmpty").textContent = st === "loading" ? "Loading the ranked list…" : st === "error" ? "The ranked list could not be loaded."
        : S.summary ? "The ranked list is not ready yet: candidates are ranked once the tiles in this run are searched and checked against Gaia." : "No ranked candidates yet.";
      $("tCount").textContent = "";
      $("pager").hidden = true;
      return;
    }
    S.view = sortRows(applyFilters(S.rows, S.f), S.sort.key, S.sort.dir);
    const n = S.view.length, size = S.size, pages = Math.max(1, Math.ceil(n / size));
    S.page = Math.max(0, Math.min(S.page, pages - 1));
    const from = S.page * size, rows = S.view.slice(from, from + size);
    $("candBody").innerHTML = rows.map(rowHtml).join("");
    if (root.Classify) root.Classify.badges($("candBody"));   // community consensus badges (classify.js)
    $("tEmpty").hidden = n > 0;
    $("tEmpty").textContent = n ? "" : S.rows.length ? "No candidates match these filters." : "No candidates passed the cuts in this run.";
    const total = num(S.board.n_candidates), filtered = n !== S.rows.length;
    $("tCount").textContent = n ? `Showing ${fmtInt(from + 1)}–${fmtInt(from + rows.length)} of ${fmtInt(n)} candidate${n === 1 ? "" : "s"}${filtered ? ` (filtered from ${fmtInt(S.rows.length)})` : ""}${Number.isFinite(total) && total > S.rows.length ? `; the list holds the top ${fmtInt(S.rows.length)} of ${fmtInt(total)} ranked movers` : ""}.`
      : `0 of ${fmtInt(S.rows.length)} candidates shown.`;
    $("pager").hidden = pages <= 1;
    $("pgPrev").disabled = S.page === 0;
    $("pgNext").disabled = S.page >= pages - 1;
    $("pgInfo").textContent = `Page ${S.page + 1} of ${pages}`;
  }
  function sortBy(key) {
    if (!SORTS[key]) return;
    S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: SORTS[key].dir };
    S.page = 0;
    renderTable(); writeUrl();
  }
  function setFilter(patch) {
    Object.assign(S.f, patch);
    S.page = 0;
    renderTable(); writeUrl();
  }

  // ---------- URL: filters, tile and open candidate survive a reload or a shared link ----------
  function readUrl() {
    const params = new URLSearchParams(location.search);
    const c = params.get("class");
    if (c && (c === "all" || CLASSES.includes(c))) { S.f.cls = c; $("fClass").value = c; }
    const mp = num(params.get("minpm"));
    if (Number.isFinite(mp) && mp > 0) { S.f.minPm = mp; $("fMinPm").value = String(mp); }
    if (params.get("red") === "1") { S.f.red = true; $("fRed").checked = true; }
    if (params.get("q")) { S.f.q = params.get("q"); $("fSearch").value = S.f.q; }
    const t = num(params.get("tile"));
    if (Number.isInteger(t) && t >= 0 && t < N_TILES) { S.f.tile = t; $("fTile").value = String(t); renderTileInfo(); drawMap(); }
  }
  function writeUrl() {
    try {
      const u = new URL(location.href), set = (k, v, on) => (on ? u.searchParams.set(k, v) : u.searchParams.delete(k));
      set("class", S.f.cls, S.f.cls !== "all"); set("minpm", S.f.minPm, num(S.f.minPm) > 0); set("red", "1", S.f.red);
      set("q", S.f.q, !!S.f.q); set("tile", S.f.tile, S.f.tile !== null); set("id", S.open && S.open.id, !!S.open);
      history.replaceState(null, "", u);
    } catch { /* file:// pages may refuse */ }
  }

  // ---------- candidate drawer ----------
  function numbersHtml(m) {
    const s = sexa(num(m.ra), num(m.dec)), pa = posAngle(m.pmra, m.pmdec), g = m.gaia;
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    let gaia;
    if (!g) gaia = "Not checked.";
    else if (g.checked === false) gaia = "Not checked (the Gaia archive did not answer during the run).";
    else if (g.match) gaia = `Matched: Gaia DR3 ${esc(g.source_id || "?")}${fin(num(g.sep_arcsec)) ? `, ${num(g.sep_arcsec).toFixed(2)}″ from where it should be` : ""}${fin(num(g.pm)) ? `; Gaia motion ${fmtPm(g.pm)}″/yr` : ""}${fin(num(g.g)) ? `; G = ${num(g.g).toFixed(2)}` : ""}.`;
    else gaia = "No Gaia DR3 source where this object should be (after moving Gaia's stars to the same date).";
    const plx = fin(num(m.plx)) ? row("Parallax", `${num(m.plx).toFixed(1)}${fin(num(m.plx_err)) ? ` ± ${num(m.plx_err).toFixed(1)}` : ""} mas`) : "";
    const flags = Array.isArray(m.flags) && m.flags.length ? row("Flags", m.flags.map(esc).join(", ")) : "";
    return row(`Position${fin(num(m.epoch)) ? ` (epoch ${num(m.epoch).toFixed(2)})` : ""}`, `<span class="mono">${esc(s.pretty)}</span><small class="mono">RA ${deg(m.ra)}°, Dec ${deg(m.dec)}°</small>`)
      + row("Motion", `<b class="mono">${fmtPm(m.pm)}″/yr</b>${fin(num(m.pm_err)) ? ` ± ${fmtFix(m.pm_err, 1)} mas/yr` : ""}${fin(num(m.pm_snr)) ? `<small>signal-to-noise ${fmtInt(m.pm_snr)}</small>` : ""}`)
      + row("Components", `<span class="mono">μα cos δ ${fmtFix(m.pmra, 1)}, μδ ${fmtFix(m.pmdec, 1)} mas/yr</span>`)
      + row("Direction", Number.isFinite(pa) ? `${Math.round(pa)}° east of north (towards ${compass(pa)})` : "—")
      + row("Seen", `${fmtInt(m.n_visits)} visits over ${fmtFix(m.span_yr, 1)} years`)
      + row("Line fit χ²ᵣ", `${fmtFix(m.chi2r, 2)} <small>near 1: moves in a straight line within its errors</small>`)
      + row("Brightness", `<span class="mono">W1 ${fmtFix(m.w1, 2)} · W2 ${fmtFix(m.w2, 2)} · W1−W2 ${fmtFix(m.w1w2, 2)}</span>${isRed(m) ? "<small>red: the colour of a cold brown dwarf, or W1 too faint to see</small>" : ""}`)
      + plx
      + row("Gaia DR3", gaia)
      + (Number.isInteger(num(m.k5)) ? row("Tile", `HEALPix order 5 tile <button type="button" class="linkish" data-tile="${num(m.k5)}">${num(m.k5)}</button>`) : "")
      + row("Score", `${fmtFix(m.score, 2)} <small>rank ${fmtInt(m.rank)}${S.rows.length ? ` of ${fmtInt(S.rows.length)}` : ""}</small>`)
      + flags;
  }
  function openCandidate(id) {
    const m = S.rows.find((r) => r.id === String(id));
    if (!m) return false;
    if (!S.open) S.opener = document.activeElement || null;
    S.open = m;
    $("dTitle").textContent = m.id;
    $("dClass").className = `badge ${BADGE[m.class] || "b-nc"}`;
    $("dClass").textContent = m.class || "not checked";
    $("dRank").textContent = `Rank ${fmtInt(m.rank)} · score ${fmtFix(m.score, 2)}`;
    $("dNums").innerHTML = numbersHtml(m);
    const reasons = Array.isArray(m.reasons) ? m.reasons : [];
    $("dReasons").innerHTML = reasons.length ? reasons.map((r) => `<li>${esc(r)}</li>`).join("") : "<li>No reasons were recorded for this candidate.</li>";
    const tr = trackSvg(m);
    $("dTrack").innerHTML = tr.svg;
    $("dTrack").setAttribute("aria-label", tr.n >= 2
      ? `NEOWISE track: ${tr.n} positions from ${trackPoints(m)[0].t.toFixed(1)} to ${trackPoints(m)[tr.n - 1].t.toFixed(1)}, with a straight-line fit. North up, east left.`
      : "No track points in the results file.");
    $("dTrackNote").textContent = tr.n >= 2 && tr.fit
      ? `${tr.n} visits. The dashed line is a straight-line fit to these points (${(Math.hypot(tr.fit.vx, tr.fit.vy)).toFixed(2)}″/yr); the points scatter about it by ${tr.fit.rms.toFixed(2)}″ (rms). North up, east left.`
      : "This candidate has fewer than two track points in the results file.";
    const L = links(m), cp = copyText(m);
    $("dMap").href = L.map; $("dWebb").href = L.webb; $("dByw").href = L.byw; $("dSimbad").href = L.simbad;
    $("dSimbadNote").textContent = `(${L.radiusArcmin}′ radius: wide enough for where it was in 2000)`;
    $("dCoords").textContent = cp;
    $("dCopyMsg").textContent = "";
    if (root.Classify) root.Classify.mount($("dClassify"), { id: m.id, kind: "candidate", name: `candidate ${m.id}`, heading: false });
    $("drawer").hidden = false; $("scrim").hidden = false;
    $("drawer").setAttribute("aria-hidden", "false");
    for (const id2 of ["svMain", "siteHead", "siteFoot"]) { const e = $(id2); if (e) { e.inert = true; e.setAttribute("aria-hidden", "true"); } }
    document.body.classList.add("sv-locked");
    $("dClose").focus();
    writeUrl();
    showSky(m);
    return true;
  }
  function closeDrawer() {
    if (!S.open) return;
    S.open = null; SKY.seq++;
    $("drawer").hidden = true; $("scrim").hidden = true;
    $("drawer").setAttribute("aria-hidden", "true");
    for (const id2 of ["svMain", "siteHead", "siteFoot"]) { const e = $(id2); if (e) { e.inert = false; e.removeAttribute("aria-hidden"); } }
    document.body.classList.remove("sv-locked");
    const back = S.opener; S.opener = null;
    if (back && typeof back.focus === "function") back.focus();
    writeUrl();
  }
  async function copyCoords() {
    const m = S.open; if (!m) return;
    const text = copyText(m);
    try {
      if (!root.navigator || !navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      $("dCopyMsg").textContent = "Copied to the clipboard.";
    } catch {
      $("dCopyMsg").textContent = "Copying is blocked here: select the coordinates above and copy them by hand.";
    }
  }

  // ---------- Aladin Lite (loaded only when a candidate is opened) ----------
  function fovFor(m) {
    const p = trackPoints(m);
    if (p.length < 2) return 0.05;
    const cd = Math.cos(num(m.dec) * D2R), xs = p.map((q) => wrap180(q.ra - p[0].ra) * cd), ys = p.map((q) => q.dec);
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return Math.min(1, Math.max(0.03, ext * 3));
  }
  async function ensureAladin() {
    if (SKY.aladin) return SKY.aladin;
    if (!SKY.loading) SKY.loading = (async () => {
      if (!root.A) root.A = (await import(ALADIN)).default;   // Aladin Lite 3 is an ES module (GPL-3.0, loaded, not copied)
      const A = root.A;
      await A.init;
      const al = A.aladin("#dSky", { survey: HIPS.spherex, fov: 0.05, cooFrame: "ICRSd", log: false, showReticle: false, showLayersControl: false,
        showGotoControl: false, showFullscreenControl: true, showCooGridControl: false, showSimbadPointerControl: false,
        showProjectionControl: false, showFrame: true, showZoomControl: true });
      SKY.layers.spherex = A.imageHiPS(HIPS.spherex, { name: "SPHEREx DR1", imgFormat: "png" });
      try { SKY.layers.spherex.setSliceNumber(95); } catch { /* older Aladin: first slice */ }   // ~4.6 µm, NEOWISE's W2 band
      SKY.layers.wise = A.imageHiPS(HIPS.wise, { name: "AllWISE colour", imgFormat: "jpeg" });
      al.setBaseImageLayer(SKY.layers[SKY.src]);
      SKY.track = A.graphicOverlay({ color: "#ffb547", lineWidth: 2 }); al.addOverlay(SKY.track);
      SKY.ends = A.catalog({ name: "NEOWISE track", sourceSize: 12, color: "#ffb547", shape: "circle" }); al.addCatalog(SKY.ends);
      SKY.aladin = al;
      return al;
    })();
    try { return await SKY.loading; } catch (e) { SKY.loading = null; throw e; }
  }
  async function showSky(m) {
    const me = ++SKY.seq;
    $("dSkyMsg").textContent = "Loading the live sky view…";
    try { await ensureAladin(); } catch (e) {
      if (me === SKY.seq) $("dSkyMsg").textContent = "The live sky view could not load (it needs the internet). The links below still work.";
      return;
    }
    if (me !== SKY.seq || S.open !== m) return;
    const A = root.A, pts = trackPoints(m);
    try {
      SKY.aladin.gotoRaDec(num(m.ra), num(m.dec));
      SKY.aladin.setFoV(fovFor(m));
      SKY.track.removeAll(); SKY.ends.removeAll();
      if (pts.length >= 2) {
        SKY.track.add(A.polyline(pts.map((p) => [p.ra, p.dec])));
        const a = pts[0], b = pts[pts.length - 1];
        SKY.ends.addSources([A.source(a.ra, a.dec, { name: a.t.toFixed(1) }), A.source(b.ra, b.dec, { name: b.t.toFixed(1) })]);
      }
    } catch (e) { $("dSkyMsg").textContent = "The live sky view could not show this candidate."; return; }
    $("dSkyMsg").textContent = `${SKY.src === "spherex" ? "SPHEREx (2025, 4.6 µm)" : "AllWISE colour (2010)"} under the NEOWISE track (orange, ${pts.length ? pts[0].t.toFixed(0) + "–" + pts[pts.length - 1].t.toFixed(0) : "no points"}). Drag to pan, scroll to zoom.`;
  }
  function setSurvey(src) {
    if (!HIPS[src]) return;
    SKY.src = src;
    $("dSrcSpherex").setAttribute("aria-pressed", String(src === "spherex"));
    $("dSrcWise").setAttribute("aria-pressed", String(src === "wise"));
    if (SKY.aladin && SKY.layers[src]) SKY.aladin.setBaseImageLayer(SKY.layers[src]);
    if (S.open && SKY.aladin) showSky(S.open);
  }

  // ---------- events ----------
  $("fClass").addEventListener("change", (e) => setFilter({ cls: e.target.value }));
  $("fMinPm").addEventListener("input", (e) => { const v = num(e.target.value); setFilter({ minPm: Number.isFinite(v) && v > 0 ? v : 0 }); });
  $("fRed").addEventListener("change", (e) => setFilter({ red: !!e.target.checked }));
  $("fSearch").addEventListener("input", (e) => setFilter({ q: String(e.target.value || "") }));
  $("fTile").addEventListener("change", (e) => setTile(e.target.value));
  $("fReset").addEventListener("click", () => {
    Object.assign(S.f, { cls: "all", minPm: 0, red: false, q: "", tile: null });
    $("fClass").value = "all"; $("fMinPm").value = "0"; $("fRed").checked = false; $("fSearch").value = ""; $("fTile").value = "";
    S.page = 0; renderTileInfo(); drawMap(); renderTable(); writeUrl();
  });
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  $("candHead").addEventListener("click", (e) => { const b = e.target && e.target.closest && e.target.closest("[data-sort]"); if (b) sortBy(b.dataset.sort); });
  $("candBody").addEventListener("click", (e) => { const r = e.target && e.target.closest && e.target.closest("[data-id]"); if (r) openCandidate(r.dataset.id); });
  $("pgPrev").addEventListener("click", () => { if (S.page > 0) { S.page--; renderTable(); } });
  $("pgNext").addEventListener("click", () => { S.page++; renderTable(); });
  $("pgSize").addEventListener("change", (e) => { const v = num(e.target.value); S.size = Number.isFinite(v) && v > 0 ? v : 50; S.page = 0; renderTable(); });
  $("tileClear").addEventListener("click", () => setTile(null));
  $("retry").addEventListener("click", () => load());
  $("dClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  $("dCopy").addEventListener("click", copyCoords);
  $("dSrcSpherex").addEventListener("click", () => setSurvey("spherex"));
  $("dSrcWise").addEventListener("click", () => setSurvey("wise"));
  $("dNums").addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("[data-tile]");
    if (b) { const k = num(b.dataset.tile); closeDrawer(); setTile(k); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.open) { e.preventDefault && e.preventDefault(); closeDrawer(); } });
  const cv = $("skyMap");
  cv.addEventListener("click", (e) => { const [x, y] = mapPoint(e), t = tileNear(x, y); if (t) setTile(S.f.tile === t.k5 ? null : t.k5); });
  cv.addEventListener("mousemove", (e) => {
    const [x, y] = mapPoint(e), t = tileNear(x, y), tip = $("mapTip");
    if (t !== S.hover) { S.hover = t; drawMap(); }
    if (!t) { tip.hidden = true; return; }
    tip.textContent = tileTip(t);
    tip.hidden = false;
    tip.style.left = `${Math.min(70, (t.x / MAP_W) * 100).toFixed(1)}%`;
    tip.style.top = `${((t.y / MAP_H) * 100).toFixed(1)}%`;
  });
  cv.addEventListener("mouseleave", () => { $("mapTip").hidden = true; if (S.hover) { S.hover = null; drawMap(); } });
  document.addEventListener("themechange", () => drawMap());
  let rz = 0;
  root.addEventListener("resize", () => { if (!rz) rz = root.requestAnimationFrame(() => { rz = 0; drawMap(); }); });

  const ready = load();
  root.Survey = { ready, reload: load, state: () => S, openCandidate, closeDrawer, sortBy, setFilter, setTile, mapTiles: () => S.drawn || [], tileNear, setSurvey, copyCoords };
})(typeof window !== "undefined" ? window : globalThis);
