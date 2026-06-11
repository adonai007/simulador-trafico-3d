// Bus stops (F2): snap OSM highway=bus_stop nodes onto the network.
//
// Each stop projects onto the RIGHTMOST lane (curbside) of every edge; the
// closest one within maxSnapDistM wins. Projecting onto the rightmost-lane
// polyline (instead of the edge centerline) gives the snap distance AND the
// stop's arc length in one pass, and on two-way roads it auto-selects the
// travel direction whose curb the stop was mapped on (right-hand traffic).
// Build-time O(stops × edges × points) — fine at this scale.
//
// Output (attached to the network by build.js):
//   network.busStops = [{id, laneId, lane, s, name}]
//   lane.busStops    = ascending-s array of those records (null when none)
//
// Stable shapes: EVERY lane and connector gets `busStops` (null default) here,
// before the sim ever touches a segment. (lanes.js is outside F2 ownership in
// the parallel build stage, so the default lives here instead of
// makeLaneFromPoints — call this right after buildConnectors.)

import { CONFIG } from '../config.js';
import { clamp, projectPointToPolyline } from '../util/math2d.js';

const END_CLEAR_M = 15; // keep stops clear of junction ends: s in [15, L-15]

/**
 * buildBusStops(graph, parsed, projection, connectors) -> busStops[]
 * `graph` only needs an `edges` Map with built lanes (the Network object
 * works too). Tolerates a missing CONFIG.busStops block (local default) so
 * the module stays green until the integration pass.
 */
export function buildBusStops(graph, parsed, projection, connectors) {
  const maxSnap = CONFIG.busStops?.maxSnapDistM ?? 25;

  // Stable shape for every segment kind: busStops exists from birth.
  for (const edge of graph.edges.values()) {
    for (const lane of edge.lanes) lane.busStops = null;
  }
  if (connectors) {
    for (const c of connectors.values()) c.busStops = null;
  }

  const busStops = [];
  const stopNodes = parsed.busStopNodes || [];
  const p = { x: 0, z: 0 };
  const lanesWithStops = new Set();

  for (const stop of stopNodes) {
    projection.toLocal(stop.lat, stop.lon, p);
    let bestLane = null;
    let bestS = 0;
    let bestD = maxSnap;
    for (const edge of graph.edges.values()) {
      const lane = edge.lanes[edge.lanes.length - 1]; // rightmost = curbside
      const r = projectPointToPolyline(lane.points, lane.cumLen, p);
      if (r.dist <= bestD) {
        bestD = r.dist;
        bestLane = lane;
        bestS = r.s;
      }
    }
    if (!bestLane) continue; // > maxSnap from every edge
    if (bestLane.length < 2 * END_CLEAR_M) continue; // short lane -> drop
    const rec = {
      id: stop.id,
      laneId: bestLane.id,
      lane: bestLane,
      s: clamp(bestS, END_CLEAR_M, bestLane.length - END_CLEAR_M),
      name: (stop.tags && stop.tags.name) || null,
    };
    busStops.push(rec);
    if (bestLane.busStops === null) bestLane.busStops = [];
    bestLane.busStops.push(rec);
    lanesWithStops.add(bestLane);
  }

  // Sim contract: per-lane stops sorted by ascending s.
  for (const lane of lanesWithStops) {
    lane.busStops.sort((a, b) => a.s - b.s);
  }
  return busStops;
}
