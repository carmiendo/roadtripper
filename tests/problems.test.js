import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.js';

installLocalStorage();
const { recordProblem, getProblems, clearProblems, problemsAsText } = await import('../js/problems.js');

beforeEach(() => clearProblems());

test('records service, server host, and error; newest first', () => {
  recordProblem('Routing', 'https://router.project-osrm.org/route/v1/driving/1,2;3,4', new Error('HTTP 502'));
  recordProblem('Gas stations', 'https://overpass-api.de/api/interpreter', Object.assign(new Error('x'), { name: 'AbortError' }));
  const [latest, first] = getProblems();
  assert.equal(latest.service, 'Gas stations');
  assert.equal(latest.server, 'overpass-api.de');
  assert.equal(latest.error, 'timed out');
  assert.equal(first.server, 'router.project-osrm.org');
  assert.equal(first.error, 'HTTP 502');
});

test('repeats within a minute are counted, not listed again', () => {
  for (let i = 0; i < 3; i++) recordProblem('Weather', 'https://api.open-meteo.com/v1/forecast', 'HTTP 429');
  const list = getProblems();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 3);
});

test('keeps at most 50', () => {
  for (let i = 0; i < 60; i++) recordProblem('Routing', `https://s${i}.example`, 'HTTP 500');
  assert.equal(getProblems().length, 50);
});

test('network failures get a plain description', () => {
  recordProblem('Routing', 'https://a.example', new TypeError('Failed to fetch'));
  assert.match(getProblems()[0].error, /no response/);
});

test('text version lists each problem', () => {
  recordProblem('Weather', 'https://api.open-meteo.com/x', 'HTTP 429');
  recordProblem('Weather', 'https://api.open-meteo.com/x', 'HTTP 429');
  const text = problemsAsText();
  assert.match(text, /Weather {2}api\.open-meteo\.com {2}HTTP 429 \(x2\)/);
  clearProblems();
  assert.equal(problemsAsText(), 'No problems recorded.');
});
