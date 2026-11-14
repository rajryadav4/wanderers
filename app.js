/* WANDERERS front end. Static: reads app/data/index.json and app/data/<id>/{target.json,explain.json}.
 * If served by server.js (local demo), "Ask WANDERERS" also takes free-text questions answered live by Claude. */
(() => {
  const $ = (id) => document.getElementById(id);
  const S = { list: [], t: null, ex: null, ch: "w2", i: 0, playing: false, timer: null, imgs: {}, live: false };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- boot ----------
  fetch("data/index.json").then((r) => r.json()).then((list) => {
    S.list = list;
    renderTargets(); renderExamples();
    const p = new URLSearchParams(location.search);
    if (p.get("ra") && p.get("dec")) { coordSearch(p.get("ra"), p.get("dec")); }
    else { load(p.get("target") || list[0].id, p.get("ch")); }
  }).catch(() => { $("tName").textContent = "No data yet. Run the pipeline (see README)."; });
  fetch("api/health").then((r) => { if (r.ok) { S.live = true; $("askForm").hidden = false; } }).catch(() => {});

  // one-tap examples for the coordinate box (the challenge's own WISE 0855 coordinates first)
  const hms = (deg) => { const h = deg / 15, H = Math.floor(h), m = (h - H) * 60, M = Math.floor(m);
    return `${String(H).padStart(2, "0")}h${String(M).padStart(2, "0")}m${((m - M) * 60).toFixed(2).padStart(5, "0")}s`; };
  const dms = (deg) => { const a = Math.abs(deg), D = Math.floor(a), m = (a - D) * 60, M = Math.floor(m);
    return `${deg < 0 ? "-" : "+"}${String(D).padStart(2, "0")}d${String(M).padStart(2, "0")}m${((m - M) * 60).toFixed(1).padStart(4, "0")}s`; };
  function renderExamples() {
    const ex = [{ name: "WISE 0855 (from the brief)", ra: "08h55m10.831s", dec: "-07d14m42.53s" },
      ...S.list.filter((t) => t.id !== "wise0855").map((t) => ({ name: t.name, ra: hms(t.ra), dec: dms(t.dec) }))];
    $("examples").innerHTML = "Try: " + ex.map((e, i) => `<button type="button" data-i="${i}">${e.name}<span>${e.ra} ${e.dec}</span></button>`).join("");
    $("examples").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      const e = ex[+b.dataset.i]; $("raIn").value = e.ra; $("decIn").value = e.dec; $("coordForm").requestSubmit();
    }));
  }

  // search any star by name: fill the coordinates, show its facts, then go there
  StarSearch.attach($("nameIn"), $("nameList"), (st) => {
    $("raIn").value = StarSearch.hms(st.ra); $("decIn").value = StarSearch.dms(st.dec);
    const facts = st.spect || st.mag != null ? StarSearch.describe(st) : [];
    $("starCard").hidden = false;
    $("starCard").innerHTML = `<h3>${st.name}${st.wanderers ? ' <span class="hint">· WANDERERS target</span>' : ""}</h3>` +
      `<div class="alt">${st.alt.slice(0, 4).join(" · ")}</div>${facts.length ? `<ul>${facts.map((f) => `<li>${f}</li>`).join("")}</ul>` : ""}` +
      `<p class="hint">Star data: HYG database v4.0 (Hipparcos, Yale Bright Star, Gliese), CC BY-SA 4.0. ` +
      `<a href="compass.html?star=${encodeURIComponent(st.name)}">Find it with your phone →</a></p>`;
    coordSearch(String(st.ra), String(st.dec), { fromSearch: true, label: st.name });
  });

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
    S.here = { ra: t.grid.centre_ra, dec: t.grid.centre_dec, label: t.name };
    S.t = t; S.ex = ex; S.ch = ch && t.frames[ch] ? ch : (t.frames.w2 && t.frames.w2.length ? "w2" : "w1");
    S.i = 0; S.imgs = {};
    $("targetList").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    $("tName").textContent = t.name;
    $("tKind").textContent = t.kind;
    renderChannels(); renderMeta(); S.math = null; $("mOp").value = "off"; $("stackAll").setAttribute("aria-pressed", "false");
    const url = new URL(location); url.searchParams.set("target", id); url.searchParams.delete("ra"); url.searchParams.delete("dec");
    history.replaceState(null, "", url);
    await preload();
    setupSlider(); fillCompare(); draw(); evidence(); spectrum();
    if (MAP.ready) mapGoTo();
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
    const N = S.t.grid.npix, k = c.width / N, z = +$("zoom").value || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
    // zoom about the centre (digital zoom of the cached field; larger fields come from a new lookup)
    g.setTransform(z, 0, 0, z, c.width / 2 * (1 - z), c.height / 2 * (1 - z));
    const diff = $("tDiff").checked && S.t.diff[S.ch];
    const im = S.math ? S.math.canvas : S.imgs[diff ? S.t.diff[S.ch] : f && f.png];
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
    g.setTransform(1, 0, 0, 1, 0, 0);
    const seen = f && f.detected === false ? " · not detected at this wavelength" : "";
    const lbl = S.math ? S.math.label : diff ? "Difference: SPHEREx 2026 − 2025 (green = now, pink = before)" : f ? `${f.label} · ${labelOf(S.ch)}${seen}` : "";
    $("stamp").textContent = lbl;
    $("frameLbl").textContent = f ? `${S.i + 1}/${fr.length} · ${f.year.toFixed(1)}` : "";
  }
  const labelOf = (ch) => (S.t.channels && S.t.channels[ch]) || (ch === "w2" ? "4.6 µm" : "3.4 µm");

  // wavelength-matched channels + one co-added image per SPHEREx detector
  function renderChannels() {
    const chs = Object.keys(S.t.frames).filter((c) => S.t.frames[c].length);
    const main = chs.filter((c) => !c.startsWith("d")), dets = chs.filter((c) => c.startsWith("d"));
    const btn = (c) => `<button data-ch="${c}" class="${c === S.ch ? "on" : ""}" role="radio" aria-checked="${c === S.ch}" title="${labelOf(c)}">` +
      `${c.startsWith("d") ? "D" + c.slice(1) : labelOf(c)}</button>`;
    $("channels").innerHTML = main.map(btn).join("") + (dets.length ? `<span class="sep">Detector co-adds:</span>${dets.map(btn).join("")}` : "");
  }
  $("channels").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-ch]"); if (!b) return;
    S.ch = b.dataset.ch; S.i = Math.min(S.i, frames().length - 1); S.math = null; $("mOp").value = "off"; $("stackAll").setAttribute("aria-pressed", "false");
    renderChannels(); setupSlider(); fillCompare(); draw();
    const url = new URL(location); url.searchParams.set("ch", S.ch); history.replaceState(null, "", url);
  });

  // ---------- add / subtract any two epochs, or stack every SPHEREx frame ----------
  function fillCompare() {
    const opts = frames().map((f, i) => `<option value="${i}">${f.label}</option>`).join("");
    $("mA").innerHTML = opts; $("mB").innerHTML = opts;
    const firstSpx = frames().findIndex((f) => f.mission === "SPHEREx");
    $("mA").value = Math.max(0, frames().length - 1); $("mB").value = Math.max(0, firstSpx);
  }
  function pixels(png) {
    const im = S.imgs[png], N = S.t.grid.npix, cv = document.createElement("canvas"); cv.width = cv.height = N;
    const x = cv.getContext("2d"); x.drawImage(im, 0, 0, N, N); return x.getImageData(0, 0, N, N).data;
  }
  function compute(kind) {
    const fr = frames(), N = S.t.grid.npix, cv = document.createElement("canvas"); cv.width = cv.height = N;
    const x = cv.getContext("2d"), out = x.createImageData(N, N);
    if (kind === "stack") {
      const sp = fr.filter((f) => f.mission === "SPHEREx"); if (!sp.length) return null;
      const acc = new Float32Array(N * N);
      for (const f of sp) { const p = pixels(f.png); for (let i = 0; i < N * N; i++) acc[i] += p[i * 4]; }
      const max = Math.max(...acc) || 1;
      for (let i = 0; i < N * N; i++) { const v = 255 * Math.sqrt(acc[i] / max); out.data.set([v, v, v, 255], i * 4); }
      x.putImageData(out, 0, 0);
      return { canvas: cv, label: `Stack of all ${sp.length} SPHEREx frames · ${labelOf(S.ch)} (deeper image, movers smear)` };
    }
    const A = fr[+$("mA").value], B = fr[+$("mB").value]; if (!A || !B) return null;
    // put both frames on the same scale: subtract each one's background, divide by its noise (median / MAD)
    const zs = (p) => {
      const v = new Float32Array(N * N); for (let i = 0; i < N * N; i++) v[i] = p[i * 4];
      const srt = Float32Array.from(v).sort(), med = srt[srt.length >> 1];
      const dev = Float32Array.from(v, (q) => Math.abs(q - med)).sort(), mad = 1.4826 * dev[dev.length >> 1] || 1;
      return v.map((q) => (q - med) / mad);
    };
    const za = zs(pixels(A.png)), zb = zs(pixels(B.png));
    for (let i = 0; i < N * N; i++) {
      if (kind === "add") { const v = Math.max(0, Math.min(255, 30 + (za[i] + zb[i]) * 12)); out.data.set([v, v, v, 255], i * 4); continue; }
      const d = za[i] - zb[i], k = Math.min(1, Math.max(0, (Math.abs(d) - 2.5) / 6));   // only changes above 2.5 sigma
      out.data.set(d > 0 ? [20, 40 + 215 * k, 30, 255] : [40 + 215 * k, 20, 40 + 160 * k, 255], i * 4);
    }
    x.putImageData(out, 0, 0);
    return { canvas: cv, label: kind === "add" ? `${A.label} + ${B.label}` : `${A.label} − ${B.label}: significant changes only (green = brighter in A, pink = brighter in B)` };
  }
  const recompute = () => { const op = $("mOp").value; S.math = op === "off" ? null : compute(op); $("stackAll").setAttribute("aria-pressed", "false"); draw(); };
  ["mA", "mB", "mOp"].forEach((id) => ($(id).onchange = recompute));
  $("stackAll").onclick = () => {
    const on = $("stackAll").getAttribute("aria-pressed") !== "true";
    $("stackAll").setAttribute("aria-pressed", String(on)); $("mOp").value = "off";
    S.math = on ? compute("stack") : null; draw();
  };
  $("zoom").oninput = (e) => { $("zoomVal").textContent = `${e.target.value}×`; draw(); };
  $("copyLink").onclick = async () => {
    const u = new URL(location); u.searchParams.set("ch", S.ch);
    try { await navigator.clipboard.writeText(u.toString()); $("copyLink").textContent = "✓ Link copied"; }
    catch { prompt("Copy this link:", u.toString()); }
    setTimeout(() => ($("copyLink").textContent = "🔗 Copy link"), 1800);
  };
  if (new URLSearchParams(location.search).get("embed") === "1") document.body.classList.add("embed");

  // ---------- metadata: every SPHEREx image used, its wavelength at the target and contamination flags ----------
  function renderMeta() {
    const m = S.t.metadata || [];
    if (!m.length) { $("metaBox").innerHTML = "<p class='hint'>No per-image metadata for this target.</p>"; return; }
    const flagged = m.filter((r) => r.flags_at_target.length).length, counts = {};
    m.forEach((r) => r.flags_at_target.forEach((f) => (counts[f] = (counts[f] || 0) + 1)));
    $("metaBox").innerHTML = `<p class="hint">${m.length} SPHEREx images (${(S.t.fov_arcsec / 60).toFixed(1)}′ field).
      ${flagged} have flags inside the 3-pixel aperture at the target${Object.keys(counts).length ? ": " + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ×${n}`).join(", ") : ""}.
      Flags follow the SPHEREx Explanatory Supplement; flagged images are left out of the spectrum.</p>
      <div class="scroll"><table><thead><tr><th>Date (UTC)</th><th>Det.</th><th>λ at target</th><th>Flags at target</th><th>In spectrum</th></tr></thead><tbody>` +
      m.map((r) => `<tr><td>${r.date}</td><td>D${r.detector}</td><td>${r.lam_um ?? "–"} µm</td><td class="${r.flags_at_target.length ? "flag" : ""}">${r.flags_at_target.join(", ") || "none"}</td><td>${r.used_in_spectrum ? "yes" : "no"}</td></tr>`).join("") +
      "</tbody></table></div>";
  }

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
  async function liveLookup(a, d) {
    const msg = $("coordMsg"), btn = document.querySelector("#coordForm button");
    btn.disabled = true;
    msg.textContent = `Looking up RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}° in the NASA archive…`;
    try {
      const r = await fetch("api/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ra: a, dec: d, fov: +$("fovIn").value }) });
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

  function coordSearch(ra, dec, opts = {}) {
    const a = parseAngle(ra, /h/i.test(ra) || /:/.test(ra)), d = parseAngle(dec, false);
    if (!isFinite(a) || !isFinite(d)) { $("coordMsg").textContent = "Could not read those coordinates."; return; }
    S.here = { ra: a, dec: d, label: opts.label || `RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}°` };
    let best = null, bd = 1e9;
    for (const t of S.list) {
      const dd = Math.hypot((t.ra - a) * Math.cos((d * Math.PI) / 180), t.dec - d) * 3600;
      if (dd < bd) { bd = dd; best = t; }
    }
    if (best && bd < 600) {
      $("coordMsg").textContent = `Found ${best.name}, ${Math.round(bd)}″ from your coordinates (it moves, so its position changes over the years).`;
      load(best.id).then(() => { selectTab("flip"); document.querySelector(".sky").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); });
      return;
    }
    if (opts.fromSearch) {   // a star picked by name: show it instantly; the full time-lapse is an explicit choice
      showMap(a, d, "searched star");
      $("coordMsg").innerHTML = "Showing it on the live SPHEREx sky map (slide through all 102 wavelengths)." +
        (S.live ? ' <button type="button" id="mkLapse">Make a SPHEREx time-lapse (a few minutes)</button>' : "");
      if (S.live) $("mkLapse").onclick = () => liveLookup(a, d);
      return;
    }
    if (!S.live) {
      $("coordMsg").textContent = "Showing this patch on the live SPHEREx sky map. The full time-lapse and measurements run on " +
        "the WANDERERS demo server (node server.js), which fetches SPHEREx and WISE images for any coordinates in a few minutes.";
      showMap(a, d, `RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}°`);
      return;
    }
    liveLookup(a, d);
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
    for (const [k, view, tab] of [["flip", "flipView", "tabFlip"], ["map", "mapView", "tabMap"], ["webb", "webbView", "tabWebb"]]) {
      $(view).hidden = k !== which; $(tab).classList.toggle("on", k === which); $(tab).setAttribute("aria-selected", k === which);
    }
    if (which !== "flip") stop();
    if (which === "webb") showWebb();
  }

  // ---------- through Webb: match the coordinates against every public JWST frame, show its pixels ----------
  async function showWebb() {
    const h = S.here; if (!h) return;
    const head = $("webbHead"), list = $("webbFrames");
    head.textContent = "Checking every public Webb frame…"; list.innerHTML = ""; $("webbNote").textContent = "";
    let db; try { db = await Webb.load(); } catch (e) { head.textContent = "Webb frame list unavailable: " + e.message; return; }
    $("webbCount").textContent = `${db.count.toLocaleString()} frames`;
    let frames = Webb.best(Webb.framesAt(h.ra, h.dec)), centre = h;
    if (frames.length) head.innerHTML = `<b>Webb has imaged ${esc(h.label)}</b> in ${frames.length} frame${frames.length > 1 ? "s" : ""}. ` +
      `The red cross is your position, the gold outline the frame shown.`;
    else {
      const n = Webb.near(h.ra, h.dec, 5, 1)[0];
      if (!n) { head.innerHTML = `<b>Webb has not imaged this part of the sky</b> (no public Webb image within 5° of ${esc(h.label)}).`; $("webbAladin").innerHTML = ""; return; }
      frames = [n, ...Webb.best(Webb.framesAt(n.ra, n.dec)).filter((p) => p.obs !== n.obs)]; centre = n;
      head.innerHTML = `<b>Webb has not imaged ${esc(h.label)}.</b> Showing its nearest Webb frame, “${esc(n.target)}”, ${n.dist.toFixed(2)}° away.`;
    }
    const show = async (p) => {
      list.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.obs === p.obs));
      const d = Webb.describe(p);
      $("webbNote").innerHTML = `<b>${esc(d.title)}</b><br>${esc(d.line)}` + ({ preview: "<br>Showing Webb's own image of this frame (MAST preview, placed on the sky with its WCS).",
        live: "<br>Showing ESA ESASky's live Webb map: scroll to zoom in for full resolution.",
        outline: "<br>No Webb pixels can be streamed for this frame yet, so the gold outline shows exactly where Webb looked. Open the full Webb image below." })[Webb.source(p)] +
        `<span class="webb-links"><a href="${Webb.full(p)}" target="_blank" rel="noopener">Full Webb image (large) ↗</a>` +
        `<a href="${Webb.progUrl(p)}" target="_blank" rel="noopener">Programme ${esc(p.pid)} at STScI ↗</a></span>`;
      try {
        await Webb.render($("webbAladin"), centre === h ? h.ra : p.ra, centre === h ? h.dec : p.dec, [p, ...frames.filter((x) => x !== p)],
          { label: h.label, mark: { ra: h.ra, dec: h.dec }, base: $("webbBase").value, webbOpacity: +$("webbOp").value });
      } catch (e) { $("webbNote").textContent = "Sky viewer could not load: " + e.message; }
    };
    list.innerHTML = frames.slice(0, 12).map((p) => { const d = Webb.describe(p);
      return `<button data-obs="${esc(p.obs)}"><img loading="lazy" alt="" src="${Webb.thumb(p)}"><div>${esc(d.title)}<span>${esc(d.line)}</span></div></button>`; }).join("");
    list.querySelectorAll("button").forEach((b) => (b.onclick = () => show(frames.find((p) => p.obs === b.dataset.obs))));
    show(frames[0]);
  }
  const esc = (t) => Webb.esc(t);
  $("tabWebb").onclick = () => selectTab("webb");
  $("webbOp").oninput = (e) => Webb.setOpacity(+e.target.value);
  $("webbBase").onchange = (e) => Webb.setBase(e.target.value);
  $("tabFlip").onclick = () => selectTab("flip");
  $("tabMap").onclick = async () => { selectTab("map"); try { await initMap(); mapGoTo(); } catch (e) { $("coordMsg").textContent = "Sky map unavailable: " + e.message; } };
  $("lam").oninput = (e) => setSlice(+e.target.value);
  $("mapSurvey").onchange = (e) => {
    if (!MAP.ready) return;
    MAP.aladin.setBaseImageLayer(MAP.layers[e.target.value]);
    $("lamWrap").hidden = e.target.value !== "spherex";
    if (e.target.value === "spherex") setSlice(+$("lam").value);
  };
})();
