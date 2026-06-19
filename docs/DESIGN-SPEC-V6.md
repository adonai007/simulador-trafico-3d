# DESIGN SPEC V6 — Teleférico más realista y didáctico

> Authoritative spec. Conventions: Spanish UI, English code, zero per-frame allocs, stable shapes, dispose() per module, static-site, CONFIG holds tunables. Dev server :5174 (`$env:SIM_PORT="5174"; npx playwright test`). Existing suite (19+ after v5) MUST stay green. **ANTI-HANG RULE**: every standalone Playwright script sets page.setDefaultTimeout(15000), a hard process timeout (120 s) that process.exit(1)s, no untimed waitForFunction/waitForEvent, delete after; never two workflows on :5174 at once. Deviations at bottom.

> RUNS AFTER v5 completes (v5 touches main.js/gui.js/config.js — must not overlap). User chose: **F1 Realismo físico** + **F2 Panel didáctico al click**.

## Current state (v4 teleférico)
- network/aerialway.js: buildAerialways(osm, projection, elevation) → {lines:[{points3D arc-param, color, name}], stations[], towers[]}. Cable raised to elevAt+cableHeightM, lerp tower-to-tower (STRAIGHT segments). default-aerialway.json bundled (4 lines in La Paz centro).
- render/aerialwayMesh.js: TubeGeometry cables per color, tower posts InstancedMesh, station boxes, ONE gondola InstancedMesh per line color, cabinsPerLine each, constant cabinSpeedMs along arc, ping-pong. update(dt). __SIM__.aerialway {lines, cabins}, sampleCabin().
- CONFIG.aerialway {enabled, cableHeightM:30, towerHeightM:25, cableRadiusM:0.15, sampleStepM:8, cabinsPerLine:6, cabinSpeedMs:8, cabinSize, lineColors{Roja..Morada}, palette}.

## F1 — Realismo físico

### F1a — Catenary sag (cable hangs in a curve between towers)
- network/aerialway.js: between consecutive support points (towers, or evenly spaced virtual supports every ~spanM if towers sparse), replace the straight raised polyline with a **catenary/parabolic sag**: for each span, sample N points where y = supportY − sag·(1 − ((2t−1))²) with sag = CONFIG.aerialway.sagM (per span, ~ spanLength × sagRatio 0.04, clamped). Keep arc-length param so cabins ride the sagging curve. Tube geometry follows it automatically.
- CONFIG: sagRatio:0.04, maxSagM:8, minSupportSpacingM:60 (insert virtual supports if tower gaps exceed this).

### F1b — Two parallel cables per line (ida/vuelta)
- Each line gets TWO offset polylines: laterally offset by ±CONFIG.aerialway.cableGaugeM/2 (gauge ~3 m) perpendicular to the line heading (horizontal offset, like lane offset n=(-hz,hx)). Cabins on cable A travel forward, cable B backward. Render both tubes. Cabins split between the two directions.
- aerialwayMesh.js: gondola instances assigned a direction; position on the matching offset polyline; orientation faces travel direction (makeBasis).
- CONFIG: cableGaugeM:3.0.

### F1c — Cabins stop at stations (board/alight)
- Identify station arc-positions along each line (project station nodes to nearest s on the line polyline, like bus-stop snapping). Each cabin tracks nextStationS; when approaching, decelerate to a brief dwell (CONFIG.aerialway.stationDwellS ~6 s, but visually Mi Teleférico cabins slow but rarely fully stop — use a slowdown to ~1 m/s through the station arc, optional full stop). Then resume cruise speed. Cabins evenly spaced and at realistic cruise (~5 m/s = CONFIG.aerialway.cabinSpeedMs:5).
- Zero-alloc: per-cabin scratch state {s, dir, dwellUntil, nextStationIdx} in preallocated arrays.
- CONFIG: cabinSpeedMs:5, stationSlowMs:1.2, stationZoneM:40, stationDwellS:4, cabinsPerLine tuned to spacing (cabins spaced ~lineLength/cabinsPerLine).

## F2 — Panel didáctico al click

