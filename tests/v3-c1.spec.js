// V3 C1 e2e — «Obras e incidentes» (spec §5). Closures: flag both twins,
// step-start routing rebuild (routingVersion++), vehicles drain off the closed
// pair, hazard stripes survive heatmap toggles, reopen restores the exact
// all-white attribute (test-7 contract). Incidents: phantom vehicle lives ONLY
// in lane.vehicles (D1), queue forms behind it, everything expires clean.

import { test, expect } from '@playwright/test';

const OFFLINE_ERROR_RE =
  /net::ERR|Failed to load resource|overpass|nominatim|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

async function gotoAndWaitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, {
    timeout: 30_000,
  });
}

/**
 * Pick the longest interior twin-paired edge that is NOT the space-time
 * corridor and carries NO detector (spec §5) — closing it must not starve
 * the F4 panel or the detector metrics the other suites assert on.
 */
async function pickClosableEdge(page) {
  return page.evaluate(() => {
    const S = window.__SIM__;
    const net = S.network;
    const corridorName = S.spaceTime.corridorName;
    let best = null;
    for (const e of net.edges.values()) {
      if (e.twinId == null || e.twinId < e.id) continue; // one per pair
      if (corridorName && e.name === corridorName) continue;
      const twin = net.edges.get(e.twinId);
      if (!twin || !e.lanes.length || !twin.lanes.length) continue;
      if (e.lanes[0]._det || twin.lanes[0]._det) continue; // keep detectors alive
      const fromN = net.nodes.get(e.fromNode);
      const toN = net.nodes.get(e.toNode);
      if (!fromN || !toN || fromN.legCount < 2 || toN.legCount < 2) continue; // interior
      if (!best || e.lengthM > best.lengthM) best = e;
    }
    return best ? { id: best.id, twinId: best.twinId, name: best.name } : null;
  });
}

/** Per-range vertex-color stats computed in-page (ranges hold cyclic refs). */
async function rangeStats(page, ids) {
  return page.evaluate((arg) => {
    const st = window.__SIM__.heatmap;
    const a = st.colors;
    let closedRange = null;
    let otherRange = null;
    for (const rg of st.ranges) {
      const hit =
        rg.edge.id === arg.id ||
        rg.edge.id === arg.twinId ||
        (rg.twin && (rg.twin.id === arg.id || rg.twin.id === arg.twinId));
      if (hit) closedRange = rg;
      else if (!otherRange || rg.vertCount > otherRange.vertCount) otherRange = rg;
    }
    const stats = (rg) => {
      const distinct = new Set();
      let nonWhite = 0;
      const end = rg.vertStart + rg.vertCount;
      for (let v = rg.vertStart; v < end; v++) {
        const p = v * 3;
        distinct.add(`${a[p]},${a[p + 1]},${a[p + 2]}`);
        if (a[p] !== 1 || a[p + 1] !== 1 || a[p + 2] !== 1) nonWhite++;
      }
      return { distinct: distinct.size, nonWhite, verts: rg.vertCount };
    };
    return {
      enabled: st.enabled,
      closed: closedRange ? stats(closedRange) : null,
      other: otherRange ? stats(otherRange) : null,
    };
  }, ids);
}

