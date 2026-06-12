// Map search flow (spec §1.1 / Phase 6): place name (Nominatim), Google Maps
// URL, or "lat, lon" -> Overpass fetch (mirrors + caps) -> full world rebuild.
// Loading overlay "Descargando mapa…", Spanish error toasts, current network
// kept on any failure.

import { resolveQuery } from '../osm/geocode.js';
import { fetchNetworkOsm } from '../osm/overpass.js';

let toastTimer = 0;

/** Bottom-center toast, auto-hides. Exported for other UI modules. */
export function showToast(msg, ms = 6000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, ms);
}

function setLoading(visible) {
  const overlay = document.getElementById('loading');
  if (overlay) overlay.style.display = visible ? 'flex' : 'none';
}

/**
 * createSearch(rebuildWorld) — wires #search-input / #search-btn.
 * rebuildWorld(osm, {lat, lon}, radiusM) -> Promise<true | 'incomplete' | false>
 * (true = swapped; 'incomplete' = validation failed after the radius retry;
 * false = network too small/unusable — the current world is kept either way).
 */
export function createSearch(rebuildWorld) {
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');
  let busy = false;

  async function run() {
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    button.disabled = true;
    setLoading(true);
    try {
      let loc;
      try {
        loc = await resolveQuery(q);
      } catch (err) {
        console.warn('[search] geocode:', err);
        showToast('No se pudo buscar el lugar (¿sin conexión?). Intenta con coordenadas.');
        return;
      }
      if (!loc) {
        showToast('No se encontró el lugar. Prueba con otro nombre o pega coordenadas.');
        return;
      }
      const { osm, radiusM } = await fetchNetworkOsm(loc.lat, loc.lon, loc.radiusM);
      const result = await rebuildWorld(osm, { lat: loc.lat, lon: loc.lon }, radiusM);
      if (result === 'incomplete') {
        // V2.1 A: validation (kept length / retention) failed even after the
        // automatic radius x1.5 retry inside rebuildWorld.
        showToast('Red viaria incompleta en esta zona — probá con más radio o otro punto');
      } else if (result !== true) {
        showToast('Zona sin red viaria suficiente. Se mantiene la red actual.');
      }
    } catch (err) {
      console.warn('[search]', err);
      if (err && err.code === 'TOO_DENSE') {
        showToast('Zona demasiado densa, reduce el radio.');
      } else {
        showToast('No se pudo descargar el mapa. Usando la zona de ejemplo.');
      }
    } finally {
      setLoading(false);
      busy = false;
      button.disabled = false;
    }
  }

  button.addEventListener('click', run);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') run();
  });

  return { run };
}
