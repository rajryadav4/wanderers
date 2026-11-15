/* Star database helpers: search, formatting and trajectory-chart geometry for the "Star database" tab.
 * Data: data/stars/index.json (pipeline/stardb.py) and data/stars/pred/<key>.json (pipeline/star_ml.py).
 * Works in the browser (window.StarDB) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
  const compact = (s) => norm(s).replace(/[^a-z0-9]/g, "");

  // How well one text matches the query: 0 exact, 1 prefix, 2 every query word starts a word, null no match.
  function matchText(text, q) {
    const t = compact(text), c = compact(q);
    if (!c) return null;
    if (t === c) return 0;
    if (t.startsWith(c)) return 1;
    const tt = tokens(text), qt = tokens(q);
    if (qt.length && qt.every((w) => tt.some((x) => x.startsWith(w)))) return 2;
    if (t.includes(c) && c.length >= 3) return 3;
    return null;
  }

  // Search the star list. Best matches first: name before alias, closer match first, then stars with a
  // ready prediction, then brighter stars.
  function search(stars, q, opts = {}) {
    const limit = opts.limit || 20, ready = opts.ready || new Set();
    if (!compact(q)) return [];
    const hits = [];
    for (const s of stars) {
      let best = null;
      const n = matchText(s.name, q);
      if (n !== null) best = n;
      for (const a of s.aliases || []) {
        const m = matchText(a, q);
        if (m !== null && (best === null || m + 0.5 < best)) best = m + 0.5;
      }
      if (best !== null) hits.push({ s, score: best });
    }
    hits.sort((a, b) => a.score - b.score || (ready.has(b.s.key) - ready.has(a.s.key)) ||
      ((a.s.mag ?? 99) - (b.s.mag ?? 99)));
    return hits.slice(0, limit).map((h) => h.s);
  }

  // Degrees -> "17h 57m 48.50s" / "+04° 41′ 36.2″"
  function hms(raDeg) {
    if (!Number.isFinite(raDeg)) return "—";
    let c = Math.round((((raDeg % 360) + 360) % 360) / 15 * 360000) % (24 * 360000);   // centiseconds of time, rounded first
    const h = Math.floor(c / 360000); c -= h * 360000; const m = Math.floor(c / 6000); c -= m * 6000;
    return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${(c / 100).toFixed(2).padStart(5, "0")}s`;
  }
  function dms(decDeg) {
    if (!Number.isFinite(decDeg)) return "—";
    const sign = decDeg < 0 ? "−" : "+"; let c = Math.round(Math.abs(decDeg) * 36000);   // tenths of an arcsecond
    const d = Math.floor(c / 36000); c -= d * 36000; const m = Math.floor(c / 600); c -= m * 600;
    return `${sign}${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}′ ${(c / 10).toFixed(1).padStart(4, "0")}″`;
  }
  const distance = (pc) => (Number.isFinite(pc) && pc > 0 ? `${pc < 100 ? pc.toFixed(2) : Math.round(pc)} pc (${(pc * 3.2616).toFixed(pc < 30 ? 1 : 0)} light-years)` : "unknown");
  const arcsec = (v) => (!Number.isFinite(v) ? "—" : Math.abs(v) >= 100 ? `${v.toFixed(0)}″` : Math.abs(v) >= 1 ? `${v.toFixed(2)}″` : `${(v * 1000).toFixed(0)} mas`);
  const pm = (v, e) => (!Number.isFinite(v) ? "—" : `${v.toFixed(1)}${Number.isFinite(e) ? ` ± ${e < 0.1 ? e.toFixed(2) : e.toFixed(1)}` : ""}`);

  // ---- trajectory chart ----
  // pred.path.rows: [year, ra, dec, dx_arcsec, dy_arcsec, unc68_arcsec]; dx = east (RA*), dy = north.
  // Sky charts put east on the LEFT when north is up, so screen x = -dx.
  function chart(pred, opts = {}) {
    const W = opts.width || 640, H = opts.height || 420, pad = opts.pad || 46;
    const rows = pred.path.rows, now = pred.now;
    const anchor = pred.anchor;
    const obs = [];
    const seen = new Map();
    for (const o of pred.observations || []) {           // one point per catalogue epoch (RA and Dec rows paired)
      const k = o.catalogue;
      if (!seen.has(k)) seen.set(k, { catalogue: k, epoch: o.epoch, ra: o.ra, dec: o.dec, gaia: o.gaia, down: o.down_weighted });
      else { const p = seen.get(k); if (o.axis === 1) { p.dec = o.dec; } else { p.ra = o.ra; } p.down = p.down || o.down_weighted; }
    }
    for (const p of seen.values()) { const [x, y] = offsets(p.ra, p.dec, anchor.ra, anchor.dec); obs.push({ ...p, dx: x, dy: y }); }
    const xs = rows.map((r) => -r[3]).concat(obs.map((o) => -o.dx)), ys = rows.map((r) => r[4]).concat(obs.map((o) => o.dy));
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const span = Math.max(x1 - x0, y1 - y0, 1e-3) * 1.08, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // equal scale on both axes so the path's direction and the band are true to the sky
    const k = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
    const X = (sx) => W / 2 + (sx - cx) * k, Y = (sy) => H / 2 - (sy - cy) * k;
    const pt = (r) => [X(-r[3]), Y(r[4])];
    const past = rows.filter((r) => r[0] <= now).map(pt), future = rows.filter((r) => r[0] >= now).map(pt);
    // uncertainty band: a polygon offset either side of the path by the 68% radius
    const band = [];
    const left = [], right = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], u = r[5];
      if (!Number.isFinite(u)) continue;
      const a = rows[Math.max(0, i - 1)], b = rows[Math.min(rows.length - 1, i + 1)];
      let tx = -(b[3] - a[3]), ty = b[4] - a[4]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const [px, py] = pt(r), w = Math.max(u * k, 0.6);
      left.push([px - ty * w, py - tx * w]); right.push([px + ty * w, py + tx * w]);   // normal in screen space (y flipped)
    }
    if (left.length) band.push(...left, ...right.reverse());
    const marks = (opts.marks || [1900, 1950, 2000, 2050, 2100]).concat([now]).map((yr) => {
      const r = rows.reduce((best, x) => (Math.abs(x[0] - yr) < Math.abs(best[0] - yr) ? x : best), rows[0]);
      const [mx, my] = pt(r); return { year: yr, x: mx, y: my, now: yr === now };
    });
    return { W, H, k, past, future, band, marks,
      obs: obs.map((o) => ({ ...o, x: X(-o.dx), y: Y(o.dy) })),
      scaleBar: niceBar(span), toX: X, toY: Y };
  }

  // Tangent-plane offsets (arcsec) of (ra, dec) about (ra0, dec0): x east, y north. Same maths as star_ml.py.
  function offsets(ra, dec, ra0, dec0) {
    const r = Math.PI / 180, a = ra * r, d = dec * r, a0 = ra0 * r, d0 = dec0 * r;
    const D = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    const xi = Math.cos(d) * Math.sin(a - a0) / D, eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / D;
    return [xi / r * 3600, eta / r * 3600];
  }

  // A round scale-bar length (arcsec) about a fifth of the shown span.
  function niceBar(span) {
    const t = span / 5, p = Math.pow(10, Math.floor(Math.log10(t)));
    const m = [1, 2, 5, 10].find((x) => x * p >= t) * p;
    return { arcsec: m, label: arcsec(m) };
  }

  const pathD = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");

  const api = { search, matchText, hms, dms, distance, arcsec, pm, chart, offsets, niceBar, pathD };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.StarDB = api;
})(typeof window !== "undefined" ? window : globalThis);
