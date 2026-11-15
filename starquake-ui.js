/* "Hear its starquakes" widget. Mounted under a star's details (Star database tab) and in the spectrum panel
 * for the selected target. Plays either a real Kepler recording (pipeline/starquake.py) or the model
 * (starquake.js), always labelled measured / published / predicted, with the Sun and four real stars to compare.
 */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const Q = window.Starquake;
  let INFO = null, MODEL = null, ctx = null, playing = null, uid = 0;
  const COMPARE = ["kic8006161", "sun", "kic6106415", "kic12258514", "kic3632418"];   // shown sorted by pitch

  const loadInfo = () => INFO ? Promise.resolve(INFO) : fetch("data/starquake_stars.json").then((r) => r.json()).then((j) => (INFO = j));
  const loadModels = () => MODEL ? Promise.resolve(MODEL) : fetch("data/starquake/model/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []).then((j) => (MODEL = new Set(j)));

  // Our WAVs are plain 16-bit mono PCM: parse them directly (no decodeAudioData, which is fussy on iOS Safari).
  async function wavSamples(url) {
    const b = await (await fetch(url)).arrayBuffer(), v = new DataView(b), fs = v.getUint32(24, true);
    let off = 12; while (off < b.byteLength - 8 && String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3)) !== "data") off += 8 + v.getUint32(off + 4, true);
    const n = v.getUint32(off + 4, true) / 2, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = v.getInt16(off + 8 + 2 * i, true) / 32768;
    return { samples: x, fs };
  }

  // Waveform (min/max per pixel) with a playhead while playing.
  function drawWave(cv, snd, t) {
    if (!cv || !snd) return;
    const r = window.devicePixelRatio || 1, w = cv.clientWidth || 300, h = 46;
    if (cv.width !== Math.round(w * r)) { cv.width = Math.round(w * r); cv.height = h * r; cv.style.height = h + "px"; }
    const g = cv.getContext("2d"), x = snd.samples, per = Math.max(1, Math.floor(x.length / w)), css = getComputedStyle(cv);
    g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
    g.fillStyle = css.getPropertyValue("--accent").trim() || "#7cc4ff";
    for (let i = 0; i < w; i++) {
      let lo = 0, hi = 0; for (let j = i * per; j < Math.min(x.length, (i + 1) * per); j++) { const v = x[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(i, h / 2 - hi * h / 2, 1, Math.max(1, (hi - lo) * h / 2));
    }
    if (t != null) { g.fillStyle = "#ff7bd5"; g.fillRect(Math.min(w - 2, t / (x.length / snd.fs) * w), 0, 2, h); }
  }
  const audio = () => (ctx = ctx || new (window.AudioContext || window.webkitAudioContext)());

  function stop() {
    if (!playing) return;
    try { playing.src.stop(); } catch { /* already ended */ }
    playing.btn.textContent = playing.label; playing.btn.setAttribute("aria-pressed", "false"); playing = null;
  }

  // getSound: async () => {samples, fs}; wave: optional canvas to animate a playhead on
  async function play(btn, getSound, wave) {
    const was = playing && playing.btn === btn;
    stop();
    if (was) return;                                     // second click on the same button stops it
    const label = btn.textContent;
    btn.textContent = "… preparing"; btn.disabled = true;
    try {
      const ac = audio();                                // created inside the tap, so iOS allows sound
      if (ac.state === "suspended") await ac.resume();
      const snd = await getSound();
      const buf = ac.createBuffer(1, snd.samples.length, snd.fs); buf.getChannelData(0).set(snd.samples);
      const src = ac.createBufferSource(), gain = ac.createGain(); gain.gain.value = 0.9;
      src.buffer = buf; src.connect(gain).connect(ac.destination);
      src.onended = () => { if (playing && playing.src === src) stop(); };
      const t0 = ac.currentTime; src.start();
      playing = { src, btn, label };
      btn.textContent = "■ Stop"; btn.setAttribute("aria-pressed", "true");
      if (wave) { const tick = () => { if (!playing || playing.src !== src) { drawWave(wave, snd); return; } drawWave(wave, snd, ac.currentTime - t0); requestAnimationFrame(tick); }; tick(); }
    } catch (e) {
      btn.textContent = label; btn.title = "Could not play: " + e.message;
    } finally { btn.disabled = false; }
  }

  const modelSound = (d, seed) => { const sp = Q.speedupFor(d.numax); return Q.synth(Q.modes(d), { speedup: sp.speedup, seed, fs: 8000, log2n: 17 }); };
  const fileSound = (url) => () => wavSamples(url);

  // ---- picture: the mode comb (model) or the measured power spectrum (recording) ----
  function comb(d, rec) {
    const W = 600, H = 140, L = 8, R = 8, T = 22, B = 48;
    const sig = Q.envFwhm(d.numax) / 2.355, lo = Math.max(0, d.numax - 3.3 * sig), hi = d.numax + 3.3 * sig;
    const x = (nu) => L + (nu - lo) / (hi - lo) * (W - L - R), sp = Q.speedupFor(d.numax);
    let body = "";
    if (rec && rec.spectrum) {
      const pts = rec.spectrum.nu.map((nu, i) => [nu, rec.spectrum.psd[i]]).filter(([nu]) => nu >= lo && nu <= hi);
      const top = Math.max(...pts.map((p) => p[1])) || 1;
      body = `<path class="q-psd" d="${pts.map(([nu, p], i) => `${i ? "L" : "M"}${x(nu).toFixed(1)},${(H - B - (p / top) * (H - B - T)).toFixed(1)}`).join("")}"/>`;
    } else {
      for (const m of Q.modes(d)) {
        const h = m.height / 1.5 * (H - B - T);
        body += `<line class="q-l${m.l}" x1="${x(m.nu).toFixed(1)}" x2="${x(m.nu).toFixed(1)}" y1="${H - B}" y2="${(H - B - h).toFixed(1)}"/>`;
      }
    }
    const anchor = ["start", "middle", "end"];
    const ticks = [lo, d.numax, hi].map((nu, i) => `<text x="${x(nu).toFixed(1)}" y="${H - 26}" text-anchor="${anchor[i]}">${nu < 10 ? nu.toFixed(2) : Math.round(nu)} µHz</text>` +
      `<text class="q-hz" x="${x(nu).toFixed(1)}" y="${H - 5}" text-anchor="${anchor[i]}">${(nu * 1e-6 * sp.speedup).toFixed(nu * 1e-6 * sp.speedup < 10 ? 1 : 0)} Hz heard</text>`).join("");
    const legend = rec ? `<text x="${W - R}" y="${T - 6}" text-anchor="end">measured power spectrum</text>` :
      `<text x="${W - R}" y="${T - 6}" text-anchor="end"><tspan class="q-t0">■ l=0</tspan> <tspan class="q-t1">■ l=1</tspan> <tspan class="q-t2">■ l=2</tspan> modes</text>`;
    return `<svg class="q-comb" viewBox="0 0 ${W} ${H}" role="img" aria-label="${rec ? "Measured power spectrum" : "Model mode frequencies"} around ${Math.round(d.numax)} microhertz">` +
      `<line class="q-axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>${body}${ticks}${legend}</svg>`;
  }

  const KIND = { measured: ["Measured", "data", "Real Kepler light curve, measured here"], published: ["Published", "data", "Frequencies measured by astronomers; mode pattern from theory"],
    predicted: ["Predicted", "illus", "Predicted from the star's size and temperature (scaling relations)"], none: ["No starquakes", "ai", ""] };

  // ---- mount ----
  async function mount(el, { key, row, title }) {
    if (!el) return;
    const me = ++uid; el.dataset.uid = me;
    stop();
    await Promise.all([loadInfo(), loadModels()]);
    if (el.dataset.uid !== String(me)) return;           // a newer star was chosen meanwhile
    // use the star's measured profile (Gaia / Hypatia) when the catalogue would otherwise be the only source
    const prof = window.StarProfile && StarProfile.load ? await StarProfile.load(key).catch(() => null)
      : await fetch(`data/stars/profile/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (el.dataset.uid !== String(me)) return;
    const info = Q.withProfile(INFO[key] || null, prof), d = Q.describe(info, row);
    const [chip, cls, kindText] = KIND[d.kind];
    if (d.kind === "none") {
      el.innerHTML = `<div class="quake"><h3>Starquakes <span class="tag-chip ${cls}">${chip}</span></h3><p class="hint">${esc(d.why)}</p></div>`;
      el.hidden = false; return;
    }
    const sp = Q.speedupFor(d.numax);
    const rec = info && info.recording_info ? await fetch(info.recording_info).then((r) => r.json()).catch(() => null) : null;
    const speedTxt = sp.extra === 1 ? "sped up 42,000×" : `sped up 42,000× and then ${sp.extra.toLocaleString("en-US")}× more, because at 42,000× it would be too low to hear (${(d.numax * 1e-6 * 42000).toFixed(1)} Hz)`;
    const name = esc(title || (info && info.name) || (row && row.name) || "this star");
    el.innerHTML = `<div class="quake">
      <h3>Starquakes <span class="tag-chip ${cls}">${chip}</span></h3>
      <p>Sound waves bouncing inside ${name}, ${speedTxt}: a hum near <b>${sp.hz.toFixed(sp.hz < 10 ? 1 : 0)} Hz</b> with slow beats about
        <b>${(d.dnu * 1e-6 * sp.speedup).toFixed(1)} Hz</b> apart (the spacing of its modes, set by its density). Smaller, denser stars sound higher.</p>
      <div class="q-btns">
        ${rec ? `<button type="button" class="q-rec" aria-pressed="false">▶ Real Kepler recording</button>` : ""}
        <button type="button" class="q-model" aria-pressed="false">▶ ${rec ? "Model" : "Hear its starquakes"}</button>
        ${key !== "sun" ? `<button type="button" class="q-sun" aria-pressed="false">▶ The Sun, to compare</button>` : ""}
        <button type="button" class="q-dl">↓ Download WAV</button>
      </div>
      <canvas class="q-wave" aria-hidden="true"></canvas>
      <p class="hint q-made"></p>
      ${comb(d, rec)}
      <p class="hint">${esc(kindText)}: ν<sub>max</sub> ${d.numax < 10 ? d.numax.toFixed(2) : Math.round(d.numax)} µHz, Δν ${d.dnu < 10 ? d.dnu.toFixed(2) : d.dnu.toFixed(1)} µHz${d.teff ? `, ${Math.round(d.teff).toLocaleString("en-US")} K` : ""}.
        ${rec ? `${rec.days} days of Kepler data (${esc(rec.source)}), band-passed around ν<sub>max</sub>; matches the published values to ${Math.abs(rec.agreement.dnu_pct)}% in Δν (${esc(rec.published_ref)}).` : ""}
        ${d.ref && !rec ? esc(d.ref) + "." : ""} ${d.how ? esc(d.how) + "." : ""} ${d.note ? `<b>${esc(d.note)}</b>` : ""}</p>
      <details class="q-cmp"><summary>Compare real stars, small to large</summary><div class="q-cmp-row"></div>
        <p class="hint">Four Kepler stars measured here and the Sun, all at the same 42,000×. Pitch falls as stars get bigger and less dense.</p></details>
    </div>`;
    el.hidden = false;
    const q = (s) => el.querySelector(s);
    // The model sound: pre-made for default stars; otherwise generated right now, in the browser.
    const wave = q(".q-wave");
    let modelSnd = null;
    const getModel = async () => modelSnd || (modelSnd = MODEL.has(key) ? await wavSamples(`data/starquake/model/${key}.wav`) : modelSound(d, 1));
    setTimeout(async () => {
      const t = performance.now(); const snd = await getModel(); if (el.dataset.uid !== String(me)) return;
      drawWave(wave, rec ? await wavSamples(info.recording).catch(() => snd) : snd);
      q(".q-made").textContent = rec ? "Waveform of the real Kepler recording." : MODEL.has(key) ? `Pre-made sound for ${(info && info.name) || (row && row.name) || "this star"} (model, ${snd.samples.length / snd.fs | 0} s).`
        : `Generated just now in your browser from the model (${Math.round(performance.now() - t)} ms, ${snd.samples.length / snd.fs | 0} s).`;
    }, 0);
    if (q(".q-rec")) q(".q-rec").onclick = (e) => play(e.currentTarget, fileSound(info.recording), wave);
    q(".q-model").onclick = (e) => play(e.currentTarget, getModel, rec ? null : wave);
    if (q(".q-sun")) q(".q-sun").onclick = (e) => play(e.currentTarget, async () => (MODEL.has("sun") ? wavSamples("data/starquake/model/sun.wav") : modelSound(Q.describe(INFO.sun, null), 1)));
    q(".q-dl").onclick = async () => {
      const s = await getModel();
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([Q.wav(s.samples, s.fs)], { type: "audio/wav" }));
      a.download = `starquakes-${key}.wav`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    // comparison row
    const items = COMPARE.map((k) => ({ k, i: INFO[k] })).filter((x) => x.i && x.i.numax).sort((a, b) => b.i.numax - a.i.numax);
    q(".q-cmp-row").innerHTML = items.map(({ k, i }) => `<button type="button" data-k="${esc(k)}" aria-pressed="false">▶ ${esc(i.name.replace(/ \(.*\)$/, ""))} · ${Math.round(i.numax * 1e-6 * 42000)} Hz</button>`).join("");
    q(".q-cmp-row").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      const i = INFO[b.dataset.k];
      play(b, i.recording ? fileSound(i.recording) : async () => (MODEL.has(b.dataset.k) ? wavSamples(`data/starquake/model/${b.dataset.k}.wav`) : modelSound(Q.describe(i, null), 1)));
    }));
  }

  window.StarquakeUI = { mount, stop };
})();
