import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, straightRoute } from './helpers.js';

installLocalStorage();
const { saveTrip, loadTrip, clearTrip } = await import('../js/trip-store.js');

function trip(departAt = new Date()) {
  return {
    route: straightRoute(50),
    from: { label: 'Here', lat: 39, lon: -121 },
    to: { label: 'There', lat: 39, lon: -120 },
    departAt,
    fromHere: true,
  };
}

beforeEach(() => localStorage.clear());

test('saveTrip and loadTrip round-trip the trip', () => {
  const t = trip();
  assert.equal(saveTrip(t, { detours: new Map([['n/1', { distance: 500, duration: 60 }]]) }), true);
  const saved = loadTrip();
  assert.equal(saved.trip.to.label, 'There');
  assert.equal(saved.trip.fromHere, true);
  assert.equal(saved.trip.departAt.getTime(), t.departAt.getTime());
  assert.equal(saved.trip.route.coords.length, t.route.coords.length);
  assert.deepEqual(saved.detours.get('n/1'), { distance: 500, duration: 60 });
});

test('saved forecast keeps only hours the trip can use', () => {
  const now = Math.floor(Date.now() / 3600000) * 3600;
  const time = Array.from({ length: 16 * 24 }, (_, i) => now - 6 * 3600 + i * 3600);
  const weather = { fetchedAt: Date.now(), alerts: { alerts: [] }, points: [{ along: 0, hourly: { time, temperature_2m: time.map(() => 5) } }] };
  saveTrip(trip(), { weather });
  const kept = loadTrip().weather.points[0].hourly.time;
  assert.ok(kept.length < 40, `kept ${kept.length} hours`);
  assert.ok(kept[0] >= now - 3600);
});

test('an old, finished trip is not reopened', () => {
  saveTrip(trip(new Date(Date.now() - 3 * 24 * 3600 * 1000)));
  const raw = JSON.parse(localStorage.getItem('roadtripper.lastTrip.v1'));
  raw.savedAt = Date.now() - 3 * 24 * 3600 * 1000;
  localStorage.setItem('roadtripper.lastTrip.v1', JSON.stringify(raw));
  assert.equal(loadTrip(), null);
});

test('clearTrip removes it', () => {
  saveTrip(trip());
  clearTrip();
  assert.equal(loadTrip(), null);
});
