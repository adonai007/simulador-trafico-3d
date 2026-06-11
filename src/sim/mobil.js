// MOBIL lane-change decision (spec §2.5) — pure decision logic, no mutation.
//
//   mobilDecision(veh, ctx) -> targetLane | null
//
//   ctx (caller-owned scratch object, reused per call — zero allocations):
//     edge      current edge (lanes[] indexed left->right, 0 = innermost)
//     aSelf     vehicle's current pure car-following accel (no signal/conflict)
//     leader    current-lane leader vehicle or null
//     follower  current-lane follower vehicle or null
//
// Standard variant: incentive aNew - aSelf > p * (followerLosses) + threshold,
// safety: new-follower decel >= safeDecel (-4 m/s²).
// Mandatory variant (veh.mandatory = ±1, lane lacks connector to route edge):
// incentive overridden, change as soon as safety passes; within
// mandatoryRelaxDistM of lane end the safety bound relaxes to -6 m/s²
// (creep handled by the sim via a virtual obstacle at the lane end).

import { CONFIG } from '../config.js';
import { idmAccel } from './idm.js';

const _nb = { leader: null, follower: null };

/** Find leader/follower in `lane` around arc position sT (vehicles sorted by s desc). */
function neighborsAt(lane, sT) {
  const arr = lane.vehicles;
  let leader = null;
  let follower = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].s > sT) {
      leader = arr[i];
    } else {
      follower = arr[i];
      break;
    }
  }
  _nb.leader = leader;
  _nb.follower = follower;
  return _nb;
}

/**
 * Evaluate one candidate lane. Returns the incentive value (higher = better),
 * -Infinity when rejected (no room / unsafe). For mandatory changes any value
 * > -Infinity means "safety passed".
 */
function evaluateLane(veh, target, ctx, mandatory) {
  const cfg = CONFIG.sim.mobil;
  const lane = veh.seg;
  // Proportional arc mapping (sibling lanes differ slightly in length).
  const sT = (veh.s / lane.length) * target.length;
  const nb = neighborsAt(target, sT);

  const distToEnd = lane.length - veh.s;
  const safeDecel =
    mandatory && distToEnd < cfg.mandatoryRelaxDistM ? cfg.mandatorySafeDecel : cfg.safeDecel;

  // Physical room.
  let gapLead = Infinity;
  let leadV = 0;
  if (nb.leader) {
    gapLead = nb.leader.s - nb.leader.len / 2 - sT - veh.len / 2;
    leadV = nb.leader.v;
    if (gapLead < 0.5) return -Infinity;
  }
  let gapFol = Infinity;
  if (nb.follower) {
    gapFol = sT - veh.len / 2 - nb.follower.s - nb.follower.len / 2;
    if (gapFol < 0.5) return -Infinity;
  }

  const v0T = target.speedMs * veh.v0Factor;
  const aNew = idmAccel(veh.v, v0T, gapLead, veh.v - leadV, veh.idm);

  // New follower: safety + imposed loss.
  let folLoss = 0;
  if (nb.follower) {
    const f = nb.follower;
    const fv0 = target.speedMs * f.v0Factor;
    const aFolAfter = idmAccel(f.v, fv0, gapFol, f.v - veh.v, f.idm);
    if (aFolAfter < safeDecel) return -Infinity;
    if (!mandatory) {
      const gapBefore = nb.leader
        ? nb.leader.s - nb.leader.len / 2 - f.s - f.len / 2
        : Infinity;
      const aFolBefore = idmAccel(f.v, fv0, gapBefore, f.v - leadV, f.idm);
      folLoss = aFolBefore - aFolAfter; // positive = follower is worse off
    }
  }
  if (mandatory) return 0; // safety passed; incentive is overridden

  // Old follower: gain when we leave (inherits our leader).
  let oldGain = 0;
  if (ctx.follower) {
    const f = ctx.follower;
    const fv0 = lane.speedMs * f.v0Factor;
    const gapBefore = veh.s - veh.len / 2 - f.s - f.len / 2;
    const aBefore = idmAccel(f.v, fv0, gapBefore, f.v - veh.v, f.idm);
    let gapAfter = Infinity;
    let lv = 0;
    if (ctx.leader) {
      gapAfter = ctx.leader.s - ctx.leader.len / 2 - f.s - f.len / 2;
      lv = ctx.leader.v;
    }
    const aAfter = idmAccel(f.v, fv0, gapAfter, f.v - lv, f.idm);
    oldGain = aAfter - aBefore; // usually positive
  }

  const incentive = aNew - ctx.aSelf - cfg.politeness * (folLoss - oldGain);
  return incentive > cfg.threshold ? incentive : -Infinity;
}

/**
 * mobilDecision(veh, ctx) -> targetLane | null. Caller guarantees: veh is on a
 * real lane of a multi-lane edge and the cooldown has elapsed. Mandatory
 * changes only consider the lane toward the connector that serves the route;
 * discretionary changes consider both neighbors and pick the higher incentive.
 */
export function mobilDecision(veh, ctx) {
  const lanes = ctx.edge.lanes;
  const idx = veh.seg.index;

  if (veh.mandatory !== 0) {
    const ti = idx + veh.mandatory;
    if (ti < 0 || ti >= lanes.length) return null;
    return evaluateLane(veh, lanes[ti], ctx, true) > -Infinity ? lanes[ti] : null;
  }

  let best = null;
  let bestVal = -Infinity;
  if (idx > 0) {
    const val = evaluateLane(veh, lanes[idx - 1], ctx, false);
    if (val > bestVal) {
      bestVal = val;
      best = lanes[idx - 1];
    }
  }
  if (idx < lanes.length - 1) {
    const val = evaluateLane(veh, lanes[idx + 1], ctx, false);
    if (val > bestVal) {
      bestVal = val;
      best = lanes[idx + 1];
    }
  }
  return bestVal > -Infinity ? best : null;
}
