import { useEffect, useRef } from "react";

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

      const phase = mapViewPhaseRef.current;
      const fabPhase = window.__currentMapViewPhase ?? phase;

      if (!isMapViewLockedRef.current) {
        // Map is unlocked — check proximity snap instead.
        _checkProximitySnap(newLocation, now);
        return;
      }

      if ((phase !== 2 && phase !== 3) || (fabPhase !== 2 && fabPhase !== 3)) return;
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
      mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef,
      lastProgrammaticMapMoveRef, lastUserInteractionRef, lastProximitySnapTimeRef,
      stopCardsContainerRef]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 2: NON-PRIMARY DEVICE map trigger
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
      const phase = mapViewPhaseRef.current;
      const fabPhase = window.__currentMapViewPhase ?? phase;
      if ((phase !== 2 && phase !== 3) || (fabPhase !== 2 && fabPhase !== 3)) return;
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
      setMapViewTrigger((prev) => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, setMapViewTrigger, mapViewPhaseRef, isMapViewLockedRef,
      pendingPhaseRef, lastProgrammaticMapMoveRef]);

  // ─────────────────────────────────────────────────────────────────────────
  // EFFECT 3: App resume / visibility reacquisition
  //
  // Android Chrome suspends watchPosition when backgrounded. When the driver
  // returns, immediately reacquire a fresh GPS fix and pipe it into state.
  // ─────────────────────────────────────────────────────────────────────────
  const resumeWatchIdRef      = useRef(null);
  const lastVisibilityHideRef = useRef(0);

  useEffect(() => {
    if (!isDriver || !currentUser || !isMobile) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastVisibilityHideRef.current = Date.now();
        return;
      }
      const awayMs = Date.now() - (lastVisibilityHideRef.current || 0);
      if (awayMs < 5000) return;

      console.log(`🔄 [useDriverLocationSync] App resumed after ${Math.round(awayMs / 1000)}s — reacquiring GPS`);

      if (resumeWatchIdRef.current !== null) {
        navigator.geolocation?.clearWatch(resumeWatchIdRef.current);
        resumeWatchIdRef.current = null;
      }

      if (navigator.geolocation) {
        resumeWatchIdRef.current = navigator.geolocation.watchPosition(
          (position) => {
            syncLocationRef.current?.({
              latitude:  position.coords.latitude,
              longitude: position.coords.longitude,
              timestamp: new Date(position.timestamp).toISOString(),
              accuracy:  position.coords.accuracy,
              source:    'device_gps_resume',
            });
          },
          (err) => console.warn('⚠️ [useDriverLocationSync] Resume GPS error:', err.message),
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
        );
      }
    };

    const handleFocusRefresh = (event) => {
      const { userId, latitude, longitude, accuracy } = event.detail || {};
      if (userId && userId !== currentUser.id) return;
      if (!latitude || !longitude) return;
      syncLocationRef.current?.({
        latitude, longitude, accuracy: accuracy ?? null,
        timestamp: new Date().toISOString(),
        source: 'focus_refresh',
      });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('driverLocationFocusRefresh', handleFocusRefresh);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('driverLocationFocusRefresh', handleFocusRefresh);
      if (resumeWatchIdRef.current !== null) {
        navigator.geolocation?.clearWatch(resumeWatchIdRef.current);
        resumeWatchIdRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, currentUser, isMobile]);

  // ─────────────────────────────────────────────────────────────────────────
  // INTERNAL: Proximity snap helper
  // Called by Effect 1 when the map is UNLOCKED and the driver is near a stop.
  // ─────────────────────────────────────────────────────────────────────────
  function _checkProximitySnap(newLocation, now) {
    if ((window._lastImmersiveExitAt || 0) > now - 5000) return;
    if (now - (lastUserInteractionRef?.current || 0) < 300000) return;
    if (!isPrimaryDeviceRef.current) return;

    for (const delivery of deliveriesWithStopOrderRef.current.filter(
      (d) => d?.isNextDelivery === true && ['in_transit', 'en_route', 'pending'].includes(d.status)
    )) {
      const patient = delivery.patient_id
        ? patientsRef.current.find((p) => p?.id === delivery.patient_id) : null;
      const store = !delivery.patient_id && delivery.store_id
        ? storesRef.current.find((s) => s?.id === delivery.store_id) : null;
      const stopLat = patient?.latitude ?? store?.latitude;
      const stopLon = patient?.longitude ?? store?.longitude;
      if (stopLat == null || stopLon == null) continue;
      if (calculateDistanceRef.current(newLocation.latitude, newLocation.longitude, stopLat, stopLon) > 0.1) continue;

      if (lastProximitySnappedStopIdRef.current === delivery.id) {
        // Already snapped for this stop — scroll card but don't re-snap.
        const cardEl = document.getElementById(`stop-card-${delivery.id}`);
        cardEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        break;
      }

      console.log(`📍 [useDriverLocationSync] Proximity snap → Phase 2 for stop ${delivery.id}`);
      lastProximitySnappedStopIdRef.current = delivery.id;
      if (lastProximitySnapTimeRef) lastProximitySnapTimeRef.current = now;

      const cardEl = document.getElementById(`stop-card-${delivery.id}`);
      cardEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

      // Lock into Phase 2 via the FAB control event bus.
      import('../utils/fabControlEvents').then(({ fabControlEvents }) => {
        fabControlEvents.reactivatePhaseTwoIfAvailable();
      });
      break;
    }
  }
}
