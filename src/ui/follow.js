// Follow mode (spec §3.6): click a vehicle -> chase camera + live IDM readout
// panel (velocidad, aceleración, hueco al líder, Δv, estado). Esc or an
// empty-space click exits and re-enables the free MapControls camera.
// Camera and panel both read the INTERPOLATED pose (§2.1) so the chase is as
// smooth as the vehicles. No per-frame allocations (module-level temps).

import * as THREE from 'three';
import { sampleVehiclePose } from '../render/vehiclesMesh.js';
import { signalState } from '../sim/signalsRuntime.js';

const CAM_BACK_M = 26; // chase offset behind the vehicle
const CAM_UP_M = 13;
const CAM_SMOOTH = 4.5; // 1/s — exponential smoothing rate
const PANEL_HZ = 8; // readout refresh rate (wall clock)

const _p = { x: 0, z: 0 };
const _h = { x: 0, z: 0 };
const _desired = new THREE.Vector3();
const _target = new THREE.Vector3();
const _gap = { has: false, gap: 0, dv: 0 };

/** Leader gap, walking the vehicle's route across connectors (read-only). */
function leaderInfo(veh, network, out) {
  out.has = false;
  const arr = veh.seg.vehicles;
  const i = arr.indexOf(veh);
  if (i > 0) {
    const l = arr[i - 1];
    out.gap = l.s - l.len / 2 - veh.s - veh.len / 2;
    out.dv = veh.v - l.v;
    out.has = true;
    return;
  }
  let dist = veh.seg.length - veh.s;
  let seg = veh.seg.isConnector ? veh.seg : veh.nextConn;
  let hops = 0;
  while (seg && hops < 3 && dist < 120) {
    if (seg !== veh.seg) {
      const a = seg.vehicles;
      if (a.length) {
        const l = a[a.length - 1]; // rearmost
        out.gap = dist + l.s - l.len / 2 - veh.len / 2;
        out.dv = veh.v - l.v;
        out.has = true;
        return;
      }
      dist += seg.length;
    }
    seg = seg.isConnector ? network.lanes.get(seg.toLaneId) : null;
    hops++;
  }
}

/** Driving state in Spanish (estado: libre / siguiendo / frenando / cediendo). */
function vehicleState(veh, network, simTime, gap) {
  if (veh._blocked) return 'cediendo paso';
  if (!veh.seg.isConnector && veh.nextConn && veh.nextConn.signalGroup) {
    const sig = network.signals.get(veh.nextConn.junctionId);
    if (sig) {
      const st = signalState(sig, veh.nextConn.signalGroup, simTime);
      if (st !== 'green' && veh._a < -0.15) return 'frenando por semáforo';
    }
  }
  if (gap.has && gap.gap < Math.max(veh.v * 2.5, 15)) return 'siguiendo';
  return 'libre';
}

const TYPE_ES = {
  car: 'auto',
  truck: 'camión',
  sport: 'deportivo',
  sedan: 'sedán',
  hatchback: 'hatchback',
  suv: 'SUV',
  taxi: 'taxi',
  micro: 'micro',
  camion: 'camión',
};

export function createFollow(app) {
  // ---- Panel DOM ----
  const panel = document.createElement('div');
  panel.id = 'follow';
  panel.className = 'panel';
  panel.style.display = 'none';
  panel.innerHTML =
    '<h2 id="follow-title">Siguiendo vehículo</h2>' +
    '<div class="stat"><span class="label">Velocidad</span><span class="value" id="f-vel">—</span></div>' +
    '<div class="stat"><span class="label">Aceleración</span><span class="value" id="f-acc">—</span></div>' +
    '<div class="stat"><span class="label">Hueco al líder</span><span class="value" id="f-gap">—</span></div>' +
    '<div class="stat"><span class="label">Δv con líder</span><span class="value" id="f-dv">—</span></div>' +
    '<div class="stat"><span class="label">Estado</span><span class="value" id="f-state">—</span></div>' +
    '<div id="follow-hint">Esc o clic en el vacío para salir</div>';
  document.body.appendChild(panel);
  const el = {
    title: panel.querySelector('#follow-title'),
    vel: panel.querySelector('#f-vel'),
    acc: panel.querySelector('#f-acc'),
    gap: panel.querySelector('#f-gap'),
    dv: panel.querySelector('#f-dv'),
    state: panel.querySelector('#f-state'),
  };

  let veh = null;
  let panelNext = 0;

  function follow(v) {
    veh = v;
    app.view.controls.enabled = false;
    panel.style.display = 'block';
    el.title.textContent = `Siguiendo: ${TYPE_ES[v.type] || v.type} #${v.id}`;
    panelNext = 0;
  }

  function stop() {
    if (!veh) return;
    veh = null;
    panel.style.display = 'none';
    const controls = app.view.controls;
    controls.enabled = true;
    // Free camera resumes orbiting around the last chase target.
    controls.target.copy(_target);
    controls.update();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') stop();
  }
  window.addEventListener('keydown', onKey);

  return {
    follow,
    stop,
    get active() {
      return veh !== null;
    },
    get vehicle() {
      return veh;
    },
    /** Per-frame: chase camera + (throttled) panel readout. */
    update(alpha, wallDt) {
      if (!veh) return;
      const world = app.world;
      if (!world || veh._gone) {
        stop();
        return;
      }
      sampleVehiclePose(veh, alpha, _p, _h);
      const cam = app.view.camera;
      _desired.set(_p.x - _h.x * CAM_BACK_M, CAM_UP_M, _p.z - _h.z * CAM_BACK_M);
      const k = 1 - Math.exp(-CAM_SMOOTH * Math.min(wallDt, 0.1));
      cam.position.lerp(_desired, k);
      _target.set(_p.x + _h.x * 8, 1.2, _p.z + _h.z * 8);
      cam.lookAt(_target);

      const now = performance.now();
      if (now < panelNext) return;
      panelNext = now + 1000 / PANEL_HZ;
      leaderInfo(veh, world.network, _gap);
      el.vel.textContent = `${(veh.v * 3.6).toFixed(0)} km/h`;
      el.acc.textContent = `${veh._a.toFixed(1)} m/s²`;
      el.gap.textContent = _gap.has ? `${Math.max(_gap.gap, 0).toFixed(1)} m` : '— (libre)';
      el.dv.textContent = _gap.has ? `${(_gap.dv * 3.6).toFixed(0)} km/h` : '—';
      el.state.textContent = vehicleState(veh, world.network, world.sim.time, _gap);
    },
    dispose() {
      stop();
      window.removeEventListener('keydown', onKey);
      panel.remove();
    },
  };
}
