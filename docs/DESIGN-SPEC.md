# DESIGN SPEC — Simulador de Tráfico Urbano 3D (La Paz)

> Authoritative implementation spec. Builder agents: follow this exactly unless it contradicts reality (then document the deviation at the bottom under "Deviations").

## Fixed decisions

- **Default zone**: La Paz centro, Bolivia — Plaza del Estudiante / Av. Villazón / El Prado. Center `lat -16.5044506, lon -68.1302608`, radius **600 m**. Bundled snapshot at `public/data/default-network.json` (download once via curl from Overpass). Hardcode center next to it in `src/config.js` (projection origin must match snapshot center).
- **Runtime map search**: place name (Nominatim) or pasted Google Maps URL → Overpass fetch → rebuild network live.
- **Stack**: Vite + vanilla JS ES modules, `three` (latest stable), `lil-gui`. No TypeScript, no framework.
- **Style**: low-poly stylized, InstancedMesh everywhere, 60 fps with 300+ vehicles.
- **UI text: SPANISH. Code identifiers/comments: English.**
- **Traffic models**: IDM car-following, MOBIL lane changes, signalized intersections with phase cycles + green-wave offsets, connector conflict yielding, Poisson arrivals, vehicle mix 80% car / 12% truck / 8% sport, fixed timestep + accumulator, sim speed 0.25x–4x + pause.
- Node v20.20.2 / npm 10.8.2 available. Windows, PowerShell. Vite dev server port 5173 `strictPort`.

---

## 0. Scaffold

```
npm create vite@latest . -- --template vanilla   (then delete demo files)
npm i three lil-gui
npm i -D @playwright/test
```

- Delete `bash.exe.stackdump`.
- `vite.config.js`: default config + `server: { port: 5173, strictPort: true }`. No plugins.
- One-time data snapshot (dev task, not runtime): curl the Overpass query for La Paz (center -16.5044506, -68.1302608, radius 600) into `public/data/default-network.json`.

File tree (final):

```
index.html                      — canvas container, HUD divs, search box, explainer panel (Spanish strings live in HTML/UI modules only)
vite.config.js
package.json
playwright.config.js
public/data/default-network.json — bundled Overpass JSON (La Paz centro, offline default)
src/main.js                     — bootstrap: load network -> build sim -> build render -> RAF loop
src/config.js                   — all tunables: highway whitelist, lane defaults, IDM defaults, signal timings, clamps, default center
src/util/rng.js                 — mulberry32 seeded RNG (determinism for tests)
src/util/math2d.js              — polyline resample/offset/arc-length, pointAt(s), headingAt(s), bezier sampling
src/osm/geocode.js              — Nominatim search + Google-Maps-URL parser -> {lat, lon, radius}
src/osm/overpass.js             — buildQuery(lat,lon,r), fetchWithFallback(mirrors[]), abort/timeout
src/osm/parse.js                — Overpass JSON -> {nodes Map, ways[]} with tag normalization (oneway, lanes, maxspeed)
src/geo/projection.js           — lat/lon <-> local meters (equirectangular, origin = query center)
src/network/graph.js            — split ways at shared nodes -> directed edges, degree-2 collapse, SCC prune, entries/exits
src/network/lanes.js            — per-lane offset polylines, stop-line trimming, arc-length tables
src/network/connectors.js       — bezier turn connectors, lane-turn assignment, conflict pairs
src/network/signals.js          — signal detection + heuristic, phase plans, green-wave offsets
src/network/routing.js          — reverse Dijkstra next-hop tables keyed by exit
src/network/build.js            — orchestrates parse->graph->lanes->connectors->signals->routing -> Network object
src/sim/idm.js                  — pure function idmAccel(v, v0, gap, dv, p) -> a
src/sim/mobil.js                — pure function mobilDecision(veh, ctx) -> targetLane | null
src/sim/vehicle.js              — vehicle factory per type (car/truck/sport): dims, IDM params, color
src/sim/signalsRuntime.js       — phase state machine per intersection (green/yellow/all-red, offsets)
src/sim/simulation.js           — fixed-step engine: spawn, leader lookahead, red-light obstacle, conflict yield, despawn
src/sim/detectors.js            — edge detectors, rolling windows, global aggregates
src/render/scene.js             — renderer, camera, MapControls, lights, shadow setup, resize
src/render/roadMesh.js          — merged ribbons + intersection discs + dashed markings + stop lines
src/render/buildings.js         — grid-sampled InstancedMesh boxes, distance-to-road test
src/render/vehiclesMesh.js      — 3 InstancedMesh (one per type), per-frame matrix/color sync
src/render/signalsMesh.js       — poles (static) + lamp InstancedMesh with per-phase setColorAt
src/render/picking.js           — raycast InstancedMesh -> instanceId -> vehicleId
src/render/debug.js             — optional line overlays for lanes/connectors (dev flag)
src/ui/gui.js                   — lil-gui (Spanish labels), binds to sim params live
src/ui/hud.js                   — vehículos / vel media / flujo / densidad readouts
src/ui/chart.js                 — fundamental diagram on 2D canvas
src/ui/search.js                — search box flow: geocode -> fetch -> rebuild network
src/ui/explainer.js             — collapsible "¿Cómo funciona?" panel
src/ui/follow.js                — click-to-follow camera + live IDM readout panel
tests/e2e.spec.js               — Playwright checks
```

---

