import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, formatDuration, formatMarker, toUnit, fromUnit } from '../js/format.js';
import { MI } from './helpers.js';

test('formatDistance: one decimal under 10, whole numbers above, no trailing .0', () => {
  assert.equal(formatDistance(2 * MI), '2 mi');
  assert.equal(formatDistance(0.45 * MI), '0.5 mi');
  assert.equal(formatDistance(123.4 * MI), '123 mi');
  assert.equal(formatDistance(5000, 'km'), '5 km');
  assert.equal(formatDistance(5500, 'km'), '5.5 km');
});

test('formatDuration: long and compact forms', () => {
  assert.equal(formatDuration(45 * 60), '45 min');
  assert.equal(formatDuration(2 * 3600), '2 hr');
  assert.equal(formatDuration(3.5 * 3600), '3 hr 30 min');
  assert.equal(formatDuration(3.5 * 3600, { compact: true }), '3h 30m');
});

test('formatMarker and unit conversion', () => {
  assert.equal(formatMarker(212 * MI), 'mile 212');
  assert.equal(formatMarker(341000, 'km'), 'km 341');
  assert.ok(Math.abs(toUnit(fromUnit(50, 'mi'), 'mi') - 50) < 1e-9);
  assert.equal(fromUnit(80, 'km'), 80000);
});
