// V4 D2 e2e — Teleférico Mi Teleférico (spec §D2). Runs against the same dev
// server as e2e.spec.js (SIM_PORT=5174). Hooks under window.__SIM__:
//   aerialway      -> { lines, cabins } | null  (default zone has >=1 line)
//   sampleCabin()  -> { x, y, z } | null         (first cabin's live position)
//   setTeleferico(b) / aerialwayWanted()         (layer visibility)
//
// The default La Paz snapshot (public/data/default-aerialway.json) carries the
// real Mi Teleférico lines, so these tests need NO network access. The mesh
// attaches fire-and-forget after the world, so each test waits for it.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
  // Aerialway attaches fire-and-forget from the bundled snapshot.
  await page.waitForFunction(() => window.__SIM__.aerialway && window.__SIM__.aerialway.lines > 0, null, {
    timeout: 20_000,
  });
}

test.describe('V4 D2 — Teleférico Mi Teleférico', () => {
  test('D2-1. la zona por defecto carga líneas y cabinas de Mi Teleférico', async ({ page }) => {
    await gotoAndWaitReady(page);
    const state = await page.evaluate(() => window.__SIM__.aerialway);
    expect(state).not.toBeNull();
    // The bundled La Paz snapshot has 4 lines (Amarilla/Blanca/Celeste/Morada).
    expect(state.lines).toBeGreaterThanOrEqual(1);
    expect(state.cabins).toBeGreaterThan(0);
    // cabinsPerLine cabins per line, both directions.
    expect(state.cabins).toBeGreaterThanOrEqual(state.lines);
  });

  test('D2-2. las cabinas se desplazan y viajan elevadas sobre el cable', async ({ page }) => {
    test.setTimeout(60_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));

    // Sample the first cabin, wait 3 s of wall time, sample again. Cabins ride
    // WALL-CLOCK time (independent of sim speed), so >2 m of displacement proves
    // the animation advances. y must sit well above ground (elevated cable).
    const p0 = await page.evaluate(() => window.__SIM__.sampleCabin());
    expect(p0).not.toBeNull();
    // Cable rides elevAt + cableHeightM (30) minus the ~1.4 m gondola hang, so
    // even on flat terrain y should be comfortably above +10.
    expect(p0.y).toBeGreaterThan(10);

    await page.waitForTimeout(3000);
    const p1 = await page.evaluate(() => window.__SIM__.sampleCabin());
    expect(p1).not.toBeNull();
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    expect(moved).toBeGreaterThan(2);
    expect(p1.y).toBeGreaterThan(10);
  });

  test('D2-3. la casilla «Teleférico» oculta y muestra la capa', async ({ page }) => {
    await gotoAndWaitReady(page);

    // Find the aerialway group and confirm it is visible by default.
    const visible0 = await page.evaluate(() => {
      let g = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.name === 'aerialway') g = o;
      });
      return g ? g.visible : null;
    });
    expect(visible0).toBe(true);

    // Toggle off via the hook -> group hidden.
    const hidden = await page.evaluate(() => {
      window.__SIM__.setTeleferico(false);
      let g = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.name === 'aerialway') g = o;
      });
      return g ? g.visible : null;
    });
    expect(hidden).toBe(false);

    // Toggle back on -> group visible again.
    const shown = await page.evaluate(() => {
      window.__SIM__.setTeleferico(true);
      let g = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.name === 'aerialway') g = o;
      });
      return g ? g.visible : null;
    });
    expect(shown).toBe(true);
  });

  test('D2-4. la casilla «Teleférico» de la GUI controla la capa', async ({ page }) => {
    await gotoAndWaitReady(page);
    // The «Vista» folder is collapsed by default — open it, then toggle.
    await page.getByRole('button', { name: 'Vista' }).click();
    const checkbox = page.getByRole('checkbox', { name: 'Teleférico' });
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    const afterOff = await page.evaluate(() => {
      let g = null;
      window.__SIM__.view.scene.traverse((o) => {
        if (o.name === 'aerialway') g = o;
      });
      return g ? g.visible : null;
    });
    expect(afterOff).toBe(false);
  });

  test('D2-5. el teleférico renderiza con consola limpia', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !OFFLINE_ERROR_RE.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      if (!OFFLINE_ERROR_RE.test(String(err))) errors.push(String(err));
    });
    await gotoAndWaitReady(page);
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    // Let the cabins animate for a while with the layer visible.
    await page.waitForTimeout(8000);
    // Cabins keep moving -> at least one sample differs over a short window.
    const a = await page.evaluate(() => window.__SIM__.sampleCabin());
    await page.waitForTimeout(1000);
    const b = await page.evaluate(() => window.__SIM__.sampleCabin());
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
  });
});