## 1. OSM → lane-graph pipeline

### 1.1 Overpass query (`src/osm/overpass.js`)

Use `around` (radius from geocoded point), not bbox. Radius clamp: **250–1200 m**, default 600.

```
[out:json][timeout:30];
way(around:{R},{LAT},{LON})
  ["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]
  ["area"!="yes"]
  ["access"!~"^(private|no)$"];
(._;>;);
out body;
```

Key points:
- Excluded on purpose: `service`, `footway/path/cycleway/pedestrian/track/construction/proposed`. Excluding `service` is the single best noise filter.
- `(._;>;); out body;` — recursion pulls all way nodes **with tags** (traffic_signals nodes arrive in same request). Do NOT use `out skel`.
- POST query as `data=` form body.
- `fetchWithFallback(query)`: try `https://overpass-api.de/api/interpreter`, then `https://overpass.kumi.systems/api/interpreter`, each with `AbortController` 25 s timeout; on both failing, typed error → UI toast: *"No se pudo descargar el mapa. Usando la zona de ejemplo."*
- Hard cap after parse: if ways > **1500** or nodes > **20000**: re-issue with radius × 0.6 (one retry), else error *"Zona demasiado densa, reduce el radio."*

Geocoding (`src/osm/geocode.js`):
- Nominatim: `https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1` (no custom headers; debounce 1 req/s).
- Google Maps URL parse: regex `/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z/`; also accept `?q=lat,lon` and bare `lat, lon` pairs. Zoom→radius: `radius = clamp(40075000 * cos(lat) / 2^zoom * 0.35, 250, 1200)`.

### 1.2 Projection (`src/geo/projection.js`)

Equirectangular tangent plane at query center `(lat0, lon0)`:

```
metersPerDegLat = 111320
metersPerDegLon = 111320 * cos(lat0 * π/180)
east  = (lon - lon0) * metersPerDegLon
north = (lat - lat0) * metersPerDegLat
```

