/* WANDERERS front end. Static: reads app/data/index.json and app/data/<id>/{target.json,explain.json}.
 * If served by server.js (local demo), "Ask WANDERERS" also takes free-text questions answered live by Claude. */
(() => {
  const $ = (id) => document.getElementById(id);
  const S = { list: [], t: null, ex: null, ch: "w2", i: 0, playing: false, timer: null, imgs: {}, live: false };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- boot ----------
  fetch("data/index.json").then((r) => r.json()).then((list) => {
    S.list = list;
    renderTargets();
    const p = new URLSearchParams(location.search);
    if (p.get("ra") && p.get("dec")) { coordSearch(p.get("ra"), p.get("dec")); }
    else { load(p.get("target") || list[0].id, p.get("ch")); }
  }).catch(() => { $("tName").textContent = "No data yet. Run the pipeline (see README)."; });
  fetch("api/health").then((r) => { if (r.ok) { S.live = true; $("askForm").hidden = false; } }).catch(() => {});

  function renderTargets() {
    $("targetList").innerHTML = S.list.map((t, k) =>
      `<li><button data-id="${t.id}"><span class="lvl">${k + 1}</span><span>${t.name}</span><span class="sub">${t.teaser}</span></button></li>`).join("");
    $("targetList").querySelectorAll("button").forEach((b) => b.onclick = () => load(b.dataset.id));
  }

  async function load(id, ch) {
    stop();
    const [t, ex] = await Promise.all([
      fetch(`data/${id}/target.json`).then((r) => r.json()),
      fetch(`data/${id}/explain.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    S.t = t; S.ex = ex; S.ch = ch && t.frames[ch] ? ch : (t.frames.w2 && t.frames.w2.length ? "w2" : "w1");
    S.i = 0; S.imgs = {};
    $("targetList").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    $("tName").textContent = t.name;
    $("tKind").textContent = t.kind;
    document.querySelectorAll(".channel button").forEach((b) => {
      const has = t.frames[b.dataset.ch] && t.frames[b.dataset.ch].length;
      b.disabled = !has; b.classList.toggle("on", b.dataset.ch === S.ch); b.setAttribute("aria-checked", b.dataset.ch === S.ch);
    });
    const url = new URL(location); url.searchParams.set("target", id); url.searchParams.delete("ra"); url.searchParams.delete("dec");
    history.replaceState(null, "", url);
    await preload();
    setupSlider(); draw(); evidence(); spectrum();
    $("answer").textContent = "";
  }

  function frames() { return S.t.frames[S.ch] || []; }

  function preload() {
    const jobs = [];
    for (const ch of Object.keys(S.t.frames)) {
      for (const f of S.t.frames[ch]) jobs.push(img(f.png));
      if (S.t.diff[ch]) jobs.push(img(S.t.diff[ch]));
    }
    return Promise.all(jobs);
  }
  function img(name) {
    return new Promise((res) => {
      const im = new Image(); im.onload = () => { S.imgs[name] = im; res(); }; im.onerror = res;
      im.src = `data/${S.t.id}/${name}`;
    });
  }

  // ---------- flipbook ----------
  function setupSlider() {
    const n = frames().length;
    $("frame").max = Math.max(0, n - 1); $("frame").value = S.i;
    $("scale").textContent = `${(S.t.grid.npix * S.t.grid.arcsec_per_pix / 60).toFixed(1)}′ across · north up`;
  }

  function draw() {
    const c = $("sky"), g = c.getContext("2d"), fr = frames(), f = fr[S.i];
    const N = S.t.grid.npix, k = c.width / N;
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
    const diff = $("tDiff").checked && S.t.diff[S.ch];
    const im = S.imgs[diff ? S.t.diff[S.ch] : f && f.png];
    if (im) g.drawImage(im, 0, 0, c.width, c.height);
    const Y = (y) => (N - 1 - y + 0.5) * k, X = (x) => (x + 0.5) * k;   // PNGs are stored north-up (origin lower)

    if (!diff && f && $("tGhost").checked) {
      g.strokeStyle = "rgba(124,196,255,.85)"; g.lineWidth = 1.2;
      for (const [x, y] of S.t.ghosts[f.png] || []) { g.beginPath(); g.arc(X(x), Y(y), 7, 0, 2 * Math.PI); g.stroke(); }
    }
    if ($("tTrail").checked && S.t.track.length) {
      const ch = S.t.track.filter((p) => (p.ch || "w2") === S.ch).sort((a, b) => a.year - b.year);
      g.strokeStyle = "rgba(255,181,71,.9)"; g.lineWidth = 2; g.setLineDash([6, 4]);
      g.beginPath(); ch.forEach((p, j) => (j ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke(); g.setLineDash([]);
      for (const p of ch) {
        g.fillStyle = "rgba(255,181,71,.95)"; g.beginPath(); g.arc(X(p.x), Y(p.y), 3.5, 0, 2 * Math.PI); g.fill();
        g.fillStyle = "#ffe2b0"; g.font = "12px ui-monospace, monospace"; g.fillText(p.mission === "WISE" ? "2010" : Math.floor(p.year), X(p.x) + 8, Y(p.y) - 6);
      }
    }
    const seen = f && f.detected === false ? " · not detected at this wavelength" : "";
    const lbl = diff ? "Difference: SPHEREx 2026 − 2025 (green = now, pink = before)" : f ? `${f.label} · ${labelOf(S.ch)}${seen}` : "";
    $("stamp").textContent = lbl;
    $("frameLbl").textContent = f ? `${S.i + 1}/${fr.length} · ${f.year.toFixed(1)}` : "";
  }
  const labelOf = (ch) => (ch === "w2" ? "4.6 µm" : "3.4 µm");

  function step() { const n = frames().length; if (!n) return; S.i = (S.i + 1) % n; $("frame").value = S.i; draw(); }
  function play() {
    if (S.playing) return stop();
    S.playing = true; $("play").textContent = "❚❚ Pause";
    S.timer = setInterval(step, reduceMotion ? 1500 : 600);
  }
  function stop() { S.playing = false; clearInterval(S.timer); $("play").textContent = "▶ Blink"; }

  $("play").onclick = play;
  $("frame").oninput = (e) => { stop(); S.i = +e.target.value; draw(); };
  ["tGhost", "tTrail", "tDiff"].forEach((id) => ($(id).onchange = draw));
  document.querySelectorAll(".channel button").forEach((b) => (b.onclick = () => {
    S.ch = b.dataset.ch; S.i = Math.min(S.i, frames().length - 1);
    document.querySelectorAll(".channel button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    setupSlider(); draw();
    const url = new URL(location); url.searchParams.set("ch", S.ch); history.replaceState(null, "", url);
  }));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); play(); }
    if (e.key === "ArrowRight") { stop(); step(); }
    if (e.key === "ArrowLeft") { stop(); const n = frames().length; S.i = (S.i - 1 + n) % n; $("frame").value = S.i; draw(); }
  });

  // ---------- evidence ----------
  function evidence() {
    const ev = S.t.evidence;
    if (!ev) { $("verdict").innerHTML = ""; $("checks").innerHTML = ""; return; }
    $("verdict").className = `verdict ${ev.status}`;
    $("verdict").innerHTML = `<div class="status">${ev.status === "known" ? "KNOWN OBJECT" : "CANDIDATE · NOT A DISCOVERY"}</div>
      <div class="cls">${ev.classification}</div>
      <div class="conf">Confidence: <b>${ev.confidence}</b> · ${ev.checks_passed} of ${ev.checks_needed || ev.checks.length} key checks support it${ev.confidence_note ? ` · ${ev.confidence_note}` : ""}</div>`;
    const icon = { ok: "✓", no: "–", warn: "!" };
    $("checks").innerHTML = ev.checks.map((c) => `<li><span class="${c.state}">${icon[c.state]}</span><span>${c.text}</span></li>`).join("");
    $("numbers").innerHTML = (ev.numbers || []).map((n) => `<div><b>${n.value}</b><span>${n.label}</span></div>`).join("");
    $("explain").textContent = S.ex ? S.ex.summary : "Explanation not generated yet (run pipeline/explain.py).";
    $("qButtons").innerHTML = S.ex && S.ex.qa ? S.ex.qa.map((q, k) => `<button data-k="${k}">${q.q}</button>`).join("") : "";
    $("qButtons").querySelectorAll("button").forEach((b) => (b.onclick = () => ($("answer").textContent = S.ex.qa[+b.dataset.k].a)));
  }

  $("askForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("askIn").value.trim(); if (!q) return;
    $("answer").textContent = "Thinking…";
    try {
      const r = await fetch("api/ask", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: S.t.id, question: q }) });
      const j = await r.json(); $("answer").textContent = j.answer || j.error;
    } catch { $("answer").textContent = "Live questions need the local server (node server.js)."; }
  };

  // ---------- spectrum ----------
  function spectrum() {
    const svg = $("spec"), sp = S.t.spectrum.filter((p) => p.flux_mjy > 0);
    const W = 900, H = 260, L = 60, R = 20, T = 14, B = 34;
    const x = (l) => L + ((l - 0.75) / (5.0 - 0.75)) * (W - L - R);
    let out = "";
    const colors = { H2O: "var(--h2o)", CH4: "var(--ch4)", CO: "var(--co)", CO2: "var(--co)" };
    for (const b of S.t.bands) out += `<rect x="${x(b.lo)}" y="${T}" width="${x(b.hi) - x(b.lo)}" height="${H - T - B}" fill="${colors[b.name]}"><title>${b.name} absorption band</title></rect>`;
    for (const b of S.t.bands) out += `<text x="${(x(b.lo) + x(b.hi)) / 2}" y="${T + 10}" text-anchor="middle">${b.name.replace("2", "₂").replace("4", "₄")}</text>`;
    if (sp.length) {
      const v = sp.map((p) => Math.log10(p.flux_mjy)), lo = Math.min(...v) - 0.15, hi = Math.max(...v) + 0.15;
      const y = (f) => H - B - ((Math.log10(f) - lo) / (hi - lo)) * (H - T - B);
      out += `<polyline class="line" points="${sp.map((p) => `${x(p.lam)},${y(p.flux_mjy)}`).join(" ")}"/>`;
      out += sp.map((p) => `<circle class="pt" cx="${x(p.lam)}" cy="${y(p.flux_mjy)}" r="3"><title>${p.lam} µm: ${p.flux_mjy.toPrecision(3)} mJy (${p.n} images)</title></circle>`).join("");
      for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) out += `<text x="${L - 8}" y="${y(10 ** e) + 4}" text-anchor="end">${fmtFlux(10 ** e)}</text><line class="axis" x1="${L}" x2="${W - R}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" opacity=".35"/>`;
    }
    for (let l = 1; l <= 5; l++) out += `<text x="${x(l)}" y="${H - 12}" text-anchor="middle">${l} µm</text>`;
    out += `<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
    svg.innerHTML = out;
    const fl = S.t.flagged_points, tot = S.t.spectrum_points;
    $("specNote").textContent = sp.length
      ? `${tot} SPHEREx measurements, ${fl} left out because the pipeline flagged pixels in the aperture${fl > tot / 2 ? " (this object is bright enough to saturate SPHEREx at many wavelengths)" : ""}. Flux is aperture photometry, log scale.`
      : "Not enough unflagged SPHEREx measurements for a spectrum.";
  }
  const fmtFlux = (f) => (f >= 1000 ? `${f / 1000} Jy` : f >= 1 ? `${f} mJy` : `${f * 1000} µJy`);

  // ---------- coordinates ----------
  $("coordForm").onsubmit = (e) => { e.preventDefault(); coordSearch($("raIn").value, $("decIn").value); };
  function parseAngle(s, hours) {
    s = String(s).trim(); if (!s) return NaN;
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return +s;
    const m = s.replace(/[hdms:°'″"]/g, " ").trim().split(/\s+/).map(Number);
    const sign = /^-/.test(s) ? -1 : 1, v = Math.abs(m[0]) + (m[1] || 0) / 60 + (m[2] || 0) / 3600;
    return sign * v * (hours ? 15 : 1);
  }
  function coordSearch(ra, dec) {
    const a = parseAngle(ra, /h/i.test(ra) || /:/.test(ra)), d = parseAngle(dec, false);
    if (!isFinite(a) || !isFinite(d)) { $("coordMsg").textContent = "Could not read those coordinates."; return; }
    let best = null, bd = 1e9;
    for (const t of S.list) {
      const dd = Math.hypot((t.ra - a) * Math.cos((d * Math.PI) / 180), t.dec - d) * 3600;
      if (dd < bd) { bd = dd; best = t; }
    }
    if (best && bd < 600) { $("coordMsg").textContent = `Matched ${best.name} (${Math.round(bd)}″ away).`; load(best.id); }
    else $("coordMsg").textContent = `Not in the cached set yet. A teammate can add it in a few minutes: ` +
      `python pipeline/fetch.py --ra ${a.toFixed(5)} --dec ${d.toFixed(5)}, then analyze.py and evidence.py.`;
  }
})();
