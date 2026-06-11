// Apply real elevation to a built network (F1). Called at the end of
// buildNetwork (after buildConnectors):
//   1. node.elev for every kept node.
//   2. ONE longitudinal profile per UNDIRECTED edge pair (forward twin
//      computes; the twin samples the same profile reversed — guarantees both
//      directions agree). Profile = sampler at trimmedPoints, moving-average
//      smoothed (~30 m), endpoints eased to the adjacent node.elev over the
//      last ~12 m ("junction plateau" — keeps discs / ribbon ends / connectors
//      C0-continuous), grades clamped to |de/ds| <= maxGrade.
//   3. lane.elev sampled from the edge profile at arc FRACTION (all lanes of
//      an edge share the longitudinal profile; no cross-lane tilt).
//   4. connector.elev = lerp(in-lane end elev, out-lane start elev) — flat-ish
//      across the junction thanks to the plateau.
//   5. lane/connector gradeAt swapped from the shared ZERO_GRADE to a real
//      binary-search lookup (posAt already reads lane.elev dynamically).
// Flat sampler: every shape still gets node.elev / edge.elevVals (0 / null) so
// object shapes stay stable across worlds.

import { CONFIG } from '../config.js';
import { cumulativeLengths, gradeAtParam, clamp } from '../util/math2d.js';

/** Linear interpolation over a (cum, vals) profile at arc length s. */
export function profileAt(cum, vals, s) {
  const n = cum.length;
  if (s <= 0) return vals[0];
  const total = cum[n - 1];
  if (s >= total) return vals[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const ds = cum[hi] - cum[lo] || 1;
  const t = (s - cum[lo]) / ds;
  return vals[lo] + (vals[hi] - vals[lo]) * t;
}

/** Moving-average smooth of vals along cum with the given window (meters). */
function smoothProfile(cum, vals, windowM) {
  const half = windowM / 2;
  const n = vals.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = cum[i];
    let sum = 0;
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (Math.abs(cum[j] - s) <= half) {
        sum += vals[j];
        count++;
      }
    }
    out[i] = count ? sum / count : vals[i];
  }
  return out;
}

/** Ease both profile ends to the node elevations over plateauM (smoothstep). */
function applyPlateau(cum, vals, elevFrom, elevTo, plateauM) {
  const total = cum[cum.length - 1];
  for (let i = 0; i < vals.length; i++) {
    let w = clamp(cum[i] / plateauM, 0, 1);
    w = w * w * (3 - 2 * w);
    vals[i] = elevFrom + (vals[i] - elevFrom) * w;
    let w2 = clamp((total - cum[i]) / plateauM, 0, 1);
    w2 = w2 * w2 * (3 - 2 * w2);
    vals[i] = elevTo + (vals[i] - elevTo) * w2;
  }
}

/** Clamp consecutive grades to |de/ds| <= maxGrade (forward then backward). */
function clampGrades(cum, vals, maxGrade) {
  for (let i = 1; i < vals.length; i++) {
    const ds = cum[i] - cum[i - 1];
    const lim = maxGrade * ds;
    vals[i] = clamp(vals[i], vals[i - 1] - lim, vals[i - 1] + lim);
  }
  for (let i = vals.length - 2; i >= 0; i--) {
    const ds = cum[i + 1] - cum[i];
    const lim = maxGrade * ds;
    vals[i] = clamp(vals[i], vals[i + 1] - lim, vals[i + 1] + lim);
  }
}

/**
 * Grade clamp that PINS BOTH ENDPOINTS (junction continuity): every value is
 * kept inside the feasibility band [max(eFrom-g·s, eTo-g·(L-s)),
 * min(eFrom+g·s, eTo+g·(L-s))] AND within ±g·ds of its predecessor. Both
 * constraints are simultaneously satisfiable whenever |eTo-eFrom| <= g·L
 * (the band moves by at most g·ds per step), so one forward pass guarantees
 * exact endpoints and |de/ds| <= g everywhere. Infeasible endpoints (only
 * possible when node relaxation was skipped) fall back to the local clamp.
 */
function clampProfileBand(cum, vals, eFrom, eTo, g) {
  const n = vals.length;
  const total = cum[n - 1];
  if (Math.abs(eTo - eFrom) > g * total) {
    clampGrades(cum, vals, g);
    return;
  }
  vals[0] = eFrom;
  for (let i = 1; i < n; i++) {
    const s = cum[i];
    const ds = s - cum[i - 1];
    let lo = Math.max(eFrom - g * s, eTo - g * (total - s), vals[i - 1] - g * ds);
    let hi = Math.min(eFrom + g * s, eTo + g * (total - s), vals[i - 1] + g * ds);
    if (lo > hi) {
      const m = (lo + hi) / 2; // numeric guard (band width ~0)
      lo = m;
      hi = m;
    }
    vals[i] = vals[i] < lo ? lo : vals[i] > hi ? hi : vals[i];
  }
  vals[n - 1] = eTo;
}

/**
 * Relax node elevations until every undirected edge's MEAN grade (node to
 * node over its trimmed length) is <= maxMeanGrade — La Paz has short blocks
 * steeper than the road clamp; without this the profile clamp would have to
 * break junction continuity (cliff steps at discs, connector spikes). Roads
 * are effectively "regraded"; the terrain road-splat follows the road
 * profiles, so render stays consistent.
 */
