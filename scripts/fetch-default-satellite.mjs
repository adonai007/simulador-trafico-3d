// One-time dev task (D1): fetch + stitch Esri World Imagery for the default
// La Paz zone and commit it as public/data/default-satellite.{jpg,json} so the
// static site can drape the satellite view offline. Run from the repo root:
//   node scripts/fetch-default-satellite.mjs   (npm run fetch:satellite)
//
// Build-time ONLY. Uses @napi-rs/canvas (a devDependency, NOT shipped — the
// Render build just reads the committed JPG). The browser path (loadSatellite)
// stitches live for SEARCHED zones; the default zone ships this snapshot.
//
// Tile cover is computed over the SAME terrain plane rect the browser uses
// (default-network.json bbox + 35% margin per side), so the committed geoBounds
// line up exactly with buildTerrainUVs at runtime. Esri tile order is {z}/{y}/{x}.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { CONFIG } from '../src/config.js';
import { createProjection } from '../src/geo/projection.js';
import { computeTileCover } from '../src/render/satellite.js';

const here = dirname(fileURLToPath(import.meta.url));
const jpgPath = resolve(here, '../public/data/default-satellite.jpg');
const jsonPath = resolve(here, '../public/data/default-satellite.json');
const networkPath = resolve(here, '../public/data/default-network.json');

const { lat, lon } = CONFIG.defaultCenter;
const projection = createProjection(lat, lon);

// Recreate the terrain plane rect from the bundled network bbox the same way
// terrainMesh.js / satellite.planeRectForNetwork does (35% margin per side).
function planeRectFromBbox(bbox) {
  const spanX = Math.max(bbox.maxX - bbox.minX, 200);
  const spanZ = Math.max(bbox.maxZ - bbox.minZ, 200);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cz = (bbox.minZ + bbox.maxZ) / 2;
  const width = spanX * 1.7;
  const depth = spanZ * 1.7;
  return {
    minX: cx - width / 2,
    maxX: cx + width / 2,
    minZ: cz - depth / 2,
    maxZ: cz + depth / 2,
  };
}

// Derive the bbox from the bundled network nodes (same projection the app uses).
const osm = JSON.parse(await readFile(networkPath, 'utf8'));
let minX = Infinity;
let maxX = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
const out = { x: 0, z: 0 };
for (const el of osm.elements || []) {
  if (el.type !== 'node' || typeof el.lat !== 'number') continue;
  projection.toLocal(el.lat, el.lon, out);
  if (out.x < minX) minX = out.x;
  if (out.x > maxX) maxX = out.x;
  if (out.z < minZ) minZ = out.z;
  if (out.z > maxZ) maxZ = out.z;
}
if (!Number.isFinite(minX)) {
  // Fallback to a radius disc around center.
  const r = CONFIG.defaultRadiusM;
  minX = -r;
  maxX = r;
  minZ = -r;
  maxZ = r;
}
const planeRect = planeRectFromBbox({ minX, maxX, minZ, maxZ });

const cover = computeTileCover(planeRect, projection, CONFIG.satellite);
const cols = cover.x1 - cover.x0 + 1;
const rows = cover.y1 - cover.y0 + 1;
console.log(
  `Tile cover z=${cover.z}  x:${cover.x0}..${cover.x1}  y:${cover.y0}..${cover.y1}  (${cols}x${rows} = ${cols * rows} tiles)`
);

const canvas = createCanvas(cols * 256, rows * 256);
const ctx = canvas.getContext('2d');

const urlTemplate = CONFIG.satellite.url;
let failed = 0;
let done = 0;
const total = cols * rows;

// Fetch with a small concurrency pool.
const cells = [];
for (let ry = 0; ry < rows; ry++) {
  for (let cx = 0; cx < cols; cx++) {
    cells.push({ cx, ry, tx: cover.x0 + cx, ty: cover.y0 + ry });
  }
}

async function fetchTile(cell) {
  const url = urlTemplate
    .replace('{z}', cover.z)
    .replace('{x}', cell.tx)
    .replace('{y}', cell.ty);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'sim-trafico-3d/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    ctx.drawImage(img, cell.cx * 256, cell.ry * 256);
  } catch (err) {
    failed++;
    console.warn(`  tile ${cover.z}/${cell.ty}/${cell.tx} falló: ${err.message}`);
  } finally {
    done++;
    if (done % 8 === 0 || done === total) console.log(`  ${done}/${total} tiles`);
  }
}

const CONCURRENCY = CONFIG.satellite.concurrency;
let idx = 0;
async function worker() {
  while (idx < cells.length) {
    await fetchTile(cells[idx++]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (failed / total > 0.1) {
  console.error(`Too many tile failures (${failed}/${total}) — NOT writing snapshot.`);
  process.exit(1);
}

const jpg = await canvas.encode('jpeg', 80);
await mkdir(dirname(jpgPath), { recursive: true });
await writeFile(jpgPath, jpg);

const meta = {
  z: cover.z,
  x0: cover.x0,
  x1: cover.x1,
  y0: cover.y0,
  y1: cover.y1,
  geoBounds: cover.geoBounds,
  center: { lat, lon },
  attribution: CONFIG.satellite.attribution,
};
await writeFile(jsonPath, JSON.stringify(meta));

console.log(`Wrote ${jpgPath} (${(jpg.length / 1024).toFixed(0)} KB)`);
console.log(`Wrote ${jsonPath}`);
console.log(`geoBounds: z=${cover.z} xt ${meta.geoBounds.xtMin}..${meta.geoBounds.xtMax} yt ${meta.geoBounds.ytMin}..${meta.geoBounds.ytMax}`);
