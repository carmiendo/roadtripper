// Address search and reverse lookup via Photon (OpenStreetMap data).
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const PHOTON = 'https://photon.komoot.io';

function labelFor(props) {
  const street = [props.housenumber, props.street].filter(Boolean).join(' ');
  const place = props.city || props.town || props.village || props.county;
  const parts = [props.name !== place ? props.name : null, street || null, place, props.state];
  const seen = new Set();
  return parts
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(', ');
}

function toPlace(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  return { label: labelFor(feature.properties), lat, lon };
}

/**
 * Search for places matching `query`.
 * @param {string} query
 * @param {{lat:number, lon:number}} [near] bias results toward this point
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{label:string, lat:number, lon:number}>>}
 */
export async function searchPlaces(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: '5', lang: 'en' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lon.toFixed(4));
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Address search failed (${res.status}).`);
  const data = await res.json();
  return data.features.map(toPlace).filter((p) => p.label);
}

/** Name the place at a coordinate, for labeling "current location". */
export async function reversePlace(lat, lon) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), lang: 'en' });
  const res = await fetch(`${PHOTON}/reverse?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.features.length ? toPlace(data.features[0]) : null;
}
