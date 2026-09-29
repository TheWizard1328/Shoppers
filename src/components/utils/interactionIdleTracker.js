/**
 * interactionIdleTracker — global "how long since the user last touched the app"
 * tracker (owner request, Sep 28 2026).
 *
 * Used by the web-update auto-restart logic: if a device has been sitting
 * FOREGROUND-but-idle (no taps/keys/scroll) for 10+ minutes when an update
 * becomes ready, the app can refresh itself onto the new build without
 * disturbing anyone.
 *
 * Initialized once from Layout; listeners are passive+capture so they never
 * block normal interaction. Falls back to app-boot time when no interaction
 * has ever been recorded (nothing special — idle simply counts from boot).
 */

let _lastInteractionAt = Date.now();
let _initialized = false;

const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

export function initInteractionIdleTracker() {
  if (_initialized || typeof window === 'undefined') return;
  _initialized = true;
  const note = () => { _lastInteractionAt = Date.now(); };
  EVENTS.forEach((evt) => {
    window.addEventListener(evt, note, { capture: true, passive: true });
  });
}

/** Milliseconds since the user's last tap / key / scroll (or app boot). */
export function getIdleMs() {
  return Date.now() - _lastInteractionAt;
}

/** Test hook — reset the idle clock (not used in production paths). */
export function _resetInteractionIdleTracker() {
  _lastInteractionAt = Date.now();
}
