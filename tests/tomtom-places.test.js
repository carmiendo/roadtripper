import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, straightRoute, MI } from './helpers.js';
import { pointAlong } from '../js/geo.js';
import { tomtomHours, hoursStatus } from '../js/hours.js';

installLocalStorage();
const {
  toStation, mergeStations, isFuelStop, searchAll, createTomTomStationLoader, CATEGORY,
} = await import('../js/tomtom-places.js');

const route = straightRoute(60);

// A TomTom result at `miles` along the test route.
function result(id, miles, { name = 'Chevron', cats = [CATEGORY.gas], brand = name, detour = 120, extra = {} } = {}) {
  const [lon, lat] = pointAlong(route, miles * MI);
  return {
    id,
    position: { lat: lat + 0.001, lon },
    poi: { name, brands: brand ? [{ name: brand }] : undefined, categorySet: cats.map((c) => ({ id: c })) },
    address: { municipality: 'Town' },
    detourTime: detour,
    detourDistance: 500,
    vehicleTypes: ['Car'],
    ...extra,
  };
}

let handler = null;
const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, points: body.route.points });
  return handler(url, body);
};
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

beforeEach(() => { calls.length = 0; });

// Searches are paced (a few a second), so wait for a condition rather than a fixed time.
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

test('toStation: name, detour, hours, and truck stops', () => {
  const s = toStation(result('a', 10, {
    extra: { poi: { name: 'Chevron', brands: [{ name: 'Chevron' }], categorySet: [{ id: 7311 }],
      openingHours: { timeRanges: [{ startTime: { date: '2026-10-24', hour: 0, minute: 0 }, endTime: { date: '2026-10-31', hour: 0, minute: 0 } }] } } },
  }));
  assert.equal(s.id, 'tt/a');
  assert.equal(s.name, 'Chevron');
  assert.equal(s.place, 'Town');
  assert.deepEqual(s.detour, { distance: 500, duration: 120 });
  assert.equal(s.open24, true);
  assert.equal(s.amenities.truckStop, false);

  assert.equal(toStation(result('b', 10, { name: 'Akal Travel Plaza', brand: null, cats: [CATEGORY.truckStop] })).amenities.truckStop, true);
  assert.equal(toStation(result('c', 10, { name: "Love's Travel Stop" })).amenities.truckStop, true);
});

test('mergeStations: the same stop listed as gas station and truck stop shows once, as a truck stop', () => {
  const gas = toStation(result('g', 20, { name: 'Pilot Gas' , brand: null }));
  const truck = toStation(result('t', 20, { name: 'Pilot Travel Center', brand: null, cats: [CATEGORY.truckStop] }));
  const other = toStation(result('o', 30));
  const merged = mergeStations([gas, truck, other, gas]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'tt/g');
  assert.equal(merged[0].amenities.truckStop, true);
});

test('isFuelStop: truck-stop listings that are really other businesses are dropped', () => {
  assert.equal(isFuelStop(result('a', 1)), true);
  assert.equal(isFuelStop(result('b', 1, { name: 'Akal Travel Plaza', brand: null, cats: [CATEGORY.truckStop] })), true);
  assert.equal(isFuelStop(result('c', 1, { name: 'Applegate Tran Interiors', brand: null, cats: [CATEGORY.truckStop] })), false);
});

test('mergeStations: a nearby truck-stop listing for a different business is not merged', () => {
  const gas = toStation(result('g', 20, { name: 'Arco' }));
  const other = toStation(result('t', 20, { name: 'Sacramento Valley Truck Stop', brand: null, cats: [CATEGORY.truckStop] }));
  const merged = mergeStations([gas, other]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].amenities.truckStop, false);
});

test('searchAll splits a stretch while answers come back full', async () => {
  // 20 results (full) for any stretch longer than 15 km, otherwise 3.
  let depthCalls = 0;
  handler = (url, body) => {
    depthCalls++;
    const pts = body.route.points;
    const lonSpan = Math.abs(pts.at(-1).lon - pts[0].lon);
    const km = lonSpan * 111.32 * Math.cos((39 * Math.PI) / 180);
    const count = km > 15 ? 20 : 3;
    return ok(Array.from({ length: count }, (_, i) => result(`${depthCalls}-${i}`, 1)));
  };
  const out = await searchAll(route, 0, 25000, { query: '*', categorySet: '7311' });
  // 25 km is full, its two 12.5 km halves aren't: 1 + 2 searches, 3 + 3 results.
  assert.equal(depthCalls, 3);
  assert.equal(out.length, 6);
});

test('the loader searches only the segments in range and reports stations along the route', async () => {
  handler = (url) => ok(url.includes('categorySet=7358&') || url.endsWith('categorySet=7358') ? [] : [result(`s${calls.length}`, 12)]);
  const updates = [];
  const loader = createTomTomStationLoader(route, 5 * MI, (u) => updates.push(u));
  loader.setRange(10 * MI, 14 * MI);   // all inside the first 25 km segment
  await until(() => updates.at(-1)?.complete);
  const last = updates.at(-1);
  assert.equal(last.complete, true);
  assert.equal(calls.length, 2);   // gas stations + truck stops, one segment
  assert.equal(last.stations.length, 1);
  assert.ok(Math.abs(last.stations[0].along - 12 * MI) < 200);
});

test('the loader hands over to the backup when TomTom refuses', async () => {
  handler = () => ({ ok: false, status: 403, json: async () => ({}) });
  let unavailable = null;
  const loader = createTomTomStationLoader(route, 5 * MI, () => {}, { onUnavailable: (e) => { unavailable = e; } });
  loader.setRange(0, 10 * MI);
  await until(() => unavailable);
  assert.equal(unavailable?.name, 'TomTomUnavailable');
});

test('tomtomHours: daily hours and closed days', () => {
  const day = (d, h1, h2) => ({
    startTime: { date: `2026-10-${d}`, hour: h1, minute: 0 },
    endTime: { date: `2026-10-${d}`, hour: h2, minute: 0 },
  });
  // Sat 24th through Fri 30th, 6–22 every day but Sunday the 25th.
  const ranges = [24, 26, 27, 28, 29, 30].map((d) => day(d, 6, 22));
  const hours = tomtomHours(ranges);
  const utc = 0;
  assert.deepEqual(hoursStatus(hours, new Date(Date.UTC(2026, 9, 24, 12)), utc).open, true);
  assert.deepEqual(hoursStatus(hours, new Date(Date.UTC(2026, 9, 24, 23)), utc).open, false);
  assert.deepEqual(hoursStatus(hours, new Date(Date.UTC(2026, 9, 25, 12)), utc).open, false);
  assert.equal(tomtomHours([]), null);
});
