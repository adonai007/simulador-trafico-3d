// Vista satélite (D1) — Esri World Imagery draped over the displaced terrain.
//
// Pure tile/UV math + an offscreen-canvas tile stitcher. NO scene coupling: the
// terrain mesh consumes the returned {texture, geoBounds, dispose} via
// terrainMesh.setSatellite(). The default La Paz zone ships a bundled JPG+JSON
// snapshot (loadDefaultSatellite); searched zones fetch live (loadSatellite)
// with a graceful null on >10% tile failure.
//
// Web-Mercator slippy tiles, Esri order {z}/{y}/{x}:
//   n = 2^z
//   xt = (lon+180)/360 * n
//   yt = (1 - asinh(tan(lat·π/180))/π) / 2 * n
//   inverse: lon = xt/n·360 - 180 ; lat = atan(sinh(π(1-2·yt/n)))·180/π
//
// geoBounds is the WHOLE-TILE rectangle at the chosen zoom in fractional tile
// units {z, xtMin, xtMax, ytMin, ytMax}; buildTerrainUVs maps each terrain
// vertex into [0,1]² of the stitched canvas via per-vertex Mercator (NOT a
// linear bbox stretch — the margin ring would smear).

import * as THREE from 'three';
import { CONFIG } from '../config.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** lon/lat -> fractional tile coords at zoom z (Web-Mercator). */
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const xt = ((lon + 180) / 360) * n;
  const yt = ((1 - Math.asinh(Math.tan(lat * DEG2RAD)) / Math.PI) / 2) * n;
  return { xt, yt };
}

/**
 * Corners of the TERRAIN PLANE rect (bbox + margin — passed in as planeRect in
 * local meters) -> lat/lon -> tile range at a zoom picked from maxZoom down
 * until tileCount <= maxTiles (or minZoom reached). Returns the integer tile
 * window + the whole-tile geoBounds at that zoom.
 */
export function computeTileCover(planeRect, projection, opts = {}) {
  const maxZoom = opts.maxZoom ?? CONFIG.satellite.maxZoom;
  const minZoom = opts.minZoom ?? CONFIG.satellite.minZoom;
  const maxTiles = opts.maxTiles ?? CONFIG.satellite.maxTiles;

  // Four corners of the plane rect (local meters) -> lat/lon.
  const corners = [
    projection.toLatLon(planeRect.minX, planeRect.minZ),
    projection.toLatLon(planeRect.maxX, planeRect.minZ),
    projection.toLatLon(planeRect.minX, planeRect.maxZ),
    projection.toLatLon(planeRect.maxX, planeRect.maxZ),
  ];

  for (let z = maxZoom; z >= minZoom; z--) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of corners) {
      const { xt, yt } = lonLatToTile(c.lon, c.lat, z);
      x0 = Math.min(x0, xt);
      x1 = Math.max(x1, xt);
      y0 = Math.min(y0, yt);
      y1 = Math.max(y1, yt);
    }
    const tx0 = Math.floor(x0);
    const tx1 = Math.floor(x1);
    const ty0 = Math.floor(y0);
    const ty1 = Math.floor(y1);
    const tileCount = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    if (tileCount <= maxTiles || z === minZoom) {
      return {
        z,
        x0: tx0,
        x1: tx1,
        y0: ty0,
        y1: ty1,
        // Whole-tile rect in fractional tile units (the stitched canvas spans
        // exactly these tiles edge-to-edge).
        geoBounds: {
          z,
          xtMin: tx0,
          xtMax: tx1 + 1,
          ytMin: ty0,
          ytMax: ty1 + 1,
        },
      };
    }
  }
  // Unreachable (loop returns at minZoom), but keep the contract total.
  return null;
}

/** Load one tile as an Image with crossOrigin + timeout. Resolves to the
 * Image or null on error/timeout (caller tallies the failure rate). */
function loadTile(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** Run async jobs with a fixed concurrency, preserving result order. */
async function pooled(jobs, concurrency) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, jobs.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Stitch an Esri tile window into an offscreen canvas -> CanvasTexture.
 * `cover` is computeTileCover's output. Returns {texture, geoBounds,
 * attribution, dispose} or null if too many tiles failed (>10%).
 */
async function stitchCover(cover, opts) {
  const urlTemplate = opts.url ?? CONFIG.satellite.url;
  const concurrency = opts.concurrency ?? CONFIG.satellite.concurrency;
  const tileTimeoutMs = opts.tileTimeoutMs ?? CONFIG.satellite.tileTimeoutMs;
  const maxCanvasPx = opts.maxCanvasPx ?? CONFIG.satellite.maxCanvasPx;

  const cols = cover.x1 - cover.x0 + 1;
  const rows = cover.y1 - cover.y0 + 1;
  const wPx = cols * 256;
  const hPx = rows * 256;
  if (wPx > maxCanvasPx || hPx > maxCanvasPx) {
    // Caller should have dropped zoom; refuse rather than allocate a giant canvas.
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d');

  // Build the fetch jobs in row-major order.
  const cells = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      cells.push({ cx, ry, tx: cover.x0 + cx, ty: cover.y0 + ry });
    }
  }
  const jobs = cells.map((cell) => () => {
    const url = urlTemplate
      .replace('{z}', cover.z)
      .replace('{x}', cell.tx)
      .replace('{y}', cell.ty);
    return loadTile(url, tileTimeoutMs);
  });
  const images = await pooled(jobs, concurrency);

  let failed = 0;
  for (let i = 0; i < cells.length; i++) {
    const img = images[i];
    if (!img) {
      failed++;
      continue;
    }
    ctx.drawImage(img, cells[i].cx * 256, cells[i].ry * 256);
  }

  if (failed / cells.length > 0.1) return null; // too many holes -> no drape

  return finalizeTexture(canvas, cover.geoBounds, opts);
}

