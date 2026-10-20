// Roadtripper entry point.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Planned modules (one per data source, so each can be swapped independently):
//   js/routing.js   OSRM, with Valhalla fallback; Google Routes later
//   js/geocode.js   Photon address search
//   js/stations.js  Overpass gas stations, detours via routing.js
//   js/weather.js   Open-Meteo forecasts, NWS alerts
//   js/map.js       MapLibre with OpenFreeMap tiles
//   js/settings.js  units, tank range, gap threshold, brands (stored in the browser)

function init() {
  const status = document.getElementById('status');
  if (status) status.textContent = "Route planning isn't built yet.";
}

init();
