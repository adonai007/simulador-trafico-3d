// Main-corridor extraction for the space-time trajectory diagram (spec F4).
// Groups directed edges by street name (fallback: OSM way id), chains them by
// toNode -> fromNode connectivity in a SINGLE direction (immediate twins are
// excluded so a chain never U-turns onto itself), and picks the chain with the
// largest total length — on the default La Paz zone "El Prado" (Av. 16 de
// Julio / Villazón axis) wins naturally.
//
// Returned offsets are built from MEAN LANE lengths + MEAN CONNECTOR lengths
// (not edge.lengthM): vehicle `s` lives on junction-trimmed lanes and crosses
// connectors between them, so this keeps trajectories continuous through
// junctions (no sawtooth at every crossing). Build-time only — allocations OK.

/** Mean lane length of an edge (lanes are trimmed; lengths differ per lane). */
function meanLaneLength(edge) {
  const lanes = edge.lanes;
  if (!lanes || !lanes.length) return edge.lengthM;
  let sum = 0;
  for (let i = 0; i < lanes.length; i++) sum += lanes[i].length;
  return sum / lanes.length;
}

/**
 * Find the longest named corridor of `network` (auto/vehicle edges only — v1).
 * Returns {
 *   name: string,                       // display name (Spanish fallback)
 *   lengthM: number,                    // total corridor length (lanes + connectors)
 *   baseS: Map(edgeId -> cumOffset),    // edge -> distance of its lane start
 *   connBaseS: Map(connectorId -> cumOffset), // connectors linking chain edges
 *   speedMs: number,                    // length-weighted mean speed (color scale)
 * } or null when the network has no edges.
 */
export function findCorridor(network) {
  if (!network || !network.edges || network.edges.size === 0) return null;

  // --- 1. Group edges by name (fallback: way id). Twins share the group. ---
  const groups = new Map();
  for (const edge of network.edges.values()) {
    const key = edge.name || `way:${edge.wayId}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(edge);
  }

  // --- 2. Chain each group by toNode -> fromNode; keep the longest chain. ---
  let best = null; // { chain: Edge[], total: number }
  for (const arr of groups.values()) {
    const byFrom = new Map(); // fromNode -> edges[] (within group)
    for (const e of arr) {
      let list = byFrom.get(e.fromNode);
      if (!list) {
        list = [];
        byFrom.set(e.fromNode, list);
      }
      list.push(e);
    }
    const toNodes = new Set();
    for (const e of arr) toNodes.add(e.toNode);
    // Chain starts: edges no group edge feeds into. Loops (e.g. named ring
    // roads) have none — every edge may seed, the visited set ends the walk.
    const starts = arr.filter((e) => !toNodes.has(e.fromNode));
    const seeds = starts.length ? starts : arr;
    const visited = new Set();
    for (const seed of seeds) {
      if (visited.has(seed.id)) continue;
      const chain = [];
      let total = 0;
      let cur = seed;
      while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        chain.push(cur);
        total += cur.lengthM;
        const nexts = byFrom.get(cur.toNode);
        let nxt = null;
        if (nexts) {
          for (const cand of nexts) {
            if (visited.has(cand.id)) continue;
            if (cand.id === cur.twinId) continue; // single direction — no U-turn
            nxt = cand;
            break;
          }
        }
        cur = nxt;
      }
      if (!best || total > best.total) best = { chain, total };
    }
  }
  if (!best || !best.chain.length) return null; // unreachable with >=1 edge, but safe
  const chain = best.chain;

  // --- 3. Cumulative offsets along the chain (lanes + linking connectors). ---
  const connsByPair = new Map(); // "inEdgeId_outEdgeId" -> connectors[]
  if (network.connectors) {
    for (const c of network.connectors.values()) {
      const key = `${c.inEdgeId}_${c.outEdgeId}`;
      let list = connsByPair.get(key);
      if (!list) {
        list = [];
        connsByPair.set(key, list);
      }
      list.push(c);
    }
  }

  const baseS = new Map();
  const connBaseS = new Map();
  let cum = 0;
  let speedWeighted = 0;
  let laneTotal = 0;
  for (let i = 0; i < chain.length; i++) {
    const edge = chain[i];
    baseS.set(edge.id, cum);
    const len = meanLaneLength(edge);
    speedWeighted += edge.speedMs * len;
    laneTotal += len;
    cum += len;
    const next = chain[i + 1];
    if (!next) continue;
    const conns = connsByPair.get(`${edge.id}_${next.id}`);
    if (!conns) continue; // movement pruned (rare) -> tiny gap, fine for a scatter
    let mean = 0;
    for (const c of conns) {
      connBaseS.set(c.id, cum);
      mean += c.length;
    }
    cum += mean / conns.length;
  }

  return {
    name: chain[0].name ?? 'vía sin nombre',
    lengthM: cum,
    baseS,
    connBaseS,
    speedMs: laneTotal > 0 ? speedWeighted / laneTotal : chain[0].speedMs,
  };
}