/** Wrap a stitched canvas (or loaded Image) into a CanvasTexture handle. */
function finalizeTexture(source, geoBounds, opts) {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  if (opts.anisotropy) texture.anisotropy = opts.anisotropy;
  texture.needsUpdate = true;
  return {
    texture,
    geoBounds,
    attribution: CONFIG.satellite.attribution,
    dispose() {
      texture.dispose();
    },
  };
}

/** terrain plane rect from the network bbox (mirrors terrainMesh's margin). */
export function planeRectForNetwork(network) {
  const bbox = network.bbox;
  const spanX = Math.max(bbox.maxX - bbox.minX, 200);
  const spanZ = Math.max(bbox.maxZ - bbox.minZ, 200);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cz = (bbox.minZ + bbox.maxZ) / 2;
  const width = spanX * 1.7; // 35% margin per side, matches terrainMesh.js
  const depth = spanZ * 1.7;
  return {
    minX: cx - width / 2,
    maxX: cx + width / 2,
    minZ: cz - depth / 2,
    maxZ: cz + depth / 2,
  };
}

/**
 * Live satellite for a searched zone. Fetches + stitches Esri tiles covering the
 * terrain plane. Resolves to a texture handle or null (no imagery -> caller
 * toasts «Sin imágenes satelitales para esta zona»).
 */
export async function loadSatellite(network, opts = {}) {
  const merged = { ...CONFIG.satellite, ...opts };
  const planeRect = planeRectForNetwork(network);
  let cover = computeTileCover(planeRect, network.projection, merged);
  if (!cover) return null;

  // Drop zoom while the stitched canvas would exceed maxCanvasPx.
  const maxCanvasPx = merged.maxCanvasPx ?? CONFIG.satellite.maxCanvasPx;
  while (
    (cover.x1 - cover.x0 + 1) * 256 > maxCanvasPx ||
    (cover.y1 - cover.y0 + 1) * 256 > maxCanvasPx
  ) {
    if (cover.z <= (merged.minZoom ?? CONFIG.satellite.minZoom)) break;
    cover = computeTileCover(planeRect, network.projection, { ...merged, maxZoom: cover.z - 1 });
    if (!cover) return null;
  }

  try {
    return await stitchCover(cover, merged);
  } catch (err) {
    console.warn('[satélite] stitch falló:', err);
    return null;
  }
}

/**
 * Bundled default-zone satellite: load the committed JPG + JSON. The JSON
 * carries the geoBounds {z,x0,x1,y0,y1,geoBounds,center,attribution} produced by
 * scripts/fetch-default-satellite.mjs. Resolves to a texture handle or null.
 */
export async function loadDefaultSatellite(opts = {}) {
  try {
    const metaRes = await fetch('/data/default-satellite.json');
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const geoBounds = meta.geoBounds || {
      z: meta.z,
      xtMin: meta.x0,
      xtMax: meta.x1 + 1,
      ytMin: meta.y0,
      ytMax: meta.y1 + 1,
    };
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = '/data/default-satellite.jpg';
    });
    if (!img) return null;
    return finalizeTexture(img, geoBounds, { ...CONFIG.satellite, ...opts });
  } catch (err) {
    console.warn('[satélite] snapshot por defecto no disponible:', err);
    return null;
  }
}

/**
 * Per-vertex UVs for the terrain geometry: each (x,z) -> lat/lon -> fractional
 * Mercator tile coords at geoBounds.z -> u,v in the stitched canvas [0,1].
 * Stays in TILE UNITS (the ×256 canvas scale cancels). v is flipped because the
 * canvas/texture origin is top-left while THREE UV origin is bottom-left.
 */
export function buildTerrainUVs(geom, network, geoBounds) {
  const pos = geom.attributes.position;
  const count = pos.count;
  const projection = network.projection;
  const z = geoBounds.z;
  const n = 2 ** z;
  const du = geoBounds.xtMax - geoBounds.xtMin;
  const dv = geoBounds.ytMax - geoBounds.ytMin;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const zc = pos.getZ(i);
    const ll = projection.toLatLon(x, zc);
    const xt = ((ll.lon + 180) / 360) * n;
    const yt = ((1 - Math.asinh(Math.tan(ll.lat * DEG2RAD)) / Math.PI) / 2) * n;
    const u = (xt - geoBounds.xtMin) / du;
    const vPixel = (yt - geoBounds.ytMin) / dv;
    uv[i * 2] = u;
    uv[i * 2 + 1] = 1 - vPixel; // flip: canvas top-left vs THREE bottom-left
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.attributes.uv.needsUpdate = true;
}

export { RAD2DEG, lonLatToTile };
