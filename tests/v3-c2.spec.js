// V3 C2 e2e — Clima y ciclo día/noche (spec §5). Runs against the same dev
// server as e2e.spec.js (SIM_PORT). Hooks: __SIM__.setWeather/weather,
// setTimeOfDay/timeOfDay, environment {nightFactor, sunIntensity,
// headlightCount, rainVisible, lampGlowVisible}.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

/** Mean of N meanSpeedKmh samples ~1 s apart (smooths the 0.5 s metric). */
async function sampleMeanSpeed(page, n = 5) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += await page.evaluate(() => window.__SIM__.metrics.global.meanSpeedKmh);
    await page.waitForTimeout(1000);
  }
  return sum / n;
}

test.describe('V3 C2 — Clima y ciclo día/noche', () => {
  test('C2-1. lluvia: multiplicadores IDM exactos y la velocidad media cae', async ({ page }) => {
    test.setTimeout(300_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    // Calentamiento despejado hasta población estable. Presupuestos holgados:
    // los assertions van sobre TIEMPO SIM — bajo contención de CPU (suites en
    // paralelo) el reloj de pared se estira sin invalidar la física.
    await page.waitForFunction(() => window.__SIM__.time > 60, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 20, null, { timeout: 60_000 });
    const clearMean = await sampleMeanSpeed(page);
    expect(clearMean).toBeGreaterThan(5); // sanity: hay tráfico en movimiento

    // Lluvia a intensidad 1 -> multiplicadores D5 (lerp identidad->lluvia).
    const wet = await page.evaluate(() => {
      window.__SIM__.setWeather('lluvia', 1);
      return {
        weather: window.__SIM__.weather,
        rainVisible: window.__SIM__.environment.rainVisible,
      };
    });
    expect(wet.weather.mode).toBe('lluvia');
    expect(wet.weather.current.v0Mul).toBeCloseTo(0.8, 5);
    expect(wet.weather.current.TAdd).toBeCloseTo(0.4, 5);
    expect(wet.weather.current.bMul).toBeCloseTo(0.85, 5);
    expect(wet.rainVisible).toBe(true);

    // Ventana de 60 s sim bajo lluvia -> velocidad media < despejado x 0.95.
    const t0 = await page.evaluate(() => window.__SIM__.time);
    await page.waitForFunction((t) => window.__SIM__.time > t + 60, t0, { timeout: 120_000 });
    const rainMean = await sampleMeanSpeed(page);
    expect(rainMean).toBeLessThan(clearMean * 0.95);

    // Despejado -> identidad EXACTA (cero cambio de comportamiento) y sin lluvia.
    const dry = await page.evaluate(() => {
      window.__SIM__.setWeather('despejado');
      return {
        current: window.__SIM__.weather.current,
        rainVisible: window.__SIM__.environment.rainVisible,
      };
    });
    expect(dry.current.v0Mul).toBe(1);
    expect(dry.current.TAdd).toBe(0);
    expect(dry.current.bMul).toBe(1);
    expect(dry.rainVisible).toBe(false);
  });

  test('C2-2. noche enciende faros y farolas; mediodía restaura exacto (D4)', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 5, null, { timeout: 30_000 });

    // Medianoche: sol apagado, noche plena, farolas encendidas, sin sombras.
    const night = await page.evaluate(() => {
      window.__SIM__.setTimeOfDay(0);
      const e = window.__SIM__.environment;
      return {
        sunIntensity: e.sunIntensity,
        nightFactor: e.nightFactor,
        lampGlowVisible: e.lampGlowVisible,
        castShadow: window.__SIM__.view.sun.castShadow,
      };
    });
    expect(night.sunIntensity).toBeLessThan(0.1);
    expect(night.nightFactor).toBeGreaterThan(0.9);
    expect(night.lampGlowVisible).toBe(true);
    expect(night.castShadow).toBe(false); // refund nocturno (sunI < 0.05)
    // Los faros se emiten en el siguiente tick de render con vehículos vivos.
    await page.waitForFunction(() => window.__SIM__.environment.headlightCount > 0, null, {
      timeout: 15_000,
    });

    // Mediodía: rampa EXACTA del escenario legado (idempotencia D4, sin
    // save/restore) — intensidad 2.6, cielo 0x101720, sombras de vuelta.
    const noon = await page.evaluate(() => {
      window.__SIM__.setTimeOfDay(12);
      const e = window.__SIM__.environment;
      return {
        sunIntensity: e.sunIntensity,
        nightFactor: e.nightFactor,
        sky: window.__SIM__.view.scene.background.getHex(),
        fogNear: window.__SIM__.view.scene.fog.near,
        fogFar: window.__SIM__.view.scene.fog.far,
        castShadow: window.__SIM__.view.sun.castShadow,
      };
    });
    expect(noon.sunIntensity).toBe(2.6);
    expect(noon.nightFactor).toBe(0);
    expect(noon.sky).toBe(0x101720);
    expect(noon.fogNear).toBe(900);
    expect(noon.fogFar).toBe(2600);
    expect(noon.castShadow).toBe(true);
    await page.waitForFunction(() => window.__SIM__.environment.headlightCount === 0, null, {
      timeout: 15_000,
    });
  });

  test('C2-3. ciclo automático: la hora avanza estrictamente', async ({ page }) => {
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    // La carpeta «Clima y hora» nace cerrada — abrirla y activar el ciclo.
    await page.getByRole('button', { name: 'Clima y hora' }).click();
    await page.getByRole('checkbox', { name: 'Ciclo automático' }).click();
    const h0 = await page.evaluate(() => window.__SIM__.timeOfDay);
    await page.waitForTimeout(2000);
    const h1 = await page.evaluate(() => window.__SIM__.timeOfDay);
    await page.waitForTimeout(2000);
    const h2 = await page.evaluate(() => window.__SIM__.timeOfDay);
    expect(h1).toBeGreaterThan(h0);
    expect(h2).toBeGreaterThan(h1);
  });

  test('C2-4. lluvia + noche componen con consola limpia', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !OFFLINE_ERROR_RE.test(msg.text())) {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      if (!OFFLINE_ERROR_RE.test(String(err))) errors.push(String(err));
    });
    await gotoAndWaitReady(page);
    await page.evaluate(() => {
      window.__SIM__.setSimSpeed(4);
      window.__SIM__.setWeather('lluvia', 1);
      window.__SIM__.setTimeOfDay(22);
    });
    const composed = await page.evaluate(() => {
      const e = window.__SIM__.environment;
      return { rainVisible: e.rainVisible, nightFactor: e.nightFactor };
    });
    expect(composed.rainVisible).toBe(true);
    expect(composed.nightFactor).toBeGreaterThan(0.9);
    await page.waitForTimeout(8_000); // lluvia nocturna renderizando
    expect(errors).toEqual([]);
  });
});
