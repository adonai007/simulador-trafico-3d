// lil-gui control panel (spec §3.6 / Phase 5) — Spanish labels, live bindings:
//   demanda           -> sim.setDemand
//   velocidad / pausa -> sim.setSimSpeed / sim.setPaused
//   cortesía          -> CONFIG.sim.mobil.politeness (read live by MOBIL)
//   ciclo / onda verde-> retimeSignals (stateless runtime -> instant effect)
//   sombras           -> sun.castShadow (shadowMap stays enabled, spec §3.1)
//   carriles/conectores -> debug overlay visibility
// Settings persist across live map swaps via applyTo(world).

import GUI from 'lil-gui';
import { CONFIG } from '../config.js';
import { retimeSignals } from '../network/signals.js';

export function createGui(app) {
  const gui = new GUI({ title: 'Controles' });

  const params = {
    demanda: app.world.sim.demand,
    velocidad: app.world.sim.simSpeed,
    pausado: false,
    cortesia: CONFIG.sim.mobil.politeness,
    cicloS: CONFIG.signals.cycleS,
    ondaVerdeKmh: CONFIG.signals.greenWaveKmh,
    sombras: !!app.view.sun.castShadow,
    verCarriles: !!CONFIG.debug.showLanes,
    verConectores: !!CONFIG.debug.showConnectors,
    paradasMicro: CONFIG.busStops.enabled,
    paradaMediaS: CONFIG.busStops.meanDwellS,
    // --- R1 --- «Ruteo por congestión» checkbox state (default OFF). Drives
    // sim.setCongestionRouting; carried across world swaps via applyTo.
    rutaCongestion: CONFIG.routing?.congestionEnabled === true,
    // --- end R1 ---
    mapaCalor: !!CONFIG.heatmap.enabled,
    nombresCalles: CONFIG.streetNames.enabled !== false,
    // --- C1 --- (obras e incidentes)
    modoObras: false, // read by picking opts in main.js (isObrasMode)
    // --- end C1 ---
    // --- C2 --- (clima y hora)
    clima: CONFIG.weather.mode,
    intensidadLluvia: CONFIG.weather.intensity,
    horaDelDia: CONFIG.dayNight.timeOfDay,
    cicloAutomatico: !!CONFIG.dayNight.auto,
    // --- end C2 ---
    // --- D1 --- «Vista satélite» checkbox state (OFF = stylized low-poly).
    verSatelite: !!CONFIG.view.satellite,
    // --- end D1 ---
    // --- D2 --- «Teleférico» checkbox state (renders only if lines exist).
    verTeleferico: CONFIG.aerialway.enabled !== false,
    // --- end D2 ---
  };

  const retime = () =>
    retimeSignals(app.world.network, app.world.network.signals, params.cicloS);

  // --- Tráfico ---
  gui
    .add(params, 'demanda', 0, 6000, 50)
    .name('Demanda (veh/h)')
    .onChange((v) => app.world.sim.setDemand(v));
  gui
    .add(params, 'velocidad', CONFIG.sim.speedMin, CONFIG.sim.speedMax, 0.25)
    .name('Velocidad de simulación')
    .onChange((v) => app.world.sim.setSimSpeed(v));
  const pauseCtrl = gui
    .add(
      {
        pausa() {
          params.pausado = !params.pausado;
          app.world.sim.setPaused(params.pausado);
          pauseCtrl.name(params.pausado ? '▶ Reanudar' : '⏸ Pausa');
        },
      },
      'pausa'
    )
    .name('⏸ Pausa');
  gui
    .add(params, 'cortesia', 0, 1, 0.05)
    .name('Cortesía (MOBIL)')
    .onChange((v) => {
      CONFIG.sim.mobil.politeness = v;
    });
  gui
    .add(params, 'paradasMicro')
    .name('Paradas de micro')
    .onChange((v) => {
      CONFIG.busStops.enabled = v;
    });
  gui
    .add(params, 'paradaMediaS', 5, 30, 1)
    .name('Parada media (s)')
    .onChange((v) => {
      CONFIG.busStops.meanDwellS = v;
    });
  // --- R1 --- «Ruteo por congestión» (default OFF). ON: the sim periodically
  // rebuilds next-hop tables weighting edges by live congestion so traffic
  // detours around jams; OFF: free-flow routing (unchanged). Per-network sim
  // state — re-asserted on world swap in applyTo.
  gui
    .add(params, 'rutaCongestion')
    .name('Ruteo por congestión')
    .onChange((v) => window.__SIM__?.setCongestionRouting?.(v));
  // --- end R1 ---

  // --- Semáforos ---
  const fSig = gui.addFolder('Semáforos');
  fSig
    .add(params, 'cicloS', CONFIG.signals.cycleClampS.min, CONFIG.signals.cycleClampS.max, 5)
    .name('Ciclo semafórico (s)')
    .onChange(() => retime());
  fSig
    .add(params, 'ondaVerdeKmh', 20, 80, 5)
    .name('Onda verde (km/h)')
    .onChange((v) => {
      CONFIG.signals.greenWaveKmh = v;
      retime();
    });

  // --- C1 --- «Obras e incidentes» (modoObras is read live by the picking
  // opts in main.js; closures repaint via roads.notifyClosuresChanged).
  const fObras = gui.addFolder('Obras e incidentes');
  fObras.add(params, 'modoObras').name('Modo obras (clic en calle) 🚧');
  fObras
    .add(
      {
        incidente() {
          const sim = app.world?.sim;
          if (!sim?.triggerIncident) return;
          // Followed vehicle's lane when it's a REAL lane (spec C1);
          // otherwise the sim's weighted pick (busy multi-lane preferred).
          const fv = window.__SIM__?.follow?.vehicle ?? null;
          const laneId =
            fv && !fv._gone && fv.seg && !fv.seg.isConnector ? fv.seg.id : null;
          sim.triggerIncident(laneId !== null ? { laneId } : undefined);
        },
      },
      'incidente'
    )
    .name('Provocar incidente');
  fObras
    .add(
      {
        reabrir() {
          const sim = app.world?.sim;
          if (!sim) return;
          if (sim.closedEdges) {
            for (const id of [...sim.closedEdges]) sim.openEdge?.(id);
          }
          sim.clearIncidents?.();
          app.world?.roads.notifyClosuresChanged?.();
        },
      },
      'reabrir'
    )
    .name('Reabrir todo');
  fObras.close();
  // NOTE: closures/incidents are per-network runtime state (cleared on world
  // swap) — intentionally NOTHING about them in applyTo().
  // --- end C1 ---

  // --- E1 --- «Emergencias» (ambulancia). The button is a ?.-guarded no-op
  // until sim.callAmbulance + __SIM__.callAmbulance land; agent E1 fills ONLY
  // inside this block (button «Llamar ambulancia 🚑» -> __SIM__.callAmbulance(),
  // optional concurrent/yield read-outs). Per-network runtime state — like
  // obras, NOTHING about ambulances goes in applyTo().
  const fEmergencias = gui.addFolder('Emergencias');
  fEmergencias
    .add(
      {
        ambulancia() {
          // E1: spawns an ambulance that ignores red lights with caution and
          // routes toward the last incident; others cede toward the curb.
          window.__SIM__?.callAmbulance?.();
        },
      },
      'ambulancia'
    )
    .name('Llamar ambulancia 🚑');
  fEmergencias.close();
  // --- end E1 ---

  // --- C2 --- «Clima y hora» (controls are ?.-guarded no-ops until
  // app.environment lands; agent C2 fills ONLY inside this block).
  const fClima = gui.addFolder('Clima y hora');
  fClima
    .add(params, 'clima', ['despejado', 'lluvia'])
    .name('Clima')
    .onChange((v) => app.environment?.setWeather?.(v, params.intensidadLluvia));
  fClima
    .add(params, 'intensidadLluvia', 0, 1, 0.05)
    .name('Intensidad de lluvia')
    .onChange((v) => app.environment?.setWeather?.(params.clima, v));
  fClima
    .add(params, 'horaDelDia', 0, 24, 0.25)
    .name('Hora del día')
    .onChange((h) => app.environment?.setTimeOfDay?.(h));
  fClima
    .add(params, 'cicloAutomatico')
    .name('Ciclo automático')
    .onChange((v) => app.environment?.setAuto?.(v));
  fClima.close();
  // --- end C2 ---

  // --- Vista ---
  const fView = gui.addFolder('Vista');
  fView.add(params, 'sombras').name('Sombras').onChange((v) => {
    // --- C2 --- environment owns sun.castShadow once it lands (night gate);
    // until then the legacy direct toggle keeps behavior identical.
    if (app.environment?.setShadowsEnabled) app.environment.setShadowsEnabled(v);
    else app.view.sun.castShadow = v;
    // --- end C2 ---
  });
  fView
    .add(params, 'verCarriles')
    .name('Carriles (debug)')
    .onChange((v) => app.world.debug.setLanesVisible(v));
  fView
    .add(params, 'verConectores')
    .name('Conectores (debug)')
    .onChange((v) => app.world.debug.setConnectorsVisible(v));
  fView
    .add(params, 'mapaCalor')
    .name('Mapa de calor')
    .onChange((v) => app.world.roads.setHeatmap(v));
  fView
    .add(params, 'nombresCalles')
    .name('Nombres de calles')
    .onChange((v) => app.world.streetNames.setVisible(v));
  // --- D1 --- «Vista satélite» (?.-guarded no-op until D1 wires __SIM__/setter;
  // agent D1 fills ONLY inside this block — drape imagery + building transparency).
  fView
    .add(params, 'verSatelite')
    .name('Vista satélite')
    .onChange((v) => window.__SIM__?.setSatellite?.(v));
  // --- end D1 ---
  // --- D2 --- «Teleférico» (?.-guarded no-op until D2 wires group visibility;
  // agent D2 fills ONLY inside this block — toggle aerialwayMesh.group.visible).
  fView
    .add(params, 'verTeleferico')
    .name('Teleférico')
    .onChange((v) => app.world?.aerialwayMesh?.setVisible?.(v));
  // --- end D2 ---
  fView.close();

  // --- D3 --- «Escenario» (Compartir enlace + Modo tour). Buttons are
  // ?.-guarded no-ops until D3 wires app.share / app.tour; agent D3 fills ONLY
  // inside this block (placeholder folder so the layout slot exists now).
  const fEscenario = gui.addFolder('Escenario');
  fEscenario
    .add(
      {
        compartir() {
          // D3: window.__SIM__.share.copy() -> copies enlace + toast.
          window.__SIM__?.share?.copy?.();
        },
      },
      'compartir'
    )
    .name('Compartir enlace 🔗');
  fEscenario
    .add(
      {
        tour() {
          // D3: app.tour.play() -> opens #tour panel + starts the guided tour.
          app.tour?.play?.();
        },
      },
      'tour'
    )
    .name('Modo tour ▶');
  fEscenario.close();
  // --- end D3 ---

  return {
    gui,
    params,
    /** Re-apply the user's settings to a freshly built world (map swap). */
    applyTo(world) {
      world.sim.setDemand(params.demanda);
      world.sim.setSimSpeed(params.velocidad);
      world.sim.setPaused(params.pausado);
      retimeSignals(world.network, world.network.signals, params.cicloS);
      world.debug.setLanesVisible(params.verCarriles);
      world.debug.setConnectorsVisible(params.verConectores);
      world.roads.setHeatmap(params.mapaCalor);
      world.streetNames.setVisible(params.nombresCalles);
      // --- R1 --- re-assert congestion routing on the fresh world's sim (the
      // flag is per-sim runtime state; default OFF means this is a no-op unless
      // the user enabled it). Only call when ON to avoid an unnecessary swap.
      if (params.rutaCongestion) world.sim.setCongestionRouting?.(true);
      // --- end R1 ---
      // --- C2 --- re-apply weather/hour/wetness/lamps to the fresh world.
      app.environment?.applyTo?.(world);
      // --- end C2 ---
      // --- D1 --- carry the «Vista satélite» toggle across world swaps. The
      // imagery itself loads fire-and-forget in makeWorld/rebuildWorld and gates
      // application on this param; this line re-asserts the intent on swap.
      // Agent D1 fills (e.g. window.__SIM__?.setSatellite?.(params.verSatelite),
      // or a direct world.terrain.setSatellite gated on world.satellite ready).
      if (params.verSatelite) window.__SIM__?.setSatellite?.(true);
      // --- end D1 ---
      // --- D2 --- carry the «Teleférico» visibility across world swaps.
      world.aerialwayMesh?.setVisible?.(params.verTeleferico);
      // --- end D2 ---
    },
    // --- D3 --- mirror restored/tour state into params + redraw the controllers.
    // share.applyFromUrl and tour.applyState call this AFTER driving the live
    // setters, so this only updates `params` + the lil-gui display (NOT the
    // setters again — avoids double-apply). Keys match `params` field names;
    // controllers are looked up by their bound property via controllersRecursive.
    applyState(patch) {
      if (!patch) return;
      for (const key in patch) {
        if (key in params) params[key] = patch[key];
      }
      for (const ctrl of gui.controllersRecursive()) {
        if (ctrl.property in patch) ctrl.updateDisplay();
      }
    },
    // --- end D3 ---
    dispose() {
      gui.destroy();
    },
  };
}
