/* Starquakes: a star's internal sound waves (solar-like oscillations), sped up so we can hear them.
 * Recreates the method of Stanford's Sonification of Solar Harmonics (SoSH) project (Kosovichev et al.):
 * the Sun's ~3 mHz (5-minute) oscillations sped up 42,000x become a hum near 126 Hz. Every star here uses
 * the same 42,000x, so pitch compares fairly: small dense stars sound higher, big ones lower.
 *
 * Model (when no recording is used):
 *   nu_max = 3090 uHz * (M/Msun) (R/Rsun)^-2 (Teff/5777 K)^-0.5     peak frequency (Brown et al. 1991; Kjeldsen & Bedding 1995)
 *   dnu    = 135.1 uHz * (M/Msun)^0.5 (R/Rsun)^-1.5                spacing, set by mean density
 *   nu(n,l) = dnu (n + l/2 + eps) - l(l+1) D0,  D0 = dnu/100       asymptotic pattern (Tassoul 1980); eps = 1.45
 *   heights: Gaussian envelope around nu_max, FWHM = 0.66 nu_max^0.88 (Mosser et al. 2012), visibility l=0:1:2 = 1 : 1.5 : 0.5
 *   linewidth Gamma = 1 uHz (Teff/5777)^15, kept within 0.1-10 uHz                (about 1 uHz for the Sun)
 * Synthesis: each mode is a Lorentzian line of width Gamma, filled with random complex amplitudes
 * (stochastic excitation by convection) and turned into sound by an inverse FFT. Gamma = 1 uHz means a mode
 * lives ~3.7 days, which is ~7.6 s of audio at 42,000x: the slow swelling and fading of real modes.
 *
 * Works in the browser (window.Starquake) and in Node (module.exports).
 */
