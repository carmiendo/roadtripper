import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePoints, hourAt, hourAtIndex, describe, hazards } from '../js/weather.js';
import { timeAlong } from '../js/geo.js';
import { straightRoute } from './helpers.js';

function hourly(startSec, n, overrides = {}) {
  const h = {
    time: [], temperature_2m: [], precipitation_probability: [], precipitation: [], snowfall: [],
    weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], visibility: [], is_day: [],
  };
  for (let i = 0; i < n; i++) {
    h.time.push(startSec + i * 3600);
    h.temperature_2m.push(10 + i);
    h.precipitation_probability.push(0);
    h.precipitation.push(0);
    h.snowfall.push(0);
    h.weather_code.push(0);
    h.wind_speed_10m.push(10);
    h.wind_gusts_10m.push(20);
    h.visibility.push(20000);
    h.is_day.push(1);
  }
  return Object.assign(h, overrides);
}

test('samplePoints: about every 30 minutes, ending at the destination', () => {
  const route = straightRoute(100);   // 25 m/s, about 1.8 h
  const pts = samplePoints(route);
  assert.equal(pts[0].along, 0);
  assert.equal(pts.at(-1).along, route.cumDist.at(-1));
  const gaps = pts.slice(1, -1).map((p, i) => timeAlong(route, p.along) - timeAlong(route, pts[i].along));
  for (const g of gaps) assert.ok(Math.abs(g - 1800) < 5, `spacing ${g}`);
});

test('samplePoints: long routes are capped at 16 points', () => {
  const route = straightRoute(1500);
  assert.ok(samplePoints(route).length <= 16);
});

test('samplePoints: starts from your position', () => {
  const route = straightRoute(100);
  const pts = samplePoints(route, 40000);
  assert.ok(pts[0].along >= 40000);
});

test('hourAt: nearest hour, null outside the forecast', () => {
  const start = Date.UTC(2026, 9, 20, 0) / 1000;
  const h = hourly(start, 48);
  assert.equal(hourAt(h, new Date((start + 3 * 3600 + 20 * 60) * 1000)).temperature_2m, 13);
  assert.equal(hourAt(h, new Date((start + 3 * 3600 + 40 * 60) * 1000)).temperature_2m, 14);
  assert.equal(hourAt(h, new Date((start - 5 * 3600) * 1000)), null);
  assert.equal(hourAt(h, new Date((start + 60 * 3600) * 1000)), null);
  assert.equal(hourAtIndex(h, 48), null);
});

test('describe: WMO codes', () => {
  assert.equal(describe(0).label, 'Clear');
  assert.equal(describe(73).kind, 'snow');
  assert.equal(describe(66).kind, 'ice');
  assert.equal(describe(95).kind, 'storm');
  assert.equal(describe(null).label, 'Unknown');
});

test('hazards: driving concerns', () => {
  const base = { weather_code: 0, precipitation_probability: 0, snowfall: 0, wind_gusts_10m: 20, visibility: 20000 };
  assert.deepEqual(hazards(base), []);
  assert.deepEqual(hazards({ ...base, weather_code: 63 }), ['rain']);
  assert.deepEqual(hazards({ ...base, precipitation_probability: 70 }), ['rain']);
  assert.deepEqual(hazards({ ...base, weather_code: 73, snowfall: 1 }), ['snow']);
  assert.deepEqual(hazards({ ...base, wind_gusts_10m: 70 }), ['wind']);
  assert.deepEqual(hazards({ ...base, weather_code: 45 }), ['fog']);
  assert.deepEqual(hazards({ ...base, weather_code: 67 }), ['ice']);
  assert.deepEqual(hazards(null), []);
});
