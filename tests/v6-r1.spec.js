// V6 R1 e2e — «Ruteo sensible a congestión» (congestion-sensitive routing).
// Default OFF: routing uses the unchanged free-flow tables (zero behavioral
// change — no periodic rebuilds, no congestion swaps). Enabling the flag
// schedules congestion-weighted rebuilds on a sim-time cadence (reusing the
// budgeted closure-rebuild machinery) that bump routingVersion and increment
// congestionRebuilds, while the sim stays healthy (vehicles keep moving, no
// NaN positions, no console errors). Toggling OFF restores free-flow routing
// (one final swap, then no further congestion rebuilds).
//
// Everything is driven through window.__SIM__ (the only sim entry point the
// suite uses). Port 5173; plain `npx playwright test v6-r1`.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

/** All live (non-phantom) vehicle world positions finite? Catches NaN drift. */
async function positionsFinite(page) {
  return page.evaluate(() => {
    const S = window.__SIM__;
    for (const v of S.sim.vehicles) {
      if (v.isPhantom) continue;
      const p = v.seg.posAt(v.s);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        return false;
      }
      if (!Number.isFinite(v.v) || !Number.isFinite(v.s)) return false;
    }
    return true;
  });
}

test.describe('V6 R1 — Ruteo sensible a congestión', () => {
  test('1. default OFF = free-flow (sin rebuilds de congestión); ON dispara rebuilds ponderados; OFF restaura', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !OFFLINE_ERROR_RE.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      if (!OFFLINE_ERROR_RE.test(String(err))) errors.push(String(err));
    });

    await gotoAndWaitReady(page);

    // --- (a) DEFAULT OFF: the flag is off and NO congestion machinery runs.
    const off0 = await page.evaluate(() => ({
      flag: window.__SIM__.congestionRouting,
      rebuilds: window.__SIM__.congestionRebuilds,
    }));
    expect(off0.flag).toBe(false);
    expect(off0.rebuilds).toBe(0);

    // Drive demand + speed, then let a good chunk of SIM time pass with the
    // flag OFF: routingVersion must NOT advance from periodic rebuilds (free
    // flow is untouched) and congestionRebuilds must stay 0. This is the
    // "zero behavioral change when OFF" contract — the rebuild cadence is
    // 15 sim-s, so 50 sim-s would yield 3+ swaps if it (wrongly) ran while OFF.
    await page.evaluate(() => {
      window.__SIM__.setSimSpeed(8);
      window.__SIM__.setDemand(6000);
    });
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 20, null, {
      timeout: 60_000,
    });
    const rvBeforeIdle = await page.evaluate(() => window.__SIM__.routingVersion);
    const tIdle0 = await page.evaluate(() => window.__SIM__.time);
    await page.waitForFunction((t0) => window.__SIM__.time > t0 + 50, tIdle0, {
      timeout: 90_000,
    });
    const idle = await page.evaluate((rv) => ({
      rebuilds: window.__SIM__.congestionRebuilds,
      rvDelta: window.__SIM__.routingVersion - rv,
      flag: window.__SIM__.congestionRouting,
    }), rvBeforeIdle);
    expect(idle.flag).toBe(false);
    expect(idle.rebuilds).toBe(0); // no congestion swaps while OFF
    expect(idle.rvDelta).toBe(0); // no spurious routing rebuilds at all
    expect(await positionsFinite(page)).toBe(true);

    // --- (b) ENABLE: setter flips the flag and schedules a rebuild on the next
    // cadence tick. With heavy demand the network congests, so the periodic
    // rebuild reweights edges. Assert: flag ON, congestionRebuilds climbs,
    // routingVersion advances, vehicles keep flowing, positions finite.
    const rvBeforeOn = await page.evaluate(() => window.__SIM__.routingVersion);
    await page.evaluate(() => window.__SIM__.setCongestionRouting(true));
    expect(await page.evaluate(() => window.__SIM__.congestionRouting)).toBe(true);

    // First congestion rebuild lands quickly (timer reset to `time` on enable).
    await page.waitForFunction(() => window.__SIM__.congestionRebuilds >= 1, null, {
      timeout: 60_000,
    });
    // Let the periodic cadence fire several more times (cadence 15 sim-s).
    await page.waitForFunction(() => window.__SIM__.congestionRebuilds >= 3, null, {
      timeout: 90_000,
    });
    const onState = await page.evaluate((rv) => ({
      rebuilds: window.__SIM__.congestionRebuilds,
      rvDelta: window.__SIM__.routingVersion - rv,
      count: window.__SIM__.vehicleCount,
    }), rvBeforeOn);
    expect(onState.rebuilds).toBeGreaterThanOrEqual(3);
    expect(onState.rvDelta).toBeGreaterThanOrEqual(3); // each swap bumps routingVersion
    expect(onState.count).toBeGreaterThan(20);
    expect(await positionsFinite(page)).toBe(true);

    // Non-vacuous: real congestion exists (some edge's _speedRatio EWMA well
    // below free flow), so the penalty is genuinely active rather than a no-op
    // multiply-by-1. minSpeedRatio < ~0.9 means at least one edge is slowed.
    expect(await page.evaluate(() => window.__SIM__.minSpeedRatio)).toBeLessThan(0.9);

    // Routing stays healthy after repeated weighted rebuilds: one next-hop
    // table per exit. Together with slowed>0 (real congestion the penalty acts
    // on) this makes the rebuild non-vacuous — the penalty multiplies real
    // sub-1 ratios, not a network where every edge is free flow (penalty 1).
    const health = await page.evaluate(() => {
      const net = window.__SIM__.network;
      const live = net.routing; // = congestion-weighted tables right now
      let slowed = 0;
      for (const e of net.edges.values()) if ((e._speedRatio ?? 1) < 0.9) slowed++;
      return { slowed, tableCount: live.tables.size, exitCount: live.exits.length };
    });
    expect(health.slowed).toBeGreaterThan(0); // genuine congestion to route around
    expect(health.tableCount).toBe(health.exitCount); // one table per exit (healthy)

    // Sim stays alive: vehicles keep moving (some non-trivial speed present)
    // across a window while congestion routing is active.
    const moving = await page.evaluate(() => {
      const S = window.__SIM__;
      return S.sim.vehicles.some((v) => !v.isPhantom && v.v > 1);
    });
    expect(moving).toBe(true);

    // --- (c) DISABLE: setter flips off, does ONE free-flow restore swap, then
    // the congestion cadence never fires again. Assert congestionRebuilds
    // freezes over a full cadence window and the flag is OFF.
    await page.evaluate(() => window.__SIM__.setCongestionRouting(false));
    expect(await page.evaluate(() => window.__SIM__.congestionRouting)).toBe(false);
    const rebuildsAtOff = await page.evaluate(() => window.__SIM__.congestionRebuilds);
    const tOff0 = await page.evaluate(() => window.__SIM__.time);
    // Wait > 2 cadence periods of sim-time: if congestion (wrongly) kept
    // rebuilding, congestionRebuilds would climb past rebuildsAtOff.
    await page.waitForFunction((t0) => window.__SIM__.time > t0 + 40, tOff0, {
      timeout: 90_000,
    });
    const afterOff = await page.evaluate(() => ({
      rebuilds: window.__SIM__.congestionRebuilds,
      count: window.__SIM__.vehicleCount,
      flag: window.__SIM__.congestionRouting,
    }));
    expect(afterOff.flag).toBe(false);
    expect(afterOff.rebuilds).toBe(rebuildsAtOff); // no further congestion swaps
    expect(afterOff.count).toBeGreaterThan(20);
    expect(await positionsFinite(page)).toBe(true);

    expect(errors).toEqual([]);
  });
});
