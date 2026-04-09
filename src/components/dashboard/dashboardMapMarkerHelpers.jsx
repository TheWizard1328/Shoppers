if (typeof window !== 'undefined') {
  window.__dashboardMapMarkerHelpers = window.__dashboardMapMarkerHelpers || {};
}

export const FINISHED_MAP_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

export function getVisibleHomeMarkersForBounds({
  mapHomeMarkers = [],
  mapDeliveryMarkers = [],
  mapPickupMarkers = [],
  currentUser,
  selectedDriverId,
  showAllDriverMarkers,
  userHasRole
}) {
  return (mapHomeMarkers || []).filter((home) => {
    const stops = [...(mapDeliveryMarkers || []), ...(mapPickupMarkers || [])].filter((stop) => stop?.driver_id === home.driverId);
    const hasCompletedStops = stops.some((stop) => FINISHED_MAP_STATUSES.includes(stop.status));
    const remainingPickups = stops.filter((stop) => stop?.markerType === 'pickup' && !FINISHED_MAP_STATUSES.includes(stop.status)).length;
    const shouldShowHome = !hasCompletedStops || remainingPickups === 0;
    const shouldShowForCurrentView = (userHasRole(currentUser, 'driver') && home.driverId === currentUser.id) || showAllDriverMarkers || selectedDriverId === 'all' || home.driverId === selectedDriverId;
    return !home.excludeFromBounds && shouldShowHome && shouldShowForCurrentView;
  });
}

export function appendStopCoordinates({
  deliveriesToMap = [],
  patients = [],
  stores = [],
  allCoordinates = []
}) {
  let hasStopMarkers = false;
  let coordsAdded = 0;

  (deliveriesToMap || []).forEach((delivery) => {
    if (!delivery) return;

    if (delivery.patient_id) {
      const patient = patients.find((p) => p && p.id === delivery.patient_id);
      if (patient?.latitude && patient?.longitude) {
        allCoordinates.push([patient.latitude, patient.longitude]);
        hasStopMarkers = true;
        coordsAdded++;
      }
      return;
    }

    if (delivery.store_id) {
      const store = stores.find((s) => s && s.id === delivery.store_id);
      if (store?.latitude && store?.longitude) {
        allCoordinates.push([store.latitude, store.longitude]);
        hasStopMarkers = true;
        coordsAdded++;
      }
    }
  });

  return { hasStopMarkers, coordsAdded, allCoordinates };
}

if (typeof window !== 'undefined') {
  window.__dashboardMapMarkerHelpers = {
    getVisibleHomeMarkersForBounds,
    appendStopCoordinates,
    FINISHED_MAP_STATUSES
  };
}