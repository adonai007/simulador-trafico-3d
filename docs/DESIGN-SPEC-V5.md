# DESIGN SPEC V5 — Ambulancia/Emergencias (E1) + Datos: CSV/Estadísticas/Replay (E2)

> Authoritative spec. Conventions: Spanish UI, English code, zero per-frame allocs (module scratch), stable object shapes, dispose() per module, static-site, CONFIG holds tunables. Dev server on **:5174** (run suite `$env:SIM_PORT="5174"; npx playwright test`). Existing 17 tests MUST stay green. Deviations at bottom.

> **ANTI-HANG RULE (mandatory for all verification scripts):** every standalone Playwright node script MUST set `page.setDefaultTimeout(15000)`, wrap the whole run in a hard process timeout (e.g. `setTimeout(()=>{console.error('TIMEOUT');process.exit(1)}, 120000)`), and NEVER call `waitForFunction`/`waitForEvent` without an explicit `{timeout}`. Delete the script after running. NEVER run two workflows against :5174 at once.

## E1 — Ambulancia / vehículos de emergencia

### Decision: emergency FLAG on a reused mesh slot, NOT a 7th vehicle type
Ambulances = normal vehicles with `typeIndex` of an existing mesh (reuse `suv`) + boolean `isEmergency`. Renders through the existing 6-InstancedMesh system untouched. Siren = separate overlay InstancedMesh (brake-light pattern). Never go through `pickVehicleType` (event-spawned, not demand). In master `vehicles[]` (integrate/render/despawn normally) but skipped in detector/FD loops via `isPhantom`-style guard.

### CONFIG.emergency
```
emergency: { enabled:true, meshType:'suv', maxConcurrent:3, v0Factor:1.35, accelFactor:1.4,
  gapFactor:0.55, signalSlowdownMs:6.0, yieldRadiusM:60, yieldLcSafeDecel:-7.0, yieldEdgeOffsetM:1.2,
  yieldSlowFactor:0.55, siren:{barW:1.4,barH:0.18,barD:0.5,y:1.65,blinkHz:4,colorA:0x2030ff,colorB:0xff2020},
  color:{r:0.93,g:0.95,b:0.97}, routeToIncident:true }
```

### vehicle.js
Stable factory fields: `isEmergency:false, _yielding:0 (sim-time lease), _yieldDir:0, spawnTime:0, _freeFlowTime:0`. New `createAmbulance(rng, lane)`: type=meshType, typeIndex valid, isEmergency=true, v0Factor/accel/idm.T*gapFactor/idm.s0*gapFactor, white color, len=suv.

### simulation.js (markers `--- E1 ---`)
1. **decide() signal branch**: if veh.isEmergency, replace red-light hard-stop with a creep: free-road IDM term with v0=signalSlowdownMs near the stop line (rolls through, never v=0). Still car-follows leader (min() framework — can't rear-end). Conflict-yield stays active (creep, don't hard-stop).
2. **markYields() pre-pass** (start of step 2, zero-alloc): per ambulance walk near-term path (lookaheadLeader hop pattern) up to yieldRadiusM; every non-emergency vehicle ahead → `_yielding = time + 0.5` (short lease, refreshed), `_yieldDir` = curb (rightmost lane idx).
3. **Yield behavior**: lane exists → maybeLaneChange uses `_mctx.yield` + yieldLcSafeDecel through mobil.js mandatory path (curb-ward). No lane → decide lowers v0 by yieldSlowFactor + sets lcLat toward curb by yieldEdgeOffsetM (renderer eases via existing lcLat). Ambulance sees larger gap automatically (no special-casing).
4. **spawnAmbulance(opts)**: weighted entry, createAmbulance, exitEdgeId; if routeToIncident && incidents → route toward incident. Enforce maxConcurrent counter. Despawn decrements counter in removeVehicle.
5. **Detector/FD exclusion** (detectors.js + cross() site): add `|| veh.isEmergency` to existing isPhantom guard.

