/* PathView: the path a star has taken and the path it will take, for every WANDERERS result
 * (a prepared target, a star found by name, a star picked in the Sky Compass).
 *
 * Model (by the team's star-path work, reused as is):
 *   - learnt path: scikit-learn HuberRegressor fitted to every catalogue position of the star since ~1950
 *     (pipeline/star_ml.py -> app/data/stars/pred/<key>.json), with its 68% uncertainty;
 *   - otherwise the catalogue motion (Gaia DR3 or HYG) through StarCore.startState;
 *   - long range: StarCore (straight line through 3D space; the sky track curves, the star speeds up
 *     as it approaches). Without a known distance only the short, straight-on-the-sky path is drawn.
 * Needs starcore.js. Works in the console and the Sky Compass (window.PathView). */
(function (root) {
  "use strict";
  const LY_PER_PC = 3.261563777, MOON = 1866;   // the Moon's width in arcsec
  let PATHS = null, base = "data/";
  const preds = {};
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const yr = (y) => (y <= 0 ? `${Math.round(1 - y).toLocaleString()} BCE` : Math.round(y).toLocaleString().replace(/,/g, y < 10000 ? "" : ","));
  const ang = (as) => (as < 60 ? `${as.toFixed(1)}″` : as < 3600 ? `${(as / 60).toFixed(1)}′` : `${(as / 3600).toFixed(1)}°`);
  const nice = (v) => [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].find((n) => n >= v) || 100000;

  function load(b = "data/") {
    base = b;
    if (PATHS) return Promise.resolve(PATHS);
    return fetch(base + "paths.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((j) => (PATHS = j));
  }
  function pred(key) {
    if (!key) return Promise.resolve(null);
    if (!preds[key]) preds[key] = fetch(`${base}stars/pred/${encodeURIComponent(key)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return preds[key];
  }

  /* q = {target: "<id>"} for a prepared target, or {star: <StarSearch star>} for a star found by name. */
  async function model(q) {
    await load(base);
    let key, row, name;
    if (q.target && PATHS[q.target]) {
      const p = PATHS[q.target], s = p.state;
      key = p.key; name = p.name;
      row = { name, ra: s.ra, dec: s.dec, epoch: s.epoch, pmra: s.pmra, pmdec: s.pmdec, dist_pc: s.plx ? 1000 / s.plx : null, rv: s.rv, src: s.source };
    } else if (q.star && q.star.pmra != null) {
      const s = q.star;
      key = s.key; name = s.name;
      row = { name, ra: s.ra, dec: s.dec, epoch: 2000, pmra: s.pmra, pmdec: s.pmdec, dist_pc: s.dist ? s.dist / LY_PER_PC : null, rv: s.rv, src: "HYG catalogue" };
    } else return null;
    const p = await pred(key);
    const st = root.StarCore.startState(p, row);
    const now = 1970 + Date.now() / 31557600000;   // decimal year now
    return { name, key, pred: p, row, star: st.star, err: st.err, sources: st.sources || {}, warnings: st.warnings || [], learnt: !!p, now };
  }

  // positions (ra, dec) on the sky at each year: learnt rows, else StarCore, else straight on the sky
  function near(m) {
    if (m.pred) return m.pred.path.rows.map((r) => ({ year: r[0], ra: r[1], dec: r[2], unc: r[5] }));
    const out = [];
    for (let y = 1900; y <= 2100; y += 5) {
      if (m.star) { const p = root.StarCore.propagate(m.star, y); out.push({ year: y, ra: p.ra, dec: p.dec }); }
      else {
        const r = m.row, c = Math.cos(r.dec * Math.PI / 180), dt = y - r.epoch;
        out.push({ year: y, ra: r.ra + r.pmra * dt / 3.6e6 / c, dec: r.dec + r.pmdec * dt / 3.6e6 });
      }
    }
    return out;
  }

  // one sky chart (orthographic, north up, east left): past solid, future dashed, labelled years
  function chart(pts, nowYear, opts) {
    const W = 320, H = 230, pad = 26, SC = root.StarCore;
    const nowP = pts.reduce((b, p) => (Math.abs(p.year - nowYear) < Math.abs(b.year - nowYear) ? p : b));
    const xy = pts.map((p) => ({ ...p, ...SC.ortho(p.ra, p.dec, nowP.ra, nowP.dec) }));
    const span = Math.max(1e-9, ...xy.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
    const k = Math.min((W / 2 - pad) / span, (H / 2 - pad) / span);
    const X = (p) => W / 2 + p.x * k, Y = (p) => H / 2 - p.y * k;
    const line = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)} ${Y(p).toFixed(1)}`).join("");
    const past = xy.filter((p) => p.year <= nowYear), fut = xy.filter((p) => p.year >= nowYear);
    const band = xy.filter((p, i) => p.unc && i % Math.max(1, Math.floor(xy.length / 24)) === 0)
      .map((p) => `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${Math.max(1.5, p.unc / 3600 * k).toFixed(1)}" class="pv-band"/>`).join("");
    const marks = opts.marks.map((y) => xy.reduce((b, p) => (Math.abs(p.year - y) < Math.abs(b.year - y) ? p : b)))
      .map((p) => `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="3" class="pv-mark"/><text x="${(X(p) + 6).toFixed(1)}" y="${(Y(p) - 6).toFixed(1)}" class="pv-yr">${esc(yr(p.year))}</text>`).join("");
    const scaleAs = span * 3600, bar = Math.min(W / 2 - pad, span * k);
    return `<svg viewBox="0 0 ${W} ${H}" class="pv-chart" role="img" aria-label="${esc(opts.title)}">
      <text x="8" y="16" class="pv-title">${esc(opts.title)}</text>
      <text x="${W - 8}" y="16" text-anchor="end" class="pv-dim">N ↑ E ←</text>
      ${band}<path d="${line(past)}" class="pv-past"/><path d="${line(fut)}" class="pv-future"/>${marks}
      <circle cx="${X(xy.find((p) => p.year === nowP.year)).toFixed(1)}" cy="${Y(xy.find((p) => p.year === nowP.year)).toFixed(1)}" r="5" class="pv-now"/>
      <line x1="10" x2="${(10 + bar).toFixed(1)}" y1="${H - 10}" y2="${H - 10}" class="pv-axis"/>
      <text x="${(14 + bar).toFixed(1)}" y="${H - 6}" class="pv-dim">${esc(ang(scaleAs))}</text></svg>`;
  }

  /* Draw into `el`. Returns the model (or null when no motion is known). */
  async function render(el, q, opts = {}) {
    el.innerHTML = `<p class="pv-dim">Working out its path…</p>`;
    let m;
    try { m = await model(q); } catch (e) { m = null; }
    if (!m) { el.innerHTML = `<p class="pv-dim">No motion is known for this position, so no path can be drawn.</p>`; return null; }
    const N = near(m), SC = root.StarCore;
    const speed = Math.hypot(m.star ? m.star.pmra : m.row.pmra, m.star ? m.star.pmdec : m.row.pmdec) / 1000;   // arcsec per year
    const at = (y) => N.reduce((b, p) => (Math.abs(p.year - y) < Math.abs(b.year - y) ? p : b));
    const sep = (a, b) => SC.separationArcsec(a, b);
    const nowP = at(m.now), p1900 = at(1900), p2100 = at(2100);
    let html = `<div class="pv-charts">` + chart(N, m.now, { title: m.learnt ? "1900 → 2100 · learnt path" : "1900 → 2100", marks: [1900, 1950, 2050, 2100] });
    let longTxt = "";
    if (m.star && speed > 0) {
      const half = nice(36000 / speed);                                   // about 10 degrees each way, rounded
      const far = SC.track(m.star, m.now - half, m.now + half, 240);
      html += chart(far, m.now, { title: `±${half.toLocaleString()} years`, marks: [m.now - half, m.now - half / 2, m.now + half / 2, m.now + half] });
      const ca = SC.closestApproach(m.star), d0 = SC.propagate(m.star, m.now).distLy;
      const travel = sep(far[0], far.at(-1));
      longTxt = `<li><b>Long range:</b> over ${half.toLocaleString()} years each way it crosses ${ang(travel)} of sky, curving as its distance changes.` +
        (ca && Math.abs(ca.year - m.now) < 2e6 ? ` Closest to the Sun ${ca.year > m.now ? "in" : "was in"} ${yr(ca.year)}, at ${ca.distLy.toFixed(ca.distLy < 10 ? 2 : 1)} light-years (now ${d0.toFixed(d0 < 10 ? 2 : 1)}).` : "") + `</li>`;
    }
    html += `</div><ul class="pv-facts">
      <li><b>Speed across the sky:</b> ${speed < 1 ? `${(speed * 1000).toFixed(speed < 0.01 ? 1 : 0)} milliarcseconds` : ang(speed)} a year${speed > 0.05 ? `, a Moon-width every ${Math.round(MOON / speed).toLocaleString()} years` : ""}.</li>
      <li><b>Path taken:</b> since 1900 it has moved ${ang(sep(p1900, nowP))}.</li>
      <li><b>Path ahead:</b> by 2100 it will have moved another ${ang(sep(nowP, p2100))}${N.at(-1).unc ? ` (±${ang(N.at(-1).unc)} at 68%)` : ""}.</li>
      ${longTxt}</ul>`;
    if (m.learnt) {
      const obs = [...new Map((m.pred.observations || []).map((o) => [`${o.catalogue}@${o.epoch}`, o])).values()], ys = obs.map((o) => o.epoch || o.year).filter(Number.isFinite), h = m.pred.holdout_gaia;
      html += `<p class="pv-src"><span class="pv-tag">ML</span> Path learnt with scikit-learn (${esc(m.pred.model.estimator.split(" (")[0])}) from ${obs.length} catalogue positions` +
        (ys.length ? ` taken ${Math.round(Math.min(...ys))}–${Math.round(Math.max(...ys))}` : "") +
        (h && h.miss_mas != null ? `. Trained without Gaia, it predicted Gaia's 2016 position to ${h.miss_mas < 1000 ? `${Math.round(h.miss_mas)} mas` : ang(h.miss_mas / 1000)}.` : ".") + `</p>`;
    } else html += `<p class="pv-src"><span class="pv-tag cat">catalogue</span> From the catalogue motion (${esc(m.row.src || "HYG")}); this star's path has not been learnt by the model yet.</p>`;
    if (m.warnings.length) html += `<p class="pv-dim">${m.warnings.map(esc).join(" ")}</p>`;
    if (m.key && opts.explorer !== false) html += `<p><a class="pv-link" href="${opts.explorerHref ? opts.explorerHref(m.key) : `observatory.html?star=${encodeURIComponent(m.key)}`}">Open the full path explorer (sky globe, 3D map, distance) →</a></p>`;
    el.innerHTML = html;
    return m;
  }

  /* Sky positions for a trail (Sky Compass): from `now - half` to `now + half` years. */
  async function trail(q, n = 80) {
    const m = await model(q);
    if (!m || !m.star) return null;
    const speed = Math.hypot(m.star.pmra, m.star.pmdec) / 1000;
    if (!(speed > 0)) return null;
    const half = nice(36000 / speed);
    return { half, now: m.now, pts: root.StarCore.track(m.star, m.now - half, m.now + half, n).map((p) => ({ year: p.year, ra: p.ra, dec: p.dec })) };
  }

  /* The 1900-2100 path on the sky, for drawing over a map: {now, learnt, pts:[{year, ra, dec}]} or null. */
  async function sky(q) {
    const m = await model(q);
    if (!m) return null;
    return { now: m.now, learnt: m.learnt, name: m.name, pts: near(m).map((p) => ({ year: p.year, ra: p.ra, dec: p.dec })) };
  }

  root.PathView = { load, model, render, trail, sky };
})(typeof window !== "undefined" ? window : globalThis);
