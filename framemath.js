/* Frame maths for the WANDERERS viewer: add or subtract the displayed sky images in the browser.
 *
 * Input is brightness per pixel (0-255 luminance of the flipbook PNGs). Those PNGs are stretched
 * (asinh, own limits per frame), so this is for SEEING motion, not for measuring flux; measurements
 * live in the pipeline and the evidence card. Subtraction first matches the brightness scale of the
 * two frames with a least-squares gain and offset, so stars that did not move mostly cancel.
 *
 * Works in the browser (window.FrameMath) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  function sameSize(...arrs) {
    const n = arrs[0].length;
    if (!arrs.every((a) => a.length === n)) throw new Error("Frames must have the same size.");
    return n;
  }

  // Luminance (0-255) from RGBA bytes.
  function lumFromRGBA(data) {
    const n = data.length / 4, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
    return out;
  }

  // p-th percentile (0-100) of the values, ignoring NaN. Returns 0 for an empty set.
  function percentile(values, p) {
    const v = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
    if (!v.length) return 0;
    const k = (p / 100) * (v.length - 1), lo = Math.floor(k), hi = Math.ceil(k);
    return v[lo] + (v[hi] - v[lo]) * (k - lo);
  }

  // Light smoothing (box average of radius r pixels) to calm pixel noise before subtracting.
  function smooth(v, w, h, r) {
    if (!(r > 0)) return Float32Array.from(v);
    if (v.length !== w * h) throw new Error("Size does not match width x height.");
    const iw = w + 1, I = new Float64Array(iw * (h + 1)), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += v[y * w + x]; I[(y + 1) * iw + x + 1] = I[y * iw + x + 1] + row; }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r), y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      out[y * w + x] = (I[(y1 + 1) * iw + x1 + 1] - I[y0 * iw + x1 + 1] - I[(y1 + 1) * iw + x0] + I[y0 * iw + x0]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
    return out;
  }

  // Add frames together: the per-pixel average. Averaging several frames lowers the random noise.
  function add(frames) {
    if (!frames.length) throw new Error("Pick at least one frame.");
    const n = sameSize(...frames), out = new Float32Array(n);
    for (const f of frames) for (let i = 0; i < n; i++) out[i] += f[i];
    for (let i = 0; i < n; i++) out[i] /= frames.length;
    return out;
  }

  const GAIN_MIN = 0.3, GAIN_MAX = 3;

  // Gain and offset so that  gain * a + offset  best matches b (least squares).
  // Moving objects and noise would pull a plain fit off, so after each fit the worst-matching
  // `trim` fraction of pixels is left out and the fit is repeated.
  function matchBrightness(a, b, opts) {
    const n = sameSize(a, b), trim = (opts && opts.trim) ?? 0.01, rounds = (opts && opts.rounds) ?? 3;
    let keep = null, gain = 1, offset = 0;
    for (let round = 0; round < rounds; round++) {
      let m = 0, sa = 0, sb = 0, saa = 0, sab = 0;
      for (let i = 0; i < n; i++) {
        if (keep && !keep[i]) continue;
        m++; sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sab += a[i] * b[i];
      }
      if (!m) break;
      const den = m * saa - sa * sa;
      gain = Math.abs(den) < 1e-9 ? 1 : (m * sab - sa * sb) / den;
      offset = (sb - gain * sa) / m;
      // A sparse sky with few shared stars (for example one bright star that moved) has no usable
      // brightness relationship: the fit can come out near zero or negative. Fall back to equal
      // scale, shifted so the typical background level agrees.
      if (!(gain >= GAIN_MIN && gain <= GAIN_MAX)) { gain = 1; offset = percentile(b, 50) - percentile(a, 50); break; }
      if (round === rounds - 1) break;
      const res = new Float32Array(n);
      for (let i = 0; i < n; i++) res[i] = Math.abs(b[i] - (gain * a[i] + offset));
      const cut = percentile(res, 100 * (1 - trim));
      keep = new Uint8Array(n);
      for (let i = 0; i < n; i++) keep[i] = res[i] <= cut ? 1 : 0;
    }
    return { gain, offset };
  }

  // later minus earlier, after matching the earlier frame's brightness to the later one.
  // Positive = brighter in the later frame ("now"), negative = brighter in the earlier one ("before").
  function subtract(earlier, later) {
    const n = sameSize(earlier, later), { gain, offset } = matchBrightness(earlier, later), d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = later[i] - (gain * earlier[i] + offset);
    return { diff: d, gain, offset };
  }

  // Colour scale for a difference image: the 99.5th percentile of |d|, but never below `floor`
  // (so a pair of identical frames does not turn pure noise into bright colour).
  function autoScale(diff, floor = 6) {
    const a = new Float32Array(diff.length);
    for (let i = 0; i < diff.length; i++) a[i] = Math.abs(diff[i]);
    return Math.max(percentile(a, 99.5), floor);
  }

  // RGBA picture of a difference: green where it is brighter now, pink where it was brighter before,
  // over a dim copy of the later frame. Differences smaller than `threshold` (a fraction of the
  // colour scale, default 0.25) stay grey, so raising it hides faint speckle.
  function diffToRGBA(diff, base, scale, threshold) {
    const n = sameSize(diff, base), out = new Uint8ClampedArray(n * 4), s = scale || autoScale(diff), th = threshold ?? 0.25;
    for (let i = 0; i < n; i++) {
      const g = Math.min(255, Math.max(0, base[i])) * 0.35, d = diff[i], m = Math.abs(d) / s;
      let r = g, gr = g, b = g;
      if (m > th) {
        const k = Math.min(1, m);
        if (d > 0) { r = g * 0.4 + 60 * k; gr = g * 0.4 + 255 * k; b = g * 0.4 + 140 * k; }
        else { r = g * 0.4 + 255 * k; gr = g * 0.4 + 95 * k; b = g * 0.4 + 168 * k; }
      }
      out[4 * i] = r; out[4 * i + 1] = gr; out[4 * i + 2] = b; out[4 * i + 3] = 255;
    }
    return out;
  }

  // RGBA grey picture of a 0-255 brightness image.
  function grayToRGBA(v) {
    const out = new Uint8ClampedArray(v.length * 4);
    for (let i = 0; i < v.length; i++) { out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = v[i]; out[4 * i + 3] = 255; }
    return out;
  }

  const api = { lumFromRGBA, percentile, smooth, add, matchBrightness, subtract, autoScale, diffToRGBA, grayToRGBA };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FrameMath = api;
})(typeof window !== "undefined" ? window : globalThis);
