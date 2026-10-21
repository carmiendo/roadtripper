// Roadtripper entry point.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// Modules (one per data source, so each can be swapped independently):
//   routing.js   OSRM, with Valhalla fallback; Google Routes later
//   geocode.js   Photon address search
//   map.js       MapLibre with OpenFreeMap tiles
//   location.js  browser geolocation
//   settings.js  color, units, and other preferences (stored in the browser)
//   recent.js    recent destinations (stored in the browser)
//   trip-store.js  the last trip, saved so it reopens without a signal
//   ../sw.js     service worker: keeps the app and viewed map tiles offline
//   stations.js  Overpass gas stations and gap detection
//   gas.js       the "Gas ahead" panel
//   weather.js   Open-Meteo forecasts and NWS alerts
//   weather-panel.js  the "Weather ahead" panel

import { searchPlaces, reversePlace } from './geocode.js';
import { getRoute } from './routing.js';
import { getCurrentPosition } from './location.js';
import { createMap, preloadMap } from './map.js';
import { ACCENTS, CHOICES, loadSettings, saveSettings, applyAccent, nearestChoice } from './settings.js';
import { createGasPanel } from './gas.js';
import { createWeatherPanel } from './weather-panel.js';
import { projectToRoute, pointAlong } from './geo.js';
import { loadRecent, addRecent } from './recent.js';
import { saveTrip, loadTrip } from './trip-store.js';
import { getProblems, clearProblems, onProblemsChange, problemsAsText } from './problems.js';
import { formatDistance, formatDuration, formatDayClock, toLocalInputValue } from './format.js';

const settings = loadSettings();
const $ = (id) => document.getElementById(id);

const state = {
  from: null,   // {label, lat, lon} chosen start, or null for current location
  to: null,
  here: null,   // last known current position, used to bias search
  route: null,
  trip: null,   // {route, from, to, departAt, fromHere} current trip
  savedAt: null,  // when the shown trip was saved, if it was reopened from storage
};

let map = null;
let planning = false;
let gas = null;
let weather = null;
let watchId = null;

const ON_ROUTE_M = 1000;   // within 1 km of the route counts as being on it

// ---------- Status ----------

function setStatus(message, kind = 'info') {
  const el = $('status');
  el.textContent = message;
  el.dataset.kind = kind;
}

// ---------- Address suggestions ----------

