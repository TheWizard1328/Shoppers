import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { enterBatchSilentMode, exitBatchSilentMode } from './entityMutations';

const queueState = {
  completionJobs: new Map(),
  appUserUpdates: new Map()
};

const COMPLETION_DEBOUNCE_MS = 1500;

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const mergeAppUserPayload = (current = {}, incoming = {}) => ({ ...current, ...incoming });

const flushAppUserUpdate = async (entry) => {
  const { appUserId, payload } = entry;
  entry.timer = null;
  if (!appUserId || !/^[a-f0-9]{24}$/i.test(String(appUserId))) return null;
  entry.inFlight = base44.entities.AppUser.update(appUserId, payload);
  try {
    const result = await entry.inFlight;
    entry.lastPayloadKey = stableStringify(payload);
    return result;
  } finally {
    entry.inFlight = null;
    if (entry.pendingPayload) {
      entry.payload = mergeAppUserPayload({}, entry.pendingPayload);
      entry.pendingPayload = null;
      entry.promise = scheduleAppUserUpdate(appUserId, entry.payload);
    } else {
      queueState.appUserUpdates.delete(appUserId);
    }
  }
};

export const scheduleAppUserUpdate = (appUserId, payload, delay = COMPLETION_DEBOUNCE_MS) => {
  if (!appUserId || !payload) return Promise.resolve(null);
  const payloadKey = stableStringify(payload);
  let entry = queueState.appUserUpdates.get(appUserId);

  if (!entry) {
    entry = {
      appUserId,
      payload: {},
      pendingPayload: null,
      timer: null,
      inFlight: null,
      promise: null,
      resolve: null,
      reject: null,
      lastPayloadKey: null
    };
    queueState.appUserUpdates.set(appUserId, entry);
  }

  if (entry.lastPayloadKey === payloadKey && !entry.timer && !entry.inFlight) {
    return Promise.resolve(null);
  }

  if (entry.inFlight) {
    entry.pendingPayload = mergeAppUserPayload(entry.pendingPayload || entry.payload || {}, payload);
    return entry.promise || entry.inFlight;
  }

  entry.payload = mergeAppUserPayload(entry.payload, payload);
  if (entry.timer) clearTimeout(entry.timer);

  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  entry.timer = setTimeout(async () => {
    try {
      const result = await flushAppUserUpdate(entry);
      entry.resolve?.(result);
    } catch (error) {
      entry.reject?.(error);
      queueState.appUserUpdates.delete(appUserId);
    }
  }, delay);

  return entry.promise;
};

