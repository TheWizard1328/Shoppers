if (typeof window !== 'undefined') {
  window.__dashboardMapMarkerHelpers = window.__dashboardMapMarkerHelpers || {};
}

export const FINISHED_MAP_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

import { getDeliveryTypeFlags } from '../utils/deliveryTypeUtils';
import { getInterStoreLocationSync } from '../utils/interStoreDisplayName';

export function getVisibleHomeMarkersForBounds({
  mapHomeMarkers = [],
  mapDeliveryMarkers = [],
  mapPickupMarkers = [],
  currentUser,
  selectedDriverId,
  showAllDriverMarkers,
  userHasRole,
  hasDriverMarkers = false
}) {
  const isAdmin = userHasRole(currentUser, 'admin');
  const isShowAllMode = showAllDriverMarkers || selectedDriverId === 'all';

  if (hasDriverMarkers) {
    return [];
  }

  return (mapHomeMarkers || []).filter((home) => {
    const stops = [...(mapDeliveryMarkers || []), ...(mapPickupMarkers || [])].filter((stop) => stop?.driver_id === home.driverId);
    const firstFinishedStop = stops.find((stop) => FINISHED_MAP_STATUSES.includes(stop.status));
    const visiblePickups = stops.filter((stop) => stop?.markerType === 'pickup');
    const lastPickupIsFinished = visiblePickups.length > 0 && visiblePickups.every((stop) => FINISHED_MAP_STATUSES.includes(stop.status));
    const shouldShowHome = !firstFinishedStop || lastPickupIsFinished;
    const shouldShowForCurrentView = (userHasRole(currentUser, 'driver') && home.driverId === currentUser.id) || (isAdmin && isShowAllMode) || showAllDriverMarkers || selectedDriverId === 'all' || home.driverId === selectedDriverId;
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

    // Cycling markers use dedicated lat/lng fields — include them in bounds directly
    if (delivery.is_cycling_marker) {
      if (delivery.cycling_latitude && delivery.cycling_longitude) {
        allCoordinates.push([delivery.cycling_latitude, delivery.cycling_longitude]);
        hasStopMarkers = true;
        coordsAdded++;
      }
      return;
    }

    const { isPatientDelivery, isInterStore, isStorePickup } = getDeliveryTypeFlags(delivery);

    if (isPatientDelivery) {
      const patient = patients.find((p) => p && p.id === delivery.patient_id);
      if (patient?.latitude && patient?.longitude) {
        allCoordinates.push([patient.latitude, patient.longitude]);
        hasStopMarkers = true;
        coordsAdded++;
      }
      return;
    }

    if (isInterStore) {
      // ISP/ISD: use InterStoreLocation coords (sync cache from interStoreDisplayName)
      const loc = getInterStoreLocationSync(delivery.delivery_id);
      if (loc?.store_latitude && loc?.store_longitude) {
        allCoordinates.push([loc.store_latitude, loc.store_longitude]);
        hasStopMarkers = true;
        coordsAdded++;
        return;
      }
      // Fallback to stored _interstore fields if cache not yet warm
      if (delivery._interstore_source_id || delivery._interstore_dest_id) return;
    }

    if (isStorePickup && delivery.store_id) {
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