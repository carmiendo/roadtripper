// Display formatting for distances, durations, and times.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const METERS_PER_MILE = 1609.344;

export function formatDistance(meters, unit = 'mi') {
  const value = unit === 'km' ? meters / 1000 : meters / METERS_PER_MILE;
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(0);
  return `${text} ${unit}`;
}

/** Distance as a number in the user's unit, without the unit. */
export function toUnit(meters, unit = 'mi') {
  return unit === 'km' ? meters / 1000 : meters / METERS_PER_MILE;
}

export function fromUnit(value, unit = 'mi') {
  return unit === 'km' ? value * 1000 : value * METERS_PER_MILE;
}

/** Position along the route, like "mile 212" or "km 341". */
export function formatMarker(meters, unit = 'mi') {
  return `${unit === 'km' ? 'km' : 'mile'} ${Math.round(toUnit(meters, unit))}`;
}

export function formatDuration(seconds, { compact = false } = {}) {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const [hr, min] = compact ? ['h', 'm'] : [' hr', ' min'];
  if (h === 0) return `${m}${min}`;
  return m === 0 ? `${h}${hr}` : `${h}${hr} ${m}${min}`;
}

export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Clock time at a place with the given UTC offset (seconds), like "6 AM" or
 * "9:30 PM". Falls back to this device's time zone when the offset is unknown.
 */
export function formatClockAt(date, offsetSec) {
  if (offsetSec == null) return formatClock(date).replace(':00', '');
  const shifted = new Date(date.getTime() + offsetSec * 1000);
  return shifted.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).replace(':00', '');
}

export function formatDayClock(date, reference = new Date()) {
  const sameDay = date.toDateString() === reference.toDateString();
  const time = formatClock(date);
  if (sameDay) return time;
  const day = date.toLocaleDateString([], { weekday: 'short' });
  return `${day} ${time}`;
}

// Value for a <input type="datetime-local"> in local time.
export function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
