/* Predicted star path (from pipeline/star_trajectory.py -> data/<id>/trajectory.json).
 *
 * The path is a list of [year, x, y] samples in display-grid pixels (same grid as the flipbook PNGs,
 * x right, y up). These helpers read it; drawing stays in app.js.
 *
 * Works in the browser (window.StarPath) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  // Position at a decimal year by straight-line interpolation between samples; null outside the path.
  function at(path, year) {
    if (!Array.isArray(path) || path.length === 0 || !Number.isFinite(year)) return null;
    if (year < path[0][0] || year > path[path.length - 1][0]) return null;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m][0] <= year) lo = m; else hi = m; }
    const [y0, x0, v0] = path[lo], [y1, x1, v1] = path[hi];
    const f = y1 === y0 ? 0 : (year - y0) / (y1 - y0);
    return { x: x0 + f * (x1 - x0), y: v0 + f * (v1 - v0) };
  }

  // Samples between two years (inclusive), with exact end points added so the line starts and stops on time.
  function between(path, from, to) {
    if (!Array.isArray(path) || !path.length) return [];
    const a = Math.max(Math.min(from, to), path[0][0]), b = Math.min(Math.max(from, to), path[path.length - 1][0]);
    if (a > b) return [];
    const inside = path.filter((p) => p[0] > a && p[0] < b).map((p) => ({ x: p[1], y: p[2] }));
    return [at(path, a), ...inside, at(path, b)];
  }

  // Arcseconds -> short readable text.
  const arcsec = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v < 1 ? `${v.toFixed(2)}″` : `${v.toFixed(1)}″`);

  // One-paragraph plain summary of a trajectory.json for the page.
  function summary(tr) {
    if (!tr) return "";
    const s = tr.summary || {}, src = ((tr.reference || {}).source || "catalogue").split(",")[0];
    const parts = [`Predicted from ${src}: ${tr.proper_motion_arcsec_per_yr.toFixed(2)}″/yr`];
    if (tr.parallax_loop_arcsec >= 0.01) parts[0] += ` plus a yearly parallax loop of ±${arcsec(tr.parallax_loop_arcsec)}`;
    parts[0] += ".";
    if (s.n_measured) parts.push(`It agrees with the ${s.n_measured} measured positions to ${arcsec(s.rms_arcsec)} rms (one SPHEREx pixel is 6.15″).`);
    const fc = (tr.forecast || []).find((f) => f.year >= 2030) || (tr.forecast || [])[0];
    if (fc) parts.push(`In ${Math.floor(fc.year)} it should be at RA ${fc.ra.toFixed(5)}°, Dec ${fc.dec >= 0 ? "+" : ""}${fc.dec.toFixed(5)}°` +
      (fc.in_field ? "." : ", outside this field."));
    return parts.join(" ");
  }

  const api = { at, between, summary, arcsec };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.StarPath = api;
})(typeof window !== "undefined" ? window : globalThis);
