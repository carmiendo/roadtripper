// Dev site helpers: separate saved data, a log of every request, and
// made-up TomTom answers so nothing uses the real key.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Imported first by app.js. Does nothing outside the dev site.

import { IS_DEV, DEV_SOURCE } from './config.js';

const LOG_MAX = 200;
const log = [];                 // {at, service, url, note, fake}
const listeners = new Set();

/** Requests made since the page opened, newest first. */
export function requestLog() { return log; }
export function onRequestLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function clearRequestLog() { log.length = 0; listeners.forEach((fn) => fn()); }

function serviceOf(url) {
  const u = new URL(url, location.href);
  const h = u.hostname;
  if (h === 'api.tomtom.com') {
    if (u.pathname.includes('searchAlongRoute')) return 'TomTom search';
    if (u.pathname.includes('calculateRoute')) return 'TomTom route';
    if (u.pathname.includes('copyrights')) return 'TomTom copyright';
    return 'TomTom other';
  }
  if (h.includes('overpass') || h === 'maps.mail.ru') return 'Overpass (gas, OSM)';
  if (h.includes('osrm') || h === 'routing.openstreetmap.de') return 'OSRM routing';
  if (h.includes('valhalla')) return 'Valhalla routing';
  if (h === 'api.weather.gov') return u.pathname.startsWith('/points') ? 'NWS zone lookups' : 'NWS alerts';
  if (h === 'api.open-meteo.com') return 'Open-Meteo forecast';
  if (h === 'photon.komoot.io') return 'Photon search';
  if (h === 'nominatim.openstreetmap.org') return 'Nominatim search';
  if (h.includes('dot.ca.gov')) return 'Caltrans';
  if (h.includes('openfreemap') || h === 'unpkg.com') return 'Map tiles and library';
  return h;
}

function record(url, note, fake) {
  log.unshift({ at: Date.now(), service: serviceOf(url), url: String(url).replace(/key=[^&]+/, 'key=…'), note, fake });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  listeners.forEach((fn) => fn());
}

// ---------- Made-up TomTom answers ----------
// Places come from a fixed grid of map cells (about 1.5 km), so the same
// stretch always gives the same places, and overlapping searches agree.
// Like TomTom: at most 20 per search, filled from the start of the stretch.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;   // 0..1
}

const BRANDS = ['Chevron', 'Shell', '76', 'Arco', 'Valero', 'Mobil', 'Exxon', 'Sinclair', 'Circle K', '7-Eleven'];
const TRUCK = ["Love's Travel Stop", 'Pilot Travel Center', 'Flying J Travel Center', 'TA', 'Dev Truck Plaza'];
const CELL_DEG = 0.015;
const RATES = { 7311: 0.18, 7358: 0.012, 7395: 0.01 };   // chance per cell

const meters = ([lon1, lat1], [lon2, lat2]) => {
  const R = 6371008.8, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

function fakeSearch(url, body) {
  const u = new URL(url);
  const cats = (u.searchParams.get('categorySet') || '').split(',').map(Number);
  const maxDetour = Number(u.searchParams.get('maxDetourTime')) || 900;
  const limit = Number(u.searchParams.get('limit')) || 20;
  const pts = (body?.route?.points || []).map((p) => [p.lon, p.lat]);
  const results = [];
  const seen = new Set();
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) along += meters(pts[i - 1], pts[i]);
    // Walk each segment in ~500 m steps so no cell is skipped.
    const steps = i ? Math.max(1, Math.ceil(meters(pts[i - 1], pts[i]) / 500)) : 1;
    for (let s = 1; s <= steps; s++) {
      const t = i ? s / steps : 1;
      const [lon, lat] = i
        ? [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]
        : pts[0];
      const cell = `${Math.floor(lon / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`;
      for (const cat of cats) {
        const id = `${cat}:${cell}`;
        if (seen.has(id) || !(cat in RATES)) continue;
        seen.add(id);
        if (hash(id) > RATES[cat]) continue;
        const detour = 60 + Math.floor(hash(`${id}d`) * 720);   // 1–13 min
        if (detour > maxDetour) continue;
        const name = cat === 7311 ? BRANDS[Math.floor(hash(`${id}b`) * BRANDS.length)]
          : cat === 7358 ? TRUCK[Math.floor(hash(`${id}b`) * TRUCK.length)]
            : `Dev Rest Area ${cell.replace(',', '-')}`;
        const h24 = hash(`${id}h`) < 0.6;
        results.push({
          id: `dev-${id}`,
          position: { lat: lat + (hash(`${id}y`) - 0.5) * 0.004, lon: lon + (hash(`${id}x`) - 0.5) * 0.004 },
          poi: {
            name,
            brands: cat === 7395 ? undefined : [{ name }],
            categorySet: [{ id: cat }],
            openingHours: { mode: 'nextSevenDays', timeRanges: openRanges(h24) },
          },
          address: { municipality: 'Devtown' },
          dist: along,
          detourTime: detour,
          detourDistance: Math.round(detour * 8),
          vehicleTypes: cat === 7358 ? ['Car', 'Truck'] : ['Car'],
        });
      }
    }
  }
  return { summary: { numResults: Math.min(limit, results.length) }, results: results.slice(0, limit) };
}

