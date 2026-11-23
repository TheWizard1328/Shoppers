/**
 * Returns true if the current device is running iOS (iPhone, iPad, iPod).
 */
export const isIOS = () => {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
};

/**
 * Returns a Google Maps web URL for the given address.
 */
export const getMapsUrl = (address) => {
  if (!address) return null;
  const encoded = encodeURIComponent(address);
  return `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;
};

/**
 * NAVIGATION (owner report Nov 23 2026): on iPhones running the installed PWA,
 * tapping Navigate threw the drivers into the App Store asking them to install
 * or update Google Maps, even though it was already installed.
 *
 * Why: iOS standalone PWAs do not reliably hand off `comgooglemaps://`, so the
 * old 300ms visibility probe always "failed" and the code fell through to the
 * Google Maps WEB page — which is what shows the "get the app" / App Store
 * interstitial. The Apple Maps scheme was probed the same way and could be
 * skipped for the same reason.
 *
 * New rule:
 *   iOS  → try the Google Maps app scheme once; if the app did not take over,
 *          open the Apple Maps UNIVERSAL LINK (https://maps.apple.com/...),
 *          which iOS always resolves to the Maps app. The Google web page is
 *          never used on iOS, so the store nag cannot happen.
 *   other→ Google Maps directions URL (Android resolves it into the app).
 */
const NAV_PREF_KEY = 'rxdeliver_nav_app';

/** 'google' | 'apple' | 'auto' (default: Google first, Apple second on iOS) */
export const getNavigationAppPreference = () => {
  try { return localStorage.getItem(NAV_PREF_KEY) || 'auto'; } catch { return 'auto'; }
};

export const setNavigationAppPreference = (value) => {
  try { localStorage.setItem(NAV_PREF_KEY, value || 'auto'); } catch { /* private mode */ }
};

/** "lat,lon" when coordinates are usable, otherwise the address. */
const navDestination = ({ address, lat, lon } = {}) => {
  const la = Number(lat);
  const lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0)) return `${la},${lo}`;
  return address ? String(address) : null;
};

/**
 * Open turn-by-turn navigation to an address and/or coordinates.
 * Accepts either a string (address) or { address, lat, lon }.
 */
export const openInMaps = (target) => {
  const opts = typeof target === 'string' ? { address: target } : (target || {});
  const dest = navDestination(opts);
  if (!dest) return;
  const enc = encodeURIComponent(dest);
  const pref = getNavigationAppPreference();

  if (isIOS()) {
    const appleUniversal = `https://maps.apple.com/?daddr=${enc}&dirflg=d`;
    const googleScheme = `comgooglemaps://?daddr=${enc}&directionsmode=driving`;

    if (pref === 'apple') {
      window.location.href = appleUniversal;
      return;
    }

    // Google first (scheme), Apple as the guaranteed fallback. Never the Google
    // web page: that is what produced the App Store interstitial.
    window.location.href = googleScheme;
    setTimeout(() => {
      if (document.visibilityState !== 'visible') return; // Maps app opened
      window.location.href = appleUniversal;
    }, 500);
    return;
  }

  window.open(`https://www.google.com/maps/dir/?api=1&destination=${enc}`, '_blank');
};

/**
 * Same as openInMaps but for a marker/stop that has coordinates.
 * Kept as a named helper so call sites read clearly.
 */
export const openNavigationTo = ({ address = null, lat = null, lon = null } = {}) =>
  openInMaps({ address, lat, lon });

export const calculateFannedPosition = (originalLat, originalLng, markerIndex, totalMarkers, stopOrder, currentZoom) => {
  if (currentZoom < 11 || currentZoom > 18) {
    return [originalLat, originalLng];
  }

  const baseRadius = 0.0008;
  const dynamicRadius = 0.0008;
  const radius = baseRadius + (18 - currentZoom) * dynamicRadius;

  let arcWidth;
  if (totalMarkers <= 2) {
    arcWidth = 90;
  } else if (totalMarkers === 3) {
    arcWidth = 120;
  } else if (totalMarkers === 4) {
    arcWidth = 140;
  } else {
    arcWidth = Math.min(180, 140 + (totalMarkers - 4) * 10);
  }

  const arcWidthRad = (arcWidth * Math.PI) / 180;
  const startAngle = (Math.PI / 2) - (arcWidthRad / 2);
  const endAngle = (Math.PI / 2) + (arcWidthRad / 2);

  let angle;
  if (totalMarkers === 1) {
    angle = Math.PI / 2;
  } else {
    const angleStep = (endAngle - startAngle) / (totalMarkers - 1);
    angle = startAngle + ((totalMarkers - 1 - markerIndex) * angleStep);
  }

  const fannedLat = originalLat + radius * Math.sin(angle);
  const fannedLng = originalLng + radius * Math.cos(angle);

  return [fannedLat, fannedLng];
};