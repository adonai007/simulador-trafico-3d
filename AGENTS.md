# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev                     # Vite dev server, port 5173 (strictPort)
npm run build                   # production build to dist/
powershell -File scripts/build-clean.ps1   # clean build: wipe dist/, rebuild, print exit code
npm run preview                 # serve dist/
npx playwright test             # full e2e suite (reuses a running dev server)
npx playwright test -g "viva"   # single test by title substring
```

Run tests as plain `npx playwright test` — no env-var prefixes (`SIM_PORT=...`, `$env:SIM_PORT=...`). The port defaults to 5173 in `playwright.config.js`; only a human overrides SIM_PORT manually when another project occupies the port.

UI text is **Spanish**; code identifiers and comments are **English**. The authoritative design document is `docs/DESIGN-SPEC.md` — deviations from it are recorded at its bottom and must be kept up to date.

## Architecture

Three layers, one-directional data flow. `src/main.js` owns the swappable `world` object (network + sim + per-network meshes) and the fixed-timestep RAF loop; the map search tears a world down (`dispose()` on every render module) and rebuilds it in place while scene/camera/UI persist.

1. **OSM → network pipeline** (`src/osm/`, `src/network/`, orchestrated by `network/build.js`): Overpass JSON → tag normalization (`osm/parse.js`) → directed edge graph with way splitting, degree-2 collapse, micro-edge merge, iterative-Tarjan SCC prune, entry/exit stubs (`graph.js`) → per-lane offset polylines (`lanes.js`) → signal detection + two-phase plans + green-wave offsets (`signals.js`) → Bézier turn connectors with lane-turn assignment and conflict pairs (`connectors.js`) → reverse-Dijkstra next-hop tables per exit (`routing.js`). Build order matters: signals before connectors (conflict registration needs signal groups), routing after connectors (adjacency derives from actual connectors so pruned U-turns are never routed).

2. **Sim engine** (`src/sim/`): fixed `DT = 1/30 s` with a wall-clock accumulator in main.js (`acc += wallDt × simSpeed`, max 8 steps/frame, remainder dropped when capped). Step order: snapshot prevSeg/prevS → spawn (Poisson + retry queue) → decide (IDM + MOBIL) → apply lane changes → integrate → segment transitions/despawn → detectors. `signalsRuntime.js` is stateless: signal state is a pure function of (plan, sim time), which is why GUI retiming (`retimeSignals`) takes effect instantly.

3. **Render + UI** (`src/render/`, `src/ui/`): three.js scene with one draw call per vehicle type (InstancedMesh), merged road/marking/building geometry, instanced signal poles/lamps. UI modules receive the `app` object and read `app.world.sim` live, so they survive world swaps without rebinding.

## Key invariants and conventions

- **Lane API abstraction**: real lanes and turn connectors expose the same shape (`{id, length, points, cumLen, vehicles[], speedMs, pointAt(s, out?), headingAt(s, out?)}`, connectors add `isConnector, turnType, signalGroup, conflictRefs`). The sim engine walks `lane → connector → lane` chains without caring which is which; vehicles on connectors block upstream lanes automatically via the lookahead.

- **Virtual-obstacle min() rule** (`sim/simulation.js decide()`): red lights, conflict yielding and mandatory-lane-change creep are all modeled as a standing virtual leader fed to `idmAccel`; the final acceleration is the **minimum** of all restrictive terms, never an average. MOBIL receives the *pure* car-following accel (`aCar`) so queued vehicles don't weave to dodge red lights.

- **Coordinate convention** (`src/geo/projection.js`, the #1 handedness bug source): three.js is right-handed Y-up; `x = east`, `z = −north` (+z = south). The right side of travel direction `(dx, dz)` is `(−dz, dx)`. NEVER compute yaw with ad-hoc atan2 — build orientation with `matrix.makeBasis(right, up, forward)` where `forward = (h.x, 0, h.z)` and `right = cross(up, forward)`; all vehicle/signal geometry points nose **+Z local**.

- **Degree-2 collapse must never reverse a one-way segment** (`graph.js collapseDegree2`): orienting chain merges by flipping a directed edge inverts traffic direction and shatters the SCC (historic bug: core dropped from 894 nodes to a 65-node fragment). Collapse only merges chains whose edges already agree in direction, lane count and class, and keeps `traffic_signals` nodes.

- **Render interpolation** (§2.1): the sim snapshots `prevSeg/prevS` at step start; `vehiclesMesh.sampleVehiclePose(veh, alpha)` lerps arc position within a segment and world-lerps across segment seams (`alpha = acc/DT`). Lane changes remap the snapshot onto the target lane — the sideways motion comes only from the 1.5 s lateral ease.

- **InstancedMesh strategy**: 6 instanced meshes (sedán/hatchback/SUV/taxi/micro/camión, capacity 400 each) whose order is data-driven from `CONFIG.vehicleTypes` key order (= `typeIndex`), matrices + colors rewritten every frame, `instanceIdToVehicle[type][i]` rebuilt per frame for picking, plus ONE shared brake-light InstancedMesh (instances exist only for braking vehicles: `_a < −1` or held at ~standstill). Vehicle geometry uses vec4 vertex colors where alpha = tint mask (1 = region multiplied by per-instance body color, 0 = fixed authored color: glass/tires/hubs/taxi sign/micro band) via an `onBeforeCompile` patch of the `color_vertex` chunk — one draw call per type (+1 for brake lights). Gotcha: InstancedMesh caches `boundingSphere` from whatever `count` it had when first computed — `picking.js` recomputes it per click or every raycast misses.

- **No per-frame allocations in hot paths**: sim step, vehiclesMesh.update, follow.update and detector updates use module/closure-level scratch objects; vehicle objects keep a stable shape (all fields created in the factory).

- **Metrics contract** (`sim/detectors.js`): `sim.metrics = { global, detectorPoints }` are **stable references mutated in place** on sim-time cadences (0.5 s global, 5 s detector windows); UI closes over them and polls. `k` = veh/km/lane (counted occupancy), `q` = veh/h/lane — exactly the fundamental-diagram axes in `ui/chart.js`.

- **Bundled snapshots vs live Overpass**: first paint never touches the network — `public/data/default-network.json` and `default-buildings.json` are build-time snapshots of the default La Paz zone (center/radius hardcoded next to them in `config.js`; the projection origin must match the snapshot center). Live search (`ui/search.js`) goes Nominatim → `osm/overpass.js` (mirror fallback, 25 s aborts, way/node caps with one 0.6×radius retry, radius clamp 250–1200 m) and keeps the current network on any failure, with Spanish toasts.

- **Overpass WAF vs non-browser tooling**: `overpass-api.de` returns **HTTP 406** to non-browser User-Agents (node scripts, curl). The app is unaffected (browser UA), but node-side tooling (snapshot scripts, funnel diagnostics like `tests/funnel-macrodistrito.mjs`) must send a browser-like `User-Agent` header or use the `overpass.kumi.systems` mirror.

- **Determinism**: all randomness flows through the seeded mulberry32 RNG (`util/rng.js`, seed in `config.js`); sim clocks are sim-time, never wall-time.

- `window.__SIM__` (defined in main.js) is the test hook and UI entry point: getters for `ready/time/vehicleCount/metrics/networkCenter`, `setDemand/setSimSpeed/setPaused`, plus `sim`, `network`, `view`, `follow`, `chartPoints`. The Playwright suite drives the sim exclusively through it.
