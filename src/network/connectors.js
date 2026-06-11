// Bezier turn connectors, lane-turn assignment, conflict pairs. Spec §1.8.
//
// Connector = Lane-API object with extras:
//   { id, isConnector: true, turnType: 'through'|'right'|'left'|'uturn',
//     junctionId, inEdgeId, outEdgeId, fromLaneId, toLaneId,
//     signalGroup: 'NS'|'EW'|null, conflicts: [{connectorId, myEntryS, theirEntryS}],
//     speedMs (curvature-capped), points, cumLen, length, vehicles[],
//     pointAt(s,out?), headingAt(s,out?) }

import { CONFIG } from '../config.js';
import {
  signedAngle,
  sampleCubicBezier,
  clamp,
  dist2d,
  circumradius,
} from '../util/math2d.js';
import { makeLaneFromPoints } from './lanes.js';

export const TURN_PRIORITY = { through: 3, right: 2, left: 1, uturn: 0 };

function classifyTurn(alphaRad) {
  const cfg = CONFIG.connectors;
  const deg = (alphaRad * 180) / Math.PI; // right turns positive
  if (Math.abs(deg) < cfg.throughAngleDeg) return 'through';
  if (deg >= cfg.throughAngleDeg && deg <= cfg.uturnAngleDeg) return 'right';
  if (deg <= -cfg.throughAngleDeg && deg >= -cfg.uturnAngleDeg) return 'left';
  return 'uturn';
}

