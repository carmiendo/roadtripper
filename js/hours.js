// Opening hours from OpenStreetMap's opening_hours tag, for the common forms:
//   "24/7", "Mo-Fr 06:00-22:00; Sa,Su 07:00-21:00", "05:00-23:00",
//   "Mo-Su 22:00-02:00" (past midnight), "Su off", "PH off" (ignored).
// Anything more involved (months, weeks, sunrise, comments) returns null,
// which the app treats as "hours unknown", never as closed.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const DAY_INDEX = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };   // like Date#getUTCDay
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAY_LIST = new RegExp(`^(${DAY}(?:-${DAY})?(?:\\s*,\\s*${DAY}(?:-${DAY})?)*)\\s*(.*)$`);
const TIME = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/;

function parseDays(text) {
  const days = new Set();
  for (const part of text.split(/\s*,\s*/)) {
    const [a, b] = part.split('-');
    let d = DAY_INDEX[a];
    const end = b ? DAY_INDEX[b] : d;
    days.add(d);
    while (d !== end) { d = (d + 1) % 7; days.add(d); }
  }
  return days;
}

// "06:00-12:00,13:00-22:00" -> [[360, 720], [780, 1320]] (minutes); overnight ends go past 1440.
function parseTimes(text) {
  const out = [];
  for (const part of text.split(/\s*,\s*/)) {
    const m = part.match(TIME);
    if (!m) return null;
    const start = +m[1] * 60 + +m[2];
    let end = +m[3] * 60 + +m[4];
    if (start > 1440 || end > 1440 * 2) return null;
    if (end <= start) end += 1440;   // runs past midnight
    out.push([start, end]);
  }
  return out;
}

/**
 * @param {string} text an opening_hours value
 * @returns {null | {always: true} | {days: Array<Array<[number, number]>>}}
 *   days[d] holds that day's open intervals in minutes after midnight (local time)
 */
export function parseHours(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim();
  if (s === '24/7' || s === 'Mo-Su 00:00-24:00' || s === '00:00-24:00') return { always: true };

  // Rules are separated by ";" (and sometimes ", " before a new day range).
  const rules = s.split(/\s*;\s*|(?<=\d)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/).filter(Boolean);
  const days = Array.from({ length: 7 }, () => []);
  let any = false;
  for (const rule of rules) {
    if (/^(PH|SH)\b/.test(rule)) continue;    // public/school holidays: can't know them here
    let daySet = new Set([0, 1, 2, 3, 4, 5, 6]);
    let rest = rule;
    const dm = rule.match(DAY_LIST);
    if (dm) { daySet = parseDays(dm[1]); rest = dm[2]; }
    rest = rest.replace(/\bPH\b.*$/, '').trim();
    let intervals;
    if (/^(off|closed)$/i.test(rest)) intervals = [];
    else if (rest === '24/7' || rest === '00:00-24:00') intervals = [[0, 1440]];
    else intervals = parseTimes(rest);
    if (!intervals) return null;
    for (const d of daySet) days[d] = intervals;   // later rules replace earlier ones for their days
    any = true;
  }
  return any ? { days } : null;
}

// Local wall-clock pieces for an instant at a given UTC offset (seconds).
function local(date, offsetSec) {
  const t = new Date(date.getTime() + offsetSec * 1000);
  return { day: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

/**
 * Whether the place is open at `date`, and when that changes.
 * @param {object} hours from parseHours
 * @param {Date} date
 * @param {number} offsetSec the place's UTC offset in seconds
 * @returns {null | {open: boolean, changesAt: Date|null}}
 */
export function hoursStatus(hours, date, offsetSec) {
  if (!hours) return null;
  if (hours.always) return { open: true, changesAt: null };

  // Lay out open intervals over a window from yesterday to a week ahead, in
  // minutes from the start of today (local), then look up `date`.
  const { day, minute } = local(date, offsetSec);
  const spans = [];
  for (let k = -1; k <= 7; k++) {
    for (const [a, b] of hours.days[(day + k + 7) % 7]) spans.push([k * 1440 + a, k * 1440 + b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  // Merge touching spans, so 22:00-24:00 then 00:00-06:00 reads as one stretch.
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  const at = (m) => new Date(date.getTime() + (m - minute) * 60000);
  const current = merged.find(([a, b]) => minute >= a && minute < b);
  if (current) return { open: true, changesAt: current[1] - minute > 7 * 1440 ? null : at(current[1]) };
  const next = merged.find(([a]) => a > minute);
  return { open: false, changesAt: next ? at(next[0]) : null };
}
