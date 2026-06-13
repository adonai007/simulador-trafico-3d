# DESIGN SPEC V3 — Obras e incidentes (C1) + Clima y ciclo día/noche (C2)

> Authoritative spec. Conventions as V1/V2/V2.1 (Spanish UI, English code, zero per-frame allocs, stable shapes, dispose(), static-site, CONFIG holds tunables). Dev server is on **:5174** now (5173 taken by another app); run suite as `SIM_PORT=5174 npx playwright test`. Deviations at the bottom.

## 0. Key design decisions

**D1 — Incidents = phantom vehicle, not virtual-obstacle term.** Insert a fake stopped vehicle into `lane.vehicles` via existing `insertSorted` → same-lane followers, cross-connector `lookaheadLeader`, and MOBIL (`neighborsAt`) all see it automatically; overtaking emerges with zero new code. Only exclusions needed: skip in decide loop (`isPhantom` → `_a=0, continue`), never push to the master `vehicles[]` (integrate/render/global metrics never see it), two one-line `isPhantom` filters in detectors. ~6 lines vs ~40 across 3 hot files.

**D2 — Closures: flag + routing rebuild + hard local guard (3 layers).**
1. `buildRouting(graph, closedSet = null)`: skip records whose `out` edge is closed (nothing routes INTO it) but KEEP records whose `prev` edge is closed (vehicles already on it get next-hops OUT — closed edge stays a valid Dijkstra source, never an intermediate). `exits` filtered of closed edges.
2. `setRouteForLane` closed-guard: skip `outs[i]` whose outEdge is `_closed`; `pickFallbackConn` prefers non-closed; all-closed ⇒ `nextConn=null` ⇒ despawn at barrier (documented).
3. Recompute **coalesced at step start**: `closeEdge/openEdge` only set `edge._closed` (both twins) + `closuresDirty=true` + `closureVersion++`; `step()` starts with `if (closuresDirty) applyClosures()` — rebuild never happens mid-decide. Budget `performance.now()` vs `CONFIG.closures.recomputeBudgetMs` (50); if exceeded → double-buffered chunking (K exit tables per step into a fresh Map, atomic swap; old tables stay live — safe due to layer 2). After rebuild: `reresolveRoute(veh)` for every vehicle on a real lane (= `setRouteForLane` minus `pickNextStop` and minus blockT/ignoreCount resets — preserves micro dwell determinism).

**D3 — roadMesh ONE unified repaint path.** Invariant: `material.color` is white whenever `heatmapOn || closedCount > 0` (× wetness). Single `repaint()` writes every range: closed ⇒ hazard stripes (alternate two colors every ~2 ribbon vertex rows — free, no UVs), else heatmap-on ⇒ ramp, else asphalt RGB per-vertex. When heatmap off AND no closures: legacy exact path (fill(1) + roadColor) so e2e test 7's all-white assertion stays byte-identical. `updateHeatmap()` skips closed ranges. `setHeatmap` calls `repaint()` (closures survive toggles).

**D4 — Environment = pure function `apply(hour, weatherMode, intensity)`.** No save/restore: every property (sun intensity/color/position arc, hemi, sky, fog, wetness, building emissive, lamp glow, headlight gate) recomputed from precomputed gradient stops on every apply. Idempotent ⇒ returning to day restores exactly. Rain+night compose: day/night ramp first, then weather modifiers.

**D5 — Weather physics entirely inside `idm.js`.** Module-level `const W = CONFIG.weather.current`; in `idmAccel`: `v0 *= W.v0Mul; T = params.T + W.TAdd; b = params.b * W.bMul`. Every call site (car-following, signal/conflict/creep/bus-stop obstacles, MOBIL) gets consistent caution for free; zero signature churn; per-vehicle params immutable.

## 1. CONFIG additions (src/config.js)

