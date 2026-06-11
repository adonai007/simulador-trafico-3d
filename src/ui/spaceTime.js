// Space-time trajectory diagram (spec F4) — clone of the chart.js panel
// pattern. 2D canvas scatter over the network's main corridor: x = sim time
// (sliding window), y = distance along the corridor; one 2x2 px dot per
// vehicle per sample tick, colored by v/speedMs. Shockwaves show up as red
// diagonal bands drifting upstream. Collapsible panel; Spanish labels.
// Samples on its own sim-time cadence (sampleS), redraws only on sample ticks
// while expanded — never per frame. Ring buffers preallocated, zero per-frame
// allocations in update().

import { CONFIG } from '../config.js';
import { findCorridor } from '../network/corridor.js';

const CSS_W = 320;
const CSS_H = 230;
const M_LEFT = 42;
const M_RIGHT = 10;
const M_TOP = 20;
const M_BOTTOM = 30;

// 8 precomputed speed-ratio color buckets: red <0.3, yellow mid, green >=0.75.
const COLORS = [];
{
  const R = [217, 47, 47];
  const Y = [255, 194, 26];
  const G = [41, 211, 93];
  const mix = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  for (let i = 0; i < 8; i++) {
    const ratio = (i + 0.5) / 8;
    let c;
    if (ratio <= 0.3) c = R;
    else if (ratio >= 0.75) c = G;
    else {
      const t = (ratio - 0.3) / 0.45;
      c = t < 0.5 ? mix(R, Y, t * 2) : mix(Y, G, (t - 0.5) * 2);
    }
    COLORS.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
}

// Panel CSS injected here (self-creating DOM — keeps index.html untouched).
const PANEL_CSS = `
#spacetime { bottom: 16px; right: 372px; padding: 10px 12px; }
#spacetime-header { display: flex; justify-content: space-between; gap: 16px; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--accent); user-select: none; }
#spacetime-body { margin-top: 6px; }
#spacetime canvas { display: block; }
#spacetime-hint { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; max-width: 320px; }
`;

export function createSpaceTime(app) {
  // Tolerate the CONFIG.spaceTime block being absent until integration.
  const stCfg = CONFIG.spaceTime;
  const windowS = stCfg?.windowS ?? 300; // sliding x window (sim s)
  const sampleS = stCfg?.sampleS ?? 1.0; // sim-s between samples
  const capacity = stCfg?.capacity ?? 36000; // ~300 s x ~120 veh at 1 Hz

  // Ring buffers (overwrite-oldest).
  const ts = new Float32Array(capacity);
  const ss = new Float32Array(capacity);
  const vs = new Float32Array(capacity);
  let head = 0; // next write slot
  let count = 0;
  let totalSamples = 0; // cumulative (monotonic) — test hook
  let nextSampleT = 0;
  let lastTime = 0;
  let lastSim = null;
  let corridor = null;

  // ---- DOM ----
  const style = document.createElement('style');
  style.id = 'spacetime-style';
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'spacetime';
  panel.className = 'panel';
  const header = document.createElement('div');
  header.id = 'spacetime-header';
  header.innerHTML =
    '<span id="spacetime-title">Diagrama espacio-tiempo</span>' +
    '<span id="spacetime-toggle">▾</span>';
  const titleEl = header.querySelector('#spacetime-title');
  const body = document.createElement('div');
  body.id = 'spacetime-body';
  const canvas = document.createElement('canvas');
  canvas.style.width = `${CSS_W}px`;
  canvas.style.height = `${CSS_H}px`;
  const hint = document.createElement('div');
  hint.id = 'spacetime-hint';
  hint.textContent =
    'x = tiempo, y = distancia; bandas rojas diagonales = ondas de choque';
  body.appendChild(canvas);
  body.appendChild(hint);
  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);

  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    header.querySelector('#spacetime-toggle').textContent = collapsed ? '▸' : '▾';
    if (!collapsed) draw();
  });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = CSS_W * dpr;
  canvas.height = CSS_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  function setCorridor(c) {
    corridor = c;
    titleEl.textContent = c
      ? `Diagrama espacio-tiempo — ${c.name}`
      : 'Diagrama espacio-tiempo';
  }

  function draw() {
    ctx.clearRect(0, 0, CSS_W, CSS_H);
    const plotW = CSS_W - M_LEFT - M_RIGHT;
    const plotH = CSS_H - M_TOP - M_BOTTOM;
    const lengthM = corridor ? corridor.lengthM : 1;
    const speedMs = corridor ? corridor.speedMs : 1;
    // Window starts sliding once sim time passes windowS (no negative labels).
    const tMin = Math.max(0, lastTime - windowS);
    const tMax = tMin + windowS;

    // Frame + grid + ticks (chart.js styling).
    ctx.strokeStyle = 'rgba(139,148,158,0.35)';
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M_LEFT, M_TOP);
    ctx.lineTo(M_LEFT, M_TOP + plotH);
    ctx.lineTo(M_LEFT + plotW, M_TOP + plotH);
    ctx.stroke();
    const TICKS = 4;
    ctx.textAlign = 'center';
    for (let i = 0; i <= TICKS; i++) {
      const tv = tMin + (windowS * i) / TICKS;
      const x = M_LEFT + (plotW * i) / TICKS;
      ctx.fillStyle = '#8b949e';
      ctx.fillText(String(Math.round(tv)), x, M_TOP + plotH + 12);
      if (i > 0) {
        ctx.strokeStyle = 'rgba(139,148,158,0.12)';
        ctx.beginPath();
        ctx.moveTo(x, M_TOP);
        ctx.lineTo(x, M_TOP + plotH);
        ctx.stroke();
      }
    }
    ctx.textAlign = 'right';
    for (let i = 0; i <= TICKS; i++) {
      const dv = (lengthM * i) / TICKS;
      const y = M_TOP + plotH - (plotH * i) / TICKS;
      ctx.fillStyle = '#8b949e';
      ctx.fillText(String(Math.round(dv)), M_LEFT - 5, y + 3);
      if (i > 0) {
        ctx.strokeStyle = 'rgba(139,148,158,0.12)';
        ctx.beginPath();
        ctx.moveTo(M_LEFT, y);
        ctx.lineTo(M_LEFT + plotW, y);
        ctx.stroke();
      }
    }

    // Axis labels (Spanish).
    ctx.fillStyle = '#aeb8c2';
    ctx.textAlign = 'center';
    ctx.fillText('tiempo (s)', M_LEFT + plotW / 2, CSS_H - 6);
    ctx.textAlign = 'left';
    ctx.fillText('distancia (m)', 4, 12);

    if (!corridor || count === 0) return;

    // Trajectory dots, oldest -> newest.
    const xScale = plotW / windowS;
    const yScale = plotH / lengthM;
    const vScale = 8 / speedMs; // ratio -> bucket index space
    for (let i = 0; i < count; i++) {
      const idx = (head - count + i + capacity) % capacity;
      const t = ts[idx];
      if (t < tMin) continue; // rolled out of the window
      const d = ss[idx];
      if (d < 0 || d > lengthM) continue;
      const x = M_LEFT + (t - tMin) * xScale;
      const y = M_TOP + plotH - d * yScale;
      let b = (vs[idx] * vScale) | 0;
      if (b > 7) b = 7;
      else if (b < 0) b = 0;
      ctx.fillStyle = COLORS[b];
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  draw(); // empty axes until the first sample tick

  return {
    /** Called once per frame; samples on its own sampleS sim-time cadence. */
    update() {
      const world = app.world;
      if (!world) return;
      const sim = world.sim;
      if (sim !== lastSim) {
        // New world (map swap): recompute corridor, drop the old samples.
        lastSim = sim;
        setCorridor(findCorridor(world.network));
        head = 0;
        count = 0;
        nextSampleT = 0;
        lastTime = sim.time;
        draw();
      }
      if (!corridor) return;
      if (sim.time < nextSampleT) return;
      nextSampleT = sim.time + sampleS;
      lastTime = sim.time;
      const vehs = sim.vehicles;
      const baseS = corridor.baseS;
      const connBaseS = corridor.connBaseS;
      let added = false;
      for (let i = 0; i < vehs.length; i++) {
        const veh = vehs[i];
        const seg = veh.seg;
        const base = seg.isConnector ? connBaseS.get(seg.id) : baseS.get(seg.edgeId);
        if (base === undefined) continue; // not on the corridor
        ts[head] = sim.time;
        ss[head] = base + veh.s;
        vs[head] = veh.v;
        head = (head + 1) % capacity;
        if (count < capacity) count++;
        totalSamples++;
        added = true;
      }
      if (added && !collapsed) draw();
    },
    get sampleCount() {
      return totalSamples;
    },
    get corridorName() {
      return corridor ? corridor.name : null;
    },
    get corridorLength() {
      return corridor ? corridor.lengthM : 0;
    },
    dispose() {
      panel.remove();
      style.remove();
    },
  };
}