test.describe('V3 C1 — Obras e incidentes', () => {
  test('1. cierre: banderas + rebuild de rutas + drenaje + estriado + reapertura all-white', async ({
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
    await page.evaluate(() => window.__SIM__.setSimSpeed(4));
    await page.waitForFunction(() => window.__SIM__.vehicleCount > 20, null, {
      timeout: 60_000,
    });

    const ids = await pickClosableEdge(page);
    expect(ids).not.toBeNull();

    // --- closeEdge: both twins flagged, coalesced rebuild bumps routingVersion.
    const before = await page.evaluate(() => window.__SIM__.routingVersion);
    const affected = await page.evaluate((id) => window.__SIM__.closeEdge(id), ids.id);
    expect(affected).toContain(ids.id);
    expect(affected).toContain(ids.twinId);
    const flags = await page.evaluate((arg) => {
      const closed = [...window.__SIM__.closedEdges];
      return { has: closed.includes(arg.id) && closed.includes(arg.twinId), n: closed.length };
    }, ids);
    expect(flags.has).toBe(true);
    expect(flags.n).toBe(2);
    await page.waitForFunction((rv) => window.__SIM__.routingVersion > rv, before, {
      timeout: 30_000,
    });

    // --- Visual, heatmap OFF: closed range striped (>= 2 colors, none white),
    // open ranges uniform per-vertex asphalt (material went white — D3).
    let vis = await rangeStats(page, ids);
    expect(vis.closed).not.toBeNull();
    expect(vis.closed.nonWhite).toBe(vis.closed.verts);
    expect(vis.closed.distinct).toBeGreaterThanOrEqual(2);
    expect(vis.other.distinct).toBe(1); // uniform asphalt fill
    expect(vis.other.nonWhite).toBe(vis.other.verts); // asphalt RGB, not white

    // --- Heatmap ON: ramp paints open ranges, stripes survive (updateHeatmap
    // skips closed ranges); then OFF again: stripes still there (D3).
    await page.evaluate(() => window.__SIM__.setHeatmap(true));
    await page.waitForTimeout(2_500); // let a couple of 1 Hz repaints land
    vis = await rangeStats(page, ids);
    expect(vis.enabled).toBe(true);
    expect(vis.closed.distinct).toBeGreaterThanOrEqual(2); // still striped
    await page.evaluate(() => window.__SIM__.setHeatmap(false));
    vis = await rangeStats(page, ids);
    expect(vis.enabled).toBe(false);
    expect(vis.closed.distinct).toBeGreaterThanOrEqual(2); // closures survive toggles

    // --- Drain: within 60 sim-s nobody remains on the closed pair (connectors
    // lack edgeId so they are naturally excluded) and the sim stays populated.
    const t0 = await page.evaluate(() => window.__SIM__.time);
    await page.waitForFunction(
      (arg) => {
        const S = window.__SIM__;
        if (S.time > arg.t0 + 60) return 'timeout';
        const clear = S.sim.vehicles.every(
          (v) => v.seg.edgeId !== arg.id && v.seg.edgeId !== arg.twinId
        );
        return clear && S.vehicleCount > 20 ? 'ok' : false;
      },
      { id: ids.id, twinId: ids.twinId, t0 },
      { timeout: 60_000 }
    );
    const drained = await page.evaluate((arg) => {
      const S = window.__SIM__;
      return {
        onClosed: S.sim.vehicles.filter(
          (v) => v.seg.edgeId === arg.id || v.seg.edgeId === arg.twinId
        ).length,
        count: S.vehicleCount,
      };
    }, ids);
    expect(drained.onClosed).toBe(0);
    expect(drained.count).toBeGreaterThan(20);

    // --- openEdge: exact all-white attribute restored (test-7 contract).
    const reopened = await page.evaluate((id) => window.__SIM__.openEdge(id), ids.id);
    expect(reopened).toContain(ids.id);
    const allWhite = await page.evaluate(() => {
      const S = window.__SIM__;
      if ([...S.closedEdges].length !== 0) return false;
      const a = S.heatmap.colors;
      for (let i = 0; i < a.length; i++) if (a[i] !== 1) return false;
      return true;
    });
    expect(allWhite).toBe(true);

    expect(errors).toEqual([]);
  });

  test('2. incidente: fantasma solo en lane.vehicles, cola detrás y expiración limpia', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await gotoAndWaitReady(page);
    await page.evaluate(() => {
      window.__SIM__.setSimSpeed(4);
      window.__SIM__.setDemand(5000);
    });
    // Warm-up: a loaded network guarantees followers for the queue assert.
    await page.waitForFunction(
      () => window.__SIM__.time > 40 && window.__SIM__.vehicleCount > 20,
      null,
      { timeout: 90_000 }
    );

    // Long incident first: a stable observation window for the queue assert
    // (a 30 sim-s one expires ~7.5 s wall after trigger @4x — too racy).
    // Lane picked via the official opts.laneId path (same as the GUI
    // follow-mode button), on a SINGLE-LANE fed street with vehicles already
    // approaching: with no sibling lane MOBIL can't drain the followers, so
    // the standstill queue is deterministic (on 2-lane edges followers
    // legitimately overtake until the edge saturates — that can take 100+
    // sim-s; the overtake itself is asserted on a separate incident below).
    const rec = await page.evaluate(() => {
      const S = window.__SIM__;
      const cands = [];
      for (const e of S.network.edges.values()) {
        if (e._closed || e.lanes.length !== 1) continue;
        const l = e.lanes[0];
        if (l.length < 50 || l._inConnCount === 0) continue;
        let upHalf = 0;
        for (const v of l.vehicles) if (!v.isPhantom && v.s < l.length / 2) upHalf++;
        if (upHalf >= 1) cands.push({ id: l.id, score: upHalf });
      }
      cands.sort((a, b) => b.score - a.score);
      for (const c of cands.slice(0, 8)) {
        const r = S.triggerIncident({ durationS: 600, laneId: c.id });
        if (!r) continue;
        const lane = S.network.lanes.get(r.laneId);
        if (lane.vehicles.some((v) => !v.isPhantom && v.s < r.s)) return r; // follower upstream NOW
        S.clearIncidents(); // phantom landed ahead of everyone — try the next lane
      }
      return S.triggerIncident({ durationS: 600 }); // fallback: weighted pick
    });
    expect(rec).not.toBeNull();
    expect(rec.laneId).toBeTruthy();
    expect(rec.s).toBeGreaterThan(0);

    // D1: exactly one incident; phantom IS in lane.vehicles, NOT in vehicles[].
    const membership = await page.evaluate((arg) => {
      const S = window.__SIM__;
      const lane = S.network.lanes.get(arg.laneId);
      return {
        incidentCount: S.incidents.length,
        inLane: lane.vehicles.some((v) => v.isPhantom && v.id === arg.id),
        inMaster: S.sim.vehicles.some((v) => v.isPhantom),
        laneCount: S.network.edges.get(arg.edgeId).lanes.length,
      };
    }, rec);
    expect(membership.incidentCount).toBe(1);
    expect(membership.inLane).toBe(true);
    expect(membership.inMaster).toBe(false);

    // Queue forms behind the phantom (IDM): some real vehicle upstream at
    // near-standstill while the blockage lives.
    await page.waitForFunction(
      (arg) => {
        const S = window.__SIM__;
        const lane = S.network.lanes.get(arg.laneId);
        if (!lane) return false;
        return lane.vehicles.some((v) => !v.isPhantom && v.s < arg.s && v.v < 0.5);
      },
      rec,
      { timeout: 60_000 }
    );

    // Multi-lane => overtaking emerges via MOBIL (SOFT assert per spec §5:
    // logged, not failed — light sibling traffic can miss the window). A
    // SECOND incident on a fed multi-lane street exercises exactly that.
    const rec2 = await page.evaluate(() => {
      const S = window.__SIM__;
      let best = null;
      let bestScore = -1;
      for (const e of S.network.edges.values()) {
        if (e._closed || e.lanes.length < 2) continue;
        for (const l of e.lanes) {
          if (l.length < 50 || l._inConnCount === 0) continue;
          const score = l._inConnCount * 2 + l.vehicles.length;
          if (score > bestScore) {
            bestScore = score;
            best = l.id;
          }
        }
      }
      return best ? S.triggerIncident({ durationS: 600, laneId: best }) : null;
    });
    if (rec2) {
      const overtook = await page
        .waitForFunction(
          (arg) => {
            const S = window.__SIM__;
            const edge = S.network.edges.get(arg.edgeId);
            for (const lane of edge.lanes) {
              if (lane.id === arg.laneId) continue;
              for (const v of lane.vehicles) {
                if (!v.isPhantom && Math.abs(v.s - arg.s) < 8 && v.v > 1) return true;
              }
            }
            return false;
          },
          rec2,
          { timeout: 15_000 }
        )
        .then(() => true)
        .catch(() => false);
      console.log(`[v3-c1] adelantamiento observado: ${overtook}`);
    }

    // Expiry lifecycle on a fresh SHORT incident (the observation ones are
    // cleared first — clearIncidents must wipe them all instantly):
    const rec3 = await page.evaluate(() => {
      const S = window.__SIM__;
      S.clearIncidents();
      if (S.incidents.length !== 0) return null; // clearIncidents failed
      return S.triggerIncident({ durationS: 20 });
    });
    expect(rec3).not.toBeNull();
    // Zero incidents, zero phantoms anywhere once `until` passes.
    await page.waitForFunction(
      (arg) => {
        const S = window.__SIM__;
        const lane = S.network.lanes.get(arg.laneId);
        return (
          S.incidents.length === 0 &&
          !lane.vehicles.some((v) => v.isPhantom) &&
          !S.sim.vehicles.some((v) => v.isPhantom)
        );
      },
      rec3,
      { timeout: 60_000 }
    );
    const finalCount = await page.evaluate(() => window.__SIM__.vehicleCount);
    expect(finalCount).toBeGreaterThan(20);
  });
});