const flushCompletionJob = async (entry) => {
  entry.timer = null;
  const { setOffDuty, driverId, deliveryDate, nextDeliveryId, lastCompletedDeliveryId, affectedFullRecords } = entry.payload;

  // NOTE: purgeAndRegeneratePolylines (HERE API) is intentionally never called here.
  // Stop orders do not change on complete/fail/cancel, so existing polylines remain valid.
  // Route optimization only runs on explicit user actions (Accept All, Start, FAB re-optimize)
  // or when stops are added/removed from the route (retry, return, restart).

  // ── STEP 1: Pre-seed IDB with all affected records BEFORE backend writes ──
  // This ensures that when backend writes trigger WS broadcasts, the device's
  // own IDB is already authoritative — incoming WS events won't overwrite
  // optimistic local state with stale data.
  if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
    const validRecords = affectedFullRecords.filter((r) => r?.id);
    if (validRecords.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, validRecords).catch(() => null);
    }
  }

  // ── STEP 2: Register ALL affected delivery IDs in smartRefreshManager ──────
  // This suppresses per-record UI re-renders when our own server writes trigger
  // WebSocket broadcasts back to this device. The local IDB state (pre-seeded
  // above) is already authoritative, so WS echoes should be silently merged
  // without triggering a UI re-render cascade.
  if (Array.isArray(affectedFullRecords) && driverId && deliveryDate) {
    try {
      const { smartRefreshManager } = await import('./smartRefreshManager');
      for (const rec of affectedFullRecords) {
        if (rec?.id) smartRefreshManager.registerPendingUpdate(rec.id, driverId, deliveryDate);
      }
    } catch (_) {}
  }

  // ── STEP 3: Write to server in batch silent mode ───────────────────────────
  // enterBatchSilentMode suppresses per-record notifyMutation + broadcastMutation
  // from entityMutations, so each server write does NOT trigger a separate UI
  // update or outgoing WS broadcast. The server's own WS broadcasts are suppressed
  // by the smartRefreshManager registration above.
  enterBatchSilentMode();

  const tasks = [];

  // 3a. Persist full records for all affected stops to online DB
  if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
    tasks.push(
      Promise.allSettled(
        affectedFullRecords.map((rec) => rec?.id ? base44.entities.Delivery.update(rec.id, rec).catch(() => null) : Promise.resolve(null))
      )
    );
  }

  // 3b. Set isNextDelivery flag on backend (authoritative server-side confirmation)
  //     This also repairs stop_order server-side via buildStopOrderRepairs.
  if (driverId && deliveryDate) {
    tasks.push(
      base44.functions.invoke('setNextDeliveryFlag', {
        driverId,
        deliveryDate,
        targetDeliveryId: nextDeliveryId || null
      }).catch(() => null)
    );
  }

  // 3c. Set driver off-duty if last stop completed
  if (setOffDuty && entry.payload.appUserId && /^[a-f0-9]{24}$/i.test(String(entry.payload.appUserId))) {
    tasks.push(
      scheduleAppUserUpdate(entry.payload.appUserId, {
        driver_status: 'off_duty',
        location_tracking_enabled: false
      }, 0).catch(() => null)
    );
  }

  entry.inFlight = Promise.allSettled(tasks);
  try {
    await entry.inFlight;
    exitBatchSilentMode();

    // ── STEP 4: Broadcast to OTHER devices (not this one) ───────────────────
    // IDB is already pre-seeded above + smartRefreshManager registered, so
    // this device ignores incoming WS echoes. Other devices receive fresh
    // authoritative data. We use broadcastMutation for cross-device delivery.
    //
    // CRITICAL: Only broadcast if we did NOT already write via entityMutations
    // (which does its own broadcast). Since we're in batch silent mode above,
    // the entity writes above don't broadcast. So we broadcast once here.
    if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0 && driverId && deliveryDate) {
      try {
        const { broadcastMutation } = await import('./realtimeSync');
        for (const rec of affectedFullRecords) {
          if (rec?.id) broadcastMutation('Delivery', 'update', rec.id, rec).catch(() => null);
        }
      } catch (_) {}
    }

    // ── STEP 5: Single deliveriesUpdated event for UI refresh ───────────────
    // One event with all fresh data → one UI re-render, not N.
    if (driverId && deliveryDate) {
      try {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId,
            deliveryDate,
            triggeredBy: 'completionSideEffects',
            freshDeliveries: affectedFullRecords || [],
            preserveLocalState: true
          }
        }));
      } catch (_) {}
    }

    return;
  } catch (err) {
    exitBatchSilentMode();
    throw err;
  } finally {
    entry.inFlight = null;
    if (entry.pendingPayload) {
      entry.payload = { ...entry.payload, ...entry.pendingPayload };
      entry.pendingPayload = null;
      entry.promise = scheduleCompletionSideEffects(entry.payload);
    } else {
      queueState.completionJobs.delete(entry.key);
    }
  }
};

/**
 * scheduleCompletionSideEffects
 *
 * Called after a stop is completed/failed/cancelled.
 * Runs non-blocking background tasks:
 *  1. Pre-seed IDB with affected records
 *  2. Register all affected IDs in smartRefreshManager (suppress WS echo)
 *  3. Write to server in batch silent mode (suppress per-record UI updates)
 *  4. Broadcast to other devices
 *  5. Single deliveriesUpdated event for UI refresh
 *
 * @param {object} payload
 *   - driverId: string
 *   - deliveryDate: string
 *   - nextDeliveryId: string|null
 *   - lastCompletedDeliveryId: string|null
 *   - setOffDuty: boolean
 *   - appUserId: string|null
 *   - affectedFullRecords: Delivery[] — full record objects for all stops changed in this action
 *   - skipRouteOptimization: boolean (legacy, unused)
 *   - skipNextLegPolylineRefresh: boolean (legacy, unused)
 */
export const scheduleCompletionSideEffects = (payload, delay = COMPLETION_DEBOUNCE_MS) => {
  const key = `${payload?.driverId || 'unknown'}:${payload?.deliveryDate || 'unknown'}`;
  let entry = queueState.completionJobs.get(key);

  if (!entry) {
    entry = {
      key,
      payload: {},
      pendingPayload: null,
      timer: null,
      inFlight: null,
      promise: null,
      resolve: null,
      reject: null
    };
    queueState.completionJobs.set(key, entry);
  }

  if (entry.inFlight) {
    entry.pendingPayload = { ...(entry.pendingPayload || entry.payload), ...payload };
    return entry.promise || entry.inFlight;
  }

  entry.payload = { ...entry.payload, ...payload };
  if (entry.timer) clearTimeout(entry.timer);

  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  entry.timer = setTimeout(async () => {
    try {
      const result = await flushCompletionJob(entry);
      entry.resolve?.(result);
    } catch (error) {
      entry.reject?.(error);
      queueState.completionJobs.delete(key);
    }
  }, delay);

  return entry.promise;
};
