// Seeded RNG (mulberry32) — determinism for tests.

/** Returns a () => float in [0,1) generator seeded with the given 32-bit seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper with common sampling helpers. */
export function createRng(seed = 1) {
  const next = mulberry32(seed);
  return {
    next,
    /** float in [min, max) */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** integer in [min, max] inclusive */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** random element of a non-empty array */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /** exponential distribution with the given mean */
    exp(mean) {
      return -Math.log(1 - next()) * mean;
    },
    /** multiplicative jitter: value * (1 +- amount) */
    jitter(value, amount) {
      return value * (1 + (next() * 2 - 1) * amount);
    },
  };
}
