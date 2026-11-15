/* Sky math for the WANDERERS Sky Compass. Every formula is a standard published one:
 *  - Time: the phone clock as UTC milliseconds (time zones do not matter; UTC is used throughout).
 *  - Earth rotation: Greenwich mean sidereal time, IAU 1982 expression (Meeus, Astronomical Algorithms, eq. 12.4).
 *  - Precession J2000 -> date: IAU 1976 angles zeta, z, theta (Meeus eq. 21.3).
 *  - Sun: Astronomical Almanac low-precision formulae (about 0.01 degree).
 *  - Moon: Astronomical Almanac low-precision formulae (about 0.3 degree) plus topocentric parallax.
 *  - Refraction: Bennett (1982) for apparent altitude (Meeus eq. 16.4).
 *  - Magnetic declination: NOAA/BGS World Magnetic Model 2025 grid (data/declination.json).
 *  - Many stars at once, and the inverse (where the phone points): one rotation matrix built from the two above (frame).
 *  - Planets: JPL "Approximate Positions of the Planets", Keplerian elements valid 1800-2050 (about 0.02 degree here).
 * Accuracy target: well under 1 degree, far finer than a phone compass. */
(function (root) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R), tan = (d) => Math.tan(d * D2R);
  const norm360 = (x) => ((x % 360) + 360) % 360;

  const jd = (date) => date.getTime() / 86400000 + 2440587.5;

  function gmst(J) {                      // degrees
    const T = (J - 2451545.0) / 36525;
    return norm360(280.46061837 + 360.98564736629 * (J - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000);
  }

  function precess(ra, dec, J) {          // J2000 RA/Dec (deg) -> mean equator of date
    const T = (J - 2451545.0) / 36525;
    const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) / 3600;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) / 3600;
    const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) / 3600;
    const A = cos(dec) * sin(ra + zeta);
    const B = cos(th) * cos(dec) * cos(ra + zeta) - sin(th) * sin(dec);
    const C = sin(th) * cos(dec) * cos(ra + zeta) + cos(th) * sin(dec);
    return { ra: norm360(Math.atan2(A, B) * R2D + z), dec: Math.asin(Math.max(-1, Math.min(1, C))) * R2D };
  }

  function sun(J) {                       // apparent-ish RA/Dec of date (deg)
    const n = J - 2451545.0;
    const L = norm360(280.460 + 0.9856474 * n), g = norm360(357.528 + 0.9856003 * n);
    const lam = L + 1.915 * sin(g) + 0.020 * sin(2 * g), eps = 23.439 - 0.0000004 * n;
    return { ra: norm360(Math.atan2(cos(eps) * sin(lam), cos(lam)) * R2D), dec: Math.asin(sin(eps) * sin(lam)) * R2D, parallax: 0.0024 };
  }

  function moon(J) {                      // geocentric RA/Dec of date (deg) + horizontal parallax (deg)
    const T = (J - 2451545.0) / 36525;
    const lam = 218.32 + 481267.881 * T + 6.29 * sin(135.0 + 477198.87 * T) - 1.27 * sin(259.3 - 413335.36 * T)
      + 0.66 * sin(235.7 + 890534.22 * T) + 0.21 * sin(269.9 + 954397.74 * T) - 0.19 * sin(357.5 + 35999.05 * T)
      - 0.11 * sin(186.5 + 966404.03 * T);
    const bet = 5.13 * sin(93.3 + 483202.02 * T) + 0.28 * sin(228.2 + 960400.89 * T)
      - 0.28 * sin(318.3 + 6003.15 * T) - 0.17 * sin(217.6 - 407332.21 * T);
    const par = 0.9508 + 0.0518 * cos(135.0 + 477198.87 * T) + 0.0095 * cos(259.3 - 413335.36 * T)
      + 0.0078 * cos(235.7 + 890534.22 * T) + 0.0028 * cos(269.9 + 954397.74 * T);
    const eps = 23.439 - 0.0130 * T;
    const l = cos(bet) * cos(lam), m = cos(eps) * cos(bet) * sin(lam) - sin(eps) * sin(bet);
    const nn = sin(eps) * cos(bet) * sin(lam) + cos(eps) * sin(bet);
    return { ra: norm360(Math.atan2(m, l) * R2D), dec: Math.asin(nn) * R2D, parallax: par };
  }

  function altAz(ra, dec, lat, lst) {     // geometric (airless) altitude/azimuth, azimuth from north through east
    const H = lst - ra;
    const sAlt = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H);
    const alt = Math.asin(Math.max(-1, Math.min(1, sAlt))) * R2D;
    const az = Math.atan2(-sin(H) * cos(dec), cos(lat) * sin(dec) - sin(lat) * cos(dec) * cos(H)) * R2D;
    return { alt, az: norm360(az) };
  }

  function refraction(alt) {              // degrees to add to a geometric altitude (Saemundsson 1986, inverse of Bennett)
    if (alt < -2) return 0;
    return (1.02 / tan(alt + 10.3 / (alt + 5.11))) / 60;
  }

  // Full pipeline for a catalogue (J2000) object or a solar-system body, as seen from the phone.
  function observe(obj, date, lat, lon) {
    const J = jd(date), lst = norm360(gmst(J) + lon);
    let ra, dec, par = 0;
    if (obj.body === "sun") ({ ra, dec, parallax: par } = sun(J));
    else if (obj.body === "moon") ({ ra, dec, parallax: par } = moon(J));
    else ({ ra, dec } = precess(obj.ra, obj.dec, J));
    const g = altAz(ra, dec, lat, lst);
    const topo = g.alt - par * cos(g.alt);          // parallax lowers nearby bodies (the Moon by up to 1 degree)
    return { az: g.az, alt: topo + refraction(topo), geometricAlt: topo, lst };
  }

  // ---------- one rotation for a moment and a place: J2000 <-> local horizon ----------
  // The three columns are where the J2000 axes land in (east, north, up), found by sending each axis through
  // precess() and altAz(). So the matrix cannot disagree with those two, and its transpose is the exact inverse:
  // forward (thousands of stars a second) and backward (where the phone points) share one source.
  const unit = (ra, dec) => [cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec)];
  const enu = (az, alt) => [sin(az) * cos(alt), cos(az) * cos(alt), sin(alt)];
  function frame(date, lat, lon) {
    const J = jd(date), lst = norm360(gmst(J) + lon);
    const col = [[0, 0], [90, 0], [0, 90]].map(([ra, dec]) => { const p = precess(ra, dec, J), h = altAz(p.ra, p.dec, lat, lst); return enu(h.az, h.alt); });
    const m = [0, 1, 2].map((r) => [col[0][r], col[1][r], col[2][r]]);       // rows: east, north, up
    // J2000 unit vector -> (east, north, up) as seen, with refraction lifting it when it is near the horizon.
    const toHorizon = (x, y, z) => {
      const e = m[0][0] * x + m[0][1] * y + m[0][2] * z, n = m[1][0] * x + m[1][1] * y + m[1][2] * z, u = m[2][0] * x + m[2][1] * y + m[2][2] * z;
      const alt = Math.asin(Math.max(-1, Math.min(1, u))) * R2D, seen = alt + refraction(alt), h = Math.hypot(e, n) || 1e-12, c = cos(seen);
      return [(e / h) * c, (n / h) * c, sin(seen)];
    };
    // (east, north, up) geometric direction -> J2000 RA/Dec.
    const toJ2000 = (v) => {
      const x = m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], y = m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], z = m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2];
      return { ra: norm360(Math.atan2(y, x) * R2D), dec: Math.asin(Math.max(-1, Math.min(1, z))) * R2D };
    };
    return { m, lst, toHorizon, toJ2000 };
  }
  function unrefract(alt) {               // apparent altitude -> geometric (Bennett 1982)
    if (alt < -1.5) return alt;
    return alt - (1 / tan(alt + 7.31 / (alt + 4.4))) / 60;
  }
  // Where a pointing direction is among the stars. refract=false treats alt as geometric.
  let FRAME = null;                        // the last frame: the page asks many times for the same moment and place
  function unobserve(az, alt, date, lat, lon, refract = true) {
    const key = `${date.getTime()}|${lat}|${lon}`;
    if (!FRAME || FRAME.key !== key) FRAME = { key, f: frame(date, lat, lon) };
    return FRAME.f.toJ2000(enu(az, refract ? unrefract(alt) : alt));
  }
  // Position angle (from J2000 north through east) of "up on the screen" at the pointed direction.
  // Up is towards the zenith; when the phone points at the zenith itself, up is the compass direction az.
  function zenithAngle(az, alt, date, lat, lon) {
    const p = unobserve(az, alt, date, lat, lon, false);
    // the point 90 degrees from the pointing direction along "up": same azimuth, 90 degrees higher (over the top)
    const upAz = alt >= 0 ? az + 180 : az, upAlt = 90 - Math.abs(alt);
    const u = Math.abs(alt) > 89.999 ? unobserve(az, 0, date, lat, lon, false)
      : alt >= 0 ? unobserve(upAz, upAlt, date, lat, lon, false) : unobserve(az, 90 + alt, date, lat, lon, false);
    const dRa = u.ra - p.ra;
    return norm360(Math.atan2(sin(dRa) * cos(u.dec), cos(p.dec) * sin(u.dec) - sin(p.dec) * cos(u.dec) * cos(dRa)) * R2D);
  }

  // ---------- planets (JPL approximate elements, J2000 ecliptic; value at J2000 and change per century) ----------
  //            a (AU)                  e                        I (deg)                  L (deg)                        long. perihelion (deg)     long. node (deg)
  const ELEMENTS = {
    Mercury: [[0.38709927, 0.00000037], [0.20563593, 0.00001906], [7.00497902, -0.00594749], [252.25032350, 149472.67411175], [77.45779628, 0.16047689], [48.33076593, -0.12534081]],
    Venus: [[0.72333566, 0.00000390], [0.00677672, -0.00004107], [3.39467605, -0.00078890], [181.97909950, 58517.81538729], [131.60246718, 0.00268329], [76.67984255, -0.27769418]],
    Earth: [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]],
    Mars: [[1.52371034, 0.00001847], [0.09339410, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]],
    Jupiter: [[5.20288700, -0.00011607], [0.04838624, -0.00013253], [1.30439695, -0.00183714], [34.39644051, 3034.74612775], [14.72847983, 0.21252668], [100.47390909, 0.20469106]],
    Saturn: [[9.53667594, -0.00125060], [0.05386179, -0.00050991], [2.48599187, 0.00193609], [49.95424423, 1222.49362201], [92.59887831, -0.41897216], [113.66242448, -0.28867794]],
  };
  const TYPICAL_MAG = { Mercury: 0, Venus: -4.1, Mars: 0.5, Jupiter: -2.3, Saturn: 0.6 };   // only sets the dot size
  function heliocentric(name, T) {        // J2000 ecliptic x, y, z in AU
    const [a, e, I, L, wbar, node] = ELEMENTS[name].map(([v, rate]) => v + rate * T);
    const w = wbar - node, M = ((L - wbar + 180) % 360 + 360) % 360 - 180;
    let E = M + e * R2D * sin(M);
    for (let k = 0; k < 8; k++) E += (M - (E - e * R2D * sin(E))) / (1 - e * cos(E));
    const xp = a * (cos(E) - e), yp = a * Math.sqrt(1 - e * e) * sin(E);
    return [
      (cos(w) * cos(node) - sin(w) * sin(node) * cos(I)) * xp + (-sin(w) * cos(node) - cos(w) * sin(node) * cos(I)) * yp,
      (cos(w) * sin(node) + sin(w) * cos(node) * cos(I)) * xp + (-sin(w) * sin(node) + cos(w) * cos(node) * cos(I)) * yp,
      sin(w) * sin(I) * xp + cos(w) * sin(I) * yp,
    ];
  }
  // Geocentric J2000 RA/Dec of the five naked-eye planets. Pass each one to observe() like a star.
  function planets(date) {
    const T = (jd(date) - 2451545.0) / 36525, earth = heliocentric("Earth", T), eps = 23.43928;
    return ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"].map((name) => {
      const h = heliocentric(name, T), x = h[0] - earth[0], y = h[1] - earth[1], z = h[2] - earth[2];
      const ye = y * cos(eps) - z * sin(eps), ze = y * sin(eps) + z * cos(eps);
      return { name, ra: norm360(Math.atan2(ye, x) * R2D), dec: Math.atan2(ze, Math.hypot(x, ye)) * R2D, mag: TYPICAL_MAG[name] };
    });
  }

  let DECL = null;
  function loadDeclination(url) {
    return fetch(url).then((r) => r.json()).then((d) => (DECL = d)).catch(() => null);
  }
  function declination(lat, lon) {        // WMM2025, bilinear on the 2-degree grid; null if not loaded
    if (!DECL) return null;
    const { lat0, lon0, step, nlat, nlon, d } = DECL;
    const fy = Math.max(0, Math.min(nlat - 1.001, (lat - lat0) / step)), fx = Math.max(0, Math.min(nlon - 1.001, (lon - lon0) / step));
    const i = Math.floor(fy), j = Math.floor(fx), u = fy - i, v = fx - j;
    // interpolate through the 180-degree wrap of declination safely
    const c = [d[i][j], d[i][j + 1], d[i + 1][j], d[i + 1][j + 1]].map((x) => x / 10);
    const ref = c[0], w = c.map((x) => ref + ((x - ref + 540) % 360) - 180);
    const val = w[0] * (1 - u) * (1 - v) + w[1] * (1 - u) * v + w[2] * u * (1 - v) + w[3] * u * v;
    return ((val + 540) % 360) - 180;
  }

  const api = { jd, gmst, precess, sun, moon, altAz, refraction, observe, unit, frame, unobserve, zenithAngle, planets,
    loadDeclination, declination,
    model: () => (DECL ? { model: DECL.model, epoch: DECL.epoch } : null) };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sky = api;
})(typeof window !== "undefined" ? window : globalThis);
