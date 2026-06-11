// HUD readouts (spec §5 global metrics, 0.5 s sim cadence): vehículos activos,
// velocidad media, flujo, densidad, tiempo de simulación, ms/paso.
// DOM writes only when the detector layer publishes a new global sample
// (metrics.global.time changes), so per-frame cost is one comparison.

export function createHud(app) {
  const el = {
    vehicles: document.getElementById('hud-vehicles'),
    speed: document.getElementById('hud-speed'),
    flow: document.getElementById('hud-flow'),
    density: document.getElementById('hud-density'),
    time: document.getElementById('hud-time'),
    step: document.getElementById('hud-step'),
  };

  let lastSampleT = -1;
  let stepEma = 0; // smoothed ms/paso (raw value jumps around)

  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')} min`;
  }

  return {
    update() {
      const world = app.world;
      if (!world) return;
      const g = world.sim.metrics.global;
      if (g.time === lastSampleT) return;
      lastSampleT = g.time;
      stepEma = stepEma === 0 ? world.sim.lastStepMs : stepEma * 0.8 + world.sim.lastStepMs * 0.2;
      el.vehicles.textContent = String(g.vehicles);
      el.speed.textContent = `${g.meanSpeedKmh.toFixed(1)} km/h`;
      el.flow.textContent = `${g.flowVehHLane.toFixed(0)} veh/h/carril`;
      el.density.textContent = `${g.densityVehKm.toFixed(1)} veh/km`;
      el.time.textContent = fmtTime(g.time);
      el.step.textContent = `${stepEma.toFixed(1)} ms`;
    },
    reset() {
      lastSampleT = -1;
      stepEma = 0;
    },
  };
}
