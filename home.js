/* WANDERERS homepage. Every number and image comes from app/data (the pipeline's output); nothing is invented here.
 * Illustrations on the page are labelled as such in the HTML. */
(() => {
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const loadImg = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const num = (t, re) => ((t.evidence && t.evidence.numbers) || []).find((n) => re.test(n.label));
  const check = (t, re) => ((t.evidence && t.evidence.checks) || []).find((c) => re.test(c.text));
  const fmtDeg = (v, sign) => `${sign && v >= 0 ? "+" : ""}${v.toFixed(5)}°`;
  // PNGs are stored north-up with the origin at the lower left (same mapping as app.js)
  const toPx = (N, k) => ({ X: (x) => (x + 0.5) * k, Y: (y) => (N - 1 - y + 0.5) * k });

  /* ---------------- scroll reveals ---------------- */
  const arts = document.querySelectorAll(".concept-art");
  if (!reduce && "IntersectionObserver" in window) {
    arts.forEach((a) => a.classList.add("reveal"));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.35 });
    arts.forEach((a) => io.observe(a));
  }

  /* ---------------- hero: Barnard's Star across 16 years ---------------- */
  async function hero() {
    const t = await getJSON("data/barnard/target.json");
    const fr = t.frames.w2, N = t.grid.npix, as = t.grid.arcsec_per_pix;
    const imgs = await Promise.all(fr.map((f) => loadImg(`data/barnard/${f.png}`)));
    const c = $("heroSky"), g = c.getContext("2d"), k = c.width / N, P = toPx(N, k);
    const trk = t.track.filter((p) => (p.ch || "w2") === "w2").sort((a, b) => a.year - b.year);

    // stats
    const set = (key, v) => { const d = document.querySelector(`#heroStats [data-k="${key}"]`); if (d && v) d.textContent = v; };
    set("shift", t.motion && `${Math.round(t.motion.shift_arcsec)}″`);
    set("meas", num(t, /^measured motion/)?.value);
    set("cat", num(t, /^catalogue motion/)?.value);
    set("dist", num(t, /^distance/)?.value);
    $("heroCoords").innerHTML = [`RA ${fmtDeg(t.grid.centre_ra)}`, `Dec ${fmtDeg(t.grid.centre_dec, true)}`, `Field ${N * as}″ × ${N * as}″`,
      `${as}″ / display px`, `${fr.length} epochs · 4.6 µm`].map((s) => `<span>${s}</span>`).join("");

    // coordinate ticks around the frame: offsets from field centre, every 60″
    let ticks = "";
    for (let a = -120; a <= 120; a += 60) {
      const p = 300 + (a / as) * k, lab = a === 0 ? "0" : `${a > 0 ? "+" : "−"}${Math.abs(a / 60)}′`;
      ticks += `<line class="tick" x1="${p}" x2="${p}" y1="${600 - 10}" y2="${600 - 20}"/><text class="tickl" x="${p}" y="${600 - 26}" text-anchor="middle">${lab}</text>`;
      ticks += `<line class="tick" x1="10" x2="20" y1="${600 - p}" y2="${600 - p}"/>`;
    }
    ticks += `<text class="tickl" x="16" y="${600 - 26}">ΔRA</text><text class="tickl" x="16" y="${600 - 46}">N ↑  E ←</text>`;

    let i = reduce ? fr.length - 1 : 0, timer = null, paused = reduce;
    function draw() {
      const f = fr[i];
      g.imageSmoothingEnabled = false; g.fillStyle = "#050B14"; g.fillRect(0, 0, c.width, c.height);
      if (imgs[i]) g.drawImage(imgs[i], 0, 0, c.width, c.height);
      const seen = trk.filter((p) => p.year <= f.year + 0.002);
      let svg = ticks;
      if (seen.length > 1) svg += `<polyline class="trk" points="${seen.map((p) => `${P.X(p.x)},${P.Y(p.y)}`).join(" ")}"/>`;
      seen.forEach((p, j) => {
        const last = j === seen.length - 1, x = P.X(p.x), y = P.Y(p.y);
        svg += `<circle class="pt${last ? "" : " old"}" cx="${x}" cy="${y}" r="${last ? 4.5 : 3.2}"/>`;
        if (last) svg += `<circle class="ring" cx="${x}" cy="${y}" r="15"/>`;
      });
      // label once per distinct year so the 2025 and 2026 clusters stay legible
      const byYear = new Map(); seen.forEach((p) => byYear.set(p.mission === "WISE" ? "2010" : String(Math.floor(p.year)), p));
      byYear.forEach((p, yr) => { svg += `<text x="${P.X(p.x) + 20}" y="${P.Y(p.y) + 4}">${yr}${p.mission === "WISE" ? " · WISE" : " · SPHEREx"}</text>`; });
      $("heroOverlay").innerHTML = svg;
      $("heroStamp").textContent = `${f.label} · ${i + 1}/${fr.length}`;
    }
    function tick() { draw(); const end = i === fr.length - 1; timer = setTimeout(() => { i = (i + 1) % fr.length; tick(); }, end ? 2600 : i === 0 ? 1600 : 650); }
    const btn = $("heroPause");
    function setPaused(p) { paused = p; btn.textContent = p ? "Play" : "Pause"; btn.setAttribute("aria-pressed", p); clearTimeout(timer); if (p) draw(); else tick(); }
    btn.onclick = () => setPaused(!paused);
    setPaused(paused);
    document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(timer); else if (!paused) tick(); });
    return t;
  }

  /* ---------------- 02: compare epochs on a timeline ---------------- */
  async function compare() {
    const id = "eps_indi_b", t = await getJSON(`data/${id}/target.json`);
    const fr = t.frames.w2, N = t.grid.npix, as = t.grid.arcsec_per_pix;
    const imgs = await Promise.all(fr.map((f) => loadImg(`data/${id}/${f.png}`)));
    const trk = t.track.filter((p) => (p.ch || "w2") === "w2");
    const ref = trk.find((p) => p.mission === "WISE");
    $("tlTarget").textContent = `${t.name} · 4.6 µm · ${fr.length} epochs`;
    let sel = fr.length - 1, blink = null, showRef = false;

    function paint(cv, idx) {
      const g = cv.getContext("2d"), k = cv.width / N, P = toPx(N, k);
      g.imageSmoothingEnabled = false; g.fillStyle = "#050B14"; g.fillRect(0, 0, cv.width, cv.height);
      if (imgs[idx]) g.drawImage(imgs[idx], 0, 0, cv.width, cv.height);
      if (ref) { g.strokeStyle = "rgba(242,184,102,.95)"; g.lineWidth = 1.5; g.beginPath(); g.arc(P.X(ref.x), P.Y(ref.y), 10, 0, 2 * Math.PI); g.stroke(); }
    }
    paint($("cmpA"), 0); $("cmpALbl").textContent = fr[0].label;

    // broken time axis: the 2010 epoch on the left, then the SPHEREx years spread out
    const later = fr.filter((f) => f.mission !== "WISE").map((f) => f.year);
    const y0 = Math.floor(Math.min(...later) * 2) / 2, y1 = Math.ceil((Math.max(...later) + 0.01) * 2) / 2;
    const pos = (yr) => (yr < 2015 ? 5 : 30 + ((yr - y0) / (y1 - y0)) * 67);
    function axis() {
      const ax = $("tlAxis"), w = ax.clientWidth || 600;
      let h = `<div class="base"></div><div class="gap" style="left:12%;width:13%"><span>${Math.round(y0 - 2010.5)}-year gap</span></div>`;
      h += `<span class="yr" style="left:5%">2010</span>`;
      for (let y = y0; y <= y1 + 1e-6; y += 0.5) h += `<span class="yr" style="left:${pos(y)}%">${Number.isInteger(y) ? y : "mid " + Math.floor(y)}</span>`;
      ax.innerHTML = h;
      let lastPx = -99, stack = 0;
      fr.forEach((f, j) => {
        const pct = pos(f.year), px = (pct / 100) * w;
        stack = px - lastPx < 16 ? stack + 1 : 0; lastPx = px;
        const b = document.createElement("button");
        b.type = "button"; b.style.left = `${pct}%`; b.style.top = `${40 - stack * 17}px`;
        b.setAttribute("aria-label", `${f.label}${f.detected === false ? ", target not detected" : ""}`);
        b.setAttribute("aria-pressed", j === sel); b.title = f.label;
        b.onclick = () => choose(j);
        ax.appendChild(b);
      });
    }
    function choose(j) {
      sel = j; showRef = false;
      paint($("cmpB"), sel); $("cmpBLbl").textContent = fr[sel].label;
      $("tlAxis").querySelectorAll("button").forEach((b, n) => b.setAttribute("aria-pressed", n === sel));
      const f = fr[sel], m = trk.find((p) => Math.abs(p.year - f.year) < 0.02 && p.mission === f.mission);
      const dt = f.year - 2010.5;
      let note = `<b>${esc(f.label)}</b>`;
      if (f.mission === "WISE") note += " · the reference epoch (AllWISE coadd, treated as 2010.5)";
      else {
        note += ` · ${dt.toFixed(1)} years after WISE`;
        if (m && ref) note += ` · measured offset from 2010 position: <b>${(Math.hypot(m.x - ref.x, m.y - ref.y) * as).toFixed(0)}″</b>`;
        else note += " · position not separately measured in this frame";
        if (f.n_images) note += ` · stack of ${f.n_images} SPHEREx image${f.n_images > 1 ? "s" : ""}`;
      }
      if (f.detected === false) note += " · target not detected at this wavelength";
      $("tlNote").innerHTML = note;
    }
    axis(); choose(sel);
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { axis(); choose(sel); }, 150); });

    const bb = $("cmpBlink");
    bb.onclick = () => {
      if (blink) { clearInterval(blink); blink = null; bb.setAttribute("aria-pressed", "false"); bb.textContent = "Blink"; choose(sel); return; }
      bb.setAttribute("aria-pressed", "true"); bb.textContent = "Stop";
      const flip = () => { showRef = !showRef; paint($("cmpB"), showRef ? 0 : sel); $("cmpBLbl").textContent = fr[showRef ? 0 : sel].label; };
      flip(); blink = setInterval(flip, reduce ? 1400 : 700);
    };
  }

  /* ---------------- 03: evidence card + spectrum ---------------- */
  function evidenceCard(t) {
    const ev = t.evidence; if (!ev) return;
    $("evName").textContent = t.name;
    $("evCls").textContent = ev.classification;
    $("evConf").textContent = `${ev.status === "known" ? "Known object" : "Candidate · not a discovery"} · confidence ${ev.confidence} · ${ev.checks_passed} of ${ev.checks_needed || ev.checks.length} checks support it`;
    const icon = { ok: "✓", no: "–", warn: "!" };
    $("evChecks").innerHTML = ev.checks.slice(0, 4).map((c) => `<li><span class="${c.state}" aria-hidden="true">${icon[c.state]}</span><span>${esc(c.text)}</span></li>`).join("");
  }
  async function miniSpec() {
    const t = await getJSON("data/eps_indi_b/target.json"), sp = t.spectrum.filter((p) => p.flux_mjy > 0);
    const W = 560, H = 240, L = 54, R = 12, T = 26, B = 30, svg = $("miniSpec");
    const x = (l) => L + ((l - 0.75) / (5 - 0.75)) * (W - L - R);
    const v = sp.map((p) => Math.log10(p.flux_mjy)), lo = Math.min(...v) - 0.15, hi = Math.max(...v) + 0.15;
    const y = (f) => H - B - ((Math.log10(f) - lo) / (hi - lo)) * (H - T - B);
    const cls = { H2O: "h2o", CH4: "ch4", CO: "co", CO2: "co" };
    let o = t.bands.map((b) => `<rect class="${cls[b.name]}" x="${x(b.lo)}" y="${T}" width="${x(b.hi) - x(b.lo)}" height="${H - T - B}"><title>${b.name} band</title></rect>`).join("");
    const names = { CH4: "CH₄", H2O: "H₂O", CO2: "CO₂", CO: "CO" }, done = new Set();
    t.bands.forEach((b) => { if (b.name === "CH4" && b.lo > 3 && !done.has("m")) { done.add("m"); o += `<text x="${x((b.lo + b.hi) / 2)}" y="${T - 8}" text-anchor="middle">${names[b.name]} dip</text>`; } });
    for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) o += `<line class="ax" x1="${L}" x2="${W - R}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" opacity=".5"/><text x="${L - 6}" y="${y(10 ** e) + 3.5}" text-anchor="end">${10 ** e >= 1 ? 10 ** e : 10 ** e * 1000 + "µ"}${10 ** e >= 1 ? " mJy" : "Jy"}</text>`;
    for (let l = 1; l <= 5; l++) o += `<text x="${x(l)}" y="${H - 10}" text-anchor="middle">${l} µm</text>`;
    o += `<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
    o += `<polyline class="ln" points="${sp.map((p) => `${x(p.lam)},${y(p.flux_mjy)}`).join(" ")}"/>`;
    o += sp.map((p) => `<circle class="p" cx="${x(p.lam)}" cy="${y(p.flux_mjy)}" r="2.4"><title>${p.lam} µm: ${p.flux_mjy.toPrecision(3)} mJy (${p.n} images)</title></circle>`).join("");
    svg.innerHTML = o;
    $("specName").textContent = t.name;
    const meth = check(t, /methane/i);
    $("specCap").textContent = `${t.spectrum_points} SPHEREx measurements, ${t.flagged_points} flagged and left out. Aperture photometry, log flux.${meth ? " " + meth.text.split(":")[0] + "." : ""}`;
    svg.setAttribute("aria-label", `SPHEREx spectrum of ${t.name}, 0.75 to 5 micrometres, log flux.${meth ? " " + meth.text : ""}`);
  }

  /* ---------------- 01 facts + 04 target gallery ---------------- */
  async function targets() {
    const list = await getJSON("data/index.json");
    const ts = await Promise.all(list.map((e) => getJSON(`data/${e.id}/target.json`).catch(() => null)));
    const barn = ts[list.findIndex((e) => e.id === "barnard")], rdra = ts[list.findIndex((e) => e.id === "r_dra")];
    const mv = barn && check(barn, /^Moved/);
    if (mv) $("factMotion").textContent = `Measured · ${barn.name}: ${mv.text}`;
    const fd = rdra && check(rdra, /^(Faded|Brightened)/);
    if (fd) $("factVar").textContent = `Measured · ${rdra.name}: ${fd.text.split(" (")[0]}`;

    $("targetCards").innerHTML = list.map((e, k) => {
      const t = ts[k]; if (!t) return "";
      const fr = t.frames.w2 || t.frames.w1 || [], last = fr[fr.length - 1];
      const ev = t.evidence || {}, dist = num(t, /^distance/), mot = num(t, /^measured motion/);
      return `<li><a class="tcard" href="observatory.html?target=${encodeURIComponent(e.id)}">
        <span class="idx">${String(k + 1).padStart(2, "0")}</span>
        <span class="thumb">${last ? `<img src="data/${e.id}/${last.png}" alt="" loading="lazy" width="150" height="150">` : ""}</span>
        <span><span class="tname">${esc(t.name)}</span><span class="tkind">${esc(t.kind)}</span><span class="tcls">${esc(ev.classification || "")}</span></span>
        <dl>
          <dt>RA / Dec</dt><dd>${e.ra.toFixed(3)}° ${e.dec >= 0 ? "+" : ""}${e.dec.toFixed(3)}°</dd>
          ${dist ? `<dt>Distance</dt><dd>${esc(dist.value)}</dd>` : ""}
          ${mot ? `<dt>Motion</dt><dd>${esc(mot.value)} measured</dd>` : ""}
          <dt>Evidence</dt><dd>${ev.checks_passed ?? "–"} / ${ev.checks_needed || (ev.checks || []).length} checks · ${esc(ev.confidence || "")}</dd>
        </dl>
        <span class="go">Observe <span class="arr" aria-hidden="true">→</span></span>
      </a></li>`;
    }).join("");
  }

  hero().then(evidenceCard).catch(() => { $("heroStamp").textContent = "Data not available. Run the pipeline (see README)."; });
  compare().catch(() => { $("tlNote").textContent = "Observation data not available."; });
  miniSpec().catch(() => {});
  targets().catch(() => {});
})();
