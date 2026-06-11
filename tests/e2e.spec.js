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

  test('6. micros paran en las paradas y el toggle las libera (F2)', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAndWaitReady(page);
    // Red por defecto: 7 paradas ancladas a carriles.
    expect(await page.evaluate(() => window.__SIM__.network.busStops.length)).toBe(7);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    // Algún micro queda detenido en parada (v<0.5 con dwell activo)...
    await page.waitForFunction(
      () => {
        const sim = window.__SIM__.sim;
        return sim.vehicles.some((x) => x.isMicro && x.v < 0.5 && sim.time < x.dwellUntil);
      },
      null,
      { timeout: 90_000 }
    );
    // ...y más tarde reanuda la marcha (v>2).
    await page.waitForFunction(
      () => {
        const sim = window.__SIM__.sim;
        return sim.vehicles.some(
          (x) => x.isMicro && x.dwellUntil > 0 && sim.time > x.dwellUntil && x.v > 2
        );
      },
      null,
      { timeout: 60_000 }
    );
    // Toggle off vía GUI -> nadie en dwell tras 30 s sim.
    // (Esta versión de lil-gui usa clases con prefijo `lil-`, p. ej.
    // `.lil-controller` — el checkbox se localiza por rol accesible.)
    await page.getByRole('checkbox', { name: 'Paradas de micro' }).click();
    const t0 = await page.evaluate(() => window.__SIM__.time);
    await page.waitForFunction((t) => window.__SIM__.time > t + 30, t0, { timeout: 60_000 });
    const dwelling = await page.evaluate(() => {
      const sim = window.__SIM__.sim;
      return sim.vehicles.filter((x) => sim.time < x.dwellUntil).length;
    });
    expect(dwelling).toBe(0);
  });

  test('7. mapa de calor: la congestión baja minSpeedRatio y colorea la vía', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => {
      window.__SIM__.setSimSpeed(4);
      window.__SIM__.setDemand(5000);
    });
    await page.waitForFunction(() => window.__SIM__.time > 90, null, { timeout: 90_000 });
    const minRatio = await page.evaluate(() => window.__SIM__.minSpeedRatio);
    expect(minRatio).toBeLessThan(0.5);

    // ON -> el atributo de color del mesh de calzadas deja de ser blanco.
    const heat = await page.evaluate(() => {
      window.__SIM__.setHeatmap(true);
      const st = window.__SIM__.heatmap; // hook getHeatmapState() de roadMesh
      if (!st || !st.colors) return null;
      const a = st.colors;
      let nonWhite = 0;
      for (let i = 0; i < a.length; i += 3) {
        if (a[i] !== 1 || a[i + 1] !== 1 || a[i + 2] !== 1) nonWhite++;
      }
      return { vertices: a.length / 3, ranges: st.rangeCount, nonWhite };
    });
    expect(heat).not.toBeNull();
    expect(heat.ranges).toBeGreaterThan(0);
    expect(heat.nonWhite).toBeGreaterThan(0);

    // OFF -> el atributo vuelve a blanco exacto (blanco x roadColor = aspecto original).
    const allWhite = await page.evaluate(() => {
      window.__SIM__.setHeatmap(false);
      const a = window.__SIM__.heatmap.colors;
      for (let i = 0; i < a.length; i++) if (a[i] !== 1) return false;
      return true;
    });
    expect(allWhite).toBe(true);
  });

  test('8. diagrama espacio-tiempo: corredor >200 m y muestras crecientes', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    // Panel visible con título en español.
    await expect(page.locator('#spacetime')).toContainText('Diagrama espacio-tiempo');
    // Corredor detectado sobre la red por defecto.
    const st0 = await page.evaluate(() => window.__SIM__.spaceTime);
    expect(st0.corridorLength).toBeGreaterThan(200);
    // Calentamiento: en una página recién cargada aún no hay vehículos sobre
    // el corredor — espera la primera muestra antes de medir incrementos.
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    await page.waitForFunction(() => window.__SIM__.spaceTime.sampleCount > 0, null, {
      timeout: 60_000,
    });
    // Muestras estrictamente crecientes durante 10 s de pared a 4x.
    const c0 = await page.evaluate(() => window.__SIM__.spaceTime.sampleCount);
    await page.waitForTimeout(5_000);
    const c1 = await page.evaluate(() => window.__SIM__.spaceTime.sampleCount);
    await page.waitForTimeout(5_000);
    const c2 = await page.evaluate(() => window.__SIM__.spaceTime.sampleCount);
    expect(c1).toBeGreaterThan(c0);
    expect(c2).toBeGreaterThan(c1);
  });
});
