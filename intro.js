/* WANDERERS "Where are you?" intro, built only from real imagery: the NASA Blue Marble (day) and Black Marble
 * (night lights) Earth with the real day/night line for this moment, swinging in to your location, then NASA GIBS
 * satellite imagery of your region with your nearest city, time zone and sidereal time. Earth's distance and speed
 * from the Astronomical Almanac solar formula. Everything renders on the phone. */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const D2R = Math.PI / 180;

export function earthFacts(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);          // AU
  const v = 29.7847 * Math.sqrt(2 / r - 1 / 1.000001018);                          // km/s (vis-viva)
  return { distanceAU: r, speedKms: v, distanceKm: r * 149597870.7 };
}

export async function playIntro({ container, caption, sub, getPlace, getRegionImage, onDone, reduced, slow = 1 }) {
  // ?intro=slow plays it more slowly (handy when recording a demo video)
  const W = () => container.clientWidth, H = () => container.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W(), H());
  container.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(50, W() / H(), 0.01, 5000);
  const onResize = () => { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); };
  window.addEventListener("resize", onResize);
  const now = new Date();
  let stop = false, skip = false;
  const say = (a, b) => { caption.textContent = a; sub.innerHTML = b || ""; };
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const wait = (ms) => new Promise((ok) => { if (skip) return ok(); const t0 = performance.now(); const tick = () => (skip || performance.now() - t0 >= ms ? ok() : setTimeout(tick, 50)); tick(); });
  function animate(ms, fn) {
    if (skip) { fn(1, 1); renderer.render(scene, camera); return Promise.resolve(); }   // Skip never waits for a frame
    return new Promise((ok) => {
      const t0 = performance.now();
      let done = false; const finish = () => { if (!done) { done = true; current = null; ok(); } };
      current = () => { fn(1, 1); renderer.render(scene, camera); finish(); };   // Skip mid-animation
      const f = () => {
        if (done) return;
        if (stop) return finish();
        const k = skip ? 1 : Math.min(1, (performance.now() - t0) / (ms * slow));
        fn(ease(k), k); renderer.render(scene, camera);
        k >= 1 ? finish() : requestAnimationFrame(f);
      };
      f();
    });
  }
  const fade = (to, ms = 400) => { container.style.transition = `opacity ${ms}ms`; container.style.opacity = to; return wait(ms); };
  let scene = new THREE.Scene();
  const disposeScene = (s) => s.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); });
  let skipNow; const skipped = new Promise((ok) => (skipNow = ok));
  let current = null;
  container.skip = () => { skip = true; skipNow(null); if (current) current(); };

  const dot = (() => {        // soft round sprite so stars and galaxies are not squares
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,.8)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
  })();
  const points = (pos, col, size) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ size: size * 2.2, map: dot, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  };

  const ef = earthFacts(now);
  container.style.opacity = 1;

  // ---------- Earth, now (NASA Blue Marble day + Black Marble night, real terminator) ----------
  const loader = new THREE.TextureLoader();
  const [day, night] = await Promise.all([loader.loadAsync("data/earth/day.jpg"), loader.loadAsync("data/earth/night.jpg")]);
  day.colorSpace = night.colorSpace = THREE.SRGBColorSpace;
  // subsolar point = where the Sun is overhead right now
  const sunEq = window.Sky.sun(window.Sky.jd(now)), gmst = window.Sky.gmst(window.Sky.jd(now));
  const subLon = ((sunEq.ra - gmst + 540) % 360) - 180, subLat = sunEq.dec;
  const ll = (lat, lon, r = 1) => new THREE.Vector3(r * Math.cos(lat * D2R) * Math.cos(lon * D2R), r * Math.sin(lat * D2R), -r * Math.cos(lat * D2R) * Math.sin(lon * D2R));
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { day: { value: day }, night: { value: night }, sun: { value: ll(subLat, subLon) } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv=uv; vN=normalize(position); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=normalize(-mv.xyz);
      gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D day; uniform sampler2D night; uniform vec3 sun; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float d=dot(normalize(vN), normalize(sun)); float k=smoothstep(-0.12,0.12,d);
      vec3 cd=pow(texture2D(day,vUv).rgb,vec3(0.8))*(0.6+0.75*max(d,0.0)); vec3 cn=texture2D(night,vUv).rgb*1.4;
      vec3 c=mix(cn,cd,k); gl_FragColor=vec4(c,1.0); }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMat);
  scene.add(earth);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 48), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `varying vec3 vN; void main(){ float i=pow(0.75-dot(vN,vec3(0,0,1.0)),3.0); gl_FragColor=vec4(0.35,0.62,1.0,1.0)*i; }`,
  }));
  scene.add(atmo);
  // a few background stars
  { const pos = [], col = []; for (let i = 0; i < 1500; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(80); pos.push(v.x, v.y, v.z); col.push(0.8, 0.85, 1); } scene.add(points(pos, col, 0.25)); }

  const place = await Promise.race([getPlace(), skipped, new Promise((ok) => setTimeout(() => ok(null), 6000))]) || { lat: 47.61, lon: -122.33, approx: true };
  const pin = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffb547 }));
  pin.position.copy(ll(place.lat, place.lon, 1.005)); scene.add(pin);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 40), new THREE.MeshBasicMaterial({ color: 0xffb547, side: THREE.DoubleSide, transparent: true }));
  ring.position.copy(ll(place.lat, place.lon, 1.006)); ring.lookAt(ll(place.lat, place.lon, 2)); scene.add(ring);
  let said = false;
  const dayNight = (() => { const p = ll(place.lat, place.lon), s = ll(subLat, subLon); return p.dot(s) > 0 ? "daytime" : "night"; })();
  say("Earth, right now", `NASA Blue Marble by day, Black Marble city lights by night, with the real day/night line for this ` +
    `moment. Earth is <b>${ef.distanceAU.toFixed(3)} AU</b> from the Sun, moving at <b>${ef.speedKms.toFixed(1)} km/s</b>.`);
  // swing in from the far side of the planet to your longitude (spherical interpolation of the view direction)
  const a0 = new THREE.Vector3().copy(ll(place.lat * 0.3 + 10, place.lon + 170)).normalize(), a1 = ll(place.lat, place.lon).normalize();
  const ang = a0.angleTo(a1), axis = new THREE.Vector3().crossVectors(a0, a1).normalize();
  await animate(reduced ? 1 : 6000, (e, k) => {
    const dir = a0.clone().applyAxisAngle(axis, ang * e);
    camera.position.copy(dir.multiplyScalar(6.5 + (1.9 - 6.5) * e)); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
    if (k > 0.6 && !said) { said = true; say(`Finding you…`, `Where you are it is <b>${dayNight}</b> right now.`); }
    const dist = camera.position.length() - 1;
    ring.scale.setScalar((1 + 0.5 * Math.abs(Math.sin(k * 12))) * Math.min(1, dist / 0.9)); pin.scale.setScalar(Math.min(1, dist / 0.9));
  });

  // ---------- 5. you are here ----------
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -now.getTimezoneOffset() / 60;
  const local = now.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const lst = ((window.Sky.gmst(window.Sky.jd(now)) + place.lon) % 360 + 360) % 360;
  const hm = (deg) => `${String(Math.floor(deg / 15)).padStart(2, "0")}h${String(Math.floor((deg / 15 % 1) * 60)).padStart(2, "0")}m`;
  const where = place.city ? `${place.city}, ${place.region}` : "your location";
  say(`You are here: ${where}`,
    `${Math.abs(place.lat).toFixed(2)}°${place.lat >= 0 ? "N" : "S"}, ${Math.abs(place.lon).toFixed(2)}°${place.lon >= 0 ? "E" : "W"}` +
    `${place.approx ? " (approximate: location not shared)" : ""} · <b>${local}</b> ${tz} (UTC${offset >= 0 ? "+" : ""}${offset})` +
    ` · local sidereal time ${hm(lst)}`);
  const img = getRegionImage ? await Promise.race([getRegionImage(), new Promise((ok) => setTimeout(() => ok(null), reduced ? 10 : 2500))]) : null;
  if (img && !skip) {
    container.classList.add("with-region");
    const el = document.createElement("div");
    el.className = "region"; el.style.backgroundImage = `url(${img})`;
    el.innerHTML = '<div class="region-pin"></div><div class="region-credit">NASA GIBS · Blue Marble</div>';
    container.appendChild(el);
    await wait(60); el.classList.add("in");
    await wait(2600);
  } else {
    await animate(reduced ? 1 : 1800, (e, k) => {
      camera.position.copy(ll(place.lat, place.lon, 1.9 - 0.35 * e)); camera.lookAt(0, 0, 0);
      const dist = camera.position.length() - 1, sc = Math.min(1, dist / 0.9);
      pin.scale.setScalar(sc); ring.scale.setScalar(sc * (1 + 0.5 * Math.abs(Math.sin(k * 12))));
    });
    await wait(skip ? 0 : 1200);
  }
  stop = true;
  window.removeEventListener("resize", onResize);
  disposeScene(scene); renderer.dispose(); renderer.domElement.remove();
  onDone && onDone(place);
}
