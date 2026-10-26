import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.js';

installLocalStorage();
const { isCounting, setCounting } = await import('../js/stats.js');

test('"Don\'t count" uses GoatCounter\'s own skipgc switch, so its script skips this device too', () => {
  assert.equal(isCounting(), true);
  setCounting(false);
  assert.equal(localStorage.getItem('skipgc'), 't');
  assert.equal(isCounting(), false);
  setCounting(true);
  assert.equal(localStorage.getItem('skipgc'), null);
});
