// V4 D3 — Modo tour. A guided sequence of didactic traffic scenes driven by the
// SAME setters share.js / the GUI use (so the GUI controllers stay in sync). The
// #tour panel (index.html) shows the scene caption + ▶ / ⏭ / ⏸ controls; scenes
// auto-advance after holdMs or step manually with «Siguiente».
//
// Scenes (Spanish captions):
//   1 «Mañana tranquila» — 6:30, demanda baja, despejado, vista general.
//   2 «Hora pico»        — demanda alta.
//   3 «Cierre de avenida»— cierra la avenida principal + mapa de calor.
//   4 «Llega la lluvia»  — lluvia intensa.
//   5 «Anochece»         — 19:30.
//
// State application goes through applyState(app, gui, patch): one place that
// drives the setters AND mirrors the values into gui.applyState() — identical to
// the share restore path, so a tour scene and a shared link converge on the same
// world state.

import { CONFIG } from '../config.js';

/**
 * applyState(app, gui, patch) — shared setter helper (tour + share converge).
 * patch keys mirror gui.params: demanda, velocidad, pausado, clima,
 * intensidadLluvia, horaDelDia, mapaCalor, nombresCalles, verSatelite,
 * verTeleferico. Each drives the live setter, then gui.applyState() redraws.
 */
export function applyState(app, gui, patch) {
  const S = window.__SIM__;
  if ('demanda' in patch) S.setDemand?.(patch.demanda);
  if ('velocidad' in patch) S.setSimSpeed?.(patch.velocidad);
  if ('pausado' in patch) S.setPaused?.(patch.pausado);
  if ('clima' in patch || 'intensidadLluvia' in patch) {
    const mode = patch.clima ?? gui.params.clima;
    const wi = patch.intensidadLluvia ?? gui.params.intensidadLluvia;
    S.setWeather?.(mode, wi);
  }
  if ('horaDelDia' in patch) S.setTimeOfDay?.(patch.horaDelDia);
  if ('mapaCalor' in patch) S.setHeatmap?.(patch.mapaCalor);
  if ('nombresCalles' in patch) app.world?.streetNames?.setVisible?.(patch.nombresCalles);
  if ('verSatelite' in patch) S.setSatellite?.(patch.verSatelite); // D1 (defensive)
  if ('verTeleferico' in patch) app.world?.aerialwayMesh?.setVisible?.(patch.verTeleferico);
  gui.applyState?.(patch);
}

/** Camera: fit the whole network bbox (general overview). */
function viewGeneral(app) {
  const n = app.world && app.world.network;
  if (n && app.view?.frame) app.view.frame(n.bbox);
}

/**
 * Close the longest primary/secondary interior edge (tour scene 3). Returns the
 * closed edge id (or null). Picks a twin-paired interior edge so both directions
 * shut and the closure is visible on the heatmap.
 */
function closeMainEdge(app) {
  const w = app.world;
  if (!w || !w.sim.closeEdge) return null;
  const net = w.network;
  const MAJOR = new Set(['primary', 'secondary', 'trunk', 'tertiary']);
  let best = null;
  for (const e of net.edges.values()) {
    if (e.twinId == null || e.twinId < e.id) continue; // one per pair
    if (!MAJOR.has(e.highwayClass)) continue;
    if (!best || e.lengthM > best.lengthM) best = e;
  }
  // Fallback: longest interior twin-paired edge regardless of class.
  if (!best) {
    for (const e of net.edges.values()) {
      if (e.twinId == null || e.twinId < e.id) continue;
      if (!best || e.lengthM > best.lengthM) best = e;
    }
  }
  if (!best) return null;
  w.sim.closeEdge(best.id);
  w.roads.notifyClosuresChanged?.();
  return best.id;
}

/** Reopen everything closed by the tour (scene reset on play()/replay). */
function reopenAll(app) {
  const sim = app.world && app.world.sim;
  if (!sim || !sim.closedEdges) return;
  for (const id of [...sim.closedEdges]) sim.openEdge?.(id);
  app.world?.roads.notifyClosuresChanged?.();
}

