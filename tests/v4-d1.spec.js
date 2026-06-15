// V4 D1 e2e — Vista satélite (spec §D1). Runs against the dev server on
// SIM_PORT=5174 like the rest of the suite. Hooks under window.__SIM__:
//   setSatellite(b)   -> toggle the drape (terrain imagery + building transparency)
//   satellite         -> { enabled, ready }
//   terrainHasMap     -> !!terrain.material.map (true only once draped)
//
// The default La Paz zone ships a bundled JPG+JSON snapshot
// (public/data/default-satellite.{jpg,json}), so these tests need NO live tile
// fetch. The imagery attaches fire-and-forget after the world, so the toggle-on
// test waits for `satellite.ready`.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|arcgisonline|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

async function waitSatelliteReady(page) {
  // Imagery attaches fire-and-forget from the bundled snapshot.
  await page.waitForFunction(() => window.__SIM__.satellite && window.__SIM__.satellite.ready, null, {
    timeout: 20_000,
  });
}

test.describe('V4 D1 — Vista satélite', () => {
  test('D1-1. la zona por defecto carga las imágenes satelitales', async ({ page }) => {
    await gotoAndWaitReady(page);
    await waitSatelliteReady(page);
    const sat = await page.evaluate(() => window.__SIM__.satellite);
    expect(sat.ready).toBe(true);
    // OFF by default -> not enabled, terrain not yet draped.
    expect(sat.enabled).toBe(false);
    const hasMap = await page.evaluate(() => window.__SIM__.terrainHasMap);
    expect(hasMap).toBe(false);
  });

  test('D1-2. activar Vista satélite drapea la foto sobre el terreno', async ({ page }) => {
    await gotoAndWaitReady(page);
    await waitSatelliteReady(page);

    // Toggle ON -> terrain gets the texture map, satellite.enabled true.
    const on = await page.evaluate(() => {
      window.__SIM__.setSatellite(true);
      return { enabled: window.__SIM__.satellite.enabled, hasMap: window.__SIM__.terrainHasMap };
    });
    expect(on.enabled).toBe(true);
    expect(on.hasMap).toBe(true);

    // Toggle OFF -> map removed (terrain returns to the stylized ground color).
    const off = await page.evaluate(() => {
      window.__SIM__.setSatellite(false);
      return {
        enabled: window.__SIM__.satellite.enabled,
        hasMap: window.__SIM__.terrainHasMap,
      };
    });
    expect(off.enabled).toBe(false);
    expect(off.hasMap).toBe(false);
  });

  test('D1-3. los edificios se vuelven semitransparentes con la vista satélite', async ({ page }) => {
    await gotoAndWaitReady(page);
    await waitSatelliteReady(page);
    // Buildings attach fire-and-forget; wait for the merged mesh to exist.
    await page.waitForFunction(
      () => {
        let found = false;
        window.__SIM__.view.scene.traverse((o) => {
          if (o.isMesh && o.material && o.material.vertexColors && o.castShadow) found = true;
        });
        return found;
      },
      null,
      { timeout: 20_000 }
    );

    // Read building material transparency in OFF then ON states. The building
    // mesh is the merged, vertex-colored, shadow-casting mesh.
    function readBuildingMat() {
      let mat = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.isMesh && o.material && o.material.vertexColors && o.castShadow) mat = o.material;
      });
      return mat ? { transparent: mat.transparent, opacity: mat.opacity } : null;
    }

    const offState = await page.evaluate(readBuildingMat);
    expect(offState).not.toBeNull();
    expect(offState.opacity).toBeCloseTo(1, 2);

    const onState = await page.evaluate(() => {
      window.__SIM__.setSatellite(true);
      let mat = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.isMesh && o.material && o.material.vertexColors && o.castShadow) mat = o.material;
      });
      return mat ? { transparent: mat.transparent, opacity: mat.opacity } : null;
    });
    expect(onState).not.toBeNull();
    expect(onState.transparent).toBe(true);
    expect(onState.opacity).toBeLessThan(0.9);
    expect(onState.opacity).toBeGreaterThan(0.1);
  });

  test('D1-4. la casilla «Vista satélite» de la GUI drapea la foto', async ({ page }) => {
    await gotoAndWaitReady(page);
    await waitSatelliteReady(page);
    // The «Vista» folder is collapsed by default — open it, then toggle.
    await page.getByRole('button', { name: 'Vista' }).click();
    const checkbox = page.getByRole('checkbox', { name: 'Vista satélite' });
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    const hasMap = await page.evaluate(() => window.__SIM__.terrainHasMap);
    expect(hasMap).toBe(true);
  });

  test('D1-5. la vista satélite compone con día/noche y lluvia sin errores', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !OFFLINE_ERROR_RE.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      if (!OFFLINE_ERROR_RE.test(String(err))) errors.push(String(err));
    });
    await gotoAndWaitReady(page);
    await waitSatelliteReady(page);

    // Compose: satellite ON + night + rain — the Lambert terrain must still
    // composite sun/fog/night with the photo map and not throw.
    await page.evaluate(() => {
      window.__SIM__.setSatellite(true);
      window.__SIM__.setTimeOfDay(21); // night
      window.__SIM__.setWeather('lluvia', 0.9);
    });
    await page.waitForTimeout(4000);
    const hasMap = await page.evaluate(() => window.__SIM__.terrainHasMap);
    expect(hasMap).toBe(true);
    expect(errors).toEqual([]);
  });
});
