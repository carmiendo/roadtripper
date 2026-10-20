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

const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH',
  'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
  Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

function toPlace(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const town = p.city || p.town || p.village || p.county || null;
  const state = US_STATES[p.state] || p.state;
  return { label: labelFor(p), town: town && state ? `${town}, ${state}` : town, lat, lon };
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
