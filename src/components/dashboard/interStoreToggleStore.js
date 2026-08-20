/**
 * interStoreToggleStore.js
 * Tiny pub/sub store for the InterStore markers toggle (dispatchers only).
 * Kept outside React state so the toggle button (StatsPanel) and the map
 * layer (InterStoreMarkers) stay in sync without prop drilling through the
 * deep Dashboard → DashboardView → MapSection → DeliveryMap chain.
 *
 * Persisted to localStorage so the preference survives reloads.
 */

const LS_KEY = 'rxdeliver_show_interstore';

let _active = (() => {
  try {
    return localStorage.getItem(LS_KEY) === 'true';
  } catch {
    return false;
  }
})();

const listeners = new Set();

export function isInterStoreActive() {
  return _active;
}

export function setInterStoreActive(value) {
  const next = !!value;
  if (next === _active) return;
  _active = next;
  try {
    localStorage.setItem(LS_KEY, String(next));
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

export function toggleInterStore() {
  setInterStoreActive(!_active);
}

export function subscribeInterStore(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}