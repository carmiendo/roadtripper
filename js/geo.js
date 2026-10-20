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

// ---------- Route helpers ----------
// A route has coords [lon, lat][], cumDist[] (m), cumTime[] (s); see routing.js.

const M_PER_DEG_LAT = 111320;

/**
 * Snap a point to the route.
 * @returns {{along:number, offRoute:number, index:number}}
 *   along: meters from route start to the snapped point
 *   offRoute: straight-line meters from the point to the route
 *   index: route segment the point snapped to
 * @param {number} [fromIndex] only consider segments at or after this index
 */
export function projectToRoute(route, [lon, lat], fromIndex = 0) {
  const kx = M_PER_DEG_LAT * Math.cos(toRad(lat));
  const ky = M_PER_DEG_LAT;
  const { coords, cumDist } = route;
  let best = { along: 0, offRoute: Infinity, index: 0 };
  for (let i = Math.max(0, fromIndex); i < coords.length - 1; i++) {
    const ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky;
    const bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.offRoute) {
      best = { along: cumDist[i] + t * (cumDist[i + 1] - cumDist[i]), offRoute: d, index: i };
    }
  }
  return best;
}

function segmentAt(cum, value) {
  // Last index i with cum[i] <= value (binary search).
  let lo = 0, hi = cum.length - 1;
  if (value <= cum[0]) return 0;
  if (value >= cum[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= value) lo = mid; else hi = mid;
  }
  return lo;
}

/** Coordinate at a distance along the route. */
export function pointAlong(route, along) {
  const { coords, cumDist } = route;
  const i = segmentAt(cumDist, along);
  const span = cumDist[i + 1] - cumDist[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (along - cumDist[i]) / span)) : 0;
  return [
    coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
    coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
  ];
}

/** Seconds from route start to a distance along the route. */
export function timeAlong(route, along) {
  const { cumDist, cumTime } = route;
  const i = segmentAt(cumDist, along);
  const span = cumDist[i + 1] - cumDist[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (along - cumDist[i]) / span)) : 0;
  return cumTime[i] + t * (cumTime[i + 1] - cumTime[i]);
}

/** Route coordinates between two distances along it, for drawing a stretch. */
export function sliceAlong(route, from, to) {
  const { coords, cumDist } = route;
  const out = [pointAlong(route, from)];
  for (let i = 0; i < coords.length; i++) {
    if (cumDist[i] > from && cumDist[i] < to) out.push(coords[i]);
  }
  out.push(pointAlong(route, to));
  return out;
}

/** Points along the route spaced about `spacing` meters apart (start and end included). */
export function resampleRoute(route, spacing) {
  const out = [];
  const total = route.cumDist[route.cumDist.length - 1];
  for (let d = 0; d < total; d += spacing) out.push(pointAlong(route, d));
  out.push(route.coords[route.coords.length - 1]);
  return out;
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
