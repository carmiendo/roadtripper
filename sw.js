// Roadtripper service worker: keeps the app and recently viewed map tiles on
// the device so the app opens and shows your saved trip without a signal.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// How updates work: the app's own files are served from the device first
// (fast, works offline) and refreshed in the background, so a new version
// shows up the next time you open the app. Bump VERSION only when the list
// of cached files changes or a cache's format changes.

const VERSION = 'v2';
const SHELL_CACHE = `shell-${VERSION}`;   // the app's own files
const LIB_CACHE = `libs-${VERSION}`;      // pinned libraries and map style files
const TILE_CACHE = `tiles-${VERSION}`;    // map tiles you've viewed
const MAX_TILES = 3000;                   // roughly 100–200 MB at most

// Saved at install so the app works offline right after the first visit.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/config.js',
  'js/format.js',
  'js/gas.js',
  'js/geo.js',
  'js/geocode.js',
  'js/hours.js',
  'js/location.js',
  'js/map.js',
  'js/problems.js',
  'js/recent.js',
  'js/roads.js',
  'js/roads-panel.js',
  'js/routing.js',
  'js/settings.js',
  'js/stations.js',
  'js/trip-store.js',
  'js/weather-panel.js',
  'js/weather.js',
  'icons/favicon.svg',
  'icons/favicon-32-v2.png',
  'icons/icon-192-v2.png',
  'icons/icon-maskable-192-v2.png',
];
const LIBS = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Cache what we can; a missing file shouldn't block the install.
    await Promise.all(SHELL.map((url) => shell.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    const libs = await caches.open(LIB_CACHE);
    await Promise.all(LIBS.map((url) => libs.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, LIB_CACHE, TILE_CACHE]);
    for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, req.mode === 'navigate'));
  } else if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req, LIB_CACHE));   // pinned versions never change
  } else if (url.hostname === 'tiles.openfreemap.org') {
    if (/\.(pbf|mvt|png|jpg|webp)$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, TILE_CACHE, { trim: MAX_TILES }));
    } else {
      event.respondWith(staleWhileRevalidate(event, LIB_CACHE));   // style, sprites, fonts
    }
  }
  // Everything else (routing, stations, weather, search) goes straight to the
  // network; the app saves what it needs from those itself.
});

async function staleWhileRevalidate(event, cacheName, isNavigation = false) {
  const cache = await caches.open(cacheName);
  const req = event.request;
  const key = isNavigation ? new URL('./', self.location).href : req;
  const cached = await cache.match(key, { ignoreSearch: isNavigation });
  const refresh = fetch(req, isNavigation ? undefined : { cache: 'no-cache' })
    .then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  try {
    return await refresh;
  } catch {
    if (isNavigation) {
      const fallback = await cache.match('index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

let trimming = false;
async function cacheFirst(req, cacheName, { trim } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
      if (trim && !trimming) {
        trimming = true;
        trimCache(cache, trim).finally(() => { trimming = false; });
      }
    }
    return res;
  } catch {
    return Response.error();
  }
}

// Drop the oldest entries once a cache grows past `max` (keys are in insertion order).
async function trimCache(cache, max) {
  const keys = await cache.keys();
  const extra = keys.length - max;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}
