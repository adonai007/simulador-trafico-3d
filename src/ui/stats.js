// Panel «Estadísticas» + exportación CSV (spec V5 §E2a). Collapsible panel
// cloning the chart.js pattern (.panel + header toggle), refreshed on the HUD
// cadence (metrics.global.time changes). Six rows: viajes completados, tiempo
// medio de viaje, demora media, demora total, velocidad media, rendimiento.
//
// «Exportar CSV» writes three files — metricas-globales.csv (the metricsHistory
// ring), detectores.csv (per-detector window stats) and viajes.csv (the capped
// trip log) — each via Blob + createObjectURL + a.click() + revokeObjectURL,
// prefixed with a UTF-8 BOM so Excel renders Spanish accents, type
// text/csv;charset=utf-8, a.target=_blank. Filenames carry zone + timestamp.
//
// Emergencies and phantoms are already excluded upstream (recordTrip skips
// them; detectors skip phantoms) — the panel reads pure civilian-demand stats.

import { CONFIG } from '../config.js';

const BOM = CONFIG.stats?.bom ?? '﻿';

/** "2026-06-15_14-32-07" — filesystem-safe local timestamp for filenames. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

/** Slugify the zone name into a safe filename token (accents/spaces dropped). */
function zoneSlug(app) {
  const raw = app.lastQuery?.text || 'la-paz-centro';
  return (
    raw
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'zona'
  );
}

