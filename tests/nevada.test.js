import { test } from 'node:test';
import assert from 'node:assert/strict';
import { straightRoute, MI } from './helpers.js';
import { nevadaLevel, parseNevada, alertsOnRoute } from '../js/roads.js';
import { createRouteIndex, pointAlong } from '../js/geo.js';
import { trimNevada } from '../scripts/nevada-trim.mjs';

// Google's polyline encoding, precision 5 (what Nevada 511 uses).
function encode(coords) {
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    let x = v < 0 ? ~(v << 1) : v << 1, s = '';
    while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
    return s + String.fromCharCode(x + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - pLat) + enc(lo - pLon);
    pLat = la; pLon = lo;
  }
  return out;
}

test('Nevada wording maps to the app\'s levels', () => {
  assert.equal(nevadaLevel('Road Closed').level, 'closed');
  assert.equal(nevadaLevel('Holding Traffic').level, 'held');
  assert.equal(nevadaLevel('Chains Required, All Vehicles except 4-wheel drive with Snow tires').level, 'chains');
  assert.equal(nevadaLevel('High Winds - Vehicles over 9 feet Prohibited').short, 'Wind');
  assert.equal(nevadaLevel('Adverse Driving Conditions').level, 'caution');
  assert.equal(nevadaLevel('No Report'), null);
});

test('the published file keeps only roads with something to report', () => {
  const out = trimNevada([
    { Id: 1, 'Overall Status': 'No Report', 'Secondary Conditions': [], RoadwayName: 'I-80', Extra: 'x' },
    { Id: 2, 'Overall Status': 'Road Closed', 'Secondary Conditions': [], RoadwayName: 'SR-431', Extra: 'x' },
    { Id: 3, 'Overall Status': 'No Report', 'Secondary Conditions': ['Wind Alert - Vehicles over 9 feet use caution'] },
  ], new Date('2026-10-27T12:00:00Z'));
  assert.deepEqual(out.conditions.map((c) => c.Id), [2, 3]);
  assert.equal(out.conditions[0].Extra, undefined);
  assert.equal(out.total, 3);
  assert.equal(out.fetchedAt, '2026-10-27T12:00:00.000Z');
});

test('a condition along the route shows as one stretch; a road that only crosses it doesn\'t', () => {
  const route = straightRoute(60);
  const index = createRouteIndex(route, 400);
  const along = [10, 11, 12, 13, 14, 15].map((m) => pointAlong(route, m * MI));
  const [cx, cy] = pointAlong(route, 40 * MI);
  const crossing = [[cx, cy - 0.05], [cx, cy], [cx, cy + 0.05]];   // north–south road crossing at mile 40
  const alerts = parseNevada({ conditions: [
    { Id: 7, 'Overall Status': 'Chains Required, All Vehicles', RoadwayName: 'I-80', LocationDescription: 'from Verdi to Reno',
      EncodedPolyline: [encode(along)], LastUpdated: 1793000000 },
    { Id: 8, 'Overall Status': 'Road Closed', RoadwayName: 'SR-447', EncodedPolyline: [encode(crossing)] },
  ] });
  const on = alertsOnRoute(alerts, route, index);
  assert.equal(on.length, 1);
  assert.equal(on[0].level, 'chains');
  assert.equal(on[0].route, 'I-80');
  assert.ok(on[0].endAlong - on[0].along > 4 * MI);
  assert.equal(on[0].places[0], 'from Verdi to Reno');
});
