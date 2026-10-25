// Places along the route from TomTom's along-route search: gas stations and
// truck stops (and later rest areas), with the detour to each one.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// TomTom's terms don't allow storing results, so nothing here is cached
// beyond the current page; the Overpass loader in stations.js is the backup
// and covers saved trips and offline use.
//
// Each search returns at most 20 places, filled from the start of the stretch
// searched. So a stretch is searched once, and if the answer is full, again
// from the last place found: on a quiet road one search covers it, and busy
// stretches take one more search per 20 or so places. Nothing is skipped, so
// there are no false "no gas" gaps. Only stretches not yet searched are
// searched when your target or position moves.

import { TOMTOM_KEY } from './config.js';
import { createRouteIndex, sliceAlong } from './geo.js';
import { recordProblem } from './problems.js';
import { tomtomHours } from './hours.js';
import { TRUCK_STOP_BRANDS } from './stations.js';

const SEARCH = 'https://api.tomtom.com/search/2/searchAlongRoute';
const LIMIT = 20;                 // TomTom's maximum per search
const MIN_SEARCH_M = 24000;       // search at least this far ahead (about 15 mi), so driving on doesn't search every few seconds
const MAX_SEARCH_M = 250000;      // longest stretch sent in one search
const MIN_ADVANCE_M = 2000;       // if 20+ places sit within this, move on past them
const MAX_DETOUR_S = 600;         // places at most a 10-minute detour away
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
  gas: [{ query: '*', categorySet: `${CATEGORY.gas},${CATEGORY.truckStop}` }],
  // Only while the Truck stop filter is on: in busy stretches the gas search
  // fills up with ordinary stations, so look for truck stops on their own too.
  truckStops: [{ query: '*', categorySet: `${CATEGORY.truckStop}` }],
  restrooms: [{ query: '*', categorySet: `${CATEGORY.restArea},${CATEGORY.truckStop}` }],
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

