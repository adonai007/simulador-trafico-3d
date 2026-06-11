# DESIGN SPEC V2 — Elevación real, Paradas de micro, Heatmap, Espacio-tiempo

> Authoritative spec for the 4 approved features. Builder agents follow this exactly; deviations documented at the bottom. UI text SPANISH, code English. Conventions from V1 still apply: zero per-frame allocations, stable object shapes, every render module returns `{..., dispose()}`, GUI persists via `applyTo`, static-site constraint (every new remote fetch needs a bundled fallback for the default La Paz zone).

## Verified architecture facts (do not re-derive)

- Lane: `{id, edgeId, index, points:[{x,z}], cumLen, length, speedMs, vehicles[], outConnectors[], isConnector, pointAt(s,out), headingAt(s,out)}` (src/network/lanes.js:21-36; impl src/util/math2d.js:146-200, pure 2D, binary search + lerp, zero-alloc `out`). Connectors wrap the same API (connectors.js:1-8).
- Edge: `{id, fromNode, toNode, points, trimmedPoints, lengthM, laneCount, speedMs, highwayClass, oneway, twinId, wayId, lanes[]}` (graph.js:198-211). Road ribbons built per UNDIRECTED pair (forward twin wins, roadMesh.js:91).
- Vehicle: vehicle.js:65-111; accel: `idmAccel` pure (idm.js:8-14) applied in `decide()` simulation.js:284-328 (aCar line 301, restrictive min() terms 302-327, `veh._a` line 326, integration 469). Step order 429-504.
- roadMesh stripGeometry per edge (roadMesh.js:9-35), indexed, y=0 at line 17, merged ~line 172, MeshLambertMaterial. Per-edge geoms exist pre-merge.
- Ground: unit plane y=0 (scene.js:46-51, frame() ~80). Buildings base y=0 (buildings.js:77). sampleVehiclePose 2D (vehiclesMesh.js:49-78); makeBasis 379-380, y=0.05 hardcoded.
- Detectors per-edge ring buffers (detectors.js:52-78); 0.5 s metrics gate in update() ~158. chart.js panel pattern (panel/header/body/canvas, collapse, 5 s cadence).
- GUI lil-gui folders (gui.js:14-80), persists via gui.applyTo(world) (main.js:148). parse.js keeps ALL node tags (line 104); snapshot has 7 highway=bus_stop nodes. World rebuild main.js:127-150. buildNetwork is synchronous — elevation must be fetched BEFORE it and passed in (both call sites async already). Edges do NOT carry way `name` (only wayId). buildHighwayQuery only recurses way nodes (overpass.js:14) — standalone bus_stop nodes beside the road are missed in searched zones.

---

## F1 — Real elevation/grades (foundation; FIRST)

