# Roadtripper

A web app for two road-trip tasks:

- **Gas ahead.** Type how far ahead you want to stop (say, 50 miles) and see the closest stations before and after that point, how far off the route each one is, and how long the detour takes. Get warned about the last station before a long stretch with none.
- **Weather ahead.** See the forecast at points along the route for the time you'll actually reach them, plus National Weather Service alerts and California chain controls.

Live at [roadtripper.quest](https://roadtripper.quest).

## Status

Routing, gas stations ahead, weather and road conditions along the route, home-screen install, and offline use are working. Next: Nevada road conditions.

## Features

1. Gas stations around a target distance ahead: the 5 closest before and after it
2. Distance off route and detour time for each station, with directions
3. Warnings for long stretches with no gas, highlighted on the map
4. Weather at your arrival time at points along the route, with NWS alerts
5. Settings: color, units (miles/km, °F/°C), max distance off route, gap warning length
6. Recent destinations and a results-first layout for use on the road
7. Installable to the home screen (Chrome: menu → Add to Home screen / Install app)
8. Works offline: reopens your last trip (route, stations, detours, forecasts) and map areas you viewed
9. While driving: the map follows you, and a pinned bar shows the next gas station and whether it's the last before a gap
10. Opening hours at your arrival time (in the station's time zone); closed stations don't count for gap warnings
11. Amenity badges and filters: restrooms, store, food, truck stop
12. Compare the weather for leaving now vs. 1–4 hours later
13. California chain controls and closures ahead on the route (Caltrans)
14. Recent problems log in Settings, with a copy button for bug reports

Planned: traffic-aware drive times.

## Data sources

All free and used without API keys:

| Purpose | Service |
|---|---|
| Routing | [OSRM](https://project-osrm.org/) (project and [FOSSGIS](https://routing.openstreetmap.de/) servers), with [Valhalla](https://valhalla.github.io/valhalla/) as fallback |
| Address search | [Photon](https://photon.komoot.io/) |
| Gas stations | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (OpenStreetMap), several public servers |
| Weather | [Open-Meteo](https://open-meteo.com/) |
| Weather alerts | [National Weather Service API](https://www.weather.gov/documentation/services-web-api) |
| Chain controls | [Caltrans CWWP2](https://cwwp2.dot.ca.gov/) |
| Map | [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) tiles |

Map and station data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). Weather data by Open-Meteo.com, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). App icon based on the 🚙 emoji from [Twemoji](https://github.com/jdecked/twemoji), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Running locally

Plain HTML, CSS, and JavaScript with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Location access works on `localhost` and on HTTPS sites.

## Tests

Tests use Node's built-in test runner (Node 20 or later), with nothing to install:

```sh
npm test
```

They cover the route math, gap warnings, the stations picked around your target, opening hours, amenities, weather sampling and hazards, chain controls, saved trips, settings, the problem log, and the offline and preload file lists. GitHub runs them on every push.

## Deployment

GitHub Pages, deployed from the root of the `main` branch. `.nojekyll` turns off Jekyll processing.

## License

Copyright (C) 2026 Carmen Jackson

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3. See [LICENSE](LICENSE).
