// A log of recent failures (which service, which server, when, and why),
// kept in this browser so problems can be seen and shared from Settings.
// Nothing is sent anywhere.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const KEY = 'roadtripper.problems.v1';
const MAX = 50;
const MERGE_MS = 60 * 1000;   // repeats of the same problem within a minute are counted, not listed again

const listeners = new Set();

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* storage unavailable */ }
}

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return url || ''; }
};

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'timed out';
  if (err instanceof TypeError && /fetch|network|load/i.test(err.message)) return 'no response (offline, blocked, or rate-limited)';
  return err.message || String(err);
}

/**
 * Record a failure.
 * @param {string} service what the app was doing, e.g. "Gas stations"
 * @param {string} url the server address (only its host name is kept)
 * @param {Error|string} error
 */
export function recordProblem(service, url, error) {
  const entry = {
    at: Date.now(),
    service,
    server: hostOf(url),
    error: typeof error === 'string' ? error : describeError(error),
    online: typeof navigator === 'undefined' ? null : navigator.onLine !== false,
    count: 1,
  };
  const list = read();
  const last = list[0];
  if (last && last.service === entry.service && last.server === entry.server &&
      last.error === entry.error && entry.at - last.at < MERGE_MS) {
    last.count += 1;
    last.at = entry.at;
  } else {
    list.unshift(entry);
  }
  write(list);
  listeners.forEach((fn) => fn());
}

export function getProblems() {
  return read();
}

export function clearProblems() {
  write([]);
  listeners.forEach((fn) => fn());
}

export function onProblemsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Plain-text version of the log, for copying into a message. */
export function problemsAsText(list = read()) {
  if (!list.length) return 'No problems recorded.';
  const lines = list.map((p) => {
    const when = new Date(p.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const times = p.count > 1 ? ` (x${p.count})` : '';
    const offline = p.online === false ? ' [offline]' : '';
    return `${when}  ${p.service}  ${p.server}  ${p.error}${times}${offline}`;
  });
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return `Roadtripper problems\n${agent}\n\n${lines.join('\n')}`;
}

// Script errors in the app itself, so bugs show up here too.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    if (e.message) recordProblem('App', e.filename || location.href, `${e.message} (line ${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r?.name === 'AbortError') return;
    recordProblem('App', location.href, r?.message || String(r));
  });
}
