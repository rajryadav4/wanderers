/* HiPS tile arithmetic for the real-sky view. Pure functions, no network.
 * A HiPS tile at order k is HEALPix pixel n in the NESTED scheme with nside = 2^k (Gorski et al. 2005),
 * stored at  <base>/Norder{k}/Dir{floor(n/10000)*10000}/Npix{n}.jpg  (IVOA HiPS 1.0).
 * Used by realsky.js (which tiles to save for a place) and sw.js (which recent tiles to drop first).
 * CONFIG below is the one place for the names both of them must agree on. */
(function (root) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  // ---- settings shared by the page (realsky.js) and the service worker (sw.js) ----
  const CONFIG = {
    // Same survey on both hosts (checked 2026-11-14); the second is the one spacetelescopelive.org uses.
    // Saved pictures are always fetched from, and stored under, the first. tile / allsky: mean tile and
    // Norder3/Allsky.jpg in bytes, measured 2026-11-14, for the size shown before a save.
    surveys: {
      visible: { name: "Digitized Sky Survey 2 (visible light)", tile: 38000, allsky: 810000,
        hosts: ["https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color", "https://cdn.skies.esac.esa.int/DSSColor"] },
      infrared: { name: "2MASS near-infrared (1.2 to 2.2 µm), shown in false colour", tile: 59000, allsky: 1030000,
        hosts: ["https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color", "https://cdn.skies.esac.esa.int/2MASSColor"] },
    },
    tileRoots: ["https://irsa.ipac.caltech.edu/data/hips/", "https://cdn.skies.esac.esa.int/"],
    // Aladin Lite is GPL-3.0, so it is loaded from its published package, not copied into this MIT repository.
    aladin: "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js",
    caches: { recent: "wanderers-sky-v1", saved: "wanderers-sky-saved-v1", shell: "wanderers-shell-v1", pinned: "wanderers-data-v1" },
    recent: { maxFiles: 1200, maxBytes: 40 * 1048576, maxAgeMs: 7 * 86400000 },
  };

  const TILE_DEG = 58.6323;                       // side of an order-0 tile: sqrt(4*pi/12) radians

  function spread(v) { let r = 0; for (let i = 0; i < 15; i++) r |= ((v >> i) & 1) << (2 * i); return r; }
  function squeeze(v) { let r = 0; for (let i = 0; i < 15; i++) r |= ((v >> (2 * i)) & 1) << i; return r; }

  // HEALPix ang2pix, nested. RA/Dec in degrees, same frame as the survey (equatorial for the ones we use).
  function pixel(order, ra, dec) {
    const ns = 1 << order, z = Math.sin(dec * D2R), za = Math.abs(z);
    const tt = ((((ra % 360) + 360) % 360) / 90) % 4;        // 0..4
    let face, ix, iy;
    if (za <= 2 / 3) {                                         // equatorial belt
      const t1 = ns * (0.5 + tt), t2 = ns * z * 0.75;
      const jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2);
      const ifp = Math.floor(jp / ns), ifm = Math.floor(jm / ns);
      face = ifp === ifm ? (ifp & 3) + 4 : ifp < ifm ? ifp & 3 : (ifm & 3) + 8;
      ix = jm & (ns - 1); iy = ns - (jp & (ns - 1)) - 1;
    } else {                                                   // polar caps
      const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = Math.sqrt(3 * (1 - za));
      const jp = Math.min(ns - 1, Math.floor(ns * tp * tmp)), jm = Math.min(ns - 1, Math.floor(ns * (1 - tp) * tmp));
      if (z >= 0) { face = ntt; ix = ns - jm - 1; iy = ns - jp - 1; } else { face = ntt + 8; ix = jp; iy = jm; }
    }
    return face * ns * ns + spread(ix) + 2 * spread(iy);
  }

  // HEALPix pix2ang, nested: the centre of a tile.
  const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
  function centre(order, n) {
    const ns = 1 << order, face = Math.floor(n / (ns * ns)), pf = n % (ns * ns);
    const ix = squeeze(pf), iy = squeeze(pf >> 1), jr = JRLL[face] * ns - ix - iy - 1;
    let nr, z, kshift;
    if (jr < ns) { nr = jr; z = 1 - (nr * nr) / (3 * ns * ns); kshift = 0; }
    else if (jr > 3 * ns) { nr = 4 * ns - jr; z = -1 + (nr * nr) / (3 * ns * ns); kshift = 0; }
    else { nr = ns; z = ((2 * ns - jr) * 2) / (3 * ns); kshift = (jr - ns) & 1; }
    let jp = (JPLL[face] * nr + ix - iy + 1 + kshift) / 2;
    if (jp > 4 * nr) jp -= 4 * nr;
    if (jp < 1) jp += 4 * nr;
    return { ra: (jp - (kshift + 1) * 0.5) * (90 / nr), dec: Math.asin(z) * R2D };
  }

  const tileSide = (order) => TILE_DEG / (1 << order);         // degrees
  // The lowest order whose 512-pixel tiles are at least as fine as the screen (degrees across, pixels across).
  function orderFor(viewDeg, viewPx, max = 9) {
    let k = 0;
    while (k < max && tileSide(k) / 512 > viewDeg / viewPx) k++;
    return k;
  }

  // The declinations that can ever rise above the horizon at a latitude. Longitude and date only change when.
  function band(lat) { return lat >= 0 ? [lat - 90, 90] : [-90, lat + 90]; }
  const skyShare = (lat) => (1 + Math.cos(lat * D2R)) / 2;

  // Every tile of one order that touches that band: sample it on a grid a quarter of a tile wide,
  // widened by one step towards the horizon so tiles that only clip the band are kept.
  function tilesForLatitude(lat, order) {
    const step = tileSide(order) / 4, [lo, hi] = band(lat);
    const d0 = Math.max(-90, lo - step), d1 = Math.min(90, hi + step), out = new Set();
    for (let i = 0, n = Math.ceil((d1 - d0) / step); i <= n; i++) {
      const dec = Math.min(d1, d0 + i * step), m = Math.max(1, Math.ceil((360 * Math.cos(dec * D2R)) / step));
      for (let j = 0; j < m; j++) out.add(pixel(order, (j * 360) / m, dec));
    }
    return [...out].sort((a, b) => a - b);
  }

  const url = (base, order, n) => `${base}/Norder${order}/Dir${Math.floor(n / 10000) * 10000}/Npix${n}.jpg`;

  // Everything to fetch so the sky of one latitude works with no network: low orders first.
  // size: mean tile and all-sky file in bytes for this survey (default: DSS2 colour, measured 2026-11-14).
  function plan(base, lat, maxOrder, size = { tile: 38000, allsky: 810000 }) {
    // Aladin Lite draws wide views from Norder3/Allsky.jpg alone (measured: no tile request above a 40-degree view).
    const urls = [`${base}/properties`, `${base}/Moc.fits`, `${base}/Norder3/Allsky.jpg`];
    let tiles = 0;
    for (let k = 0; k <= maxOrder; k++) for (const n of tilesForLatitude(lat, k)) { urls.push(url(base, k, n)); tiles++; }
    return { urls, tiles, bytes: tiles * size.tile + size.allsky };
  }

  // Which entries of the automatic cache to drop: oldest first, until both limits hold.
  // entries: [{ url, bytes }] in insertion order (oldest first). Returns the urls to delete.
  function evict(entries, maxEntries, maxBytes) {
    let n = entries.length, bytes = entries.reduce((s, e) => s + (e.bytes || 0), 0);
    const drop = [];
    for (const e of entries) {
      if (n <= maxEntries && bytes <= maxBytes) break;
      drop.push(e.url); n--; bytes -= e.bytes || 0;
    }
    return drop;
  }

  // ---- saved places: one manifest per place, stored in the saved cache next to its pictures ----
  // A manifest is { lat, order, survey, savedAt, tiles, urls }. The list of places on screen is the list of
  // manifests, so it cannot disagree with what is stored. Removing a place deletes only what no other place lists.
  const manifestUrl = (base, lat, order, survey = "visible") => `${base}/__saved__/${survey}_lat${Math.round(lat)}_order${order}.json`;
  const isManifest = (u) => /\/__saved__\/[a-z]+_lat-?\d+_order\d+\.json$/.test(u);
  function orphans(removed, others) {
    const kept = new Set(others.flatMap((m) => m.urls));
    return removed.urls.filter((u) => !kept.has(u));
  }

  const api = { CONFIG, manifestUrl, isManifest, orphans, pixel, centre, tileSide, orderFor, band, skyShare, tilesForLatitude, url, plan, evict };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Hips = api;
})(typeof self !== "undefined" ? self : globalThis);