```js
closures: { recomputeBudgetMs: 50, chunkExitsPerStep: 8, stripePeriodRows: 2, conesPerEnd: 3, coneEveryM: 1.1 },
incidents: { durationS: 90, phantomLenM: 4.6, preferMultiLane: true, hazardBlinkHz: 1.5 },
weather: {
  mode: 'despejado', intensity: 0.7,
  current: { v0Mul: 1, TAdd: 0, bMul: 1 },     // read by idm.js every call
  rain: { v0Mul: 0.8, TAdd: 0.4, bMul: 0.85, dropCount: 10000, areaM: 280, heightM: 120, fallMs: 60,
          fogNear: 350, fogFar: 1400, skyColor: 0x2a313c, asphaltDarken: 0.55, sunMul: 0.45, hemiMul: 0.75 },
},
dayNight: {
  timeOfDay: 12, auto: false, gameDayMin: 6,
  stops: [ /* {h, sky, fog, hemi, sunI, sunColor} at h = 0,5,7,9,12,17,19,21,24 */ ],
  headlights: { onBelowSunI: 0.35, poolLenM: 7, poolWidthM: 2.4, dotSize: 0.3 },
  lamps: { classes: ['primary','secondary'], spacingM: 45, maxCount: 240, heightM: 6, glowColor: 0xffc97a },
  windows: { emissive: 0xffd089, maxIntensity: 0.15 },
},
```
Defaults = identity/clear/noon/auto:false ⇒ the existing 8 e2e tests see zero behavioral change.

## 2. C1 — module-by-module

