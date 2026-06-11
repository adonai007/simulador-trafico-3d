// Signal detection + phase plans + green-wave offsets. Spec §1.7.
//
// Output per signalized junction:
//   {
//     junctionId,
//     groups: Map(incomingEdgeId -> 'NS' | 'EW'),
//     plan: { cycleS, greenNS, greenEW, yellowS, allRedS, offsetS }
//   }
// Runtime evaluation lives in src/sim/signalsRuntime.js (stateless, clock-driven).

import { CONFIG } from '../config.js';
import { angularDiff, axisDiff } from '../util/math2d.js';

const CLASS_RANK = {
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  unclassified: 4,
  residential: 3,
  living_street: 2,
};

function classRank(cls) {
  return CLASS_RANK[cls] ?? (cls && cls.endsWith('_link') ? 1 : 0);
}

/** Heading (radians) of an edge as it ARRIVES at its toNode. */
function incomingHeading(edge) {
  const pts = edge.trimmedPoints || edge.points;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return Math.atan2(b.z - a.z, b.x - a.x);
}

/** Detect signalized junctions: OSM snap (25 m) + heuristic fallback. */
function detectSignalizedJunctions(graph, parsed, projection) {
  const cfg = CONFIG.signals;
  const signalized = new Set();

  // Candidate junctions: real intersections (>= 3 legs).
  const candidates = [];
  for (const node of graph.nodes.values()) {
    if (node.legCount >= 3) candidates.push(node);
  }

  // 1) Snap traffic_signals nodes to the nearest candidate within snapDistM.
  //    (Signal nodes are usually mapped at stop lines a few meters before the
  //    junction; duplicates collapse onto the same junction.)
  for (const sid of parsed.signalNodeIds) {
    const sn = parsed.nodes.get(sid);
    if (!sn) continue;
    const p = projection.toLocal(sn.lat, sn.lon);
    let best = null;
    let bestD = cfg.snapDistM;
    for (const node of candidates) {
      const dx = node.x - p.x;
      const dz = node.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= bestD) {
        bestD = d;
        best = node;
      }
    }
    if (best) signalized.add(best.id);
  }

  // 2) Heuristic fallback: legCount >= 4 AND >= 2 major-class incident edges
  //    with non-collinear headings (axis diff > 45°).
  const majorClasses = new Set(cfg.heuristicClasses);
  const maxAxis = (cfg.heuristicAxisDiffDeg * Math.PI) / 180;
  for (const node of candidates) {
    if (signalized.has(node.id)) continue;
    if (node.legCount < cfg.heuristicMinLegs) continue;
    const majorHeadings = [];
    const seen = new Set();
    for (const eid of [...node.edgesIn, ...node.edgesOut]) {
      if (seen.has(eid)) continue;
      const e = graph.edges.get(eid);
      seen.add(eid);
      if (e.twinId != null) seen.add(e.twinId);
      if (!majorClasses.has(e.highwayClass)) continue;
      // Edge axis at the junction end.
      const pts = e.trimmedPoints || e.points;
      const atEnd = e.toNode === node.id;
      const a = atEnd ? pts[pts.length - 2] : pts[1];
      const b = atEnd ? pts[pts.length - 1] : pts[0];
      majorHeadings.push(Math.atan2(b.z - a.z, b.x - a.x));
    }
    let nonCollinear = false;
    for (let i = 0; i < majorHeadings.length && !nonCollinear; i++) {
      for (let j = i + 1; j < majorHeadings.length; j++) {
        if (axisDiff(majorHeadings[i], majorHeadings[j]) > maxAxis) {
          nonCollinear = true;
          break;
        }
      }
    }
    if (majorHeadings.length >= 2 && nonCollinear) signalized.add(node.id);
  }
  return signalized;
}

