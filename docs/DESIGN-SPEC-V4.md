# DESIGN SPEC V4 — Vista satélite (D1) + Teleférico (D2) + Compartir/Tour (D3)

> Authoritative spec. Conventions: Spanish UI, English code, zero per-frame allocs, stable shapes, dispose() per render module, static-site (bundled fallback for default La Paz zone; live fetch + graceful fallback for searched zones), CONFIG holds tunables. Dev server runs on **:5174** (5173 is taken by another app; the running vite was started with --port 5174 --strictPort). Run suite as `$env:SIM_PORT="5174"; npx playwright test`. Existing 14 tests MUST stay green. Deviations at bottom.

## USER DECISIONS (fixed)
- Vista satélite = a TOGGLE alongside the stylized low-poly view. In satellite mode KEEP 3D buildings but SEMI-TRANSPARENT (opacity ~0.5). Imagery draped on the displaced terrain so it follows the hills.
- Imagery source: Esri World Imagery (no Google). Teleférico = Mi Teleférico real lines + animated cabins. Compartir = URL scenario serialization + a guided tour mode.

## Architecture facts (verified, v3 live in prod)
- Segments: pointAt/headingAt (2D), posAt(s,out)->{x,y,z}, gradeAt(s). Edges {id, fromNode, toNode, lanes[], twinId, wayId, name, highwayClass, speedMs}. network.elevation={elevAt(x,z),minElev,maxElev,flat}, network.center, network.signals, network.busStops, network.exits/entries, network.projection.
- projection.js: createProjection(center) → toLocal(lat,lon)->{x,z} AND toLatLon(x,z)->{lat,lon} (inverse — UV math foundation). x=east, z=−north.
- terrainMesh.js: PlaneGeometry over bbox+~35% margin/side displaced by sampler; uv attribute DELETED; MeshLambertMaterial groundColor; receiveShadow. Only built when elevation && !flat. buildings.js merged InstancedMesh MeshLambertMaterial vertexColors on terrain. environment.js (v3) pure apply() owns sun/sky/fog/wetness/lamps/building-emissive — does NOT touch terrain material color (keep it that way). scene.js getFrameInfo()->{cx,cz,span}, MapControls, setGroundVisible.
- main.js app={view,world,environment}; makeWorld builds roads/terrain/signals/sim/vehicles/busStops/works/streetLamps/streetNames; attachBuildings async fire-and-forget; rebuildWorld(osm,center,radius); window.__SIM__ hooks. gui.js lil-gui folders, applyTo(world) persists across swaps. overpass.js buildHighwayQuery+fetchWithFallback(mirrors). parse.js keeps all node tags. e2e suite 14 tests.

---

## D1 — Vista satélite

### NEW src/render/satellite.js (pure, no scene coupling)
Tile math (Web-Mercator slippy; Esri order **{z}/{y}/{x}**):
```
n=2^z; xt=(lon+180)/360*n; yt=(1-asinh(tan(lat*PI/180))/PI)/2*n
inverse: lon=xt/n*360-180; lat=atan(sinh(PI*(1-2*yt/n)))*180/PI
```
- `computeTileCover(planeRect, projection, opts)`: corners of the TERRAIN PLANE (bbox+35% margin — NOT raw bbox, or margin ring samples garbage) → toLatLon → tiles; pick zoom from maxZoom 18 down while tileCount>maxTiles(64) && z>minZoom(15); geoBounds = whole-tile rect {xtMin=x0, xtMax=x1+1, ytMin=y0, ytMax=y1+1} at fixed z.
- `loadSatellite(network,opts)`: offscreen canvas (x1-x0+1)*256 × (y1-y0+1)*256 cap maxCanvasPx 4096 (drop zoom if exceeded); fetch each tile as Image crossOrigin='anonymous', concurrency 6, timeout 12 s; drawImage into cells; any tile fail (>10%) → return null; texture=CanvasTexture, colorSpace=SRGB, anisotropy=max, wrap=ClampToEdge.
- `buildTerrainUVs(geom, network, geoBounds)`: per vertex (x,z) → projection.toLatLon → xt,yt (Mercator, fixed z) → u=(xt-xtMin)/(xtMax-xtMin); vPixel=(yt-ytMin)/(ytMax-ytMin); v=1-vPixel. Stay in TILE UNITS (×256 cancels). Use per-vertex Mercator, NOT linear bbox stretch. **The likely bug = v flip from CanvasTexture flipY: screenshot-check at noon; if roads mirrored N/S, flip v sign.**
- `loadDefaultSatellite()`: bundled public/data/default-satellite.jpg + default-satellite.json {z,x0,x1,y0,y1,geoBounds,center,attribution}.

