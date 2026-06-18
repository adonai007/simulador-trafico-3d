// V5 E2 e2e — Datos: estadísticas + CSV (E2a) + barra de repetición (E2b).
// Runs against the same dev server as e2e.spec.js (SIM_PORT). All work happens
// on the DEFAULT zone (no live Overpass fetch), so the suite is reliable
// offline. Hooks under window.__SIM__:
//   E2a: tripStats, metricsHistory, exportStats(), the «Exportar CSV» button
//   E2b: replay {recording, mode, windowS, frameCount, written, scrubT,
//        minTime, maxTime}, setReplayMode(b), setReplayScrub(t),
//        replayFrameCount, replayInstanceSignature(), paused
//
// Two agents own disjoint describe blocks here (E2a appends its own block).

import { test, expect } from '@playwright/test';

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

/** Fast-forward the sim to at least `targetSimS` seconds of sim time. */
async function runSimTo(page, targetSimS, timeoutMs = 40_000) {
  await page.evaluate(() => window.__SIM__.setSimSpeed(4));
  await page.waitForFunction(
    (t) => window.__SIM__.time >= t,
    targetSimS,
    { timeout: timeoutMs }
  );
}

test.describe('V5 E2b — Barra de repetición (replay scrubber)', () => {
  test('E2b-1. el grabador captura cuadros en vivo (ring sim-time)', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoAndWaitReady(page);

    // Replay starts live (mode OFF) and recording ON.
    const initial = await page.evaluate(() => window.__SIM__.replay);
    expect(initial).not.toBeNull();
    expect(initial.mode).toBe(false);
    expect(initial.recording).toBe(true);
    expect(initial.windowS).toBeGreaterThan(0);

    // After ~30 sim-s the ring holds captured frames (recordHz × ~30 s).
    await runSimTo(page, 30);
    const after = await page.evaluate(() => ({
      recording: window.__SIM__.replay.recording,
      written: window.__SIM__.replay.written,
      frameCount: window.__SIM__.replayFrameCount,
      maxTime: window.__SIM__.replay.maxTime,
    }));
    expect(after.recording).toBe(true);
    expect(after.written).toBeGreaterThan(0);
    expect(after.frameCount).toBeGreaterThan(0); // frames captured so far
    expect(after.maxTime).toBeGreaterThan(0);
  });

  test('E2b-2. entrar a replay congela la simulación; EN VIVO la reanuda', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoAndWaitReady(page);
    await runSimTo(page, 20);

    // Enter replay -> sim hard-paused + render-source flag flips.
    await page.evaluate(() => window.__SIM__.setReplayMode(true));
    const paused = await page.evaluate(() => window.__SIM__.paused);
    const mode = await page.evaluate(() => window.__SIM__.replay.mode);
    const recording = await page.evaluate(() => window.__SIM__.replay.recording);
    expect(paused).toBe(true);
    expect(mode).toBe(true);
    expect(recording).toBe(false); // recording paused while scrubbing

    // The sim clock must not advance while in replay mode.
    const t0 = await page.evaluate(() => window.__SIM__.time);
    await page.waitForTimeout(800);
    const t1 = await page.evaluate(() => window.__SIM__.time);
    expect(t1).toBeCloseTo(t0, 3);

    // EN VIVO -> sim resumes, recording resumes, mode OFF.
    await page.evaluate(() => window.__SIM__.setReplayMode(false));
    const afterPaused = await page.evaluate(() => window.__SIM__.paused);
    const afterMode = await page.evaluate(() => window.__SIM__.replay.mode);
    const afterRec = await page.evaluate(() => window.__SIM__.replay.recording);
    expect(afterPaused).toBe(false);
    expect(afterMode).toBe(false);
    expect(afterRec).toBe(true);
  });

  test('E2b-3. mover el scrubber cambia las matrices de instancia', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    // Enough sim time that vehicles actually move across the window.
    await runSimTo(page, 45);

    // Read the recorded sim-time window to pick two distinct scrub targets.
    const win = await page.evaluate(() => {
      const r = window.__SIM__.replay;
      return { lo: r.minTime, hi: r.maxTime };
    });
    expect(win.hi).toBeGreaterThan(win.lo);
    const t1 = win.lo + (win.hi - win.lo) * 0.2;
    const t2 = win.lo + (win.hi - win.lo) * 0.8;

    // Enter replay and scrub to t1; let one RAF frame render the ring.
    await page.evaluate((t) => {
      window.__SIM__.setReplayMode(true);
      window.__SIM__.setReplayScrub(t);
    }, t1);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const sig1 = await page.evaluate(() => window.__SIM__.replayInstanceSignature());

    // Scrub to t2; render again; signatures must differ (positions changed).
    await page.evaluate((t) => window.__SIM__.setReplayScrub(t), t2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const sig2 = await page.evaluate(() => window.__SIM__.replayInstanceSignature());

    expect(Number.isFinite(sig1)).toBe(true);
    expect(Number.isFinite(sig2)).toBe(true);
    // Non-trivial scene (vehicles present) and the two scrub poses differ.
    expect(Math.abs(sig1)).toBeGreaterThan(0);
    expect(sig1).not.toBeCloseTo(sig2, 2);

    await page.evaluate(() => window.__SIM__.setReplayMode(false));
  });

  test('E2b-4. el scrub respeta los límites de la ventana (sin extrapolar)', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoAndWaitReady(page);
    await runSimTo(page, 35);

    const win = await page.evaluate(() => {
      const r = window.__SIM__.replay;
      return { lo: r.minTime, hi: r.maxTime };
    });
    // Scrub far before the oldest and far after the newest — must not throw and
    // must still produce a finite render signature (clamped to the edge frame).
    await page.evaluate(() => window.__SIM__.setReplayMode(true));
    await page.evaluate((lo) => window.__SIM__.setReplayScrub(lo - 9999), win.lo);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const sigLo = await page.evaluate(() => window.__SIM__.replayInstanceSignature());
    await page.evaluate((hi) => window.__SIM__.setReplayScrub(hi + 9999), win.hi);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const sigHi = await page.evaluate(() => window.__SIM__.replayInstanceSignature());
    expect(Number.isFinite(sigLo)).toBe(true);
    expect(Number.isFinite(sigHi)).toBe(true);
    await page.evaluate(() => window.__SIM__.setReplayMode(false));
  });

  test('E2b-5. la barra de repetición existe con sus controles en español', async ({ page }) => {
    test.setTimeout(60_000);
    await gotoAndWaitReady(page);
    const bar = page.locator('#replay');
    await expect(bar).toBeVisible();
    await expect(page.locator('#replay-slider')).toBeVisible();
    await expect(page.locator('#replay-live')).toHaveText('EN VIVO');
    await expect(page.locator('#replay-rec')).toContainText('REC');
  });
});

