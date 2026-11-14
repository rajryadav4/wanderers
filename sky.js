/* Sky math for the WANDERERS Sky Compass. Every formula is a standard published one:
 *  - Time: the phone clock as UTC milliseconds (time zones do not matter; UTC is used throughout).
 *  - Earth rotation: Greenwich mean sidereal time, IAU 1982 expression (Meeus, Astronomical Algorithms, eq. 12.4).
 *  - Precession J2000 -> date: IAU 1976 angles zeta, z, theta (Meeus eq. 21.3).
 *  - Sun: Astronomical Almanac low-precision formulae (about 0.01 degree).
 *  - Moon: Astronomical Almanac low-precision formulae (about 0.3 degree) plus topocentric parallax.
 *  - Refraction: Bennett (1982) for apparent altitude (Meeus eq. 16.4).
 *  - Magnetic declination: NOAA/BGS World Magnetic Model 2025 grid (data/declination.json).
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

  const api = { jd, gmst, precess, sun, moon, altAz, refraction, observe, loadDeclination, declination,
    model: () => (DECL ? { model: DECL.model, epoch: DECL.epoch } : null) };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Sky = api;
})(typeof window !== "undefined" ? window : globalThis);
