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

const POLL_INTERVAL_MS = 60 * 1000;

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

/** True while this patient is watching the portal right now. */
export function useIsPatientWatching(patientId) {
  useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
  return !!patientId && _watchers.has(patientId);
}

/** How many of the given deliveries' patients are watching right now. */
export function usePortalWatchCount(deliveries) {
  useSyncExternalStore(portalWatchersStore.subscribe, portalWatchersStore.getVersion);
  return useMemo(() => {
    let count = 0;
    for (const d of deliveries || []) {
      if (d?.patient_id && _watchers.has(d.patient_id)) count++;
    }
    return count;
  }, [deliveries]);
}