### F2a — Picking aerialway (cables/cabins/stations)
- render/picking.js: extend raycast to include aerialwayMesh pickable meshes (cable tubes + station boxes + gondola instances). On hit, resolve to the line (and cabin/station). Return via a callback to a new info panel. Keep vehicle picking + obras picking intact (priority: obras > vehicle > aerialway, or modifier-free since they're spatially distinct).

### F2b — Info panel (ui/aerialwayInfo.js NEW)
- Click a line/cabin/station → collapsible Spanish panel showing: **Línea** (name + color swatch), **Longitud** (km), **Estaciones** (count + names), **Tiempo de viaje** (lineLength / cabinSpeedMs, mm:ss), **Capacidad** (cabinsPerLine × cabinCapacity(~10) × (3600/headwaySeconds) → pasajeros/hora estimate), **Velocidad** (km/h). Computed from the line geometry at build. Esc/click-empty closes.
- Data: network/aerialway.js computes per-line {name, color, lengthM, stations:[names], travelTimeS, capacityPax} stored on each line object. capacityPax = cabinsPerLine × paxPerCabin(10) × directionFactor.
- CONFIG.aerialway: paxPerCabin:10, label info.

### F2c — Floating labels (line + station names)
- render/aerialwayLabels.js NEW (or extend streetNames pattern): sprite label per line at its midpoint (line name, colored) + per station (station name). Billboard, distance-fade/LOD like streetNames. Toggle in GUI Vista «Etiquetas teleférico» (default ON). Built per-world, dispose().
- Reuse the streetNames canvas-text + sprite + 5 Hz LOD pattern (do NOT import streetNames; keep independent).

## CONFIG additions
```
aerialway (extend): sagRatio:0.04, maxSagM:8, minSupportSpacingM:60, cableGaugeM:3.0,
  cabinSpeedMs:5, stationSlowMs:1.2, stationZoneM:40, stationDwellS:4, paxPerCabin:10,
  showLabels:true, cabinCapacity:10
```

## Files
- network/aerialway.js (catenary, two cables, station arc-positions, per-line didactic stats)
- render/aerialwayMesh.js (sagging tubes, two offset cables, cabins with direction + station slowdown)
- render/picking.js (aerialway raycast — shared with v5? v5 doesn't touch picking; safe)
- ui/aerialwayInfo.js (NEW info panel), render/aerialwayLabels.js (NEW labels)
- main.js (wire info panel + labels + picking callback; __SIM__.aerialway extended with line stats + selectLine hook), gui.js (Vista «Etiquetas teleférico»), config.js (extend aerialway), explainer.js (update «Teleférico» section: catenaria, dos cables, estaciones, capacidad).

## Verification (Playwright, anti-hang timeouts, :5174)
- Catenary: sample a cable midpoint y between two towers < the tower endpoints y (it sags). Two cables: __SIM__.aerialway exposes cableCount = lines×2 or cabins split in two directions (sampleCabin two cabins moving opposite). Station stops: a cabin's speed drops near a station arc (sample cabin v over time near station < cruise).
- Panel: __SIM__.selectAerialwayLine(0) (or simulate click) → info panel DOM shows the line name + "pasajeros/hora" + "Estaciones"; values sane (lengthM>200, capacityPax>0). Labels: line/station sprites present (__SIM__.aerialwayLabels.count>0), toggle hides.
- Regression: full suite green; aerialway.lines still >0; cabins still animate; no console errors; perf steady (cables/labels are static or cheap).

## Deviations V6
(Builders append here.)

### R1 — Ruteo sensible a congestión (congestion-sensitive routing, default OFF)

NOTE: This spec doc is the teleférico (F1/F2) roadmap. R1 was specified separately by the orchestrator; logged here as the V6 deviations home.

- **Congestion signal reused, not re-derived**: the per-edge congestion measure is the detectors EWMA `e._speedRatio` (mean-vehicle-speed / free-flow, ~1 = free), already maintained alloc-free every 0.5 s sim by `sim/detectors.js computeEdgeSpeedRatios()`. No new per-edge accumulator was added — R1 reads what detectors already produce.
- **Penalty**: `congestionPenalty(speedRatio, cfg)` in `network/routing.js` = `1 + alpha·max(0,1−ratio)^gamma`, clamped to `[1, maxPenalty]`. Monotonic, bounded; ratio ≥ 1 → exactly 1. CONFIG: `routing.{congestionEnabled:false, rebuildEveryS:15, alpha:2.5, gamma:1.5, maxPenalty:6}`.
- **Cost integration**: `createRoutingBuilder(graph, closedSet, congestion=null)` gained a 3rd optional arg. When `congestion.enabled` is true, the PREV-edge traversal time is multiplied by the penalty (connector/turn cost left at free flow — turns carry no detector signal). When the arg is absent/disabled the penalty is 1 for every edge, so tables are **identical to free flow** (the OFF zero-behavioral-change contract). `buildRouting` threads the same arg; the network's initial build (`build.js`) passes nothing → free-flow, unchanged.
- **Periodic rebuild reuses the C1 budgeted machinery**: no parallel mechanism. `simulation.js` adds `startCongestionRebuild()` that builds through the same `createRoutingBuilder` → sync within `closures.recomputeBudgetMs`, else chunked into the double buffer over following steps; `finishRoutingSwap` swaps atomically and re-resolves routed vehicles. Cadence is **sim-time** (`time >= nextCongestionRebuildT`, period `rebuildEveryS`), strictly lower priority than closures and than finishing an in-flight rebuild (closures always win the buffer; a pending build never restarts mid-stream). A closure rebuild adopts the live congestion setting so toggling a closure never momentarily drops weighting.
- **Toggle semantics**: `sim.setCongestionRouting(b)`. ON → reset cadence timer to `time` (rebuild on the next step). OFF → one immediate free-flow (closure-aware) restore swap, then the cadence never fires again. GUI «Ruteo por congestión» checkbox in the Tráfico section (default OFF), carried across world swaps via `gui.applyTo` (only re-asserted when ON). `__SIM__` gains `setCongestionRouting` / `congestionRouting` / `congestionRebuilds` (e2e hook = completed weighted swaps).
- **Zero-alloc preserved**: `congestionParams` is a single stable object mutated in place (never reallocated); the builder reads `e._speedRatio` directly off the edge objects. No per-frame allocations added to any hot path.
- **Explainer NOT touched**: R1's orchestrator brief scoped the work to routing/sim/gui/config/tests only; `explainer.js` left unchanged to avoid regression risk to the existing suite.
- **Test**: `tests/v6-r1.spec.js` (1 test, isolated PASS ~48 s on :5173). Asserts (a) default OFF: flag false, `congestionRebuilds`==0, and over 50 sim-s with heavy demand `routingVersion` does NOT advance (no spurious rebuilds) — the OFF baseline; (b) ON: flag true, `congestionRebuilds` ≥ 3, `routingVersion` advances ≥ 3, vehicles keep moving (`v>1`), positions finite, real congestion present (`minSpeedRatio<0.9`, slowed edges >0 — non-vacuous), tables healthy (one per exit); (c) OFF: flag false, `congestionRebuilds` frozen over 40 sim-s, sim still populated, positions finite. No console errors throughout.
