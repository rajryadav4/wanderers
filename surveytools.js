/* Sky Survey tools for the step from "ranked list" to "a human investigates" (app/survey.html).
 *
 *  - Where a candidate is at any date: its NEOWISE position moved with its own measured motion (straight line on
 *    the sky, unit vectors, so RA 0/360 and the poles need no special case), with the uncertainty that adds.
 *  - Links to look it up elsewhere, each at the right date: sky viewers at today's predicted position (IRSA Finder
 *    Chart, Aladin Lite, Legacy Surveys); catalogues at J2000 (SIMBAD, VizieR) or 2016.0 (Gaia DR3 in VizieR).
 *  - The filtered list as CSV or JSON (built here, downloaded by the page as a Blob: no server needed).
 *  - Filter state <-> URL parameters, so a shared link reproduces the list, and the "high-confidence" preset.
 *
 * No WiseView link: its URL format is not publicly documented, so a link could open the wrong place.
 * Works in the browser (window.SurveyTools) and in Node (module.exports) for the tests.
 */
(function (root) {
  "use strict";
  const AL = root.AladinLink || (typeof require === "function" ? require("./aladinlink.js") : null);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, MAS_PER_RAD = (180 / Math.PI) * 3.6e6;
  const J2000 = 2000.0, GAIA_EPOCH = 2016.0, LATER = 2030.0;

  const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" ? NaN : Number(v));
  const fin = (v) => Number.isFinite(num(v));

  // ---------- dates and positions ----------
  // Decimal year of a date (UTC), e.g. 2026-07-02 -> 2026.5
  function decimalYear(date) {
    const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
    const y = d.getUTCFullYear(), a = Date.UTC(y, 0, 1), b = Date.UTC(y + 1, 0, 1);
    return y + (d.getTime() - a) / (b - a);
  }
  // (ra, dec) in degrees after dt years of motion pmra (includes cos dec), pmdec in mas/yr
  function propagate(ra, dec, pmra, pmdec, dt) {
    const a = ra * D2R, d = dec * D2R, k = dt / MAS_PER_RAD;
    const p = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    const e = [-Math.sin(a), Math.cos(a), 0], n = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
    const q = p.map((v, i) => v + (pmra * e[i] + pmdec * n[i]) * k), len = Math.hypot(q[0], q[1], q[2]);
    return { ra: ((Math.atan2(q[1], q[0]) * R2D) % 360 + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, q[2] / len))) * R2D };
  }
  // Angle between two positions, arcsec
  function sepArcsec(a, b) {
    const u = (p) => [Math.cos(p.dec * D2R) * Math.cos(p.ra * D2R), Math.cos(p.dec * D2R) * Math.sin(p.ra * D2R), Math.sin(p.dec * D2R)];
    const x = u(a), y = u(b), c = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    return 2 * Math.asin(Math.min(1, c / 2)) * R2D * 3600;
  }
  // Where the candidate is at `year`: {ra, dec, epoch, dt, err (arcsec, from pm_err; null if unknown), moved}
  function positionAt(m, year) {
    if (!m || !fin(m.ra) || !fin(m.dec)) return null;
    const ra = num(m.ra), dec = num(m.dec), ep = num(m.epoch), pmra = num(m.pmra), pmdec = num(m.pmdec);
    const moving = Number.isFinite(ep) && Number.isFinite(pmra) && Number.isFinite(pmdec) && Number.isFinite(year);
    const dt = moving ? year - ep : 0;
    const p = moving && dt !== 0 ? propagate(ra, dec, pmra, pmdec, dt) : { ra: ra >= 0 && ra < 360 ? ra : ((ra % 360) + 360) % 360, dec };
    const err = moving && fin(m.pm_err) ? Math.abs(dt) * Math.abs(num(m.pm_err)) / 1000 : null;
    return { ra: p.ra, dec: p.dec, epoch: moving ? year : ep, dt, err, moved: moving };
  }
  function pmOf(m) {
    if (fin(m.pm)) return Math.abs(num(m.pm));
    return fin(m.pmra) && fin(m.pmdec) ? Math.hypot(num(m.pmra), num(m.pmdec)) : 0;
  }
  // The dates the drawer lists: measured (NEOWISE mean epoch), J2000, Gaia DR3, today, 2030
  function timeline(m, now) {
    const t = Number.isFinite(num(now)) ? num(now) : decimalYear();
    const rows = [["neowise", "NEOWISE (measured)", num(m && m.epoch)], ["j2000", "J2000 (SIMBAD, most catalogues)", J2000],
      ["gaia", "2016.0 (Gaia DR3)", GAIA_EPOCH], ["now", "Today (predicted)", t], ["later", "2030 (predicted)", LATER]];
    return rows.map(([key, label, year]) => ({ key, label, ...(positionAt(m, key === "neowise" ? num(m && m.epoch) : year) || {}) }))
      .filter((r) => Number.isFinite(r.ra));
  }

  // ---------- investigate links ----------
  const fmt = (v, d = 6) => num(v).toFixed(d);
  const signed = (dec, plus) => (dec < 0 ? "" : plus) + fmt(dec);         // a "+" must be encoded in a query string
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Cone radius for a catalogue search at a moved position: 5" plus 3 sigma of the move plus one year of motion
  // (some catalogue entries are for their own observation date, not exactly J2000/2016.0); whole arcsec, 5" to 120"
  const coneArcsec = (p, pmArcsecYr) => clamp(Math.ceil(5 + 3 * (p && p.err ? p.err : 0) + (Number.isFinite(pmArcsecYr) ? pmArcsecYr : 0)), 5, 120);
  const IRSA_FINDER = "https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api";
  const LEGACY = "https://www.legacysurvey.org/viewer";
  const SIMBAD = "https://simbad.cds.unistra.fr/simbad/sim-coo";
  const VIZIER = "https://vizier.cds.unistra.fr/viz-bin/";
  function archiveLinks(m, opts) {
    const o = opts || {}, nowYear = Number.isFinite(num(o.now)) ? num(o.now) : decimalYear();
    const now = positionAt(m, nowYear), j2000 = positionAt(m, J2000), gaia = positionAt(m, GAIA_EPOCH);
    if (!now) return null;
    const pm = pmOf(m) / 1000;                                             // arcsec per year
    const yrs = now.moved ? Math.max(0, nowYear - 2000) : 0;
    // Finder Chart (DSS 1950s .. WISE 2010): wide enough for the path since 2000, 2' to 6' (the service's range)
    const finderArcmin = clamp(Math.ceil(2 * pm * yrs / 60 + 1), 2, 6);
    // Aladin (AllWISE colour, 2010): the path since 2010 plus a margin, 1' to 30'
    const aladinArcsec = clamp(Math.round(2 * pm * Math.max(0, nowYear - 2010) + 60), 60, 1800);
    const zoom = pm < 1 ? 16 : pm < 3 ? 15 : 14;
    const nowTxt = `today (${nowYear.toFixed(2)})`;
    const links = [
      { key: "finder", label: "IRSA Finder Chart", at: "now", when: nowTxt, note: "DSS, SDSS, 2MASS and WISE images of the spot, 1950s to 2010s",
        href: `${IRSA_FINDER}?mode=getResult&UserTargetWorldPt=${fmt(now.ra)};${fmt(now.dec)};EQ_J2000&subsize=${(finderArcmin / 60).toFixed(4)}&survey=DSS,SDSS,2MASS,WISE` },
      { key: "aladin", label: "Aladin Lite", at: "now", when: nowTxt, note: "the AllWISE colour sky (2010) in the CDS viewer",
        href: AL ? AL.url({ ra: now.ra, dec: now.dec, fovArcsec: aladinArcsec, survey: "P/allWISE/color" }) : "" },
      { key: "legacy", label: "Legacy Surveys viewer", at: "now", when: nowTxt, note: "deep optical images (DR10), marked where it should be",
        href: `${LEGACY}?ra=${fmt(now.ra)}&dec=${fmt(now.dec)}&layer=ls-dr10&zoom=${zoom}&mark=${fmt(now.ra)},${fmt(now.dec)}` },
    ];
    if (j2000) {
      const r = coneArcsec(j2000, pm);
      links.push({ key: "simbad", label: "SIMBAD", at: "j2000", when: `J2000, ${r}″ radius`, note: "known objects (SIMBAD lists J2000 positions)",
        href: `${SIMBAD}?Coord=${fmt(j2000.ra)}%20${signed(j2000.dec, "%2B")}&CooFrame=ICRS&CooEpoch=2000&CooEqui=2000&Radius=${r}&Radius.unit=arcsec` });
      links.push({ key: "vizier", label: "VizieR, all catalogues", at: "j2000", when: `J2000, ${r}″ radius`, note: "every catalogue with a source there",
        href: `${VIZIER}VizieR?-c=${fmt(j2000.ra)}%20${signed(j2000.dec, "%2B")}&-c.eq=J2000&-c.rs=${r}&-out.add=_r&-sort=_r` });
    }
    if (gaia) {
      const r = coneArcsec(gaia, pm);
      links.push({ key: "gaia", label: "Gaia DR3 in VizieR", at: "gaia", when: `2016.0, ${r}″ radius`, note: "Gaia DR3 positions are for 2016.0",
        href: `${VIZIER}VizieR-4?-source=I/355/gaiadr3&-c=${fmt(gaia.ra)}%20${signed(gaia.dec, "%2B")}&-c.eq=J2000&-c.rs=${r}&-out.add=_r&-sort=_r` });
    }
    return { now, j2000, gaia, nowYear, links: links.filter((l) => l.href) };
  }

  // ---------- export ----------
  const EXPORT_COLUMNS = ["rank", "id", "k5", "ra", "dec", "epoch", "pm", "pmra", "pmdec", "pm_err", "pm_snr", "w1", "w2", "w1w2",
    "n_visits", "span_yr", "class", "gaia_checked", "gaia_match", "gaia_source_id", "gaia_sep_arcsec", "score", "flags", "duplicates"];
  const numOrNull = (v) => (fin(v) ? num(v) : null);
  function exportRow(m) {
    const g = m && m.gaia && typeof m.gaia === "object" ? m.gaia : {};
    const list = (v) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)]);
    return {
      rank: numOrNull(m.rank), id: String(m.id ?? ""), k5: numOrNull(m.k5), ra: numOrNull(m.ra), dec: numOrNull(m.dec), epoch: numOrNull(m.epoch),
      pm: numOrNull(m.pm), pmra: numOrNull(m.pmra), pmdec: numOrNull(m.pmdec), pm_err: numOrNull(m.pm_err), pm_snr: numOrNull(m.pm_snr),
      w1: numOrNull(m.w1), w2: numOrNull(m.w2), w1w2: numOrNull(m.w1w2), n_visits: numOrNull(m.n_visits), span_yr: numOrNull(m.span_yr),
      class: m.class ? String(m.class) : "not checked",
      gaia_checked: g.checked === undefined || g.checked === null ? null : !!g.checked,
      gaia_match: g.match === undefined || g.match === null ? null : !!g.match,
      gaia_source_id: g.source_id === undefined || g.source_id === null || g.source_id === "" ? null : String(g.source_id),
      gaia_sep_arcsec: numOrNull(g.sep_arcsec), score: numOrNull(m.score), flags: list(m.flags), duplicates: list(m.duplicates),
    };
  }
  // One CSV field (RFC 4180): quoted when it holds a comma, quote or line break; text that a spreadsheet would run
  // as a formula (starting with = + - @ or a tab) gets a leading apostrophe. Numbers are written as they are.
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    if (typeof v === "boolean") return v ? "true" : "false";
    let s = Array.isArray(v) ? v.join(";") : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(rows) {
    const lines = [EXPORT_COLUMNS.join(",")];
    for (const m of rows || []) { const r = exportRow(m); lines.push(EXPORT_COLUMNS.map((k) => csvCell(r[k])).join(",")); }
    return lines.join("\r\n") + "\r\n";
  }
  function toJSON(rows, meta) {
    const o = meta || {};
    return JSON.stringify({
      source: "WANDERERS Sky Survey (NEOWISE 2014-2024 movers, checked against Gaia DR3)",
      generated: o.generated || null, exported: o.exported || new Date().toISOString(), url: o.url || null,
      filters: o.filters || null, sort: o.sort || null, count: (rows || []).length, columns: EXPORT_COLUMNS,
      units: { ra: "deg", dec: "deg", epoch: "decimal year", pm: "mas/yr", pm_err: "mas/yr", w1: "Vega mag", gaia_sep_arcsec: "arcsec" },
      candidates: (rows || []).map(exportRow),
    }, null, 1);
  }
  function exportName(ext, generated, n) {
    const d = String(generated || "").match(/^(\d{4})-(\d\d)-(\d\d)/);
    return `wanderers-survey-candidates${d ? `-${d[1]}${d[2]}${d[3]}` : ""}-${n}.${ext}`;
  }

  // ---------- filters: flags, preset, URL ----------
  const HIDE_KEYS = ["edge", "crowded", "saturated", "artefact"];
  const RED_MIN = 0.5;   // W1−W2 at or above this: the colour of a cold brown dwarf (a hint, not proof)
  function hasFlag(m, key) {
    const flags = Array.isArray(m && m.flags) ? m.flags.map((f) => String(f).toLowerCase()) : [];
    if (key === "edge") return flags.some((f) => f.includes("edge"));
    if (key === "artefact") return (m && m.class) === "likely artefact";
    return flags.includes(key);
  }
  const FILTER_DEFAULTS = { cls: "all", minPm: 0, red: false, q: "", tile: null, minVisits: 0, minSnr: 0, hide: [] };
  const PRESETS = { high: { minVisits: 12, minSnr: 10, hide: HIDE_KEYS.slice() } };
  function isPreset(f, name) {
    const p = PRESETS[name];
    return !!p && num(f.minVisits) >= p.minVisits && num(f.minSnr) >= p.minSnr && p.hide.every((h) => (f.hide || []).includes(h));
  }
  // The preset switched on (or off again: its fields back to the defaults); other filters are left alone
  function togglePreset(f, name) {
    const p = PRESETS[name];
    if (!p) return { ...f };
    return isPreset(f, name) ? { ...f, minVisits: 0, minSnr: 0, hide: [] } : { ...f, ...p, hide: p.hide.slice() };
  }
  // Filters and sort -> [key, value] pairs for the address bar (defaults left out). sorts: {key: default direction}
  function toParams(f, sort, sorts) {
    const out = [];
    if (f.cls && f.cls !== "all") out.push(["class", f.cls]);
    if (num(f.minPm) > 0) out.push(["minpm", String(num(f.minPm))]);
    if (f.red) out.push(["red", "1"]);
    if (num(f.minVisits) > 0) out.push(["visits", String(num(f.minVisits))]);
    if (num(f.minSnr) > 0) out.push(["snr", String(num(f.minSnr))]);
    const hide = HIDE_KEYS.filter((h) => (f.hide || []).includes(h));
    if (hide.length) out.push(["hide", hide.join(",")]);
    if (f.q) out.push(["q", String(f.q)]);
    if (f.tile !== null && f.tile !== undefined) out.push(["tile", String(f.tile)]);
    if (sort && sort.key) {
      const def = sorts && sorts[sort.key] !== undefined ? sorts[sort.key] : 1, flipped = !!sort.dir && sort.dir !== def;
      if (sort.key !== "rank" || flipped) out.push(["sort", sort.key]);
      if (flipped) out.push(["dir", sort.dir > 0 ? "asc" : "desc"]);
    }
    return out;
  }
  // URL parameters -> {f, sort}; nonsense values are ignored. opts: {classes, sorts: {key: defaultDir}, nTiles}
  function fromParams(params, opts) {
    const o = opts || {}, get = (k) => (params && typeof params.get === "function" ? params.get(k) : null);
    const f = { ...FILTER_DEFAULTS, hide: [] };
    if (get("preset") && PRESETS[get("preset")]) Object.assign(f, PRESETS[get("preset")], { hide: PRESETS[get("preset")].hide.slice() });
    const c = get("class");
    if (c && (c === "all" || (o.classes || []).includes(c))) f.cls = c;
    const pos = (k) => { const v = num(get(k)); return Number.isFinite(v) && v > 0 ? v : null; };
    if (pos("minpm") !== null) f.minPm = pos("minpm");
    if (get("red") === "1") f.red = true;
    if (pos("visits") !== null) f.minVisits = Math.round(pos("visits"));
    if (pos("snr") !== null) f.minSnr = pos("snr");
    if (get("hide") !== null) f.hide = HIDE_KEYS.filter((h) => String(get("hide")).split(",").map((s) => s.trim()).includes(h));
    if (get("q")) f.q = String(get("q"));
    const t = num(get("tile"));
    if (Number.isInteger(t) && t >= 0 && t < (o.nTiles || 12288)) f.tile = t;
    let sort = null;
    const sk = get("sort"), sorts = o.sorts || {};
    if (sk && Object.prototype.hasOwnProperty.call(sorts, sk)) {
      const d = get("dir");
      sort = { key: sk, dir: d === "asc" ? 1 : d === "desc" ? -1 : sorts[sk] };
    }
    return { f, sort };
  }

  const api = {
    J2000, GAIA_EPOCH, LATER, decimalYear, propagate, sepArcsec, positionAt, timeline, archiveLinks, coneArcsec,
    EXPORT_COLUMNS, exportRow, csvCell, toCSV, toJSON, exportName,
    HIDE_KEYS, RED_MIN, hasFlag, FILTER_DEFAULTS, PRESETS, isPreset, togglePreset, toParams, fromParams,
  };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.SurveyTools = api;
})(typeof window !== "undefined" ? window : globalThis);
