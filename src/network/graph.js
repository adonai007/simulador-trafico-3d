// OSM ways -> directed edge graph. Spec §1.4 / §1.5:
//   1. split ways at junction nodes (refCount >= 2 or way endpoint)
//   2. degree-2 collapse (keep traffic_signals nodes)
//   3. micro-edge merge (< 8 m junction-junction, midpoint collapse, <= 3 passes)
//   4. directed edges (two per two-way segment, twins linked)
//   5. iterative Tarjan SCC -> keep largest as core + boundary stubs
//   6. entries / exits with spawn weights

import { CONFIG } from '../config.js';
import { polylineLength, dist2d, dedupePolyline } from '../util/math2d.js';

let nextSegId = 1;

/** Split kept ways at junction nodes into undirected segments. */
function splitWays(parsed, projection) {
  const refCount = new Map();
  for (const way of parsed.ways) {
    for (const ref of way.nodeRefs) {
      refCount.set(ref, (refCount.get(ref) || 0) + 1);
    }
  }
  const isJunction = (way, idx) => {
    const ref = way.nodeRefs[idx];
    return idx === 0 || idx === way.nodeRefs.length - 1 || refCount.get(ref) >= 2;
  };

  const segments = new Map(); // segId -> segment
  for (const way of parsed.ways) {
    let startIdx = 0;
    for (let i = 1; i < way.nodeRefs.length; i++) {
      if (!isJunction(way, i)) continue;
      const refs = way.nodeRefs.slice(startIdx, i + 1);
      const points = refs.map((r) => {
        const n = parsed.nodes.get(r);
        const p = projection.toLocal(n.lat, n.lon);
        return { x: p.x, z: p.z };
      });
      const deduped = dedupePolyline(points);
      if (deduped.length >= 2 && refs[0] !== refs[refs.length - 1]) {
        const id = nextSegId++;
        segments.set(id, {
          id,
          fromNode: refs[0],
          toNode: refs[refs.length - 1],
          points: deduped,
          oneway: way.oneway,
          lanesFwd: way.lanesFwd,
          lanesBwd: way.lanesBwd,
          speedMs: way.speedMs,
          highwayClass: way.highwayClass,
          wayId: way.id,
        });
      }
      startIdx = i;
    }
  }
  return segments;
}

function buildNodeIndex(segments) {
  const nodeSegs = new Map(); // nodeId -> Set(segId)
  for (const seg of segments.values()) {
    if (!nodeSegs.has(seg.fromNode)) nodeSegs.set(seg.fromNode, new Set());
    if (!nodeSegs.has(seg.toNode)) nodeSegs.set(seg.toNode, new Set());
    nodeSegs.get(seg.fromNode).add(seg.id);
    nodeSegs.get(seg.toNode).add(seg.id);
  }
  return nodeSegs;
}

/** Reverse a segment in place (geometry + direction-dependent lane counts). */
function reverseSegment(seg) {
  seg.points.reverse();
  const t = seg.fromNode;
  seg.fromNode = seg.toNode;
  seg.toNode = t;
  const lf = seg.lanesFwd;
  seg.lanesFwd = seg.lanesBwd;
  seg.lanesBwd = lf;
}

/**
 * Merge chains through nodes with exactly 2 incident segments and identical
 * {lane counts, class, oneway, speed} — unless the node is traffic_signals.
 */
function collapseDegree2(segments, parsed) {
  const nodeSegs = buildNodeIndex(segments);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, segIds] of nodeSegs) {
      if (segIds.size !== 2) continue;
      const node = parsed.nodes.get(nodeId);
      if (node?.tags?.highway === 'traffic_signals') continue; // keep (spec §1.4)
      const [idA, idB] = [...segIds];
      let a = segments.get(idA);
      let b = segments.get(idB);
      if (!a || !b || a === b) continue;
      if (a.fromNode === a.toNode || b.fromNode === b.toNode) continue;
      // Orient so that a ends at node and b starts at node. NEVER reverse a
      // one-way segment (that would flip traffic direction); two head-to-head
      // or tail-to-tail one-ways are a genuine flow junction -> keep the node.
      if (a.toNode === nodeId && b.fromNode === nodeId) {
        // already oriented
      } else if (b.toNode === nodeId && a.fromNode === nodeId) {
        const t = a;
        a = b;
        b = t;
      } else if (a.toNode === nodeId && b.toNode === nodeId) {
        if (b.oneway) continue;
        reverseSegment(b);
      } else if (a.fromNode === nodeId && b.fromNode === nodeId) {
        if (a.oneway) continue;
        reverseSegment(a);
      } else {
        continue;
      }
      if (a.fromNode === b.toNode) continue; // would create a loop
      const compatible =
        a.highwayClass === b.highwayClass &&
        a.oneway === b.oneway &&
        a.lanesFwd === b.lanesFwd &&
        a.lanesBwd === b.lanesBwd &&
        Math.abs(a.speedMs - b.speedMs) < 1e-6;
      if (!compatible) continue;
      // Merge b into a.
      a.points = dedupePolyline(a.points.concat(b.points.slice(1)));
      a.toNode = b.toNode;
      segments.delete(b.id);
      segIds.clear();
      nodeSegs.delete(nodeId);
      const endSet = nodeSegs.get(b.toNode);
      endSet.delete(b.id);
      endSet.add(a.id);
      changed = true;
      break; // re-scan (index mutated)
    }
  }
}

