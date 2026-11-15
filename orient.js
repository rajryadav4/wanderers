/* WANDERERS orientation engine: where is the phone's camera pointing?
 *
 * Phones give two kinds of orientation:
 *  - RELATIVE (gyroscope + accelerometer): smooth and precise, but its "north" is arbitrary and drifts slowly.
 *  - ABSOLUTE (adds the magnetometer): knows magnetic north, but is noisy (+-3-5 deg), easily disturbed by
 *    metal, and on iPhone the compass heading is only well defined when the phone is roughly flat.
 * We fuse them: the RELATIVE stream drives every movement, and the compass only sets the yaw offset between
 * the gyro frame and magnetic north. That offset is measured precisely during a 3-second "lay the phone flat"
 * calibration (many samples averaged, phone still, compass at its most reliable), then corrected very slowly
 * afterwards. Result: smooth, stable pointing that still knows where north is.
 *
 * Angles follow the W3C DeviceOrientation spec: R = Rz(alpha) * Rx(beta) * Ry(gamma) maps device axes to the
 * Earth frame (x east, y north, z up). The back camera looks along the device's -z axis.
 * Works in browsers (window.Orient) and in Node (module.exports) so it can be tested with simulated sensors. */
(function (root) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const wrap180 = (x) => ((x % 360) + 540) % 360 - 180;
  const wrap360 = (x) => ((x % 360) + 360) % 360;

  function matFromEuler(a, b, g) {
    a *= D2R; b *= D2R; g *= D2R;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    return [
      [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
      [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
      [-cb * sg, sb, cb * cg],
    ];
  }
  function eulerFromMat(R) {          // inverse of matFromEuler, W3C ranges (gamma in [-90, 90))
    const sb = Math.max(-1, Math.min(1, R[2][1]));
    const sign = R[2][2] >= 0 ? 1 : -1;
    const cb = sign * Math.hypot(R[2][0], R[2][2]);
    const beta = Math.atan2(sb, cb) * R2D;
    const gamma = Math.atan2(-R[2][0] * sign, R[2][2] * sign) * R2D;
    const alpha = Math.abs(cb) > 1e-9 ? Math.atan2(-R[0][1] / cb, R[1][1] / cb) * R2D : 0;
    return { alpha: wrap360(alpha), beta, gamma };
  }
  const mul = (A, B) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const T = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);
  const col = (R, j) => [R[0][j], R[1][j], R[2][j]];
  const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const azAlt = (v) => ({ az: wrap360(Math.atan2(v[0], v[1]) * R2D), alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D });
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * R2D;

  // circular statistics for yaw offsets
  function circMean(list) {
    let x = 0, y = 0, w = 0;
    for (const s of list) { const ww = s.w == null ? 1 : s.w; x += ww * Math.cos(s.v * D2R); y += ww * Math.sin(s.v * D2R); w += ww; }
    const r = Math.hypot(x, y) / (w || 1);
    return { mean: wrap360(Math.atan2(y, x) * R2D), std: Math.sqrt(Math.max(0, -2 * Math.log(Math.max(r, 1e-9)))) * R2D };
  }

  class Fusion {
    constructor() {
      this.rel = null;            // latest relative Euler {alpha,beta,gamma,t}
      this.absAlpha = null;       // latest absolute yaw sample (magnetic), paired with rel
      this.delta = null;          // yaw offset: alpha_magnetic = alpha_relative + delta
      this.deltaStd = null;
      this.calibrated = false;
      this.platform = "unknown";  // "ios" | "android" | "none"
      this.compassAccuracy = null;
      this.bias = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];   // device-frame tilt bias from calibration
      this.decl = 0;              // magnetic declination (deg, east +), set by the app
      this.fineAz = 0;            // user fine-tune (deg)
      this.fineAlt = 0;
      this.out = null;            // smoothed {f, u}
      this.lastRaw = null;
      this.rate = 0;              // deg/s, for adaptive smoothing
      this.flat = null;           // calibration buffer
      this.relOnly = true;        // becomes false once we see a separate relative stream next to an absolute one
      this.sawRelative = false;
      this.absMotion = false;     // true while the absolute stream drives motion (delta 0 is only valid for it)
    }

    // ---- input: call for every deviceorientation / deviceorientationabsolute event ----
    feed(e) {
      const t = e.t != null ? e.t : Date.now();
      if (e.beta == null || e.gamma == null) return;
      const hasCompass = typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading) && e.webkitCompassHeading >= 0;
      if (hasCompass) {
        // iOS: one event carries the smooth relative Euler angles AND a compass heading.
        this.platform = "ios";
        this.sawRelative = true;
        this.compassAccuracy = typeof e.webkitCompassAccuracy === "number" ? e.webkitCompassAccuracy : null;
        this.rel = { alpha: e.alpha || 0, beta: e.beta, gamma: e.gamma, t };
        // iPhone compass heading has TWO meanings (seen in a real test: S 175 deg -> N 357 deg the moment the
        // camera tilted past ~45 deg up): when the top of the phone is within 45 deg of horizontal, it is the
        // direction the TOP points; otherwise it is the direction the CAMERA points. Pointing at the sky above
        // 45 deg therefore flips it by 180 deg. We compute the matching direction in the gyro frame for whichever
        // mode applies, and skip the ambiguous band around the switch.
        const R = matFromEuler(this.rel.alpha, this.rel.beta, this.rel.gamma);
        const topElev = Math.asin(Math.max(-1, Math.min(1, R[2][1]))) * R2D;
        const mode = Math.abs(topElev) < 38 ? "top" : Math.abs(topElev) > 52 ? "camera" : null;
        if (mode) {
          const v = mode === "top" ? [R[0][1], R[1][1], R[2][1]] : [-R[0][2], -R[1][2], -R[2][2]];
          if (Math.hypot(v[0], v[1]) > 0.5) {           // needs a clear horizontal direction
            const flatish = Math.abs(e.beta) < 35 && Math.abs(e.gamma) < 35;
            this._deltaSample(wrap360(azAlt(v).az - e.webkitCompassHeading), t, flatish ? 1 : 0.5);
          }
        }
        this._step(t);
        return;
      }
      if (e.absolute === true || e.type === "deviceorientationabsolute") {
        if (this.platform === "unknown") this.platform = "android";
        if (!this.sawRelative) {
          // No separate gyro stream (some browsers): use the absolute stream as the motion source with delta 0.
          this.rel = { alpha: e.alpha || 0, beta: e.beta, gamma: e.gamma, t };
          if (this.delta == null) { this.delta = 0; this.deltaStd = 5; this.absMotion = true; }
          this._step(t);
          return;
        }
        // Yaw from the fused absolute stream is meaningful away from gimbal lock (beta near +-90).
        if (Math.abs(Math.cos(e.beta * D2R)) > 0.35 && this.rel) this._yawSample(e.alpha, t, 0.5);
        return;
      }
      // relative (gyro) stream
      // If an absolute event came first (both streams start together on Android), delta 0 was set for the absolute
      // frame; the gyro frame's north is arbitrary, so let the next compass sample set delta afresh.
      if (this.absMotion) { this.absMotion = false; this.delta = null; this.deltaStd = null; }
      this.sawRelative = true;
      this.rel = { alpha: e.alpha || 0, beta: e.beta, gamma: e.gamma, t };
      this._step(t);
    }

    _yawSample(absAlpha, t, w) { this._deltaSample(wrap360(absAlpha - this.rel.alpha), t, w); }
    _deltaSample(d, t, w) {
      this.hasCompass = true;
      if (this.flat) { const c = this.flat.cur; if (c && t - c.start > 600) c.deltas.push({ v: d, w }); return; }
      if (this.compassFrozen) return;                         // a sight check beats the magnetometer
      if (this.delta == null) { this.delta = d; this.deltaStd = 10; return; }
      // Slow complementary correction: fast before calibration, very slow after (gyro is trusted).
      const diff = wrap180(d - this.delta);
      const dt = this._lastYawT ? Math.min(0.2, (t - this._lastYawT) / 1000) : 0.016;
      this._lastYawT = t;
      const tau = this.calibrated ? 60 : 3;                   // seconds: gyro is trusted once calibrated
      const robust = Math.exp(-Math.pow(diff / 20, 2));       // ignore magnetic spikes
      this.delta = wrap360(this.delta + diff * (dt / tau) * robust * w);
    }

    // ---- four-way flat calibration ----
    // Lay the phone flat and hold still, then give it a quarter turn and hold, four times. At each stop we average
    // the compass (ignoring the first 0.6 s, because iOS smooths its heading and lags after a turn). The gyroscope
    // knows exactly how far the phone turned, so if the four stops disagree, something nearby is bending the
    // compass (magnetic phone case, laptop, steel desk). Averaging four directions cancels the phone's own
    // magnetic bias; a uniform bias from a whole building cannot be detected this way and needs a sight check.
    startFlatCalibration() { this.flat = { stops: [], cur: null, window: [], state: "waiting" }; }
    cancelCalibration() { this.flat = null; }
    finishCalibrationNow() { if (this.flat && this.flat.stops.length) this._finishFlat(); }
    _flatTick(t) {
      const F = this.flat, r = this.rel;
      F.window.push([r.beta, r.gamma, r.alpha]); if (F.window.length > 20) F.window.shift();
      const n = F.window.length, mean = (k) => F.window.reduce((s, x) => s + x[k], 0) / n;
      const sd = (k) => { const m = mean(k); return Math.sqrt(F.window.reduce((s, x) => s + (x[k] - m) ** 2, 0) / n); };
      const yawSpread = Math.max(...F.window.map((x) => Math.abs(wrap180(x[2] - r.alpha))));
      const flat = Math.abs(r.beta) < 12 && Math.abs(r.gamma) < 12;
      const still = n >= 10 && sd(0) < 0.5 && sd(1) < 0.5 && yawSpread < 1;
      if (!flat) { F.state = "tilted"; F.cur = null; return; }
      if (!still) { F.state = "moving"; F.cur = null; return; }
      if (F.stops.some((st) => Math.abs(wrap180(st.yaw - r.alpha)) < 60)) { F.state = "turn"; F.cur = null; return; }
      if (!F.cur) F.cur = { start: t, tilt: [], deltas: [] };
      F.state = "ok";
      F.cur.tilt.push([r.beta, r.gamma]);
      const enough = this.hasCompass ? F.cur.deltas.length >= 8 : true;
      if (t - F.cur.start >= 1300 && enough) {
        const c = F.cur.deltas.length ? circMean(F.cur.deltas) : null;
        F.stops.push({ yaw: r.alpha, delta: c ? c.mean : null, scatter: c ? c.std : null, tilt: F.cur.tilt });
        F.cur = null; F.state = "turn";
        if (F.stops.length >= 4) this._finishFlat();
      }
    }
    _finishFlat() {
      const F = this.flat, tilts = F.stops.flatMap((st) => st.tilt);
      const b0 = tilts.reduce((s, x) => s + x[0], 0) / tilts.length;
      const g0 = tilts.reduce((s, x) => s + x[1], 0) / tilts.length;
      const lim = (x) => Math.max(-6, Math.min(6, x));
      this.bias = T(matFromEuler(0, lim(b0), lim(g0)));        // measured = true * B  =>  true = measured * B^T
      const withCompass = F.stops.filter((st) => st.delta != null);
      let spread = null;
      if (withCompass.length) {
        const c = circMean(withCompass.map((st) => ({ v: st.delta })));
        this.delta = c.mean; this.deltaStd = c.std;
        spread = Math.max(...withCompass.map((st) => Math.abs(wrap180(st.delta - c.mean))));
      }
      this.calibrated = true; this.compassFrozen = false;
      this.result = {
        stops: F.stops.length, tiltDeg: Math.hypot(b0, g0), spread,
        quality: !withCompass.length ? "nocompass" : F.stops.length < 4 ? "partial" : spread < 5 ? "good" : spread < 12 ? "fair" : "poor",
      };
      this.flat = null;
      if (this.onCalibrated) this.onCalibrated(this.result);
    }
    calibrationState() {
      if (!this.flat) return null;
      const F = this.flat, part = F.cur ? Math.min(1, (this.rel.t - F.cur.start) / 1600) : 0;
      return { progress: (F.stops.length + part) / 4, stops: F.stops.length, state: F.state };
    }
    clearFineTune() { this.fineAz = 0; this.fineAlt = 0; this.compassFrozen = false; }

    // ---- fine-tune on a known object (Sun, Moon, star, landmark): makes the current pointing equal the truth ----
    fineTune(trueAz, trueAlt) {
      if (!this.out) return null;
      const now = this.pointing();
      const dAz = wrap180(trueAz - now.az);
      this.fineAz = wrap180(this.fineAz + dAz);   // positive = rotate pointing clockwise
      this.compassFrozen = true;                  // the sky/landmark is the truth now; stop magnetic nudging
      if (trueAlt != null) this.fineAlt += trueAlt - now.alt;
      return { dAz, dAlt: trueAlt != null ? trueAlt - now.alt : 0 };
    }

    // ---- output ----
    _step(t) {
      if (this.flat) this._flatTick(t);
      const r = this.rel;
      // alpha_true = alpha_rel + delta - (declination + fine-tune)  [alpha is counter-clockwise, azimuth clockwise]
      const yaw = r.alpha + (this.delta || 0) - this.decl - this.fineAz;
      const R = mul(matFromEuler(yaw, r.beta, r.gamma), this.bias);
      const f = [-R[0][2], -R[1][2], -R[2][2]];          // back camera direction
      const u = [R[0][1], R[1][1], R[2][1]];              // top of the phone (screen up in portrait)
      // adaptive smoothing: steady when still, responsive when turning
      if (this.lastRaw) {
        const dt = Math.max(0.005, (t - this.lastRaw.t) / 1000);
        const inst = angle(f, this.lastRaw.f) / dt;
        this.rate += (inst - this.rate) * 0.2;
      }
      this.lastRaw = { f, t };
      const k = Math.max(0.08, Math.min(0.7, 0.08 + this.rate / 60));
      if (!this.out) this.out = { f, u };
      else this.out = {
        f: norm(this.out.f.map((x, i) => x + (f[i] - x) * k)),
        u: norm(this.out.u.map((x, i) => x + (u[i] - x) * k)),
      };
    }

    // pointing: true azimuth/altitude of the camera, plus the screen "up" and "right" vectors for AR drawing
    pointing() {
      if (!this.out) return null;
      let f = this.out.f, u = this.out.u;
      u = norm(u.map((x, i) => x - dot(u, f) * f[i]));
      if (this.fineAlt) {                                 // tilt correction: rotate about the camera's right axis
        const c = Math.cos(this.fineAlt * D2R), s = Math.sin(this.fineAlt * D2R);
        const f2 = f.map((x, i) => x * c + u[i] * s), u2 = u.map((x, i) => x * c - f[i] * s);
        f = norm(f2); u = norm(u2);
      }
      const right = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];   // f x u = device +x
      const a = azAlt(f);
      return { az: a.az, alt: a.alt, forward: f, up: u, right, ready: this.delta != null };
    }
  }

  const api = { Fusion, matFromEuler, eulerFromMat, azAlt, angle, circMean, wrap180, wrap360, mul, T };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Orient = api;
})(typeof window !== "undefined" ? window : globalThis);
