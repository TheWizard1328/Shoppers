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

  // 3a. Persist ONLY changed fields to server — NOT full records.
  // Writing full in-memory records can null out server-side encoded_polyline
  // and other large fields that may be absent from the in-memory representation.
  // Extract a minimal update payload per record: only the fields that are
  // meaningful for a completion event.
  if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
    tasks.push(
      Promise.allSettled(
        affectedFullRecords.map((rec) => {
          if (!rec?.id) return Promise.resolve(null);
          // Build minimal update — only fields relevant to a status change
          const update = {};
          if (typeof rec.status === 'string') update.status = rec.status;
          if (rec.actual_delivery_time != null) update.actual_delivery_time = rec.actual_delivery_time;
          if (rec.arrival_time != null) update.arrival_time = rec.arrival_time;
          if (rec.isNextDelivery !== undefined) update.isNextDelivery = rec.isNextDelivery;
          if (rec.stop_order != null) update.stop_order = rec.stop_order;
          if ('finished_leg_encoded_polyline' in rec) update.finished_leg_encoded_polyline = rec.finished_leg_encoded_polyline;
          if ('finished_leg_transport_mode' in rec) update.finished_leg_transport_mode = rec.finished_leg_transport_mode;
          if ('PolylineUpdated' in rec) update.PolylineUpdated = rec.PolylineUpdated;
          if (rec.cod_payments != null) update.cod_payments = rec.cod_payments;
          if (rec.signature_image_url != null) update.signature_image_url = rec.signature_image_url;
          if (rec.delivery_route_breadcrumbs != null) update.delivery_route_breadcrumbs = rec.delivery_route_breadcrumbs;
          if (typeof rec.travel_dist === 'number') update.travel_dist = rec.travel_dist;
          if (rec.delivery_time_eta != null) update.delivery_time_eta = rec.delivery_time_eta;
          // If no meaningful fields to update, skip the server write entirely
          if (Object.keys(update).length === 0) return Promise.resolve(null);
          return base44.entities.Delivery.update(rec.id, update).catch(() => null);
        })
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
