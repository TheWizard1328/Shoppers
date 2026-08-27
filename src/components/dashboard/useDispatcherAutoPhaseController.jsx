import { useEffect, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { saveSetting } from '@/components/utils/userSettingsManager';

/**
 * useDispatcherAutoPhaseController
 * ----------------------------------------------------------------------------
 * Dispatcher-only auto-phase state machine for the MapCycleFAB.
 *
 * RULES:
 *   1) Assigned driver goes On Duty from Off Duty → Phase 2 IF the driver's
 *      next stop is the dispatcher's store; otherwise no action.
 *   2) Assigned driver goes On Duty from On Break → Phase 3 (always).
 *   3) Last assigned driver goes Off Duty → Phase 1.
 *   4) All assigned drivers go On Break → Phase 1 (unconditionally).
 *
 * "Assigned drivers" = drivers assigned to the dispatcher's store via store
 * records (weekday_am_driver_id, weekday_pm_driver_id, saturday_*, sunday_*),
 * NOT just drivers who happen to have deliveries that day.
 *
 * Additional delivery-driven events:
 *   - New stop created (pending / in_transit / en_route / InterStore) → Phase 3
 *   - Driver accepts / is assigned a stop → Phase 3
 *   - All selected-store stops completed → Phase 1
 *
 * Free-pan handling:
 *   - Boundary events (rules 2/3/4, all-complete→1, new-work→3) ALWAYS apply
 *     and clear the free-pan flag (strong state transitions).
 *   - Transient events (acceptance→3, rule 1 on-duty→2) honour the free-pan
 *     flag (skip while mapUserUnlockedRef.current === true).
 *
 * The hook reuses the existing ref + setter pipeline that Dashboard owns.
 *
 * Event sources (existing broadcast buses — no new sockets):
 *   - window 'realtimeUpdate_Delivery'  ({ type, id, data, changedFields })
 *   - window 'appUserUpdated'            ({ appUser, fromRealtime })
 *   - window 'driverStatusChanged'       ({ userId, newStatus })
 */

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
const ACTIVE_STATUSES = ['pending', 'in_transit', 'en_route'];
const DEBOUNCE_MS = 400;

const isInterStore = (d) => {
  const did = String(d?.delivery_id || '').toUpperCase();
  return did.startsWith('ISP-') || did.startsWith('ISD-');
};

// Exclude cycling-only markers — they are not real stops.
const isRealStop = (d) => !!d && !d.is_cycling_marker;

const isStoreStopFor = (d, storeId, dateStr) =>
  isRealStop(d) &&
  String(d.store_id) === String(storeId) &&
  d.delivery_date === dateStr;

/**
 * Build a compact signature map (id → { ack, driver, status, interstore })
 * for the selected store + date slice. Used to diff between renders.
 */
const buildSignature = (deliveries, storeId, dateStr) => {
  const map = new Map();
  if (!storeId || !dateStr) return map;
  for (const d of deliveries || []) {
    if (!isStoreStopFor(d, storeId, dateStr)) continue;
    map.set(d.id, {
      ack: !!d.driver_acknowledged,
      driver: d.driver_id || '',
      status: d.status || '',
      interstore: isInterStore(d),
      finished: FINISHED_STATUSES.includes(d.status),
      stopOrder: d.stop_order ?? Infinity,
      isISD: String(d.delivery_id || '').toUpperCase().startsWith('ISD-'),
      isStorePickup:
        !d.patient_id && String(d.store_id) === String(storeId) && !isInterStore(d),
    });
  }
  return map;
};

/**
 * Compute the set of driver_ids assigned to a store for a given date,
 * based on store driver-assignment fields (day-of-week aware).
 */
const getAssignedDriverIdsForStore = (store, dateStr) => {
  if (!store || !dateStr) return new Set();
  const dayIdx = new Date(dateStr + 'T00:00:00').getDay();
  const ids = new Set();
  if (dayIdx === 6) {
    if (store.saturday_am_driver_id) ids.add(store.saturday_am_driver_id);
    if (store.saturday_pm_driver_id) ids.add(store.saturday_pm_driver_id);
  } else if (dayIdx === 0) {
    if (store.sunday_am_driver_id) ids.add(store.sunday_am_driver_id);
    if (store.sunday_pm_driver_id) ids.add(store.sunday_pm_driver_id);
  } else {
    if (store.weekday_am_driver_id) ids.add(store.weekday_am_driver_id);
    if (store.weekday_pm_driver_id) ids.add(store.weekday_pm_driver_id);
  }
  return ids;
};

export function useDispatcherAutoPhaseController({
  enabled,
  currentUser,
  deliveries,
  appUsers,
  stores,
  selectedDate,
  selectedStoreId,
  isFormOverlayOpen,
  // Dashboard-owned refs + setters (same set the existing routeFinished reset uses)
  mapViewPhaseRef,
  isMapViewLockedRef,
  pendingPhaseRef,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  lastProgrammaticMapMoveRef,
  mapUserUnlockedRef,
  setMapViewPhase,
  setIsMapViewLocked,
  setMapViewTrigger,
}) {
  // manualOverrideRef = true → suppress auto-phase application. Cleared by the
  // next qualifying store-scoped WebSocket state change, which then applies.
  const manualOverrideRef = useRef(false);

  // lastScheduledEvent = { ts, phase, isBoundary } — most-recent wins (debounce).
  const lastScheduledEventRef = useRef(null);
  const debounceTimerRef = useRef(null);

  // Signature of the store+date slice, kept fresh from BOTH the deliveries
  // React state (post-commit) AND realtime window events (pre-commit, freshest).
  const signatureRef = useRef(new Map());
  // Set of driver_ids assigned to the dispatcher's store for the selected
  // date (from store records, NOT from deliveries). This is the authoritative
  // "assigned drivers" set used for all 4 rules.
  const assignedDriverIdsRef = useRef(new Set());
  // Per-driver previous driver_status, so we can detect flips.
  const driverStatusRef = useRef(new Map());
  // Initialized keys (storeId:dateStr) — re-baselining without firing events.
  const initializedKeysRef = useRef(new Set());

  const keyRef = useRef('');
  const storeIdRef = useRef(selectedStoreId);
  const dateStrRef = useRef('');
  const enabledRef = useRef(enabled);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { storeIdRef.current = selectedStoreId; }, [selectedStoreId]);

  // ── Apply a target phase via the existing ref + setter pipeline ───────────
  const applyPhase = useCallback((phase, isBoundary) => {
    if (!enabledRef.current) return;

    // Free-pan handling: boundary events always apply (and clear free-pan);
    // transient events honour the free-pan flag and skip while it's active.
    if (isBoundary) {
      if (mapUserUnlockedRef) mapUserUnlockedRef.current = false;
    } else if (mapUserUnlockedRef?.current) {
      return;
    }

    if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
    mapLockExpiresAtRef.current = null;

    mapViewPhaseRef.current = phase;
    isMapViewLockedRef.current = true;
    pendingPhaseRef.current = phase;
    setMapViewPhase(phase);
    setIsMapViewLocked(true);

    lastProgrammaticMapMoveRef.current = Date.now();
    if (typeof window !== 'undefined') {
      window._lastProgrammaticMapMove = Date.now();
      window._cancelInFlightNextFit = true;
      window._suppressMapRepositionUntil = Date.now() + 1500;
    }
    setMapViewTrigger((p) => p + 1);
    if (currentUser?.id) {
      try { saveSetting(currentUser.id, 'fab_map_cycle_phase', phase); } catch (_) {}
    }

    // Subtle flash so the dispatcher notices the auto-phase change.
    if (typeof window?.__fabFlashUpdate === 'function') {
      try { window.__fabFlashUpdate('route_change'); } catch (_) {}
    }

    // Phase 1 is an overview_unlock after 500ms (mirrors the existing
    // routeFinishedResetToPhase1 behaviour); phases 2/3 stay locked.
    if (phase === 1) {
      const exp = Date.now() + 500;
      mapLockExpiresAtRef.current = exp;
      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === exp) {
          isMapViewLockedRef.current = false;
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
        }
      }, 500);
    }
  }, [currentUser?.id, mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef,
      mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef,
      mapUserUnlockedRef, setMapViewPhase, setIsMapViewLocked, setMapViewTrigger]);

  // ── Schedule a classified event (debounce + most-recent-wins) ─────────────
  const scheduleEvent = useCallback((phase, isBoundary) => {
    if (!enabledRef.current) return;
    // A genuine auto-phase event arrived → clear any manual pause so this
    // (and all subsequent) events apply. Per clarification #1.
    manualOverrideRef.current = false;

    lastScheduledEventRef.current = { ts: Date.now(), phase, isBoundary };
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const evt = lastScheduledEventRef.current;
      lastScheduledEventRef.current = null;
      debounceTimerRef.current = null;
      if (!evt) return;
      // Skip application while a form overlay is open (dispatcher is editing).
      if (isFormOverlayOpen) return;
      applyPhase(evt.phase, evt.isBoundary);
    }, DEBOUNCE_MS);
  }, [enabledRef, isFormOverlayOpen, applyPhase]);

  // ── Recompute assigned driver IDs from store records + status maps ────────
  const refreshDriverMaps = useCallback(() => {
    const storeId = storeIdRef.current;
    const dateStr = dateStrRef.current;
    const store = (stores || []).find((s) => s && String(s.id) === String(storeId));
    assignedDriverIdsRef.current = getAssignedDriverIdsForStore(store, dateStr);

    const statusMap = new Map();
    for (const au of appUsers || []) {
      if (au?.user_id) statusMap.set(au.user_id, au.driver_status || 'off_duty');
    }
    driverStatusRef.current = statusMap;
  }, [appUsers, stores]);

  // ── Re-baseline signature + driver maps from deliveries / appUsers state ──
  // Runs after React commits. Used for initialization and to keep the
  // signature fresh; never fires an auto-phase event itself.
  useEffect(() => {
    if (!enabledRef.current) return;
    const storeId = storeIdRef.current;
    const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';
    dateStrRef.current = dateStr;
    const key = `${storeId}:${dateStr}`;
    keyRef.current = key;

    const prevSig = signatureRef.current;
    const nextSig = buildSignature(deliveries, storeId, dateStr);

    // If the store/date key changed, re-baseline silently (no events).
    if (key !== (prevSig._key || '')) {
      nextSig._key = key;
      signatureRef.current = nextSig;
      initializedKeysRef.current.add(key);
      refreshDriverMaps();
      // New key → also reset scheduled debounce so a stale event from the old
      // store/date doesn't apply an auto-phase to the new selection.
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
      lastScheduledEventRef.current = null;
      return;
    }

    // Same key → reconcile from the authoritative state.
    nextSig._key = key;
    signatureRef.current = nextSig;
    refreshDriverMaps();
  }, [enabled, selectedDate, deliveries, appUsers, stores, refreshDriverMaps]);

  // ── Patch signature immediately from realtime Delivery events (pre-commit) ─
  useEffect(() => {
    if (!enabledRef.current) return;
    const onDelivery = (e) => {
      if (!enabledRef.current) return;
      const storeId = storeIdRef.current;
      const dateStr = dateStrRef.current;
      if (!storeId || !dateStr) return;
      const { type, data, changedFields } = e?.detail || {};
      if (!data?.id) return;

      // Only stops relevant to the selected store + date drive classification.
      if (!isStoreStopFor(data, storeId, dateStr)) return;

      const sig = signatureRef.current;
      const prev = sig.get(data.id);
      const next = {
        ack: !!data.driver_acknowledged,
        driver: data.driver_id || '',
        status: data.status || '',
        interstore: isInterStore(data),
        finished: FINISHED_STATUSES.includes(data.status),
        stopOrder: data.stop_order ?? Infinity,
        isISD: String(data.delivery_id || '').toUpperCase().startsWith('ISD-'),
        isStorePickup:
          !data.patient_id && String(data.store_id) === String(storeId) && !isInterStore(data),
      };

      // Delete event → remove from signature, no auto-phase.
      if (type === 'delete') {
        if (prev) sig.delete(data.id);
        return;
      }

      // Create event → new-work classification.
      if (type === 'create' || !prev) {
        sig.set(data.id, next);
        if (
          ACTIVE_STATUSES.includes(next.status) ||
          next.interstore
        ) {
          scheduleEvent(3, true /* boundary */);
        }
        return;
      }

      // Update event → classify by what changed.
      sig.set(data.id, next);
      const fields = Array.isArray(changedFields) ? changedFields : [];

      // Acceptance: driver_acknowledged flipped false→true, OR driver_id newly
      // assigned (empty → set) while the stop is not finished.
      const ackNowTrue = fields.includes('driver_acknowledged') && !prev.ack && next.ack;
      const driverAssigned =
        fields.includes('driver_id') && !prev.driver && !!next.driver && !next.finished;
      if (ackNowTrue || driverAssigned) {
        scheduleEvent(3, false /* transient */);
        return;
      }

      // A status change can make the slice fully complete → check all-complete.
      if (fields.includes('status')) {
        const allDone = (sig.size > 0) && Array.from(sig.values()).every((s) => s.finished);
        if (allDone) {
          scheduleEvent(1, true /* boundary */);
          return;
        }
        // In-Transit / InterStore activation on an existing stop → Phase 3 reactivate.
        if (
          (next.status === 'in_transit' || next.status === 'en_route') ||
          (next.interstore && ACTIVE_STATUSES.includes(next.status) && !ACTIVE_STATUSES.includes(prev.status))
        ) {
          scheduleEvent(3, true /* boundary */);
        }
      }
    };

    window.addEventListener('realtimeUpdate_Delivery', onDelivery);
    return () => window.removeEventListener('realtimeUpdate_Delivery', onDelivery);
  }, [enabled, scheduleEvent]);

  // ── AppUser driver_status changes → auto-phase rules ──────────────────────
  useEffect(() => {
    if (!enabledRef.current) return;

    /**
     * Check if the driver's next stop (isNextDelivery) belongs to the
     * dispatcher's store. Used for Rule 1 (On Duty from Off Duty → Phase 2).
     */
    const isNextStopForDispatcherStore = (driverId) => {
      const storeId = storeIdRef.current;
      const dateStr = dateStrRef.current;
      if (!storeId || !dateStr || !driverId) return false;
      for (const d of deliveries || []) {
        if (!d || d.driver_id !== driverId) continue;
        if (d.delivery_date !== dateStr) continue;
        if (d.isNextDelivery !== true) continue;
        return String(d.store_id) === String(storeId);
      }
      return false;
    };

    const handleAppUserChange = (newStatus, userId, prevStatus) => {
      if (!enabledRef.current) return;
      const assignedDrivers = assignedDriverIdsRef.current;
      if (!userId || assignedDrivers.size === 0 || !assignedDrivers.has(userId)) return;

      // Get all assigned drivers' current statuses.
      const statuses = [];
      for (const did of assignedDrivers) {
        statuses.push(driverStatusRef.current.get(did) || 'off_duty');
      }
      const allOnBreak = statuses.length > 0 && statuses.every((s) => s === 'on_break');
      const anyOnDuty = statuses.includes('on_duty');

      // RULE 2: Assigned driver goes On Duty from On Break → Phase 3 (boundary).
      // Takes priority over Rule 1 — return from break, not shift start.
      if (newStatus === 'on_duty' && prevStatus === 'on_break') {
        scheduleEvent(3, true /* boundary */);
        return;
      }

      // RULE 1: Assigned driver goes On Duty from Off Duty → Phase 2 IF the
      // driver's next stop is the dispatcher's store (transient — honour free-pan).
      if (newStatus === 'on_duty' && (prevStatus === 'off_duty' || !prevStatus)) {
        if (isNextStopForDispatcherStore(userId)) {
          scheduleEvent(2, false /* transient */);
        }
        // If next stop is NOT the dispatcher's store, no action.
        return;
      }

      // RULE 3: Last assigned driver goes Off Duty → Phase 1 (boundary).
      // Fires when a driver transitions to off_duty AND no assigned drivers
      // are on_duty anymore.
      if (newStatus === 'off_duty' && !anyOnDuty) {
        scheduleEvent(1, true /* boundary */);
        return;
      }

      // RULE 4: All assigned drivers On Break → Phase 1 (boundary, unconditional).
      if (allOnBreak) {
        scheduleEvent(1, true /* boundary */);
        return;
      }
    };

    const onAppUserUpdated = (e) => {
      const au = e?.detail?.appUser;
      if (!au?.user_id) return;
      const prev = driverStatusRef.current.get(au.user_id);
      const next = au.driver_status || 'off_duty';
      driverStatusRef.current.set(au.user_id, next);
      handleAppUserChange(next, au.user_id, prev);
    };
    const onRealtimeAppUser = (e) => {
      const { data, changedFields } = e?.detail || {};
      if (!data?.user_id) return;
      if (Array.isArray(changedFields) && changedFields.length > 0 && !changedFields.includes('driver_status')) return;
      const prev = driverStatusRef.current.get(data.user_id);
      const next = data.driver_status || 'off_duty';
      driverStatusRef.current.set(data.user_id, next);
      handleAppUserChange(next, data.user_id, prev);
    };
    const onDriverStatusChanged = (e) => {
      const { userId, newStatus } = e?.detail || {};
      if (!userId || !newStatus) return;
      const prev = driverStatusRef.current.get(userId);
      driverStatusRef.current.set(userId, newStatus);
      handleAppUserChange(newStatus, userId, prev);
    };

    window.addEventListener('appUserUpdated', onAppUserUpdated);
    window.addEventListener('realtimeUpdate_AppUser', onRealtimeAppUser);
    window.addEventListener('driverStatusChanged', onDriverStatusChanged);
    return () => {
      window.removeEventListener('appUserUpdated', onAppUserUpdated);
      window.removeEventListener('realtimeUpdate_AppUser', onRealtimeAppUser);
      window.removeEventListener('driverStatusChanged', onDriverStatusChanged);
    };
  }, [enabled, scheduleEvent, deliveries]);

  // ── Keep assigned driver IDs + status maps fresh ──────────────────────────
  useEffect(() => { refreshDriverMaps(); }, [appUsers, stores, refreshDriverMaps]);

  // ── Public API: arm the manual-pause flag (called on dispatcher FAB tap) ─
  const setManualOverride = useCallback(() => {
    manualOverrideRef.current = true;
    if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
    lastScheduledEventRef.current = null;
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
      if (mapLockTimeoutRef?.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
    };
  }, [mapLockTimeoutRef]);

  return { setManualOverride };
}

export default useDispatcherAutoPhaseController;
