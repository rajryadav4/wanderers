/* "Star database" tab: search the HYG-based star list, show a star's details and its past and future path
 * as learnt by pipeline/star_ml.py (scikit-learn). Uses stardb.js for search, formatting and chart maths.
 * Precomputed predictions load as static files; with server.js running, any star can be computed on demand.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DB = { stars: null, meta: null, ready: new Set(), full: new Set(), live: false, cur: null, hits: [], sel: -1, token: 0 };
  const CAT_COLOR = (c) => (/^Gaia/.test(c) ? "#7ee787" : /^WANDERERS/.test(c) ? "#ffb547" : /Hipparcos|Tycho/.test(c) ? "#b48cff" : "#7cc4ff");

  async function ensureDb() {
    if (DB.stars) return;
    $("starMsg").textContent = "Loading the star database…";
    const [idx, ready, full] = await Promise.all([
      fetch("data/stars/index.json").then((r) => r.json()),
      fetch("data/stars/pred/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch("data/stars/profile/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    DB.stars = idx.stars; DB.meta = idx.meta; DB.ready = new Set(ready); DB.full = new Set(full);
    DB.live = await fetch("api/health").then((r) => r.ok).catch(() => false);
    $("starMsg").textContent = `${DB.stars.length.toLocaleString("en-US")} stars searchable (${DB.meta.selection}). Every star gets a profile, ` +
      `a path from 1900 to 2100 and over thousands of years, and its starquakes. The stars below are fully done: real spectrum, learnt path, pre-made sound.`;
    showSuggestions();
  }

  // Stars already fully done, on top, to choose from: full profile (with spectrum) AND learnt path first.
  function showSuggestions() {
    const byName = (a, b) => a.name.localeCompare(b.name), chip = (s) => `<button type="button" class="chip" data-key="${esc(s.key)}">${esc(s.name)}</button>`;
    const both = DB.stars.filter((s) => DB.full.has(s.key) && DB.ready.has(s.key)).sort(byName);
    const prof = DB.stars.filter((s) => DB.full.has(s.key) && !DB.ready.has(s.key)).sort(byName);
    const path = DB.stars.filter((s) => DB.ready.has(s.key) && !DB.full.has(s.key)).sort(byName);
    $("starSuggest").innerHTML =
      `<span class="chips-row"><b>Fully done</b> <span class="hint">(full profile with real spectrum + learnt path):</span> ${both.map(chip).join(" ")}</span>` +
      (prof.length ? `<span class="chips-row"><b>Full profile</b> <span class="hint">(path computed from its measured motion):</span> ${prof.map(chip).join(" ")}</span>` : "") +
      (path.length ? `<span class="chips-row"><b>Learnt path</b>: ${path.map(chip).join(" ")}</span>` : "");
    $("starSuggest").querySelectorAll("button").forEach((b) => (b.onclick = () => choose(b.dataset.key)));
  }

  // ---------- search box (combobox + listbox, keyboard friendly) ----------
  function renderHits() {
    const ul = $("starResults");
    ul.innerHTML = DB.hits.map((s, i) => {
      const extra = [s.aliases.find((a) => /^(Gl|HIP|HD) /.test(a)), s.con, s.mag != null ? `V ${s.mag}` : null].filter(Boolean).join(" · ");
      return `<li role="option" id="starOpt${i}" data-key="${esc(s.key)}" aria-selected="${i === DB.sel}" class="${i === DB.sel ? "on" : ""}">` +
        `<b>${esc(s.name)}</b> <span class="hint">${esc(extra)}</span>${DB.full.has(s.key) ? ' <span class="badge">full profile</span>' : ""}${DB.ready.has(s.key) ? ' <span class="badge">learnt path</span>' : ""}</li>`;
    }).join("");
    ul.hidden = !DB.hits.length;
    $("starQ").setAttribute("aria-expanded", String(!!DB.hits.length));
    $("starQ").setAttribute("aria-activedescendant", DB.sel >= 0 ? `starOpt${DB.sel}` : "");
    ul.querySelectorAll("li").forEach((li) => (li.onmousedown = (e) => { e.preventDefault(); choose(li.dataset.key); }));
  }
  $("starQ").addEventListener("input", async (e) => {
    await ensureDb();
    DB.hits = StarDB.search(DB.stars, e.target.value, { limit: 12, ready: DB.ready }); DB.sel = DB.hits.length ? 0 : -1;
    renderHits();
    if (e.target.value.trim() && !DB.hits.length) $("starMsg").textContent = "No star by that name here. Try a proper name (Vega), Bayer (Alpha Lyrae), HIP/HD/Gliese number.";
  });
  $("starQ").addEventListener("keydown", (e) => {
    if (!DB.hits.length) return;
    if (e.key === "ArrowDown") { DB.sel = (DB.sel + 1) % DB.hits.length; renderHits(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { DB.sel = (DB.sel - 1 + DB.hits.length) % DB.hits.length; renderHits(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); if (DB.sel >= 0) choose(DB.hits[DB.sel].key); }
    else if (e.key === "Escape") { DB.hits = []; renderHits(); }
  });
  $("starQ").addEventListener("blur", () => setTimeout(() => { DB.hits = []; renderHits(); }, 150));
  $("starQ").addEventListener("focus", ensureDb);

  // ---------- one star ----------
  async function choose(key) {
    await ensureDb();
    const s = DB.stars.find((x) => x.key === key);
    if (!s) { $("starMsg").textContent = "That star is not in the database."; return; }
    DB.cur = s; DB.hits = []; renderHits(); $("starQ").value = s.name;
    const url = new URL(location); url.searchParams.set("star", key); history.replaceState(null, "", url);
    renderDetail(s);
    if (window.StarProfile) StarProfile.mount($("starProfile"), { key, row: s, stars: DB.stars });
    // links like ?star=hip8102#starQuake scroll to that section once it has been drawn
    const hash = decodeURIComponent(location.hash.slice(1));
    if (/^(starProfile|starQuake|starLong|starPred)$/.test(hash)) {
      let tries = 0;
      const go = () => { const t = $(hash); if (t && !t.hidden && t.offsetHeight > 40) setTimeout(() => t.scrollIntoView({ block: "start" }), 250); else if (++tries < 40) setTimeout(go, 200); };
      setTimeout(go, 300);
    }
    if (window.StarquakeUI) StarquakeUI.mount($("starQuake"), { key, row: s });
    $("starPred").hidden = true; $("starPredMsg").innerHTML = "";
    if (DB.ready.has(key)) return showPred(await fetch(`data/stars/pred/${key}.json`).then((r) => r.json()));
    // No learnt path yet: compute one from the star's measured motion (Gaia DR3, else HYG), so every star has both paths.
    const prof = window.StarProfile ? await StarProfile.load(key).catch(() => null) : null;
    if (DB.cur !== s) return;
    const phys = window.PhysicsPath ? PhysicsPath.build(s, prof) : null;
    if (phys) showPred(phys); else if (window.LongRange) LongRange.show(null, s, DB.stars);
    const how = DB.live ? `<button type="button" id="starLearn">Learn its path with the ML model</button> <span class="hint">Queries 13 catalogues at the ESA Gaia archive and fits the model: about a minute.</span>`
      : `<span class="hint">To learn it with the ML model, run <code>node server.js</code>, or <code>.venv/bin/python pipeline/star_ml.py ${esc(key)}</code>.</span>`;
    $("starPredMsg").innerHTML = phys ? `${how}` : `No distance or motion is known for ${esc(s.name)}, so its path cannot be drawn. ${how}`;
    if ($("starLearn")) $("starLearn").onclick = () => learn(key);
  }

  function renderDetail(s) {
    const rows = [
      ["Also known as", s.aliases.filter((a) => a !== "WANDERERS target").join(", ") || "—"],
      ["Position (J2000)", `RA ${StarDB.hms(s.ra)} · Dec ${StarDB.dms(s.dec)}`],
      ["Constellation", s.con || "—"], ["Spectral type", s.spect || "—"],
      ["Brightness", s.mag != null ? `V = ${s.mag}` : "not in this catalogue (infrared object)"],
      ["Distance", StarDB.distance(s.dist_pc)],
      ["Catalogue motion", `${StarDB.pm(s.pmra)} , ${StarDB.pm(s.pmdec)} mas/yr (RA*, Dec)` +
        ([s.pmra, s.pmdec].some((v) => Math.abs(v) === 9999.99) ? " — capped at 9999.99 in HYG; see the learnt value below" : "")],
      ["Radial velocity", s.rv != null && s.rv !== 0 ? `${s.rv} km/s` : "—"],
      ["Source", s.source || "HYG v4.1 (Hipparcos, Yale, Gliese)"],
    ];
    $("starDetail").innerHTML = `<h3>${esc(s.name)}</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` +
      (s.wanderers ? `<p><a href="?target=${esc(s.wanderers)}" id="starToTarget">See it move in the WISE → SPHEREx time-lapse →</a></p>` : "");
    $("starDetail").hidden = false;
    const link = $("starToTarget");
    if (link) link.onclick = (e) => { e.preventDefault(); window.WANDERERS && window.WANDERERS.openTarget(s.wanderers); };
  }

  async function learn(key) {
    const me = ++DB.token;
    $("starPredMsg").textContent = "Starting…";
    try {
      const r = await fetch("api/star-predict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "server error");
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        if (me !== DB.token) return;
        const st = await fetch(`api/star-job/${j.job}`).then((x) => x.json());
        $("starPredMsg").textContent = `${st.log.slice(-1)[0] || "Working…"} (${st.seconds} s)`;
        if (st.status === "done") { DB.ready.add(key); if (DB.cur && DB.cur.key === key) showPred(await fetch(`data/stars/pred/${key}.json?t=${Date.now()}`).then((x) => x.json())); return; }
        if (st.status === "error") throw new Error(st.log.slice(-1)[0] || "failed");
      }
    } catch (e) { if (me === DB.token) $("starPredMsg").textContent = "Could not learn this star's path: " + e.message; }
  }

  // ---------- prediction ----------
  function showPred(p) {
    $("starPredMsg").innerHTML = "";
    $("starPred").hidden = false;
    if (window.LongRange) LongRange.show(p, DB.cur, DB.stars);
    drawChart(p);
    const t = p.table;
    $("starTable").innerHTML = `<thead><tr><th>Year</th><th>RA</th><th>Dec</th><th>± (68%)</th><th>From 2000</th></tr></thead><tbody>` +
      t.map((r) => `<tr class="${r.year === p.now ? "now" : r.year > p.now ? "future" : ""}"><th scope="row">${r.year === p.now ? `Now (${r.year.toFixed(1)})` : Math.round(r.year)}</th>` +
        `<td class="mono">${StarDB.hms(r.ra)}</td><td class="mono">${StarDB.dms(r.dec)}</td><td>${StarDB.arcsec(r.unc_arcsec)}</td><td>${StarDB.arcsec(r.moved_from_2000_arcsec)}</td></tr>`).join("") + "</tbody>";
    const computed = p.kind === "physics";
    $("starPredSub").textContent = computed ? "1900 → 2100, calculated from its measured motion" : "1900 → 2100, learnt by a classical machine-learning model";
    $("starModelH").textContent = computed ? "How the path was calculated" : "How the path was learnt";
    $("starModel").innerHTML = computed ? physicsCard(p) : modelCard(p);
    $("starObsBox").hidden = computed;
    $("starObs").innerHTML = computed ? "" : obsTable(p);
  }

  function physicsCard(p) {
    const L = p.learnt, c = p.catalogue_motion;
    return `<p>This star has no learnt path yet, so its path is <b>calculated</b> from ${esc(p.basis)}: proper motion
      ${StarDB.pm(c.pmra)}, ${StarDB.pm(c.pmdec)} mas/yr, parallax ${StarDB.pm(c.parallax)} mas${p.rvKnown ? `, radial velocity ${StarDB.pm(p.gaia_dr3 && p.gaia_dr3.radial_velocity != null ? p.gaia_dr3.radial_velocity : DB.cur && DB.cur.rv)} km/s` : " (no radial velocity known: assumed 0)"}.</p>
      <p class="hint">Model: straight-line motion through space (the model behind astropy's <code>apply_space_motion</code>, checked against it in the tests).
      The band is the catalogue's proper-motion uncertainty (±${StarDB.pm(L.pmra_err)} / ±${StarDB.pm(L.pmdec_err)} mas/yr) carried over the years.
      A learnt path instead fits up to 13 catalogues of real positions from 1950 onwards with scikit-learn, and can find accelerations this cannot.</p>`;
  }

  function drawChart(p) {
    const c = StarDB.chart(p, { width: 640, height: 420 });
    const svg = $("starChart");
    const marks = c.marks.map((m) => `<g class="${m.now ? "mk now" : "mk"}"><circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${m.now ? 5 : 3}"/>` +
      `<text x="${(m.x + 8).toFixed(1)}" y="${(m.y - 6).toFixed(1)}">${m.now ? "now" : m.year}</text></g>`).join("");
    const obs = c.obs.map((o) => `<circle class="ob${o.down ? " down" : ""}" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="4" fill="${CAT_COLOR(o.catalogue)}">` +
      `<title>${esc(o.catalogue)} · ${o.epoch.toFixed(2)}${o.down ? " · down-weighted (disagrees with the rest)" : ""}</title></circle>`).join("");
    const bar = c.scaleBar.arcsec * c.k;
    svg.innerHTML =
      `<rect width="${c.W}" height="${c.H}" class="bg"/>` +
      (c.band.length ? `<path class="band" d="${StarDB.pathD(c.band)}Z"><title>68% uncertainty of the path</title></path>` : "") +
      `<path class="past" d="${StarDB.pathD(c.past)}"/><path class="future" d="${StarDB.pathD(c.future)}"/>` + obs + marks +
      `<g class="bar"><line x1="16" y1="${c.H - 18}" x2="${16 + bar}" y2="${c.H - 18}"/><text x="16" y="${c.H - 24}">${esc(c.scaleBar.label)}</text></g>` +
      `<g class="compass"><text x="${c.W - 22}" y="20">N</text><text x="${c.W - 44}" y="40">E</text><line x1="${c.W - 18}" y1="40" x2="${c.W - 18}" y2="24"/><line x1="${c.W - 18}" y1="40" x2="${c.W - 34}" y2="40"/></g>`;
    svg.setAttribute("aria-label", `Path of ${p.name} on the sky from 1900 to 2100, learnt from ${new Set(p.observations.map((o) => o.catalogue)).size} catalogue positions`);
  }

  function modelCard(p) {
    const m = p.model, L = p.learnt, g = p.gaia_dr3, h = p.holdout_gaia;
    const sc = Object.entries(m.scores || {}).map(([k, v]) => `<tr class="${k === m.chosen_features ? "on" : ""}"><td>${esc(k)}</td><td>${v.bic.toFixed(1)}</td>` +
      `<td>${v.allowed ? (k === m.chosen_features ? "chosen" : "allowed") : esc((v.rejected_because || []).join("; "))}</td></tr>`).join("");
    const cmp = g ? `<tr><th>Gaia DR3</th><td>${StarDB.pm(g.pmra)}</td><td>${StarDB.pm(g.pmdec)}</td><td>${StarDB.pm(g.parallax)}</td></tr>` :
      p.catalogue_motion && p.catalogue_motion.pmra != null ? `<tr><th>${esc(p.catalogue_motion.source.split(",")[0])}</th><td>${StarDB.pm(p.catalogue_motion.pmra)}</td><td>${StarDB.pm(p.catalogue_motion.pmdec)}</td><td>${StarDB.pm(p.catalogue_motion.parallax)}</td></tr>` : "";
    const lines = [];
    if (h) lines.push(`<b>Gaia hold-out test:</b> trained on ${h.trained_on.length} catalogues without any Gaia data, the model predicted where Gaia DR3 saw the star in 2016.0 to within <b>${StarDB.arcsec(h.miss_mas / 1000)}</b> (${h.years_extrapolated} years beyond its newest training point).`);
    if (g && g.ml_minus_gaia_path_arcsec) lines.push(`<b>Against Gaia's physics:</b> the learnt path and straight propagation of Gaia DR3's solution differ by ${StarDB.arcsec(g.ml_minus_gaia_path_arcsec["1900"])} in 1900 and ${StarDB.arcsec(g.ml_minus_gaia_path_arcsec["2100"])} in 2100.`);
    if (L.acc_dec_mas_yr2 != null) lines.push(`<b>Acceleration found:</b> ${L.acc_ra_mas_yr2.toFixed(2)}, ${L.acc_dec_mas_yr2.toFixed(2)} mas/yr² (RA*, Dec). For a fast, nearby star this is perspective acceleration: its motion changes as it passes us. The learnt motion at 2016 is ${StarDB.pm(L.pmra_2016)}, ${StarDB.pm(L.pmdec_2016)} mas/yr.`);
    if (!g) lines.push("Gaia DR3 has no usable solution for this star (too bright or too cold), so there is no Gaia check.");
    return `<p class="hint">${esc(m.library)} ${esc(m.sklearn_version)} · <b>${esc(m.estimator)}</b>, fitted to this star's ${m.trained_on_rows / 2 | 0} measured positions ` +
      `(${esc(m.catalogues.length)} catalogues, ${m.epoch_span[0]}–${m.epoch_span[1]}). ${esc(m.note)}</p>` +
      `<table class="frames"><thead><tr><th></th><th>pmRA* (mas/yr)</th><th>pmDec (mas/yr)</th><th>Parallax (mas)</th></tr></thead><tbody>` +
      `<tr><th>Learnt (at ${L.pm_epoch})</th><td>${StarDB.pm(L.pmra_mas_yr, L.pmra_err)}</td><td>${StarDB.pm(L.pmdec_mas_yr, L.pmdec_err)}</td><td>${L.parallax_mas != null ? StarDB.pm(L.parallax_mas, L.parallax_err) : "not resolved"}</td></tr>${cmp}</tbody></table>` +
      lines.map((l) => `<p>${l}</p>`).join("") +
      `<details><summary>Model selection (${esc(m.selection)})</summary><table class="frames"><thead><tr><th>Features</th><th>BIC</th><th></th></tr></thead><tbody>${sc}</tbody></table>` +
      `<p class="hint">Lower BIC is better. Parallax and acceleration terms are only allowed when they are 3σ detections and physically possible. Uncertainty: ${esc(m.uncertainty)}.</p></details>`;
  }

  function obsTable(p) {
    const by = new Map();
    for (const o of p.observations) { const k = o.catalogue; if (!by.has(k)) by.set(k, []); by.get(k).push(o); }
    const rows = [...by.entries()].sort((a, b) => a[1][0].epoch - b[1][0].epoch).map(([k, os]) => {
      const res = Math.hypot(...os.map((o) => o.resid_mas)) / 1000, down = os.some((o) => o.down_weighted);
      return `<tr><th scope="row"><span class="dot" style="background:${CAT_COLOR(k)}"></span>${esc(k)}</th><td>${os[0].epoch.toFixed(2)}</td>` +
        `<td>${StarDB.arcsec(Math.max(...os.map((o) => o.sigma_mas)) / 1000)}</td><td class="${down ? "m-warn" : ""}">${StarDB.arcsec(res)}${down ? " · down-weighted" : ""}</td></tr>`;
    }).join("");
    return `<table class="frames"><thead><tr><th>Measured by</th><th>Year</th><th>Stated error</th><th>Off the learnt path</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="hint">Positions queried from the ESA Gaia archive (which also hosts Hipparcos, Tycho-2, 2MASS, AllWISE, Pan-STARRS1, URAT1, UCAC4, PPMXL, GSC 2.3 and CatWISE). ` +
      `${esc(p.identified_via)} was used only to find the star in each survey. Computed ${esc(p.computed)}.</p>`;
  }

  // open from a link: ?star=hip87937
  const q = new URLSearchParams(location.search).get("star");
  window.StarsTab = { open: async (key) => { await ensureDb(); if (key) choose(key); }, ensureDb };
  if (q) window.addEventListener("load", () => window.WANDERERS && window.WANDERERS.selectTab("stars", q));
})();
