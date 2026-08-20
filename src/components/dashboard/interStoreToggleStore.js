/**
 * interStoreToggleStore.js
 * Tiny pub/sub store for the InterStore markers toggle (dispatchers only).
 * Kept outside React state so the segmented button (StatsPanel) and the map
 * layer (InterStoreMarkers) stay in sync without prop drilling through the
 * deep Dashboard → DashboardView → MapSection → DeliveryMap chain.
 *
 * The toggle has three states:
 *   - 'off'      → no InterStore markers, both button halves neutral
 *   - 'pickup'   → left (up-arrow) half active (red). Click a marker to add
 *                  a pickup FROM that InterStore location TO the dispatcher's store.
 *   - 'dropoff'  → right (down-arrow) half active (green). Click a marker to add
 *                  a dropoff TO that InterStore location FROM the dispatcher's store.
 *
 * Persisted to localStorage so the preference survives reloads.
 */

const LS_KEY = 'rxdeliver_interstore_mode';

const isValid = (v) => v === 'pickup' || v === 'dropoff' || v === 'off';

let _mode = (() => {
  try {
    const v = localStorage.getItem(LS_KEY);
    return isValid(v) ? v : 'off';
  } catch {
    return 'off';
  }
})();

const listeners = new Set();

export function getInterStoreMode() {
  return _mode;
}

/** Backward-compat boolean getter used by older callers. */
export function isInterStoreActive() {
  return _mode !== 'off';
}

export function setInterStoreMode(mode) {
  const next = isValid(mode) ? mode : 'off';
  if (next === _mode) return;
  _mode = next;
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* ignore quota errors */
  }
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      /* listener errors are non-fatal */
    }
  });
}

/** Toggle the pickup (left) half. Clicking it again turns the whole toggle off. */
export function setInterStorePickup() {
  setInterStoreMode(_mode === 'pickup' ? 'off' : 'pickup');
}

/** Toggle the dropoff (right) half. Clicking it again turns the whole toggle off. */
export function setInterStoreDropoff() {
  setInterStoreMode(_mode === 'dropoff' ? 'off' : 'dropoff');
}

/** Legacy single toggle — kept for any older callers. Defaults to pickup when off. */
export function toggleInterStore() {
  setInterStoreMode(_mode === 'off' ? 'pickup' : 'off');
}

export function subscribeInterStore(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}