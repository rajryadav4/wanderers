/* Frame details and data-flag summary for the WANDERERS viewer.
 *
 * Turns a target's target.json into plain rows and numbers the page can show:
 *   - one row per frame of a wavelength channel (epoch, SPHEREx images stacked, was the object seen, signal)
 *   - how many SPHEREx spectrum measurements were left out because of flagged pixels
 *   - the SPHEREx visits and how many images each had
 * It only reports what the pipeline recorded. The pipeline keeps a flagged/not-flagged count, not a
 * count per flag type, so none is shown.
 *
 * Works in the browser (window.FrameInfo) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  // What makes a SPHEREx measurement unusable. From pipeline/analyze.py (BAD_NAMES), the conservative set from
  // the SPHEREx Explanatory Supplement that IRSA's source-discovery tutorial uses, in plain words.
  const FLAG_KINDS = ["saturation (overflow)", "bloom", "ghosts", "streaks", "persistence", "cross-talk",
    "non-linear pixels", "hot, cold or non-functional pixels", "missing data", "transients", "snowballs", "halos"];

  const fmtSnr = (s) => (s >= 100 ? `${Math.round(s)}σ` : `${s.toFixed(1)}σ`);

  function frameRow(f) {
    const spherex = f.mission === "SPHEREx";
    let seen, tone;
    if (typeof f.detected === "boolean") { seen = f.detected ? "seen" : "not detected"; tone = f.detected ? "ok" : "warn"; }
    else { seen = "not measured"; tone = "mute"; }
    return {
      label: f.label,
      epoch: Number.isFinite(f.year) ? f.year.toFixed(1) : "",
      source: spherex ? "SPHEREx" : f.mission === "NEOWISE" ? "NEOWISE single exposures" : "AllWISE atlas",
      images: (spherex || f.mission === "NEOWISE") && Number.isFinite(f.n_images) ? f.n_images : null,
      seen, tone,
      signal: typeof f.snr === "number" && Number.isFinite(f.snr) ? fmtSnr(f.snr) : "",
    };
  }

  // How much of the SPHEREx spectrum survived the flags.
  function quality(t) {
    const total = Number(t.spectrum_points) || 0, flagged = Number(t.flagged_points) || 0;
    if (total <= 0) return { total: 0, flagged: 0, pct: null, level: "none", text: "No SPHEREx spectrum measurements for this target." };
    const pct = Math.round((100 * flagged) / total);
    const level = pct < 25 ? "ok" : pct <= 60 ? "warn" : "bad";
    let text = `${flagged} of ${total} SPHEREx measurements (${pct}%) were left out because of flagged pixels near the target.`;
    if (flagged >= total) text += " None were usable, so there is no spectrum.";
    if (flagged > total / 2) text += " This object is bright enough to saturate SPHEREx at many wavelengths.";
    return { total, flagged, pct, level, text };
  }

  function describe(t, channel) {
    const frames = (t && t.frames && t.frames[channel]) || [];
    const visits = ((t && t.spherex_visits) || []).map((v, i) => ({ n: i + 1, epoch: Number(v.year).toFixed(2), images: v.n_images }));
    return {
      rows: frames.map(frameRow),
      quality: quality(t || {}),
      visits,
      visitImages: visits.reduce((s, v) => s + (Number(v.images) || 0), 0),
      flagKinds: FLAG_KINDS,
    };
  }

  const api = { describe, quality, frameRow, fmtSnr, FLAG_KINDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FrameInfo = api;
})(typeof window !== "undefined" ? window : globalThis);
