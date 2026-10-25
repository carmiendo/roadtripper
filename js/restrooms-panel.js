// "Restrooms ahead" panel: rest areas and truck stops coming up on the route.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// From TomTom's along-route search, so it needs the TomTom key and a
// connection; TomTom's terms don't allow storing results for offline use.

import { createTomTomStationLoader, SEARCHES, isRestroomStop, toRestroomStop } from './tomtom-places.js';
import { TOMTOM_KEY } from './config.js';
import { timeAlong } from './geo.js';
import { MAX_STATION_RADIUS } from './settings.js';
import { formatDistance, formatDuration, formatDayClock } from './format.js';

const AHEAD_M = 150 * 1609.344;   // look this far ahead of you
const SHOWN = 6;                   // stops listed
const KIND_LABEL = { rest: 'Rest stop', truck: 'Truck stop' };

const $ = (id) => document.getElementById(id);

export function createRestroomsPanel({ settings }) {
  const el = {
    panel: $('restrooms-panel'),
    context: $('restrooms-context'),
    list: $('restrooms-list'),
    empty: $('restrooms-empty'),
    kindButtons: document.querySelectorAll('[data-restroom-kind]'),
  };
  const state = {
    trip: null,
    stops: null,       // from the loader, or null before the first answer
    load: null,
    progress: null,
    unavailable: false,
    generation: 0,
  };
  let loader = null;

  // Rest stops, truck stops, or (neither pressed) both. Only for this session.
  let kind = null;
  el.kindButtons.forEach((b) => b.addEventListener('click', () => {
    kind = kind === b.dataset.restroomKind ? null : b.dataset.restroomKind;
    el.kindButtons.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.restroomKind === kind)));
    render();
  }));

  const from = () => state.progress?.along ?? 0;

  function arrivalAt(along) {
    const { route, departAt } = state.trip;
    const p = state.progress;
    if (p?.live) return new Date(Date.now() + (timeAlong(route, along) - timeAlong(route, p.along)) * 1000);
    return new Date(departAt.getTime() + timeAlong(route, along) * 1000);
  }

  function updateRange() {
    if (!loader || !state.trip) return;
    loader.setRange(from(), from() + AHEAD_M);
  }

  function stopItem(stop, index) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'station';
    li.dataset.id = stop.id;

    const num = document.createElement('span');
    num.className = 'station-num';
    num.textContent = String(index + 1);

    const main = document.createElement('div');
    main.className = 'station-main';
    const name = document.createElement('p');
    name.className = 'station-name';
    name.textContent = stop.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = KIND_LABEL[stop.kind];
    name.append(' ', badge);
    if (stop.open24 && stop.kind === 'truck') {
      const b24 = document.createElement('span');
      b24.className = 'badge';
      b24.textContent = '24 hr';
      name.append(' ', b24);
    }
    const sub = document.createElement('p');
    sub.className = 'station-sub';
    sub.textContent = [stop.subname, stop.place, `ETA ${formatDayClock(arrivalAt(stop.along), state.trip.departAt)}`]
      .filter(Boolean).join(' · ');
    const det = document.createElement('p');
    det.className = 'station-detour';
    const d = stop.detour;
    det.textContent = !d ? '' : d.duration < 60 ? 'On the way' : `+${formatDuration(d.duration)} detour`;
    main.append(name, sub);
    if (det.textContent) main.append(det);

    const dist = document.createElement('div');
    dist.className = 'station-dist';
    const strong = document.createElement('strong');
    strong.textContent = formatDistance(stop.along - from(), unit);
    const span = document.createElement('span');
    span.textContent = 'ahead';
    const nav = document.createElement('a');
    nav.className = 'station-nav';
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}`;
    nav.target = '_blank';
    nav.rel = 'noopener';
    nav.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>';
    nav.setAttribute('aria-label', `Directions to ${stop.name}`);
    nav.title = 'Directions';
    dist.append(strong, span, nav);

    li.append(num, main, dist);
    return li;
  }

  function render() {
    if (!state.trip) {
      el.list.replaceChildren();
      el.context.textContent = '';
      el.empty.hidden = true;
      return;
    }
    const unit = settings.distanceUnit;
    if (state.unavailable) {
      el.list.replaceChildren();
      el.context.textContent = '';
      el.empty.textContent = !TOMTOM_KEY
        ? 'Restroom stops need TomTom, which isn\'t set up.'
        : navigator.onLine === false
          ? "You're offline. Restroom stops will load when you have a connection."
          : "Couldn't load restroom stops right now.";
      el.empty.hidden = false;
      return;
    }
    const here = from();
    el.context.textContent = `Rest stops and truck stops in the next ${formatDistance(AHEAD_M, unit)}, ` +
      `measured ${state.progress?.live ? 'from your location' : 'from the start of the route'}.`;
    if (!state.stops) {
      el.list.replaceChildren();
      el.empty.textContent = 'Finding restroom stops…';
      el.empty.hidden = false;
      return;
    }
    const ahead = state.stops.filter((s) => s.along > here + 150 && (!kind || s.kind === kind));
    const shown = ahead.slice(0, SHOWN);
    el.list.replaceChildren(...shown.map(stopItem));
    if (shown.length) {
      el.empty.hidden = true;
    } else if (state.load?.loading) {
      el.empty.textContent = 'Finding restroom stops…';
      el.empty.hidden = false;
    } else {
      const noun = kind === 'rest' ? 'rest stops' : kind === 'truck' ? 'truck stops' : 'rest stops or truck stops';
      el.empty.textContent = `No ${noun} in the next ${formatDistance(AHEAD_M, unit)}.`;
      el.empty.hidden = false;
    }
  }

  function setTrip(trip) {
    state.generation += 1;
    const generation = state.generation;
    state.trip = trip;
    state.stops = null;
    state.load = null;
    state.unavailable = !TOMTOM_KEY;
    loader?.cancel();
    loader = null;
    if (TOMTOM_KEY) {
      loader = createTomTomStationLoader(trip.route, MAX_STATION_RADIUS, (update) => {
        if (generation !== state.generation) return;
        state.stops = update.stations;
        state.load = update;
        render();
      }, {
        searches: SEARCHES.restrooms,
        keep: isRestroomStop,
        convert: toRestroomStop,
        service: 'Restroom stops',
        onUnavailable: () => {
          if (generation !== state.generation) return;
          state.unavailable = true;
          render();
        },
      });
    }
    render();
    updateRange();
  }

  // Forget the trip (the section was closed for a new trip).
  function clear() {
    state.generation += 1;
    loader?.cancel();
    loader = null;
    state.trip = null;
    state.stops = null;
    render();
  }

  function setProgress(progress) {
    state.progress = progress;
    if (!state.trip) return;
    updateRange();
    render();
  }

  // Try again after an outage (for example, when the connection comes back).
  function retryFailed() {
    if (state.trip && state.unavailable && TOMTOM_KEY) setTrip(state.trip);
  }

  function refreshSettings() { render(); }

  return { setTrip, clear, setProgress, refreshSettings, retryFailed };
}
