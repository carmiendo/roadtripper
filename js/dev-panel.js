// The "Dev site" section of Settings: where places come from, and how many
// requests each service got since the page opened.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { IS_DEV, DEV_SOURCE, DEV_SOURCE_KEY } from './config.js';
import { requestLog, onRequestLog, clearRequestLog } from './dev.js';

const $ = (id) => document.getElementById(id);

export function setupDevPanel() {
  if (!IS_DEV) return;
  $('dev-settings').hidden = false;
  document.querySelector('.dev-badge').hidden = false;

  for (const input of document.querySelectorAll('input[name="devSource"]')) {
    input.checked = input.value === DEV_SOURCE;
    input.addEventListener('change', () => {
      try { localStorage.setItem(DEV_SOURCE_KEY, input.value); } catch { /* ignore */ }
      location.reload();
    });
  }

  function render() {
    const log = requestLog();
    const counts = new Map();
    for (const r of log) counts.set(r.service, (counts.get(r.service) || 0) + 1);
    $('dev-summary').textContent = log.length
      ? `${log.length} requests since the page opened:`
      : 'No requests yet.';
    $('dev-counts').replaceChildren(...[...counts].sort((a, b) => b[1] - a[1]).map(([service, n]) => {
      const li = document.createElement('li');
      li.textContent = `${service}: ${n}`;
      return li;
    }));
    $('dev-log').replaceChildren(...log.filter((r) => r.service.startsWith('TomTom')).slice(0, 40).map((r) => {
      const li = document.createElement('li');
      const when = new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      li.textContent = `${when} · ${r.service} · ${r.note}`;
      li.title = r.url;
      return li;
    }));
  }
  onRequestLog(render);
  render();
  $('dev-clear').addEventListener('click', () => clearRequestLog());
}
