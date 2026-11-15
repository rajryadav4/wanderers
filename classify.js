/* WANDERERS citizen science: classify what you see as Moving, Variable, Stationary, Artifact or Unsure.
 *
 * Shown for every target in the explorer (observatory.html: app.js mounts a card) and every Sky Survey candidate
 * (survey.html: survey.js mounts a card in the candidate drawer and asks for consensus badges on the table rows).
 * The site is static, so votes travel like this:
 *   1. Your own vote is kept in this browser (localStorage; in memory when storage is blocked) and counted here at once.
 *   2. "Send my vote" opens the GitHub issue form .github/ISSUE_TEMPLATE/classification.yml in kneha07/WANDERERS with
 *      every field filled in through the URL. That needs a free GitHub account and makes a public issue. No server, no key.
 *   3. pipeline/aggregate_votes.py (run by .github/workflows/classifications.yml) counts those issues into
 *      data/classifications.json: per object the counts, voters, consensus and every user's latest vote.
 *   4. On the hosted site this file also asks GitHub's public search API (no key) for votes newer than that snapshot,
 *      skipping issue numbers the snapshot already holds. Any failure (rate limit, offline) is silent.
 * The parsing and counting rules match pipeline/aggregate_votes.py; tests/fixtures/classify/ checks both on the same issues.
 * Node tests: require("app/classify.js") gives the helpers and create(env) for an instance with fake storage and fetch. */
