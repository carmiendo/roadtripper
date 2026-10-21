import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine, decodePolyline, projectToRoute, createRouteIndex, pointAlong, timeAlong, sliceAlong, resampleRoute,
} from '../js/geo.js';
import { makeRoute, straightRoute, MI } from './helpers.js';

test('haversine: SF to LA is about 559 km', () => {
  const d = haversine([-122.4194, 37.7749], [-118.2437, 34.0522]);
  assert.ok(Math.abs(d - 559000) < 3000, `got ${d}`);
});

test('decodePolyline: decodes the Google example at precision 5', () => {
  const coords = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  assert.deepEqual(coords.map(([lon, lat]) => [+lon.toFixed(3), +lat.toFixed(3)]),
    [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});

test('projectToRoute: point beside a straight route', () => {
  const route = straightRoute(100);
  const mid = pointAlong(route, 50 * MI);
  const offset = [mid[0], mid[1] + 1 / 69];   // about a mile north
  const snap = projectToRoute(route, offset);
  assert.ok(Math.abs(snap.along / MI - 50) < 0.1, `along ${snap.along / MI}`);
  assert.ok(Math.abs(snap.offRoute / MI - 1) < 0.05, `off ${snap.offRoute / MI}`);
});

test('createRouteIndex matches projectToRoute on a winding route', () => {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([-122 + i * 0.05, 39 + Math.sin(i / 3) * 0.2]);
  const route = makeRoute(pts, { stepsPerLeg: 10 });
  const radius = 8000;
  const index = createRouteIndex(route, radius);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let checked = 0;
  for (let k = 0; k < 500; k++) {
    const p = [-122 + rand() * 2, 38.7 + rand() * 0.6];
    const full = projectToRoute(route, p);
    if (full.offRoute > radius) continue;
    const fast = index.project(p);
    assert.ok(fast, 'index found nothing for a point within the radius');
    assert.ok(Math.abs(fast.along - full.along) < 1 && Math.abs(fast.offRoute - full.offRoute) < 1);
    checked++;
  }
  assert.ok(checked > 50, `only ${checked} points near the route`);
});

test('createRouteIndex returns null far from the route', () => {
  const route = straightRoute(50);
  assert.equal(createRouteIndex(route, 3000).project([-110, 45]), null);
});

test('pointAlong and timeAlong interpolate and clamp', () => {
  const route = straightRoute(100);
  assert.deepEqual(pointAlong(route, 0), route.coords[0]);
  assert.deepEqual(pointAlong(route, 1e9), route.coords.at(-1));
  assert.ok(Math.abs(timeAlong(route, route.distance / 2) - route.duration / 2) < 1);
});

test('sliceAlong covers exactly the requested stretch', () => {
  const route = straightRoute(100);
  const line = sliceAlong(route, 20 * MI, 30 * MI);
  const len = line.slice(1).reduce((sum, c, i) => sum + haversine(line[i], c), 0);
  assert.ok(Math.abs(len / MI - 10) < 0.05, `length ${len / MI}`);
});

test('resampleRoute includes both ends', () => {
  const route = straightRoute(10);
  const pts = resampleRoute(route, 1000);
  assert.deepEqual(pts[0], route.coords[0]);
  assert.deepEqual(pts.at(-1), route.coords.at(-1));
  assert.ok(pts.length >= 16 && pts.length <= 18);
});
