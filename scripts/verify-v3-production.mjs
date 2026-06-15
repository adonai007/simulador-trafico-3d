// Standalone Playwright verification of v3 in PRODUCTION (Render).
// Checks: zero console errors, __SIM__.ready, closeEdge/openEdge re-route,
// setTimeOfDay(22) -> headlights, setWeather('lluvia') -> rain, then restores
// defaults. Captures docs/screenshots/v3-production.png (night + rain) if green.
import { chromium } from '@playwright/test';

const URL = 'https://simulador-trafico-3d.onrender.com/';
const SHOT = 'docs/screenshots/v3-production.png';

const result = {
  url: URL,
  consoleErrors: [],
  pageErrors: [],
  ready: null,
  closeEdge: null,
  openEdge: null,
  headlights: null,
  rain: null,
  restored: null,
  screenshot: null,
  pass: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') result.consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => result.pageErrors.push(String(err)));

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });

  // 1) __SIM__.ready
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, { timeout: 60000 });
  result.ready = await page.evaluate(() => window.__SIM__.ready);

  // Warm the sim so vehicles exist (needed for headlights at night).
  await page.evaluate(() => { window.__SIM__.setSimSpeed(4); window.__SIM__.setDemand(5000); });
  await page.waitForFunction(() => window.__SIM__.vehicleCount > 20, null, { timeout: 60000 });

  // 2) closeEdge -> re-route (routingVersion bumps), then openEdge restores.
  const ids = await page.evaluate(() => {
    const S = window.__SIM__;
    const net = S.network;
    const corridorName = S.spaceTime?.corridorName;
    let best = null;
    for (const e of net.edges.values()) {
      if (e.twinId == null || e.twinId < e.id) continue;
      if (corridorName && e.name === corridorName) continue;
      const twin = net.edges.get(e.twinId);
      if (!twin || !e.lanes.length || !twin.lanes.length) continue;
      if (e.lanes[0]._det || twin.lanes[0]._det) continue;
      const fromN = net.nodes.get(e.fromNode);
      const toN = net.nodes.get(e.toNode);
      if (!fromN || !toN || fromN.legCount < 2 || toN.legCount < 2) continue;
      if (!best || e.lengthM > best.lengthM) best = e;
    }
    return best ? { id: best.id, twinId: best.twinId, name: best.name } : null;
  });
  if (!ids) throw new Error('no closable edge found');

  const rv0 = await page.evaluate(() => window.__SIM__.routingVersion);
  const affected = await page.evaluate((id) => window.__SIM__.closeEdge(id), ids.id);
  await page.waitForFunction((rv) => window.__SIM__.routingVersion > rv, rv0, { timeout: 20000 });
  const rv1 = await page.evaluate(() => window.__SIM__.routingVersion);
  const closedHas = await page.evaluate((id) => window.__SIM__.closedEdges.has(id), ids.id);
  result.closeEdge = { edge: ids.name, affected, routingVersionBefore: rv0, routingVersionAfter: rv1, inClosedSet: closedHas, ok: rv1 > rv0 && closedHas };

  const reopened = await page.evaluate((id) => window.__SIM__.openEdge(id), ids.id);
  const closedHas2 = await page.evaluate((id) => window.__SIM__.closedEdges.has(id), ids.id);
  result.openEdge = { reopened, stillClosed: closedHas2, ok: reopened && !closedHas2 };

  // 3) setTimeOfDay(22) -> headlights on (headlightCount > 0).
  await page.evaluate(() => window.__SIM__.setTimeOfDay(22));
  await page.waitForFunction(() => window.__SIM__.environment.headlightCount > 0, null, { timeout: 20000 });
  const hc = await page.evaluate(() => window.__SIM__.environment.headlightCount);
  const nf = await page.evaluate(() => window.__SIM__.environment.nightFactor);
  result.headlights = { headlightCount: hc, nightFactor: nf, ok: hc > 0 };

  // 4) setWeather('lluvia', 1) -> rain visible.
  await page.evaluate(() => window.__SIM__.setWeather('lluvia', 1));
  await page.waitForFunction(() => window.__SIM__.environment.rainVisible === true, null, { timeout: 20000 });
  const rainVisible = await page.evaluate(() => window.__SIM__.environment.rainVisible);
  const weather = await page.evaluate(() => window.__SIM__.weather.current);
  result.rain = { rainVisible, weather, ok: rainVisible === true };

  // 5) Screenshot night + rain over La Paz (if everything green so far).
  const greenSoFar = result.ready && result.closeEdge.ok && result.openEdge.ok && result.headlights.ok && result.rain.ok;
  if (greenSoFar) {
    // Let particles + headlights settle a few frames.
    await page.waitForFunction(() => window.__SIM__.time > 0, null, { timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: SHOT });
    result.screenshot = SHOT;
  }

  // 6) Restore defaults: clear weather, return to daytime, reopen edges.
  await page.evaluate(() => {
    window.__SIM__.setWeather('despejado');
    window.__SIM__.setTimeOfDay(12);
  });
  await page.waitForFunction(() => window.__SIM__.environment.rainVisible === false && window.__SIM__.environment.headlightCount === 0, null, { timeout: 20000 });
  const restWeather = await page.evaluate(() => window.__SIM__.weather.current);
  const restTod = await page.evaluate(() => window.__SIM__.timeOfDay);
  const restRain = await page.evaluate(() => window.__SIM__.environment.rainVisible);
  const restHl = await page.evaluate(() => window.__SIM__.environment.headlightCount);
  result.restored = { weather: restWeather, timeOfDay: restTod, rainVisible: restRain, headlightCount: restHl, ok: restRain === false && restHl === 0 };

  result.pass =
    result.ready === true &&
    result.consoleErrors.length === 0 &&
    result.pageErrors.length === 0 &&
    result.closeEdge.ok &&
    result.openEdge.ok &&
    result.headlights.ok &&
    result.rain.ok &&
    result.restored.ok;
} catch (err) {
  result.error = String(err && err.stack ? err.stack : err);
} finally {
  await browser.close();
}

console.log('VERIFY_RESULT_JSON_START');
console.log(JSON.stringify(result, null, 2));
console.log('VERIFY_RESULT_JSON_END');
process.exit(result.pass ? 0 : 1);
