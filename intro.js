/* WANDERERS "Where are you in the universe?" intro.
 * Universe -> Milky Way -> Solar System (planets at today's positions) -> Earth (NASA Blue Marble / Black Marble,
 * real day-night line for this moment) -> your location (NASA GIBS imagery, nearest city, your time zone).
 * Facts: observable universe ~93 billion ly across; Milky Way ~100,000 ly across with the Sun ~26,000 ly from the
 * centre in the Orion Arm; planet mean longitudes from Standish (JPL) approximate elements; Earth's distance from
 * the Sun from the Astronomical Almanac solar formula. Everything renders on the phone. */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const D2R = Math.PI / 180;

export function earthFacts(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);          // AU
  const v = 29.7847 * Math.sqrt(2 / r - 1 / 1.000001018);                          // km/s (vis-viva)
  return { distanceAU: r, speedKms: v, distanceKm: r * 149597870.7 };
}

// Standish (JPL) mean longitude at J2000 and rate (deg / Julian century); semi-major axis (AU)
const PLANETS = [
  ["Mercury", 252.2503235, 149472.67411175, 0.387, 0x9a9a9a, 0.6],
  ["Venus", 181.9790995, 58517.81538729, 0.723, 0xe8cfa0, 0.9],
  ["Earth", 100.46457166, 35999.37244981, 1.0, 0x5aa9ff, 1.0],
  ["Mars", -4.55343205, 19140.30268499, 1.524, 0xd0603a, 0.7],
  ["Jupiter", 34.39644051, 3034.74612775, 5.203, 0xd8b98a, 2.2],
  ["Saturn", 49.95424423, 1222.49362201, 9.537, 0xe6d3a0, 1.9],
  ["Uranus", 313.23810451, 428.48202785, 19.19, 0x9fdbe6, 1.4],
  ["Neptune", -55.12002969, 218.45945325, 30.07, 0x5b7fe0, 1.4],
];

