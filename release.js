/* SPHEREx data status line: the current SPHEREx release at NASA IRSA, how recent our prepared data is, and when it
 * was last synced and checked, for example
 *   "SPHEREx Quick Release 3 · data through Sep 2026 · last synced 15 Nov 2026 · checked 15 Nov 2026"
 * plus a short note when IRSA has a release that some prepared targets were not built from yet.
 *
 * Reads data/spherex_release.json (written by pipeline/spherex_releases.py) and fills the element with
 * id="spherexStatus" (observatory.html and index.html). Needs nothing from app.js or home.js.
 * Works offline and fails quietly: if the file is missing, broken or unreadable, the line stays hidden and nothing
 * is logged. Dates are shown in UTC, as the file stores them.
 *
 * Works in the browser (window.SpherexRelease) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  const FILE = "data/spherex_release.json";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // "2026-09-07", "2026-11-15T06:10:33Z" or with an offset -> Date (UTC), else null
  function parseDate(s) {
    if (typeof s !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim());
    if (!m) return null;
    const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    let t = Date.UTC(y, mo - 1, d, h, mi, se);
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1) return null;          // 2026-02-31 and the like
    if (m[7] && m[7] !== "Z") {
      const o = /([+-])(\d{2}):?(\d{2})/.exec(m[7]);
      t -= (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60000;
    }
    return new Date(t);
  }

  const fmtDay = (s) => { const d = parseDate(s); return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : ""; };
  const fmtMonth = (s) => { const d = parseDate(s); return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : ""; };
  const isoDay = (s) => { const d = parseDate(s); return d ? d.toISOString().slice(0, 10) : ""; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortLabel = (l) => String(l).replace(/^SPHEREx\s+/, "");

  function currentLabel(st) {
    if (typeof st.current_label === "string" && st.current_label.trim()) return st.current_label.trim();
    const rel = Array.isArray(st.releases) ? st.releases.find((r) => r && r.name === st.current) : null;
    return rel && typeof rel.label === "string" && rel.label.trim() ? rel.label.trim() : "";
  }

  /* The status file -> what to show: { parts: [{ text, date? }], note, fresh, title }, or null when the file does not
   * say which release is current (then nothing is shown). */
  function describe(st) {
    if (!st || typeof st !== "object" || Array.isArray(st)) return null;
    const label = currentLabel(st);
    if (!label) return null;
    const parts = [{ text: label, cls: "spx-rel" }];
    const through = fmtMonth(st.data_through);
    if (through) parts.push({ text: "data through ", date: through, iso: isoDay(st.data_through) });
    const synced = fmtDay(st.synced);
    if (synced) parts.push({ text: "last synced ", date: synced, iso: isoDay(st.synced) });
    const checked = fmtDay(st.checked), tried = fmtDay(st.last_attempt);
    if (checked) parts.push({ text: "checked ", date: checked, iso: isoDay(st.checked) });
    else if (st.error && tried) parts.push({ text: "IRSA release check failed ", date: tried, iso: isoDay(st.last_attempt), cls: "spx-fail" });

    let note = null;
    if (st.new_release_available === true) {
      const labels = (Array.isArray(st.new_releases) ? st.new_releases : [])
        .map((r) => (r && typeof r.label === "string" ? shortLabel(r.label) : "")).filter(Boolean);
      const what = labels.length ? labels.join(", ") : "a newer release";
      const behind = st.targets_behind && typeof st.targets_behind === "object" ? Object.keys(st.targets_behind).length : 0;
      const total = Number.isInteger(st.targets) && st.targets > 0 ? st.targets : 0;
      note = behind && total
        ? `New data available at IRSA: ${what} is not yet in ${behind} of ${total} targets.`
        : `New data available at IRSA: ${what} is not yet in these views.`;
    }
    let title = "SPHEREx data status, from data/spherex_release.json.";
    if (st.error && typeof st.error === "string") title += " Last check: " + st.error;
    return { parts, note, fresh: !note, title };
  }

  function render(st) {
    const d = describe(st);
    if (!d) return "";
    const items = d.parts.map((p) => {
      const body = p.date ? `${esc(p.text)}<time datetime="${esc(p.iso)}">${esc(p.date)}</time>` : esc(p.text);
      return `<span class="spx-part${p.cls ? " " + p.cls : ""}">${body}</span>`;
    });
    return `<span class="spx-dot${d.fresh ? "" : " spx-dot-new"}" aria-hidden="true"></span>` +
      `<span class="spx-line">${items.join('<span class="spx-sep" aria-hidden="true"> · </span>')}</span>` +
      (d.note ? `<span class="spx-new">${esc(d.note)}</span>` : "");
  }

  // Fetch and parse the status file. Resolves to the object, or null on any problem (never rejects, never logs).
  function load(fetchFn, url) {
    try {
      if (typeof fetchFn !== "function") return Promise.resolve(null);
      return Promise.resolve(fetchFn(url || FILE, { cache: "no-cache" }))
        .then((r) => (r && r.ok ? r.json() : null))
        .then((j) => (j && typeof j === "object" && !Array.isArray(j) ? j : null))
        .catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function apply(el, st) {
    if (!el) return false;
    const html = render(st);
    if (!html) { el.hidden = true; return false; }
    el.innerHTML = html;
    const d = describe(st);
    el.setAttribute("title", d.title);
    el.classList.toggle("spx-has-new", !d.fresh);
    el.hidden = false;
    return true;
  }

  function init(doc, fetchFn) {
    const el = doc && typeof doc.getElementById === "function" ? doc.getElementById("spherexStatus") : null;
    if (!el) return Promise.resolve(false);
    return load(fetchFn).then((st) => (st ? apply(el, st) : false)).catch(() => false);
  }

  const api = { FILE, parseDate, fmtDay, fmtMonth, describe, render, load, apply, init };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.SpherexRelease = api;
    if (root.document) init(root.document, typeof root.fetch === "function" ? root.fetch.bind(root) : null);
  }
})(typeof window !== "undefined" ? window : globalThis);