**three.js mapping (write as comment at top of projection.js — #1 handedness bug source):** three.js right-handed, Y up. `x = east`, `z = -north` (+z = south), `y = up`. With travel direction `d = (dx, dz)`, the **right side** of travel (right-hand traffic) is `n = (-dz, dx)`. Verify: heading east `d=(1,0)` → `n=(0,1)` = +z = south = driver's right. Correct.

Orientation: NEVER ad-hoc atan2 yaw. Build instance matrices from basis vectors:
```
forward = (dx, 0, dz); up = (0,1,0); right = cross(up, forward)  // unit
matrix.makeBasis(right, up, forward); matrix.setPosition(x, y, z)
```
Model all vehicle geometry with nose pointing **+Z local**.

### 1.3 Tag normalization (`src/osm/parse.js`)

Per-class defaults in `config.js` (when tags absent):

| class | lanes/dir | speed km/h |
|---|---|---|
| motorway | 3 | 100 |
| trunk | 2 | 80 |
| primary | 2 | 60 |
| secondary | 2 | 50 |
| tertiary | 1 | 50 |
| unclassified / residential | 1 | 30 |
| living_street | 1 | 20 |
| *_link | 1 | 40 |

- `oneway`: `yes|1|true` → forward; `-1` → reverse node list, treat as forward; `junction=roundabout` implies oneway.
- `lanes` = total both directions. With `lanes:forward`/`lanes:backward` use them; else two-way: `fwd = ceil(lanes/2)`, `bwd = floor(lanes/2)`; clamp each direction [1, 4]. One-way: all forward.
- `maxspeed`: parse int; handle `"30 mph"` (×1.609); ignore `signals`/`walk` → class default.
- Lane width fixed **3.0 m** (config).

### 1.4 Way splitting → directed edges (`src/network/graph.js`)

1. Count node refs across kept ways. Junction node if `refCount ≥ 2` OR way endpoint.
2. Split ways at junction nodes into segments (keep intermediate geometry nodes as shape points).
3. Emit directed edges: one for one-way, two (reversed polyline) for two-way. Edge = `{id, fromNode, toNode, points[], lengthM, laneCount, speedMs, highwayClass}`.
4. **Degree-2 collapse**: merge chains through nodes with exactly one in/out edge per direction and identical `{laneCount, class}` — unless node has `highway=traffic_signals` (keep). Cuts edge count 40–60%.
5. Drop edges < **8 m** connecting two junctions; merge endpoints (collapse junctions to midpoint). Iterative, max 3 passes.

### 1.5 SCC pruning + entries/exits

- **Iterative Tarjan** (explicit stack) on directed junction graph. Keep largest SCC = **core**.
- **Boundary stubs** (one endpoint in core, other of total degree 1): stub into core → outer end = **entry** (spawn); stub out of core → **exit** (despawn); two-way stub → both.
- Discard everything else outside core.
- Degenerate fallback: if no entries or exits → `spawnMode = 'onNetwork'`: spawn on random lane starts with gap check, despawn after exp-distributed trip length (mean 1.5 km). Sim supports both behind `pickSpawn()/shouldDespawn()`.
- Spawn weighting per entry ∝ `laneCount × classWeight` (motorway 4, primary 3, secondary 2, else 1).

### 1.6 Lane polylines + stop lines (`src/network/lanes.js`)

- **Node radius** per junction: `R_node = max over incident edges (laneCountBothDirs_i × 3.0 / 2) + 2.0` m.
- Trim each edge polyline by `R_node(from)` at start, `R_node(to)` at end (skip at degree-1 stub ends). If edge < 4 m after trim, clamp trims proportionally.
- Per-lane offset (right-hand traffic, to the **right** of travel):
  - two-way edge: lane i (0 = innermost): `3.0 × (i + 0.5)`;
  - one-way edge: centered bundle: `3.0 × (i − (N−1)/2)`.
- `math2d.offsetPolyline(points, d)`: per-vertex miter normal = normalized sum of adjacent segment normals × `1/cos(θ/2)`, miter clamped to `2.5 × d`.
- Resample lanes to ≤ 3 m segments, store `points[]` + prefix-sum `cumLen[]`. API: `lane.pointAt(s)`, `lane.headingAt(s)` (binary search + lerp). Lane: `{id, edgeId, index, length, points, cumLen, vehicles: [], outConnectors: [], speedMs}`.
- **Stop line = lane end (s = lane.length)**.

### 1.7 Signals (`src/network/signals.js`)

- Collect `highway=traffic_signals` nodes. **Snap**: signal node within **25 m** of a junction node (post-collapse) marks junction signalized (duplicates collapse).
- **Heuristic fallback** (junctions not signalized): signalize if `legCount ≥ 4` AND ≥ 2 incident edges class ∈ {primary, secondary, tertiary} with non-collinear headings (axis diff > 45°).
- **Phase grouping**: dominant axis `A` = heading of highest-class incoming edge. Group approaches by `|angularDiff(heading, A)| < 45° or > 135°` → NS, else EW. Two phases: NS green / EW red, swap; transitions yellow **3 s** + all-red **2 s**. Cycle `C` 30–120 s (default 60); green split ∝ group lane counts, min green 7 s.
- **Green-wave offsets**: project signalized junction positions onto network dominant axis (most common edge heading mod 180°). `offset_i = (proj_i / v_wave) mod C`, `v_wave` = 50 km/h default (GUI "velocidad de onda verde"). `phaseTime = (simTime + offset_i) mod C`.
- Runtime state in `sim/signalsRuntime.js`: `signalState(junction, approachGroup) -> 'green'|'yellow'|'red'` evaluated from clock — stateless, no per-tick mutation.

### 1.8 Turn connectors (`src/network/connectors.js`)

Per junction, per incoming×outgoing directed edge pair:
- Skip reverse twin (**U-turn pruning**; config `allowUTurns` default false).
- Turn angle `α = signedAngle(headIn, headOut)`, right turns positive. `|α| < 30°` through; `30°–150°` right; `−150°–−30°` left; else U-turn (pruned).
- **Lane-to-lane assignment** (N incoming lanes, K outgoing edges): rightmost lane serves right turns; leftmost serves left; through maps `outIdx = round(inIdx × (M−1)/(N−1))`. Guarantee every incoming lane ≥ 1 connector (else attach to nearest through/right target); every outgoing lane gets one when possible.
- **Geometry**: cubic Bézier, `P0 = inLane.end`, `P3 = outLane.start`, `P1 = P0 + headIn × k`, `P2 = P3 − headOut × k`, `k = clamp(0.35 × |P3−P0|, 2, 10)`. Sample ~1 m → polyline wrapped in same Lane API (`isConnector: true`, `turnType`, `signalGroup`, `conflicts[]`).
- **Curvature speed cap**: circumradius from consecutive sample triples; `vMax = min(laneSpeed, sqrt(2.0 × Rmin))` (a_lat = 2.0 m/s²).
- **Conflict pairs**: pairs of connectors at same junction from different incoming edges; sample at 1 m; min distance < **2.5 m** → conflict. Priority: through > right > left; tie → right-hand priority. Store on lower-priority connector: `conflicts: [{connector, myEntryS, theirEntryS}]`. At signalized junctions only register conflicts between movements green simultaneously.

### 1.9 Routing (`src/network/routing.js`)

**Precomputed reverse-Dijkstra next-hop tables.** Dijkstra backward from each exit over directed edge graph (cost = `length / speedMs`), store `nextEdge[exitId] : Map(edgeId -> edgeId)`. At spawn pick exit from distance-biased distribution (weight ∝ `exitWeight × dist^0.5`).

Vehicle stores `{exitId, currentLane}`; next connector chosen on lane entry: among `currentLane.outConnectors`, the one whose `outEdge === nextEdge[exitId].get(currentEdge)`; if current lane has no connector to that edge → **mandatory lane change** flag; if vehicle reaches lane end without managing it → take any connector and re-route (no teleports, no stuck vehicles).

---

## 2. Simulation

### 2.1 Core loop (`src/sim/simulation.js`)

- Fixed `DT = 1/30 s`. `acc += wallDt × simSpeed; while (acc ≥ DT && steps < 8) step(DT)`. Cap 8 steps/frame; drop remainder when capped. `simSpeed ∈ [0.25, 4]`, pause = simSpeed 0 (RAF keeps running).
- Step order: (1) spawn queue, (2) per-vehicle decision (leader find → IDM; MOBIL where allowed), (3) integrate `v += a·DT (≥0); s += v·DT`, (4) lane-end transitions, (5) despawn at exits, (6) detectors.
- Store `prevS/prevLane`; renderer interpolates `lerp(prev, cur, acc/DT)`.
- Per-lane `vehicles[]` sorted by `s` descending. Leader = previous array element.

### 2.2 Leader-finding across connectors

```
lookahead(veh):
  if leader in same lane ahead: return {gap, dv}
  walk path [nextConnector, nextLane, ...] (vehicle's actual route) while dist < LOOKAHEAD (max(80, v*T + v²/(2b)) m):
    if segment has vehicles: leader = rearmost (min s)
      return {gap: dist + leader.s - leader.len/2 - veh.len/2, dv}
  return free road
```
Vehicles on connectors automatically block upstream lanes.

### 2.3 Red light as virtual obstacle

Next connector's `signalGroup` red → virtual standing leader at stop line: `gap = distToStopline − s0margin, dv = veh.v`. **Yellow**: stop only if comfortable — if `distToStopline > v²/(2 × b_comfort) + v × 0.5` treat as red, else proceed. Vehicles ON a connector never see the signal.

Final accel = `min(a_freeAndLeader, a_redlight, a_conflict)` — most restrictive, never average.

### 2.4 Conflict yielding

Evaluated within 15 m of stop line when next connector has `conflicts[]`:
- Blocked if higher-priority conflicting connector occupied before conflict point, OR vehicle on its feeding lane arrives within `T_gap = 4 s` (`eta = distToConflict / max(v, 1)`).
- Blocked → virtual obstacle at stop line.
- **Deadlock breaker**: conflict-blocked at v < 0.3 m/s for > 8 s → ignore lowest-priority remaining conflict.

### 2.5 MOBIL

- Eligible: real lane (not connector), edge `laneCount ≥ 2`, `s < lane.length − 25 m`, cooldown 4 s.
- Standard MOBIL: change if `aNew − aOld > p × (Δa_followers) + 0.1` and new-follower decel ≥ −4 m/s². `p` = GUI "cortesía".
- **Mandatory variant** (lane lacks connector to next route edge): incentive overridden — change when safety passes; below 60 m from lane end relax safety to −6 m/s² + IDM slowdown (virtual obstacle at lane end) to creep until gap.
- Visual: logical change instantaneous; render-only lateral offset eases over 1.5 s.

### 2.6 Spawning

Poisson per entry lane: `λ_lane = demandaTotal × entryWeight / 3600`; per step spawn prob `λ × DT`. Spawn at `s = 0`, `v = min(laneSpeed, gapSafeSpeed)`; require lookahead gap ≥ `s0 + v×T + vehLen`. Blocked → `queued` counter, retry next step. Mix: 80% car (4.5 m) / 12% truck (10 m, lower v0/accel) / 8% sport (higher v0/accel).

IDM params (per-vehicle jitter ±10%): T ≈ 1.5 s, a ≈ 1.5, b ≈ 2.0, s0 ≈ 2.0, delta = 4. v0 = lane speed × per-vehicle factor (car 1.0, truck 0.85, sport 1.2, jittered).

---

## 3. Rendering

### 3.1 Scene (`src/render/scene.js`)

`WebGLRenderer({antialias:true})`, sRGB output, `MapControls` (three/addons), `PerspectiveCamera` 45° tilt over network bbox. Hemisphere + DirectionalLight, ortho shadow frustum fit to bbox (2048 map). Shadows toggle: keep `renderer.shadowMap.enabled = true`, toggle `light.castShadow`. Ground: big plane y=0, flat green.

### 3.2 Roads (`src/render/roadMesh.js`)

- Per undirected edge: ribbon of width `3.0 × totalLanes` (same offset math as lanes), merged via `BufferGeometryUtils.mergeGeometries`, asphalt-gray `MeshLambertMaterial`, `y = 0.02`, `receiveShadow`.
- Per junction: flat disc (16-seg) radius `R_node + 1`, same material — hides seams. `polygonOffset` on road material vs discs.
- Markings (`y = 0.05`, white `MeshBasicMaterial`, merged): dashed separators (2 m quad / 4 m gap) between same-direction lanes; solid center strip (0.15 m) on two-way; **stop lines** (laneWidth × 0.5 m) at signalized lane ends.
- Connectors not drawn (junction disc covers them).

### 3.3 Buildings (`src/render/buildings.js`)

1. Spatial hash (cell 20 m) of road segments with half-widths.
2. Sample grid over bbox at 16 m spacing ±4 m jitter.
3. Accept if `distToRoad > roadHalfWidth + 7` and `< 60 m`.
4. Box footprint 8–13 m, re-test 4 corners; height `6 + exp(rng)·8` clamp 6–40, taller near high-class roads.
5. One `InstancedMesh` + `setColorAt` from 6-color pastel palette. `castShadow`. N ≈ 400–900.

### 3.4 Vehicles (`src/render/vehiclesMesh.js`)

- 3 procedural low-poly geometries (body + cabin + 4 wheel stubs, ≤ 60 tris), nose +Z local. One `InstancedMesh` per type, capacity 800, `count` = active.
- Per frame: interpolated `(pos, heading)` from segment `pointAt/headingAt` + lane-change lateral offset; `matrix.makeBasis`; `setMatrixAt`; `instanceMatrix.needsUpdate`. Color at spawn via `setColorAt`.
- `instanceIdToVehicle[type][i]` arrays, swap-with-last compaction on despawn (needed by picking).

### 3.5 Traffic lights (`src/render/signalsMesh.js`)

Per signalized approach (per incoming edge): pole at stop line, offset right of rightmost lane 1.5 m; head faces `forward = −headIn` (makeBasis).
- Static InstancedMesh: pole cylinder + housing box.
- Dynamic InstancedMesh: one lamp sphere per approach, color-switched red/amber/green via `setColorAt` + `instanceColor.needsUpdate`. `MeshBasicMaterial`.

### 3.6 Picking (`src/render/picking.js`)

Click → `Raycaster.intersectObjects([carMesh, truckMesh, sportMesh])` → `instanceId` → vehicle. Follow mode (`ui/follow.js`): camera lerps to chase offset, readout panel ("velocidad", "aceleración", "hueco al líder (m)", "Δv con líder", "estado: libre / siguiendo / frenando por semáforo / cediendo paso"). Esc or click-empty exits.

---

## 4. Implementation phases (each ends runnable)

- **Phase 0 — Scaffold**: Vite app, scene.js (ground + controls + lights), HUD shell. Delete stackdump. Download La Paz snapshot.
- **Phase 1 — Network offline**: parse, projection, graph, lanes on snapshot; roadMesh ribbons + discs; debug lane overlays. *La Paz roads in 3D.*
- **Phase 2 — Connectors + signals static**: connectors (debug curves), signal detection + phases, signalsMesh cycling via signalsRuntime clock.
- **Phase 3 — Sim core**: idm, vehicle, simulation (spawn/lookahead/red-light/transitions/despawn), routing, vehiclesMesh. Single-lane only, conflicts as "occupied → wait". *Queues at red lights work.*
- **Phase 4 — Realism**: mobil + mandatory changes, conflict-yield with priorities, curvature caps, vehicle mix, sim speed/pause, deadlock breaker.
- **Phase 5 — Didactic UI**: gui, detectors, hud, chart (fundamental diagram), follow, explainer.
- **Phase 6 — Live map loading**: geocode, overpass mirrors, search (loading overlay "Descargando mapa…", full teardown/rebuild — every module exposes `dispose()`), buildings, shadows toggle.
- **Phase 7 — Hardening + verification**: clamps, error toasts, Playwright suite, perf pass (sim step < 4 ms @ 500 vehicles; cache per-vehicle next-connector; no allocations in `step()`).
- **Phase 8 — Docs**: README.md (Spanish), CLAUDE.md.

---

## 5. Metrics (`src/sim/detectors.js`)

All clocked on **sim time**, never wall time.

- **Global HUD** (every 0.5 s sim): active count; `vel media = mean(v) × 3.6`; `densidad = activeCount / totalLaneKm`; `flujo` from detectors summed/normalized.
- **Detectors** for fundamental diagram: 8–12 longest non-connector edges (≥ 80 m), cross-section at midpoint:
  - **Flow q**: ring buffer of crossing timestamps; `q = crossings / window`, window 60 s sim, slide 5 s.
  - **Speed**: harmonic mean of crossing speeds (space-mean).
  - **Density k**: `vehiclesOnEdge(window-avg) / (edgeLengthKm × laneCount)` — counted, not q/v.
- **Chart**: canvas 2D scatter, x = k (veh/km/carril), y = q (veh/h/carril), one point per detector per 5 s, fade with age (keep 300). Axes labeled "densidad (veh/km)" / "flujo (veh/h)".

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Overpass down | Mirror fallback, 25 s aborts, bundled snapshot always loads first — first paint never depends on network. |
| Nominatim rate limit | Debounce, single result, only on explicit Enter/"Buscar". |
| Huge area | Radius clamp 1200 + post-parse cap + one auto-retry 0.6×R + Spanish toast. |
| Tiny/empty area | kept ways < 5 or SCC < 10 edges → toast "Zona sin red viaria suficiente", keep current network. |
| Pathological OSM | Drop zero-length segments + duplicate node refs; micro-edge merge; Bézier depends only on endpoints+headings. |
| Closed-loop network | `spawnMode='onNetwork'` fallback. |
| Gridlock | 8 s starvation override; spillback itself is desired (didactic). |
| 60 fps | One draw call per type/buildings/road/markings; cap lookahead 80–150 m; zero allocations in step(). |
| Handedness bugs | Single convention in projection.js, makeBasis everywhere, debug arrows in Phase 1. |
| Network swap leaks | `dispose()` on every render module; verify `renderer.info.memory` in dev. |

---

## 7. Verification

- `npm run build` clean; `npm run preview` serves dist.
- Test hook `window.__SIM__` always exposed: `{ready, time, vehicleCount, sampleVehicle(), setDemand(vehPerHour), networkCenter:{lat,lon}}`. Seeded RNG.
- Playwright (`tests/e2e.spec.js`, `webServer` → `vite dev --port 5173`):
  1. Console clean during 10 s default load (filter offline network errors).
  2. Sim alive: `__SIM__.ready`, `vehicleCount > 20` within 30 s, sampled vehicle displaces > 5 m over 3 s, screenshot diff t0/t1.
  3. Queues form: `setDemand(high)` → mean speed drops below free-flow after 60 sim-s.
  4. Search loads city: "Manhattan, New York" → `networkCenter` changes (lat ≈ 40.7), ready again, vehicles > 0. `test.skip` when offline.
  5. Spanish UI strings visible: "Demanda", "¿Cómo funciona?", "veh/km".
- Manual didactic checklist: queue growth/dissipation; stop-and-go wave; green wave in follow mode along El Prado; FD cloud tracing both branches as demand rises.

## Deviations

(Builder agents: document any deviation from this spec here, with reason.)

- **§3.3 Buildings — real OSM footprints instead of procedural grid boxes.** `src/render/buildings.js` extrudes real La Paz building footprints (closed `building` ways from a build-time Overpass snapshot, `public/data/default-buildings.json`, 436 ways around the default center) rather than grid-sampled `InstancedMesh` boxes. Height = `building:levels` × 3.2 m when tagged (186/436), else seeded-random 2–6 levels; clamped 5–40 m. All prisms merged into ONE `BufferGeometry` (per-building vertex colors from the 6-tone pastel palette, `MeshLambertMaterial vertexColors`) — still a single draw call, ~435 buildings. Reason: real footprints match the actual city layout (blocks align with the road network), look better, and avoid the distance-to-road sampling machinery. The spec's procedural generator was not implemented; if the snapshot is missing/insufficient (<10 footprints) buildings are skipped with a `console.info` instead of falling back to procedural boxes (procedural fallback would couple the renderer to the network bootstrap). Centroid-on-road test also skipped — real footprints rarely overlap carriageways and roads render at y=0.02 above building bases.

**Builder A (Phases 0–2 + MVP sim pivot), 2026-06-11:**

1. **MVP scope pivot (coordinator request)**: a minimal vehicle simulation was absorbed from Phase 3 so traffic visibly moves: `sim/idm.js` (spec-contract `idmAccel(v, v0, gap, dv, p)`), `sim/vehicle.js` (car type only), `sim/simulation.js` (Poisson spawn at entries, IDM, cross-segment leader lookahead, red-light virtual obstacle, random connector choice, despawn at exits / 3 km trip cap), `render/vehiclesMesh.js` (one InstancedMesh, per-instance colors). NO MOBIL (vehicles never change lanes), NO routing tables (`network/routing.js` is a documented stub), NO conflict-yield behavior in the sim (conflict pairs ARE computed and stored on connectors per §1.8, just not yet consumed). Buildings, lil-gui, chart, follow, search, Playwright suite: not built.
2. **build.js order**: signals are detected BEFORE connectors (spec file list implies connectors→signals) because §1.8 conflict registration needs signal groups ("only register conflicts between movements green simultaneously"). Behavior matches spec.
3. **Signal snap restricted to junctions with legCount ≥ 3**: a 2-leg (mid-block) signalized "junction" has no opposing phase group (§1.7 grouping degenerates), so traffic_signals nodes only signalize real intersections within 25 m. Degree-2 traffic_signals nodes are still kept by the collapse per §1.4.
4. **Phase plans where one group is empty → junction left unsignalized** (e.g., collinear T-junctions): avoids a permanently-green/pointless cycle.
5. **Default demand raised to 2400 veh/h** (spec GUI default in §2.6 unspecified): the La Paz snapshot yields only 7 entry stubs; lower values look empty.
6. **index.html HUD** shows Vehículos / Vel. media / Tiempo for the MVP (flujo/densidad return with Phase 5 detectors).
7. **`window.__SIM__`** already exposes `{ready, time, vehicleCount, sampleVehicle(), setDemand(), networkCenter, network, view, debug}` — superset of the placeholder, subset of §7 final contract (no `simSpeed` control yet).
8. **OSM data quirk (La Paz centro)**: 216 highway ways, 156/216 one-way, 39 traffic_signals nodes. CRITICAL bug class found here: degree-2 collapse must NEVER reverse a one-way segment when orienting chain merges — doing so flips traffic direction and shatters the SCC (kept core dropped from 894 raw nodes to a 65-node western fragment before the fix in `graph.js collapseDegree2`).

**Builder B (routing / MOBIL / conflicts / mix / detectors / controls), 2026-06-11:**

1. **§1.9 routing adjacency from connectors, not raw edges**: the reverse-Dijkstra edge graph is derived from the ACTUAL turn connectors (`lane.outConnectors`), so pruned U-turn movements are never routed and next-hops are always physically takeable. Costs include connector traversal time; `distM` (meters along the shortest-time path) feeds the `exitWeight × dist^0.5` spawn bias (spec's "dist" interpreted as path meters, not Euclidean). `buildRouting(graph)` therefore must run after `buildConnectors` (build.js already does).
2. **§5 detector edge choice restricted to interior edges** (both endpoints `legCount ≥ 2`): the literal "longest edges" pick landed 8/10 detectors on two-way dead-end stubs which survive SCC pruning via their own twin but carry zero routed traffic (their only continuation is a pruned U-turn). Spec amended in spirit: longest *trafficked* edges.
3. **§2.4 deadlock breaker generalization**: a vehicle conflict-blocked OR creep-waiting for a mandatory lane change at < 0.3 m/s accumulates `blockT`; every 8 s it first abandons the mandatory change (takes the fallback connector and re-routes per §1.9 failure rule), then starts ignoring the lowest-priority remaining conflicts one at a time (`conflictRefs` sorted by the other movement's priority). Guarantees no stuck vehicles.
4. **§2.5 MOBIL details**: `mobilDecision(veh, ctx)` with a caller-owned scratch ctx `{edge, aSelf, leader, follower}` (zero allocations). `aSelf` is the PURE car-following accel (signal/conflict braking excluded) so queued vehicles don't weave to dodge red lights. Incentive includes both followers' Δa (standard MOBIL); mandatory variant skips incentive, uses −6 m/s² safety inside 60 m of the lane end and a virtual obstacle 2 m before the lane end to creep. Arc position maps proportionally between sibling lanes (offset polylines differ in length). Lane changes are decided during the per-segment pass and applied in a separate pass (no array mutation mid-iteration).
5. **§2.6 spawn queue**: blocked Poisson arrivals are kept in a per-entry-lane `queued` counter (retried each step) capped at 20 so demand drops don't release an unbounded burst. Spawn speed `v = min(laneSpeed, freeGap/T, rearV+3)`.
6. **§2.3 verified as specced**: yellow comfortable-stop rule (`dist > v²/(2b) + 0.5v`), red as virtual standing leader at the stop line, final accel = `min()` of car-following / red-light / conflict / mandatory-creep terms — never an average. Conflict blocking is also re-checked at the lane-end transition (overshoot guard), holding the vehicle at the stop line.
7. **§7/§2.1 sim controls**: `sim.setSimSpeed (0.25–4, clamped)`, `sim.setPaused`, plus `window.__SIM__.{setSimSpeed,setPaused,simSpeed,paused,metrics,sim}`. The RAF accumulator multiplies wall dt by `paused ? 0 : simSpeed`. `sim.lastStepMs` exposed for perf checks (measured ≈0.6 ms median @ 736 vehicles — budget is < 4 ms @ 500).
8. **§5 metrics contract for the UI layer**: `sim.metrics = { global: {vehicles, meanSpeedKmh, densityVehKm, flowVehHLane, time}, detectorPoints: [{edgeId, k, q, vKmh}] }` — `k` in veh/km/lane (counted occupancy), `q` in veh/h/lane, recomputed every 5 s sim over a 60 s window; `global` every 0.5 s sim. Objects are stable references (mutated in place) — safe to close over in UI code.
9. **§3.4 vehicle wheels omitted** (body+cabin+extras boxes only, ≤ 36 tris/type): keeps well under the tri budget; truck (10 m, cab+cargo) and sport (low + spoiler) silhouettes are clearly distinct at the default zoom. `instanceIdToVehicle[type][i]` maps are rebuilt every frame (simpler than swap-with-last and equivalent for picking).
10. **Trip-cap safety net**: routed vehicles despawn at their exit; a hard 8 km `tripDist` cap guards pathological re-route loops (was 3 km in the MVP, which could kill long legitimate routes). `onNetwork` fallback uses exp-distributed trip length (mean 1.5 km) as specced.

**Builder C (Phases 5–8: interpolation / UI / search / tests / docs), 2026-06-11:**

1. **§2.1 interpolation across segment seams is a world-space lerp**, not an arc-length lerp: when `prevSeg !== seg` (lane→connector→lane transition mid-step) the renderer lerps positions and heading vectors in world space between the two poses. The polylines are C0-continuous at the seam (connector P0 = lane end), so the path stays visually smooth without needing a unified arc coordinate. Lane changes remap the `prevS` snapshot proportionally onto the target lane in `applyLaneChange` so the §2.5 lateral ease remains the only source of sideways motion (no double-counting).
2. **InstancedMesh raycast fix (§3.6)**: three r184 caches `InstancedMesh.boundingSphere` from whatever `count` it had when first computed — at startup that's 0, producing an empty sphere (radius −1) that rejects every ray forever. `picking.js` calls `computeBoundingSphere()` on the three vehicle meshes per click (rare, O(count)). Not in the spec; documented as a load-bearing gotcha in CLAUDE.md.
3. **§1.7 live cycle retiming**: the spec has no runtime path for the GUI "ciclo semafórico" (plans are baked at build time). Added `retimeSignals(graphLike, signals, cycleS)` to `network/signals.js`: rescales every plan to the new cycle preserving each junction's green-split ratio (min-green respected) and recomputes green-wave offsets with the live `CONFIG.signals.greenWaveKmh`. Stateless `signalsRuntime` makes it take effect instantly. A "velocidad de onda verde" slider (spec §1.7 GUI mention) was added alongside.
4. **GUI settings persist across map swaps**: `gui.applyTo(world)` re-applies demand/speed/pause/cycle/debug-overlay settings to a freshly built world after a search rebuild (the spec doesn't define this; resetting user controls on rebuild felt broken).
5. **§7 test 3 reformulated relatively**: "mean speed drops below free-flow" is asserted as `meanSpeed(after 90 sim-s at demand 5000) < 0.9 × meanSpeed(default demand)` rather than an absolute threshold — the La Paz network's free-flow mean (~29 km/h) varies with the OSM data revision. Test 2 runs at 4× sim speed to reach >20 vehicles within the 30 s wall budget (default demand takes ~60 sim-s to hit that population).
6. **§7 test 4 search target is "Sopocachi, La Paz"** (not Manhattan): same didactic intent, lighter Overpass payload, verified to load. The test also **skips (not fails) when Overpass/Nominatim answer but refuse service** (rate-limit toast detected) — an external 429 is not an app bug; true offline is detected with a Nominatim status probe.
7. **§3.3 buildings on live map swaps**: `addBuildings(scene, {lat, lon, radius})` fetches real footprints from Overpass for the new area (same query pattern as the bundled snapshot, capped at 2500 footprints); the bundled snapshot is used as fallback only when the area IS the default zone (±0.01°) — foreign footprints anywhere else would be wrong, so failures simply skip buildings. Building fetch is fire-and-forget and is disposed if the world was swapped again while it was in flight.
8. **§5 chart sampling**: the chart keeps its own 5 s sim-time cadence reading `metrics.detectorPoints` (stable mutated references) instead of hooking the detector slide directly; detector points with `k = q = 0` are skipped so empty detectors don't pile at the origin. Ring buffer of 300 points, age-faded alpha, auto-scaling axes (nice-rounded, min 20 veh/km / 200 veh/h).
9. **Follow-mode "estado" heuristics (§3.6)**: `cediendo paso` = `veh._blocked` (covers both conflict yield and mandatory-change creep-wait); `frenando por semáforo` = non-green signal on `nextConn` AND `veh._a < −0.15`; `siguiendo` = leader (walked across connectors, same logic as the sim lookahead) within `max(2.5·v, 15)` m; else `libre`. The sim does not export its internal decision branch, and re-deriving it from public state keeps the panel read-only.
10. **`window.__SIM__` is now getter-based over the swappable world** (`app.world`), so the contract survives search rebuilds; added `chartPoints`, `follow`, and `view` for the e2e suite and dev tooling. `__SIM__.debug` points at the current world's overlay.

**Builder D (fleet upgrade: 6 vehicle types + detail + brake lights), 2026-06-11:**

1. **§2.6/§3.4 fleet expanded 3 → 6 procedural types** with a realistic La Paz mix: sedán 30% (4.5 m) / hatchback 25% (3.9 m, nimble class: v0 ×1.15, accel ×1.3) / SUV 15% (4.7 m, taller) / taxi 10% (sedan shell, white-yellow palette + yellow roof sign) / **micro paceño** 12% (7 m boxy minibus, saturated green/red/blue liveries + white waist band + roof rack) / camión 8% (10 m cab + box trailer, slowest: v0 ×0.8, accel ×0.55). The spec's fixed `car/truck/sport` mix (§ Fixed decisions, §2.6, §3.4, §3.6 wording) is superseded. Type system is **data-driven**: `CONFIG.vehicleTypes` key order is the single source of truth for `typeIndex` AND InstancedMesh order (`sim/vehicle.js` + `render/vehiclesMesh.js` both derive from it); `CONFIG.vehicleTypes[type].lengthM` still feeds `veh.len`, so all IDM/MOBIL gap math picks up the new lengths automatically.
2. **§3.4 tri budget raised from ≤60 to ~250–440 tris/model** (street-level readability request — the camera is not only aerial): 8-segment cylinder wheels (dark tire + lighter protruding hub face, slightly oversized, axle height = radius so bodies sit ON the wheels), wraparound dark glass band (windshield + side strips) + flat dark windshield hints on hood/roof for aerial readability, grille block, bumpers, headlight blocks, baked dark-red tail bar. Still one merged BufferGeometry + one InstancedMesh + one draw call per type; 6 × ≤400 instances is far under any GPU budget.
3. **Two-color-region rendering via vec4 vertex colors + tiny shader patch**: the merged geometry's `color` attribute is vec4 where rgb = authored region color and **alpha = tint mask** (1 = multiply by per-instance body color, 0 = keep authored color exactly). A 7-line `onBeforeCompile` replacement of three's `color_vertex` chunk implements `vColor.rgb *= mix(vec3(1), instanceColor.rgb, vColor.a)`. This gives exact fixed colors (pure-white micro band, yellow taxi sign, near-black glass/tires, light hubs) without a second material/draw call — multiplication alone cannot produce light fixed colors on saturated bodies. Verified against three r184's chunk source; `customProgramCacheKey` set so the patched Lambert doesn't collide with the buildings' stock vertex-color Lambert.
4. **§3.4 brake lights — ONE shared extra InstancedMesh** (unit box, bright-red `MeshBasicMaterial`, capacity 6×400) for all types, +1 draw call total. Per frame a braking vehicle gets one instance positioned/scaled onto its tail by reusing the body's already-computed basis vectors (per-type dims table; zero allocations). Light condition: `_a < −1 m/s²` (brief) **OR held at ~standstill** (`v < 0.3 ∧ _a < 0.4`) so standing queues stay lit like real brake-holding traffic — braking waves visibly propagate down queues.
5. **`vehicleCapacityPerType` 800 → 400** (6 types → 2400 max instances). `instanceIdToVehicle` is now `[6][400]`; picking (`render/picking.js`) and follow needed NO changes — they consume `vehiclesMesh.meshes`/`instanceIdToVehicle` generically. `sampleVehiclePose` untouched.
6. **Legacy aliases kept** (`car/truck/sport` palettes, builders, brake dims) so the renderer/factory work against either config generation — made each HMR reload during the live upgrade a consistent state; harmless dead entries now.
7. **Verified 2026-06-11**: `npm run build` clean; e2e suite 4 passed / 1 skipped (offline live-search skip, by design); zero console errors/warnings; all 6 types spawn with correct lengths and proportions; click-to-follow resolves the exact clicked vehicle ("Siguiendo: sedán #545"); `sim.lastStepMs` ≈ 0.4 ms median / 1.1 ms max at **662 vehicles** (demand 7000, budget < 4 ms @ 500); 120 fps on a 120 Hz display at 568+ vehicles. Screenshots: `docs/screenshots/fleet.png` (street-level, all 6 types in frame), `docs/screenshots/fleet-brakes.png` (19-vehicle queue, brake bars lit).
