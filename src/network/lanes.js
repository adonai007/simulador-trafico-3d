// Per-lane offset polylines, stop-line trimming, arc-length tables. Spec §1.6.
// Lane API (used by sim + render): lane.pointAt(s, out?), lane.headingAt(s, out?).
// Stop line = lane end (s = lane.length).

import { CONFIG } from '../config.js';
import {
  offsetPolyline,
  resamplePolyline,
  cumulativeLengths,
  trimPolyline,
  pointAtParam,
  headingAtParam,
  dedupePolyline,
} from '../util/math2d.js';

/**
 * Wrap a polyline in the shared Lane API. Used for real lanes and connectors.
 * `pointAt`/`headingAt` accept an optional `out` object to avoid per-frame
 * allocations in the render/sim loops.
 */
export function makeLaneFromPoints(points, props) {
  const pts = dedupePolyline(points);
  const cumLen = cumulativeLengths(pts);
  const lane = {
    points: pts,
    cumLen,
    length: cumLen[cumLen.length - 1],
    vehicles: [],
    outConnectors: [],
    isConnector: false,
    ...props,
  };
  lane.pointAt = (s, out) => pointAtParam(lane.points, lane.cumLen, s, out);
  lane.headingAt = (s, out) => headingAtParam(lane.points, lane.cumLen, s, out);
  return lane;
}

/**
 * Junction radius: R_node = max over incident edges
 * (laneCountBothDirs_i * laneWidth / 2) + pad. Spec §1.6.
 */
export function computeNodeRadii(graph) {
  const radii = new Map();
  for (const node of graph.nodes.values()) {
    let maxHalf = 0;
    const seen = new Set();
    for (const eid of [...node.edgesIn, ...node.edgesOut]) {
      if (seen.has(eid)) continue;
      const e = graph.edges.get(eid);
      seen.add(eid);
      let both = e.laneCount;
      if (e.twinId != null) {
        seen.add(e.twinId);
        both += graph.edges.get(e.twinId).laneCount;
      }
      const half = (both * CONFIG.laneWidthM) / 2;
      if (half > maxHalf) maxHalf = half;
    }
    radii.set(node.id, maxHalf + CONFIG.nodeRadiusPadM);
  }
  return radii;
}

/**
 * Build lanes for every edge. Mutates edges: sets `edge.trimmedPoints` (road
 * ribbon centerline, junction-trimmed) and `edge.lanes` (Lane[] index 0 =
 * innermost/leftmost, N-1 = rightmost). Returns { lanes: Map, nodeRadii: Map }.
 */
export function buildLanes(graph) {
  const nodeRadii = computeNodeRadii(graph);
  const lanes = new Map();
  const W = CONFIG.laneWidthM;

  for (const edge of graph.edges.values()) {
    const fromNode = graph.nodes.get(edge.fromNode);
    const toNode = graph.nodes.get(edge.toNode);
    // Skip trims at degree-1 stub ends (entries/exits keep full length).
    const trimStart = fromNode.legCount <= 1 ? 0 : nodeRadii.get(edge.fromNode);
    const trimEnd = toNode.legCount <= 1 ? 0 : nodeRadii.get(edge.toNode);
    const trimmed = trimPolyline(
      edge.points,
      trimStart,
      trimEnd,
      CONFIG.minEdgeAfterTrimM
    );
    edge.trimmedPoints = trimmed;

    const N = edge.laneCount;
    const twoWay = edge.twinId != null;
    edge.lanes = [];
    for (let i = 0; i < N; i++) {
      // Positive offset = right of travel (projection.js convention).
      const offset = twoWay
        ? W * (i + 0.5) // two-way: lanes sit right of the shared centerline
        : W * (i - (N - 1) / 2); // one-way: bundle centered on the centerline
      const offPts = offsetPolyline(trimmed, offset, CONFIG.miterClampFactor);
      const resampled = resamplePolyline(offPts, CONFIG.laneResampleStepM);
      const lane = makeLaneFromPoints(resampled, {
        id: `L${edge.id}_${i}`,
        edgeId: edge.id,
        index: i,
        speedMs: edge.speedMs,
      });
      edge.lanes.push(lane);
      lanes.set(lane.id, lane);
    }
  }
  return { lanes, nodeRadii };
}
