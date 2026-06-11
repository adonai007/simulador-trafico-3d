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
