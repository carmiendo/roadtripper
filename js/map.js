// Map display: MapLibre GL JS with OpenFreeMap tiles.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// The rest of the app only calls createMap() and the returned methods, so the
// map library can be swapped without touching anything else.

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ROUTE_SOURCE = 'route';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function markerEl(kind) {
  const el = document.createElement('div');
  el.className = `map-marker map-marker--${kind}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// ---------- Loading the map library ----------
// MapLibre is large (about 800 KB), so it loads only when a map is needed, or
// quietly in the background once the start screen is up (preloadMap).

const LIB = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
let libPromise = null;

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${LIB}.css`;
    document.head.append(css);
    const script = document.createElement('script');
    script.src = `${LIB}.js`;
    script.async = true;
    script.onload = () => (window.maplibregl ? resolve() : reject(new Error('Map library missing')));
    script.onerror = () => { libPromise = null; reject(new Error("Map library didn't load")); };
    document.head.append(script);
  });
  return libPromise;
}

/** Start downloading the map library without showing a map. */
export function preloadMap() {
  loadMapLibre().catch(() => {});
}

const METHODS = ['showRoute', 'clear', 'refreshColors', 'showStations', 'showGaps', 'showPosition', 'follow', 'stopFollowing', 'showRoadAlerts'];

/**
 * A map in `container`. Returns right away; calls made before the library
 * has loaded are applied once it has.
 */
export function createMap(container) {
  container.classList.add('map--loading');
  const real = loadMapLibre().then(
    () => { container.classList.remove('map--loading'); return createMapNow(container); },
    () => {
      container.classList.remove('map--loading');
      container.classList.add('map--unavailable');
      container.textContent = "The map couldn't load. Route details are still shown below.";
      return null;
    },
  );
  return Object.fromEntries(METHODS.map((name) => [name, async (...args) => {
    const m = await real;
    return m ? m[name](...args) : undefined;
  }]));
}

