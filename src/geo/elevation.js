// Real elevation grids (F1). Open-Meteo elevation API: CORS, free, no key,
// batches of up to 100 points per request. The grid is keyed by lat/lon (NOT
// node ids — those don't survive graph collapse/merge): ~50 m step over the
// query bbox + 20% margin, clamped to 48x48 points.
//
// Grid JSON shape (also the committed default snapshot
// public/data/default-elevation.json, produced by
// scripts/fetch-default-elevation.mjs):
//   { lat0, lon0, latStep, lonStep, cols, rows, values: [rows*cols] }
// values are RAW meters above sea level, row-major, row r = lat0 + r*latStep
// (south -> north), col c = lon0 + c*lonStep (west -> east).
//
// createElevationSampler() normalizes to the projection origin (y = 0 at the
// query center) so cameras/fog/shadows keep working — La Paz sits at ~3600 m.

import { CONFIG } from '../config.js';

const METERS_PER_DEG_LAT = 111320; // matches src/geo/projection.js

/** Fallback for zones without elevation data: everything at y = 0. */
export const FLAT_SAMPLER = { elevAt: () => 0, minElev: 0, maxElev: 0, flat: true };

/**
 * Grid spec for a circular query (center + radius): bbox + 20% margin,
 * gridStepM spacing, clamped to gridMaxPoints per axis.
 */
export function elevationGridSpec(lat, lon, radiusM) {
  const cfg = CONFIG.elevation;
  const half = radiusM * 1.2; // bbox + 20% margin
  const maxN = cfg.gridMaxPoints;
  let n = Math.floor((2 * half) / cfg.gridStepM) + 1;
  if (n < 2) n = 2;
  if (n > maxN) n = maxN;
  const stepM = (2 * half) / (n - 1);
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return {
    lat0: lat - half / METERS_PER_DEG_LAT,
    lon0: lon - half / mPerDegLon,
    latStep: stepM / METERS_PER_DEG_LAT,
    lonStep: stepM / mPerDegLon,
    cols: n,
    rows: n,
  };
}

/** One Open-Meteo batch (<= batchSize points) with an abort timeout. */
async function fetchBatchOnce(lats, lons, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  try {
    const url =
      `${cfg.apiUrl}?latitude=${lats.join(',')}&longitude=${lons.join(',')}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`elevation API ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.elevation) || data.elevation.length !== lats.length) {
      throw new Error('elevation API: respuesta inválida');
    }
    return data.elevation;
  } finally {
    clearTimeout(timer);
  }
}

/** Batch fetch with 2 retries (backoff) — Open-Meteo rate-limits bursts. */
async function fetchBatch(lats, lons, cfg) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt * attempt));
    try {
      return await fetchBatchOnce(lats, lons, cfg);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Fetch a full elevation grid for a circular zone. Batches of batchSize,
 * `concurrency` requests in flight. Throws on any failure (caller falls back
 * to FLAT_SAMPLER). Works in browsers AND Node >= 18 (used by the snapshot
 * script). opts: {concurrency?, delayMs?} — the script paces itself to dodge
 * Open-Meteo burst limits.
 */
export async function fetchElevationGrid(lat, lon, radiusM, opts) {
  const cfg = CONFIG.elevation;
  const concurrency = (opts && opts.concurrency) || cfg.concurrency;
  const delayMs = (opts && opts.delayMs) || 0;
  const spec = elevationGridSpec(lat, lon, radiusM);
  const total = spec.rows * spec.cols;
  const values = new Array(total).fill(0);

  // Flatten grid points row-major (lat rows ascending, lon cols ascending).
  const batches = [];
  for (let start = 0; start < total; start += cfg.batchSize) {
    const end = Math.min(start + cfg.batchSize, total);
    const lats = [];
    const lons = [];
    for (let i = start; i < end; i++) {
      const r = Math.floor(i / spec.cols);
      const c = i % spec.cols;
      lats.push((spec.lat0 + r * spec.latStep).toFixed(6));
      lons.push((spec.lon0 + c * spec.lonStep).toFixed(6));
    }
    batches.push({ start, lats, lons });
  }

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const b = batches[next++];
      const elev = await fetchBatch(b.lats, b.lons, cfg);
      for (let i = 0; i < elev.length; i++) {
        values[b.start + i] = elev[i] == null ? 0 : elev[i];
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(concurrency, batches.length); k++) workers.push(worker());
  await Promise.all(workers);

  return {
    lat0: spec.lat0,
    lon0: spec.lon0,
    latStep: spec.latStep,
    lonStep: spec.lonStep,
    cols: spec.cols,
    rows: spec.rows,
    values,
  };
}

/**
 * Bilinear sampler over a grid JSON, in LOCAL METERS (projection space).
 * Grid corners are converted to meters once; queries outside the grid clamp
 * to the border. Heights are normalized so the projection origin (query
 * center) sits at y = 0. Returns { elevAt(x,z), minElev, maxElev, flat:false }.
 */
export function createElevationSampler(grid, projection) {
  const { cols, rows, values } = grid;
  const p00 = projection.toLocal(grid.lat0, grid.lon0);
  const x0 = p00.x;
  const z0 = p00.z;
  // Per-row/col meter steps (z decreases as lat increases: zStep < 0).
  const xStep = projection.toLocal(grid.lat0, grid.lon0 + grid.lonStep).x - x0;
  const zStep = projection.toLocal(grid.lat0 + grid.latStep, grid.lon0).z - z0;

  const maxC = cols - 1;
  const maxR = rows - 1;

  function rawAt(x, z) {
    let gx = (x - x0) / xStep;
    let gz = (z - z0) / zStep; // row index along lat
    if (gx < 0) gx = 0;
    else if (gx > maxC) gx = maxC;
    if (gz < 0) gz = 0;
    else if (gz > maxR) gz = maxR;
    const c0 = Math.min(Math.floor(gx), maxC - 1);
    const r0 = Math.min(Math.floor(gz), maxR - 1);
    const tx = gx - c0;
    const tz = gz - r0;
    const i00 = r0 * cols + c0;
    const v00 = values[i00];
    const v01 = values[i00 + 1];
    const v10 = values[i00 + cols];
    const v11 = values[i00 + cols + 1];
    const a = v00 + (v01 - v00) * tx;
    const b = v10 + (v11 - v10) * tx;
    return a + (b - a) * tz;
  }

  const base = rawAt(0, 0); // projection origin -> y = 0
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    elevAt: (x, z) => rawAt(x, z) - base,
    minElev: min - base,
    maxElev: max - base,
    flat: false,
  };
}
