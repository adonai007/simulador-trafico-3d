// Bootstrap: load bundled network -> build world (network+sim+render) ->
// UI layer (GUI/HUD/chart/follow/explainer/search) -> fixed-step RAF loop with
// §2.1 render interpolation. Live map search tears the world down and rebuilds
// it in place (every render module exposes dispose()); the scene/camera/UI
// survive swaps.

import { CONFIG } from './config.js';
import { buildNetwork } from './network/build.js';
import { fetchNetworkOsm, fetchAerialwayOsm } from './osm/overpass.js'; // D2 adds fetchAerialwayOsm
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
import { createWorksMesh } from './render/worksMesh.js'; // C1: cones + hazards
import { createStreetLampsMesh } from './render/streetLampsMesh.js'; // C2
import { createEnvironment } from './render/environment.js'; // C2
import { loadSatellite, loadDefaultSatellite } from './render/satellite.js'; // D1
import { buildAerialways } from './network/aerialway.js'; // D2
import { createAerialwayMesh } from './render/aerialwayMesh.js'; // D2
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
// --- D3 --- compartir por URL + modo tour.
import { createShare, bootShare } from './ui/share.js';
import { createTour } from './ui/tour.js';
// --- end D3 ---
// --- E2a --- panel de estadísticas + exportación CSV.
import { createStats } from './ui/stats.js';
// --- end E2a ---
// --- E2b --- grabador de replay + barra de repetición. El grabador (ring) vive
// dentro de la simulación (sim/replay.js, creado por createSimulation); aquí solo
// importamos la barra de repetición (UI app-owned).
import { createReplayUI } from './ui/replayUI.js';
// --- end E2b ---

window.__SIM__ = { ready: false };

// --- E2b --- replay render-source flags (module scope, reset on world swap).
// While replayMode is ON the sim is HARD-paused AND its recorder is paused, and
// the RAF frame() calls vehiclesMesh.updateFromReplay(replay, replayScrubT)
// instead of update(). replayUI is the app-owned scrubber bar; replayPrevPaused
// remembers the live pause state so EN VIVO restores it exactly.
let replayMode = false;
let replayScrubT = 0;
let replayUI = null;
let replayPrevPaused = false;
// --- end E2b ---

const DT = CONFIG.sim.dt;