/** A CSV field: quote + escape only when it contains a comma, quote or newline. */
function csvField(v) {
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Trigger a browser download for one CSV string (BOM + UTF-8 + revoke). */
function downloadCsv(filename, csv) {
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // NOTE: no target="_blank" — the `download` attribute already keeps the page
  // put, and target=_blank makes the browser treat the programmatic click as a
  // popup, which stalls a Playwright button .click() waiting for a new page
  // (the download still fires, but the click action never resolves). Dropping
  // it keeps the «Exportar CSV» button clickable in the e2e suite. (Deviation.)
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has surely been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build metricas-globales.csv from the metricsHistory ring, oldest -> newest.
 * Spanish headers. Returns the raw string (also used by __SIM__.exportStats()).
 */
function buildMetricsCsv(mh) {
  let out = 'tiempo_s,vehiculos,vel_media_kmh,flujo_veh_h_carril,densidad_veh_km\n';
  if (!mh || !mh.count) return out;
  const cap = mh.cap;
  for (let age = mh.count - 1; age >= 0; age--) {
    const idx = (mh.head - 1 - age + cap * 2) % cap;
    out +=
      `${mh.t[idx].toFixed(1)},${Math.round(mh.vehicles[idx])},` +
      `${mh.meanSpeedKmh[idx].toFixed(2)},${mh.flowVehHLane[idx].toFixed(1)},` +
      `${mh.densityVehKm[idx].toFixed(2)}\n`;
  }
  return out;
}

/** Build detectores.csv from the live detector window stats. */
function buildDetectorsCsv(sim) {
  let out = 'detector_id,arista_id,flujo_veh_h_carril,densidad_veh_km_carril,vel_kmh\n';
  const dets = sim.detectors || [];
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    out +=
      `${i + 1},${csvField(d.edgeId)},${d.q.toFixed(1)},` +
      `${d.k.toFixed(2)},${d.vKmh.toFixed(2)}\n`;
  }
  return out;
}

/** Build viajes.csv from the capped trip log, oldest -> newest. */
function buildTripsCsv(sim) {
  let out =
    'vehiculo_id,t_entrada_s,t_salida_s,tiempo_viaje_s,demora_s,distancia_m\n';
  const tl = sim.tripLog;
  if (!tl || !tl.count) return out;
  const cap = tl.id.length;
  for (let age = tl.count - 1; age >= 0; age--) {
    const idx = (tl.head - 1 - age + cap * 2) % cap;
    out +=
      `${tl.id[idx]},${tl.spawnT[idx].toFixed(1)},${tl.exitT[idx].toFixed(1)},` +
      `${tl.tripTime[idx].toFixed(1)},${tl.delay[idx].toFixed(1)},` +
      `${tl.dist[idx].toFixed(1)}\n`;
  }
  return out;
}

export function createStats(app) {
  // ---- DOM (clones the chart.js collapsible-panel pattern) ----
  // index.html is out of scope for E2a, so position/size are set inline here
  // (the .panel class supplies background/border/blur). Top-right corner keeps
  // clear of the HUD/follow (top-left), explainer (bottom-left), chart
  // (bottom-right) and the replay bar (bottom-center).
  const panel = document.createElement('div');
  panel.id = 'stats';
  panel.className = 'panel';
  // Left column, below the HUD (top-left, ~190 px tall). The top-right corner is
  // taken by the lil-gui controls panel (which intercepts pointer events), and
  // the bottom-right by the chart — both would block this panel's button.
  panel.style.top = '220px';
  panel.style.left = '16px';
  panel.style.minWidth = '230px';
  panel.style.maxWidth = '260px';
  panel.style.padding = '10px 14px';
  panel.style.zIndex = '11'; // above the lil-gui root (z auto) and other panels
  const header = document.createElement('div');
  header.id = 'stats-header';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.gap = '16px';
  header.style.cursor = 'pointer';
  header.style.fontSize = '13px';
  header.style.fontWeight = '600';
  header.style.color = 'var(--accent)';
  header.style.userSelect = 'none';
  header.innerHTML =
    '<span>Estadísticas</span><span id="stats-toggle">▾</span>';
  const body = document.createElement('div');
  body.id = 'stats-body';
  body.style.marginTop = '8px';

  // Six metric rows (label + value), built once; update() rewrites values only.
  const ROWS = [
    ['viajes', 'Viajes completados'],
    ['tiempo', 'Tiempo medio de viaje'],
    ['demoraMedia', 'Demora media'],
    ['demoraTotal', 'Demora total'],
    ['velocidad', 'Velocidad media'],
    ['rendimiento', 'Rendimiento'],
  ];
  // The .stat/.label/.value styles in index.html are scoped to #hud, so the
  // rows are styled inline here to match that look (tabular numerics, dim
  // labels) without touching index.html (out of scope for E2a).
  const valEls = {};
  for (const [key, label] of ROWS) {
    const row = document.createElement('div');
    row.className = 'stat';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.gap = '16px';
    row.style.fontSize = '12.5px';
    row.style.lineHeight = '1.8';
    const l = document.createElement('span');
    l.className = 'label';
    l.style.color = 'var(--text-dim)';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value';
    v.style.fontVariantNumeric = 'tabular-nums';
    v.textContent = '—';
    row.appendChild(l);
    row.appendChild(v);
    body.appendChild(row);
    valEls[key] = v;
  }

  const btn = document.createElement('button');
  btn.id = 'stats-export';
  btn.textContent = 'Exportar CSV';
  btn.style.marginTop = '10px';
  btn.style.width = '100%';
  btn.style.padding = '7px 14px';
  btn.style.fontSize = '12.5px';
  btn.style.fontWeight = '600';
  btn.style.color = '#0d1117';
  btn.style.background = 'var(--accent)';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.style.fontFamily = 'var(--font)';
  body.appendChild(btn);

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);

  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    header.querySelector('#stats-toggle').textContent = collapsed ? '▸' : '▾';
  });

  /** Format seconds as "M:SS" or "Ss" for compact display. */
  function fmtSecs(s) {
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return `${m}:${String(r).padStart(2, '0')} min`;
  }

  let lastSampleT = -1;

  /**
   * Export the three CSV files. Returns the metricas-globales string (the e2e
   * hook __SIM__.exportStats() returns this; the click triggers all three
   * downloads).
   */
  function exportCSV() {
    const world = app.world;
    if (!world) return '';
    const sim = world.sim;
    const slug = zoneSlug(app);
    const ts = stamp();
    const metricsCsv = buildMetricsCsv(sim.metricsHistory);
    downloadCsv(`metricas-globales_${slug}_${ts}.csv`, metricsCsv);
    downloadCsv(`detectores_${slug}_${ts}.csv`, buildDetectorsCsv(sim));
    downloadCsv(`viajes_${slug}_${ts}.csv`, buildTripsCsv(sim));
    return metricsCsv;
  }

  btn.addEventListener('click', exportCSV);

  return {
    /** Refresh the rows on the HUD cadence (one comparison when unchanged). */
    update() {
      const world = app.world;
      if (!world) return;
      const sim = world.sim;
      const g = sim.metrics.global;
      if (g.time === lastSampleT) return; // no new global sample
      lastSampleT = g.time;
      if (collapsed) return; // values invisible — skip the DOM writes
      const ts = sim.tripStats;
      if (!ts) return;
      valEls.viajes.textContent = String(ts.viajesCompletados);
      valEls.tiempo.textContent =
        ts.viajesCompletados > 0 ? fmtSecs(ts.tiempoMedioViaje) : '—';
      valEls.demoraMedia.textContent =
        ts.viajesCompletados > 0 ? fmtSecs(ts.demoraMedia) : '—';
      valEls.demoraTotal.textContent = fmtSecs(ts.demoraTotal);
      valEls.velocidad.textContent =
        ts.viajesCompletados > 0 ? `${ts.velocidadMedia.toFixed(1)} km/h` : '—';
      valEls.rendimiento.textContent = `${ts.rendimiento.toFixed(1)} veh/min`;
    },
    exportCSV,
    dispose() {
      panel.remove();
    },
  };
}
