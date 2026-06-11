// Edge detectors + global aggregates (spec §5). All clocks are SIM time.
//
//   - Detectors on the N longest non-connector edges (>= 80 m): cross-section
//     at each lane's midpoint. Flow q = crossings / window (60 s, slide 5 s),
//     speed = harmonic mean of crossing speeds, density k = window-averaged
//     vehicles-on-edge / (edgeLengthKm * laneCount) — counted, not q/v.
//   - Global HUD aggregates every 0.5 s sim.
//
// Exposed shape (consumed by UI builder):
//   metrics = {
//     global: { vehicles, meanSpeedKmh, densityVehKm, flowVehHLane, time },
//     detectorPoints: [{ edgeId, k, q, vKmh }, ...]   // veh/km/lane, veh/h/lane
//   }
//
// Crossing detection is done by the sim integrate loop via the `_det`/`_detS`
// fields this module attaches to every lane (null on non-detector segments to
// keep object shapes monomorphic in the hot path).

import { CONFIG } from '../config.js';

const RING_CAP = 512; // crossing events kept per detector (>= 60 s at capacity flow)

export function createDetectors(network) {
  const cfg = CONFIG.detectors;
  const occCap = Math.ceil(cfg.windowS / cfg.hudIntervalS); // occupancy samples per window

  // Stable shapes: every segment gets the fields, detectors overwrite below.
  for (const l of network.lanes.values()) {
    l._det = null;
    l._detS = 0;
  }
  for (const c of network.connectors.values()) {
    c._det = null;
    c._detS = 0;
  }

  // Pick the longest INTERIOR edges (junction at both ends, by trimmed lane
  // length). Excludes boundary stubs and two-way dead ends — those survive the
  // SCC prune via their own twin but carry no routed traffic (U-turns pruned).
  const candidates = [];
  for (const e of network.edges.values()) {
    if (!e.lanes.length) continue;
    if (e.lanes[0].length < cfg.minEdgeLengthM) continue;
    const fromN = network.nodes.get(e.fromNode);
    const toN = network.nodes.get(e.toNode);
    if (!fromN || !toN || fromN.legCount < 2 || toN.legCount < 2) continue;
    candidates.push(e);
  }
  candidates.sort((a, b) => b.lanes[0].length - a.lanes[0].length);
  const chosen = candidates.slice(0, cfg.count);

  const detectors = [];
  for (const e of chosen) {
    const d = {
      edgeId: e.id,
      lanes: e.lanes,
      laneCount: e.lanes.length,
      lengthKm: e.lanes[0].length / 1000,
      // Crossing ring buffer (time + speed), overwrite-oldest when full.
      times: new Float64Array(RING_CAP),
      speeds: new Float64Array(RING_CAP),
      head: 0, // next write slot
      count: 0,
      // Occupancy ring (vehicles on edge, sampled every hudIntervalS).
      occ: new Float32Array(occCap),
      occIdx: 0,
      occCount: 0,
      occSum: 0,
      // Last computed window stats.
      q: 0,
      k: 0,
      vKmh: 0,
    };
    for (const l of e.lanes) {
      l._det = d;
      l._detS = l.length * 0.5;
    }
    detectors.push(d);
  }

  const detectorPoints = detectors.map((d) => ({ edgeId: d.edgeId, k: 0, q: 0, vKmh: 0 }));
  const metrics = {
    global: { vehicles: 0, meanSpeedKmh: 0, densityVehKm: 0, flowVehHLane: 0, time: 0 },
    detectorPoints,
  };

  /** Record a midpoint crossing (called from the sim integrate loop). */
  function cross(d, time, speed) {
    d.times[d.head] = time;
    d.speeds[d.head] = speed;
    d.head = (d.head + 1) % RING_CAP;
    if (d.count < RING_CAP) d.count++;
  }

  function sampleOccupancy() {
    for (let i = 0; i < detectors.length; i++) {
      const d = detectors[i];
      let n = 0;
      for (let j = 0; j < d.lanes.length; j++) n += d.lanes[j].vehicles.length;
      if (d.occCount === occCap) {
        d.occSum -= d.occ[d.occIdx];
      } else {
        d.occCount++;
      }
      d.occ[d.occIdx] = n;
      d.occSum += n;
      d.occIdx = (d.occIdx + 1) % occCap;
    }
  }

  function computeWindows(time) {
    const tMin = time - cfg.windowS;
    for (let i = 0; i < detectors.length; i++) {
      const d = detectors[i];
      let n = 0;
      let invSum = 0;
      for (let j = 0; j < d.count; j++) {
        const idx = (d.head - 1 - j + RING_CAP * 2) % RING_CAP;
        const t = d.times[idx];
        if (t < tMin) break; // entries are time-ordered newest-first
        n++;
        invSum += 1 / Math.max(d.speeds[idx], 0.5);
      }
      const window = Math.min(cfg.windowS, Math.max(time, cfg.slideS));
      d.q = ((n / window) * 3600) / d.laneCount; // veh/h/lane
      d.vKmh = n > 0 ? (n / invSum) * 3.6 : 0; // harmonic (space-mean) speed
      const occAvg = d.occCount ? d.occSum / d.occCount : 0;
      d.k = occAvg / (d.lengthKm * d.laneCount); // veh/km/lane (counted)
      const p = detectorPoints[i];
      p.k = d.k;
      p.q = d.q;
      p.vKmh = d.vKmh;
    }
  }

  function computeGlobal(time, vehicles, totalLaneKm) {
    let vSum = 0;
    for (let i = 0; i < vehicles.length; i++) vSum += vehicles[i].v;
    const g = metrics.global;
    g.time = time;
    g.vehicles = vehicles.length;
    g.meanSpeedKmh = vehicles.length ? (vSum / vehicles.length) * 3.6 : 0;
    g.densityVehKm = totalLaneKm > 0 ? vehicles.length / totalLaneKm : 0;
    let qSum = 0;
    for (let i = 0; i < detectors.length; i++) qSum += detectors[i].q;
    g.flowVehHLane = detectors.length ? qSum / detectors.length : 0;
  }

  let nextHud = 0;
  let nextSlide = cfg.slideS;

  /** Called once per sim step; internal gates keep it cheap. */
  function update(time, vehicles, totalLaneKm) {
    if (time >= nextSlide) {
      nextSlide = time + cfg.slideS;
      computeWindows(time);
    }
    if (time >= nextHud) {
      nextHud = time + cfg.hudIntervalS;
      sampleOccupancy();
      computeGlobal(time, vehicles, totalLaneKm);
    }
  }

  return { update, cross, metrics, detectors };
}
