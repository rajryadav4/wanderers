/* Day / Night Observatory toggle. The first theme is set by a tiny inline script in <head> (no flash);
 * this file wires the button, saves the choice and follows the OS until the visitor picks one. */
(() => {
  const KEY = "wanderers-theme", root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const label = (t) => (t === "dark" ? "Switch to Day Observatory (light theme)" : "Switch to Night Observatory (dark theme)");

  function apply(t, animate) {
    if (animate) { root.classList.add("theme-anim"); setTimeout(() => root.classList.remove("theme-anim"), 320); }
    root.dataset.theme = t;
    document.querySelectorAll(".theme-toggle").forEach((b) => { b.setAttribute("aria-label", label(t)); b.setAttribute("aria-pressed", t === "dark"); });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === "dark" ? "#0B1422" : "#F6F8FB";
    document.dispatchEvent(new CustomEvent("themechange", { detail: t }));
  }
  apply(root.dataset.theme || (mq.matches ? "dark" : "light"), false);

  document.querySelectorAll(".theme-toggle").forEach((b) => b.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, t); } catch { /* private mode: still switch */ }
    apply(t, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }));
  mq.addEventListener?.("change", (e) => { if (!saved()) apply(e.matches ? "dark" : "light", true); });

  const nt = document.querySelector(".nav-toggle"), nav = document.querySelector(".site-nav");
  if (nt && nav) {
    nt.addEventListener("click", () => { const o = nav.classList.toggle("open"); nt.setAttribute("aria-expanded", o); });
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) { nav.classList.remove("open"); nt.setAttribute("aria-expanded", "false"); } });
  }
})();
