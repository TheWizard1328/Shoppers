/**
 * Real-time Sync Client - WebSocket subscriptions for Base44 entities
 * 
 * Uses base44.entities.*.subscribe() to receive real-time updates for:
 * - Delivery entities
 * - Patient entities
 * - AppUser entities
 * 
 * Broadcasts changes to the app and notifies all listeners.
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { isDeliveryRelevantToCurrentSelection } from './deliveryCardUtils';
import { getLocalTimestampFromDate } from './localTimeHelper';
import { applyRealtimeMergeWithLockout } from './completionLockout';

const rsTime = () => new Date().toLocaleTimeString('en-CA', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Global listeners for real-time updates
const listeners = new Set();

// Pause flag — when true, flushBuffered skips UI dispatches (but still saves to offline DB)
let _realtimePaused = false;

export const pauseRealtimeSync = () => {
  _realtimePaused = true;
  console.log(`⏸️ [RealtimeSync] [${rsTime()}] UI broadcasts paused`);
};

export const resumeRealtimeSync = () => {
  _realtimePaused = false;
  console.log(`▶️ [RealtimeSync] [${rsTime()}] UI broadcasts resumed`);
};

// Buffered inbound realtime events to reduce UI thrash.
// A non-zero debounce gives the IDB write lock time to commit both events from a
// two-broadcast polyline save before flushBuffered reads the IDB snapshot back.
const DEBOUNCE_MS = 50;
const eventBuffers = {
  Delivery: new Map(),
  Patient: new Map(),
  AppUser: new Map(),
  Payroll: new Map(),
  Message: new Map(),
  GoogleAPILog: new Map(),
  AppSettings: new Map(),
  InterStoreLocation: new Map(),
  RxTempLogs: new Map(),
};
const flushTimers = {};

// Fields that must survive a partial follow-up WS event for the same record.
// When two WS events arrive for the same delivery (e.g. the polyline write fires
// two events because the backend does two field updates in sequence), the second
// event often only carries the timestamp field. The merge must preserve any
// polyline/route fields from the first event so they are not silently dropped.
const POLYLINE_PRESERVE_FIELDS = [
  'encoded_polyline', 'travel_dist', 'polyline_saved_at',
  'transport_mode', 'estimated_distance_km', 'estimated_duration_minutes',
];

function bufferEvent(entityName, payload) {
  const buf = eventBuffers[entityName] || new Map();
  eventBuffers[entityName] = buf;
  const prev = buf.get(payload.id);
  if (prev) {
    const mergedChanged = Array.from(new Set([...(prev.changedFields || []), ...(payload.changedFields || [])]));
    const mergedData = { ...(prev.data || {}), ...(payload.data || {}) };

    // CRITICAL: If the incoming payload is missing key polyline fields that the previous
    // buffered event DID carry, restore them. This prevents a follow-up timestamp-only
    // WS event (e.g. just polyline_saved_at + updated_date) from wiping encoded_polyline.
    if (entityName === 'Delivery' && prev.data && payload.data) {
      for (const field of POLYLINE_PRESERVE_FIELDS) {
        if (prev.data[field] && !payload.data[field]) {
          mergedData[field] = prev.data[field];
        }
      }
    }

    buf.set(payload.id, {
      ...prev,
      ...payload,
      data: mergedData,
      changedFields: mergedChanged,
      isRemoteUpdate: prev.isRemoteUpdate || payload.isRemoteUpdate,
    });
  } else {
    buf.set(payload.id, payload);
  }
  if (!flushTimers[entityName]) {
    flushTimers[entityName] = setTimeout(() => flushBuffered(entityName), DEBOUNCE_MS);
  }
}

async function flushBuffered(entityName) {
  const buf = eventBuffers[entityName];
  if (!buf || buf.size === 0) { if (flushTimers[entityName]) { clearTimeout(flushTimers[entityName]); flushTimers[entityName] = null; } return; }
  const items = Array.from(buf.values());
  buf.clear();
  if (flushTimers[entityName]) { clearTimeout(flushTimers[entityName]); flushTimers[entityName] = null; }

  let fullReplacementData = null;
  try {
    if (entityName === 'Delivery') {
      const selectedDate = (typeof window !== 'undefined' ? window.__appSelectedDate : null) || localStorage.getItem('global_selected_date') || localStorage.getItem('app_selectedDate');
      if (selectedDate) {
        fullReplacementData = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
      }
    } else if (entityName === 'AppUser') {
      fullReplacementData = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    } else if (entityName === 'Patient') {
      fullReplacementData = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    } else if (entityName === 'Payroll') {
      fullReplacementData = await offlineDB.getAll(offlineDB.STORES.PAYROLL);
    } else if (entityName === 'AppSettings') {
      fullReplacementData = null;
    }
  } catch (error) {
    console.warn(`⚠️ [RealtimeSync] [${rsTime()}] Failed to load full replacement data for ${entityName}:`, error.message);
  }

  // If a form save / mutation is in progress, skip all UI broadcasts.
  // The offline DB saves above already ran — we just don't want to clobber optimistic UI state.
  if (_realtimePaused) {
    console.log(`⏸️ [RealtimeSync] [${rsTime()}] Skipping UI broadcast for ${entityName} — paused during mutation`);
    return;
  }

  // Notify listeners and dispatch window events once per record
  items.forEach(({ entityType, eventType, data, id, updatedBy, changedFields }) => {
    listeners.forEach(callback => {
      try {
        callback({
          entityType,
          entity: entityType,
          eventType,
          type: eventType,
          data,
          id,
          updatedBy,
          changedFields
        });
      } catch (err) { console.error(`❌ [RealtimeSync] [${rsTime()}] Listener error:`, err); }
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entityName}`, { detail: { type: eventType, id, data, updatedBy, changedFields } }));
      if (entityName === 'AppUser' && (eventType === 'create' || eventType === 'update') && data) {
        window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: data, fromRealtime: true } }));
        if (data.preferred_travel_mode && data.user_id) {
          window.dispatchEvent(new CustomEvent('driverTravelModeChanged', {
            detail: { driverId: data.user_id, travelMode: data.preferred_travel_mode, fromRealtime: true }
          }));
        }
      }
      if (entityName === 'Store' && data) {
        window.dispatchEvent(new CustomEvent('storeUpdated', {
          detail: { storeId: id, updatedStore: data, fromRealtime: true }
        }));
      }
      if (entityName === 'AppSettings' && data) {
        window.dispatchEvent(new CustomEvent('appSettingsUpdated', {
          detail: { type: eventType, id, data, fromRealtime: true }
        }));
        window.dispatchEvent(new CustomEvent('refreshCurrentUserFromSmartRefresh', {
          detail: { source: 'appSettingsRealtime', type: eventType, id, data }
        }));
        window.dispatchEvent(new CustomEvent('adminUtilitiesAppSettingsUpdated', {
          detail: { source: 'appSettingsRealtime', type: eventType, id, data }
        }));
      }
      if (entityName === 'Payroll' && data) {
        window.dispatchEvent(new CustomEvent('payrollUpdated', {
          detail: { type: eventType, id, data, fromRealtime: true }
        }));
      }
      if (entityName === 'RxTempLogs' && data) {
        // Only broadcast latest_reading + identifying fields — the full temperature_readings
        // array is intentionally excluded from realtime events to keep payloads small.
        // LiveTempBadge and other consumers re-read the full record from offline DB as needed.
        const { temperature_readings: _omitted, ...slimData } = data;
        window.dispatchEvent(new CustomEvent('rxTempLogsUpdated', {
          detail: { type: eventType, id, data: slimData, fromRealtime: true }
        }));
      }
    }
  });

  // CRITICAL: For polyline updates — if IDB returned null/empty (e.g. receiving device hasn't
  // synced this date yet), build fullReplacementData from in-memory state merged with the
  // incoming WS payload so the deliveriesUpdated event always fires with the new polyline.
  if (typeof window !== 'undefined' && entityName === 'Delivery' && !Array.isArray(fullReplacementData)) {
    const polylineItems = items.filter(item => item?.data?.encoded_polyline);
    if (polylineItems.length > 0) {
      const localDeliveries = window.__appDeliveries;
      const base = Array.isArray(localDeliveries) ? localDeliveries : [];
      const snapshotMap = new Map(base.map(d => [d.id, d]));
      polylineItems.forEach(({ data: itemData }) => {
        if (!itemData?.id) return;
        const existing = snapshotMap.get(itemData.id);
        snapshotMap.set(itemData.id, existing ? { ...existing, ...itemData } : itemData);
      });
      fullReplacementData = Array.from(snapshotMap.values());
      console.log(`🗺️ [RealtimeSync] [${rsTime()}] Built polyline fallback snapshot: ${fullReplacementData.length} deliveries`);
    }
  }

  if (typeof window !== 'undefined' && entityName === 'Delivery' && Array.isArray(fullReplacementData)) {
    const selectedDate = (typeof window !== 'undefined' ? window.__appSelectedDate : null) || localStorage.getItem('global_selected_date') || localStorage.getItem('app_selectedDate');
    const selectedDriverId = (typeof window !== 'undefined' ? window.__appSelectedDriverId : null) || localStorage.getItem('global_selected_driver') || localStorage.getItem('app_selectedDriver');
    const relevantItems = items.filter((item) => item?.data && isDeliveryRelevantToCurrentSelection(item.data));
    const deletedItems = items.filter((item) => item.eventType === 'delete');
    const candidateDriverIds = Array.from(new Set([
      ...(relevantItems.map((item) => item?.data?.driver_id).filter(Boolean)),
      ...(deletedItems.map((item) => item?.data?.driver_id).filter(Boolean))
    ]));

    relevantItems.forEach((item) => {
      if (Array.isArray(item.changedFields) && item.changedFields.includes('status') && item.data?.status === 'in_transit') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('deliveryBecameInTransit', {
            detail: {
              source: 'realtimeSyncStatusUpdate',
              deliveryId: item.id,
              driverId: item.data?.driver_id,
              deliveryDate: item.data?.delivery_date,
              durationMs: 500
            }
          }));
        }
      }

      if (Array.isArray(item.changedFields) && item.changedFields.includes('isNextDelivery') && item.data?.isNextDelivery) {
        scheduleAfterUISettled(() => {
          triggerCenterNextDeliveryCard({
            source: 'realtimeSyncIsNextDelivery',
            deliveryId: item.id,
            driverId: item.data?.driver_id,
            deliveryDate: item.data?.delivery_date
          });
          // CRITICAL: Re-engage FAB lock in phases 2/3 when the next stop flag is set.
          // This handles the case where handleStartDelivery or optimizeRemainingStops
          // updates isNextDelivery on the backend and it arrives via WebSocket.
          // Resolve next stop location — include cycling marker coords if applicable
          const _nextStopData = item.data;
          let _nextStopLocation = null;
          if (_nextStopData?.is_cycling_start_marker && _nextStopData?.cycling_start_latitude && _nextStopData?.cycling_start_longitude) {
            _nextStopLocation = { latitude: _nextStopData.cycling_start_latitude, longitude: _nextStopData.cycling_start_longitude };
          }
          window.dispatchEvent(new CustomEvent('isNextDeliveryFlagUpdated', {
            detail: {
              deliveryId: item.id,
              driverId: item.data?.driver_id,
              deliveryDate: item.data?.delivery_date,
              nextStopId: item.id,
              nextStopLocation: _nextStopLocation,
            }
          }));
        });
      }
    });

    // CRITICAL: If ALL buffered events came from the current device (same user), skip the
    // full-replacement dispatch. The optimistic local state already reflects the correct
    // values and an IDB snapshot taken mid-write would contain stale isNextDelivery/status
    // values that would momentarily bounce the UI back before the next WebSocket event
    // (for the isNextDelivery write) arrives to correct it.
    // EXCEPTION: If any item carries polyline data (encoded_polyline), always dispatch so
    // the map updates on all devices — polylines are written by the backend and never
    // set optimistically on the client.
    const hasPolylineUpdates = relevantItems.some((item) =>
      item?.changedFields?.includes('encoded_polyline') ||
      (item?.data && typeof item.data.encoded_polyline === 'string' && item.data.encoded_polyline.length > 0)
    );
    const allFromLocalDevice = relevantItems.length > 0 && relevantItems.every((item) => !item.isRemoteUpdate);

    // CRITICAL: Also check smartRefreshManager for pending local updates.
    // Backend service-role writes (setNextDeliveryFlag, stop_order repairs) use
    // asServiceRole which sets updated_by_name to the service account, not the
    // current user. This makes isRemoteUpdate=true for our own server-side writes,
    // defeating the allFromLocalDevice optimization. By also checking the
    // smartRefreshManager pending registry, we can recognize WS echoes from our
    // own completion/stop-order operations and skip the UI re-render cascade.
    let allHavePendingUpdates = false;
    if (!allFromLocalDevice && relevantItems.length > 0) {
      try {
        const { smartRefreshManager } = await import('./smartRefreshManager');
        allHavePendingUpdates = relevantItems.every((item) =>
          item?.id && smartRefreshManager.hasPendingUpdate(item.id)
        );
      } catch (_) {}
    }

    if ((allFromLocalDevice || allHavePendingUpdates) && deletedItems.length === 0 && !hasPolylineUpdates) {
      // Local-only writes — skip full replacement. The optimistic IDB state is already correct.
      // Individual offline DB saves in the subscription handler have already persisted each record.
      return;
    }

    // CRITICAL: When a remote full-replacement snapshot arrives, preserve any optimistic
    // isNextDelivery=true flags set locally that the backend hasn't confirmed yet.
    // This prevents the badge reverting when a remote driver's update triggers a batch flush.
    // ALSO: Overlay the buffered items' data directly onto the snapshot so polyline updates
    // (and any other fields written by the backend) are never lost due to IDB read races.
    if (Array.isArray(fullReplacementData) && fullReplacementData.length > 0) {
      const snapshotMap = new Map(fullReplacementData.map(d => [d.id, d]));

      // Overlay every buffered item's data onto the snapshot — this guarantees polylines
      // (and other backend-written fields) are present even if IDB hasn't fully committed yet.
      // Also apply the completion lockout so in-flight complete actions aren't reverted.
      items.forEach(({ data: itemData }) => {
        if (!itemData?.id) return;
        const existing = snapshotMap.get(itemData.id);
        if (existing) {
          const merged = { ...existing, ...itemData };
          const lockoutProtected = applyRealtimeMergeWithLockout(itemData.id, merged, existing);
          snapshotMap.set(itemData.id, lockoutProtected);
        }
        // If the item isn't in the snapshot but carries a polyline update, add it directly
        // so polyline saves on edge-case deliveries (e.g. IDB lagged behind) are never dropped.
        if (!existing && typeof itemData?.encoded_polyline === 'string' && itemData.encoded_polyline.length > 0) {
          snapshotMap.set(itemData.id, itemData);
        }
        // CRITICAL: If the item IS in the snapshot but the snapshot's encoded_polyline is stale
        // (IDB write hadn't committed yet when the snapshot was read), force the new polyline in.
        // This is the primary cause of breadcrumb edits not updating on other devices.
        if (existing && typeof itemData?.encoded_polyline === 'string' && itemData.encoded_polyline.length > 0) {
          snapshotMap.set(itemData.id, { ...snapshotMap.get(itemData.id), encoded_polyline: itemData.encoded_polyline, travel_dist: itemData.travel_dist ?? existing.travel_dist, polyline_saved_at: itemData.polyline_saved_at ?? existing.polyline_saved_at });
        }
      });

      // Read the in-memory Layout deliveries to find locally-set isNextDelivery=true flags.
      // CRITICAL: Skip any delivery that has an active completion lockout — the lockout means
      // an in-flight complete action has already set isNextDelivery=false on that stop, and
      // the localDeliveries loop must not re-apply the stale pre-optimistic true value.
      const localDeliveries = window.__appDeliveries;
      if (Array.isArray(localDeliveries)) {
        const { isFieldLocked } = await import('./completionLockout');
        localDeliveries.forEach(local => {
          if (!local?.id || !local.isNextDelivery) return;
          // Don't override if this delivery's isNextDelivery is actively locked
          if (isFieldLocked(local.id, 'isNextDelivery')) return;
          const snap = snapshotMap.get(local.id);
          if (snap && !snap.isNextDelivery) {
            snapshotMap.set(local.id, { ...snap, isNextDelivery: true });
          }
        });
      }
      fullReplacementData = Array.from(snapshotMap.values());
    } else if (hasPolylineUpdates && allFromLocalDevice) {
      // Editing device — polyline was just saved by this user.
      // The pullToSyncDataReady broadcast from PolylineViewer may not have settled yet,
      // so build the snapshot from IDB (which PolylineViewer already wrote before
      // calling the backend function) merged with buffered item data to guarantee
      // the new encoded_polyline is present.
      const localDeliveries = window.__appDeliveries;
      const base = Array.isArray(localDeliveries) ? localDeliveries : [];
      const snapshotMap = new Map(base.map(d => [d.id, d]));
      items.forEach(({ data: itemData }) => {
        if (!itemData?.id) return;
        const existing = snapshotMap.get(itemData.id);
        // Always overlay the buffered data — this is the authoritative new value
        snapshotMap.set(itemData.id, existing ? { ...existing, ...itemData } : itemData);
      });
      fullReplacementData = Array.from(snapshotMap.values());
    }

    // CRITICAL: If we have polyline updates but fullReplacementData is null/empty
    // (e.g. the receiving device's IDB snapshot for this date is empty or not yet synced),
    // build the delivery list directly from the buffered item data + in-memory state
    // so the map always receives the new encoded_polyline immediately.
    if (hasPolylineUpdates && (!fullReplacementData || fullReplacementData.length === 0)) {
      const localDeliveries = window.__appDeliveries;
      const base = Array.isArray(localDeliveries) ? localDeliveries : [];
      const snapshotMap = new Map(base.map(d => [d.id, d]));
      items.forEach(({ data: itemData }) => {
        if (!itemData?.id) return;
        const existing = snapshotMap.get(itemData.id);
        snapshotMap.set(itemData.id, existing ? { ...existing, ...itemData } : itemData);
      });
      fullReplacementData = Array.from(snapshotMap.values());
    }

    // CRITICAL: Dispatch ALL deliveries for the selected date — never filter by driver here.
    // The UI layer (Dashboard) handles per-driver filtering. Filtering here would drop other
    // drivers' deliveries from Layout state, causing them to disappear from the dashboard.
    let allDateDeliveries = (fullReplacementData || []).filter((delivery) => {
      if (!delivery) return false;
      if (selectedDate && delivery.delivery_date && delivery.delivery_date !== selectedDate) return false;
      return true;
    });

    // CRITICAL: For polyline updates — if the snapshot doesn't contain the updated
    // delivery, inject the WS payload directly so it always reaches the map.
    if (hasPolylineUpdates && relevantItems.length > 0) {
      const snapshotIds = new Set(allDateDeliveries.map(d => d.id));
      const missing = relevantItems.filter(item =>
        item?.data?.encoded_polyline && !snapshotIds.has(item.id)
      );
      if (missing.length > 0) {
        allDateDeliveries = [...allDateDeliveries, ...missing.map(i => i.data)];
      }
    }

    // CRITICAL: Ensure ETA changes trigger immediate UI update
    const hasETAChanges = relevantItems.some((item) => 
      Array.isArray(item.changedFields) && 
      (item.changedFields.includes('delivery_time_eta') || item.changedFields.includes('estimated_duration_minutes'))
    );
    
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        deliveries: allDateDeliveries,
        freshDeliveries: allDateDeliveries,
        deletedIds: deletedItems.map((item) => item.id).filter(Boolean),
        immediate: true,
        deliveryDate: selectedDate,
        triggeredBy: 'realtimeBufferedFullRefresh',
        source: 'realtime_sync',
        fromRealtime: true,
        fullReplacement: false,
        skipMapPhaseOneRefresh: true,
        preserveLocalState: true,
        skipDriverLocationRefresh: true,
        forceETAUpdate: hasETAChanges,
        forcePolylineUpdate: hasPolylineUpdates,
      }
    }));
  }

  if (typeof window !== 'undefined' && entityName === 'AppUser') {
    // CRITICAL: ALWAYS use targeted merge for AppUser updates — never dispatch a full
    // IDB snapshot. The snapshot is read asynchronously and can contain a stale
    // location_updated_at that was just overwritten by the WebSocket save, causing
    // the marker to flicker back to its old position/color mid-animation.
    //
    // Strategy:
    //   • For every WS update (location-only OR full field change), dispatch only the
    //     incoming records directly — the freshest data we have.
    //   • Record the WS update timestamp per-driver on window.__wsAppUserLastUpdate
    //     so the SmartRefresh poll can skip overwriting drivers updated very recently.
    const now = Date.now();
    if (!window.__wsAppUserLastUpdate) window.__wsAppUserLastUpdate = new Map();
    items.forEach(({ data: itemData }) => {
      if (!itemData) return;
      const key = itemData.user_id || itemData.id;
      if (key) window.__wsAppUserLastUpdate.set(key, now);
    });

    // Dispatch the raw incoming data — IDB save already completed above this point.
    const incomingUsers = items.map(i => i.data).filter(Boolean);
    incomingUsers.forEach((itemData) => {
      window.dispatchEvent(new CustomEvent('appUserUpdated', {
        detail: { appUser: itemData, fromRealtime: true }
      }));
    });
    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
      detail: {
        appUsers: incomingUsers,
        fromRealtime: true,
        mergeMode: 'merge',
      }
    }));
  }

  if (typeof window !== 'undefined' && entityName === 'Patient' && Array.isArray(fullReplacementData)) {
    window.dispatchEvent(new CustomEvent('patientsUpdated', {
      detail: {
        patients: fullReplacementData,
        fromRealtime: true,
        fullReplacement: true
      }
    }));
  }

  if (typeof window !== 'undefined' && entityName === 'Payroll' && Array.isArray(fullReplacementData)) {
    window.dispatchEvent(new CustomEvent('payrollRecordsUpdated', {
      detail: {
        payrollRecords: fullReplacementData,
        fromRealtime: true,
        fullReplacement: true
      }
    }));
  }


  // Center next delivery card when the next-stop flag becomes active on any relevant device
  if (entityName === 'Delivery' && items.some(it => shouldCenterForDeliveryUpdate(it.data, it.changedFields))) {
    scheduleAfterUISettled(() => {
      triggerCenterNextDeliveryCard({ source: 'realtimeSyncBuffered' });
    });
  }
}


// Active subscription unsubscribers
const activeSubscriptions = new Map();

// Client state
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Helpers for auto-centering the "next delivery" card after UI settles
let centerEventTimer = null;
const scheduleAfterUISettled = (fn) => {
  if (typeof window === 'undefined') return;
  const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  // Double RAF + microtask to wait for React state commits/paint
  raf(() => raf(() => setTimeout(fn, 0)));
};

const getEffectiveUser = () => {
  try {
    const cache = sessionStorage.getItem('effectiveUserCache');
    if (cache) return JSON.parse(cache);
  } catch {}
  return null;
};

const isDeliveryVisibleToUser = (delivery) => {
  const eff = getEffectiveUser();
  if (!eff) return true; // Fallback: don't block if unknown
  const roles = eff?.appUser?.app_roles || eff?.user?.app_roles || [];
  const appUserId = eff?.appUser?.id || eff?.user?.app_user_id;
  const userId = eff?.user?.id || eff?.user?.user_id;

  // Driver: visible if delivery driver_id matches app user or user id (support both schemas)
  if (roles.includes('driver')) {
    if (delivery?.driver_id && (delivery.driver_id === appUserId || delivery.driver_id === userId)) return true;
  }

  // Dispatcher/Admin: visible if store_id is one they manage
  const storeIds = eff?.appUser?.store_ids || eff?.user?.store_ids || [];
  if ((roles.includes('dispatcher') || roles.includes('admin')) && delivery?.store_id && Array.isArray(storeIds)) {
    if (storeIds.includes(delivery.store_id)) return true;
  }

  return false;
};

const shouldCenterForDeliveryUpdate = (data, changedFields) => {
  if (!data) return false;
  if (!isDeliveryVisibleToUser(data)) return false;
  if (!isDeliveryRelevantToCurrentSelection(data)) return false;
  const statusChanged = Array.isArray(changedFields) && changedFields.includes('status');
  const isNextChanged = Array.isArray(changedFields) && changedFields.includes('isNextDelivery');
  const status = data?.status;

  if ((statusChanged && (status === 'en_route' || status === 'completed')) || isNextChanged) {
    if (isNextChanged) {
      return data?.isNextDelivery === true;
    }
    return true;
  }
  return false;
};

const triggerCenterNextDeliveryCard = (payload) => {
  if (centerEventTimer) {
    clearTimeout(centerEventTimer);
    centerEventTimer = null;
  }
  // Debounce slightly to coalesce bursts of updates
  centerEventTimer = setTimeout(() => {
    if (typeof window !== 'undefined') {
      if ((window._userMapControlUntil || 0) > Date.now()) {
        return;
      }
      window.dispatchEvent(new CustomEvent('centerNextDeliveryCard', { detail: payload }));
    }
  }, 50);
};

/**
 * Helper to detect changed fields between old and new data
 */
