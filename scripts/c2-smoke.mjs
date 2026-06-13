// Standalone C2 smoke (avoids MCP browser contention): drives :5174 directly.
import { chromium } from '@playwright/test';

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:5174/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__SIM__.setSimSpeed(4));
  await page.waitForFunction(() => window.__SIM__.vehicleCount > 5, null, { timeout: 30000 });

  const noonBefore = await page.evaluate(() => ({
    env: { ...window.__SIM__.environment, headlightCount: window.__SIM__.environment.headlightCount,
           rainVisible: window.__SIM__.environment.rainVisible,
           lampGlowVisible: window.__SIM__.environment.lampGlowVisible },
    weather: window.__SIM__.weather,
    sky: window.__SIM__.view.scene.background.getHex(),
    sunI: window.__SIM__.view.sun.intensity,
    sunPos: window.__SIM__.view.sun.position.toArray(),
    castShadow: window.__SIM__.view.sun.castShadow,
  }));
  console.log('DEFAULT(noon):', JSON.stringify(noonBefore));

  const night = await page.evaluate(() => {
    window.__SIM__.setTimeOfDay(0);
    const e = window.__SIM__.environment;
    return {
      sunIntensity: e.sunIntensity, nightFactor: e.nightFactor, headlightFactor: e.headlightFactor,
      lampGlowVisible: e.lampGlowVisible, castShadow: window.__SIM__.view.sun.castShadow,
      sky: window.__SIM__.view.scene.background.getHex(),
    };
  });
  await page.waitForTimeout(800);
  const headCount = await page.evaluate(() => window.__SIM__.environment.headlightCount);
  console.log('NIGHT(h=0):', JSON.stringify(night), 'headlightCount:', headCount);

  const rain = await page.evaluate(() => {
    window.__SIM__.setWeather('lluvia', 1);
    return { current: window.__SIM__.weather.current, rainVisible: window.__SIM__.environment.rainVisible,
             fogNear: window.__SIM__.view.scene.fog.near, fogFar: window.__SIM__.view.scene.fog.far };
  });
  console.log('RAIN(1):', JSON.stringify(rain));

  const restored = await page.evaluate(() => {
    window.__SIM__.setWeather('despejado');
    window.__SIM__.setTimeOfDay(12);
    const e = window.__SIM__.environment;
    return {
      sunIntensity: e.sunIntensity, nightFactor: e.nightFactor,
      sky: window.__SIM__.view.scene.background.getHex(),
      fogNear: window.__SIM__.view.scene.fog.near, fogFar: window.__SIM__.view.scene.fog.far,
      current: window.__SIM__.weather.current, castShadow: window.__SIM__.view.sun.castShadow,
      sunPos: window.__SIM__.view.sun.position.toArray(),
      rainVisible: window.__SIM__.environment.rainVisible,
    };
  });
  await page.waitForTimeout(500);
  const headAfter = await page.evaluate(() => window.__SIM__.environment.headlightCount);
  console.log('RESTORED(noon):', JSON.stringify(restored), 'headlightCount:', headAfter);
  console.log('ERRORS:', JSON.stringify(errors.filter((e) => !/net::ERR|Failed to load resource|overpass|nominatim/i.test(e))));
  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
