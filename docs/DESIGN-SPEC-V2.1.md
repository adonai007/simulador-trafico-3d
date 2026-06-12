# DESIGN SPEC V2.1 — Map completeness fix + Real street names

> Follow-up to V2. Same conventions (Spanish UI, English code, zero per-frame allocs, dispose(), static-site). Based on a quantified diagnostic reproduction (saved in engram, obs 131).

## A — Map completeness fix (user-reported bug)

User searched `https://www.google.com/maps/place/Macrodistrito+Centro,+La+Paz/@-16.5029088,-68.1246376,15z/...` → sparse broken network. Measured funnel: 107 ways fetched, 123 directed edges, **36 SCCs**, largest kept only 38.2% edges / 29.2% length, 0 entries → degraded onNetwork spawn. Buildings fetched for the full disc → buildings cover far more area than surviving roads.

### Confirmed root causes
1. `parseCoordsOrUrl` (src/osm/geocode.js) matches `@lat,lon,zz` first; the **place pin `!3d…!4d…` is never parsed** and Nominatim never reached for `/place/` URLs. The `@` viewport center sat 381 m off the urban core.
2. z15 → radius 410 m (0.35 factor formula) — too small, clips one-way avenue loops → graph fragments.
3. graph.js keeps ONLY the largest **SCC** → discards 70.8% of fetched road length in clipped one-way-heavy zones.
4. Validation too lax: `minKeptWays:5`, `minCoreEdges:10` let a visibly broken 47-edge network render silently.

### Fixes (all four; quantified on the exact URL)
1. **geocode.js**: parse `!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)` from Google Maps URLs and PREFER the pin over the `@` center when present (the pin is the searched place; the @ is just the viewport). → retention 29.2% → 95.4%.
2. **geocode.js**: radius floor for `/place/` URLs: `radiusM = max(zoomRadius, 800)` (still clamped ≤1200). → 91.9% even at the bad center. Plain `@` URLs (no place) keep current formula but raise floor to 500.
3. **graph.js**: replace keep-largest-SCC with **largest WCC (weakly connected component)**. Dead-end edge tips become entries (if directed into the component interior) / exits (if out). The sim already supports re-route at lane end + onNetwork/despawn fallbacks, so unreachable pockets self-resolve. Measured: user zone 80.5% edges / 73.3% length kept; default & pin zones 100%. KEEP Tarjan code available (flag `CONFIG.network.pruneMode: 'wcc'|'scc'`, default 'wcc') for didactic comparison and rollback.
4. **Validation (config.js + main.js search path)**: add `minKeptLengthKm: 2.5` and `minRetention: 0.5` (kept directed length / fetched directed length). On failure: ONE auto-retry with radius ×1.5 (≤1200), else Spanish toast "Red viaria incompleta en esta zona — probá con más radio o otro punto" and keep the previous world. `entries===0` after a search → console.info + toast "Zona sin conexiones al exterior — generación interna activada" (not silent).
5. **Note**: overpass-api.de returns HTTP 406 to non-browser UAs (WAF) — irrelevant for the app (browser UA), but document in CLAUDE.md for future node-side tooling.

### Verification A
- Standalone node script (tests/) reproducing the funnel for the user's exact URL through the REAL modules: assert kept length ≥ 15 km, entries ≥ 4, WCC retention ≥ 90% with the pin center.
- In-app (Playwright vs :5173): search the exact URL → `__SIM__.ready`, network center ≈ pin (-16.4995, -68.1241), `vehicleCount > 30` within 60 s, no console errors. Screenshot.
- Default La Paz zone: funnel unchanged (WCC == SCC there, 95%+) — regression guard. Existing e2e suite green.

## B — Real street names in 3D

OSM `name` is already preserved on edges (graph.js, added by F4 for the corridor). Render floating map-style labels.

