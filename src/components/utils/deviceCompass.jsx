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

/** Edmonton magnetic declination: magnetic north sits ~12.5 deg EAST of true north. */
const MAGNETIC_DECLINATION_DEG = 12.5;

let debug = null;

/** Current screen rotation in degrees (0 portrait, 90/270 landscape). */
function screenAngle() {
  try {
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.angle != null) {
      return Number(screen.orientation.angle) || 0;
    }
    if (typeof window !== 'undefined' && typeof window.orientation === 'number') {
      return Number(window.orientation) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * OWNER REPORT (Nov 26 2026): the red needle pointed noticeably away from north.
 * Two causes, both fixed here:
 *   1. TILT. `alpha` alone is only a compass heading while the phone lies FLAT.
 *      Held upright in a mount it drifts badly. The heading must come from the
 *      full alpha/beta/gamma rotation matrix projected onto the horizontal plane.
 *   2. MAGNETIC vs TRUE north. `deviceorientationabsolute` reports MAGNETIC north
 *      (Edmonton is ~12.5 deg off true north); iOS `webkitCompassHeading` is
 *      already true. Declination is added only to the Android reading.
 * Screen rotation is compensated too, so landscape mounts read correctly.
 */
function tiltCompensatedHeading(alpha, beta, gamma) {
  // Standard device-orientation heading: rotate alpha/beta/gamma into the earth
  // frame and project the screen-up axis onto the horizontal plane, so an
  // upright phone in a mount still reads the true compass heading.
  const deg = Math.PI / 180;
  const x = (Number(beta) || 0) * deg;
  const y = (Number(gamma) || 0) * deg;
  const z = (Number(alpha) || 0) * deg;
  const cX = Math.cos(x), sX = Math.sin(x);
  const cY = Math.cos(y), sY = Math.sin(y);
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const vx = -cZ * sY - sZ * sX * cY;
  const vy = -sZ * sY + cZ * sX * cY;
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return null;
  let h = Math.atan(vx / vy);
  if (vy < 0) h += Math.PI;
  else if (vx < 0) h += 2 * Math.PI;
  const degOut = (h * 180) / Math.PI;
  if (!Number.isFinite(degOut)) return null;
  return normalize(degOut);
}

function handleOrientation(e) {
  if (!e) return;
  let h = null;
  let source = 'none';
  let raw = null;
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    // iOS: already a TRUE compass heading in degrees clockwise from north.
    h = e.webkitCompassHeading;
    source = 'ios';
    raw = h;
  } else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && e.alpha != null) {
    raw = 360 - Number(e.alpha);
    const tilt = tiltCompensatedHeading(e.alpha, e.beta, e.gamma);
    h = normalize((tilt == null ? raw : tilt) + MAGNETIC_DECLINATION_DEG);
    source = 'android';
  }
  if (h == null || !Number.isFinite(Number(h))) return;
  const angle = screenAngle();
  // The needle is drawn in screen space, so remove the screen's own rotation.
  heading = normalize(h - angle);
  debug = { source, alpha: e.alpha, beta: e.beta, gamma: e.gamma, raw, magneticPlusDeclination: h, screenAngle: angle, heading };
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

/** Diagnostics for the compass needle: last raw values, declination and result. */
export function getCompassDebug() {
  return debug ? { ...debug, stale: Date.now() - lastEventAt > STALE_MS } : null;
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
