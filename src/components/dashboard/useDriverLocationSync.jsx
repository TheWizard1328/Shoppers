import { useEffect, useRef } from "react";

export default function useDriverLocationSync({
  isDriver,
  currentUser,
  appUsers,
  isMobile,
  deliveriesWithStopOrder,
  patients,
  stores,
  mapViewPhaseRef,
  isMapViewLockedRef,
  isMapViewLocked,
  lastProgrammaticMapMoveRef,
  lastUserInteractionRef,
  lastProximitySnapTimeRef,
  stopCardsContainerRef,
  setMapViewTrigger,
  setDriverLocation,
  calculateDistance,
  locationTracker,
}) {
  const lastLiveDriverLocationRef = useRef(null);

  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const syncLiveDriverLocation = (newLocation) => {
      if (!newLocation?.latitude || !newLocation?.longitude) return;
      lastLiveDriverLocationRef.current = newLocation;
      setDriverLocation(newLocation);
    };

    const startWatchingPosition = () => {
      if (!isMobile) {
        const appUser = appUsers?.find((au) => au?.user_id === currentUser.id);
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
        if (!isMobile || !newLocation.latitude || !newLocation.longitude) return;
        const now = Date.now();
        if (mapViewPhaseRef.current === 2 && isMapViewLockedRef.current) {
          const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
          if (nextCard) document.getElementById(`stop-card-${nextCard.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          return;
        }
        if (mapViewPhaseRef.current === 3 && isMapViewLockedRef.current) {
          return;
        }
        if (isMapViewLocked || now - lastUserInteractionRef.current < 300000 || now - lastProximitySnapTimeRef.current < 60000) return;
        for (const delivery of deliveriesWithStopOrder.filter((d) => d && ['in_transit', 'en_route'].includes(d.status))) {
          const patient = delivery.patient_id ? patients.find((p) => p && p.id === delivery.patient_id) : null;
          const store = !delivery.patient_id && delivery.store_id ? stores.find((s) => s && s.id === delivery.store_id) : null;
          const stopLat = patient?.latitude || store?.latitude;
          const stopLon = patient?.longitude || store?.longitude;
          if (!stopLat || !stopLon) continue;
          if (calculateDistance(newLocation.latitude, newLocation.longitude, stopLat, stopLon) > 0.1) continue;
          const cardElement = document.getElementById(`stop-card-${delivery.id}`);
          const container = stopCardsContainerRef.current?.querySelector('.overflow-x-auto');
          if (cardElement && container) {
            const c = container.getBoundingClientRect();
            const r = cardElement.getBoundingClientRect();
            if (Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) < 50) continue;
          }
          lastProximitySnapTimeRef.current = Date.now();
          cardElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          break;
        }
      };

      const trackerStatus = locationTracker.getStatus();
      if (trackerStatus.lastLocation?.latitude && trackerStatus.lastLocation?.longitude) {
        syncMobileLocation({
          latitude: trackerStatus.lastLocation.latitude,
          longitude: trackerStatus.lastLocation.longitude,
          timestamp: new Date().toISOString(),
          accuracy: trackerStatus.lastLocation.accuracy,
          source: trackerStatus.providerName || 'tracker'
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
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            timestamp: new Date(position.timestamp).toISOString(),
            accuracy: position.coords.accuracy,
            source: 'device_gps'
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
  }, [isDriver, currentUser, isMobile, deliveriesWithStopOrder, patients, stores, mapViewPhaseRef, isMapViewLockedRef, isMapViewLocked, appUsers, calculateDistance, locationTracker, lastProgrammaticMapMoveRef, lastUserInteractionRef, lastProximitySnapTimeRef, stopCardsContainerRef, setMapViewTrigger, setDriverLocation]);

  useEffect(() => {
    if (!isDriver || !currentUser?.id || !isMobile) return;

    const handleDriverLocationUpdated = (event) => {
      if (event?.detail?.fromPoller || event?.detail?.fromRealtime) return;

      const singleUpdate = event?.detail?.singleUpdate;
      if (singleUpdate?.user_id !== currentUser.id) return;
      if (!singleUpdate?.current_latitude || !singleUpdate?.current_longitude) return;

      const nextLocation = {
        latitude: Number(singleUpdate.current_latitude),
        longitude: Number(singleUpdate.current_longitude),
        timestamp: singleUpdate.location_updated_at || new Date().toISOString(),
        accuracy: lastLiveDriverLocationRef.current?.accuracy ?? null,
        source: 'tracker_sync'
      };

      syncLiveDriverLocation(nextLocation);
    };

    const syncLiveDriverLocation = (newLocation) => {
      if (!newLocation?.latitude || !newLocation?.longitude) return;
      lastLiveDriverLocationRef.current = newLocation;
      setDriverLocation(newLocation);
    };

    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdated);
    return () => window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdated);
  }, [isDriver, currentUser?.id, isMobile, setDriverLocation]);
}