(function (root) {
  "use strict";
  const SUN = { numax: 3090, dnu: 135.1, teff: 5777, gamma: 1.0 };
  const SPEEDUP = 42000;
  const VIS = [1, 1.5, 0.5];               // relative visibility (amplitude^2) of l = 0, 1, 2
  const EPS = 1.45;
  const HOT = 7000;                        // K: hotter stars have no deep convective envelope to drive starquakes

  const numaxOf = (M, R, T) => SUN.numax * M * Math.pow(R, -2) * Math.pow(T / SUN.teff, -0.5);
  const dnuOf = (M, R) => SUN.dnu * Math.sqrt(M) * Math.pow(R, -1.5);
  const gammaOf = (T) => Math.min(10, Math.max(0.1, SUN.gamma * Math.pow(T / SUN.teff, 15)));
  const envFwhm = (numax) => 0.66 * Math.pow(numax, 0.88);

  // ---- star parameters ----
  // Teff from B-V (Ballesteros 2012), or from the spectral type when there is no colour.
  const teffFromBV = (bv) => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const SPT = { O: [42000, 31000], B: [31000, 10000], A: [9700, 7300], F: [7200, 6000], G: [5900, 5300], K: [5250, 3900], M: [3850, 2400], L: [2300, 1400], T: [1300, 600], Y: [500, 250] };
  const SPT_GIANT = { G: [5600, 4850], K: [4750, 3850], M: [3850, 2900] };   // giants are cooler than dwarfs of the same type
  function teffFromType(spect) {
    const m = /^\s*(?:sd|d)?([OBAFGKMLTY])(\d(?:\.\d)?)?/.exec(spect || "");
    if (!m) return null;
    const table = isGiant(spect) && SPT_GIANT[m[1]] ? SPT_GIANT : SPT;
    const [hi, lo] = table[m[1]], sub = m[2] ? +m[2] : 5;
    return hi + (lo - hi) * sub / 10;
  }
  const isGiant = (spect) => /(?:^|[^I])(III|II|Ib|Iab|Ia|I)(?![IV])/.test((spect || "").replace(/^[^OBAFGKMLTY]*[OBAFGKMLTY][\d.]*/, ""));
  // V-band bolometric correction against Teff (approximate, after Flower 1996)
  const BC = [[2500, -4.0], [3100, -2.2], [3850, -1.2], [4400, -0.7], [5250, -0.3], [5770, -0.07], [6500, -0.01], [8100, -0.05], [9700, -0.3], [15700, -1.4], [31000, -3.0], [42000, -4.0]];
  function bcOf(T) {
    if (T <= BC[0][0]) return BC[0][1];
    for (let i = 1; i < BC.length; i++) if (T <= BC[i][0]) {
      const [t0, b0] = BC[i - 1], [t1, b1] = BC[i], f = (Math.log(T) - Math.log(t0)) / (Math.log(t1) - Math.log(t0));
      return b0 + f * (b1 - b0);
    }
    return BC[BC.length - 1][1];
  }

  // Physical parameters for a database row, from its catalogue magnitude, distance, colour and type.
  // Returns {M, R, teff, L, giant, how} or null. These are estimates and the page labels them as such.
  function estimate(row) {
    if (!row) return null;
    const teff = Number.isFinite(row.ci) ? teffFromBV(row.ci) : teffFromType(row.spect);
    if (!teff || !(row.dist_pc > 0) || !Number.isFinite(row.mag)) return null;
    const absV = row.mag - 5 * Math.log10(row.dist_pc / 10);
    const L = Math.pow(10, -0.4 * (absV + bcOf(teff) - 4.74));
    const R = Math.sqrt(L) / Math.pow(teff / SUN.teff, 2);
    const giant = isGiant(row.spect) || R > 5;
    const M = giant ? 1.3 : L < 0.033 ? Math.pow(L / 0.23, 1 / 2.3) : Math.min(2.5, Math.pow(L, 0.25));
    return { M, R, teff, L, giant, how: `estimated from the catalogue (V, distance, ${Number.isFinite(row.ci) ? "B−V colour" : "spectral type"})` + (giant ? "; giant mass assumed 1.3 M☉" : "; mass from the mass–luminosity relation") };
  }

  // What we can say about a star's starquakes. info: entry from starquake_stars.json (or null); row: database row.
  // Returns {kind: "measured"|"published"|"predicted"|"none", numax, dnu, gamma, teff, ...labels}
  function describe(info, row) {
    const est = info && info.M ? { M: info.M, R: info.R, teff: info.teff, how: info.params_ref || "literature values" } : estimate(row);
    const teff = (info && info.teff) || (est && est.teff);
    if (teff && teff > HOT) return { kind: "none", teff, why: `At about ${Math.round(teff).toLocaleString()} K this star has no deep outer convection zone, so it is not expected to ring with starquakes like the Sun's. (Hot stars can pulsate in other ways, which this does not model.)` };
    if (info && info.numax && info.dnu) {
      return { kind: info.recording ? "measured" : "published", numax: info.numax, dnu: info.dnu, gamma: info.gamma || gammaOf(teff || SUN.teff),
        teff, ref: info.ref, recording: info.recording || null, note: info.note || null };
    }
    if (!est) return { kind: "none", why: "Not enough is known about this star (temperature, brightness and distance) to predict its starquakes." };
    const numax = numaxOf(est.M, est.R, est.teff), dnu = dnuOf(est.M, est.R);
    const cool = est.teff < 2600;
    return { kind: "predicted", numax, dnu, gamma: gammaOf(est.teff), teff: est.teff, M: est.M, R: est.R, how: est.how,
      note: (info && info.note) || (cool ? "Brown dwarfs are predicted to oscillate, but it has never been detected: this is a prediction only." :
        est.teff < 3900 && !est.giant ? "Red dwarfs like this are predicted to have tiny, fast starquakes, but none has been detected yet: this is a prediction." : null) };
  }

  // ---- modes ----
  function modes(d) {
    const sigma = envFwhm(d.numax) / 2.355, D0 = d.dnu / 100, out = [];
    const nLo = Math.max(1, Math.floor((d.numax - 3.2 * sigma) / d.dnu - EPS)), nHi = Math.ceil((d.numax + 3.2 * sigma) / d.dnu - EPS);
    for (let n = nLo; n <= nHi; n++) for (let l = 0; l <= 2; l++) {
      const nu = d.dnu * (n + l / 2 + EPS) - l * (l + 1) * D0;
      if (nu <= 0) continue;
      const h = VIS[l] * Math.exp(-((nu - d.numax) ** 2) / (2 * sigma * sigma));
      if (h > 1e-3) out.push({ n, l, nu, height: h, gamma: d.gamma });
    }
    return out;
  }

  // Speed-up: always 42,000x, with an extra, clearly labelled factor only when the result would be too low to hear.
  function speedupFor(numax) {
    let extra = 1;
    for (const k of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6]) { extra = k; if (numax * 1e-6 * SPEEDUP * k >= 30) break; }   // 30 Hz: about the lowest pitch we hear
    return { speedup: SPEEDUP * extra, extra, hz: numax * 1e-6 * SPEEDUP * extra };
  }

  // ---- synthesis ----
  function rng(seed) {                      // mulberry32 + Box-Muller (normal deviates)
    let a = seed >>> 0;
    const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
  }

  // In-place iterative radix-2 FFT on (re, im); inverse when inv = true (unnormalised).
  function fft(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // Modes -> audio samples. opts: {speedup, fs (Hz), log2n, seed}. Returns {samples: Float32Array, fs, seconds}.
  function synth(ms, opts = {}) {
    const S = opts.speedup || SPEEDUP, fs = opts.fs || 16000, N = 1 << (opts.log2n || 19), T = N / fs, g = rng(opts.seed || 1);
    const re = new Float64Array(N), im = new Float64Array(N), df = 1 / T;
    for (const m of ms) {
      const f0 = m.nu * 1e-6 * S, half = Math.max(m.gamma * 1e-6 * S / 2, df / 2);      // Lorentzian half-width in Hz (at least one bin)
      const k0 = Math.round(f0 / df), reach = Math.ceil(60 * half / df) + 2;
      for (let k = Math.max(1, k0 - reach); k <= Math.min(N / 2 - 1, k0 + reach); k++) {
        const x = (k * df - f0) / half, p = m.height / (1 + x * x), a = Math.sqrt(p / 2);
        re[k] += a * g(); im[k] += a * g();
      }
    }
    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }          // Hermitian -> real signal
    fft(re, im, true);
    let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(re[i]));
    const out = new Float32Array(N), fade = Math.floor(0.4 * fs);
    for (let i = 0; i < N; i++) {
      const w = Math.min(1, i / fade, (N - 1 - i) / fade);                                 // soft start and end, no clicks
      out[i] = peak ? (0.85 * re[i] / peak) * w : 0;
    }
    return { samples: out, fs, seconds: T };
  }

  // Power spectrum of samples (for tests and the picture): returns {freq: Float64Array (Hz), power}
  function spectrum(samples, fs) {
    let n = 1; while (n < samples.length) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n); re.set(samples);
    fft(re, im, false);
    const freq = new Float64Array(n / 2), power = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { freq[k] = k * fs / n; power[k] = re[k] * re[k] + im[k] * im[k]; }
    return { freq, power };
  }

  // 16-bit mono WAV, for "download".
  function wav(samples, fs) {
    const n = samples.length, buf = new ArrayBuffer(44 + 2 * n), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, fs, true); v.setUint32(28, 2 * fs, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, 2 * n, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return buf;
  }

  const api = { SUN, SPEEDUP, VIS, EPS, HOT, numaxOf, dnuOf, gammaOf, envFwhm, teffFromBV, teffFromType, isGiant, bcOf,
    estimate, describe, modes, speedupFor, synth, spectrum, wav, fft, rng };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Starquake = api;
})(typeof window !== "undefined" ? window : globalThis);
