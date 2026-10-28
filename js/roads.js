// Road conditions along the route: California chain controls from Caltrans,
// and Nevada road conditions from Nevada 511.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Each source turns its own data into the same RoadAlert shape.
//
// RoadAlert:
//   id, source ('Caltrans' | 'Nevada 511'), lat, lon
//   code      status code, e.g. 'R-2'
//   level     how serious for a passenger car: 'closed' | 'held' | 'chains' | 'caution'
//   short     badge text, e.g. 'R2', 'Closed'
//   title     plain-language summary
//   detail    the agency's own description
//   route     e.g. 'I-80'; direction e.g. 'East'
//   place     nearby town or location name
//   since     when the status last changed (Date) or null

import { recordProblem } from './problems.js';
import { decodePolyline, haversine } from './geo.js';

const CALTRANS = 'https://cwwp2.dot.ca.gov/data';
const TIMEOUT_MS = 15000;
const CACHE_KEY = 'roadtripper.roads.v1';
const FRESH_MS = 5 * 60 * 1000;            // refetch a district after 5 minutes
const STALE_OK_MS = 24 * 60 * 60 * 1000;   // offline: show saved data up to a day old

// Rough bounding boxes [south, west, north, east] of Caltrans districts that
// have mountain passes with chain controls. Generous on purpose: fetching an
// extra district costs little, missing one would hide a chain control.
const DISTRICTS = {
  1: [38.6, -124.5, 42.1, -122.6],
  2: [39.5, -123.8, 42.1, -119.9],
  3: [38.2, -122.6, 40.3, -119.8],
  6: [35.6, -121.3, 37.8, -117.8],
  7: [33.6, -119.6, 35.0, -117.5],
  8: [33.3, -118.1, 35.9, -114.1],
  9: [35.0, -119.7, 38.8, -115.5],
  10: [36.8, -121.7, 39.0, -119.1],
  11: [32.5, -117.7, 33.6, -114.4],
};

// Caltrans status codes that matter for a passenger car (truck-only codes are skipped).
const CODES = {
  'RC': { level: 'closed', short: 'Closed', title: 'Road closed' },
  'ROAD CLOSED': { level: 'closed', short: 'Closed', title: 'Road closed' },
  'HT': { level: 'held', short: 'Held', title: 'All traffic held at the chain checkpoint' },
  'ESC': { level: 'held', short: 'Escort', title: 'CHP escorting all traffic' },
  'R-3': { level: 'chains', short: 'R3', title: 'Chains required on all vehicles, no exceptions' },
  'R-2': { level: 'chains', short: 'R2', title: 'Chains required unless 4WD/AWD with snow tires on all wheels' },
  'R-1 MODIFIED': { level: 'chains', short: 'R1', title: 'Chains or snow tires required unless 4WD/AWD' },
  'R-1': { level: 'chains', short: 'R1', title: 'Chains or snow tires required unless 4WD/AWD' },
  'VM': { level: 'caution', short: 'Metered', title: 'Traffic metered at the chain checkpoint' },
  'W': { level: 'caution', short: 'Snow', title: 'No restrictions; watch for snow on the road' },
};
export const LEVEL_ORDER = { closed: 0, held: 1, chains: 2, caution: 3 };

// ---------- Nevada ----------
// Nevada 511 allows 10 requests a minute for the whole key, so the deploy
// workflow fetches its road conditions every 15 minutes with the key kept
// secret, and publishes just the ones that aren't "No Report" with the site,
// as data/nevada.json. The app reads that file.

const NEVADA_URL = 'data/nevada.json';
const NEVADA_BOX = [35.0, -120.1, 42.1, -114.0];   // [south, west, north, east], generous
const NEVADA_SAMPLE_M = 800;   // a point every 800 m along each condition's road

/** How Nevada 511's wording maps to the app's levels, most serious first. */
export function nevadaLevel(status) {
  const s = String(status || '');
  if (/closed/i.test(s)) return { level: 'closed', short: 'Closed' };
  if (/holding traffic|traffic (is )?held|escort/i.test(s)) return { level: 'held', short: 'Held' };
  if (/chain|traction|snow tires/i.test(s)) {
    return { level: 'chains', short: 'Chains' };
  }
  if (/over 9 feet prohibited/i.test(s)) return { level: 'caution', short: 'Wind' };
  if (/wind/i.test(s)) return { level: 'caution', short: 'Wind' };
  if (/snow|ice|icy|slush|blowing|visibility|fog|adverse|caution|flood|rock/i.test(s)) return { level: 'caution', short: 'Caution' };
  return null;   // "No Report", dry, normal
}

