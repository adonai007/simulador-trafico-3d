// V4 D3 — Compartir por URL. Serializes the live scenario (zone + GUI settings
// + street closures) into URLSearchParams, builds a shareable link, copies it
// to the clipboard, and restores a scenario from the URL at boot time.
//
// Boot-restore ordering is the risky part and is implemented EXACTLY per
// DESIGN-SPEC-V4 §D3:
//   (1) parse — empty → return.
//   (2) ZONE FIRST — if q or a non-default center is present, fetch + AWAIT
//       rebuildWorld so the network exists before any setter runs. A fetch
//       failure toasts and continues on whatever world is live (default zone).
//   (3) SETTINGS — applied via the same setters the GUI uses, then mirrored
//       into gui.applyState() so the lil-gui controllers redraw. Order:
//       demanda/vel/pausa → clima+intensidad → hora → heatmap → nombres →
//       satélite (async, defensive) → teleférico.
//   (4) CLOSURES LAST — resolved against network.edges by OSM-stable
//       (wayId, fromNode, toNode); exact match else wayId-nearest-midpoint,
//       else skipped. Reliable on the same default zone, best-effort elsewhere.

import { CONFIG } from '../config.js';
import { resolveQuery } from '../osm/geocode.js';
import { fetchNetworkOsm } from '../osm/overpass.js';
import { showToast } from './search.js';

const EPS_DEG = 1e-5; // ~1 m — center equality tolerance for "is default zone"

/** Encode a boolean as '1' | '0'. */
function b01(v) {
  return v ? '1' : '0';
}

/** Parse a param as boolean: '1'/'true' → true, '0'/'false' → false, else dflt. */
function parseBool(raw, dflt) {
  if (raw == null) return dflt;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return dflt;
}

