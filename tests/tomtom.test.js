import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tomtomToRoute } from '../js/routing.js';
import { timeAlong } from '../js/geo.js';

// A straight 3-point route with a slow first half (traffic) and a fast second half.
const sample = {
  summary: { lengthInMeters: 20000, travelTimeInSeconds: 1500, trafficDelayInSeconds: 600 },
  legs: [{ points: [
    { latitude: 39, longitude: -121.0 }, { latitude: 39, longitude: -120.8843 }, { latitude: 39, longitude: -120.7686 },
  ] }],
  guidance: { instructions: [
    { pointIndex: 0, travelTimeInSeconds: 0 },
    { pointIndex: 1, travelTimeInSeconds: 1200 },   // 10 km in 20 min
    { pointIndex: 2, travelTimeInSeconds: 1500 },   // 10 km in 5 min
  ] },
};

test('tomtomToRoute: times follow the turn-by-turn timings, not an average speed', () => {
  const r = tomtomToRoute(sample);
  assert.equal(r.provider, 'TomTom');
  assert.equal(r.duration, 1500);
  assert.equal(r.trafficDelay, 600);
  assert.deepEqual(r.cumTime, [0, 1200, 1500]);
  const half = r.cumDist[1] / 2;
  assert.ok(Math.abs(timeAlong(r, half) - 600) < 1);
});

test('tomtomToRoute: works without instructions (even spread)', () => {
  const r = tomtomToRoute({ ...sample, guidance: undefined });
  assert.ok(Math.abs(r.cumTime[1] - 750) < 5);
  assert.equal(r.cumTime[2], 1500);
});
