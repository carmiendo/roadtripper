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
import { recordProblem } from './problems.js';

// Public Overpass servers (see wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const SEGMENT_M = 25000;           // route cut into 25 km segments, one bounding box each
const SEGMENTS_PER_REQUEST = 4;    // up to ~100 km of route per request
const PARALLEL_REQUESTS = 2;
const HEDGE_AFTER_MS = 5000;       // start another server if no answer by then
const REQUEST_TIMEOUT_MS = 25000;
const CACHE_KEY = 'roadtripper.stations.v3';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_STALE_OK_MS = 14 * 24 * 60 * 60 * 1000;   // use old data if every server fails
const CACHE_ROUTES = 5;

let preferred = 0;   // server that answered last; tried first next time

async function postOverpass(url, query, signal) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Overpass reports its own timeouts inside a 200 response.
  if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) throw new Error('server busy');
  return data;
}

/**
 * Send a query to several servers, staggered: start the next server when one
 * fails or hasn't answered within HEDGE_AFTER_MS. First good answer wins.
 */
function overpass(query) {
  const order = [...ENDPOINTS.keys()].map((k) => (k + preferred) % ENDPOINTS.length);
  return new Promise((resolve, reject) => {
    const controllers = [];
    const errors = [];
    let started = 0;
    let finished = 0;
    let done = false;
    let hedgeTimer = null;

    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (done || started >= order.length) return;
      const idx = order[started++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      postOverpass(ENDPOINTS[idx], query, ctrl.signal)
        .then((data) => {
          if (done) return;
          done = true;
          preferred = idx;
          controllers.forEach((c) => c !== ctrl && c.abort());
          resolve(data);
        })
        .catch((err) => {
          if (done) return;   // another server already answered; this one was cancelled
          recordProblem('Gas stations', ENDPOINTS[idx], err);
          errors.push(err.name === 'AbortError' ? 'timed out' : err.message);
          finished++;
          if (started < order.length) startNext();
          else if (finished === started) { done = true; reject(new Error(errors.join('; '))); }
        })
        .finally(() => clearTimeout(timer));
      hedgeTimer = setTimeout(startNext, HEDGE_AFTER_MS);
    };
    startNext();
  });
}

// Bounding box of one route segment, padded by `radius`.
function segmentBox(route, seg, radius) {
  const from = seg * SEGMENT_M;
  const to = from + SEGMENT_M;
  const { coords, cumDist } = route;
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const next = cumDist[i + 1] ?? Infinity;
    if (next < from) continue;
    if (cumDist[i] > to) break;
    const [lon, lat] = coords[i];
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon].map((v) => v.toFixed(4)).join(',');
}

