// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const FIELDS = ['Id', 'LocationDescription', 'Overall Status', 'Secondary Conditions', 'AreaName',
  'RoadwayName', 'EncodedPolyline', 'LastUpdated'];

const quiet = (c) => /^\s*(no report|normal|dry|clear)?\s*$/i.test(String(c['Overall Status'] || '')) &&
  ![].concat(c['Secondary Conditions'] || []).some(Boolean);

/** Nevada 511's road conditions list, minus quiet roads and unused fields. */
export function trimNevada(raw, now) {
  if (!Array.isArray(raw)) throw new Error('Expected a list of road conditions.');
  const conditions = raw.filter((c) => !quiet(c))
    .map((c) => Object.fromEntries(FIELDS.filter((f) => f in c).map((f) => [f, c[f]])));
  return { source: 'Nevada 511 (nvroads.com)', fetchedAt: now.toISOString(), total: raw.length, conditions };
}