/**
 * createTour(app, gui) — builds the scene list, wires the #tour panel, and
 * exposes the __SIM__.tour state {playing, scene, play, next, pause}.
 */
export function createTour(app, gui) {
  const hold = CONFIG.tour.autoHoldMs;

  const scenes = [
    {
      caption: 'Mañana tranquila — tráfico ligero al amanecer.',
      apply() {
        reopenAll(app);
        applyState(app, gui, {
          demanda: 800,
          horaDelDia: 6.5,
          clima: 'despejado',
          intensidadLluvia: gui.params.intensidadLluvia,
          mapaCalor: false,
        });
        viewGeneral(app);
      },
    },
    {
      caption: 'Hora pico — la demanda se dispara y aparecen las colas.',
      apply() {
        applyState(app, gui, { demanda: 5000 });
        viewGeneral(app);
      },
    },
    {
      caption: 'Cierre de avenida — una vía principal se cierra y el tráfico se redistribuye.',
      apply() {
        applyState(app, gui, { mapaCalor: true });
        if (CONFIG.tour.closeMainEdge) closeMainEdge(app);
        viewGeneral(app);
      },
    },
    {
      caption: 'Llega la lluvia — menor velocidad deseada y más distancia de seguridad.',
      apply() {
        applyState(app, gui, { clima: 'lluvia', intensidadLluvia: 0.9 });
      },
    },
    {
      caption: 'Anochece — se encienden faros y farolas sobre la ciudad.',
      apply() {
        applyState(app, gui, { horaDelDia: 19.5 });
      },
    },
  ];

  // ---- Panel wiring ----
  const panel = document.getElementById('tour');
  const elScene = document.getElementById('tour-scene');
  const elCaption = document.getElementById('tour-caption');
  const btnPlay = document.getElementById('tour-play');
  const btnNext = document.getElementById('tour-next');
  const btnPause = document.getElementById('tour-pause');

  let index = -1; // current scene index (-1 = not started)
  let playing = false;
  let timer = 0; // setTimeout handle for auto-advance

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  function scheduleAdvance() {
    clearTimer();
    if (!playing) return;
    timer = setTimeout(() => {
      timer = 0;
      if (index < scenes.length - 1) next();
      else pause(); // last scene reached — stop auto-advance, leave panel open
    }, hold);
  }

  function renderPanel() {
    if (!panel) return;
    panel.classList.add('visible');
    const sc = scenes[Math.max(index, 0)];
    if (elScene) elScene.textContent = `Escena ${Math.max(index, 0) + 1} / ${scenes.length}`;
    if (elCaption && sc) elCaption.textContent = sc.caption;
    if (btnPlay) btnPlay.textContent = playing ? '▶ Reproduciendo' : '▶ Reproducir';
  }

  /** Apply scene i and refresh the panel. */
  function goTo(i) {
    index = Math.min(Math.max(i, 0), scenes.length - 1);
    scenes[index].apply();
    renderPanel();
  }

  function play() {
    playing = true;
    if (index < 0) goTo(0);
    else renderPanel();
    scheduleAdvance();
  }

  function next() {
    clearTimer();
    if (index < scenes.length - 1) goTo(index + 1);
    else goTo(scenes.length - 1);
    if (playing) scheduleAdvance();
  }

  function pause() {
    playing = false;
    clearTimer();
    renderPanel();
  }

  function close() {
    pause();
    if (panel) panel.classList.remove('visible');
  }

  if (btnPlay) btnPlay.addEventListener('click', play);
  if (btnNext) btnNext.addEventListener('click', next);
  if (btnPause) btnPause.addEventListener('click', pause);

  return {
    // __SIM__.tour state shape (e2e hooks).
    get playing() {
      return playing;
    },
    get scene() {
      return index;
    },
    get sceneCount() {
      return scenes.length;
    },
    get caption() {
      return index >= 0 ? scenes[index].caption : null;
    },
    play,
    next,
    pause,
    close,
  };
}
