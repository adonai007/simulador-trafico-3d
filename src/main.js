// Bootstrap: load bundled network -> build world (network+sim+render) ->
// UI layer (GUI/HUD/chart/follow/explainer/search) -> fixed-step RAF loop with
// §2.1 render interpolation. Live map search tears the world down and rebuilds
// it in place (every render module exposes dispose()); the scene/camera/UI
// survive swaps.

import { CONFIG } from './config.js';
import { buildNetwork } from './network/build.js';
import { createScene } from './render/scene.js';
import { buildRoadMesh } from './render/roadMesh.js';
import { createDebugOverlay } from './render/debug.js';
import { createSignalsMesh } from './render/signalsMesh.js';
import { createVehiclesMesh } from './render/vehiclesMesh.js';
import { addBuildings } from './render/buildings.js';
import { createPicking } from './render/picking.js';
import { createSimulation } from './sim/simulation.js';
import { createGui } from './ui/gui.js';
import { createHud } from './ui/hud.js';
import { createChart } from './ui/chart.js';
import { createFollow } from './ui/follow.js';
import { initExplainer } from './ui/explainer.js';
import { createSearch, showToast } from './ui/search.js';

window.__SIM__ = { ready: false };

const DT = CONFIG.sim.dt;

// app.world is the swappable unit: network + sim + all per-network meshes.
const app = { view: null, world: null };

/** Camera-fit bbox: clamp to the query radius so boundary stubs don't zoom us out. */
function clampBbox(bbox, r) {
  return {
    minX: Math.max(bbox.minX, -r),
    maxX: Math.min(bbox.maxX, r),
    minZ: Math.max(bbox.minZ, -r),
    maxZ: Math.min(bbox.maxZ, r),
  };
}

/** Build sim + meshes for an already-validated network and add them to the scene. */
function makeWorld(network, radiusM) {
  const view = app.view;
  const roads = buildRoadMesh(network);
  view.scene.add(roads.group);
  const debug = createDebugOverlay(network);
  view.scene.add(debug.group);
  const signalsMesh = createSignalsMesh(network);
  view.scene.add(signalsMesh.group);
  const sim = createSimulation(network);
  const vehiclesMesh = createVehiclesMesh(sim);
  view.scene.add(vehiclesMesh.mesh);

  const world = {
    network,
    sim,
    roads,
    debug,
    signalsMesh,
    vehiclesMesh,
    buildings: null,
    radiusM,
    dispose() {
      view.scene.remove(roads.group);
      roads.dispose();
      view.scene.remove(debug.group);
      debug.dispose();
      view.scene.remove(signalsMesh.group);
      signalsMesh.dispose();
      view.scene.remove(vehiclesMesh.mesh);
      vehiclesMesh.dispose();
      if (world.buildings) {
        world.buildings.dispose();
        world.buildings = null;
      }
      network.dispose();
    },
  };

  console.info(
    `[sim] red lista: ${network.edges.size} aristas, ${network.lanes.size} carriles, ` +
      `${network.connectors.size} conectores, ${network.signals.size} cruces semaforizados, ` +
      `${network.entries.length} entradas, ${network.exits.length} salidas (${network.spawnMode})`
  );
  return world;
}

/** Fire-and-forget buildings; dropped if the world was swapped while fetching. */
function attachBuildings(world, opts) {
  addBuildings(app.view.scene, opts)
    .then((b) => {
      if (app.world === world) world.buildings = b;
      else b.dispose();
    })
    .catch((err) => console.warn('[buildings] fallo:', err));
}

let acc = 0; // fixed-timestep accumulator (reset on world swap)

