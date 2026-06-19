// Fixed-step traffic engine (spec §2):
//   - Poisson spawning at entry stubs with retry queue (§2.6), vehicle mix
//   - routed next-hop following (reverse-Dijkstra tables, §1.9) with
//     mandatory-lane-change flags and automatic re-routing (no teleports)
//   - IDM car-following with cross-segment leader lookahead (§2.2)
//   - red light + conflict block as virtual standing obstacles; final accel is
//     min() of all restrictive terms, never an average (§2.3)
//   - connector conflict yielding with priorities, 4 s gap acceptance and the
//     8 s starvation deadlock breaker (§2.4)
//   - MOBIL discretionary + mandatory lane changes (§2.5)
//   - edge detectors + global aggregates (§5), sim-speed/pause controls (§2.1)
//   - street closures with coalesced step-start routing rebuild + incident
//     phantom vehicles (V3 C1, spec D1/D2)
// Step order: closure rebuild -> spawn -> decide (+MOBIL) -> lane changes ->
// integrate -> transitions/despawn -> incident expiry -> detectors.
// Hot paths are allocation-free: scratch objects are module/closure-level,
// per-vehicle scratch fields are created once in the vehicle factory.

import { CONFIG } from '../config.js';
import { clamp } from '../util/math2d.js';
import { createRng } from '../util/rng.js';
import { createVehicle, createAmbulance, pickVehicleType } from './vehicle.js';
import { idmAccel } from './idm.js';
import { signalState, setSimTime } from './signalsRuntime.js';
import { mobilDecision } from './mobil.js';
import { createDetectors } from './detectors.js';
import { TURN_PRIORITY } from '../network/connectors.js';
import { createRoutingBuilder } from '../network/routing.js';
// --- E2b: replay recorder import ---
// Owned by the sim so the ring is per-world (reset on swap) and fed from the
// step-5 sampling marker. main.js reads it via the `replay` public hook.
import { createReplayRecorder } from './replay.js';
// --- end E2b: replay recorder import ---

const HARD_TRIP_CAP_M = 8000; // safety net against pathological loops
const MAX_SPAWN_QUEUE = 20; // arrivals kept waiting per entry lane