const normalizeComparableValue = (value) => {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
};

const getChangedFields = (oldData, newData) => {
  if (!oldData || !newData) return [];
  const changed = [];
  for (const key in newData) {
    if (normalizeComparableValue(oldData[key]) !== normalizeComparableValue(newData[key])) {
      changed.push(key);
    }
  }
  return changed;
};

const normalizeDeliveryRealtimeData = (data) => {
  if (!data) return data;

  const normalizeTimestampField = (value) => {
    if (!value || typeof value !== 'string') return value;
    if (!/Z$|[+-]\d{2}:?\d{2}$/.test(value)) return value;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return getLocalTimestampFromDate(parsed);
  };

  // Normalize delivery_date: strip ISO timestamp suffix (e.g. "2026-05-26T06:00:00.000Z" → "2026-05-26")
  const normalizeDateField = (value) => {
    if (!value || typeof value !== 'string') return value;
    if (value.length > 10 && value.includes('T')) return value.slice(0, 10);
    return value;
  };

  return {
    ...data,
    delivery_date: normalizeDateField(data.delivery_date),
    actual_delivery_time: normalizeTimestampField(data.actual_delivery_time),
    arrival_time: normalizeTimestampField(data.arrival_time)
  };
};

/**
 * Subscribe to entity changes
 */