/** Parse a finite number param, else dflt. */
function parseNum(raw, dflt) {
  if (raw == null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/** Round to a compact, URL-friendly precision (kills float noise). */
function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** True when the world center matches the bundled default zone (omit c/r). */
function isDefaultZone(app) {
  const n = app.world && app.world.network;
  if (!n || !n.center) return true;
  return (
    Math.abs(n.center.lat - CONFIG.defaultCenter.lat) < EPS_DEG &&
    Math.abs(n.center.lon - CONFIG.defaultCenter.lon) < EPS_DEG
  );
}

/**
 * serializeState(app, gui) → URLSearchParams.
 * The GUI params object is the single source of truth for the toggles/sliders
 * (it stays in sync with every onChange + applyState); the live closure set
 * comes from sim.closedEdges resolved back to OSM-stable triples.
 */
export function serializeState(app, gui) {
  const params = new URLSearchParams();
  const p = gui.params;

  // ---- Zone (omit for the default zone so default links stay short) ----
  if (!isDefaultZone(app)) {
    if (app.lastQuery && app.lastQuery.text) {
      params.set('q', app.lastQuery.text);
    } else {
      const c = app.world.network.center;
      params.set('c', `${round(c.lat, 6)},${round(c.lon, 6)}`);
    }
    const r = app.world.radiusM;
    if (Number.isFinite(r)) params.set('r', String(Math.round(r)));
  }

  // ---- Traffic + environment toggles ----
  // Read the LIVE runtime state (sim/environment/roads) so the link is accurate
  // however the scenario was set — via the GUI (which mirrors into gui.params)
  // OR directly through __SIM__ setters. gui.params is the fallback when the
  // live source is unavailable.
  const sim = app.world && app.world.sim;
  const roads = app.world && app.world.roads;
  const demanda = sim && Number.isFinite(sim.demand) ? sim.demand : p.demanda;
  const velocidad = sim && Number.isFinite(sim.simSpeed) ? sim.simSpeed : p.velocidad;
  const hora = Number.isFinite(CONFIG.dayNight.timeOfDay)
    ? CONFIG.dayNight.timeOfDay
    : p.horaDelDia;
  const lluvia = CONFIG.weather.mode === 'lluvia';
  const intensidad = Number.isFinite(CONFIG.weather.intensity)
    ? CONFIG.weather.intensity
    : p.intensidadLluvia;
  const heatmap = roads?.getHeatmapState ? !!roads.getHeatmapState().enabled : !!p.mapaCalor;

  params.set('d', String(Math.round(demanda)));
  params.set('v', String(round(velocidad, 2)));
  params.set('h', String(round(hora, 2)));
  params.set('w', b01(lluvia));
  params.set('wi', String(round(intensidad, 2)));
  params.set('hm', b01(heatmap));
  params.set('sat', b01(p.verSatelite)); // D1 owns no live getter yet — GUI param
  params.set('tel', b01(p.verTeleferico));
  params.set('nm', b01(p.nombresCalles));

  // ---- Closures: OSM-stable triples (NOT build-specific edge ids) ----
  const closed = app.world && app.world.sim.closedEdges;
  if (closed && closed.size > 0) {
    const net = app.world.network;
    const seen = new Set();
    const triples = [];
    for (const id of closed) {
      const e = net.edges.get(id);
      if (!e) continue;
      // Collapse a twin pair to ONE canonical triple (smaller node first) so a
      // both-direction closure serializes once and restores both twins.
      const a = e.fromNode;
      const b = e.toNode;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = `${e.wayId}:${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      triples.push(key);
    }
    if (triples.length) params.set('closed', triples.join(','));
  }

  return params;
}

/** buildShareUrl(params) → absolute link reproducing the scenario. */
export function buildShareUrl(params) {
  const qs = params.toString();
  return location.origin + location.pathname + (qs ? '?' + qs : '');
}

/**
 * copyShareLink(app, gui) — copy the share URL to the clipboard with a Spanish
 * toast. Uses navigator.clipboard when available, falling back to a hidden
 * input + execCommand('copy') for non-secure contexts / older browsers.
 */
export async function copyShareLink(app, gui) {
  const url = buildShareUrl(serializeState(app, gui));
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = legacyCopy(url);
  showToast(ok ? 'Enlace copiado' : 'No se pudo copiar — copia la URL manualmente');
  return { url, ok };
}

/** execCommand('copy') fallback over a transient off-screen textarea. */
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Resolve a serialized closure triple to a live edge id on the current network.
 *   1. exact (wayId, {fromNode,toNode} either direction)
 *   2. same wayId, nearest edge midpoint (best-effort across rebuilds)
 *   3. skip
 * Returns an edge id (or null). The canonical triple stored a node-sorted pair,
 * so direction is matched as an unordered {a,b}.
 */
function resolveClosure(net, wayId, na, nb) {
  let exact = null;
  let wayCandidates = null;
  for (const e of net.edges.values()) {
    if (e.wayId !== wayId) continue;
    const matchPair =
      (e.fromNode === na && e.toNode === nb) ||
      (e.fromNode === nb && e.toNode === na);
    if (matchPair) {
      exact = e;
      break;
    }
    (wayCandidates ||= []).push(e);
  }
  if (exact) return exact.id;
  if (wayCandidates && wayCandidates.length) {
    // Nearest by node membership: prefer an edge that touches either endpoint.
    let touch = null;
    for (const e of wayCandidates) {
      if (e.fromNode === na || e.toNode === na || e.fromNode === nb || e.toNode === nb) {
        touch = e;
        break;
      }
    }
    return (touch || wayCandidates[0]).id;
  }
  return null;
}

/**
 * applyFromUrl(params, app, gui, rebuildWorld) — full boot restore.
 * Returns true when at least one scenario field was applied (or the zone was
 * restored), false when the URL carried nothing to restore.
 */
export async function applyFromUrl(params, app, gui, rebuildWorld) {
  if (!params || ![...params.keys()].length) return false;

  // ---- (2) ZONE FIRST — fetch + await rebuild before any setter touches it ----
  const q = params.get('q');
  const c = params.get('c');
  let restoredText = null;
  if (q || c) {
    try {
      let loc = null;
      if (q) {
        loc = await resolveQuery(q);
        restoredText = q;
      } else {
        const [lat, lon] = c.split(',').map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const r = parseNum(params.get('r'), CONFIG.defaultRadiusM);
          loc = { lat, lon, radiusM: r };
        }
      }
      if (loc) {
        const r = parseNum(params.get('r'), loc.radiusM ?? CONFIG.defaultRadiusM);
        const { osm, radiusM } = await fetchNetworkOsm(loc.lat, loc.lon, r);
        const result = await rebuildWorld(
          osm,
          { lat: loc.lat, lon: loc.lon, text: restoredText },
          radiusM
        );
        if (result !== true) {
          showToast('No se pudo restaurar la zona del enlace — usando la zona de ejemplo');
        }
      }
    } catch (err) {
      console.warn('[share] restore de zona falló:', err);
      showToast('No se pudo restaurar la zona del enlace — usando la zona de ejemplo');
    }
  }

  // ---- (3) SETTINGS — via setters, mirrored into gui.applyState() ----
  const S = window.__SIM__;
  const next = {};

  if (params.has('d')) {
    const d = parseNum(params.get('d'), gui.params.demanda);
    S.setDemand?.(d);
    next.demanda = d;
  }
  if (params.has('v')) {
    const v = parseNum(params.get('v'), gui.params.velocidad);
    S.setSimSpeed?.(v);
    next.velocidad = v;
  }
  // clima + intensidad in one setWeather call (intensity first so mode applies it).
  if (params.has('w') || params.has('wi')) {
    const mode = parseBool(params.get('w'), gui.params.clima === 'lluvia')
      ? 'lluvia'
      : 'despejado';
    const wi = parseNum(params.get('wi'), gui.params.intensidadLluvia);
    S.setWeather?.(mode, wi);
    next.clima = mode;
    next.intensidadLluvia = wi;
  }
  if (params.has('h')) {
    const h = parseNum(params.get('h'), gui.params.horaDelDia);
    S.setTimeOfDay?.(h);
    next.horaDelDia = h;
  }
  if (params.has('hm')) {
    const hm = parseBool(params.get('hm'), gui.params.mapaCalor);
    S.setHeatmap?.(hm);
    next.mapaCalor = hm;
  }
  if (params.has('nm')) {
    const nm = parseBool(params.get('nm'), gui.params.nombresCalles);
    app.world?.streetNames?.setVisible?.(nm);
    next.nombresCalles = nm;
  }
  if (params.has('sat')) {
    const sat = parseBool(params.get('sat'), gui.params.verSatelite);
    // D1 lands in parallel — call defensively; the inert stub is a safe no-op.
    S.setSatellite?.(sat);
    next.verSatelite = sat;
  }
  if (params.has('tel')) {
    const tel = parseBool(params.get('tel'), gui.params.verTeleferico);
    app.world?.aerialwayMesh?.setVisible?.(tel);
    next.verTeleferico = tel;
  }

  // Mirror everything into the GUI so the lil-gui controllers redraw.
  gui.applyState?.(next);

  // ---- (4) CLOSURES LAST — resolve OSM triples against the live network ----
  const closedRaw = params.get('closed');
  if (closedRaw && app.world) {
    const net = app.world.network;
    let any = false;
    for (const tri of closedRaw.split(',')) {
      const parts = tri.split(':');
      if (parts.length !== 3) continue;
      const wayId = Number(parts[0]);
      const na = Number(parts[1]);
      const nb = Number(parts[2]);
      if (!Number.isFinite(wayId)) continue;
      const id = resolveClosure(net, wayId, na, nb);
      if (id != null) {
        app.world.sim.closeEdge?.(id);
        any = true;
      }
    }
    if (any) app.world.roads.notifyClosuresChanged?.();
  }

  return true;
}

/**
 * createShare(app, gui) — the share controller wired into __SIM__.share and the
 * GUI «Compartir enlace» button.
 */
export function createShare(app, gui) {
  return {
    url: () => buildShareUrl(serializeState(app, gui)),
    serialize: () => serializeState(app, gui),
    copy: () => copyShareLink(app, gui),
  };
}

/**
 * bootShare(app, gui, rebuildWorld) — called at the END of init(), AFTER
 * window.__SIM__ is assigned. Restores any scenario carried in the page URL.
 */
export function bootShare(app, gui, rebuildWorld) {
  const params = new URLSearchParams(location.search);
  applyFromUrl(params, app, gui, rebuildWorld).catch((err) =>
    console.warn('[share] boot restore falló:', err)
  );
}
