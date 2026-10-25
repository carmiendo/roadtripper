// Weather along a route: Open-Meteo hourly forecasts and NWS alerts.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// All values are kept in metric (°C, km/h, mm, m) and converted for display.

import { pointAlong, timeAlong } from './geo.js';
import { reversePlace } from './geocode.js';
import { recordProblem } from './problems.js';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const NWS = 'https://api.weather.gov';
const MAX_POINTS = 16;
const POINT_SPACING_S = 30 * 60;   // a forecast point every 30 minutes of driving
const FORECAST_DAYS = 16;          // Open-Meteo's limit
const TIMEOUT_MS = 20000;

const HOURLY = [
  'temperature_2m', 'precipitation_probability', 'precipitation', 'snowfall',
  'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'visibility', 'is_day',
];

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    const alerts = url.startsWith(NWS);
    // NWS answers 400/404 for points outside the US; that's expected, not a problem.
    if (!(alerts && (err.status === 400 || err.status === 404))) {
      recordProblem(alerts ? 'Weather alerts' : 'Weather', url, err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Points along the route to forecast, spaced by drive time, from `from` meters to the end.
 * @returns {Array<{along:number, lat:number, lon:number}>}
 */
export function samplePoints(route, from = 0) {
  const total = route.cumDist[route.cumDist.length - 1];
  const t0 = timeAlong(route, from);
  const remaining = route.duration - t0;
  const spacing = Math.max(POINT_SPACING_S, remaining / (MAX_POINTS - 1));

  // Walk the route converting target times to distances.
  const points = [];
  let i = 0;
  for (let t = t0; t < route.duration; t += spacing) {
    while (i < route.cumTime.length - 2 && route.cumTime[i + 1] < t) i++;
    const span = route.cumTime[i + 1] - route.cumTime[i];
    const f = span > 0 ? (t - route.cumTime[i]) / span : 0;
    const along = Math.max(from, route.cumDist[i] + f * (route.cumDist[i + 1] - route.cumDist[i]));
    points.push(along);
  }
  if (!points.length || total - points[points.length - 1] > 5000) points.push(total);
  else points[points.length - 1] = total;

  return points.map((along) => {
    const [lon, lat] = pointAlong(route, along);
    return { along, lat, lon };
  });
}

/** Hourly forecasts for several points in one request. */
export async function fetchForecasts(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: HOURLY.join(','),
    timeformat: 'unixtime',
    timezone: 'auto',   // also tells us each point's UTC offset, for station hours
    forecast_days: String(FORECAST_DAYS),
  });
  const data = await fetchJson(`${OPEN_METEO}?${params}`);
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => ({ hourly: d.hourly, utcOffset: d.utc_offset_seconds ?? null }));
}

/** The hourly values at the hour closest to `date`, or null if outside the forecast. */
export function hourAt(hourly, date) {
  if (!hourly?.time?.length) return null;
  const t = date.getTime() / 1000;
  const first = hourly.time[0];
  const i = Math.round((t - first) / 3600);
  if (i < 0 || i >= hourly.time.length) return null;
  return hourAtIndex(hourly, i);
}

export function hourAtIndex(hourly, i) {
  if (i < 0 || i >= hourly.time.length) return null;
  const out = { time: new Date(hourly.time[i] * 1000), index: i };
  for (const key of HOURLY) out[key] = hourly[key]?.[i] ?? null;
  return out;
}

// Run `fn` over `items`, `limit` at a time.
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- Names ----------

async function nameFor(point) {
  try {
    const place = await reversePlace(point.lat, point.lon);
    return place?.town || place?.label || null;
  } catch {
    return null;
  }
}

/** Town names for points, reported one at a time as they arrive. */
export async function namePoints(points, onName) {
  await eachLimited(points, 4, async (p, i) => {
    const name = await nameFor(p);
    if (name) onName(i, name);
  });
}

// ---------- NWS alerts ----------
// One request per state for its active alerts, kept only where they cover a
// forecast point: by the alert's outline when it has one, otherwise by the
// NWS zones (forecast zone, county, fire zone) the point is in. Each point's
// zones come from NWS's /points lookup once, then from this browser's cache:
// zone lines rarely move, so later trips on the same roads need no lookups.

