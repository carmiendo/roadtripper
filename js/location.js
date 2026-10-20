// Current position from the browser.
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

const MESSAGES = {
  1: 'Location access is off for this site. Allow it in your browser settings, or type a starting address.',
  2: "Your location isn't available right now. Type a starting address instead.",
  3: 'Finding your location took too long. Try again, or type a starting address.',
};

export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error("This browser can't share your location. Type a starting address."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(MESSAGES[err.code] || MESSAGES[2])),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    );
  });
}
