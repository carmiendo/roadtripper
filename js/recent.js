// Recent destinations, for one-tap planning. Stored in this browser only.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const KEY = 'roadtripper.recent.v1';
const MAX = 5;

export function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function addRecent(place) {
  const list = loadRecent().filter((p) => p.label !== place.label);
  list.unshift({ label: place.label, lat: place.lat, lon: place.lon });
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Storage unavailable; recents won't persist.
  }
  return list.slice(0, MAX);
}