const subscribeToEntity = (entityName) => {
  if (activeSubscriptions.has(entityName)) {
    console.log(`✅ [RealtimeSync] [${rsTime()}] Already subscribed to ${entityName}`);
    return;
  }
  // Global guard: if another module instance already owns this subscription, skip.
  if (!window.__realtimeSyncSubscribed) window.__realtimeSyncSubscribed = new Set();
  if (window.__realtimeSyncSubscribed.has(entityName)) {
    console.log(`✅ [RealtimeSync] [${rsTime()}] Subscription to ${entityName} owned by another module instance — skipping`);
    return;
  }
  window.__realtimeSyncSubscribed.add(entityName);

  try {
    // Keep track of entity data to detect changes
    const entityDataCache = new Map();

    const unsubscribe = base44.entities[entityName].subscribe(async (event) => {
    const { type, id } = event;
    const data = entityName === 'Delivery' ? normalizeDeliveryRealtimeData(event.data) : event.data;

    // SELF-ECHO SUPPRESSION: If this AppUser update was written by this exact device
    // (tracked via window.__localAppUserWrites set in locationTrackerBroadcast),
    // drop the incoming WS echo — the offline DB and UI state are already up to date.
    // We suppress for 10 seconds from the write time to cover WebSocket round-trip latency.
    if (entityName === 'AppUser') {
      const localWrites = window.__localAppUserWrites;
      if (localWrites && localWrites.has(id)) {
        const writtenAt = localWrites.get(id);
        if (Date.now() - writtenAt < 10000) {
          console.log(`🔇 [RealtimeSync] Self-echo suppressed for AppUser ${id} — originated from this device (${Math.round((Date.now() - writtenAt) / 1000)}s ago)`);
          return;
        }
        // Expired — remove so future remote updates from other devices pass through
        localWrites.delete(id);
      }
    }
      
      // Get current user name for "updatedBy"
      let updatedBy = 'System';
      let currentUserName = 'System';
      try {
        const userCache = sessionStorage.getItem('effectiveUserCache');
        if (userCache) {
          const parsed = JSON.parse(userCache);
          currentUserName = parsed?.user?.user_name || parsed?.user?.full_name || 'System';
          updatedBy = currentUserName;
        }
      } catch (e) {
        // Ignore
      }

      // Detect changed fields for updates
      let changedFields = [];
      if (type === 'update') {
        const oldData = entityDataCache.get(id);
        changedFields = getChangedFields(oldData, data);
        entityDataCache.set(id, data);
      } else if (type === 'create') {
        entityDataCache.set(id, data);
      } else if (type === 'delete') {
        entityDataCache.delete(id);
      }
      
      // For Delivery, look up patient_name from the offline DB if not present in the broadcast payload
      let deliveryDisplayName = data?.patient_name || data?.full_name;
      if (entityName === 'Delivery' && !deliveryDisplayName && data?.id) {
        try {
          const { offlineDB } = await import('./offlineDatabase');
          const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, data.id);
          deliveryDisplayName = existing?.patient_name || existing?.full_name;
        } catch (_) {}
      }
      const displayId = entityName === 'Patient'
        ? (data?.full_name || id)
        : entityName === 'Delivery'
          ? (deliveryDisplayName || data?.patient_id || id)
          : entityName === 'AppUser'
            ? (data?.user_name || data?.full_name || data?.email || id)
            : id;

      // Deduplicate across ALL module instances using a window-level cache.
      // Two script bundles loaded simultaneously will share this cache, so only
      // the first instance to process a given event wins; the second is dropped.
      if (!window.__realtimeSyncDedupeCache) window.__realtimeSyncDedupeCache = new Map();
      const dedupeKey = `${entityName}:${id}:${type}`;
      const now = Date.now();
      const lastSeen = window.__realtimeSyncDedupeCache.get(dedupeKey) || 0;
      if (now - lastSeen < 500) {
        return; // Duplicate WebSocket event from another module instance — skip
      }
      window.__realtimeSyncDedupeCache.set(dedupeKey, now);

      console.log(`📡 [RealtimeSync] [${rsTime()}] ${entityName} ${type}: ${displayId}${changedFields.length > 0 ? ` changed: ${changedFields.join(', ')}` : ''}`);
      
      // CRITICAL: Save to offline DB immediately on WebSocket update — dataToSave hoisted here so it's in scope after the try/catch
      let dataToSave = data;
      try {
        const { offlineDB } = await import('./offlineDatabase');

        // LOCATION STALENESS GUARD (AppUser only):
        // Before saving or broadcasting, check whether the incoming location timestamp
        // is strictly newer than what the offline DB already holds.
        // This prevents ghost/slingshot markers caused by out-of-order WS events.
        if (entityName === 'AppUser' && type === 'update' && data?.location_updated_at) {
          try {
            const existingAU = await offlineDB.getById(offlineDB.STORES.APP_USERS, data.id || id);
            if (existingAU?.location_updated_at) {
              const existingTs = new Date(existingAU.location_updated_at).getTime();
              const incomingTs = new Date(data.location_updated_at).getTime();
              if (incomingTs <= existingTs) {
                console.log(`🔇 [RealtimeSync] Dropped stale AppUser location for ${data.user_id || id} — incoming ${incomingTs} <= existing ${existingTs}`);
                return; // Drop entirely — stale location update
              }
            }
          } catch (_) { /* non-critical — proceed on error */ }
        }
        if (type === 'create' || type === 'update') {
          const storeName = entityName === 'AppUser' ? offlineDB.STORES.APP_USERS :
                            entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                            entityName === 'Patient' ? offlineDB.STORES.PATIENTS :
                            entityName === 'City' ? offlineDB.STORES.CITIES :
                            entityName === 'Store' ? offlineDB.STORES.STORES :
                            entityName === 'Payroll' ? offlineDB.STORES.PAYROLL :
                            entityName === 'DeliveryBreadcrumbs' ? offlineDB.STORES.DELIVERY_BREADCRUMBS :
                            entityName === 'InterStoreLocation' ? offlineDB.STORES.INTER_STORE_LOCATIONS :
                            entityName === 'RxTempLogs' ? offlineDB.STORES.RX_TEMP_LOGS :
                            entityName === 'StatHoliday' ? offlineDB.STORES.STAT_HOLIDAYS :
                            entityName === 'Message' ? null : null;

          if (entityName === 'Message' && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('messageRealtimeUpdate', {
              detail: { type, id, data }
            }));
          }

          if (storeName) {
            // CRITICAL: For RxTempLogs — only latest_reading + metadata is carried in the
            // WebSocket event. The full temperature_readings array is intentionally excluded
            // from realtime broadcasts to keep payloads small; smart refresh / offline sync
            // handles syncing the full array. Fetch the full record to save to offline DB,
            // but only dispatch latest_reading to the UI via the window event.
            if (entityName === 'RxTempLogs' && data?.id) {
              try {
                const full = await base44.entities.RxTempLogs.get(data.id);
                if (full?.id) dataToSave = full;
              } catch (_) { /* use partial data as fallback */ }
            }

            // CRITICAL: For Delivery updates — if the incoming WS payload carries an encoded_polyline
            // (i.e. a breadcrumb edit was saved), fetch the full delivery record from the server
            // to guarantee the receiving device's offline DB gets the complete authoritative data,
            // not just a partial merge. This is the primary fix for polylines not syncing to remote devices.
            if (entityName === 'Delivery' && type === 'update' && data?.id && data?.encoded_polyline) {
              try {
                const full = await base44.entities.Delivery.get(data.id);
                if (full?.id) {
                  dataToSave = full;
                  console.log(`🗺️ [RealtimeSync] [${rsTime()}] Fetched full delivery for polyline update: ${data.id}`);
                }
              } catch (_) { /* use incoming data as fallback */ }
            }

            // CRITICAL: For Delivery updates, merge incoming data with the existing offline record
            // to avoid wiping time window fields (delivery_time_start/end/eta) that may not be
            // included in a partial WebSocket update payload.
            // We use a per-delivery lock so two rapid WS events (e.g. encoded_polyline then
            // polyline_saved_at) don't race on the IDB read-merge-write cycle — the second
            // would otherwise read the pre-first-write record (no polyline) and overwrite it.
            if (entityName === 'Delivery' && type === 'update' && data?.id) {
              // Serialize concurrent writes for the same delivery id
              if (!window.__deliveryIdbWriteLocks) window.__deliveryIdbWriteLocks = new Map();
              const prevLock = window.__deliveryIdbWriteLocks.get(data.id) || Promise.resolve();
              let resolveLock;
              const newLock = new Promise((r) => { resolveLock = r; });
              window.__deliveryIdbWriteLocks.set(data.id, newLock);
              await prevLock; // wait for any in-progress write for this delivery to finish
              try {
                const existing = await offlineDB.getById(storeName, data.id);
                if (existing) {
                  // Preserve existing non-null fields that are ABSENT from the incoming payload.
                  // Only preserve if the field is truly not present in the update (undefined) —
                  // if it's explicitly set (even to null/''), the incoming value wins.
                  // Time window fields (delivery_time_start/end/eta) are ONLY preserved when absent
                  // so that forced updates from purgeAndRegeneratePolylines are never blocked.
                  // Fields that must NEVER be wiped by a partial WebSocket update.
                  // The WS payload often carries only the changed field (e.g. just `status`).
                  // A simple { ...existing, ...data } would zero-out anything absent from
                  // the incoming payload if the incoming value is falsy/absent.
                  // We restore from the existing IDB record when the field is truly absent
                  // (undefined) from the incoming payload AND has a non-falsy value locally.
                  const PRESERVE_FIELDS = [
                    // Route / polyline
                    'encoded_polyline', 'transport_mode', 'estimated_distance_km',
                    'estimated_duration_minutes', 'first_leg_origin_lat', 'first_leg_origin_lng',
                    'polyline_saved_at', 'PolylineUpdated', 'travel_dist',
                    // Time windows
                    'delivery_time_start', 'delivery_time_end', 'delivery_time_eta',
                    // Sequencing
                    'stop_order', 'isNextDelivery',
                    // Identity
                    'puid', 'stop_id', 'delivery_id', 'tracking_number',
                    // Inter-store
                    '_interstore_source_id', '_interstore_source_name',
                    '_interstore_dest_id', '_interstore_dest_name',
                    // Cycling
                    'is_cycling_marker', 'cycling_latitude', 'cycling_longitude',
                    // Patient-denormalized (sent only on create, not on every update)
                    'patient_name', 'patient_phone', 'delivery_instructions', 'unit_number',
                    // COD
                    'cod_total_amount_required', 'cod_payments',
                    // Proof
                    'signature_image_url', 'proof_photo_urls', 'barcode_values', 'receipt_barcode_values',
                  ];
                  const merged = { ...existing, ...data };
                  for (const field of PRESERVE_FIELDS) {
                    // Only restore from existing if the field is completely absent from the incoming payload
                    if (!(field in data) && existing[field]) {
                      merged[field] = existing[field];
                    }
                  }

                  // CRITICAL: Apply completion lockout — suppress realtime events that would
                  // revert an optimistically-completed stop or flip isNextDelivery mid-chain.
                  const lockoutProtected = applyRealtimeMergeWithLockout(data.id, merged, existing);
                  dataToSave = lockoutProtected;
                }
              } catch (mergeErr) {
                // Non-critical — fall back to using data as-is
              } finally {
                resolveLock(); // release the per-delivery write lock
              }
            }
            // CRITICAL: Merge AppUser data with existing offline record before saving.
            // IndexedDB `put` REPLACES the entire record. The WebSocket event may
            // carry only the changed fields (driver_status, location, etc.) and
            // saving a partial record would wipe fields like app_roles, user_name.
            let finalDataToSave = dataToSave;
            if (entityName === 'AppUser' && type === 'update') {
              try {
                const existing = await offlineDB.getById(storeName, dataToSave?.id || id);
                if (existing) finalDataToSave = { ...existing, ...dataToSave };
              } catch (_) {}
            }
            await offlineDB.save(storeName, finalDataToSave);
            const savedLabel = entityName === 'Patient'
              ? (data?.full_name || data?.id || 'Patient')
              : entityName === 'AppUser'
                ? (data?.user_name || data?.full_name || data?.email || data?.id || 'AppUser')
                : entityName;
            console.log(`💾 [RealtimeSync] [${rsTime()}] Saved ${savedLabel} to offline DB - changed: ${changedFields.join(', ')}`);
          }

          // PATIENT DATA SINK: For new deliveries only, silently save the patient to offline DB.
          // Do NOT bufferEvent — that would re-trigger patientsUpdated and cause a feedback loop.
          if (entityName === 'Delivery' && type === 'create' && data?.patient_id) {
            try {
              const existing = await offlineDB.getById(offlineDB.STORES.PATIENTS, data.patient_id);
              if (!existing) {
                const patient = await base44.entities.Patient.get(data.patient_id);
                if (patient?.id) {
                  await offlineDB.save(offlineDB.STORES.PATIENTS, patient);
                  console.log(`💾 [RealtimeSync] [${rsTime()}] Patient sink: saved patient "${patient.full_name}" for new delivery ${data.id}`);
                }
              }
            } catch (patientErr) {
              console.warn(`⚠️ [RealtimeSync] [${rsTime()}] Patient sink fetch failed for patient_id ${data.patient_id}:`, patientErr.message);
            }
          }
        } else if (type === 'delete') {
          const storeName = entityName === 'AppUser' ? offlineDB.STORES.APP_USERS :
                            entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                            entityName === 'Patient' ? offlineDB.STORES.PATIENTS :
                            entityName === 'Payroll' ? offlineDB.STORES.PAYROLL :
                            entityName === 'DeliveryBreadcrumbs' ? offlineDB.STORES.DELIVERY_BREADCRUMBS :
                            entityName === 'InterStoreLocation' ? offlineDB.STORES.INTER_STORE_LOCATIONS :
                            entityName === 'RxTempLogs' ? offlineDB.STORES.RX_TEMP_LOGS :
                            entityName === 'StatHoliday' ? offlineDB.STORES.STAT_HOLIDAYS :
                            null;

          if (storeName) {
            await offlineDB.deleteRecord(storeName, id);
            const deletedLabel = entityName === 'Patient' ? (data?.full_name || id) : id;
            console.log(`💾 [RealtimeSync] [${rsTime()}] Deleted ${entityName} from offline DB: ${deletedLabel}`);
          }
        }
      } catch (offlineError) {
        console.warn(`⚠️ [RealtimeSync] [${rsTime()}] Failed to update offline DB for ${entityName}:`, offlineError.message);
      }
      
      // isRemoteUpdate controls whether remote devices dispatch deliveriesUpdated.
      // For 'update' events: use the updated_by_name field to detect same-user writes.
      // For 'create' and 'delete' events: ALWAYS treat as remote — the triggering device
      // already applied optimistic state; all other devices (including other sessions of
      // the same account) need the WS echo to update their IDB snapshot and UI.
      // The username heuristic CANNOT be used for create/delete because those events carry
      // no updated_by_name and fall back to the local session username, making every device
      // think it originated the event and silently suppressing the UI update.
      let isRemoteUpdate;
      if (type === 'update') {
        const senderName = data?.updated_by_name || data?.updatedBy || updatedBy;
        isRemoteUpdate = senderName !== currentUserName;
      } else {
        // create / delete — always propagate to all devices
        isRemoteUpdate = true;
      }

      // CRITICAL: For Delivery updates, use the merged dataToSave (which has patient_name
      // restored from the offline DB) so the toast and buffer always show the correct name.
      // For all other entities, use the raw incoming data as before.
      const bufferData = (entityName === 'Delivery' && type === 'update' && dataToSave && dataToSave !== data)
        ? dataToSave
        : data;

      // CRITICAL: If encoded_polyline is present in the merged dataToSave but was NOT in the
      // raw incoming payload (it was preserved from IDB), changedFields won't include it —
      // causing hasPolylineUpdates to be false and the UI broadcast to be suppressed on
      // receiving devices. Force it into changedFields whenever the merged record carries it.
      let effectiveChangedFields = changedFields;
      if (
        entityName === 'Delivery' &&
        type === 'update' &&
        dataToSave?.encoded_polyline &&
        !changedFields.includes('encoded_polyline')
      ) {
        // Check if the raw incoming payload explicitly had encoded_polyline — if it did,
        // changedFields already includes it. If it didn't (preserved from IDB), add it now
        // so downstream hasPolylineUpdates detection fires correctly on all devices.
        if (data?.encoded_polyline || dataToSave.encoded_polyline !== data?.encoded_polyline) {
          effectiveChangedFields = [...changedFields, 'encoded_polyline'];
          console.log(`🔀 [RealtimeSync] [${rsTime()}] Injected encoded_polyline into changedFields for delivery ${id} — was preserved from IDB merge`);
        }
      }

      // Buffer notifications to debounce UI updates
      bufferEvent(entityName, { entityType: entityName, eventType: type, data: bufferData, id, updatedBy, changedFields: effectiveChangedFields, isRemoteUpdate });
    });

    activeSubscriptions.set(entityName, unsubscribe);
  } catch (error) {
    console.error(`❌ [RealtimeSync] [${rsTime()}] Failed to subscribe to ${entityName}:`, error);
  }
};