export async function playIntro({ container, caption, sub, getPlace, getRegionImage, onDone, reduced, slow = 1, from = "universe" }) {
  // ?intro=slow and ?introFrom=milkyway|solar|earth help when recording a demo video
  const order = ["universe", "milkyway", "solar", "earth"], startAt = Math.max(0, order.indexOf(from));
  const skipStage = (name) => order.indexOf(name) < startAt;
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
  const wait = (ms) => new Promise((ok) => { const t0 = performance.now(); const f = () => (skip || performance.now() - t0 >= ms ? ok() : requestAnimationFrame(f)); f(); });
  function animate(ms, fn) {
    return new Promise((ok) => {
      const t0 = performance.now();
      const f = () => {
        if (stop) return ok();
        const k = skip ? 1 : Math.min(1, (performance.now() - t0) / (ms * slow));
        fn(ease(k), k); renderer.render(scene, camera);
        k >= 1 ? ok() : requestAnimationFrame(f);
      };
      f();
    });
  }
  const fade = (to, ms = 400) => { container.style.transition = `opacity ${ms}ms`; container.style.opacity = to; return wait(ms); };
  let scene = new THREE.Scene();
  const disposeScene = (s) => s.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); });
  container.skip = () => { skip = true; };

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

  // ---------- 1. the observable universe (procedural galaxy field) ----------
  if (!reduced && !skipStage("universe")) {
    const pos = [], col = [];
    for (let i = 0; i < 9000; i++) {
      const r = 60 * Math.cbrt(Math.random()), th = Math.random() * 2 * Math.PI, ph = Math.acos(2 * Math.random() - 1);
      // filaments: bunch galaxies along a few great circles
      const f = Math.random() < 0.55 ? Math.floor(Math.random() * 6) : -1;
      const p = f < 0 ? [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)]
        : [r * Math.cos(th + f), (Math.random() - 0.5) * 6 + f * 3 - 9, r * Math.sin(th + f)];
      pos.push(...p);
      const c = 0.55 + Math.random() * 0.45; col.push(c, c * (0.85 + Math.random() * 0.15), c * (0.9 + Math.random() * 0.2));
    }
    scene.add(points(pos, col, 0.35));
    say("The observable universe", "About <b>93 billion light-years</b> across and full of galaxies. One of them is ours.");
    await animate(3200, (e) => { camera.position.set(0, 4, 90 - 80 * e); camera.lookAt(0, 0, 0); scene.rotation.y = e * 0.6; });
    await fade(0, 300);
  }

  // ---------- 2. the Milky Way (procedural spiral) ----------
  disposeScene(scene); scene = new THREE.Scene(); container.style.opacity = 1;
  const sunPos = new THREE.Vector3(26 * Math.cos(2.4), 0, 26 * Math.sin(2.4));     // 26,000 ly from the centre
  if (!reduced && !skipStage("milkyway")) {
    const pos = [], col = [];
    for (let i = 0; i < 26000; i++) {
      const arm = i % 4, r = Math.pow(Math.random(), 0.7) * 50;
      const a = arm * Math.PI / 2 + Math.log(1 + r) * 1.9 + (Math.random() - 0.5) * (0.5 + 6 / (r + 2));
      const bulge = Math.random() < 0.18;
      const rr = bulge ? Math.random() * 7 : r;
      const p = bulge ? [rr * Math.cos(i), (Math.random() - 0.5) * 3, rr * Math.sin(i)] : [rr * Math.cos(a), (Math.random() - 0.5) * 1.2, rr * Math.sin(a)];
      pos.push(...p);
      const warm = bulge || rr < 9;
      col.push(warm ? 1 : 0.65 + Math.random() * 0.3, warm ? 0.85 : 0.75 + Math.random() * 0.2, warm ? 0.6 : 1);
    }
    scene.add(points(pos, col, 0.28));
    const you = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.8, 48), new THREE.MeshBasicMaterial({ color: 0xffb547, side: THREE.DoubleSide, transparent: true }));
    you.position.copy(sunPos); you.rotation.x = -Math.PI / 2; scene.add(you);
    say("The Milky Way", "About <b>100,000 light-years</b> across. Our Sun sits in the <b>Orion Arm</b>, about <b>26,000 light-years</b> from the centre (orange ring).");
    await animate(3600, (e) => {
      camera.position.set(0 + sunPos.x * e * 0.7, 70 - 55 * e, 40 + (sunPos.z - 40) * e * 0.8);
      camera.lookAt(sunPos.x * e, 0, sunPos.z * e);
      you.scale.setScalar(1 + 0.3 * Math.sin(e * 20));
    });
    await fade(0, 300);
  }

  // ---------- 3. the Solar System, today ----------
  disposeScene(scene); scene = new THREE.Scene(); container.style.opacity = 1;
  const T = (now.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
  const ef = earthFacts(now);
  const rs = (a) => 4 * Math.sqrt(a);                                     // compressed distances for display
  let earthXYZ = null;
  if (!reduced && !skipStage("solar")) {
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.1, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffd36b })));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.8, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffa83d, transparent: true, opacity: 0.25 }));
    scene.add(glow);
    for (const [name, L0, rate, a, color, size] of PLANETS) {
      const L = (L0 + rate * T) * D2R, r = rs(a);
      const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 128 }, (_, i) => new THREE.Vector3(r * Math.cos(i / 128 * 2 * Math.PI), 0, -r * Math.sin(i / 128 * 2 * Math.PI)))),
      new THREE.LineBasicMaterial({ color: name === "Earth" ? 0x5aa9ff : 0x2a3a5c, transparent: true, opacity: name === "Earth" ? 0.9 : 0.6 }));
      scene.add(orbit);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.22 * size, 16, 12), new THREE.MeshBasicMaterial({ color }));
      p.position.set(r * Math.cos(L), 0, -r * Math.sin(L)); scene.add(p);
      if (name === "Earth") earthXYZ = p.position.clone();
    }
    say("The Solar System, right now", `Planets shown at today's positions. Earth is <b>${ef.distanceAU.toFixed(3)} AU</b> ` +
      `(${(ef.distanceKm / 1e6).toFixed(1)} million km) from the Sun, moving at <b>${ef.speedKms.toFixed(1)} km/s</b>.`);
    await animate(3600, (e) => {
      const far = new THREE.Vector3(0, 55, 30), near = earthXYZ.clone().add(new THREE.Vector3(0, 2, 3));
      camera.position.lerpVectors(far, near, e); camera.lookAt(new THREE.Vector3().lerpVectors(new THREE.Vector3(), earthXYZ, e));
    });
    await fade(0, 300);
  }

  // ---------- 4. Earth, now (NASA Blue Marble day + Black Marble night, real terminator) ----------
  disposeScene(scene); scene = new THREE.Scene(); container.style.opacity = 1;
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

  const place = await Promise.race([getPlace(), new Promise((ok) => setTimeout(() => ok(null), 6000))]) || { lat: 47.61, lon: -122.33, approx: true };
  const pin = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffb547 }));
  pin.position.copy(ll(place.lat, place.lon, 1.005)); scene.add(pin);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 40), new THREE.MeshBasicMaterial({ color: 0xffb547, side: THREE.DoubleSide, transparent: true }));
  ring.position.copy(ll(place.lat, place.lon, 1.006)); ring.lookAt(ll(place.lat, place.lon, 2)); scene.add(ring);
  const dayNight = (() => { const p = ll(place.lat, place.lon), s = ll(subLat, subLon); return p.dot(s) > 0 ? "daytime" : "night"; })();
  say("Earth, right now", `The real day/night line for this moment (NASA Blue Marble and Black Marble imagery). ` +
    `Where you are it is <b>${dayNight}</b>.`);
  const start = ll(place.lat + 15, place.lon + 70, 4.2), end = ll(place.lat, place.lon, 1.9);
  await animate(reduced ? 1 : 4200, (e, k) => {
    const dir = start.clone().normalize().lerp(end.clone().normalize(), e).normalize();
    camera.position.copy(dir.multiplyScalar(4.2 + (1.9 - 4.2) * e)); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
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
