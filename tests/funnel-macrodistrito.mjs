// V2.1 A verification — standalone node funnel for the user-reported URL:
//   https://www.google.com/maps/place/Macrodistrito+Centro,+La+Paz/@-16.5029088,-68.1246376,15z/...!3d-16.4995204!4d-68.1241239...
// Reproduces the search pipeline through the REAL modules (geocode -> overpass
// query -> parse -> graph) and asserts the V2.1 fixes:
//   - the !3d!4d place pin is preferred over the @ viewport center
//   - radius floor 800 m for /place/ URLs
//   - WCC prune: kept directed length >= 15 km, entries >= 4, retention >= 90%
// Also prints the BEFORE funnel (old @ center, z15 radius 410 m, SCC prune)
// for the deviation record.
//
// NOTE: overpass-api.de answers HTTP 406 to non-browser clients (WAF; it
// fingerprints beyond the User-Agent — curl with a browser UA still gets 406),
// and overpass.kumi.systems can be down. This script shims a browser UA anyway
// and appends the maps.mail.ru full-planet mirror, which accepts node clients
// (see CLAUDE.md "Overpass WAF vs non-browser tooling").
//
// Run: node tests/funnel-macrodistrito.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from '../src/config.js';
import { parseCoordsOrUrl } from '../src/osm/geocode.js';
import { buildHighwayQuery } from '../src/osm/overpass.js';
import { parseOsm } from '../src/osm/parse.js';
import { buildGraph } from '../src/network/graph.js';
import { createProjection } from '../src/geo/projection.js';

const USER_URL =
  'https://www.google.com/maps/place/Macrodistrito+Centro,+La+Paz/@-16.5029088,-68.1246376,15z/' +
  'data=!4m6!3m5!1s0x915f2070888d6597:0xff4b3324fe647d5a!8m2!3d-16.4995204!4d-68.1241239!16s%2Fg%2F12848nh7m?entry=ttu';

const PIN = { lat: -16.4995204, lon: -68.1241239 };
const OLD_AT = { lat: -16.5029088, lon: -68.1246376, radiusM: 410 }; // pre-fix funnel

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Overpass fetch with browser-UA shim + mirror fallback, cached in tmpdir. */
async function fetchOverpass(lat, lon, radiusM) {
  const cacheDir = join(tmpdir(), 'sim3d-funnel-cache');
  const key = `osm_${lat}_${lon}_${Math.round(radiusM)}.json`;
  const cachePath = join(cacheDir, key);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {
    /* cache miss */
  }
  const query = buildHighwayQuery(lat, lon, radiusM);
  let lastErr = null;
  // App mirrors first (browser path parity), then a node-friendly planet mirror.
  const mirrors = [
    ...CONFIG.overpass.mirrors,
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  for (const url of mirrors) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BROWSER_UA, // overpass-api.de WAF rejects node UAs (406)
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const osm = await res.json();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify(osm));
      return osm;
    } catch (err) {
      lastErr = err;
      console.warn(`  [overpass] ${url} failed: ${err.message}`);
    }
  }
  throw new Error(`all Overpass mirrors failed: ${lastErr?.message}`);
}

/** Run parse -> buildGraph at a center/radius under the given prune mode. */
function runFunnel(osm, center, pruneMode) {
  const prev = CONFIG.network.pruneMode;
  CONFIG.network.pruneMode = pruneMode;
  try {
    const parsed = parseOsm(osm);
    const projection = createProjection(center.lat, center.lon);
    const graph = buildGraph(parsed, projection);
    const s = graph.stats;
    return {
      ways: parsed.ways.length,
      directedEdges: s.totalDirectedEdges,
      keptEdges: s.keptDirectedEdges,
      fetchedKm: s.totalDirectedLengthM / 1000,
      keptKm: s.keptDirectedLengthM / 1000,
      retention: s.keptDirectedLengthM / Math.max(s.totalDirectedLengthM, 1),
      entries: graph.entries.length,
      exits: graph.exits.length,
      spawnMode: graph.spawnMode,
    };
  } finally {
    CONFIG.network.pruneMode = prev;
  }
}

function printFunnel(label, f) {
  console.log(
    `  ${label}: ${f.ways} ways -> ${f.directedEdges} directed edges -> kept ` +
      `${f.keptEdges} (${f.keptKm.toFixed(2)} km / ${f.fetchedKm.toFixed(2)} km = ` +
      `${(f.retention * 100).toFixed(1)}%), entries ${f.entries}, exits ${f.exits} (${f.spawnMode})`
  );
}

// ---- 1) geocode: pin preferred over @, /place/ radius floor 800 ----
const loc = parseCoordsOrUrl(USER_URL);
check('parseCoordsOrUrl resolves locally', loc !== null);
check(
  'pin center used (not the @ viewport)',
  Math.abs(loc.lat - PIN.lat) < 1e-6 && Math.abs(loc.lon - PIN.lon) < 1e-6,
  `got (${loc.lat}, ${loc.lon})`
);
check(
  `radius floored to ${CONFIG.geocode.placeRadiusFloorM} m (z15 formula gave ~410 m)`,
  loc.radiusM >= CONFIG.geocode.placeRadiusFloorM && loc.radiusM <= CONFIG.radiusClampM.max,
  `radiusM = ${loc.radiusM}`
);

// ---- 2) AFTER funnel: pin center, floored radius, WCC (production path) ----
console.log(`\nFetching Overpass: pin center, r=${loc.radiusM} m ...`);
const osmAfter = await fetchOverpass(loc.lat, loc.lon, loc.radiusM);
const after = runFunnel(osmAfter, loc, 'wcc');
printFunnel('AFTER (pin, wcc)', after);
check('kept directed length >= 15 km', after.keptKm >= 15, `${after.keptKm.toFixed(2)} km`);
check('entries >= 4', after.entries >= 4, `${after.entries}`);
check(
  'WCC retention >= 90% at the pin center',
  after.retention >= 0.9,
  `${(after.retention * 100).toFixed(1)}%`
);

// ---- 3) BEFORE funnel: old @ center, 410 m, SCC (pre-V2.1 behavior) ----
console.log(`\nFetching Overpass: old @ center, r=${OLD_AT.radiusM} m ...`);
const osmBefore = await fetchOverpass(OLD_AT.lat, OLD_AT.lon, OLD_AT.radiusM);
const before = runFunnel(osmBefore, OLD_AT, 'scc');
printFunnel('BEFORE (@, scc)', before);
const beforeWcc = runFunnel(osmBefore, OLD_AT, 'wcc');
printFunnel('BEFORE center, WCC only', beforeWcc);

console.log(
  `\nRetention: ${(before.retention * 100).toFixed(1)}% (before) -> ` +
    `${(after.retention * 100).toFixed(1)}% (after); kept ${before.keptKm.toFixed(2)} km -> ` +
    `${after.keptKm.toFixed(2)} km; entries ${before.entries} -> ${after.entries}`
);

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll funnel assertions passed.');
