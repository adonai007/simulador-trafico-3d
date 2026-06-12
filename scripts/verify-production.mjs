// Standalone production verification for v2 deploy (no test runner, no MCP).
// Usage: node scripts/verify-production.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'https://simulador-trafico-3d.onrender.com';
const SHOT = 'docs/screenshots/v2-production.png';

const results = {
  url: URL,
  pageLoaded: false,
  consoleErrors: [],
  pageErrors: [],
  simReady: false,
  elevation: null,
  elevationRange: null,
  elevationRangeOk: false,
  vehiclesMoving: false,
  vehicleEvidence: null,
  bundle: null,
  screenshot: null,
  pass: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') results.consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => results.pageErrors.push(String(err)));

try {
  const resp = await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
  results.pageLoaded = !!resp && resp.ok();

  // Which bundle is actually being served (deploy freshness evidence).
  results.bundle = await page.evaluate(() => {
    const s = document.querySelector('script[src*="assets/index-"]');
    return s ? s.getAttribute('src') : null;
  });

  // Sim builds the network asynchronously; give it up to 90 s.
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 90_000,
  });

  // Observe for 10 s with the app running, accumulating console errors.
  await page.waitForTimeout(10_000);

  results.simReady = await page.evaluate(() => window.__SIM__.ready === true);
  results.elevation = await page.evaluate(() => window.__SIM__.elevation);
  if (results.elevation) {
    results.elevationRange = results.elevation.max - results.elevation.min;
    results.elevationRangeOk = results.elevationRange > 30;
  }

  // Vehicles moving: same vehicle advances along its lane between two samples.
  results.vehicleEvidence = await page.evaluate(async () => {
    const sim = window.__SIM__.sim;
    const moving = sim.vehicles.find((x) => x.v > 1);
    if (!moving) return { count: sim.vehicles.length, moved: false, note: 'no vehicle with v>1' };
    const id = moving.id;
    const s0 = moving.s;
    const v0 = moving.v;
    await new Promise((r) => setTimeout(r, 3000));
    const later = window.__SIM__.sim.vehicles.find((x) => x.id === id);
    return {
      count: window.__SIM__.sim.vehicles.length,
      id,
      v0,
      s0,
      s1: later ? later.s : null,
      moved: later ? later.s !== s0 : true, // vehicle despawned => it traversed the network
    };
  });
  results.vehiclesMoving = !!results.vehicleEvidence && results.vehicleEvidence.moved;

  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: false });
  results.screenshot = SHOT;

  results.pass =
    results.pageLoaded &&
    results.consoleErrors.length === 0 &&
    results.pageErrors.length === 0 &&
    results.simReady &&
    results.elevationRangeOk &&
    results.vehiclesMoving;
} catch (err) {
  results.error = String(err);
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