/** Heading vector {x,z} at the end (into junction) of an edge centerline. */
function edgeEndHeading(edge) {
  const pts = edge.trimmedPoints || edge.points;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** Heading vector {x,z} at the start (out of junction) of an edge centerline. */
function edgeStartHeading(edge) {
  const pts = edge.trimmedPoints || edge.points;
  const a = pts[0];
  const b = pts[1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** Map an incoming lane index to an outgoing lane index for through moves. */
function throughOutIdx(inIdx, N, M) {
  if (M <= 1) return 0;
  const t = N <= 1 ? 0.5 : inIdx / (N - 1);
  return Math.round(t * (M - 1));
}

let nextConnectorId = 1;

function createConnector(inLane, outLane, turnType, junctionId, signalGroup) {
  const cfg = CONFIG.connectors;
  const p0 = inLane.pointAt(inLane.length);
  const p3 = outLane.pointAt(0);
  const hIn = inLane.headingAt(inLane.length);
  const hOut = outLane.headingAt(0);
  const k = clamp(cfg.bezierKFactor * dist2d(p0, p3), cfg.bezierKMin, cfg.bezierKMax);
  const p1 = { x: p0.x + hIn.x * k, z: p0.z + hIn.z * k };
  const p2 = { x: p3.x - hOut.x * k, z: p3.z - hOut.z * k };
  const pts = sampleCubicBezier(p0, p1, p2, p3, cfg.sampleStepM);

  // Curvature speed cap: vMax = min(laneSpeed, sqrt(aLat * Rmin)).
  let rMin = Infinity;
  for (let i = 2; i < pts.length; i++) {
    const r = circumradius(pts[i - 2], pts[i - 1], pts[i]);
    if (r < rMin) rMin = r;
  }
  const laneSpeed = Math.min(inLane.speedMs, outLane.speedMs);
  const speedMs = Number.isFinite(rMin)
    ? Math.min(laneSpeed, Math.sqrt(cfg.aLatMs2 * rMin))
    : laneSpeed;

  const conn = makeLaneFromPoints(pts, {
    id: `C${nextConnectorId++}`,
    isConnector: true,
    turnType,
    junctionId,
    inEdgeId: inLane.edgeId,
    outEdgeId: outLane.edgeId,
    fromLaneId: inLane.id,
    toLaneId: outLane.id,
    signalGroup,
    conflicts: [],
    speedMs: Math.max(1.5, speedMs),
  });
  inLane.outConnectors.push(conn);
  return conn;
}

/** Build all connectors for one junction node. Returns connector array. */
function buildJunctionConnectors(graph, node, signals) {
  const out = [];
  const sig = signals.get(node.id) || null;

  for (const inEdgeId of node.edgesIn) {
    const inEdge = graph.edges.get(inEdgeId);
    const hIn = edgeEndHeading(inEdge);
    const signalGroup = sig ? sig.groups.get(inEdgeId) ?? null : null;

    // Classify each outgoing edge as a movement.
    const movements = [];
    for (const outEdgeId of node.edgesOut) {
      if (!CONFIG.connectors.allowUTurns && outEdgeId === inEdge.twinId) continue;
      const outEdge = graph.edges.get(outEdgeId);
      const alpha = signedAngle(hIn, edgeStartHeading(outEdge));
      const turnType = classifyTurn(alpha);
      if (turnType === 'uturn' && !CONFIG.connectors.allowUTurns) continue;
      movements.push({ outEdge, alpha, turnType });
    }
    if (!movements.length) continue;

    const N = inEdge.lanes.length;
    const made = []; // {inIdx, outEdge, outIdx, turnType}
    const has = (inIdx, outEdgeId, outIdx) =>
      made.some((m) => m.inIdx === inIdx && m.outEdge.id === outEdgeId && m.outIdx === outIdx);
    const add = (inIdx, movement, outIdx) => {
      if (has(inIdx, movement.outEdge.id, outIdx)) return;
      made.push({ inIdx, outEdge: movement.outEdge, outIdx, turnType: movement.turnType });
    };

    const throughs = movements
      .filter((m) => m.turnType === 'through')
      .sort((a, b) => Math.abs(a.alpha) - Math.abs(b.alpha));
    const rights = movements.filter((m) => m.turnType === 'right');
    const lefts = movements.filter((m) => m.turnType === 'left');
    const uturns = movements.filter((m) => m.turnType === 'uturn');

    // Through: spread incoming lanes proportionally over outgoing lanes.
    for (const m of throughs) {
      const M = m.outEdge.lanes.length;
      for (let i = 0; i < N; i++) add(i, m, throughOutIdx(i, N, M));
    }
    // Right turns from the rightmost lane (index N-1) to the rightmost out lane.
    for (const m of rights) add(N - 1, m, m.outEdge.lanes.length - 1);
    // Left turns from the leftmost lane (index 0) to the leftmost out lane.
    for (const m of lefts) add(0, m, 0);
    for (const m of uturns) add(0, m, 0); // only when allowUTurns

    // Guarantee 1: every incoming lane has >= 1 connector.
    const fallbackOrder = [...throughs, ...rights, ...lefts, ...uturns];
    for (let i = 0; i < N; i++) {
      if (made.some((m) => m.inIdx === i)) continue;
      const m = fallbackOrder[0];
      const M = m.outEdge.lanes.length;
      add(i, m, throughOutIdx(i, N, M));
    }
    // Guarantee 2: every outgoing lane of each movement target gets one when possible.
    for (const m of movements) {
      const M = m.outEdge.lanes.length;
      for (let o = 0; o < M; o++) {
        if (made.some((x) => x.outEdge.id === m.outEdge.id && x.outIdx === o)) continue;
        // Feed from the incoming lane already serving this edge nearest in index.
        const serving = made.filter((x) => x.outEdge.id === m.outEdge.id);
        let inIdx;
        if (serving.length) {
          serving.sort((a, b) => Math.abs(a.outIdx - o) - Math.abs(b.outIdx - o));
          inIdx = serving[0].inIdx;
        } else {
          inIdx = m.turnType === 'right' ? N - 1 : m.turnType === 'left' ? 0 : throughOutIdx(o, M, N);
        }
        add(inIdx, m, o);
      }
    }

    for (const m of made) {
      const conn = createConnector(
        inEdge.lanes[m.inIdx],
        m.outEdge.lanes[m.outIdx],
        m.turnType,
        node.id,
        signalGroup
      );
      conn._hIn = hIn; // used for right-hand priority below, stripped after
      out.push(conn);
    }
  }
  return out;
}

/** First arc length along `a` that comes within `maxDist` of polyline `b`, or -1. */
function firstApproachS(a, b, maxDist) {
  const d2max = maxDist * maxDist;
  for (let i = 0; i < a.points.length; i++) {
    const p = a.points[i];
    for (let j = 0; j < b.points.length; j++) {
      const q = b.points[j];
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < d2max) return a.cumLen[i];
    }
  }
  return -1;
}

/**
 * Register conflict pairs between connectors of one junction.
 * Priority: through > right > left; tie -> right-hand priority.
 * Stored on the LOWER-priority connector. At signalized junctions only
 * movements that can be green simultaneously (same group) conflict.
 */
function registerConflicts(connectors, signalized) {
  const maxDist = CONFIG.connectors.conflictDistM;
  for (let i = 0; i < connectors.length; i++) {
    for (let j = i + 1; j < connectors.length; j++) {
      const a = connectors[i];
      const b = connectors[j];
      if (a.inEdgeId === b.inEdgeId) continue; // same approach -> no conflict
      if (signalized && a.signalGroup !== b.signalGroup) continue; // never green together
      const sA = firstApproachS(a, b, maxDist);
      if (sA < 0) continue;
      const sB = firstApproachS(b, a, maxDist);
      if (sB < 0) continue;

      let winner = null;
      const pa = TURN_PRIORITY[a.turnType];
      const pb = TURN_PRIORITY[b.turnType];
      if (pa > pb) winner = a;
      else if (pb > pa) winner = b;
      else {
        // Tie -> right-hand priority: yield to the connector approaching from
        // your right. signedAngle(hA, hB) < 0 -> b comes from a's right.
        winner = signedAngle(a._hIn, b._hIn) < 0 ? b : a;
      }
      const loser = winner === a ? b : a;
      const mine = loser === a ? sA : sB;
      const theirs = loser === a ? sB : sA;
      loser.conflicts.push({ connectorId: winner.id, myEntryS: mine, theirEntryS: theirs });
    }
  }
}

/**
 * Build connectors for the whole graph. Fills lane.outConnectors and returns
 * Map(connectorId -> connector). Junction connector lists are stored on
 * nodes: node.connectors = [ids].
 */
export function buildConnectors(graph, signals) {
  nextConnectorId = 1;
  const all = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.edgesIn.length || !node.edgesOut.length) continue;
    const conns = buildJunctionConnectors(graph, node, signals);
    registerConflicts(conns, signals.has(node.id));
    node.connectors = conns.map((c) => c.id);
    for (const c of conns) {
      delete c._hIn;
      all.set(c.id, c);
    }
  }
  return all;
}
