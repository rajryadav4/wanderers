/* StarCore: long-range star motion (thousands of years), pure maths, no DOM.
 *
 * The star moves in a straight line through 3D space at constant velocity (the model behind
 * astropy's apply_space_motion and Gaia's epoch propagation). Seen from the Sun this gives the real
 * effects: the sky track is a great circle (curved on any sky chart), the star speeds up across the sky
 * as it approaches and slows as it recedes, and its distance passes through a closest approach.
 * Over tens of thousands of years the Galaxy's pull bends real paths only slightly; that is ignored.
 *
 * Starting state: the scikit-learn trajectory model (star_ml.py) gives today's position, motion and,
 * when resolved, parallax; Gaia DR3 gives the radial velocity. Without a learnt path the database
 * (catalogue) values are used and labelled so.
 *
 * Works in the browser (window.StarCore) and in Node (module.exports) so it can be tested against astropy.
 */
(function (root) {
  "use strict";
  const DEG = Math.PI / 180, MAS = DEG / 3.6e6, KMS = 1.0227121650537077e-6, LY = 3.261563777;   // km/s -> pc/yr; pc -> ly
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  function basis(raDeg, decDeg) {
    const a = raDeg * DEG, d = decDeg * DEG, ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
    return { u: [cd * ca, cd * sa, sd], p: [-sa, ca, 0], q: [-sd * ca, -sd * sa, cd] };   // line of sight, east, north
  }

  // {ra, dec, plx (mas), pmra (mas/yr, x cos dec), pmdec, rv (km/s), epoch} -> position (pc) and velocity (pc/yr)
  function toState(s) {
    if (!(s.plx > 0)) throw new Error("parallax must be > 0");
    const d = 1000 / s.plx, { u, p, q } = basis(s.ra, s.dec), mua = s.pmra * MAS, mud = s.pmdec * MAS, vr = (s.rv || 0) * KMS;
    return { r: u.map((c) => c * d), v: [0, 1, 2].map((i) => d * (mua * p[i] + mud * q[i]) + vr * u[i]), epoch: s.epoch };
  }

  function fromState(r, v) {
    const dist = Math.hypot(r[0], r[1], r[2]);
    let ra = Math.atan2(r[1], r[0]) / DEG; if (ra < 0) ra += 360;
    const dec = Math.atan2(r[2], Math.hypot(r[0], r[1])) / DEG, { u, p, q } = basis(ra, dec);
    return { ra, dec, distPc: dist, distLy: dist * LY, plx: 1000 / dist, pmra: dot(v, p) / dist / MAS, pmdec: dot(v, q) / dist / MAS,
      rv: dot(v, u) / KMS, speedKms: Math.hypot(v[0], v[1], v[2]) / KMS, xyzLy: r.map((c) => c * LY) };
  }

  function propagate(star, year) {
    const { r, v, epoch } = toState(star), dt = year - epoch;
    return { year, ...fromState(r.map((c, i) => c + v[i] * dt), v) };
  }

  function track(star, y0, y1, n = 300) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(propagate(star, y0 + (y1 - y0) * i / n));
    return out;
  }

  // Closest approach to the Sun: t = epoch - (r.v)/|v|^2 (may be in the past)
  function closestApproach(star) {
    const { r, v, epoch } = toState(star), vv = dot(v, v);
    return vv === 0 ? null : propagate(star, epoch - dot(r, v) / vv);
  }

  function separationArcsec(a, b) {
    const x = basis(a.ra, a.dec).u, y = basis(b.ra, b.dec).u;
    const c = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return Math.atan2(Math.hypot(...c), dot(x, y)) / DEG * 3600;
  }

  // Apparent magnitude at another distance, from today's magnitude and distance (same star, no extinction).
  const magAt = (mag0, d0, d) => (Number.isFinite(mag0) && d0 > 0 && d > 0 ? mag0 + 5 * Math.log10(d / d0) : null);

  // ---- starting state ----
  // From a learnt prediction (star_ml.py JSON) and its database row. Returns {star, err, sources, warnings}.
  function startState(pred, row) {
    const warnings = [], sources = {};
    let s, err;
    if (pred) {
      const r16 = pred.path.rows.reduce((b, x) => (Math.abs(x[0] - 2016) < Math.abs(b[0] - 2016) ? x : b));
      const L = pred.learnt, g = pred.gaia_dr3 || {}, cat = pred.catalogue_motion || {};
      s = { name: pred.name, ra: r16[1], dec: r16[2], epoch: r16[0], pmra: L.pmra_2016, pmdec: L.pmdec_2016 };
      err = { pmra: L.pmra_err || 1, pmdec: L.pmdec_err || 1 };
      sources.position = sources.motion = "learnt (scikit-learn, star_ml.py)";
      if (L.parallax_mas > 0) { s.plx = L.parallax_mas; err.plx = L.parallax_err || 0.1 * s.plx; sources.parallax = "learnt"; }
      else if (g.parallax > 0) { s.plx = g.parallax; err.plx = g.parallax_error || 0.01 * s.plx; sources.parallax = "Gaia DR3"; }
      else if (cat.parallax > 0) { s.plx = cat.parallax; err.plx = 0.05 * s.plx; sources.parallax = cat.source || "catalogue"; }
      if (Number.isFinite(g.radial_velocity)) { s.rv = g.radial_velocity; err.rv = 0.5; sources.rv = "Gaia DR3"; }
      else if (row && row.rv) { s.rv = row.rv; err.rv = 2; sources.rv = "HYG catalogue"; }
    } else if (row) {
      s = { name: row.name, ra: row.ra, dec: row.dec, epoch: row.epoch || 2000.0, pmra: row.pmra || 0, pmdec: row.pmdec || 0,
        plx: row.dist_pc > 0 ? 1000 / row.dist_pc : null, rv: row.rv || 0 };
      err = { pmra: 2 + 0.01 * Math.abs(s.pmra), pmdec: 2 + 0.01 * Math.abs(s.pmdec), plx: s.plx ? 0.05 * s.plx : 0, rv: 2 };
      sources.position = sources.motion = sources.parallax = "catalogue values (HYG; no learnt path yet)";
      if (row.rv) sources.rv = "HYG catalogue";
      if ([row.pmra, row.pmdec].some((v) => Math.abs(v) === 9999.99)) warnings.push("The catalogue motion is capped at 9999.99 mas/yr; learn this star's path for the real value.");
    }
    if (!s || !(s.plx > 0)) return { star: null, warnings: ["No distance is known for this star, so its path through space cannot be drawn."] };
    if (!s.rv) { s.rv = 0; err.rv = 30; sources.rv = "unknown"; warnings.push("No radial velocity: assumed 0 ± 30 km/s, so distance changes are uncertain (see the cloud)."); }
    return { star: s, err, sources, warnings };
  }

  // ---- Monte Carlo: sample the starting state from its errors ----
  function rng(seed) {   // mulberry32 + Box-Muller
    let a = seed >>> 0;
    const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return () => { const x = Math.max(u(), 1e-12), y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  }
  function samples(star, err, n = 300, seed = 1) {
    const g = rng(seed), out = [];
    for (let i = 0; i < n; i++) {
      const plx = star.plx + g() * (err.plx || 0);
      if (!(plx > 0)) continue;
      out.push({ ...star, plx, pmra: star.pmra + g() * (err.pmra || 0), pmdec: star.pmdec + g() * (err.pmdec || 0), rv: star.rv + g() * (err.rv || 0) });
    }
    return out;
  }

  // Spread of the sampled positions at a year: 68% radius on the sky (arcsec) and in distance (ly).
  function spreadAt(clones, year) {
    const ps = clones.map((c) => propagate(c, year));
    const mid = { ra: median(ps.map((p) => p.ra)), dec: median(ps.map((p) => p.dec)) };
    const seps = ps.map((p) => separationArcsec(p, mid)).sort((a, b) => a - b);
    const d = ps.map((p) => p.distLy).sort((a, b) => a - b);
    return { points: ps, sky68: seps[Math.floor(0.68 * (seps.length - 1))], dist16: d[Math.floor(0.16 * (d.length - 1))], dist84: d[Math.floor(0.84 * (d.length - 1))] };
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---- orthographic sky projection (the celestial sphere seen from inside, east left) ----
  function ortho(ra, dec, ra0, dec0) {
    const a = ra * DEG, d = dec * DEG, a0 = ra0 * DEG, d0 = dec0 * DEG;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    return { x: -Math.cos(d) * Math.sin(a - a0) / DEG, y: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / DEG, front: cosc > 0 };
  }

  // Centre of a set of sky positions (mean unit vector).
  function centre(pts) {
    const s = [0, 0, 0];
    for (const p of pts) { const u = basis(p.ra, p.dec).u; s[0] += u[0]; s[1] += u[1]; s[2] += u[2]; }
    let ra = Math.atan2(s[1], s[0]) / DEG; if (ra < 0) ra += 360;
    return { ra, dec: Math.atan2(s[2], Math.hypot(s[0], s[1])) / DEG };
  }

  // A round grid step (degrees) for a field `span` degrees across.
  function gridStep(span) {
    return [1 / 60, 2 / 60, 5 / 60, 10 / 60, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find((s) => span / s <= 8) || 30;
  }

  const fmtYear = (y) => (y <= 0 ? `${Math.round(1 - y)} BCE` : `${Math.round(y)} CE`);
  const fmtAngle = (as) => (as < 60 ? `${as.toFixed(1)}″` : as < 3600 ? `${(as / 60).toFixed(1)}′` : `${(as / 3600).toFixed(2)}°`);

  const api = { DEG, MAS, KMS, LY, basis, toState, fromState, propagate, track, closestApproach, separationArcsec, magAt,
    startState, samples, spreadAt, rng, ortho, centre, gridStep, fmtYear, fmtAngle };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.StarCore = api;
})(typeof window !== "undefined" ? window : globalThis);
