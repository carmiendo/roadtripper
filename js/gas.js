// "Gas ahead" panel: stations in a distance window, detours, gap warnings, brand filter.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { fetchStations, findGaps } from './stations.js';
import { getTripLength } from './routing.js';
import { pointAlong, timeAlong, sliceAlong } from './geo.js';
import { CHOICES, MAX_STATION_RADIUS, saveSettings } from './settings.js';
import {
  formatDistance, formatDuration, formatDayClock, formatMarker, formatRange,
  toUnit, fromUnit,
} from './format.js';

const DETOUR_SPAN_M = 3000;     // measure detours from 3 km before to 3 km after the station
const DETOUR_SPACING_MS = 1100; // OSRM's public server asks for at most 1 request a second
const MAX_LISTED = 10;

const $ = (id) => document.getElementById(id);

export function createGasPanel({ settings, getMap }) {
  const el = {
    windows: $('gas-windows'),
    custom: $('gas-custom'),
    customMin: $('gas-min'),
    customMax: $('gas-max'),
    customUnit: document.querySelectorAll('.gas-unit'),
    context: $('gas-context'),
    gaps: $('gas-gaps'),
    brands: $('gas-brands'),
    list: $('gas-list'),
    empty: $('gas-empty'),
  };

  const state = {
    trip: null,           // {route, from, to, departAt}
    stations: null,       // all stations within MAX_STATION_RADIUS, or null while loading
    error: null,
    progress: null,       // {along, live:boolean} position on the route
    brand: null,          // selected brand filter, or null for all
    detours: new Map(),   // station id -> {distance, duration} | 'pending' | 'error'
    generation: 0,        // bumps on each new trip, to drop stale results
  };

  let detourQueue = [];
  let detourRunning = false;

  // ---------- Window choices ----------

  function renderWindowChoices() {
    const unit = settings.distanceUnit;
    const presets = CHOICES.gasWindow[unit];
    const [curMin, curMax] = settings.gasWindow;
    const isPreset = presets.some(([a, b]) => Math.abs(a - curMin) < 50 && Math.abs(b - curMax) < 50);

    el.windows.replaceChildren();
    const add = (label, value, checked) => {
      const wrap = document.createElement('label');
      wrap.className = 'chip';
      wrap.innerHTML = `<input type="radio" name="gas-window" value="${value}"><span></span>`;
      wrap.querySelector('span').textContent = label;
      wrap.querySelector('input').checked = checked;
      el.windows.append(wrap);
    };
    presets.forEach((range, i) => {
      const checked = isPreset && Math.abs(range[0] - curMin) < 50 && Math.abs(range[1] - curMax) < 50;
      add(formatRange(range, unit), String(i), checked);
    });
    add('Custom', 'custom', !isPreset);

    el.custom.hidden = isPreset;
    el.customMin.value = Math.round(toUnit(curMin, unit));
    el.customMax.value = Math.round(toUnit(curMax, unit));
    el.customUnit.forEach((n) => { n.textContent = unit; });
  }

  el.windows.addEventListener('change', (e) => {
    const unit = settings.distanceUnit;
    if (e.target.value === 'custom') {
      el.custom.hidden = false;
      el.customMin.focus();
      return;
    }
    settings.gasWindow = CHOICES.gasWindow[unit][Number(e.target.value)];
    saveSettings(settings);
    el.custom.hidden = true;
    render();
  });

  function applyCustom() {
    const unit = settings.distanceUnit;
    let min = Number(el.customMin.value);
    let max = Number(el.customMax.value);
    if (!Number.isFinite(min) || min < 0) min = 0;
    if (!Number.isFinite(max) || max <= min) max = min + 10;
    settings.gasWindow = [fromUnit(min, unit), fromUnit(max, unit)];
    saveSettings(settings);
    render();
  }
  el.customMin.addEventListener('change', applyCustom);
  el.customMax.addEventListener('change', applyCustom);

  // ---------- Brand filter ----------

  function renderBrands(stations) {
    const counts = new Map();
    for (const s of stations) if (s.brand) counts.set(s.brand, (counts.get(s.brand) || 0) + 1);
    const brands = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b]) => b);
    if (state.brand && !brands.includes(state.brand)) brands.push(state.brand);

    el.brands.replaceChildren();
    if (brands.length < 2) { el.brands.hidden = true; return; }
    el.brands.hidden = false;
    for (const brand of [null, ...brands]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip-button';
      button.textContent = brand ?? 'All brands';
      button.setAttribute('aria-pressed', String(state.brand === brand));
      button.addEventListener('click', () => {
        state.brand = brand;
        render();
      });
      el.brands.append(button);
    }
  }

  // ---------- Detours ----------

  function queueDetour(station) {
    if (state.detours.has(station.id)) return;
    state.detours.set(station.id, 'pending');
    detourQueue.push({ station, generation: state.generation });
    runDetours();
  }

  async function runDetours() {
    if (detourRunning) return;
    detourRunning = true;
    while (detourQueue.length) {
      const { station, generation } = detourQueue.shift();
      if (generation !== state.generation) continue;
      const { route } = state.trip;
      const total = route.cumDist[route.cumDist.length - 1];
      const a = Math.max(0, station.along - DETOUR_SPAN_M);
      const b = Math.min(total, station.along + DETOUR_SPAN_M);
      const [aLon, aLat] = pointAlong(route, a);
      const [bLon, bLat] = pointAlong(route, b);
      try {
        const via = await getTripLength([
          { lat: aLat, lon: aLon },
          { lat: station.lat, lon: station.lon },
          { lat: bLat, lon: bLon },
        ]);
        if (generation !== state.generation) continue;
        state.detours.set(station.id, {
          distance: Math.max(0, via.distance - (b - a)),
          duration: Math.max(0, via.duration - (timeAlong(route, b) - timeAlong(route, a))),
        });
      } catch {
        if (generation === state.generation) state.detours.set(station.id, 'error');
      }
      render();
      await new Promise((r) => setTimeout(r, DETOUR_SPACING_MS));
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
    const d = state.detours.get(station.id);
    if (!d || d === 'pending') return `${off} · measuring detour…`;
    if (d === 'error') return `${off} · detour unavailable`;
    if (d.duration < 60) return `${off} · right on the way`;
    return `${off} · +${formatDuration(d.duration)} detour (+${formatDistance(d.distance, unit)})`;
  }

  function stationItem(station, index, ahead, gapAfter) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'station';

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
    sub.textContent = [where, `arrive ${formatDayClock(arrivalAt(station.along), state.trip.departAt)}`]
      .filter(Boolean).join(' · ');
    const det = document.createElement('p');
    det.className = 'station-detour';
    det.textContent = detourText(station);
    main.append(name, sub, det);
    if (gapAfter) {
      const warn = document.createElement('p');
      warn.className = 'station-warn';
      warn.textContent = `Last gas for ${formatDistance(gapAfter.length, unit)}`;
      main.append(warn);
    }

    const dist = document.createElement('div');
    dist.className = 'station-dist';
    dist.innerHTML = '<strong></strong><span>ahead</span>';
    dist.querySelector('strong').textContent = formatDistance(ahead, unit);

    const nav = document.createElement('a');
    nav.className = 'station-nav';
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lon}`;
    nav.target = '_blank';
    nav.rel = 'noopener';
    nav.textContent = 'Directions';

    li.append(num, main, dist, nav);
    return li;
  }

  function gapItem(gap, from) {
    const unit = settings.distanceUnit;
    const li = document.createElement('li');
    li.className = 'gap';
    const title = document.createElement('p');
    title.className = 'gap-title';
    const inGap = gap.start <= from;
    title.textContent = inGap
      ? `No gas for the next ${formatDistance(gap.end - from, unit)}`
      : `No gas for ${formatDistance(gap.length, unit)}`;
    const detail = document.createElement('p');
    detail.className = 'gap-detail';
    const endText = gap.toEnd ? 'your destination' : formatMarker(gap.end, unit);
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

  function render() {
    const map = getMap();

    if (!state.trip) {
      el.context.textContent = '';
      el.gaps.replaceChildren();
      el.brands.hidden = true;
      el.list.replaceChildren();
      el.empty.textContent = 'Plan a route to see stations along it.';
      el.empty.hidden = false;
      return;
    }
    if (state.error) {
      el.empty.textContent = state.error;
      el.empty.hidden = false;
      el.list.replaceChildren();
      return;
    }
    if (!state.stations) {
      el.empty.textContent = 'Finding gas stations along your route…';
      el.empty.hidden = false;
      el.list.replaceChildren();
      return;
    }

    const unit = settings.distanceUnit;
    const { route } = state.trip;
    const from = state.progress?.along ?? 0;
    const near = state.stations.filter((s) => s.offRoute <= settings.maxOffRoute);
    const [wMin, wMax] = settings.gasWindow;

    // Context line
    const fromText = state.progress?.live
      ? `from your location (${formatMarker(from, unit)})`
      : 'from the start of the route';
    el.context.textContent =
      `Measured ${fromText}, within ${formatDistance(settings.maxOffRoute, unit)} of the route.`;

    // Gaps (always on all brands: any fuel counts)
    const gaps = findGaps(near, route, settings.gapThreshold, from).slice(0, 3);
    el.gaps.replaceChildren(...gaps.map((g) => gapItem(g, from)));
    const gapAfterStation = new Map(gaps.filter((g) => g.lastStation).map((g) => [g.lastStation.id, g]));

    // Stations in the window
    const ahead = near.filter((s) => s.along >= from);
    renderBrands(ahead);
    const filtered = state.brand ? ahead.filter((s) => s.brand === state.brand) : ahead;
    const inWindow = filtered
      .filter((s) => s.along - from >= wMin && s.along - from <= wMax)
      .slice(0, MAX_LISTED);

    el.list.replaceChildren(...inWindow.map((s, i) =>
      stationItem(s, i, s.along - from, gapAfterStation.get(s.id))));
    inWindow.forEach(queueDetour);

    if (inWindow.length) {
      el.empty.hidden = true;
    } else {
      const before = [...filtered].reverse().find((s) => s.along - from < wMin);
      const after = filtered.find((s) => s.along - from > wMax);
      const hints = [];
      if (before) hints.push(`${before.name} at ${formatDistance(before.along - from, unit)}`);
      if (after) hints.push(`${after.name} at ${formatDistance(after.along - from, unit)}`);
      el.empty.textContent = `No stations ${formatRange(settings.gasWindow, unit).replace('Next', 'in the next')} ahead.` +
        (hints.length ? ` Closest: ${hints.join(' and ')}.` : '');
      el.empty.hidden = false;
    }

    map?.showStations(inWindow.map((s) => [s.lon, s.lat]));
    map?.showGaps(gaps.map((g) => sliceAlong(route, Math.max(g.start, from), g.end)));
  }

  // ---------- Public ----------

  async function setTrip(trip) {
    state.generation += 1;
    const generation = state.generation;
    state.trip = trip;
    state.stations = null;
    state.error = null;
    state.brand = null;
    state.detours = new Map();
    detourQueue = [];
    render();
    try {
      const stations = await fetchStations(trip.route, MAX_STATION_RADIUS);
      if (generation !== state.generation) return;
      state.stations = stations;
    } catch (err) {
      if (generation !== state.generation) return;
      state.error = err.message;
    }
    render();
  }

  function setProgress(progress) {
    state.progress = progress;
    if (state.trip) render();
  }

  // Settings changed elsewhere (units, off-route distance, gap threshold).
  function refreshSettings() {
    renderWindowChoices();
    render();
  }

  renderWindowChoices();
  render();

  return { setTrip, setProgress, refreshSettings };
}
