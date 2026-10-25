// Settings for optional services, and the dev site.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).
//
// The TomTom key stays empty in the repo: the deploy workflow writes it from
// the repository secret TOMTOM_KEY into the live site's copy only. It's still
// visible to anyone who opens the live site, so it's restricted to
// roadtripper.quest in TomTom's Key Management page.
//
// The dev site (roadtripper.quest/dev/, or this folder served on localhost)
// never uses the key. It answers TomTom requests with made-up data, or skips
// TomTom and uses OpenStreetMap, as picked in its Settings (see dev.js).

// Live site's TomTom key (written by the deploy workflow). Empty = off.
export const RELEASE_KEY = '';

// True in the dev site's copy (written by the deploy workflow).
export const DEV_BUILD = false;

export const IS_DEV = DEV_BUILD ||
  (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));

export const DEV_SOURCE_KEY = 'dev:roadtripper.devSource';
/** Where the dev site gets places: 'fake' (made-up TomTom answers) or 'osm'. */
export const DEV_SOURCE = (() => {
  if (!IS_DEV) return null;
  try { return localStorage.getItem(DEV_SOURCE_KEY) === 'osm' ? 'osm' : 'fake'; } catch { return 'fake'; }
})();

// The key the app uses. In dev it's a stand-in that dev.js answers locally;
// nothing with it ever reaches TomTom.
export const TOMTOM_KEY = IS_DEV ? (DEV_SOURCE === 'fake' ? 'dev-fake' : '') : RELEASE_KEY;
