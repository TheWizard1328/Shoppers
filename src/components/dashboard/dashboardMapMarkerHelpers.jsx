if (typeof window !== 'undefined') {
  window.__dashboardMapMarkerHelpers = window.__dashboardMapMarkerHelpers || {};
}

export const FINISHED_MAP_STATUSES = ['completed', 'failed', 'cancelled'];

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
  // SELECTED-DRIVER BOUNDS RULE (Sep 16, 2026): when a specific driver is
  // selected, ONLY that driver's home marker may contribute to the FAB bounds —
  // even in show-all mode. Admins/owner render home pins for ALL active drivers
  // (Sep 11 rule), but those pins must not stretch the zoom/center fit when the
  // admin is focused on one driver.
  const isSpecificDriverSelected = !!selectedDriverId && selectedDriverId !== 'all';

  if (hasDriverMarkers) {
    return [];
  }

  return (mapHomeMarkers || []).filter((home) => {
    const stops = [...(mapDeliveryMarkers || []), ...(mapPickupMarkers || [])].filter((stop) => stop?.driver_id === home.driverId);
    const finishedStops = stops.filter((stop) => FINISHED_MAP_STATUSES.includes(stop.status));
    const allStopsFinished = stops.length > 0 && finishedStops.length === stops.length;
    const noFinishedStops = finishedStops.length === 0;

    // Is this the selected driver? (loose String compare — driverId may be user.id or user.user_id)
    const isSelectedDriver = home.driverId === selectedDriverId ||
      String(home.driverId) === String(selectedDriverId) ||
      (userHasRole(currentUser, 'driver') && home.driverId === currentUser.id);

    // Admins always count as "viewing the selected driver" when one is selected
    const isAdminViewingSelectedDriver = isAdmin &&
      (home.driverId === selectedDriverId || String(home.driverId) === String(selectedDriverId));

    const isViewingThisDriver = isSelectedDriver || isAdminViewingSelectedDriver;

    // With a specific driver selected, every other driver's home marker is
    // excluded from the bounds, full stop — no show-all override.
    if (isSpecificDriverSelected && !isViewingThisDriver) return false;

    // Always show home for the selected driver when route is complete OR has no finished stops yet
    const shouldShowHome = isViewingThisDriver
      ? (allStopsFinished || noFinishedStops)
      : noFinishedStops;

    const shouldShowForCurrentView = isViewingThisDriver || (isAdmin && isShowAllMode) || showAllDriverMarkers || selectedDriverId === 'all';
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