async function searchStretch(route, from, to, search, attempt = 0, service = 'Gas stations') {
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
    recordProblem(service, safeUrl, err);
    throw new TomTomUnavailable(err.name === 'AbortError' ? 'timed out' : 'no response');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && attempt < RETRIES_429) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    return searchStretch(route, from, to, search, attempt + 1, service);
  }
  if (!res.ok) {
    recordProblem(service, safeUrl, `HTTP ${res.status}`);
    // 403: key refused; 429: over the daily limit; 5xx: TomTom trouble.
    throw new TomTomUnavailable(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.results || [];
}

export const hasCategory = (r, id) => (r.poi?.categorySet || []).some((c) => c.id === id);

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

/** Whether a TomTom result belongs in the restrooms list: rest areas and real truck stops. */
export function isRestroomStop(r) {
  if (hasCategory(r, CATEGORY.restArea)) return true;
  return hasCategory(r, CATEGORY.truckStop) && isFuelStop(r);
}

/** A TomTom result as a restroom stop: a station-shaped object with `kind`. */
export function toRestroomStop(r) {
  const restArea = hasCategory(r, CATEGORY.restArea);
  const st = toStation(r);
  if (restArea) {
    // Rest areas come with names like "Rest Area:" or "Rest Area: Truckee
    // Welcome Center Follow Signs". "Rest Area" stays in the name: it helps
    // tell real rest areas from vista points TomTom files in the same category.
    const name = String(r.poi?.name || '')
      .replace(/\s*follow signs?\s*$/i, '')
      .replace(/[\s:]+$/, '')
      .trim();
    st.name = name || 'Rest area';
    st.subname = null;
    st.amenities = { truckStop: false };
  }
  st.kind = restArea ? 'rest' : 'truck';
  return st;
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

// ---------- Stretches along the route ----------
// Lists of [from, to] in meters along the route, kept sorted and merged.

function addSpan(list, a, b) {
  if (b <= a) return list;
  const out = [];
  let [na, nb] = [a, b];
  for (const [x, y] of list) {
    if (y < na - 1 || x > nb + 1) out.push([x, y]);
    else { na = Math.min(na, x); nb = Math.max(nb, y); }
  }
  out.push([na, nb]);
  return out.sort((p, q) => p[0] - q[0]);
}

/** Parts of [a, b] not in any of `lists`. */
function missingSpans([a, b], ...lists) {
  let parts = [[a, b]];
  for (const list of lists) {
    for (const [x, y] of list) {
      const next = [];
      for (const [p, q] of parts) {
        if (y <= p || x >= q) { next.push([p, q]); continue; }
        if (x > p) next.push([p, x]);
        if (y < q) next.push([y, q]);
      }
      parts = next;
    }
  }
  return parts.filter(([p, q]) => q - p > 1);
}

const overlaps = (list, [a, b]) => list.some(([x, y]) => x < b && y > a);

/**
 * Same interface as createStationLoader in stations.js.
 * onUnavailable(err) is called once if TomTom can't be used, so the caller
 * can switch to the backup loader.
 */
export function createTomTomStationLoader(route, radius, onUpdate, {
  onUnavailable,
  searches = SEARCHES.gas,
  keep = isFuelStop,
  convert = toStation,
  service = 'Gas stations',
} = {}) {
  const [search] = searches;
  const total = route.cumDist[route.cumDist.length - 1];
  const index = createRouteIndex(route, radius);
  const found = new Map();   // id -> station (with along, offRoute)
  let covered = [];          // stretches fully searched
  let busy = [];             // stretches being searched
  let failed = [];           // stretches whose search failed
  let range = [0, 0];
  let extra = [];
  let cancelled = false;
  let unavailable = false;
  let inFlight = 0;

  const wanted = () => [range, ...extra].filter(([a, b]) => b > a);

  function report() {
    if (cancelled || unavailable) return;
    let complete = true, loading = false, anyFailed = false;
    for (const span of wanted()) {
      const left = missingSpans(span, covered);
      if (!left.length) continue;
      complete = false;
      if (left.some((p) => overlaps(failed, p))) anyFailed = true;
      if (left.some((p) => !overlaps(failed, p))) loading = true;
    }
    const stations = mergeStations([...found.values()]).sort((a, b) => a.along - b.along);
    onUpdate({ stations, range: [...range], complete, loading, failed: anyFailed, stale: false });
  }

  function addResults(results) {
    for (const r of results) {
      if (!keep(r)) continue;
      const st = convert(r);
      if (found.has(st.id)) continue;
      const p = index.project([st.lon, st.lat]);
      if (p && p.offRoute <= radius) found.set(st.id, { ...st, along: p.along, offRoute: p.offRoute });
    }
  }

  // Search [a, b], continuing from the last place found while answers are full.
  async function searchSpan(a, b) {
    inFlight++;
    const job = [a, b];
    busy.push(job);
    try {
      let at = a;
      while (at < b - 1) {
        const results = await searchStretch(route, at, b, search, 0, service);
        if (cancelled) return;
        addResults(results);
        let next = b;
        if (results.length >= LIMIT) {
          // Full: the answer reaches as far as its farthest place.
          const reach = Math.max(...results.map((r) => {
            const p = index.project([r.position.lon, r.position.lat]);
            return p ? p.along : at + (r.dist || 0);
          }));
          next = Math.min(b, Math.max(at + MIN_ADVANCE_M, reach - 100));
        }
        covered = addSpan(covered, at, next);
        at = next;
        job[0] = at;
        report();
      }
    } catch (err) {
      if (cancelled) return;
      failed = addSpan(failed, job[0], b);
      if (err instanceof TomTomUnavailable && !unavailable) {
        unavailable = true;
        onUnavailable?.(err);
        return;
      }
    } finally {
      inFlight--;
      busy = busy.filter((j) => j !== job);
    }
    report();
    pump();
  }

  function pump() {
    if (cancelled || unavailable) return;
    for (const span of wanted()) {
      for (const [a, b0] of missingSpans(span, covered, busy, failed)) {
        if (inFlight >= PARALLEL_REQUESTS) return;
        // Search a little past what's needed, so moving on a bit doesn't
        // start a search right away; long stretches go in a few searches.
        let b = Math.min(total, Math.max(b0, a + MIN_SEARCH_M));
        b = Math.min(b, a + MAX_SEARCH_M);
        searchSpan(a, b);
      }
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
      failed = [];
      pump();
      report();
    },
    cancel() { cancelled = true; },
  };
}
