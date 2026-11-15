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
    renderTargets(); renderExamples();
    const p = new URLSearchParams(location.search), want = p.get("target");
    if (p.get("ra") && p.get("dec")) { if (!coordSearch(p.get("ra"), p.get("dec"), p.get("fov"))) load(list[0].id); }   // unreadable: still show something
    else {                                                // an unknown id in a link: say so and show the first target
      const known = list.some((t) => t.id === want);
      if (want && !known) $("coordMsg").textContent = `No mission called “${want}”. Showing ${list[0].name} instead.`;
      load(known ? want : list[0].id, p.get("ch"));
    }
  }).catch(() => { $("tName").textContent = "Could not load the observatory data. Please reload the page."; });
  fetch("api/health").then((r) => { if (r.ok) { S.live = true; $("askForm").hidden = false; } }).catch(() => {});
  // "Explore any patch" live mode (web/ + backend/ on port 8001): links show only when server.js can reach it
  const liveExplore = fetch("api/live-health").then((r) => r.ok).catch(() => false);
  liveExplore.then((ok) => { $("exploreLink").hidden = !ok; });

  // one-tap examples for the coordinate box (the challenge's own WISE 0855 coordinates first)
  // rounded before splitting, so 59.996 s becomes the next minute instead of "60.00s"
  const hms = (deg) => { const c = Math.round((((deg % 360) + 360) % 360) / 15 * 360000) % 8640000;   // hundredths of a second of time
    return `${String(Math.floor(c / 360000)).padStart(2, "0")}h${String(Math.floor(c / 6000) % 60).padStart(2, "0")}m${((c % 6000) / 100).toFixed(2).padStart(5, "0")}s`; };
  const dms = (deg) => { const c = Math.round(Math.abs(deg) * 36000);   // tenths of an arcsecond
    return `${deg < 0 ? "-" : "+"}${String(Math.floor(c / 36000)).padStart(2, "0")}d${String(Math.floor(c / 600) % 60).padStart(2, "0")}m${((c % 600) / 10).toFixed(1).padStart(4, "0")}s`; };
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
    showPath({ star: st });
    coordSearch(String(st.ra), String(st.dec), { fromSearch: true, label: st.name });
  });

  function renderTargets() {
    $("targetList").innerHTML = S.list.map((t, k) =>
      `<li><button data-id="${t.id}"><span class="lvl">${k + 1}</span><span>${t.name}</span><span class="sub">${t.teaser}</span></button></li>`).join("");
    $("targetList").querySelectorAll("button").forEach((b) => b.onclick = () => openTarget(b.dataset.id));
  }
  // a mission picked from the list (or a link in the Star database): the searched star's card no longer applies
  function openTarget(id) { $("starCard").hidden = true; selectTab("flip"); load(id); }

  // Where a target is now: its newest measured position (fast movers leave the field centre behind), else the centre.
  function nowPos(t) {
    const last = [...(t.track || [])].sort((a, b) => b.year - a.year)[0];
    return last && last.ra != null ? { ra: last.ra, dec: last.dec } : { ra: t.grid.centre_ra, dec: t.grid.centre_dec };
  }

  // The subject is a searched star or typed position with no prepared time-lapse: heading, evidence and
  // spectrum say so instead of still describing the previous mission target.
  function showSubject(label, kind) {
    S.away = true;
    $("tName").textContent = label; $("tKind").textContent = kind;
    $("targetList").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    $("verdict").className = "verdict";
    $("verdict").innerHTML = `<div class="status">NOT ANALYSED</div><div class="conf">${esc(label)} has no prepared time-lapse, so there is no evidence card. ` +
      "The sky map and Through Webb tabs show it live; pick a mission for the full analysis.</div>";
    $("checks").innerHTML = ""; $("numbers").innerHTML = ""; $("insights").hidden = true; $("changes").hidden = true;
    $("explain").textContent = ""; $("qButtons").innerHTML = ""; $("answer").textContent = "";
    $("spec").innerHTML = ""; $("specNote").textContent = "No SPHEREx spectrum: this position has not been analysed."; $("targetQuake").hidden = true;
  }

  let loadSeq = 0;
  async function load(id, ch) {
    stop();
    const me = ++loadSeq;   // a newer pick wins: a slow answer for an earlier target is dropped
    const [t, ex, tr] = await Promise.all([
      fetch(`data/${id}/target.json`).then((r) => r.json()),
      fetch(`data/${id}/explain.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`data/${id}/trajectory.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),   // optional
    ]);
    if (me !== loadSeq) return;
    S.here = { ...nowPos(t), label: t.name };   // Through Webb looks where the star is now, not at the field centre
    S.t = t; S.ex = ex; S.tr = tr; S.away = false;
    $("pathNote").textContent = StarPath.summary(tr); $("pathNote").hidden = !tr;
    const hasFrames = (c) => Object.hasOwn(t.frames, c) && Array.isArray(t.frames[c]) && t.frames[c].length > 0;
    $("tPath").parentElement.hidden = !tr; S.ch = ch && hasFrames(ch) ? ch : (hasFrames("w2") ? "w2" : "w1");
    S.i = 0; S.imgs = {}; S.lum = {}; S.mixOut = null;
    $("targetList").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    $("tName").textContent = t.name;
    $("tKind").textContent = t.kind;
    const fovNow = String(Math.round(t.grid.npix * t.grid.arcsec_per_pix));
    if ([...$("fovIn").options].some((o) => o.value === fovNow)) $("fovIn").value = fovNow;
    renderChannels(); S.math = null; $("mOp").value = "off"; $("stackAll").setAttribute("aria-pressed", "false");
    const url = new URL(location); url.searchParams.set("target", id); ["ra", "dec", "fov"].forEach((k) => url.searchParams.delete(k));
    if (S.ch === ch) url.searchParams.set("ch", ch); else url.searchParams.delete("ch");   // a channel from the last target is not this one's
    history.replaceState(null, "", url);
    await preload();
    if (me !== loadSeq) return;
    if (S.pickUrlDone) { S.pick = null; const u = new URL(location); u.searchParams.delete("pick"); history.replaceState(null, "", u); }
    setupSlider(); initMix(true); renderMeta(); renderChanges(); renderMetaBox(); setAladin(); fillCompare(); draw(); evidence(); spectrum();
    showPath({ target: id });
    // starquakes for the five challenge targets (typed-in fields have no star parameters, so no widget)
    if (window.StarquakeUI) {
      Promise.all([fetch("data/starquake/targets.json").then((r) => (r.ok ? r.json() : {})), fetch("data/starquake_stars.json").then((r) => r.json()),
        fetch("data/stars/index.json").then((r) => r.json())]).then(([map, info, idx]) => {
        if (me !== loadSeq) return;
        const qk = map[id] || (id === "barnard" ? "hip87937" : "wanderers_" + id), row = idx.stars.find((s) => s.key === qk) || null;
        if (info[qk] || row) StarquakeUI.mount($("targetQuake"), { key: qk, row, title: t.name }); else $("targetQuake").hidden = true;
      }).catch(() => { $("targetQuake").hidden = true; });
    }
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
    const store = S.imgs;   // every target names its frames alike (w2_wise2010.png): a late image must not land in the next target's cache
    return new Promise((res) => {
      const im = new Image(); im.onload = () => { store[name] = im; res(); }; im.onerror = res;
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
    const mixed = !diff && !S.math && S.mix.mode !== "single" && S.mixOut;
    const im = S.math ? S.math.canvas : S.imgs[diff ? S.t.diff[S.ch] : f && f.png];
    if (mixed) g.drawImage(S.mixOut.canvas, 0, 0, c.width, c.height);
    else if (im) g.drawImage(im, 0, 0, c.width, c.height);
    const Y = (y) => (N - 1 - y + 0.5) * k, X = (x) => (x + 0.5) * k;   // PNGs are stored north-up (origin lower)

    if (!diff && !mixed && f && $("tGhost").checked) {
      g.strokeStyle = "rgba(124,196,255,.85)"; g.lineWidth = 1.2;
      for (const [x, y] of S.t.ghosts[f.png] || []) { g.beginPath(); g.arc(X(x), Y(y), 7, 0, 2 * Math.PI); g.stroke(); }
    }
    // Predicted path over the years the frames cover, and where the star should be in this frame.
    if ($("tPath").checked && S.tr) {
      const P = S.tr.path.with_parallax, yrs = frames().map((q) => q.year);
      const line = yrs.length ? StarPath.between(P, Math.min(...yrs), Math.max(...yrs)) : [];
      g.strokeStyle = "rgba(126,231,135,.75)"; g.lineWidth = 1.5;
      g.beginPath(); line.forEach((p, j) => (j ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke();
      // Forecast beyond the newest frame, dotted, to the end of the computed path.
      const last = P[P.length - 1], ahead = yrs.length ? StarPath.between(P, Math.max(...yrs), last[0]) : [];
      if (ahead.length > 1) {
        g.setLineDash([2, 5]); g.beginPath(); ahead.forEach((p, j) => (j ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke(); g.setLineDash([]);
        const e = ahead[ahead.length - 1];
        if (e.x >= 0 && e.x < N && e.y >= 0 && e.y < N) { g.fillStyle = "#b9f5c0"; g.font = "12px ui-monospace, monospace"; g.fillText(`${Math.round(last[0])}?`, X(e.x) + 8, Y(e.y) + 4); }
      }
      const here = !diff && !mixed && f && StarPath.at(P, f.year);
      if (here) {                                   // open crosshair, so the star itself stays visible
        const cx = X(here.x), cy = Y(here.y);
        g.beginPath();
        for (const [a, b] of [[-14, -6], [6, 14]]) { g.moveTo(cx + a, cy); g.lineTo(cx + b, cy); g.moveTo(cx, cy + a); g.lineTo(cx, cy + b); }
        g.stroke();
      }
    }
    if ($("tTrail").checked && S.t.track.length) {
      const ch = S.t.track.filter((p) => (p.ch || "w2") === S.ch).sort((a, b) => a.year - b.year);
      g.strokeStyle = "rgba(255,181,71,.9)"; g.lineWidth = 2; g.setLineDash([6, 4]);
      g.beginPath(); ch.forEach((p, j) => (j ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke(); g.setLineDash([]);
      // label the years sparsely: with NEOWISE there is a dot every six months, so a label on each would smear
      let lastLbl = null;
      ch.forEach((p, j) => {
        g.fillStyle = "rgba(255,181,71,.95)"; g.beginPath(); g.arc(X(p.x), Y(p.y), 3.5, 0, 2 * Math.PI); g.fill();
        const yr = p.mission === "WISE" ? 2010 : Math.floor(p.year), far = !lastLbl || Math.hypot(X(p.x) - lastLbl.x, Y(p.y) - lastLbl.y) > 34;
        if (j === 0 || j === ch.length - 1 || (far && yr !== (lastLbl && lastLbl.yr))) {
          g.fillStyle = "#ffe2b0"; g.font = "12px ui-monospace, monospace"; g.fillText(yr, X(p.x) + 8, Y(p.y) - 6);
          lastLbl = { x: X(p.x), y: Y(p.y), yr };
        }
      });
    }
    // A pair from the automatic mover search (pipeline/vet.py): 2010 end, arrow, SPHEREx end.
    const pk = S.pick && S.t.changes && S.t.changes.items.find((c) => c.n === S.pick);
    if (pk) {
      const col = { candidate: "#ffb547", known: "#4fd1a5", target: "#4fd1a5", rejected: "#9aa7c2" }[pk.status];
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
      g.beginPath(); g.moveTo(X(pk.x0), Y(pk.y0)); g.lineTo(X(pk.x1), Y(pk.y1)); g.stroke();
      for (const [x, y, lab] of [[pk.x0, pk.y0, "2010"], [pk.x1, pk.y1, String(Math.floor(pk.year))]]) {
        g.beginPath(); g.arc(X(x), Y(y), 11, 0, 2 * Math.PI); g.stroke();
        g.font = "12px ui-monospace, monospace"; g.fillText(lab, X(x) + 14, Y(y) + 4);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    const seen = f && f.detected === false ? " · not detected at this wavelength" : f && f.saturated_core ? " · saturated (too bright for this camera)" : "";
    const lbl = S.math ? S.math.label : diff ? "Difference: SPHEREx 2026 − 2025 (green = now, pink = before)" : mixed ? S.mixOut.label : f ? `${f.label} · ${labelOf(S.ch)}${seen}` : "";
    $("stamp").textContent = lbl;
    $("frameLbl").textContent = mixed ? "" : f ? `${S.i + 1}/${fr.length} · ${f.year.toFixed(1)}${fr.length === 1 ? " · only one frame here" : ""}` : "";
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
  // ---------- what else moved in this field (pipeline/vet.py grades the automatic mover search) ----------
  const CH_WORD = { candidate: "Unconfirmed", known: "Known object", target: "The target", rejected: "Ruled out" };
  function renderChanges() {
    const ch = S.t.changes, box = $("changes");
    box.hidden = !ch || $("flipView").hidden;          // shown with the time-lapse only
    if (!ch) return;
    const out = ch.items.filter((c) => c.status === "rejected").length, kn = ch.found - out - ch.candidates;
    const pairs = (k) => `${k} pair${k === 1 ? "" : "s"}`;
    $("chSummary").textContent = !ch.found
      ? "The search found no pair of dots that looks like a moving object here."
      : `The search proposed ${pairs(ch.found)} of dots. ${ch.candidates ? `${ch.candidates} still unexplained. ` : "None is left unexplained. "}` +
        `${kn ? `${kn} known. ` : ""}${out ? `${out} ruled out.` : ""}`;
    $("chList").innerHTML = ch.items.map((c) => {
      const co = encodeURIComponent(`${c.ra.toFixed(5)} ${c.dec >= 0 ? "+" : ""}${c.dec.toFixed(5)}`);
      return `<li class="ch-${c.status}"><button data-n="${c.n}" aria-pressed="false">Show</button>` +
        `<div><b>${CH_WORD[c.status]}</b> <span class="mono">${c.arcsec_per_yr.toFixed(2)}″/yr if real</span><br>${esc(c.reason)} ` +
        `<a href="https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${co}&Radius=30&Radius.unit=arcsec" target="_blank" rel="noopener noreferrer">SIMBAD ↗</a>` +
        (c.status === "candidate" ? ` · <a href="https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9" target="_blank" rel="noopener noreferrer">Report it ↗</a>` : "") +
        `</div></li>`;
    }).join("");
    $("chList").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      S.pick = S.pick === +b.dataset.n ? null : +b.dataset.n;
      $("chList").querySelectorAll("button").forEach((x) => { const on = +x.dataset.n === S.pick; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); });
      const u = new URL(location); if (S.pick) u.searchParams.set("pick", S.pick); else u.searchParams.delete("pick"); history.replaceState(null, "", u);
      if (S.pick && S.ch !== "w2" && S.t.frames.w2 && S.t.frames.w2.length) document.querySelector('.channel button[data-ch="w2"]').click();
      else draw();
    }));
    // Shareable: ?target=wise0855&pick=2 opens with that pair drawn.
    const want = Number(new URLSearchParams(location.search).get("pick"));
    if (!S.pickUrlDone) { S.pickUrlDone = true; const b = want && $("chList").querySelector(`button[data-n="${want}"]`); if (b) { S.pick = want; b.classList.add("on"); b.setAttribute("aria-pressed", "true"); } }
    $("chNote").textContent = (ch.target_recovered === false
      ? "The search did not find this mission's own target, so it also misses real movers. Treat an empty list as “nothing found”, not “nothing there”. " : "") +
      `${ch.method} ${ch.not_checked}`;
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
    renderChannels(); setupSlider(); initMix(false); renderMeta(); renderMetaBox(); fillCompare(); draw();
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
  function renderMetaBox() {
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
    // the blink slider has no meaning on a combined picture, nor with a single frame (D2 and D5 of some targets)
    const one = fr.length < 2, spx = fr.filter((f) => f.mission === "SPHEREx").length;
    $("play").disabled = $("frame").disabled = !!out || one;
    $("mixMode").disabled = $("mOp").disabled = $("mA").disabled = $("mB").disabled = one;
    $("stackAll").disabled = spx < 2;
    $("tDiff").disabled = !S.t.diff[S.ch];
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
    if ($("play").disabled) return;                       // one frame, or a combined picture (keyboard too)
    S.playing = true; $("play").textContent = "❚❚ Pause";
    S.timer = setInterval(step, reduceMotion ? 1500 : 600);
  }
  function stop() { S.playing = false; clearInterval(S.timer); $("play").textContent = "▶ Blink"; }

  $("play").onclick = play;
  $("frame").oninput = (e) => { stop(); S.i = +e.target.value; draw(); };
  ["tGhost", "tTrail", "tPath", "tDiff"].forEach((id) => ($(id).onchange = draw));

  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey || $("flipView").hidden) return;                   // browser shortcuts; another tab is showing
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) return;          // the control's own keys
    if (e.key === " " && el.closest && el.closest("button, a, summary")) return;              // Space presses the focused button
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
    insights();
    $("explain").textContent = S.ex ? S.ex.summary : "No written explanation for this target yet.";
    $("qButtons").innerHTML = S.ex && S.ex.qa ? S.ex.qa.map((q, k) => `<button data-k="${k}">${q.q}</button>`).join("") : "";
    $("qButtons").querySelectorAll("button").forEach((b) => (b.onclick = () => ($("answer").textContent = S.ex.qa[+b.dataset.k].a)));
  }

  // ---------- insights: what the numbers mean, the limits of this view, and where to check (pipeline/evidence.py) ----------
  function insights() {
    const ins = S.t.insights, box = $("insights");
    box.hidden = !ins;
    if (!ins) return;
    $("facts").innerHTML = ins.facts.map((f) =>
      `<li><b>${esc(f.headline)}</b><span>${esc(f.detail)}</span><span class="basis">How: ${esc(f.basis)}</span></li>`).join("");
    $("limits").innerHTML = ins.limits.map((l) => `<li>${esc(l)}</li>`).join("");
    const { ra, dec } = nowPos(S.t);   // latest measured position (fast movers leave the catalogue position behind)
    const c = encodeURIComponent(`${ra.toFixed(5)} ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}`);
    const links = [
      ["SIMBAD (is it a known object?)", `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c}&Radius=30&Radius.unit=arcsec`],
      ["Gaia DR3 (VizieR)", `https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-source=I/355/gaiadr3&-c=${c}&-c.rs=30`],
      ["Backyard Worlds (report an unknown mover)", "https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9"],
    ];
    $("nextLinks").innerHTML = links.map(([t, h]) => `<a href="${h}" target="_blank" rel="noopener noreferrer">${esc(t)} ↗</a>`).join(" · ");
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
    s = String(s).trim().replace(/[−–]/g, "-"); if (!s) return NaN;   // the Star database prints a Unicode minus
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return +s;
    const m = s.replace(/[hdms:°'′″"]/g, " ").trim().split(/\s+/).map(Number);
    if (m.length > 3) return NaN;                                      // both coordinates typed into one box
    const sign = /^-/.test(s) ? -1 : 1, v = Math.abs(m[0]) + (m[1] || 0) / 60 + (m[2] || 0) / 3600;
    return sign * v * (hours ? 15 : 1);
  }
  // 12h30m, 12:30:00 and plain "12 30 00" are hours of RA (the usual convention); 187.5 and 187d30m are degrees
  const raInHours = (s) => /h|:/i.test(s) || (/^\s*[-+]?[\d.]+\s+\d/.test(s) && !/[d°]/i.test(s));
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

  const fovLabel = (f) => `${f / 60}′`;
  function exploreHere(a, d) {
    document.getElementById("exploreHere")?.remove();
    liveExplore.then((ok) => { if (ok) $("coordMsg").insertAdjacentHTML("afterend",
      `<p id="exploreHere" class="hint"><a href="/explore/?q=${encodeURIComponent(`${a.toFixed(5)} ${d.toFixed(5)}`)}">Explore this patch live</a></p>`); });
  }

  function coordSearch(ra, dec, fovIn, opts = {}) {
    if (fovIn && typeof fovIn === "object") { opts = fovIn; fovIn = $("fovIn").value; }
    let a = parseAngle(ra, raInHours(ra)), d = parseAngle(dec, false);
    if (!isFinite(a) || !isFinite(d)) { $("coordMsg").textContent = "Could not read those coordinates."; return false; }
    if (a < 0 || a > 360 || Math.abs(d) > 90) { $("coordMsg").textContent = "RA runs from 0 to 360° (0h to 24h) and Dec from −90° to +90°."; return false; }
    if (a === 360) a = 0;                                // 24h00m00s is 0h
    S.here = { ra: a, dec: d, label: opts.label || `RA ${a.toFixed(4)}°, Dec ${d.toFixed(4)}°` };
    if (!opts.fromSearch) { showPath(null); $("starCard").hidden = true; }   // bare coordinates: no known motion until a target matches
    const fov = Number(fovIn) || 300;
    if ([...$("fovIn").options].some((o) => Number(o.value) === fov)) $("fovIn").value = String(fov);
    // nearest cached target overall, and nearest one that has the field size that was asked for
    const near = (list) => {
      let best = null, bd = 1e9;
      for (const t of list) {
        const dd = Math.hypot((((t.ra - a + 540) % 360) - 180) * Math.cos((d * Math.PI) / 180), t.dec - d) * 3600;   // across RA 0h too
        if (dd < bd) { bd = dd; best = t; }
      }
      return { best, bd };
    };
    const same = near(S.list.filter((t) => (t.fov || 300) === fov)), any = near(S.list);
    if (same.best && same.bd < 600) { $("coordMsg").textContent = `Matched ${same.best.name} (${Math.round(same.bd)}″ away).`; load(same.best.id); return true; }
    if (opts.fromSearch) {   // a star picked by name: show it instantly; the full time-lapse is an explicit choice
      showSubject(S.here.label, "Found by name · shown live on the sky map");
      showMap(a, d, opts.label || "searched star");
      $("coordMsg").innerHTML = "Showing it on the live SPHEREx sky map (slide through all 102 wavelengths), or open 🔭 Through Webb." +
        (S.live ? ' <button type="button" id="mkLapse">Make a SPHEREx time-lapse (a few minutes)</button>' : "");
      if (S.live) $("mkLapse").onclick = () => requestField(a, d, fov);
      exploreHere(a, d);
      return true;
    }
    exploreHere(a, d);   // live /explore/ mode (backend on :8001), shown beside the message
    if (S.live) { showSubject(S.here.label, "Typed coordinates · preparing a time-lapse"); requestField(a, d, fov); return true; }
    else if (any.best && any.bd < 600) {   // no server to make the other size: show what is cached and say so
      $("coordMsg").textContent = `${any.best.name} is prepared as a ${fovLabel(any.best.fov || 300)} field only, so that is what is shown.`;
      load(any.best.id); return true;
    } else {   // static site: show the live sky map
      showSubject(S.here.label, "Typed coordinates · shown live on the sky map");
      showMap(a, d, S.here.label);
      $("coordMsg").textContent = "This patch of sky has no prepared time-lapse yet; the sky map shows it live.";
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
    MAP.aladin = A.aladin("#aladin", { survey: HIPS.spherex, fov: 0.12, cooFrame: "ICRSd", log: false, showReticle: true, showLayersControl: false,
      showGotoControl: false, showFullscreenControl: true, showCooGridControl: false, showSimbadPointerControl: false,
      showProjectionControl: false, showFrame: true, showZoomControl: true,
      target: t.grid ? `${t.grid.centre_ra} ${t.grid.centre_dec}` : "0 0" });
    MAP.layers.spherex = A.imageHiPS(HIPS.spherex, { name: "SPHEREx DR1", imgFormat: "png" });
    MAP.layers.wise = A.imageHiPS(HIPS.wise, { name: "AllWISE colour", imgFormat: "jpeg" });
    MAP.aladin.setBaseImageLayer(MAP.layers.spherex);
    MAP.overlay = A.graphicOverlay({ color: "#ffb547", lineWidth: 2, lineDash: [6, 4] }); MAP.aladin.addOverlay(MAP.overlay);
    MAP.cat = A.catalog({ name: "target", sourceSize: 22, color: "#ffb547", shape: "circle" }); MAP.aladin.addCatalog(MAP.cat);
    MAP.past = A.graphicOverlay({ color: "#7cc4ff", lineWidth: 2.5 }); MAP.aladin.addOverlay(MAP.past);                    // path taken
    MAP.fut = A.graphicOverlay({ color: "#7ee787", lineWidth: 2.5, lineDash: [7, 5] }); MAP.aladin.addOverlay(MAP.fut);    // path ahead
    MAP.yr = A.catalog({ name: "year", sourceSize: 16, color: "#7ee787", shape: "square" }); MAP.aladin.addCatalog(MAP.yr);  // predicted spot in a chosen year
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
    MAP.overlay.removeAll(); MAP.cat.removeAll(); MAP.past.removeAll(); MAP.fut.removeAll(); MAP.yr.removeAll();
    MAP.sp = null; $("mapYears").hidden = true; yrStop();
    const me = (MAP.seq = (MAP.seq || 0) + 1);
    if (S.pathQ && window.PathView) PathView.sky(S.pathQ).then((sp) => {     // the star's path, 1900 to 2100
      if (!sp || !MAP.past || me !== MAP.seq) return;                        // the map has moved on to another star
      const back = sp.pts.filter((p) => p.year <= sp.now).map((p) => [p.ra, p.dec]), ahead = sp.pts.filter((p) => p.year >= sp.now).map((p) => [p.ra, p.dec]);
      if (back.length > 1) MAP.past.add(A.polyline(back));
      if (ahead.length > 1) MAP.fut.add(A.polyline(ahead));
      MAP.sp = sp; $("mapYears").hidden = false; $("yrSlider").value = Math.floor(sp.now);
      const c = Math.cos(sp.pts[0].dec * Math.PI / 180), xs = sp.pts.map((p) => p.ra * c), ys = sp.pts.map((p) => p.dec);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (span > 0) MAP.aladin.setFoV(Math.min(30, Math.max(0.03, span * 2.2)));   // fit the whole path
      yrMove(sp.now);
    }).catch(() => {});
    const pts = t && label === t.name ? t.track.filter((p) => (p.ch || "w2") === "w2").sort((a, b) => a.year - b.year) : [];
    if (pts.length >= 2) MAP.overlay.add(A.polyline(pts.map((p) => [p.ra, p.dec])));
    const last = pts.length ? pts[pts.length - 1] : { ra, dec };
    MAP.cat.addSources([A.source(last.ra, last.dec, { name: label })]);
  }
  // ---------- year slider: move the star along its predicted path (any star with known motion) ----------
  function yrMove(y) {
    const sp = MAP.sp; if (!sp) return;
    const P = sp.pts; let i = P.findIndex((p) => p.year >= y); if (i <= 0) i = 1; if (i >= P.length) i = P.length - 1;
    const a = P[i - 1], b = P[i], t = b.year === a.year ? 0 : Math.max(0, Math.min(1, (y - a.year) / (b.year - a.year)));
    MAP.yr.removeAll(); MAP.yr.addSources([A.source(a.ra + (b.ra - a.ra) * t, a.dec + (b.dec - a.dec) * t, { name: String(Math.round(y)) })]);
    const isNow = Math.abs(y - sp.now) < 1;           // "now" is this calendar year (2026.9 is still 2026)
    $("yrLbl").textContent = `${isNow ? Math.floor(sp.now) : Math.round(y)} · ${isNow ? "now" : y < sp.now ? "where it was" : "predicted"}`;
  }
  let yrAnim = null;
  function yrStop() { if (yrAnim) cancelAnimationFrame(yrAnim); yrAnim = null; $("yrPlay").textContent = "▶ Play its path"; }
  $("yrSlider").oninput = (e) => { yrStop(); yrMove(+e.target.value); };
  $("yrPlay").onclick = () => {
    if (yrAnim) return yrStop();
    if (reduceMotion) { $("yrSlider").value = 2100; return yrMove(2100); }
    const t0 = performance.now(), y0 = +$("yrSlider").value >= 2099 ? 1900 : +$("yrSlider").value;
    $("yrPlay").textContent = "❚❚ Pause";
    const step = (now) => {
      const y = Math.min(2100, y0 + (now - t0) / 1000 * 25);   // 25 years a second
      $("yrSlider").value = Math.round(y); yrMove(y);
      yrAnim = y < 2100 ? requestAnimationFrame(step) : (yrStop(), null);
    };
    yrAnim = requestAnimationFrame(step);
  };
  async function showMap(ra, dec, label) {
    selectTab("map");
    try { await initMap(); mapGoTo(ra, dec, label); } catch (e) { $("coordMsg").textContent = "Sky map unavailable: " + e.message; }
  }
  function selectTab(which, starKey) {
    const views = { flip: ["flipView", "tabFlip"], map: ["mapView", "tabMap"], webb: ["webbView", "tabWebb"], stars: ["starView", "tabStars"] };
    for (const [k, [view, tab]] of Object.entries(views)) {
      $(view).hidden = k !== which; $(tab).classList.toggle("on", k === which); $(tab).setAttribute("aria-selected", k === which);
    }
    $("meta").hidden = which === "stars";
    document.body.classList.toggle("stars-mode", which === "stars");
    if (which === "stars") $("pathCard").hidden = true; else if (S.pathQ && $("pathBody").innerHTML) $("pathCard").hidden = false;   // typed coordinates: no path
    $("changes").hidden = which !== "flip" || S.away || !(S.t && S.t.changes);   // "What else moved" belongs to the time-lapse
    if (which !== "stars" && new URLSearchParams(location.search).has("star")) {   // a reload should not reopen the Star database
      const u = new URL(location); u.searchParams.delete("star"); history.replaceState(null, "", u);
    }
    if (which !== "flip") stop();
    if (which === "webb") showWebb();
    if (which === "stars" && window.StarsTab) window.StarsTab.open(starKey);
    if (window.LongRange) which === "stars" ? requestAnimationFrame(window.LongRange.refresh) : window.LongRange.stop();
  }
  window.WANDERERS = { selectTab, openTarget };

  // ---------- path taken and path ahead (the team's star-path model, via pathview.js) ----------
  let pathSeq = 0;
  // the "See it in the sky" button opens the Sky Compass already aimed at what is on screen
  function compassCta(q) {
    const a = $("compassCta"); if (!a) return;
    const t = q && q.target ? S.list.find((x) => x.id === q.target) : null;
    a.href = t ? `compass.html?target=${encodeURIComponent(t.id)}` : q && q.star ? `compass.html?star=${encodeURIComponent(q.star.name)}` : "compass.html";
    $("compassCtaSub").textContent = t ? `Find ${t.name} with your phone` : q && q.star ? `Find ${q.star.name} with your phone` : "Sky Compass · point your phone up";
  }
  async function showPath(q) {
    compassCta(q);
    S.pathQ = q || null;
    const card = $("pathCard"), seq = ++pathSeq;
    if (!q || !window.PathView) { card.hidden = true; return; }
    card.hidden = document.body.classList.contains("stars-mode");
    const m = await PathView.render($("pathBody"), q, { explorerHref: (k) => `observatory.html?star=${encodeURIComponent(k)}` });
    if (seq !== pathSeq) return;                                   // a newer result has replaced this one
    const a = $("pathBody").querySelector(".pv-link");
    if (a && m && m.key) a.onclick = (e) => { e.preventDefault(); selectTab("stars", m.key); };
  }

  // ---------- through Webb: match the coordinates against every public JWST frame, show its pixels ----------
  async function showWebb() {
    const h = S.here; if (!h) return;
    const head = $("webbHead"), list = $("webbFrames");
    head.textContent = "Checking every public Webb frame…"; list.innerHTML = ""; $("webbNote").textContent = "";
    let db; try { db = await Webb.load(); } catch (e) { head.textContent = "Webb frame list unavailable: " + e.message; return; }
    $("webbCount").textContent = `${db.count.toLocaleString()} frames`;
    let frames = Webb.best(Webb.framesAt(h.ra, h.dec)), centre = h;
    const path = S.pathQ && window.PathView ? await PathView.sky(S.pathQ).catch(() => null) : null;
    const legend = `<br><span class="webb-legend"><i class="lg-gold"></i>Webb frame shown <i class="lg-grey"></i>other Webb frames that cover this spot <i class="lg-cross"></i>your position` +
      (path ? ` <i class="lg-past"></i>path taken since 1900 <i class="lg-fut"></i>path ahead to 2100` : "") + `</span>` +
      (path ? "" : `<br><span class="hint">No path is drawn: ${S.pathQ ? "no motion is known for this star" : "these are typed coordinates, not a known star. Search a star by name to see where it has been and where it is going"}.</span>`);
    if (frames.length) head.innerHTML = `<b>Webb has imaged ${esc(h.label)}</b> in ${frames.length} frame${frames.length > 1 ? "s" : ""}. ` +
      `The red cross is your position, the gold outline the frame shown.`;
    else {
      const n = Webb.near(h.ra, h.dec, 5, 1)[0];
      if (!n) { head.innerHTML = `<b>Webb has not imaged this part of the sky</b> (no public Webb image within 5° of ${esc(h.label)}).`; $("webbAladin").innerHTML = ""; return; }
      frames = [n, ...Webb.best(Webb.framesAt(n.ra, n.dec)).filter((p) => p.obs !== n.obs)]; centre = n;
      head.innerHTML = `<b>Webb has not imaged ${esc(h.label)}.</b> Showing its nearest Webb frame, “${esc(Webb.name(n))}”, ${n.dist.toFixed(2)}° away.`;
    }
    head.innerHTML += legend;
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
          { label: h.label, mark: { ra: h.ra, dec: h.dec }, path, base: $("webbBase").value, webbOpacity: +$("webbOp").value });
        const edge = Webb.inside(p, h.ra, h.dec) ? Webb.edgeArcsec(p, h.ra, h.dec) : null;
        if (edge != null && edge < 15) $("webbNote").insertAdjacentHTML("beforeend", `<br><span class="hint">Your position is only ${edge.toFixed(0)}″ inside this frame's outline, right at its edge: Webb's pixels may not quite reach it.</span>`);
      } catch (e) { $("webbNote").textContent = "Sky viewer could not load: " + e.message; }
    };
    list.innerHTML = frames.slice(0, 12).map((p) => { const d = Webb.describe(p);
      return `<button data-obs="${esc(p.obs)}"><img loading="lazy" alt="" src="${Webb.thumb(p)}"><div>${esc(d.title)}<span>${esc(d.line)}</span></div></button>`; }).join("");
    list.querySelectorAll("button").forEach((b) => (b.onclick = () => show(frames.find((p) => p.obs === b.dataset.obs))));
    show(frames[0]);
  }
  $("tabWebb").onclick = () => selectTab("webb");
  $("webbOp").oninput = (e) => Webb.setOpacity(+e.target.value);
  $("webbBase").onchange = (e) => Webb.setBase(e.target.value);
  $("tabFlip").onclick = () => {   // the time-lapse belongs to a mission: back from a searched star, show that mission again
    selectTab("flip");
    if ((S.away || !S.t) && S.list.length) { $("starCard").hidden = true; load((S.t || S.list[0]).id, S.t ? S.ch : undefined); }
  };
  $("tabStars").onclick = () => selectTab("stars");
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
