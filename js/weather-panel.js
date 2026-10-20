// "Weather ahead" panel: conditions at each point when you'll get there, plus NWS alerts.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import {
  samplePoints, fetchForecasts, namePoints, fetchAlerts, hourAt, hourAtIndex, describe, hazards,
} from './weather.js';
import { timeAlong } from './geo.js';
import { formatDistance, formatDayClock, formatClock } from './format.js';

const REFRESH_MS = 60 * 60 * 1000;   // refetch forecasts older than an hour
const HOURS_SHOWN = 6;               // hours in an expanded row

const $ = (id) => document.getElementById(id);

// ---------- Units ----------

const temp = (c, unit) => (c == null ? '–' : `${Math.round(unit === 'F' ? c * 9 / 5 + 32 : c)}°`);
const wind = (kmh, distUnit) => (kmh == null ? '–'
  : distUnit === 'km' ? `${Math.round(kmh)} km/h` : `${Math.round(kmh / 1.609344)} mph`);

// ---------- Icons ----------

const ICON_PATHS = {
  cloud: '<path d="M7 18.5h10.5a3.75 3.75 0 0 0 .4-7.48A5.5 5.5 0 0 0 7.4 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
};
const SMALL_CLOUD = '<path d="M7 16.5h9a3.25 3.25 0 0 0 .35-6.48A4.75 4.75 0 0 0 7.3 8.8 3.9 3.9 0 0 0 7 16.5z"/>';
const ICONS = {
  clear: (day) => (day ? ICON_PATHS.sun : ICON_PATHS.moon),
  partly: (day) => (day
    ? '<path d="M8.5 3v1.5M3 8.5h1.5M4.6 4.6l1 1M12.4 4.6l-1 1"/><path d="M5.6 10.6a3.5 3.5 0 0 1 6.3-3.3"/>'
    : '<path d="M11 3.5a5 5 0 0 0-6.5 6.5 5 5 0 0 0 6.5-6.5z"/>') +
    '<path d="M9 20h8.5a3.25 3.25 0 0 0 .35-6.48A4.75 4.75 0 0 0 9.3 12.3 3.9 3.9 0 0 0 9 20z"/>',
  cloud: () => ICON_PATHS.cloud,
  fog: () => '<path d="M4 9h16M3 13h18M5 17h14"/>',
  rain: () => `${SMALL_CLOUD}<path d="M8.5 19l-1 2.5M12.5 19l-1 2.5M16.5 19l-1 2.5"/>`,
  snow: () => `${SMALL_CLOUD}<path d="M8 20.5h.01M12 19.5h.01M16 20.5h.01M10 22.5h.01M14 22.5h.01" stroke-width="2.6"/>`,
  ice: () => `${SMALL_CLOUD}<path d="M8.5 19l-1 2.5M15.5 19l-1 2.5"/><path d="M12 20.5h.01" stroke-width="2.6"/>`,
  storm: () => `${SMALL_CLOUD}<path d="M12.5 17l-2 3h3l-2 3"/>`,
};

