/* Frame details and data-flag summary for the WANDERERS viewer.
 *
 * Turns a target's target.json into plain rows and numbers the page can show:
 *   - one row per frame of a wavelength channel (epoch, SPHEREx images stacked, was the object seen, signal, verdict)
 *   - how many SPHEREx spectrum measurements were left out because of flagged pixels
 *   - the SPHEREx visits and how many images each had
 *   - for the frame on screen: mission, instrument, detector, wavelength at the target, dates, images stacked, flags,
 *     saturation, bad pixels near the target and the pipeline's good / caution / poor verdict (frameMeta)
 *   - a legend of the SPHEREx flag planes, with the meaning each FITS header gives (flagLegend), and one readable
 *     row per SPHEREx image (imageRows)
 *   - the channel switch: wavelength-matched channels, individual detectors D1-D6, or all six combined
 * It only reports what the pipeline recorded (pipeline/analyze.py). Data prepared before a field existed degrades to
 * "not recorded" instead of breaking.
 *
 * Works in the browser (window.FrameInfo) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  // What makes a SPHEREx measurement unusable. From pipeline/analyze.py (BAD_NAMES), the conservative set from
  // the SPHEREx Explanatory Supplement that IRSA's source-discovery tutorial uses, in plain words.
  const FLAG_KINDS = ["saturation (overflow)", "bloom", "ghosts", "streaks", "persistence", "cross-talk",
    "non-linear pixels", "hot, cold or non-functional pixels", "missing data", "transients", "snowballs", "halos"];
  // The same set by flag-plane name (analyze.py BAD_NAMES), for data whose target.json has no flag_legend yet.
  const BAD_NAMES = ["TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD",
    "NONLINEAR", "PERSIST", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO"];
  const INFO_NAMES = ["SOURCE", "FULLSAMPLE"];
  // Detector slices in µm (analyze.py DETECTOR_BANDS); target.json carries its own copy as detector_bands.
  const DETECTOR_BANDS = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.0] };
  const COMBINED = "all";
  const VERDICTS = { good: "Good", caution: "Caution", poor: "Poor", unknown: "Not assessed" };

  const fmtSnr = (s) => (s >= 100 ? `${Math.round(s)}σ` : `${s.toFixed(1)}σ`);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function frameRow(f) {
    const spherex = f.mission === "SPHEREx";
    let seen, tone;
    if (typeof f.detected === "boolean") { seen = f.detected ? (f.saturated_core ? "seen (saturated)" : "seen") : "not detected"; tone = f.detected ? "ok" : "warn"; }
    else { seen = "not measured"; tone = "mute"; }
    const v = f.quality && VERDICTS[f.quality.verdict] ? f.quality.verdict : null;
    return {
      label: f.label,
      epoch: Number.isFinite(f.year) ? f.year.toFixed(1) : "",
      source: spherex ? "SPHEREx" : f.mission === "NEOWISE" ? "NEOWISE single exposures" : "AllWISE atlas",
      images: (spherex || f.mission === "NEOWISE") && Number.isFinite(f.n_images) ? f.n_images : null,
      seen, tone,
      signal: typeof f.snr === "number" && Number.isFinite(f.snr) ? fmtSnr(f.snr) : "",
      verdict: v, verdictLabel: v ? VERDICTS[v] : "",
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

  // ---------- channels: wavelength-matched, individual detectors, all six combined ----------
  const isDet = (c) => /^d[1-6]$/.test(c);
  function channelGroups(t) {
    const fr = (t && t.frames) || {};
    const has = (c) => Object.prototype.hasOwnProperty.call(fr, c) && Array.isArray(fr[c]) && fr[c].length > 0;
    const keys = Object.keys(fr).filter(has);
    return {
      wavelength: keys.filter((c) => !isDet(c) && c !== COMBINED),
      detectors: keys.filter(isDet).sort(),
      combined: has(COMBINED) ? COMBINED : null,
    };
  }
  // Which half of the detector switch a channel belongs to: "individual" (D1-D6), "combined", or null (3.4 / 4.6 µm).
  const detectorMode = (ch) => (ch === COMBINED ? "combined" : isDet(ch) ? "individual" : null);
  // Everything the switch shows. lastDet: the detector picked before, so Individual returns to it.
  function switchState(t, ch, lastDet) {
    const g = channelGroups(t);
    const det = isDet(ch) && g.detectors.includes(ch) ? ch : g.detectors.includes(lastDet) ? lastDet : g.detectors[0] || null;
    const bands = (t && t.detector_bands) || {};
    return {
      mode: detectorMode(ch),
      show: g.detectors.length > 0 || !!g.combined,
      individual: { available: g.detectors.length > 0, channel: det },
      combined: { available: !!g.combined, channel: g.combined },
      picks: g.detectors.map((c) => ({ ch: c, label: `D${c.slice(1)}`, range: bandText(bands[c.slice(1)] || DETECTOR_BANDS[c.slice(1)]), on: c === ch })),
    };
  }
  // Arrow-key movement inside a radio group (WAI-ARIA radio pattern): wraps around; null for other keys.
  function radioStep(ids, cur, key) {
    if (!ids || !ids.length) return null;
    const i = Math.max(0, ids.indexOf(cur)), n = ids.length;
    if (key === "ArrowRight" || key === "ArrowDown") return ids[(i + 1) % n];
    if (key === "ArrowLeft" || key === "ArrowUp") return ids[(i - 1 + n) % n];
    if (key === "Home") return ids[0];
    if (key === "End") return ids[n - 1];
    return null;
  }

  // ---------- the frame on screen: observation metadata and contamination ----------
  function bandText(b) {
    if (!Array.isArray(b) || num(b[0]) === null || num(b[1]) === null) return "";
    return `${b[0].toFixed(2)}–${b[1].toFixed(2)} µm`;
  }
  function lamText(l) {
    if (!Array.isArray(l) || num(l[0]) === null) return "";
    const hi = num(l[1]) === null ? l[0] : l[1];
    return Math.abs(hi - l[0]) < 0.005 ? `${l[0].toFixed(2)} µm` : `${l[0].toFixed(2)}–${hi.toFixed(2)} µm`;
  }
  function timeText(o) {
    const s = o && typeof o.start === "string" ? o.start : "", e = o && typeof o.end === "string" ? o.end : "";
    if (!s && !e) return "";
    if (!e || e === s) return `${s || e} UTC`;
    if (!s) return `${e} UTC`;
    return s.slice(0, 10) === e.slice(0, 10) ? `${s}–${e.slice(11)} UTC` : `${s} → ${e} UTC`;
  }
  function detText(o, t) {
    const d = o && Array.isArray(o.detectors) ? o.detectors.filter((x) => Number.isInteger(x)) : [];
    if (!d.length) return "";
    const bands = (t && t.detector_bands) || {};
    const range = (k) => bandText(bands[String(k)] || DETECTOR_BANDS[k]);
    if (d.length === 1) return `D${d[0]}${range(d[0]) ? ` · ${range(d[0])}` : ""}`;
    const all = bandText(o.band_um);
    return `${d.map((k) => `D${k}`).join(", ")}${all ? ` · ${all}` : ""}`;
  }
  const countsText = (c) => {
    const e = c && typeof c === "object" ? Object.entries(c).filter(([, n]) => Number(n) > 0) : [];
    return e.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ×${n}`).join(", ");
  };

  // One panel model per frame: verdict + chips (label, value, tone). Missing data gives "not recorded", never throws.
  function frameMeta(t, ch, i) {
    const fr = (t && t.frames && t.frames[ch]) || [], f = fr[i];
    if (!f) return null;
    const o = f.obs || {}, q = f.quality || null, spx = f.mission === "SPHEREx";
    const n = num(f.n_images);
    const chips = [];
    const add = (k, v, tone = "", title = "") => chips.push({ k, v: v === "" || v == null ? "not recorded" : String(v), tone: v === "" || v == null ? "mute" : tone, title });
    add("Mission", o.mission || f.mission || "");
    add("Instrument", o.instrument || "");
    if (spx) add(o.detectors && o.detectors.length > 1 ? "Detectors" : "Detector", detText(o, t));
    add("λ at target", lamText(o.lam_um), "", o.lam_note || "");
    add("Observed", timeText(o), "", o.time_note || "");
    add("Stacked", n !== null ? plural(n, "image") : f.mission === "WISE" ? "atlas co-add" : "");
    let verdict;
    if (!q || !VERDICTS[q.verdict]) {
      verdict = { level: "unknown", label: VERDICTS.unknown, reason: "No quality check is recorded for this frame." };
      add("Flags at target", "");
      add("Target saturated", "");
      add("Bad pixels near target", "");
    } else {
      verdict = { level: q.verdict, label: VERDICTS[q.verdict], reason: q.reason || "" };
      if (q.flags_checked === false) add("Flags at target", "not checked (no WISE flag images here)", "mute");
      else {
        const ap = countsText(q.flag_counts), px = countsText(q.pixel_flag_counts);
        add("Flags at target pixel", px || "none", px ? "warn" : "ok");
        add("Flags within 3 px", ap || "none", ap ? "warn" : "ok");
      }
      const sat = num(q.n_saturated);
      if (sat === null) add("Target saturated", "");
      else if (!spx) add("Target saturated", sat ? "yes (blank core)" : "no", sat ? "bad" : "ok");
      else add("Target saturated", sat ? `yes, in ${sat} of ${plural(n || sat, "image")}` : "no", sat ? "bad" : "ok");
      const worst = num(q.bad_px_worst), ap = num(q.aperture_px), hit = num(q.images_with_bad_px);
      if (worst === null || ap === null) add("Bad pixels near target", "");
      else if (!spx) add("Blank pixels near target", `${worst} of ${ap}`, worst ? "warn" : "ok");
      else add("Bad pixels near target", `${worst} of ${ap}${n && n > 1 ? " in the worst image" : ""}` +
        (hit !== null && n && n > 1 ? ` · ${hit} of ${n} images affected` : ""), worst ? "warn" : "ok");
      if (q.detector_verdicts && typeof q.detector_verdicts === "object") {
        const dv = Object.entries(q.detector_verdicts).map(([d, v]) => `D${d} ${VERDICTS[v] ? VERDICTS[v].toLowerCase() : "?"}`).join(" · ");
        if (dv) add("Each detector", dv, Object.values(q.detector_verdicts).some((v) => v !== "good") ? "warn" : "ok");
      }
    }
    return { verdict, chips, label: f.label || "", channel: ch, index: i };
  }

  // ---------- flag legend and per-image rows ----------
  // The legend from target.json (meanings straight from the FITS headers), else names only from the image list.
  function flagLegend(t) {
    const L = t && Array.isArray(t.flag_legend) ? t.flag_legend : null;
    let rows;
    if (L) rows = L.filter((r) => r && r.name).map((r) => ({ name: String(r.name), bit: num(r.bit), desc: r.description || "",
      bad: !!r.bad, info: !!r.informational, hidden: !!r.hidden_in_pictures, images: num(r.images_aperture) || 0, pixel: num(r.images_target_pixel) || 0 }));
    else {
      const seen = {};
      for (const m of (t && t.metadata) || []) for (const f of m.flags_at_target || []) seen[f] = (seen[f] || 0) + 1;
      rows = Object.entries(seen).map(([name, k]) => ({ name, bit: null, desc: "", bad: BAD_NAMES.includes(name), info: INFO_NAMES.includes(name), hidden: false, images: k, pixel: null }));
    }
    return rows.sort((a, b) => (b.images > 0) - (a.images > 0) || (a.bit ?? 99) - (b.bit ?? 99) || (a.name < b.name ? -1 : 1));
  }
  function imageRows(t) {
    const legend = Object.fromEntries(flagLegend(t).map((r) => [r.name, r]));
    const flag = (name) => ({ name, desc: (legend[name] && legend[name].desc) || "", bad: legend[name] ? legend[name].bad : BAD_NAMES.includes(name) });
    return ((t && t.metadata) || []).map((m) => {
      const v = VERDICTS[m.quality] ? m.quality : null;
      const ap = num(m.aperture_px), bad = num(m.bad_px_aperture);
      return {
        date: m.date || "", det: Number.isInteger(m.detector) ? `D${m.detector}` : "", lam: num(m.lam_um) !== null ? `${m.lam_um} µm` : "–",
        pixel: Array.isArray(m.flags_target_pixel) ? m.flags_target_pixel.map(flag) : null,
        aperture: (m.flags_at_target || []).map(flag),
        saturated: typeof m.saturated === "boolean" ? m.saturated : null,
        badPx: bad !== null && ap !== null ? `${bad}/${ap}` : "",
        verdict: v, verdictLabel: v ? VERDICTS[v] : "", reason: m.quality_reason || "",
        inSpectrum: !!m.used_in_spectrum,
      };
    });
  }
  // Counts for the summary line above the image table.
  function imageSummary(t) {
    const rows = imageRows(t), by = { good: 0, caution: 0, poor: 0 };
    rows.forEach((r) => { if (r.verdict) by[r.verdict]++; });
    return { n: rows.length, ...by, assessed: rows.some((r) => r.verdict), saturated: rows.filter((r) => r.saturated).length,
      withFlags: rows.filter((r) => r.aperture.length).length, inSpectrum: rows.filter((r) => r.inSpectrum).length };
  }

  const api = { describe, quality, frameRow, fmtSnr, FLAG_KINDS, BAD_NAMES, DETECTOR_BANDS, COMBINED, VERDICTS,
    channelGroups, detectorMode, switchState, radioStep, frameMeta, flagLegend, imageRows, imageSummary,
    bandText, lamText, timeText, detText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FrameInfo = api;
})(typeof window !== "undefined" ? window : globalThis);