### terrainMesh.js (D1 block): add `setSatellite(sat|null)` + expose planeRect
- null: mat.map=null, mat.color=groundColor, needsUpdate. present: buildTerrainUVs → geom.setAttribute('uv',...); mat.map=sat.texture; mat.color=white (photo true colors); keep MeshLambertMaterial (sun/shadow/fog composite for free at night/rain). Flat-zone fallback: drape on the scaled ground plane with full-quad UV (minimal; default La Paz always has elevation).

### main.js (D1 block)
- makeWorld: world.satellite=null + fire-and-forget attachSatellite(world) (default→loadDefaultSatellite, searched→loadSatellite). On resolve if app.world===world && Vista toggle ON → world.terrain.setSatellite(sat), else dispose. null + user-enabled → toast "Sin imágenes satelitales para esta zona". Gate application on the persisted GUI param.
- Buildings semi-transparent on satellite ON: material.transparent=true, opacity 0.5, KEEP depthWrite=true (merged mesh — depthWrite=false causes self-sort artifacts; document tradeoff). OFF restores. Re-apply after attachBuildings resolves (world.applySatelliteToBuildings()).
- dispose: world.satellite?.dispose(). __SIM__: setSatellite(b), satellite getter {enabled, ready}, terrainHasMap hook (!!terrain.mesh.material.map).
- Attribution credit line visible only while satellite ON (Esri license).

### scripts/fetch-default-satellite.mjs + CONFIG
- Node fetch+stitch using @napi-rs/canvas (devDependency, build-time only — NOT shipped, Render build only reads committed JPG). Output JPG q80 + JSON. npm script "fetch:satellite".
- CONFIG.view={satellite:false}; CONFIG.satellite={url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom:18, minZoom:15, maxTiles:64, maxCanvasPx:4096, concurrency:6, tileTimeoutMs:12000, buildingOpacity:0.5, attribution:'Imágenes © Esri, Maxar, Earthstar Geographics'}.

---

## D2 — Teleférico Mi Teleférico

### osm/overpass.js (D2 block)
buildAerialwayQuery(lat,lon,r): `[out:json][timeout:30];( way(around:r,...)["aerialway"]; node(around:r,...)["aerialway"]; );(._;>;);out body;` + fetchAerialwayOsm (same transport). Failure/empty → no teleférico (graceful like buildings).

### NEW network/aerialway.js
buildAerialways(osm, projection, elevation) → {lines:[{points3D[arc-param], color, name}], stations[], towers[]} | null. Parse aerialway ways → polylines → toLocal; station/tower nodes. Height: cableY=elevAt(x,z)+cableHeightM, lerp tower-to-tower, sample ~sampleStepM, arc-length param (util/math2d cumulativeLengths/pointAtParam). Color from OSM colour/name (Mi Teleférico Roja/Amarilla/Verde/Azul/Naranja/Blanca/Celeste/Café/Plateada/Morada → CONFIG.aerialway.lineColors) else palette by index. null if no ways. **Build in makeWorld from osm (keeps network/build.js out of shared edits).**

### NEW render/aerialwayMesh.js (per-world, only if lines exist; pattern of worksMesh)
- Cables: TubeGeometry along raised 3D polyline (radius cableRadiusM) merged per color, MeshBasicMaterial tinted, 1 draw call/color.
- Towers: InstancedMesh tall posts at tower nodes (base elevAt, height towerHeightM). Stations: InstancedMesh small boxes.
- Cabins (animated): InstancedMesh gondola per line color, cabinsPerLine each, arc-length s advanced cabinSpeedMs*dt, position via pointAtParam on raised polyline (rides cable height), both directions, ping-pong/wrap at ends, makeBasis from tangent. update(dt) advances cabins (cheap, zero-alloc scratch). dispose().

