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
// Step order: spawn -> decide (+MOBIL) -> lane changes -> integrate ->
// transitions/despawn -> detectors.
// Hot paths are allocation-free: scratch objects are module/closure-level,
// per-vehicle scratch fields are created once in the vehicle factory.

import { CONFIG } from '../config.js';
import { clamp } from '../util/math2d.js';
import { createRng } from '../util/rng.js';
import { createVehicle, pickVehicleType } from './vehicle.js';
import { idmAccel } from './idm.js';
import { signalState, setSimTime } from './signalsRuntime.js';
import { mobilDecision } from './mobil.js';
import { createDetectors } from './detectors.js';
import { TURN_PRIORITY } from '../network/connectors.js';

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
  const routing = network.routing;
  const hasRouting =
    network.spawnMode === 'entries' && routing.tables && routing.tables.size > 0;
  const detectors = createDetectors(network);

  // ---- One-time wiring (stable object shapes for the hot loops) ----
  for (const e of network.edges.values()) {
    for (const l of e.lanes) l._edge = e;
  }
  for (const c of network.connectors.values()) {
    c._edge = null;
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
    removeFromSeg(veh);
    const i = vehicles.indexOf(veh);
    if (i >= 0) {
      vehicles[i] = vehicles[vehicles.length - 1];
      vehicles.pop();
    }
  }

  // ---- Routing (§1.9) ----
  function pickFallbackConn(outs) {
    for (let i = 0; i < outs.length; i++) {
      if (outs[i].turnType === 'through') return outs[i];
    }
    return outs[0];
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
    veh.mandatory = 0;
    veh.blockT = 0;
    veh.ignoreCount = 0;
    pickNextStop(veh, lane); // F2 — also re-rolled after lane changes
    const outs = lane.outConnectors;
    if (!outs.length) {
      veh.nextConn = null; // exit stub / dead end -> despawn at lane end
      return;
    }
    if (veh.exitEdgeId === null) {
      veh.nextConn = outs[Math.floor(rng.next() * outs.length)];
      return;
    }
    let table = routing.tables.get(veh.exitEdgeId);
    let desired = table ? table.next.get(lane.edgeId) : undefined;
    if (desired === undefined) {
      // Off-route (or table missing): re-route from here.
      const ex = routing.pickExit(rng, lane.edgeId);
      veh.exitEdgeId = ex;
      if (ex === null) {
        veh.nextConn = outs[Math.floor(rng.next() * outs.length)];
        return;
      }
      desired = routing.tables.get(ex).next.get(lane.edgeId);
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
    const v0 = veh.seg.speedMs * veh.v0Factor;
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
      if (shouldStopAtSignal(veh, distToStop)) {
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
  const _mctx = { edge: null, aSelf: 0, aGrade: 0, leader: null, follower: null };

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
    if (veh.mandatory === 0 && veh.s >= seg.length - mobilCfg.minDistToLaneEndM) return;
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
    if (!veh.nextConn || veh.tripDist > HARD_TRIP_CAP_M) {
      removeVehicle(veh); // reached exit stub / dead end / safety cap
      return false;
    }
    if (network.spawnMode === 'onNetwork' && veh.tripDist > veh.tripMax) {
      removeVehicle(veh);
      return false;
    }
    const sig = signalFor(veh.nextConn);
    if (sig && signalState(sig, veh.nextConn.signalGroup, time) === 'red') {
      veh.s = veh.seg.length; // hold at stop line (numeric overshoot)
      veh.v = 0;
      return false;
    }
    if (veh.nextConn.conflictRefs.length && conflictBlocked(veh)) {
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
    enterSegment(veh, lane, veh.len / 2);
    veh.prevSeg = veh.seg; // interpolation snapshot starts at the spawn pose
    veh.prevS = veh.s;
    vehicles.push(veh);
    return true;
  }

  // ---- Step ----
  const allSegs = [...network.lanes.values(), ...network.connectors.values()];

  function step(dt) {
    const t0 = performance.now();
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
      if (rng.next() < lambda * e.share * dt && e.queued < MAX_SPAWN_QUEUE) e.queued++;
      if (e.queued > 0 && trySpawn(e)) e.queued--;
    }
    // 2) decide + MOBIL decisions (no mutation of lane arrays here).
    for (let si = 0; si < allSegs.length; si++) {
      const seg = allSegs[si];
      const arr = seg.vehicles;
      for (let i = 0; i < arr.length; i++) {
        const veh = arr[i];
        veh._lcTo = null;
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
      const det = veh.seg._det;
      if (det !== null) {
        const sd = veh.seg._detS;
        if (sPrev < sd && veh.s >= sd) detectors.cross(det, time, veh.v);
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
    // 5) clock + detectors/metrics.
    time += dt;
    setSimTime(time);
    detectors.update(time, vehicles, network.totalLaneKm);
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
  };
}
