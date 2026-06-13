// V3 C2 screenshots: docs/screenshots/v3-noche.png + v3-lluvia.png.
import { chromium } from '@playwright/test';

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto('http://localhost:5174/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__SIM__.setSimSpeed(4));
  await page.waitForFunction(() => window.__SIM__.vehicleCount > 40, null, { timeout: 60000 });
  // Wait for buildings (async attach) so lit windows show at night.
  await page.waitForTimeout(4000);

  // Oblique view over the busiest lane: street + traffic guaranteed in frame,
  // headlight pools / lamp glows / wet asphalt all read clearly.
  await page.evaluate(() => {
    const sim = window.__SIM__.sim;
    let best = null;
    for (const v of sim.vehicles) {
      if (!v.seg.isConnector && (!best || v.seg.vehicles.length > best.vehicles.length)) {
        best = v.seg;
      }
    }
    const p = best.posAt(best.length / 2);
    const h = best.headingAt(best.length / 2);
    const view = window.__SIM__.view;
    // Down the avenue AGAINST the travel direction: oncoming headlights and
    // their pools face the camera; lamps line the right shoulder.
    view.controls.target.set(p.x, p.y + 2, p.z);
    view.camera.position.set(p.x + h.x * 70, p.y + 32, p.z + h.z * 70);
    view.controls.update();
  });

  // --- Night ---
  await page.evaluate(() => window.__SIM__.setTimeOfDay(22));
  await page.waitForFunction(() => window.__SIM__.environment.headlightCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'docs/screenshots/v3-noche.png' });
  const night = await page.evaluate(() => ({
    h: window.__SIM__.timeOfDay,
    heads: window.__SIM__.environment.headlightCount,
    lamps: window.__SIM__.environment.lampGlowVisible,
  }));
  console.log('noche:', JSON.stringify(night));

  // --- Rain (late afternoon so the wet darkening reads) ---
  await page.evaluate(() => {
    window.__SIM__.setTimeOfDay(15);
    window.__SIM__.setWeather('lluvia', 1);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'docs/screenshots/v3-lluvia.png' });
  const rain = await page.evaluate(() => ({
    rainVisible: window.__SIM__.environment.rainVisible,
    current: window.__SIM__.weather.current,
  }));
  console.log('lluvia:', JSON.stringify(rain));
  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
