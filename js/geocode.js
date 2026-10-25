// Address search and reverse lookup via Photon (OpenStreetMap data), with
// Nominatim as a backup when Photon can't be reached.
//
// Nominatim's usage policy allows at most one request per second and no
// search-as-you-type, so it's only used for searches the user asks for
// (Enter or Plan) and for place names, one at a time, with names cached.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { recordProblem } from './problems.js';

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON_RETRY_MS = 5 * 60 * 1000;   // after Photon fails, skip it for this long

let photonDownUntil = 0;
const photonUp = () => Date.now() >= photonDownUntil;

/** Thrown by suggestPlaces when suggestions can't be offered right now. */
export class SuggestionsUnavailable extends Error {
  constructor() {
    super("Suggestions aren't available right now. Press Enter to search.");
    this.name = 'SuggestionsUnavailable';
  }
}

// OpenStreetMap lists every number on a building ("1186;1188;1190"); show the first.
const firstNumber = (n) => (n ? String(n).split(/[;,]/)[0].trim() : null);

function labelFor(props) {
  const street = [firstNumber(props.housenumber), props.street].filter(Boolean).join(' ');
  const place = props.city || props.town || props.village || props.county;
  const state = US_STATES[props.state] || props.state;
  const parts = [props.name !== place ? props.name : null, street || null, place, state];
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

async function photonJson(path, params, signal, service) {
  const url = `${PHOTON}${path}?${params}`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;   // a newer keystroke
    photonDownUntil = Date.now() + PHOTON_RETRY_MS;
    recordProblem(service, url, err);
    throw err;
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) photonDownUntil = Date.now() + PHOTON_RETRY_MS;
    recordProblem(service, url, `HTTP ${res.status}`);
    throw new Error(`${service} failed (${res.status}).`);
  }
  return res.json();
}

function photonSearch(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: '5', lang: 'en' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lon.toFixed(4));
  }
  return photonJson('/api/', params, signal, 'Address search')
    .then((data) => data.features.map(toPlace).filter((p) => p.label));
}

// ---------- Nominatim (backup) ----------

function fromNominatim(item) {
  const a = item.address || {};
  const props = {
    name: item.name,
    housenumber: a.house_number,
    street: a.road,
    city: a.city,
    town: a.town,
    village: a.village,
    county: a.county,
    state: a.state,
  };
  const town = props.city || props.town || props.village || props.county || null;
  const state = US_STATES[props.state] || props.state;
  return {
    label: labelFor(props) || item.display_name,
    town: town && state ? `${town}, ${state}` : town,
    lat: Number(item.lat),
    lon: Number(item.lon),
  };
}

// One request at a time, at least a second apart.
let nominatimQueue = Promise.resolve();
let nominatimLast = 0;
function nominatimJson(path, params, service, signal) {
  const run = async () => {
    const wait = nominatimLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    nominatimLast = Date.now();
    const url = `${NOMINATIM}${path}?${params}`;
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name !== 'AbortError') recordProblem(service, url, err);
      throw err;
    }
    if (!res.ok) {
      recordProblem(service, url, `HTTP ${res.status}`);
      throw new Error(`${service} failed (${res.status}).`);
    }
    return res.json();
  };
  const result = nominatimQueue.then(run, run);
  nominatimQueue = result.catch(() => {});
  return result;
}

function nominatimSearch(query, near, signal) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'en',
  });
  if (near) {
    // Prefer results near you without excluding others.
    const d = 1;
    params.set('viewbox', [near.lon - d, near.lat + d, near.lon + d, near.lat - d].map((v) => v.toFixed(3)).join(','));
  }
  return nominatimJson('/search', params, 'Address search', signal)
    .then((list) => list.map(fromNominatim).filter((p) => p.label));
}

// ---------- Public API ----------

/**
 * Suggestions while typing. Photon only; throws SuggestionsUnavailable when
 * Photon can't be reached (Nominatim doesn't allow search-as-you-type).
 * @param {string} query
 * @param {{lat:number, lon:number}} [near] bias results toward this point
 * @param {AbortSignal} [signal]
 */
export async function suggestPlaces(query, near, signal) {
  if (!photonUp()) throw new SuggestionsUnavailable();
  try {
    return await photonSearch(query, near, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (!photonUp()) throw new SuggestionsUnavailable();
    throw err;
  }
}

/**
 * A search the user asked for (Enter or Plan): Photon, then Nominatim.
 * @returns {Promise<Array<{label:string, town:string|null, lat:number, lon:number}>>}
 */
export async function searchPlaces(query, near, signal) {
  if (photonUp()) {
    try {
      return await photonSearch(query, near, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  return nominatimSearch(query, near, signal);
}

// ---------- Place names ----------

const NAME_CACHE_KEY = 'roadtripper.placeNames.v2';
const NAME_CACHE_MAX = 300;

function nameKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;   // about 100 m
}

function readNames() {
  try { return JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}'); } catch { return {}; }
}

function rememberName(key, place) {
  try {
    const names = readNames();
    delete names[key];
    names[key] = place;
    const keys = Object.keys(names);
    for (const k of keys.slice(0, Math.max(0, keys.length - NAME_CACHE_MAX))) delete names[k];
    localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(names));
  } catch { /* storage unavailable */ }
}

/** Name the place at a coordinate, for labeling "current location" and forecast points. */
export async function reversePlace(lat, lon) {
  const key = nameKey(lat, lon);
  const cached = readNames()[key];
  if (cached) return cached;

  let place = null;
  let found = false;
  if (photonUp()) {
    try {
      const params = new URLSearchParams({ lat: String(lat), lon: String(lon), lang: 'en' });
      const data = await photonJson('/reverse', params, undefined, 'Place names');
      place = data.features.length ? toPlace(data.features[0]) : null;
      found = true;
    } catch { /* fall through to Nominatim */ }
  }
  if (!found) {
    const params = new URLSearchParams({
      lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1', zoom: '14', 'accept-language': 'en',
    });
    try {
      const item = await nominatimJson('/reverse', params, 'Place names');
      place = item && !item.error ? fromNominatim(item) : null;
    } catch {
      return null;
    }
  }
  if (place) rememberName(key, place);
  return place;
}
