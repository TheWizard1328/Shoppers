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
  // Tracks the driver's coordinates at the time of the last phase-2 map reposition
  // so we can distance-gate updates and match the live-marker update cadence.
  const lastMapPositionRef = useRef(null);

  // ── Live data refs ────────────────────────────────────────────────────────
  // These let syncMobileLocation always read current data without the effect
  // itself re-running (and tearing down the GPS listener) on every delivery
  // or patient/store update.
  const deliveriesWithStopOrderRef = useRef(deliveriesWithStopOrder);
  const patientsRef                = useRef(patients);
  const storesRef                  = useRef(stores);
  const appUsersRef                = useRef(appUsers);
  const calculateDistanceRef       = useRef(calculateDistance);

  useEffect(() => { deliveriesWithStopOrderRef.current = deliveriesWithStopOrder; }, [deliveriesWithStopOrder]);
  useEffect(() => { patientsRef.current                = patients;                }, [patients]);
  useEffect(() => { storesRef.current                  = stores;                  }, [stores]);
  useEffect(() => { appUsersRef.current                = appUsers;                }, [appUsers]);
  useEffect(() => { calculateDistanceRef.current       = calculateDistance;       }, [calculateDistance]);

  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const syncLiveDriverLocation = (newLocation) => {
      if (!newLocation?.latitude || !newLocation?.longitude) return;
      lastLiveDriverLocationRef.current = newLocation;
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
          const minIntervalMs = mapViewPhaseRef.current === 2 ? 1200 : 1800;
          // Phase 2: always try to scroll the next card into view on every GPS tick,
          // regardless of whether the map itself repositions.
          if (mapViewPhaseRef.current === 2) {
            const nextCard = deliveriesWithStopOrderRef.current.find((d) => d && d.isNextDelivery === true);
            if (nextCard) document.getElementById(`stop-card-${nextCard.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }

          // Phase 2 on primary device: require ≥15m of movement since the last
          // map reposition so the view follows the live-location marker cadence.
          // Fallback: if we haven't repositioned in 6s regardless of distance, allow it.
          if (mapViewPhaseRef.current === 2 && isPrimaryDevice && lastMapPositionRef.current) {
            const movedKm = calculateDistanceRef.current(
              newLocation.latitude, newLocation.longitude,
              lastMapPositionRef.current.latitude, lastMapPositionRef.current.longitude
            );
            const PHASE2_MIN_DIST_KM = 0.015; // 15 metres
            const timeFallbackMs = minIntervalMs * 5; // ~6s — ensures map catches up if driver is slow
            if (movedKm < PHASE2_MIN_DIST_KM && now - lastProgrammaticMapMoveRef.current < timeFallbackMs) return;
          }
          if (now - lastProgrammaticMapMoveRef.current >= minIntervalMs) {
            lastProgrammaticMapMoveRef.current = now;
            window._lastProgrammaticMapMove = now;
            if (mapViewPhaseRef.current === 2) lastMapPositionRef.current = { latitude: newLocation.latitude, longitude: newLocation.longitude };
            pendingPhaseRef.current = mapViewPhaseRef.current;
            setMapViewTrigger((prev) => prev + 1);
          }
          return;
        }

        // Proximity snap — only when unlocked, user hasn't interacted recently, AND on primary device only
        // CRITICAL: Never proximity-snap within 5s of exiting immersive mode — the driver
        // just arrived near a stop and is parked; snapping to Phase 2 causes a jarring map jump.
        if ((window._lastImmersiveExitAt || 0) > now - 5000) return;
        if (isMapViewLockedRef.current || now - lastUserInteractionRef.current < 300000 || now - lastProximitySnapTimeRef.current < 60000) return;
        // CRITICAL: Only trigger proximity phase 2 on the driver's primary mobile device.
        // Secondary/tablet devices should not auto-switch map phases based on proximity.
        if (!isPrimaryDevice) return;
        // Include 'pending' stops so unstarted routes also trigger proximity phase 2
        for (const delivery of deliveriesWithStopOrderRef.current.filter((d) => d && d.isNextDelivery === true && ['in_transit', 'en_route', 'pending'].includes(d.status))) {
          const patient = delivery.patient_id ? patientsRef.current.find((p) => p && p.id === delivery.patient_id) : null;
          const store   = !delivery.patient_id && delivery.store_id ? storesRef.current.find((s) => s && s.id === delivery.store_id) : null;
          const stopLat = patient?.latitude ?? store?.latitude;
          const stopLon = patient?.longitude ?? store?.longitude;
          if (stopLat == null || stopLon == null) continue;
          if (calculateDistanceRef.current(newLocation.latitude, newLocation.longitude, stopLat, stopLon) > 0.1) continue;
          // Driver is within 100m of the next stop:
          // Activate FAB into phase 2 (lock it) WITHOUT moving the map.
          // This lets the driver see they're "locked to next stop" without a jarring map jump.
          lastProximitySnapTimeRef.current = Date.now();
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
          source:    trackerStatus.providerName || 'tracker'
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
      if (isSelfOrAll && isPrimaryDevice) return; // primary device handles this via live GPS path
      if (!isSelfOrAll) {
        // Specific OTHER driver selected — resolve that driver's updated record
      }

      const updatedAppUsers = event?.detail?.appUsers;
      if (!Array.isArray(updatedAppUsers) || updatedAppUsers.length === 0) return;

      // Resolve the effective target: for self/all on non-primary, use current user's record
      const resolvedTargetId = (isSelfOrAll && !isPrimaryDevice)
        ? currentUser?.id
        : targetId;
      const targetAppUser = updatedAppUsers.find((au) => au?.user_id === resolvedTargetId);
      if (!targetAppUser?.current_latitude || !targetAppUser?.current_longitude) return;

      const minIntervalMs = mapViewPhaseRef.current === 2 ? 1200 : 1800;
      if (now - lastProgrammaticMapMoveRef.current < minIntervalMs) return;

      lastProgrammaticMapMoveRef.current = now;
      window._lastProgrammaticMapMove = now;
      pendingPhaseRef.current = mapViewPhaseRef.current;
      setMapViewTrigger((prev) => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleSharedLocationUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, isPrimaryDevice, setMapViewTrigger, mapViewPhaseRef, isMapViewLockedRef,
      pendingPhaseRef, lastProgrammaticMapMoveRef]);
}