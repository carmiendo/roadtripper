// Places along the route from TomTom's along-route search: gas stations and
// truck stops (and later rest areas), with the detour to each one.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// TomTom's terms don't allow storing results, so nothing here is cached
// beyond the current page; the Overpass loader in stations.js is the backup
// and covers saved trips and offline use.
//
// Each search returns at most 20 places, nearest detour first. To avoid
// missing places (which would show up as false "no gas" gaps), the route is
// searched in 25 km segments, and a segment that comes back full is split in
// half and searched again, down to about 6 km. A piece that's still full has
// 20+ places in a few km, so nothing missing there can make a gap.

import { TOMTOM_KEY } from './config.js';
import { createRouteIndex, sliceAlong } from './geo.js';
import { recordProblem } from './problems.js';
import { tomtomHours } from './hours.js';
import { TRUCK_STOP_BRANDS } from './stations.js';

const SEARCH = 'https://api.tomtom.com/search/2/searchAlongRoute';
const LIMIT = 20;                 // TomTom's maximum per search
const SEGMENT_M = 25000;
const MIN_PIECE_M = 6000;         // stop splitting full answers below this
const MAX_DETOUR_S = 900;         // places at most a 15-minute detour away
const MAX_POINTS = 400;           // route points sent per search
const PARALLEL_REQUESTS = 3;
const TIMEOUT_MS = 15000;
const SPACING_MS = 300;           // about 3 searches a second
const RETRIES_429 = 3;            // "too many requests": wait and try again

export const CATEGORY = { gas: 7311, truckStop: 7358, restArea: 7395 };

// What to search for, by kind. "*" with a category means "everything in that
// category"; words narrow it to names that match ("gas station" finds only a
// few stations with "Gas" in their names and misses the big brands).
export const SEARCHES = {
  gas: [
    { query: '*', categorySet: `${CATEGORY.gas},${CATEGORY.truckStop}` },
    { query: '*', categorySet: `${CATEGORY.truckStop}` },
  ],
};

/** Thrown when TomTom can't be used right now (no key, refused, offline). */
export class TomTomUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'TomTomUnavailable';
  }
}

// Every nth point, so long stretches stay under MAX_POINTS (first and last kept).
function thin(coords) {
  if (coords.length <= MAX_POINTS) return coords;
  const step = (coords.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => coords[Math.round(i * step)]);
}

// Spaces searches evenly: TomTom allows 5 a second, but bursts get refused.
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + SPACING_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function searchStretch(route, from, to, search, attempt = 0) {
  await slot();
  const { query, categorySet } = search;
  const points = thin(sliceAlong(route, from, to)).map(([lon, lat]) => ({ lat, lon }));
  const params = new URLSearchParams({
    key: TOMTOM_KEY,
    maxDetourTime: String(MAX_DETOUR_S),
    limit: String(LIMIT),
    categorySet,
    openingHours: 'nextSevenDays',
  });
  const url = `${SEARCH}/${encodeURIComponent(query)}.json?${params}`;
  const safeUrl = url.replace(/key=[^&]+/, 'key=…');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: { points } }),
      signal: ctrl.signal,
    });
  } catch (err) {
    recordProblem('Gas stations', safeUrl, err);
    throw new TomTomUnavailable(err.name === 'AbortError' ? 'timed out' : 'no response');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && attempt < RETRIES_429) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    return searchStretch(route, from, to, search, attempt + 1);
  }
  if (!res.ok) {
    recordProblem('Gas stations', safeUrl, `HTTP ${res.status}`);
    // 403: key refused; 429: over the daily limit; 5xx: TomTom trouble.
    throw new TomTomUnavailable(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.results || [];
}

/**
 * All places in a stretch, splitting it while answers come back full.
 * @returns {Promise<object[]>} TomTom results
 */
export async function searchAll(route, from, to, search) {
  const results = await searchStretch(route, from, to, search);
  if (results.length < LIMIT || to - from <= MIN_PIECE_M) return results;
  const mid = (from + to) / 2;
  const [a, b] = await Promise.all([searchAll(route, from, mid, search), searchAll(route, mid, to, search)]);
  return [...a, ...b];
}

const hasCategory = (r, id) => (r.poi?.categorySet || []).some((c) => c.id === id);

/** A TomTom result as a station (same shape as stations.js, plus `detour`). */
export function toStation(r) {
  const poi = r.poi || {};
  const brand = poi.brands?.[0]?.name || null;
  const name = brand || poi.name || 'Gas station';
  const hoursParsed = tomtomHours(poi.openingHours?.timeRanges);
  const truckStop = hasCategory(r, CATEGORY.truckStop) ||
    (r.vehicleTypes || []).includes('Truck') ||
    TRUCK_STOP_BRANDS.test(brand || poi.name || '');
  return {
    id: `tt/${r.id}`,
    lat: r.position.lat,
    lon: r.position.lon,
    name,
    subname: poi.name && poi.name !== name ? poi.name : null,
    brand,
    place: r.address?.municipality || r.address?.streetName || null,
    open24: Boolean(hoursParsed?.always),
    hours: null,
    hoursParsed,
    amenities: { truckStop },
    detour: Number.isFinite(r.detourTime)
      ? { distance: r.detourDistance || 0, duration: r.detourTime }
      : null,
  };
}

// TomTom's truck-stop category also holds unrelated businesses (truck
// interiors, repair shops). Keep a truck-stop-only listing when its name
// sounds like somewhere to fill up.
const FUEL_NAME = /truck ?stop|travel (center|centre|plaza|stop)|plaza|fuel|gas|diesel|petro|oil\b|cardlock/i;

/** Whether a TomTom result belongs in the gas list. */
export function isFuelStop(r) {
  if (hasCategory(r, CATEGORY.gas)) return true;
  const name = r.poi?.brands?.[0]?.name || r.poi?.name || '';
  return FUEL_NAME.test(name) || TRUCK_STOP_BRANDS.test(name);
}

const GENERIC = new Set(['truck', 'trucks', 'stop', 'stops', 'travel', 'center', 'centre', 'plaza',
  'station', 'fuel', 'food', 'mart', 'market', 'shop', 'store', 'auto', 'service', 'services', 'and', 'the']);
const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !GENERIC.has(w)) || []);
const sameBusiness = (a, b) => {
  const wa = words(`${a.name} ${a.subname || ''}`);
  return [...words(`${b.name} ${b.subname || ''}`)].some((w) => wa.has(w));
};

