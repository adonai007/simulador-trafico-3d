// D2 — Mi Teleférico aerialway network. Parses raw Overpass aerialway JSON
// into elevated 3D cable polylines + station/tower nodes consumed by
// render/aerialwayMesh.js. Pure data (no THREE, no scene) so it runs in Node
// (scripts/fetch-default-aerialway.mjs validation) and the browser alike.
//
// Coordinate convention matches the rest of the sim (see geo/projection.js):
//   x = east, z = -north, y = up (meters, origin at the query center).
//
// Cable height model: each cable rides at elevAt(x,z) + cableHeightM ABOVE the
// displaced terrain, so it follows the hills the gondola actually spans. Points
// are resampled to ~sampleStepM so the tube + cabin motion stay smooth over
// long sagless spans. Arc-length tables (cumLen) are precomputed for zero-alloc
// cabin animation downstream.

import { CONFIG } from '../config.js';
import { cumulativeLengths } from '../util/math2d.js';

// Mi Teleférico line names (Spanish, OSM `name`/`ref`) -> palette key. The line
// NAME is the authority (e.g. "Teleférico Línea Celeste"), so the Spanish color
// words are matched FIRST against name/ref; only then do we fall back to colour
// keywords. Order matters: more-specific keys (celeste, skyblue) precede the
// generic "blue" so "skyblue"/"Celeste" never collapses onto Azul.
const NAME_COLOR_KEYS = [
  // Spanish line-name colors (authoritative — these come from `name`/`ref`).
  ['amarilla', 'Amarilla'],
  ['celeste', 'Celeste'],
  ['blanca', 'Blanca'],
  ['verde', 'Verde'],
  ['naranja', 'Naranja'],
  ['café', 'Café'], ['cafe', 'Café'], ['marrón', 'Café'], ['marron', 'Café'],
  ['plateada', 'Plateada'], ['plata', 'Plateada'],
  ['morada', 'Morada'], ['púrpura', 'Morada'], ['purpura', 'Morada'], ['violeta', 'Morada'],
  ['azul', 'Azul'],
  ['roja', 'Roja'], ['rojo', 'Roja'],
  // English / colour-tag keywords (fallback). "skyblue"/"lightblue"/"cyan"
  // before "blue"; "silver"/"grey" -> Plateada; "purple"/"violet" -> Morada.
  ['yellow', 'Amarilla'],
  ['skyblue', 'Celeste'], ['lightblue', 'Celeste'], ['cyan', 'Celeste'],
  ['white', 'Blanca'],
  ['green', 'Verde'],
  ['orange', 'Naranja'],
  ['brown', 'Café'],
  ['silver', 'Plateada'], ['grey', 'Plateada'], ['gray', 'Plateada'], ['gris', 'Plateada'],
  ['purple', 'Morada'], ['violet', 'Morada'],
  ['blue', 'Azul'],
  ['red', 'Roja'],
];