// Overpass answers bbox queries from its spatial index, much faster than "around".
function segmentsQuery(route, segs, radius) {
  const parts = segs.map((seg) => `nwr["amenity"="fuel"](${segmentBox(route, seg, radius)});`);
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
 * Loads gas stations for just the part of the route you ask for.
 *
 *   const loader = createStationLoader(route, radius, onUpdate);
 *   loader.setRange(from, to);   // meters along the route; call again as it changes
 *   loader.retry();              // try failed segments again
 *
 * The route is cut into 25 km segments; only segments overlapping the range
 * are requested, and loaded segments are kept (and cached in this browser),
 * so moving the range forward only fetches what's new.
 *
 * onUpdate({stations, range, complete, loading, failed, stale}):
 *   stations  stations in loaded segments (range and extra stretches), sorted along the route
 *   range     [from, to] that was asked for
 *   complete  every segment in the range is loaded
 *   loading   some segments in the range are still being fetched
 *   failed    true if some segments in the range couldn't be loaded
 *   stale     true if some segments are older saved data (servers didn't answer)
 */
export function createStationLoader(route, radius, onUpdate) {
  const total = route.cumDist[route.cumDist.length - 1];
  const lastSeg = Math.floor(Math.max(0, total - 1) / SEGMENT_M);
  const index = createRouteIndex(route, radius);
  const key = cacheKey(route, radius);
  const saved = readCache(key);           // {at, segs: {seg: raw[]}} or null
  const segs = new Map();                 // seg -> {status: 'ok'|'pending'|'failed', raw, stale}
  let range = [0, 0];
  let extra = [];            // more stretches to load, e.g. just ahead of you
  let cancelled = false;
  let inFlight = 0;

  const freshSaved = saved && Date.now() - saved.at < CACHE_MAX_AGE_MS;
  if (freshSaved) {
    for (const [seg, raw] of Object.entries(saved.segs)) segs.set(Number(seg), { status: 'ok', raw, stale: false });
  }

  const segsIn = ([from, to]) => {
    const out = [];
    for (let k = Math.max(0, Math.floor(from / SEGMENT_M)); k <= Math.min(lastSeg, Math.floor(to / SEGMENT_M)); k++) out.push(k);
    return out;
  };

  // Segments to load: the main range plus any extra stretches, nearest first.
  const wantedSegs = () => [...new Set([...extra.flatMap(segsIn), ...segsIn(range)])].sort((a, b) => a - b);

  function report() {
    if (cancelled) return;
    const wanted = wantedSegs();
    const raw = new Map();
    let complete = true, loading = false, failed = false, stale = false;
    for (const k of wanted) {
      const seg = segs.get(k);
      if (seg?.status === 'ok') {
        for (const st of seg.raw) raw.set(st.id, st);
        if (seg.stale) stale = true;
      } else {
        complete = false;
        if (!seg || seg.status === 'pending') loading = true;
        else failed = true;
      }
    }
    const stations = [];
    for (const st of raw.values()) {
      const p = index.project([st.lon, st.lat]);
      if (p && p.offRoute <= radius) stations.push({ ...st, along: p.along, offRoute: p.offRoute });
    }
    stations.sort((a, b) => a.along - b.along);
    onUpdate({ stations, range: [...range], complete, loading, failed, stale });
  }

  function save() {
    const out = {};
    for (const [k, seg] of segs) if (seg.status === 'ok' && !seg.stale) out[k] = seg.raw;
    writeCache(key, out);
  }

  async function fetchGroup(group) {
    inFlight++;
    try {
      const data = await overpass(segmentsQuery(route, group, radius));
      const raw = (data.elements || []).map(toStation).filter(Boolean);
      // A station is filed under every segment it's in; duplicates merge by id later.
      for (const k of group) segs.set(k, { status: 'ok', raw, stale: false });
      save();
    } catch {
      for (const k of group) {
        const old = saved?.segs?.[k];
        segs.set(k, old ? { status: 'ok', raw: old, stale: true } : { status: 'failed', raw: [] });
      }
    } finally {
      inFlight--;
    }
    report();
    pump();
  }

  // Start requests for missing segments, nearest first, a few at a time.
  function pump() {
    if (cancelled) return;
    const missing = wantedSegs().filter((k) => !segs.has(k));
    while (inFlight < PARALLEL_REQUESTS && missing.length) {
      const group = [];
      while (missing.length && group.length < SEGMENTS_PER_REQUEST &&
        (!group.length || missing[0] === group[group.length - 1] + 1)) {
        group.push(missing.shift());
      }
      for (const k of group) segs.set(k, { status: 'pending', raw: [] });
      fetchGroup(group);
    }
  }

  return {
    /**
     * @param {number} from
     * @param {number} to
     * @param {{also?: Array<[number, number]>}} [opts] extra stretches to load
     */
    setRange(from, to, { also = [] } = {}) {
      range = [Math.max(0, from), Math.min(total, to)];
      extra = also.map(([a, b]) => [Math.max(0, a), Math.min(total, b)]);
      pump();
      report();
    },
    retry() {
      for (const k of wantedSegs()) if (segs.get(k)?.status === 'failed') segs.delete(k);
      pump();
      report();
    },
    cancel() { cancelled = true; },
  };
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
    if (!hit || Date.now() - hit.at > CACHE_STALE_OK_MS) return null;
    return hit;   // {at, segs}
  } catch {
    return null;
  }
}

function writeCache(key, segsObj) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[key] = { at: all[key]?.at && Object.keys(all[key].segs || {}).length ? all[key].at : Date.now(), segs: segsObj };
    if (!Object.keys(segsObj).length) delete all[key];
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
export function findGaps(stations, route, threshold, from = 0, until = Infinity, { leading = true } = {}) {
  const total = route.cumDist[route.cumDist.length - 1];
  const end = Math.min(total, until);   // only judge the part of the route that's loaded
  const gaps = [];
  let prev = null;
  let prevAlong = from;
  for (const s of stations) {
    if (s.along < from) { prev = s; continue; }
    if (s.along > end) break;
    // A gap before the first station counts only if `from` is where you are;
    // otherwise there may be stations just before the searched range.
    if ((prev || leading) && s.along - prevAlong > threshold) {
      gaps.push({ start: prevAlong, end: s.along, length: s.along - prevAlong, lastStation: prev });
    }
    prev = s;
    prevAlong = s.along;
  }
  if (end >= total && (prev || leading) && end - prevAlong > threshold) {
    gaps.push({ start: prevAlong, end, length: end - prevAlong, lastStation: prev, toEnd: true });
  } else if (end < total && prev && end - prevAlong > threshold) {
    // Runs past the searched range; it's at least this long.
    gaps.push({ start: prevAlong, end, length: end - prevAlong, lastStation: prev, open: true });
  }
  return gaps;
}

/**
 * The stations closest to a target distance ahead: up to `perSide` before it
 * (nearest the target last) and up to `perSide` past it, within `range`.
 * @param {Array} stations sorted by `along`
 * @param {{from:number, target:number, range:[number, number], perSide:number}} opts
 *   from: your position along the route; target: meters ahead of `from`
 */
export function pickAroundTarget(stations, { from, target, range, perSide }) {
  const [start, end] = range;
  const ahead = stations.filter((s) => s.along >= Math.max(from, start) && s.along <= end);
  return {
    before: ahead.filter((s) => s.along - from <= target).slice(-perSide),
    after: ahead.filter((s) => s.along - from > target).slice(0, perSide),
  };
}

/**
 * The first station ahead of `from` (more than `minAhead` meters on), or null.
 * Also says whether it's the last one before a gap from `gaps`.
 */
export function nextStation(stations, from, gaps = [], minAhead = 150) {
  const next = stations.find((s) => s.along > from + minAhead) || null;
  if (!next) return null;
  const gap = gaps.find((g) => g.lastStation?.id === next.id) || null;
  return { station: next, distance: next.along - from, gapAfter: gap };
}