- **network/routing.js**: `buildRouting(graph, closedSet=null)` per D2.
- **sim/simulation.js**: `let routing`; `closuresDirty/closedEdges Set/incidents[]/closureVersion`. Stamp `e._closed=false` in the one-time wiring loop. `closeEdge(id)/openEdge(id)` (resolve twin, flags both, dirty, version++, return affected ids). `applyClosures()` at top of step() (sync or chunked per D2; assigns `routing` AND `network.routing`; then reresolveRoute all vehicles on real lanes). Closed-guards in setRouteForLane/pickFallbackConn/mandatory scan. Spawn loop: skip closed entries. Decide loop: `if (veh.isPhantom) { veh._a = 0; continue; }`. `triggerIncident(opts)`: lane = opts.laneId (main passes followed vehicle's lane if real) else weighted pick (prefer laneCount≥2, most vehicles, not closed, not connector); phantom = createVehicle(rng, lane, 'sedan') then v=0, isPhantom=true, len=phantomLenM, nextConn=null; s = mid-lane adjusted into largest gap; insertSorted into lane.vehicles ONLY. Record {id, lane, s, until}; closureVersion++. Expiry at end of step (reverse loop, allocation-free): removeFromSeg + splice + version++. Transition safety net: entering a connector whose outEdge._closed ⇒ re-resolve, else nextConn=null. Sim exports: closeEdge, openEdge, closedEdges getter, triggerIncident, clearIncidents, incidents getter (lazy), closureVersion, routingVersion.
- **sim/vehicle.js**: `isPhantom: false` in factory.
- **sim/detectors.js**: skip isPhantom in computeEdgeSpeedRatios + occupancy (counted inner loop, 0.5 s cadence).
- **render/roadMesh.js**: unified repaint() per D3; notifyClosuresChanged(); `edgeForVertex(vIdx)` (binary search heatmapRanges by vertStart) + expose `ribbonMesh`; `setWetness(k)` API stub (C1 lands it, C2 calls it: material.color = base × lerp(1, asphaltDarken, k)); getHeatmapState() shape unchanged.
- **render/picking.js**: `createPicking(view, getVehiclesMesh, onPick, opts)` with `opts={isObrasMode, getRoads, onRoadPick}`; obras mode: raycast ribbonMesh, face.a → edgeForVertex → onRoadPick({edge, twin}); vehicle path untouched.
- **render/worksMesh.js** (NEW, per-world): cone InstancedMesh (orange cylinder + white band, vertex-colored, busStopsMesh pattern, capacity 256). refresh(sim, network) on closureVersion change (polled): 3 cones across road width at posAt(0)/posAt(length) of both directions' outer lanes per closed pair; cones around incident phantoms. Blinking hazard: tiny additive amber-sphere InstancedMesh, `count = blinkOn ? n : 0` via floor(simTime×2×hazardBlinkHz)%2. dispose().
- **main.js (C1 block)**: worksMesh in makeWorld + RAF update(sim.time); picking opts (onRoadPick toggles close/open + roads.notifyClosuresChanged()); __SIM__: closeEdge/openEdge (also notify roads), closedEdges, triggerIncident, incidents.
- **gui.js (C1 block)**: folder «Obras e incidentes»: checkbox "Modo obras (clic en calle) 🚧", button "Provocar incidente", button "Reabrir todo". Closures are per-network runtime state (cleared on world swap) — nothing in applyTo.

## 3. C2 — module-by-module

- **sim/idm.js**: per D5 (~5 lines).
- **render/environment.js** (NEW, owned by app, survives swaps): createEnvironment(view) → {setTimeOfDay, setAuto, setWeather, setShadowsEnabled, applyTo(world), update(sim, wallDt, camera), state, dispose}. Precomputed gradient stop arrays; apply() lerps into existing Color objects (no allocs); sun position arc around frame center (scene.getFrameInfo()); `sun.castShadow = userShadows && sunI > 0.05` (refunds night-light cost). Weather after ramp: fog/sky toward rain values × intensity, sunMul/hemiMul, roads.setWetness(i), building emissive = windows.emissive × nightFactor × maxIntensity (uniform on merged Lambert — per-window masks rejected for v3). auto: hour advances by sim.time / (gameDayMin×60) × 24, re-apply at ~10 Hz wall gate. setWeather mutates CONFIG.weather.current in place. nightFactor = smoothstep on sun elevation, exposed via state. applyTo(world) re-applies wetness/lamps/emissive on fresh worlds; attachBuildings → environment.refreshWorld() after async attach.
- **render/rain.js** (NEW, owned by environment): ONE THREE.Points, dropCount positions seeded once in areaM×heightM×areaM box; ShaderMaterial (~30 lines): vertex wraps y = mod(y0 − uTime×uFall, uHeight), recenters XZ on uCamPos with modulo wrap (GPU recycling, zero CPU writes); fragment soft vertical streak, additive-ish, depthWrite:false, fog:false. Intensity → setDrawRange + opacity uniform. setEnabled toggles visible.
- **render/streetLampsMesh.js** (NEW, per-world): static pole InstancedMesh + additive glow InstancedMesh + additive ground-pool quads. Positions: one per signalized junction (offset nodeRadius+1 right of first inbound lane) + every spacingM along edges of lamps.classes (right side, posAt elevation), cap maxCount. setNight(f): glows visible = f > 0.25, opacity ∝ f. No per-frame work.
- **render/vehiclesMesh.js**: headDotsMesh (small warm MeshBasicMaterial boxes at headlight positions) + headPoolMesh (additive transparent depthWrite:false flat unit plane scaled poolWidthM×poolLenM at pos + fwd×(len/2+poolLen/2) slightly above road). HEAD_DIMS per type mirroring BRAKE_DIMS. **Emit headlight instances BEFORE the brake-light block** (it destroys _right/_bUp/_fwd by in-place scaling) using NEW dedicated scratch vectors (_r2/_u2/_f2). update(alpha, nightFactor=0): below threshold both counts=0. +2 draw calls at night.
- **render/scene.js**: expose getFrameInfo() → {cx, cz, span} (stored by frame()); nothing else.
- **main.js (C2 block)**: app.environment after createScene; streetLampsMesh in makeWorld; RAF: environment.update(world.sim, wallDt, camera); pass nightFactor into vehiclesMesh.update; attachBuildings → refreshWorld. __SIM__: setWeather(mode,intensity), weather getter, setTimeOfDay(h), timeOfDay, environment getter ({nightFactor, sunIntensity, headlightCount, rainVisible, lampGlowVisible}).
- **gui.js (C2 block)**: folder «Clima y hora»: dropdown Clima [despejado, lluvia], slider Intensidad de lluvia 0–1, slider Hora del día 0–24 (step 0.25), checkbox Ciclo automático. gui routes sombras through environment.setShadowsEnabled (it owns sun.castShadow now). applyTo → environment.applyTo(world).

## 4. Execution: scaffold → parallel → integrate

**Phase 0 — Scaffold (one agent, small)**: config.js (all 4 blocks), gui.js (both folders, calls guarded `?.`), main.js (hook/makeWorld stubs guarded `?.`), explainer.js (both sections §7). Suite must stay green (defaults are no-ops). Mark blocks with `// --- C1 ---` / `// --- C2 ---` comments.

**Phase 1 — parallel (disjoint ownership):**
| Agent C1 owns | Agent C2 owns |
|---|---|
| network/routing.js | sim/idm.js |
| sim/simulation.js, sim/vehicle.js, sim/detectors.js | render/environment.js*, render/rain.js* |
| render/roadMesh.js (incl. setWetness API) | render/streetLampsMesh.js*, render/vehiclesMesh.js |
| render/picking.js, render/worksMesh.js* | render/scene.js (getFrameInfo only) |
| tests/v3-c1.spec.js* | tests/v3-c2.spec.js* |

Each fills ONLY its own marked block in main.js/gui.js (small additive hunks inside the scaffolded stubs).

**Phase 2 — Integration**: reconcile main/gui blocks, full suite `SIM_PORT=5174 npx playwright test`, npm run build, deviations, screenshots.
**Phase 3 — Adversarial verification** (C1, C2, regression v2/v2.1) + fix loop.
**Phase 4 — Deploy** (commit, push, poll Render, verify production).

## 5. Verification assertions

**C1 (tests/v3-c1.spec.js)**: pick interior twin-paired edge, NOT the space-time corridor (`name !== __SIM__.spaceTime.corridorName`), no detector on it. closeEdge ⇒ closedEdges has id+twin, routingVersion++. Drain: within 60 sim-s @4× no vehicle on id/twin (guard: connectors lack edgeId) and vehicleCount > 20. Visual: heatmap OFF ⇒ colors non-white inside closed range, white outside; heatmap on→off ⇒ closed range still striped; openEdge ⇒ exact all-white (test-7 contract). Incident: triggerIncident({durationS:30}) ⇒ incidents.length 1; phantom in lane.vehicles, NOT in sim.vehicles; demand 5000 ⇒ queue forms behind (some v<0.5 upstream); multi-lane ⇒ overtake (soft assert); after duration ⇒ zero incidents, zero phantoms.

**C2 (tests/v3-c2.spec.js)**: setWeather('lluvia',1) ⇒ current ≈ {0.8, +0.4, 0.85}; mean speed under rain < despejado × 0.95 (60 sim-s windows); rainVisible. despejado ⇒ exact {1,0,1}, rain hidden. setTimeOfDay(0) ⇒ sunIntensity < 0.1, nightFactor > 0.9, headlightCount > 0, lampGlowVisible; setTimeOfDay(12) ⇒ nightFactor 0, headlightCount 0, noon ramp value exact (idempotence). Ciclo automático ⇒ timeOfDay strictly increases. Rain+night composes console-clean (OFFLINE_ERROR_RE filter).

## 6. Risks

Routing race → coalesced step-start + local guards + atomic double-buffer swap. Determinism → closeEdge/triggerIncident consume RNG (acceptable); reresolveRoute skips pickNextStop. Corridor/detector edge closed → panel stops accruing (tests pick other edges; document). Rain perf → GPU-recycled Points, tunable dropCount; night shadow pass disabled refunds cost. Light restore → pure ramp (D4); sombras toggle routed via environment. Test-7 white contract → legacy exact path + regression assert. Phantom leaks → never in vehicles[], factory field. All-exits-closed → existing fallbacks, despawn at barrier.

## 7. Explainer (Spanish)

- «Obras e incidentes»: Activa **Modo obras** y hacé clic sobre una calle para cerrarla (ambos sentidos): los vehículos adentro salen y **recalculan su ruta**, nadie nuevo entra, los conos marcan el cierre. **Provocar incidente** detiene un vehículo 90 s en un solo carril: cola por IDM detrás y, si hay otro carril, MOBIL genera el adelantamiento — miralo con el mapa de calor.
- «Clima y ciclo día/noche»: Con **lluvia** todos bajan su velocidad deseada (×0.8), amplían el hueco (+0.4 s) y frenan más suave: la capacidad cae sin tocar la demanda. La **hora del día** mueve el sol, enciende faros, farolas y ventanas. Experimento: misma demanda 12:00 despejado vs 22:00 lluvia — mirá el diagrama fundamental.
- «Experimentos sugeridos»: + cerrar la avenida principal y ver el re-ruteo en el heatmap; + lluvia con demanda alta vs despejado.

## Deviations V3
(Builders append here.)

- **[Phase 0] Explainer register**: §7 sample text uses voseo («hacé clic», «miralo», «mirá»); the shipped explainer sections use tuteo («haz clic», «míralo», «mira») to match every existing explainer section. Content otherwise verbatim.
- **[Phase 0] dayNight.stops units (decision, for C2)**: `sunI`/`hemi` in `CONFIG.dayNight.stops` are ABSOLUTE three.js light intensities anchored to scene.js — the h=12 stop is exactly the legacy scene (sky/fog `0x101720`, hemi `2.1`, sunI `2.6`, sunColor `0xfff2dd`) so `apply(12)` is idempotent with the untouched scene (C2 test "noon ramp value exact"). `headlights.onBelowSunI: 0.35` therefore compares against that absolute scale (headlights switch on between ~19 h and ~21 h).
- **[Phase 0] Scaffold semantics**: `createPicking` already receives the C1 `opts` 4th argument (ignored by the legacy signature); `__SIM__` closure/incident/weather hooks exist now and return `null`/identity until C1/C2 land; gui «Sombras» falls back to the legacy direct `sun.castShadow` toggle while `app.environment` is null.
- **[C2] createEnvironment(view, getWorld)**: §3 lists `createEnvironment(view)`; the implementation takes a second arg — a lazy world getter (`() => app.world` in the main.js C2 block). Per-world pieces (roads `setWetness`, `streetLampsMesh.setNight`, buildings window emissive, `vehiclesMesh.headlightCount`) are resolved through it on EVERY apply, so the environment survives world swaps with zero re-wiring and `applyTo(world)` / `refreshWorld()` both reduce to the same pure `apply()` (D4 kept intact).
- **[C2] headlight gate plumbed as `state.headlightFactor`**: the scaffolded RAF block read `state.nightFactor` for vehiclesMesh; shipped code passes `state.headlightFactor` instead (1 − smoothstep on sunI vs `headlights.onBelowSunI`, per §0). Rationale: nightFactor (sun-elevation smoothstep, drives lamps/windows) reaches 1 by ~18:00 while sunI is still 0.9 at 19:00 — headlights would have switched on two hours early. Lamps ~17:50, headlights ~20:15, exactly the spec's "between ~19 h and ~21 h".
- **[C2] additive pool opacities tuned up**: headlight ground pool 0.5 (× headlight factor), lamp ground pool 0.3 (× nightFactor). The first-pass 0.3/0.22 were nearly invisible over the night asphalt at typical camera distances (verified with a forced-red A/B screenshot — geometry was correct, the add was just too dim).
- **[C2] rain drop seeding**: build-time xorshift64 (BigInt) instead of the sim RNG — purely visual, keeps `createRng` consumption (and thus sim determinism) untouched by weather toggles.
- **[C2/infra] playwright `workers: 2`**: with three spec files of heavyweight WebGL sims at 4× (e2e + v3-c1 + v3-c2), the default file-level parallelism (3 SwiftShader pages) starved pages into rotating `waitForFunction` timeouts — never assertion failures. Capped to 2 workers in playwright.config.js; v3-c2 C2-1 wall budgets widened (sim-time assertions unchanged).
- **[C1] routing.js also exports `createRoutingBuilder(graph, closedSet)`**: D2's budgeted/chunked rebuild needs per-exit increments, so the build loop lives in a builder (`build(k) -> done`, `finish() -> routing`); `buildRouting(graph, closedSet = null)` (the spec signature) is a thin `build(Infinity)` wrapper. Double buffering is inherent: the builder's Maps are fresh and the live routing object is untouched until `finish()` is swapped in at step start.
- **[C1] `createWorksMesh(network, sim)`** (spec/scaffold said `createWorksMesh(network)`): the RAF hook is `update(simTime)` only, so the mesh keeps the sim reference from construction to poll `sim.closureVersion` and read `closedEdges`/`incidents` on refresh. Per-world lifecycle unchanged.
- **[C1] §5 "white outside" amended to "uniform asphalt outside"**: D3 paints OPEN ranges per-vertex ASPHALT whenever closures exist (material is forced white so stripes render pure; white open vertices would render washed-out white streets). v3-c1 test 1 therefore asserts: closed range = striped (≥2 colors, none white), open ranges = uniform asphalt RGB ≠ white, and `openEdge` ⇒ exact `fill(1)` + roadColor material (test-7 all-white contract intact whenever `heatmapOn === false && closedCount === 0`).
- **[C1] incident pick reweighted (spec §2 "weighted pick... most vehicles")**: instantaneous per-LANE occupancy proved useless — measured pick landed on an edge with zero inflow for 200 sim-s (most lanes show 0 vehicles at any instant). Shipped: weighted pick over EDGES by `classWeight × (1 + 2·edgeOccupancy) × (multiLane ? 4 : 1)`, then within the edge the lane maximizing `2·inboundConnectors + vehicles` (a busiest-now lane with zero inbound connectors starves — single-lane feeders map to lane index 1 via `throughOutIdx`, so lane 0 of many 2-lane edges never receives traffic). `lane._inConnCount` is stamped in the sim's one-time wiring loop.
- **[C1] v3-c1 test 2 incident choreography** (spec §5 says one `triggerIncident({durationS:30})`): a 30 sim-s incident expires ~7.5 s wall after trigger at 4× — every assert raced expiry. Shipped: (a) 600 s observation incident via the official `opts.laneId` path on a SINGLE-lane fed street with followers already upstream — on 2-lane edges MOBIL legitimately drains followers around the phantom for 100+ sim-s (that IS the emergent overtaking), so `v<0.5` standstill there is saturation-dependent, while a 1-lane street queues deterministically; (b) separate multi-lane incident for the soft overtake assert (observed true in standalone runs, logged not failed); (c) `clearIncidents()` then a fresh 20 s incident for the expiry lifecycle. All spec assertions preserved.
- **[C1] gui «Provocar incidente»** reads the followed vehicle through `window.__SIM__.follow` (the gui receives `app`, which has no follow reference); passes `{laneId}` only when the followed vehicle sits on a real lane, else the sim's weighted pick.
- **[C1] verification utilities**: `scripts/c1-smoke.mjs` (closure+incident smoke against :5174, no test runner) and `scripts/c1-screenshot.mjs` (reproducible `docs/screenshots/v3-obras.png`: cone barrier at the junction, hazard-striped closed road, heatmap on, traffic rerouting).
