// Environment (V3 C2, D4) — app-owned day/night + weather director. Survives
// world swaps; per-world pieces (roads wetness, street lamps, buildings) are
// reached lazily through getWorld() on every apply.
//
// D4 contract: apply() is a PURE function of (timeOfDay, weather mode,
// intensity) — every property (sky, fog, hemi, sun intensity/color/arc,
// wetness, lamp glow, window emissive, headlight gate, shadows) is recomputed
// from the precomputed gradient stops on each call, with NO save/restore.
// Returning to noon/despejado therefore restores the legacy scene exactly
// (the h=12 stop mirrors scene.js values byte-for-byte — see config.js).
//
// Weather physics (D5) live in sim/idm.js; here we only mutate
// CONFIG.weather.current IN PLACE (idm.js holds a live reference).
// Zero per-frame allocations: lerps write into module-level scratch Colors.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRain } from './rain.js';

// Legacy sun offset at noon = (0.4, 0.7, -0.3) * span (scene.js frame()).
// Arc: fixed radius, azimuth 15°/h around the noon bearing, elevation
// theta0 * sin(day phase) — at h=12 this reproduces the legacy position.
const SUN_R = Math.sqrt(0.4 * 0.4 + 0.7 * 0.7 + 0.3 * 0.3);
const SUN_THETA0 = Math.asin(0.7 / SUN_R);
const SUN_PHI0 = Math.atan2(-0.3, 0.4);

