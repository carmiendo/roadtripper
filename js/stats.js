// Visit counts with GoatCounter (roadtripper.goatcounter.com): no cookies,
// and nothing about where you are or where you're going. Counts opening the
// app, planning a trip, opening Gas, Restrooms, or Weather, and driving with
// the app open. Off on the dev site, and on devices opted out with a private
// link: roadtripper.quest/#toggle-goatcounter (open it again to undo). There's
// no setting for it on purpose, so visitors can't turn counting off.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { IS_DEV } from './config.js';

const ENDPOINT = 'https://roadtripper.goatcounter.com/count';
const SCRIPT = 'https://gc.zgo.at/count.js';
const SKIP_KEY = 'skipgc';   // GoatCounter's own "don't count this browser" switch; count.js checks it too

const EVENTS = {
  'plan-trip': 'Planned a trip',
  'open-gas': 'Opened Gas',
  'open-restrooms': 'Opened Restrooms',
  'open-weather': 'Opened Weather',
  driving: 'Used while driving',
};

export function isCounting() {
  try { return localStorage.getItem(SKIP_KEY) !== 't'; } catch { return true; }
}

export function setCounting(on) {
  try {
    if (on) localStorage.removeItem(SKIP_KEY);
    else localStorage.setItem(SKIP_KEY, 't');
  } catch { /* storage unavailable */ }
}

const queue = [];
let loaded = false;

/**
 * Opening the site with #toggle-goatcounter switches counting for this device.
 * @returns {boolean|null} counting now on/off, or null if the link wasn't used
 */
export function toggleCountingFromLink() {
  if (typeof location === 'undefined' || location.hash !== '#toggle-goatcounter') return null;
  const on = !isCounting();
  setCounting(on);
  history.replaceState(null, '', location.pathname + location.search);
  return on;
}

/** Load the counter (it counts the visit itself). */
export function startStats() {
  if (IS_DEV || !isCounting() || typeof document === 'undefined') return;
  const s = document.createElement('script');
  s.async = true;
  s.src = SCRIPT;
  s.dataset.goatcounter = ENDPOINT;
  s.addEventListener('load', () => {
    loaded = true;
    queue.splice(0).forEach(send);
  });
  document.head.append(s);
}

function send(name) {
  try {
    window.goatcounter?.count?.({ path: name, title: EVENTS[name] || name, event: true });
  } catch { /* counting must never break the app */ }
}

/** Count an event, by name from EVENTS. */
export function countEvent(name) {
  if (IS_DEV) {
    console.info(`[stats] would count: ${EVENTS[name] || name}`);
    return;
  }
  if (!isCounting()) return;
  if (loaded) send(name);
  else if (queue.length < 20) queue.push(name);
}
