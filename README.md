# Roadtripper

A web app for two road-trip tasks:

- **Gas ahead.** Find stations within a distance window ahead on your route, see how far off the route each one is and how long the detour takes, and get warned about the last station before a long stretch with none.
- **Weather ahead.** See the forecast at points along the route for the time you'll actually reach them, plus National Weather Service alerts.

Live at [roadtripper.quest](https://roadtripper.quest).

## Status

Routing, gas stations ahead, and weather along the route are working. Next: phone layout refinements and offline support.

## Planned features

1. Gas stations in a distance window ahead (for example, 40–80 miles), sorted by distance along the route
2. Distance off route and actual detour (extra miles and minutes) for each station
3. Last station before a gap longer than a set threshold
4. Brand filter
5. Weather at your arrival time along the route, with NWS alerts
6. Weather for towns along the route
7. Settings: units (miles/km, °F/°C), tank range, gap threshold, maximum detour, preferred brands
8. Phone layout for use on the road, laptop layout for planning
9. Offline caching of the last route and forecasts

## Data sources

All free and used without API keys:

| Purpose | Service |
|---|---|
| Routing | [OSRM](https://project-osrm.org/), with [Valhalla](https://valhalla.github.io/valhalla/) as fallback |
| Address search | [Photon](https://photon.komoot.io/) |
| Gas stations | [Overpass API](https://overpass-api.de/) (OpenStreetMap) |
| Weather | [Open-Meteo](https://open-meteo.com/) |
| Weather alerts | [National Weather Service API](https://www.weather.gov/documentation/services-web-api) |
| Map | [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) tiles |

Map and station data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). Weather data by Open-Meteo.com, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Running locally

Plain HTML, CSS, and JavaScript with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Location access works on `localhost` and on HTTPS sites.

## Deployment

GitHub Pages, deployed from the root of the `main` branch. `.nojekyll` turns off Jekyll processing.

## License

Copyright (C) 2026 Carmen Jackson

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3. See [LICENSE](LICENSE).
