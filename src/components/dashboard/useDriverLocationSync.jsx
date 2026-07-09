import { useEffect, useRef } from "react";

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
  // isMapViewLocked state intentionally omitted — read via isMapViewLockedRef.current
  lastProgrammaticMapMoveRef,
  lastUserInteractionRef,
  lastProximitySnapTimeRef,
  stopCardsContainerRef,
  setMapViewTrigger,
  setDriverLocation,
  calculateDistance,
  locationTracker,
  pendingPhaseRef,
  driverLocationRef, // optional — when provided, updated synchronously before setMapViewTrigger
  selectedDriverId, // needed to re-trigger map when viewing another driver's location
}) {
  const lastLiveDriverLocationRef = useRef(null);
  // Stable ref to syncLiveDriverLocation so the resume effect can call it without closure staleness
  const syncLiveDriverLocationRef = useRef(null);

  // ── Live data refs ────────────────────────────────────────────────────────
  // These let syncMobileLocation always read current data without the effect
  // itself re-running (and tearing down the GPS listener) on every delivery
  // or patient/store update.
  const deliveriesWithStopOrderRef = useRef(deliveriesWithStopOrder);
  const patientsRef                = useRef(patients);
  const storesRef                  = useRef(stores);
  const appUsersRef                = useRef(appUsers);
  const calculateDistanceRef       = useRef(calculateDistance);
  // CRITICAL: isPrimaryDevice resolves asynchronously (Dashboard.jsx looks it up from the
  // DB after mount) and is NOT in the GPS-watching effect's dependency array below — that
  // effect's closure is created once when isDriver/currentUser/isMobile/locationTracker
  // first become truthy, and would otherwise capture the stale initial `false` forever,
  // silently disabling the live map-follow trigger on the actual primary device. Reading
  // it via a ref (kept fresh here) instead of the raw prop fixes that without needing to
  // tear down and recreate the GPS watcher every time the primary-device status resolves.
  const isPrimaryDeviceRef         = useRef(isPrimaryDevice);

  // PROXIMITY SNAP: tracks which delivery ID the snap last fired for.
  // Once we snap for a given stop, we must NOT snap again for the same stop —
  // only re-snap when isNextDelivery moves to a different delivery (driver completed
  // the stop and moved on). This prevents the 60s cooldown from re-triggering the
  // snap repeatedly while the driver is parked at a stop they've already arrived at.
  const lastProximitySnappedStopIdRef = useRef(null);

  useEffect(() => { deliveriesWithStopOrderRef.current = deliveriesWithStopOrder; }, [deliveriesWithStopOrder]);
  useEffect(() => { patientsRef.current                = patients;                }, [patients]);
  useEffect(() => { storesRef.current                  = stores;                  }, [stores]);
  useEffect(() => { appUsersRef.current                = appUsers;                }, [appUsers]);
  useEffect(() => { calculateDistanceRef.current       = calculateDistance;       }, [calculateDistance]);
  useEffect(() => { isPrimaryDeviceRef.current         = isPrimaryDevice;         }, [isPrimaryDevice]);

  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const syncLiveDriverLocation = (newLocation) => {
      if (!newLocation?.latitude || !newLocation?.longitude) return;
      lastLiveDriverLocationRef.current = newLocation;
      syncLiveDriverLocationRef.current = syncLiveDriverLocation; // keep resume effect ref fresh
      // CRITICAL: Update driverLocationRef synchronously BEFORE calling setMapViewTrigger.
      // setDriverLocation (state) only updates driverLocationRef.current one render later,
      // so without this the mapViewTrigger effect reads the OLD position and briefly
      // pans to the wrong location before the next render corrects it (the "bounce").
      if (driverLocationRef) driverLocationRef.current = newLocation;
      setDriverLocation(newLocation);
    };

    const startWatchingPosition = () => {
      if (!isMobile) {
        // Desktop: pull location from shared appUser record
        const appUser = appUsersRef.current?.find((au) => au?.user_id === currentUser.id);
        if (appUser?.current_latitude && appUser?.current_longitude && appUser?.location_updated_at) {
          syncLiveDriverLocation({
            latitude: appUser.current_latitude,
            longitude: appUser.current_longitude,
            timestamp: appUser.location_updated_at,
            accuracy: null,
            source: 'shared_location'
          });
        } else {
          setDriverLocation(null);
        }
        return () => {};
      }

      const syncMobileLocation = (newLocation) => {
        syncLiveDriverLocation(newLocation);
        if (!newLocation.latitude || !newLocation.longitude) return;
        const now = Date.now();

        // Phase 2 or 3 locked: re-trigger map bounds so view follows live GPS.
        // Only fires if this device's driver IS the selected/target driver —
        // an admin with a different driver selected must not override those bounds.
        // CRITICAL: Also cross-check the window global (set by MapViewCycleFAB from React state)
        // to guard against ref/state desync where mapViewPhaseRef says 2 but FAB shows 1.
        const fabReportsPhase = window.__currentMapViewPhase ?? mapViewPhaseRef.current;
        if (isMapViewLockedRef.current && (mapViewPhaseRef.current === 2 || mapViewPhaseRef.current === 3) && (fabReportsPhase === 2 || fabReportsPhase === 3)) {
          if ((window._suppressMapRepositionUntil || 0) > now) return;
          // Suppress GPS-driven map repositioning for 1.5s after exiting immersive mode
          // (just enough time for the padding re-render to settle — driver still needs the map
          // to follow them at 250m from the stop, so 5s was too long here).
          if ((window._lastImmersiveExitAt || 0) > now - 1500) return;
          const selectedId = window._selectedDriverIdRef?.current;
          if (selectedId && selectedId !== 'all' && selectedId !== currentUser.id) return;
          // Phase 2: always try to scroll the next card into view on every GPS tick,
          // regardless of whether the map itself repositions.
          if (mapViewPhaseRef.current === 2) {
            const nextCard = deliveriesWithStopOrderRef.current.find((d) => d && d.isNextDelivery === true);
            if (nextCard) document.getElementById(`stop-card-${nextCard.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }

          // No update timer / distance-gate here anymore: on the primary device the map
          // follow is driven exactly by the live GPS marker's own update cadence — every
          // watchPosition tick that reaches here (already the device's real GPS refresh
          // rate) immediately repositions the map, matching the live-location marker 1:1.
          if (isPrimaryDeviceRef.current) {
            lastProgrammaticMapMoveRef.current = now;
            window._lastProgrammaticMapMove = now;
            pendingPhaseRef.current = mapViewPhaseRef.current;
            setMapViewTrigger((prev) => prev + 1);
          }
          return;
        }

        // Proximity snap — only when unlocked, user hasn't interacted recently, AND on primary device only
        // CRITICAL: Never proximity-snap within 5s of exiting immersive mode — the driver
        // just arrived near a stop and is parked; snapping to Phase 2 causes a jarring map jump.
        if ((window._lastImmersiveExitAt || 0) > now - 5000) return;
        if (isMapViewLockedRef.current || now - lastUserInteractionRef.current < 300000) return;
        // CRITICAL: Only trigger proximity phase 2 on the driver's primary mobile device.
        // Secondary/tablet devices should not auto-switch map phases based on proximity.
        if (!isPrimaryDeviceRef.current) return;
        // Include 'pending' stops so unstarted routes also trigger proximity phase 2
        for (const delivery of deliveriesWithStopOrderRef.current.filter((d) => d && d.isNextDelivery === true && ['in_transit', 'en_route', 'pending'].includes(d.status))) {
          const patient = delivery.patient_id ? patientsRef.current.find((p) => p && p.id === delivery.patient_id) : null;
          const store   = !delivery.patient_id && delivery.store_id ? storesRef.current.find((s) => s && s.id === delivery.store_id) : null;
          const stopLat = patient?.latitude ?? store?.latitude;
          const stopLon = patient?.longitude ?? store?.longitude;
          if (stopLat == null || stopLon == null) continue;
          if (calculateDistanceRef.current(newLocation.latitude, newLocation.longitude, stopLat, stopLon) > 0.1) continue;

          // Driver is within 100m of the next stop.
          // CRITICAL: Only snap ONCE per stop. If we already snapped for this delivery ID,
          // do NOT snap again — this prevents the proximity snap from re-firing every 60s
          // while the driver is parked at the stop waiting to complete it. The snap only
          // re-arms when isNextDelivery changes to a different delivery (i.e. stop completed).
          if (lastProximitySnappedStopIdRef.current === delivery.id) {
            // Already snapped for this stop — still scroll the card into view but don't re-snap phase.
            const cardElement = document.getElementById(`stop-card-${delivery.id}`);
            cardElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            break;
          }

          // First arrival at this stop — fire the snap.
          lastProximitySnapTimeRef.current = Date.now();
          lastProximitySnappedStopIdRef.current = delivery.id;

          const currentPhase = mapViewPhaseRef.current;
          if (currentPhase !== 2) {
            // Only activate phase 2 if there is a driver location available for phase 2 to be meaningful
            const hasDriverLocation = !!(
              (newLocation.latitude && newLocation.longitude) ||
              appUsersRef.current?.find((au) => au?.user_id === currentUser?.id)?.current_latitude
            );
            if (hasDriverLocation) {
              // Lock FAB into phase 2 and trigger a map reposition
              mapViewPhaseRef.current = 2;
              isMapViewLockedRef.current = true;
              pendingPhaseRef.current = 2;
              lastProgrammaticMapMoveRef.current = now;
              window._lastProgrammaticMapMove = now;
              // Dispatch event so FABControls can update its state synchronously
              window.dispatchEvent(new CustomEvent('proximityActivatedPhase2', {
                detail: { driverId: currentUser?.id }
              }));
              // Trigger map to actually reposition to phase 2 bounds
              setMapViewTrigger((prev) => prev + 1);
            }
          }
          // Scroll the next stop card into view
          const cardElement = document.getElementById(`stop-card-${delivery.id}`);
          cardElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          break;
        }
      };

      const trackerStatus = locationTracker.getStatus();
      if (trackerStatus.lastLocation?.latitude && trackerStatus.lastLocation?.longitude) {
        syncMobileLocation({
          latitude:  trackerStatus.lastLocation.latitude,
          longitude: trackerStatus.lastLocation.longitude,
          timestamp: new Date().toISOString(),
          accuracy:  trackerStatus.lastLocation.accuracy,
          source:    'tracker'
        });
      }

      const handleTrackerPosition = (event) => {
        const { userId, latitude, longitude, timestamp, accuracy, source } = event.detail || {};
        if (userId && userId !== currentUser.id) return;
        if (!latitude || !longitude) return;
        syncMobileLocation({ latitude, longitude, timestamp, accuracy, source: source || 'tracker' });
      };

      window.addEventListener('driverPositionUpdated', handleTrackerPosition);
      if (!trackerStatus.isTracking && navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          (position) => syncMobileLocation({
            latitude:  position.coords.latitude,
            longitude: position.coords.longitude,
            timestamp: new Date(position.timestamp).toISOString(),
            accuracy:  position.coords.accuracy,
            source:    'device_gps'
          }),
          (error) => console.warn('⚠️ [Dashboard] GPS error:', error.message),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      } else if (!trackerStatus.isTracking) {
        console.warn('⚠️ [Dashboard] Geolocation not available on this device');
      }

      return () => window.removeEventListener('driverPositionUpdated', handleTrackerPosition);
    };

    const cleanup = startWatchingPosition();
    return () => {
      if (cleanup) cleanup();
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };

  // Stable deps only — live data (deliveriesWithStopOrder, patients, stores, appUsers,
  // calculateDistance) are read via refs above so the effect never tears down the GPS
  // listener just because a delivery refreshed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver, currentUser, isMobile, locationTracker, setDriverLocation, setMapViewTrigger,
      mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef,
      lastProgrammaticMapMoveRef, lastUserInteractionRef, lastProximitySnapTimeRef, stopCardsContainerRef]);

  // ── App resume / visibility reacquisition ────────────────────────────────────────────────
  // On Android Chrome, switching apps suspends the browser context. When the driver returns:
  //   1. `locationTracker._resumeAfterAbsence` fires a fresh GPS fix and dispatches
  //      `driverLocationFocusRefresh` with the new coords — we must pipe that into React state.
  //   2. The Dashboard's fallback `watchPosition` watcher (started inside startWatchingPosition)
  //      may have gone stale during the suspension — we detect this and restart it.
  // Both fixes together eliminate the straight-line jump caused by a long gap between the last
  // breadcrumb before suspension and the first one after return.
  const resumeWatchIdRef      = useRef(null);    // separate watch started on resume
  const lastVisibilityHideRef = useRef(0);

  useEffect(() => {
    if (!isDriver || !currentUser || !isMobile) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastVisibilityHideRef.current = Date.now();
        return;
      }

      const awayMs = Date.now() - (lastVisibilityHideRef.current || 0);
      if (awayMs < 15000) return; // not gone long enough to need a restart

      console.log(`🔄 [useDriverLocationSync] App resumed after ${Math.round(awayMs / 1000)}s — reacquiring GPS watcher`);

      // Clear any stale resume watcher from a previous return
      if (resumeWatchIdRef.current !== null) {
        navigator.geolocation?.clearWatch(resumeWatchIdRef.current);
        resumeWatchIdRef.current = null;
      }

      // Fire a fresh watchPosition that overwrites stale position state immediately.
      // This runs in parallel with locationTracker's own refreshNow — both contribute
      // a fresh fix so whichever resolves first updates the UI.
      if (navigator.geolocation) {
        resumeWatchIdRef.current = navigator.geolocation.watchPosition(
          (position) => {
            syncLiveDriverLocationRef.current?.({
              latitude:  position.coords.latitude,
              longitude: position.coords.longitude,
              timestamp: new Date(position.timestamp).toISOString(),
              accuracy:  position.coords.accuracy,
              source:    'device_gps_resume',
            });
          },
          (err) => console.warn('⚠️ [useDriverLocationSync] Resume GPS watcher error:', err?.message),
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
        );
      }
    };

    // Also pipe locationTracker's immediate refreshNow result into React state.
    // `driverLocationFocusRefresh` is dispatched by locationTracker._resumeAfterAbsence
    // right after it acquires a fresh fix — but useDriverLocationSync never listened to it.
    const handleFocusRefresh = (event) => {
      const { userId, latitude, longitude, accuracy } = event.detail || {};
      if (userId && userId !== currentUser.id) return;
      if (!latitude || !longitude) return;
      syncLiveDriverLocationRef.current?.({
        latitude,
        longitude,
        timestamp: new Date().toISOString(),
        accuracy: accuracy ?? null,
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

  // ── Selected driver shared-location follow (admin/dispatcher viewing another driver) ──
  // When a specific driver is selected that is NOT the current user, re-trigger the map
  // on their shared location updates so phase 2/3 follows them instead of the viewer.
  const selectedDriverIdRef = useRef(selectedDriverId);
  useEffect(() => { selectedDriverIdRef.current = selectedDriverId; }, [selectedDriverId]);

  useEffect(() => {
    const handleSharedLocationUpdate = (event) => {
      const now = Date.now();
      if (!isMapViewLockedRef.current) return;
      if (mapViewPhaseRef.current !== 2 && mapViewPhaseRef.current !== 3) return;
      // CRITICAL: Guard against ref/state desync — FAB must also report phase 2/3
      const fabPhase = window.__currentMapViewPhase ?? mapViewPhaseRef.current;
      if (fabPhase !== 2 && fabPhase !== 3) return;
      if ((window._suppressMapRepositionUntil || 0) > now) return;

      const targetId = selectedDriverIdRef.current;

      // On a non-primary device the driver's own location arrives via shared location broadcast,
      // not local GPS — so we must also re-trigger the map for self (targetId === currentUser?.id)
      // and for the "all" case when not on the primary device.
      const isSelfOrAll = !targetId || targetId === 'all' || targetId === currentUser?.id;
      if (isSelfOrAll && isPrimaryDeviceRef.current) return; // primary device handles this via live GPS path
      if (!isSelfOrAll) {
        // Specific OTHER driver selected — resolve that driver's updated record
      }

      const updatedAppUsers = event?.detail?.appUsers;
      if (!Array.isArray(updatedAppUsers) || updatedAppUsers.length === 0) return;

      // Resolve the effective target: for self/all on non-primary, use current user's record
      const resolvedTargetId = (isSelfOrAll && !isPrimaryDeviceRef.current)
        ? currentUser?.id
        : targetId;
      const targetAppUser = updatedAppUsers.find((au) => au?.user_id === resolvedTargetId);
      if (!targetAppUser?.current_latitude || !targetAppUser?.current_longitude) return;

      // No update timer here either: on non-primary devices the map follow is driven
      // exactly by the shared/broadcast location marker's own update cadence — every
      // 'driverLocationsUpdated' event for the target driver immediately repositions
      // the map, matching the shared marker 1:1 instead of polling on an interval.
      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      pendingPhaseRef.current = mapViewPhaseRef.current;
      setMapViewTrigger((prev) => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, setMapViewTrigger, mapViewPhaseRef, isMapViewLockedRef,
      pendingPhaseRef, lastProgrammaticMapMoveRef]);
}
