// E2E suite (spec §7). Runs against the dev server on :5173 (webServer config
// reuses a running instance). The sim exposes window.__SIM__ as its test hook.

import { test, expect } from '@playwright/test';

/** Console/page errors that don't indicate app bugs when running offline. */
const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

test.describe('Simulador de Tráfico Urbano 3D', () => {
  test('1. consola limpia durante 10 s de carga por defecto', async ({ page }) => {
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
    await page.waitForTimeout(10_000);
    expect(errors).toEqual([]);
  });

  test('2. sim viva: >20 vehículos y desplazamiento >5 m', async ({ page }) => {
    await gotoAndWaitReady(page);
    // 4x para alcanzar la población de equilibrio dentro de los 30 s de pared.
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 20, null, {
      timeout: 30_000,
    });

    // Un vehículo en movimiento debe desplazarse > 5 m en 3 s de pared.
    // (Puede despawnear a mitad de la medición: reintenta hasta 3 veces.)
    let displaced = 0;
    for (let attempt = 0; attempt < 3 && displaced <= 5; attempt++) {
      const before = await page.evaluate(() => {
        const v = window.__SIM__.sim.vehicles.find((x) => x.v > 1);
        if (!v) return null;
        const p = v.seg.pointAt(v.s);
        return { id: v.id, x: p.x, z: p.z };
      });
      if (!before) {
        await page.waitForTimeout(1000);
        continue;
      }
      await page.waitForTimeout(3000);
      const after = await page.evaluate((id) => {
        const v = window.__SIM__.sim.vehicles.find((x) => x.id === id);
        if (!v) return null;
        const p = v.seg.pointAt(v.s);
        return { x: p.x, z: p.z };
      }, before.id);
      if (!after) continue; // despawned mid-measurement
      displaced = Math.hypot(after.x - before.x, after.z - before.z);
    }
    expect(displaced).toBeGreaterThan(5);
  });

  test('3. demanda alta -> la velocidad media cae (se forman colas)', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    // Calentamiento a demanda por defecto hasta 90 s sim.
    await page.waitForFunction(() => window.__SIM__.time > 90, null, { timeout: 60_000 });
    const freeFlow = await page.evaluate(() => window.__SIM__.metrics.global.meanSpeedKmh);
    expect(freeFlow).toBeGreaterThan(5); // sanity: traffic is actually moving

    // Saturar la red y dejar pasar >60 s sim.
    const t0 = await page.evaluate(() => {
      window.__SIM__.setDemand(5000);
      return window.__SIM__.time;
    });
    await page.waitForFunction((t) => window.__SIM__.time > t + 90, t0, { timeout: 60_000 });
    const congested = await page.evaluate(() => window.__SIM__.metrics.global.meanSpeedKmh);
    expect(congested).toBeLessThan(freeFlow * 0.9);
  });

  test('4. textos en español visibles (Demanda / ¿Cómo funciona? / veh/km)', async ({ page }) => {
    await gotoAndWaitReady(page);
    await expect(page.locator('.lil-gui.lil-root')).toContainText('Demanda');
    await expect(page.locator('#explainer')).toContainText('¿Cómo funciona?');
    await expect(page.locator('#hud')).toContainText('veh/km');
    await expect(page.locator('#chart')).toContainText('Diagrama fundamental');
  });

  test('5. búsqueda carga otra ciudad (se omite sin conexión)', async ({ page, request }) => {
    test.setTimeout(150_000);
    // Sonda de conectividad: sin red -> skip, no fail.
    let online = true;
    try {
      await request.get('https://nominatim.openstreetmap.org/status', { timeout: 8_000 });
    } catch {
      online = false;
    }
    test.skip(!online, 'sin conexión a internet — búsqueda en vivo no comprobable');

    await gotoAndWaitReady(page);
    const before = await page.evaluate(() => window.__SIM__.networkCenter);
    await page.fill('#search-input', 'Sopocachi, La Paz');
    await page.click('#search-btn');
    // El centro de la red debe cambiar y la sim volver a estar lista con
    // tráfico. Si Overpass/Nominatim rechazan la petición (rate limit, caída),
    // la app muestra un toast y conserva la red actual: eso cuenta como
    // "sin servicio" -> skip, no fail.
    const outcome = await page.waitForFunction(
      (prev) => {
        const c = window.__SIM__.networkCenter;
        if (
          window.__SIM__.ready &&
          c &&
          (Math.abs(c.lat - prev.lat) > 1e-4 || Math.abs(c.lon - prev.lon) > 1e-4)
        ) {
          return 'changed';
        }
        const toast = document.getElementById('toast');
        if (
          toast &&
          toast.style.display === 'block' &&
          /No se pudo descargar|No se pudo buscar/.test(toast.textContent)
        ) {
          return 'unavailable';
        }
        return false;
      },
      before,
      { timeout: 120_000 }
    );
    const result = await outcome.jsonValue();
    test.skip(result === 'unavailable', 'servicio Overpass/Nominatim no disponible ahora mismo');
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 0, null, {
      timeout: 30_000,
    });
    const after = await page.evaluate(() => window.__SIM__.networkCenter);
    expect(after.lat).not.toBeCloseTo(before.lat, 4);
  });
});
