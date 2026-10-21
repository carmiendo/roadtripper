import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, MI } from './helpers.js';

installLocalStorage();
const { loadSettings, saveSettings, nearestChoice, CHOICES, DEFAULTS } = await import('../js/settings.js');

test('defaults: pink, miles, °F, 50 mi target', () => {
  const s = loadSettings();
  assert.equal(s.accent, 'pink');
  assert.equal(s.distanceUnit, 'mi');
  assert.equal(s.tempUnit, 'F');
  assert.equal(Math.round(s.gasTarget / MI), 50);
});

test('saved settings override defaults; the old range setting is dropped', () => {
  saveSettings({ ...DEFAULTS, accent: 'blue', gasWindow: [1, 2] });
  const s = loadSettings();
  assert.equal(s.accent, 'blue');
  assert.equal('gasWindow' in s, false);
});

test('nearestChoice keeps a setting sensible across a unit switch', () => {
  assert.equal(nearestChoice(CHOICES.maxOffRoute.km, 2 * MI), 3000);
  assert.equal(nearestChoice(CHOICES.gapThreshold.km, 50 * MI), 80000);
});
