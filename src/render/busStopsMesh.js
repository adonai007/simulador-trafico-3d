// Bus-stop street furniture (F2): ONE static InstancedMesh per world —
// pole cylinder + sign box + bench merged into a single vertex-colored
// geometry (one draw call, no per-frame work). Placed laneWidth/2 + 1.2 m to
// the RIGHT of the travel direction at lane.posAt(s) (n = (-hz, hx)), y from
// posAt (F1 elevation). Built in makeWorld, disposed on world swap.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const _m = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();

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

export function createBusStopsMesh(network) {
  const group = new THREE.Group();
  const stops = network.busStops || []; // tolerate pre-integration networks
  const count = stops.length;

  // Local axes: +Z = travel direction. NOTE basis right = cross(up, fwd)
  // maps local +X to the DRIVER'S LEFT (toward the road) under the
  // x=east/z=-south mapping — the bench therefore sits at local -X (curbside).
  const pole = colorize(new THREE.CylinderGeometry(0.05, 0.06, 3.0, 6), 0x4a5158);
  pole.translate(0, 1.5, 0);
  const sign = colorize(new THREE.BoxGeometry(0.7, 0.45, 0.08), 0x1fa83c);
  sign.translate(0, 2.6, 0);
  const bench = colorize(new THREE.BoxGeometry(0.5, 0.45, 1.6), 0x8a6f4d);
  bench.translate(-0.9, 0.225, 0);
  const geom = BufferGeometryUtils.mergeGeometries([pole, sign, bench]);
  pole.dispose();
  sign.dispose();
  bench.dispose();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(geom, mat, count);
  mesh.castShadow = true;

  const off = CONFIG.laneWidthM / 2 + 1.2;
  const p = { x: 0, y: 0, z: 0 };
  const h = { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const stop = stops[i];
    stop.lane.posAt(stop.s, p);
    stop.lane.headingAt(stop.s, h);
    _fwd.set(h.x, 0, h.z).normalize();
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _m.setPosition(p.x + -h.z * off, p.y, p.z + h.x * off); // right of travel
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  return {
    group,
    dispose() {
      geom.dispose();
      mat.dispose();
    },
  };
}