function createMapNow(container) {

  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [-98.5, 39.5],   // continental US
    zoom: 3,
    attributionControl: { compact: true },
    cooperativeGestures: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  const ready = new Promise((resolve) => {
    if (map.loaded()) resolve(); else map.once('load', resolve);
  });
  let markers = [];

  async function showRoute(route) {
    await ready;
    following = false;
    lastPosition = null;
    recenterButton.hidden = true;
    const data = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.coords },
    };
    const existing = map.getSource(ROUTE_SOURCE);
    if (existing) {
      existing.setData(data);
    } else {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': cssVar('--route') || '#0b6b3a', 'line-width': 5 },
      });
    }

    markers.forEach((m) => m.remove());
    const start = route.coords[0];
    const end = route.coords[route.coords.length - 1];
    markers = [
      new maplibregl.Marker({ element: markerEl('start') }).setLngLat(start).addTo(map),
      new maplibregl.Marker({ element: markerEl('end') }).setLngLat(end).addTo(map),
    ];

    const bounds = route.coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(start, start),
    );
    routeBounds = bounds;
    map.fitBounds(bounds, { padding: 40, duration: 0 });
  }

  function clear() {
    markers.forEach((m) => m.remove());
    markers = [];
    stationMarkers.forEach((m) => m.remove());
    stationMarkers = [];
    if (map.getLayer('gap-line')) map.removeLayer('gap-line');
    if (map.getSource('gaps')) map.removeSource('gaps');
    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getLayer('route-casing')) map.removeLayer('route-casing');
    if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  }

  let stationMarkers = [];
  let positionMarker = null;

  let targetMarker = null;
  let routeBounds = null;

  /**
   * Numbered markers for stations, matching the order of the gas list.
   * @param {Array<[number, number]>} coords
   * @param {{target?: [number, number]|null, fit?: boolean, onSelect?: (index:number) => void}} options
   */
  async function showStations(coords, { target = null, fit = false, onSelect } = {}) {
    await ready;
    stationMarkers.forEach((m) => m.remove());
    stationMarkers = coords.map((c, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'map-station';
      el.textContent = String(i + 1);
      el.setAttribute('aria-label', `Station ${i + 1}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); onSelect?.(i); });
      return new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map);
    });

    targetMarker?.remove();
    targetMarker = null;
    if (target) {
      const el = document.createElement('div');
      el.className = 'map-target';
      el.setAttribute('aria-hidden', 'true');
      targetMarker = new maplibregl.Marker({ element: el }).setLngLat(target).addTo(map);
    }

    if (fit && coords.length && !following) {
      const points = target ? [...coords, target] : coords;
      const bounds = points.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(points[0], points[0]));
      map.fitBounds(bounds, { padding: 50, maxZoom: 13, duration: 0 });
      wholeRouteButton.hidden = false;
    }
  }

  // "Whole route" control, shown when the map is zoomed to stations.
  const wholeRouteButton = document.createElement('button');
  wholeRouteButton.type = 'button';
  wholeRouteButton.className = 'map-whole-route';
  wholeRouteButton.textContent = 'Whole route';
  wholeRouteButton.hidden = true;
  wholeRouteButton.addEventListener('click', () => {
    stopFollowing();
    if (routeBounds) map.fitBounds(routeBounds, { padding: 40, duration: 0 });
    wholeRouteButton.hidden = true;
  });
  container.append(wholeRouteButton);

  // ---------- Following your position ----------
  // While driving, the map keeps you in view. Panning or zooming yourself
  // pauses that; "Recenter" turns it back on.

  const FOLLOW_ZOOM = 12;
  let following = false;
  let lastPosition = null;

  const recenterButton = document.createElement('button');
  recenterButton.type = 'button';
  recenterButton.className = 'map-recenter';
  recenterButton.textContent = 'Recenter';
  recenterButton.hidden = true;
  recenterButton.addEventListener('click', () => {
    following = true;
    recenterButton.hidden = true;
    if (lastPosition) map.easeTo({ center: lastPosition, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), duration: 600 });
  });
  container.append(recenterButton);

  const userMoved = (e) => {
    if (!e.originalEvent || !following) return;   // ignore moves the app made
    following = false;
    recenterButton.hidden = !lastPosition;
  };
  map.on('dragstart', userMoved);
  map.on('zoomstart', userMoved);
  map.on('rotatestart', userMoved);

  /** Keep `coord` in view (if following). The first call turns following on. */
  async function follow(coord) {
    await ready;
    const first = lastPosition === null;
    lastPosition = coord;
    if (first) following = true;
    if (!following) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.easeTo({
      center: coord,
      zoom: first ? Math.max(map.getZoom(), FOLLOW_ZOOM) : map.getZoom(),
      duration: reduce ? 0 : 800,
    });
    wholeRouteButton.hidden = false;
  }

  function stopFollowing() {
    following = false;
    recenterButton.hidden = !lastPosition;
  }

  let roadMarkers = [];

  /** Chain control and closure points: [{coord, short, level}]. */
  async function showRoadAlerts(list) {
    await ready;
    roadMarkers.forEach((m) => m.remove());
    roadMarkers = list.map(({ coord, short, level }) => {
      const el = document.createElement('div');
      el.className = `map-road map-road--${level}`;
      el.textContent = short;
      el.setAttribute('aria-hidden', 'true');
      return new maplibregl.Marker({ element: el }).setLngLat(coord).addTo(map);
    });
  }

  /** Highlight stretches with no gas. */
  async function showGaps(lines) {
    await ready;
    const data = {
      type: 'FeatureCollection',
      features: lines.map((coordinates) => ({
        type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates },
      })),
    };
    const source = map.getSource('gaps');
    if (source) { source.setData(data); return; }
    map.addSource('gaps', { type: 'geojson', data });
    map.addLayer({
      id: 'gap-line',
      type: 'line',
      source: 'gaps',
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': cssVar('--warn-line') || '#d97706', 'line-width': 5, 'line-dasharray': [1.2, 1] },
    });
  }

  /** Your current position on the route, or null to hide it. */
  async function showPosition(coord) {
    await ready;
    if (!coord) { positionMarker?.remove(); positionMarker = null; return; }
    if (!positionMarker) {
      const el = document.createElement('div');
      el.className = 'map-you';
      el.setAttribute('aria-hidden', 'true');
      positionMarker = new maplibregl.Marker({ element: el }).setLngLat(coord).addTo(map);
    } else {
      positionMarker.setLngLat(coord);
    }
  }

  async function refreshColors() {
    await ready;
    if (map.getLayer('route-line')) {
      map.setPaintProperty('route-line', 'line-color', cssVar('--route'));
    }
  }

  return { showRoute, clear, refreshColors, showStations, showGaps, showPosition, follow, stopFollowing, showRoadAlerts };
}