/** Nevada 511 road conditions to RoadAlerts: one per point along each affected road. */
export function parseNevada(json) {
  const out = [];
  for (const c of json?.conditions || []) {
    const status = String(c['Overall Status'] || '').trim();
    const secondary = [].concat(c['Secondary Conditions'] || []).filter(Boolean);
    const primary = nevadaLevel(status);
    const text = primary ? status : secondary.find(nevadaLevel);
    if (!text) continue;
    const info = primary || nevadaLevel(text);
    const lines = [].concat(c.EncodedPolyline || []).filter(Boolean).map((p) => decodePolyline(p, 5));
    let span = 0;
    let k = 0;
    const base = {
      source: 'Nevada 511',
      code: `NV:${status}`,
      ...info,
      title: text,
      detail: [status, ...secondary].filter((x, i, a) => x && a.indexOf(x) === i).join('. '),
      route: String(c.RoadwayName || '').trim(),
      direction: '',
      place: String(c.LocationDescription || '').trim().replace(/^From /, 'from '),
      since: Number.isFinite(c.LastUpdated) ? new Date(c.LastUpdated * 1000) : null,
    };
    const points = [];
    for (const line of lines) {
      let sinceLast = Infinity;
      for (let i = 0; i < line.length; i++) {
        if (i) { const d = haversine(line[i - 1], line[i]); span += d; sinceLast += d; }
        if (sinceLast >= NEVADA_SAMPLE_M || i === line.length - 1) {
          points.push(line[i]);
          sinceLast = 0;
        }
      }
    }
    for (const [lon, lat] of points) out.push({ ...base, id: `nv/${c.Id}/${k++}`, lat, lon, span });
  }
  return out;
}

const inNevada = ([lon, lat]) =>
  lat >= NEVADA_BOX[0] && lat <= NEVADA_BOX[2] && lon >= NEVADA_BOX[1] && lon <= NEVADA_BOX[3];

