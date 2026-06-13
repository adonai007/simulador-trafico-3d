// Street lamps (V3 C2) — per-world static furniture, busStopsMesh pattern:
// THREE InstancedMeshes sharing ONE matrix list (offsets baked into each
// geometry): pole+arm (Lambert, shadows), additive glow sphere at the arm tip,
// additive ground-pool disc under it. NEVER real lights — the warm look is
// additive unlit quads (D4 refunds the cost of disabled night shadows).
// Placement: one lamp per signalized junction + one every lamps.spacingM along
// edges whose highwayClass is in lamps.classes (right side of travel,
// elevation from lane.posAt), capped at lamps.maxCount.
// setNight(f) is the ONLY runtime API — no per-frame work.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const _m = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _p = { x: 0, y: 0, z: 0 };
const _h = { x: 0, z: 0 };

// Arm reaches toward the roadway: with basis right = cross(up, fwd) local +X
// points to the DRIVER'S LEFT (see busStopsMesh.js note) = toward the road
// when the pole stands on the right shoulder.
const ARM_REACH = 1.4;

export function createStreetLampsMesh(network) {
  const L = CONFIG.dayNight.lamps;
  const W = CONFIG.laneWidthM;
  const group = new THREE.Group();
  const classSet = new Set(L.classes);

  // ---- Collect lamp poses (build-time allocations are fine) ----
  const poses = []; // {x, y, z, hx, hz}
  const pushLane = (lane, s, off) => {
    if (poses.length >= L.maxCount) return;
    lane.posAt(s, _p);
    lane.headingAt(s, _h);
    poses.push({
      x: _p.x + -_h.z * off,
      y: _p.y,
      z: _p.z + _h.x * off,
      hx: _h.x,
      hz: _h.z,
    });
  };

  // One per signalized junction: end of the first inbound edge's rightmost
  // lane, pushed right past the signal pole (offset 1.5) so they don't merge.
  for (const sig of network.signals.values()) {
    const firstEdgeId = sig.groups.keys().next().value;
    const edge = network.edges.get(firstEdgeId);
    if (!edge || !edge.lanes.length) continue;
    const lane = edge.lanes[edge.lanes.length - 1];
    pushLane(lane, lane.length, W / 2 + 2.6);
  }

  // Every spacingM along primary/secondary edges (each direction lights its
  // own right side — twins give the classic both-sides avenue look).
  const spacing = L.spacingM;
  for (const edge of network.edges.values()) {
    if (poses.length >= L.maxCount) break;
    if (!classSet.has(edge.highwayClass) || !edge.lanes.length) continue;
    const lane = edge.lanes[edge.lanes.length - 1];
    for (let s = spacing * 0.5; s < lane.length; s += spacing) {
      pushLane(lane, s, W / 2 + 0.9);
      if (poses.length >= L.maxCount) break;
    }
  }
  const count = poses.length;

  // ---- Geometry: offsets baked so all 3 meshes share the SAME matrices ----
  const H = L.heightM;
  const pole = new THREE.CylinderGeometry(0.07, 0.1, H, 6);
  pole.translate(0, H / 2, 0);
  const arm = new THREE.BoxGeometry(ARM_REACH, 0.07, 0.07);
  arm.translate(ARM_REACH / 2, H - 0.12, 0);
  const head = new THREE.BoxGeometry(0.5, 0.12, 0.22);
  head.translate(ARM_REACH, H - 0.1, 0);
  const poleGeom = BufferGeometryUtils.mergeGeometries([pole, arm, head]);
  pole.dispose();
  arm.dispose();
  head.dispose();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
  const poleMesh = new THREE.InstancedMesh(poleGeom, poleMat, count);
  poleMesh.castShadow = true;

  const glowGeom = new THREE.SphereGeometry(0.26, 8, 6);
  glowGeom.translate(ARM_REACH, H - 0.18, 0);
  const glowMat = new THREE.MeshBasicMaterial({
    color: L.glowColor,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new THREE.InstancedMesh(glowGeom, glowMat, count);

  const poolGeom = new THREE.CircleGeometry(3.4, 12);
  poolGeom.rotateX(-Math.PI / 2);
  poolGeom.translate(ARM_REACH, 0.06, 0); // just above road/terrain
  const poolMat = new THREE.MeshBasicMaterial({
    color: L.glowColor,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const poolMesh = new THREE.InstancedMesh(poolGeom, poolMat, count);

  for (let i = 0; i < count; i++) {
    const q = poses[i];
    _fwd.set(q.hx, 0, q.hz).normalize();
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _m.setPosition(q.x, q.y, q.z);
    poleMesh.setMatrixAt(i, _m);
    glowMesh.setMatrixAt(i, _m);
    poolMesh.setMatrixAt(i, _m);
  }
  poleMesh.instanceMatrix.needsUpdate = true;
  glowMesh.instanceMatrix.needsUpdate = true;
  poolMesh.instanceMatrix.needsUpdate = true;
  glowMesh.visible = false;
  poolMesh.visible = false;
  group.add(poleMesh);
  group.add(glowMesh);
  group.add(poolMesh);

  let glowsVisible = false;

  return {
    group,
    count,
    get glowsVisible() {
      return glowsVisible;
    },
    /** nightFactor 0..1 -> glows/pools on above 0.25, opacity follows f. */
    setNight(f) {
      glowsVisible = count > 0 && f > 0.25;
      glowMesh.visible = glowsVisible;
      poolMesh.visible = glowsVisible;
      glowMat.opacity = Math.min(1, f);
      poolMat.opacity = 0.3 * Math.min(1, f);
    },
    dispose() {
      poleGeom.dispose();
      poleMat.dispose();
      glowGeom.dispose();
      glowMat.dispose();
      poolGeom.dispose();
      poolMat.dispose();
    },
  };
}