export function createSimulation(network) {
  const rng = createRng(CONFIG.rngSeed);
  const vehicles = [];
  let time = 0;
  let demandVehPerHour = CONFIG.sim.spawn.defaultDemandVehPerHour;
  let simSpeed = 1;
  let paused = false;
  let lastStepMs = 0;

  const simCfg = CONFIG.sim;
  const mobilCfg = simCfg.mobil;
  // --- E1 --- emergency state (V5). emCfg falls back to off-safe defaults so
  // the module stays green if the config block is missing (busCfg pattern).
  const emCfg = CONFIG.emergency ?? {
    enabled: false, meshType: 'suv', maxConcurrent: 3, signalSlowdownMs: 6,
    yieldRadiusM: 60, yieldLcSafeDecel: -7, yieldEdgeOffsetM: 1.2, yieldSlowFactor: 0.55,
    routeToIncident: true,
  };
  let ambulanceCount = 0; // live ambulances (capped at emCfg.maxConcurrent)
  let yieldingCount = 0; // civilians with an active _yielding lease this step (debug)
  // --- end E1 ---
  let routing = network.routing; // C1: reassigned by the closure rebuild (D2)
  const hasRouting =
    network.spawnMode === 'entries' && routing.tables && routing.tables.size > 0;
  const detectors = createDetectors(network);
  // --- E2b: replay recorder instance ---
  // Per-world flat ring (preallocated once in createReplayRecorder). Fed from
  // the step-5 sampling marker (sim-time gated); paused while replayMode is ON.
  const replayRecorder = createReplayRecorder({ vehicles });
  // --- end E2b: replay recorder instance ---

  // ---- Closures & incidents state (V3 C1) ----
  // ?? fallbacks keep the module green if config blocks are absent (busCfg pattern).
  const closuresCfg = CONFIG.closures ?? { recomputeBudgetMs: 50, chunkExitsPerStep: 8 };
  const incidentsCfg = CONFIG.incidents ?? {
    durationS: 90,
    phantomLenM: 4.6,
    preferMultiLane: true,
  };
  const closedEdges = new Set(); // closed edge ids (both twins of a pair)
  const incidents = []; // [{id, lane, s, until, veh}] — veh is the phantom
  let closuresDirty = false; // closeEdge/openEdge only flag; step() coalesces (D2)
  let closureVersion = 0; // bumped on every closure/incident change (worksMesh polls)
  let routingVersion = 0; // bumped on every routing table swap
  let pendingRoutingBuilder = null; // chunked rebuild in flight (double buffer)

  // ---- Congestion-sensitive routing (V6 R1) — default OFF ----
  // routingCfg fallback keeps the module green if the config block is absent
  // (closuresCfg pattern). `congestionRouting` is the live flag; while ON the
  // step() loop kicks a congestion-weighted rebuild every routingCfg.rebuildEveryS
  // sim-seconds through the SAME budgeted builder closures use. The rebuild
  // reads each edge's `_speedRatio` (detectors EWMA) as the congestion signal,
  // so it must be gated to NOT clobber a closure rebuild already in flight.
  const routingCfg = CONFIG.routing ?? {
    congestionEnabled: false, rebuildEveryS: 15, alpha: 2.5, gamma: 1.5, maxPenalty: 6,
  };
  // Penalty params snapshot handed to the builder (stable object, mutated never).
  const congestionParams = {
    enabled: false,
    alpha: routingCfg.alpha,
    gamma: routingCfg.gamma,
    maxPenalty: routingCfg.maxPenalty,
  };
  let congestionRouting = routingCfg.congestionEnabled === true;
  let nextCongestionRebuildT = routingCfg.rebuildEveryS; // first rebuild after one period
  let congestionRebuilds = 0; // completed congestion-weighted swaps (e2e hook)

  // ---- Stats: trip accumulators + metrics history ring (V5 E2a) ----
  // statsCfg fallback keeps the module green if the config block is absent
  // (busCfg/closuresCfg pattern). All accumulators are plain numbers /
  // preallocated typed arrays — zero per-frame allocation, stable shapes.
  const statsCfg = CONFIG.stats ?? {
    completionsWindowS: 60,
    metricsHistoryCap: 900,
    metricsSampleS: 2.0,
    tripLogCap: 2000,
    bom: '﻿',
  };
  const tripAcc = {
    completed: 0, // total exit-despawned civilian trips
    sumTripTime: 0, // Σ tripTime (s) — mean trip time
    sumDelay: 0, // Σ delay (s) — mean + total delay
    sumDist: 0, // Σ trip distance (m)
    sumSpeed: 0, // Σ per-trip mean speed (m/s) — mean of trip means
  };
  // Completion ring for "rendimiento" (throughput, veh/min over a rolling
  // window): timestamps of recent completions, overwrite-oldest. Capacity is
  // generous (window/headway worst case) — sized once, zero-alloc thereafter.
  const COMPLETION_RING_CAP = 4096;
  const completionTimes = new Float64Array(COMPLETION_RING_CAP);
  let completionHead = 0;
  let completionCount = 0;

  // Capped trip log for viajes.csv: parallel typed arrays (no object churn).
  const tripLogCap = statsCfg.tripLogCap;
  const tripLog = {
    id: new Float64Array(tripLogCap),
    spawnT: new Float32Array(tripLogCap),
    exitT: new Float32Array(tripLogCap),
    tripTime: new Float32Array(tripLogCap),
    delay: new Float32Array(tripLogCap),
    dist: new Float32Array(tripLogCap),
    head: 0,
    count: 0,
  };

  // metricsHistory ring: preallocated Float32Arrays of global metrics samples,
  // sim-time gated (~statsCfg.metricsSampleS). Capped (~30 min). Zero-alloc.
  const mhCap = statsCfg.metricsHistoryCap;
  const metricsHistory = {
    t: new Float32Array(mhCap),
    vehicles: new Float32Array(mhCap),
    meanSpeedKmh: new Float32Array(mhCap),
    flowVehHLane: new Float32Array(mhCap),
    densityVehKm: new Float32Array(mhCap),
    head: 0, // next write slot
    count: 0, // valid samples (<= cap)
    cap: mhCap,
  };
  let nextMetricsSampleT = 0; // sim-time gate for the next ring sample

  /**
   * Fold a finished trip into tripStats + the capped trip log (V5 E2a). Called
   * from removeVehicle on the exit-despawn path. Excludes emergencies (event-
   * spawned, not demand) and phantoms (which never reach removeVehicle).
   * delay = max(0, tripTime - freeFlowTime): time lost to signals/queues vs an
   * unobstructed run at free speed.
   */
  function recordTrip(veh) {
    if (veh.isEmergency || veh.isPhantom) return;
    const tripTime = time - veh.spawnTime;
    if (tripTime <= 0) return; // guard against a degenerate same-step despawn
    const delay = Math.max(0, tripTime - veh._freeFlowTime);
    const dist = veh.tripDist;
    tripAcc.completed++;
    tripAcc.sumTripTime += tripTime;
    tripAcc.sumDelay += delay;
    tripAcc.sumDist += dist;
    tripAcc.sumSpeed += dist / tripTime; // this trip's mean speed (m/s)
    // Completion ring (throughput window).
    completionTimes[completionHead] = time;
    completionHead = (completionHead + 1) % COMPLETION_RING_CAP;
    if (completionCount < COMPLETION_RING_CAP) completionCount++;
    // Capped trip log (overwrite-oldest).
    const h = tripLog.head;
    tripLog.id[h] = veh.id;
    tripLog.spawnT[h] = veh.spawnTime;
    tripLog.exitT[h] = time;
    tripLog.tripTime[h] = tripTime;
    tripLog.delay[h] = delay;
    tripLog.dist[h] = dist;
    tripLog.head = (h + 1) % tripLogCap;
    if (tripLog.count < tripLogCap) tripLog.count++;
  }

  /** Live completions within the rolling rendimiento window (veh count). */
  function recentCompletions() {
    const tMin = time - statsCfg.completionsWindowS;
    let n = 0;
    for (let j = 0; j < completionCount; j++) {
      const idx = (completionHead - 1 - j + COMPLETION_RING_CAP * 2) % COMPLETION_RING_CAP;
      if (completionTimes[idx] < tMin) break; // newest-first, time-ordered
      n++;
    }
    return n;
  }

  /** Push one global-metrics sample into the ring (sim-time gated by caller). */
  function pushMetricsSample(g) {
    const h = metricsHistory.head;
    metricsHistory.t[h] = g.time;
    metricsHistory.vehicles[h] = g.vehicles;
    metricsHistory.meanSpeedKmh[h] = g.meanSpeedKmh;
    metricsHistory.flowVehHLane[h] = g.flowVehHLane;
    metricsHistory.densityVehKm[h] = g.densityVehKm;
    metricsHistory.head = (h + 1) % mhCap;
    if (metricsHistory.count < mhCap) metricsHistory.count++;
  }

  // ---- One-time wiring (stable object shapes for the hot loops) ----
  for (const e of network.edges.values()) {
    e._closed = false; // C1: closure flag stamped before any hot loop reads it
    for (const l of e.lanes) {
      l._edge = e;
      l._inConnCount = 0; // C1: inbound connectors (incident lane pick)
    }
  }
  for (const c of network.connectors.values()) {
    c._edge = null;
    c._outEdge = network.edges.get(c.outEdgeId) ?? null; // C1: closed-guard lookups
    const toLane = network.lanes.get(c.toLaneId);
    if (toLane) toLane._inConnCount++;
    const refs = [];
    for (const cf of c.conflicts) {
      const other = network.connectors.get(cf.connectorId);
      if (!other) continue;
      refs.push({
        conn: other,
        feedLane: network.lanes.get(other.fromLaneId),
        myEntryS: cf.myEntryS,
        theirEntryS: cf.theirEntryS,
        prio: TURN_PRIORITY[other.turnType],
      });
    }
    refs.sort((a, b) => b.prio - a.prio); // highest-priority first
    c.conflictRefs = refs;
  }

  // ---- Spawn lanes ----
  const spawnLanes = [];
  if (network.spawnMode === 'entries') {
    let totalW = 0;
    for (const e of network.entries) totalW += e.weight;
    for (const e of network.entries) {
      const edge = network.edges.get(e.edgeId);
      for (const lane of edge.lanes) {
        spawnLanes.push({ lane, share: e.weight / totalW / edge.lanes.length, queued: 0 });
      }
    }
  } else {
    // onNetwork fallback: random long-lane starts.
    const candidates = [...network.lanes.values()].filter((l) => l.length > 40);
    for (const lane of candidates) {
      spawnLanes.push({ lane, share: 1 / candidates.length, queued: 0 });
    }
  }

  // ---- Allocation-free array helpers ----
  function removeAt(arr, i) {
    arr.copyWithin(i, i + 1);
    arr.pop();
  }

  function insertSorted(arr, veh) {
    // Keep sorted by s descending.
    let i = arr.length;
    arr.push(veh);
    while (i > 0 && arr[i - 1].s < veh.s) {
      arr[i] = arr[i - 1];
      i--;
    }
    arr[i] = veh;
  }

  function removeFromSeg(veh) {
    const arr = veh.seg.vehicles;
    const i = arr.indexOf(veh);
    if (i >= 0) removeAt(arr, i);
  }

  function removeVehicle(veh) {
    veh._gone = true;
    // --- E1: removeVehicle exit ---
    // Free an ambulance slot under emergency.maxConcurrent (incremented in
    // spawnAmbulance). Civilians never touch the counter.
    if (veh.isEmergency && ambulanceCount > 0) ambulanceCount--;
    // --- end E1: removeVehicle exit ---
    // --- E2a: recordTrip exit ---
    // Single exit-despawn path (transition() despawns here on the exit stub /
    // dead end / trip cap). Fold tripTime = time - spawnTime and
    // delay = max(0, tripTime - _freeFlowTime) into tripStats + the trip log.
    // recordTrip itself skips emergencies/phantoms (the latter never reach here
    // anyway — they expire via removeIncidentAt).
    recordTrip(veh);
    // --- end E2a: recordTrip exit ---
    removeFromSeg(veh);
    const i = vehicles.indexOf(veh);
    if (i >= 0) {
      vehicles[i] = vehicles[vehicles.length - 1];
      vehicles.pop();
    }
  }

  // ---- Routing (§1.9) ----
  /**
   * C1 closed-guard (D2 layer 2): prefer an OPEN through, then any open
   * connector. Returns null when every out edge is closed — the vehicle
   * despawns at the barrier (documented). With zero closures this is
   * byte-identical to the legacy "first through, else outs[0]".
   */
  function pickFallbackConn(outs) {
    let anyOpen = null;
    for (let i = 0; i < outs.length; i++) {
      const c = outs[i];
      if (c._outEdge !== null && c._outEdge._closed) continue;
      if (c.turnType === 'through') return c;
      if (anyOpen === null) anyOpen = c;
    }
    return anyOpen;
  }

  /**
   * Uniform pick among OPEN connectors (C1). Exactly one rng draw — same
   * consumption as the legacy `outs[floor(rng*len)]` when nothing is closed.
   */
  function pickRandomOpenConn(outs) {
    if (closedEdges.size === 0) return outs[Math.floor(rng.next() * outs.length)];
    let n = 0;
    for (let i = 0; i < outs.length; i++) {
      const oe = outs[i]._outEdge;
      if (oe === null || !oe._closed) n++;
    }
    if (n === 0) return null;
    let k = Math.floor(rng.next() * n);
    for (let i = 0; i < outs.length; i++) {
      const oe = outs[i]._outEdge;
      if (oe === null || !oe._closed) {
        if (k === 0) return outs[i];
        k--;
      }
    }
    return null;
  }

  // ---- Bus stops (F2) ----
  // CONFIG.busStops may be absent until the integration pass wires config.js;
  // the local default keeps this module green (?? picks the real object once
  // present, so GUI mutations of CONFIG.busStops apply live).
  const busCfg = CONFIG.busStops ?? {
    enabled: true,
    meanDwellS: 12,
    minDwellS: 8,
    maxDwellS: 25,
    stopProb: 0.85,
  };

  /**
   * Bus-stop choice on lane entry (F2): a micro serves the FIRST stop ahead
   * (s > veh.s + 5) with probability stopProb — one rng draw per lane entry.
   * lane.busStops is null (or undefined pre-integration) when the lane has none.
   */
  function pickNextStop(veh, lane) {
    veh.nextStopS = -1;
    veh.nextStopIdx = -1;
    if (!veh.isMicro || !busCfg.enabled) return;
    const stops = lane.busStops;
    if (!stops) return;
    const minS = veh.s + 5;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].s > minS) {
        if (rng.next() < busCfg.stopProb) {
          veh.nextStopS = stops[i].s;
          veh.nextStopIdx = i;
        }
        return;
      }
    }
  }

  /**
   * On entering a real lane: cache the next connector along the route.
   * No connector from THIS lane to the route edge -> mandatory-change flag
   * toward the nearest lane that has one. Unroutable -> re-route (new exit).
   */
  function setRouteForLane(veh, lane) {
    veh.blockT = 0;
    veh.ignoreCount = 0;
    pickNextStop(veh, lane); // F2 — also re-rolled after lane changes
    resolveRoute(veh, lane);
  }

  /**
   * C1 (D2): after a routing table swap, recompute nextConn/mandatory from
   * the NEW tables without re-rolling the bus-stop choice (pickNextStop) and
   * without resetting blockT/ignoreCount — preserves micro dwell determinism
   * and in-flight deadlock-breaker state.
   */
  function reresolveRoute(veh) {
    resolveRoute(veh, veh.seg);
  }

  function resolveRoute(veh, lane) {
    veh.mandatory = 0;
    const outs = lane.outConnectors;
    if (!outs.length) {
      veh.nextConn = null; // exit stub / dead end -> despawn at lane end
      return;
    }
    if (veh.exitEdgeId === null) {
      veh.nextConn = pickRandomOpenConn(outs);
      return;
    }
    const table = routing.tables.get(veh.exitEdgeId);
    let desired = table ? table.next.get(lane.edgeId) : undefined;
    // C1 layer-2 guard: a stale table (chunked rebuild still in flight) can
    // point into a freshly closed edge — treat it as off-route instead.
    if (desired !== undefined && closedEdges.size > 0 && closedEdges.has(desired)) {
      desired = undefined;
    }
    if (desired === undefined) {
      // Off-route (or table missing): re-route from here.
      const ex = routing.pickExit(rng, lane.edgeId);
      veh.exitEdgeId = ex;
      if (ex === null) {
        veh.nextConn = pickRandomOpenConn(outs);
        return;
      }
      desired = routing.tables.get(ex).next.get(lane.edgeId);
      if (desired !== undefined && closedEdges.size > 0 && closedEdges.has(desired)) {
        desired = undefined; // stale table still routes into the barrier
      }
      if (desired === undefined) {
        veh.nextConn = pickFallbackConn(outs);
        return;
      }
    }
    for (let i = 0; i < outs.length; i++) {
      if (outs[i].outEdgeId === desired) {
        veh.nextConn = outs[i];
        return;
      }
    }
    // Mandatory lane change toward the nearest lane serving the route edge.
    veh.nextConn = pickFallbackConn(outs);
    const edge = lane._edge;
    let bestIdx = -1;
    let bestD = Infinity;
    for (let li = 0; li < edge.lanes.length; li++) {
      if (li === lane.index) continue;
      const oc = edge.lanes[li].outConnectors;
      for (let j = 0; j < oc.length; j++) {
        if (oc[j].outEdgeId === desired) {
          const d = Math.abs(li - lane.index);
          if (d < bestD) {
            bestD = d;
            bestIdx = li;
          }
          break;
        }
      }
    }
    if (bestIdx >= 0) veh.mandatory = bestIdx > lane.index ? 1 : -1;
  }

  function enterSegment(veh, seg, s) {
    veh.seg = seg;
    veh.s = s;
    seg.vehicles.push(veh); // entering at the rear -> sort order kept
    if (!seg.isConnector) {
      setRouteForLane(veh, seg);
    } else {
      veh.mandatory = 0;
      veh.blockT = 0;
      veh.ignoreCount = 0;
      veh.nextStopS = -1; // bus stops live on real lanes only (F2)
      veh.nextStopIdx = -1;
    }
  }

  // ---- Closures (V3 C1, D2 layer 3: coalesced step-start rebuild) ----
  /** Close an edge (and its twin). Only flags + dirties; step() rebuilds. */
  function closeEdge(id) {
    const e = network.edges.get(id);
    if (!e || e._closed) return null;
    e._closed = true;
    closedEdges.add(e.id);
    let twin = null;
    if (e.twinId != null) {
      twin = network.edges.get(e.twinId);
      if (twin) {
        twin._closed = true;
        closedEdges.add(twin.id);
      }
    }
    closuresDirty = true;
    closureVersion++;
    return twin ? [e.id, twin.id] : [e.id];
  }

  /** Reopen an edge (and its twin). Same coalesced-rebuild contract. */
  function openEdge(id) {
    const e = network.edges.get(id);
    if (!e || !e._closed) return null;
    e._closed = false;
    closedEdges.delete(e.id);
    let twin = null;
    if (e.twinId != null) {
      twin = network.edges.get(e.twinId);
      if (twin) {
        twin._closed = false;
        closedEdges.delete(twin.id);
      }
    }
    closuresDirty = true;
    closureVersion++;
    return twin ? [e.id, twin.id] : [e.id];
  }

  let pendingIsCongestion = false; // R1: the in-flight rebuild is congestion-weighted

  /** Atomic swap of the double-buffered tables + re-resolve routed vehicles. */
  function finishRoutingSwap(builder) {
    routing = builder.finish();
    network.routing = routing; // keep the shared network reference fresh
    pendingRoutingBuilder = null;
    routingVersion++;
    // R1: count completed congestion-weighted swaps (e2e hook) and clear the tag.
    if (pendingIsCongestion) {
      congestionRebuilds++;
      pendingIsCongestion = false;
    }
    // Vehicles on real lanes re-resolve against the new tables NOW; vehicles
    // on connectors re-resolve on landing (enterSegment -> setRouteForLane).
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      if (!veh.seg.isConnector) reresolveRoute(veh);
    }
  }

  /**
   * Coalesced closure application at step start (never mid-decide). Builds
   * exit tables synchronously while inside CONFIG.closures.recomputeBudgetMs;
   * past budget the build continues chunked (chunkExitsPerStep tables/step)
   * into the fresh double buffer — the OLD tables stay live and safe in the
   * meantime thanks to the layer-2 closed-guards in resolveRoute.
   */
  function applyClosures() {
    closuresDirty = false;
    // R1: a closure rebuild adopts the CURRENT congestion setting so toggling a
    // closure while congestion routing is ON never momentarily drops weighting.
    congestionParams.enabled = congestionRouting;
    pendingIsCongestion = false; // a closure rebuild is attributed to closures, not R1
    const builder = createRoutingBuilder(
      network,
      closedEdges.size > 0 ? closedEdges : null,
      congestionRouting ? congestionParams : null
    );
    const t0 = performance.now();
    let done = builder.build(1);
    while (!done && performance.now() - t0 < closuresCfg.recomputeBudgetMs) {
      done = builder.build(1);
    }
    if (done) finishRoutingSwap(builder);
    else pendingRoutingBuilder = builder; // continue on the following steps
  }

  /**
   * R1: start a congestion-weighted routing rebuild on the periodic cadence.
   * Reuses the budgeted builder (sync within recomputeBudgetMs, else chunked
   * into the double buffer exactly like closures). Skipped while another
   * rebuild (closure OR congestion) is already in flight, and respects any
   * active closures. The OLD tables stay live and safe until the swap, so the
   * sim never stalls. Returns true if a rebuild was kicked off.
   */
  function startCongestionRebuild() {
    if (pendingRoutingBuilder !== null) return false; // a rebuild is already running
    congestionParams.enabled = true;
    pendingIsCongestion = true;
    const builder = createRoutingBuilder(
      network,
      closedEdges.size > 0 ? closedEdges : null,
      congestionParams
    );
    const t0 = performance.now();
    let done = builder.build(1);
    while (!done && performance.now() - t0 < closuresCfg.recomputeBudgetMs) {
      done = builder.build(1);
    }
    if (done) finishRoutingSwap(builder);
    else pendingRoutingBuilder = builder; // continue chunked on following steps
    return true;
  }

  // ---- Incidents (V3 C1, D1: phantom vehicle in lane.vehicles ONLY) ----
  /**
   * Edge weight for the random incident pick: whole-edge occupancy x road
   * class x multi-lane preference. Instantaneous LANE occupancy alone proved
   * useless (most lanes show 0 at any given instant — measured: a "weighted"
   * pick landed on an edge with zero flow for 200 sim-s); edge occupancy plus
   * the class prior reliably targets streets that actually carry traffic.
   */
  function incidentEdgeWeight(edge) {
    if (edge._closed) return 0; // never on a closed street
    if (!edge.lanes.length || edge.lanes[0].length < 30) return 0; // room to queue
    let occ = 0;
    for (let i = 0; i < edge.lanes.length; i++) occ += edge.lanes[i].vehicles.length;
    let w = (CONFIG.classWeights[edge.highwayClass] || 1) * (1 + 2 * occ);
    if (incidentsCfg.preferMultiLane && edge.lanes.length >= 2) w *= 4;
    return w;
  }

  /** Weighted edge pick, then that edge's busiest lane ("most vehicles"). */
  function pickIncidentLane() {
    let total = 0;
    for (const e of network.edges.values()) total += incidentEdgeWeight(e);
    if (total <= 0) return null;
    let r = rng.next() * total;
    let chosen = null;
    for (const e of network.edges.values()) {
      const w = incidentEdgeWeight(e);
      if (w <= 0) continue;
      chosen = e;
      r -= w;
      if (r <= 0) break;
    }
    if (chosen === null) return null;
    // The lane traffic actually FEEDS: inbound connectors weigh double the
    // instantaneous occupancy (measured: a busiest-now lane with zero inbound
    // connectors starves — the queue would form on the sibling, not behind
    // the phantom).
    let lane = chosen.lanes[0];
    let bestScore = -1;
    for (let i = 0; i < chosen.lanes.length; i++) {
      const l = chosen.lanes[i];
      const score = 2 * l._inConnCount + l.vehicles.length;
      if (score > bestScore) {
        bestScore = score;
        lane = l;
      }
    }
    return lane;
  }

  /** Mid-lane s nudged into the largest free gap (bumpers kept clear). */
  function findIncidentS(lane, len) {
    const arr = lane.vehicles; // sorted by s DESC
    const margin = len / 2 + 1;
    let bestLo = 0;
    let bestHi = lane.length;
    let bestSize = -1;
    let hi = lane.length; // top of the gap currently being scanned
    for (let i = 0; i <= arr.length; i++) {
      const lo = i < arr.length ? arr[i].s + arr[i].len / 2 : 0;
      if (hi - lo > bestSize) {
        bestSize = hi - lo;
        bestLo = lo;
        bestHi = hi;
      }
      if (i < arr.length) hi = arr[i].s - arr[i].len / 2;
    }
    let lo = bestLo + margin;
    let hi2 = bestHi - margin;
    if (hi2 < lo) {
      lo = (bestLo + bestHi) / 2; // gap tighter than the margins: center it
      hi2 = lo;
    }
    return clamp(lane.length / 2, lo, hi2);
  }

  /**
   * Stop a phantom vehicle on one lane for `durationS` (D1). The phantom is
   * inserted ONLY into lane.vehicles — followers (IDM), cross-connector
   * lookahead and MOBIL see it automatically; integrate/render/global
   * metrics never do, because it never joins the master vehicles[] array.
   */
  function triggerIncident(opts) {
    const durationS =
      opts && opts.durationS !== undefined ? opts.durationS : incidentsCfg.durationS;
    let lane = null;
    if (opts && opts.laneId != null) {
      const l = network.lanes.get(opts.laneId);
      if (l && !l.isConnector && !l._edge._closed) lane = l;
    }
    if (lane === null) lane = pickIncidentLane();
    if (lane === null) return null;
    const phantom = createVehicle(rng, lane, 'sedan'); // seg/prevSeg = lane
    phantom.isPhantom = true;
    phantom.v = 0;
    phantom.len = incidentsCfg.phantomLenM;
    phantom.nextConn = null;
    phantom.s = findIncidentS(lane, phantom.len);
    phantom.prevS = phantom.s;
    insertSorted(lane.vehicles, phantom); // lane ONLY — never vehicles[] (D1)
    const rec = { id: phantom.id, lane, s: phantom.s, until: time + durationS, veh: phantom };
    incidents.push(rec);
    closureVersion++; // worksMesh polls this for cones + hazard blinkers
    return { id: phantom.id, laneId: lane.id, edgeId: lane.edgeId, s: phantom.s, until: rec.until };
  }

  function removeIncidentAt(i) {
    const rec = incidents[i];
    rec.veh._gone = true;
    removeFromSeg(rec.veh);
    removeAt(incidents, i);
    closureVersion++;
  }

  function clearIncidents() {
    for (let i = incidents.length - 1; i >= 0; i--) removeIncidentAt(i);
  }

  // ---- Signals (§2.3) ----
  const signalFor = (conn) =>
    conn && conn.signalGroup ? network.signals.get(conn.junctionId) : null;

  function shouldStopAtSignal(veh, distToStop) {
    const sig = signalFor(veh.nextConn);
    if (!sig) return false;
    const state = signalState(sig, veh.nextConn.signalGroup, time);
    if (state === 'green') return false;
    if (state === 'red') return distToStop > -1; // hold unless already past
    // Yellow: stop only if a comfortable stop is possible.
    const b = CONFIG.idm.b;
    return distToStop > (veh.v * veh.v) / (2 * b) + veh.v * simCfg.yellowStopFactor;
  }

  // ---- Conflict yielding (§2.4) ----
  const conflictClearM = CONFIG.connectors.conflictDistM;

  /**
   * True when the vehicle's next connector must yield right now. conflictRefs
   * are sorted by priority of the OTHER movement (desc); the deadlock breaker
   * ignores the `ignoreCount` lowest-priority blocking entries.
   */
  function conflictBlocked(veh) {
    const refs = veh.nextConn.conflictRefs;
    let blockedCount = 0;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      let blocked = false;
      // (a) priority connector occupied before/at the conflict point.
      const occ = ref.conn.vehicles;
      for (let j = 0; j < occ.length; j++) {
        if (occ[j].s - occ[j].len / 2 < ref.theirEntryS + conflictClearM) {
          blocked = true;
          break;
        }
      }
      // (b) vehicle on the feeding lane arriving within T_gap.
      if (!blocked) {
        const fv = ref.feedLane.vehicles;
        if (fv.length) {
          const front = fv[0];
          if (front.nextConn === ref.conn) {
            const distToConflict = ref.feedLane.length - front.s + ref.theirEntryS;
            if (distToConflict / Math.max(front.v, 1) < simCfg.conflictTGapS) blocked = true;
          }
        }
      }
      if (blocked) {
        blockedCount++;
        if (blockedCount > veh.ignoreCount) return true;
      }
    }
    return false;
  }

  // ---- Leader lookahead across connectors (§2.2) ----
  const _look = { gap: Infinity, dv: 0 };

  function lookaheadLeader(veh, out) {
    let dist = veh.seg.length - veh.s;
    let seg = veh.seg.isConnector ? veh.seg : veh.nextConn;
    let hops = 0;
    while (seg && hops < 3) {
      if (seg !== veh.seg) {
        const arr = seg.vehicles;
        if (arr.length) {
          const leader = arr[arr.length - 1]; // rearmost (min s)
          out.gap = dist + leader.s - leader.len / 2 - veh.len / 2;
          out.dv = veh.v - leader.v;
          return true;
        }
        dist += seg.length;
      }
      if (dist > simCfg.lookaheadMinM) break;
      seg = seg.isConnector ? network.lanes.get(seg.toLaneId) : null;
      hops++;
    }
    return false;
  }

  // ---- Per-vehicle decision (returns pure car-following accel for MOBIL) ----
  const gradeClamp = CONFIG.elevation.gradeAccelClamp;
  const gradeLowGearMs = CONFIG.elevation.gradeLowGearMs;

  function decide(veh, leader) {
    veh._blocked = false;
    // Dwelling at a bus stop (F2): pin an exact standstill and return early —
    // every other term skipped. _blocked stays false on purpose (followers
    // queue or overtake via MOBIL; the deadlock breaker must NOT fire).
    // Toggle-off (busCfg.enabled = false) releases dwellers immediately.
    if (veh.isMicro && busCfg.enabled && time < veh.dwellUntil) {
      veh._a = Math.max(-5, -veh.v / simCfg.dt);
      return veh._a;
    }
    let v0 = veh.seg.speedMs * veh.v0Factor;
    // --- E1: yield slowdown ---
    // A civilian with an active yield lease (stamped by markYields) eases off:
    // its desired speed drops by yieldSlowFactor and it drifts toward the curb
    // (lcLat nudge below). On a multi-lane edge the mandatory curb change in
    // maybeLaneChange does the real work; the slowdown opens the gap meanwhile.
    if (veh._yielding > time && !veh.isEmergency) {
      v0 *= emCfg.yieldSlowFactor;
    }
    // --- end E1: yield slowdown ---
    let gap = Infinity;
    let dv = 0;
    if (leader) {
      gap = leader.s - leader.len / 2 - veh.s - veh.len / 2;
      dv = veh.v - leader.v;
    } else {
      _look.gap = Infinity;
      _look.dv = 0;
      if (lookaheadLeader(veh, _look)) {
        gap = _look.gap;
        dv = _look.dv;
      }
    }
    // Grade term (F1): gravity along the slope, scaled per type. Applied to
    // the BASE accel before the restrictive min() terms. Uphill pull ramps in
    // with speed ("low gear": full engine torque at launch, full gravity pull
    // at cruise) — queue discharge keeps working on hills and vehicles never
    // stall; instead they settle at a slow crawl equilibrium (camión ~11 km/h
    // on a 15% street).
    let aGrade = clamp(
      -9.81 * veh.seg.gradeAt(veh.s) * veh.gradeFactor,
      gradeClamp.min,
      gradeClamp.max
    );
    if (aGrade < 0) {
      const k = veh.v / gradeLowGearMs;
      if (k < 1) aGrade *= k;
    }
    veh._aGrade = aGrade;
    const aCar = idmAccel(veh.v, v0, gap, dv, veh.idm) + aGrade;
    let a = aCar;

    if (!veh.seg.isConnector && veh.nextConn) {
      const distToStop = veh.seg.length - veh.s - veh.len / 2;
      // --- E1: decide signal branch ---
      // An ambulance rolls THROUGH a red (and creeps past a blocked conflict)
      // instead of hard-stopping: near the stop line its desired speed is capped
      // to emergency.signalSlowdownMs via a FREE-ROAD IDM term (no virtual
      // obstacle), so it settles at the creep speed and never reaches v=0. It
      // still car-follows its leader through the restrictive min() above (aCar),
      // so it can't rear-end the queue ahead. Civilians take the legacy branch.
      if (veh.isEmergency) {
        const redOrYellow = shouldStopAtSignal(veh, distToStop);
        const conflictHere =
          veh.nextConn.conflictRefs.length &&
          distToStop < simCfg.conflictEvalDistM &&
          conflictBlocked(veh);
        if ((redOrYellow || conflictHere) && distToStop < simCfg.conflictEvalDistM) {
          // Free-road creep cap (Infinity gap = no obstacle, just the v0 cap).
          const aCreep = idmAccel(veh.v, emCfg.signalSlowdownMs, Infinity, 0, veh.idm);
          if (aCreep < a) a = aCreep;
          // NOT _blocked: the ambulance keeps rolling, so the deadlock breaker
          // and the "held at standstill" brake-light logic never fire on it.
        }
      } else if (shouldStopAtSignal(veh, distToStop)) {
        const aStop = idmAccel(veh.v, v0, Math.max(distToStop, 0.05), veh.v, veh.idm);
        if (aStop < a) a = aStop; // most restrictive, never average
      } else if (
        veh.nextConn.conflictRefs.length &&
        distToStop < simCfg.conflictEvalDistM &&
        conflictBlocked(veh)
      ) {
        veh._blocked = true;
        const aStop = idmAccel(veh.v, v0, Math.max(distToStop, 0.05), veh.v, veh.idm);
        if (aStop < a) a = aStop;
      }
      // --- end E1: decide signal branch ---
      // Mandatory-change creep: virtual obstacle just before the lane end so
      // the vehicle waits for a gap (deadlock breaker gives up after 8 s).
      if (veh.mandatory !== 0 && distToStop < mobilCfg.mandatoryRelaxDistM) {
        const aCreep = idmAccel(veh.v, v0, Math.max(distToStop - 2, 0.05), veh.v, veh.idm);
        if (aCreep < a) a = aCreep;
        if (distToStop < 10) veh._blocked = true; // waiting at lane end
      }
    }
    // Bus-stop service (F2): brake for the chosen stop with the same
    // restrictive-min IDM pattern; at the stop, start the dwell clock.
    if (veh.nextStopS >= 0 && busCfg.enabled && !veh.seg.isConnector) {
      const gapToStop = veh.nextStopS - veh.s - veh.len / 2;
      if (gapToStop < -2) {
        // Overshot (e.g. stop logic re-enabled mid-lane): skip this stop.
        veh.nextStopS = -1;
        veh.nextStopIdx = -1;
      } else {
        const aStop = idmAccel(veh.v, v0, Math.max(gapToStop, 0.05), veh.v, veh.idm);
        if (aStop < a) a = aStop;
        // Trigger is s0-aware: IDM's standing equilibrium leaves gap ≈ s0
        // (~2 m, jittered) to the virtual obstacle, so a fixed 1.5 m
        // threshold would never fire (measured: micros parked forever).
        if (veh.v < 0.3 && gapToStop < veh.idm.s0 + 0.5) {
          veh.dwellUntil =
            time + clamp(rng.exp(busCfg.meanDwellS), busCfg.minDwellS, busCfg.maxDwellS);
          // Advance to the next stop on this lane (rare: long streets).
          const stops = veh.seg.busStops;
          const ni = veh.nextStopIdx + 1;
          if (stops && ni < stops.length) {
            veh.nextStopIdx = ni;
            veh.nextStopS = stops[ni].s;
          } else {
            veh.nextStopIdx = -1;
            veh.nextStopS = -1;
          }
        }
      }
    }
    veh._a = a;
    return aCar;
  }

  // ---- MOBIL hook (§2.5) ----
  // `yield` (E1): when set, mobil.js treats the change like a mandatory one but
  // with the relaxed emergency.yieldLcSafeDecel bound and a curb-ward target.
  const _mctx = { edge: null, aSelf: 0, aGrade: 0, leader: null, follower: null, yield: false };

  function maybeLaneChange(veh, seg, aCar, leader, follower) {
    if (time < veh.lcCooldownUntil) return;
    // F2: no lane changes while dwelling or within 40 m of the chosen stop.
    // (nextStopS/dwellUntil are -1 for non-micros — the guard is universal.)
    if (
      busCfg.enabled &&
      (time < veh.dwellUntil || (veh.nextStopS >= 0 && veh.nextStopS - veh.s < 40))
    ) {
      return;
    }
    const edge = seg._edge;
    if (edge.lanes.length < 2) return;
    // --- E1: yield curb change ---
    // A civilian under an active yield lease that is NOT already on the curb
    // lane makes a forced curb-ward change via mobil's mandatory path with the
    // relaxed yieldLcSafeDecel bound. Real route-mandatory changes take priority
    // (an ambulance must not derail traffic's actual route obligations).
    const yielding =
      veh._yielding > time &&
      !veh.isEmergency &&
      veh.mandatory === 0 &&
      seg.index < edge.lanes.length - 1; // room to move toward the curb
    _mctx.yield = yielding;
    // --- end E1: yield curb change ---
    if (!yielding && veh.mandatory === 0 && veh.s >= seg.length - mobilCfg.minDistToLaneEndM)
      return;
    _mctx.edge = edge;
    _mctx.aSelf = aCar;
    _mctx.aGrade = veh._aGrade; // sibling lanes share the longitudinal profile (F1)
    _mctx.leader = leader;
    _mctx.follower = follower;
    const target = mobilDecision(veh, _mctx);
    if (target) veh._lcTo = target;
  }

  function applyLaneChange(veh, target) {
    const old = veh.seg;
    removeFromSeg(veh);
    veh.seg = target;
    veh.s = (veh.s / old.length) * target.length; // proportional arc mapping
    // Remap the step-start snapshot onto the new lane so the renderer lerps
    // forward along it (the sideways shift is handled by the lateral ease).
    veh.prevSeg = target;
    veh.prevS = (veh.prevS / old.length) * target.length;
    insertSorted(target.vehicles, veh);
    veh.lcLat = (old.index - target.index) * CONFIG.laneWidthM; // render ease
    veh.lcT = time;
    veh.lcCooldownUntil = time + mobilCfg.cooldownS;
    setRouteForLane(veh, target);
  }

  // ---- Transitions at segment ends ----
  function transition(veh) {
    const overshoot = veh.s - veh.seg.length;
    if (veh.seg.isConnector) {
      const next = network.lanes.get(veh.seg.toLaneId);
      removeFromSeg(veh);
      enterSegment(veh, next, Math.min(overshoot, next.length));
      return true;
    }
    // Real lane end.
    // C1 safety net: never enter a connector whose out edge closed after the
    // route was cached — re-resolve; if every option is closed the vehicle
    // despawns at the barrier (D2, documented).
    if (
      veh.nextConn !== null &&
      closedEdges.size > 0 &&
      veh.nextConn._outEdge !== null &&
      veh.nextConn._outEdge._closed
    ) {
      reresolveRoute(veh);
      if (
        veh.nextConn !== null &&
        veh.nextConn._outEdge !== null &&
        veh.nextConn._outEdge._closed
      ) {
        veh.nextConn = null;
      }
    }
    if (!veh.nextConn || veh.tripDist > HARD_TRIP_CAP_M) {
      removeVehicle(veh); // reached exit stub / dead end / safety cap
      return false;
    }
    if (network.spawnMode === 'onNetwork' && veh.tripDist > veh.tripMax) {
      removeVehicle(veh);
      return false;
    }
    // E1: an ambulance rolls THROUGH a red / blocked conflict at the lane end
    // (its decide() creep keeps v > 0 — pinning v=0 here would contradict the
    // "never fully stops" contract). It still enters the connector at its low
    // creep speed and car-follows whatever is already on it. Civilians hold.
    const sig = signalFor(veh.nextConn);
    if (!veh.isEmergency && sig && signalState(sig, veh.nextConn.signalGroup, time) === 'red') {
      veh.s = veh.seg.length; // hold at stop line (numeric overshoot)
      veh.v = 0;
      return false;
    }
    if (!veh.isEmergency && veh.nextConn.conflictRefs.length && conflictBlocked(veh)) {
      veh.s = veh.seg.length;
      veh.v = 0;
      veh._blocked = true;
      return false;
    }
    const conn = veh.nextConn;
    removeFromSeg(veh);
    enterSegment(veh, conn, Math.min(overshoot, conn.length));
    return true;
  }

  // ---- Spawning (§2.6) ----
  function trySpawn(entry) {
    const lane = entry.lane;
    const type = pickVehicleType(rng);
    const len = CONFIG.vehicleTypes[type].lengthM;
    const idm = CONFIG.idm;
    const arr = lane.vehicles;
    let v = lane.speedMs;
    if (arr.length) {
      const rear = arr[arr.length - 1];
      const gap = rear.s - rear.len / 2 - len; // bumper gap (new front at s=len)
      const free = gap - idm.s0;
      if (free < 0.5) return false; // blocked -> stays queued
      v = Math.min(v, Math.max(0.5, free / idm.T), rear.v + 3);
    }
    const veh = createVehicle(rng, lane, type);
    veh.v = v;
    if (network.spawnMode === 'onNetwork') {
      veh.tripMax = Math.max(300, rng.exp(simCfg.spawn.tripMeanKm * 1000));
    }
    if (hasRouting) veh.exitEdgeId = routing.pickExit(rng, lane.edgeId);
    // --- E2a: trySpawn spawnTime ---
    // Stamp the trip clock so recordTrip() can compute tripTime = time -
    // spawnTime on exit-despawn, and reset the free-flow accumulator (the
    // integrate loop adds ds/seg.speedMs each step). Both are stable factory
    // fields (vehicle.js: spawnTime:0/_freeFlowTime:0); written here at the real
    // spawn instant. `??=` keeps this green even before the E1 factory fields
    // land (parallel build) without changing the hot-loop shape afterwards.
    veh.spawnTime = time;
    veh._freeFlowTime = 0;
    // --- end E2a: trySpawn spawnTime ---
    enterSegment(veh, lane, veh.len / 2);
    veh.prevSeg = veh.seg; // interpolation snapshot starts at the spawn pose
    veh.prevS = veh.s;
    vehicles.push(veh);
    return true;
  }

  // --- E1: spawnAmbulance ---
  /**
   * Pick an exit so the routed path heads TOWARD the latest incident (V5 E1).
   * The reverse-Dijkstra tables are keyed by EXIT edge; the incident edge is
   * rarely an exit itself, so we choose the exit DOWNSTREAM of the incident with
   * the smallest remaining distance (the incident sits "on the way" to it).
   * Falls back to the standard weighted pickExit when nothing routes there.
   */
  function pickExitTowardIncident(fromEdgeId) {
    if (!hasRouting) return null;
    if (!incidents.length) return routing.pickExit(rng, fromEdgeId);
    const incEdgeId = incidents[incidents.length - 1].lane.edgeId;
    let bestExit = null;
    let bestDist = Infinity;
    for (const [exitEdgeId, table] of routing.tables) {
      // Both the spawn edge and the incident edge must route to this exit, so
      // the spawn->exit path passes through the incident's region.
      if (!table.next.has(fromEdgeId)) continue;
      const d = table.distM.get(incEdgeId);
      if (d === undefined) continue;
      if (d < bestDist) {
        bestDist = d;
        bestExit = exitEdgeId;
      }
    }
    return bestExit !== null ? bestExit : routing.pickExit(rng, fromEdgeId);
  }

  /**
   * Spawn one emergency vehicle (V5 E1). Event-driven (NOT demand): never goes
   * through trySpawn/pickVehicleType. Bails at emergency.maxConcurrent. Picks
   * the weighted entry lane with the most room at the head, builds an ambulance
   * (createAmbulance: reused mesh slot + isEmergency + white + faster), routes it
   * toward the latest incident when routeToIncident is on, and joins vehicles[].
   * Returns the new vehicle id, or null when capped / no room anywhere.
   */
  function spawnAmbulance(opts) {
    if (!emCfg.enabled) return null;
    if (ambulanceCount >= emCfg.maxConcurrent) return null;
    if (!spawnLanes.length) return null;
    // Choose the open entry lane with the largest head gap (so the fast
    // ambulance has room to launch); skip closed entries.
    let best = null;
    let bestFree = -Infinity;
    for (let i = 0; i < spawnLanes.length; i++) {
      const lane = spawnLanes[i].lane;
      if (lane._edge._closed) continue;
      const arr = lane.vehicles;
      let free = lane.length;
      if (arr.length) {
        const rear = arr[arr.length - 1];
        free = rear.s - rear.len / 2 - emLenHalf; // bumper gap ahead of s=len/2
      }
      // Weight by the entry share so busier corridors are still preferred.
      const score = free + spawnLanes[i].share * 50;
      if (free > 1 && score > bestFree) {
        bestFree = score;
        best = lane;
      }
    }
    if (best === null) return null;
    const veh = createAmbulance(rng, best);
    veh.v = Math.min(best.speedMs, Math.max(2, bestFree / veh.idm.T));
    if (network.spawnMode === 'onNetwork') {
      veh.tripMax = Math.max(300, rng.exp(simCfg.spawn.tripMeanKm * 1000));
    }
    if (hasRouting) {
      veh.exitEdgeId =
        emCfg.routeToIncident
          ? pickExitTowardIncident(best.edgeId)
          : routing.pickExit(rng, best.edgeId);
    }
    veh.spawnTime = time; // E2a trip clock (shared exit-despawn path)
    veh._freeFlowTime = 0;
    enterSegment(veh, best, veh.len / 2);
    veh.prevSeg = veh.seg;
    veh.prevS = veh.s;
    vehicles.push(veh);
    ambulanceCount++;
    void opts; // reserved (e.g. forced laneId) — weighted pick covers the GUI button
    return veh.id;
  }
  const emLenHalf = (CONFIG.vehicleTypes[emCfg.meshType]?.lengthM ?? 4.7) / 2;

  /**
   * markYields() pre-pass (V5 E1, zero-alloc). For each LIVE ambulance, walk its
   * near-term path (the lookaheadLeader hop pattern) up to emergency.yieldRadiusM
   * and stamp every non-emergency vehicle ahead with a short sim-time lease
   * (_yielding = time + 0.5, refreshed each step) and _yieldDir = curb (rightmost
   * lane index of that vehicle's edge). The decide loop reads the slowdown; the
   * MOBIL hook reads the lease to force a curb-ward mandatory change. The short
   * lease auto-expires so civilians release the instant the ambulance passes —
   * preventing gridlock. No-op while no ambulance is live.
   */
  function markYields() {
    yieldingCount = 0;
    if (ambulanceCount <= 0) return;
    const lease = time + 0.5;
    const radius = emCfg.yieldRadiusM;
    for (let i = 0; i < vehicles.length; i++) {
      const amb = vehicles[i];
      if (!amb.isEmergency) continue;
      // Walk the path ahead: current seg from amb.s, then hop through the next
      // connector/lane chain until the cumulative distance exceeds the radius.
      let seg = amb.seg;
      let fromS = amb.s;
      let dist = 0;
      let hops = 0;
      while (seg && dist < radius && hops < 4) {
        const arr = seg.vehicles;
        for (let j = 0; j < arr.length; j++) {
          const other = arr[j];
          if (other === amb || other.isEmergency || other.isPhantom) continue;
          if (other.s <= fromS) continue; // only vehicles AHEAD on this seg
          if (dist + (other.s - fromS) > radius) continue;
          other._yielding = lease;
          // Curb = rightmost lane index of this vehicle's edge (lanes 0..N-1,
          // N-1 = curb). Connectors have no _edge: leave _yieldDir at 0.
          other._yieldDir = seg.isConnector ? 0 : seg._edge.lanes.length - 1;
        }
        dist += seg.length - fromS;
        // Hop to the next segment along the ambulance's route.
        if (seg.isConnector) {
          seg = network.lanes.get(seg.toLaneId);
        } else {
          seg = amb.nextConn && seg === amb.seg ? amb.nextConn : null;
          // Beyond the first lane we can't cheaply know the route; one hop via
          // the cached nextConn covers the common "approaching the junction"
          // case where yielding matters most.
        }
        fromS = 0;
        hops++;
      }
    }
    // Count active leases for the debug getter (cheap: one pass).
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.isEmergency && v._yielding > time) yieldingCount++;
    }
  }
  // --- end E1: spawnAmbulance ---

  // ---- Step ----
  const allSegs = [...network.lanes.values(), ...network.connectors.values()];

  function step(dt) {
    const t0 = performance.now();
    // C1 (D2): closures apply COALESCED at step start — never mid-decide.
    // R1 (V6): congestion-weighted rebuilds reuse the same budgeted machinery,
    // on a sim-time cadence, with strictly lower priority than closures and
    // than finishing a rebuild already in flight (so a pending build never
    // restarts mid-stream and closures always win the buffer).
    if (closuresDirty) {
      applyClosures();
    } else if (
      pendingRoutingBuilder !== null &&
      pendingRoutingBuilder.build(closuresCfg.chunkExitsPerStep)
    ) {
      finishRoutingSwap(pendingRoutingBuilder);
    } else if (
      congestionRouting &&
      pendingRoutingBuilder === null &&
      time >= nextCongestionRebuildT
    ) {
      nextCongestionRebuildT = time + routingCfg.rebuildEveryS;
      startCongestionRebuild();
    }
    // 0) snapshot step-start state for render interpolation (§2.1).
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      veh.prevSeg = veh.seg;
      veh.prevS = veh.s;
    }
    // 1) spawn: Poisson arrivals enqueue; blocked spawns retry next step.
    const lambda = demandVehPerHour / 3600;
    for (let i = 0; i < spawnLanes.length; i++) {
      const e = spawnLanes[i];
      if (e.lane._edge._closed) continue; // C1: closed entry — nobody new gets in
      if (rng.next() < lambda * e.share * dt && e.queued < MAX_SPAWN_QUEUE) e.queued++;
      if (e.queued > 0 && trySpawn(e)) e.queued--;
    }
    // --- E1: markYields pre-pass ---
    // Stamp the short curb-yield lease on civilians ahead of each ambulance,
    // BEFORE the decide loop reads it. Zero-alloc; no-op with no live ambulance.
    markYields();
    // --- end E1: markYields pre-pass ---
    // 2) decide + MOBIL decisions (no mutation of lane arrays here).
    for (let si = 0; si < allSegs.length; si++) {
      const seg = allSegs[si];
      const arr = seg.vehicles;
      for (let i = 0; i < arr.length; i++) {
        const veh = arr[i];
        veh._lcTo = null;
        if (veh.isPhantom) {
          // D1: the phantom never moves or decides; followers/MOBIL see it
          // as a regular stopped leader with zero extra code.
          veh._a = 0;
          continue;
        }
        const leader = i > 0 ? arr[i - 1] : null;
        const aCar = decide(veh, leader);
        if (!seg.isConnector) {
          maybeLaneChange(veh, seg, aCar, leader, i + 1 < arr.length ? arr[i + 1] : null);
        }
      }
    }
    // 2b) apply lane changes.
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      if (veh._lcTo !== null) {
        applyLaneChange(veh, veh._lcTo);
        veh._lcTo = null;
      }
    }
    // 3) integrate + deadlock timers + detector crossings.
    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      veh.v = Math.max(0, veh.v + veh._a * dt);
      const ds = veh.v * dt;
      const sPrev = veh.s;
      veh.s += ds;
      veh.tripDist += ds;
      // --- E2a: integrate freeFlowTime ---
      // Accumulate the free-flow reference for delay: the time THIS distance
      // would have taken at the segment's free speed. recordTrip() later folds
      // delay = max(0, tripTime - _freeFlowTime). seg.speedMs is always > 0
      // (lanes inherit edge.speedMs; connectors clamp to >= 1.5) so no guard is
      // needed. Phantoms never integrate (skipped in the decide loop, v stays 0)
      // so they never accrue here either.
      veh._freeFlowTime += ds / veh.seg.speedMs;
      // --- end E2a: integrate freeFlowTime ---
      const det = veh.seg._det;
      if (det !== null) {
        const sd = veh.seg._detS;
        // --- E2b: step-3 detector cross ---
        // Agent E2b: this is the per-step detector-cross site referenced by the
        // scaffold. The replay RECORD call itself lives at the step-5 sampling
        // marker (sim-time gated, after the clock advances); nothing to add here
        // unless E2b needs a per-vehicle crossing hook. Leave the cross() call
        // untouched.
        // --- end E2b: step-3 detector cross ---
        // E1: ambulances are event-spawned, not demand — exclude their crossings
        // from detector flow (FD unaffected by a called ambulance).
        if (!veh.isEmergency && sPrev < sd && veh.s >= sd) detectors.cross(det, time, veh.v);
      }
      if (veh._blocked && veh.v < simCfg.deadlockSpeedMs) {
        veh.blockT += dt;
        if (veh.blockT > simCfg.deadlockTimeS) {
          // Starvation breaker: give up on the mandatory change first, then
          // ignore the lowest-priority remaining conflict (§2.4).
          if (veh.mandatory !== 0) veh.mandatory = 0;
          else veh.ignoreCount++;
          veh.blockT = 0;
        }
      } else if (!veh._blocked) {
        veh.blockT = 0;
      }
    }
    // 4) transitions + despawn (front vehicles first).
    for (let si = 0; si < allSegs.length; si++) {
      const seg = allSegs[si];
      while (seg.vehicles.length && seg.vehicles[0].s >= seg.length) {
        if (!transition(seg.vehicles[0])) break;
      }
    }
    // 5) clock + incident expiry + detectors/metrics.
    time += dt;
    setSimTime(time);
    // C1: expire incidents (reverse loop, allocation-free removeAt).
    for (let i = incidents.length - 1; i >= 0; i--) {
      if (time >= incidents[i].until) removeIncidentAt(i);
    }
    detectors.update(time, vehicles, network.totalLaneKm);
    // --- E2b: step-5 sampling ---
    // Agent E2b: record one replay frame here (END of step, after the clock
    // advanced and detectors updated). The recorder is SIM-TIME gated
    // internally (nextRecordT = time + 1/recordHz) so cadence follows sim
    // speed; it writes sim.vehicles (skip phantoms, include ambulances) into
    // the next ring frame as [id, typeIndex, x, y, z, heading]. Skip entirely
    // while replayMode is active (recording paused — main.js HARD-pauses sim).
    //   e.g. replayRecorder.record(time);
    replayRecorder.record(time);
    // --- end E2b: step-5 sampling ---
    // --- E2a: step-5 metrics sampling ---
    // Push one metricsHistory ring sample (sim-time gated, ~stats.metricsSampleS)
    // from detectors.metrics.global. Single owner of the ring — lives here (not
    // detectors.js) so the gate follows sim time and the sample reads the
    // just-updated global. Zero-alloc (typed-array writes only), capped.
    if (time >= nextMetricsSampleT) {
      nextMetricsSampleT = time + statsCfg.metricsSampleS;
      pushMetricsSample(detectors.metrics.global);
    }
    // --- end E2a: step-5 metrics sampling ---
    lastStepMs = performance.now() - t0;
  }

  return {
    step,
    get time() {
      return time;
    },
    get vehicleCount() {
      return vehicles.length;
    },
    vehicles,
    metrics: detectors.metrics,
    detectors: detectors.detectors,
    get lastStepMs() {
      return lastStepMs;
    },
    setDemand(vehPerHour) {
      demandVehPerHour = clamp(vehPerHour, 0, 20000);
    },
    get demand() {
      return demandVehPerHour;
    },
    setSimSpeed(x) {
      simSpeed = clamp(x, simCfg.speedMin, simCfg.speedMax);
    },
    get simSpeed() {
      return simSpeed;
    },
    setPaused(p) {
      paused = !!p;
    },
    get paused() {
      return paused;
    },
    sampleVehicle() {
      if (!vehicles.length) return null;
      const veh = vehicles[0];
      const p = veh.seg.posAt(veh.s); // {x,y,z} — y = elevation (F1)
      return { id: veh.id, x: p.x, y: p.y, z: p.z, v: veh.v, segId: veh.seg.id, s: veh.s };
    },
    // ---- Closures & incidents (V3 C1) ----
    closeEdge,
    openEdge,
    get closedEdges() {
      return closedEdges;
    },
    triggerIncident,
    clearIncidents,
    get incidents() {
      return incidents;
    },
    get closureVersion() {
      return closureVersion;
    },
    get routingVersion() {
      return routingVersion;
    },
    // ---- Congestion-sensitive routing (V6 R1) ----
    /**
     * Toggle congestion-sensitive routing. ON: schedules a congestion-weighted
     * rebuild on the next cadence tick (immediately, since the timer is reset to
     * `time`). OFF: restores free-flow routing by kicking ONE plain (free-flow,
     * closure-aware) rebuild now, so behavior returns to the unchanged tables.
     */
    setCongestionRouting(b) {
      const on = !!b;
      if (on === congestionRouting) return;
      congestionRouting = on;
      if (on) {
        nextCongestionRebuildT = time; // rebuild on the next step
      } else if (pendingRoutingBuilder === null) {
        // Restore free-flow tables immediately (closure-aware, congestion off).
        congestionParams.enabled = false;
        pendingIsCongestion = false;
        const builder = createRoutingBuilder(
          network,
          closedEdges.size > 0 ? closedEdges : null,
          null
        );
        const t0 = performance.now();
        let done = builder.build(1);
        while (!done && performance.now() - t0 < closuresCfg.recomputeBudgetMs) {
          done = builder.build(1);
        }
        if (done) finishRoutingSwap(builder);
        else pendingRoutingBuilder = builder;
      }
    },
    get congestionRouting() {
      return congestionRouting;
    },
    /** Completed congestion-weighted table swaps (e2e hook). */
    get congestionRebuilds() {
      return congestionRebuilds;
    },
    // --- E1: sim public hooks ---
    /** Spawn one ambulance (GUI «Llamar ambulancia»). Returns id, or null at cap. */
    callAmbulance(opts) {
      return spawnAmbulance(opts);
    },
    /** Live ambulances: {count, list:[{id,segId,s,v}]} (allocates — UI/test only). */
    get ambulances() {
      const list = [];
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (v.isEmergency) list.push({ id: v.id, segId: v.seg.id, s: v.s, v: v.v });
      }
      return { count: ambulanceCount, list };
    },
    /** Civilians with an active curb-yield lease this step (e2e hook). */
    get yieldingCount() {
      return yieldingCount;
    },
    // --- end E1: sim public hooks ---
    // --- E2a: sim public hooks ---
    // Derived trip stats (means from the accumulators) + the metricsHistory ring
    // + the trip-log accessor for the CSV exporter. The getters allocate a small
    // result object, but they run on the HUD/export cadence (~2 Hz), NOT in the
    // per-frame hot loop — consistent with sampleVehicle()/ambulances.
    get tripStats() {
      const c = tripAcc.completed;
      const windowMin = statsCfg.completionsWindowS / 60;
      return {
        viajesCompletados: c,
        tiempoMedioViaje: c > 0 ? tripAcc.sumTripTime / c : 0, // s
        demoraMedia: c > 0 ? tripAcc.sumDelay / c : 0, // s
        demoraTotal: tripAcc.sumDelay, // s
        velocidadMedia: c > 0 ? (tripAcc.sumSpeed / c) * 3.6 : 0, // km/h
        rendimiento: windowMin > 0 ? recentCompletions() / windowMin : 0, // veh/min
      };
    },
    get metricsHistory() {
      return metricsHistory;
    },
    get tripLog() {
      return tripLog;
    },
    // --- end E2a: sim public hooks ---
    // --- E2b: sim public hooks ---
    // Agent E2b: expose the replay recorder so main.js can drive the RAF swap —
    // e.g. `replay` getter ({recording, frameCount, windowS, ...}),
    // recordReplay()/replayReset() or a direct recorder handle. The recorder
    // itself is created in sim/replay.js and fed from the E2b step-5 marker.
    replay: replayRecorder, // direct recorder handle (record/reset/read API)
    /** Pause/resume live recording (main.js HARD-pauses while scrubbing). */
    setReplayRecording(b) {
      replayRecorder.setRecording(b);
    },
    /** Clear the ring on world swap (also re-enables recording). */
    replayReset() {
      replayRecorder.reset();
    },
    // --- end E2b: sim public hooks ---
  };
}
