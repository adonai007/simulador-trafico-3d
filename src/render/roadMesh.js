// Road ribbons + junction discs + markings + stop lines. Spec §3.2.
// Few draw calls: one merged mesh for ribbons, one for discs, one for markings.
// F3: per-edge congestion heatmap on the ribbon mesh via a dynamic vertex
// color attribute (see setHeatmap/updateHeatmap on the returned object).

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { offsetPolyline, cumulativeLengths, pointAtParam, headingAtParam } from '../util/math2d.js';
import { profileAt } from '../network/elevation.js';

// ---- F3 congestion heatmap -------------------------------------------------
// Ramp anchor colors (linear-ish sRGB components; thresholds live in
// CONFIG.heatmap). One world at a time + synchronous use -> module scratch.
const HEAT_GREEN = { r: 0.13, g: 0.78, b: 0.25 };
const HEAT_YELLOW = { r: 1.0, g: 0.84, b: 0.1 };
const HEAT_RED = { r: 0.88, g: 0.1, b: 0.1 };
const _rgb = { r: 0, g: 0, b: 0 };

/**
 * Piecewise-linear speed-ratio ramp into `out`:
 * green at >= greenT, yellow at yellowT, red at <= redT.
 */
function heatRamp(ratio, greenT, yellowT, redT, out) {
  if (ratio >= greenT) {
    out.r = HEAT_GREEN.r;
    out.g = HEAT_GREEN.g;
    out.b = HEAT_GREEN.b;
  } else if (ratio >= yellowT) {
    const t = (ratio - yellowT) / (greenT - yellowT); // 0 = yellow, 1 = green
    out.r = HEAT_YELLOW.r + (HEAT_GREEN.r - HEAT_YELLOW.r) * t;
    out.g = HEAT_YELLOW.g + (HEAT_GREEN.g - HEAT_YELLOW.g) * t;
    out.b = HEAT_YELLOW.b + (HEAT_GREEN.b - HEAT_YELLOW.b) * t;
  } else if (ratio >= redT) {
    const t = (ratio - redT) / (yellowT - redT); // 0 = red, 1 = yellow
    out.r = HEAT_RED.r + (HEAT_YELLOW.r - HEAT_RED.r) * t;
    out.g = HEAT_RED.g + (HEAT_YELLOW.g - HEAT_RED.g) * t;
    out.b = HEAT_RED.b + (HEAT_YELLOW.b - HEAT_RED.b) * t;
  } else {
    out.r = HEAT_RED.r;
    out.g = HEAT_RED.g;
    out.b = HEAT_RED.b;
  }
}
// ----------------------------------------------------------------------------

/**
 * Triangulated strip between two equal-length polylines (up normals).
 * `rowY` (F1, optional): per-row elevation — row i = centerline elevation at
 * trimmedPoints[i]; left/right share it (no cross-road tilt). Null -> y = 0.
 */