const _sky = new THREE.Color();
const _fog = new THREE.Color();
const _sunC = new THREE.Color();
const _rainSky = new THREE.Color();
const _emis = new THREE.Color();

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function createEnvironment(view, getWorld) {
  const D = CONFIG.dayNight;
  const scene = view.scene;
  const sun = view.sun;
  const hemi = scene.children.find((o) => o.isHemisphereLight);

  // Baseline fog distances captured BEFORE any modification (legacy scene).
  const baseFogNear = scene.fog.near;
  const baseFogFar = scene.fog.far;

  // Precompute gradient stop arrays (one-time): hours + Colors + scalars.
  const stops = D.stops;
  const hs = stops.map((st) => st.h);
  const skyC = stops.map((st) => new THREE.Color(st.sky));
  const fogC = stops.map((st) => new THREE.Color(st.fog));
  const sunCC = stops.map((st) => new THREE.Color(st.sunColor));
  const hemiI = stops.map((st) => st.hemi);
  const sunII = stops.map((st) => st.sunI);

  const rain = createRain();
  scene.add(rain.points);

  let userShadows = !!sun.castShadow; // GUI «Sombras» routes through here now
  let lastSimTime = 0;
  let autoAnchorSim = 0;
  let autoAnchorHour = D.timeOfDay;
  let needAnchor = false;
  let applyGate = 0;

  const state = {
    nightFactor: 0,
    sunIntensity: sun.intensity,
    headlightFactor: 0,
    get headlightCount() {
      const w = getWorld();
      return w && w.vehiclesMesh ? w.vehiclesMesh.headlightCount || 0 : 0;
    },
    get rainVisible() {
      return rain.visible;
    },
    get lampGlowVisible() {
      const w = getWorld();
      return w && w.streetLampsMesh ? w.streetLampsMesh.glowsVisible : false;
    },
  };

  /** D4 pure apply: recompute EVERYTHING from (hour, mode, intensity). */
  function apply() {
    const h = D.timeOfDay;
    const Rw = CONFIG.weather.rain;
    const k = CONFIG.weather.mode === 'lluvia' ? CONFIG.weather.intensity : 0;

    // -- Gradient bracket: stops[i].h <= h < stops[i+1].h (t=0 at a stop, so
    // landing exactly on h=12 yields the stop values EXACTLY — idempotence).
    let i = 0;
    while (i < hs.length - 2 && h >= hs[i + 1]) i++;
    const t = Math.min(Math.max((h - hs[i]) / (hs[i + 1] - hs[i]), 0), 1);
    _sky.copy(skyC[i]).lerp(skyC[i + 1], t);
    _fog.copy(fogC[i]).lerp(fogC[i + 1], t);
    _sunC.copy(sunCC[i]).lerp(sunCC[i + 1], t);
    let hemiInt = hemiI[i] + (hemiI[i + 1] - hemiI[i]) * t;
    let sunInt = sunII[i] + (sunII[i + 1] - sunII[i]) * t;

    // -- Weather composes AFTER the day/night ramp (D4).
    if (k > 0) {
      _rainSky.setHex(Rw.skyColor);
      _sky.lerp(_rainSky, k);
      _fog.lerp(_rainSky, k);
      sunInt *= 1 + (Rw.sunMul - 1) * k;
      hemiInt *= 1 + (Rw.hemiMul - 1) * k;
    }

    // -- Scene lights / fog / sky (write into existing objects, no allocs).
    scene.background.copy(_sky);
    scene.fog.color.copy(_fog);
    scene.fog.near = baseFogNear + (Rw.fogNear - baseFogNear) * k;
    scene.fog.far = baseFogFar + (Rw.fogFar - baseFogFar) * k;
    hemi.intensity = hemiInt;
    sun.intensity = sunInt;
    sun.color.copy(_sunC);

    // -- Sun arc around the framed network center.
    const fi = view.getFrameInfo();
    const sinDay = Math.sin((Math.PI * (h - 6)) / 12);
    const theta = Math.max(SUN_THETA0 * sinDay, 0.08);
    const phi = SUN_PHI0 + (h - 12) * (Math.PI / 12);
    const r = fi.span * SUN_R;
    sun.position.set(
      fi.cx + r * Math.cos(theta) * Math.cos(phi),
      r * Math.sin(theta),
      fi.cz + r * Math.cos(theta) * Math.sin(phi)
    );

    // -- Night shadow refund: no perceptible shadows below sunI 0.05.
    sun.castShadow = userShadows && sunInt > 0.05;

    // -- Derived factors.
    const nightFactor = 1 - smoothstep(0, 0.15, sinDay);
    const headlightFactor =
      1 - smoothstep(D.headlights.onBelowSunI * 0.5, D.headlights.onBelowSunI, sunInt);
    state.nightFactor = nightFactor;
    state.sunIntensity = sunInt;
    state.headlightFactor = headlightFactor;

    // -- Rain particles.
    rain.setIntensity(CONFIG.weather.intensity);
    rain.setEnabled(k > 0);

    // -- Per-world pieces (lazy — world may be mid-swap or pre-C1).
    const w = getWorld();
    if (w) {
      w.roads.setWetness?.(k); // C1 lands the roadMesh API; defensive until then
      if (w.streetLampsMesh) w.streetLampsMesh.setNight(nightFactor);
      if (w.buildings && w.buildings.mesh) {
        _emis.setHex(D.windows.emissive);
        _emis.multiplyScalar(nightFactor * D.windows.maxIntensity);
        w.buildings.mesh.material.emissive.copy(_emis);
      }
    }
  }

  return {
    state,
    setTimeOfDay(h) {
      h = Math.min(Math.max(+h || 0, 0), 24);
      D.timeOfDay = h;
      autoAnchorHour = h; // auto resumes from the freshly picked hour
      autoAnchorSim = lastSimTime;
      apply();
    },
    setAuto(b) {
      D.auto = !!b;
      if (D.auto) needAnchor = true; // anchored on the next update (sim.time)
    },
    /** Mutates CONFIG.weather.current IN PLACE (live reference in idm.js). */
    setWeather(mode, intensity) {
      if (mode === 'lluvia' || mode === 'despejado') CONFIG.weather.mode = mode;
      if (intensity != null && Number.isFinite(+intensity)) {
        CONFIG.weather.intensity = Math.min(Math.max(+intensity, 0), 1);
      }
      const Rw = CONFIG.weather.rain;
      const k = CONFIG.weather.mode === 'lluvia' ? CONFIG.weather.intensity : 0;
      const cur = CONFIG.weather.current;
      cur.v0Mul = 1 + (Rw.v0Mul - 1) * k; // k=0 -> exact identity {1, 0, 1}
      cur.TAdd = Rw.TAdd * k;
      cur.bMul = 1 + (Rw.bMul - 1) * k;
      apply();
    },
    /** GUI «Sombras» — environment owns sun.castShadow (night gate, D4). */
    setShadowsEnabled(b) {
      userShadows = !!b;
      apply();
    },
    /** Re-apply hour/weather/wetness/lamps/emissive to a fresh world. */
    applyTo() {
      apply();
    },
    /** Buildings attach asynchronously — re-stamp the window emissive. */
    refreshWorld() {
      apply();
    },
    /**
     * Per-frame: rain follows the camera; auto mode advances the hour from
     * sim time (24 h per gameDayMin sim-minutes) and re-applies at ~10 Hz
     * wall-clock. Manual mode does no per-frame work beyond rain uniforms.
     */
    update(sim, wallDt, camera) {
      rain.update(wallDt, camera);
      if (!sim) return;
      lastSimTime = sim.time;
      if (!D.auto) return;
      if (needAnchor) {
        needAnchor = false;
        autoAnchorSim = sim.time;
        autoAnchorHour = D.timeOfDay;
      }
      D.timeOfDay =
        (autoAnchorHour + ((sim.time - autoAnchorSim) / (D.gameDayMin * 60)) * 24) % 24;
      applyGate += wallDt;
      if (applyGate >= 0.1) {
        applyGate = 0;
        apply();
      }
    },
    dispose() {
      scene.remove(rain.points);
      rain.dispose();
    },
  };
}
