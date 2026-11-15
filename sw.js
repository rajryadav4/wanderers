/* WANDERERS Sky Compass service worker: keeps sky pictures on the phone. Registered by realsky.js (the Sky Compass page) only.
 *
 * It answers three kinds of request and lets everything else go straight to the network, so a new
 * deploy of the app is never served stale:
 *   1. HiPS sky tiles from IRSA (or the ESA mirror): saved places first, then recent pictures, then the network.
 *      Pictures fetched from the network are kept as "recent": at most 40 MB or 1,200 files, oldest
 *      dropped first, and all of them dropped 7 days after the first one was stored.
 *   2. The pinned Aladin Lite and three.js scripts (they never change): cache first, so Deep and the page work with no signal.
 *   3. The compass page itself (SHELL below): fetched and stored when the worker installs, then network first with
 *      the stored copy when there is no answer in 4 seconds. So the page opens with no signal after one visit,
 *      and a new deploy still shows at once when there is one.
 * Saved places ("wanderers-sky-saved-v1") are written by realsky.js and are never trimmed here. */
importScripts("hips.js");

const CFG = Hips.CONFIG;                               // shared with realsky.js
const [TILES, TILES2] = CFG.tileRoots;
const ALADIN = CFG.aladin;
// The intro (intro.js) imports this pinned three.js; compass.js imports intro.js, so the page cannot start offline without it.
const THREE_JS = "https://cdn.jsdelivr.net/npm/three@0.170.0/";
const AUTO = CFG.caches.recent, SAVED = CFG.caches.saved, DATA = CFG.caches.pinned;
const { maxFiles: MAX_FILES, maxBytes: MAX_BYTES, maxAgeMs: MAX_AGE_MS } = CFG.recent, FALLBACK_BYTES = CFG.surveys.visible.tile;
const META = TILES + "__wanderers_meta__";            // a made-up URL inside the cache: when it was started
const SHELL_CACHE = CFG.caches.shell;
const SHELL = ["compass.html", "compass.css", "compass.js", "brand.css", "theme.js", "favicon.svg", "sky.js", "search.js", "starcore.js",
  "pathview.js", "telescope.js", "orient.js", "intro.js", "skyview.js", "hips.js", "realsky.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "data/skystars.json", "data/stars.json", "data/constellations.json", "data/index.json", "data/declination.json", "data/earth/cities.json", "data/paths.json"].map((f) => new URL(f, self.registration.scope).href);
const IS_SHELL = new Set(SHELL);
const bare = (url) => { const u = new URL(url); u.search = ""; u.hash = ""; return u.href; };   // compass.html?target=... is compass.html

// One by one, not addAll: with addAll a single missing file left the page with nothing stored at all.
self.addEventListener("install", (e) => e.waitUntil(caches.open(SHELL_CACHE).then((c) => Promise.all(SHELL.map((u) =>
  fetch(new Request(u, { cache: "reload" })).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([self.clients.claim(), expire()])));

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  if (e.request.method !== "GET") return;
  if (url.startsWith(TILES) || url.startsWith(TILES2)) e.respondWith(tile(url, e));
  else if (url.startsWith(ALADIN) || url.startsWith(THREE_JS)) e.respondWith(pinned(url));
  else if (IS_SHELL.has(bare(url))) e.respondWith(fresh(e.request));
});

async function tile(url, e) {
  const hit = (await caches.match(url, { cacheName: SAVED, ignoreVary: true })) || (await caches.match(url, { cacheName: AUTO, ignoreVary: true }));
  if (hit) return hit;
  // Always a CORS fetch: an opaque copy cannot be measured and costs megabytes of quota per file.
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (res.ok) e.waitUntil(keep(url, res.clone()));
  return res;
}

async function pinned(url) {
  const hit = (await caches.match(url, { cacheName: SAVED })) || (await caches.match(url, { cacheName: DATA }));
  if (hit) return hit;
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (res.ok) (await caches.open(DATA)).put(url, res.clone());
  return res;
}

async function fresh(request) {
  const cache = await caches.open(SHELL_CACHE), key = bare(request.url);
  try {
    const res = await fetch(request, { signal: AbortSignal.timeout(4000) });
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

let puts = 0;
async function keep(url, res) {
  const cache = await caches.open(AUTO);
  if (!(await cache.match(META))) await cache.put(META, new Response(JSON.stringify({ created: Date.now() })));
  await cache.put(url, res);
  if (++puts % 25 === 0) await trim(cache);
}

// Test hook for test/browser/realsky.mjs: run the trim and the 7-day rule now, with limits the check chooses
// ({ files, bytes, ageMs }). It can only make the recent cache smaller, so it is harmless in normal use.
self.addEventListener("message", (e) => {
  if (!e.data || e.data.op !== "expire" || !e.ports[0]) return;
  e.waitUntil(expire(e.data).then(() => e.ports[0].postMessage("done")));
});

async function trim(cache, lim = {}) {
  const keys = (await cache.keys()).filter((k) => k.url !== META), entries = [];
  for (const k of keys) {
    const r = await cache.match(k);
    entries.push({ url: k.url, bytes: +(r && r.headers.get("content-length")) || FALLBACK_BYTES });
  }
  for (const url of Hips.evict(entries, lim.files ?? MAX_FILES, lim.bytes ?? MAX_BYTES)) await cache.delete(url);   // cache.keys() is oldest first
}

async function expire(lim = {}) {
  if (!(await caches.has(AUTO))) return;
  const cache = await caches.open(AUTO), meta = await cache.match(META);
  const created = meta ? (await meta.json()).created : 0;
  if (Date.now() - created > (lim.ageMs ?? MAX_AGE_MS)) await caches.delete(AUTO); else await trim(cache, lim);
}
