// Overpass JSON -> { nodes: Map, ways: [] } with tag normalization
// (oneway, lanes per direction, maxspeed). Spec §1.3.

import { CONFIG } from '../config.js';
import { clamp } from '../util/math2d.js';

const KMH_TO_MS = 1 / 3.6;
const MPH_TO_KMH = 1.609;

/**
 * Parse a raw `maxspeed` tag value into km/h, or null when unusable
 * (e.g. "signals", "walk", "none").
 */
function parseMaxspeedKmh(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null; // "signals" / "walk" / etc -> class default
  let v = parseFloat(m[1]);
  if (/mph/i.test(raw)) v *= MPH_TO_KMH;
  return v > 0 ? v : null;
}

/**
 * Normalize one way's tags into per-direction lane counts and speed.
 * Returns null when the way should be dropped.
 */
function normalizeWay(way) {
  const tags = way.tags || {};
  const cls = tags.highway;
  if (!CONFIG.highwayWhitelist.includes(cls)) return null;
  if (tags.area === 'yes') return null;
  if (tags.access === 'private' || tags.access === 'no') return null;

  const defaults = CONFIG.classDefaults[cls];
  let nodeRefs = way.nodes.slice();

  // --- oneway ---
  const ow = tags.oneway;
  let oneway = ow === 'yes' || ow === '1' || ow === 'true';
  if (ow === '-1') {
    oneway = true;
    nodeRefs.reverse(); // treat as forward along reversed node list
  }
  if (tags.junction === 'roundabout' || tags.junction === 'circular') oneway = true;
  if (ow === 'no') oneway = false;

  // --- lanes (total both directions) ---
  const { min: minL, max: maxL } = CONFIG.lanesPerDirClamp;
  const lanesTotal = parseInt(tags.lanes, 10);
  const lanesFwdTag = parseInt(tags['lanes:forward'], 10);
  const lanesBwdTag = parseInt(tags['lanes:backward'], 10);
  let lanesFwd;
  let lanesBwd;
  if (oneway) {
    lanesBwd = 0;
    lanesFwd = Number.isFinite(lanesTotal) ? lanesTotal : defaults.lanesPerDir;
    lanesFwd = clamp(lanesFwd, minL, maxL);
  } else {
    if (Number.isFinite(lanesFwdTag) || Number.isFinite(lanesBwdTag)) {
      lanesFwd = Number.isFinite(lanesFwdTag) ? lanesFwdTag : defaults.lanesPerDir;
      lanesBwd = Number.isFinite(lanesBwdTag) ? lanesBwdTag : defaults.lanesPerDir;
    } else if (Number.isFinite(lanesTotal)) {
      lanesFwd = Math.ceil(lanesTotal / 2);
      lanesBwd = Math.floor(lanesTotal / 2);
    } else {
      lanesFwd = defaults.lanesPerDir;
      lanesBwd = defaults.lanesPerDir;
    }
    lanesFwd = clamp(lanesFwd, minL, maxL);
    lanesBwd = clamp(lanesBwd, minL, maxL);
  }

  // --- maxspeed ---
  const kmh = parseMaxspeedKmh(tags.maxspeed) ?? defaults.speedKmh;
  const speedMs = kmh * KMH_TO_MS;

  return {
    id: way.id,
    nodeRefs,
    highwayClass: cls,
    oneway,
    lanesFwd,
    lanesBwd,
    speedMs,
    tags,
  };
}

/**
 * Overpass JSON -> {
 *   nodes: Map(id -> {id, lat, lon, tags}),
 *   ways:  [{id, nodeRefs[], highwayClass, oneway, lanesFwd, lanesBwd, speedMs, tags}],
 *   signalNodeIds: Set(id)   // nodes tagged highway=traffic_signals
 * }
 */
export function parseOsm(json) {
  const nodes = new Map();
  const ways = [];
  const signalNodeIds = new Set();
  const elements = json?.elements || [];

  for (const el of elements) {
    if (el.type === 'node') {
      nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
      if (el.tags && el.tags.highway === 'traffic_signals') signalNodeIds.add(el.id);
    }
  }
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.nodes) || el.nodes.length < 2) continue;
    const w = normalizeWay(el);
    if (!w) continue;
    // Drop refs to nodes missing from the response and consecutive duplicates.
    const refs = [];
    for (const r of w.nodeRefs) {
      if (!nodes.has(r)) continue;
      if (refs.length && refs[refs.length - 1] === r) continue;
      refs.push(r);
    }
    if (refs.length < 2) continue;
    w.nodeRefs = refs;
    ways.push(w);
  }

  return { nodes, ways, signalNodeIds };
}