// app.world is the swappable unit: network + sim + all per-network meshes.
// app.environment (C2) is app-owned and survives world swaps (D4).
// app.lastQuery / app.tour (D3) are app-owned and survive world swaps:
//   lastQuery = the last successful search (share.js emits `q=` from it);
//   tour      = the guided-tour controller (createTour, assigned in init()).
const app = { view: null, world: null, environment: null, lastQuery: null, tour: null };

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

  // --- C1 --- worksMesh (cones + hazard blinkers, per-world): polls
  // sim.closureVersion inside update(simTime) — needs the sim reference.
  const worksMesh = createWorksMesh(network, sim);
  view.scene.add(worksMesh.group);
  // --- end C1 ---

  // --- C2 --- streetLampsMesh (poles + glows + ground pools, per-world).
  const streetLampsMesh = createStreetLampsMesh(network);
  view.scene.add(streetLampsMesh.group);
  // --- end C2 ---

  // --- D1 (makeWorld:create) ---
  // Satellite imagery loads fire-and-forget AFTER the world exists (see
  // attachSatellite); starts null. terrain may be null in flat zones — the
  // drape needs a terrain mesh, so a null terrain simply never drapes.
  let satellite = null;
  // --- end D1 (makeWorld:create) ---

  // --- D2 (makeWorld:create) ---
  // The aerialway needs the raw Overpass aerialway JSON (NOT part of `network`,
  // which is highway-only). So `aerialwayMesh` starts null and is filled by a
  // fire-and-forget attachAerialway(world, source) AFTER the world exists:
  //   - default zone  -> fetch the bundled public/data/default-aerialway.json
  //   - searched zone -> fetchAerialwayOsm(lat,lon,r) (see D2 rebuildWorld:attach)
  // attachAerialway builds lines via buildAerialways(osm, projection, elevation),
  // and only creates the mesh when lines exist (graceful empty otherwise).
  let aerialwayMesh = null;
  // --- end D2 (makeWorld:create) ---

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
    worksMesh, // C1: per-world cones/hazards
    streetLampsMesh, // C2: per-world lamps (null until C2 lands)
    // --- D1 (world:fields) ---
    satellite, // loaded imagery handle (CanvasTexture+dispose) or null
    /**
     * Apply (or remove) building semi-transparency for the satellite view.
     * KEEP depthWrite=true on the merged building mesh — depthWrite=false on a
     * single merged InstancedMesh causes self-sort flicker (documented tradeoff,
     * spec D1). Reads the persisted «Vista satélite» param via __SIM__.
     */
    applySatelliteToBuildings() {
      const mesh = world.buildings?.mesh;
      if (!mesh) return;
      const on = !!window.__SIM__?.satellite?.enabled;
      const m = mesh.material;
      if (on) {
        m.transparent = true;
        m.opacity = CONFIG.satellite.buildingOpacity;
        m.depthWrite = true; // keep — avoids merged-mesh self-sort artifacts
      } else {
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
      }
      m.needsUpdate = true;
    },
    // --- end D1 (world:fields) ---
    // --- D2 (world:fields) ---
    aerialwayMesh, // null until attachAerialway resolves with >=1 line
    // --- end D2 (world:fields) ---
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
      // --- C1 ---
      if (world.worksMesh) {
        view.scene.remove(world.worksMesh.group);
        world.worksMesh.dispose();
      }
      // --- end C1 ---
      // --- C2 ---
      if (world.streetLampsMesh) {
        view.scene.remove(world.streetLampsMesh.group);
        world.streetLampsMesh.dispose();
      }
      // --- end C2 ---
      // --- D1 (dispose) ---
      // Release the loaded satellite imagery on world swap. terrain.dispose()
      // already frees the terrain material/geometry; this frees the CanvasTexture.
      world.satellite?.dispose();
      world.satellite = null;
      // --- end D1 (dispose) ---
      // --- D2 (dispose) ---
      if (world.aerialwayMesh) {
        view.scene.remove(world.aerialwayMesh.group);
        world.aerialwayMesh.dispose();
        world.aerialwayMesh = null;
      }
      // --- end D2 (dispose) ---
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
      if (app.world === world) {
        world.buildings = b;
        // --- C2 --- re-apply window emissive to the freshly attached buildings.
        app.environment?.refreshWorld?.();
        // --- end C2 ---
        // --- D1 (attachBuildings:resolve) ---
        // Re-apply satellite building transparency to the freshly attached
        // buildings (their material is created here, AFTER the toggle may
        // already be ON).
        world.applySatelliteToBuildings?.();
        // --- end D1 (attachBuildings:resolve) ---
      } else {
        b.dispose();
      }
    })
    .catch((err) => console.warn('[buildings] fallo:', err));
}

// --- D1 --- fire-and-forget satellite attach (Vista satélite). `source` is
// null/undefined for the bundled default-zone snapshot (loadDefaultSatellite)
// or { lat, lon, radius } for a searched zone (loadSatellite). On resolve:
//   - drop if the world was swapped while fetching (app.world !== world);
//   - stash world.satellite (so dispose frees the texture even if never draped);
//   - if the persisted «Vista satélite» toggle is ON, drape now; else keep idle
//     until the user toggles it on (setSatellite reads world.satellite).
//   - null result + the toggle ON => toast «Sin imágenes satelitales…».
function attachSatellite(world, source) {
  const load = source
    ? loadSatellite(world.network, { lat: source.lat, lon: source.lon, radius: source.radius })
    : loadDefaultSatellite();
  Promise.resolve(load)
    .then((sat) => {
      if (app.world !== world) {
        sat?.dispose();
        return;
      }
      world.satellite = sat;
      const wantOn = !!window.__SIM__?.satellite?.enabled;
      if (!sat) {
        if (wantOn) showToast('Sin imágenes satelitales para esta zona');
        return;
      }
      if (wantOn) {
        world.terrain?.setSatellite(sat);
        world.applySatelliteToBuildings?.();
      }
    })
    .catch((err) => console.warn('[satélite] fallo:', err));
}
// --- end D1 ---

