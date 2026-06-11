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

  // --- Vista ---
  const fView = gui.addFolder('Vista');
  fView.add(params, 'sombras').name('Sombras').onChange((v) => {
    app.view.sun.castShadow = v;
  });
  fView
    .add(params, 'verCarriles')
    .name('Carriles (debug)')
    .onChange((v) => app.world.debug.setLanesVisible(v));
  fView
    .add(params, 'verConectores')
    .name('Conectores (debug)')
    .onChange((v) => app.world.debug.setConnectorsVisible(v));
  fView.close();

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
    },
    dispose() {
      gui.destroy();
    },
  };
}
