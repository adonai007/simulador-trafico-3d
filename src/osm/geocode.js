// Geocoding (spec §1.1): Google-Maps-URL / "lat, lon" parsing first (no
// network), then Nominatim place search (debounced to 1 req/s, single result,
// no custom headers). resolveQuery(q) -> { lat, lon, radiusM, label }.

import { CONFIG } from '../config.js';
import { clamp } from '../util/math2d.js';

const GMAPS_AT_RE = /@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z/;
const QPARAM_RE = /[?&]q=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/;
const BARE_PAIR_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Google-Maps zoom -> meters radius (spec formula), clamped 250–1200. */
function zoomToRadius(lat, zoom) {
  const m = ((40075000 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)) * 0.35;
  return clamp(m, CONFIG.radiusClampM.min, CONFIG.radiusClampM.max);
}

function validCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Try to parse the query locally: Google Maps URL (@lat,lon,zoom z), ?q=lat,lon,
 * or a bare "lat, lon" pair. Returns {lat, lon, radiusM, label} or null.
 */
export function parseCoordsOrUrl(q) {
  let m = q.match(GMAPS_AT_RE);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (validCoords(lat, lon)) {
      return { lat, lon, radiusM: zoomToRadius(lat, parseFloat(m[3])), label: 'URL de Google Maps' };
    }
  }
  m = q.match(QPARAM_RE) || q.match(BARE_PAIR_RE);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (validCoords(lat, lon)) {
      return { lat, lon, radiusM: CONFIG.defaultRadiusM, label: 'coordenadas' };
    }
  }
  return null;
}

let lastNominatimAt = 0;

/** Nominatim place search. Debounced to >= 1 s between requests. */
export async function geocodePlace(q) {
  const wait = lastNominatimAt + 1000 - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  lastNominatimAt = Date.now();

  const url = `${CONFIG.nominatimUrl}?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const res = await fetch(url); // no custom headers (CORS-safe per Nominatim policy)
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  const hit = results[0];
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  if (!validCoords(lat, lon)) return null;
  return { lat, lon, radiusM: CONFIG.defaultRadiusM, label: hit.display_name || q };
}

/**
 * Full resolution: local parse first, Nominatim otherwise.
 * Resolves to {lat, lon, radiusM, label} or null (place not found).
 */
export async function resolveQuery(q) {
  const local = parseCoordsOrUrl(q);
  if (local) return local;
  return geocodePlace(q);
}
