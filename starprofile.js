/* Star profile: how a star compares with the Sun, what it is made of, and its real spectrum.
 * Data: app/data/stars/profile/<key>.json (pipeline/star_profile.py: literature, Gaia DR3 FLAME/GSP-Phot, Hypatia
 * Catalog abundances and planets, Gaia XP spectrum). Anything missing is estimated from the catalogue in the browser
 * (starquake.js estimate()) and labelled "estimate".
 * Visual ideas follow common practice: a size comparison with true blackbody colours, an H-R diagram, the Hypatia
 * Catalog's periodic-table view of abundances ([X/H] relative to the Sun), and a spectrum drawn over the rainbow.
 * Pure helpers work in Node (module.exports); the drawing runs in the browser (window.StarProfile).
 */
(function (root) {
  "use strict";
  const SUN = { M: 1, R: 1, L: 1, T: 5772, age: 4.57, Rkm: 695700, Mkg: 1.989e30, g: 274.0, rho: 1.408 };

  // ---------- colour of a blackbody, as the eye would see it ----------
  // CIE 1931 2-degree colour-matching functions, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013).
  const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
  const xbar = (l) => 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const ybar = (l) => 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const zbar = (l) => 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  const planck = (lnm, T) => { const l = lnm * 1e-9; return 1 / (l ** 5 * (Math.exp(1.4387769e-2 / (l * T)) - 1)); };
  const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  function blackbodyRGB(T) {
    if (!(T > 0)) return [128, 128, 128];
    T = Math.max(1000, Math.min(40000, T));
    let X = 0, Y = 0, Z = 0;
    for (let l = 380; l <= 780; l += 5) { const p = planck(l, T); X += p * xbar(l); Y += p * ybar(l); Z += p * zbar(l); }
    let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    const lo = Math.min(r, gg, b); if (lo < 0) { r -= lo; gg -= lo; b -= lo; }        // desaturate into gamut
    const hi = Math.max(r, gg, b) || 1;
    return [r, gg, b].map((c) => Math.round(255 * gamma(c / hi)));
  }
  const rgb = (T) => `rgb(${blackbodyRGB(T).join(",")})`;

  // Colour of light of one wavelength (for the rainbow under the spectrum); grey outside 380-750 nm.
  function wavelengthRGB(l) {
    let r = 0, gg = 0, b = 0;
    if (l >= 380 && l < 440) { r = -(l - 440) / 60; b = 1; } else if (l < 490) { gg = (l - 440) / 50; b = 1; }
    else if (l < 510) { gg = 1; b = -(l - 510) / 20; } else if (l < 580) { r = (l - 510) / 70; gg = 1; }
    else if (l < 645) { r = 1; gg = -(l - 645) / 65; } else if (l <= 750) { r = 1; }
    else return "rgb(95,95,110)";
    if (l < 380) return "rgb(95,95,110)";
    const f = l < 420 ? 0.3 + 0.7 * (l - 380) / 40 : l > 700 ? 0.3 + 0.7 * (750 - l) / 50 : 1;
    return `rgb(${[r, gg, b].map((c) => Math.round(255 * Math.pow(c * f, 0.8))).join(",")})`;
  }

  // ---------- properties ----------
  // Best value for each property: the profile (with its source), else the catalogue estimate (starquake.js).
  function properties(profile, row, info, Q) {
    const p = (profile && profile.properties) || {}, out = {};
    const est = Q && row ? Q.estimate(row) : null;
    const lit = info || {};
    const take = (k, val, src) => { if (val != null && Number.isFinite(+val)) out[k] = { value: +val, source: src }; };
    if (p.mass) out.M = p.mass; else take("M", lit.M, lit.params_ref || "literature"); if (!out.M && est) take("M", est.M, "estimate from the catalogue");
    if (p.radius) out.R = p.radius; else take("R", lit.R, lit.params_ref || "literature"); if (!out.R && est) take("R", est.R, "estimate from the catalogue");
    if (p.teff) out.T = p.teff; else take("T", lit.teff, lit.params_ref || "literature"); if (!out.T && est) take("T", est.teff, "estimate from the catalogue colour");
    if (p.luminosity) out.L = p.luminosity;
    else if (out.R && out.T) take("L", out.R.value ** 2 * (out.T.value / SUN.T) ** 4, "from radius and temperature");
    else if (est) take("L", est.L, "estimate from the catalogue");
    if (p.age_gyr) out.age = p.age_gyr;
    if (p.metallicity) out.FeH = p.metallicity;
    if (p.logg) out.logg = p.logg;
    if (row && row.dist_pc) take("dist", row.dist_pc * 3.261563777, "HYG catalogue (Hipparcos parallax)");
    return out;
  }

  // Derived numbers, all relative to the Sun where that makes sense.
  function derived(P) {
    const d = {};
    if (P.M) { d.Mkg = P.M.value * SUN.Mkg; d.Mjup = P.M.value * 1047.6; }
    if (P.R) { d.diamKm = 2 * P.R.value * SUN.Rkm; d.diamEarths = P.R.value * 109.2; }
    if (P.M && P.R) { d.rho = SUN.rho * P.M.value / P.R.value ** 3; d.g = SUN.g * P.M.value / P.R.value ** 2; d.gEarth = d.g / 9.81; }
    if (P.L) { d.hzIn = 0.95 * Math.sqrt(P.L.value); d.hzOut = 1.67 * Math.sqrt(P.L.value); }   // habitable zone, AU (Kasting-style rule of thumb)
    if (P.T) d.Tc = P.T.value - 273.15;
    return d;
  }

  // Ratio bars: [label, ratio to the Sun, text] for whatever is known.
  function ratios(P, D) {
    const out = [];
    const f = (x) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x >= 10 ? x.toFixed(1) : x >= 0.1 ? x.toFixed(2) : x.toPrecision(2));
    if (P.M) out.push(["Mass", P.M.value, `${f(P.M.value)} × the Sun`, P.M.source]);
    if (P.R) out.push(["Diameter", P.R.value, `${f(P.R.value)} × the Sun`, P.R.source]);
    if (P.L) out.push(["Brightness (power)", P.L.value, `${f(P.L.value)} × the Sun`, P.L.source]);
    if (P.T) out.push(["Surface temperature", P.T.value / SUN.T, `${Math.round(P.T.value).toLocaleString("en-US")} K (Sun 5,772 K)`, P.T.source]);
    if (D.rho != null) out.push(["Density", D.rho / SUN.rho, `${f(D.rho)} g/cm³ (Sun 1.41)`, "from mass and diameter"]);
    if (D.g != null) out.push(["Surface gravity", D.g / SUN.g, `${f(D.gEarth)} × Earth's (Sun 28×)`, "from mass and diameter"]);
    if (P.age) out.push(["Age", P.age.value / SUN.age, `${f(P.age.value)} billion years (Sun 4.6)`, P.age.source]);
    return out;
  }

  // ---------- chemistry ----------
  // Asplund et al. 2009 solar photosphere: log10 abundance (H = 12) and atomic mass.
  const SOLAR = { H: [12.00, 1.008], He: [10.93, 4.003], C: [8.43, 12.011], N: [7.83, 14.007], O: [8.69, 15.999], Ne: [7.93, 20.180],
    Na: [6.24, 22.990], Mg: [7.60, 24.305], Al: [6.45, 26.982], Si: [7.51, 28.085], S: [7.12, 32.06], Ar: [6.40, 39.948],
    Ca: [6.34, 40.078], Ti: [4.95, 47.867], Cr: [5.64, 51.996], Mn: [5.43, 54.938], Fe: [7.50, 55.845], Ni: [6.22, 58.693] };
  const Z_SUN = 0.0134;

  // Mass fractions. Metals scale with [M/H]; helium cannot be seen in cool stars' spectra, so it follows the
  // Galaxy's helium-enrichment law Y = 0.2449 + 1.5 Z (primordial helium + enrichment). abund: {El: {x_h}}.
  function composition(feh, abund) {
    const m = Number.isFinite(feh) ? feh : 0;
    const Z = Z_SUN * Math.pow(10, m), Y = 0.2449 + 1.5 * Z, X = 1 - Y - Z;
    const metals = {};
    let tot = 0;
    for (const [el, [eps, A]] of Object.entries(SOLAR)) {
      if (el === "H" || el === "He") continue;
      const xh = abund && abund[el] ? abund[el].x_h : m;
      const w = A * Math.pow(10, eps - 12 + xh);
      metals[el] = w; tot += w;
    }
    for (const el in metals) metals[el] = metals[el] / tot * Z;
    return { X, Y, Z, metals, measured: !!(abund && Object.keys(abund).length) };
  }

  // Compact periodic table positions [period, group] for the elements we show.
  const PT = { H: [1, 1], He: [1, 18], Li: [2, 1], Be: [2, 2], B: [2, 13], C: [2, 14], N: [2, 15], O: [2, 16], F: [2, 17], Ne: [2, 18],
    Na: [3, 1], Mg: [3, 2], Al: [3, 13], Si: [3, 14], P: [3, 15], S: [3, 16], Cl: [3, 17], Ar: [3, 18],
    K: [4, 1], Ca: [4, 2], Sc: [4, 3], Ti: [4, 4], V: [4, 5], Cr: [4, 6], Mn: [4, 7], Fe: [4, 8], Co: [4, 9], Ni: [4, 10], Cu: [4, 11], Zn: [4, 12],
    Ga: [4, 13], Ge: [4, 14], As: [4, 15], Se: [4, 16], Br: [4, 17], Kr: [4, 18],
    Rb: [5, 1], Sr: [5, 2], Y: [5, 3], Zr: [5, 4], Nb: [5, 5], Mo: [5, 6], Tc: [5, 7], Ru: [5, 8], Rh: [5, 9], Pd: [5, 10], Ag: [5, 11], Cd: [5, 12],
    In: [5, 13], Sn: [5, 14], Sb: [5, 15], Te: [5, 16], I: [5, 17], Xe: [5, 18], Cs: [6, 1], Ba: [6, 2],
    La: [8, 3], Ce: [8, 4], Pr: [8, 5], Nd: [8, 6], Pm: [8, 7], Sm: [8, 8], Eu: [8, 9] };
  // Diverging colour for [X/H]: blue = less than the Sun, white = solar, orange = more.
  function abundColor(xh) {
    const t = Math.max(-1, Math.min(1, xh / 0.6));
    const a = [255, 255, 255], c = t < 0 ? [70, 130, 230] : [240, 140, 40], k = Math.abs(t);
    return `rgb(${a.map((v, i) => Math.round(v + (c[i] - v) * k)).join(",")})`;
  }

  // Features worth labelling in a Gaia XP spectrum (very low resolution: only broad features show).
  const FEATURES = [
    { nm: 393.4, label: "Ca II H&K", el: "Ca" }, { nm: 434.0, label: "Hγ", el: "H" }, { nm: 486.1, label: "Hβ", el: "H" },
    { nm: 517.0, label: "Mg b", el: "Mg" }, { nm: 589.3, label: "Na D", el: "Na" }, { nm: 656.3, label: "Hα", el: "H" },
    { nm: 710, label: "TiO", el: "Ti", cool: true }, { nm: 770, label: "TiO", el: "Ti", cool: true }, { nm: 854.2, label: "Ca II triplet", el: "Ca" },
  ];

  const api = { SUN, blackbodyRGB, rgb, wavelengthRGB, properties, derived, ratios, composition, SOLAR, Z_SUN, PT, abundColor, FEATURES };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.StarProfile = api;

  // ===================== browser drawing =====================
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let READY = null, INFO = null, uid = 0, hrCache = null;
  const getReady = () => READY ? Promise.resolve(READY) : fetch("data/stars/profile/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []).then((j) => (READY = new Set(j)));
  const getInfo = () => INFO ? Promise.resolve(INFO) : fetch("data/starquake_stars.json").then((r) => r.json()).catch(() => ({})).then((j) => (INFO = j));
  const big = (x) => { const e = Math.floor(Math.log10(x)); return `${(x / 10 ** e).toFixed(2)} × 10<sup>${e}</sup>`; };
  const nice = (x, d = 2) => (x >= 1000 ? Math.round(x).toLocaleString("en-US") : x >= 10 ? x.toFixed(1) : x.toFixed(d));

  function sizeSVG(P, name) {
    const W = 520, H = 230, R = P.R ? P.R.value : null, T = P.T ? P.T.value : null;
    if (!R) return "";
    const maxR = 96, k = maxR / Math.max(R, 1), rs = Math.max(R * k, 1.5), rsun = Math.max(k, 1.5);
    const cx1 = 150, cx2 = R > 4 ? 150 + rs + 60 : 380, cy = 115;
    const grad = (id, col) => `<radialGradient id="${id}"><stop offset="0%" stop-color="#fff" stop-opacity=".95"/><stop offset="35%" stop-color="${col}"/><stop offset="100%" stop-color="${col}" stop-opacity=".85"/></radialGradient>` +
      `<radialGradient id="${id}g"><stop offset="55%" stop-color="${col}" stop-opacity=".35"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></radialGradient>`;
    const disc = (cx, r, id) => `<circle cx="${cx}" cy="${cy}" r="${(r * 1.45).toFixed(1)}" fill="url(#${id}g)"/><circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="url(#${id})"/>`;
    const earthOrbit = R > 60 ? `<circle cx="${cx1}" cy="${cy}" r="${(215 * k).toFixed(1)}" fill="none" stroke="currentColor" stroke-dasharray="3 4" opacity=".5"/><text x="${cx1}" y="${(cy - 215 * k - 4).toFixed(0)}" text-anchor="middle" class="sp-small">Earth's orbit</text>` : "";
    return `<svg class="sp-size" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)} is ${nice(R)} times the Sun's diameter">
      <defs>${grad("spS", T ? rgb(T) : "#ccc")}${grad("spSun", rgb(SUN.T))}</defs>${earthOrbit}
      ${disc(cx1, rs, "spS")}${disc(cx2, rsun, "spSun")}
      <text x="${cx1}" y="${H - 12}" text-anchor="middle" class="sp-lbl">${esc(name)}</text>
      <text x="${cx2}" y="${H - 12}" text-anchor="middle" class="sp-lbl">The Sun</text>
      <text x="${W - 6}" y="16" text-anchor="end" class="sp-small">to scale · true colours from temperature</text></svg>`;
  }

  function barsHTML(rs) {
    const pos = (r) => 50 + Math.max(-50, Math.min(50, Math.log10(r) / 2 * 50));       // 0.01x .. 100x, Sun in the middle
    return `<div class="sp-bars">${rs.map(([lab, r, txt, src]) => {
      const p = pos(r), left = Math.min(50, p), w = Math.abs(p - 50);
      return `<div class="sp-bar" title="${esc(src)}"><span class="sp-bl">${esc(lab)}</span><span class="sp-track"><i class="sp-sun"></i>` +
        `<b class="${r >= 1 ? "up" : "down"}" style="left:${left}%;width:${Math.max(w, 0.6)}%"></b></span><span class="sp-bv">${esc(txt)}</span></div>`;
    }).join("")}<p class="hint sp-axis"><span>0.01×</span><span>Sun</span><span>100×</span></p></div>`;
  }

  function factsHTML(P, D, row) {
    const cards = [];
    if (D.Mkg) cards.push(["Weight", `${big(D.Mkg)} kg`, P.M.value < 0.1 ? `${nice(D.Mjup, 0)} Jupiters` : `${nice(P.M.value)} Suns`]);
    if (D.diamKm) cards.push(["Diameter", `${Math.round(D.diamKm).toLocaleString("en-US")} km`, `${nice(D.diamEarths, 0)} Earths across`]);
    if (P.T) cards.push(["Surface", `${Math.round(P.T.value).toLocaleString("en-US")} K`, `${Math.round(D.Tc).toLocaleString("en-US")} °C`, rgb(P.T.value)]);
    if (P.L) cards.push(["Power output", `${nice(P.L.value, P.L.value < 0.01 ? 4 : 2)} Suns`, P.L.value < 1 ? `${nice(1 / P.L.value, 0)}× dimmer than the Sun` : `${nice(P.L.value, 0)}× brighter`]);
    if (P.dist) cards.push(["Distance", `${nice(P.dist.value)} light-years`, `the light you see left it ${Math.round(P.dist.value)} years ago`]);
    if (D.hzIn) cards.push(["Habitable zone", `${nice(D.hzIn)}–${nice(D.hzOut)} AU`, D.hzOut < 1 ? "much closer in than Earth's orbit" : D.hzIn > 1 ? "farther out than Earth's orbit" : "around Earth's distance"]);
    if (P.age) cards.push(["Age", `${nice(P.age.value, 1)} billion years`, P.age.value > SUN.age ? "older than the Sun" : "younger than the Sun"]);
    if (P.FeH) cards.push(["Metals", `[Fe/H] = ${P.FeH.value >= 0 ? "+" : ""}${P.FeH.value.toFixed(2)}`, `${nice(Math.pow(10, P.FeH.value))}× the Sun's share of iron`]);
    return `<div class="sp-facts">${cards.map(([k, v, s, sw]) => `<div class="sp-card"><span class="sp-k">${esc(k)}${sw ? ` <i class="sp-sw" style="background:${sw}"></i>` : ""}</span><b>${v}</b><span class="sp-s">${esc(s)}</span></div>`).join("")}</div>`;
  }

  function hrDraw(canvas, P, stars, name) {
    const Q = window.Starquake, r = window.devicePixelRatio || 1, w = canvas.clientWidth || 420, h = Math.round(w * 0.72);
    canvas.width = w * r; canvas.height = h * r; canvas.style.height = h + "px";
    const c = canvas.getContext("2d"); c.setTransform(r, 0, 0, r, 0, 0);
    const pad = { l: 46, r: 10, t: 12, b: 34 }, tLo = Math.log10(2300), tHi = Math.log10(30000), lLo = -4.5, lHi = 5.5;
    const X = (T) => pad.l + (tHi - Math.log10(T)) / (tHi - tLo) * (w - pad.l - pad.r), Y = (L) => pad.t + (lHi - Math.log10(L)) / (lHi - lLo) * (h - pad.t - pad.b);
    const css = getComputedStyle(canvas);
    c.fillStyle = css.getPropertyValue("--viewer") || "#03060d"; c.fillRect(0, 0, w, h);
    if (!hrCache && Q) hrCache = stars.map((s) => Q.estimate(s)).filter((e) => e && e.teff > 2300 && e.teff < 30000 && e.L > 3e-5 && e.L < 3e5).map((e) => [e.teff, e.L]);
    for (const [T, L] of hrCache || []) { c.fillStyle = rgb(T); c.globalAlpha = 0.45; c.fillRect(X(T) - 0.8, Y(L) - 0.8, 1.6, 1.6); }
    c.globalAlpha = 1;
    c.fillStyle = "#8d9bb8"; c.font = "10px system-ui";
    c.fillText("giants", X(4600), Y(2000)); c.fillText("main sequence", X(14000), Y(300)); c.fillText("red dwarfs", X(3400), Y(0.0004));
    c.textAlign = "center"; let lastX = -1e9;
    for (const T of [20000, 10000, 6000, 4000, 3000]) { const lx = X(T), lab = T.toLocaleString("en-US") + " K", tw = c.measureText(lab).width; if (lx - tw / 2 > lastX + 6) { c.fillText(lab, lx, h - 10); lastX = lx + tw / 2; } }
    c.textAlign = "right"; for (const L of [1e-4, 0.01, 1, 100, 1e4]) c.fillText(L >= 1 ? L.toLocaleString("en-US") : String(L), pad.l - 4, Y(L) + 3);
    c.textAlign = "left"; c.fillText("× Sun's power", pad.l + 4, pad.t + 8); c.fillText("hotter ←  temperature  → cooler", w / 2 - 70, h - 22);
    const mark = (T, L, col, label, rr) => {
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(X(T), Y(L), rr, 0, 7); c.stroke(); c.fillStyle = col; c.font = "bold 11px system-ui";
      const tw = c.measureText(label).width, right = X(T) + rr + 4 + tw <= w - 4;      // flip to the left near the edge
      c.fillText(label, right ? X(T) + rr + 4 : X(T) - rr - 4 - tw, Y(L) + 4);
    };
    mark(SUN.T, 1, "#ffd166", "Sun", 5);
    if (P.T && P.L) mark(Math.max(2300, Math.min(30000, P.T.value)), Math.max(3e-5, Math.min(3e5, P.L.value)), "#ff7bd5", name, 7);
  }

  function compositionHTML(P, chem) {
    const feh = P.FeH ? P.FeH.value : 0, ab = chem && chem.abundances, comp = composition(feh, ab);
    // donut: hydrogen, helium, metals (metals exaggerated so the slice is visible, labelled with the true number)
    const parts = [["Hydrogen", comp.X, "#7cc4ff"], ["Helium", comp.Y, "#b48cff"], ["Everything else", comp.Z, "#ffb547"]];
    let a0 = -Math.PI / 2, svg = "";
    const R = 52, r0 = 32, cx = 60, cy = 60;
    for (const [lab, f, col] of parts) {
      const a1 = a0 + Math.max(f, lab === "Everything else" ? 0.03 : f) * 2 * Math.PI, big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, rr) => `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
      svg += `<path d="M${p(a0, R)}A${R},${R} 0 ${big} 1 ${p(a1, R)}L${p(a1, r0)}A${r0},${r0} 0 ${big} 0 ${p(a0, r0)}Z" fill="${col}"><title>${lab}: ${(f * 100).toFixed(2)}% by mass</title></path>`;
      a0 = a1;
    }
    const top = Object.entries(comp.metals).sort((a, b) => b[1] - a[1]), shown = top.slice(0, 7), other = top.slice(7).reduce((s, x) => s + x[1], 0);
    const NAMES = { O: "oxygen", C: "carbon", Ne: "neon", Fe: "iron", N: "nitrogen", Si: "silicon", Mg: "magnesium", S: "sulphur", Ar: "argon", Ni: "nickel", Ca: "calcium", Al: "aluminium", Na: "sodium", Cr: "chromium", Mn: "manganese", Ti: "titanium" };
    const metalBar = shown.concat([["other", other]]).map(([el, f], i) => `<span style="flex:${(f / comp.Z * 100).toFixed(3)} 1 0;background:hsl(${30 + i * 38},70%,58%)" title="${esc(NAMES[el] || el)}: ${(f / comp.Z * 100).toFixed(1)}% of the metals">${f / comp.Z > 0.07 ? esc(el) : ""}</span>`).join("");
    // periodic table of [X/H]
    let tiles = "";
    for (const [el, [per, grp]] of Object.entries(PT)) {
      const v = ab && ab[el], x = (grp - 1) * 22 + 2, y = (per - 1) * 22 + (per === 8 ? 6 : 0) + 2;
      tiles += `<g class="${v ? "pt-on" : "pt-off"}"><rect x="${x}" y="${y}" width="20" height="20" rx="3" fill="${v ? abundColor(v.x_h) : "none"}"/>` +
        `<text x="${x + 10}" y="${y + 13.5}" text-anchor="middle">${el}</text>${v ? `<title>${el}: [${el}/H] = ${v.x_h >= 0 ? "+" : ""}${v.x_h.toFixed(2)} (${nice(Math.pow(10, v.x_h))}× the Sun), from ${v.n_catalogs} studies</title>` : ""}</g>`;
    }
    return `<div class="sp-comp">
      <div class="sp-donut"><svg viewBox="0 0 120 120" role="img" aria-label="Composition by mass">${svg}<text x="60" y="57" text-anchor="middle" class="sp-small">by</text><text x="60" y="70" text-anchor="middle" class="sp-small">mass</text></svg>
        <ul>${parts.map(([l, f, c]) => `<li><i style="background:${c}"></i>${l} <b>${(f * 100).toFixed(f < 0.05 ? 2 : 1)}%</b></li>`).join("")}</ul></div>
      <div class="sp-metals"><p class="sp-k">What the "everything else" is</p><div class="sp-mbar">${metalBar}</div>
        <p class="hint">Oxygen, carbon and neon lead, as in the Sun${comp.measured ? "; measured elements are scaled by this star's own abundances" : "; scaled by its overall metal content"}.</p></div>
    </div>
    ${ab && Object.keys(ab).length ? `<p class="sp-k">Elements measured in its light, compared with the Sun</p>
      <svg class="sp-pt" viewBox="0 0 400 190" role="img" aria-label="Periodic table coloured by abundance relative to the Sun">${tiles}</svg>
      <p class="hint sp-legend"><i style="background:${abundColor(-0.6)}"></i> less than the Sun <i style="background:${abundColor(0)}"></i> same <i style="background:${abundColor(0.6)}"></i> more · ${Object.keys(ab).length} elements · ${esc(chem.source)}</p>` :
      `<p class="hint">No element-by-element measurements for this star in the Hypatia Catalog${P.FeH ? "; the split above uses its overall metal content" : "; the split above assumes a Sun-like mix"}. Helium is not visible in cool stars' light and follows the Galaxy's helium-enrichment law.</p>`}`;
  }

  function spectrumSVG(spec, P) {
    if (!spec) return "";
    const keep = spec.wavelength_nm.map((l, i) => i).filter((i) => spec.wavelength_nm[i] >= 380 && spec.wavelength_nm[i] <= 1000);
    if (keep.length < 10) return "";
    const top = Math.max(...keep.map((i) => spec.flux[i])) || 1;                 // the edges are noisy: show 380-1000 nm, rescaled
    spec = { wavelength_nm: keep.map((i) => spec.wavelength_nm[i]), flux: keep.map((i) => spec.flux[i] / top) };
    const W = 640, H = 200, L = 34, R = 10, T = 14, B = 30, lo = spec.wavelength_nm[0], hi = spec.wavelength_nm[spec.wavelength_nm.length - 1];
    const x = (l) => L + (l - lo) / (hi - lo) * (W - L - R), y = (f) => H - B - Math.max(0, f) * (H - B - T);
    const pts = spec.wavelength_nm.map((l, i) => [x(l), y(spec.flux[i])]);
    const stops = []; for (let l = lo; l <= hi; l += 10) stops.push(`<stop offset="${((l - lo) / (hi - lo) * 100).toFixed(1)}%" stop-color="${wavelengthRGB(l)}"/>`);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    const cool = P.T && P.T.value < 4000, hot = P.T && P.T.value > 7000;
    const feats = FEATURES.filter((f) => f.nm > lo && f.nm < hi && (!f.cool || cool) && !(hot && f.el === "Ti"))
      .map((f) => `<g class="sp-feat"><line x1="${x(f.nm).toFixed(1)}" x2="${x(f.nm).toFixed(1)}" y1="${T}" y2="${H - B}"/><text x="${x(f.nm).toFixed(1)}" y="${T - 2}" text-anchor="middle">${esc(f.label)}</text></g>`).join("");
    const ticks = [400, 500, 600, 700, 800, 900, 1000].filter((l) => l >= lo && l <= hi).map((l) => `<text x="${x(l)}" y="${H - 12}" text-anchor="middle">${l} nm</text>`).join("");
    return `<svg class="sp-spec" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gaia XP spectrum from ${lo} to ${hi} nanometres">
      <defs><linearGradient id="spRainbow" x1="0" x2="1">${stops.join("")}</linearGradient></defs>
      <path d="${line}L${x(hi).toFixed(1)},${H - B}L${x(lo).toFixed(1)},${H - B}Z" fill="url(#spRainbow)" opacity=".85"/>
      <path d="${line}" fill="none" class="sp-line"/>${feats}${ticks}
      <text x="${W - R}" y="${H - B - 6}" text-anchor="end" class="sp-small">invisible infrared →</text><text x="${L + 2}" y="${H - B - 6}" class="sp-small">← violet</text></svg>`;
  }

  function planetsSVG(planets, D, P) {
    if (!planets || !planets.length) return "";
    const pl = planets.filter((p) => p.a_au > 0);
    const maxA = Math.max(...pl.map((p) => p.a_au), D.hzOut || 0, 0.05) * 1.15, W = 520, H = 120, cy = 60, x0 = 20;
    const X = (a) => x0 + a / maxA * (W - x0 - 20);
    const hz = D.hzIn ? `<rect x="${X(D.hzIn)}" y="${cy - 26}" width="${Math.max(2, X(D.hzOut) - X(D.hzIn))}" height="52" rx="6" class="sp-hz"/><text x="${(X(D.hzIn) + X(D.hzOut)) / 2}" y="${cy + 40}" text-anchor="middle" class="sp-small">habitable zone</text>` : "";
    const dots = pl.map((p, i) => { const mE = p.mass_mjup ? p.mass_mjup * 317.8 : null, r = mE ? Math.max(3, Math.min(10, 2.5 * Math.cbrt(mE))) : 4;
      return `<circle cx="${X(p.a_au)}" cy="${cy}" r="${r}" class="sp-planet"><title>Planet ${esc(p.name)}: ${mE ? `${nice(mE, 1)} Earth masses` : "mass unknown"}, ${p.period_d ? nice(p.period_d, 1) + "-day year" : ""}, ${nice(p.a_au, 3)} AU</title></circle><text x="${X(p.a_au)}" y="${cy - 14 - (i % 2) * 10}" text-anchor="middle" class="sp-small">${esc(p.name)}</text>`; }).join("");
    return `<svg class="sp-planets" viewBox="0 0 ${W} ${H}" role="img" aria-label="${pl.length} known planets and the habitable zone">
      ${hz}<line x1="${x0}" x2="${W - 10}" y1="${cy}" y2="${cy}" class="sp-orbitline"/><circle cx="${x0}" cy="${cy}" r="9" fill="${P.T ? rgb(P.T.value) : "#ffd166"}"/>${dots}
      <text x="${W - 10}" y="${H - 6}" text-anchor="end" class="sp-small">distance from the star, AU (Earth–Sun = 1)</text></svg>`;
  }

  async function mount(el, { key, row, stars }) {
    if (!el) return;
    const me = String(++uid); el.dataset.uid = me;
    const [ready, info] = await Promise.all([getReady(), getInfo()]);
    if (el.dataset.uid !== me) return;
    let profile = null;
    if (ready.has(key)) profile = await fetch(`data/stars/profile/${key}.json`).then((r) => r.json()).catch(() => null);
    render(el, profile, row, info[key], stars, key);
    if (!profile) {                                        // ask the local server to gather Gaia + Hypatia data, then refresh
      const live = await fetch("api/health").then((r) => r.ok).catch(() => false);
      if (!live || el.dataset.uid !== me) return;
      const msg = el.querySelector(".sp-status"); if (msg) msg.textContent = "Looking up Gaia and the Hypatia Catalog for this star…";
      try {
        const r = await fetch("api/star-profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || "server error");
        for (let i = 0; i < 90; i++) {
          await new Promise((ok) => setTimeout(ok, 2000));
          if (el.dataset.uid !== me) return;
          const st = await fetch(`api/star-job/${j.job}`).then((x) => x.json());
          if (st.status === "done") { READY.add(key); profile = await fetch(`data/stars/profile/${key}.json?t=${Date.now()}`).then((x) => x.json()); render(el, profile, row, info[key], stars, key); return; }
          if (st.status === "error") throw new Error(st.log.slice(-1)[0] || "failed");
        }
      } catch (e) { if (msg && el.dataset.uid === me) msg.textContent = "Could not reach Gaia/Hypatia just now; showing catalogue estimates."; }
    }
  }

  function render(el, profile, row, info, stars, key) {
    const P = properties(profile, row, info, window.Starquake), D = derived(P), name = (row && row.name) || (profile && profile.name) || "This star";
    const estimated = Object.values(P).some((v) => /estimate/.test(v.source));
    el.innerHTML = `<div class="sprof">
      <h3>Star profile <span class="tag-chip ${profile ? "data" : "illus"}">${profile ? "Measured + catalogue" : "Catalogue estimate"}</span></h3>
      <p class="hint sp-status">${profile ? `Sources: ${esc([...new Set(Object.values(P).map((v) => v.source))].join("; "))}.` : "Estimated from the star catalogue (brightness, distance, colour)."}${estimated && profile ? " Values marked “estimate” come from the catalogue." : ""}</p>
      <div class="sp-grid">${sizeSVG(P, name)}<div class="sp-hrwrap"><canvas class="sp-hr" role="img" aria-label="Hertzsprung–Russell diagram with ${esc(name)} and the Sun"></canvas>
        <p class="hint">Every star in the database by temperature and brightness (the Hertzsprung–Russell diagram).</p></div></div>
      ${factsHTML(P, D, row)}
      <h4>Compared with the Sun</h4>${barsHTML(ratios(P, D))}
      <h4>What it is made of</h4>${compositionHTML(P, profile && profile.chemistry)}
      ${profile && profile.spectrum ? `<h4>Its light, spread into a rainbow</h4>${spectrumSVG(profile.spectrum, P)}
        <p class="hint">${esc(profile.spectrum.source)}; 380–1000 nm shown (the ends are noisy). Very low resolution: dark dips from hydrogen, calcium, sodium, magnesium or titanium oxide show only as broad features, and only where this star's temperature makes them strong.</p>` : ""}
      ${profile && profile.planets && profile.planets.length ? `<h4>Known planets</h4>${planetsSVG(profile.planets, D, P)}<p class="hint">Planets from the Hypatia Catalog (NASA Exoplanet Archive). Green: the habitable zone, where water could be liquid.</p>` : ""}
    </div>`;
    el.hidden = false;
    const cv = el.querySelector(".sp-hr");
    if (cv) requestAnimationFrame(() => hrDraw(cv, P, stars || [], name));
  }

  root.StarProfile.mount = mount;
})(typeof window !== "undefined" ? window : globalThis);
