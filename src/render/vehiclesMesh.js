// Vehicle InstancedMeshes (spec §3.4 + fleet deviation): one per type
// (sedán / hatchback / SUV / taxi / micro paceño / camión), distinct low-poly
// geometry (~250–440 tris: boxes + 8-segment cylinder wheels with hub faces),
// nose +Z local, matrices via makeBasis (projection.js convention).
//
// Color regions: merged geometry carries a vec4 `color` attribute where
// rgb = region color and ALPHA = "tint mask" — 1 means the region multiplies
// the per-instance body color (setColorAt), 0 means the region keeps its
// authored color exactly (glass, tires, hubs, bumpers, taxi sign, micro white
// band). A tiny onBeforeCompile patch on the shared MeshLambertMaterial
// implements the mix; still ONE draw call per type.
//
// Brake lights: ONE extra InstancedMesh (unit box, bright red MeshBasicMaterial)
// shared by all types. Per frame, every vehicle with _a < -1 m/s² (or held at
// ~standstill) gets one instance scaled/positioned onto its tail via the same
// basis vectors already computed for the body — zero allocations, +1 draw call
// total. Braking waves are visible propagating through queues.
//
// Lane changes are logically instantaneous in the sim; here the lateral
// offset eases out over CONFIG.sim.mobil.lateralEaseS (spec §2.5).
// No per-frame allocations: temps are module-level.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const _m = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _bUp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _color = new THREE.Color();
const _c = new THREE.Color();
// ALL pose scratch carries y from creation (F1) — stable hidden classes.
const _p = { x: 0, y: 0, z: 0 };
const _h = { x: 0, y: 0, z: 0 };
const _pA = { x: 0, y: 0, z: 0 };
const _pB = { x: 0, y: 0, z: 0 };
const _hA = { x: 0, y: 0, z: 0 };
const _hB = { x: 0, y: 0, z: 0 };

/**
 * Interpolated vehicle pose (spec §2.1): lerp between the step-start snapshot
 * (prevSeg/prevS) and the current state by the accumulator fraction `alpha`.
 * Same segment -> lerp the arc position (exact). Across a segment boundary
 * (lane -> connector -> lane) -> lerp positions/headings in world space; the
 * polylines are continuous at the seam so the path stays smooth.
 * Writes into outP {x,y,z} (posAt elevation) and outH {x,y,z} where x/z is the
 * unit planar heading and y = signed grade (pitch, F1). No allocations.
 */
export function sampleVehiclePose(veh, alpha, outP, outH) {
  const seg = veh.seg;
  const prevSeg = veh.prevSeg;
  if (prevSeg === seg) {
    const s = Math.min(veh.prevS + (veh.s - veh.prevS) * alpha, seg.length);
    seg.posAt(s, outP);
    seg.headingAt(s, outH);
    outH.y = seg.gradeAt(s);
    return;
  }
  const sA = Math.min(veh.prevS, prevSeg.length);
  const sB = Math.min(veh.s, seg.length);
  prevSeg.posAt(sA, _pA);
  seg.posAt(sB, _pB);
  outP.x = _pA.x + (_pB.x - _pA.x) * alpha;
  outP.y = _pA.y + (_pB.y - _pA.y) * alpha;
  outP.z = _pA.z + (_pB.z - _pA.z) * alpha;
  prevSeg.headingAt(sA, _hA);
  seg.headingAt(sB, _hB);
  let hx = _hA.x + (_hB.x - _hA.x) * alpha;
  let hz = _hA.z + (_hB.z - _hA.z) * alpha;
  const len = Math.sqrt(hx * hx + hz * hz);
  if (len > 1e-6) {
    hx /= len;
    hz /= len;
  } else {
    hx = _hB.x;
    hz = _hB.z;
  }
  outH.x = hx;
  outH.z = hz;
  const gA = prevSeg.gradeAt(sA);
  const gB = seg.gradeAt(sB);
  outH.y = gA + (gB - gA) * alpha;
}

// ---------------------------------------------------------------------------
// Geometry builders. Shared fixed-region colors:
const COL_GLASS = 0x10141a; // very dark blue-black — strong contrast vs bodies
const COL_TIRE = 0x141518;
const COL_HUB = 0x9aa0a8; // lighter hub face so wheels read at street level
const COL_BUMPER = 0x2c2f34;
const COL_GRILLE = 0x1c1f24;
const COL_TRIM = 0x4a4e55; // roof rails / rack
const COL_HEADLIGHT = 0xffe9b0;
const COL_TAIL = 0x7a1410; // baked dark-red tail bar (brake overlay glows on top)
const COL_BAND = 0xf2f2f2; // micro paceño white band

