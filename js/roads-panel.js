// "Road conditions" panel: California chain controls ahead on the route.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { loadRoadAlerts, alertsOnRoute, LEVEL_ORDER } from './roads.js';
import { createRouteIndex, resampleRoute, timeAlong } from './geo.js';
import { formatDistance, formatDayClock, formatClock } from './format.js';

const REFRESH_MS = 5 * 60 * 1000;
const $ = (id) => document.getElementById(id);

export function createRoadsPanel({ settings, getMap }) {
  const el = {
    panel: $('roads-panel'),
    summary: $('roads-summary'),
    list: $('roads-list'),
    status: $('roads-status'),
  };
  const state = {
    trip: null,
    index: null,
    points: null,
    result: null,     // from loadRoadAlerts
    progress: null,
    loading: false,
    generation: 0,
  };
  let timer = null;

  function etaAt(along) {
    const { route, departAt } = state.trip;
    const p = state.progress;
    if (p?.live) return new Date(Date.now() + (timeAlong(route, along) - timeAlong(route, p.along)) * 1000);
    return new Date(departAt.getTime() + timeAlong(route, along) * 1000);
  }

  function item(a, from) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = `road-alert road-alert--${a.level}`;
    const badge = document.createElement('span');
    badge.className = 'road-badge';
    badge.textContent = a.short;
    const main = document.createElement('div');
    main.className = 'road-main';
    const title = document.createElement('p');
    title.className = 'road-title';
    title.textContent = a.title;
    const where = document.createElement('p');
    where.className = 'road-where';
    const road = [a.route, a.direction ? a.direction.toLowerCase() + 'bound' : ''].filter(Boolean).join(' ');
    const near = a.places.length ? `near ${a.places.slice(0, 2).join(' and ')}` : '';
    const ahead = Math.max(0, a.along - from);
    const span = a.endAlong - a.along > 1600 ? ` for ${formatDistance(a.endAlong - a.along, unit)}` : '';
    where.textContent = [
      [road, near].filter(Boolean).join(' '),
      (ahead < 800 ? 'here' : `${formatDistance(ahead, unit)} ahead`) + span,
      ahead < 800 ? null : `ETA ${formatDayClock(etaAt(a.along), state.trip.departAt)}`,
    ].filter(Boolean).join(' · ');
    main.append(title, where);
    if (a.since) {
      const since = document.createElement('p');
      since.className = 'road-since';
      since.textContent = `In effect since ${formatDayClock(a.since)}`;
      main.append(since);
    }
    li.title = a.detail;   // Caltrans's full wording, on hover
    li.append(badge, main);
    return li;
  }

  function render() {
    const r = state.result;
    if (!state.trip || !r || !r.covered) {
      el.panel.hidden = true;
      getMap()?.showRoadAlerts?.([]);
      return;
    }
    el.panel.hidden = false;
    const from = state.progress?.along ?? 0;
    const ahead = alertsOnRoute(r.alerts, state.trip.route, state.index).filter((a) => a.endAlong >= from - 500);
    const checked = r.checkedAt ? formatClock(r.checkedAt) : null;

    if (ahead.length) {
      const worst = ahead.reduce((w, a) => (LEVEL_ORDER[a.level] < LEVEL_ORDER[w.level] ? a : w));
      el.summary.textContent = worst.level === 'closed'
        ? 'Road closed ahead on your route.'
        : `${ahead.length} chain control ${ahead.length === 1 ? 'area' : 'areas'} ahead on your route.`;
      el.summary.className = `roads-summary roads-summary--${worst.level}`;
    } else {
      el.summary.textContent = r.failed ? '' : 'No chain controls or closures on your route right now.';
      el.summary.className = 'roads-summary';
    }
    el.list.replaceChildren(...ahead.map((a) => item(a, from)));

    const notes = [];
    if (r.failed) notes.push("Couldn't reach Caltrans for part of your route.");
    if (r.stale) notes.push(`Showing saved conditions from ${checked}.`);
    else if (checked) notes.push(`California only. Checked ${checked}; conditions change quickly in storms.`);
    el.status.textContent = notes.join(' ');

    getMap()?.showRoadAlerts?.(ahead.map((a) => ({ coord: [a.lon, a.lat], short: a.short, level: a.level })));
  }

  async function load({ force = false } = {}) {
    if (!state.trip || state.loading) return;
    const generation = state.generation;
    state.loading = true;
    try {
      const result = await loadRoadAlerts(state.points, { force });
      if (generation !== state.generation) return;
      state.result = result;
    } catch {
      // loadRoadAlerts reports per-district failures in its result.
    } finally {
      state.loading = false;
    }
    render();
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) load();
    }, REFRESH_MS);
  }

  function setTrip(trip) {
    state.generation += 1;
    state.trip = trip;
    state.index = createRouteIndex(trip.route, 400);
    state.points = resampleRoute(trip.route, 10000);
    state.result = null;
    render();
    load();
    schedule();
  }

  function setProgress(progress) {
    state.progress = progress;
    if (state.trip) render();
  }

  window.addEventListener('online', () => load());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.trip) load();
  });

  return { setTrip, setProgress, refreshSettings: render };
}
