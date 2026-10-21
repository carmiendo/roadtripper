// Settings for optional services. Keys stay empty in the repo: the deploy
// workflow fills them in from repository secrets in the published copy. They
// are still visible to anyone who opens the site, so each one must be
// restricted to roadtripper.quest in its provider's console.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

// TomTom Routing API key (secret TOMTOM_KEY), for traffic-aware drive times.
// Empty = off, and routing uses OSRM (normal-traffic drive times) as before.
export const TOMTOM_KEY = '';
