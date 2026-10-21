// "Gas ahead" panel: stations around a target distance, detours, gap warnings.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { createStationLoader, findGaps } from './stations.js';
import { getDetourLengths } from './routing.js';
import { pointAlong, timeAlong, sliceAlong } from './geo.js';
import { MAX_STATION_RADIUS, saveSettings } from './settings.js';
import {
  formatDistance, formatDuration, formatDayClock, formatMarker,
  toUnit, fromUnit,
} from './format.js';

const DETOUR_SPAN_M = 3000;     // measure detours from 3 km before to 3 km after the station
const DETOUR_SPACING_MS = 1100; // OSRM's public server asks for at most 1 request a second
const PER_SIDE = 5;   // stations shown on each side of the target
const SEARCH_SPAN_M = 50 * 1609.344;   // look this far before and after the target

const $ = (id) => document.getElementById(id);

export function createGasPanel({ settings, getMap, onChange }) {
  const el = {
    target: $('gas-target'),
    targetUnit: $('gas-target-unit'),
    context: $('gas-context'),
    gaps: $('gas-gaps'),
    list: $('gas-list'),
    empty: $('gas-empty'),
    status: $('gas-status'),
  };

  const state = {
    trip: null,           // {route, from, to, departAt}
    stations: null,       // stations in the search range, or null before the first answer
    load: null,           // {range, complete, loading, failed, stale} from the loader
    progress: null,       // {along, live:boolean} position on the route
    shownKey: '',         // ids of listed stations, to refit the map only when they change
    detours: new Map(),   // station id -> {distance, duration} | 'pending' | 'error'
    generation: 0,        // bumps on each new trip, to drop stale results
  };

  let loader = null;
  let detourQueue = [];
  let detourRunning = false;

  // ---------- Target distance ----------

  function renderTarget() {
    const unit = settings.distanceUnit;
    if (document.activeElement !== el.target) {
      el.target.value = Math.round(toUnit(settings.gasTarget, unit));
    }
    el.targetUnit.textContent = `${unit} ahead`;
  }

  let targetTimer = null;
  function applyTarget({ immediate = false } = {}) {
    clearTimeout(targetTimer);
    const run = () => {
      const value = Number(el.target.value);
      if (!Number.isFinite(value) || value <= 0) return;   // keep the last good value while typing
      settings.gasTarget = fromUnit(value, settings.distanceUnit);
      saveSettings(settings);
      updateRange();
      render();
    };
    if (immediate) run(); else targetTimer = setTimeout(run, 600);
  }
  el.target.addEventListener('input', () => applyTarget());
  el.target.addEventListener('change', () => applyTarget({ immediate: true }));
  el.target.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyTarget({ immediate: true }); el.target.blur(); }
  });
  el.target.addEventListener('focus', () => el.target.select());

  // ---------- Detours ----------

  function queueDetour(station) {
    if (state.detours.has(station.id)) return;
    state.detours.set(station.id, 'pending');
    detourQueue.push({ station, generation: state.generation });
    // Let the current render queue all its stations, then send one request.
    queueMicrotask(runDetours);
  }

  // Measures every queued station in one request. If more are queued while a
  // request is out (for example, you changed the target), they go in the next
  // one, at most one request a second as OSRM's public server asks.
  async function runDetours() {
    if (detourRunning) return;
    detourRunning = true;
    while (detourQueue.length) {
      const generation = state.generation;
      const batch = detourQueue.filter((q) => q.generation === generation).map((q) => q.station);
      detourQueue = [];
      if (!batch.length) continue;

      const { route } = state.trip;
      const total = route.cumDist[route.cumDist.length - 1];
      const spans = batch.map((st) => {
        const a = Math.max(0, st.along - DETOUR_SPAN_M);
        const b = Math.min(total, st.along + DETOUR_SPAN_M);
        const [aLon, aLat] = pointAlong(route, a);
        const [bLon, bLat] = pointAlong(route, b);
        return { st, a, b, item: { a: { lat: aLat, lon: aLon }, s: { lat: st.lat, lon: st.lon }, b: { lat: bLat, lon: bLon } } };
      });

      try {
        const results = await getDetourLengths(spans.map((x) => x.item));
        if (generation !== state.generation) continue;
        spans.forEach(({ st, a, b }, i) => {
          const via = results[i];
          state.detours.set(st.id, via ? {
            distance: Math.max(0, via.distance - (b - a)),
            duration: Math.max(0, via.duration - (timeAlong(route, b) - timeAlong(route, a))),
          } : 'error');
        });
      } catch {
        if (generation === state.generation) spans.forEach(({ st }) => state.detours.set(st.id, 'error'));
      }
      render();
      onChange?.();
      if (detourQueue.length) await new Promise((r) => setTimeout(r, DETOUR_SPACING_MS));
    }
    detourRunning = false;
  }

  // ---------- Rendering ----------

  function arrivalAt(along) {
    const { route, departAt } = state.trip;
    const p = state.progress;
    if (p?.live) {
      return new Date(Date.now() + (timeAlong(route, along) - timeAlong(route, p.along)) * 1000);
    }
    return new Date(departAt.getTime() + timeAlong(route, along) * 1000);
  }

  function detourText(station) {
    const unit = settings.distanceUnit;
    const off = `${formatDistance(station.offRoute, unit)} off route`;
    // Short form: "0.3 mi off route · +2 min detour".
    const d = state.detours.get(station.id);
    if (!d || d === 'pending') return `${off} · detour…`;
    if (d === 'error') return off;
    if (d.duration < 60) return `${off} · on the way`;
    return `${off} · +${formatDuration(d.duration)} detour`;
  }

  function stationItem(station, index, ahead, gapAfter, target) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'station';
    li.dataset.index = String(index);

    const num = document.createElement('span');
    num.className = 'station-num';
    num.textContent = String(index + 1);

    const main = document.createElement('div');
    main.className = 'station-main';
    const name = document.createElement('p');
    name.className = 'station-name';
    name.textContent = station.name;
    if (station.open24) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '24 hr';
      name.append(' ', badge);
    }
    const sub = document.createElement('p');
    sub.className = 'station-sub';
    const where = [station.subname, station.place].filter(Boolean).join(', ');
    sub.textContent = [where, `ETA ${formatDayClock(arrivalAt(station.along), state.trip.departAt)}`]
      .filter(Boolean).join(' · ');
    const det = document.createElement('p');
    det.className = 'station-detour';
    det.textContent = detourText(station);
    main.append(name, sub, det);
    if (gapAfter) {
      const warn = document.createElement('p');
      warn.className = 'station-warn';
      warn.textContent = `Last gas for ${gapAfter.open ? 'at least ' : ''}${formatDistance(gapAfter.length, unit)}`;
      main.append(warn);
    }

    const dist = document.createElement('div');
    dist.className = 'station-dist';
    dist.innerHTML = '<strong></strong><span></span>';
    dist.querySelector('strong').textContent = formatDistance(ahead, unit);
    const diff = ahead - target;
    dist.querySelector('span').textContent = Math.abs(diff) < 0.5 * 1609.344
      ? 'at target'
      : `${formatDistance(Math.abs(diff), unit)} ${diff < 0 ? 'before' : 'past'}`;

    const nav = document.createElement('a');
    nav.className = 'station-nav';
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lon}`;
    nav.target = '_blank';
    nav.rel = 'noopener';
    nav.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>';
    nav.setAttribute('aria-label', `Directions to ${station.name}`);
    nav.title = 'Directions';
    dist.append(nav);

    li.append(num, main, dist);
    return li;
  }

  function targetDivider(target, from) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'target-divider';
    li.setAttribute('aria-label', `Your target, ${formatDistance(target, unit)} ahead`);
    const label = document.createElement('span');
    const point = from + target;
    const total = state.trip.route.cumDist[state.trip.route.cumDist.length - 1];
    label.textContent = point > total
      ? `${formatDistance(target, unit)} is past your destination`
      : `${formatDistance(target, unit)} ahead · ETA ${formatDayClock(arrivalAt(point), state.trip.departAt)}`;
    li.append(label);
    return li;
  }

  function gapItem(gap, from) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'gap';
    const title = document.createElement('p');
    title.className = 'gap-title';
    const inGap = gap.start <= from;
    const atLeast = gap.open ? 'at least ' : '';
    title.textContent = inGap
      ? `No gas for the next ${atLeast}${formatDistance(gap.end - from, unit)}`
      : `No gas for ${atLeast}${formatDistance(gap.length, unit)}`;
    const detail = document.createElement('p');
    detail.className = 'gap-detail';
    const endText = gap.toEnd ? 'your destination'
      : gap.open ? `past ${formatMarker(gap.end, unit)}` : formatMarker(gap.end, unit);
    if (inGap) {
      detail.textContent = gap.toEnd
        ? 'No stations between here and your destination.'
        : `Next station at ${formatMarker(gap.end, unit)}.`;
    } else {
      const last = gap.lastStation;
      const lastText = last
        ? `Last station: ${last.name}${last.place ? `, ${last.place}` : ''}, ${formatDistance(gap.start - from, unit)} ahead.`
        : '';
      detail.textContent = `${formatMarker(gap.start, unit)} to ${endText}. ${lastText}`.trim();
    }
    li.append(title, detail);
    return li;
  }

  function renderStatus() {
    const load = state.load;
    el.status.replaceChildren();
    if (!state.trip || !load) { el.status.hidden = true; return; }
    let text = '';
    let retry = false;
    if (load.failed && !load.loading) {
      retry = true;
      if (state.stations?.length) {
        text = navigator.onLine === false
          ? "You're offline. Part of this stretch will load when you have a connection."
          : "Part of this stretch couldn't be loaded. The station servers are busy.";
      }
    } else if (load.loading && state.stations?.length) {
      text = 'Loading more stations…';
    } else if (load.stale) {
      text = navigator.onLine === false
        ? 'Showing stations saved on an earlier visit.'
        : "Showing saved stations from an earlier visit. The station servers didn't answer.";
    }
    if (!text && !retry) { el.status.hidden = true; return; }
    if (text) {
      const p = document.createElement('span');
      p.textContent = text;
      el.status.append(p);
    }
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary-button gas-retry';
      b.textContent = 'Retry';
      b.addEventListener('click', () => loader?.retry());
      el.status.append(b);
    }
    el.status.hidden = false;
  }

  // Ask the loader for just the stretch around the target.
  function updateRange() {
    if (!loader || !state.trip) return;
    const from = state.progress?.along ?? 0;
    const target = settings.gasTarget;
    loader.setRange(from + Math.max(0, target - SEARCH_SPAN_M), from + target + SEARCH_SPAN_M);
  }

  function render() {
    const map = getMap();

    if (!state.trip) {
      el.context.textContent = '';
      el.gaps.replaceChildren();
      el.list.replaceChildren();
      el.empty.textContent = 'Plan a route to see stations along it.';
      el.empty.hidden = false;
      return;
    }
    renderStatus();
    if (!state.stations || (!state.stations.length && !state.load?.complete)) {
      el.context.textContent = '';
      el.gaps.replaceChildren();
      el.list.replaceChildren();
      el.empty.textContent = state.load?.failed && !state.load.loading
        ? (navigator.onLine === false
          ? "You're offline. Gas stations will load when you have a connection."
          : "Couldn't load gas stations. The station servers are busy right now.")
        : 'Finding gas stations…';
      el.empty.hidden = false;
      return;
    }

    const unit = settings.distanceUnit;
    const { route } = state.trip;
    const from = state.progress?.along ?? 0;
    const near = state.stations.filter((s) => s.offRoute <= settings.maxOffRoute);

    // Context line
    const fromText = state.progress?.live
      ? `from your location (${formatMarker(from, unit)})`
      : 'from the start of the route';
    const [rStart, rEnd] = state.load.range;
    el.context.textContent =
      `Measured ${fromText}. Showing stations within ${formatDistance(settings.maxOffRoute, unit)} of the route, ` +
      `${formatMarker(rStart, unit)} to ${formatMarker(rEnd, unit)}.`;

    // Gaps, only within the searched range and only once it's fully loaded
    const gaps = state.load.complete
      ? findGaps(near, route, settings.gapThreshold, rStart, rEnd, { leading: rStart <= from + 1 }).slice(0, 3)
      : [];
    el.gaps.replaceChildren(...gaps.map((g) => gapItem(g, from)));
    const gapAfterStation = new Map(gaps.filter((g) => g.lastStation).map((g) => [g.lastStation.id, g]));

    // Stations in the window
    const ahead = near.filter((s) => s.along >= Math.max(from, rStart) && s.along <= rEnd);
    const filtered = ahead;
    const target = settings.gasTarget;
    const before = filtered.filter((s) => s.along - from <= target).slice(-PER_SIDE);
    const after = filtered.filter((s) => s.along - from > target).slice(0, PER_SIDE);
    const shown = [...before, ...after];

    const items = [];
    const sideNote = (text) => {
      const li = document.createElement('li');
      li.className = 'side-note';
      li.textContent = text;
      return li;
    };
    const reach = (d) => formatDistance(Math.min(d, SEARCH_SPAN_M), unit);
    if (!before.length && after.length && state.load.complete) {
      items.push(sideNote(rStart <= from + 1
        ? `No stations between here and ${formatDistance(target, unit)}.`
        : `No stations within ${reach(target)} before your target.`));
    }
    before.forEach((s, i) => items.push(stationItem(s, i, s.along - from, gapAfterStation.get(s.id), target)));
    if (state.trip && (before.length || after.length)) items.push(targetDivider(target, from));
    after.forEach((s, i) =>
      items.push(stationItem(s, before.length + i, s.along - from, gapAfterStation.get(s.id), target)));
    if (before.length && !after.length && state.load.complete) {
      const routeEnd = route.cumDist[route.cumDist.length - 1];
      items.push(sideNote(rEnd >= routeEnd - 1
        ? `No stations past ${formatDistance(target, unit)} on this route.`
        : `No stations within ${reach(SEARCH_SPAN_M)} past your target.`));
    }
    el.list.replaceChildren(...items);
    shown.forEach(queueDetour);

    if (shown.length) {
      el.empty.hidden = true;
    } else {
      el.empty.textContent = `No gas stations from ${formatMarker(rStart, unit)} to ${formatMarker(rEnd, unit)}.`;
      el.empty.hidden = false;
    }

    const key = shown.map((s) => s.id).join(',');
    const total = route.cumDist[route.cumDist.length - 1];
    const targetPoint = from + target <= total ? pointAlong(route, from + target) : null;
    map?.showStations(shown.map((s) => [s.lon, s.lat]), {
      target: targetPoint,
      fit: key !== state.shownKey && state.load.complete,
      onSelect: (i) => {
        const card = el.list.querySelector(`[data-index="${i}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.classList.remove('flash');
        void card?.offsetWidth;
        card?.classList.add('flash');
      },
    });
    if (state.load.complete) state.shownKey = key;
    map?.showGaps(gaps.map((g) => sliceAlong(route, Math.max(g.start, from), g.end)));
  }

  // ---------- Public ----------

  /**
   * @param {object} trip
   * @param {Map} [savedDetours] detour times saved earlier for this trip
   */
  function setTrip(trip, savedDetours = null) {
    state.generation += 1;
    const generation = state.generation;
    state.trip = trip;
    state.stations = null;
    state.load = null;
    state.shownKey = '';
    state.detours = new Map(savedDetours ?? []);
    detourQueue = [];
    loader?.cancel();
    loader = createStationLoader(trip.route, MAX_STATION_RADIUS, (update) => {
      if (generation !== state.generation) return;
      state.stations = update.stations;
      state.load = update;
      render();
    });
    render();
    updateRange();
  }

  function setProgress(progress) {
    state.progress = progress;
    if (!state.trip) return;
    updateRange();
    render();
  }

  // Settings changed elsewhere (units, off-route distance, gap threshold).
  function refreshSettings() {
    renderTarget();
    updateRange();
    render();
  }

  renderTarget();
  render();

  // Called when the connection comes back: retry stations and detours that failed.
  function retryFailed() {
    if (!state.trip) return;
    loader?.retry();
    for (const [id, d] of state.detours) if (d === 'error') state.detours.delete(id);
    render();
  }

  // Detour times worth saving (finished measurements only).
  function snapshot() {
    return new Map([...state.detours].filter(([, d]) => typeof d === 'object'));
  }

  return { setTrip, setProgress, refreshSettings, retryFailed, snapshot };
}
