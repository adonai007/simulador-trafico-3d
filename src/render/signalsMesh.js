// Traffic-light heads: static poles/housings + dynamic lamp InstancedMesh
// color-switched red/amber/green per phase. Spec §3.5.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { signalState } from '../sim/signalsRuntime.js';

const COLOR_GREEN = new THREE.Color(0x29d35d);
const COLOR_YELLOW = new THREE.Color(0xffc21a);
const COLOR_RED = new THREE.Color(0xff3b30);
const STATE_COLORS = { green: COLOR_GREEN, yellow: COLOR_YELLOW, red: COLOR_RED };

const _m = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();

export function createSignalsMesh(network) {
  const R = CONFIG.render;
  const W = CONFIG.laneWidthM;
  const group = new THREE.Group();

  // One approach = one (signalized junction, incoming edge) pair.
  const approaches = [];
  for (const sig of network.signals.values()) {
    for (const [edgeId, sigGroup] of sig.groups) {
      const edge = network.edges.get(edgeId);
      if (!edge || !edge.lanes.length) continue;
      const lane = edge.lanes[edge.lanes.length - 1]; // rightmost lane
      const end = lane.pointAt(lane.length);
      const h = lane.headingAt(lane.length);
      // Pole offset to the right of the rightmost lane.
      const off = W / 2 + R.signalPoleOffsetM;
      approaches.push({
        sig,
        group: sigGroup,
        x: end.x + -h.z * off,
        z: end.z + h.x * off,
        // Head faces back toward oncoming traffic: forward = -headIn.
        fx: -h.x,
        fz: -h.z,
        lastState: '',
      });
    }
  }

  const count = approaches.length;

  // Static geometry: pole cylinder + housing box (merged), origin at ground.
  const pole = new THREE.CylinderGeometry(0.1, 0.12, R.signalPoleHeightM, 6);
  pole.translate(0, R.signalPoleHeightM / 2, 0);
  const housing = new THREE.BoxGeometry(0.55, 1.25, 0.35);
  housing.translate(0, R.signalPoleHeightM - 0.4, 0.12);
  const staticGeom = BufferGeometryUtils.mergeGeometries([pole, housing]);
  pole.dispose();
  housing.dispose();
  const staticMat = new THREE.MeshLambertMaterial({ color: 0x2b2f33 });
  const staticMesh = new THREE.InstancedMesh(staticGeom, staticMat, count);
  staticMesh.castShadow = true;

  // Dynamic lamps: one sphere per approach, color = current phase state.
  const lampGeom = new THREE.SphereGeometry(R.signalLampRadiusM, 10, 8);
  const lampMat = new THREE.MeshBasicMaterial();
  const lampMesh = new THREE.InstancedMesh(lampGeom, lampMat, count);

  for (let i = 0; i < count; i++) {
    const a = approaches[i];
    _fwd.set(a.fx, 0, a.fz);
    _right.crossVectors(_up, _fwd);
    _m.makeBasis(_right, _up, _fwd);
    _m.setPosition(a.x, 0, a.z);
    staticMesh.setMatrixAt(i, _m);
    // Lamp on the housing front (local +Z of the head), near the top.
    _m.setPosition(
      a.x + a.fx * 0.34,
      R.signalPoleHeightM - 0.4,
      a.z + a.fz * 0.34
    );
    lampMesh.setMatrixAt(i, _m);
    lampMesh.setColorAt(i, COLOR_RED);
  }
  staticMesh.instanceMatrix.needsUpdate = true;
  lampMesh.instanceMatrix.needsUpdate = true;
  if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;

  group.add(staticMesh);
  group.add(lampMesh);

  return {
    group,
    /** Sync lamp colors with the signal clock. No allocations. */
    update(simTime) {
      let dirty = false;
      for (let i = 0; i < count; i++) {
        const a = approaches[i];
        const state = signalState(a.sig, a.group, simTime);
        if (state !== a.lastState) {
          a.lastState = state;
          lampMesh.setColorAt(i, STATE_COLORS[state]);
          dirty = true;
        }
      }
      if (dirty && lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
    },
    dispose() {
      staticGeom.dispose();
      staticMat.dispose();
      lampGeom.dispose();
      lampMat.dispose();
    },
  };
}
