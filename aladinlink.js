/* Link that opens a patch of sky in Aladin Lite (the CDS sky viewer, Strasbourg).
 *
 * The page at https://aladin.cds.unistra.fr/AladinLite/ reads these query parameters for its first view
 * (checked in the page's own script): ra (0 to 360 degrees), dec (-90 to 90), fov (degrees, above 0 up to 180)
 * and hips (the sky survey to show). Values outside those ranges are ignored by the page, so they are brought
 * into range here.
 *
 * Works in the browser (window.AladinLink) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  "use strict";

  const BASE = "https://aladin.cds.unistra.fr/AladinLite/";
  const DEFAULT_SURVEY = "P/allWISE/color";   // WISE infrared sky, the same mission as the 2010 frame

  const num = (v, name) => {
    const n = Number(v);
    if (v === null || v === undefined || v === "" || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };

  // opts: { ra, dec, fovArcsec, survey? }  ->  URL string
  function url(opts) {
    const o = opts || {};
    const ra = ((num(o.ra, "ra") % 360) + 360) % 360;                   // wrap into 0..360
    const dec = Math.min(90, Math.max(-90, num(o.dec, "dec")));
    const fov = Math.min(180, Math.max(0.0001, num(o.fovArcsec, "fovArcsec") / 3600));   // arcseconds -> degrees
    const q = new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov: String(+fov.toFixed(4)), hips: o.survey || DEFAULT_SURVEY });
    return `${BASE}?${q.toString()}`;
  }

  const api = { url, BASE, DEFAULT_SURVEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AladinLink = api;
})(typeof window !== "undefined" ? window : globalThis);
