// User settings, stored in this browser only.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const KEY = 'roadtripper.settings.v1';

export const ACCENTS = Object.freeze([
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'orange', label: 'Orange' },
]);

const MI = 1609.344;
const KM = 1000;

export const DEFAULTS = Object.freeze({
  accent: 'pink',
  distanceUnit: 'mi',            // 'mi' | 'km'
  tempUnit: 'F',                 // 'F' | 'C'
  gasTarget: 50 * MI,            // meters ahead to look for gas around
  maxOffRoute: 2 * MI,           // meters; stations farther from the route are ignored
  gapThreshold: 50 * MI,         // meters; warn about longer stretches with no station
});

// Choices offered in the UI, in the user's unit. Stored values are meters.
export const CHOICES = Object.freeze({
  maxOffRoute: {
    mi: [0.5, 1, 2, 5].map((v) => v * MI),
    km: [1, 2, 3, 8].map((v) => v * KM),
  },
  gapThreshold: {
    mi: [30, 50, 75, 100].map((v) => v * MI),
    km: [50, 80, 120, 160].map((v) => v * KM),
  },
});

/** The choice in `list` closest to `value`, so a saved value survives a unit switch. */
export function nearestChoice(list, value) {
  return list.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), list[0]);
}

// Widest off-route choice, used as the station search radius.
export const MAX_STATION_RADIUS = 5 * MI;

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    delete saved.gasWindow;   // replaced by gasTarget
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode, blocked). Settings last for this visit only.
  }
}

export function applyAccent(id) {
  const known = ACCENTS.some((a) => a.id === id);
  document.documentElement.dataset.accent = known ? id : DEFAULTS.accent;
}
