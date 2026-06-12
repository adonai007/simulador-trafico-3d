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