async function init() {
  const res = await fetch('/data/default-network.json');
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const osm = await res.json();

  const network = buildNetwork(osm, CONFIG.defaultCenter);
  const r = CONFIG.defaultRadiusM;
  app.view = createScene(document.getElementById('app'), clampBbox(network.bbox, r));
  app.world = makeWorld(network, r);
  attachBuildings(app.world, null); // bundled snapshot

  // ---- UI layer ----
  initExplainer();
  const gui = createGui(app);
  const hud = createHud(app);
  const chart = createChart(app);
  const follow = createFollow(app);
  createPicking(
    app.view,
    () => app.world && app.world.vehiclesMesh,
    (veh) => {
      if (veh) follow.follow(veh);
      else follow.stop();
    }
  );

  /** Full teardown/rebuild for the map search. Returns false -> keep current. */
  async function rebuildWorld(newOsm, center, radiusM) {
    let wayCount = 0;
    for (const el of newOsm.elements || []) if (el.type === 'way') wayCount++;
    if (wayCount < CONFIG.minKeptWays) return false;
    let network2;
    try {
      network2 = buildNetwork(newOsm, center);
    } catch (err) {
      console.warn('[rebuild] buildNetwork failed:', err);
      return false;
    }
    if (network2.edges.size < CONFIG.minCoreEdges) return false;

    follow.stop();
    const old = app.world;
    app.world = null; // RAF idles during the swap
    acc = 0;
    if (old) old.dispose();
    app.view.frame(clampBbox(network2.bbox, radiusM));
    const world = makeWorld(network2, radiusM);
    app.world = world;
    gui.applyTo(world); // user's demand/speed/cycle settings carry over
    hud.reset();
    attachBuildings(world, { lat: center.lat, lon: center.lon, radius: radiusM });
    return true;
  }
  createSearch(rebuildWorld);

  // ---- Test hook (spec §7 + sim controls §2.1) ----
  window.__SIM__ = {
    get ready() {
      return !!app.world;
    },
    get network() {
      return app.world ? app.world.network : null;
    },
    get sim() {
      return app.world ? app.world.sim : null;
    },
    get networkCenter() {
      const n = app.world ? app.world.network : null;
      return n ? { lat: n.center.lat, lon: n.center.lon } : null;
    },
    get time() {
      return app.world ? app.world.sim.time : 0;
    },
    get vehicleCount() {
      return app.world ? app.world.sim.vehicleCount : 0;
    },
    get metrics() {
      return app.world ? app.world.sim.metrics : null;
    },
    get simSpeed() {
      return app.world ? app.world.sim.simSpeed : 1;
    },
    get paused() {
      return app.world ? app.world.sim.paused : false;
    },
    sampleVehicle: () => (app.world ? app.world.sim.sampleVehicle() : null),
    setDemand: (vph) => app.world && app.world.sim.setDemand(vph),
    setSimSpeed: (x) => app.world && app.world.sim.setSimSpeed(x),
    setPaused: (p) => app.world && app.world.sim.setPaused(p),
    get debug() {
      return app.world ? app.world.debug : null;
    },
    get chartPoints() {
      return chart.pointCount;
    },
    follow,
    get view() {
      return app.view;
    },
  };

  // ---- Fixed-timestep loop with accumulator + interpolation (spec §2.1) ----
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let wallDt = (now - last) / 1000;
    last = now;
    if (wallDt > 0.25) wallDt = 0.25; // tab was hidden
    const world = app.world;
    if (world) {
      const sim = world.sim;
      acc += wallDt * (sim.paused ? 0 : sim.simSpeed);
      let steps = 0;
      while (acc >= DT && steps < CONFIG.sim.maxStepsPerFrame) {
        sim.step(DT);
        acc -= DT;
        steps++;
      }
      if (steps === CONFIG.sim.maxStepsPerFrame) acc = 0; // drop remainder when capped
      const alpha = Math.min(acc / DT, 1);
      world.signalsMesh.update(sim.time);
      world.vehiclesMesh.update(alpha);
      hud.update();
      chart.update();
      follow.update(alpha, wallDt);
    }
    if (!follow.active) app.view.controls.update();
    app.view.render();
  }
  requestAnimationFrame(frame);
}

init().catch((err) => {
  console.error('[sim] init failed:', err);
  showToast('No se pudo iniciar la simulación. Revisa la consola.', 60000);
});
