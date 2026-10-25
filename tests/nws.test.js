import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.js';

installLocalStorage();

// Two points in California (Truckee, Sacramento) and one in Nevada (Reno).
const POINTS = [
  { lat: 39.3277, lon: -120.1833, along: 1000 },
  { lat: 38.5816, lon: -121.4944, along: 2000 },
  { lat: 39.5296, lon: -119.8138, along: 3000 },
];
const ZONES = {
  '39.3277': { state: 'CA', fz: 'CAZ072', county: 'CAC057' },
  '38.5816': { state: 'CA', fz: 'CAZ017', county: 'CAC067' },
  '39.5296': { state: 'NV', fz: 'NVZ003', county: 'NVC031' },
};
const square = (lon, lat, d = 0.2) => ({
  type: 'Polygon',
  coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
});
const ALERTS = {
  CA: [
    // Zone-based: covers Truckee's forecast zone.
    { properties: { id: 'wsw', event: 'Winter Storm Warning', severity: 'Severe', geocode: { UGC: ['CAZ072', 'CAZ071'] } }, geometry: null },
    // Outline-based: a box around Sacramento.
    { properties: { id: 'svr', event: 'Severe Thunderstorm Warning', severity: 'Severe', geocode: { UGC: ['CAC067'] } }, geometry: square(-121.49, 38.58) },
    // Outline elsewhere, though its county code matches Sacramento: the outline wins.
    { properties: { id: 'far', event: 'Flood Warning', severity: 'Moderate', geocode: { UGC: ['CAC067'] } }, geometry: square(-118, 34) },
    // Somewhere else entirely.
    { properties: { id: 'coast', event: 'Coastal Flood Advisory', severity: 'Minor', geocode: { UGC: ['CAZ006'] } }, geometry: null },
  ],
  NV: [
    { properties: { id: 'wind', event: 'Wind Advisory', severity: 'Moderate', geocode: { UGC: ['NVZ003'] } }, geometry: null },
  ],
};

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  const pm = url.match(/\/points\/([-\d.]+),/);
  if (pm) {
    const z = ZONES[pm[1]];
    return {
      ok: true,
      json: async () => ({ properties: {
        relativeLocation: { properties: { state: z.state } },
        forecastZone: `https://api.weather.gov/zones/forecast/${z.fz}`,
        county: `https://api.weather.gov/zones/county/${z.county}`,
      } }),
    };
  }
  const am = url.match(/area=(\w+)/);
  return { ok: true, json: async () => ({ features: ALERTS[am[1]] || [] }) };
};

const { fetchAlerts } = await import('../js/weather.js');

beforeEach(() => { calls.length = 0; });

test('alerts come from one request per state and match by outline or zone', async () => {
  localStorage.clear();
  const { alerts, covered } = await fetchAlerts(POINTS);
  assert.equal(covered, true);
  assert.deepEqual(alerts.map((a) => a.id).sort(), ['svr', 'wind', 'wsw']);
  assert.deepEqual(alerts.find((a) => a.id === 'wsw').alongs, [1000]);
  assert.deepEqual(alerts.find((a) => a.id === 'svr').alongs, [2000]);
  assert.equal(calls.filter((u) => u.includes('/points/')).length, 3);
  assert.equal(calls.filter((u) => u.includes('/alerts/')).length, 2);   // CA and NV
});

test('zone lookups are cached, so a repeat trip needs only the state requests', async () => {
  await fetchAlerts(POINTS);
  assert.equal(calls.filter((u) => u.includes('/points/')).length, 0);
  assert.equal(calls.length, 2);
});