### src/render/streetNames.js (new)
- Group edges by `name` (skip null/empty). For each unique name: pick the longest chain of consecutive same-name edges (reuse/adapt the chaining logic pattern from network/corridor.js — do NOT import corridor.js, keep modules independent; a simple by-name longest-edge fallback is acceptable if chaining is overkill). Label anchor = chain midpoint via `edge.lanes[0].posAt(length/2)` (y included → labels follow terrain), lifted +6 m.
- One THREE.Sprite per street: canvas-rendered text (offscreen canvas per label, trimmed to text width, font ~600 28px system-ui white with 4px dark outline, padding; texture min/mag linear, `sizeAttenuation: true`). Scale ∝ text length; cap total labels at CONFIG.streetNames.maxLabels (default 60), prioritized by highway class (primary > secondary > tertiary > residential) then chain length.
- Visibility: per-frame distance fade is allocation-free — precompute label positions array; in update(camera), for each sprite set `material.opacity` by camera distance bands (full <400 m, fade to 0 at 1200 m) and hide labels of minor roads when camera is far (class-based LOD: residential labels only <300 m). Gate the loop at ~5 Hz wall-clock.
- Returns `{group, update(camera), setVisible(v), dispose()}`. Built in makeWorld per network (names differ per zone), disposed on swap.

### Wiring
- main.js: instantiate after roads; call `update(camera)` in the frame loop (5 Hz gate inside); expose `__SIM__.streetNames = {count}`.
- gui.js (Vista folder): checkbox "Nombres de calles" (default ON) → setVisible.
- config.js: `CONFIG.streetNames = {maxLabels: 60, liftM: 6, fadeNearM: 400, fadeFarM: 1200, residentialMaxM: 300}`.

### Verification B
- `__SIM__.streetNames.count > 10` in default zone; sprite for "El Prado" or "Avenida 16 de Julio"/"Avenida Villazón" exists (check label text list exposed for test); toggle off hides group; no console errors; FPS unaffected (sim.lastStepMs unchanged, render steady). Screenshot with labels visible over the avenues.

