// v3-obras.png: closed street with cones + hazard stripes + rerouted traffic,
// heatmap ON. Standalone (no test runner) against :5174.
import { chromium } from '@playwright/test';

const url = `http://localhost:${process.env.SIM_PORT || 5174}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.goto(url);
await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready, null, { timeout: 30000 });
await page.evaluate(() => {
  window.__SIM__.setSimSpeed(4);
  window.__SIM__.setDemand(5000);
});
// Load the network so the heatmap has contrast.
await page.waitForFunction(() => window.__SIM__.time > 60, null, { timeout: 90000 });

// Close the best interior edge + heatmap on.
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
  S.closeEdge(best.id);
  S.setHeatmap(true);
  return { id: best.id, twinId: best.twinId };
});
console.log('closed:', ids);

// Short settle: queues at the junction are still visible while rerouting.
await page.waitForTimeout(2500);

// Frame the closure: junction node (cone barriers + rerouting traffic) in the
// foreground, striped closed road receding behind it.
await page.evaluate((arg) => {
  const S = window.__SIM__;
  const edge = S.network.edges.get(arg.id);
  const lane = edge.lanes[0];
  const node = S.network.nodes.get(edge.toNode);
  const ny = node.elev || 0;
  const h = lane.headingAt(lane.length); // unit travel direction at the barrier
  const view = S.view;
  // Look from the side of the road, slightly behind the junction.
  view.controls.target.set(node.x - h.x * 10, ny, node.z - h.z * 10);
  view.camera.position.set(
    node.x + h.x * 14 - h.z * 17,
    ny + 16,
    node.z + h.z * 14 + h.x * 17
  );
  view.controls.update();
}, ids);
await page.waitForTimeout(1200);

await page.screenshot({ path: 'docs/screenshots/v3-obras.png' });
console.log('saved docs/screenshots/v3-obras.png');

// Cleanup so the shared dev server returns to a pristine state.
await page.evaluate((arg) => {
  window.__SIM__.openEdge(arg.id);
  window.__SIM__.setHeatmap(false);
  window.__SIM__.setDemand(2400);
  window.__SIM__.setSimSpeed(1);
}, ids);
await browser.close();
