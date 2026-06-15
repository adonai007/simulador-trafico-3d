// V4 D3 e2e — Compartir por URL + modo tour (spec §D3). Runs against the same
// dev server as e2e.spec.js (SIM_PORT). Round-trips a scenario on the DEFAULT
// zone (no live Overpass fetch needed), so it is reliable offline. Hooks:
//   __SIM__.share.url() / .copy(), __SIM__.tour {playing, scene, play, next, pause},
//   __SIM__.setDemand/setSimSpeed/setHeatmap/setWeather/setTimeOfDay, closedEdges.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

/** Read the live scenario values the share link should round-trip. */
async function readState(page) {
  return page.evaluate(() => ({
    demanda: window.__SIM__.sim.demand,
    simSpeed: window.__SIM__.simSpeed,
    timeOfDay: window.__SIM__.timeOfDay,
    weatherMode: window.__SIM__.weather.mode,
    heatmap: !!window.__SIM__.heatmap?.enabled,
  }));
}

test.describe('V4 D3 — Compartir por URL + modo tour', () => {
  test('D3-1. round-trip de escenario en la zona por defecto', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoAndWaitReady(page);

    // Distinctive, non-default scenario via the live setters.
    await page.evaluate(() => {
      window.__SIM__.setDemand(3500);
      window.__SIM__.setSimSpeed(2);
      window.__SIM__.setWeather('lluvia', 0.8);
      window.__SIM__.setTimeOfDay(19.5);
      window.__SIM__.setHeatmap(true);
    });

    const url = await page.evaluate(() => window.__SIM__.share.url());
    // Default zone => no c/r/q; settings present.
    expect(url).toContain('d=3500');
    expect(url).toContain('h=19.5');
    expect(url).toContain('w=1'); // lluvia
    expect(url).toContain('hm=1');
    expect(url).not.toContain('c='); // default zone omits center
    expect(url).not.toContain('q=');

    // Reload via the share URL and confirm the scenario was restored.
    await page.goto(url);
    await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
      timeout: 30_000,
    });
    // Boot restore runs async after __SIM__; wait for demanda to land.
    await page.waitForFunction(() => window.__SIM__.sim.demand === 3500, null, {
      timeout: 15_000,
    });

    const restored = await readState(page);
    expect(restored.demanda).toBe(3500);
    expect(restored.simSpeed).toBeCloseTo(2, 5);
    expect(restored.timeOfDay).toBeCloseTo(19.5, 2);
    expect(restored.weatherMode).toBe('lluvia');
    expect(restored.heatmap).toBe(true);

    // Weather multipliers reflect lluvia (intensidad 0.8 lerp).
    const w = await page.evaluate(() => window.__SIM__.weather.current);
    expect(w.v0Mul).toBeLessThan(1);
    expect(w.TAdd).toBeGreaterThan(0);
  });

  test('D3-2. los cierres de calle sobreviven al enlace (OSM-stable)', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoAndWaitReady(page);

    // Close the longest interior twin-paired edge (mirrors the C1 picker).
    const closed = await page.evaluate(() => {
      const net = window.__SIM__.network;
      let best = null;
      for (const e of net.edges.values()) {
        if (e.twinId == null || e.twinId < e.id) continue; // one per pair
        if (!best || e.lengthM > best.lengthM) best = e;
      }
      if (!best) return null;
      window.__SIM__.closeEdge(best.id);
      return { id: best.id, wayId: best.wayId };
    });
    expect(closed).not.toBeNull();
    await page.waitForFunction(() => window.__SIM__.closedEdges?.size >= 1, null, {
      timeout: 10_000,
    });

    const url = await page.evaluate(() => window.__SIM__.share.url());
    expect(url).toContain('closed=');
    expect(url).toContain(String(closed.wayId)); // OSM way id, not edge id

    await page.goto(url);
    await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
      timeout: 30_000,
    });
    // Closures apply LAST in the boot restore — wait for them.
    await page.waitForFunction(() => window.__SIM__.closedEdges?.size >= 1, null, {
      timeout: 15_000,
    });
    const size = await page.evaluate(() => window.__SIM__.closedEdges.size);
    expect(size).toBeGreaterThanOrEqual(1);
  });

  test('D3-3. «Compartir enlace» copia y muestra el toast', async ({ page, context }) => {
    test.setTimeout(60_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await gotoAndWaitReady(page);

    const res = await page.evaluate(() => window.__SIM__.share.copy());
    expect(res.ok).toBe(true);
    expect(res.url).toContain('d=');

    // Toast shows the Spanish confirmation.
    const toast = page.locator('#toast');
    await expect(toast).toHaveText('Enlace copiado', { timeout: 5_000 });
  });

  test('D3-4. modo tour: reproduce, avanza y cambia el estado', async ({ page }) => {
    test.setTimeout(60_000);
    await gotoAndWaitReady(page);

    // Play: panel visible, playing true, first scene applied (demanda baja).
    await page.evaluate(() => window.__SIM__.tour.play());
    expect(await page.evaluate(() => window.__SIM__.tour.playing)).toBe(true);
    expect(await page.evaluate(() => window.__SIM__.tour.scene)).toBe(0);

    const panel = page.locator('#tour');
    await expect(panel).toBeVisible();
    const caption = page.locator('#tour-caption');
    await expect(caption).toContainText('Mañana tranquila');

    const demanda0 = await page.evaluate(() => window.__SIM__.sim.demand);
    expect(demanda0).toBe(800); // scene 1: mañana tranquila

    // Next: scene advances and state changes (hora pico => demanda 5000).
    await page.evaluate(() => window.__SIM__.tour.next());
    expect(await page.evaluate(() => window.__SIM__.tour.scene)).toBe(1);
    await expect(caption).toContainText('Hora pico');
    expect(await page.evaluate(() => window.__SIM__.sim.demand)).toBe(5000);

    // Advance to the closure scene => at least one edge closed + heatmap on.
    await page.evaluate(() => window.__SIM__.tour.next());
    expect(await page.evaluate(() => window.__SIM__.tour.scene)).toBe(2);
    await page.waitForFunction(() => window.__SIM__.closedEdges?.size >= 1, null, {
      timeout: 10_000,
    });
    expect(await page.evaluate(() => window.__SIM__.heatmap.enabled)).toBe(true);

    // Pause stops auto-advance but keeps the panel open.
    await page.evaluate(() => window.__SIM__.tour.pause());
    expect(await page.evaluate(() => window.__SIM__.tour.playing)).toBe(false);
    await expect(panel).toBeVisible();
  });

  test('D3-5. compartir + restaurar con consola limpia', async ({ page }) => {
    test.setTimeout(60_000);
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
      window.__SIM__.setDemand(2000);
      window.__SIM__.setTimeOfDay(8);
    });
    const url = await page.evaluate(() => window.__SIM__.share.url());
    await page.goto(url);
    await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.__SIM__.sim.demand === 2000, null, {
      timeout: 15_000,
    });
    await page.waitForTimeout(3_000);
    expect(errors).toEqual([]);
  });
});
