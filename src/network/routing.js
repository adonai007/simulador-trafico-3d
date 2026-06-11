// Routing (spec §1.9): precomputed reverse-Dijkstra next-hop tables keyed by
// exit. Edge adjacency is derived from the ACTUAL turn connectors (so pruned
// U-turns are never routed) — buildRouting must run after buildConnectors.
//
//   buildRouting(graph) -> {
//     nextEdge: Map(exitEdgeId -> Map(edgeId -> nextEdgeId)),   // spec contract
//     tables:   Map(exitEdgeId -> { next, costS, distM }),      // rich view
//     exits:    [{nodeId, edgeId, weight}],
//     pickExit(rng, fromEdgeId) -> exitEdgeId | null            // w ∝ weight * dist^0.5
//   }
//
// cost = edge traversal time (lengthM / speedMs) + connector traversal time.
// distM tracks meters along the chosen shortest-time path (used for the
// distance-biased exit pick).

import { CONFIG } from '../config.js';

/** Minimal binary min-heap on parallel arrays (build-time only). */
function createHeap() {
  const keys = [];
  const ids = [];
  return {
    get size() {
      return keys.length;
    },
    push(key, id) {
      keys.push(key);
      ids.push(id);
      let i = keys.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        const tk = keys[p]; keys[p] = keys[i]; keys[i] = tk;
        const ti = ids[p]; ids[p] = ids[i]; ids[i] = ti;
        i = p;
      }
    },
    pop(out) {
      out.key = keys[0];
      out.id = ids[0];
      const lk = keys.pop();
      const li = ids.pop();
      if (keys.length) {
        keys[0] = lk;
        ids[0] = li;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < keys.length && keys[l] < keys[m]) m = l;
          if (r < keys.length && keys[r] < keys[m]) m = r;
          if (m === i) break;
          const tk = keys[m]; keys[m] = keys[i]; keys[i] = tk;
          const ti = ids[m]; ids[m] = ids[i]; ids[i] = ti;
          i = m;
        }
      }
      return out;
    },
  };
}

export function buildRouting(graph) {
  const edges = graph.edges;

  // Reverse adjacency from connectors: revAdj.get(edgeB) = predecessors
  // [{prev, w, m}] where w/m = cost/meters of traversing prev edge + the
  // cheapest connector prev->B.
  const revAdj = new Map();
  for (const e of edges.values()) revAdj.set(e.id, []);
  const best = new Map(); // "in_out" -> record
  for (const e of edges.values()) {
    const eCost = e.lengthM / Math.max(e.speedMs, 0.5);
    for (const lane of e.lanes) {
      for (const c of lane.outConnectors) {
        const w = eCost + c.length / Math.max(c.speedMs, 0.5);
        const key = `${e.id}_${c.outEdgeId}`;
        const prev = best.get(key);
        if (prev === undefined || w < prev.w) {
          best.set(key, { prev: e.id, out: c.outEdgeId, w, m: e.lengthM + c.length });
        }
      }
    }
  }
  for (const rec of best.values()) {
    const list = revAdj.get(rec.out);
    if (list) list.push(rec);
  }

  const _pop = { key: 0, id: 0 };

  /** Dijkstra backward from one exit edge over the reverse adjacency. */
  function dijkstraFrom(exitEdgeId) {
    const next = new Map(); // edgeId -> next edgeId toward exit
    const costS = new Map(); // time from START of edge to exit (traversing it)
    const distM = new Map(); // meters along the shortest-time path
    const exitEdge = edges.get(exitEdgeId);
    costS.set(exitEdgeId, exitEdge.lengthM / Math.max(exitEdge.speedMs, 0.5));
    distM.set(exitEdgeId, exitEdge.lengthM);
    const heap = createHeap();
    heap.push(costS.get(exitEdgeId), exitEdgeId);
    while (heap.size) {
      heap.pop(_pop);
      const u = _pop.id;
      if (_pop.key > costS.get(u)) continue; // stale entry
      const preds = revAdj.get(u);
      if (!preds) continue;
      const cu = costS.get(u);
      const du = distM.get(u);
      for (let i = 0; i < preds.length; i++) {
        const rec = preds[i];
        const cand = cu + rec.w;
        const old = costS.get(rec.prev);
        if (old === undefined || cand < old) {
          costS.set(rec.prev, cand);
          distM.set(rec.prev, du + rec.m);
          next.set(rec.prev, u);
          heap.push(cand, rec.prev);
        }
      }
    }
    return { next, costS, distM };
  }

  const tables = new Map();
  const nextEdge = new Map();
  for (const ex of graph.exits) {
    const t = dijkstraFrom(ex.edgeId);
    tables.set(ex.edgeId, t);
    nextEdge.set(ex.edgeId, t.next);
  }

  const exits = graph.exits;
  const distExp = CONFIG.sim.spawn.exitDistExponent;

  /**
   * Distance-biased exit pick: weight ∝ exitWeight × dist^0.5 over exits
   * reachable from `fromEdgeId`. Allocation-free (two passes).
   */
  function pickExit(rng, fromEdgeId) {
    let total = 0;
    for (let i = 0; i < exits.length; i++) {
      const t = tables.get(exits[i].edgeId);
      const d = t.distM.get(fromEdgeId);
      if (d === undefined || d <= 0) continue;
      total += exits[i].weight * Math.pow(d, distExp);
    }
    if (total <= 0) return null;
    let r = rng.next() * total;
    let last = null;
    for (let i = 0; i < exits.length; i++) {
      const t = tables.get(exits[i].edgeId);
      const d = t.distM.get(fromEdgeId);
      if (d === undefined || d <= 0) continue;
      last = exits[i].edgeId;
      r -= exits[i].weight * Math.pow(d, distExp);
      if (r <= 0) return last;
    }
    return last;
  }

  return { nextEdge, tables, exits, pickExit };
}
