// One-time dev task (F1): fetch the Open-Meteo elevation grid for the default
// La Paz zone and commit it as public/data/default-elevation.json so the
// static site works offline. Run from the repo root:
//   node scripts/fetch-default-elevation.mjs
// Reuses the exact grid spec + fetch logic the app uses at runtime
// (src/geo/elevation.js imports only src/config.js — both plain ESM, Node-safe).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { fetchElevationGrid } from '../src/geo/elevation.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../public/data/default-elevation.json');

const { lat, lon } = CONFIG.defaultCenter;
const radiusM = CONFIG.defaultRadiusM;

console.log(`Fetching elevation grid for ${lat}, ${lon} (r=${radiusM} m)…`);
// Serial + paced: the one-time script has no hurry and Open-Meteo
// rate-limits bursts (the app at runtime uses concurrency 4 + retries).
const grid = await fetchElevationGrid(lat, lon, radiusM, { concurrency: 1, delayMs: 1500 });

let min = Infinity;
let max = -Infinity;
for (const v of grid.values) {
  if (v < min) min = v;
  if (v > max) max = v;
}
console.log(
  `Grid ${grid.cols}x${grid.rows} (${grid.values.length} pts), ` +
    `elevation ${min}–${max} m (relief ${(max - min).toFixed(0)} m)`
);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(grid));
console.log(`Wrote ${outPath}`);
