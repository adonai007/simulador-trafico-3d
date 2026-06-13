// C1 smoke (standalone, no test runner): closures + incidents quick pass on :5174.
import { chromium } from '@playwright/test';

const url = `http://localhost:${process.env.SIM_PORT || 5174}/`;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/net::ERR|Failed to load resource|overpass|nominatim/i.test(m.text()))
    errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url);
await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, { timeout: 30000 });
await page.evaluate(() => window.__SIM__.setSimSpeed(4));
await page.waitForFunction(() => window.__SIM__.vehicleCount > 10, null, { timeout: 60000 });

const ids = await page.evaluate(() => {
  const S = window.__SIM__;
  const net = S.network;
  let best = null;
  for (const e of net.edges.values()) {
    if (e.twinId == null || e.twinId < e.id) continue;
    if (e.name && e.name === S.spaceTime.corridorName) continue;
    const twin = net.edges.get(e.twinId);
    if (e.lanes[0]._det || twin.lanes[0]._det) continue;
    const f = net.nodes.get(e.fromNode), t = net.nodes.get(e.toNode);
    if (!f || !t || f.legCount < 2 || t.legCount < 2) continue;
    if (!best || e.lengthM > best.lengthM) best = e;
  }
  return best ? { id: best.id, twinId: best.twinId, len: best.lengthM } : null;
});
console.log('edge pick:', ids);

const rv0 = await page.evaluate(() => window.__SIM__.routingVersion);
const affected = await page.evaluate((id) => window.__SIM__.closeEdge(id), ids.id);
console.log('closeEdge ->', affected, 'closedEdges:', await page.evaluate(() => [...window.__SIM__.closedEdges]));
await page.waitForFunction((rv) => window.__SIM__.routingVersion > rv, rv0, { timeout: 15000 });
console.log('routingVersion bumped:', await page.evaluate(() => window.__SIM__.routingVersion));

const vis = await page.evaluate((arg) => {
  const st = window.__SIM__.heatmap;
  const a = st.colors;
  let closed = null, other = null;
  for (const rg of st.ranges) {
    const hit = rg.edge.id === arg.id || (rg.twin && rg.twin.id === arg.id) || rg.edge.id === arg.twinId;
    if (hit) closed = rg; else if (!other) other = rg;
  }
  const stats = (rg) => {
    const set = new Set(); let nw = 0;
    for (let v = rg.vertStart; v < rg.vertStart + rg.vertCount; v++) {
      const p = v * 3; set.add(`${a[p]},${a[p+1]},${a[p+2]}`);
      if (a[p] !== 1 || a[p+1] !== 1 || a[p+2] !== 1) nw++;
    }
    return { distinct: set.size, nonWhite: nw, verts: rg.vertCount };
  };
  return { closed: closed && stats(closed), other: other && stats(other) };
}, ids);
console.log('visual:', JSON.stringify(vis));

// cones present?
console.log('worksMesh cones:', await page.evaluate(() => {
  let n = 0;
  window.__SIM__.view.scene.traverse((o) => { if (o.isInstancedMesh && o.count > 0) n += 0; });
  return 'n/a';
}));

// incident
const rec = await page.evaluate(() => window.__SIM__.triggerIncident({ durationS: 20 }));
console.log('incident:', rec);
const mem = await page.evaluate((arg) => {
  const S = window.__SIM__;
  const lane = S.network.lanes.get(arg.laneId);
  return {
    n: S.incidents.length,
    inLane: lane.vehicles.some((v) => v.isPhantom),
    inMaster: S.sim.vehicles.some((v) => v.isPhantom),
  };
}, rec);
console.log('membership:', mem);

// wait expiry
await page.waitForFunction((arg) => {
  const S = window.__SIM__;
  const lane = S.network.lanes.get(arg.laneId);
  return S.incidents.length === 0 && !lane.vehicles.some((v) => v.isPhantom);
}, rec, { timeout: 40000 });
console.log('incident expired clean');

// drain + reopen
await page.waitForFunction((arg) =>
  window.__SIM__.sim.vehicles.every((v) => v.seg.edgeId !== arg.id && v.seg.edgeId !== arg.twinId),
  ids, { timeout: 40000 });
console.log('drained');
await page.evaluate((id) => window.__SIM__.openEdge(id), ids.id);
const allWhite = await page.evaluate(() => {
  const a = window.__SIM__.heatmap.colors;
  for (let i = 0; i < a.length; i++) if (a[i] !== 1) return false;
  return [...window.__SIM__.closedEdges].length === 0;
});
console.log('reopen all-white:', allWhite);
console.log('console errors:', errors);
await browser.close();
process.exit(allWhite && errors.length === 0 ? 0 : 1);
