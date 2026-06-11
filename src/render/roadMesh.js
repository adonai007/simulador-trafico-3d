// Road ribbons + junction discs + markings + stop lines. Spec §3.2.
// Few draw calls: one merged mesh for ribbons, one for discs, one for markings.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { offsetPolyline, cumulativeLengths, pointAtParam, headingAtParam } from '../util/math2d.js';

/** Triangulated strip between two equal-length polylines (flat, y=0, up normals). */
function stripGeometry(left, right) {
  const n = left.length;
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const indices = [];
  for (let i = 0; i < n; i++) {
    positions[i * 6 + 0] = left[i].x;
    positions[i * 6 + 1] = 0;
    positions[i * 6 + 2] = left[i].z;
    positions[i * 6 + 3] = right[i].x;
    positions[i * 6 + 4] = 0;
    positions[i * 6 + 5] = right[i].z;
    normals[i * 6 + 1] = 1;
    normals[i * 6 + 4] = 1;
    if (i > 0) {
      const a = (i - 1) * 2;
      // CCW from above (+Y) so faces point up.
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/** Flat quad centered at p, oriented by unit heading h: len along h, width across. */
function quadGeometry(p, h, len, width) {
  const rx = -h.z; // right normal
  const rz = h.x;
  const hl = len / 2;
  const hw = width / 2;
  const corners = [
    { x: p.x - h.x * hl - rx * hw, z: p.z - h.z * hl - rz * hw },
    { x: p.x - h.x * hl + rx * hw, z: p.z - h.z * hl + rz * hw },
    { x: p.x + h.x * hl - rx * hw, z: p.z + h.z * hl - rz * hw },
    { x: p.x + h.x * hl + rx * hw, z: p.z + h.z * hl + rz * hw },
  ];
  const positions = new Float32Array(12);
  const normals = new Float32Array(12);
  corners.forEach((c, i) => {
    positions[i * 3] = c.x;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = c.z;
    normals[i * 3 + 1] = 1;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex([0, 1, 2, 2, 1, 3]); // CCW from above
  return g;
}

/** Dashes (len dash / gap) along a polyline, as merged quads. */
function dashGeometries(points, dashLen, gapLen, width, out) {
  const cum = cumulativeLengths(points);
  const total = cum[cum.length - 1];
  const p = { x: 0, z: 0 };
  const h = { x: 0, z: 0 };
  for (let s = dashLen / 2; s + dashLen / 2 < total; s += dashLen + gapLen) {
    pointAtParam(points, cum, s, p);
    headingAtParam(points, cum, s, h);
    out.push(quadGeometry(p, h, dashLen, width));
  }
}

/**
 * Build road group: ribbons, junction discs, markings.
 * Returns { group, dispose() }.
 */
export function buildRoadMesh(network) {
  const W = CONFIG.laneWidthM;
  const R = CONFIG.render;
  const group = new THREE.Group();

  const ribbonGeoms = [];
  const markingGeoms = [];

  for (const edge of network.edges.values()) {
    // Process each undirected road once (forward twin wins).
    if (edge.twinId != null && edge.twinId < edge.id) continue;
    const twin = edge.twinId != null ? network.edges.get(edge.twinId) : null;
    const center = edge.trimmedPoints || edge.points;
    if (center.length < 2) continue;

    // Ribbon extents relative to this edge's travel direction:
    // right side = this edge's lanes, left side = twin's lanes (or centered one-way).
    let rightExt;
    let leftExt;
    if (twin) {
      rightExt = W * edge.laneCount;
      leftExt = -W * twin.laneCount;
    } else {
      rightExt = (W * edge.laneCount) / 2;
      leftExt = -rightExt;
    }
    const right = offsetPolyline(center, rightExt, CONFIG.miterClampFactor);
    const left = offsetPolyline(center, leftExt, CONFIG.miterClampFactor);
    ribbonGeoms.push(stripGeometry(left, right));

    // Markings: dashed separators between same-direction lanes.
    for (const dirEdge of twin ? [edge, twin] : [edge]) {
      const sign = dirEdge === edge ? 1 : -1; // twin lanes sit on the other side
      const N = dirEdge.laneCount;
      for (let i = 1; i < N; i++) {
        // Boundary between lane i-1 and i (offsets per lanes.js conventions).
        const off = twin ? W * i : W * (i - N / 2);
        dashGeometries(
          offsetPolyline(center, sign * off, CONFIG.miterClampFactor),
          R.dashLengthM,
          R.dashGapM,
          0.12,
          markingGeoms
        );
      }
    }
    // Solid center strip on two-way roads.
    if (twin) {
      const right = offsetPolyline(center, R.centerStripWidthM / 2, CONFIG.miterClampFactor);
      const left = offsetPolyline(center, -R.centerStripWidthM / 2, CONFIG.miterClampFactor);
      markingGeoms.push(stripGeometry(left, right));
    }
  }

  // Stop lines at signalized lane ends.
  const pEnd = { x: 0, z: 0 };
  const hEnd = { x: 0, z: 0 };
  for (const sig of network.signals.values()) {
    for (const edgeId of sig.groups.keys()) {
      const edge = network.edges.get(edgeId);
      for (const lane of edge.lanes) {
        lane.pointAt(lane.length, pEnd);
        lane.headingAt(lane.length, hEnd);
        markingGeoms.push(quadGeometry(pEnd, hEnd, R.stopLineDepthM, W));
      }
    }
  }

  // Junction discs (radius R_node + 1).
  const discGeoms = [];
  for (const node of network.nodes.values()) {
    if (node.legCount < 2) continue;
    const radius = (network.nodeRadii.get(node.id) || 4) + 1;
    const disc = new THREE.CircleGeometry(radius, 16);
    disc.rotateX(-Math.PI / 2);
    disc.translate(node.x, 0, node.z);
    disc.deleteAttribute('uv'); // match ribbon attributes for merging
    discGeoms.push(disc);
  }

  const roadMat = new THREE.MeshLambertMaterial({
    color: R.roadColor,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const discMat = new THREE.MeshLambertMaterial({ color: R.roadColor });
  const markMat = new THREE.MeshBasicMaterial({ color: R.markingColor });

  const meshes = [];
  if (ribbonGeoms.length) {
    const g = BufferGeometryUtils.mergeGeometries(ribbonGeoms);
    ribbonGeoms.forEach((x) => x.dispose());
    const m = new THREE.Mesh(g, roadMat);
    m.position.y = R.roadY;
    m.receiveShadow = true;
    group.add(m);
    meshes.push(m);
  }
  if (discGeoms.length) {
    const g = BufferGeometryUtils.mergeGeometries(discGeoms);
    discGeoms.forEach((x) => x.dispose());
    const m = new THREE.Mesh(g, discMat);
    m.position.y = R.roadY;
    m.receiveShadow = true;
    group.add(m);
    meshes.push(m);
  }
  if (markingGeoms.length) {
    const g = BufferGeometryUtils.mergeGeometries(markingGeoms);
    markingGeoms.forEach((x) => x.dispose());
    const m = new THREE.Mesh(g, markMat);
    m.position.y = R.markingY;
    group.add(m);
    meshes.push(m);
  }

  return {
    group,
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      roadMat.dispose();
      discMat.dispose();
      markMat.dispose();
    },
  };
}
