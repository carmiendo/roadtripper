// Display formatting for distances, durations, and times.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const METERS_PER_MILE = 1609.344;

export function formatDistance(meters, unit = 'mi') {
  const value = unit === 'km' ? meters / 1000 : meters / METERS_PER_MILE;
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${unit}`;
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
