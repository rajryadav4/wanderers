/* "See it through Webb": match sky coordinates against the outlines of every public JWST imaging frame and
 * show the real Webb pixels there. Shared by the console (index.html) and the Sky Compass.
 * Frames: app/data/webb.json, built by pipeline/make_webb.py from MAST (STScI): 22,049 public level-3 images,
 * merged into ~5,500 pointings, each with its footprint outline (convex hull of MAST s_region).
 * Pixels, best first: (1) a MAST preview of that frame cut by pipeline/make_webb_previews.py and placed with its own
 * WCS (our targets and every catalogue star inside a Webb frame); (2) ESA ESASky's live JWST NIRCam / MIRI / NIRISS
 * maps where their coverage map (MOC) says they have pixels; (3) otherwise the frame outline on DSS / 2MASS,
 * with the MAST thumbnail and full-image link. Drawn by Aladin Lite. */
(function (root) {
  const D2R = Math.PI / 180;
  const ESA = "https://skies.esac.esa.int/";
  const HIPS = {
    NIRCam: { url: ESA + "JWST/NIRCam_Imaging/", fmt: "png", name: "Webb NIRCam (ESASky)" },
    MIRI: { url: ESA + "JWST/MIRI_Imaging/", fmt: "png", name: "Webb MIRI (ESASky)" },
    NIRISS: { url: ESA + "JWST/NIRISS_Imaging/", fmt: "png", name: "Webb NIRISS (ESASky)" },
  };
  // backgrounds from IRSA's HiPS mirrors (CORS-enabled; also up when CDS Strasbourg is not)
  const IRSA = "https://irsa.ipac.caltech.edu/data/hips/CDS/";
  const BASE = { dss: { url: IRSA + "DSS2/color", fmt: "jpeg", name: "DSS colour (visible)" },
                 twomass: { url: IRSA + "2MASS/Color", fmt: "jpeg", name: "2MASS colour (near-infrared)" } };
  let DB = null, loading = null, BASEURL = "data/";

  // h: ESASky's live Webb map has pixels there; pv: WANDERERS has a MAST preview with WCS (data/webb/<obs>.jpg)
  function load(base = "data/") {
    if (DB) return Promise.resolve(DB);
    BASEURL = base;
    if (!loading) loading = Promise.all([fetch(base + "webb.json").then((r) => r.json()),
      fetch(base + "webb_previews.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}))]).then(([d, pv]) => {
      const maxR = Math.max(...d.p.map((p) => p[2]));
      DB = { updated: d.updated, count: d.count, programs: d.programs, maxR, previews: pv,
        p: d.p.map(([ra, dec, r, inst, target, pid, mjd, filters, obs, hull, h, hasPv]) =>
          ({ ra, dec, r, inst, target, pid, mjd, filters, obs, hull, live: !!h, preview: !!hasPv })) };
      return DB;
    });
    return loading;
  }

  // angular distance (deg)
  function sep(ra1, dec1, ra2, dec2) {
    const s = Math.sin((dec2 - dec1) * D2R / 2) ** 2 + Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / D2R;
  }
  // is (ra, dec) inside the frame outline? (gnomonic projection around the frame centre, then ray casting)
  function inside(p, ra, dec) {
    const c = Math.cos(p.dec * D2R), tp = (a, d) => [((a - p.ra + 540) % 360 - 180) * c, d - p.dec];
    const [x, y] = tp(ra, dec); let inn = false;
    for (let i = 0, j = p.hull.length / 2 - 1; i < p.hull.length / 2; j = i++) {
      const [xi, yi] = tp(p.hull[2 * i], p.hull[2 * i + 1]), [xj, yj] = tp(p.hull[2 * j], p.hull[2 * j + 1]);
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn;
    }
    return inn;
  }
  // candidates in a strip of RA (the list is sorted by RA); a full scan when the circle reaches a pole.
  // Half-width of a circle of radius rad in RA: asin(sin rad / cos dec) (rad / cos dec is too narrow for big circles)
  function strip(ra, dec, rad) {
    const P = DB.p, w = Math.abs(dec) + rad >= 89.9 ? 360 : Math.asin(Math.min(1, Math.sin(rad * D2R) / Math.cos(dec * D2R))) / D2R + 1e-6;
    if (w >= 180) return P;
    const lo = ra - w, hi = ra + w, out = [];
    const first = (x) => { let a = 0, b = P.length; while (a < b) { const m = (a + b) >> 1; P[m].ra < x ? (a = m + 1) : (b = m); } return a; };
    const take = (a, b) => { for (let i = first(a); i < P.length && P[i].ra <= b; i++) out.push(P[i]); };
    if (lo < 0) { take(lo + 360, 360); take(0, hi); } else if (hi > 360) { take(lo, 360); take(0, hi - 360); } else take(lo, hi);
    return out;
  }
  // frames whose outline contains the position, closest centre first
  function framesAt(ra, dec) {
    if (!DB) return [];
    return strip(ra, dec, DB.maxR).map((p) => ({ p, d: sep(ra, dec, p.ra, p.dec) }))
      .filter((x) => x.d <= x.p.r * 1.01 && inside(x.p, ra, dec)).sort((a, b) => a.d - b.d).map((x) => x.p);
  }
  // nearest pointings within maxDeg (for "nothing here, but Webb looked 0.4° away")
  function near(ra, dec, maxDeg = 5, limit = 5) {
    if (!DB) return [];
    return strip(ra, dec, maxDeg).map((p) => ({ p, d: sep(ra, dec, p.ra, p.dec) })).filter((x) => x.d <= maxDeg)
      .sort((a, b) => a.d - b.d).slice(0, limit).map((x) => Object.assign({ dist: x.d }, x.p));
  }

  const dateOf = (mjd) => mjd ? new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10) : "";
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const thumb = (p) => `https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:JWST/product/${p.obs}_i2d_thumb.jpg`;
  const full = (p) => `https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:JWST/product/${p.obs}_i2d.jpg`;
  const progUrl = (p) => `https://www.stsci.edu/jwst/science-execution/program-information?id=${encodeURIComponent(p.pid)}`;
  const inHips = (p) => !!(HIPS[p.inst] && p.live);
  // what the viewer will show for this frame
  const source = (p) => p.preview && DB.previews[p.obs] ? "preview" : inHips(p) ? "live" : "outline";
  // frames with real pixels first (our preview, then ESASky's live map), keeping the given order inside each group
  const RANK = { preview: 0, live: 1, outline: 2 };
  const best = (frames) => frames.map((p, i) => [p, i]).sort((a, b) => RANK[source(a[0])] - RANK[source(b[0])] || a[1] - b[1]).map((x) => x[0]);

  // a readable name: Webb's own target name, unless it is a placeholder (parallel fields are "UNKNOWN")
  const VAGUE = /^(unknown|background|bkg|parallel|field|none|sky|offset|-+)$/i;
  function name(p) {
    const t = String(p.target || "").replace(/^-+/, "").trim();
    if (t && !VAGUE.test(t)) return t;
    const title = DB.programs[p.pid] || "";
    return title ? `a field from “${title.length > 48 ? title.slice(0, 46) + "…" : title}”` : `programme ${p.pid} field`;
  }
  const named = (p) => { const t = String(p.target || "").replace(/^-+/, "").trim(); return !!t && !VAGUE.test(t); };
  // how good a frame is to suggest: real pixels first, then a real name, then closeness
  const appeal = (p, dist = 0) => RANK[source(p)] * 10 + (named(p) ? 0 : 4) + dist;

  // one line per frame, for lists
  function describe(p) {
    return { title: DB.programs[p.pid] || `Programme ${p.pid}`, name: name(p),
      line: `${p.inst} · ${p.filters || "imaging"} · ${dateOf(p.mjd)} · target “${name(p)}”` };
  }

  // ---------- the viewer ----------
  let AL = null;
  async function aladinLib() {
    if (!root.A) root.A = (await import("https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js")).default;
    await root.A.init; return root.A;
  }
  const V = { aladin: null, el: null, overlay: null, sel: null, cat: null, layers: {} };

  /* Render into `el` (a sized <div>) centred on (ra, dec). frames: matches from framesAt/near.
   * Returns the frame shown. */
  async function render(el, ra, dec, frames, opts = {}) {
    const A = await aladinLib();
    const main = frames[0];
    const fov = main ? Math.max(0.02, Math.min(1.5, main.r * 2.4)) : 0.25;
    if (!V.aladin || V.el !== el) {
      el.innerHTML = "";
      V.aladin = A.aladin(el, { survey: BASE[opts.base || "twomass"].url, fov, target: `${ra} ${dec}`, cooFrame: "ICRSd", log: false, showReticle: true, showLayersControl: false,
        showGotoControl: false, showFullscreenControl: false, showCooGridControl: false, showSimbadPointerControl: false,
        showProjectionControl: false, showFrame: false, showZoomControl: true, showSettingsControl: false, showShareControl: false,
        showStatusBar: false });
      V.el = el; V.layers = {}; V.base = opts.base || "twomass";
      V.overlay = A.graphicOverlay({ color: "#9fb0c8", lineWidth: 1.2, lineDash: [4, 4] }); V.aladin.addOverlay(V.overlay);   // other Webb frames here
      V.past = A.graphicOverlay({ color: "#7cc4ff", lineWidth: 2.5 }); V.aladin.addOverlay(V.past);                      // path taken
      V.fut = A.graphicOverlay({ color: "#7ee787", lineWidth: 2.5, lineDash: [7, 5] }); V.aladin.addOverlay(V.fut);      // path ahead
      V.sel = A.graphicOverlay({ color: "#ffb547", lineWidth: 2.5 }); V.aladin.addOverlay(V.sel);
      V.cat = A.catalog({ name: "you", sourceSize: 18, color: "#ff5a4e", shape: "cross" }); V.aladin.addCatalog(V.cat);
    }
    const layer = (k, h) => V.layers[k] || (V.layers[k] = A.imageHiPS(h.url, { name: h.name, imgFormat: h.fmt }));
    const bk = opts.base || "twomass";
    if (V.base !== bk) { if (V.base) V.aladin.setBaseImageLayer(BASE[bk].url); V.base = bk; }   // URL string: an imageHiPS object gets remapped to CDS
    try { V.aladin.removeImageLayer("webb"); } catch {}
    const src = main ? source(main) : "outline";
    if (src === "preview") {
      const m = DB.previews[main.obs];
      const img = A.image(`${BASEURL}webb/${main.obs}.jpg`, { name: "Webb " + main.obs, imgFormat: "jpeg", wcs: m.wcs });
      V.aladin.setOverlayImageLayer(img, "webb");
    } else if (src === "live") {
      V.aladin.setOverlayImageLayer(layer(main.inst, HIPS[main.inst]), "webb");
    }
    try { V.aladin.getOverlayImageLayer("webb").setOpacity(opts.webbOpacity ?? 1); } catch {}
    V.aladin.gotoRaDec(ra, dec); V.aladin.setFoV(fov);
    V.overlay.removeAll(); V.sel.removeAll(); V.cat.removeAll(); V.past.removeAll(); V.fut.removeAll();
    if (opts.path && opts.path.pts.length > 1) {      // the star's path (pathview.js): blue behind, green ahead
      const P = opts.path.pts, now = opts.path.now;
      const back = P.filter((p) => p.year <= now).map((p) => [p.ra, p.dec]), ahead = P.filter((p) => p.year >= now).map((p) => [p.ra, p.dec]);
      if (back.length > 1) V.past.add(A.polyline(back));
      if (ahead.length > 1) V.fut.add(A.polyline(ahead));
    }
    const poly = (p) => A.polygon(Array.from({ length: p.hull.length / 2 }, (_, i) => [p.hull[2 * i], p.hull[2 * i + 1]]));
    for (const p of frames.slice(1, 40)) V.overlay.add(poly(p));
    if (main) V.sel.add(poly(main));
    const m = opts.mark || { ra, dec };
    V.cat.addSources([A.source(m.ra, m.dec, { name: opts.label || "" })]);
    return main;
  }
  function setOpacity(x) { try { V.aladin.getOverlayImageLayer("webb").setOpacity(x); } catch {} }
  function setBase(k) { if (V.aladin && BASE[k] && V.base !== k) { V.aladin.setBaseImageLayer(BASE[k].url); V.base = k; } }

  // distance (arcsec) from a position to the nearest edge of a frame's outline
  function edgeArcsec(p, ra, dec) {
    const c = Math.cos(p.dec * D2R), tp = (a, d) => [((a - p.ra + 540) % 360 - 180) * c, d - p.dec];
    const [x, y] = tp(ra, dec), n = p.hull.length / 2; let best = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [x1, y1] = tp(p.hull[2 * j], p.hull[2 * j + 1]), [x2, y2] = tp(p.hull[2 * i], p.hull[2 * i + 1]);
      const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - x1 - t * dx, y - y1 - t * dy));
    }
    return best * 3600;
  }

  root.Webb = { edgeArcsec, load, framesAt, near, inside, sep, render, setOpacity, setBase, describe, dateOf, esc, thumb, full, progUrl, inHips, source, best, name, appeal, _v: V };
})(window);
