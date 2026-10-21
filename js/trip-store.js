// Saves the last planned trip in this browser, so it can be shown again when
// the app is reopened, including with no signal.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const KEY = 'roadtripper.lastTrip.v1';
const KEEP_AFTER_ARRIVAL_MS = 3 * 60 * 60 * 1000;   // reopen a trip until 3 hours after arrival
const KEEP_AFTER_SAVE_MS = 12 * 60 * 60 * 1000;     // ...or 12 hours after it was planned

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function packRoute(route) {
  return {
    coords: route.coords.map(([lon, lat]) => [round(lon, 5), round(lat, 5)]),
    cumDist: route.cumDist.map((v) => round(v, 1)),
    cumTime: route.cumTime.map((v) => round(v, 1)),
    distance: route.distance,
    duration: route.duration,
    provider: route.provider,
  };
}

// Keep only the forecast hours the trip can use: from now to a day past arrival.
function packWeather(snapshot, arriveAt) {
  if (!snapshot?.points) return null;
  const start = Date.now() / 1000 - 3600;
  const end = arriveAt / 1000 + 24 * 3600;
  return {
    fetchedAt: snapshot.fetchedAt,
    alerts: snapshot.alerts,
    points: snapshot.points.map((p) => {
      const h = p.hourly;
      if (!h?.time) return { ...p, hourly: null };
      const keep = h.time.map((t, i) => (t >= start && t <= end ? i : -1)).filter((i) => i >= 0);
      const hourly = {};
      for (const [k, arr] of Object.entries(h)) hourly[k] = keep.map((i) => arr[i]);
      return { ...p, hourly };
    }),
  };
}

/**
 * Save the trip and what's been loaded for it.
 * @param {{route, from, to, departAt, fromHere}} trip
 * @param {{weather?, detours?}} extras
 */
export function saveTrip(trip, { weather, detours } = {}) {
  const arriveAt = trip.departAt.getTime() + trip.route.duration * 1000;
  const data = {
    savedAt: Date.now(),
    from: trip.from,
    to: trip.to,
    fromHere: Boolean(trip.fromHere),
    departAt: trip.departAt.getTime(),
    route: packRoute(trip.route),
    weather: packWeather(weather, arriveAt),
    detours: detours ? Object.fromEntries(detours) : {},
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    // Too big or storage unavailable: try again without the forecast.
    try {
      data.weather = null;
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The saved trip if it's still worth reopening, or null.
 * Alerts' dates come back as strings; they're converted here.
 */
export function loadTrip() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
  if (!data?.route?.coords?.length) return null;
  const arriveAt = data.departAt + data.route.duration * 1000;
  const now = Date.now();
  if (now > arriveAt + KEEP_AFTER_ARRIVAL_MS && now > data.savedAt + KEEP_AFTER_SAVE_MS) return null;

  const toDate = (v) => (v ? new Date(v) : null);
  if (data.weather?.alerts?.alerts) {
    for (const a of data.weather.alerts.alerts) { a.onset = toDate(a.onset); a.ends = toDate(a.ends); }
  }
  return {
    savedAt: new Date(data.savedAt),
    trip: {
      route: data.route,
      from: data.from,
      to: data.to,
      fromHere: data.fromHere,
      departAt: new Date(data.departAt),
    },
    weather: data.weather,
    detours: new Map(Object.entries(data.detours || {})),
  };
}

export function clearTrip() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
