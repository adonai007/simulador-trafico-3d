// Rain (V3 C2) — ONE THREE.Points with GPU-recycled drops: positions are
// seeded ONCE in an areaM × heightM × areaM box around the origin; the vertex
// shader wraps Y by uTime (fall) and recenters XZ on uCamPos with a modulo
// wrap, so the storm follows the camera with ZERO per-frame CPU vertex writes.
// Fragment renders a soft vertical streak (additive, depthWrite off, no fog).
// Intensity drives both the draw range (drop count) and an opacity uniform.
// Owned by environment.js (app lifetime, survives world swaps).

import * as THREE from 'three';
import { CONFIG } from '../config.js';

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uFall;
  uniform float uHeight;
  uniform float uArea;
  uniform vec3 uCamPos;
  varying float vFade;
  void main() {
    vec3 p = position;
    // Vertical recycling: fall at uFall m/s, wrap into [0, uHeight).
    p.y = mod(p.y - uTime * uFall, uHeight);
    // Horizontal recycling: keep the box centered on the camera.
    p.x = uCamPos.x + mod(p.x - uCamPos.x + uArea * 0.5, uArea) - uArea * 0.5;
    p.z = uCamPos.z + mod(p.z - uCamPos.z + uArea * 0.5, uArea) - uArea * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 1.0);
    gl_PointSize = clamp(140.0 / dist, 1.0, 7.0);
    // Distant drops fade out instead of popping at the box edge.
    vFade = 1.0 - smoothstep(0.35, 0.5, length(p.xz - uCamPos.xz) / uArea);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vFade;
  void main() {
    // Soft vertical streak: narrow in x, elongated in y (point sprite space).
    float x = abs(gl_PointCoord.x - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.0, 0.45, x);
    float a = core * uOpacity * vFade * 0.5;
    if (a < 0.004) discard;
    gl_FragColor = vec4(0.62, 0.72, 0.85, a);
  }
`;

export function createRain() {
  const R = CONFIG.weather.rain;
  const n = R.dropCount;
  const positions = new Float32Array(n * 3);
  // Deterministic-enough seeding (visual only — sim RNG untouched).
  let s = 88172645463325252n; // xorshift64 seed, no Math.random dependence
  const rnd = () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(s % 100000n) / 100000;
  };
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (rnd() - 0.5) * R.areaM;
    positions[i * 3 + 1] = rnd() * R.heightM;
    positions[i * 3 + 2] = (rnd() - 0.5) * R.areaM;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const uniforms = {
    uTime: { value: 0 },
    uFall: { value: R.fallMs },
    uHeight: { value: R.heightM },
    uArea: { value: R.areaM },
    uCamPos: { value: new THREE.Vector3() },
    uOpacity: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false; // box follows the camera — always on screen
  points.visible = false;
  points.renderOrder = 10; // after opaque world + additive light quads

  return {
    points,
    get visible() {
      return points.visible;
    },
    setEnabled(b) {
      points.visible = !!b;
    },
    /** Intensity 0..1 -> active drop count + streak opacity. */
    setIntensity(k) {
      const kk = Math.min(Math.max(k, 0), 1);
      geom.setDrawRange(0, Math.floor(n * kk));
      uniforms.uOpacity.value = 0.35 + 0.65 * kk;
    },
    /** Per-frame: advance fall clock + follow the camera. Zero allocations. */
    update(wallDt, camera) {
      if (!points.visible) return;
      uniforms.uTime.value += wallDt;
      uniforms.uCamPos.value.copy(camera.position);
    },
    dispose() {
      geom.dispose();
      mat.dispose();
    },
  };
}