function icon(h, size = 28) {
  const { kind } = describe(h?.weather_code);
  const day = h?.is_day !== 0;
  const span = document.createElement('span');
  span.className = `wx-icon wx-icon--${kind}`;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ` +
    'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    `${ICONS[kind](day)}</svg>`;
  return span;
}

// ---------- Hazard text ----------

const HAZARD_LABEL = {
  ice: 'Freezing rain or ice',
  snow: 'Snow',
  storm: 'Thunderstorms',
  rain: 'Rain',
  wind: 'Strong gusts',
  fog: 'Low visibility',
};

export function createWeatherPanel({ settings }) {
  const el = {
    context: $('wx-context'),
    headsup: $('wx-headsup'),
    alerts: $('wx-alerts'),
    list: $('wx-list'),
    empty: $('wx-empty'),
  };

  const state = {
    trip: null,
    points: null,      // [{along, lat, lon, name, hourly}]
    alerts: null,      // {alerts, covered}
    fetchedAt: 0,
    error: null,
    progress: null,
    expanded: new Set(),
    generation: 0,
  };

  function etaFor(along) {
    const { route, departAt } = state.trip;
    const p = state.progress;
    if (p?.live) return new Date(Date.now() + (timeAlong(route, along) - timeAlong(route, p.along)) * 1000);
    return new Date(departAt.getTime() + timeAlong(route, along) * 1000);
  }

  function placeName(point, i, rows) {
    if (point.name) return point.name;
    if (i === rows.length - 1) return 'Destination';
    return 'Along the route';
  }

  // ---------- Pieces ----------

  function headsUp(rows) {
    // Group consecutive points that share a hazard into one line.
    const lines = [];
    for (const kind of Object.keys(HAZARD_LABEL)) {
      let run = null;
      const flush = () => { if (run) lines.push(run); run = null; };
      rows.forEach((r) => {
        if (r.hazards.includes(kind)) {
          if (!run) run = { kind, first: r, last: r, maxGust: 0 };
          run.last = r;
          run.maxGust = Math.max(run.maxGust, r.hour?.wind_gusts_10m ?? 0);
        } else {
          flush();
        }
      });
      flush();
    }
    lines.sort((a, b) => a.first.point.along - b.first.point.along);

    return lines.slice(0, 4).map((run) => {
      const li = document.createElement('li');
      li.className = `headsup headsup--${run.kind}`;
      const title = document.createElement('p');
      title.className = 'headsup-title';
      title.textContent = run.kind === 'wind'
        ? `${HAZARD_LABEL.wind} up to ${wind(run.maxGust, settings.distanceUnit)}`
        : HAZARD_LABEL[run.kind];
      const detail = document.createElement('p');
      detail.className = 'headsup-detail';
      const ref = state.trip.departAt;
      if (run.first === run.last) {
        detail.textContent = `Near ${run.first.name} around ${formatDayClock(run.first.eta, ref)}`;
      } else {
        detail.textContent = `${run.first.name} to ${run.last.name}, ` +
          `${formatDayClock(run.first.eta, ref)}–${formatClock(run.last.eta)}`;
      }
      li.append(icon(run.first.hour, 24), title, detail);
      return li;
    });
  }

  function alertItem(a) {
    const li = document.createElement('li');
    li.className = `alert alert--${(a.severity || 'unknown').toLowerCase()}`;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'alert-title';
    title.textContent = a.event;
    const when = document.createElement('span');
    when.className = 'alert-when';
    const ref = state.trip.departAt;
    const parts = [];
    if (a.onset && a.onset > new Date()) parts.push(`from ${formatDayClock(a.onset, ref)}`);
    if (a.ends) parts.push(`until ${formatDayClock(a.ends, ref)}`);
    when.textContent = parts.join(' ') || 'In effect now';
    summary.append(title, when);

    const body = document.createElement('div');
    body.className = 'alert-body';
    for (const text of [a.headline, a.description, a.instruction]) {
      if (!text) continue;
      const p = document.createElement('p');
      p.textContent = text.replace(/\n(?!\n)/g, ' ').trim();
      body.append(p);
    }
    const area = document.createElement('p');
    area.className = 'alert-area';
    area.textContent = a.area;
    body.append(area);
    details.append(summary, body);
    li.append(details);
    return li;
  }

  function row(r, from) {
    const unit = settings.distanceUnit;
    const tUnit = settings.tempUnit;
    const li = document.createElement('li');
    li.className = 'wx-row';
    if (r.hazards.length) li.classList.add('wx-row--flag');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wx-row-main';
    const open = state.expanded.has(r.key);
    button.setAttribute('aria-expanded', String(open));

    const time = document.createElement('span');
    time.className = 'wx-time';
    if (r.index === 0 && state.progress?.live) {
      time.textContent = 'Now';
    } else {
      const ref = state.progress?.live ? new Date() : state.trip.departAt;
      if (r.eta.toDateString() !== ref.toDateString()) {
        const day = document.createElement('span');
        day.className = 'wx-day';
        day.textContent = r.eta.toLocaleDateString([], { weekday: 'short' });
        time.append(day);
      }
      time.append(formatClock(r.eta));
    }

    const where = document.createElement('span');
    where.className = 'wx-where';
    const name = document.createElement('span');
    name.className = 'wx-name';
    name.textContent = r.name;
    const sub = document.createElement('span');
    sub.className = 'wx-sub';
    const ahead = r.point.along - from;
    const cond = r.hour ? describe(r.hour.weather_code).label : 'Forecast not available yet';
    sub.textContent = [
      ahead > 500 ? `${formatDistance(ahead, unit)} ahead` : null,
      cond,
      r.hour ? `wind ${wind(r.hour.wind_speed_10m, unit)}` : null,
    ].filter(Boolean).join(' · ');
    where.append(name, sub);

    const tempEl = document.createElement('span');
    tempEl.className = 'wx-temp';
    tempEl.textContent = r.hour ? temp(r.hour.temperature_2m, tUnit) : '–';
    const pop = document.createElement('span');
    pop.className = 'wx-pop';
    const prob = r.hour?.precipitation_probability;
    pop.textContent = prob != null && prob >= 10 ? `${Math.round(prob)}%` : '';
    tempEl.append(pop);

    button.append(time, icon(r.hour), where, tempEl);
    button.addEventListener('click', () => {
      if (state.expanded.has(r.key)) state.expanded.delete(r.key); else state.expanded.add(r.key);
      render();
    });
    li.append(button);

    if (open && r.hour) {
      const hours = document.createElement('ol');
      hours.className = 'wx-hours';
      hours.setAttribute('aria-label', `Next hours at ${r.name}`);
      for (let k = 0; k < HOURS_SHOWN; k++) {
        const h = hourAtIndex(r.point.hourly, r.hour.index + k);
        if (!h) break;
        const item = document.createElement('li');
        const t = document.createElement('span');
        t.className = 'wx-hour-time';
        t.textContent = formatClock(h.time).replace(':00', '');
        const tt = document.createElement('span');
        tt.className = 'wx-hour-temp';
        tt.textContent = temp(h.temperature_2m, tUnit);
        const pp = document.createElement('span');
        pp.className = 'wx-hour-pop';
        pp.textContent = (h.precipitation_probability ?? 0) >= 10 ? `${Math.round(h.precipitation_probability)}%` : '';
        item.append(t, icon(h, 24), tt, pp);
        hours.append(item);
      }
      li.append(hours);
    }
    return li;
  }

  // ---------- Render ----------

  function render() {
    if (!state.trip) {
      el.context.textContent = '';
      el.headsup.replaceChildren();
      el.alerts.replaceChildren();
      el.list.replaceChildren();
      el.empty.textContent = 'Plan a route to see the weather along it.';
      el.empty.hidden = false;
      return;
    }
    if (state.error) {
      el.list.replaceChildren();
      el.empty.textContent = state.error;
      el.empty.hidden = false;
      return;
    }
    if (!state.points) {
      el.list.replaceChildren();
      el.empty.textContent = 'Getting forecasts along your route…';
      el.empty.hidden = false;
      return;
    }

    const from = state.progress?.along ?? 0;
    const visible = state.points.filter((p, i) =>
      p.along >= from - 2000 || i === state.points.length - 1);
    const rows = visible.map((point, i) => {
      const eta = etaFor(Math.max(point.along, from));
      const hour = hourAt(point.hourly, eta);
      return {
        key: `${point.along.toFixed(0)}`,
        index: i,
        point,
        eta,
        hour,
        hazards: hazards(hour),
        name: placeName(point, i, visible),
      };
    });

    el.context.textContent = state.progress?.live
      ? 'Forecast for when you reach each point, from where you are now. Tap a row for the next few hours.'
      : `Forecast for when you reach each point, leaving ${formatDayClock(state.trip.departAt)}. Tap a row for the next few hours.`;
    el.headsup.replaceChildren(...headsUp(rows));
    const alerts = state.alerts?.alerts ?? [];
    el.alerts.replaceChildren(...alerts.map(alertItem));
    el.list.replaceChildren(...rows.map((r) => row(r, from)));
    el.empty.hidden = true;
  }

  // ---------- Public ----------

  // Forecast rows render as soon as the forecast arrives; town names and NWS
  // alerts fill in afterward, in parallel.
  async function load(generation) {
    const points = samplePoints(state.trip.route);
    const keepNames = state.points ? new Map(state.points.map((p) => [p.along.toFixed(0), p.name])) : new Map();

    const alertsDone = fetchAlerts(points)
      .catch(() => ({ alerts: [], covered: false }))
      .then((alerts) => {
        if (generation !== state.generation) return;
        state.alerts = alerts;
        render();
      });

    try {
      const hourlies = await fetchForecasts(points);
      if (generation !== state.generation) return;
      state.points = points.map((p, i) => ({ ...p, name: keepNames.get(p.along.toFixed(0)) ?? null, hourly: hourlies[i] }));
      state.fetchedAt = Date.now();
      state.error = null;
      render();
    } catch {
      if (generation !== state.generation) return;
      if (!state.points) state.error = "Couldn't load forecasts. Check your connection and try again.";
      render();
      return;
    }

    let pending = null;
    const unnamed = state.points.filter((p) => !p.name);
    await namePoints(unnamed, (i, name) => {
      if (generation !== state.generation) return;
      unnamed[i].name = name;
      // Batch re-renders while names stream in.
      if (!pending) pending = setTimeout(() => { pending = null; render(); }, 150);
    });
    await alertsDone;
  }

  function setTrip(trip) {
    state.generation += 1;
    state.trip = trip;
    state.points = null;
    state.alerts = null;
    state.error = null;
    state.expanded = new Set();
    render();
    load(state.generation);
  }

  function setProgress(progress) {
    state.progress = progress;
    if (!state.trip) return;
    if (state.points && Date.now() - state.fetchedAt > REFRESH_MS) load(state.generation);
    render();
  }

  // Refresh stale forecasts when the page comes back into view.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.points && Date.now() - state.fetchedAt > REFRESH_MS) {
      load(state.generation);
    }
  });

  render();
  return { setTrip, setProgress, refreshSettings: render };
}
