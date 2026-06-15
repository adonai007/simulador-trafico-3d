// D2 — Mi Teleférico render module (per-world, only built when lines exist).
// Pattern follows worksMesh/streetLampsMesh: a Group of meshes, dispose() frees
// every GPU resource, zero per-frame allocations.
//
// Pieces (draw-call budget: 1 tube per line color + 1 towers + 1 stations +
// 1 cabins-per-line-color):
//   - Cables  : TubeGeometry along the RAISED 3D polyline (rides elevAt +
//               cableHeightM), one merged geometry per color, MeshBasicMaterial
//               tinted (unlit so the cable reads against sky/terrain at any hour).
//   - Towers  : InstancedMesh tall posts at tower nodes (base elevAt, extruded
//               towerHeightM up toward the cable).
//   - Stations: InstancedMesh small boxes at station nodes.
//   - Cabins  : InstancedMesh gondola per line, cabinsPerLine each, animated by
//               arc length along the SAME raised polyline (so they ride the
//               cable, hills included). Both directions, ping-pong at the ends.
//               makeBasis orientation from the cable tangent. update(dt) advances
//               them in WALL-CLOCK time (independent of sim speed/pause) with a
//               pre-allocated scratch set — no allocations in the hot loop.
//
// __SIM__.sampleCabin() returns the first cabin's live world position for e2e.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { pointAtParam3 } from '../util/math2d.js';

// ---- module-scope scratch (shared, never escapes a synchronous call) -------
const _m = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _pos = { x: 0, y: 0, z: 0 };
const _ahead = { x: 0, y: 0, z: 0 };

/**
 * A CatmullRom-free Curve adapter: feeds an arc-length-sampled raised polyline
 * straight into TubeGeometry. We sample the polyline ourselves (already dense
 * from network/aerialway resampling) so the tube tracks the terrain-following
 * cable exactly rather than a smoothing spline that could clip a hill.
 */
class PolylineCurve3 extends THREE.Curve {
  constructor(points3) {
    super();
    this._pts = points3; // [THREE.Vector3]
  }
  getPoint(t, optionalTarget = new THREE.Vector3()) {
    const pts = this._pts;
    const n = pts.length - 1;
    const f = t * n;
    let i = Math.floor(f);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    const lt = f - i;
    return optionalTarget.copy(pts[i]).lerp(pts[i + 1], lt);
  }
}