/**
 * Merge stations found twice, by id or by being the same stop listed as both a
 * gas station and a truck stop (within 150 m, sharing a name). The first
 * listing wins and keeps the truck-stop flag.
 */
export function mergeStations(list) {
  const out = [];
  const byId = new Map();
  for (const s of list) {
    if (byId.has(s.id)) continue;
    const twin = out.find((o) => Math.abs(o.lat - s.lat) < 0.0014 && Math.abs(o.lon - s.lon) < 0.0018 &&
      (o.amenities.truckStop || s.amenities.truckStop) && sameBusiness(o, s));
    if (twin) {
      twin.amenities.truckStop = true;
      if (!twin.detour && s.detour) twin.detour = s.detour;
      byId.set(s.id, twin);
      continue;
    }
    const copy = { ...s, amenities: { ...s.amenities } };
    out.push(copy);
    byId.set(s.id, copy);
  }
  return out;
}

/**
 * Same interface as createStationLoader in stations.js.
 * onUnavailable(err) is called once if TomTom can't be used, so the caller
 * can switch to the backup loader.
 */
export function createTomTomStationLoader(route, radius, onUpdate, { onUnavailable, searches = SEARCHES.gas } = {}) {
  const total = route.cumDist[route.cumDist.length - 1];
  const lastSeg = Math.floor(Math.max(0, total - 1) / SEGMENT_M);
  const index = createRouteIndex(route, radius);
  const segs = new Map();   // seg -> {status: 'ok'|'pending'|'failed', raw}
  let range = [0, 0];
  let extra = [];
  let cancelled = false;
  let unavailable = false;
  let inFlight = 0;

  const segsIn = ([from, to]) => {
    const out = [];
    for (let k = Math.max(0, Math.floor(from / SEGMENT_M)); k <= Math.min(lastSeg, Math.floor(to / SEGMENT_M)); k++) out.push(k);
    return out;
  };
  const wantedSegs = () => [...new Set([...extra.flatMap(segsIn), ...segsIn(range)])].sort((a, b) => a - b);

  function report() {
    if (cancelled || unavailable) return;
    let complete = true, loading = false, failed = false;
    const raw = [];
    for (const k of wantedSegs()) {
      const seg = segs.get(k);
      if (seg?.status === 'ok') raw.push(...seg.raw);
      else {
        complete = false;
        if (!seg || seg.status === 'pending') loading = true;
        else failed = true;
      }
    }
    const stations = [];
    for (const st of mergeStations(raw)) {
      const p = index.project([st.lon, st.lat]);
      if (p && p.offRoute <= radius) stations.push({ ...st, along: p.along, offRoute: p.offRoute });
    }
    stations.sort((a, b) => a.along - b.along);
    onUpdate({ stations, range: [...range], complete, loading, failed, stale: false });
  }

  async function fetchSeg(k) {
    inFlight++;
    const from = k * SEGMENT_M;
    const to = Math.min(total, from + SEGMENT_M);
    try {
      const lists = await Promise.all(searches.map((s) => searchAll(route, from, to, s)));
      if (cancelled) return;
      segs.set(k, { status: 'ok', raw: lists.flat().filter(isFuelStop).map(toStation) });
    } catch (err) {
      if (cancelled) return;
      segs.set(k, { status: 'failed', raw: [] });
      if (err instanceof TomTomUnavailable && !unavailable) {
        unavailable = true;
        onUnavailable?.(err);
        return;
      }
    } finally {
      inFlight--;
    }
    report();
    pump();
  }

  function pump() {
    if (cancelled || unavailable) return;
    const missing = wantedSegs().filter((k) => !segs.has(k));
    while (inFlight < PARALLEL_REQUESTS && missing.length) {
      const k = missing.shift();
      segs.set(k, { status: 'pending', raw: [] });
      fetchSeg(k);
    }
  }

  return {
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
