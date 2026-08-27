import { useEffect, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { saveSetting } from '@/components/utils/userSettingsManager';

/**
 * useDispatcherAutoPhaseController
 * ----------------------------------------------------------------------------
 * Dispatcher-only auto-phase state machine for the MapCycleFAB.
 *
 * Drives the FAB's map-view phase (1/2/3) from live WebSocket state instead of
 * manual taps, scoped to the store currently selected by the dispatcher and
 * the dashboard's selected date.
 *
 *   Assigned driver goes On Duty         → ACTIVATES the rules + Phase 2
 *                                          (Active Drivers & Next Stops)
 *   Driver accepts / is assigned a stop  → Phase 3 (Show Incomplete & Pending)
 *   All selected-store stops complete    → Phase 1 (Show All Stops)
 *   New In-Transit / InterStore / pending→ Phase 3 (reactivate)
 *
 * Clarifications honoured:
 *   - Manual pause: a manual FAB tap arms manualOverrideRef; the very next
 *     qualifying store-scoped WebSocket state change clears it AND applies
 *     its auto phase (pause-until-next-event).
 *   - Selected store only: reactions are scoped to the store the dispatcher
 *     has selected (globalFilters selected store, or the dispatcher's first
 *     assigned store as the dispatcher dashboard effectively uses store_ids[0]).
 *   - Most-recent event wins: events within a ~400ms debounce window are
 *     coalesced; the last one's target phase is applied.
 *
 * Free-pan handling (per PRD):
 *   - Boundary events (all-complete → 1, new-work → 3) ALWAYS apply and clear
 *     the free-pan flag (strong state transitions).
 *   - Transient events (acceptance → 3, on_duty → 2) honour the free-pan flag
 *     (skip application while mapUserUnlockedRef.current === true).
 *
 * The hook reuses the existing ref + setter pipeline that Dashboard owns
 * (mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef, setMapViewPhase,
 * setIsMapViewLocked, setMapViewTrigger) — the same path the existing
 * "route finished → reset to Phase 1" effect uses — so the visual FAB, lock
 * state, and map reposition all update together. No parallel setter.
 *
 * Event sources (existing broadcast buses — no new sockets):
 *   - window 'realtimeUpdate_Delivery'  ({ type, id, data, changedFields })
 *   - window 'appUserUpdated'            ({ appUser, fromRealtime })
 *   - window 'driverStatusChanged'       ({ userId, newStatus })
 *   - window 'deliveriesUpdated'         (freshDeliveries / deletedIds) — used
 *     to keep the in-memory store-slice signature in sync after React commits.
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
    });
  }
  return map;
};

export function useDispatcherAutoPhaseController({
  enabled,
  currentUser,
  deliveries,
  appUsers,
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
  // Set of driver_ids that currently appear on ANY stop (active or finished)
  // for the selected store+date — i.e. the dispatcher's assigned drivers for
  // that store today. An On Duty event from any of them is the engagement
  // trigger that activates the auto-phase rules (per the approved PRD).
  const sliceDriverIdsRef = useRef(new Set());
  // Per-driver previous driver_status, so we can detect a flip TO on_duty.
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

  // ── Recompute activeDriverIds + driverStatus maps from current state ──────
  const refreshDriverMaps = useCallback(() => {
    const sig = signatureRef.current;
    const sliceDrivers = new Set();
    for (const s of sig.values()) {
      if (s.driver) sliceDrivers.add(s.driver);
    }
    sliceDriverIdsRef.current = sliceDrivers;
    const statusMap = new Map();
    for (const au of appUsers || []) {
      if (au?.user_id) statusMap.set(au.user_id, au.driver_status || 'off_duty');
    }
    driverStatusRef.current = statusMap;
  }, [appUsers]);

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

    // Same key → merge immediate realtime patches may already be in prevSig;
    // reconcile from the authoritative state but keep "newest wins" fields.
    nextSig._key = key;
    signatureRef.current = nextSig;
    refreshDriverMaps();
  }, [enabled, selectedDate, deliveries, appUsers, refreshDriverMaps]);

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
      };

      // Delete event → remove from signature, no auto-phase (let all-complete
      // check fall through naturally on the next state sync if needed).
      if (type === 'delete') {
        if (prev) sig.delete(data.id);
        return;
      }

      // Create event → new-work classification.
      if (type === 'create' || !prev) {
        sig.set(data.id, next);
        // New stop matching new-work criteria → Phase 3 (reactivate).
        if (
          ACTIVE_STATUSES.includes(next.status) || // pending / in_transit / en_route
          next.interstore // ISP/ISD stop
        ) {
          scheduleEvent(3, true /* boundary — override free-pan */);
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
        scheduleEvent(3, false /* transient — honour free-pan */);
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

  // ── AppUser driver_status changes → On Duty classification ────────────────
  useEffect(() => {
    if (!enabledRef.current) return;
    const handleAppUserChange = (newStatus, userId) => {
      if (!enabledRef.current) return;
      if (newStatus !== 'on_duty') return;
      // Engagement trigger: the dispatcher's assigned drivers are those with a
      // stop in the selected store+date slice. When one of them flips to On Duty
      // the auto-phase rules activate and advance to Phase 2 (Active Drivers &
      // Next Stops) — transient, so it honours free-pan.
      const sliceDrivers = sliceDriverIdsRef.current;
      if (!userId || sliceDrivers.size === 0) return;
      if (!sliceDrivers.has(userId)) return; // not one of this store's drivers today
      const prevStatus = driverStatusRef.current.get(userId);
      if (prevStatus === 'on_duty') return; // not a flip
      scheduleEvent(2, false /* transient — honour free-pan */);
    };

    const onAppUserUpdated = (e) => {
      const au = e?.detail?.appUser;
      if (!au?.user_id) return;
      const prev = driverStatusRef.current.get(au.user_id);
      const next = au.driver_status || 'off_duty';
      // Update our per-driver status map immediately so subsequent events diff correctly.
      driverStatusRef.current.set(au.user_id, next);
      handleAppUserChange(next, au.user_id);
    };
    const onRealtimeAppUser = (e) => {
      const { data, changedFields } = e?.detail || {};
      if (!data?.user_id) return;
      if (Array.isArray(changedFields) && changedFields.length > 0 && !changedFields.includes('driver_status')) return;
      const next = data.driver_status || 'off_duty';
      driverStatusRef.current.set(data.user_id, next);
      handleAppUserChange(next, data.user_id);
    };
    const onDriverStatusChanged = (e) => {
      const { userId, newStatus } = e?.detail || {};
      if (!userId || !newStatus) return;
      driverStatusRef.current.set(userId, newStatus);
      handleAppUserChange(newStatus, userId);
    };

    window.addEventListener('appUserUpdated', onAppUserUpdated);
    window.addEventListener('realtimeUpdate_AppUser', onRealtimeAppUser);
    window.addEventListener('driverStatusChanged', onDriverStatusChanged);
    return () => {
      window.removeEventListener('appUserUpdated', onAppUserUpdated);
      window.removeEventListener('realtimeUpdate_AppUser', onRealtimeAppUser);
      window.removeEventListener('driverStatusChanged', onDriverStatusChanged);
    };
  }, [enabled, scheduleEvent]);

  // ── Keep activeDriverIds fresh for the on_duty relevance check ────────────
  // The signature effect already calls refreshDriverMaps; this light pass keeps
  // activeDriverIds synced even when only appUsers update without a delivery change.
  useEffect(() => { refreshDriverMaps(); }, [appUsers, refreshDriverMaps]);

  // ── Public API: arm the manual-pause flag (called on dispatcher FAB tap) ─
  const setManualOverride = useCallback(() => {
    manualOverrideRef.current = true;
    // Clear any pending auto-apply so the manual choice isn't immediately undone.
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