// Gas stations along a route, from OpenStreetMap via the Overpass API.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Station:
//   id, lat, lon
//   name      display name (brand, else name, else "Gas station")
//   brand     OSM brand tag, or null
//   place     town or street, when tagged
//   open24    true when tagged opening_hours=24/7
//   along     meters from route start to where the station meets the route
//   offRoute  straight-line meters from the route

import { projectToRoute, resampleRoute } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const SAMPLE_SPACING_M = 3000;   // route points every 3 km for the corridor query
const POINTS_PER_QUERY = 150;    // about 450 km of route per request
const TIMEOUT_MS = 30000;

async function overpass(query) {
  const errors = [];
  for (const url of ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      errors.push(err.name === 'AbortError' ? 'timed out' : err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Couldn't load gas stations (${errors.join('; ')}). Try again in a minute.`);
}

function corridorQuery(points, radius) {
  const line = points.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  return `[out:json][timeout:25];nwr["amenity"="fuel"](around:${Math.round(radius)},${line});out center tags;`;
}

function toStation(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const brand = t.brand || null;
  const name = brand || t.name || t.operator || 'Gas station';
  return {
    id: `${el.type}/${el.id}`,
    lat, lon,
    name,
    subname: t.name && t.name !== name ? t.name : null,
    brand,
    place: t['addr:city'] || t['addr:street'] || null,
    open24: t.opening_hours === '24/7',
  };
}

/**
 * Gas stations within `radius` meters of the route, sorted by distance along it.
 * @param {object} route
 * @param {number} radius meters
 * @param {(done:number, total:number) => void} [onProgress]
 */
export async function fetchStations(route, radius, onProgress) {
  const points = resampleRoute(route, SAMPLE_SPACING_M);
  const chunks = [];
  for (let i = 0; i < points.length; i += POINTS_PER_QUERY - 1) {
    chunks.push(points.slice(i, i + POINTS_PER_QUERY));
    if (i + POINTS_PER_QUERY >= points.length) break;
  }

  const byId = new Map();
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const data = await overpass(corridorQuery(chunks[i], radius));
    for (const el of data.elements || []) {
      const station = toStation(el);
      if (station && !byId.has(station.id)) byId.set(station.id, station);
    }
  }
  onProgress?.(chunks.length, chunks.length);

  const stations = [];
  for (const s of byId.values()) {
    const { along, offRoute } = projectToRoute(route, [s.lon, s.lat]);
    if (offRoute <= radius) stations.push({ ...s, along, offRoute });
  }
  stations.sort((a, b) => a.along - b.along);
  return stations;
}

/**
 * Stretches of route longer than `threshold` meters with no station.
 * Measured from `from` (meters along) to the end of the route.
 * @returns {Array<{start:number, end:number, length:number, lastStation:object|null}>}
 */
export function findGaps(stations, route, threshold, from = 0) {
  const end = route.cumDist[route.cumDist.length - 1];
  const gaps = [];
  let prev = null;
  let prevAlong = from;
  for (const s of stations) {
    if (s.along < from) { prev = s; continue; }
    if (s.along - prevAlong > threshold) {
      gaps.push({ start: prevAlong, end: s.along, length: s.along - prevAlong, lastStation: prev });
    }
    prev = s;
    prevAlong = s.along;
  }
  if (end - prevAlong > threshold) {
    gaps.push({ start: prevAlong, end, length: end - prevAlong, lastStation: prev, toEnd: true });
  }
  return gaps;
}