### Data
- Open-Meteo elevation API: `https://api.open-meteo.com/v1/elevation?latitude=L1,L2,...&longitude=...` — CORS, free, no key, batches of 100. (Terrarium tiles rejected.)
- Key by lat/lon GRID, not node-id (node ids don't survive collapse/merge). Grid ~50 m step, clamp max 48×48, over bbox + 20% margin. Default zone ≈ 27×27 = 729 pts = 8 requests.
- `scripts/fetch-default-elevation.mjs` (plain node fetch loop, run once, commit output) → `public/data/default-elevation.json`: `{lat0, lon0, latStep, lonStep, cols, rows, values:[...]}`.

### src/geo/elevation.js (new)
- `fetchElevationGrid(lat, lon, radiusM)` → grid JSON. Batches 100, concurrency 4, AbortController timeout (CONFIG ~10 s). Throws on failure.
- `createElevationSampler(grid, projection)` → `{elevAt(x,z), minElev, maxElev, flat:false}` — bilinear in local meters, pre-converted once, clamped outside grid.
- `FLAT_SAMPLER = {elevAt:()=>0, minElev:0, maxElev:0, flat:true}` — fallback for searched zones; Spanish toast "Sin datos de elevación — terreno plano".

### src/network/elevation.js (new) — applyElevation(graph, lanes, connectors, sampler)
Called at end of buildNetwork (after buildConnectors):
1. `node.elev = sampler.elevAt(node.x, node.z)` for kept nodes.
2. Edge profiles ONCE per undirected pair (forward twin computes, twin = reversed copy — guarantees direction agreement): sample at trimmedPoints; moving-average smooth window ≈30 m; **junction plateau** — ease endpoints to adjacent `node.elev` over last ~12 m (KEY: keeps disc/ribbon-end/connector continuous); forward+backward grade clamp |Δe/Δs| ≤ 0.15. Store `edge.elevVals` (Float32Array per trimmedPoints idx) + `edge.elevCum`.
3. Lane elev: `lane.elev = Float32Array(lane.points.length)`, entry i samples edge profile at arc fraction (lanes share longitudinal profile, no cross-lane tilt).
4. Connector elev: lerp(inEnd, outStart) — flat-ish thanks to plateau.
5. Segment API on lanes AND connectors ALWAYS (monomorphic, flat sampler included): `posAt(s,out)` → `{x,y,z}` via new `pointAtParam3(points, cumLen, elev, s, out)` in math2d.js (ONE binary search; elev===null → y=0). `gradeAt(s)` → signed forward slope from same search; flat → shared ZERO_GRADE fn. Existing pointAt/headingAt UNTOUCHED (2D callers zero churn).
6. `network.elevation = sampler` exposed.

Plumbing: `buildNetwork(osmJson, center, sampler = FLAT_SAMPLER)` (build.js:33). main.js init() fetches /data/default-elevation.json alongside network snapshot; rebuildWorld() tries fetchElevationGrid (await, behind loading overlay), falls back FLAT_SAMPLER.

### Physics (simulation.js decide(), after line 301)
- CONFIG.vehicleTypes gains `gradeFactor`: camion 1.0, micro 0.9, suv 0.7, sedan/taxi 0.6, hatchback 0.55. Copy onto vehicle at creation (stable shape).
- `aCar += clamp(-9.81 * veh.seg.gradeAt(veh.s) * veh.gradeFactor, -3.0, +1.2)` BEFORE restrictive min() terms. Uphill: trucks crawl on >6%. Downhill boost capped +1.2; IDM free term limits overspeed.
- Pass aGrade into MOBIL ctx (`_mctx.aGrade`), add to aNew inside evaluateLane (mobil.js:72) — symmetric incentive, one line.

### Render
- roadMesh: `stripGeometry(left, right, rowY?)` optional per-row elevation (row i = centerline elev at trimmedPoints[i]; left/right share). Ribbons + center strips pass edge.elevVals. Dashes: quad corners at profileAt(s). Stop lines: `lane.posAt(lane.length).y`. Junction discs: translate(node.x, node.elev, node.z). Mesh-level position.y = R.roadY stays.
- src/render/terrainMesh.js (new): PlaneGeometry ~96×96 segs over bbox+margin, displaced by sampler; then ROAD-SPLAT pass: walk every edge profile ~3 m steps, terrain vertices within (half road width + 6 m) pulled to min(y, roadElev − 0.5); one smoothing pass after. (Kills poke-through where real slope exceeds the 15% clamp.) Lambert ground color, receiveShadow. scene.js: `view.setGroundVisible(v)`; makeWorld hides flat ground when terrain exists (keep for flat-sampler worlds). Per-world, disposed on swap.
- buildings.js: `addBuildings(scene, opts, sampler)` — translate y by min(elevAt over footprint verts) − 0.5. main.js attachBuildings passes world.network.elevation.
- vehiclesMesh: sampleVehiclePose writes `outP.y` (seg.posAt) and `outH.y = gradeAt(s)` (pitch). ALL scratch objects pre-initialized `{x:0,y:0,z:0}` (incl. follow.js) — hidden classes stable. update(): `_fwd.set(h.x,h.y,h.z).normalize(); _right.crossVectors(_up,_fwd).normalize(); _bUp.crossVectors(_fwd,_right); makeBasis(_right,_bUp,_fwd); setPosition(px, _p.y+0.05, pz)`. Brake bar reuses basis.
- signalsMesh: approach y = lane.posAt(lane.length).y; pole/lamp positioned with it.
- follow.js: camera/target use `_p.y + CAM_UP` / `_p.y + 1.2`. debug.js: parallel elev array when provided.
- Picking, camera frame() unchanged.

### Config
```js
CONFIG.elevation = { apiUrl:'https://api.open-meteo.com/v1/elevation', batchSize:100, concurrency:4,
  fetchTimeoutMs:10000, gridStepM:50, gridMaxPoints:48, smoothWindowM:30, maxGrade:0.15,
  junctionPlateauM:12, terrainSegments:96, terrainDropM:0.5, gradeAccelClamp:{min:-3.0,max:1.2} }
```

### Risks/mitigations
Junction seams → plateau. Twin mismatch → single profile per pair. Terrain poke-through → road-splat. Hidden-class churn → pre-init y on all scratch. Hot loop → posAt/gradeAt one binary search, zero alloc. Offline default → bundled JSON.

### Verification F1
Expose `__SIM__.elevation = {min,max,flat}`. Default zone: max−min > 30. Some lane |gradeAt(mid)| > 0.03, all ≤ 0.15. sampleVehicle() gains y; moving vehicle's y changes > 1 m over 10 s on a graded lane. Existing e2e tests 1-3 stay green. Screenshot terrain.

---

## F2 — Micros stopping at bus stops

- parse.js: collect `busStopNodes: [{id, lat, lon, tags}]` where tags.highway==='bus_stop' (mirror signalNodeIds pattern ~line 105).
- overpass.js buildHighwayQuery: union `( way(...)[highway~...]; node(around:r,lat,lon)["highway"="bus_stop"]; ); (._;>;); out body;` (bundled snapshot already has 7 — no rebuild).
- src/network/busStops.js (new) — buildBusStops(graph, parsed, projection), called from build.js after buildLanes: project stop → nearest edge ≤ 25 m (build-time O(stops×edges×points) fine) → RIGHTMOST lane; new `projectPointToPolyline(points, cumLen, p)` → `{s, dist}` in math2d.js; clamp s to [15, length−15]; drop on short lanes. Output `network.busStops = [{id, laneId, lane, s, name}]`; `lane.busStops` ascending-s array; makeLaneFromPoints gains default `busStops: null` (stable shape, connectors too).
- Sim: vehicle factory adds `nextStopS:-1, nextStopIdx:-1, dwellUntil:-1, isMicro: type==='micro'` (cached bool). On lane entry: if isMicro && seg.busStops — first stop with s > veh.s+5, rng once per lane entry with stopProb 0.85 → set nextStopS/idx else -1.
- decide() additions (same min() pattern, after signal/conflict block):
  - Dwelling (`time < dwellUntil`): `veh._a = Math.max(-5, -veh.v/dt)`, return early — exact standstill; followers queue + MOBIL overtaking free. DO NOT set `_blocked` (deadlock breaker stays out).
  - Else if nextStopS ≥ 0 && enabled: `gapToStop = nextStopS − s − len/2`; `aStop = idmAccel(v, v0, max(gapToStop, 0.05), v, idm)`; min into a. When v < 0.3 && gapToStop < 1.5 → `dwellUntil = time + clamp(exp(meanDwellS), min, max)`; advance nextStopIdx.
- maybeLaneChange: skip when dwelling or nextStopS − s < 40.
- Toggle-off: enabled=false → skip stop logic entirely AND release dwellers.
- src/render/busStopsMesh.js (new): one static InstancedMesh (pole cylinder + sign box + bench), at lane.posAt(s) offset laneWidth/2 + 1.2 m right of travel (n = (−hz, hx)), y from posAt. Built in makeWorld, disposed on swap.
- GUI (Tráfico folder): checkbox "Paradas de micro" → CONFIG.busStops.enabled; slider "Parada media (s)". Explainer: section "Micros y paradas".
- `CONFIG.busStops = {enabled:true, maxSnapDistM:25, meanDwellS:12, minDwellS:8, maxDwellS:25, stopProb:0.85}`.

### Verification F2
`__SIM__.network.busStops.length === 7` (default). At 4×: some micro reaches dwell (v<0.5, time<dwellUntil), later resumes (v>2). Toggle off → none dwelling after 30 sim-s.

---

## F3 — Congestion heatmap

- detectors.js, inside existing 0.5 s hud gate: `computeEdgeSpeedRatios()` — init `edge._speedRatio = 1`; per tick per edge: mean v over lanes' vehicles → `target = count ? mean/edge.speedMs : 1`; `ratio += k*(target−ratio)`, k = hudIntervalS/5 (τ≈5 s). O(edges+vehicles), zero alloc.
- roadMesh.js: pre-merge record `heatmapRanges.push({edge, twin, vertStart, vertCount})` (prefix-sum of strip position.count; mergeGeometries concatenates in array order → exact). Post-merge: `color` Float32 attribute (3 comp, DynamicDrawUsage) filled WHITE; material `vertexColors: true` from creation — **white × material.color = current look exactly, no recompile, off costs nothing**.
- ON: roadMat.color → white; per range write ramp from `ratio = min(edge._speedRatio, twin?._speedRatio ?? 1)` (worst direction): green ≥0.8 → yellow 0.45 → red ≤0.2; module scratch, straight into attribute.array, needsUpdate. OFF: restore roadMat.color = roadColor + refill white once.
- API on returned object: `setHeatmap(enabled)`, `updateHeatmap()` (writes only when enabled). main.js frame loop: 1 Hz wall-clock gate. Junction discs stay asphalt (documented limitation).
- GUI (Vista): checkbox "Mapa de calor". Expose `__SIM__.setHeatmap(b)`, `__SIM__.minSpeedRatio`.

### Verification F3
setDemand(5000), 90 sim-s → minSpeedRatio < 0.5. Heatmap ON → sampled color attribute in a known range non-white. Screenshot.

---

## F4 — Space-time trajectory diagram

- graph.js prereq: keep `name: way.tags?.name ?? null` through splitWays → emitDirectedEdges → collapseDegree2 (additive field).
- src/network/corridor.js (new): `findCorridor(network)` — group edges by `name || 'way:'+wayId`; chain by toNode→fromNode connectivity (single direction); pick max total length chain (El Prado wins naturally); fallback longest edge. Return `{name, lengthM, baseS: Map(edgeId→cumOffset), connBaseS: Map(connectorId→cumOffset), speedMs}` — include connectors whose inEdgeId/outEdgeId both in chain (no trajectory gaps). Auto-only v1.
- src/ui/spaceTime.js (new, clone chart.js pattern): panel/header/body/canvas/hint, collapsible, dpr-scaled 320×230. Header "Diagrama espacio-tiempo — {name}"; hint "x = tiempo, y = distancia; bandas rojas diagonales = ondas de choque".
- Ring buffers preallocated: ts/ss/vs Float32Arrays, capacity ≈ 36k (300 s × ~120 veh), head/count overwrite-oldest. update() per frame with own 1.0 sim-s cadence: iterate sim.vehicles, look up seg.edgeId in baseS (or seg.id in connBaseS), push (time, base+s, v). Zero alloc.
- Redraw on sample tick when expanded: x=[time−300, time], y=[0, lengthM], 2×2 fillRect per sample, color by v/speedMs (red <0.3 / yellow / green ≥0.75) via 8 precomputed color-string buckets.
- World-swap: `if (sim !== lastSim) { recompute corridor; reset ring; }` (chart.js pattern). Expose `__SIM__.spaceTime = {sampleCount, corridorName, corridorLength}`.

### Verification F4
corridorLength > 200; sampleCount strictly increasing over 10 s wall at 4×; DOM contains "Diagrama espacio-tiempo"; congestion screenshot shows red diagonal bands.

---

## Execution order & file ownership

**Stage 1 — F1 alone.** Owns/edits: geo/elevation.js*, network/elevation.js*, render/terrainMesh.js*, scripts/fetch-default-elevation.mjs*, public/data/default-elevation.json*, util/math2d.js, network/lanes.js, network/build.js, sim/simulation.js, sim/mobil.js, sim/vehicle.js, render/roadMesh.js, render/scene.js, render/buildings.js, render/vehiclesMesh.js, render/signalsMesh.js, render/debug.js, ui/follow.js, main.js, config.js.

**Stage 2 — F2/F3/F4 PARALLEL (disjoint core ownership; do NOT touch shared files — return integration manifests instead):**
| Agent | Owns exclusively |
|---|---|
| F2 | osm/parse.js, osm/overpass.js, network/busStops.js*, render/busStopsMesh.js*, sim/vehicle.js, sim/simulation.js |
| F3 | render/roadMesh.js, sim/detectors.js |
| F4 | network/graph.js, network/corridor.js*, ui/spaceTime.js* |

Shared (integration pass only): main.js, config.js, ui/gui.js, ui/explainer.js, network/build.js, tests/e2e.spec.js.

**Stage 3 — Integration:** apply manifests to shared files, wire modules, full build + Playwright suite + visual pass, screenshots.
**Stage 4 — Adversarial verification per feature** against :5173 (assertions above). Fix loop until green.
**Stage 5 — Deploy:** commit + push main → Render auto-redeploy → verify https://simulador-trafico-3d.onrender.com live.

## Deviations V2

(Builders: append here.)

**Builder F1 (real elevation/grades), 2026-06-11:**

1. **Node-elevation graph relaxation before edge profiles** (network/elevation.js `relaxNodeElevations`, not in spec): La Paz centro has short blocks whose node-to-node mean grade exceeds the 15% clamp; the spec'd smooth→plateau→clamp pipeline then CANNOT honor both junction continuity and ≤15% — the literal forward/backward clamp shifted profile endpoints off `node.elev`, producing cliff steps at discs and connector grades up to **2.2** (measured). Fix: ≤24 Jacobi passes pull adjacent node elevations together until every undirected edge's end-to-end mean grade ≤ `0.8·maxGrade` over its trimmed length (roads are effectively "regraded"; terrain follows via the road-splat, so render stays consistent). After relaxation: max lane |grade| 0.1499, max connector |grade| 0.023, zero seam discontinuities.
2. **Feasibility-band clamp instead of plain forward+backward clamp** (`clampProfileBand`): values are clamped into the band `[max(eFrom−g·s, eTo−g·(L−s)), min(eFrom+g·s, eTo+g·(L−s))]` AND ±g·ds of the predecessor in one forward pass — provably keeps |de/ds| ≤ g everywhere while pinning BOTH endpoints exactly (junction continuity guaranteed, not just hoped for). Applied to edge profiles AND lane resamples (offset lanes on curves are shorter than the centerline, which pushed clamped grades back over the limit). Working limit is `maxGrade − 1e-4`: profiles are stored as Float32 and rounding pushed 11 lanes to 0.1500005 without the margin.
3. **Sampler normalizes to the projection origin**: La Paz sits at ~3600 m ASL; `createElevationSampler` subtracts the grid elevation at (0,0) so the query center renders at y=0 (camera frame()/fog/controls untouched, per spec "camera frame() unchanged"). `__SIM__.elevation.{min,max}` are therefore RELATIVE (default zone: min −82, max +104, relief 186 m — assertion `max−min > 30` unaffected). The committed grid JSON keeps raw meters.
4. **`CONFIG.elevation.gradeLowGearMs = 6` — uphill pull ramps in with speed** (`aGrade·min(1, v/6)` when aGrade < 0): the literal spec formula gives a camión at v=0 a net launch accel of 0.825−1.47 < 0 on a 15% street → permanent stall, and even a softer cap collapsed uphill queue discharge enough that e2e test 3 (congestion contrast) failed deterministically — the network slowly gridlocked at default demand. The speed ramp models low-gear torque: full launch accel from standstill, full gravity pull at cruise; vehicles settle at a crawl equilibrium instead of stalling (measured: camión 11.8 km/h on a 15% grade, sedán ~23 km/h). Downhill boost is NOT speed-scaled (gravity acts from standstill). All 5 e2e tests green with this model.
5. **fetchElevationGrid hardening**: 3 attempts per batch with quadratic backoff (Open-Meteo 429s on bursts — hit during the snapshot run), `null` elevations coerced to 0, and an opts `{concurrency, delayMs}` parameter so `scripts/fetch-default-elevation.mjs` runs serial+paced (1.5 s between batches). Default grid is **29×29 = 841 pts** (radius 600 m ×1.2 margin at 50 m step), not the spec's estimated 27×27.
6. **Terrain sizing/splat details**: plane spans bbox×1.7 per axis (spec said bbox+margin; the larger apron fills the horizon since the flat ground is hidden), the splat radius is floored at one cell diagonal (at 96 segs a cell is ~20 m — a strict `halfW+6` radius could miss every vertex of the containing cell and leave poke-through), and **junction nodes get their own splat** (radius `R_node+6` at `node.elev`) because edge walks stop at the trim radius and never cover disc interiors. Smoothing pass re-applies the splat constraint afterward so smoothed terrain stays under roads.
7. Misc: `gradeAtParam(cumLen, elev, s)` added next to `pointAtParam3` in math2d.js (gradeAt needs no points, only cum+elev); `ZERO_GRADE` lives in network/lanes.js; flat worlds keep `lane.elev = null` / `edge.elevVals = null` / `node.elev = 0` (stable shapes, monomorphic posAt/gradeAt from birth); buildings on flat worlds now sit at y = −0.5 (buried base) instead of 0; `__SIM__.sampleVehicle()` gained `y`. Transient `gradeLowGearMs is not defined` errors visible in long-lived HMR sessions during the build are mid-edit artifacts — fresh loads are clean.

**Builder F2 (micros stopping at bus stops), 2026-06-11:**

1. **`buildBusStops(graph, parsed, projection, connectors)` is called after buildConnectors, not "after buildLanes"**, and lanes.js was NOT edited: the stage-2 ownership table doesn't grant lanes.js to F2, so the spec'd `makeLaneFromPoints` default `busStops: null` lives inside buildBusStops instead — it stamps `busStops = null` onto EVERY lane and EVERY connector (hence the extra `connectors` argument) before any sim/render code touches a segment. Same stable-shape guarantee, zero shared-file churn.
2. **Stops snap to the rightmost-LANE polyline, not the edge centerline**: one `projectPointToPolyline` pass per (stop, edge) on the curbside lane yields the snap distance AND the stop's arc `s` directly, and on two-way streets the curb-distance comparison auto-selects the travel direction the stop was mapped beside (right-hand traffic) — the spec's "nearest edge → rightmost lane" two-step would need a second projection and can pick the wrong direction on twins.
3. **Dwell trigger is s0-aware**: `v < 0.3 && gapToStop < veh.idm.s0 + 0.5` instead of the spec's fixed `gapToStop < 1.5`. IDM's standing equilibrium against the virtual obstacle leaves gap ≈ s0 (2 m ±10% jitter) > 1.5 m, so the literal threshold never fires (measured: micros parked 2 m short of the stop forever, dwell never started).
4. **Dwell early-return sits at the TOP of decide()** (before the IDM/leader code), not "after the signal/conflict block" — it skips every other term, which is the cheapest correct reading of "return early". An overshoot guard (`gapToStop < −2` → stop skipped) covers re-enabling the toggle after a micro already passed its chosen stop.
5. **pickNextStop re-rolls on lane CHANGES too**: setRouteForLane is the single "entered a real lane" path (spawn, connector exit, applyLaneChange), so a micro that changes lane re-draws against the new lane's stop list — "rng once per lane entry" includes entries via lane change. maybeLaneChange's 40 m guard makes pathological re-roll loops impossible.
6. **busStopsMesh: pole + sign + bench merged into ONE vertex-colored geometry inside ONE InstancedMesh** (single draw call; spec wording implied per-part instancing). The bench is modeled at local −X: with `right = cross(up, fwd)` under the x=east/z=−south convention, local +X is the driver's LEFT, so curbside is −X (comment in module). Instance count 0 (no stops / flat searched zones) is valid and renders nothing.

**Builder F3 (congestion heatmap), 2026-06-11:**

1. **`minSpeedRatio` lives on the detectors metrics object** (`metrics.minSpeedRatio`, initialized 1 at creation — stable shape): the spec named the `__SIM__` getter but not the storage; `sim.metrics` is already the exposed metrics path, so main.js reads `app.world.sim.metrics.minSpeedRatio`. Updated every 0.5 s hud tick regardless of heatmap visibility (the e2e assertion must work with the heatmap off). Edges are snapshotted into a plain array at `createDetectors` time so the tick iterates index-based with zero allocations (no per-tick Map iterator).
2. **Ratio target is intentionally unclamped** (`mean/edge.speedMs` can transiently exceed 1 from v0 jitter ±10% and the downhill boost): the ramp maps anything ≥ greenRatio to green and `minSpeedRatio` takes a min, so values >1 are harmless and the spec formula is kept literal.
3. **Ramp anchor colors are module constants in roadMesh.js** (green 0.13/0.78/0.25, yellow 1.0/0.84/0.1, red 0.88/0.1/0.1); `CONFIG.heatmap` carries only thresholds + tau per spec, plus two additions: `updateHz` (main.js wall-clock repaint gate — spec's "1 Hz" made tunable) and `enabled` (initial GUI checkbox state, default false).
4. **`setHeatmap(true)` repaints immediately** instead of waiting up to one updateHz period for the main-loop gate (toggle feels instant); `setHeatmap(false)` restores `roadMat.color = roadColor` and refills the attribute white in the same call. Both no-op on worlds with no ribbons.
5. **`getHeatmapState()` test hook on the roadMesh return object** (`{enabled, colors, rangeCount, ranges}`; allocates — e2e only): buildings, vehicles, debug lines and (F2) bus stops also carry `color` attributes, so "traverse the scene for a mesh with vertex colors" is ambiguous; the e2e test reaches the ribbon attribute via `__SIM__.heatmap` → this hook instead.
6. Per-edge `_speedRatio ?? 1` guards in `updateHeatmap` cover the one instant during `makeWorld` where the road mesh exists but `createDetectors` hasn't stamped `_speedRatio` yet (build order: roads → sim); after that the field always exists and reads stay monomorphic.

**Builder F4 (space-time diagram), 2026-06-11:**

1. **Default-zone corridor is "Avenida 20 de Octubre" (1276 m), not El Prado**: the spec'd rule (max total-length single-direction chain per name group) picks it deterministically — Av. 16 de Julio's group in the snapshot totals 1059 m and is fragmented at Plaza del Estudiante. Rule followed literally; the parenthetical "(El Prado wins naturally)" was a prediction, not a constraint. Verified in node against the bundled snapshot: 13 edges + 24 connectors, zero twin pairs inside the chain, all connector offsets ordered.
2. **`baseS` offsets accumulate mean trimmed-LANE length + mean connector length, not `edge.lengthM`**: vehicle `s` lives on junction-trimmed lanes and crosses connectors between them; summing raw edge lengths would double-count every junction and sawtooth each trajectory at each crossing. All per-lane connectors of a chain pair share one `connBaseS` offset (per-lane length spread ≪ 1 px at diagram scale).
3. **"Single direction" is implemented as immediate-twin exclusion** in the chain walk (candidate `id === cur.twinId` skipped): a name group contains both directions, and the only edge that can reverse a chain onto itself at a node is the current edge's twin.
4. **`__SIM__.spaceTime.sampleCount` is a cumulative monotonic counter**, not ring-buffer occupancy — the F4 verification ("strictly increasing over 10 s") would fail once the ring saturates at capacity otherwise.
5. **x-window is `[max(0, time−windowS), …+windowS]`** — clamped to 0 until sim time passes `windowS` so startup doesn't label negative seconds; identical to the spec'd `[time−300, time]` thereafter.
6. **Panel CSS self-injected** from spaceTime.js (`<style id="spacetime-style">`, removed in `dispose()`) instead of an index.html hunk; the panel reuses `.panel` and sits LEFT of the fundamental diagram (`bottom: 16px; right: 372px`).
7. **graph.js `name` is purely additive**: on degree-2 collapse the surviving segment keeps its own name and only adopts the neighbor's when null (`a.name ?? b.name`); `name` is NOT part of the merge-compatibility predicate, so graph topology is bit-identical to pre-F4. Unnamed corridor groups display as "vía sin nombre".

**Integrator (Stage 3), 2026-06-11:**

1. **e2e tests renumbered**: all three manifests numbered their new test "6"; applied as 6 = F2 (paradas de micro), 7 = F3 (mapa de calor), 8 = F4 (espacio-tiempo) in `tests/e2e.spec.js`. Content otherwise verbatim from the manifests.
2. **config.js block order**: `busStops` (F2) sits after `elevation` as specified; `spaceTime` (F4) then `heatmap` (F3) both sit between `detectors` and `// ---- Rendering ----` — each manifest's placement constraint is satisfied, they just interleave.
3. **explainer section order**: 'Micros y paradas' between 'Semáforos y ondas verdes' and 'Ondas de choque' (F2 manifest); 'Mapa de calor de congestión' then 'Diagrama espacio-tiempo' between 'Diagrama fundamental' and 'Experimentos sugeridos' (F3 before F4 — both manifests claimed the same slot).
4. **Verification port is 5174, not 5173**: on this machine port 5173 is held by an unrelated project's Vite server (81_DIARIOMED_v3 "DentiMed") — it was NOT touched. Integration was verified against a second Vite instance of THIS project on port 5174 (`npx vite dev --port 5174 --host --strictPort`) using `playwright.integration.config.js` (a copy of playwright.config.js pointed at 5174, `reuseExistingServer: true`). The default `playwright.config.js` (5173) is left unchanged for machines without the port conflict; on this machine run the suite with `--config=playwright.integration.config.js`.
5. No index.html changes were needed (F4's panel CSS is self-injected; F2/F3 add no DOM).
6. **Test 6 locator fixed**: the bundled lil-gui version prefixes its CSS classes (`.lil-controller`, `.lil-boolean` — root is `.lil-gui.lil-root`), so the manifest's `.lil-gui .controller` locator matched nothing and the click hung to test timeout. Replaced with the version-agnostic `page.getByRole('checkbox', { name: 'Paradas de micro' })` (the input carries `aria-labelledby` → accessible name works).
7. **Test 8 warmup added**: on a freshly loaded page no vehicle has reached the corridor yet, so `sampleCount` was still 0 when the first increment was measured (0 > 0 failed). The test now waits for `spaceTime.sampleCount > 0` (≤ 60 s at 4×) before asserting strict growth; test timeout raised to 120 s.
