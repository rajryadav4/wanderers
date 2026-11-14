/* WANDERERS front end. Static: reads app/data/index.json and app/data/<id>/{target.json,explain.json}.
 * If served by server.js (local demo), "Ask WANDERERS" also takes free-text questions answered live by Claude. */
(() => {
  const $ = (id) => document.getElementById(id);
  const S = { list: [], t: null, ex: null, ch: "w2", i: 0, playing: false, timer: null, imgs: {}, live: false,
    mix: { mode: "single", a: 0, b: 0, set: new Set(), smooth: true, th: 0.6 }, lum: {}, mixOut: null, mixUrlDone: false };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- boot ----------
  fetch("data/index.json").then((r) => r.json()).then((list) => {
    S.list = list;
    renderTargets();
    const p = new URLSearchParams(location.search);
    if (p.get("ra") && p.get("dec")) { if (!coordSearch(p.get("ra"), p.get("dec"), p.get("fov"))) load(list[0].id); }   // unreadable: still show something
    else { load(p.get("target") || list[0].id, p.get("ch")); }
  }).catch(() => { $("tName").textContent = "No data yet. Run the pipeline (see README)."; });
  fetch("api/health").then((r) => { if (r.ok) { S.live = true; $("askForm").hidden = false; } }).catch(() => {});
  // "Explore any patch" live mode (web/ + backend/ on port 8001): links show only when server.js can reach it
  const liveExplore = fetch("api/live-health").then((r) => r.ok).catch(() => false);
  liveExplore.then((ok) => { $("exploreLink").hidden = !ok; });

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
    S.i = 0; S.imgs = {}; S.lum = {}; S.mixOut = null;
    $("targetList").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    $("tName").textContent = t.name;
    $("tKind").textContent = t.kind;
    const fovNow = String(Math.round(t.grid.npix * t.grid.arcsec_per_pix));
    if ([...$("fovIn").options].some((o) => o.value === fovNow)) $("fovIn").value = fovNow;
    document.querySelectorAll(".channel button").forEach((b) => {
      const has = t.frames[b.dataset.ch] && t.frames[b.dataset.ch].length;
      b.disabled = !has; b.classList.toggle("on", b.dataset.ch === S.ch); b.setAttribute("aria-checked", b.dataset.ch === S.ch);
    });
    const url = new URL(location); url.searchParams.set("target", id); ["ra", "dec", "fov"].forEach((k) => url.searchParams.delete(k));
    history.replaceState(null, "", url);
    await preload();
    setupSlider(); initMix(true); renderMeta(); setAladin(); draw(); evidence(); spectrum();
    if (MAP.ready) mapGoTo();
    $("answer").textContent = "";
  }

  function frames() { return S.t.frames[S.ch] || []; }

  // "Open this field in Aladin Lite": same centre and size as the field on screen (see aladinlink.js).
  function setAladin() {
    const a = $("aladinLink"), g = S.t.grid;
    try { a.href = AladinLink.url({ ra: g.centre_ra, dec: g.centre_dec, fovArcsec: g.npix * g.arcsec_per_pix }); a.hidden = false; }
    catch { a.hidden = true; }     // never break the page over a link
  }

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
    const mixed = !diff && S.mix.mode !== "single" && S.mixOut;
    const im = S.imgs[diff ? S.t.diff[S.ch] : f && f.png];
    if (mixed) g.drawImage(S.mixOut.canvas, 0, 0, c.width, c.height);
    else if (im) g.drawImage(im, 0, 0, c.width, c.height);
    const Y = (y) => (N - 1 - y + 0.5) * k, X = (x) => (x + 0.5) * k;   // PNGs are stored north-up (origin lower)

    if (!diff && !mixed && f && $("tGhost").checked) {
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
    const lbl = diff ? "Difference: SPHEREx 2026 − 2025 (green = now, pink = before)" : mixed ? S.mixOut.label : f ? `${f.label} · ${labelOf(S.ch)}${seen}` : "";
    $("stamp").textContent = lbl;
    $("frameLbl").textContent = mixed ? "" : f ? `${S.i + 1}/${fr.length} · ${f.year.toFixed(1)}` : "";
    document.querySelectorAll("#metaBody tr[data-i]").forEach((tr) => tr.classList.toggle("now", !diff && +tr.dataset.i === S.i));
  }

  // ---------- frame details and data flags (uses frameinfo.js) ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function renderMeta() {
    const d = FrameInfo.describe(S.t, S.ch), q = d.quality;
    const rows = d.rows.map((r, i) =>
      `<tr data-i="${i}"><th scope="row">${esc(r.label)}</th><td>${esc(r.epoch)}</td>` +
      `<td>${esc(r.source)}${r.images ? ` · ${r.images} image${r.images === 1 ? "" : "s"} stacked` : ""}</td>` +
      `<td class="m-${r.tone}">${esc(r.seen)}${r.signal ? ` · ${esc(r.signal)}` : ""}</td></tr>`).join("");
    const bar = q.pct === null ? "" : `<div class="qbar" role="img" aria-label="${q.pct}% of SPHEREx measurements flagged"><i class="q-${q.level}" style="width:${q.pct}%"></i></div>`;
    const visits = d.visits.map((v) => `<li>Visit ${v.n}: around ${esc(v.epoch)}, ${v.images} images used</li>`).join("");
    $("metaBody").innerHTML =
      `<table class="frames"><thead><tr><th>Frame</th><th>Year</th><th>Image</th><th>Object</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<h4>Data flags</h4>${bar}<p class="hint">${esc(q.text)}</p>` +
      `<p class="hint">A measurement is left out if pixels near the target are flagged for: ${esc(d.flagKinds.join(", "))}. ` +
      `This is the conservative set from the SPHEREx Explanatory Supplement. The flipbook pictures hide only broken detector pixels, so bright stars stay visible.</p>` +
      (visits ? `<h4>SPHEREx visits at this position</h4><ul class="visits">${visits}</ul>` +
        `<p class="hint">${d.visitImages} images used in all; the pipeline downloads a capped, evenly spread share of the images that overlap the target.</p>` : "");
  }
  const labelOf = (ch) => (ch === "w2" ? "4.6 µm" : "3.4 µm");

  // ---------- add / subtract frames (uses framemath.js) ----------
  // Works on the displayed (stretched) images, so it is for spotting motion, not for measuring flux.
  const HINT_SUB = "Made in your browser from the displayed images, brightness-matched first. Faint targets look noisy: raise the threshold to hide speckle. For measurements use the evidence card.";
  const HINT_ADD = "Averages the displayed images to lower noise. A moving object leaves a streak instead of a dot.";

  function lumOf(name) {
    if (S.lum[name]) return S.lum[name];
    const im = S.imgs[name]; if (!im) return null;
    const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
    const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(im, 0, 0);
    return (S.lum[name] = { w: im.width, h: im.height, v: FrameMath.lumFromRGBA(cx.getImageData(0, 0, im.width, im.height).data) });
  }
  function toCanvas(rgba, w, h) {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    return cv;
  }
  function makeSub(fr) {
    const m = S.mix, A = lumOf(fr[m.a].png), B = lumOf(fr[m.b].png);
    if (!A || !B) throw new Error("images are not loaded yet");
    if (A.w !== B.w || A.h !== B.h) throw new Error("the frames differ in size");
    const r = m.smooth ? 1 : 0;
    const { diff } = FrameMath.subtract(FrameMath.smooth(A.v, A.w, A.h, r), FrameMath.smooth(B.v, B.w, B.h, r));
    return { canvas: toCanvas(FrameMath.diffToRGBA(diff, B.v, FrameMath.autoScale(diff), m.th), A.w, A.h),
             label: `${fr[m.b].label} − ${fr[m.a].label} · ${labelOf(S.ch)} (green = now, pink = before)` };
  }
  function makeAdd(fr) {
    const ids = [...S.mix.set].sort((x, y) => x - y), L = ids.map((k) => lumOf(fr[k].png));
    if (L.some((x) => !x)) throw new Error("images are not loaded yet");
    if (L.some((x) => x.w !== L[0].w || x.h !== L[0].h)) throw new Error("the frames differ in size");
    return { canvas: toCanvas(FrameMath.grayToRGBA(FrameMath.add(L.map((x) => x.v))), L[0].w, L[0].h),
             label: `Average of ${ids.length} frames (${ids.map((k) => fr[k].label).join(", ")}) · ${labelOf(S.ch)}` };
  }

  function updateMix(redraw = true) {
    const m = S.mix, fr = frames();
    let note = "", out = null;
    try {
      if (m.mode === "sub") { if (m.a === m.b) note = "Pick two different frames."; else out = makeSub(fr); }
      else if (m.mode === "add") { if (m.set.size < 2) note = "Tick at least two frames."; else out = makeAdd(fr); }
    } catch (e) { note = `Could not combine these frames: ${e.message}.`; }
    S.mixOut = out;
    $("mixMode").value = m.mode;
    $("mixSub").hidden = m.mode !== "sub"; $("mixOpts").hidden = m.mode !== "sub"; $("mixAdd").hidden = m.mode !== "add";
    $("play").disabled = $("frame").disabled = !!out;     // the blink slider has no meaning on a combined picture
    $("mixNote").textContent = note || (m.mode === "sub" ? HINT_SUB : m.mode === "add" ? HINT_ADD : "");
    writeMixUrl();
    if (redraw) draw();
  }
  function fillMix() {
    const fr = frames(), m = S.mix, opts = fr.map((f, k) => `<option value="${k}">${f.label}</option>`).join("");
    $("mixA").innerHTML = opts; $("mixB").innerHTML = opts;
    $("mixA").value = m.a; $("mixB").value = m.b;
    $("mixChecks").innerHTML = fr.map((f, k) => `<label><input type="checkbox" value="${k}" ${m.set.has(k) ? "checked" : ""}> ${f.label}</label>`).join("");
    $("mixSmooth").checked = m.smooth; $("mixTh").value = Math.round(m.th * 100);
  }
  // Shareable links: ?mix=sub&a=0&b=3[&th=60][&sm=0]  or  ?mix=add&set=1,2,3
  function readMixUrl() {
    const p = new URLSearchParams(location.search), n = frames().length, m = S.mix;
    const idx = (v) => { const k = Number(v); return Number.isInteger(k) && k >= 0 && k < n ? k : null; };
    if (p.get("mix") === "sub" && idx(p.get("a")) !== null && idx(p.get("b")) !== null) {
      m.mode = "sub"; m.a = idx(p.get("a")); m.b = idx(p.get("b"));
      const th = Number(p.get("th")); if (th >= 0.1 && th <= 0.9) m.th = th;
      m.smooth = p.get("sm") !== "0";
    } else if (p.get("mix") === "add") {
      const set = (p.get("set") || "").split(",").map(idx).filter((k) => k !== null);
      if (set.length >= 2) { m.mode = "add"; m.set = new Set(set); }
    }
  }
  function writeMixUrl() {
    const u = new URL(location), m = S.mix;
    ["mix", "a", "b", "set", "th", "sm"].forEach((k) => u.searchParams.delete(k));
    if (m.mode === "sub") {
      u.searchParams.set("mix", "sub"); u.searchParams.set("a", m.a); u.searchParams.set("b", m.b);
      if (Math.abs(m.th - 0.6) > 0.001) u.searchParams.set("th", m.th.toFixed(2));
      if (!m.smooth) u.searchParams.set("sm", "0");
    } else if (m.mode === "add") { u.searchParams.set("mix", "add"); u.searchParams.set("set", [...m.set].sort((x, y) => x - y).join(",")); }
    history.replaceState(null, "", u);
  }
  // fresh = a new target was loaded (reset to sensible defaults); otherwise just keep choices in range.
  function initMix(fresh) {
    const fr = frames(), m = S.mix, last = Math.max(0, fr.length - 1);
    if (fresh) {
      m.mode = "single"; m.a = 0; m.b = last; m.th = 0.6; m.smooth = true;
      m.set = new Set(fr.map((f, k) => (f.mission === "SPHEREx" ? k : -1)).filter((k) => k >= 0));
      if (!S.mixUrlDone) { S.mixUrlDone = true; readMixUrl(); }   // a shared link applies once, on first load
    } else {
      m.a = Math.min(m.a, last); m.b = Math.min(m.b, last); m.set = new Set([...m.set].filter((k) => k <= last));
    }
    fillMix(); updateMix(false);
  }
  $("mixMode").onchange = (e) => { stop(); S.mix.mode = e.target.value; updateMix(); };
  $("mixA").onchange = (e) => { S.mix.a = +e.target.value; updateMix(); };
  $("mixB").onchange = (e) => { S.mix.b = +e.target.value; updateMix(); };
  $("mixChecks").onchange = () => { S.mix.set = new Set([...$("mixChecks").querySelectorAll("input:checked")].map((x) => +x.value)); updateMix(); };
  $("mixSmooth").onchange = (e) => { S.mix.smooth = e.target.checked; updateMix(); };
  $("mixTh").oninput = (e) => { S.mix.th = e.target.value / 100; updateMix(); };

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
    setupSlider(); initMix(false); renderMeta(); draw();
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
  let lastChartW = 0, chartTimer = null;
  const chartWidthNow = () => ChartLayout.chartWidth($("spec").getBoundingClientRect().width);
  window.addEventListener("resize", () => {   // rotate a phone or resize a window: redraw at the new width
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => { if (S.t && Math.abs(chartWidthNow() - lastChartW) > 8) spectrum(); }, 150);
  });
  function spectrum() {
    const svg = $("spec"), sp = S.t.spectrum.filter((p) => p.flux_mjy > 0);
    // Draw at the width the chart really has, so its labels stay a readable size on a phone.
    const W = chartWidthNow(), H = ChartLayout.chartHeight(W), L = 60, R = 20, T = 14, B = 34;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); lastChartW = W;
    const x = (l) => L + ((l - 0.75) / (5.0 - 0.75)) * (W - L - R);
    let out = "";
    const colors = { H2O: "var(--h2o)", CH4: "var(--ch4)", CO: "var(--co)", CO2: "var(--co)" };
    for (const b of S.t.bands) out += `<rect x="${x(b.lo)}" y="${T}" width="${x(b.hi) - x(b.lo)}" height="${H - T - B}" fill="${colors[b.name]}"><title>${b.name} absorption band</title></rect>`;
    // Band names across the top; names that would overlap move to a second row (see chartlayout.js).
    for (const l of ChartLayout.placeLabels(S.t.bands, x)) out += `<text x="${l.cx}" y="${T + 10 + l.row * 12}" text-anchor="middle">${l.name}</text>`;
    if (sp.length) {
      const v = sp.map((p) => Math.log10(p.flux_mjy)), lo = Math.min(...v) - 0.15, hi = Math.max(...v) + 0.15;
      const y = (f) => H - B - ((Math.log10(f) - lo) / (hi - lo)) * (H - T - B - 24);   // 24px headroom keeps the band names clear of the data
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
  $("coordForm").onsubmit = (e) => { e.preventDefault(); coordSearch($("raIn").value, $("decIn").value, $("fovIn").value); };
  function parseAngle(s, hours) {
    s = String(s).trim(); if (!s) return NaN;
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return +s;
    const m = s.replace(/[hdms:°'″"]/g, " ").trim().split(/\s+/).map(Number);
    const sign = /^-/.test(s) ? -1 : 1, v = Math.abs(m[0]) + (m[1] || 0) / 60 + (m[2] || 0) / 3600;
    return sign * v * (hours ? 15 : 1);
  }
  async function liveLookup(a, d) {
    const msg = $("coordMsg"), btn = document.querySelector("#coordForm button");
    btn.disabled = true;
    msg.textContent = `Looking up RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}° in the NASA archive…`;
    try {
      const r = await fetch("api/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ra: a, dec: d }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "lookup failed");
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const s = await (await fetch(`api/job/${j.job}`)).json();
        msg.textContent = `${s.seconds}s · ${s.log[s.log.length - 1] || "starting…"}`;
        if (s.status === "done") {
          S.list = await (await fetch("data/index.json", { cache: "no-store" })).json();
          renderTargets(); msg.textContent = "Done. Showing the new patch."; load(s.id); break;
        }
        if (s.status === "error") throw new Error(s.log.slice(-2).join(" "));
      }
    } catch (e) { msg.textContent = "Lookup failed: " + e.message; }
    finally { btn.disabled = false; }
  }

  const fovLabel = (f) => `${f / 60}′`;
  function exploreHere(a, d) {
    document.getElementById("exploreHere")?.remove();
    liveExplore.then((ok) => { if (ok) $("coordMsg").insertAdjacentHTML("afterend",
      `<p id="exploreHere" class="hint"><a href="/explore/?q=${encodeURIComponent(`${a.toFixed(5)} ${d.toFixed(5)}`)}">Explore this patch live</a></p>`); });
  }

  function coordSearch(ra, dec, fovIn) {
    const a = parseAngle(ra, /h/i.test(ra) || /:/.test(ra)), d = parseAngle(dec, false);
    if (!isFinite(a) || !isFinite(d)) { $("coordMsg").textContent = "Could not read those coordinates."; return false; }
    const fov = Number(fovIn) || 300;
    if ([...$("fovIn").options].some((o) => Number(o.value) === fov)) $("fovIn").value = String(fov);
    // nearest cached target overall, and nearest one that has the field size that was asked for
    const near = (list) => {
      let best = null, bd = 1e9;
      for (const t of list) {
        const dd = Math.hypot((t.ra - a) * Math.cos((d * Math.PI) / 180), t.dec - d) * 3600;
        if (dd < bd) { bd = dd; best = t; }
      }
      return { best, bd };
    };
    const same = near(S.list.filter((t) => (t.fov || 300) === fov)), any = near(S.list);
    if (same.best && same.bd < 600) { $("coordMsg").textContent = `Matched ${same.best.name} (${Math.round(same.bd)}″ away).`; load(same.best.id); return true; }
    exploreHere(a, d);   // live /explore/ mode (backend on :8001), shown beside the message
    if (S.live) { requestField(a, d, fov); return true; }
    else if (any.best && any.bd < 600) {   // no server to make the other size: show what is cached and say so
      $("coordMsg").textContent = `${any.best.name} is cached at ${fovLabel(any.best.fov || 300)} only. A ${fovLabel(fov)} field needs the local server (node server.js).`;
      load(any.best.id); return true;
    } else {   // static site: show the live sky map, plus how a teammate adds the field
      showMap(a, d, `RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}°`);
      $("coordMsg").textContent = `Not in the cached set yet. A teammate can add it in a few minutes: ` +
      `python pipeline/fetch.py --ra ${a.toFixed(5)} --dec ${d.toFixed(5)}${fov === 300 ? "" : ` --fov ${fov}`}, then analyze.py and evidence.py.`;
    }
    return true;   // the live sky map is showing
  }

  // ---------- live sky map (Aladin Lite + IRSA HiPS; works for any coordinates on the static site) ----------
  const HIPS = {
    spherex: "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube",
    wise: "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1",
  };
  const MAP = { ready: false, aladin: null, layers: {}, lams: [], overlay: null, cat: null, at: null };

  async function loadAladin() {
    // Aladin Lite 3.x ships as an ES module with a default export.
    if (!window.A) window.A = (await import("https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js")).default;
  }
  async function initMap() {
    if (MAP.ready) return;
    await loadAladin(); await A.init;
    const t = S.t || {};
    MAP.aladin = A.aladin("#aladin", { survey: HIPS.spherex, fov: 0.12, cooFrame: "ICRSd", showReticle: true, showLayersControl: false,
      showGotoControl: false, showFullscreenControl: true, showCooGridControl: false, showSimbadPointerControl: false,
      showProjectionControl: false, showFrame: true, showZoomControl: true,
      target: t.grid ? `${t.grid.centre_ra} ${t.grid.centre_dec}` : "0 0" });
    MAP.layers.spherex = A.imageHiPS(HIPS.spherex, { name: "SPHEREx DR1", imgFormat: "png" });
    MAP.layers.wise = A.imageHiPS(HIPS.wise, { name: "AllWISE colour", imgFormat: "jpeg" });
    MAP.aladin.setBaseImageLayer(MAP.layers.spherex);
    MAP.overlay = A.graphicOverlay({ color: "#ffb547", lineWidth: 2, lineDash: [6, 4] }); MAP.aladin.addOverlay(MAP.overlay);
    MAP.cat = A.catalog({ name: "target", sourceSize: 22, color: "#ffb547", shape: "circle" }); MAP.aladin.addCatalog(MAP.cat);
    try {   // wavelength of each of the 102 cube frames, straight from the HiPS description
      const txt = await (await fetch(HIPS.spherex + "/properties")).text();
      const m = txt.match(/data_cube_crval3_arr\s*=\s*([\d.\s]+)/);
      if (m) MAP.lams = m[1].trim().split(/\s+/).map(Number);
    } catch {}
    MAP.ready = true;
    setSlice(+$("lam").value);
  }
  function setSlice(n) {
    const lam = MAP.lams[n - 1];
    $("lamVal").textContent = lam ? `${lam.toFixed(2)} µm (band ${n} of 102)` : `band ${n} of 102`;
    try { MAP.layers.spherex.setSliceNumber(n - 1); } catch {}
  }
  function mapGoTo(ra, dec, label) {
    if (!MAP.ready) return;
    const t = S.t;
    if (ra == null && t) { ra = t.grid.centre_ra; dec = t.grid.centre_dec; label = t.name; }
    if (ra == null) return;
    MAP.aladin.gotoRaDec(ra, dec);
    MAP.overlay.removeAll(); MAP.cat.removeAll();
    const pts = t && label === t.name ? t.track.filter((p) => (p.ch || "w2") === "w2").sort((a, b) => a.year - b.year) : [];
    if (pts.length >= 2) MAP.overlay.add(A.polyline(pts.map((p) => [p.ra, p.dec])));
    const last = pts.length ? pts[pts.length - 1] : { ra, dec };
    MAP.cat.addSources([A.source(last.ra, last.dec, { name: label })]);
  }
  async function showMap(ra, dec, label) {
    selectTab("map");
    try { await initMap(); mapGoTo(ra, dec, label); } catch (e) { $("coordMsg").textContent = "Sky map unavailable: " + e.message; }
  }
  function selectTab(which) {
    const map = which === "map";
    $("flipView").hidden = map; $("mapView").hidden = !map;
    $("tabFlip").classList.toggle("on", !map); $("tabMap").classList.toggle("on", map);
    $("tabFlip").setAttribute("aria-selected", !map); $("tabMap").setAttribute("aria-selected", map);
    if (map) stop();
  }
  $("tabFlip").onclick = () => selectTab("flip");
  $("tabMap").onclick = async () => { selectTab("map"); try { await initMap(); mapGoTo(); } catch (e) { $("coordMsg").textContent = "Sky map unavailable: " + e.message; } };
  $("lam").oninput = (e) => setSlice(+e.target.value);
  $("mapSurvey").onchange = (e) => {
    if (!MAP.ready) return;
    MAP.aladin.setBaseImageLayer(MAP.layers[e.target.value]);
    $("lamWrap").hidden = e.target.value !== "spherex";
    if (e.target.value === "spherex") setSlice(+$("lam").value);
  };

  // Ask the local server to prepare a patch of sky that is not cached yet, then show it when ready.
  // Only used when server.js is running (S.live); the static site keeps the message above.
  async function requestField(a, d, fov = 300) {
    const me = (S.fieldToken = (S.fieldToken || 0) + 1);   // a newer search cancels this one
    const msg = (t) => { if (me === S.fieldToken) $("coordMsg").textContent = t; };
    const api = async (url, opt) => {
      const r = await fetch(url, opt), j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "The server could not prepare this field.");
      return j;
    };
    try {
      msg(`Preparing a ${fovLabel(fov)} patch of sky. This can take several minutes the first time${fov > 300 ? ", and a wider field takes longer" : ""}.`);
      let j = await api("api/field", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ra: a, dec: d, fov }) });
      while (j.status !== "ready" && j.status !== "done") {
        if (j.status === "error") throw new Error(j.error || "No usable data for these coordinates.");
        msg(j.stage + (j.detail ? ` · ${j.detail}` : ""));
        await new Promise((r) => setTimeout(r, 3000));
        if (me !== S.fieldToken) return;
        j = await api(`api/job?id=${encodeURIComponent(j.job)}`);
      }
      if (me !== S.fieldToken) return;
      S.list = await fetch(`data/index.json?t=${Date.now()}`).then((r) => r.json());
      renderTargets();
      msg("Ready.");
      load(j.tid);
    } catch (e) { msg(e.message); }
  }
})();
