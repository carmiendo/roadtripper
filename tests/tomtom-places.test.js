import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, straightRoute, MI } from './helpers.js';
import { pointAlong } from '../js/geo.js';
import { tomtomHours, hoursStatus } from '../js/hours.js';

installLocalStorage();
const {
  toStation, mergeStations, isFuelStop, isRestroomStop, toRestroomStop, createTomTomStationLoader, CATEGORY,
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

// Like TomTom: up to 20 places, filled from the start of the stretch searched.
function fillFromStart(stationMiles) {
  return (url, body) => {
    const pts = body.route.points;
    const lonA = pts[0].lon, lonB = pts.at(-1).lon;
    const inStretch = stationMiles.filter((m) => {
      const [lon] = pointAlong(route, m * MI);
      return lon >= Math.min(lonA, lonB) - 1e-6 && lon <= Math.max(lonA, lonB) + 1e-6;
    });
    return ok(inStretch.slice(0, 20).map((m) => result(`m${m}`, m)));
  };
}

test('a full answer is followed by a search from the last place found, not a split', async () => {
  // 30 stations between miles 5 and 20 (one every half mile), then 3 more.
  const miles = [...Array.from({ length: 30 }, (_, i) => 5 + i * 0.5), 30, 40, 50];
  handler = fillFromStart(miles);
  const updates = [];
  const loader = createTomTomStationLoader(route, 5 * MI, (u) => updates.push(u));
  loader.setRange(0, 55 * MI);
  await until(() => updates.at(-1)?.complete);
  assert.equal(calls.length, 2);   // miles 0–55 (full, last at 14.5), then 14.5–55
  assert.equal(updates.at(-1).stations.length, miles.length);
});

test('a quiet stretch takes one search, and moving the range only searches the new part', async () => {
  handler = fillFromStart([10, 25, 40]);
  const updates = [];
  const loader = createTomTomStationLoader(route, 5 * MI, (u) => updates.push(u));
  loader.setRange(0, 30 * MI);
  await until(() => updates.at(-1)?.complete);
  assert.equal(calls.length, 1);
  loader.setRange(20 * MI, 50 * MI);
  await until(() => updates.at(-1)?.complete && updates.at(-1).range[1] === 50 * MI);
  assert.equal(calls.length, 2);
  const [first] = calls.at(-1).points;
  const [lon30] = pointAlong(route, 30 * MI);
  assert.ok(Math.abs(first.lon - lon30) < 0.001);   // started at mile 30, where the last search ended
});

test('the loader searches only the segments in range and reports stations along the route', async () => {
  handler = (url) => ok(url.includes('categorySet=7358&') || url.endsWith('categorySet=7358') ? [] : [result(`s${calls.length}`, 12)]);
  const updates = [];
  const loader = createTomTomStationLoader(route, 5 * MI, (u) => updates.push(u));
  loader.setRange(10 * MI, 14 * MI);   // all inside the first 25 km segment
  await until(() => updates.at(-1)?.complete);
  const last = updates.at(-1);
  assert.equal(last.complete, true);
  assert.equal(calls.length, 1);   // one search: gas stations and truck stops, one segment
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

test('restroom stops: rest areas and real truck stops, with tidy rest-area names', () => {
  const rest = result('r', 5, { name: 'Rest Area:', brand: null, cats: [CATEGORY.restArea] });
  const named = result('n', 5, { name: 'C.H. Warlow Safety Rest Area', brand: null, cats: [CATEGORY.restArea] });
  const truck = result('t', 5, { name: "Love's Travel Stop", cats: [CATEGORY.truckStop] });
  const junk = result('j', 5, { name: 'Applegate Tran Interiors', brand: null, cats: [CATEGORY.truckStop] });
  const gas = result('g', 5);
  assert.deepEqual([rest, named, truck, junk, gas].map(isRestroomStop), [true, true, true, false, false]);
  assert.equal(toRestroomStop(rest).name, 'Rest Area');
  assert.equal(toRestroomStop(rest).kind, 'rest');
  assert.equal(toRestroomStop(named).name, 'C.H. Warlow Safety Rest Area');
  const signs = result('s', 5, { name: 'Rest Area: Truckee Welcome Center Follow Signs', brand: null, cats: [CATEGORY.restArea] });
  assert.equal(toRestroomStop(signs).name, 'Rest Area: Truckee Welcome Center');
  assert.equal(toRestroomStop(truck).kind, 'truck');
});

test('driving on searches every 15 miles or so, not on every position update', async () => {
  handler = fillFromStart([5, 15, 25, 35, 45]);
  const updates = [];
  const loader = createTomTomStationLoader(route, 5 * MI, (u) => updates.push(u));
  for (let at = 0; at <= 20 * MI; at += 0.25 * MI) {
    loader.setRange(at, at + 15 * MI);
    await until(() => updates.at(-1)?.complete, 2000);
  }
  // Miles 0–35 in searches of at least 15 miles: 3 or fewer, not 80.
  assert.ok(calls.length <= 3, `made ${calls.length} searches`);
});
