// One-time dev task (D2): fetch the Mi Teleférico aerialway data for the
// default La Paz zone and commit it as public/data/default-aerialway.json so the
// static site shows the teleférico offline. Run from the repo root:
//   node scripts/fetch-default-aerialway.mjs
//
// IMPORTANT: fetched at a WIDE radius (~1500 m, configurable below) — the La Paz
// teleférico lines span kilometers, so the default 600 m road disc would clip
// every line down to a stub. The browser keeps the full network at 600 m for
// roads; the aerialway snapshot intentionally reaches farther so the colored
// cables actually cross the visible scene. The committed raw Overpass JSON is
// parsed at runtime by network/aerialway.js (buildAerialways).
//
// Reuses the exact query + transport the app uses (src/osm/overpass.js imports
// only src/config.js + src/util/math2d.js — all plain ESM, Node 18+ safe). A
// validation pass parses the result with buildAerialways so the script fails
// loudly if the snapshot would yield zero lines.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { fetchAerialwayOsm } from '../src/osm/overpass.js';
import { buildAerialways } from '../src/network/aerialway.js';
import { createProjection } from '../src/geo/projection.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../public/data/default-aerialway.json');

const { lat, lon } = CONFIG.defaultCenter;
// Wide enough to keep whole Mi Teleférico lines around Plaza del Estudiante.
const RADIUS_M = Number(process.env.AERIALWAY_RADIUS_M || 1500);

console.log(`Fetching aerialway (teleférico) for ${lat}, ${lon} (r=${RADIUS_M} m)…`);
const osm = await fetchAerialwayOsm(lat, lon, RADIUS_M);

let ways = 0;
let nodes = 0;
for (const el of osm.elements || []) {
  if (el.type === 'way') ways++;
  else if (el.type === 'node') nodes++;
}
console.log(`Overpass returned ${ways} ways, ${nodes} nodes.`);

// Validate: parse exactly as the app will at runtime.
const projection = createProjection(lat, lon);
const flat = { elevAt: () => 0, flat: true };
const model = buildAerialways(osm, projection, flat);
if (!model || !model.lines.length) {
  console.error(
    'No aerialway lines parsed from the response — NOT writing snapshot.\n' +
      'Try a wider radius: AERIALWAY_RADIUS_M=2000 node scripts/fetch-default-aerialway.mjs'
  );
  process.exit(1);
}
console.log(
  `Parsed ${model.lines.length} line(s): ` +
    model.lines.map((l) => `${l.name} (#${l.color.toString(16)}, ${Math.round(l.lengthM)} m)`).join(', ')
);
console.log(`Stations: ${model.stations.length}, towers: ${model.towers.length}`);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(osm));
console.log(`Wrote ${outPath} (${(JSON.stringify(osm).length / 1024).toFixed(0)} KB)`);