async function fetchNevada() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NEVADA_URL, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { alerts: parseNevada(json), fetchedAt: json.fetchedAt ? Date.parse(json.fetchedAt) : Date.now() };
  } catch (err) {
    recordProblem('Nevada road conditions', NEVADA_URL, err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Districts whose box any of the points fall in. */
export function districtsFor(points) {
  const out = new Set();
  for (const [lon, lat] of points) {
    for (const [d, [s, w, n, e]] of Object.entries(DISTRICTS)) {
      if (lat >= s && lat <= n && lon >= w && lon <= e) out.add(Number(d));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function caltransTime(date, time) {
  if (!date || !time || /not reported/i.test(date + time)) return null;
  // Pacific time; close enough to show "since 9:40 PM".
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Caltrans chain control records to RoadAlerts (only ones that matter for a car). */
export function parseCaltrans(json) {
  const out = [];
  for (const item of json?.data || []) {
    const cc = item.cc || item;
    if (String(cc.inService) === 'false') continue;
    const sd = cc.statusData || {};
    const code = String(sd.status || '').trim().toUpperCase();
    const info = CODES[code];
    if (!info) continue;   // R-0, Not Reported, truck-only codes
    const loc = cc.location || {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      id: `caltrans/${cc.index}`,
      source: 'Caltrans',
      lat, lon,
      code,
      ...info,
      detail: sd.statusDescription || '',
      route: loc.route || '',
      direction: loc.direction || '',
      place: loc.nearbyPlace || loc.locationName || '',
      since: caltransTime(sd.statusTimestamp?.statusDate, sd.statusTimestamp?.statusTime),
    });
  }
  return out;
}

// ---------- Fetching with a per-district cache ----------

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function writeCache(all) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch { /* full or unavailable */ }
}

async function fetchDistrict(d) {
  const url = `${CALTRANS}/d${d}/cc/ccStatusD${String(d).padStart(2, '0')}.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 404) return [];   // this district publishes no chain controls
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCaltrans(await res.json());
  } catch (err) {
    recordProblem('Chain controls', url, err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current California chain controls for the districts a route passes through.
 * @param {Array<[number, number]>} points [lon, lat] along the route
 * @returns {Promise<{alerts: RoadAlert[], checkedAt: Date|null, covered: boolean, failed: boolean, stale: boolean}>}
 *   covered: the route enters an area with chain controls; checkedAt: oldest data shown
 */
export async function loadRoadAlerts(points, { force = false } = {}) {
  const districts = districtsFor(points);
  const nevada = points.some(inNevada);
  if (!districts.length && !nevada) return { alerts: [], checkedAt: null, covered: false, failed: false, stale: false };
  const cache = readCache();
  const now = Date.now();
  let failed = false;
  let stale = false;
  let oldest = now;
  const alerts = [];
  await Promise.all(districts.map(async (d) => {
    const hit = cache[d];
    if (!force && hit && now - hit.at < FRESH_MS) {
      alerts.push(...hit.alerts.map(revive));
      oldest = Math.min(oldest, hit.at);
      return;
    }
    try {
      const list = await fetchDistrict(d);
      cache[d] = { at: Date.now(), alerts: list };
      alerts.push(...list);
    } catch {
      if (hit && now - hit.at < STALE_OK_MS) {
        alerts.push(...hit.alerts.map(revive));
        oldest = Math.min(oldest, hit.at);
        stale = true;
      } else {
        failed = true;
      }
    }
  }));
  if (nevada) {
    const hit = cache.NV;
    if (!force && hit && now - hit.at < FRESH_MS) {
      alerts.push(...hit.alerts.map(revive));
      oldest = Math.min(oldest, hit.dataAt ?? hit.at);
    } else {
      try {
        const { alerts: list, fetchedAt } = await fetchNevada();
        cache.NV = { at: Date.now(), dataAt: fetchedAt, alerts: list };
        alerts.push(...list);
        oldest = Math.min(oldest, fetchedAt);
      } catch {
        if (hit && now - hit.at < STALE_OK_MS) {
          alerts.push(...hit.alerts.map(revive));
          oldest = Math.min(oldest, hit.dataAt ?? hit.at);
          stale = true;
        } else {
          failed = true;
        }
      }
    }
  }
  writeCache(cache);
  return { alerts, checkedAt: new Date(oldest), covered: true, failed, stale };
}

const revive = (a) => ({ ...a, since: a.since ? new Date(a.since) : null });

// ---------- Matching to the route ----------

const BEARINGS = { North: 0, East: 90, South: 180, West: 270 };

function bearing([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/**
 * Alerts on the route in your direction of travel, sorted by distance along it.
 * Nearby signs with the same status on the same road are merged into one.
 * @param {Array} alerts RoadAlerts
 * @param {object} route
 * @param {{project: Function}} index from createRouteIndex(route, radius)
 * @param {number} [maxOff] meters from the route a sign may be
 */
export function alertsOnRoute(alerts, route, index, maxOff = 400) {
  const hits = [];
  for (const a of alerts) {
    const snap = index.project([a.lon, a.lat]);
    if (!snap || snap.offRoute > maxOff) continue;
    const want = BEARINGS[a.direction];
    if (want != null) {
      const i = snap.index;
      const heading = bearing(route.coords[i], route.coords[Math.min(i + 1, route.coords.length - 1)]);
      const diff = Math.abs(((heading - want + 540) % 360) - 180);
      if (diff > 75) continue;   // sign faces the other direction of travel
    }
    hits.push({ ...a, along: snap.along });
  }
  hits.sort((x, y) => x.along - y.along);

  const merged = [];
  for (const h of hits) {
    // The latest stretch with the same status on the same road, even if another
    // road's alert came in between.
    const last = merged.findLast((m) => m.code === h.code && m.route === h.route);
    if (last && h.along - last.endAlong < 16000) {
      last.endAlong = h.along;
      if (!last.places.includes(h.place) && h.place) last.places.push(h.place);
    } else {
      merged.push({ ...h, endAlong: h.along, places: h.place ? [h.place] : [] });
    }
  }
  // A Nevada road that only crosses the route (a closed side road, say) touches
  // it at a point or two; keep only ones that run along it for a while.
  return merged.filter((m) => m.source !== 'Nevada 511' || m.endAlong - m.along >= Math.min(1000, (m.span || 0) * 0.5));
}
