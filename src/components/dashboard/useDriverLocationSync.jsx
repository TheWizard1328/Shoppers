import { useEffect, useRef } from "react";
import { locationTracker } from "@/components/utils/locationTracker";

/**
 * useDriverLocationSync
 *
 * Manages two completely separate concerns:
 *
 * 1. LIVE DRIVER LOCATION STATE — keeps `driverLocation` React state and
 *    `driverLocationRef` in sync with the primary device's raw GPS ticks
 *    (via `driverPositionUpdated`) or the desktop shared-location fallback.
 *
 * 2. MAP PAN/ZOOM TRIGGER — fires `setMapViewTrigger` exactly when the live
 *    location marker updates, so Phase 2 / Phase 3 auto-pan matches 1:1 with
 *    marker movement:
 *
 *    PRIMARY DEVICE (driver's own phone running locationTracker):
 *      → trigger fires on every `driverPositionUpdated` event (raw GPS tick,
 *        every ~1-5s from watchPosition / native background provider).
 *
 *    NON-PRIMARY DEVICE (admin tablet, dispatcher, secondary phone):
 *      → trigger fires on every `driverLocationsUpdated` event (WS broadcast
 *        from the backend DB write, every ~15s upload cycle) for the target
 *        selected driver.
 *
 * 3. PROXIMITY SNAP — auto-enters Phase 2 when the driver is within 100m of
 *    the next stop (primary device only, unlocked state only).
 *
 * 4. PHASE-2/3 WATCHDOG — a safety net that re-fires setMapViewTrigger if no
 *    GPS-driven trigger has landed in the last 12s while the map is locked
 *    in Phase 2 or 3. This covers scenarios where watchPosition callbacks
 *    are throttled by the OS or where the FAB's window.__currentMapViewPhase
 *    briefly desyncs from mapViewPhaseRef.current.
 */