/** Fill a vec4 color attribute: rgb = color, a = tint mask (1 = body tint). */
function paint(g, hex, tint) {
  _c.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = _c.r;
    arr[i * 4 + 1] = _c.g;
    arr[i * 4 + 2] = _c.b;
    arr[i * 4 + 3] = tint;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 4));
  return g;
}

/** Body-tinted box (rgb white × instanceColor). */
function box(parts, w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  parts.push(paint(g, 0xffffff, 1));
}

/** Fixed-color box (ignores instanceColor). */
function fbox(parts, w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  parts.push(paint(g, hex, 0));
}

/**
 * Axle pair: 8-segment cylinder tires (dark) + slightly wider hub cylinders
 * (light) so wheels clearly read at street level. Axle height = radius, so
 * tires touch the ground and the body sits ON the wheels.
 */
function wheelPair(parts, r, halfTrack, z, w) {
  for (let side = -1; side <= 1; side += 2) {
    const tire = new THREE.CylinderGeometry(r, r, w, 8);
    tire.rotateZ(Math.PI / 2);
    tire.translate(side * halfTrack, r, z);
    parts.push(paint(tire, COL_TIRE, 0));
    const hub = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.06, 8);
    hub.rotateZ(Math.PI / 2);
    hub.translate(side * halfTrack, r, z);
    parts.push(paint(hub, COL_HUB, 0));
  }
}

function headlights(parts, x, y, z) {
  fbox(parts, 0.34, 0.13, 0.07, -x, y, z, COL_HEADLIGHT);
  fbox(parts, 0.34, 0.13, 0.07, x, y, z, COL_HEADLIGHT);
}

