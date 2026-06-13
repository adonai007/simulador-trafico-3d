// Standalone production verification for v2.1 deploy (no test runner, no MCP).
// Checks: page loads, zero console/page errors, __SIM__.ready,
// streetNames.count > 10, and the user-reported Google Maps /place/ URL
// search loads a dense network (vehicleCount > 30) in production.
// Usage: node scripts/verify-v21-production.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'https://simulador-trafico-3d.onrender.com';
const SHOT = 'docs/screenshots/v21-production.png';
const USER_URL =
  'https://www.google.com/maps/place/Macrodistrito+Centro,+La+Paz/@-16.5029088,-68.1246376,15z/' +
  'data=!4m6!3m5!1s0x915f2070888d6597:0xff4b3324fe647d5a!8m2!3d-16.4995204!4d-68.1241239!16s%2Fg%2F12848nh7m?entry=ttu';
const PIN = { lat: -16.4995204, lon: -68.1241239 };

const results = {
  url: URL,
  bundle: null,
  pageLoaded: false,
  consoleErrors: [],
  pageErrors: [],
  simReady: false,
  streetNamesInitial: null,
  streetNamesOk: false,
  search: {
    url: USER_URL,
    rebuilt: false,
    networkCenter: null,
    centerIsPin: false,
    vehicleCount: 0,
    vehicleCountOk: false,
    streetNamesAfter: null,
    keptKm: null,
    entries: null,
  },
  screenshot: null,
  pass: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const loc = msg.location();
    results.consoleErrors.push(msg.text() + (loc && loc.url ? ` [${loc.url}]` : ''));
  }
});
page.on('pageerror', (err) => results.pageErrors.push(String(err)));

try {
  // ---- 1) page loads + bundle freshness ----
  const resp = await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
  results.pageLoaded = !!resp && resp.ok();
  results.bundle = await page.evaluate(() => {
    const s = document.querySelector('script[src*="assets/index-"]');
    return s ? s.getAttribute('src') : null;
  });

  // ---- 2) sim ready (default La Paz network builds asynchronously) ----
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 90_000,
  });
  results.simReady = true;

  // ---- 3) street names rendered (V2.1 B) ----
  results.streetNamesInitial = await page.evaluate(() => {
    const sn = window.__SIM__.streetNames;
    return sn ? { count: sn.count, sample: sn.names.slice(0, 8) } : null;
  });
  results.streetNamesOk =
    !!results.streetNamesInitial && results.streetNamesInitial.count > 10;

  // ---- 4) search the user-reported /place/ URL (V2.1 A) ----
  await page.fill('#search-input', USER_URL);
  await page.click('#search-btn');
  // Rebuild done when the network center moves to the !3d!4d place pin.
  await page.waitForFunction(
    (pin) => {
      const c = window.__SIM__.networkCenter;
      return c && Math.abs(c.lat - pin.lat) < 1e-4 && Math.abs(c.lon - pin.lon) < 1e-4;
    },
    PIN,
    { timeout: 180_000 }
  );
  results.search.rebuilt = true;
  results.search.networkCenter = await page.evaluate(() => window.__SIM__.networkCenter);
  results.search.centerIsPin = true;
  results.search.keptKm = await page.evaluate(() => {
    const n = window.__SIM__.network;
    return n && n.stats ? +(n.stats.keptDirectedLengthM / 1000).toFixed(2) : null;
  });
  results.search.entries = await page.evaluate(() => {
    const n = window.__SIM__.network;
    return n && n.entries ? n.entries.length : null;
  });

  // ---- 5) dense network populates: vehicleCount > 30 ----
  try {
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 30, null, {
      timeout: 120_000,
    });
  } catch {
    // Fallback: accelerate the sim to compress spawn time, then restore.
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 30, null, {
      timeout: 90_000,
    });
    await page.evaluate(() => window.__SIM__.setSimSpeed(1));
  }
  results.search.vehicleCount = await page.evaluate(() => window.__SIM__.vehicleCount);
  results.search.vehicleCountOk = results.search.vehicleCount > 30;

  results.search.streetNamesAfter = await page.evaluate(() => {
    const sn = window.__SIM__.streetNames;
    return sn ? { count: sn.count, sample: sn.names.slice(0, 8) } : null;
  });

  // ---- 6) screenshot of the dense searched network ----
  await page.waitForTimeout(3_000); // let vehicles + labels settle visually
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: false });
  results.screenshot = SHOT;

  results.pass =
    results.pageLoaded &&
    results.consoleErrors.length === 0 &&
    results.pageErrors.length === 0 &&
    results.simReady &&
    results.streetNamesOk &&
    results.search.rebuilt &&
    results.search.vehicleCountOk;
} catch (err) {
  results.error = String(err);
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