/**
 * Drop segments < minLen connecting two real junctions (degree >= 2 each);
 * merge the junction pair to the midpoint. Iterative, max `passes`.
 */
function mergeMicroEdges(segments, minLen, passes) {
  for (let pass = 0; pass < passes; pass++) {
    const nodeSegs = buildNodeIndex(segments);
    let merged = false;
    for (const seg of [...segments.values()]) {
      if (seg.fromNode === seg.toNode) continue;
      if (polylineLength(seg.points) >= minLen) continue;
      const degFrom = nodeSegs.get(seg.fromNode)?.size || 0;
      const degTo = nodeSegs.get(seg.toNode)?.size || 0;
      if (degFrom < 2 || degTo < 2) continue; // keep stubs
      const keep = seg.fromNode;
      const drop = seg.toNode;
      const mid = {
        x: (seg.points[0].x + seg.points[seg.points.length - 1].x) / 2,
        z: (seg.points[0].z + seg.points[seg.points.length - 1].z) / 2,
      };
      segments.delete(seg.id);
      for (const other of segments.values()) {
        let touched = false;
        if (other.fromNode === drop || other.fromNode === keep) {
          other.fromNode = keep;
          other.points[0] = { x: mid.x, z: mid.z };
          touched = true;
        }
        if (other.toNode === drop || other.toNode === keep) {
          other.toNode = keep;
          other.points[other.points.length - 1] = { x: mid.x, z: mid.z };
          touched = true;
        }
        if (touched) {
          other.points = dedupePolyline(other.points);
          // Degenerate after merge -> drop self-loops / zero-length leftovers.
          if (
            other.points.length < 2 ||
            (other.fromNode === other.toNode && polylineLength(other.points) < minLen * 2)
          ) {
            segments.delete(other.id);
          }
        }
      }
      merged = true;
      break;
    }
    if (!merged) break;
  }
}

/** Emit directed edges (with twins for two-way segments). */
function emitDirectedEdges(segments) {
  const edges = new Map();
  let nextId = 1;
  for (const seg of segments.values()) {
    const fwdId = nextId++;
    const fwd = {
      id: fwdId,
      fromNode: seg.fromNode,
      toNode: seg.toNode,
      points: seg.points.map((p) => ({ x: p.x, z: p.z })),
      lengthM: polylineLength(seg.points),
      laneCount: Math.max(1, seg.lanesFwd),
      speedMs: seg.speedMs,
      highwayClass: seg.highwayClass,
      oneway: seg.oneway,
      twinId: null,
      wayId: seg.wayId,
      lanes: [], // filled by lanes.js
    };
    edges.set(fwdId, fwd);
    if (!seg.oneway && seg.lanesBwd > 0) {
      const bwdId = nextId++;
      const bwd = {
        id: bwdId,
        fromNode: seg.toNode,
        toNode: seg.fromNode,
        points: seg.points.slice().reverse().map((p) => ({ x: p.x, z: p.z })),
        lengthM: fwd.lengthM,
        laneCount: Math.max(1, seg.lanesBwd),
        speedMs: seg.speedMs,
        highwayClass: seg.highwayClass,
        oneway: false,
        twinId: fwdId,
        wayId: seg.wayId,
        lanes: [],
      };
      fwd.twinId = bwdId;
      edges.set(bwdId, bwd);
    }
  }
  return edges;
}

/** Iterative Tarjan SCC over the directed node graph. Returns Map(nodeId -> sccId). */
function tarjanScc(nodeIds, outEdgesByNode, edges) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Map();
  const sccOf = new Map();
  const stack = [];
  let nextIndex = 0;
  let sccCount = 0;

  for (const root of nodeIds) {
    if (index.has(root)) continue;
    // Explicit DFS stack: frames of [nodeId, iterator position].
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        index.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.set(v, true);
      }
      const outs = outEdgesByNode.get(v) || [];
      let advanced = false;
      while (frame[1] < outs.length) {
        const w = edges.get(outs[frame[1]]).toNode;
        frame[1]++;
        if (!index.has(w)) {
          work.push([w, 0]);
          advanced = true;
          break;
        } else if (onStack.get(w)) {
          lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
        }
      }
      if (advanced) continue;
      // v finished.
      if (lowlink.get(v) === index.get(v)) {
        const sccId = sccCount++;
        for (;;) {
          const w = stack.pop();
          onStack.set(w, false);
          sccOf.set(w, sccId);
          if (w === v) break;
        }
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(v)));
      }
    }
  }
  return { sccOf, sccCount };
}

