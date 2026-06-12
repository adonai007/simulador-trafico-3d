// Bootstrap: load bundled network -> build world (network+sim+render) ->
// UI layer (GUI/HUD/chart/follow/explainer/search) -> fixed-step RAF loop with
// §2.1 render interpolation. Live map search tears the world down and rebuilds
// it in place (every render module exposes dispose()); the scene/camera/UI
// survive swaps.

import { CONFIG } from './config.js';
import { buildNetwork } from './network/build.js';
import { fetchNetworkOsm } from './osm/overpass.js';
import { createProjection } from './geo/projection.js';
import {
  FLAT_SAMPLER,
  fetchElevationGrid,
  createElevationSampler,
} from './geo/elevation.js';
import { createScene } from './render/scene.js';
import { buildRoadMesh } from './render/roadMesh.js';
import { createTerrainMesh } from './render/terrainMesh.js';
import { createDebugOverlay } from './render/debug.js';
import { createSignalsMesh } from './render/signalsMesh.js';
import { createVehiclesMesh } from './render/vehiclesMesh.js';
import { createBusStopsMesh } from './render/busStopsMesh.js';
import { createStreetNames } from './render/streetNames.js';
import { addBuildings } from './render/buildings.js';
import { createPicking } from './render/picking.js';
import { createSimulation } from './sim/simulation.js';
import { createGui } from './ui/gui.js';
import { createHud } from './ui/hud.js';
import { createChart } from './ui/chart.js';
import { createSpaceTime } from './ui/spaceTime.js';
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
  // Real terrain replaces the flat ground when elevation data exists (F1).
  let terrain = null;
  if (network.elevation && !network.elevation.flat) {
    terrain = createTerrainMesh(network);
    view.scene.add(terrain.mesh);
  }
  view.setGroundVisible(!terrain);
  const debug = createDebugOverlay(network);
  view.scene.add(debug.group);
  const signalsMesh = createSignalsMesh(network);
  view.scene.add(signalsMesh.group);
  const busStopsMesh = createBusStopsMesh(network);
  view.scene.add(busStopsMesh.group);
  const streetNames = createStreetNames(network); // V2.1 B map-style labels
  view.scene.add(streetNames.group);
  const sim = createSimulation(network);
  const vehiclesMesh = createVehiclesMesh(sim);
  view.scene.add(vehiclesMesh.mesh);

  const world = {
    network,
    sim,
    roads,
    terrain,
    debug,
    signalsMesh,
    busStopsMesh,
    streetNames,
    vehiclesMesh,
    buildings: null,
    radiusM,
    dispose() {
      view.scene.remove(roads.group);
      roads.dispose();
      if (terrain) {
        view.scene.remove(terrain.mesh);
        terrain.dispose();
      }
      view.setGroundVisible(true);
      view.scene.remove(debug.group);
      debug.dispose();
      view.scene.remove(signalsMesh.group);
      signalsMesh.dispose();
      view.scene.remove(busStopsMesh.group);
      busStopsMesh.dispose();
      view.scene.remove(streetNames.group);
      streetNames.dispose();
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
  addBuildings(app.view.scene, opts, world.network.elevation)
    .then((b) => {
      if (app.world === world) world.buildings = b;
      else b.dispose();
    })
    .catch((err) => console.warn('[buildings] fallo:', err));
}

let acc = 0; // fixed-timestep accumulator (reset on world swap)

async function init() {
  // Bundled snapshots: network + elevation grid fetched in parallel (F1).
  const [res, elevRes] = await Promise.all([
    fetch('/data/default-network.json'),
    fetch('/data/default-elevation.json').catch(() => null),
  ]);
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const osm = await res.json();

  let sampler = FLAT_SAMPLER;
  if (elevRes && elevRes.ok) {
    try {
      const grid = await elevRes.json();
      sampler = createElevationSampler(
        grid,
        createProjection(CONFIG.defaultCenter.lat, CONFIG.defaultCenter.lon)
      );
    } catch (err) {
      console.warn('[elevation] snapshot inválido — terreno plano:', err);
    }
  } else {
    console.warn('[elevation] snapshot no disponible — terreno plano.');
  }

  const network = buildNetwork(osm, CONFIG.defaultCenter, sampler);
  const r = CONFIG.defaultRadiusM;
  app.view = createScene(document.getElementById('app'), clampBbox(network.bbox, r));
  app.world = makeWorld(network, r);
  attachBuildings(app.world, null); // bundled snapshot

  // ---- UI layer ----
  initExplainer();
  const gui = createGui(app);
  const hud = createHud(app);
  const chart = createChart(app);
  const spaceTime = createSpaceTime(app);
  const follow = createFollow(app);
  createPicking(
    app.view,
    () => app.world && app.world.vehiclesMesh,
    (veh) => {
      if (veh) follow.follow(veh);
      else follow.stop();
    }
  );

  /** One build attempt: elevation fetch + buildNetwork. null -> unusable OSM. */
  async function buildCandidate(newOsm, center, radiusM) {
    let wayCount = 0;
    for (const el of newOsm.elements || []) if (el.type === 'way') wayCount++;
    if (wayCount < CONFIG.minKeptWays) return null;
    // Elevation for the searched zone (awaited behind the search loading
    // overlay); any failure falls back to flat terrain with a toast.
    let sampler2 = FLAT_SAMPLER;
    try {
      const grid = await fetchElevationGrid(center.lat, center.lon, radiusM);
      sampler2 = createElevationSampler(grid, createProjection(center.lat, center.lon));
    } catch (err) {
      console.warn('[elevation] fetch falló — terreno plano:', err);
      showToast('Sin datos de elevación — terreno plano');
    }
    try {
      return buildNetwork(newOsm, center, sampler2);
    } catch (err) {
      console.warn('[rebuild] buildNetwork failed:', err);
      return null;
    }
  }

  /** V2.1 A validation: enough kept length AND retention vs the fetched roads. */
  function networkComplete(network) {
    if (!network || network.edges.size < CONFIG.minCoreEdges) return false;
    const s = network.graphStats;
    const keptKm = s.keptDirectedLengthM / 1000;
    const retention = s.keptDirectedLengthM / Math.max(s.totalDirectedLengthM, 1);
    return keptKm >= CONFIG.network.minKeptLengthKm && retention >= CONFIG.network.minRetention;
  }

  /**
   * Full teardown/rebuild for the map search. Returns true on success,
   * 'incomplete' when validation failed even after the radius retry, or
   * false when the OSM data was unusable — the caller keeps the current
   * world and maps the code to a Spanish toast.
   */
  async function rebuildWorld(newOsm, center, radiusM) {
    let network2 = await buildCandidate(newOsm, center, radiusM);
    let r = radiusM;
    if (!networkComplete(network2)) {
      // ONE auto-retry with radius x1.5 (clamped <= 1200 m): small discs clip
      // one-way loops and fragment the graph (V2.1 A).
      const retryR = Math.min(Math.round(radiusM * 1.5), CONFIG.radiusClampM.max);
      if (retryR > radiusM) {
        console.info(
          `[rebuild] red incompleta con radio ${Math.round(radiusM)} m — reintento con ${retryR} m`
        );
        try {
          const retry = await fetchNetworkOsm(center.lat, center.lon, retryR);
          const cand = await buildCandidate(retry.osm, center, retry.radiusM);
          if (cand) {
            network2 = cand;
            r = retry.radiusM;
          }
        } catch (err) {
          console.warn('[rebuild] reintento Overpass falló:', err);
        }
      }
    }
    if (!network2) return false;
    if (!networkComplete(network2)) return 'incomplete';

    follow.stop();
    const old = app.world;
    app.world = null; // RAF idles during the swap
    acc = 0;
    if (old) old.dispose();
    app.view.frame(clampBbox(network2.bbox, r));
    const world = makeWorld(network2, r);
    app.world = world;
    gui.applyTo(world); // user's demand/speed/cycle settings carry over
    hud.reset();
    attachBuildings(world, { lat: center.lat, lon: center.lon, radius: r });
    if (network2.spawnMode === 'onNetwork') {
      // Not silent (V2.1 A): zero entries (or exits) -> on-network spawning.
      console.info('[rebuild] red sin entradas/salidas — generación interna (onNetwork)');
      showToast('Zona sin conexiones al exterior — generación interna activada');
    }
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
    get busStops() {
      return app.world ? app.world.network.busStops : null;
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
    setHeatmap: (b) => app.world && app.world.roads.setHeatmap(b),
    get minSpeedRatio() {
      return app.world ? app.world.sim.metrics.minSpeedRatio : 1;
    },
    get heatmap() {
      // F3 e2e hook: {enabled, colors, rangeCount, ranges} from roadMesh.
      return app.world ? app.world.roads.getHeatmapState() : null;
    },
    get elevation() {
      const e = app.world ? app.world.network.elevation : null;
      return e ? { min: e.minElev, max: e.maxElev, flat: e.flat } : null;
    },
    get debug() {
      return app.world ? app.world.debug : null;
    },
    get chartPoints() {
      return chart.pointCount;
    },
    get spaceTime() {
      return {
        sampleCount: spaceTime.sampleCount,
        corridorName: spaceTime.corridorName,
        corridorLength: spaceTime.corridorLength,
      };
    },
    get streetNames() {
      // V2.1 B e2e hook: label count + the rendered name list.
      const sn = app.world ? app.world.streetNames : null;
      return sn ? { count: sn.count, names: sn.names } : null;
    },
    follow,
    get view() {
      return app.view;
    },
  };

  // ---- Fixed-timestep loop with accumulator + interpolation (spec §2.1) ----
  let last = performance.now();
  let nextHeat = 0; // F3: wall-clock heatmap repaint gate (CONFIG.heatmap.updateHz)
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
      if (now >= nextHeat) {
        nextHeat = now + 1000 / (CONFIG.heatmap.updateHz ?? 1);
        world.roads.updateHeatmap(); // no-op while the heatmap is off
      }
      world.streetNames.update(app.view.camera); // ~5 Hz gate inside (V2.1 B)
      hud.update();
      chart.update();
      spaceTime.update();
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
