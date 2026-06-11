// 2D polyline math on the ground plane. Points are {x, z} (three.js x/z, y up).
// Travel direction d = (dx, dz); the RIGHT side of travel is n = (-dz, dx)
// (see src/geo/projection.js for the handedness convention).
// signedAngle: RIGHT turns are POSITIVE (cross = a.x*b.z - a.z*b.x).

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function dist2d(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Signed angle (radians) from direction a to direction b; right turns positive. */
export function signedAngle(a, b) {
  const dot = a.x * b.x + a.z * b.z;
  const cross = a.x * b.z - a.z * b.x; // positive = rotation toward driver's right
  return Math.atan2(cross, dot);
}

/** Normalize an angle to (-PI, PI]. */
export function normalizeAngle(a) {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** Smallest absolute difference between two headings (radians), in [0, PI]. */
export function angularDiff(h1, h2) {
  return Math.abs(normalizeAngle(h1 - h2));
}

/** Smallest difference between two headings treated as AXES (mod 180°), in [0, PI/2]. */
export function axisDiff(h1, h2) {
  let d = Math.abs(normalizeAngle(h1 - h2));
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** Total arc length of a polyline. */
export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist2d(points[i - 1], points[i]);
  return len;
}

/** Prefix-sum arc lengths: cumLen[i] = distance from points[0] to points[i]. */
export function cumulativeLengths(points) {
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + dist2d(points[i - 1], points[i]);
  }
  return cum;
}

/** Remove consecutive duplicate (or near-duplicate) vertices. */
export function dedupePolyline(points, eps = 1e-6) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (dist2d(out[out.length - 1], points[i]) > eps) out.push(points[i]);
  }
  return out;
}

/**
 * Resample a polyline so that no segment exceeds maxStep (original vertices kept).
 */
export function resamplePolyline(points, maxStep) {
  if (points.length < 2) return points.slice();
  const out = [{ x: points[0].x, z: points[0].z }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = dist2d(a, b);
    const n = Math.max(1, Math.ceil(d / maxStep));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
    }
  }
  return out;
}

/**
 * Offset a polyline laterally. Positive d offsets to the RIGHT of travel
 * (n = (-dz, dx)). Per-vertex miter normal = normalized sum of adjacent
 * segment normals scaled by 1/cos(theta/2); miter length clamped to
 * miterClampFactor * |d|. Returns a new polyline with the same vertex count.
 */
export function offsetPolyline(points, d, miterClampFactor = 2.5) {
  const n = points.length;
  if (n < 2 || d === 0) {
    return points.map((p) => ({ x: p.x, z: p.z }));
  }
  // Per-segment unit right normals.
  const segNx = new Array(n - 1);
  const segNz = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    let dx = points[i + 1].x - points[i].x;
    let dz = points[i + 1].z - points[i].z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= len;
    dz /= len;
    segNx[i] = -dz; // right normal
    segNz[i] = dx;
  }
  const maxLen = Math.abs(d) * miterClampFactor;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 2, i);
    let mx = segNx[i0] + segNx[i1];
    let mz = segNz[i0] + segNz[i1];
    const mlen = Math.sqrt(mx * mx + mz * mz);
    let ox, oz;
    if (mlen < 1e-9) {
      // 180° spike — fall back to one segment's normal.
      ox = segNx[i1] * d;
      oz = segNz[i1] * d;
    } else {
      mx /= mlen;
      mz /= mlen;
      // cos(theta/2) = dot(miterUnit, segNormal)
      const cosHalf = mx * segNx[i1] + mz * segNz[i1];
      let scale = d / Math.max(cosHalf, 1e-3);
      scale = clamp(scale, -maxLen, maxLen);
      ox = mx * scale;
      oz = mz * scale;
    }
    out[i] = { x: points[i].x + ox, z: points[i].z + oz };
  }
  return out;
}

/**
 * Point at arc length s along a polyline (binary search over cumLen + lerp).
 * Writes into `out` when provided to avoid per-frame allocations.
 */
export function pointAtParam(points, cumLen, s, out) {
  const res = out || { x: 0, z: 0 };
  const total = cumLen[cumLen.length - 1];
  if (s <= 0) {
    res.x = points[0].x;
    res.z = points[0].z;
    return res;
  }
  if (s >= total) {
    const p = points[points.length - 1];
    res.x = p.x;
    res.z = p.z;
    return res;
  }
  let lo = 0;
  let hi = cumLen.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] <= s) lo = mid;
    else hi = mid;
  }
  const segLen = cumLen[hi] - cumLen[lo] || 1;
  const t = (s - cumLen[lo]) / segLen;
  res.x = lerp(points[lo].x, points[hi].x, t);
  res.z = lerp(points[lo].z, points[hi].z, t);
  return res;
}

/**
 * Unit heading at arc length s along a polyline. Writes into `out` when given.
 */
export function headingAtParam(points, cumLen, s, out) {
  const res = out || { x: 0, z: 0 };
  const total = cumLen[cumLen.length - 1];
  let lo = 0;
  let hi = cumLen.length - 1;
  if (s <= 0) {
    hi = 1;
  } else if (s >= total) {
    lo = cumLen.length - 2;
    hi = cumLen.length - 1;
  } else {
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLen[mid] <= s) lo = mid;
      else hi = mid;
    }
  }
  let dx = points[hi].x - points[lo].x;
  let dz = points[hi].z - points[lo].z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  res.x = dx / len;
  res.z = dz / len;
  return res;
}

/**
 * Sample a cubic Bézier P0..P3 into a polyline with roughly `stepM` spacing.
 */
export function sampleCubicBezier(p0, p1, p2, p3, stepM = 1.0) {
  // Estimate length via control polygon to choose sample count.
  const approx =
    dist2d(p0, p1) + dist2d(p1, p2) + dist2d(p2, p3);
  const n = Math.max(4, Math.ceil(approx / stepM));
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out[i] = {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
    };
  }
  return out;
}

/**
 * Trim a polyline by trimStart meters at the beginning and trimEnd at the end.
 * If the remaining length would be < minRemain, trims are scaled down
 * proportionally. Returns a new polyline.
 */
export function trimPolyline(points, trimStart, trimEnd, minRemain = 4) {
  const cum = cumulativeLengths(points);
  const total = cum[cum.length - 1];
  let ts = Math.max(0, trimStart);
  let te = Math.max(0, trimEnd);
  if (total - ts - te < minRemain) {
    const avail = Math.max(0, total - minRemain);
    const sum = ts + te;
    if (sum > 0) {
      ts = (ts / sum) * avail;
      te = (te / sum) * avail;
    }
  }
  const sEnd = total - te;
  const out = [pointAtParam(points, cum, ts)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > ts && cum[i] < sEnd) out.push({ x: points[i].x, z: points[i].z });
  }
  out.push(pointAtParam(points, cum, sEnd));
  return dedupePolyline(out);
}

/** Circumradius of the circle through three points (Infinity when collinear). */
export function circumradius(a, b, c) {
  const ab = dist2d(a, b);
  const bc = dist2d(b, c);
  const ca = dist2d(c, a);
  const area2 = Math.abs(
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  ); // = 2 * triangle area
  if (area2 < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * area2);
}