function openRanges(always) {
  const day = (d) => {
    const x = new Date(); x.setDate(x.getDate() + d);
    return x.toISOString().slice(0, 10);
  };
  if (always) return [{ startTime: { date: day(0), hour: 0, minute: 0 }, endTime: { date: day(7), hour: 0, minute: 0 } }];
  return Array.from({ length: 7 }, (_, d) => ({
    startTime: { date: day(d), hour: 6, minute: 0 },
    endTime: { date: day(d), hour: 22, minute: 0 },
  }));
}

// A TomTom-shaped route from a real OSRM route, with 10% made-up traffic.
async function fakeRoute(url, realFetch) {
  const m = new URL(url).pathname.match(/calculateRoute\/([-\d.]+),([-\d.]+):([-\d.]+),([-\d.]+)/);
  const [, lat1, lon1, lat2, lon2] = m;
  const osrm = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}` +
    '?overview=full&geometries=geojson&annotations=duration&steps=false';
  record(osrm, 'for a made-up TomTom route', false);
  const data = await (await realFetch(osrm)).json();
  const r = data.routes[0];
  const coords = r.geometry.coordinates;
  const dur = r.legs[0].annotation.duration;
  const instructions = [{ pointIndex: 0, travelTimeInSeconds: 0 }];
  let t = 0;
  for (let i = 0; i < dur.length; i++) {
    t += dur[i] * 1.1;
    if ((i + 1) % 50 === 0 || i === dur.length - 1) instructions.push({ pointIndex: i + 1, travelTimeInSeconds: Math.round(t) });
  }
  return {
    routes: [{
      summary: { lengthInMeters: r.distance, travelTimeInSeconds: Math.round(t), trafficDelayInSeconds: Math.round(t - r.duration) },
      legs: [{ points: coords.map(([lon, lat]) => ({ latitude: lat, longitude: lon })) }],
      guidance: { instructions },
    }],
  };
}

const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

if (IS_DEV) {
  // Keep the dev site's saved trips, settings, and caches apart from the live app's.
  for (const name of ['getItem', 'setItem', 'removeItem']) {
    const orig = Storage.prototype[name];
    Storage.prototype[name] = function (key, ...rest) {
      const k = String(key);
      return orig.call(this, k.startsWith('dev:') ? k : `dev:${k}`, ...rest);
    };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    let host = '';
    try { host = new URL(url, location.href).hostname; } catch { /* relative */ }
    if (host === location.hostname || !host) return realFetch(input, init);
    if (host === 'api.tomtom.com') {
      const body = init.body ? JSON.parse(init.body) : null;
      const pts = body?.route?.points?.length;
      if (DEV_SOURCE !== 'fake') {
        record(url, 'not sent (OpenStreetMap mode)', true);
        return new Response('{}', { status: 403 });
      }
      record(url, pts ? `${pts} route points, made-up answer` : 'made-up answer', true);
      await new Promise((r) => setTimeout(r, 250));   // feel like a real request
      if (url.includes('searchAlongRoute')) return json(fakeSearch(url, body));
      if (url.includes('calculateRoute')) return json(await fakeRoute(url, realFetch));
      if (url.includes('copyrights')) return json({ copyrightsCaption: '©TomTom (made-up dev data)' });
      return new Response('{}', { status: 404 });
    }
    record(url, '', false);
    return realFetch(input, init);
  };

  document.documentElement.dataset.dev = DEV_SOURCE;
  document.title = 'Roadtripper (dev)';
}