/** Build the two-phase plan (NS/EW groups, green split, cycle). */
function buildPhasePlan(graph, node) {
  const cfg = CONFIG.signals;
  const approaches = node.edgesIn.map((eid) => graph.edges.get(eid));
  if (approaches.length < 2) return null;

  // Dominant axis A = heading of the highest-class incoming edge.
  let dominant = approaches[0];
  for (const e of approaches) {
    if (classRank(e.highwayClass) > classRank(dominant.highwayClass)) dominant = e;
  }
  const A = incomingHeading(dominant);

  const groups = new Map();
  let lanesNS = 0;
  let lanesEW = 0;
  const limit = Math.PI / 4; // 45°
  for (const e of approaches) {
    const d = angularDiff(incomingHeading(e), A);
    const group = d < limit || d > Math.PI - limit ? 'NS' : 'EW';
    groups.set(e.id, group);
    if (group === 'NS') lanesNS += e.laneCount;
    else lanesEW += e.laneCount;
  }
  if (lanesNS === 0 || lanesEW === 0) return null; // degenerate -> unsignalized

  const cycleS = Math.min(Math.max(cfg.cycleS, cfg.cycleClampS.min), cfg.cycleClampS.max);
  const lost = 2 * (cfg.yellowS + cfg.allRedS);
  const greenTotal = cycleS - lost;
  let greenNS = Math.max(cfg.minGreenS, (greenTotal * lanesNS) / (lanesNS + lanesEW));
  let greenEW = greenTotal - greenNS;
  if (greenEW < cfg.minGreenS) {
    greenEW = cfg.minGreenS;
    greenNS = greenTotal - greenEW;
  }
  return {
    junctionId: node.id,
    groups,
    plan: {
      cycleS,
      greenNS,
      greenEW,
      yellowS: cfg.yellowS,
      allRedS: cfg.allRedS,
      offsetS: 0, // filled by assignGreenWaveOffsets
    },
  };
}

/** Most common edge heading mod 180° (length-weighted, 10° bins). */
function dominantNetworkAxis(graph) {
  const BINS = 18;
  const hist = new Array(BINS).fill(0);
  for (const e of graph.edges.values()) {
    if (e.twinId != null && e.twinId < e.id) continue; // count roads once
    const pts = e.points;
    const h = Math.atan2(
      pts[pts.length - 1].z - pts[0].z,
      pts[pts.length - 1].x - pts[0].x
    );
    let deg = ((h * 180) / Math.PI) % 180;
    if (deg < 0) deg += 180;
    hist[Math.floor(deg / (180 / BINS)) % BINS] += e.lengthM;
  }
  let best = 0;
  for (let i = 1; i < BINS; i++) if (hist[i] > hist[best]) best = i;
  const deg = (best + 0.5) * (180 / BINS);
  return (deg * Math.PI) / 180;
}

/** offset_i = (proj_i / v_wave) mod C along the dominant axis. */
function assignGreenWaveOffsets(graph, signals) {
  const axis = dominantNetworkAxis(graph);
  const ux = Math.cos(axis);
  const uz = Math.sin(axis);
  const vWave = (CONFIG.signals.greenWaveKmh * 1000) / 3600;
  for (const sig of signals.values()) {
    const node = graph.nodes.get(sig.junctionId);
    const proj = node.x * ux + node.z * uz;
    const C = sig.plan.cycleS;
    sig.plan.offsetS = ((proj / vWave) % C + C) % C;
  }
}

/**
 * Live retiming for the GUI ("ciclo semafórico" / "velocidad de onda verde"):
 * rescale every plan to a new cycle length (green split ratio preserved,
 * min-green respected) and recompute green-wave offsets with the current
 * CONFIG.signals.greenWaveKmh. `graph` only needs {nodes, edges} Maps, so the
 * built Network object works. signalsRuntime is stateless -> takes effect
 * immediately.
 */
export function retimeSignals(graph, signals, cycleS) {
  const cfg = CONFIG.signals;
  const C = Math.min(Math.max(cycleS, cfg.cycleClampS.min), cfg.cycleClampS.max);
  const lost = 2 * (cfg.yellowS + cfg.allRedS);
  const greenTotal = C - lost;
  for (const sig of signals.values()) {
    const p = sig.plan;
    const ratio = p.greenNS / (p.greenNS + p.greenEW);
    let gNS = Math.max(cfg.minGreenS, greenTotal * ratio);
    let gEW = greenTotal - gNS;
    if (gEW < cfg.minGreenS) {
      gEW = cfg.minGreenS;
      gNS = greenTotal - gEW;
    }
    p.cycleS = C;
    p.greenNS = gNS;
    p.greenEW = gEW;
  }
  assignGreenWaveOffsets(graph, signals);
}

/**
 * Build all signals. Returns Map(junctionId -> signal) and sets
 * `node.signal` on signalized junction nodes.
 */
export function buildSignals(graph, parsed, projection) {
  const signalized = detectSignalizedJunctions(graph, parsed, projection);
  const signals = new Map();
  for (const nodeId of signalized) {
    const node = graph.nodes.get(nodeId);
    const sig = buildPhasePlan(graph, node);
    if (!sig) continue;
    signals.set(nodeId, sig);
    node.signal = sig;
  }
  assignGreenWaveOffsets(graph, signals);
  return signals;
}
