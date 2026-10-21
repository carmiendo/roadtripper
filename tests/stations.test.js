import { test } from 'node:test';
import * as stationsModule from '../js/stations.js';
import assert from 'node:assert/strict';
import { findGaps, pickAroundTarget, nextStation } from '../js/stations.js';
import { straightRoute, stationsAt, MI } from './helpers.js';

const at = (list) => list.map((s) => Math.round(s.along / MI));
const miles = (gaps) => gaps.map((g) => [Math.round(g.start / MI), Math.round(g.end / MI)]);

test('findGaps: finds stretches longer than the threshold', () => {
  const route = straightRoute(200);
  const st = stationsAt([10, 30, 100, 120, 165]);
  const gaps = findGaps(st, route, 50 * MI);
  assert.deepEqual(miles(gaps), [[30, 100]]);
  assert.equal(gaps[0].lastStation.name, 'S1');
});

test('findGaps: gap to the destination is flagged', () => {
  const route = straightRoute(200);
  const gaps = findGaps(stationsAt([10, 30]), route, 50 * MI);
  assert.deepEqual(miles(gaps), [[30, 200]]);
  assert.equal(gaps[0].toEnd, true);
});

test('findGaps: from your position, a leading gap counts', () => {
  const route = straightRoute(200);
  const gaps = findGaps(stationsAt([90, 100]), route, 50 * MI, 20 * MI);
  assert.deepEqual(miles(gaps).slice(0, 1), [[20, 90]]);
  assert.equal(gaps[0].lastStation, null);
});

test('findGaps: searched range, leading gap ignored when it is not your position', () => {
  const route = straightRoute(300);
  const gaps = findGaps(stationsAt([90, 100]), route, 50 * MI, 20 * MI, 140 * MI, { leading: false });
  assert.deepEqual(gaps, []);
});

test('findGaps: a gap running past the searched range is open-ended', () => {
  const route = straightRoute(300);
  const gaps = findGaps(stationsAt([40, 80]), route, 50 * MI, 0, 150 * MI);
  assert.deepEqual(miles(gaps), [[80, 150]]);
  assert.equal(gaps[0].open, true);
});

test('findGaps: no gaps when stations are close together', () => {
  const route = straightRoute(100);
  assert.deepEqual(findGaps(stationsAt([5, 30, 55, 80]), route, 30 * MI), []);
});

test('pickAroundTarget: five on each side, nearest the target', () => {
  const st = stationsAt([5, 10, 15, 20, 25, 30, 35, 40, 45, 55, 60, 65, 70, 75, 80, 85]);
  const { before, after } = pickAroundTarget(st, { from: 0, target: 50 * MI, range: [0, 100 * MI], perSide: 5 });
  assert.deepEqual(at(before), [25, 30, 35, 40, 45]);
  assert.deepEqual(at(after), [55, 60, 65, 70, 75]);
});

test('pickAroundTarget: measured from your position and limited to the range', () => {
  const st = stationsAt([5, 40, 70, 95, 130, 200]);
  const { before, after } = pickAroundTarget(st, { from: 50 * MI, target: 50 * MI, range: [50 * MI, 150 * MI], perSide: 5 });
  assert.deepEqual(at(before), [70, 95]);
  assert.deepEqual(at(after), [130]);
});

test('pickAroundTarget: a station exactly at the target counts as before', () => {
  const { before, after } = pickAroundTarget(stationsAt([50]), { from: 0, target: 50 * MI, range: [0, 100 * MI], perSide: 5 });
  assert.equal(before.length, 1);
  assert.equal(after.length, 0);
});

test('findGaps: a leading gap from your position is reported', () => {
  const route = straightRoute(300);
  const gaps = findGaps(stationsAt([60, 80]), route, 50 * MI, 0, 150 * MI);
  assert.deepEqual(miles(gaps), [[0, 60], [80, 150]]);
});

test('nextStation: first station ahead, skipping one you are at', () => {
  const st = stationsAt([5, 20.05, 31, 60]);
  assert.equal(nextStation(st, 20 * MI).station.name, 'S2');   // 20.05 is under 150 m ahead
  assert.ok(Math.abs(nextStation(st, 20 * MI).distance / MI - 11) < 0.01);
  assert.equal(nextStation(st, 70 * MI), null);
});

test('nextStation: flags the last station before a gap', () => {
  const st = stationsAt([10, 30, 100]);
  const gaps = [{ start: 30 * MI, end: 100 * MI, length: 70 * MI, lastStation: st[1] }];
  assert.equal(nextStation(st, 15 * MI, gaps).gapAfter.length, 70 * MI);
  assert.equal(nextStation(st, 0, gaps).gapAfter, null);
});

test('amenitiesFrom: tags and truck-stop chains', () => {
  const { amenitiesFrom } = stationsModule;
  assert.deepEqual(amenitiesFrom({ toilets: 'yes', shop: 'convenience' }),
    { restrooms: true, store: true, food: false, truckStop: false });
  assert.deepEqual(amenitiesFrom({ brand: "Love's" }), { restrooms: true, store: true, food: true, truckStop: true });
  assert.equal(amenitiesFrom({ brand: 'Pilot', toilets: 'no' }).restrooms, false);
  assert.deepEqual(amenitiesFrom({ hgv: 'yes' }), { restrooms: false, store: false, food: false, truckStop: true });
  assert.deepEqual(amenitiesFrom({ brand: 'Chevron' }), { restrooms: false, store: false, food: false, truckStop: false });
  assert.equal(amenitiesFrom({ brand: 'Tapioca Express' }).truckStop, false);   // "TA" only as a whole word
});