function relaxNodeElevations(graph, maxMeanGrade) {
  const pairs = [];
  for (const edge of graph.edges.values()) {
    if (edge.twinId != null && edge.twinId < edge.id) continue;
    const pts = edge.trimmedPoints || edge.points;
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dz = pts[i].z - pts[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    pairs.push({
      a: graph.nodes.get(edge.fromNode),
      b: graph.nodes.get(edge.toNode),
      maxDiff: maxMeanGrade * Math.max(len, 1),
    });
  }
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < pairs.length; i++) {
      const { a, b, maxDiff } = pairs[i];
      const diff = b.elev - a.elev;
      const excess = Math.abs(diff) - maxDiff;
      if (excess > 0.001) {
        const shift = (Math.sign(diff) * excess) / 2;
        a.elev += shift;
        b.elev -= shift;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Real gradeAt for a segment with a filled elev table. */
function makeGradeAt(seg) {
  return (s) => gradeAtParam(seg.cumLen, seg.elev, s);
}

/**
 * applyElevation(graph, lanes, connectors, sampler) — mutates the network in
 * place. Build-time only (allocations fine). Flat sampler -> zeroed/null
 * fields, shared ZERO_GRADE stays in place.
 */
export function applyElevation(graph, lanes, connectors, sampler) {
  const cfg = CONFIG.elevation;

  // Stable shapes for every world flavor.
  for (const node of graph.nodes.values()) node.elev = 0;
  for (const edge of graph.edges.values()) {
    edge.elevVals = null;
    edge.elevCum = null;
  }
  if (sampler.flat) return;

  // Epsilon margin: profiles are stored as Float32 — rounding can push a
  // stored grade a hair past the clamp; shave it off the working limit.
  const gMax = cfg.maxGrade - 1e-4;

  // 1) Node elevations, then graph-wide relaxation so every edge is
  //    grade-feasible end to end (80% of the clamp leaves profile headroom).
  for (const node of graph.nodes.values()) {
    node.elev = sampler.elevAt(node.x, node.z);
  }
  relaxNodeElevations(graph, cfg.maxGrade * 0.8);

  // 2) Edge profiles, once per undirected pair (forward twin = lower id wins,
  //    same rule as roadMesh ribbons).
  for (const edge of graph.edges.values()) {
    if (edge.twinId != null && edge.twinId < edge.id) continue;
    const pts = edge.trimmedPoints || edge.points;
    const cumArr = cumulativeLengths(pts);
    const cum = Float32Array.from(cumArr);
    const raw = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i++) raw[i] = sampler.elevAt(pts[i].x, pts[i].z);
    const vals = smoothProfile(cum, raw, cfg.smoothWindowM);
    const eFrom = graph.nodes.get(edge.fromNode).elev;
    const eTo = graph.nodes.get(edge.toNode).elev;
    applyPlateau(cum, vals, eFrom, eTo, cfg.junctionPlateauM);
    clampProfileBand(cum, vals, eFrom, eTo, gMax);
    edge.elevVals = vals;
    edge.elevCum = cum;

    if (edge.twinId != null) {
      // Twin = the same profile traversed backwards, resampled onto the
      // twin's own trimmedPoints arc lengths (vertex counts may differ).
      const twin = graph.edges.get(edge.twinId);
      const tPts = twin.trimmedPoints || twin.points;
      const tCum = Float32Array.from(cumulativeLengths(tPts));
      const total = cum[cum.length - 1];
      const tTotal = tCum[tCum.length - 1] || 1;
      const tVals = new Float32Array(tPts.length);
      for (let i = 0; i < tPts.length; i++) {
        tVals[i] = profileAt(cum, vals, total * (1 - tCum[i] / tTotal));
      }
      twin.elevVals = tVals;
      twin.elevCum = tCum;
    }
  }

  // 3) Lane elevations: sample the edge profile at arc fraction, then clamp
  //    again with pinned endpoints (offset lanes on curves are shorter/longer
  //    than the centerline, which can push a clamped centerline grade past
  //    the limit). Endpoints stay = node elevations -> connectors stay flat.
  for (const edge of graph.edges.values()) {
    const cum = edge.elevCum;
    const vals = edge.elevVals;
    const total = cum[cum.length - 1];
    for (const lane of edge.lanes) {
      const n = lane.points.length;
      const elev = new Float32Array(n);
      const laneTotal = lane.length || 1;
      for (let i = 0; i < n; i++) {
        elev[i] = profileAt(cum, vals, total * (lane.cumLen[i] / laneTotal));
      }
      clampProfileBand(lane.cumLen, elev, vals[0], vals[vals.length - 1], gMax);
      lane.elev = elev;
      lane.gradeAt = makeGradeAt(lane);
    }
  }

  // 4) Connectors: linear in-end -> out-start (flat-ish thanks to plateau).
  for (const conn of connectors.values()) {
    const inLane = lanes.get(conn.fromLaneId);
    const outLane = lanes.get(conn.toLaneId);
    const e0 = inLane.elev[inLane.elev.length - 1];
    const e1 = outLane.elev[0];
    const n = conn.points.length;
    const elev = new Float32Array(n);
    const total = conn.length || 1;
    for (let i = 0; i < n; i++) {
      const t = conn.cumLen[i] / total;
      elev[i] = e0 + (e1 - e0) * t;
    }
    conn.elev = elev;
    conn.gradeAt = makeGradeAt(conn);
  }
}