export default function useDriverLocationSync({
  isDriver,
  currentUser,
  appUsers,
  isMobile,
  isPrimaryDevice,
  deliveriesWithStopOrder,
  patients,
  stores,
  mapViewPhaseRef,
  isMapViewLockedRef,
  lastProgrammaticMapMoveRef,
  lastUserInteractionRef,
  lastProximitySnapTimeRef,
  stopCardsContainerRef,
  setMapViewTrigger,
  setDriverLocation,
  calculateDistance,
  locationTracker,
  pendingPhaseRef,
  driverLocationRef,
  selectedDriverId,
}) {

  // ── Stable refs for live data ─────────────────────────────────────────────
  // Read via refs inside event callbacks so we never need to tear down and
  // recreate event listeners when delivery/patient/store lists refresh.
  const deliveriesWithStopOrderRef = useRef(deliveriesWithStopOrder);
  const patientsRef                = useRef(patients);
  const storesRef                  = useRef(stores);
  const appUsersRef                = useRef(appUsers);
  const calculateDistanceRef       = useRef(calculateDistance);
  const selectedDriverIdRef        = useRef(selectedDriverId);

  // isPrimaryDevice resolves asynchronously — keep it in a ref so callbacks
  // always see the current value without needing to re-register listeners.
  const isPrimaryDeviceRef = useRef(isPrimaryDevice);

  // Stable ref so the app-resume effect can call syncLocation without a stale closure.
  const syncLocationRef = useRef(null);

  // Proximity snap: remember which stop we last snapped to so we don't re-snap
  // repeatedly while the driver is parked at the same stop.
  const lastProximitySnappedStopIdRef = useRef(null);

  // Track the last time we fired setMapViewTrigger so the watchdog can detect gaps.
  const lastMapTriggerTimeRef = useRef(0);

  useEffect(() => { deliveriesWithStopOrderRef.current = deliveriesWithStopOrder; }, [deliveriesWithStopOrder]);
  useEffect(() => { patientsRef.current                = patients;                }, [patients]);
  useEffect(() => { storesRef.current                  = stores;                  }, [stores]);
  useEffect(() => { appUsersRef.current                = appUsers;                }, [appUsers]);
  useEffect(() => { calculateDistanceRef.current       = calculateDistance;       }, [calculateDistance]);
  useEffect(() => { isPrimaryDeviceRef.current         = isPrimaryDevice;         }, [isPrimaryDevice]);
  useEffect(() => { selectedDriverIdRef.current        = selectedDriverId;        }, [selectedDriverId]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 1: Live driver location state + PRIMARY DEVICE map trigger
  //
  // On mobile: listens to `driverPositionUpdated` (raw GPS from locationTracker,
  //            every ~1-5s) → updates driverLocation state and fires map trigger.
  // On desktop: reads from appUser shared record once at mount.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isDriver || !currentUser) return;

    // Synchronously update both the ref and the React state so the mapViewTrigger
    // effect always has the latest position when it reads driverLocationRef.current.
    const syncLocation = (newLocation) => {
      if (!newLocation?.latitude || !newLocation?.longitude) return;
      if (driverLocationRef) driverLocationRef.current = newLocation;
      setDriverLocation(newLocation);
      syncLocationRef.current = syncLocation;
    };

    syncLocationRef.current = syncLocation;

    if (!isMobile) {
      // Desktop fallback: pull position from shared AppUser record (no GPS here).
      const appUser = appUsersRef.current?.find((au) => au?.user_id === currentUser.id);
      if (appUser?.current_latitude && appUser?.current_longitude) {
        syncLocation({
          latitude:  appUser.current_latitude,
          longitude: appUser.current_longitude,
          timestamp: appUser.location_updated_at,
          accuracy:  null,
          source:    'shared_location',
        });
      } else {
        setDriverLocation(null);
      }
      return;
    }

    // ── Mobile: PRIMARY DEVICE GPS path ──────────────────────────────────
    // Seed from tracker's last known position if available so the map doesn't
    // start blank while waiting for the first `driverPositionUpdated` event.
    const trackerStatus = locationTracker?.getStatus?.();
    if (trackerStatus?.lastLocation?.latitude && trackerStatus?.lastLocation?.longitude) {
      syncLocation({
        latitude:  trackerStatus.lastLocation.latitude,
        longitude: trackerStatus.lastLocation.longitude,
        timestamp: new Date().toISOString(),
        accuracy:  trackerStatus.lastLocation.accuracy,
        source:    'tracker_seed',
      });
    }

    const handleTrackerPosition = (event) => {
      const { userId, latitude, longitude, timestamp, accuracy, source } = event.detail || {};
      if (userId && userId !== currentUser.id) return;
      if (!latitude || !longitude) return;

      const newLocation = { latitude, longitude, timestamp, accuracy, source: source || 'tracker' };

      // Always update the driver location state — this is what moves the blue dot.
      syncLocation(newLocation);

      const now = Date.now();

      // ── MAP TRIGGER: Phase 2 / Phase 3 auto-pan on PRIMARY DEVICE ────────
      // Rule: fire on every GPS tick when phase is 2 or 3 and the map is locked.
      // This is the PRIMARY device path only — non-primary uses driverLocationsUpdated (below).
      //
      // "Effectively primary" covers the async race: isPrimaryDeviceRef is resolved from
      // the DB after mount, but locationTracker only runs on confirmed primary devices, so
      // any driverPositionUpdated event IS from the primary device. window.__isPrimaryDevice
      // is stamped by locationTracker itself the moment it confirms it is primary.
      const effectivelyPrimary = isPrimaryDeviceRef.current || window.__isPrimaryDevice === true;
      if (!effectivelyPrimary) return;

      // CRITICAL: Use mapViewPhaseRef.current as the AUTHORITATIVE phase source.
      // window.__currentMapViewPhase is set by MapViewCycleFAB's effect and can lag
      // behind the ref by one render cycle (e.g., when Dashboard re-renders but the
      // memoized DashboardView/FABControls subtree hasn't committed yet). Using the
      // stale window var caused the GPS handler to bail, breaking Phase 2 auto-pan.
      const phase = mapViewPhaseRef.current;

      if (!isMapViewLockedRef.current) {
        // Map is unlocked — check proximity snap instead.
        _checkProximitySnap(newLocation, now);
        return;
      }

      if (phase !== 2 && phase !== 3) return;
      if ((window._suppressMapRepositionUntil || 0) > now) return;
      if ((window._lastImmersiveExitAt || 0) > now - 1500) return;

      // Don't override bounds when an admin is viewing a DIFFERENT driver's route.
      const selectedId = selectedDriverIdRef.current;
      if (selectedId && selectedId !== 'all' && selectedId !== currentUser.id) return;

      // Phase 2: also keep the next-stop card scrolled into view.
      if (phase === 2) {
        const nextCard = deliveriesWithStopOrderRef.current.find((d) => d?.isNextDelivery === true);
        if (nextCard) {
          document.getElementById(`stop-card-${nextCard.id}`)?.scrollIntoView({
            behavior: 'smooth', block: 'nearest', inline: 'center',
          });
        }
      }

      // Fire the map trigger — Dashboard's mapViewTrigger effect handles the actual
      // fitBounds call with the correct Phase 2 / Phase 3 coordinate set.
      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      pendingPhaseRef.current = phase;
      lastMapTriggerTimeRef.current = now;
      setMapViewTrigger((prev) => prev + 1);
    };

    window.addEventListener('driverPositionUpdated', handleTrackerPosition);

    // Fallback watchPosition only when locationTracker isn't running (e.g. browser
    // that bypassed the tracker entirely). locationTracker already calls handleLocationSuccess
    // which dispatches driverPositionUpdated, so this only activates if isTracking === false.
    let watchId = null;
    if (!trackerStatus?.isTracking && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          window.dispatchEvent(new CustomEvent('driverPositionUpdated', {
            detail: {
              userId:    currentUser.id,
              latitude:  position.coords.latitude,
              longitude: position.coords.longitude,
              timestamp: new Date(position.timestamp).toISOString(),
              accuracy:  position.coords.accuracy,
              source:    'device_gps_fallback',
            },
          }));
        },
        (err) => console.warn('⚠️ [useDriverLocationSync] GPS fallback error:', err.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    }

    return () => {
      window.removeEventListener('driverPositionUpdated', handleTrackerPosition);
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    };
  // Stable deps only — all live data accessed via refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, currentUser, isMobile, locationTracker, setDriverLocation, setMapViewTrigger,
      mapViewPhaseRef, isMapViewLockedRef, lastProgrammaticMapMoveRef, pendingPhaseRef,
      driverLocationRef, lastProximitySnapTimeRef, stopCardsContainerRef, selectedDriverId]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 2: NON-PRIMARY DEVICE map trigger (WS-driven)
  //
  // Listens to `driverLocationsUpdated` (WS broadcast, fires on every DB upload
  // from the primary device, ~15s cadence). Fires the map trigger when the
  // target driver's record is in the payload and we're in Phase 2 or 3.
  //
  // Also handles:
  //   - Admin/dispatcher viewing a specific OTHER driver's route
  //   - Driver on a secondary device (tablet signed in as the same driver)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleSharedLocationUpdate = (event) => {
      const now = Date.now();

      // Only act when the map is locked in Phase 2 or 3.
      if (!isMapViewLockedRef.current) return;
      // CRITICAL: Use the ref as authoritative — window.__currentMapViewPhase can
      // lag behind the ref when the FAB component hasn't committed yet.
      const phase = mapViewPhaseRef.current;
      if (phase !== 2 && phase !== 3) return;
      if ((window._suppressMapRepositionUntil || 0) > now) return;

      const updatedAppUsers = event?.detail?.appUsers;
      if (!Array.isArray(updatedAppUsers) || updatedAppUsers.length === 0) return;

      const targetId = selectedDriverIdRef.current;
      const isSelfOrAll = !targetId || targetId === 'all' || targetId === currentUser?.id;

      // PRIMARY DEVICE handles its own map trigger via driverPositionUpdated (Effect 1).
      // Skip here to avoid double-triggering — primary device fires on every GPS tick,
      // non-primary fires on every WS broadcast. They must not both run.
      if (isSelfOrAll && (isPrimaryDeviceRef.current || window.__isPrimaryDevice === true)) return;

      // Determine which driver record to look for in the payload.
      const resolvedTargetId = isSelfOrAll ? currentUser?.id : targetId;
      if (!resolvedTargetId) return;

      const targetAppUser = updatedAppUsers.find(
        (au) => au?.user_id === resolvedTargetId || au?.id === resolvedTargetId
      );
      if (!targetAppUser?.current_latitude || !targetAppUser?.current_longitude) return;

      // Fire the map trigger — same as primary device path but driven by WS cadence.
      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      pendingPhaseRef.current = phase;
      lastMapTriggerTimeRef.current = now;
      setMapViewTrigger((prev) => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, setMapViewTrigger, mapViewPhaseRef, isMapViewLockedRef,
      pendingPhaseRef, lastProgrammaticMapMoveRef]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 2b: PHASE 2/3 WATCHDOG — re-fire map trigger if GPS ticks go silent
  //
  // On some Android devices, watchPosition callbacks can be throttled by the OS
  // (power saving, background restrictions) to once every 15-30 seconds. During
  // these gaps, the map appears "stuck" even though the FAB shows locked Phase 2.
  // This watchdog fires every 5s and checks: if we're locked in Phase 2/3 but
  // haven't had a GPS-driven trigger in 12+ seconds, force a re-pan using the
  // last known driver location. This ensures the map never goes more than ~12s
  // without updating while in Phase 2/3 lock.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isDriver || !isMobile || !currentUser) return;

    const WATCHDOG_INTERVAL_MS = 5000;  // check every 5s
    const STALE_THRESHOLD_MS   = 12000; // re-fire if no trigger in 12s

    const watchdog = setInterval(() => {
      if (!isMapViewLockedRef.current) return;
      const phase = mapViewPhaseRef.current;
      if (phase !== 2 && phase !== 3) return;

      const now = Date.now();
      const timeSinceLastTrigger = now - (lastMapTriggerTimeRef.current || 0);
      if (timeSinceLastTrigger < STALE_THRESHOLD_MS) return;

      // Don't fire if the user just exited immersive mode (give 1.5s grace)
      if ((window._lastImmersiveExitAt || 0) > now - 1500) return;

      // Don't fire if map reposition is explicitly suppressed
      if ((window._suppressMapRepositionUntil || 0) > now) return;

      // Don't override bounds when viewing a DIFFERENT driver's route
      const selectedId = selectedDriverIdRef.current;
      if (selectedId && selectedId !== 'all' && selectedId !== currentUser.id) return;

      // Need a valid driver location to re-pan
      const loc = driverLocationRef?.current;
      if (!loc?.latitude || !loc?.longitude) return;

      console.log(`🐕 [useDriverLocationSync] Watchdog re-fire: ${Math.round(timeSinceLastTrigger / 1000)}s since last trigger (phase ${phase})`);

      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      pendingPhaseRef.current = phase;
      lastMapTriggerTimeRef.current = now;
      setMapViewTrigger((prev) => prev + 1);
    }, WATCHDOG_INTERVAL_MS);

    return () => clearInterval(watchdog);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, isMobile, currentUser, setMapViewTrigger, mapViewPhaseRef,
      isMapViewLockedRef, lastProgrammaticMapMoveRef, pendingPhaseRef,
      driverLocationRef, selectedDriverId]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 3: App resume / visibility reacquisition
  //
  // Android Chrome suspends watchPosition when backgrounded. When the driver
  // returns, immediately reacquire a fresh GPS fix and pipe it into state.
  // ─────────────────────────────────────────────────────────────────────────
  const resumeWatchIdRef      = useRef(null);
  const lastVisibilityHideRef = useRef(0);

  useEffect(() => {
    if (!isDriver || !isMobile) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        lastVisibilityHideRef.current = Date.now();
        // Cancel any pending resume fix
        if (resumeWatchIdRef.current) {
          navigator.geolocation?.clearWatch?.(resumeWatchIdRef.current);
          resumeWatchIdRef.current = null;
        }
        return;
      }

      // Visible again — reacquire GPS if we were hidden for more than 5 seconds
      const wasHiddenFor = Date.now() - (lastVisibilityHideRef.current || 0);
      if (wasHiddenFor < 5000) return;

      // Fire a fresh GPS fix immediately — use the tracker's getFreshPosition
      // so we get a cached fallback (lastPosition) if the fresh fix times out
      // while GPS is still re-acquiring after returning from background.
      if (syncLocationRef.current) {
        const pos = await locationTracker.getFreshPosition({ timeout: 10000, maximumAge: 0, enableHighAccuracy: true });
        if (pos) {
          const newLocation = {
            latitude:  pos.latitude,
            longitude: pos.longitude,
            timestamp: new Date().toISOString(),
            accuracy:  pos.accuracy,
            source:    'visibility_resume',
          };
          syncLocationRef.current(newLocation);

          // Also dispatch a driverPositionUpdated so the map trigger fires
          window.dispatchEvent(new CustomEvent('driverPositionUpdated', {
            detail: {
              userId:    currentUser.id,
              latitude:  pos.latitude,
              longitude:  pos.longitude,
              timestamp: newLocation.timestamp,
              accuracy:  pos.accuracy,
              source:    'visibility_resume',
            },
          }));
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, isMobile, currentUser]);

  // ─────────────────────────────────────────────────────────────────────────
  // PROXIMITY SNAP
  // ─────────────────────────────────────────────────────────────────────────
  function _checkProximitySnap(newLocation, now) {
    if (!isPrimaryDeviceRef.current && !(window.__isPrimaryDevice === true)) return;
    // Suppress for 5 minutes after any user interaction with the map
    if (now - (lastUserInteractionRef?.current || 0) < 300000) return;
    // Only snap once every 30 seconds
    if (now - (lastProximitySnapTimeRef?.current || 0) < 30000) return;

    const phase = mapViewPhaseRef.current;
    // Only auto-enter Phase 2 from Phase 1 when map is unlocked
    if (phase !== 1) return;

    // Don't snap if viewing a different driver
    const selectedId = selectedDriverIdRef.current;
    if (selectedId && selectedId !== 'all' && selectedId !== currentUser.id) return;

    const nextStop = deliveriesWithStopOrderRef.current.find(
      (d) => d?.isNextDelivery === true && !['completed', 'failed', 'cancelled'].includes(d.status)
    );
    if (!nextStop) return;

    // Resolve target coordinates
    let targetLat, targetLon;
    if (nextStop.patient_id) {
      const p = patientsRef.current.find((x) => x?.id === nextStop.patient_id);
      targetLat = p?.latitude;
      targetLon = p?.longitude;
    } else if (nextStop.store_id) {
      const s = storesRef.current.find((x) => x?.id === nextStop.store_id);
      targetLat = s?.latitude;
      targetLon = s?.longitude;
    }
    if (!targetLat || !targetLon) return;

    const dist = calculateDistanceRef.current?.(newLocation.latitude, newLocation.longitude, targetLat, targetLon);
    if (dist == null) return;

    // Within 100m → auto-enter Phase 2
    if (dist <= 100) {
      lastProximitySnapTimeRef.current = now;
      console.log(`🎯 [useDriverLocationSync] Proximity snap: ${Math.round(dist)}m from next stop → Phase 2`);

      mapViewPhaseRef.current = 2;
      isMapViewLockedRef.current = true;
      pendingPhaseRef.current = 2;
      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      lastMapTriggerTimeRef.current = now;
      setMapViewTrigger((prev) => prev + 1);
    }
  }
}
