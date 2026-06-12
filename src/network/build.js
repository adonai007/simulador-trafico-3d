// Orchestrates parse -> graph -> lanes -> signals -> connectors -> routing
// into the Network object consumed by sim + render.
//
// NOTE: signals are detected BEFORE connectors (spec lists connectors first)
// because conflict registration needs signal groups. Documented in Deviations.

import { createProjection } from '../geo/projection.js';
import { FLAT_SAMPLER } from '../geo/elevation.js';
import { parseOsm } from '../osm/parse.js';
import { buildGraph } from './graph.js';
import { buildLanes } from './lanes.js';
import { buildSignals } from './signals.js';
import { buildConnectors } from './connectors.js';
import { buildRouting } from './routing.js';
import { buildBusStops } from './busStops.js';
import { applyElevation } from './elevation.js';

/**
 * Network object shape (stable contract for sim/UI builders):
 * {
 *   center: {lat, lon}, projection,
 *   nodes: Map(nodeId -> {id, x, z, edgesIn[], edgesOut[], legCount, signal?, connectors?}),
 *   edges: Map(edgeId -> {id, fromNode, toNode, points[], trimmedPoints[],
 *                          lengthM, laneCount, speedMs, highwayClass, twinId, lanes: Lane[]}),
 *   lanes: Map(laneId -> Lane),            // real lanes only
 *   connectors: Map(connectorId -> Lane),  // isConnector: true, turnType, conflicts[]
 *   signals: Map(junctionId -> {junctionId, groups: Map(edgeId->'NS'|'EW'), plan}),
 *   nodeRadii: Map(nodeId -> R_node meters),
 *   entries: [{nodeId, edgeId, weight}], exits: [...], spawnMode,
 *   graphStats: {pruneMode, totalDirectedEdges, keptDirectedEdges,
 *                totalDirectedLengthM, keptDirectedLengthM},  // V2.1 A
 *   routing, bbox: {minX,maxX,minZ,maxZ}, totalLaneKm, dispose(),
 *   busStops: [{id, laneId, lane, s, name}]  // F2; lane.busStops = ascending-s array | null
 * }
 * Lane API: {id, edgeId, index, length, points, cumLen, vehicles[],
 *            outConnectors[], speedMs, elev (Float32Array|null),
 *            pointAt(s,out?), headingAt(s,out?), posAt(s,out?) -> {x,y,z},
 *            gradeAt(s) -> signed forward slope}
 * Stop line = lane end (s = lane.length).
 * `sampler` (F1): elevation sampler from src/geo/elevation.js — defaults to
 * FLAT_SAMPLER (y = 0 everywhere). Exposed as network.elevation.
 */
export function buildNetwork(osmJson, center, sampler = FLAT_SAMPLER) {
  const projection = createProjection(center.lat, center.lon);
  const parsed = parseOsm(osmJson);
  const graph = buildGraph(parsed, projection);
  const { lanes, nodeRadii } = buildLanes(graph);
  const signals = buildSignals(graph, parsed, projection);
  const connectors = buildConnectors(graph, signals);
  const routing = buildRouting(graph);
  applyElevation(graph, lanes, connectors, sampler);
  // F2: must run after buildConnectors — stamps the stable-shape `busStops`
  // default (null) onto every lane AND connector before sim/render touch them.
  const busStops = buildBusStops(graph, parsed, projection, connectors);

  let totalLaneM = 0;
  for (const lane of lanes.values()) totalLaneM += lane.length;

  return {
    center,
    projection,
    nodes: graph.nodes,
    edges: graph.edges,
    lanes,
    connectors,
    signals,
    nodeRadii,
    entries: graph.entries,
    exits: graph.exits,
    spawnMode: graph.spawnMode,
    graphStats: graph.stats, // V2.1 A: prune funnel (kept length / retention)
    routing,
    busStops,
    elevation: sampler,
    bbox: graph.bbox,
    totalLaneKm: totalLaneM / 1000,
    dispose() {
      // Network data is plain JS; render modules own GPU resources.
    },
  };
}
