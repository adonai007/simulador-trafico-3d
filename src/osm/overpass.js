// Overpass runtime fetch (spec §1.1): around-radius highway query, mirror
// fallback with 25 s aborts, post-parse way/node caps with one auto-retry at
// radius × 0.6. Building footprint query reuses the same transport (the
// bundled snapshots in public/data/ were produced with these exact queries).
//
// Errors are typed via `err.code` so the UI can map them to Spanish toasts:
//   'OFFLINE'   — every mirror failed / timed out
//   'TOO_DENSE' — way/node caps exceeded even after the radius retry

import { CONFIG } from '../config.js';
import { clamp } from '../util/math2d.js';

/**
 * Highway whitelist query — `around` radius, recursed nodes WITH tags.
 * Unions standalone highway=bus_stop nodes (F2): stops mapped BESIDE the road
 * are not way members, so way recursion alone would miss them.
 */
export function buildHighwayQuery(lat, lon, radiusM) {
  const classes = CONFIG.highwayWhitelist.join('|');
  const r = Math.round(radiusM);
  return (
    `[out:json][timeout:30];` +
    `(` +
    `way(around:${r},${lat},${lon})` +
    `["highway"~"^(${classes})$"]` +
    `["area"!="yes"]` +
    `["access"!~"^(private|no)$"];` +
    `node(around:${r},${lat},${lon})["highway"="bus_stop"];` +
    `);` +
    `(._;>;);out body;`
  );
}

/** Closed building ways (same pattern that produced default-buildings.json). */
export function buildBuildingQuery(lat, lon, radiusM) {
  return (
    `[out:json][timeout:30];` +
    `way(around:${Math.round(radiusM)},${lat},${lon})["building"];` +
    `(._;>;);out body;`
  );
}

function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * POST the query to each mirror in turn (`data=` form body), AbortController
 * timeout per attempt. Resolves to parsed Overpass JSON.
 */
export async function fetchWithFallback(query) {
  const { mirrors, timeoutMs } = CONFIG.overpass;
  let lastErr = null;
  for (const url of mirrors) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw typedError('OFFLINE', `Overpass mirrors failed: ${lastErr?.message ?? 'unknown'}`);
}

function countElements(osm) {
  let ways = 0;
  let nodes = 0;
  for (const el of osm.elements || []) {
    if (el.type === 'way') ways++;
    else if (el.type === 'node') nodes++;
  }
  return { ways, nodes };
}

/**
 * Fetch the road network around a point. Radius clamped to 250–1200 m.
 * Hard cap after parse (ways > 1500 or nodes > 20000): one retry at
 * radius × 0.6, then 'TOO_DENSE'. Resolves to { osm, radiusM }.
 */
export async function fetchNetworkOsm(lat, lon, radiusM) {
  const { min, max } = CONFIG.radiusClampM;
  let r = clamp(radiusM ?? CONFIG.defaultRadiusM, min, max);
  const { maxWays, maxNodes, retryRadiusFactor } = CONFIG.overpass;
  for (let attempt = 0; attempt < 2; attempt++) {
    const osm = await fetchWithFallback(buildHighwayQuery(lat, lon, r));
    const { ways, nodes } = countElements(osm);
    if (ways <= maxWays && nodes <= maxNodes) return { osm, radiusM: r };
    r = Math.max(min, r * retryRadiusFactor);
  }
  throw typedError('TOO_DENSE', 'way/node caps exceeded after radius retry');
}

/** Fetch building footprints for the area; caller treats failure as "no buildings". */
export async function fetchBuildingsOsm(lat, lon, radiusM) {
  const { min, max } = CONFIG.radiusClampM;
  const r = clamp(radiusM ?? CONFIG.defaultRadiusM, min, max);
  return fetchWithFallback(buildBuildingQuery(lat, lon, r));
}
