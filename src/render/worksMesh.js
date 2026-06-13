// Obras e incidentes street furniture (V3 C1) — per-world, two draw calls:
//   - traffic cones: ONE InstancedMesh (orange body + white band + base merged
//     into a single vertex-colored geometry — busStopsMesh pattern, cap 256).
//     Closures get a cone barrier across each direction's half of the road at
//     posAt(0)/posAt(length); incidents get a wedge behind the phantom.
//   - hazard blinkers: tiny additive amber spheres at the phantom's corners;
//     blinking = count flip (floor(simTime*2*blinkHz) % 2) — zero matrix work.
// refresh() is event-driven: update(simTime) polls sim.closureVersion (bumped
// by closeEdge/openEdge/triggerIncident/expiry). No per-frame allocations.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const CONE_CAP = 256;
const HAZARD_CAP = 64;

const _m = new THREE.Matrix4();
const _pL = { x: 0, y: 0, z: 0 };
const _pR = { x: 0, y: 0, z: 0 };
const _p = { x: 0, y: 0, z: 0 };
const _h = { x: 0, z: 0 };

/** Fill a per-vertex color attribute with one flat color (pre-merge). */
function colorize(geom, hex) {
  const n = geom.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geom;
}

export function createWorksMesh(network, sim) {
  const group = new THREE.Group();
  const cfg = CONFIG.closures ?? { conesPerEnd: 3, coneEveryM: 1.1 };
  const blinkHz = CONFIG.incidents?.hazardBlinkHz ?? 1.5;
  const W = CONFIG.laneWidthM;

  // Traffic cone: orange tapered body + white band + square base.
  const body = colorize(new THREE.CylinderGeometry(0.05, 0.22, 0.75, 8), 0xff6a13);
  body.translate(0, 0.375, 0);
  const band = colorize(new THREE.CylinderGeometry(0.135, 0.17, 0.16, 8), 0xf2f2f2);
  band.translate(0, 0.4, 0);
  const base = colorize(new THREE.BoxGeometry(0.42, 0.05, 0.42), 0xd14e00);
  base.translate(0, 0.025, 0);
  const coneGeom = BufferGeometryUtils.mergeGeometries([body, band, base]);
  body.dispose();
  band.dispose();
  base.dispose();
  const coneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cones = new THREE.InstancedMesh(coneGeom, coneMat, CONE_CAP);
  cones.castShadow = true;
  cones.frustumCulled = false; // sparse + tiny — skip stale-bounds culling
  cones.count = 0;
  group.add(cones);

  // Hazard blinkers (additive amber, no depth write — cheap glow dots).
  const hazardGeom = new THREE.SphereGeometry(0.13, 8, 6);
  const hazardMat = new THREE.MeshBasicMaterial({
    color: 0xffb340,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const hazards = new THREE.InstancedMesh(hazardGeom, hazardMat, HAZARD_CAP);
  hazards.frustumCulled = false;
  hazards.count = 0;
  group.add(hazards);

  let lastVersion = -1; // forces the first refresh
  let coneIdx = 0;
  let hazardIdx = 0;
  let hazardCount = 0;
  let blinkOn = true;

  function placeCone(x, y, z) {
    if (coneIdx >= CONE_CAP) return;
    _m.makeTranslation(x, y, z);
    cones.setMatrixAt(coneIdx++, _m);
  }

  function placeHazard(x, y, z) {
    if (hazardIdx >= HAZARD_CAP) return;
    _m.makeTranslation(x, y, z);
    hazards.setMatrixAt(hazardIdx++, _m);
  }

  /**
   * Cone barrier across ONE direction's half of the road at the lane start
   * (atEnd=false) or end (atEnd=true): >= conesPerEnd cones spaced ~coneEveryM
   * spanning outer lane to outer lane plus half a lane of shoulder.
   */
  function barrier(edge, atEnd) {
    const lanes = edge.lanes;
    if (!lanes || !lanes.length) return;
    const lFirst = lanes[0];
    const lLast = lanes[lanes.length - 1];
    lFirst.posAt(atEnd ? lFirst.length : 0, _pL);
    lLast.posAt(atEnd ? lLast.length : 0, _pR);
    lFirst.headingAt(atEnd ? lFirst.length : 0, _h);
    const cx = (_pL.x + _pR.x) / 2;
    const cy = (_pL.y + _pR.y) / 2;
    const cz = (_pL.z + _pR.z) / 2;
    let dx = _pR.x - _pL.x;
    let dz = _pR.z - _pL.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) {
      dx /= dl;
      dz /= dl;
    } else {
      dx = -_h.z; // single lane: span along the lateral (right) normal
      dz = _h.x;
    }
    const half = dl / 2 + W / 2 - 0.35;
    const n = Math.max(cfg.conesPerEnd, Math.round((2 * half) / cfg.coneEveryM) + 1);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : -half + (2 * half * i) / (n - 1);
      placeCone(cx + dx * t, cy, cz + dz * t);
    }
  }

  /** Cone wedge behind the incident phantom + blinking corner hazards. */
  function incidentFurniture(rec) {
    const lane = rec.lane;
    const halfLen = rec.veh.len / 2;
    for (let i = 0; i < 3; i++) {
      const s = Math.max(rec.s - halfLen - 1 - i * cfg.coneEveryM, 0.5);
      lane.posAt(s, _p);
      lane.headingAt(s, _h);
      const lat = (i - 1) * 0.7; // -0.7 / 0 / +0.7 wedge across the lane
      placeCone(_p.x - _h.z * lat, _p.y, _p.z + _h.x * lat);
    }
    const sFront = Math.min(rec.s + halfLen + 1, lane.length - 0.5);
    lane.posAt(sFront, _p);
    placeCone(_p.x, _p.y, _p.z);
    // Hazard blinkers at the phantom's four corners.
    const sRear = Math.max(rec.s - halfLen + 0.3, 0.3);
    lane.posAt(sRear, _p);
    lane.headingAt(sRear, _h);
    placeHazard(_p.x - _h.z * 0.8, _p.y + 0.75, _p.z + _h.x * 0.8);
    placeHazard(_p.x + _h.z * 0.8, _p.y + 0.75, _p.z - _h.x * 0.8);
    const sFwd = Math.min(rec.s + halfLen - 0.3, lane.length - 0.3);
    lane.posAt(sFwd, _p);
    lane.headingAt(sFwd, _h);
    placeHazard(_p.x - _h.z * 0.8, _p.y + 0.75, _p.z + _h.x * 0.8);
    placeHazard(_p.x + _h.z * 0.8, _p.y + 0.75, _p.z - _h.x * 0.8);
  }

  /** Rebuild every instance from sim.closedEdges + sim.incidents. */
  function refresh() {
    coneIdx = 0;
    hazardIdx = 0;
    const closed = sim.closedEdges;
    if (closed && closed.size > 0) {
      for (const id of closed) {
        const e = network.edges.get(id);
        if (!e) continue;
        // Each undirected pair once (closeEdge always flags both twins).
        if (e.twinId != null && closed.has(e.twinId) && e.twinId < id) continue;
        barrier(e, false);
        barrier(e, true);
        if (e.twinId != null && closed.has(e.twinId)) {
          const twin = network.edges.get(e.twinId);
          if (twin) {
            barrier(twin, false);
            barrier(twin, true);
          }
        }
      }
    }
    const inc = sim.incidents;
    for (let i = 0; i < inc.length; i++) incidentFurniture(inc[i]);
    cones.count = coneIdx;
    cones.instanceMatrix.needsUpdate = true;
    hazardCount = hazardIdx;
    hazards.count = blinkOn ? hazardCount : 0;
    hazards.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    /** RAF hook: polls closureVersion + drives the hazard blink. */
    update(simTime) {
      if (sim.closureVersion !== lastVersion) {
        lastVersion = sim.closureVersion;
        refresh();
      }
      const on = Math.floor(simTime * 2 * blinkHz) % 2 === 0;
      if (on !== blinkOn) {
        blinkOn = on;
        hazards.count = on ? hazardCount : 0; // count flip — no matrix churn
      }
    },
    dispose() {
      coneGeom.dispose();
      coneMat.dispose();
      hazardGeom.dispose();
      hazardMat.dispose();
    },
  };
}
