// Geometry helpers.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in meters between [lon, lat] points. */
export function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Decode a Google-style encoded polyline. Returns [lon, lat] pairs. */
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}
