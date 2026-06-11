// Fundamental diagram (spec §5) — the didactic centerpiece. 2D canvas scatter:
// x = densidad k (veh/km/carril), y = flujo q (veh/h/carril). One point per
// detector per 5 s slide, ring buffer of ~300 points, alpha fades with age.
// Collapsible panel; axes labeled in Spanish. Redraws only when new samples
// arrive (every slideS sim-seconds), not per frame.

import { CONFIG } from '../config.js';

const CSS_W = 320;
const CSS_H = 230;
const M_LEFT = 42;
const M_RIGHT = 10;
const M_TOP = 20;
const M_BOTTOM = 30;

export function createChart(app) {
  const maxPoints = CONFIG.detectors.chartMaxPoints;
  const ks = new Float32Array(maxPoints);
  const qs = new Float32Array(maxPoints);
  let head = 0; // next write slot
  let count = 0;
  let nextSampleT = CONFIG.detectors.slideS;
  let lastSim = null;

  // ---- DOM ----
  const panel = document.createElement('div');
  panel.id = 'chart';
  panel.className = 'panel';
  const header = document.createElement('div');
  header.id = 'chart-header';
  header.innerHTML =
    '<span>Diagrama fundamental</span><span id="chart-toggle">▾</span>';
  const body = document.createElement('div');
  body.id = 'chart-body';
  const canvas = document.createElement('canvas');
  canvas.style.width = `${CSS_W}px`;
  canvas.style.height = `${CSS_H}px`;
  const hint = document.createElement('div');
  hint.id = 'chart-hint';
  hint.textContent = 'cada punto = un detector (ventana de 60 s); los recientes brillan más';
  body.appendChild(canvas);
  body.appendChild(hint);
  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);

  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    header.querySelector('#chart-toggle').textContent = collapsed ? '▸' : '▾';
    if (!collapsed) draw();
  });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = CSS_W * dpr;
  canvas.height = CSS_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  function niceCeil(v, step) {
    return Math.max(step, Math.ceil(v / step) * step);
  }

  function draw() {
    ctx.clearRect(0, 0, CSS_W, CSS_H);
    const plotW = CSS_W - M_LEFT - M_RIGHT;
    const plotH = CSS_H - M_TOP - M_BOTTOM;

    // Auto-scale to the current cloud (nice round bounds, sane minimums).
    let kMax = 0;
    let qMax = 0;
    for (let i = 0; i < count; i++) {
      if (ks[i] > kMax) kMax = ks[i];
      if (qs[i] > qMax) qMax = qs[i];
    }
    kMax = niceCeil(kMax * 1.05, 20); // veh/km/carril
    qMax = niceCeil(qMax * 1.05, 200); // veh/h/carril

    // Frame + grid + ticks.
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
      const kv = (kMax * i) / TICKS;
      const x = M_LEFT + (plotW * i) / TICKS;
      ctx.fillText(String(Math.round(kv)), x, M_TOP + plotH + 12);
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
      const qv = (qMax * i) / TICKS;
      const y = M_TOP + plotH - (plotH * i) / TICKS;
      ctx.fillText(String(Math.round(qv)), M_LEFT - 5, y + 3);
      if (i > 0) {
        ctx.strokeStyle = 'rgba(139,148,158,0.12)';
        ctx.beginPath();
        ctx.moveTo(M_LEFT, y);
        ctx.lineTo(M_LEFT + plotW, y);
        ctx.stroke();
      }
    }

    // Axis labels (Spanish, spec §5).
    ctx.fillStyle = '#aeb8c2';
    ctx.textAlign = 'center';
    ctx.fillText('densidad (veh/km)', M_LEFT + plotW / 2, CSS_H - 6);
    ctx.textAlign = 'left';
    ctx.fillText('flujo (veh/h)', 4, 12);

    // Points, oldest -> newest so recent ones draw on top with more alpha.
    for (let age = count - 1; age >= 0; age--) {
      const idx = (head - 1 - age + maxPoints * 2) % maxPoints;
      const x = M_LEFT + (ks[idx] / kMax) * plotW;
      const y = M_TOP + plotH - (qs[idx] / qMax) * plotH;
      const a = 0.12 + 0.78 * (1 - age / Math.max(count, 1));
      ctx.fillStyle = `rgba(88,166,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  draw(); // empty axes until the first window closes

  return {
    /** Called once per frame; samples on its own slideS sim-time cadence. */
    update() {
      const world = app.world;
      if (!world) return;
      const sim = world.sim;
      if (sim !== lastSim) {
        // New world (map swap): drop the old cloud.
        lastSim = sim;
        head = 0;
        count = 0;
        nextSampleT = CONFIG.detectors.slideS;
        draw();
      }
      if (sim.time < nextSampleT) return;
      nextSampleT = sim.time + CONFIG.detectors.slideS;
      const pts = sim.metrics.detectorPoints;
      let added = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.k <= 0 && p.q <= 0) continue; // empty detector — skip origin pile
        ks[head] = p.k;
        qs[head] = p.q;
        head = (head + 1) % maxPoints;
        if (count < maxPoints) count++;
        added = true;
      }
      if (added && !collapsed) draw();
    },
    get pointCount() {
      return count;
    },
    dispose() {
      panel.remove();
    },
  };
}