test.describe('V5 E2a — Estadísticas + CSV', () => {
  test('E2a-1. tripStats acumula viajes completados con demora y tiempo medio', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);

    // Fresh world: nothing completed yet.
    const start = await page.evaluate(() => window.__SIM__.tripStats);
    expect(start).not.toBeNull();
    expect(start.viajesCompletados).toBe(0);

    // ~60 sim-s at high speed: vehicles spawn, traverse, and exit-despawn.
    await runSimTo(page, 60, 60_000);
    const ts = await page.evaluate(() => window.__SIM__.tripStats);
    expect(ts.viajesCompletados).toBeGreaterThan(0);
    expect(ts.tiempoMedioViaje).toBeGreaterThan(0); // mean trip time > 0
    expect(ts.demoraMedia).toBeGreaterThanOrEqual(0); // delay = max(0, ...)
    expect(ts.demoraTotal).toBeGreaterThanOrEqual(0);
    expect(ts.velocidadMedia).toBeGreaterThan(0); // km/h
    expect(ts.rendimiento).toBeGreaterThanOrEqual(0); // veh/min
    // Demora media can never exceed the mean trip time (delay <= tripTime).
    expect(ts.demoraMedia).toBeLessThanOrEqual(ts.tiempoMedioViaje + 1e-6);
  });

  test('E2a-2. metricsHistory crece a lo largo del tiempo (anillo sim-time)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);

    await runSimTo(page, 20, 40_000);
    const c1 = await page.evaluate(() => window.__SIM__.metricsHistory?.count ?? 0);
    expect(c1).toBeGreaterThan(0); // ring filling on the ~2 s gate

    await runSimTo(page, 50, 40_000);
    const c2 = await page.evaluate(() => window.__SIM__.metricsHistory?.count ?? 0);
    expect(c2).toBeGreaterThan(c1); // more samples after more sim time
  });

  test('E2a-3. exportStats() devuelve un CSV con cabecera en español y datos', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    await runSimTo(page, 40, 50_000);

    const csv = await page.evaluate(() => window.__SIM__.exportStats());
    expect(typeof csv).toBe('string');
    const lines = csv.trim().split('\n');
    // Spanish header + at least 2 data rows (metricsHistory sampled every ~2 s).
    expect(lines[0]).toContain('tiempo_s');
    expect(lines[0]).toContain('vel_media_kmh');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Data rows are numeric CSV (first field is the sim-time stamp).
    const firstCell = lines[1].split(',')[0];
    expect(Number.isFinite(Number(firstCell))).toBe(true);
  });

  test('E2a-4. el botón «Exportar CSV» dispara una descarga .csv', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAndWaitReady(page);
    await runSimTo(page, 30, 50_000);

    // The stats panel + its export button are present.
    const panel = page.locator('#stats');
    await expect(panel).toBeVisible();
    const btn = page.locator('#stats-export');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Exportar CSV');

    // Clicking it fires (at least) one browser download whose name ends in .csv.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      btn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('E2a-5. el panel «Estadísticas» muestra las seis filas en español', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoAndWaitReady(page);
    const body = page.locator('#stats-body');
    await expect(page.locator('#stats-header')).toContainText('Estadísticas');
    await expect(body).toContainText('Viajes completados');
    await expect(body).toContainText('Tiempo medio de viaje');
    await expect(body).toContainText('Demora media');
    await expect(body).toContainText('Demora total');
    await expect(body).toContainText('Velocidad media');
    await expect(body).toContainText('Rendimiento');
  });
});
