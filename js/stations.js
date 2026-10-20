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

import { createRouteIndex } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const BOX_SPAN_M = 25000;        // route split into ~25 km pieces, one bounding box each
const TIMEOUT_MS = 12000;        // try the mirror if the main server is slow
const CACHE_KEY = 'roadtripper.stations.v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_ROUTES = 5;

async function overpass(query) {
  const errors = [];
  for (const [i, url] of ENDPOINTS.entries()) {
    const ctrl = new AbortController();
    // Move on quickly from a busy server; give the last one longer.
    const timer = setTimeout(() => ctrl.abort(), i === ENDPOINTS.length - 1 ? 2 * TIMEOUT_MS : TIMEOUT_MS);
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

// Bounding boxes along the route, each padded by `radius`. Overpass answers
// bbox queries from its spatial index, which is much faster than "around".
function corridorQuery(route, radius) {
  const boxes = [];
  // One pass over the route coordinates, cutting a new box every BOX_SPAN_M.
  let box = null;
  let boxStart = 0;
  const { coords, cumDist } = route;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (!box) box = { s: lat, n: lat, w: lon, e: lon };
    box.s = Math.min(box.s, lat); box.n = Math.max(box.n, lat);
    box.w = Math.min(box.w, lon); box.e = Math.max(box.e, lon);
    if (cumDist[i] - boxStart >= BOX_SPAN_M || i === coords.length - 1) {
      boxes.push(box);
      box = { s: lat, n: lat, w: lon, e: lon };
      boxStart = cumDist[i];
    }
  }
  const parts = boxes.map((b) => {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos((((b.s + b.n) / 2) * Math.PI) / 180));
    const bbox = [b.s - dLat, b.w - dLon, b.n + dLat, b.e + dLon].map((v) => v.toFixed(4)).join(',');
    return `nwr["amenity"="fuel"](${bbox});`;
  });
  return `[out:json][timeout:25];(${parts.join('')});out center tags;`;
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
 * Results are cached in this browser for a day, per route.
 * @param {number} radius meters
 */
export async function fetchStations(route, radius) {
  const key = cacheKey(route, radius);
  let raw = readCache(key);
  if (!raw) {
    const data = await overpass(corridorQuery(route, radius));
    const byId = new Map();
    for (const el of data.elements || []) {
      const station = toStation(el);
      if (station && !byId.has(station.id)) byId.set(station.id, station);
    }
    raw = [...byId.values()];
    writeCache(key, raw);
  }

  const index = createRouteIndex(route, radius);
  const stations = [];
  for (const s of raw) {
    const snap = index.project([s.lon, s.lat]);
    if (snap && snap.offRoute <= radius) stations.push({ ...s, along: snap.along, offRoute: snap.offRoute });
  }
  stations.sort((a, b) => a.along - b.along);
  return stations;
}

// ---------- Cache (this browser only) ----------

function cacheKey(route, radius) {
  const [a, b] = [route.coords[0], route.coords[route.coords.length - 1]];
  return [a[0], a[1], b[0], b[1]].map((v) => v.toFixed(3)).join(',') +
    `|${Math.round(route.distance / 1000)}|${Math.round(radius)}`;
}

function readCache(key) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const hit = all[key];
    return hit && Date.now() - hit.at < CACHE_MAX_AGE_MS ? hit.stations : null;
  } catch {
    return null;
  }
}

function writeCache(key, stations) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[key] = { at: Date.now(), stations };
    const keep = Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, CACHE_ROUTES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // Storage full or unavailable; skip caching.
  }
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
