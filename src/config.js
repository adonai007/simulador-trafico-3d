// Central configuration — ALL tunables live here (spec: src/config.js).
// UI text is Spanish; identifiers and comments are English.

export const CONFIG = {
  // ---- Default zone (must match bundled snapshot public/data/default-network.json) ----
  defaultCenter: { lat: -16.5044506, lon: -68.1302608 }, // La Paz centro — Plaza del Estudiante
  defaultRadiusM: 600,
  radiusClampM: { min: 250, max: 1200 },

  // ---- Overpass / geocoding (Phase 6 runtime fetch) ----
  overpass: {
    mirrors: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
    timeoutMs: 25_000,
    maxWays: 1500,
    maxNodes: 20_000,
    retryRadiusFactor: 0.6,
  },
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',

  // ---- Geocoding radius floors (V2.1 A) ----
  // z15 place URLs produced 410 m discs that clip one-way avenue loops and
  // fragment the graph; the place pin deserves a wider net than a bare viewport.
  geocode: {
    placeRadiusFloorM: 800, // Google Maps /place/ URLs (!3d!4d pin present)
    atRadiusFloorM: 500,    // plain @lat,lon,zz URLs (no place pin)
  },

  // ---- Highway whitelist (Overpass regex + parse filter) ----
  highwayWhitelist: [
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'unclassified', 'residential', 'living_street',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  ],

  // ---- Per-class defaults when OSM tags are absent: lanes per direction, speed km/h ----
  classDefaults: {
    motorway:       { lanesPerDir: 3, speedKmh: 100 },
    trunk:          { lanesPerDir: 2, speedKmh: 80 },
    primary:        { lanesPerDir: 2, speedKmh: 60 },
    secondary:      { lanesPerDir: 2, speedKmh: 50 },
    tertiary:       { lanesPerDir: 1, speedKmh: 50 },
    unclassified:   { lanesPerDir: 1, speedKmh: 30 },
    residential:    { lanesPerDir: 1, speedKmh: 30 },
    living_street:  { lanesPerDir: 1, speedKmh: 20 },
    motorway_link:  { lanesPerDir: 1, speedKmh: 40 },
    trunk_link:     { lanesPerDir: 1, speedKmh: 40 },
    primary_link:   { lanesPerDir: 1, speedKmh: 40 },
    secondary_link: { lanesPerDir: 1, speedKmh: 40 },
    tertiary_link:  { lanesPerDir: 1, speedKmh: 40 },
  },

  // ---- Lane geometry ----
  laneWidthM: 3.0,
  lanesPerDirClamp: { min: 1, max: 4 },
  laneResampleStepM: 3.0,     // resample lane polylines to segments <= this
  miterClampFactor: 2.5,      // miter length clamp = factor * |offset|
  nodeRadiusPadM: 2.0,        // R_node = max(lanesBothDirs*laneWidth/2) + pad
  minEdgeAfterTrimM: 4.0,     // clamp trims proportionally below this
  minEdgeLengthM: 8.0,        // micro-edge merge threshold (junction-junction)
  microEdgeMergePasses: 3,

  // ---- Graph / SCC ----
  classWeights: { motorway: 4, trunk: 3, primary: 3, secondary: 2 }, // default 1
  minCoreEdges: 10,           // below this -> "Zona sin red viaria suficiente"
  minKeptWays: 5,

  // ---- Graph pruning + search-path validation (V2.1 A) ----
  network: {
    // 'wcc' keeps the largest weakly connected component (dead-end tips become
    // entries/exits; unreachable pockets self-resolve via re-route/despawn).
    // 'scc' = legacy Tarjan keep-largest-SCC, kept for didactic comparison
    // and rollback — it discarded 70.8% of road length in clipped
    // one-way-heavy zones (Macrodistrito Centro diagnostic).
    pruneMode: 'wcc',
    minKeptLengthKm: 2.5,     // searched zone must keep >= this directed length
    minRetention: 0.5,        // kept / fetched directed length, else retry/toast
  },

  // ---- Connectors (turn curves) ----
  connectors: {
    allowUTurns: false,
    bezierKFactor: 0.35,      // k = clamp(0.35*|P3-P0|, kMin, kMax)
    bezierKMin: 2,
    bezierKMax: 10,
    sampleStepM: 1.0,
    conflictDistM: 2.5,       // min sample distance to register a conflict pair
    aLatMs2: 2.0,             // lateral accel for curvature speed cap: v = sqrt(aLat*R)
    throughAngleDeg: 30,      // |alpha| < 30 -> through; 30..150 right; -150..-30 left; else U-turn
    uturnAngleDeg: 150,
  },

  // ---- Signals ----
  signals: {
    snapDistM: 25,            // traffic_signals node -> junction snap radius
    heuristicMinLegs: 4,      // signalize if >= 4 legs and...
    heuristicClasses: ['primary', 'secondary', 'tertiary'],
    heuristicAxisDiffDeg: 45, // ...>= 2 non-collinear major edges
    cycleS: 60,
    cycleClampS: { min: 30, max: 120 },
    yellowS: 3,
    allRedS: 2,
    minGreenS: 7,
    greenWaveKmh: 50,         // GUI "velocidad de onda verde"
  },

  // ---- IDM defaults (Phase 3) ----
  idm: {
    T: 1.5,        // desired time headway s
    a: 1.5,        // max accel m/s^2
    b: 2.0,        // comfortable decel m/s^2
    s0: 2.0,       // jam distance m
    delta: 4,
    jitter: 0.10,  // +-10% per-vehicle parameter jitter
  },

  // ---- Vehicle mix (fleet deviation: realistic La Paz proportions) ----
  // Key order here defines typeIndex + InstancedMesh order (vehicle.js /
  // vehiclesMesh.js are data-driven from it).
  vehicleMix: {
    sedan: 0.30, hatchback: 0.25, suv: 0.15, taxi: 0.10, micro: 0.12, camion: 0.08,
  },
  // gradeFactor scales gravity's pull on slopes (F1): heavy/underpowered
  // vehicles feel hills more (camión crawls uphill), nimble cars barely notice.
  vehicleTypes: {
    sedan:     { lengthM: 4.5,  widthM: 1.8, v0Factor: 1.0,  accelFactor: 1.0,  gradeFactor: 0.6 },
    hatchback: { lengthM: 3.9,  widthM: 1.75, v0Factor: 1.15, accelFactor: 1.3,  gradeFactor: 0.55 }, // nimble class
    suv:       { lengthM: 4.7,  widthM: 1.95, v0Factor: 1.05, accelFactor: 0.95, gradeFactor: 0.7 },
    taxi:      { lengthM: 4.5,  widthM: 1.8, v0Factor: 1.1,  accelFactor: 1.15, gradeFactor: 0.6 },
    micro:     { lengthM: 7.0,  widthM: 2.3, v0Factor: 0.85, accelFactor: 0.65, gradeFactor: 0.9 }, // micro paceño
    camion:    { lengthM: 10.0, widthM: 2.5, v0Factor: 0.8,  accelFactor: 0.55, gradeFactor: 1.0 },
  },

  // ---- Real elevation / grades (F1) ----
  elevation: {
    apiUrl: 'https://api.open-meteo.com/v1/elevation',
    batchSize: 100,
    concurrency: 4,
    fetchTimeoutMs: 10000,
    gridStepM: 50,
    gridMaxPoints: 48,        // clamp grid to 48x48
    smoothWindowM: 30,        // moving-average window along edge profiles
    maxGrade: 0.15,           // |de/ds| clamp on edge/lane profiles
    junctionPlateauM: 12,     // ease profile ends to node.elev over this length
    terrainSegments: 96,      // terrain plane subdivisions per axis
    terrainDropM: 0.5,        // road-splat: terrain pulled to roadElev - drop
    gradeAccelClamp: { min: -3.0, max: 1.2 }, // m/s² added to IDM accel
    gradeLowGearMs: 6.0,      // uphill pull ramps in over [0, this] m/s ("low gear")
  },

  // ---- Bus stops (F2) ----
  busStops: {
    enabled: true,        // GUI "Paradas de micro"
    maxSnapDistM: 25,     // OSM bus_stop node -> curbside lane snap radius
    meanDwellS: 12,       // exponential dwell mean (GUI "Parada media (s)")
    minDwellS: 8,         // dwell sample clamp
    maxDwellS: 25,
    stopProb: 0.85,       // chance a micro serves the next stop on its lane
  },

  // ---- Simulation core (Phase 3/4) ----
  sim: {
    dt: 1 / 30,
    maxStepsPerFrame: 8,
    speedMin: 0.25,
    speedMax: 4,
    lookaheadMinM: 80,
    lookaheadMaxM: 150,
    conflictTGapS: 4,
    conflictEvalDistM: 15,
    deadlockSpeedMs: 0.3,
    deadlockTimeS: 8,
    yellowStopFactor: 0.5,    // stop if dist > v^2/(2*bComfort) + v*0.5
    mobil: {
      politeness: 0.3,        // GUI "cortesía"
      threshold: 0.1,
      safeDecel: -4.0,
      mandatorySafeDecel: -6.0,
      mandatoryRelaxDistM: 60,
      minDistToLaneEndM: 25,
      cooldownS: 4,
      lateralEaseS: 1.5,
    },
    spawn: {
      defaultDemandVehPerHour: 2400,
      tripMeanKm: 1.5,        // onNetwork fallback despawn
      exitDistExponent: 0.5,  // exit pick weight ~ exitWeight * dist^0.5
    },
  },

  // ---- Detectors / HUD (Phase 5) ----
  detectors: {
    count: 10,
    minEdgeLengthM: 80,
    windowS: 60,
    slideS: 5,
    hudIntervalS: 0.5,
    chartMaxPoints: 300,
  },

  // ---- Diagrama espacio-tiempo (F4) ----
  spaceTime: {
    windowS: 300,    // sliding x-axis window (sim seconds)
    capacity: 36000, // trajectory ring buffer (~300 s x ~120 veh at 1 Hz)
    sampleS: 1.0,    // sim-s between trajectory samples
  },

  // ---- Congestion heatmap (F3) ----
  heatmap: {
    enabled: false,     // initial "Mapa de calor" checkbox state
    tauS: 5,            // EWMA time constant for edge speed ratios (sim s)
    updateHz: 1,        // wall-clock repaint rate while enabled
    greenRatio: 0.8,    // speed ratio >= this -> green (free flow)
    yellowRatio: 0.45,  // mid-ramp anchor (yellow)
    redRatio: 0.2,      // speed ratio <= this -> red (jammed)
  },

  // ---- Nombres de calles (V2.1 B) ----
  streetNames: {
    enabled: true,        // initial "Nombres de calles" checkbox state
    maxLabels: 60,        // class-prioritized sprite cap per world
    liftM: 6,             // label height above the lane surface (follows terrain)
    fadeNearM: 400,       // full opacity below this camera distance
    fadeFarM: 1200,       // opacity reaches 0 at this distance
    residentialMaxM: 300, // minor-class labels (residential & co.) only below this
    labelHeightM: 12,     // sprite world height; width follows the text aspect
    updateHz: 5,          // wall-clock fade/LOD update rate inside update(camera)
  },

  // ---- Obras: cierres de calle (V3 C1) ----
  closures: {
    recomputeBudgetMs: 50,   // applyClosures(): sync rebuild budget, else chunked
    chunkExitsPerStep: 8,    // double-buffered chunking: exit tables per step
    stripePeriodRows: 2,     // hazard stripes alternate every ~2 ribbon vertex rows
    conesPerEnd: 3,          // cones across the road width at each closure end
    coneEveryM: 1.1,         // cone spacing along the closure barrier
  },

  // ---- Incidentes: vehículo fantasma detenido (V3 C1) ----
  incidents: {
    durationS: 90,           // default incident lifetime (sim s)
    phantomLenM: 4.6,        // phantom vehicle length (blocks one lane)
    preferMultiLane: true,   // weighted lane pick prefers laneCount >= 2
    hazardBlinkHz: 1.5,      // hazard-light blink frequency (sim-time driven)
  },

  // ---- Clima (V3 C2) — D5: idm.js reads CONFIG.weather.current every call ----
  weather: {
    mode: 'despejado',       // 'despejado' | 'lluvia' (GUI «Clima»)
    intensity: 0.7,          // GUI «Intensidad de lluvia» 0..1
    current: { v0Mul: 1, TAdd: 0, bMul: 1 }, // identity = zero behavioral change
    rain: {
      v0Mul: 0.8, TAdd: 0.4, bMul: 0.85,     // physics at intensity 1 (lerped)
      dropCount: 10000, areaM: 280, heightM: 120, fallMs: 60, // GPU-recycled Points
      fogNear: 350, fogFar: 1400, skyColor: 0x2a313c,
      asphaltDarken: 0.55,   // roads.setWetness: base color x lerp(1, this, k)
      sunMul: 0.45, hemiMul: 0.75,
    },
  },

  // ---- Ciclo día/noche (V3 C2) — D4: pure apply(hour) from gradient stops ----
  dayNight: {
    timeOfDay: 12,           // noon default = exact current scene look (identity)
    auto: false,             // GUI «Ciclo automático»
    gameDayMin: 6,           // full 24 h cycle in this many sim minutes
    // Gradient stops lerped by hour. The h=12 stop mirrors scene.js EXACTLY
    // (sky/fog 0x101720, hemi 2.1, sun 2.6 @ 0xfff2dd) so apply(12) is
    // idempotent with the legacy scene. Night = dark blue, dawn/dusk = warm
    // orange, noon = brightest. {h, sky, fog, hemi, sunI, sunColor}.
    stops: [
      { h: 0,  sky: 0x05080f, fog: 0x05080f, hemi: 0.30, sunI: 0.0,  sunColor: 0x8fa3c7 },
      { h: 5,  sky: 0x0a1020, fog: 0x0a1020, hemi: 0.45, sunI: 0.1,  sunColor: 0xc7b9a0 },
      { h: 7,  sky: 0x6b3c22, fog: 0x86552f, hemi: 1.00, sunI: 1.2,  sunColor: 0xffa55e },
      { h: 9,  sky: 0x14202c, fog: 0x14202c, hemi: 1.80, sunI: 2.2,  sunColor: 0xffe9c4 },
      { h: 12, sky: 0x101720, fog: 0x101720, hemi: 2.10, sunI: 2.6,  sunColor: 0xfff2dd },
      { h: 17, sky: 0x1c1d22, fog: 0x2a2520, hemi: 1.70, sunI: 2.0,  sunColor: 0xffd9a8 },
      { h: 19, sky: 0x59301f, fog: 0x6e4226, hemi: 0.90, sunI: 0.9,  sunColor: 0xff8c4a },
      { h: 21, sky: 0x0a0f1f, fog: 0x0a0f1f, hemi: 0.40, sunI: 0.0,  sunColor: 0x8fa3c7 },
      { h: 24, sky: 0x05080f, fog: 0x05080f, hemi: 0.30, sunI: 0.0,  sunColor: 0x8fa3c7 },
    ],
    headlights: { onBelowSunI: 0.35, poolLenM: 7, poolWidthM: 2.4, dotSize: 0.3 },
    lamps: { classes: ['primary', 'secondary'], spacingM: 45, maxCount: 240, heightM: 6, glowColor: 0xffc97a },
    windows: { emissive: 0xffd089, maxIntensity: 0.15 },
  },

  // ============================================================
  // V4 — Vista satélite (D1) + Teleférico (D2) + Compartir/Tour (D3)
  // Stub keys with IDENTITY / off-safe defaults. Feature agents fill the
  // remaining tunables inside their own Dx block; the scaffold guarantees
  // every read resolves to a no-op (satellite OFF, share/tour identity).
  // ============================================================

  // ---- D1: Vista satélite ----------------------------------------------
  // view = the satellite/low-poly toggle state. satellite:false => no imagery
  // is ever fetched or draped (zero behavioral change until D1 lands).
  view: {
    satellite: false, // initial «Vista satélite» checkbox state (OFF = stylized)
  },
  // --- D1 --- satellite tunables (Esri World Imagery). Agent D1 may extend.
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    minZoom: 15,
    maxTiles: 64,
    maxCanvasPx: 4096,
    concurrency: 6,
    tileTimeoutMs: 12_000,
    buildingOpacity: 0.5, // buildings go semi-transparent while satellite ON
    attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics',
  },
  // --- end D1 ---

  // ---- D2: Teleférico Mi Teleférico ------------------------------------
  // enabled:true is off-safe — the aerialway only renders if OSM data yields
  // lines (default/searched). No data => no teleférico (graceful like buildings).
  // --- D2 --- aerialway tunables. Agent D2 may extend.
  aerialway: {
    enabled: true, // «Teleférico» checkbox state (renders only if lines exist)
    cableHeightM: 30,
    towerHeightM: 25,
    cableRadiusM: 0.15,
    sampleStepM: 8,
    cabinsPerLine: 6,
    cabinSpeedMs: 8,
    cabinSize: { l: 3.2, w: 2.0, h: 2.6 },
    lineColors: {
      Roja: 0xd0021b,
      Amarilla: 0xf5a623,
      Verde: 0x2e7d32,
      Azul: 0x1565c0,
      Naranja: 0xef6c00,
      Blanca: 0xeceff1,
      Celeste: 0x4fc3f7,
      Café: 0x6d4c41,
      Plateada: 0x9e9e9e,
      Morada: 0x6a1b9a,
    },
    palette: [0xd0021b, 0xf5a623, 0x2e7d32, 0x1565c0, 0xef6c00],
  },
  // --- end D2 ---

  // ---- D3: Compartir por URL + modo tour -------------------------------
  // --- D3 --- share/tour tunables. Agent D3 may extend.
  share: {
    paramVersion: 1, // URL scenario schema version (share.js serializer)
  },
  tour: {
    autoHoldMs: 9000, // auto-advance dwell per scene
    closeMainEdge: true, // tour scene 3 closes the longest main edge
  },
  // --- end D3 ---

  // ---- Rendering ----
  render: {
    roadY: 0.02,
    markingY: 0.05,
    dashLengthM: 2.0,
    dashGapM: 4.0,
    centerStripWidthM: 0.15,
    stopLineDepthM: 0.5,
    groundColor: 0x4a6b38,
    roadColor: 0x4d5158,
    markingColor: 0xffffff,
    buildingPalette: [0xc9b8a8, 0xb8c4cf, 0xd6c7b2, 0xa8b8a0, 0xcfb8b8, 0xb0a8c4],
    vehicleCapacityPerType: 400, // 6 types -> 2400 max instances total
    shadowMapSize: 2048,
    signalPoleHeightM: 5.0,
    signalLampRadiusM: 0.45,
    signalPoleOffsetM: 1.5,   // right of rightmost lane
  },

  // ---- Debug overlays (src/render/debug.js) ----
  debug: {
    showLanes: false,
    showConnectors: false,
    showHeadings: false,
  },

  // ---- Determinism ----
  rngSeed: 1234567,
};

export default CONFIG;
