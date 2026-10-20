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
// Coming next: stations.js (Overpass) and weather.js (Open-Meteo, NWS).

import { searchPlaces, reversePlace } from './geocode.js';
import { getRoute } from './routing.js';
import { getCurrentPosition } from './location.js';
import { createMap } from './map.js';
import { ACCENTS, loadSettings, saveSettings, applyAccent } from './settings.js';
import { loadRecent, addRecent } from './recent.js';
import { formatDistance, formatDuration, formatDayClock, toLocalInputValue } from './format.js';

const settings = loadSettings();
const $ = (id) => document.getElementById(id);

const state = {
  from: null,   // {label, lat, lon} chosen start, or null for current location
  to: null,
  here: null,   // last known current position, used to bias search
  route: null,
  trip: null,   // {route, from, to, departAt} last planned trip
};

let map = null;
let planning = false;

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

function renderRoute({ route, from, to, departAt }) {
  const unit = settings.distanceUnit;
  const arrive = new Date(departAt.getTime() + route.duration * 1000);

  $('sum-to').textContent = to.label;
  $('sum-from').textContent = `From ${from.label}`;
  $('sum-distance').textContent = formatDistance(route.distance, unit);
  $('sum-duration').textContent = formatDuration(route.duration, { compact: true });
  $('sum-arrive').textContent = formatDayClock(arrive, departAt);
  $('sum-provider').textContent =
    `Route from ${route.provider}. Drive times assume normal traffic.`;

  $('trip-panel').hidden = true;
  $('route-panel').hidden = false;
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
  planning = true;
  button.disabled = true;
  try {
    let from = null;
    if (!$('from-field').hidden && $('trip-from').value.trim()) {
      setStatus('Looking up addresses…');
      from = await resolveField('trip-from', 'from');
    } else {
      setStatus('Finding your location…');
      const pos = await getCurrentPosition();
      state.here = pos;
      const named = await reversePlace(pos.lat, pos.lon).catch(() => null);
      from = { label: named?.label ? `near ${named.label}` : 'your current location', ...pos };
    }

    setStatus('Looking up addresses…');
    const to = await resolveField('trip-to', 'to');

    setStatus('Planning route…');
    const route = await getRoute(from, to);

    const departValue = $('trip-depart').value;
    const departAt = !$('depart-field').hidden && departValue ? new Date(departValue) : new Date();

    state.route = route;
    state.trip = { route, from, to, departAt };
    renderRecent(addRecent(to));
    renderRoute(state.trip);
    setStatus('');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    planning = false;
    button.disabled = false;
  }
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

  function sync() {
    for (const name of ['accent', 'distanceUnit', 'tempUnit']) {
      const input = dialog.querySelector(`input[name="${name}"][value="${settings[name]}"]`);
      if (input) input.checked = true;
    }
  }

  dialog.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (!(name in settings)) return;
    settings[name] = value;
    saveSettings(settings);
    if (name === 'accent') {
      applyAccent(value);
      map?.refreshColors();
    }
    if (name === 'distanceUnit' && state.trip) renderRoute(state.trip);
  });

  $('open-settings').addEventListener('click', () => {
    sync();
    dialog.showModal();
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

  renderRecent();
  setupSettings();
}

init();
