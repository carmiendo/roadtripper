import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCaltrans, districtsFor, alertsOnRoute } from '../js/roads.js';
import { createRouteIndex, pointAlong } from '../js/geo.js';
import { makeRoute, MI } from './helpers.js';

const record = (index, status, { lat = 39.3, lon = -120.4, direction = 'East', route = 'I-80', inService = 'true', place = 'Soda Springs' } = {}) => ({
  cc: {
    index,
    location: { district: '3', latitude: String(lat), longitude: String(lon), direction, route, nearbyPlace: place },
    inService,
    statusData: { status, statusDescription: `desc ${status}`, statusTimestamp: { statusDate: '2026-10-20', statusTime: '21:15:00' } },
  },
});

test('parseCaltrans keeps what matters for a car', () => {
  const alerts = parseCaltrans({ data: [
    record('a', 'R-0'), record('b', 'R-2'), record('c', 'TTA'), record('d', 'RC'),
    record('e', 'R-1 MODIFIED'), record('f', 'R-3', { inService: 'false' }), record('g', 'Not Reported'),
  ] });
  assert.deepEqual(alerts.map((a) => [a.code, a.level, a.short]),
    [['R-2', 'chains', 'R2'], ['RC', 'closed', 'Closed'], ['R-1 MODIFIED', 'chains', 'R1']]);
  assert.equal(alerts[0].place, 'Soda Springs');
  assert.equal(alerts[0].since.getHours(), 21);
});

test('districtsFor: SF to Reno crosses District 3 (and 4 has none)', () => {
  const pts = [[-122.4, 37.8], [-121.5, 38.6], [-120.3, 39.3], [-119.8, 39.5]];
  const d = districtsFor(pts);
  assert.ok(d.includes(3));
  assert.ok(!d.includes(4));
});

test('districtsFor: outside California returns nothing', () => {
  assert.deepEqual(districtsFor([[-110, 40], [-105, 39]]), []);
});

test('alertsOnRoute: direction of travel, distance along, and merging', () => {
  const route = makeRoute([[-121.0, 39.3], [-119.8, 39.3]], { stepsPerLeg: 200 });   // heading east
  const index = createRouteIndex(route, 400);
  const at = (miles) => pointAlong(route, miles * MI);
  const [l1, t1] = at(20), [l2, t2] = at(22), [l3, t3] = at(40), [l4, t4] = at(30);
  const alerts = parseCaltrans({ data: [
    record('east1', 'R-2', { lon: l1, lat: t1, place: 'Kingvale' }),
    record('east2', 'R-2', { lon: l2, lat: t2, place: 'Soda Springs' }),
    record('west', 'R-2', { lon: l4, lat: t4, direction: 'West' }),           // other side of the road
    record('far', 'RC', { lon: l3, lat: t3 + 0.05 }),                          // ~5 km off the route
    record('close', 'RC', { lon: l3, lat: t3 }),
  ] });
  const on = alertsOnRoute(alerts, route, index);
  assert.deepEqual(on.map((a) => a.code), ['R-2', 'RC']);
  assert.deepEqual(on[0].places, ['Kingvale', 'Soda Springs']);
  assert.ok(Math.abs(on[0].along / MI - 20) < 0.2);
  assert.ok(Math.abs(on[0].endAlong / MI - 22) < 0.2);
});