/** Parse a CSS-ish `colour` tag ("#d0021b" / "red") into an int, or null. */
function parseColourTag(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const hex = s.match(/^#?([0-9a-f]{6})$/);
  if (hex) return parseInt(hex[1], 16);
  const hex3 = s.match(/^#?([0-9a-f]{3})$/);
  if (hex3) {
    const c = hex3[1];
    return parseInt(c[0] + c[0] + c[1] + c[1] + c[2] + c[2], 16);
  }
  return null;
}

/**
 * Resolve a line's display color + canonical name. Priority:
 *   1. OSM line-name/ref keyword (Roja/Amarilla/...) -> CONFIG.lineColors hue
 *      (identity over the real Mi Teleférico palette).
 *   2. explicit `colour` hex tag.
 *   3. palette[index] fallback (keeps multi-line zones visually distinct).
 * Returns { color, name } where name is the canonical Spanish label when known.
 */
function resolveLineStyle(tags, index) {
  const cfg = CONFIG.aerialway;
  // 1. NAME/ref is authoritative (the real "Línea Celeste" etc).
  const nameHay = `${tags.name ?? ''} ${tags.ref ?? ''} ${tags['name:es'] ?? ''}`.toLowerCase();
  for (const [needle, key] of NAME_COLOR_KEYS) {
    if (nameHay.includes(needle)) {
      const color = cfg.lineColors[key];
      if (color != null) return { color, name: tags.name || tags.ref || `Línea ${key}` };
    }
  }
  // 2. colour-tag keyword (e.g. "skyblue", "red") -> palette hue.
  const colourHay = `${tags.colour ?? ''}`.toLowerCase();
  for (const [needle, key] of NAME_COLOR_KEYS) {
    if (colourHay.includes(needle)) {
      const color = cfg.lineColors[key];
      if (color != null) return { color, name: tags.name || tags.ref || `Línea ${key}` };
    }
  }
  // 3. explicit colour hex, else palette by index (distinct per line).
  const tagColour = parseColourTag(tags.colour);
  const palette = cfg.palette;
  const color = tagColour != null ? tagColour : palette[index % palette.length];
  return { color, name: tags.name || tags.ref || tags['aerialway'] || `Línea ${index + 1}` };
}

// Aerialway way subtypes we render as cable lines (skip non-cable furniture).
const CABLE_WAY_TYPES = new Set([
  'cable_car', 'gondola', 'mixed_lift', 'chair_lift', 'drag_lift',
  'goods', 'zip_line', 'j-bar', 't-bar', 'platter', 'rope_tow', 'magic_carpet',
]);
// Node aerialway subtypes that are towers/pylons vs stations.
const STATION_NODE_TYPES = new Set(['station']);
const TOWER_NODE_TYPES = new Set(['pylon', 'tower', 'support']);

/**
 * Build the aerialway model from raw Overpass JSON.
 *
 * @param {object} osm        raw Overpass response { elements: [...] }
 * @param {object} projection createProjection(lat,lon) — toLocal/toLatLon
 * @param {object} elevation  network.elevation sampler { elevAt(x,z), flat }
 * @returns {{lines, stations, towers} | null} null when no cable ways exist.
 *
 * lines[i]   = { id, name, color, points2D:[{x,z}], elev:Float32Array,
 *                cumLen:number[], lengthM }
 *   points2D + elev are PARALLEL arrays (elev[k] = cable y at points2D[k]);
 *   the cable rides elevAt + cableHeightM, sampled ~sampleStepM. cumLen is the
 *   prefix-sum arc length for zero-alloc cabin animation.
 * stations[] = { x, y, z, name }   (y = elevAt + small lift)
 * towers[]   = { x, y, z }         (y = elevAt; the mesh extrudes towerHeightM)
 */
export function buildAerialways(osm, projection, elevation) {
  const elements = osm?.elements;
  if (!Array.isArray(elements) || elements.length === 0) return null;

  const cfg = CONFIG.aerialway;
  const cableHeightM = cfg.cableHeightM;
  const stepM = Math.max(1, cfg.sampleStepM);
  const elevAt = elevation && typeof elevation.elevAt === 'function' ? elevation.elevAt : () => 0;

  // Index nodes by id (lat/lon + tags). Cable lines vs station footprints are
  // both ways: cable types -> polylines; aerialway=station ways -> a building
  // footprint we render as a small box at its centroid.
  const nodes = new Map();
  const cableWays = [];
  const stationWays = [];
  for (const el of elements) {
    if (el.type === 'node') {
      nodes.set(el.id, el);
    } else if (el.type === 'way' && Array.isArray(el.nodes) && el.nodes.length >= 2) {
      const aw = el.tags && el.tags.aerialway;
      if (aw && CABLE_WAY_TYPES.has(aw)) cableWays.push(el);
      else if (aw && STATION_NODE_TYPES.has(aw)) stationWays.push(el);
    }
  }
  if (cableWays.length === 0) return null;

  const _p = { x: 0, z: 0 };
  const toLocal = (lat, lon) => {
    projection.toLocal(lat, lon, _p);
    return { x: _p.x, z: _p.z };
  };

  const lines = [];
  for (let w = 0; w < cableWays.length; w++) {
    const way = cableWays[w];
    // Raw polyline in local meters (dedupe consecutive identical points).
    const raw = [];
    for (const ref of way.nodes) {
      const n = nodes.get(ref);
      if (!n || n.lat == null || n.lon == null) continue;
      const q = toLocal(n.lat, n.lon);
      const prev = raw[raw.length - 1];
      if (prev && Math.abs(prev.x - q.x) < 1e-3 && Math.abs(prev.z - q.z) < 1e-3) continue;
      raw.push(q);
    }
    if (raw.length < 2) continue;

    // Resample so no segment exceeds stepM, then lift to the cable height above
    // terrain at each sample. The original (sparse) tower-to-tower vertices are
    // preserved; intermediate samples follow the displaced terrain so the cable
    // visibly clears the hills it spans.
    const points2D = [];
    const elevArr = [];
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1];
      const b = raw[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.hypot(dx, dz);
      const sub = Math.max(1, Math.ceil(segLen / stepM));
      const startJ = i === 1 ? 0 : 1; // avoid duplicating the shared vertex
      for (let j = startJ; j <= sub; j++) {
        const t = j / sub;
        const x = a.x + dx * t;
        const z = a.z + dz * t;
        points2D.push({ x, z });
        elevArr.push(elevAt(x, z) + cableHeightM);
      }
    }
    if (points2D.length < 2) continue;

    const cumLen = cumulativeLengths(points2D);
    const lengthM = cumLen[cumLen.length - 1];
    if (!(lengthM > 0)) continue;

    const style = resolveLineStyle(way.tags || {}, lines.length);
    lines.push({
      id: way.id,
      name: style.name,
      color: style.color,
      points2D,
      elev: Float32Array.from(elevArr),
      cumLen,
      lengthM,
    });
  }

  if (lines.length === 0) return null;

  // Stations + towers from tagged nodes (ground-anchored; the mesh extrudes).
  const stations = [];
  const towers = [];
  for (const n of nodes.values()) {
    const aw = n.tags && n.tags.aerialway;
    if (!aw || n.lat == null || n.lon == null) continue;
    const q = toLocal(n.lat, n.lon);
    const baseY = elevAt(q.x, q.z);
    if (STATION_NODE_TYPES.has(aw)) {
      stations.push({ x: q.x, y: baseY, z: q.z, name: (n.tags && n.tags.name) || '' });
    } else if (TOWER_NODE_TYPES.has(aw)) {
      towers.push({ x: q.x, y: baseY, z: q.z });
    }
  }
  // Station footprints (closed ways tagged aerialway=station) -> centroid box.
  for (const way of stationWays) {
    let sx = 0;
    let sz = 0;
    let cnt = 0;
    for (const ref of way.nodes) {
      const n = nodes.get(ref);
      if (!n || n.lat == null || n.lon == null) continue;
      const q = toLocal(n.lat, n.lon);
      sx += q.x;
      sz += q.z;
      cnt++;
    }
    if (cnt === 0) continue;
    const x = sx / cnt;
    const z = sz / cnt;
    stations.push({ x, y: elevAt(x, z), z, name: (way.tags && way.tags.name) || '' });
  }

  return { lines, stations, towers };
}
