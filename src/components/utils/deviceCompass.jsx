/**
 * deviceCompass — the phone's own magnetometer, exposed as a plain heading.
 *
 * OWNER REQUEST (Nov 26 2026): "link our new compass icon to the phones compass
 * and have the compass icon always point North based on the driver's current
 * bearing heading … unlink the compass icons rotation from the actual maps
 * current bearing rotation."
 *
 * So the needle now reads the DEVICE compass, not the map bearing:
 *   • Chrome on Android (PWA and the APK's WebView) fires
 *     `deviceorientationabsolute` with a real `alpha`, no permission prompt.
 *   • iOS 13+ Safari / standalone PWA exposes `webkitCompassHeading` but only
 *     after `DeviceOrientationEvent.requestPermission()`, which MUST be called
 *     from inside a real user gesture. `requestCompassPermission()` is written
 *     to be called straight from a pointerdown handler.
 *
 * Everything is event driven and throttled to ~12 Hz; the compass component
 * polls `getCompassHeading()` and falls back to the map bearing when the device
 * has no magnetometer (or the driver refused the iOS prompt).
 */

const EMIT_MS = 80;
/** A heading older than this is treated as unavailable (no sensor / revoked). */
const STALE_MS = 3000;

let heading = null;
let lastEventAt = 0;
let lastEmitAt = 0;
let started = false;
let permission = 'unknown'; // unknown | prompt | granted | denied | unsupported
const listeners = new Set();

const normalize = (v) => {
  const n = ((Number(v) || 0) % 360 + 360) % 360;
  return Number.isFinite(n) ? n : 0;
};

const emit = () => {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
};

function handleOrientation(e) {
  if (!e) return;
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    // iOS: already a true compass heading in degrees clockwise from north.
    h = e.webkitCompassHeading;
  } else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && e.alpha != null) {
    // Android: alpha counts counter-clockwise from north.
    h = 360 - Number(e.alpha);
  }
  if (h == null || !Number.isFinite(Number(h))) return;
  heading = normalize(h);
  lastEventAt = Date.now();
  if (lastEventAt - lastEmitAt < EMIT_MS) return;
  lastEmitAt = lastEventAt;
  emit();
}

function attach() {
  if (typeof window === 'undefined' || started) return;
  started = true;
  try {
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
  } catch { /* no window */ }
}

/** Start listening without prompting (Android works immediately). */
export function startDeviceCompass() {
  if (typeof window === 'undefined') return;
  if (!window.DeviceOrientationEvent) { permission = 'unsupported'; return; }
  if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
    if (permission === 'unknown') permission = 'prompt';
    attach();
    return;
  }
  permission = 'granted';
  attach();
}

/**
 * Ask for the compass. Safe to call on every gesture — it only prompts once and
 * is a no-op where no permission is needed. Returns the resulting state.
 */
export async function requestCompassPermission() {
  if (typeof window === 'undefined') return 'unsupported';
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) { permission = 'unsupported'; emit(); return permission; }
  if (typeof DOE.requestPermission !== 'function') {
    permission = 'granted';
    attach();
    emit();
    return permission;
  }
  if (permission === 'granted' || permission === 'denied') {
    attach();
    return permission;
  }
  try {
    const res = await DOE.requestPermission();
    permission = res === 'granted' ? 'granted' : 'denied';
  } catch {
    // NotAllowedError = called outside a gesture, or the driver dismissed it.
    permission = 'denied';
  }
  if (permission === 'granted') attach();
  emit();
  return permission;
}

/** Live compass heading in degrees clockwise from north, or null when unknown. */
export function getCompassHeading() {
  if (heading == null) return null;
  if (Date.now() - lastEventAt > STALE_MS) return null;
  return heading;
}

export function getCompassPermission() {
  return permission;
}

export function subscribeDeviceCompass(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export default {
  startDeviceCompass,
  requestCompassPermission,
  getCompassHeading,
  getCompassPermission,
  subscribeDeviceCompass,
};
