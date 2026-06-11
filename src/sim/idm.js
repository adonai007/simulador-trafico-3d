// Intelligent Driver Model — pure function (spec contract: idmAccel(v, v0, gap, dv, p) -> a).
//   v   current speed (m/s)
//   v0  desired speed (m/s)
//   gap bumper-to-bumper gap to leader (m); Infinity for free road
//   dv  approach rate = v - vLeader (m/s)
//   p   { a, b, T, s0, delta }

export function idmAccel(v, v0, gap, dv, p) {
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), p.delta);
  if (!Number.isFinite(gap) || gap > 1e4) return p.a * free;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(gap, 0.1);
  return p.a * (free - (sStar / g) * (sStar / g));
}
