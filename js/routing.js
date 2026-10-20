// Driving routes. OSRM first, Valhalla as fallback.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Every provider returns the same Route shape, so the rest of the app doesn't
// care where a route came from. Swapping in Google Routes later means adding
// one more provider here.
//
// Route:
//   coords    [lon, lat][]   route line
//   cumDist   number[]       meters from start at each coord
//   cumTime   number[]       seconds from start at each coord
//   distance  number         total meters
//   duration  number         total seconds
//   provider  string         'OSRM' | 'Valhalla'

import { haversine, decodePolyline } from './geo.js';

const OSRM = 'https://router.project-osrm.org';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const TIMEOUT_MS = 15000;

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function osrmRoute(from, to) {
  const path = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const params = 'overview=full&geometries=geojson&annotations=distance,duration&steps=false';
  const data = await fetchJson(`${OSRM}/route/v1/driving/${path}?${params}`);
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data.message || 'No route found');
  }
  const route = data.routes[0];
  const coords = route.geometry.coordinates;
  const ann = route.legs[0].annotation;
  const cumDist = [0];
  const cumTime = [0];
  for (let i = 0; i < ann.distance.length; i++) {
    cumDist.push(cumDist[i] + ann.distance[i]);
    cumTime.push(cumTime[i] + ann.duration[i]);
  }
  return {
    coords, cumDist, cumTime,
    distance: route.distance,
    duration: route.duration,
    provider: 'OSRM',
  };
}

async function valhallaRoute(from, to) {
  const body = {
    locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
    costing: 'auto',
    directions_options: { units: 'kilometers' },
  };
  const data = await fetchJson(`${VALHALLA}/route?json=${encodeURIComponent(JSON.stringify(body))}`);
  const leg = data.trip?.legs?.[0];
  if (!leg) throw new Error('No route found');
  const coords = decodePolyline(leg.shape, 6);

  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + haversine(coords[i - 1], coords[i]));
  }

  // Valhalla gives time per maneuver; spread each one across its shape
  // segments in proportion to segment length.
  const cumTime = new Array(coords.length).fill(0);
  for (const m of leg.maneuvers) {
    const a = m.begin_shape_index;
    const b = m.end_shape_index;
    const span = cumDist[b] - cumDist[a];
    for (let i = a + 1; i <= b; i++) {
      const share = span > 0 ? (cumDist[i] - cumDist[i - 1]) / span : 0;
      cumTime[i] = cumTime[i - 1] + m.time * share;
    }
  }

  return {
    coords, cumDist, cumTime,
    distance: data.trip.summary.length * 1000,
    duration: data.trip.summary.time,
    provider: 'Valhalla',
  };
}

const PROVIDERS = [osrmRoute, valhallaRoute];

// Distance and time only, through several points. Used for detours.
async function osrmLegs(points) {
  const path = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const data = await fetchJson(`${OSRM}/route/v1/driving/${path}?overview=false&steps=false`);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message || 'No route found');
  return { distance: data.routes[0].distance, duration: data.routes[0].duration };
}

async function valhallaLegs(points) {
  const body = {
    locations: points.map((p) => ({ lat: p.lat, lon: p.lon })),
    costing: 'auto',
    directions_type: 'none',
  };
  const data = await fetchJson(`${VALHALLA}/route?json=${encodeURIComponent(JSON.stringify(body))}`);
  if (!data.trip) throw new Error('No route found');
  return { distance: data.trip.summary.length * 1000, duration: data.trip.summary.time };
}

/**
 * Driving distance (m) and time (s) through the given points in order.
 * @param {Array<{lat:number, lon:number}>} points
 */
export async function getTripLength(points) {
  const errors = [];
  for (const provider of [osrmLegs, valhallaLegs]) {
    try {
      return await provider(points);
    } catch (err) {
      errors.push(err.name === 'AbortError' ? 'timed out' : err.message);
    }
  }
  throw new Error(`Couldn't measure detour (${errors.join('; ')}).`);
}

/**
 * Get a driving route between two points, trying each provider in order.
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 */
export async function getRoute(from, to) {
  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      return await provider(from, to);
    } catch (err) {
      errors.push(err.name === 'AbortError' ? 'timed out' : err.message);
    }
  }
  throw new Error(`Couldn't get a route (${errors.join('; ')}). Check the addresses and try again.`);
}
