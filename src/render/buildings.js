// Buildings — real La Paz OSM footprints extruded into stylized low-poly prisms.
// Spec §3.3 (deviation: real OSM footprints replace the procedural grid boxes;
// see DESIGN-SPEC.md Deviations).
//
// Coordinate convention (src/geo/projection.js): x = east, z = -north, y = up.
// ExtrudeGeometry builds the cap in shape-XY and extrudes along +Z, so we map
// shape (x, y) = (east, north) and apply rotateX(-PI/2), which sends
// (px, py, pz) -> (px, pz, -py): world x = east, y = extrusion height,
// z = -north. ExtrudeGeometry normalizes ring winding internally
// (ShapeUtils.isClockWise), so either OSM winding is safe.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { createProjection } from '../geo/projection.js';
import { createRng } from '../util/rng.js';
import { fetchBuildingsOsm } from '../osm/overpass.js';

const LEVEL_HEIGHT_M = 3.2;
const HEIGHT_MIN_M = 5;
const HEIGHT_MAX_M = 40;
const MIN_AREA_M2 = 4;        // drop degenerate slivers
const MIN_FOOTPRINTS = 10;    // below this the snapshot is considered unusable
const MAX_FOOTPRINTS = 2500;  // dense downtown cap (keeps merge + draw cheap)

/** Closed OSM building ways -> [{ points: [{x, y}…] (shape space: x=east, y=north), tags }] */
function parseFootprints(osm, proj) {
  if (!osm || !Array.isArray(osm.elements)) return [];
  const nodes = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
  }
  const footprints = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !Array.isArray(el.nodes) || el.nodes.length < 4) continue;
    if (el.nodes[0] !== el.nodes[el.nodes.length - 1]) continue; // open way
    const pts = [];
    let ok = true;
    for (let i = 0; i < el.nodes.length - 1; i++) { // skip duplicate closing ref
      const n = nodes.get(el.nodes[i]);
      if (!n) { ok = false; break; }
      const p = proj.toLocal(n.lat, n.lon);
      pts.push({ x: p.x, y: -p.z }); // shape space: (east, north)
    }
    if (!ok || pts.length < 3) continue;
    footprints.push({ points: pts, tags: el.tags || {} });
  }
  return footprints;
}

/** Shoelace area (m²) in shape space — degenerate filter. */
function ringArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(a) / 2;
}

/** building:levels × 3.2 m when tagged, else seeded random 2–6 levels; clamp 5–40 m. */
function buildingHeight(tags, rng) {
  const levels = parseFloat(tags['building:levels']);
  const h = Number.isFinite(levels) && levels > 0
    ? levels * LEVEL_HEIGHT_M
    : rng.int(2, 6) * LEVEL_HEIGHT_M;
  return Math.min(HEIGHT_MAX_M, Math.max(HEIGHT_MIN_M, h));
}

/** One extruded prism with per-vertex color. Throws on bad input (caller catches). */
function extrudeFootprint(pts, height, color, baseY) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, { depth: height, steps: 1, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  // Base sunk to the lowest terrain corner − 0.5 m (F1) so prisms never float
  // on slopes (flat sampler: baseY = −0.5, harmlessly buried).
  geom.translate(0, baseY, 0);
  geom.deleteAttribute('uv'); // unused; keeps merge attributes consistent and small

  const count = geom.getAttribute('position').count;
  if (count === 0) throw new Error('empty extrusion');
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

/**
 * Extrude real building footprints, merge into ONE mesh (single draw call),
 * add to scene. Resolves to { mesh, count, dispose }.
 *
 * Without opts (default La Paz zone): loads the bundled snapshot
 * /data/default-buildings.json. With opts {lat, lon, radius}: fetches live
 * footprints from Overpass for that area; on failure it falls back to the
 * bundled snapshot ONLY when the area is the default zone (foreign footprints
 * would be wrong anywhere else) — otherwise buildings are skipped gracefully.
 * On missing/insufficient data resolves to { mesh: null, count: 0, dispose }.
 *
 * `sampler` (F1): elevation sampler — each prism's base is translated to
 * min(elevAt over footprint vertices) − 0.5 m. Defaults to flat (y = −0.5).
 */
export async function addBuildings(scene, opts, sampler) {
  const noop = { mesh: null, count: 0, dispose() {} };
  const elevAt = sampler && !sampler.flat ? sampler.elevAt : null;

  const center =
    opts && opts.lat != null ? { lat: opts.lat, lon: opts.lon } : CONFIG.defaultCenter;
  const dLat = Math.abs(center.lat - CONFIG.defaultCenter.lat);
  const dLon = Math.abs(center.lon - CONFIG.defaultCenter.lon);
  const isDefaultZone = dLat < 0.01 && dLon < 0.01; // ~1 km

  let osm = null;
  if (opts && opts.lat != null) {
    try {
      osm = await fetchBuildingsOsm(opts.lat, opts.lon, opts.radius);
    } catch {
      osm = null; // offline / mirrors down — snapshot fallback below if default zone
    }
  }
  if (!osm && (!opts || isDefaultZone)) {
    try {
      const res = await fetch('/data/default-buildings.json');
      if (res.ok) osm = await res.json();
    } catch {
      /* offline / missing snapshot — handled below */
    }
  }

  const proj = createProjection(center.lat, center.lon);
  let footprints = parseFootprints(osm, proj);
  if (footprints.length > MAX_FOOTPRINTS) footprints = footprints.slice(0, MAX_FOOTPRINTS);
  if (footprints.length < MIN_FOOTPRINTS) {
    // Procedural §3.3 fallback needs the road network (not importable here
    // without coupling render to sim bootstrap) — skip gracefully instead.
    console.info(
      `[buildings] datos de edificios insuficientes (${footprints.length} huellas) — se omiten edificios.`
    );
    return noop;
  }

  const rng = createRng(CONFIG.rngSeed);
  const palette = CONFIG.render.buildingPalette.map((hex) => new THREE.Color(hex));
  const geoms = [];
  for (const fp of footprints) {
    try {
      if (ringArea(fp.points) < MIN_AREA_M2) continue;
      const height = buildingHeight(fp.tags, rng);
      // Lowest terrain corner under the footprint (shape y = north = -z).
      let minElev = 0;
      if (elevAt) {
        minElev = Infinity;
        for (const p of fp.points) {
          const e = elevAt(p.x, -p.y);
          if (e < minElev) minElev = e;
        }
      }
      geoms.push(extrudeFootprint(fp.points, height, rng.pick(palette), minElev - 0.5));
    } catch {
      /* degenerate / self-intersecting footprint — drop silently */
    }
  }
  if (geoms.length === 0) {
    console.info('[buildings] ninguna huella válida — se omiten edificios.');
    return noop;
  }

  const merged = BufferGeometryUtils.mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) {
    console.info('[buildings] fallo al fusionar geometría — se omiten edificios.');
    return noop;
  }

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false; // static geometry in world coords
  scene.add(mesh);

  console.info(`[buildings] ${geoms.length} edificios renderizados (1 draw call)`);
  return {
    mesh,
    count: geoms.length,
    dispose() {
      scene.remove(mesh);
      merged.dispose();
      material.dispose();
    },
  };
}
