import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.js';

installLocalStorage();

// Fake network: Photon can be switched off; Nominatim answers.
let photonDown = false;
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  if (url.startsWith('https://photon.komoot.io')) {
    if (photonDown) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      json: async () => ({
        features: [{
          geometry: { coordinates: [-121.49, 38.58] },
          properties: { name: 'Sacramento', city: 'Sacramento', state: 'California' },
        }],
      }),
    };
  }
  if (url.includes('/reverse') && url.includes('lat=37.75')) {
    return {
      ok: true,
      json: async () => ({
        lat: '37.75', lon: '-122.41',
        address: { house_number: '1186;1188;1190', road: 'Treat Avenue', city: 'San Francisco', state: 'California' },
      }),
    };
  }
  if (url.includes('/reverse')) {
    return {
      ok: true,
      json: async () => ({ lat: '39.32', lon: '-120.18', address: { town: 'Truckee', state: 'California' } }),
    };
  }
  return {
    ok: true,
    json: async () => ([{
      lat: '38.58', lon: '-121.49', name: 'Sacramento',
      address: { city: 'Sacramento', state: 'California' }, display_name: 'Sacramento, California, USA',
    }]),
  };
};

const { suggestPlaces, searchPlaces, reversePlace } = await import('../js/geocode.js');

beforeEach(() => { localStorage.clear(); calls.length = 0; });

test('suggestions and searches come from Photon when it works', async () => {
  const [s] = await suggestPlaces('sacr');
  assert.equal(s.town, 'Sacramento, CA');
  const [p] = await searchPlaces('sacramento');
  assert.equal(p.lat, 38.58);
  assert.ok(calls.every((u) => u.includes('photon')));
});

test('when Photon is down, suggestions stop and searches use Nominatim', async () => {
  photonDown = true;
  await assert.rejects(suggestPlaces('sacr'), { name: 'SuggestionsUnavailable' });
  // Photon isn't tried again for a while, so no second wait.
  await assert.rejects(suggestPlaces('sacra'), { name: 'SuggestionsUnavailable' });
  assert.equal(calls.filter((u) => u.includes('photon')).length, 1);

  const [p] = await searchPlaces('sacramento');
  assert.equal(p.label, 'Sacramento, CA');
  assert.equal(p.town, 'Sacramento, CA');
  assert.equal(p.lon, -121.49);
  assert.ok(calls.at(-1).startsWith('https://nominatim.openstreetmap.org/search'));
});

test('place names fall back to Nominatim and are cached', async () => {
  photonDown = true;
  const place = await reversePlace(39.32, -120.18);
  assert.equal(place.town, 'Truckee, CA');
  const before = calls.length;
  const again = await reversePlace(39.3201, -120.1801);   // same spot, ~10 m away
  assert.equal(again.town, 'Truckee, CA');
  assert.equal(calls.length, before);
});

test('labels show one house number and a short state', async () => {
  photonDown = true;
  const place = await reversePlace(37.75, -122.41);
  assert.equal(place.label, '1186 Treat Avenue, San Francisco, CA');
});
