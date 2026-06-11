// Phase state machine per intersection — STATELESS, clock-driven (spec §1.7).
// No per-tick mutation: the state is a pure function of (signal plan, sim time).
//
// Cycle timeline (phaseTime = (simTime + offsetS) mod cycleS):
//   [0,                greenNS)                       : NS green, EW red
//   [greenNS,          greenNS+yellow)                : NS yellow, EW red
//   [greenNS+yellow,   greenNS+yellow+allRed)         : all red
//   [.. ,              .. + greenEW)                  : EW green, NS red
//   [.. ,              .. + yellow)                   : EW yellow, NS red
//   [.. ,              cycleS)                        : all red

let simClock = 0;

/** Advance the shared signal clock (called once per sim step / frame). */
export function setSimTime(t) {
  simClock = t;
}

export function getSimTime() {
  return simClock;
}

/**
 * signalState(signal, approachGroup, t?) -> 'green' | 'yellow' | 'red'
 * `signal` is the object produced by network/signals.js (or a junction node
 * with `.signal`). `approachGroup` is 'NS' | 'EW'. `t` defaults to the
 * shared clock set via setSimTime().
 */
export function signalState(signal, approachGroup, t = simClock) {
  const sig = signal && signal.plan ? signal : signal?.signal;
  if (!sig) return 'green'; // unsignalized -> always green
  const { cycleS, greenNS, greenEW, yellowS, allRedS, offsetS } = sig.plan;
  let pt = (t + offsetS) % cycleS;
  if (pt < 0) pt += cycleS;

  const nsYellowEnd = greenNS + yellowS;
  const nsAllRedEnd = nsYellowEnd + allRedS;
  const ewGreenEnd = nsAllRedEnd + greenEW;
  const ewYellowEnd = ewGreenEnd + yellowS;

  if (approachGroup === 'NS') {
    if (pt < greenNS) return 'green';
    if (pt < nsYellowEnd) return 'yellow';
    return 'red';
  }
  // EW
  if (pt < nsAllRedEnd) return 'red';
  if (pt < ewGreenEnd) return 'green';
  if (pt < ewYellowEnd) return 'yellow';
  return 'red';
}

/** Seconds of green remaining for the group at time t (0 when not green). */
export function greenRemaining(signal, approachGroup, t = simClock) {
  const sig = signal && signal.plan ? signal : signal?.signal;
  if (!sig) return Infinity;
  const { cycleS, greenNS, greenEW, yellowS, allRedS, offsetS } = sig.plan;
  let pt = (t + offsetS) % cycleS;
  if (pt < 0) pt += cycleS;
  if (approachGroup === 'NS') {
    return pt < greenNS ? greenNS - pt : 0;
  }
  const ewStart = greenNS + yellowS + allRedS;
  const ewEnd = ewStart + greenEW;
  return pt >= ewStart && pt < ewEnd ? ewEnd - pt : 0;
}
