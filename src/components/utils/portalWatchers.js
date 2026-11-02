/**
 * portalWatchers — client side of the patient-portal presence indicator
 * (owner spec Oct 23 2026).
 *
 * Patient portal pages ping patientPortalPing every 30s while visible; those
 * pings upsert PatientPortalPresence rows server-side (service-role, silent —
 * no WS broadcast). Dashboard devices poll patientPortalWatchers once a minute
 * for the selected date and this module stores the watcher list. Every
 * consumer (FAB badge, stop-card eye, map ring) intersects this list with the
 * deliveries IT can already see, which enforces the owner's gate rule
 * ("patient must have a delivery for that date") and all role scoping:
 *   • driver → only their own route's patients
 *   • dispatcher → only their stores' patients
 *   • admin → whatever driver's route they are viewing
 *
 * Zero entity reads/writes from dashboard clients — one function call per
 * minute per device, matched to the app's rate-limit budget.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { patientPortalWatchers } from '@/functions/patientPortalWatchers';

const POLL_INTERVAL_MS = 30 * 1000;

// patient_id -> watcher object
const _watchers = new Map();
let _version = 0;
const _listeners = new Set();

function _notify() {
  _version++;
  _listeners.forEach((l) => {
    try { l(); } catch (_) {}
  });
}

export const portalWatchersStore = {
  subscribe(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  },
  getVersion: () => _version,
  isWatching: (patientId) => _watchers.has(patientId),
  getWatchers: () => _watchers,

  /** Replace the watcher list; notifies only when something actually changed. */
  apply(list) {
    const next = new Map();
    for (const w of list || []) {
      if (w?.patient_id) next.set(w.patient_id, w);
    }
    let changed = next.size !== _watchers.size;
    if (!changed) {
      for (const [id, w] of next) {
        const prev = _watchers.get(id);
        if (!prev || prev.last_ping_at !== w.last_ping_at) { changed = true; break; }
      }
    }
    if (!changed) return;
    _watchers.clear();
    for (const [id, w] of next) _watchers.set(id, w);
    _notify();
  },
};

// ── Poller singleton ───────────────────────────────────────────────────────
let _timer = null;
let _date = null;
let _inFlight = false;
let _failCount = 0;

async function _pollNow() {
  if (!_date || _inFlight) return;
  _inFlight = true;
  try {
    const res = await patientPortalWatchers({ delivery_date: _date });
    const data = res?.data || res;
    portalWatchersStore.apply(data?.watchers || []);
    _failCount = 0;
  } catch (_) {
    // Back off after repeated failures (heated pool): skip 2 cycles, then retry.
    _failCount++;
  } finally {
    _inFlight = false;
  }
}

/**
 * Start polling for the given delivery date. Safe to call repeatedly with a
 * new date (date changes trigger an immediate refresh; the timer stays
 * single). Poll continues while the caller keeps it started.
 */
export function startPortalWatcherPolling(deliveryDate) {
  if (!deliveryDate) return;
  const dateStr = typeof deliveryDate === 'string' ? deliveryDate : deliveryDate.toISOString?.().slice(0, 10);
  if (!dateStr) return;
  const dateChanged = dateStr !== _date;
  _date = dateStr;
  if (_timer) {
    if (dateChanged) _pollNow(); // date switch — refresh immediately, timer keeps running
    return;
  }
  _pollNow();
  _timer = setInterval(_pollNow, POLL_INTERVAL_MS);
}

export function setPortalWatcherDate(deliveryDate) {
  if (!deliveryDate) return;
  const dateStr = typeof deliveryDate === 'string' ? deliveryDate : deliveryDate.toISOString?.().slice(0, 10);
  if (!dateStr || dateStr === _date) return;
  _date = dateStr;
  _pollNow();
}

export function stopPortalWatcherPolling() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _date = null;
  portalWatchersStore.apply([]);
}

// ── React bindings ─────────────────────────────────────────────────────────

/** Re-renders the component whenever the watcher list changes. */
export function usePortalWatcherVersion() {
  return useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
}

// ── STORE SCOPE (owner report Nov 2 2026) ───────────────────────────────────
// The watcher list is per DATE, not per store, so every consumer had to
// intersect it with deliveries it could see. A dispatcher CAN see another
// store's driver route, so Callingwood saw the glowing halo / eye / FAB ring
// for a Hampton patient (Kyle Jennings on Robert's route). Owner rule: a store
// dispatcher only sees these three patient-viewing indicators when the
// patient's delivery belongs to one of THEIR stores.
//   • app_owner / admin          → every route they view
//   • the stop's own driver      → their own route
//   • dispatcher / store_owner   → only deliveries whose store_id is in store_ids
export const isDeliveryInStoreScope = (delivery, appUser) => {
  if (!delivery || !appUser) return false;
  const roles = Array.isArray(appUser.app_roles) ? appUser.app_roles : [];
  if (appUser.is_app_owner === true || roles.includes('app_owner') || roles.includes('admin')) return true;
  if (appUser.user_id && delivery.driver_id && appUser.user_id === delivery.driver_id) return true;
  const stores = Array.isArray(appUser.store_ids) ? appUser.store_ids : [];
  return !!delivery.store_id && stores.includes(delivery.store_id);
};

/** True while this delivery's patient is watching AND is inside the viewer's store scope. */
export function isWatcherVisibleForDelivery(delivery, appUser) {
  if (!delivery?.patient_id || !_watchers.has(delivery.patient_id)) return false;
  return isDeliveryInStoreScope(delivery, appUser);
}

/** React binding: is this delivery's patient watching, within the viewer's store scope? */
export function useIsDeliveryPatientWatching(delivery, appUser) {
  useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
  return isWatcherVisibleForDelivery(delivery, appUser);
}

/** Legacy per-patient binding (kept for callers with no delivery in scope). */
export function useIsPatientWatching(patientId) {
  useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
  return !!patientId && _watchers.has(patientId);
}

/** How many of the given deliveries' patients are watching right now (store-scoped). */
export function usePortalWatchCount(deliveries, appUser = null) {
  useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
  return useMemo(() => {
    let count = 0;
    for (const d of deliveries || []) {
      if (!d?.patient_id || !_watchers.has(d.patient_id)) continue;
      // No appUser supplied → keep the old behaviour for callers that gate elsewhere.
      if (appUser && !isDeliveryInStoreScope(d, appUser)) continue;
      count++;
    }
    return count;
  }, [deliveries, appUser]);
}
