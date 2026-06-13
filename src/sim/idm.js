// Intelligent Driver Model — pure function (spec contract: idmAccel(v, v0, gap, dv, p) -> a).
//   v   current speed (m/s)
//   v0  desired speed (m/s)
//   gap bumper-to-bumper gap to leader (m); Infinity for free road
//   dv  approach rate = v - vLeader (m/s)
//   p   { a, b, T, s0, delta }
//
// Weather (V3 C2, D5): the GLOBAL caution multipliers live in
// CONFIG.weather.current and are applied here — every call site
// (car-following, signal/conflict/creep/bus-stop obstacles, MOBIL) gets
// consistent rain behavior for free. environment.setWeather mutates the
// `current` object IN PLACE, so this module-level reference stays live.
// Identity values {v0Mul:1, TAdd:0, bMul:1} are bit-exact no-ops.

import { CONFIG } from '../config.js';

const W = CONFIG.weather.current;

export function idmAccel(v, v0, gap, dv, p) {
  v0 *= W.v0Mul;
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), p.delta);
  if (!Number.isFinite(gap) || gap > 1e4) return p.a * free;
  const b = p.b * W.bMul;
  const T = p.T + W.TAdd;
  const sStar = p.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(p.a * b)));
  const g = Math.max(gap, 0.1);
  return p.a * (free - (sStar / g) * (sStar / g));
}
