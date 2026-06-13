// Vehicle factory (spec §2.6 + fleet deviation): 6-type La Paz mix —
// sedán 30% / hatchback 25% / SUV 15% / taxi 10% / micro paceño 12% /
// camión 8%. IDM params jittered ±10% per vehicle; v0 = lane speed ×
// per-type factor (jittered). Object shape is created once and kept stable —
// the sim hot loops never add properties.
//
// The type list is data-driven from CONFIG.vehicleTypes: TYPE_INDEX order ==
// Object.keys order == InstancedMesh order in render/vehiclesMesh.js. Adding
// a type = config entry + palette here + geometry builder there.

import { CONFIG } from '../config.js';

export const TYPE_INDEX = {};
Object.keys(CONFIG.vehicleTypes).forEach((t, i) => {
  TYPE_INDEX[t] = i;
});

const PALETTES = {
  // Legacy 3-type palettes kept as aliases (harmless once config flips).
  car: [
    0xd64545, 0x4587d6, 0xe0b341, 0x57b66a, 0xc7ccd4, 0x8a64c4,
    0xe07f3e, 0x3fbfb2, 0x9c2f4e, 0x5b6877,
  ],
  truck: [0xdde3e8, 0xb8bec4, 0x8d99a6, 0x9aa68d, 0xc9a86a, 0x7f8c99],
  sport: [0xff3b30, 0xffcc00, 0x2fd158, 0x00c7be, 0xff9500, 0xaf52de],
  // 6-type fleet
  sedan: [
    0xd64545, 0x4587d6, 0xe0b341, 0x57b66a, 0xc7ccd4, 0x8a64c4,
    0xe07f3e, 0x3fbfb2, 0x9c2f4e, 0x5b6877,
  ],
  hatchback: [
    0xe04b3a, 0x3a7bd6, 0x33b5a0, 0xf0c93f, 0xe8782f, 0x88c43f,
    0xd8dde2, 0x6a7480, 0xff5e8a,
  ],
  suv: [0x2e3338, 0x4a5258, 0x37503b, 0x2d3f63, 0x5e2f38, 0xb9c0c7, 0xe8e6e1],
  taxi: [0xffffff, 0xf7f5ee, 0xffd23a, 0xffdf60, 0xfff3c4],
  // Micro paceño: saturated transit-line colors (green/red/blue dominate).
  micro: [0x1fa83c, 0xd92f2f, 0x2a5cd9, 0x1fa83c, 0xd92f2f, 0x2a5cd9, 0xf0a31c, 0x16b3a6],
  camion: [0xdde3e8, 0xb8bec4, 0x8d99a6, 0x9aa68d, 0xc9a86a, 0x7f8c99],
};
const FALLBACK_PALETTE = PALETTES.car;

// Cumulative mix table, precomputed once (CONFIG.vehicleMix is static).
const MIX_TYPES = Object.keys(CONFIG.vehicleMix);
const MIX_CUM = [];
{
  let acc = 0;
  for (const t of MIX_TYPES) {
    acc += CONFIG.vehicleMix[t];
    MIX_CUM.push(acc);
  }
}

/** Sample a vehicle type from the configured mix. */
export function pickVehicleType(rng) {
  const r = rng.next();
  for (let i = 0; i < MIX_CUM.length; i++) {
    if (r < MIX_CUM[i]) return MIX_TYPES[i];
  }
  return MIX_TYPES[MIX_TYPES.length - 1];
}

let nextVehicleId = 1;

export function createVehicle(rng, lane, type) {
  if (!type) type = pickVehicleType(rng);
  const spec = CONFIG.vehicleTypes[type];
  const idm = CONFIG.idm;
  const j = idm.jitter;
  const palette = PALETTES[type] || FALLBACK_PALETTE;
  const colorHex = palette[Math.floor(rng.next() * palette.length)];
  return {
    id: nextVehicleId++,
    type,
    typeIndex: TYPE_INDEX[type],
    len: spec.lengthM,
    seg: lane, // current segment: real Lane or connector
    s: 0, // arc position of vehicle CENTER along seg
    prevSeg: lane, // state at the START of the current step (render interpolation §2.1)
    prevS: 0,
    _gone: false, // set on despawn (lets the follow camera detach)
    isPhantom: false, // V3 C1 incidents: stopped fake vehicle, lives ONLY in lane.vehicles
    v: 0,
    nextConn: null, // cached next connector for the current real lane
    exitEdgeId: null, // routed exit (null in onNetwork mode)
    mandatory: 0, // mandatory lane-change direction: -1 left, +1 right, 0 none
    tripDist: 0,
    tripMax: Infinity, // onNetwork despawn budget (exp-distributed)
    gradeFactor: spec.gradeFactor ?? 0.6, // slope sensitivity (F1)
    // --- bus stops (F2) ---
    isMicro: type === 'micro', // cached bool for the stop-logic hot path
    nextStopS: -1, // arc s of the next bus stop to serve on this lane (-1 = none)
    nextStopIdx: -1, // index into seg.busStops for that stop
    dwellUntil: -1, // sim time until which the micro dwells at a stop
    // --- per-step scratch (stable shape, no allocations in step()) ---
    _a: 0,
    _aGrade: 0, // grade accel term this step (F1; shared with MOBIL ctx)
    _blocked: false, // conflict-blocked this step (feeds deadlock breaker)
    _lcTo: null, // lane-change target chosen this step
    blockT: 0, // seconds spent conflict-blocked at ~standstill
    ignoreCount: 0, // deadlock breaker: # lowest-priority conflicts ignored
    lcCooldownUntil: 0,
    lcLat: 0, // render-side lateral ease: initial offset (m, + = right)
    lcT: -10, // sim time of last lane change
    color: {
      r: ((colorHex >> 16) & 0xff) / 255,
      g: ((colorHex >> 8) & 0xff) / 255,
      b: (colorHex & 0xff) / 255,
    },
    v0Factor: rng.jitter(spec.v0Factor, j),
    idm: {
      a: rng.jitter(idm.a * spec.accelFactor, j),
      b: rng.jitter(idm.b, j),
      T: rng.jitter(idm.T, j),
      s0: rng.jitter(idm.s0, j),
      delta: idm.delta,
    },
  };
}