(function (root) {
  "use strict";
  const REPO = "kneha07/WANDERERS", TEMPLATE = "classification.yml", LABEL = "classification";
  const DATA_URL = "data/classifications.json", STORE_KEY = "wanderers-classify-v1", LIVE_KEY = "wanderers-classify-live-v1";
  const LIVE_TTL_MS = 3 * 60 * 1000;        // one search per few minutes per tab: GitHub allows 10 a minute without a key
  const SENT_SLACK_MS = 10 * 60 * 1000;     // clocks differ: a matching vote this long before "sent" still counts as yours
  const MIN_VOTERS = 3, MIN_AGREEMENT = 0.6;
  const CLASSES = Object.freeze([
    { key: "moving", label: "Moving", help: "Changes position between frames or years." },
    { key: "variable", label: "Variable", help: "Stays put, but its brightness changes." },
    { key: "stationary", label: "Stationary", help: "Stays put and looks the same throughout." },
    { key: "artifact", label: "Artifact", help: "Not a real object: a glitch, spike, ghost or image edge." },
    { key: "unsure", label: "Unsure", help: "Can't tell from these images. That helps too." },
  ]);
  const KEYS = CLASSES.map((c) => c.key);
  const KINDS = ["target", "candidate"];
  const ALIASES = new Map([["artefact", "artifact"]]);
  const MODERATION = ["invalid", "spam"];
  const REASONS = ["duplicate", "not_a_vote", "moderated", "malformed", "unknown_class", "unknown_id"];
  const FIELDS = new Map([["object id", "object_id"], ["object_id", "object_id"], ["kind", "kind"], ["classification", "class"], ["class", "class"]]);
  const HEADING = /^###\s+(.+?)\s*#*\s*$/, TITLE = /^\s*\[classify\]\s*([^\s:]+)\s*:\s*(.+?)\s*$/i;
  const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const labelOf = (k) => (CLASSES.find((c) => c.key === k) || { label: "" }).label;
  const pct = (f) => `${Math.round(f * 100)}%`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function fmtDate(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  function classKey(s) {   // "Moving", " moving. ", "Artefact" -> key, else null
    if (typeof s !== "string") return null;
    let k = s.trim().toLowerCase().replace(/[.!]+$/, "");
    if (ALIASES.has(k)) k = ALIASES.get(k);
    return KEYS.includes(k) ? k : null;
  }
  function isoTime(s) {    // ISO 8601 with a zone -> "YYYY-MM-DDTHH:MM:SSZ" (UTC), else null
    if (typeof s !== "string" || !TIME.test(s.trim())) return null;
    const t = Date.parse(s.trim());
    return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  }

  // ---------- one issue -> one vote (same rules as pipeline/aggregate_votes.py) ----------
  function formFields(body) {   // the answers of an issue form, by "### Label"; the first heading of each wins
    const out = {}, done = new Set();
    let cur = null;
    for (const line of String(typeof body === "string" ? body : "").split(/\r?\n/)) {
      const h = HEADING.exec(line);
      if (h) {
        const f = FIELDS.get(h[1].trim().toLowerCase().replace(/\s+/g, " "));
        cur = f && !done.has(f) ? f : null;
        if (cur) { done.add(cur); out[cur] = ""; }
        continue;
      }
      const v = line.trim();
      if (cur && v) { out[cur] = v.toLowerCase() === "_no response_" ? "" : v; cur = null; }
    }
    return out;
  }
  const numberOf = (issue) => (isObj(issue) && Number.isInteger(issue.number) && issue.number > 0 ? issue.number : null);
  function labelsOf(issue) {
    if (!Array.isArray(issue.labels)) return null;
    return issue.labels.map((l) => (isObj(l) ? l.name : l)).filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase());
  }
  // known: Map(id -> kind) to check ids like the aggregator; null on the page, where an unknown id is simply never shown.
  function parseIssue(issue, known = null) {
    const n = numberOf(issue);
    if (n === null) return { reason: "malformed" };
    if (issue.pull_request != null) return { reason: "not_a_vote" };
    const labels = labelsOf(issue);
    if (labels && !labels.includes(LABEL)) return { reason: "not_a_vote" };
    if (labels && labels.some((l) => MODERATION.includes(l))) return { reason: "moderated" };
    const author = isObj(issue.author) ? issue.author : issue.user;
    if (!isObj(author)) return { reason: "malformed" };
    if (author.is_bot === true || author.type === "Bot") return { reason: "moderated" };
    if (typeof author.login !== "string" || !author.login.trim()) return { reason: "malformed" };
    const at = isoTime(issue.createdAt != null ? issue.createdAt : issue.created_at);
    if (!at) return { reason: "malformed" };
    const f = formFields(issue.body), t = TITLE.exec(typeof issue.title === "string" ? issue.title : "");
    const rawId = (f.object_id || (t ? t[1] : "")).trim(), rawCls = (f.class || (t ? t[2] : "")).trim();
    const rawKind = (f.kind || "").trim().toLowerCase();
    if (!rawId || !rawCls) return { reason: "malformed" };
    const cls = classKey(rawCls);
    if (!cls) return { reason: "unknown_class" };
    if (rawKind && !KINDS.includes(rawKind)) return { reason: "malformed" };
    let kind = rawKind || (/^\d+-\d+$/.test(rawId) ? "candidate" : "target");
    if (known) {
      if (!known.has(rawId)) return { reason: "unknown_id" };
      if (rawKind && rawKind !== known.get(rawId)) return { reason: "malformed" };
      kind = known.get(rawId);
    }
    return { vote: { issue: n, id: rawId, kind, user: author.login.trim().toLowerCase(), class: cls, at } };
  }

  // The pre-filled GitHub issue form for one vote. Dropdowns are filled by their option text.
  function issueUrl(id, kind, cls) {
    const label = labelOf(cls) || "Unsure";
    const q = [["template", TEMPLATE], ["title", `[classify] ${id}: ${label}`], ["object_id", String(id)], ["kind", KINDS.includes(kind) ? kind : "target"], ["class", label]];
    return `https://github.com/${REPO}/issues/new?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  }

  // ---------- counting ----------
  function consensusOf(counts, voters, minVoters = MIN_VOTERS, minAgreement = MIN_AGREEMENT) {
    if (!(voters > 0)) return { consensus: null, agreement: null, top: null };
    let top = KEYS[0];
    for (const k of KEYS) if (counts[k] > counts[top]) top = k;
    const share = counts[top] / voters;
    return { top, agreement: Math.floor(share * 1000 + 0.5) / 1000, consensus: voters >= minVoters && share >= minAgreement - 1e-9 ? top : null };
  }
  // o: an object's { votes, base } (base: counts without votes, from an older snapshot); extra: one more vote (yours)
  function tallyVotes(o, minVoters = MIN_VOTERS, minAgreement = MIN_AGREEMENT, extra = null) {
    const counts = Object.fromEntries(KEYS.map((k) => [k, 0]));
    if (o) {
      for (const v of o.votes || []) if (KEYS.includes(v.class)) counts[v.class]++;
      if (o.base) for (const k of KEYS) counts[k] += o.base[k] || 0;
    }
    if (KEYS.includes(extra)) counts[extra]++;
    const voters = KEYS.reduce((s, k) => s + counts[k], 0);
    return { counts, voters, ...consensusOf(counts, voters, minVoters, minAgreement) };
  }
  const emptyData = () => ({ minVoters: MIN_VOTERS, minAgreement: MIN_AGREEMENT, lastIssue: 0, lastVote: null, objects: new Map() });
  function cloneData(d) {
    const out = { ...d, objects: new Map() };
    for (const [id, o] of d.objects) out.objects.set(id, { kind: o.kind, votes: o.votes.slice(), base: o.base });
    return out;
  }
  // data/classifications.json -> the page's data. Anything odd in it is dropped, never trusted.
  function normalize(j) {
    const d = emptyData();
    if (!isObj(j)) return d;
    if (Number.isInteger(j.min_voters) && j.min_voters > 0) d.minVoters = j.min_voters;
    if (typeof j.min_agreement === "number" && j.min_agreement > 0 && j.min_agreement <= 1) d.minAgreement = j.min_agreement;
    if (Number.isInteger(j.last_issue) && j.last_issue > 0) d.lastIssue = j.last_issue;
    d.lastVote = isoTime(j.last_vote);
    for (const [id, o] of Object.entries(isObj(j.objects) ? j.objects : {})) {
      if (!isObj(o)) continue;
      const votes = (Array.isArray(o.votes) ? o.votes : []).filter((v) => isObj(v) && Number.isInteger(v.issue) && typeof v.user === "string"
        && KEYS.includes(v.class) && isoTime(v.at)).map((v) => ({ issue: v.issue, user: v.user.toLowerCase(), class: v.class, at: isoTime(v.at) }));
      let base = null;
      if (!Array.isArray(o.votes) && isObj(o.counts)) base = Object.fromEntries(KEYS.map((k) => [k, Number.isInteger(o.counts[k]) && o.counts[k] > 0 ? o.counts[k] : 0]));
      d.objects.set(id, { kind: KINDS.includes(o.kind) ? o.kind : null, votes, base });
    }
    return d;
  }
  const newer = (a, b) => a.at > b.at || (a.at === b.at && a.issue > b.issue);
  // Add issues to data (a copy is returned). An issue number at or below the snapshot's last_issue, or already counted,
  // is skipped: that is how live votes are never counted twice. One vote per user per object, the latest wins.
  function mergeIssues(data, issues, known = null) {
    const out = cloneData(data), ignored = Object.fromEntries(REASONS.map((r) => [r, 0]));
    const seen = new Set();
    for (const o of out.objects.values()) for (const v of o.votes) seen.add(v.issue);
    const list = (Array.isArray(issues) ? issues : []).slice().sort((a, b) => (numberOf(a) || 0) - (numberOf(b) || 0));
    let added = 0, replaced = 0, last = data.lastIssue;
    for (const issue of list) {
      const n = numberOf(issue);
      if (n !== null) {
        if (n <= data.lastIssue || seen.has(n)) { ignored.duplicate++; continue; }
        seen.add(n); last = Math.max(last, n);
      }
      const r = parseIssue(issue, known);
      if (!r.vote) { ignored[r.reason]++; continue; }
      const v = r.vote;
      let o = out.objects.get(v.id);
      if (!o) out.objects.set(v.id, (o = { kind: v.kind, votes: [], base: null }));
      const i = o.votes.findIndex((x) => x.user === v.user), slim = { issue: v.issue, user: v.user, class: v.class, at: v.at };
      if (i >= 0) {
        replaced++;
        if (!newer(slim, o.votes[i])) continue;
        o.votes[i] = slim;
      } else o.votes.push(slim);
      added++;
    }
    for (const o of out.objects.values()) o.votes.sort((a, b) => a.issue - b.issue);
    return { data: out, added, replaced, ignored, lastIssue: last };
  }
  // The aggregator's per-object output for these issues (the tests compare it with pipeline/aggregate_votes.py).
  function aggregate(issues, known = null) {
    const r = mergeIssues(emptyData(), issues, known);
    const objects = {};
    for (const id of [...r.data.objects.keys()].sort()) {
      const o = r.data.objects.get(id), s = tallyVotes(o);
      objects[id] = { kind: o.kind, counts: s.counts, voters: s.voters, consensus: s.consensus, agreement: s.agreement,
        last_vote: o.votes.reduce((m, v) => (v.at > m ? v.at : m), ""), votes: o.votes };
    }
    const votes = Object.values(objects).flatMap((o) => o.votes);
    return { objects, ignored: r.ignored, replaced: r.replaced, last_issue: r.lastIssue, votes_counted: votes.length,
      last_vote: votes.reduce((m, v) => (m === null || v.at > m ? v.at : m), null) };
  }

  // ---------- live votes from GitHub's search API (hosted site only) ----------
  function liveAllowed(loc) {
    if (!loc) return false;
    let p = null;
    try { p = new URLSearchParams(loc.search || "").get("votes"); } catch { /* odd location */ }
    if (p === "live") return true;
    if (p === "snapshot") return false;
    return loc.protocol === "https:" && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.(localhost|test)$/.test(String(loc.hostname || ""));
  }
  function liveUrl(data) {
    const q = `repo:${REPO} is:issue label:${LABEL}${data && data.lastVote ? ` created:>=${data.lastVote.slice(0, 10)}` : ""}`;
    return `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=100`;
  }
  const slimIssue = (i) => ({ number: i.number, title: i.title, body: i.body, created_at: i.created_at,
    user: isObj(i.user) ? { login: i.user.login, type: i.user.type } : null,
    labels: Array.isArray(i.labels) ? i.labels.map((l) => (isObj(l) ? { name: l.name } : l)) : undefined, pull_request: i.pull_request != null ? true : undefined });

  // ---------- the card ----------
  function cardHtml(v) {
    const p = `cls${v.uid}`, s = v.s, mine = v.mine;
    const head = v.heading ? `<h3 class="cls-title" id="${p}-h">${esc(v.heading)} <span class="tag-chip">Citizen science</span></h3>` : "";
    const ask = v.kind === "candidate" ? "Look at its track and the sky view, then pick what you see." : "Watch the time-lapse, then pick what you see.";
    const cons = s.voters === 0 ? `<p class="cls-consensus">No community votes yet.</p>`
      : s.consensus ? `<p class="cls-consensus is-yes">Community consensus: <b>${labelOf(s.consensus)}</b>, ${pct(s.agreement)} of ${plural(s.voters, "voter", "voters")} agree.</p>`
      : `<p class="cls-consensus">No consensus yet: ${plural(s.voters, "voter", "voters")} so far. A consensus needs at least ${v.minVoters} voters, ${pct(v.minAgreement)} of them agreeing.</p>`;
    const rows = CLASSES.map((c) => {
      const n = s.counts[c.key], on = !!mine && mine.cls === c.key, w = s.voters ? Math.round((n / s.voters) * 100) : 0;
      return `<li class="cls-row${on ? " is-mine" : ""}">`
        + `<button type="button" class="cls-btn" data-cls="${c.key}" aria-pressed="${on}" aria-describedby="${p}-${c.key} ${p}-${c.key}-n">${c.label}</button>`
        + `<span class="cls-help" id="${p}-${c.key}">${esc(c.help)}</span>`
        + `<span class="cls-count" id="${p}-${c.key}-n"><span class="cls-bar" aria-hidden="true"><i style="width:${w}%"></i></span>`
        + `<span class="cls-n">${n}<span class="visually-hidden"> ${n === 1 ? "vote" : "votes"}</span></span>`
        + `${on && s.mineCounted ? `<span class="cls-yours">incl. yours</span>` : ""}</span></li>`;
    }).join("");
    let you;
    if (!mine) you = `<p class="cls-status">Pick one. Your vote is kept on this device and counted here straight away.</p>`;
    else {
      const sent = mine.sent, same = !!sent && sent.cls === mine.cls;
      you = `<p class="cls-status">Your vote: <b>${labelOf(mine.cls)}</b>. `
        + (same ? `You opened the GitHub form for it on ${fmtDate(sent.at)}. Once that issue is submitted, it joins the community count at the next update.`
          : sent ? `You changed it after sending ${labelOf(sent.cls)}. Send it again: only your newest vote counts.`
          : "Saved on this device and counted here. Send it so it counts for everyone.")
        + `</p><a class="btn ${same ? "btn-ghost" : "btn-primary"} cls-send" data-send="1" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">`
        + `${same ? "Open the GitHub form again" : "Send my vote"} <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens GitHub in a new tab)</span></a>`;
    }
    const note = `<p class="cls-note">Sending a vote needs a free GitHub account and creates a public issue in the team's repository (${REPO}), showing your vote and your GitHub name.</p>`;
    const warn = v.storageOk ? "" : `<p class="cls-note cls-warn">This browser is not letting the site save, so your vote lasts only until you leave the page.</p>`;
    const src = v.state === "loading" || v.state === "idle" ? "Loading the community votes…"
      : v.state === "missing" ? "No community votes have been published yet. Your own vote still works."
      : v.state === "error" ? "The community votes could not be loaded. Your own vote still works."
      : `Community votes from GitHub${v.lastVote ? `, counted up to ${fmtDate(v.lastVote)}` : ""}${v.live ? `, plus ${plural(v.live, "newer vote", "newer votes")} fetched live` : ""}.`;
    return `${head}<p class="cls-ask">${ask}</p>${cons}`
      + `<div role="group" aria-label="Your classification of ${esc(v.name)}"><ul class="cls-rows">${rows}</ul></div>`
      + `<div class="cls-you">${you}${note}${warn}</div><p class="cls-src">${src}</p>`;
  }
  function badgeText(s) {
    return s && s.consensus ? `<span class="cls-badge" title="Community consensus: ${labelOf(s.consensus)}, ${pct(s.agreement)} of ${plural(s.voters, "voter", "voters")}">`
      + `<span class="visually-hidden">Community: </span>${labelOf(s.consensus)} ${pct(s.agreement)}</span>` : "";
  }

  // ---------- an instance: storage, data, cards and badges ----------
  function safe(f) { try { return f(); } catch { return null; } }
  function create(env = {}) {
    const E = {
      fetch: env.fetch !== undefined ? env.fetch : typeof root.fetch === "function" ? root.fetch.bind(root) : null,
      storage: env.storage !== undefined ? env.storage : safe(() => root.localStorage),
      session: env.session !== undefined ? env.session : safe(() => root.sessionStorage),
      location: env.location !== undefined ? env.location : root.location || null,
      document: env.document !== undefined ? env.document : root.document || null,
      now: env.now || (() => Date.now()),
      defer: env.defer || ((f) => (typeof root.setTimeout === "function" ? root.setTimeout(f, 0) : f())),
      dataUrl: env.dataUrl || DATA_URL,
    };
    const S = { data: emptyData(), state: "idle", live: 0, loading: null, cards: new Map(), boxes: new Set(), votes: null, storageOk: true, uid: 0 };

    // the visitor's own votes: { "candidate:10226-0001": { cls, at, sent: { cls, at } } }
    function myVotes() {
      if (S.votes) return S.votes;
      S.votes = {};
      let raw = null;
      try {
        if (!E.storage) throw new Error("no storage");
        raw = E.storage.getItem(STORE_KEY);
      } catch { S.storageOk = false; return S.votes; }
      let o = null;
      try { o = raw ? JSON.parse(raw) : null; } catch { o = null; }   // not ours or broken: start again
      for (const [k, m] of Object.entries(isObj(o) ? o : {})) {
        if (!isObj(m) || !KEYS.includes(m.cls)) continue;
        const sent = isObj(m.sent) && KEYS.includes(m.sent.cls) && isoTime(m.sent.at) ? { cls: m.sent.cls, at: isoTime(m.sent.at) } : null;
        S.votes[k] = { cls: m.cls, at: isoTime(m.at) || new Date(E.now()).toISOString(), ...(sent ? { sent } : {}) };
      }
      return S.votes;
    }
    function save() {
      try {
        if (!E.storage) throw new Error("no storage");
        E.storage.setItem(STORE_KEY, JSON.stringify(S.votes));
        S.storageOk = true;
      } catch { S.storageOk = false; }
    }
    const keyOf = (id, kind) => `${kind}:${id}`;
    const mine = (id, kind) => myVotes()[keyOf(id, kind)] || null;
    const nowIso = () => new Date(E.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    function vote(id, kind, cls) {   // pressing your current choice again takes the vote back
      if (!KEYS.includes(cls)) return null;
      const all = myVotes(), k = keyOf(id, kind), prev = all[k];
      if (prev && prev.cls === cls) delete all[k];
      else all[k] = { cls, at: nowIso(), ...(prev && prev.sent ? { sent: prev.sent } : {}) };
      save();
      return all[k] || null;
    }
    function markSent(id, kind) {
      const m = mine(id, kind);
      if (!m) return null;
      m.sent = { cls: m.cls, at: nowIso() };
      save();
      return m;
    }
    // Your vote is counted on this device until the community data holds it: after you sent it, a community vote for
    // the same class made since then is taken to be yours (GitHub does not tell the page who you are).
    function alreadyCounted(m, o) {
      if (!m || !m.sent || m.sent.cls !== m.cls || !o) return false;
      const since = Date.parse(m.sent.at) - SENT_SLACK_MS;
      return o.votes.some((v) => v.class === m.cls && Date.parse(v.at) >= since);
    }
    function summary(id, kind) {
      const o = S.data.objects.get(String(id)) || null, m = mine(id, kind), counted = !!m && !alreadyCounted(m, o);
      return { ...tallyVotes(o, S.data.minVoters, S.data.minAgreement, counted ? m.cls : null), mine: m ? m.cls : null, mineCounted: counted };
    }

    // ---- data: the snapshot, then (hosted site) newer votes from GitHub ----
    async function getSnapshot() {
      let r;
      try { r = await E.fetch(E.dataUrl, { cache: "no-cache" }); } catch { return { state: "error", data: emptyData() }; }
      if (!r || r.status === 404) return { state: "missing", data: emptyData() };
      if (!r.ok) return { state: "error", data: emptyData() };
      try { return { state: "ok", data: normalize(await r.json()) }; } catch { return { state: "error", data: emptyData() }; }
    }
    function cached(url) {
      const c = safe(() => JSON.parse(E.session.getItem(LIVE_KEY)));
      return isObj(c) && c.url === url && Array.isArray(c.items) && E.now() - c.t >= 0 && E.now() - c.t < LIVE_TTL_MS ? c.items : null;
    }
    async function getLive(data) {
      const url = liveUrl(data), hit = cached(url);
      if (hit) return hit;
      let items = [];
      try {
        const r = await E.fetch(url);
        if (!r || !r.ok) return [];               // 403/422/429: rate limit or a refused query; the snapshot stands
        const j = await r.json();
        items = Array.isArray(j && j.items) ? j.items.filter(isObj).map(slimIssue) : [];
      } catch { return []; }                      // offline, CORS, broken JSON
      safe(() => E.session.setItem(LIVE_KEY, JSON.stringify({ url, t: E.now(), items })));
      return items;
    }
    function load() {
      if (S.loading) return S.loading;
      S.state = "loading";
      S.loading = (async () => {
        if (!E.fetch) { S.state = "error"; refresh(); return S.data; }
        const snap = await getSnapshot();
        S.data = snap.data; S.state = snap.state;
        refresh();
        if (liveAllowed(E.location)) {
          const items = await getLive(S.data);
          const m = mergeIssues(S.data, items);
          if (m.added) { S.data = m.data; S.live = m.added; if (S.state !== "ok") S.state = "ok"; refresh(); }
        }
        return S.data;
      })().catch(() => { S.state = "error"; refresh(); return S.data; });
      return S.loading;
    }

    // ---- rendering ----
    const attr = (n, k) => (n && typeof n.getAttribute === "function" ? n.getAttribute(k) : null);
    const closest = (n, sel) => (n && typeof n.closest === "function" ? n.closest(sel) : null);
    function render(card) {
      if (!card.opts) return;
      const el = card.el, { id, kind } = card.opts, doc = E.document, active = doc && doc.activeElement;
      let again = null;   // keep the keyboard where it was: the same choice, or the send link
      if (active && typeof el.contains === "function" && el.contains(active)) {
        const c = attr(active, "data-cls");
        again = c ? `[data-cls="${c}"]` : attr(active, "data-send") !== null ? "[data-send]" : null;
      }
      const m = mine(id, kind);
      el.innerHTML = cardHtml({ ...card.opts, uid: card.uid, s: summary(id, kind), mine: m, url: m ? issueUrl(id, kind, m.cls) : null,
        storageOk: S.storageOk, state: S.state, live: S.live, lastVote: S.data.lastVote, minVoters: S.data.minVoters, minAgreement: S.data.minAgreement });
      if (again && typeof el.querySelector === "function") { const b = el.querySelector(again); if (b && typeof b.focus === "function") b.focus(); }
    }
    function decorate(box) {   // consensus badges on table rows: <tr data-id="…">, next to the row's class badge
      if (!box || typeof box.querySelectorAll !== "function") return;
      for (const row of box.querySelectorAll("tr[data-id]")) {
        for (const b of row.querySelectorAll(".cls-badge")) b.remove();
        const html = badgeText(summary(attr(row, "data-id"), "candidate"));
        if (!html) continue;
        const near = row.querySelector(".badge"), cell = (near && near.parentElement) || row.querySelector("th") || row;
        cell.insertAdjacentHTML("beforeend", html);
      }
    }
    function refresh() {
      for (const card of S.cards.values()) render(card);
      for (const box of S.boxes) decorate(box);
    }
    function onClick(card, e) {
      const t = e && e.target;
      if (!t || !card.opts) return;
      const b = closest(t, "[data-cls]");
      if (b) {
        vote(card.opts.id, card.opts.kind, attr(b, "data-cls") || (b.dataset && b.dataset.cls));
        refresh();
        return;
      }
      if (closest(t, "[data-send]")) {   // the link opens GitHub; redraw after the browser has followed it
        markSent(card.opts.id, card.opts.kind);
        E.defer(refresh);
      }
    }
    function onKey(card, e) {   // arrows, Home and End move between the five choices
      const go = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" }[e && e.key];
      const b = go !== undefined && closest(e.target, "[data-cls]");
      if (!b || typeof card.el.querySelectorAll !== "function") return;
      const list = [...card.el.querySelectorAll("[data-cls]")], i = list.indexOf(b);
      if (i < 0 || !list.length) return;
      const j = go === "first" ? 0 : go === "last" ? list.length - 1 : (i + go + list.length) % list.length;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();   // the explorer's own arrow keys step the time-lapse
      if (typeof list[j].focus === "function") list[j].focus();
    }
    function mount(el, opts) {
      if (!el || !opts || opts.id == null || String(opts.id) === "") return null;
      let card = S.cards.get(el);
      if (!card) {
        card = { el, uid: ++S.uid, opts: null };
        S.cards.set(el, card);
        el.addEventListener("click", (e) => onClick(card, e));
        el.addEventListener("keydown", (e) => onKey(card, e));
      }
      const id = String(opts.id);
      card.opts = { id, kind: KINDS.includes(opts.kind) ? opts.kind : "target", name: opts.name ? String(opts.name) : id,
        heading: opts.heading === false ? "" : String(opts.heading || "Classify this object") };
      el.hidden = false;
      render(card);
      load();
      return card;
    }
    function unmount(el) {
      const card = el && S.cards.get(el);
      if (card) card.opts = null;
      if (el) { el.hidden = true; el.innerHTML = ""; }
    }
    function badges(box) {
      if (!box) return;
      S.boxes.add(box);
      decorate(box);
      load();
    }
    return { mount, unmount, badges, load, ready: () => load(), summary, mine, vote, markSent, badgeHtml: (id) => badgeText(summary(id, "candidate")),
      state: () => ({ state: S.state, live: S.live, storageOk: S.storageOk, data: S.data }) };
  }

  let main = null;
  const page = () => main || (main = create());
  const API = {
    REPO, TEMPLATE, LABEL, DATA_URL, STORE_KEY, LIVE_KEY, LIVE_TTL_MS, MIN_VOTERS, MIN_AGREEMENT, CLASSES, KEYS, KINDS, REASONS,
    esc, classKey, labelOf, isoTime, fmtDate, formFields, parseIssue, issueUrl, consensusOf, tallyVotes, emptyData, normalize, mergeIssues,
    aggregate, liveAllowed, liveUrl, cardHtml, badgeText, create,
    // the page's own instance (window storage, fetch and location)
    mount: (el, opts) => page().mount(el, opts),
    unmount: (el) => page().unmount(el),
    badges: (box) => page().badges(box),
    ready: () => page().load(),
  };
  if (typeof module === "object" && module && module.exports) module.exports = API;
  root.Classify = API;
})(typeof window !== "undefined" ? window : globalThis);
