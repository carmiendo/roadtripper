import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHours, hoursStatus } from '../js/hours.js';

const PDT = -7 * 3600;
// Local Pacific time on Tue 2026-10-20 (a Tuesday).
const at = (hh, mm = 0, dayOffset = 0) => new Date(Date.UTC(2026, 9, 20 + dayOffset, hh + 7, mm));
const status = (text, date) => hoursStatus(parseHours(text), date, PDT);
const clock = (d) => {
  if (!d) return d;
  const p = new Date(d.getTime() + PDT * 1000);   // Pacific wall clock
  return `${p.getUTCDate()} ${String(p.getUTCHours()).padStart(2, '0')}:${String(p.getUTCMinutes()).padStart(2, '0')}`;
};

test('24/7 is always open', () => {
  assert.deepEqual(status('24/7', at(3)), { open: true, changesAt: null });
});

test('simple daily hours', () => {
  assert.equal(status('06:00-22:00', at(5, 59)).open, false);
  assert.equal(status('06:00-22:00', at(6)).open, true);
  assert.equal(clock(status('06:00-22:00', at(21)).changesAt), '20 22:00');
  assert.equal(clock(status('06:00-22:00', at(23)).changesAt), '21 06:00');   // opens next morning
});

test('weekday and weekend rules', () => {
  const h = 'Mo-Fr 05:00-23:00; Sa,Su 07:00-21:00';
  assert.equal(status(h, at(5, 30)).open, true);           // Tuesday
  assert.equal(status(h, at(6, 0, 4)).open, false);        // Saturday before 7
  assert.equal(status(h, at(8, 0, 5)).open, true);         // Sunday
});

test('closed day and later rules overriding earlier ones', () => {
  assert.equal(status('Mo-Su 06:00-22:00; Tu off', at(12)).open, false);
  assert.equal(status('Mo-Su 06:00-22:00; Tu 10:00-14:00', at(9)).open, false);
  assert.equal(status('Mo-Su 06:00-22:00; Tu 10:00-14:00', at(11)).open, true);
});

test('hours past midnight', () => {
  const h = 'Mo-Su 18:00-02:00';
  assert.equal(status(h, at(1)).open, true);                // still open from Monday night
  assert.equal(clock(status(h, at(1)).changesAt), '20 02:00');
  assert.equal(status(h, at(3)).open, false);
});

test('split hours and comma between rules', () => {
  assert.equal(status('06:00-12:00,13:00-20:00', at(12, 30)).open, false);
  assert.equal(status('Mo-Fr 06:00-22:00, Sa 08:00-20:00', at(7, 0, 4)).open, false);
  assert.equal(status('Mo-Fr 06:00-22:00, Sa 08:00-20:00', at(7)).open, true);
});

test('public holiday rules are ignored', () => {
  assert.equal(status('Mo-Su 06:00-22:00; PH off', at(12)).open, true);
});

test('unusual formats are unknown, not closed', () => {
  for (const h of ['Jan-Mar 08:00-18:00', 'sunrise-sunset', 'Mo-Fr 08:00-17:00 "call ahead"', '', null]) {
    assert.equal(parseHours(h), null, String(h));
  }
});

test('different time zone changes the answer', () => {
  const hours = parseHours('06:00-22:00');
  const date = at(5, 30);   // 5:30 AM Pacific = 6:30 AM Mountain
  assert.equal(hoursStatus(hours, date, PDT).open, false);
  assert.equal(hoursStatus(hours, date, -6 * 3600).open, true);
});