// --- D2 --- fire-and-forget aerialway attach (Mi Teleférico). `source` is
// either { url } for the bundled default-zone snapshot or { lat, lon, radius }
// for a searched zone (live Overpass). Builds lines via buildAerialways and only
// creates the mesh when >=1 line exists; dropped if the world was swapped while
// fetching, or silently skipped on any failure/empty (graceful, like buildings).
function attachAerialway(world, source) {
  if (CONFIG.aerialway?.enabled === false) return; // off-safe global kill switch
  const fetchOsm = source.url
    ? fetch(source.url).then((r) => (r.ok ? r.json() : null))
    : fetchAerialwayOsm(source.lat, source.lon, source.radius);
  Promise.resolve(fetchOsm)
    .then((osm) => {
      if (!osm || app.world !== world) return;
      const model = buildAerialways(osm, world.network.projection, world.network.elevation);
      if (!model || !model.lines.length) return; // no teleférico in this zone
      if (app.world !== world) return; // swapped during the async build
      const mesh = createAerialwayMesh(model);
      world.aerialwayMesh = mesh;
      app.view.scene.add(mesh.group);
      // Re-assert the persisted «Teleférico» checkbox onto the fresh mesh.
      const want = window.__SIM__?.aerialwayWanted?.();
      if (want === false) mesh.setVisible(false);
      console.info(
        `[teleférico] ${model.lines.length} línea(s), ${mesh.getState().cabins} cabinas`
      );
    })
    .catch((err) => console.warn('[teleférico] fallo:', err));
}
// --- end D2 ---

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
  // --- C2 --- app-owned environment (day/night + weather), created ONCE here.
  // It reaches per-world pieces (roads/lamps/buildings) lazily via the getter,
  // so it survives world swaps with no re-wiring (D4).
  app.environment = createEnvironment(app.view, () => app.world);
  // --- end C2 ---
  app.world = makeWorld(network, r);
  attachBuildings(app.world, null); // bundled snapshot
  // --- D1 --- default-zone satellite from the bundled JPG+JSON snapshot.
  attachSatellite(app.world, null);
  // --- end D1 ---
  // --- D2 --- default-zone teleférico from the bundled raw Overpass snapshot.
  attachAerialway(app.world, { url: '/data/default-aerialway.json' });
  // --- end D2 ---

  // ---- UI layer ----
  initExplainer();
  const gui = createGui(app);
  const hud = createHud(app);
  const chart = createChart(app);
  const spaceTime = createSpaceTime(app);
  const follow = createFollow(app);
  // --- E2a --- stats panel + CSV export, wired like `chart` (app-owned,
  // survives world swaps; reads app.world.sim each update). Stashed on `app`
  // so __SIM__.exportStats() reaches exportCSV().
  const stats = createStats(app);
  app.stats = stats;
  // --- end E2a ---
  // --- E2b --- replay recorder + scrubber UI. The recorder lives WITH the sim
  // (per-world, sim/replay.js); the scrubber bar is app-owned and survives world
  // swaps. setReplayMode/setReplayScrub drive the module-scope replayMode /
  // replayScrubT render-source flags + HARD-pause the sim and its recorder.
  // World swap -> applyReplayMode(false) + sim.replayReset() (see rebuildWorld).
  function applyReplayMode(on) {
    on = !!on;
    if (on === replayMode) {
      if (on) app.world?.sim?.setReplayRecording?.(false); // keep enforced
      return;
    }
    const sim = app.world?.sim;
    if (on) {
      replayPrevPaused = sim ? sim.paused : false; // remember the live pause state
      replayMode = true;
      sim?.setPaused?.(true); // HARD-pause the sim
      sim?.setReplayRecording?.(false); // pause recording (clean live-only ring)
    } else {
      replayMode = false;
      sim?.setReplayRecording?.(true); // resume recording
      sim?.setPaused?.(replayPrevPaused); // restore the exact live pause state
    }
  }
  function applyReplayScrub(t) {
    replayScrubT = +t || 0;
  }
  app._applyReplayMode = applyReplayMode; // reached by the __SIM__ E2b hooks
  app._applyReplayScrub = applyReplayScrub;
  replayUI = createReplayUI(app, {
    setReplayMode: applyReplayMode,
    setReplayScrub: applyReplayScrub,
    isReplayMode: () => replayMode,
  });
  // --- end E2b ---
  // --- C1 --- picking opts: obras mode raycasts the road ribbon instead of
  // vehicles. The extra arg is ignored by the legacy createPicking signature;
  // agent C1 extends createPicking(view, getVehiclesMesh, onPick, opts) and
  // fills onRoadPick (toggle close/open + notifyClosuresChanged).
  const pickingOpts = {
    isObrasMode: () => !!gui.params.modoObras,
    getRoads: () => (app.world ? app.world.roads : null),
    onRoadPick: (hit) => {
      const w = app.world;
      if (!w || !hit || !hit.edge) return;
      if (w.sim.closedEdges?.has(hit.edge.id)) w.sim.openEdge?.(hit.edge.id);
      else w.sim.closeEdge?.(hit.edge.id);
      w.roads.notifyClosuresChanged?.();
    },
  };
  // --- end C1 ---
  createPicking(
    app.view,
    () => app.world && app.world.vehiclesMesh,
    (veh) => {
      if (veh) follow.follow(veh);
      else follow.stop();
    },
    pickingOpts // C1 (inert today: legacy signature ignores it)
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
    // --- E2b --- world swap: force EN VIVO + clear the replay ring so the new
    // world never scrubs into stale frames. Exit replayMode (restores the live
    // pause state on the OLD sim), clear the old recorder, and reset the UI bar.
    // The new world ships with a fresh empty ring; the UI also re-pins to the
    // live edge when it detects the sim swap in its own update().
    applyReplayMode(false);
    app.world?.sim?.replayReset?.();
    replayUI?.reset();
    // --- end E2b ---
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
    // --- D1 (rebuildWorld:attach) ---
    // Searched-zone satellite: fetch + stitch Esri tiles over the terrain plane,
    // fire-and-forget. attachSatellite gates application on the persisted «Vista
    // satélite» param and app.world===world; null result toasts if the toggle
    // is on, otherwise the zone simply has no imagery.
    attachSatellite(world, { lat: center.lat, lon: center.lon, radius: r });
    // --- end D1 (rebuildWorld:attach) ---
    // --- D2 (rebuildWorld:attach) ---
    // Searched-zone teleférico: fetch live Overpass aerialway data at a WIDER
    // radius than the road disc (cable lines span km — a small disc clips every
    // line). attachAerialway gates on app.world===world and skips gracefully on
    // empty/offline so most zones simply have no teleférico.
    attachAerialway(world, { lat: center.lat, lon: center.lon, radius: Math.max(r, 1500) });
    // --- end D2 (rebuildWorld:attach) ---
    if (network2.spawnMode === 'onNetwork') {
      // Not silent (V2.1 A): zero entries (or exits) -> on-network spawning.
      console.info('[rebuild] red sin entradas/salidas — generación interna (onNetwork)');
      showToast('Zona sin conexiones al exterior — generación interna activada');
    }
    // --- D3 (rebuildWorld:success) ---
    // Stash the successful query on `app` so share.js emits `q=` (a stable
    // place name that survives OSM rebuilds) instead of raw center/radius for
    // searched zones. The query text comes either from the share-restore caller
    // (center.text) or, for an interactive search, from the live search input —
    // read here so search.js needs no D3 changes.
    {
      const inputEl = document.getElementById("search-input");
      const text =
        (center && center.text) || (inputEl ? inputEl.value.trim() : "") || null;
      app.lastQuery = { center: { lat: center.lat, lon: center.lon }, radius: r, text };
    }
    // --- end D3 (rebuildWorld:success) ---
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

    // --- C1 --- closures & incidents hooks (no-ops until sim APIs land).
    closeEdge: (id) => {
      const w = app.world;
      if (!w || !w.sim.closeEdge) return null;
      const r = w.sim.closeEdge(id);
      w.roads.notifyClosuresChanged?.();
      return r;
    },
    openEdge: (id) => {
      const w = app.world;
      if (!w || !w.sim.openEdge) return null;
      const r = w.sim.openEdge(id);
      w.roads.notifyClosuresChanged?.();
      return r;
    },
    get closedEdges() {
      return app.world?.sim.closedEdges ?? null;
    },
    triggerIncident: (opts) => app.world?.sim.triggerIncident?.(opts) ?? null,
    clearIncidents: () => app.world?.sim.clearIncidents?.(),
    get incidents() {
      return app.world?.sim.incidents ?? null;
    },
    get closureVersion() {
      return app.world?.sim.closureVersion ?? 0;
    },
    get routingVersion() {
      return app.world?.sim.routingVersion ?? 0;
    },
    // --- end C1 ---

    // --- C2 --- weather & day/night hooks (no-ops until app.environment lands).
    setWeather: (mode, intensity) => app.environment?.setWeather?.(mode, intensity),
    get weather() {
      return {
        mode: CONFIG.weather.mode,
        intensity: CONFIG.weather.intensity,
        current: CONFIG.weather.current,
      };
    },
    setTimeOfDay: (h) => app.environment?.setTimeOfDay?.(h),
    get timeOfDay() {
      return CONFIG.dayNight.timeOfDay;
    },
    get environment() {
      // C2 fills environment.state: {nightFactor, sunIntensity, headlightCount,
      // rainVisible, lampGlowVisible}.
      return app.environment?.state ?? null;
    },
    // --- end C2 ---

    // --- D1 --- satellite hooks (Vista satélite).
    //   setSatellite(b) -> toggle the drape: persists the param, drapes/undrapes
    //     the terrain imagery (if loaded) and building transparency. When the
    //     imagery is still loading, the param is recorded and attachSatellite
    //     applies it on resolve.
    //   satellite -> { enabled: <persisted param>, ready: <imagery loaded?> }
    //   terrainHasMap -> !!terrain.material.map (true only once draped)
    setSatellite: (b) => {
      const on = !!b;
      gui && (gui.params.verSatelite = on);
      const w = app.world;
      if (!w) return;
      if (on) {
        if (w.satellite) w.terrain?.setSatellite(w.satellite);
      } else {
        w.terrain?.setSatellite(null);
      }
      w.applySatelliteToBuildings?.();
    },
    get satellite() {
      return {
        enabled: !!gui?.params?.verSatelite,
        ready: !!app.world?.satellite,
      };
    },
    get terrainHasMap() {
      return !!app.world?.terrain?.mesh?.material?.map;
    },
    // --- end D1 ---

    // --- D2 --- teleférico hooks (Mi Teleférico).
    //   aerialway   -> { lines, cabins } | null  (null when the zone has none)
    //   sampleCabin -> first cabin's live world {x,y,z} | null
    //   setTeleferico/aerialwayWanted -> drive + read the «Teleférico» visibility
    //     so attachAerialway can re-assert the persisted checkbox on a fresh mesh.
    get aerialway() {
      return app.world?.aerialwayMesh
        ? app.world.aerialwayMesh.getState?.() ?? null
        : null;
    },
    sampleCabin: () => app.world?.aerialwayMesh?.sampleCabin?.() ?? null,
    setTeleferico: (b) => app.world?.aerialwayMesh?.setVisible?.(b),
    aerialwayWanted: () => gui?.params?.verTeleferico ?? CONFIG.aerialway.enabled !== false,
    // --- end D2 ---

    // --- D3 --- compartir + tour hooks (no-ops until D3 lands).
    // Agent D3 implements:
    //   share: { url: () => buildShareUrl(serializeState(app, gui)),
    //            copy: () => copyShareLink(app, gui) },
    //   get tour() { return app.tour?.state ?? null; }  // {playing, scene, play, next, pause}
    share: {
      url: () => app.share?.url?.() ?? location.href, // D3 wires serializeState
      copy: () => app.share?.copy?.(), // D3 wires copyShareLink
    },
    get tour() {
      return app.tour ?? null; // D3 assigns app.tour = createTour(app, gui)
    },
    // --- end D3 ---

    // --- E1 --- ambulancia hooks (no-ops until sim.callAmbulance lands).
    //   callAmbulance() -> spawns one ambulance, returns its id (or null at cap)
    //   ambulances      -> { count, list:[{id,segId,s,v}] } | null
    //   yieldingCount   -> live count of vehicles ceding to an ambulance
    //   sirenCount      -> vehiclesMesh siren instances last frame (e2e hook)
    callAmbulance: () => app.world?.sim.callAmbulance?.() ?? null,
    get ambulances() {
      return app.world?.sim.ambulances ?? null;
    },
    get yieldingCount() {
      return app.world?.sim.yieldingCount ?? 0;
    },
    get sirenCount() {
      return app.world?.vehiclesMesh.sirenCount ?? 0;
    },
    // --- end E1 ---

    // --- E2a --- estadísticas + CSV hooks (no-ops until createStats/sim land).
    //   tripStats      -> {viajesCompletados, tiempoMedioViaje, demoraMedia,
    //                      demoraTotal, velocidadMedia, rendimiento} | null
    //   metricsHistory -> the ring (or its sample count) for the chart/CSV
    //   exportStats()  -> the metricas-globales CSV as a string (e2e hook)
    get tripStats() {
      return app.world?.sim.tripStats ?? null;
    },
    get metricsHistory() {
      return app.world?.sim.metricsHistory ?? null;
    },
    exportStats: () => app.stats?.exportCSV?.() ?? null,
    // --- end E2a ---

    // --- E2b --- replay hooks (no-ops until replay.js + the RAF swap land).
    //   replay          -> {recording, mode, windowS, frameCount, scrubT} | null
    //   setReplayMode(b)-> enter/exit scrubbing (hard-pause + render from ring)
    //   setReplayScrub(tSeconds) -> set the scrub position (drives positions)
    //   replayFrameCount-> frames captured so far (e2e hook)
    // Agent E2b wires these to the module-scope replayMode/replayScrubT flags
    // and the recorder; they READ/DRIVE the RAF render-source swap below.
    get replay() {
      const r = app.world?.sim.replay;
      if (!r) return null;
      return {
        recording: r.recording, // live recording active (false while scrubbing)
        mode: replayMode, // true while rendering from the ring
        windowS: r.windowS, // rewindable window (s)
        frameCount: r.frameCount, // ring capacity (constant)
        written: r.written, // frames captured so far
        scrubT: replayScrubT, // current scrub sim-time
        minTime: r.minTime(), // oldest sim-time in the ring (-1 empty)
        maxTime: r.maxTime(), // newest sim-time in the ring (-1 empty)
      };
    },
    setReplayMode: (b) => app._applyReplayMode?.(b),
    setReplayScrub: (t) => app._applyReplayScrub?.(t),
    get replayFrameCount() {
      // Frames captured so far (e2e hook) — NOT the ring capacity.
      return app.world?.sim.replay?.written ?? 0;
    },
    /**
     * Sum of the live vehicle instance-matrix translation components (e2e hook).
     * Scrubbing to two different sim-times yields two different signatures —
     * proves the scrubber actually drives the rendered instance matrices. Read
     * AFTER a RAF frame has rendered the current scrubT.
     */
    replayInstanceSignature() {
      const vm = app.world?.vehiclesMesh;
      if (!vm) return 0;
      let sig = 0;
      for (let k = 0; k < vm.meshes.length; k++) {
        const m = vm.meshes[k];
        const arr = m.instanceMatrix.array;
        const n = m.count;
        for (let i = 0; i < n; i++) {
          const o = i * 16;
          // translation row (12,13,14) — position of each instance
          sig += arr[o + 12] * 0.5 + arr[o + 13] * 0.25 + arr[o + 14] * 0.125;
        }
      }
      return sig;
    },
    // --- end E2b ---
  };

  // --- D3 (init:end) ---
  // Wire share + tour AFTER window.__SIM__ is assigned (bootShare reads the live
  // hooks and may call rebuildWorld). app.share/app.tour are read by the
  // __SIM__.share/__SIM__.tour getters and the GUI «Escenario» buttons.
  app.tour = createTour(app, gui);
  app.share = createShare(app, gui);
  // Boot-time URL restore: parse → ZONE FIRST (await rebuildWorld) →
  // setters + gui.applyState → CLOSURES LAST (DESIGN-SPEC-V4 §D3).
  bootShare(app, gui, rebuildWorld);
  // --- end D3 (init:end) ---

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
      // --- C2 --- environment ramp (~10 Hz gate inside) + headlight factor
      // for vehiclesMesh (gated on sunI < onBelowSunI, NOT on the broader
      // nightFactor — headlights pop on later than lamps, ~20:00 vs ~17:45).
      app.environment?.update?.(sim, wallDt, app.view.camera);
      const nightFactor = app.environment?.state?.headlightFactor ?? 0;
      // --- end C2 ---
      // --- E2b: RAF render-source swap ---
      // While replayMode is ON, render vehicles FROM the replay ring at the
      // scrubbed sim-time instead of the live sim (the sim is already hard-paused
      // so sim.step never advanced this frame; environment, lamps, gondolas and
      // the heatmap keep rendering live). Otherwise take the live update() path.
      if (replayMode) {
        world.vehiclesMesh.updateFromReplay(sim.replay, replayScrubT);
      } else {
        world.vehiclesMesh.update(alpha, nightFactor);
      }
      // --- end E2b: RAF render-source swap ---
      // --- C1 --- cones refresh on closureVersion change + hazard blink.
      world.worksMesh?.update?.(sim.time);
      // --- end C1 ---
      // --- D2 (frame:update) --- gondola cabins ride WALL-CLOCK time (real dt,
      // independent of sim speed/pause). Zero-alloc scratch inside; no-op while
      // aerialwayMesh is null or the «Teleférico» layer is hidden.
      world.aerialwayMesh?.update?.(wallDt);
      // --- end D2 (frame:update) ---
      if (now >= nextHeat) {
        nextHeat = now + 1000 / (CONFIG.heatmap.updateHz ?? 1);
        world.roads.updateHeatmap(); // no-op while the heatmap is off
      }
      world.streetNames.update(app.view.camera); // ~5 Hz gate inside (V2.1 B)
      hud.update();
      chart.update();
      // --- E2a --- estadísticas panel refresh (HUD cadence; internal gate on
      // metrics.global.time so the DOM only writes on a new global sample).
      stats.update();
      // --- end E2a ---
      spaceTime.update();
      // --- E2b --- scrubber bar tick (REC indicator + playback advance).
      replayUI?.update(wallDt);
      // --- end E2b ---
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