### main.js (D2 block) + scripts + CONFIG
- makeWorld: world.aerialwayMesh if lines; scene add; dispose removes. Default→public/data/default-aerialway.json; searched→fetchAerialwayOsm fire-and-forget. Per-frame world.aerialwayMesh?.update(wallDt). __SIM__: aerialway getter {lines, cabins}, sampleCabin()->{x,y,z}. Respect Vista "Teleférico" checkbox (group.visible).
- scripts/fetch-default-aerialway.mjs (fetch at wider radius ~1500 so lines aren't all clipped) → public/data/default-aerialway.json (raw Overpass). npm "fetch:aerialway".
- CONFIG.aerialway={enabled:true, cableHeightM:30, towerHeightM:25, cableRadiusM:0.15, sampleStepM:8, cabinsPerLine:6, cabinSpeedMs:8, cabinSize:{l:3.2,w:2.0,h:2.6}, lineColors:{Roja:0xd0021b,Amarilla:0xf5a623,Verde:0x2e7d32,Azul:0x1565c0,Naranja:0xef6c00,Blanca:0xeceff1,Celeste:0x4fc3f7,Café:0x6d4c41,Plateada:0x9e9e9e,Morada:0x6a1b9a}, palette:[0xd0021b,0xf5a623,0x2e7d32,0x1565c0,0xef6c00]}.

---

## D3 — Compartir por URL + modo tour

### NEW ui/share.js
- serializeState(app,gui)→URLSearchParams: c=lat,lon + r=radius (OMIT for default zone) or q=lastQuery; d=demanda, v=velSim, h=hora, w=clima0/1, wi=intensidad, hm=heatmap, sat=satélite, tel=teleférico, nm=nombres; closed=list of `wayId:fromNode:toNode` (OSM-stable, NOT edge id which is build-specific).
- buildShareUrl=origin+pathname+'?'+params. copyShareLink: navigator.clipboard.writeText → toast "Enlace copiado" (fallback input+execCommand).
- applyFromUrl(params, app, gui, rebuildWorld) — BOOT RESTORE ORDERING (critical): (1) parse; empty→return. (2) ZONE FIRST: if q or non-default c → fetchNetworkOsm + await rebuildWorld; fail→toast+continue on default. (3) AFTER world ready: apply via setters + gui.applyState(state) (sets param, calls setter, controller.updateDisplay()). Order: demanda/vel/pausa → clima+intensidad (environment.setWeather) → hora (setTimeOfDay) → heatmap → nombres → satélite (async) → teleférico. Apply AFTER rebuildWorld returns (its gui.applyTo/environment.applyTo already ran). (4) CLOSURES LAST: resolve closed entries against network.edges by (wayId,fromNode,toNode) exact, else wayId-nearest-midpoint, else skip; closeEdge each + roads.notifyClosuresChanged(). Reliable on same default zone, best-effort elsewhere.
- bootShare(app,gui,rebuildWorld) called at end of init() after __SIM__ assigned.

### NEW ui/tour.js
createTour(app,gui): SCENES [{caption Spanish, apply(app,gui), holdMs}]: 1 "Mañana tranquila" (hora 6.5, demanda 800, despejado, vista general); 2 "Hora pico" (demanda 5000); 3 "Cierre de avenida" (close longest primary/secondary edge, heatmap on); 4 "Llega la lluvia" (lluvia 0.9); 5 "Anochece" (hora 19.5). Apply via same setters as share (shared applyState helper). Camera presets: viewGeneral=view.frame(bbox); viewStreet=follow a vehicle. UI drives #tour panel (▶/⏭/⏸ + caption), manual Siguiente or auto holdMs. __SIM__.tour {playing, scene, play(), next(), pause()}.

### main.js (D3 block) + index.html + CONFIG
- Stash app.lastQuery on successful search. End of init(): app.tour=createTour(app,gui); bootShare(app,gui,rebuildWorld). __SIM__.share {url(), copy()}, __SIM__.tour. index.html: hidden #tour panel (caption + 3 buttons) + CSS. gui.js "Escenario" folder: "Compartir enlace" button, "Modo tour" button.
- CONFIG.share={paramVersion:1}; CONFIG.tour={autoHoldMs:9000, closeMainEdge:true}.

---

## Execution: scaffold → parallel D1/D2/D3 → integrate → verify → deploy

**Scaffold (one agent)**: config.js (view/satellite/aerialway/share/tour stub keys with identity defaults), main.js (// --- D1/D2/D3 --- marker blocks in makeWorld/world/dispose/attachBuildings/rebuildWorld/__SIM__/init), gui.js (Vista folder checkbox stubs + "Escenario" folder placeholder, applyTo lines), explainer.js (nothing — append-only), index.html (#tour panel hidden + CSS). Build clean + 14/14 green (all no-ops).

**Parallel (disjoint ownership; agents edit ONLY their marker block in shared files):**
| D1 satélite | D2 teleférico | D3 compartir/tour |
|---|---|---|
| render/satellite.js*, terrainMesh.js (setSatellite), scripts/fetch-default-satellite.mjs*, public/data/default-satellite.{jpg,json}*, tests/v4-d1.spec.js* | osm/overpass.js (aerialway query), network/aerialway.js*, render/aerialwayMesh.js*, scripts/fetch-default-aerialway.mjs*, public/data/default-aerialway.json*, tests/v4-d2.spec.js* | ui/share.js*, ui/tour.js*, tests/v4-d3.spec.js* |
Plus each fills ONLY its // --- Dx --- block in config.js/main.js/gui.js/explainer.js.

**Integration**: reconcile marker blocks, run build + full suite (14 + 3 new), fix collisions, screenshots, deviations.
**Adversarial verification** (D1, D2, D3, regression v1/v2/v2.1/v3) + fix loop.
**Deploy**: commit, push, poll Render, verify production.

## Verification (Playwright, SIM_PORT=5174)
- D1: __SIM__.setSatellite(true)→satellite.ready, terrainHasMap true (false+groundColor when off); buildings opacity≈0.5 transparent true on, 1/false off; screenshot noon (roads aligned on photo — flag v-flip first run); console clean 8 s; graceful fallback toast on tile fail (skip-if-offline).
- D2: aerialway.lines>0 (default zone — widen fetch radius if clipped); sampleCabin displaces >2 m over 3 s @4x and y elevated (>elevAt+10); Teleférico toggle hides group; console clean.
- D3: set distinctive state, share.url(), goto(url), restored values match (demanda, weather.mode, timeOfDay, heatmap) on default zone (no live fetch); close longest edge → URL → reload → closedEdges.size≥1; "Compartir enlace" → toast "Enlace copiado"; tour play→playing, next→scene++ and state changed, #tour caption visible Spanish.
- Regression: existing 14 green; elevation/buses/heatmap/spacetime/streetnames/closures/weather/daynight all alive.

## Explainer (Spanish, append before "Experimentos sugeridos")
- "Vista satélite": imagen aérea real (Esri) proyectada sobre el terreno con relieve; edificios semitransparentes muestran el volumen sobre la foto.
- "Teleférico Mi Teleférico": líneas reales de OSM por color (Roja, Amarilla, Verde…), cabinas animadas sobre el cable elevado — identidad paceña.
- "Compartir y modo tour": Compartir copia un enlace que reproduce el escenario exacto; Modo tour recorre escenas didácticas (mañana tranquila → hora pico → cierre → lluvia → anochecer).
- +2 bullets experimentos: activar Vista satélite y comparar; compartir un escenario de hora pico con lluvia.

## Deviations V4
(Builders append here.)

### Scaffold (no behavioral change)
- `app` literal in main.js gained two stable-shape fields up front: `lastQuery: null` (D3 fills on successful search) and `tour: null` (D3 assigns `createTour`). Keeps object shape stable (no late property adds) per the zero-alloc/stable-shape convention. D3 also reads `app.share` (assigned in the D3 init:end block) for the `__SIM__.share` hooks.
- `__SIM__` D1/D2/D3 hooks are present as INERT stubs (not absent) so the e2e hook shape exists and is safe to call before the feature lands: `setSatellite` (no-op), `satellite` getter `{enabled:false, ready:false}`, `terrainHasMap` (already correct — `!!terrain.mesh.material.map`, false until D1 drapes), `aerialway` getter (null until mesh exists), `sampleCabin` (null), `share.url()`→`location.href` / `share.copy()` (no-op), `tour` getter (null). Each carries a comment telling the owning agent exactly what to replace it with.
- gui.js «Vista» folder gained `verSatelite` + `verTeleferico` checkboxes (`?.`-guarded no-ops) and a new top-level «Escenario» folder with «Compartir enlace 🔗» + «Modo tour ▶» buttons (`?.`-guarded). `applyTo(world)` re-asserts both toggles on world swap (guarded).
- index.html: hidden `#tour` panel (`#tour-scene`, `#tour-caption`, `#tour-play`/`#tour-next`/`#tour-pause`) + CSS (`#tour.visible{display:flex}`). D3 owns the wiring.
- CONFIG stub keys added with identity/off-safe defaults: `view.satellite:false`, full `satellite` block, `aerialway` (enabled:true — off-safe, only renders if lines exist), `share.paramVersion:1`, `tour{autoHoldMs,closeMainEdge}`.
- explainer.js intentionally untouched (append-only; feature agents append before "Experimentos sugeridos").

### D3 — Compartir por URL + modo tour (implementación)
- **Param schema (paramVersion 1).** Zone: `q` (place name, preferred — survives OSM rebuilds) or `c=lat,lon`+`r=radius`; BOTH omitted for the default La Paz zone so default links stay short. Settings: `d`=demanda, `v`=velSim, `h`=hora, `w`=clima (1=lluvia/0=despejado), `wi`=intensidad, `hm`=mapa de calor, `sat`=satélite, `tel`=teleférico, `nm`=nombres (all booleans 1/0). Closures: `closed=wayId:nodeLo:nodeHi,...` where the node pair is **sorted ascending** so a twin pair (both directions) serializes ONCE and restores both twins.
- **serializeState reads LIVE runtime state, not gui.params, for the dynamic fields** (`sim.demand`, `sim.simSpeed`, `CONFIG.dayNight.timeOfDay`, `CONFIG.weather.mode/intensity`, `roads.getHeatmapState().enabled`), falling back to gui.params. Rationale: the link must be accurate whether state was set via the GUI OR directly through `__SIM__` setters (the e2e path). Toggle-only fields with no live getter yet (`sat`,`tel`,`nm`) read gui.params.
- **gui.applyState(patch)** added to the gui return object (new method, D3-marked). It mirrors a restored/tour patch into `gui.params` and redraws the matching lil-gui controllers via `gui.controllersRecursive()` keyed by `ctrl.property`. It does NOT re-invoke setters (callers drive the live setters first) — avoids double-apply. This is the only addition outside an existing `// --- D3 ---` marker (the return object had none); kept minimal and clearly marked.
- **Boot restore ordering (applyFromUrl)** follows the spec exactly: (1) parse, empty→return; (2) ZONE FIRST — `q`→resolveQuery, else `c`→coords; `fetchNetworkOsm` + **await** `rebuildWorld` before any setter; failure toasts and continues on the live (default) world; (3) SETTERS in order demanda/vel → clima+intensidad (one `setWeather`) → hora → heatmap → nombres → satélite (defensive `__SIM__.setSatellite?.` since D1 lands in parallel) → teleférico, then one `gui.applyState`; (4) CLOSURES LAST — each `closed` triple resolved against `network.edges` by exact (wayId + unordered node pair), else same-wayId nearest edge touching an endpoint, else skipped; `closeEdge` + a single `roads.notifyClosuresChanged()`.
- **lastQuery capture without touching search.js.** The `rebuildWorld:success` block reads the query text from `center.text` (share-restore caller) or the live `#search-input` value (interactive search), so `createSearch` needed no D3 changes. Stored as `app.lastQuery = {center, radius, text}`.
- **Clipboard:** `navigator.clipboard.writeText` with a hidden-textarea + `execCommand(copy)` fallback for non-secure contexts; toast «Enlace copiado» on success.
- **Tour** drives scenes through the SAME `applyState(app, gui, patch)` helper as share (tour.js exports it), so a tour scene and a shared link converge on identical world state. 5 Spanish scenes (Mañana tranquila → Hora pico → Cierre de avenida → Llega la lluvia → Anochece); scene 3 closes the longest primary/secondary interior twin-paired edge (CONFIG.tour.closeMainEdge) + heatmap on. Auto-advance per CONFIG.tour.autoHoldMs (9 s) or manual «Siguiente»; last scene stops auto-advance but leaves the panel open. `__SIM__.tour` exposes `{playing, scene, sceneCount, caption, play, next, pause, close}`.
- **explainer.js:** appended a «Compartir y modo tour» section before «Experimentos sugeridos» plus 2 experiment bullets (Vista satélite comparison; share an hora-pico-con-lluvia scenario), all D3-marked.
- **Tests:** `tests/v4-d3.spec.js` — 5 tests, all on the DEFAULT zone (no live Overpass): round-trip (d/v/h/w/hm + weather multipliers), closures survive the link (OSM-stable wayId in URL, closedEdges.size≥1 after reload), «Compartir enlace» copies + toast, tour play/next/state-change/caption, and a clean-console share+restore. Full suite 19/19 green (14 baseline + 5 D3).

### D2 — Teleférico Mi Teleférico (implementación)
- **Aerialway is fetched SEPARATELY from the road network**, not folded into `network`. `default-network.json` is a highway-only Overpass query; the teleférico ships as its own bundled raw-Overpass snapshot `public/data/default-aerialway.json` (so `network/build.js` stays untouched per the ownership constraint). main.js gained `attachAerialway(world, source)` (sibling of `attachBuildings`): fire-and-forget, `source={url}` for the default snapshot or `{lat,lon,radius}` for a searched zone, gated on `app.world===world` (dropped on swap) and silently skipped on empty/offline. The `// --- D2 (makeWorld:create) ---` block therefore only declares `let aerialwayMesh = null;`; the actual build happens after the world exists (init() for default, rebuildWorld:attach for searched).
- **Searched zones fetch at a WIDER radius than the road disc** (`max(r, 1500)` m): La Paz cable lines span kilometers, so the road radius (≤1200 m) clips every line. `fetchAerialwayOsm` itself clamps only to a ≥250 m floor (no upper clamp — unlike `fetchNetworkOsm`). The default snapshot was fetched at 1500 m via `scripts/fetch-default-aerialway.mjs` (npm `fetch:aerialway`, `AERIALWAY_RADIUS_M` overridable).
- **`network/aerialway.js` (`buildAerialways(osm, projection, elevation)`)** is pure data (no THREE) so it runs in Node (the fetch script validates the snapshot through it) and the browser. Cable ways → resampled polylines (≤`sampleStepM`=8 m segments) lifted to `elevAt(x,z)+cableHeightM` PER SAMPLE, so the cable follows the displaced terrain (the hills it spans), with a parallel `Float32Array elev` + prefix-sum `cumLen` for zero-alloc cabin animation. Line color resolution: **name/ref is authoritative** (Spanish color words «Roja/Amarilla/Verde/Azul/Naranja/Blanca/Celeste/Café/Plateada/Morada» → `CONFIG.aerialway.lineColors`), THEN the `colour` tag keyword (incl. `skyblue`/`lightblue`→Celeste so the real OSM `colour=skyblue` on the Celeste line doesn't collapse onto Azul via a substring `blue` match), THEN explicit hex, else `palette[index]`. Station footprints arrive as `aerialway=station` **ways** (not nodes) → rendered as a box at the polygon centroid; pylons are `aerialway=pylon` nodes → towers.
- **`render/aerialwayMesh.js` (per-world, worksMesh/streetLampsMesh pattern):** cables = `TubeGeometry` along a `PolylineCurve3` adapter (samples the already-dense raised polyline directly — NO CatmullRom smoothing, which could overshoot into a hillside), merged per color → 1 draw call/color, `MeshBasicMaterial` (unlit, reads at any hour). Towers/stations = `InstancedMesh` (cylinder posts extruded `towerHeightM`; centroid boxes). Cabins = `InstancedMesh` gondola per color, `cabinsPerLine` each, alternating travel direction; animated by arc length along the SAME raised polyline via `pointAtParam3` (rides the cable height, hills included), ping-pong at the ends, `makeBasis` orientation re-orthogonalized for graded spans. `update(dt)` advances cabins in **WALL-CLOCK** time (real dt, independent of sim speed/pause), zero allocations (module-scope scratch), no-op while hidden. `dispose()` frees every geometry+material.
- **`__SIM__` hooks (D2 block):** `aerialway` getter `{lines, cabins}` (the scaffold's `getState()` shape — left as-is), `sampleCabin()`→ first cabin's live `{x,y,z}`, plus two added helpers `setTeleferico(b)` (drive visibility) and `aerialwayWanted()` (read the persisted «Teleférico» checkbox so `attachAerialway` re-asserts it on a fresh mesh). The gui.js D2 markers already called `aerialwayMesh?.setVisible?.()` — the mesh implements it, so gui.js needed no further D2 edits. Per-frame `world.aerialwayMesh?.update?.(wallDt)` filled the `frame:update` marker.
- **Default-zone result:** 4 Mi Teleférico lines — **Amarilla, Blanca, Celeste, Morada** — at radius 1500 m (3755 / 2913 / 2745 / 2384 m), 5 stations, 77 towers, 24 cabins (6/line). Zones without aerialway data simply have no teleférico (graceful, `aerialwayMesh` stays null).
- **Tests:** `tests/v4-d2.spec.js` — 5 tests on the DEFAULT zone (no live Overpass; the snapshot is bundled): lines>0 + cabins>0, cabins displace >2 m over 3 s @4x AND ride elevated (y>10), `setTeleferico` hides/shows the named `aerialway` group, the GUI «Teleférico» checkbox hides the layer, and an 8 s clean-console render with cabins still moving. Full suite 24/24 green (14 baseline + 5 D2 + 5 D3). Screenshot `docs/screenshots/v4-teleferico.png` (colored cable + tower + cabins over the city). Helper scripts `scripts/d2-smoke.mjs` + `scripts/d2-shots.mjs`.

### D1 — Vista satélite (implementación — completada en integración)
- **D1 was NOT delivered by its feature agent** (its "report" was a generic placeholder, no code). The INTEGRATOR implemented the whole feature during integration, following this spec §D1 exactly. All other reconciliation below assumes D1 now exists.
- **`render/satellite.js` (pure tile/UV math + offscreen stitcher, no scene coupling).** `computeTileCover(planeRect, projection, opts)` takes the four corners of the TERRAIN PLANE rect (bbox + 35% margin — NOT the raw bbox, so the margin ring doesn't sample garbage), maps them through `projection.toLatLon` → Web-Mercator fractional tiles, and picks the zoom from `maxZoom`(18) DOWN while `tileCount > maxTiles`(64) (or `minZoom`(15) is hit). `geoBounds` is the whole-tile rect in fractional tile units `{z, xtMin, xtMax, ytMin, ytMax}`. `loadSatellite(network)` (searched zones) stitches Esri tiles `{z}/{y}/{x}` into an offscreen canvas (drops zoom if it would exceed `maxCanvasPx`=4096), `crossOrigin='anonymous'`, concurrency 6, 12 s tile timeout, returns `null` if >10 % of tiles fail. `loadDefaultSatellite()` loads the bundled JPG+JSON. `finalizeTexture` → `CanvasTexture`, `SRGBColorSpace`, `ClampToEdge`, mipmaps + `LinearMipmapLinear`. `buildTerrainUVs(geom, network, geoBounds)` writes per-vertex UVs by mapping each terrain `(x,z)` → `toLatLon` → per-vertex Mercator (NOT a linear bbox stretch) → `u, 1-vPixel`.
- **v-flip resolved up front:** the canvas/texture origin is top-left while THREE UV origin is bottom-left, so `buildTerrainUVs` emits `v = 1 - vPixel`. Verified by the noon screenshot — roads on the photo align with the stylized roads (no N/S mirror), so the sign is correct.
- **`terrainMesh.js` (D1 block):** added `planeRect` (the bbox+margin extent, so satellite.js covers the SAME area the UVs map to) and `setSatellite(sat|null)`. `sat` present → `buildTerrainUVs` + `mat.map=texture` + `mat.color=white` (photo true colors; the Lambert material still composites sun/shadow/fog/night for free). `null` → delete the `uv` attribute, `mat.map=null`, `mat.color=groundColor`. Kept `MeshLambertMaterial`.
- **`main.js` (D1 blocks):** `attachSatellite(world, source)` sibling of `attachBuildings`/`attachAerialway` — `source` null = bundled default snapshot, `{lat,lon,radius}` = live searched zone. Fire-and-forget, gated on `app.world===world`, stashes `world.satellite` (so `dispose()` frees the `CanvasTexture` even if never draped), drapes immediately only if the persisted «Vista satélite» toggle is ON, else stays idle until the user toggles. `null` result + toggle ON → toast «Sin imágenes satelitales para esta zona». `world.applySatelliteToBuildings()` sets the merged building material `transparent=true, opacity=0.5` while keeping **`depthWrite=true`** (a merged InstancedMesh with `depthWrite=false` self-sorts/flickers — documented tradeoff), re-applied after `attachBuildings` resolves. `__SIM__` D1 hooks are now live: `setSatellite(b)` (persists `gui.params.verSatelite`, drapes/undrapes terrain + buildings), `satellite` getter `{enabled: <param>, ready: <world.satellite loaded?>}`, `terrainHasMap` (`!!terrain.material.map`).
- **`scripts/fetch-default-satellite.mjs` (npm `fetch:satellite`):** Node stitch via `@napi-rs/canvas` (new build-time-only devDependency, NOT shipped — Render only reads the committed JPG). Recomputes the plane rect from `default-network.json` nodes through the same projection, calls `computeTileCover`, fetches Esri tiles, encodes JPG q80, writes `public/data/default-satellite.{jpg,json}`. **The default La Paz cover resolved to z=16, 5×7 = 35 tiles, 916 KB JPG** (zoom auto-dropped from 18 → 16 by the maxTiles=64 guard). JSON carries `{z,x0,x1,y0,y1,geoBounds,center,attribution}`.
- **explainer.js (D1 block):** appended a «Vista satélite» section before «Teleférico». The «activar Vista satélite y comparar» experiment bullet was already added by D3.
- **gui.js / config.js needed no further D1 edits** — the scaffold already wired the «Vista satélite» checkbox `onChange → __SIM__.setSatellite`, the `applyTo` re-assert, and the full `CONFIG.satellite` block.
- **Tests:** `tests/v4-d1.spec.js` — 5 tests on the DEFAULT zone (bundled snapshot, no live tile fetch): snapshot loads (`satellite.ready`, off by default), toggle ON drapes (`terrainHasMap` true) + OFF removes it, buildings go `transparent/opacity 0.5` on ON, the GUI «Vista satélite» checkbox drapes, and a compose test (satellite + night h=21 + lluvia 0.9 → clean console, map stays). Screenshot `docs/screenshots/v4-satelite.png` (Esri photo draped on the hills, translucent buildings, roads aligned — no v-flip).

### Integration / reconciliation (INTEGRATOR)
- **D1 implemented from scratch** (see above) — the only feature not delivered by its agent. D2 and D3 arrived complete with their owned files and filled marker blocks; no marker collisions, no duplicated imports/folders.
- **RAF order confirmed sensible** (unchanged — scaffold + agents already correct): `sim.step` (fixed timestep) → `signalsMesh.update` → `environment.update` → `vehiclesMesh.update` → `worksMesh.update` → `aerialwayMesh.update(wallDt)` → heatmap repaint gate → `streetNames.update` → panels (hud/chart/spaceTime/follow). Aerialway cabins ride wall-clock dt (independent of sim speed/pause); satellite has no per-frame cost (static drape).
- **Bundled snapshots present:** `default-satellite.jpg` (916 KB) + `default-satellite.json` (generated this session via `npm run fetch:satellite`), `default-aerialway.json` (33.9 KB, from D2). 
- **Cross-feature verified manually on :5174:** (a) a share link with `sat=1` round-trips — reload restores demand/speed/hora/clima/heatmap AND re-drapes the satellite (`terrainHasMap` true on restore); the serializer emits `sat` from the live toggle. (b) satellite + day/night (h=19/20/21) + rain compose with zero console errors (Lambert terrain still composites night/fog over the photo map). (c) tour scene 3 «Cierre de avenida» closes a twin-paired edge (`closedEdges.size` 0→2) and turns the heatmap on (recolors). «Compartir enlace» shows the «Enlace copiado» toast; «Modo tour» opens the #tour panel and advances scenes with Spanish captions.
- **Suite: 29/29 green** (14 baseline + 5 D1 + 5 D2 + 5 D3) under `$env:SIM_PORT="5174"; npx playwright test` (workers:1). `npm run build` clean (only the pre-existing >500 kB chunk-size advisory).
- **New devDependency:** `@napi-rs/canvas` (build-time tile stitching for `fetch:satellite`; not bundled into the client). `package.json` also gained the `fetch:satellite` script.