function merge(parts) {
  const g = BufferGeometryUtils.mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

// Sedán — 4.5 m, classic three-box: hood / greenhouse / trunk.
function buildSedan() {
  const parts = [];
  box(parts, 1.8, 0.55, 4.5, 0, 0.62, 0); // lower body
  box(parts, 1.62, 0.5, 2.1, 0, 1.14, -0.3); // cabin (roof keeps body color)
  fbox(parts, 1.68, 0.34, 2.3, 0, 1.08, -0.3, COL_GLASS); // wraparound glass band
  fbox(parts, 1.45, 0.05, 0.55, 0, 0.92, 1.0, COL_GLASS); // windshield (aerial hint)
  fbox(parts, 1.45, 0.05, 0.45, 0, 0.92, -1.6, COL_GLASS); // rear glass hint
  fbox(parts, 1.35, 0.28, 0.1, 0, 0.68, 2.21, COL_GRILLE);
  fbox(parts, 1.84, 0.22, 0.18, 0, 0.42, 2.2, COL_BUMPER);
  fbox(parts, 1.84, 0.22, 0.18, 0, 0.42, -2.2, COL_BUMPER);
  headlights(parts, 0.6, 0.78, 2.27);
  fbox(parts, 1.5, 0.15, 0.07, 0, 0.8, -2.27, COL_TAIL);
  wheelPair(parts, 0.38, 0.8, 1.45, 0.28);
  wheelPair(parts, 0.38, 0.8, -1.45, 0.28);
  return merge(parts);
}

// Hatchback — 3.9 m, short rear: cabin reaches almost to the tail.
function buildHatchback() {
  const parts = [];
  box(parts, 1.75, 0.55, 3.9, 0, 0.62, 0);
  box(parts, 1.6, 0.52, 1.95, 0, 1.13, -0.62); // rear-shifted cabin
  fbox(parts, 1.66, 0.36, 2.2, 0, 1.07, -0.62, COL_GLASS); // band protrudes at hatch
  fbox(parts, 1.4, 0.05, 0.5, 0, 0.92, 0.85, COL_GLASS); // windshield hint
  fbox(parts, 1.3, 0.26, 0.1, 0, 0.66, 1.91, COL_GRILLE);
  fbox(parts, 1.8, 0.22, 0.18, 0, 0.42, 1.9, COL_BUMPER);
  fbox(parts, 1.8, 0.22, 0.18, 0, 0.42, -1.9, COL_BUMPER);
  headlights(parts, 0.55, 0.78, 1.97);
  fbox(parts, 1.45, 0.15, 0.07, 0, 0.82, -1.97, COL_TAIL);
  wheelPair(parts, 0.37, 0.78, 1.25, 0.28);
  wheelPair(parts, 0.37, 0.78, -1.25, 0.28);
  return merge(parts);
}

// SUV — 4.7 m, tall body, big wheels, roof rails.
function buildSuv() {
  const parts = [];
  box(parts, 1.95, 0.75, 4.7, 0, 0.83, 0);
  box(parts, 1.8, 0.6, 2.7, 0, 1.5, -0.25);
  fbox(parts, 1.86, 0.42, 2.95, 0, 1.42, -0.25, COL_GLASS);
  fbox(parts, 1.55, 0.05, 0.6, 0, 1.23, 1.25, COL_GLASS); // windshield hint
  fbox(parts, 0.09, 0.08, 2.3, -0.72, 1.84, -0.25, COL_TRIM); // roof rails
  fbox(parts, 0.09, 0.08, 2.3, 0.72, 1.84, -0.25, COL_TRIM);
  fbox(parts, 1.55, 0.4, 0.1, 0, 0.85, 2.31, COL_GRILLE);
  fbox(parts, 2.0, 0.28, 0.2, 0, 0.5, 2.3, COL_BUMPER);
  fbox(parts, 2.0, 0.28, 0.2, 0, 0.5, -2.3, COL_BUMPER);
  headlights(parts, 0.65, 0.95, 2.37);
  fbox(parts, 1.6, 0.16, 0.07, 0, 0.95, -2.37, COL_TAIL);
  wheelPair(parts, 0.47, 0.85, 1.5, 0.32);
  wheelPair(parts, 0.47, 0.85, -1.5, 0.32);
  return merge(parts);
}

// Taxi — sedan shell (white/yellow palette) + yellow roof sign.
function buildTaxi() {
  const parts = [];
  box(parts, 1.8, 0.55, 4.5, 0, 0.62, 0);
  box(parts, 1.62, 0.5, 2.1, 0, 1.14, -0.3);
  fbox(parts, 1.68, 0.34, 2.3, 0, 1.08, -0.3, COL_GLASS);
  fbox(parts, 1.45, 0.05, 0.55, 0, 0.92, 1.0, COL_GLASS);
  fbox(parts, 1.35, 0.28, 0.1, 0, 0.68, 2.21, COL_GRILLE);
  fbox(parts, 1.84, 0.22, 0.18, 0, 0.42, 2.2, COL_BUMPER);
  fbox(parts, 1.84, 0.22, 0.18, 0, 0.42, -2.2, COL_BUMPER);
  headlights(parts, 0.6, 0.78, 2.27);
  fbox(parts, 1.5, 0.15, 0.07, 0, 0.8, -2.27, COL_TAIL);
  fbox(parts, 0.7, 0.24, 0.36, 0, 1.51, -0.1, 0xffc419); // TAXI roof sign
  wheelPair(parts, 0.38, 0.8, 1.45, 0.28);
  wheelPair(parts, 0.38, 0.8, -1.45, 0.28);
  return merge(parts);
}

// Micro paceño — 7 m boxy minibus: flat front, saturated body color,
// white band along the waistline, side window strip, roof rack hint.
function buildMicro() {
  const parts = [];
  box(parts, 2.3, 1.95, 7.0, 0, 1.42, 0); // bus body
  fbox(parts, 2.38, 0.45, 7.06, 0, 1.0, 0, COL_BAND); // white waist band (wraps)
  fbox(parts, 2.38, 0.55, 4.8, 0, 1.95, -0.7, COL_GLASS); // side window strip
  fbox(parts, 2.05, 0.7, 0.1, 0, 1.9, 3.48, COL_GLASS); // flat windshield
  fbox(parts, 1.95, 0.05, 0.5, 0, 2.42, 3.0, COL_GLASS); // windshield aerial hint
  fbox(parts, 0.08, 0.14, 3.6, -0.95, 2.47, -0.5, COL_TRIM); // roof rack rails
  fbox(parts, 0.08, 0.14, 3.6, 0.95, 2.47, -0.5, COL_TRIM);
  fbox(parts, 2.0, 0.1, 0.1, 0, 2.47, 0.9, COL_TRIM); // crossbar
  fbox(parts, 1.8, 0.45, 0.1, 0, 0.85, 3.52, COL_GRILLE);
  fbox(parts, 2.38, 0.28, 0.2, 0, 0.5, 3.48, COL_BUMPER);
  fbox(parts, 2.38, 0.28, 0.2, 0, 0.5, -3.48, COL_BUMPER);
  headlights(parts, 0.85, 0.95, 3.54);
  fbox(parts, 2.0, 0.18, 0.08, 0, 0.95, -3.52, COL_TAIL);
  wheelPair(parts, 0.5, 1.0, 2.2, 0.34);
  wheelPair(parts, 0.5, 1.0, -2.3, 0.34);
  return merge(parts);
}

// Camión — 10 m: cab + visible gap + box trailer on a dark chassis.
function buildCamion() {
  const parts = [];
  box(parts, 2.3, 1.7, 2.6, 0, 1.6, 3.55); // cab
  fbox(parts, 2.36, 0.55, 2.7, 0, 1.95, 3.55, COL_GLASS); // cab glass band
  fbox(parts, 2.0, 0.55, 0.1, 0, 1.0, 4.87, COL_GRILLE);
  fbox(parts, 2.4, 0.32, 0.22, 0, 0.55, 4.85, COL_BUMPER);
  box(parts, 2.5, 2.5, 6.4, 0, 1.85, -1.7); // box trailer
  fbox(parts, 2.1, 0.35, 8.8, 0, 0.55, -0.2, 0x26282d); // chassis
  fbox(parts, 2.4, 0.25, 0.15, 0, 0.5, -4.92, COL_BUMPER);
  headlights(parts, 0.85, 1.05, 4.88);
  fbox(parts, 2.1, 0.2, 0.08, 0, 0.7, -4.95, COL_TAIL);
  wheelPair(parts, 0.55, 1.05, 3.5, 0.38);
  wheelPair(parts, 0.55, 1.05, -3.0, 0.38);
  return merge(parts);
}

// Builder registry — keys match CONFIG.vehicleTypes (legacy aliases kept so
// the renderer works against either config generation during HMR).
const BUILDERS = {
  sedan: buildSedan,
  hatchback: buildHatchback,
  suv: buildSuv,
  taxi: buildTaxi,
  micro: buildMicro,
  camion: buildCamion,
  car: buildSedan,
  truck: buildCamion,
  sport: buildHatchback,
};

// Brake-light bar dims per type: {w, h, d, y, z} in vehicle-local space
// (z = rear). Sized to read from behind at street level.
const BRAKE_DIMS = {
  sedan: { w: 1.5, h: 0.22, d: 0.12, y: 0.82, z: -2.28 },
  hatchback: { w: 1.45, h: 0.22, d: 0.12, y: 0.84, z: -1.98 },
  suv: { w: 1.6, h: 0.25, d: 0.12, y: 1.0, z: -2.38 },
  taxi: { w: 1.5, h: 0.22, d: 0.12, y: 0.82, z: -2.28 },
  micro: { w: 2.0, h: 0.3, d: 0.12, y: 1.42, z: -3.55 },
  camion: { w: 2.1, h: 0.3, d: 0.12, y: 1.0, z: -4.98 },
  car: { w: 1.5, h: 0.22, d: 0.12, y: 0.82, z: -2.28 },
  truck: { w: 2.1, h: 0.3, d: 0.12, y: 1.0, z: -4.98 },
  sport: { w: 1.45, h: 0.22, d: 0.12, y: 0.84, z: -1.98 },
};

const BRAKE_ON_ACCEL = -1.0; // m/s² (brief: light on when _a < -1)

export function createVehiclesMesh(sim) {
  const capacity = CONFIG.render.vehicleCapacityPerType;
  // Mesh order MUST match TYPE_INDEX order (= CONFIG.vehicleTypes key order):
  // picking maps raycast hits back through meshes.indexOf().
  const typeNames = Object.keys(CONFIG.vehicleTypes);
  const geoms = typeNames.map((t) => (BUILDERS[t] || buildSedan)());

  // Shared Lambert; vColor.a = tint mask (see header). Patch keeps everything
  // else (lighting, shadows, instancing) stock three.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      [
        'vColor = vec4( 1.0 );',
        '#ifdef USE_COLOR_ALPHA',
        '\tvColor *= color;',
        '#endif',
        '#ifdef USE_INSTANCING_COLOR',
        '\tvColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, vColor.a );',
        '#endif',
        'vColor.a = 1.0;',
      ].join('\n')
    );
  };
  mat.customProgramCacheKey = () => 'vehicles-tint-mask';

  const meshes = geoms.map((g) => {
    const mesh = new THREE.InstancedMesh(g, mat, capacity);
    mesh.castShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.setColorAt(0, _color.setHex(0xffffff)); // create instanceColor buffer
    return mesh;
  });
  const group = new THREE.Group();
  for (const m of meshes) group.add(m);

  // Brake lights: one shared InstancedMesh, instances exist only while braking.
  const brakeCapacity = capacity * typeNames.length;
  const brakeGeom = new THREE.BoxGeometry(1, 1, 1);
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0xff2415 });
  const brakeMesh = new THREE.InstancedMesh(brakeGeom, brakeMat, brakeCapacity);
  brakeMesh.count = 0;
  brakeMesh.frustumCulled = false;
  brakeMesh.castShadow = false;
  group.add(brakeMesh);
  const brakeDims = typeNames.map((t) => BRAKE_DIMS[t] || BRAKE_DIMS.sedan);

  // instanceId -> vehicle, per type (rebuilt every frame; used by picking).
  const instanceIdToVehicle = typeNames.map(() => new Array(capacity).fill(null));
  const counts = new Array(typeNames.length).fill(0);
  const easeS = CONFIG.sim.mobil.lateralEaseS;

  return {
    mesh: group, // kept name for main.js compatibility
    meshes, // [sedan, hatchback, suv, taxi, micro, camion] for raycast picking
    brakeMesh,
    instanceIdToVehicle,
    /**
     * Sync instance matrices/colors from sim vehicles. `alpha` = accumulator
     * fraction acc/DT in [0,1] for §2.1 interpolation (defaults to 1 = snap).
     */
    update(alpha = 1) {
      for (let k = 0; k < counts.length; k++) counts[k] = 0;
      let brakeCount = 0;
      const vehicles = sim.vehicles;
      const t = sim.time;
      for (let i = 0; i < vehicles.length; i++) {
        const veh = vehicles[i];
        const ti = veh.typeIndex;
        if (counts[ti] >= capacity) continue;
        const idx = counts[ti]++;
        const mesh = meshes[ti];
        sampleVehiclePose(veh, alpha, _p, _h);
        let px = _p.x;
        let pz = _p.z;
        // Lane-change lateral ease (right of travel = (-dz, dx)).
        const dtLc = t - veh.lcT;
        if (veh.lcLat !== 0 && dtLc >= 0 && dtLc < easeS) {
          let k = dtLc / easeS;
          k = k * k * (3 - 2 * k); // smoothstep
          const off = veh.lcLat * (1 - k);
          px += -_h.z * off;
          pz += _h.x * off;
        }
        // Pitched basis (F1): _h.y = grade (de/ds) tilts the forward axis;
        // right stays planar, up = fwd × right keeps the frame orthonormal.
        _fwd.set(_h.x, _h.y, _h.z).normalize();
        _right.crossVectors(_up, _fwd).normalize();
        _bUp.crossVectors(_fwd, _right);
        _m.makeBasis(_right, _bUp, _fwd);
        _m.setPosition(px, _p.y + 0.05, pz);
        mesh.setMatrixAt(idx, _m);
        _color.setRGB(veh.color.r, veh.color.g, veh.color.b);
        mesh.setColorAt(idx, _color);
        instanceIdToVehicle[ti][idx] = veh;
        // Brake light: decelerating hard, or held at ~standstill (queue/red).
        if (
          (veh._a < BRAKE_ON_ACCEL || (veh.v < 0.3 && veh._a < 0.4)) &&
          brakeCount < brakeCapacity
        ) {
          const b = brakeDims[ti];
          // Reuse the body basis: bar center = pos + fwd*z + up*y, then scale
          // the (unit box) axes to the bar dims.
          const bx = px + _fwd.x * b.z + _bUp.x * b.y;
          const by = _p.y + 0.05 + _fwd.y * b.z + _bUp.y * b.y;
          const bz = pz + _fwd.z * b.z + _bUp.z * b.y;
          _right.multiplyScalar(b.w);
          _bUp.multiplyScalar(b.h);
          _fwd.multiplyScalar(b.d);
          _m.makeBasis(_right, _bUp, _fwd);
          _m.setPosition(bx, by, bz);
          brakeMesh.setMatrixAt(brakeCount++, _m);
        }
      }
      for (let k = 0; k < meshes.length; k++) {
        meshes[k].count = counts[k];
        meshes[k].instanceMatrix.needsUpdate = true;
        if (meshes[k].instanceColor) meshes[k].instanceColor.needsUpdate = true;
      }
      brakeMesh.count = brakeCount;
      brakeMesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const g of geoms) g.dispose();
      mat.dispose();
      brakeGeom.dispose();
      brakeMat.dispose();
    },
  };
}
