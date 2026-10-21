// Shared test helpers. Copyright (C) 2026 Carmen Jackson. GPL-3.0 (see LICENSE).
import { haversine } from '../js/geo.js';

export const MI = 1609.344;

/** A route through the given [lon, lat] points, densified, with a steady speed. */
export function makeRoute(points, { stepsPerLeg = 20, speed = 25 } = {}) {
  const coords = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    for (let k = 0; k < stepsPerLeg; k++) {
      const t = k / stepsPerLeg;
      coords.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  coords.push(points[points.length - 1]);
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) cumDist.push(cumDist[i - 1] + haversine(coords[i - 1], coords[i]));
  const cumTime = cumDist.map((d) => d / speed);
  return { coords, cumDist, cumTime, distance: cumDist.at(-1), duration: cumTime.at(-1), provider: 'test' };
}

/** A straight east-west route of `miles` along latitude 39. */
export function straightRoute(miles) {
  const degPerMile = 1 / (69.172 * Math.cos((39 * Math.PI) / 180));
  return makeRoute([[-121, 39], [-121 + miles * degPerMile, 39]], { stepsPerLeg: Math.max(20, Math.round(miles)) });
}

/** Stations at the given miles along a route (snapped values filled in directly). */
export function stationsAt(miles) {
  return miles.map((m, i) => ({ id: `n/${i}`, name: `S${i}`, along: m * MI, offRoute: 100 }));
}

/** Minimal in-memory localStorage. */
export function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
  return store;
}