/**
 * Connect to real-time sync
 */
export const connect = () => {
  console.log(`🔗 [RealtimeSync] [${rsTime()}] Connecting to WebSocket...`);
  
  try {
    // Subscribe to key entities
    subscribeToEntity('Delivery');
    subscribeToEntity('Patient');
    subscribeToEntity('AppUser');
    subscribeToEntity('Payroll');
    subscribeToEntity('Message');
    subscribeToEntity('GoogleAPILog');
    subscribeToEntity('AppSettings');
    subscribeToEntity('Store');
    subscribeToEntity('DeliveryBreadcrumbs');
    subscribeToEntity('InterStoreLocation');
    subscribeToEntity('TileCoverage');
    subscribeToEntity('RxTempLogs');
    subscribeToEntity('StatHoliday');

    // Instantly cascade Patient changes to related Deliveries in OFFLINE DB + UI
    // Guard: only register this listener ONCE across all connect() calls.
    if (!window.__realtimePatientCascadeRegistered) {
      window.__realtimePatientCascadeRegistered = true;
      window.addEventListener('realtimeUpdate_Patient', async (e) => {
        try {
          const { data, changedFields } = e.detail || {};
          if (!data?.id) return;

          const patch = {
            patient_name: data.full_name || null,
            patient_phone: data.phone || null,
            unit_number: data.unit_number || null,
            delivery_instructions: data.notes || null,
            mailbox_ok: !!data.mailbox_ok,
            call_upon_arrival: !!data.call_upon_arrival,
            ring_bell: data.dont_ring_bell ? false : (typeof data.ring_bell === 'boolean' ? data.ring_bell : true),
            dont_ring_bell: !!data.dont_ring_bell,
            back_door: !!data.back_door,
            // CRITICAL: Only cascade patient time_window fields to the delivery's dedicated
            // time_window fields — NOT to delivery_time_start/end. Those are owned by the
            // dispatcher/optimizer and must not be overwritten by patient record changes.
            // Overwriting delivery_time_start would revert the "now + 5 min" value set by
            // handleStatusUpdate when a stop is accepted, causing the optimizer to re-fire
            // and the complete button to appear to hang or restart.
            ...(data.time_window_start !== undefined ? { time_window_start: data.time_window_start || '' } : {}),
            ...(data.time_window_end !== undefined ? { time_window_end: data.time_window_end || '' } : {}),
          };

          const { offlineDB } = await import('./offlineDatabase');
          const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const activeStatuses = new Set(['pending','en_route','in_transit']);
          const toUpdate = (allDeliveries || []).filter(d => d?.patient_id === data.id && activeStatuses.has(d?.status || 'pending') && d?.delivery_date >= new Date().toISOString().slice(0, 10));

          if (toUpdate.length === 0) return;

          const patched = toUpdate
            .map(d => ({ ...d, ...patch }))
            .filter((delivery, index) => JSON.stringify(toUpdate[index]) !== JSON.stringify({ ...toUpdate[index], ...patch }));
          if (patched.length === 0) return;
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, patched);

          patched.forEach(d => {
            try { broadcastMutation('Delivery', 'update', d.id, d); } catch {}
          });

          await offlineDB.updateSyncStatus('Patient', { status: 'synced' });
          await offlineDB.updateSyncStatus('Delivery', { status: 'synced' });
          window.dispatchEvent(new CustomEvent('softRefreshDeliveries', { detail: { reason: 'patient_update_cascade', patientId: data.id, changedFields } }));
        } catch (err) {
          console.warn(`⚠️ [RealtimeSync] [${rsTime()}] Local cascade on Patient update failed:`, err?.message);
        }
      });
    }

    isConnected = true;
    reconnectAttempts = 0;
    console.log(`✅ [RealtimeSync] [${rsTime()}] WebSocket connected`);
  } catch (error) {
    console.error(`❌ [RealtimeSync] [${rsTime()}] Connection failed:`, error);
    isConnected = false;
    attemptReconnect();
  }
};

