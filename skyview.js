/* Pure helpers for the Sky Compass sky layer: the shared projection, the look of a star, and the
 * honest labels. No DOM and no network, so node --test can check them (test/skyview.test.js). */
(function (root) {
  const D2R = Math.PI / 180;

  // Stereographic projection (Aladin Lite's "STG"), the one projection used by the radar canvas and by
  // the survey photographs so they always agree. d = angle from the pointing direction, fov = angle at
  // the rim of the circle (both degrees). Returns the distance from the centre as a share of the radius.
  function radial(d, fov) {
    if (d >= 175) return Infinity;
    return Math.tan((d * D2R) / 2) / Math.tan((fov * D2R) / 2);
  }

  // Faintest star (visual magnitude) a human eye sees under each kind of sky.
  const LIMITS = { city: 3.0, suburb: 4.5, dark: 6.0 };
  const limitMag = (name) => LIMITS[name] ?? LIMITS.dark;
  // stars is sorted bright to faint ([ra, dec, vmag, b_v]); how many are at or above the limit.
  function countToLimit(stars, mag) {
    let lo = 0, hi = stars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (stars[mid][2] <= mag) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Dot radius in canvas pixels (720-pixel radar) and opacity: brighter stars are larger and solid.
  // The faintest ones are small and dim, as they are to the eye; otherwise a dark-site sky looks like static.
  const starRadius = (vmag, fov = 60) => Math.max(0.9, 5.6 - 0.9 * vmag) * Math.min(1.8, Math.sqrt(60 / fov));
  const starAlpha = (vmag) => Math.max(0.28, Math.min(1, 1.2 - 0.155 * vmag));
  // Colour from the spectral class letter: blue-white for hot stars, orange for cool ones. Unknown: white.
  const TINT = { O: "#b8ccff", B: "#b8ccff", A: "#ffffff", F: "#ffffff", G: "#fff0c8", K: "#ffc890", M: "#ffc890" };
  const starColour = (letter) => TINT[letter] || "#ffffff";

  // Which way the top of the screen leans, in degrees clockwise from "towards the zenith", from the W3C
  // DeviceOrientation angles (rotation Z-X'-Y'': alpha, beta, gamma) and the screen's own rotation
  // (screen.orientation.angle). 0 when the phone is held level; +90 when its top points to your right.
  function screenRoll(alpha, beta, gamma, screenAngle = 0) {
    const a = alpha * D2R, b = beta * D2R, g = gamma * D2R, t = screenAngle * D2R;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // the phone's own axes in (east, north, up): X to the right of the screen, Y to its top, Z out of it
    const X = [ca * cg - sa * sb * sg, cg * sa + ca * sb * sg, -cb * sg], Y = [-cb * sa, ca * cb, sb];
    const Z = [cg * sa * sb + ca * sg, sa * sg - ca * cg * sb, cb * cg], p = [-Z[0], -Z[1], -Z[2]];   // the camera looks along -Z
    const top = [0, 1, 2].map((i) => Y[i] * Math.cos(t) + X[i] * Math.sin(t));
    let up = [-p[2] * p[0], -p[2] * p[1], 1 - p[2] * p[2]];                        // zenith, made square to the view
    if (Math.hypot(...up) < 1e-3) { const az = Math.atan2(p[0], p[1]); up = [Math.sin(az), Math.cos(az), 0]; }
    const n = Math.hypot(...up); up = up.map((v) => v / n);
    const right = [p[1] * up[2] - p[2] * up[1], p[2] * up[0] - p[0] * up[2], p[0] * up[1] - p[1] * up[0]];
    const d = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    return Math.atan2(d(top, right), d(top, up)) / D2R;
  }

  // What a tapped star's card says. row is a stars.json row; cons is meta.cons.
  function starCard(row, cons) {
    const [, , mag, , id, ly, con, name] = row, key = typeof id === "number" ? `hip${id}` : id;
    const lines = [`Magnitude ${mag.toFixed(1)}${cons && cons[con] ? ` · in ${cons[con]}` : ""}`];
    if (ly) lines.push(`${ly >= 100 ? Math.round(ly).toLocaleString("en-US") : ly} light-years away. The light you would see left it about ${ly >= 100 ? Math.round(ly).toLocaleString("en-US") : Math.round(ly)} years ago.`);
    else lines.push("Distance not measured.");
    return { title: name || (typeof id === "number" ? `HIP ${id}` : String(id)), lines, key };
  }

  // How far off the pointing can be, in degrees, and whether that is worth a calibration.
  function pointing({ haveSensor, accuracy, calibrated }) {
    if (!haveSensor) return { text: "No motion sensors: drag to aim", needsCal: false };
    const n = accuracy != null && accuracy >= 0 ? Math.max(1, Math.round(accuracy)) : calibrated ? 3 : 10;
    return { deg: n, text: `Direction good to about ±${n}°`, needsCal: !calibrated && n >= 10 };
  }

  const LABELS = {
    off: "",
    eye: "Drawn from measured star positions and computed planets. Not a photograph.",
    deep: "Survey photographs taken decades ago. Not a live view: no Moon, planets or satellites in them.",
  };
  const CREDITS = {
    eye: "Stars: HYG Database v4.1 (CC BY-SA 4.0). Constellation lines: d3-celestial (BSD). Planets: JPL approximate elements.",
    deep: "Digitized Sky Survey – STScI/NASA, coloured and tiled by CDS, served by NASA/IPAC IRSA.",
    infrared: "Two Micron All Sky Survey (2MASS) – University of Massachusetts and IPAC/Caltech, funded by NASA and NSF; coloured and tiled by CDS, served by NASA/IPAC IRSA.",
  };

  const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtLat = (lat) => `${Math.abs(Math.round(lat))}° ${lat >= 0 ? "N" : "S"}`;

  const api = { radial, LIMITS, limitMag, countToLimit, starRadius, starAlpha, starColour, pointing, screenRoll, starCard, LABELS, CREDITS, fmtBytes, fmtLat };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SkyView = api;
})(typeof window !== "undefined" ? window : globalThis);
