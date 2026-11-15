/* A 1900-2100 path for ANY star, computed (not learnt) from its measured motion, in the same shape as a learnt
 * prediction (pipeline/star_ml.py), so the page's path chart, table and long-range views work for every star.
 *
 * Source of the motion, best first: Gaia DR3 astrometry at epoch 2016.0 (position, proper motion, parallax, radial
 * velocity; from app/data/stars/profile_bulk or a full profile), else the HYG catalogue (epoch 2000; Hipparcos values).
 * Model: straight-line 3D space motion (starcore.js, checked against astropy). Uncertainty: the catalogue's
 * proper-motion errors carried over the years (Gaia's own; for HYG an assumed 2 mas/yr + 1%).
 * Works in the browser (window.PhysicsPath) and in Node (module.exports).
 */
(function (root) {
  "use strict";
  const C = root.StarCore || (typeof require !== "undefined" ? require("./starcore.js") : null);
  const SD = root.StarDB || (typeof require !== "undefined" ? require("./stardb.js") : null);

  // Starting state {ra, dec, epoch, pmra, pmdec, plx, rv} + errors + where it came from.
  function state(row, profile) {
    const a = profile && profile.gaia && profile.gaia.astrometry;
    if (a && Number.isFinite(a.ra) && Number.isFinite(a.pmra) && a.parallax > 0) {
      return { star: { ra: a.ra, dec: a.dec, epoch: 2016.0, pmra: a.pmra, pmdec: a.pmdec, plx: a.parallax, rv: Number.isFinite(a.radial_velocity) ? a.radial_velocity : (row && row.rv) || 0 },
        err: { pmra: a.pmra_error || 0.05, pmdec: a.pmdec_error || 0.05, plx: a.parallax_error || 0.05 },
        basis: `Gaia DR3 ${profile.gaia.source_id} (position, motion and parallax at 2016.0)`, rvKnown: Number.isFinite(a.radial_velocity) || !!(row && row.rv) };
    }
    if (row && row.dist_pc > 0 && Number.isFinite(row.pmra)) {
      return { star: { ra: row.ra, dec: row.dec, epoch: row.epoch || 2000.0, pmra: row.pmra, pmdec: row.pmdec || 0, plx: 1000 / row.dist_pc, rv: row.rv || 0 },
        err: { pmra: 2 + 0.01 * Math.abs(row.pmra), pmdec: 2 + 0.01 * Math.abs(row.pmdec || 0), plx: 0.05 * 1000 / row.dist_pc },
        basis: "HYG catalogue (Hipparcos position and motion at 2000.0)", rvKnown: !!row.rv };
    }
    return null;
  }

  // -> object shaped like a learnt prediction (path.rows, table, now, anchor, learnt, gaia_dr3, catalogue_motion), or null.
  function build(row, profile, now) {
    const st = state(row, profile);
    if (!st) return null;
    const s = st.star;
    now = now || (2000 + (Date.now() / 86400000 + 2440587.5 - 2451545) / 365.25);
    const at2000 = C.propagate(s, 2000), anchor = { ra: at2000.ra, dec: at2000.dec };
    const muErr = Math.hypot(st.err.pmra, st.err.pmdec) / 1000;                  // arcsec per year
    const years = []; for (let y = 1900; y <= 2100; y++) years.push(y);
    if (!years.includes(now)) years.push(now);
    years.sort((a, b) => a - b);
    const rows = years.map((y) => {
      const p = C.propagate(s, y), [dx, dy] = SD.offsets(p.ra, p.dec, anchor.ra, anchor.dec);
      return [Math.round(y * 1000) / 1000, +p.ra.toFixed(7), +p.dec.toFixed(7), +dx.toFixed(3), +dy.toFixed(3), +(muErr * Math.abs(y - s.epoch)).toFixed(3)];
    });
    const r2000 = rows.find((r) => r[0] === 2000);
    const table = [1900, 1950, 2000, now, 2050, 2100].map((y) => {
      const r = rows.reduce((b, x) => (Math.abs(x[0] - y) < Math.abs(b[0] - y) ? x : b));
      return { year: r[0], ra: r[1], dec: r[2], unc_arcsec: r[5], moved_from_2000_arcsec: +Math.hypot(r[3] - r2000[3], r[4] - r2000[4]).toFixed(2) };
    });
    const v16 = C.propagate(s, 2016);
    return {
      kind: "physics", key: row && row.key, name: (row && row.name) || (profile && profile.name), basis: st.basis, rvKnown: st.rvKnown,
      path: { fields: ["year", "ra", "dec", "dx_arcsec", "dy_arcsec", "unc68_arcsec"], rows }, now, anchor, table,
      observations: [],
      // the fields starcore.startState() reads, so the long-range views start from the same state
      learnt: { pmra_2016: v16.pmra, pmdec_2016: v16.pmdec, pmra_err: st.err.pmra, pmdec_err: st.err.pmdec, parallax_mas: null,
                speed_arcsec_yr: Math.hypot(s.pmra, s.pmdec) / 1000 },
      gaia_dr3: st.basis.startsWith("Gaia") ? { parallax: s.plx, parallax_error: st.err.plx, radial_velocity: st.rvKnown ? s.rv : null } : null,
      catalogue_motion: { source: st.basis, pmra: s.pmra, pmdec: s.pmdec, parallax: s.plx },
    };
  }

  const api = { build, state };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PhysicsPath = api;
})(typeof window !== "undefined" ? window : globalThis);
