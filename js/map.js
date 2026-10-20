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

export function createMap(container) {
  if (!window.maplibregl) {
    container.classList.add('map--unavailable');
    container.textContent = "The map couldn't load. Route details are still shown below.";
    return { showRoute() {}, clear() {}, refreshColors() {} };
  }

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
    map.fitBounds(bounds, { padding: 40, duration: 0 });
  }

  function clear() {
    markers.forEach((m) => m.remove());
    markers = [];
    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getLayer('route-casing')) map.removeLayer('route-casing');
    if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  }

  async function refreshColors() {
    await ready;
    if (map.getLayer('route-line')) {
      map.setPaintProperty('route-line', 'line-color', cssVar('--route'));
    }
  }

  return { showRoute, clear, refreshColors };
}