function setupCombo(inputId, key, { onChoose } = {}) {
  const input = $(inputId);
  const list = $(`${inputId}-list`);
  let timer = null;
  let controller = null;
  let results = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function choose(place) {
    state[key] = place;
    input.value = place.label;
    close();
    onChoose?.(place);
  }

  function highlight(index) {
    const items = list.querySelectorAll('li');
    items.forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    active = index;
    if (items[index]) input.setAttribute('aria-activedescendant', items[index].id);
  }

  function render() {
    list.replaceChildren();
    results.forEach((place, i) => {
      const li = document.createElement('li');
      li.id = `${inputId}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.textContent = place.label;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();   // keep focus on the input
        choose(place);
      });
      list.append(li);
    });
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    active = -1;
  }

  input.addEventListener('input', () => {
    state[key] = null;   // typed text no longer matches a chosen place
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { results = []; render(); return; }
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        results = await searchPlaces(q, state.here, controller.signal);
        render();
      } catch (err) {
        if (err.name !== 'AbortError') setStatus(err.message, 'error');
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !results.length) return;
    const count = results.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + count) % count); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') { close(); }
  });

  input.addEventListener('blur', () => setTimeout(close, 100));
}

// Resolve an input to a place: the chosen suggestion, or the top search match.
async function resolveField(inputId, key) {
  if (state[key]) return state[key];
  const q = $(inputId).value.trim();
  if (!q) return null;
  const [first] = await searchPlaces(q, state.here);
  if (!first) throw new Error(`No match for "${q}". Try adding a city or state.`);
  state[key] = first;
  $(inputId).value = first.label;
  return first;
}

// ---------- Optional fields ----------

function setupToggle(toggleId, fieldId, { openText, closeText, onOpen, onClose }) {
  const toggle = $(toggleId);
  const field = $(fieldId);
  toggle.addEventListener('click', () => {
    const opening = field.hidden;
    field.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    toggle.textContent = opening ? closeText : openText;
    if (opening) onOpen?.(); else onClose?.();
  });
}

function resetFrom() {
  state.from = null;
  $('trip-from').value = '';
  $('from-field').hidden = true;
  $('from-toggle').textContent = 'Change';
  $('from-toggle').setAttribute('aria-expanded', 'false');
  $('from-summary').textContent = 'your current location';
}

function updateDepartSummary() {
  const field = $('depart-field');
  const value = $('trip-depart').value;
  $('depart-summary').textContent =
    field.hidden || !value ? 'now' : formatDayClock(new Date(value));
}

// ---------- Recent destinations ----------

function renderRecent(list = loadRecent()) {
  const wrap = $('recent');
  const container = $('recent-list');
  container.replaceChildren();
  for (const place of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.textContent = place.label;
    button.addEventListener('click', () => {
      state.to = place;
      $('trip-to').value = place.label;
      plan();
    });
    container.append(button);
  }
  wrap.hidden = list.length === 0;
}

// ---------- Planning ----------

function renderRoute({ route, from, to, departAt }, { refit = true } = {}) {
  const unit = settings.distanceUnit;
  const arrive = new Date(departAt.getTime() + route.duration * 1000);

  $('sum-to').textContent = to.label;
  $('sum-from').textContent = `From ${from.label}`;
  $('sum-distance').textContent = formatDistance(route.distance, unit);
  $('sum-duration').textContent = formatDuration(route.duration, { compact: true });
  $('sum-arrive').textContent = formatDayClock(arrive, departAt);
  $('sum-provider').textContent =
    `Route from ${route.provider}. Drive times assume normal traffic.` +
    (state.savedAt ? ` Saved trip from ${formatDayClock(state.savedAt)}.` : '');

  $('trip-panel').hidden = true;
  $('route-panel').hidden = false;
  $('gas-panel').hidden = false;
  $('weather-panel').hidden = false;
  if (!refit) return;
  if (!map) map = createMap($('map'));
  map.showRoute(route);
  $('route-panel').scrollIntoView({ block: 'start' });
}

async function plan(event) {
  event?.preventDefault();
  const button = $('plan-button');
  if (!$('trip-to').value.trim()) {
    setStatus('Enter a destination.', 'error');
    $('trip-to').focus();
    return;
  }

  if (planning) return;
  if (navigator.onLine === false) {
    setStatus("You're offline. Planning a new route needs a connection.", 'error');
    return;
  }
  planning = true;
  button.disabled = true;
  try {
    let from = null;
    let fromHere = false;
    let fromNamed = null;   // resolves to a display name for "current location"
    const toPromise = resolveField('trip-to', 'to');
    toPromise.catch(() => {});   // handled when awaited below
    if (!$('from-field').hidden && $('trip-from').value.trim()) {
      setStatus('Looking up addresses…');
      from = await resolveField('trip-from', 'from');
    } else {
      setStatus('Finding your location…');
      const pos = await currentPosition();
      state.here = pos;
      from = { label: 'your current location', ...pos };
      fromHere = true;
      fromNamed = reversePlace(pos.lat, pos.lon).catch(() => null);
    }

    setStatus('Looking up addresses…');
    const to = await toPromise;

    setStatus('Planning route…');
    const route = await getRoute(from, to);
    if (fromNamed) {
      // Use the name if it's already back; don't hold up the route for it.
      const named = await Promise.race([fromNamed, new Promise((r) => setTimeout(r, 300))]);
      if (named?.label) from.label = `near ${named.label}`;
      else fromNamed.then((n) => {
        if (n?.label && state.trip?.from === from) {
          from.label = `near ${n.label}`;
          $('sum-from').textContent = `From ${from.label}`;
        }
      });
    }

    const departValue = $('trip-depart').value;
    const departAt = !$('depart-field').hidden && departValue ? new Date(departValue) : new Date();

    state.route = route;
    state.trip = { route, from, to, departAt, fromHere };
    state.savedAt = null;
    renderRecent(addRecent(to));
    renderRoute(state.trip);
    setStatus('');
    persistTrip();
    gas.setProgress(null);
    gas.setTrip(state.trip);
    weather.setProgress(null);
    weather.setTrip(state.trip);
    startTracking(fromHere ? from : null);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    planning = false;
    button.disabled = false;
  }
}

// ---------- Saved trip and offline ----------

let saveTimer = null;

// Save the trip with what's loaded so far (debounced while things stream in).
function persistTrip() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.trip) return;
    saveTrip(state.trip, { weather: weather.snapshot(), detours: gas.snapshot() });
  }, 800);
}

// Reopen the last trip if it's still under way or was planned recently.
function restoreTrip() {
  const saved = loadTrip();
  if (!saved) return false;
  state.trip = saved.trip;
  state.route = saved.trip.route;
  state.savedAt = saved.savedAt;
  renderRoute(state.trip);
  gas.setTrip(state.trip, saved.detours);
  weather.setTrip(state.trip, saved.weather);
  if (saved.trip.fromHere) startTracking(null);   // follows you only if location is already allowed
  return true;
}

function updateOfflineBanner() {
  const banner = $('offline-banner');
  const offline = navigator.onLine === false;
  banner.hidden = !offline;
  if (!offline) return;
  banner.textContent = state.trip
    ? "You're offline. Showing your saved trip; updates resume when you're back online."
    : "You're offline. Planning a new route needs a connection.";
}

function setupOffline() {
  window.addEventListener('offline', updateOfflineBanner);
  window.addEventListener('online', () => {
    updateOfflineBanner();
    gas.retryFailed();
    weather.refreshIfStale();
    if (/offline/i.test($('status').textContent)) setStatus('');
  });
  updateOfflineBanner();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Not available (private mode, unsupported); the app still works online.
    });
  }
}

// ---------- Current position ----------

let warmPosition = null;   // {pos, at} from a lookup started when the page opened

async function currentPosition() {
  if (warmPosition && Date.now() - warmPosition.at < 2 * 60 * 1000) return warmPosition.pos;
  const pos = await getCurrentPosition();
  warmPosition = { pos, at: Date.now() };
  return pos;
}

// If location access is already allowed, look up the position while the
// person is still typing, so planning doesn't wait on it. Never prompts.
async function warmUpPosition() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status?.state !== 'granted') return;
    const pos = await getCurrentPosition();
    warmPosition = { pos, at: Date.now() };
    state.here = pos;   // also improves address suggestions nearby
  } catch { /* ignore */ }
}

// ---------- Position along the route ----------

function updateProgress(pos) {
  if (!state.trip) return;
  const { route } = state.trip;
  const snap = projectToRoute(route, [pos.lon, pos.lat]);
  const onRoute = snap.offRoute <= ON_ROUTE_M;
  const progress = onRoute ? { along: snap.along, live: true } : null;
  gas.setProgress(progress);
  weather.setProgress(progress);
  const here = onRoute ? pointAlong(route, snap.along) : null;
  map?.showPosition(here);
  if (here) map?.follow(here);
}

// Follow the device's position while a route is shown, if location access is
// already allowed. Never prompts on its own.
async function startTracking(startPos) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (startPos) updateProgress(startPos);
  if (!('geolocation' in navigator)) return;
  let granted = Boolean(startPos);
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status) granted = status.state === 'granted';
  } catch { /* Permissions API unavailable; fall back to whether we already have a fix. */ }
  if (!granted) return;

  // Apply at most one update every 5 seconds, always ending on the latest position.
  let last = 0;
  let pending = null;
  let timer = null;
  const apply = () => {
    timer = null;
    last = Date.now();
    if (pending) updateProgress(pending);
    pending = null;
  };
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      pending = { lat: p.coords.latitude, lon: p.coords.longitude };
      const wait = 5000 - (Date.now() - last);
      if (wait <= 0) apply();
      else if (!timer) timer = setTimeout(apply, wait);
    },
    () => {},
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 60000 },
  );
}

function changeTrip() {
  $('route-panel').hidden = true;
  $('trip-panel').hidden = false;
  $('trip-to').focus();
  $('trip-to').select();
}

// ---------- Settings ----------


function setupSettings() {
  const dialog = $('settings');
  const swatches = $('accent-options');

  for (const accent of ACCENTS) {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.innerHTML =
      `<input type="radio" name="accent" id="accent-${accent.id}" value="${accent.id}">` +
      `<span class="swatch-dot" data-id="${accent.id}"></span><span>${accent.label}</span>`;
    swatches.append(label);
  }

  // Distance choices depend on the unit, so they're rebuilt when it changes.
  function renderDistanceChoices() {
    const unit = settings.distanceUnit;
    for (const [name, containerId] of [['maxOffRoute', 'off-route-options'], ['gapThreshold', 'gap-options']]) {
      const list = CHOICES[name][unit];
      settings[name] = nearestChoice(list, settings[name]);
      const container = $(containerId);
      container.replaceChildren();
      list.forEach((value, i) => {
        const label = document.createElement('label');
        label.innerHTML = `<input type="radio" name="${name}" id="${name}-${i}" value="${value}"><span></span>`;
        label.querySelector('span').textContent = formatDistance(value, unit);
        label.querySelector('input').checked = value === settings[name];
        container.append(label);
      });
    }
  }

  function sync() {
    for (const name of ['accent', 'distanceUnit', 'tempUnit']) {
      const input = dialog.querySelector(`input[name="${name}"][value="${settings[name]}"]`);
      if (input) input.checked = true;
    }
    renderDistanceChoices();
  }

  dialog.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (!(name in settings)) return;
    settings[name] = name === 'maxOffRoute' || name === 'gapThreshold' ? Number(value) : value;
    if (name === 'distanceUnit') {
      renderDistanceChoices();
    }
    saveSettings(settings);
    if (name === 'accent') {
      applyAccent(value);
      map?.refreshColors();
    }
    if (name === 'distanceUnit' && state.trip) renderRoute(state.trip, { refit: false });
    gas.refreshSettings();
    weather.refreshSettings();
  });

  $('open-settings').addEventListener('click', () => {
    sync();
    renderProblems();
    dialog.showModal();
  });

  // Recent problems
  function renderProblems() {
    const list = getProblems();
    $('problems-summary').textContent = list.length
      ? `${list.length} recent ${list.length === 1 ? 'problem' : 'problems'}, newest first.`
      : 'No problems recorded.';
    $('problems-list').replaceChildren(...list.slice(0, 20).map((p) => {
      const li = document.createElement('li');
      const head = document.createElement('span');
      head.className = 'p-head';
      const what = document.createElement('span');
      what.textContent = p.count > 1 ? `${p.service} (${p.count}×)` : p.service;
      const when = document.createElement('span');
      when.className = 'p-when';
      when.textContent = formatDayClock(new Date(p.at));
      head.append(what, when);
      const detail = document.createElement('span');
      detail.className = 'p-detail';
      detail.textContent = `${p.server}: ${p.error}${p.online === false ? ' (offline)' : ''}`;
      li.append(head, detail);
      return li;
    }));
    $('problems-copy').hidden = !list.length;
    $('problems-clear').hidden = !list.length;
    $('problems-text').hidden = true;
  }
  onProblemsChange(() => { if (dialog.open) renderProblems(); });

  $('problems-copy').addEventListener('click', async () => {
    const text = problemsAsText();
    const button = $('problems-copy');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy for a bug report'; }, 2000);
    } catch {
      // Clipboard not allowed here: show the text so it can be selected and copied.
      const area = $('problems-text');
      area.value = text;
      area.hidden = false;
      area.select();
    }
  });
  $('problems-clear').addEventListener('click', () => {
    clearProblems();
    renderProblems();
  });
}

// ---------- Start ----------

function init() {
  applyAccent(settings.accent);
  $('trip-depart').value = toLocalInputValue(new Date());

  setupCombo('trip-to', 'to', { onChoose: () => plan() });
  setupCombo('trip-from', 'from', {
    onChoose: (place) => { $('from-summary').textContent = place.label; },
  });

  setupToggle('from-toggle', 'from-field', {
    openText: 'Change',
    closeText: 'Cancel',
    onOpen: () => $('trip-from').focus(),
    onClose: resetFrom,
  });
  $('from-reset').addEventListener('click', resetFrom);

  setupToggle('depart-toggle', 'depart-field', {
    openText: 'Leave later',
    closeText: 'Leave now',
    onOpen: () => { $('trip-depart').focus(); updateDepartSummary(); },
    onClose: updateDepartSummary,
  });
  $('trip-depart').addEventListener('change', updateDepartSummary);

  $('trip-form').addEventListener('submit', plan);
  $('change-trip').addEventListener('click', changeTrip);

  warmUpPosition();
  renderRecent();
  gas = createGasPanel({ settings, getMap: () => map, onChange: persistTrip });
  weather = createWeatherPanel({ settings, onChange: persistTrip });
  setupSettings();
  const restored = restoreTrip();
  setupOffline();
  document.documentElement.dataset.ready = '1';

  // With the start screen up and nothing else going on, fetch the map library
  // so the map appears quickly once a route is planned.
  if (!restored) {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => preloadMap(), { timeout: 4000 });
  }
}

init();