export function createAerialwayMesh(model) {
  const cfg = CONFIG.aerialway;
  const group = new THREE.Group();
  group.name = 'aerialway';

  const lines = model.lines;
  const cableRadius = cfg.cableRadiusM;

  // ---- Cables: merge all lines sharing a color into ONE tube geometry. ----
  // (Mi Teleférico = mostly one color per line, but merging keeps it 1 draw
  // call/color either way.)
  const byColor = new Map(); // color -> THREE.Vector3[][] (one polyline per line)
  for (const line of lines) {
    const pts = new Array(line.points2D.length);
    for (let k = 0; k < line.points2D.length; k++) {
      const p2 = line.points2D[k];
      pts[k] = new THREE.Vector3(p2.x, line.elev[k], p2.z);
    }
    if (!byColor.has(line.color)) byColor.set(line.color, []);
    byColor.get(line.color).push(pts);
  }

  const cableMats = [];
  const cableGeoms = [];
  for (const [color, polylines] of byColor) {
    const tubes = [];
    for (const pts of polylines) {
      if (pts.length < 2) continue;
      // tubularSegments ~ one per sample point keeps the tube glued to the
      // raised polyline (no spline overshoot into a hillside).
      const segments = Math.max(1, pts.length - 1);
      const curve = new PolylineCurve3(pts);
      tubes.push(new THREE.TubeGeometry(curve, segments, cableRadius, 6, false));
    }
    if (tubes.length === 0) continue;
    const merged =
      tubes.length === 1 ? tubes[0] : BufferGeometryUtils.mergeGeometries(tubes, false);
    if (tubes.length > 1) for (const t of tubes) t.dispose();
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.frustumCulled = false; // long thin spans — stale-bounds culling hurts
    group.add(mesh);
    cableMats.push(mat);
    cableGeoms.push(merged);
  }

  // ---- Towers: InstancedMesh tall posts (base at elevAt, up towerHeightM). --
  const towers = model.towers || [];
  let towerMesh = null;
  let towerGeom = null;
  let towerMat = null;
  if (towers.length > 0) {
    const H = cfg.towerHeightM;
    towerGeom = new THREE.CylinderGeometry(0.35, 0.55, H, 6);
    towerGeom.translate(0, H / 2, 0); // base at y=0 -> sits on the ground node
    towerMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ab });
    towerMesh = new THREE.InstancedMesh(towerGeom, towerMat, towers.length);
    towerMesh.castShadow = true;
    towerMesh.frustumCulled = false;
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      _m.makeTranslation(t.x, t.y, t.z);
      towerMesh.setMatrixAt(i, _m);
    }
    towerMesh.instanceMatrix.needsUpdate = true;
    group.add(towerMesh);
  }

  // ---- Stations: InstancedMesh small boxes at station nodes. ---------------
  const stations = model.stations || [];
  let stationMesh = null;
  let stationGeom = null;
  let stationMat = null;
  if (stations.length > 0) {
    const SH = 10; // station block height (m) — reads as a small terminal
    stationGeom = new THREE.BoxGeometry(14, SH, 14);
    stationGeom.translate(0, SH / 2, 0);
    stationMat = new THREE.MeshLambertMaterial({ color: 0xb0bec5 });
    stationMesh = new THREE.InstancedMesh(stationGeom, stationMat, stations.length);
    stationMesh.castShadow = true;
    stationMesh.frustumCulled = false;
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      _m.makeTranslation(s.x, s.y, s.z);
      stationMesh.setMatrixAt(i, _m);
    }
    stationMesh.instanceMatrix.needsUpdate = true;
    group.add(stationMesh);
  }

  // ---- Cabins (animated gondolas): one InstancedMesh per line color. -------
  // Each cabin carries: line ref, arc-length s, direction (+1/-1). It rides the
  // raised polyline via pointAtParam3 (cable height baked into line.elev), so
  // it follows the hills. Ping-pong at the ends. Zero per-frame allocation.
  const cabinsPerLine = Math.max(0, cfg.cabinsPerLine | 0);
  const cabinSpeed = cfg.cabinSpeedMs;
  const cs = cfg.cabinSize;
  const cabinGeomBase = makeCabinGeometry(cs.l, cs.w, cs.h);

  // Group cabins by color too (one InstancedMesh per color, tinted to match).
  const cabinGroups = []; // { mesh, geom, mat, cabins:[{line,s,dir}] }
  const colorToGroup = new Map();
  const allCabins = []; // flat list for sampleCabin + the update loop
  for (const line of lines) {
    if (cabinsPerLine === 0) break;
    let g = colorToGroup.get(line.color);
    if (!g) {
      g = { color: line.color, cabins: [] };
      colorToGroup.set(line.color, g);
      cabinGroups.push(g);
    }
    for (let c = 0; c < cabinsPerLine; c++) {
      // Spread cabins along the line; alternate travel direction so both
      // bearings are populated (real teleférico = two parallel haul ropes).
      const frac = (c + 0.5) / cabinsPerLine;
      const dir = c % 2 === 0 ? 1 : -1;
      const cabin = { line, s: frac * line.lengthM, dir };
      g.cabins.push(cabin);
      allCabins.push(cabin);
    }
  }

  for (const g of cabinGroups) {
    const count = g.cabins.length;
    if (count === 0) continue;
    const geom = cabinGeomBase.clone();
    const mat = new THREE.MeshLambertMaterial({ color: g.color });
    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    g.mesh = mesh;
    g.geom = geom;
    g.mat = mat;
    group.add(mesh);
  }
  cabinGeomBase.dispose();

  /** Place every cabin instance at its current arc-length position. */
  function writeCabinMatrices() {
    for (const g of cabinGroups) {
      const mesh = g.mesh;
      if (!mesh) continue;
      const cabins = g.cabins;
      for (let i = 0; i < cabins.length; i++) {
        const cb = cabins[i];
        const line = cb.line;
        pointAtParam3(line.points2D, line.cumLen, line.elev, cb.s, _pos);
        // Tangent: look a little ahead in the travel direction (clamped).
        const sAhead = clampS(cb.s + cb.dir * 2.0, line.lengthM);
        pointAtParam3(line.points2D, line.cumLen, line.elev, sAhead, _ahead);
        let dx = (_ahead.x - _pos.x) * cb.dir;
        let dy = (_ahead.y - _pos.y) * cb.dir;
        let dz = (_ahead.z - _pos.z) * cb.dir;
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-5) {
          dx /= len; dy /= len; dz /= len;
        } else {
          dx = 0; dy = 0; dz = 1;
        }
        _fwd.set(dx, dy, dz);
        _right.crossVectors(_up, _fwd);
        if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
        _right.normalize();
        // Re-orthogonalize up so the basis stays rigid on graded spans.
        const ux = _fwd.y * _right.z - _fwd.z * _right.y;
        const uy = _fwd.z * _right.x - _fwd.x * _right.z;
        const uz = _fwd.x * _right.y - _fwd.y * _right.x;
        _up.set(ux, uy, uz).normalize();
        _m.makeBasis(_right, _up, _fwd);
        // Hang the gondola a touch below the cable.
        _m.setPosition(_pos.x, _pos.y - 1.4, _pos.z);
        mesh.setMatrixAt(i, _m);
        _up.set(0, 1, 0); // restore shared up scratch
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Initial placement so the cabins are visible before the first update tick.
  writeCabinMatrices();

  let visible = cfg.enabled !== false;
  group.visible = visible;

  return {
    group,
    /** e2e/debug state: line + cabin counts. */
    getState() {
      return { lines: lines.length, cabins: allCabins.length };
    },
    /**
     * First cabin's live world position {x,y,z} (or null when there are none).
     * Used by __SIM__.sampleCabin() to prove the cabins move and ride elevated.
     */
    sampleCabin() {
      const cb = allCabins[0];
      if (!cb) return null;
      pointAtParam3(cb.line.points2D, cb.line.cumLen, cb.line.elev, cb.s, _pos);
      return { x: _pos.x, y: _pos.y - 1.4, z: _pos.z };
    },
    /** «Teleférico» checkbox -> group visibility (cheap, no rebuild). */
    setVisible(v) {
      visible = !!v;
      group.visible = visible;
    },
    get visible() {
      return visible;
    },
    /**
     * Advance cabins by WALL-CLOCK dt (real seconds — gondolas ride real time,
     * independent of sim speed/pause). Ping-pong at the line ends. Skips matrix
     * work entirely while hidden. Zero allocations.
     */
    update(dt) {
      if (!visible || allCabins.length === 0) return;
      if (!(dt > 0)) return;
      const step = cabinSpeed * dt;
      for (let i = 0; i < allCabins.length; i++) {
        const cb = allCabins[i];
        const L = cb.line.lengthM;
        let s = cb.s + cb.dir * step;
        if (s >= L) {
          s = L - (s - L);
          cb.dir = -1;
          if (s < 0) s = 0;
        } else if (s <= 0) {
          s = -s;
          cb.dir = 1;
          if (s > L) s = L;
        }
        cb.s = s;
      }
      writeCabinMatrices();
    },
    dispose() {
      for (const geom of cableGeoms) geom.dispose();
      for (const mat of cableMats) mat.dispose();
      if (towerMesh) { towerGeom.dispose(); towerMat.dispose(); }
      if (stationMesh) { stationGeom.dispose(); stationMat.dispose(); }
      for (const g of cabinGroups) {
        if (g.mesh) { g.geom.dispose(); g.mat.dispose(); }
      }
    },
  };
}

/** Clamp an arc length s into [0, total]. */
function clampS(s, total) {
  return s < 0 ? 0 : s > total ? total : s;
}

/**
 * Gondola cabin geometry: a rounded box body + a small hanger arm reaching up
 * toward the cable. Nose points local +Z (basis convention). One geometry,
 * cloned per color group.
 */
function makeCabinGeometry(l, w, h) {
  const body = new THREE.BoxGeometry(w, h, l);
  body.translate(0, 0, 0);
  // Hanger: a thin post from the roof up to where the cable sits (~1.4 m gap).
  const hanger = new THREE.BoxGeometry(0.12, 1.4, 0.12);
  hanger.translate(0, h / 2 + 0.7, 0);
  const merged = BufferGeometryUtils.mergeGeometries([body, hanger]);
  body.dispose();
  hanger.dispose();
  return merged;
}