const ZONES_KEY = 'roadtripper.nwsZones.v1';
const ZONES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NO_ZONES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // outside NWS coverage
const ZONES_MAX = 600;
const NWS_HEADERS = { headers: { Accept: 'application/geo+json' } };

const zoneKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;   // about 1 km

function readZones() {
  try { return JSON.parse(localStorage.getItem(ZONES_KEY) || '{}'); } catch { return {}; }
}

function writeZones(all) {
  try {
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - ZONES_MAX))) delete all[k];
    localStorage.setItem(ZONES_KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}

const lastPart = (url) => (url ? String(url).split('/').pop() : null);

/** {state, zones: string[]} for a point, or null outside NWS coverage. */
async function zonesFor(p, cache) {
  const key = zoneKey(p);
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (hit.state ? ZONES_MAX_AGE_MS : NO_ZONES_MAX_AGE_MS)) {
    return hit.state ? hit : null;
  }
  try {
    const data = await fetchJson(`${NWS}/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, NWS_HEADERS);
    const pr = data.properties || {};
    const entry = {
      at: Date.now(),
      state: pr.relativeLocation?.properties?.state || null,
      zones: [pr.forecastZone, pr.county, pr.fireWeatherZone].map(lastPart).filter(Boolean),
    };
    cache[key] = entry;
    return entry.state ? entry : null;
  } catch (err) {
    if (err.status === 400 || err.status === 404) cache[key] = { at: Date.now(), state: null, zones: [] };
    return null;   // a temporary failure isn't cached
  }
}

// Ray casting; rings are [lon, lat] arrays, the first is the outline, the rest holes.
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));

/** Whether an alert covers a point (exported for tests). */
export function alertCovers(feature, point, zones) {
  const g = feature.geometry;
  const pt = [point.lon, point.lat];
  if (g?.type === 'Polygon') return inPolygon(pt, g.coordinates);
  if (g?.type === 'MultiPolygon') return g.coordinates.some((rings) => inPolygon(pt, rings));
  const ugc = feature.properties?.geocode?.UGC || [];
  return zones.some((z) => ugc.includes(z));
}

/**
 * Active NWS alerts at any of the points. US only; points outside NWS
 * coverage return nothing.
 * @returns {Promise<{alerts: Array<object>, covered: boolean}>}
 */
export async function fetchAlerts(points) {
  const cache = readZones();
  const info = new Array(points.length).fill(null);
  await eachLimited(points, 4, async (p, i) => { info[i] = await zonesFor(p, cache); });
  writeZones(cache);

  const states = [...new Set(info.filter(Boolean).map((z) => z.state))];
  const byId = new Map();
  let covered = false;
  await Promise.all(states.map(async (st) => {
    let data;
    try {
      data = await fetchJson(`${NWS}/alerts/active?area=${encodeURIComponent(st)}`, NWS_HEADERS);
    } catch {
      return;   // that state's alerts are missing this time
    }
    covered = true;
    for (const f of data.features || []) {
      const a = f.properties;
      points.forEach((p, i) => {
        if (info[i]?.state !== st || !alertCovers(f, p, info[i].zones)) return;
        const existing = byId.get(a.id);
        if (existing) { if (!existing.alongs.includes(p.along)) existing.alongs.push(p.along); return; }
        byId.set(a.id, {
          id: a.id,
          event: a.event,
          headline: a.headline,
          description: a.description,
          instruction: a.instruction,
          severity: a.severity,          // Extreme | Severe | Moderate | Minor | Unknown
          area: a.areaDesc,
          onset: a.onset ? new Date(a.onset) : null,
          ends: a.ends ? new Date(a.ends) : a.expires ? new Date(a.expires) : null,
          alongs: [p.along],
        });
      });
    }
  }));
  const order = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  const alerts = [...byId.values()].sort((a, b) =>
    (order[a.severity] ?? 4) - (order[b.severity] ?? 4) || Math.min(...a.alongs) - Math.min(...b.alongs));
  return { alerts, covered };
}

// ---------- Conditions ----------

// WMO weather codes, as used by Open-Meteo.
export function describe(code) {
  if (code == null) return { label: 'Unknown', kind: 'cloud' };
  if (code === 0) return { label: 'Clear', kind: 'clear' };
  if (code === 1) return { label: 'Mostly clear', kind: 'clear' };
  if (code === 2) return { label: 'Partly cloudy', kind: 'partly' };
  if (code === 3) return { label: 'Cloudy', kind: 'cloud' };
  if (code === 45 || code === 48) return { label: 'Fog', kind: 'fog' };
  if (code >= 51 && code <= 55) return { label: 'Drizzle', kind: 'rain' };
  if (code === 56 || code === 57) return { label: 'Freezing drizzle', kind: 'ice' };
  if (code >= 61 && code <= 65) return { label: code === 65 ? 'Heavy rain' : 'Rain', kind: 'rain' };
  if (code === 66 || code === 67) return { label: 'Freezing rain', kind: 'ice' };
  if (code >= 71 && code <= 75) return { label: code === 75 ? 'Heavy snow' : 'Snow', kind: 'snow' };
  if (code === 77) return { label: 'Snow grains', kind: 'snow' };
  if (code >= 80 && code <= 82) return { label: code === 82 ? 'Heavy showers' : 'Showers', kind: 'rain' };
  if (code === 85 || code === 86) return { label: 'Snow showers', kind: 'snow' };
  if (code === 95) return { label: 'Thunderstorms', kind: 'storm' };
  if (code === 96 || code === 99) return { label: 'Thunderstorms, hail', kind: 'storm' };
  return { label: 'Unknown', kind: 'cloud' };
}

const GUST_WARN_KMH = 64;   // about 40 mph
const VIS_WARN_M = 1000;

/** Driving concerns for an hour of forecast, most serious first. */
export function hazards(h) {
  if (!h) return [];
  const out = [];
  const { kind } = describe(h.weather_code);
  if (kind === 'ice') out.push('ice');
  if (kind === 'snow' || (h.snowfall ?? 0) > 0.1) out.push('snow');
  if (kind === 'storm') out.push('storm');
  if (!out.length && (kind === 'rain' || (h.precipitation_probability ?? 0) >= 60)) out.push('rain');
  if ((h.wind_gusts_10m ?? 0) >= GUST_WARN_KMH) out.push('wind');
  if ((h.visibility ?? Infinity) < VIS_WARN_M || kind === 'fog') out.push('fog');
  return out;
}

// ---------- Whole-trip summary (for comparing departure times) ----------

/**
 * What the weather looks like over a whole trip leaving at `departAt`.
 * @param {Array<{along:number, hourly:object}>} points forecast points along the route
 * @param {(along:number) => number} secondsTo drive time from the start to a point
 * @returns {{hazards: Array<{kind:string, first:Date, last:Date}>, minTemp:number|null,
 *   maxTemp:number|null, maxGust:number|null, missing:boolean}}
 *   hazards are in route order; missing is true if some points have no forecast for that time
 */
export function summarizeTrip(points, departAt, secondsTo) {
  const runs = new Map();
  let minTemp = null, maxTemp = null, maxGust = null, missing = false;
  for (const p of points) {
    const eta = new Date(departAt.getTime() + secondsTo(p.along) * 1000);
    const h = hourAt(p.hourly, eta);
    if (!h) { missing = true; continue; }
    if (h.temperature_2m != null) {
      minTemp = minTemp == null ? h.temperature_2m : Math.min(minTemp, h.temperature_2m);
      maxTemp = maxTemp == null ? h.temperature_2m : Math.max(maxTemp, h.temperature_2m);
    }
    if (h.wind_gusts_10m != null) maxGust = Math.max(maxGust ?? 0, h.wind_gusts_10m);
    for (const kind of hazards(h)) {
      const run = runs.get(kind);
      if (run) run.last = eta; else runs.set(kind, { kind, first: eta, last: eta });
    }
  }
  const list = [...runs.values()].sort((a, b) => a.first - b.first);
  return { hazards: list, minTemp, maxTemp, maxGust, missing };
}