function stripGeometry(left, right, rowY) {
  const n = left.length;
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const indices = [];
  for (let i = 0; i < n; i++) {
    const y = rowY ? rowY[i] : 0;
    positions[i * 6 + 0] = left[i].x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = left[i].z;
    positions[i * 6 + 3] = right[i].x;
    positions[i * 6 + 4] = y;
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

/**
 * Quad centered at p, oriented by unit heading h: len along h, width across.
 * yBack/yFront (F1): elevation at the rear/front corner rows (0 when flat).
 */
function quadGeometry(p, h, len, width, yBack = 0, yFront = 0) {
  const rx = -h.z; // right normal
  const rz = h.x;
  const hl = len / 2;
  const hw = width / 2;
  const corners = [
    { x: p.x - h.x * hl - rx * hw, y: yBack, z: p.z - h.z * hl - rz * hw },
    { x: p.x - h.x * hl + rx * hw, y: yBack, z: p.z - h.z * hl + rz * hw },
    { x: p.x + h.x * hl - rx * hw, y: yFront, z: p.z + h.z * hl - rz * hw },
    { x: p.x + h.x * hl + rx * hw, y: yFront, z: p.z + h.z * hl + rz * hw },
  ];
  const positions = new Float32Array(12);
  const normals = new Float32Array(12);
  corners.forEach((c, i) => {
    positions[i * 3] = c.x;
    positions[i * 3 + 1] = c.y;
    positions[i * 3 + 2] = c.z;
    normals[i * 3 + 1] = 1;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex([0, 1, 2, 2, 1, 3]); // CCW from above
  return g;
}

/**
 * Dashes (len dash / gap) along a polyline, as merged quads. profCum/profVals
 * (F1, optional): the owning edge's longitudinal profile — dash corner heights
 * are sampled at the matching arc FRACTION (offset polylines differ in length
 * from the centerline).
 */
function dashGeometries(points, dashLen, gapLen, width, out, profCum, profVals) {
  const cum = cumulativeLengths(points);
  const total = cum[cum.length - 1];
  const scale = profCum ? profCum[profCum.length - 1] / (total || 1) : 0;
  const p = { x: 0, z: 0 };
  const h = { x: 0, z: 0 };
  const hl = dashLen / 2;
  for (let s = hl; s + hl < total; s += dashLen + gapLen) {
    pointAtParam(points, cum, s, p);
    headingAtParam(points, cum, s, h);
    let yB = 0;
    let yF = 0;
    if (profVals) {
      yB = profileAt(profCum, profVals, (s - hl) * scale);
      yF = profileAt(profCum, profVals, (s + hl) * scale);
    }
    out.push(quadGeometry(p, h, dashLen, width, yB, yF));
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
  // F3: one entry per ribbon strip. mergeGeometries concatenates attributes in
  // array order, so prefix-summing position.count gives EXACT vertex ranges in
  // the merged geometry. Junction discs stay asphalt (documented limitation).
  const heatmapRanges = [];
  let ribbonVertCount = 0;

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
    // offsetPolyline preserves vertex count -> rows align with edge.elevVals.
    const strip = stripGeometry(left, right, edge.elevVals);
    heatmapRanges.push({
      edge,
      twin,
      vertStart: ribbonVertCount,
      vertCount: strip.attributes.position.count,
    });
    ribbonVertCount += strip.attributes.position.count;
    ribbonGeoms.push(strip);

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
          markingGeoms,
          edge.elevCum,
          edge.elevVals
        );
      }
    }
    // Solid center strip on two-way roads.
    if (twin) {
      const right = offsetPolyline(center, R.centerStripWidthM / 2, CONFIG.miterClampFactor);
      const left = offsetPolyline(center, -R.centerStripWidthM / 2, CONFIG.miterClampFactor);
      markingGeoms.push(stripGeometry(left, right, edge.elevVals));
    }
  }

  // Stop lines at signalized lane ends (elevated at the lane-end height, F1).
  const pEnd = { x: 0, y: 0, z: 0 };
  const hEnd = { x: 0, z: 0 };
  for (const sig of network.signals.values()) {
    for (const edgeId of sig.groups.keys()) {
      const edge = network.edges.get(edgeId);
      for (const lane of edge.lanes) {
        lane.posAt(lane.length, pEnd);
        lane.headingAt(lane.length, hEnd);
        markingGeoms.push(quadGeometry(pEnd, hEnd, R.stopLineDepthM, W, pEnd.y, pEnd.y));
      }
    }
  }

  // Junction discs (radius R_node + 1) at the node elevation (F1).
  const discGeoms = [];
  for (const node of network.nodes.values()) {
    if (node.legCount < 2) continue;
    const radius = (network.nodeRadii.get(node.id) || 4) + 1;
    const disc = new THREE.CircleGeometry(radius, 16);
    disc.rotateX(-Math.PI / 2);
    disc.translate(node.x, node.elev || 0, node.z);
    disc.deleteAttribute('uv'); // match ribbon attributes for merging
    discGeoms.push(disc);
  }

  // vertexColors from creation (F3): the color attribute starts WHITE, and
  // white x material.color === the plain asphalt look — no shader recompile on
  // toggle, zero cost while the heatmap is off.
  const roadMat = new THREE.MeshLambertMaterial({
    color: R.roadColor,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const discMat = new THREE.MeshLambertMaterial({ color: R.roadColor });
  const markMat = new THREE.MeshBasicMaterial({ color: R.markingColor });

  const meshes = [];
  let ribbonColorAttr = null; // F3: merged ribbons' per-vertex color
  if (ribbonGeoms.length) {
    const g = BufferGeometryUtils.mergeGeometries(ribbonGeoms);
    ribbonGeoms.forEach((x) => x.dispose());
    const colors = new Float32Array(g.attributes.position.count * 3).fill(1); // white
    ribbonColorAttr = new THREE.BufferAttribute(colors, 3);
    ribbonColorAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', ribbonColorAttr);
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

  // ---- F3 congestion heatmap API ----
  let heatmapOn = false;

  /**
   * Repaint ribbon vertex colors from each edge pair's speed-ratio EWMA
   * (worst direction wins). Writes straight into the attribute array via
   * module scratch — zero alloc. No-op while disabled. Call ~1 Hz wall-clock.
   * CONFIG.heatmap may be absent until integration -> ?? defaults.
   */
  function updateHeatmap() {
    if (!heatmapOn || !ribbonColorAttr) return;
    const hm = CONFIG.heatmap;
    const greenT = hm?.greenRatio ?? 0.8;
    const yellowT = hm?.yellowRatio ?? 0.45;
    const redT = hm?.redRatio ?? 0.2;
    const arr = ribbonColorAttr.array;
    for (let i = 0; i < heatmapRanges.length; i++) {
      const rg = heatmapRanges[i];
      // Worst direction of the undirected pair (detectors.js owns _speedRatio;
      // ?? 1 only guards the pre-detector instant of a world build).
      let ratio = rg.edge._speedRatio ?? 1;
      if (rg.twin) {
        const tr = rg.twin._speedRatio ?? 1;
        if (tr < ratio) ratio = tr;
      }
      heatRamp(ratio, greenT, yellowT, redT, _rgb);
      const end = (rg.vertStart + rg.vertCount) * 3;
      for (let p = rg.vertStart * 3; p < end; p += 3) {
        arr[p] = _rgb.r;
        arr[p + 1] = _rgb.g;
        arr[p + 2] = _rgb.b;
      }
    }
    ribbonColorAttr.needsUpdate = true;
  }

  /**
   * Toggle the heatmap. ON: material goes white so vertex colors show pure,
   * painted immediately. OFF: restore asphalt material color + refill the
   * attribute white once (white x roadColor = exact original look).
   */
  function setHeatmap(enabled) {
    enabled = !!enabled;
    if (enabled === heatmapOn) return;
    heatmapOn = enabled;
    if (!ribbonColorAttr) return;
    if (enabled) {
      roadMat.color.setHex(0xffffff);
      updateHeatmap();
    } else {
      roadMat.color.setHex(R.roadColor);
      ribbonColorAttr.array.fill(1);
      ribbonColorAttr.needsUpdate = true;
    }
  }

  /**
   * Test hook (F3 e2e; NOT hot-path — allocates). Other meshes also carry
   * `color` attributes (buildings/vehicles/debug), so tests must reach the
   * ribbon attribute through here instead of traversing the scene.
   */
  function getHeatmapState() {
    return {
      enabled: heatmapOn,
      colors: ribbonColorAttr ? ribbonColorAttr.array : null,
      rangeCount: heatmapRanges.length,
      ranges: heatmapRanges,
    };
  }

  return {
    group,
    setHeatmap,
    updateHeatmap,
    getHeatmapState,
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      roadMat.dispose();
      discMat.dispose();
      markMat.dispose();
    },
  };
}