### mobil.js
evaluateLane: when `ctx.yield` set, use emergency.yieldLcSafeDecel as safeDecel, treat like mandatory branch (return 0 on safety pass). Reuses mandatory path entirely.

### vehiclesMesh.js (markers `--- E1 ---`)
ONE sirenMesh InstancedMesh (unit box, MeshBasicMaterial, setColorAt, capacity maxConcurrent). In update() after brake block, per isEmergency vehicle emit roof instance at emergency.siren offset, alternate colorA/colorB by floor(sim.time*blinkHz)%2. +1 draw call only when ambulances exist. Expose sirenCount + yieldingCount debug hooks.

### gui.js + main.js (E1)
GUI «Emergencias» folder button «Llamar ambulancia 🚑» → __SIM__.callAmbulance(). Optional `a` keydown. __SIM__: callAmbulance()→id, ambulances getter {count, list:[{id,segId,s,v}]}, yieldingCount.

### Verification E1 (tests/v5-e1.spec.js, with anti-hang timeouts)
callAmbulance returns id, ambulances.count increments, caps at maxConcurrent. sirenCount>0 after spawn + color alternates across 2 frames. Others yield: spawn behind multi-lane traffic → within a few sim-s yieldingCount>0 OR a nearby vehicle lcLat!==0. Passes red: ambulance at a red signal keeps v > signalSlowdownMs*0.5 (doesn't stop). FD unaffected: flowVehHLane within tolerance of baseline with one ambulance.

## E2 — Datos: estadísticas + CSV + replay

### E2a — Stats dashboard + CSV
- **Trip stats** (simulation.js markers `--- E2a ---`): veh.spawnTime in trySpawn; `veh._freeFlowTime += ds/veh.seg.speedMs` in integrate loop; on exit-despawn recordTrip(veh): tripTime=time-spawnTime, delay=max(0,tripTime-_freeFlowTime). tripStats accumulator {completed, sumTripTime, sumDelay, sumDist, sumSpeed, completionsRing(60s)}. Getter tripStats → {viajesCompletados, tiempoMedioViaje, demoraMedia, demoraTotal, velocidadMedia, rendimiento(veh/min)}.
- **metricsHistory ring** (detectors.js or sim, ~2s sim-time gate): preallocated Float32Arrays {t, vehicles, meanSpeedKmh, flowVehHLane, densityVehKm}, cap ~900 (30 min). Zero-alloc. Getter metricsHistory.
- **stats.js (NEW, chart.js panel clone)**: collapsible «Estadísticas» panel, rows Viajes completados/Tiempo medio de viaje/Demora media/Demora total/Velocidad media/Rendimiento, updated on HUD cadence. «Exportar CSV» button → exportCSV(): Blob + createObjectURL + a.click() + revoke, UTF-8 BOM (﻿) for Excel accents, type text/csv;charset=utf-8, a.target=_blank. Files: metricas-globales.csv (metricsHistory), detectores.csv, viajes.csv (capped trip log). Spanish headers (tiempo_s,vehiculos,vel_media_kmh,...), filename = zone + timestamp.
- createStats(app) → {update, exportCSV, dispose}, wired in main.js like chart. __SIM__: tripStats, metricsHistory(or count), exportStats()→csv string.

### E2b — Replay scrubber (flat typed-array ring; markers `--- E2b ---`)
- **CONFIG.replay** = {enabled:true, windowS:180, recordHz:4, maxVehicles:600, stride:6}.
- **replay.js (NEW)** createReplayRecorder(sim): preallocated once — frameCount=ceil(windowS*recordHz)=720; frameVehCount=Int32Array(720); frameTime=Float32Array(720); data=Float32Array(720*600*6) (~10.4 MB). Ring over frames. record() per step, gated on SIM-TIME (nextRecordT=time+1/recordHz) so cadence follows sim-speed; writes sim.vehicles (skip phantoms, include ambulances) into next frame block: stride [id, typeIndex, x, y, z, heading]. Pure index math, zero alloc. Cap maxVehicles (drop overflow). reset() clears on world swap.
- **vehiclesMesh.updateFromReplay(replay, scrubT)** (NEW method, sibling to update()): read two bracketing frames for scrubT (by frameTime), match by id, lerp, build instance matrices via the SAME makeBasis block (heading from stored angle, y from stored elev), set per-type counts. Per-frame vehCount handles spawn/despawn. Siren/headlights skipped in replay (documented).
- **RAF swap (main.js)**: replayMode flag. ON → sim HARD-paused AND recording paused; RAF calls vehiclesMesh.updateFromReplay(replay, scrubT) instead of update(). Environment/lamps/gondolas/heatmap keep rendering live.
- **replay.js UI panel (ui/replayUI.js NEW)**: bottom bar, range slider 0..windowS, ● REC indicator (red while recording live), ▶/⏸/EN VIVO buttons (Spanish). Drag → replayMode=true + pause + scrub; EN VIVO → exit + resume sim + resume recording.
- Edge cases: world swap → replay.reset() + force EN VIVO (wire into rebuildWorld); sim speed → sim-time gate handles it.
- __SIM__: replay getter {recording, mode, windowS, frameCount, scrubT}, setReplayMode(b), setReplayScrub(tSeconds), replayFrameCount.

### Verification E2 (tests/v5-e2.spec.js, anti-hang timeouts)
E2a: ~60 sim-s @ high speed → tripStats.viajesCompletados>0, demoraMedia>=0, tiempoMedioViaje>0; metricsHistory count grows across 2 reads; exportStats() returns string with Spanish header + ≥2 data lines; «Exportar CSV» click → page.waitForEvent('download',{timeout:10000}) filename ends .csv. E2b: after ~30 sim-s replay.recording===true and frameCount>0; setReplayMode(true) → paused===true; setReplayScrub(t1) vs setReplayScrub(t2) → vehiclesMesh instanceMatrix element differs (proves scrubbing drives positions); EN VIVO → paused===false; world swap clears replay (or reset() hook).

## Execution: scaffold → E1 ∥ E2a ∥ E2b → integrate → verify → deploy
- **Scaffold (one agent)**: config.js blocks (emergency/replay/stats — disjoint top-level keys, identity-safe); marker comments `--- E1 --- / --- E2a --- / --- E2b ---` in simulation.js, vehiclesMesh.js, main.js, gui.js at insertion points. Build + 17/17 green (no-ops).
- **Parallel (3 agents, marker-block discipline in shared files):**
  | E1 ambulancia | E2a stats/CSV | E2b replay |
  |---|---|---|
  | vehicle.js, simulation.js(E1 markers), mobil.js, detectors.js(isEmergency guard), render/vehiclesMesh.js(siren, E1), tests/v5-e1.spec.js | simulation.js(E2a: spawnTime/_freeFlowTime/recordTrip/tripStats), detectors.js(metricsHistory), ui/stats.js(new), tests/v5-e2a in v5-e2.spec.js | simulation.js(E2b: replay.record call), sim/replay.js(new), render/vehiclesMesh.js(updateFromReplay, E2b), ui/replayUI.js(new), main.js(RAF swap), tests/v5-e2b |
  Each fills ONLY its marker blocks in shared files. removeVehicle exit-despawn path: E1 (counter) + E2a (recordTrip) both one-liners — integrator merges.
- **Integration**: reconcile markers, build + full suite (17 + new), screenshots, deviations.
- **Verification**: adversarial E1, E2a, E2b, regression v1-v4 — ALL with anti-hang timeouts. ONE workflow only.
- **Deploy**: tidy throwaway files, commit (NO Co-Authored-By trailer — author is the user only), push, poll Render, verify prod.

## Explainer (Spanish)
- «Vehículos de emergencia»: la ambulancia ignora el rojo con precaución (no se detiene del todo), los demás ceden el paso hacia el cordón mediante MOBIL forzado; podés llamarla con el botón y se dirige hacia el último incidente.
- «Datos y repetición»: panel de estadísticas (viajes completados, tiempo medio, demora, rendimiento), exportá todo a CSV, y la barra de repetición rebobina los últimos 180 s para estudiar cómo se formó un embotellamiento.

## Deviations V5
(Builders append here.)

### Scaffold (agent: scaffold)
- **Suite size is 29 tests, not 17.** The repo grew through V3/V4 (e2e.spec.js, v3-c1, v3-c2, v4-d1, v4-d2, v4-d3 = 29 tests in 6 files). The "17/17" green gate in the spec is stale; the real regression gate is **29/29**. Baseline before scaffold: build clean + 29/29 green (one run showed 27/2 with v4-d1 D1-5 + v4-d2 D2-2 failing — both are NETWORK-DEPENDENT flakes: Esri satellite tile stitching and live Overpass aerialway fetch; they pass when the network responds, and the scaffold touches neither D1 satellite nor D2 aerialway code). Post-scaffold re-run of v4-d1+v4-d2 = 10/10 green, confirming the flakes are environmental, not scaffold-induced.
- **config.js**: added three disjoint top-level keys under a "V5" banner (after `// --- end D3 ---`, before `// ---- Rendering ----`): `emergency` (E1, `// --- E1 --- … // --- end E1 ---`), `stats` (E2a), `replay` (E2b). All identity-safe: no ambulance spawns until `callAmbulance()`; stats are pure accumulators; `replay.enabled:true` only fills the ring (replayMode starts OFF, sim renders live). `stats`/`replay` carry a couple of scaffold-chosen derived tunables the spec implied but did not enumerate (`stats.completionsWindowS:60`, `metricsHistoryCap:900`, `metricsSampleS:2.0`, `tripLogCap:2000`, `bom`); feature agents may extend inside the block.
- **Marker convention**: each marker is a NAMED pair `// --- E1: <site> ---` … `// --- end E1: <site> ---` (or `--- E2a: … ---` / `--- E2b: … ---`) so the three parallel agents fill DISJOINT blocks with no collision. Distinct site suffixes disambiguate the multiple markers per agent within one file.
- **detectors.js NOT scaffolded.** The spec's scaffold bullet names only config.js + simulation.js/vehiclesMesh.js/main.js/gui.js. The `isEmergency` detector guard (E1) and the optional metricsHistory owner (E2a) in detectors.js are feature-agent edits, not scaffold; left untouched.
- **removeVehicle is the single exit-despawn owner** for both the E1 ambulance-counter decrement and the E2a `recordTrip(veh)` — markers are co-located there (`transition()` despawns via `removeVehicle`; phantoms despawn via `removeIncidentAt`, so recordTrip needs no phantom guard). Integrator merges the two one-liners.
- **E2a/E2b panels are standalone UI modules** (`ui/stats.js`, `ui/replayUI.js`), NOT lil-gui folders — only E1 gets a lil-gui «Emergencias» folder. gui.js therefore carries just the E1 marker; main.js carries the E2a/E2b import + init-wiring + `__SIM__` markers and the E2b RAF render-source swap + world-swap reset markers.

#### Exact marker layout (file → marker → what the agent inserts)
- **src/config.js**
  - `--- E1 ---` (emergency block) — E1: ambulance tunables (already populated, identity-safe).
  - `--- E2a ---` (stats block) — E2a: stats/CSV tunables.
  - `--- E2b ---` (replay block) — E2b: replay recorder tunables.
- **src/sim/simulation.js**
  - `--- E1: decide signal branch ---` (in `decide()`, at the `shouldStopAtSignal` site) — E1: ambulance red-light creep (v0 = signalSlowdownMs, never v=0).
  - `--- E1: markYields pre-pass ---` (start of step 2) — E1: per-ambulance path walk stamping `_yielding`/`_yieldDir` on civilians.
  - `--- E1: spawnAmbulance ---` (sibling after `trySpawn`) — E1: `spawnAmbulance(opts)` + maxConcurrent counter + route-to-incident.
  - `--- E1: removeVehicle exit ---` (in `removeVehicle`) — E1: `if(veh.isEmergency) ambulanceCount--`.
  - `--- E1: sim public hooks ---` (returned object) — E1: `callAmbulance` / `ambulances` / `yieldingCount`.
  - `--- E2a: trySpawn spawnTime ---` (in `trySpawn`) — E2a: `veh.spawnTime = time`.
  - `--- E2a: integrate freeFlowTime ---` (step-3 integrate loop) — E2a: `veh._freeFlowTime += ds/veh.seg.speedMs`.
  - `--- E2a: recordTrip exit ---` (in `removeVehicle`) — E2a: `recordTrip(veh)` → tripStats + trip log.
  - `--- E2a: step-5 metrics sampling ---` (step 5, after `detectors.update`) — E2a: push metricsHistory ring sample (single owner; may instead live in detectors.js).
  - `--- E2a: sim public hooks ---` (returned object) — E2a: `tripStats` / `metricsHistory` getters.
  - `--- E2b: step-3 detector cross ---` (detector-cross site) — E2b: reserved per-vehicle crossing hook (record call lives at step-5; usually nothing to add).
  - `--- E2b: step-5 sampling ---` (step 5, after `detectors.update`) — E2b: `replayRecorder.record(time)` (sim-time gated).
  - `--- E2b: sim public hooks ---` (returned object) — E2b: `replay` getter / recorder handle.
- **src/render/vehiclesMesh.js**
  - `--- E1: siren mesh setup ---` (after the brake InstancedMesh setup) — E1: create the one sirenMesh (capacity = maxConcurrent).
  - `--- E1: siren emit ---` (in `update()`, AFTER the brake block) — E1: emit a roof siren instance per `isEmergency`, blink colorA/colorB.
  - `--- E1: siren finalize ---` (end of `update()`) — E1: commit `sirenMesh.count` + needsUpdate flags.
  - `--- E1: mesh debug hooks ---` (returned object) — E1: `sirenMesh` + `sirenCount`/`yieldingCount` getters.
  - `--- E1: siren dispose ---` (in `dispose()`) — E1: dispose siren geom+material.
  - `--- E2b: updateFromReplay sibling method ---` (sibling to `update()`) — E2b: `updateFromReplay(replay, scrubT)` (same makeBasis block; siren/headlights skipped).
- **src/main.js**
  - `--- E2a ---` (imports) — E2a: `import { createStats }`.
  - `--- E2b ---` (imports) — E2b: `import { createReplayRecorder } / { createReplayUI }`.
  - `--- E2b ---` (module scope, after `window.__SIM__`) — E2b: `let replayMode/replayScrubT` render-source flags.
  - `--- E2a ---` / `--- E2b ---` (init UI-layer wiring, near `createChart`) — E2a: `createStats(app)`; E2b: recorder + replay UI wiring.
  - `--- E2b ---` (in `rebuildWorld`, at the swap point) — E2b: force EN VIVO + `replay.reset()` on world swap.
  - `--- E2b: RAF render-source swap ---` (in `frame()`, before `vehiclesMesh.update`) — E2b: call `updateFromReplay` instead of `update` while replayMode ON.
  - `--- E1 ---` / `--- E2a ---` / `--- E2b ---` (in `window.__SIM__`) — E1: `callAmbulance`/`ambulances`/`yieldingCount`/`sirenCount`; E2a: `tripStats`/`metricsHistory`/`exportStats`; E2b: `replay`/`setReplayMode`/`setReplayScrub`/`replayFrameCount`.
- **src/ui/gui.js**
  - `--- E1 ---` («Emergencias» folder, after the C1 «Obras» folder) — E1: «Llamar ambulancia 🚑» button → `__SIM__.callAmbulance()`.

### E1 — Ambulancia / emergencias (agent: E1)
- **Implemented as specified — flag on a reused `suv` slot, not a 7th type.** `vehicle.js` adds the stable factory fields (`isEmergency`, `_yielding` sim-time lease, `_yieldDir`, `spawnTime`, `_freeFlowTime`) and `createAmbulance(rng, lane)` (white color, `v0Factor`/`accelFactor`/tightened `T`/`s0`, `typeIndex` of `suv`).
- **simulation.js**: `spawnAmbulance(opts)` with a `maxConcurrent` counter (`ambulanceCount++/--`, decrement in `removeVehicle`); `markYields()` pre-pass stamps `_yielding`/`_yieldDir` on civilians within `yieldRadiusM`; red-light **creep** via a free-road IDM term at `v0 = signalSlowdownMs` (never `v=0`, still car-follows through the `min()` framework, conflict-yield stays active); `pickExitTowardIncident` routes the ambulance toward the latest incident when `routeToIncident`.
- **Detector/FD exclusion**: the `isPhantom` guard gains `|| veh.isEmergency` in `detectors.js` and at the `cross()` site, so emergencies never enter the fundamental diagram.
- **mobil.js**: `evaluateLane` honors `ctx.yield` (curb-ward mandatory path at `yieldLcSafeDecel`), reusing the mandatory branch entirely.
- **vehiclesMesh.js**: ONE `sirenMesh` InstancedMesh (capacity `maxConcurrent`) emits a roof instance per emergency vehicle, blinking `colorA`/`colorB` by `floor(time*blinkHz)%2`; +1 draw call only when ambulances exist.
- **gui.js / main.js**: «Emergencias» folder with «Llamar ambulancia 🚑»; `__SIM__.callAmbulance()` → id, `ambulances` getter, `yieldingCount`/`sirenCount`.

### E2a — Estadísticas + CSV (agent: E2a)
- **Trip stats** in `simulation.js`: `veh.spawnTime` set in `trySpawn`; `veh._freeFlowTime += ds/seg.speedMs` in the integrate loop; `recordTrip(veh)` on exit-despawn folds `tripTime`/`delay`/`dist`/`speed` into a `tripStats` accumulator + a capped trip log + a 60 s completion ring. `recordTrip` skips phantoms and emergencies.
- **metricsHistory ring** lives in `simulation.js` (step-5 owner, ~2 s sim-time gate), **not** in `detectors.js` — preallocated typed arrays, cap ~900, zero-alloc.
- **stats.js (new)**: collapsible «Estadísticas» panel (6 rows on the HUD cadence) + `exportCSV()` producing `metricas-globales.csv`, `detectores.csv`, `viajes.csv` with a UTF-8 BOM and `text/csv;charset=utf-8`, Spanish headers, zone+timestamp filenames.
- **Deviation — dropped `a.target="_blank"`** on the CSV download anchor (spec §E2a asked for it). With `target=_blank` Playwright's `.click()` stalls waiting for a popup event that never resolves; the download fires correctly without it. Documented divergence.
- `__SIM__`: `tripStats`, `metricsHistory`, `exportStats()` (returns the CSV string for the test).

### E2b — Replay scrubber (agent: E2b)
- **replay.js (new)** `createReplayRecorder({vehicles})`: preallocated flat typed-array ring (`Int32Array`/`Float32Array`, ~10.4 MB at the spec'd dims), sim-time-gated `record()` at step-5 (cadence follows sim speed), `reset()` on world swap, `minTime`/`maxTime` read API. Pure index math, zero alloc.
- **vehiclesMesh.updateFromReplay(replay, scrubT)** (sibling to `update()`): reads two bracketing frames, matches by id, lerps, rebuilds instance matrices through the SAME `makeBasis` block. **Siren and headlights are intentionally not rendered in replay** (documented limitation).
- **main.js RAF swap**: a `replayMode` flag (via the `app._applyReplayMode` hook) hard-pauses the sim + recorder and routes the RAF to `updateFromReplay` instead of `update`; environment/lamps/gondolas/heatmap keep rendering live. World swap forces EN VIVO + `replay.reset()`.
- **replayUI.js (new)**: bottom bar with range slider, ● REC indicator, ▶/⏸/EN VIVO. `__SIM__`: `replay` getter, `setReplayMode`, `setReplayScrub`, `replayFrameCount`.

### Integrator
- **`removeVehicle` is the single exit-despawn owner** — the E1 ambulance-counter decrement and the E2a `recordTrip(veh)` one-liners were merged there cleanly with no collision (the scaffold marker layout held).
- All three feature surfaces filled disjoint marker blocks in the shared files (`simulation.js`, `vehiclesMesh.js`, `main.js`, `gui.js`) — no duplicated wiring; RAF order correct (replay render-source swap precedes the live `vehiclesMesh.update`).
- Screenshots captured: `docs/screenshots/v5-ambulancia.png`, `v5-replay.png`, `v5-stats.png`.
- **Stale spec facts corrected**: with the two V5 spec files the suite is **44 tests across 8 files** (v5-e1 added 5, v5-e2 added 10 to the prior 29); the runtime port is **5173 via plain `npx playwright test`** (the `:5174` / `SIM_PORT` instruction at line 3 and §Execution is superseded by the project CLAUDE.md). The two environmental flakes are `v4-d1` D1-5 (Esri satellite tile stitching) and `v4-d2` D2-2 (live Overpass aerialway fetch) — network-dependent, retry-green, not bugs (both passed on the closing run).

### Verification & fix — v5-e1 test 5 (FD-unaffected) was a flawed test, not a bug
- **Symptom**: the closing full-suite run was 43/44, with only `v5-e1` test 5 («el diagrama fundamental no se ve afectado por una ambulancia») failing: `expect(rel).toBeLessThan(0.5)` got `0.9594560244026438`.
- **Root cause (measured, not guessed)**: the test compared `flowVehHLane` averaged over two **consecutive 20 s windows** (one before, one after adding ambulances) and required <50 % relative change. But `flowVehHLane` is built from **60 s detector windows** over a network still filling toward saturation (constant 2400 vph, no ramp), so the FD drifts heavily on its own. A control measurement of two ambulance-free consecutive windows reproduced **the exact failing number** (`CTRL_REL_q = 0.9594560244…`, flow ~31→~61 veh/h/lane), with **mean speed flat/declining** — i.e. the doubling was pure detector-window non-stationarity, with zero ambulance involvement.
- **Exclusion verified correct in code**: `detectors.cross()` is gated `!veh.isEmergency` (simulation.js), and detector occupancy + the speed-ratio EWMA skip emergencies (detectors.js). Ambulance crossings/occupancy/density never enter the FD. The contract holds; the global FD is simply too coarse to detect a 3-ambulance contribution against ~96 % natural drift — the wrong instrument for this assertion.
- **Fix (test only, no source change)**: rewrote test 5 to **self-calibrate** — it measures the FD's natural window-to-window drift from two ambulance-free windows, then asserts that adding 3 ambulances does not move the FD beyond that natural drift (+0.5 margin), and that the ambulances actually exist and move (non-vacuous). Robust to the non-stationarity that caused the false failure. A truly deterministic exclusion proof belongs in a future unit test (T1).
- **Result**: rewritten test passes in isolation (34 s); **full suite 44/44 green on re-run** (9.7 min, the two network flakes included).