## Execution
Single workflow after V2 completes: Agent A (fix A, owns geocode.js/graph.js/config.js/main.js search path) → Agent B (street names, owns streetNames.js + wiring; runs AFTER A to avoid main.js/config.js collisions) → adversarial verifier (both features + V2 regression: elevation/micros/heatmap/spacetime still alive) → deploy agent (commit, push, verify production incl. searching the user's URL in prod).

## Deviations V2.1
(Builders append here.)

**Builder A (map completeness fix), 2026-06-11:**

1. **Radius floors live in `CONFIG.geocode`** (`placeRadiusFloorM: 800`, `atRadiusFloorM: 500`) per the "ALL tunables in config.js" convention; `parseCoordsOrUrl` re-clamps the floored radius to `radiusClampM` (a floor of 800 with a future max < 800 must not escape the clamp). A pin (`!3d!4d`) with no `@` zoom in the URL falls back to `defaultRadiusM` before flooring.
2. **WCC core selection is by total directed edge LENGTH, not node count**: a sparse residential blob with many nodes must not outrank the avenue grid; length is also the unit the new validation measures. (SCC mode keeps its historic node-count rule untouched for rollback fidelity.)
3. **Validation thresholds live in `CONFIG.network`** alongside `pruneMode` (spec said "config.js" without an anchor). `graph.js` now returns `stats: {pruneMode, totalDirectedEdges, keptDirectedEdges, totalDirectedLengthM, keptDirectedLengthM}` and `build.js` forwards it as `network.graphStats` — retention is computed kept/fetched over DIRECTED length, both measured post-parse (the only lengths the pipeline has).
4. **The radius ×1.5 auto-retry lives in main.js `rebuildWorld`** (it refetches Overpass via `fetchNetworkOsm` and refetches the elevation grid for the larger disc); `rebuildWorld` now returns `true | 'incomplete' | false` and search.js maps `'incomplete'` to the "Red viaria incompleta…" toast, `false` to the historic "Zona sin red viaria suficiente…" one. The retry also fires when the first OSM payload was unusable (< minKeptWays) — a bigger disc can fix that too.
5. **The "Zona sin conexiones al exterior" toast triggers on `spawnMode === 'onNetwork'`, not literally `entries === 0`**: exits-only-zero also activates internal generation, and the toast text describes the fallback, not the count.
6. **e2e test 3 saturation demand raised 5000 → 6000 (the GUI slider max)**: with WCC the default zone keeps 100% of directed edges (303 vs 288 under SCC) and dead-end tips add entries/exits (7→32 / 4→28), so the same total demand spreads over more gates and trips shorten (more exits) — measured deterministically in node (exact test scenario, bundled snapshot + elevation): mean-speed ratio at demand 5000 is 0.925 (old SCC: 0.876), at 6000 it is 0.831 < 0.9. The test's semantic (saturation drops global mean speed ≥ 10%) is preserved with a larger margin than the old setup had.
7. **`playwright.config.js` port is overridable via `SIM_PORT`** (default 5173 unchanged): `reuseExistingServer` cannot tell WHICH app listens on the port; when another project occupies 5173 a human runs the suite with SIM_PORT pointing at the real dev server (see CLAUDE.md note).
8. **Funnel script extras** (`tests/funnel-macrodistrito.mjs`): overpass-api.de 406s even with a browser UA shim from node/curl (the WAF fingerprints the TLS client, not just the UA) and kumi.systems was down during the build — the script appends the `maps.mail.ru` full-planet mirror for node runs and caches responses in the OS tmpdir. Measured funnel on the user URL: BEFORE (@ center, 410 m, SCC) 107 ways → 123 directed edges → 47 kept (29.2% length), 0 entries; AFTER (pin center, 800 m, WCC) 418 ways → 699 directed edges → 693 kept (61.09/62.56 km = 97.7%), 58 entries / 55 exits. WCC alone at the bad center: 73.3% length, 12 entries.
9. **Open-Meteo can 429 the runtime elevation fetch for searched zones** (observed during verification: 800 m disc ≈ 16 batches × concurrency 4, on top of earlier traffic): the app degrades to flat terrain with the "Sin datos de elevación" toast exactly as designed in F1; the searched-zone "elevation non-flat" check is therefore conditional on the provider — the bundled default zone keeps its committed grid and stays non-flat regardless.

**Builder B (real street names in 3D), 2026-06-11:**

1. **`CONFIG.streetNames` carries three extra keys beyond the spec'd block**: `enabled: true` (initial "Nombres de calles" checkbox state — same precedent as `heatmap.enabled`/`busStops.enabled`), `labelHeightM: 12` (sprite world height; the spec fixed "scale ∝ text length" but no absolute size — width = canvas aspect × this), and `updateHz: 5` (the spec's "~5 Hz gate" made tunable per the "ALL tunables in config.js" convention).
2. **Sprite materials use `depthTest: false` + `depthWrite: false` + `renderOrder 10`** (map-style labels are never occluded): at +6 m lift most labels would otherwise clip into F1 terrain cuts, building walls, and each other — Google-Maps-style always-on-top is the intended look and avoids z-fighting entirely. Labels still fog and fade by distance.
3. **Chain-midpoint → lane mapping is proportional**: lanes are junction-trimmed so the edge-local arc `sEdge` does not exist on lane 0; the anchor uses `sLane = (sEdge / edge.lengthM) · lane.length`, clamped to `[0, lane.length]`. Chain lengths (for midpoint and priority sorting) use raw `edge.lengthM` like corridor.js.
4. **Class priority of a chain = max over its edges** (spec gave the ordering but not the aggregation); `*_link`, `unclassified` and `living_street` share the residential (minor) band and obey `residentialMaxM`. Any named whitelisted way is eligible — plaza ring roads ("Plaza Franz Tamayo") and park drives ("Parque Urbano Central") label their road, which is correct per "group by edge.name".
5. **`__SIM__.streetNames` exposes `{count, names}`**, not just `{count}`: the verification ("check label text list exposed for test") needs the rendered name list; `names[i]` is parallel to the sprite order (priority-sorted).
6. **`setVisible(true)` resets the 5 Hz gate** so fades re-apply on the next frame (re-enabling the checkbox would otherwise show up to 200 ms of stale opacities).
7. **Verification ran against the project's live dev server on port 5174** — on this machine port 5173 hosts an unrelated app (see Integrator deviation 4 / Builder A deviation 7); neither server was touched. Measured on :5174: 60/60 labels (cap hit), label y span −55.3…+73.9 m (terrain-following), `sim.lastStepMs` ≤ 0.3 ms at default demand, 0 console errors, toggle off/on verified through the real lil-gui checkbox.
