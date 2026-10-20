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

export const DEFAULTS = Object.freeze({
  accent: 'pink',
  distanceUnit: 'mi',   // 'mi' | 'km'
  tempUnit: 'F',        // 'F' | 'C'
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
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
