/* Layout helpers for the spectrum chart: how wide to draw it, and where the band names go.
 *
 * The chart used to be drawn in a fixed 900-pixel space and shrunk to fit, which made its text tiny on a
 * phone. Drawing at the real width keeps text a readable size, but then the band names across the top can
 * overlap where bands sit close together, so placeLabels() moves a name that does not fit to a second row
 * and leaves it out only if neither row has room (the legend and hover text still name every band).
 *
 * Works in the browser (window.ChartLayout) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  const MIN_W = 260, MAX_W = 1400, NARROW = 520;
  const CHAR_W = 3.6;       // half the width of one character of the 11px monospace label, with a little to spare

  // Width to draw at: what the element really has, kept within sensible limits; 900 if unknown.
  function chartWidth(measured) {
    const m = Number(measured);
    const w = Number.isFinite(m) && m > 0 ? m : 900;
    return Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
  }

  const chartHeight = (w) => (w < NARROW ? 230 : 260);

  // "H2O" -> "H₂O", "CH4" -> "CH₄"
  const prettyName = (n) => String(n).replace("2", "₂").replace("4", "₄");

  // bands: [{name, lo, hi}] in micrometres; x: micrometres -> pixels. Returns [{name, cx, row}] sorted left to right.
  function placeLabels(bands, x, opts) {
    const rows = (opts && opts.rows) || 2, gap = (opts && opts.gap) || 2, edge = new Array(rows).fill(-Infinity), out = [];
    for (const b of [...bands].sort((p, q) => p.lo - q.lo)) {
      const name = prettyName(b.name), cx = (x(b.lo) + x(b.hi)) / 2, hw = name.length * CHAR_W + gap;
      const r = edge.findIndex((e) => cx - hw >= e + gap);
      if (r < 0) continue;
      edge[r] = cx + hw;
      out.push({ name, cx, row: r, left: cx - hw, right: cx + hw });
    }
    return out;
  }

  const api = { chartWidth, chartHeight, prettyName, placeLabels, MIN_W, MAX_W, NARROW };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ChartLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