/**
 * Build the pruned directed graph from parsed OSM data.
 * Returns {
 *   nodes: Map(nodeId -> {id, x, z, edgesIn[], edgesOut[], legCount, inCore}),
 *   edges: Map(edgeId -> {id, fromNode, toNode, points[], lengthM, laneCount,
 *                          speedMs, highwayClass, twinId, lanes[]}),
 *   entries: [{nodeId, edgeId, weight}],
 *   exits:   [{nodeId, edgeId, weight}],
 *   spawnMode: 'entries' | 'onNetwork',
 *   bbox: {minX, maxX, minZ, maxZ}
 * }
 */
export function buildGraph(parsed, projection) {
  nextSegId = 1;
  const segments = splitWays(parsed, projection);
  collapseDegree2(segments, parsed);
  mergeMicroEdges(segments, CONFIG.minEdgeLengthM, CONFIG.microEdgeMergePasses);
  const edges = emitDirectedEdges(segments);

  // Node records.
  const nodes = new Map();
  const getNode = (id, p) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, x: p.x, z: p.z, edgesIn: [], edgesOut: [], legCount: 0, inCore: false };
      nodes.set(id, n);
    }
    return n;
  };
  for (const e of edges.values()) {
    getNode(e.fromNode, e.points[0]).edgesOut.push(e.id);
    getNode(e.toNode, e.points[e.points.length - 1]).edgesIn.push(e.id);
  }
  // legCount = number of undirected roads incident (twins counted once).
  for (const n of nodes.values()) {
    const seen = new Set();
    let legs = 0;
    for (const eid of [...n.edgesIn, ...n.edgesOut]) {
      if (seen.has(eid)) continue;
      const e = edges.get(eid);
      seen.add(eid);
      if (e.twinId != null) seen.add(e.twinId);
      legs++;
    }
    n.legCount = legs;
  }

  // --- SCC prune ---
  const outByNode = new Map();
  for (const n of nodes.values()) outByNode.set(n.id, n.edgesOut);
  const { sccOf, sccCount } = tarjanScc(nodes.keys(), outByNode, edges);
  const sccSize = new Array(sccCount).fill(0);
  for (const sccId of sccOf.values()) sccSize[sccId]++;
  let coreScc = 0;
  for (let i = 1; i < sccCount; i++) if (sccSize[i] > sccSize[coreScc]) coreScc = i;

  const inCore = (nodeId) => sccOf.get(nodeId) === coreScc;
  for (const n of nodes.values()) n.inCore = inCore(n.id);

  // Undirected degree per node (twin pairs = 1).
  const undirectedDeg = (n) => n.legCount;

  const keptEdges = new Map();
  const entries = [];
  const exits = [];
  const classWeight = (cls) => CONFIG.classWeights[cls] || 1;

  for (const e of edges.values()) {
    const fromIn = inCore(e.fromNode);
    const toIn = inCore(e.toNode);
    if (fromIn && toIn) {
      keptEdges.set(e.id, e);
      continue;
    }
    // Boundary stubs: one endpoint in core, outer endpoint total degree 1.
    if (toIn && !fromIn && undirectedDeg(nodes.get(e.fromNode)) === 1) {
      keptEdges.set(e.id, e);
      entries.push({
        nodeId: e.fromNode,
        edgeId: e.id,
        weight: e.laneCount * classWeight(e.highwayClass),
      });
    } else if (fromIn && !toIn && undirectedDeg(nodes.get(e.toNode)) === 1) {
      keptEdges.set(e.id, e);
      exits.push({
        nodeId: e.toNode,
        edgeId: e.id,
        weight: e.laneCount * classWeight(e.highwayClass),
      });
    }
  }
  // Fix dangling twin references and rebuild node in/out lists for kept set.
  for (const e of keptEdges.values()) {
    if (e.twinId != null && !keptEdges.has(e.twinId)) e.twinId = null;
  }
  const keptNodes = new Map();
  for (const e of keptEdges.values()) {
    for (const nid of [e.fromNode, e.toNode]) {
      if (!keptNodes.has(nid)) {
        const old = nodes.get(nid);
        keptNodes.set(nid, { ...old, edgesIn: [], edgesOut: [] });
      }
    }
    keptNodes.get(e.fromNode).edgesOut.push(e.id);
    keptNodes.get(e.toNode).edgesIn.push(e.id);
  }
  // Recompute legCount on the kept graph.
  for (const n of keptNodes.values()) {
    const seen = new Set();
    let legs = 0;
    for (const eid of [...n.edgesIn, ...n.edgesOut]) {
      if (seen.has(eid)) continue;
      const e = keptEdges.get(eid);
      seen.add(eid);
      if (e.twinId != null) seen.add(e.twinId);
      legs++;
    }
    n.legCount = legs;
  }

  const spawnMode = entries.length > 0 && exits.length > 0 ? 'entries' : 'onNetwork';

  // bbox over kept geometry.
  const bbox = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const e of keptEdges.values()) {
    for (const p of e.points) {
      if (p.x < bbox.minX) bbox.minX = p.x;
      if (p.x > bbox.maxX) bbox.maxX = p.x;
      if (p.z < bbox.minZ) bbox.minZ = p.z;
      if (p.z > bbox.maxZ) bbox.maxZ = p.z;
    }
  }

  return { nodes: keptNodes, edges: keptEdges, entries, exits, spawnMode, bbox };
}