/**
 * Disconnect from real-time sync
 */
export const disconnect = () => {
  console.log(`🔌 [RealtimeSync] [${rsTime()}] Disconnecting from WebSocket...`);
  
  activeSubscriptions.forEach((unsubscribe, entityName) => {
    try {
      unsubscribe();
      window.__realtimeSyncSubscribed?.delete(entityName);
      console.log(`✅ [RealtimeSync] [${rsTime()}] Unsubscribed from ${entityName}`);
    } catch (error) {
      console.error(`❌ [RealtimeSync] [${rsTime()}] Error unsubscribing from ${entityName}:`, error);
    }
  });

  activeSubscriptions.clear();
  isConnected = false;
};

/**
 * Attempt reconnection with exponential backoff
 */
const attemptReconnect = () => {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`❌ [RealtimeSync] [${rsTime()}] Max reconnection attempts reached`);
    return;
  }

  reconnectAttempts++;
  const backoffMs = Math.pow(2, reconnectAttempts) * 1000;
  
  console.log(`🔄 [RealtimeSync] [${rsTime()}] Reconnecting in ${backoffMs}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  setTimeout(() => {
    connect();
  }, backoffMs);
};

/**
 * Check if connected
 */
export const isConnectedStatus = () => isConnected;

/**
 * Get connection status
 */
export const getStatus = () => ({
  connected: isConnected,
  activeSubscriptions: Array.from(activeSubscriptions.keys()),
  reconnectAttempts
});

/**
 * Force reconnect
 */
export const reconnect = () => {
  console.log(`🔄 [RealtimeSync] [${rsTime()}] Force reconnecting...`);
  disconnect();
  reconnectAttempts = 0;
  connect();
};

/**
 * Subscribe to real-time updates
 */
export const subscribeToRealtime = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

/**
 * Broadcast a local mutation
 */
export const broadcastMutation = async (entity, action, id, data, ids = null) => {
  const deliveryLabel = data?.patient_name || data?.full_name || data?.patient_id || data?.delivery_id || data?.tracking_number;
  const displayId = entity === 'Patient'
    ? (data?.full_name || id || (ids ? ids.length + ' ids' : ''))
    : entity === 'Delivery'
      ? (deliveryLabel || id || (ids ? ids.length + ' ids' : ''))
      : (id || (ids ? ids.length + ' ids' : ''));
  console.log(`📡 [RealtimeSync] [${rsTime()}] Broadcasting ${entity} ${action}: ${displayId}`);

  try {
    const storeName = entity === 'AppUser' ? offlineDB.STORES.APP_USERS :
      entity === 'Delivery' ? offlineDB.STORES.DELIVERIES :
      entity === 'Patient' ? offlineDB.STORES.PATIENTS :
      entity === 'Payroll' ? offlineDB.STORES.PAYROLL :
      entity === 'Store' ? offlineDB.STORES.STORES :
      null;

    if (storeName) {
      if ((action === 'create' || action === 'update') && data) {
        // CRITICAL: Merge AppUser/Patient/Delivery data with existing offline record before saving.
        // broadcastMutation is called by DriverStatusToggle with partial finalData (only
        // driver_status, location fields) — saving that partial record directly via IndexedDB
        // `put` would REPLACE the full record and lose app_roles, user_name, and all other fields.
        let dataToSave = data;
        if (entity === 'AppUser' && id) {
          try {
            const existing = await offlineDB.getById(storeName, id);
            if (existing) dataToSave = { ...existing, ...data };
          } catch (_) {}
        }
        await offlineDB.save(storeName, dataToSave);
        const broadcastSavedLabel = entity === 'Patient' ? (data?.full_name || id) : id;
        console.log(`💾 [RealtimeSync] [${rsTime()}] Broadcast saved ${entity} to offline DB: ${broadcastSavedLabel}`);
      } else if (action === 'delete' && id) {
        await offlineDB.deleteRecord(storeName, id);
        const broadcastDeletedLabel = entity === 'Patient' ? (data?.full_name || id) : id;
        console.log(`💾 [RealtimeSync] [${rsTime()}] Broadcast deleted ${entity} from offline DB: ${broadcastDeletedLabel}`);
      }
    }
  } catch (error) {
    console.warn(`⚠️ [RealtimeSync] [${rsTime()}] Broadcast offline DB sync failed for ${entity}:`, error.message);
  }

  // Dispatch to all listeners
  listeners.forEach(callback => {
    try {
      callback({
        entityType: entity,
        entity,
        eventType: action,
        type: action,
        data,
        id,
        ids
      });
    } catch (error) {
      console.error(`❌ [RealtimeSync] [${rsTime()}] Broadcast listener error:`, error);
    }
  });

  // Dispatch custom event
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entity}`, {
      detail: { type: action, id, ids, data }
    }));

    if (entity === 'Delivery') {
      const shouldDispatchLocalDeliveryEvent = action === 'delete' || action === 'batch_delete';
      if (action === 'delete') {
        window.dispatchEvent(new CustomEvent('offlineDeliveriesDeleted', {
          detail: { deletedIds: [id] }
        }));
        if (data?.status === 'in_transit' || data?.status === 'en_route') {
          window.dispatchEvent(new CustomEvent('deliveryDeletedWhileActive', {
            detail: {
              source: 'realtimeBroadcast',
              deliveryId: id,
              driverId: data?.driver_id,
              deliveryDate: data?.delivery_date
            }
          }));
        }
      }
      if (action === 'batch_delete') {
        window.dispatchEvent(new CustomEvent('offlineDeliveriesDeleted', {
          detail: { deletedIds: ids || [] }
        }));
        const deletedDeliveries = Array.isArray(data) ? data : [];
        if (deletedDeliveries.some((delivery) => delivery?.status === 'in_transit' || delivery?.status === 'en_route')) {
          window.dispatchEvent(new CustomEvent('deliveryDeletedWhileActive', {
            detail: {
              source: 'realtimeBroadcastBatch',
              deletedIds: ids || [],
              driverId: deletedDeliveries.find((delivery) => delivery?.driver_id)?.driver_id,
              deliveryDate: deletedDeliveries.find((delivery) => delivery?.delivery_date)?.delivery_date
            }
          }));
        }
      }
      if (shouldDispatchLocalDeliveryEvent) {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            deliveryId: id,
            deletedId: action === 'delete' ? id : undefined,
            deletedIds: action === 'batch_delete' ? ids : action === 'delete' ? [id] : undefined,
            deliveryDate: data?.delivery_date,
            driverId: data?.driver_id,
            deletedDelivery: action === 'delete' ? data : undefined,
            freshDeliveries: action === 'delete' ? undefined : data ? [data] : undefined,
            triggeredBy: 'realtimeBroadcast',
            source: 'realtime_sync',
            fromRealtime: true,
            preserveLocalState: true,
            skipDriverLocationRefresh: true
          }
        }));
      }
    }

    if (entity === 'AppUser') {
      window.dispatchEvent(new CustomEvent('appUsersUpdated', {
        detail: {
          appUsers: data ? [data] : undefined,
          deletedId: action === 'delete' ? id : undefined,
          singleUpdate: data,
          fromRealtime: true
        }
      }));
      // CRITICAL: Do NOT dispatch driverLocationsUpdated from broadcastMutation for AppUser.
      // This function is called by locationTrackerBroadcast on the PRIMARY device after
      // writing to the server. The WebSocket subscription in subscribeToEntity('AppUser')
      // already dispatches driverLocationsUpdated for SECONDARY devices when the WS event
      // arrives. Dispatching it here as well causes the primary device to also move its own
      // shared marker, and secondary devices receive the event twice (once from this call
      // via the module event, and again from the incoming WS subscription).
      // The shared marker on ALL devices must only be driven by the WebSocket path.
    }

    if (entity === 'Patient') {
      window.dispatchEvent(new CustomEvent('patientsUpdated', {
        detail: {
          patients: data ? [data] : undefined,
          deletedId: action === 'delete' ? id : undefined,
          deletedIds: action === 'delete' ? [id] : [],
          fromRealtime: true
        }
      }));
    }

    if (entity === 'Store' && data) {
      window.dispatchEvent(new CustomEvent('storeUpdated', {
        detail: { storeId: id, updatedStore: data, fromRealtime: true }
      }));
    }

    if (entity === 'Payroll') {
      window.dispatchEvent(new CustomEvent('payrollUpdated', {
        detail: {
          payrollRecord: data,
          payrollRecords: data ? [data] : undefined,
          deletedId: action === 'delete' ? id : undefined,
          fromRealtime: true
        }
      }));
    }

  }

  return true;
};

// Export singleton instance
export const realtimeSync = {
  connect,
  disconnect,
  isConnected: isConnectedStatus,
  getStatus,
  reconnect,
  subscribe: subscribeToRealtime,
  broadcast: broadcastMutation
};

export default realtimeSync;