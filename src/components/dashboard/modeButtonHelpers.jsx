import { normalizeTravelMode } from '@/components/dashboard/travelModeHelpers';
import { haversineKm } from '@/components/utils/geoUtils';

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

// Consolidated into geoUtils (Sep 6 2026) — object coords, missing -> Infinity (previous semantics).
export function calculateDistanceKm(from, to) {
  if (!from?.latitude || !from?.longitude || !to?.latitude || !to?.longitude) return Infinity;
  return haversineKm(
    Number(from.latitude), Number(from.longitude),
    Number(to.latitude), Number(to.longitude)
  ); // straight-line haversine km
}

export function getCurrentDriverLocation({ currentUser, appUsers = [], driverLocation = null }) {
  if (driverLocation?.latitude && driverLocation?.longitude) {
    return {
      latitude: Number(driverLocation.latitude),
      longitude: Number(driverLocation.longitude)
    };
  }

  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);
  if (appUser?.current_latitude && appUser?.current_longitude) {
    return {
      latitude: Number(appUser.current_latitude),
      longitude: Number(appUser.current_longitude)
    };
  }

  if (currentUser?.current_latitude && currentUser?.current_longitude) {
    return {
      latitude: Number(currentUser.current_latitude),
      longitude: Number(currentUser.current_longitude)
    };
  }

  return null;
}

export function getNearbyModeStops({ deliveries = [], patients = [], stores = [], currentLocation, cyclingStartLocation = null, radiusKm = 50 }) {
  // Use cycling start marker coords for distance if available, otherwise driver location
  const distanceOrigin = cyclingStartLocation || currentLocation;

  return deliveries
    .filter((delivery) => delivery && !delivery.is_cycling_marker && !['completed', 'failed', 'cancelled'].includes(delivery.status))
    .map((delivery) => {
      const store = stores.find((item) => item?.id === delivery.store_id);
      const storeAbbreviation = store?.abbreviation || null;

      if (delivery.patient_id) {
        const patient = patients.find((item) => item?.id === delivery.patient_id || item?.patient_id === delivery.patient_id);
        const distanceKm = (distanceOrigin && patient?.latitude && patient?.longitude)
          ? calculateDistanceKm(distanceOrigin, { latitude: patient.latitude, longitude: patient.longitude })
          : null;
        if (currentLocation && distanceKm !== null && distanceKm > radiusKm) return null;
        return {
          id: delivery.id,
          label: patient?.full_name || 'Patient Stop',
          subtitle: patient?.address || '',
          distanceKm,
          storeAbbreviation,
          storeColor: store?.color || null,
          status: delivery.status,
          stopType: 'delivery',
          delivery
        };
      }

      const distanceKm = (distanceOrigin && store?.latitude && store?.longitude)
        ? calculateDistanceKm(distanceOrigin, { latitude: store.latitude, longitude: store.longitude })
        : null;
      if (currentLocation && distanceKm !== null && distanceKm > radiusKm) return null;
      return {
        id: delivery.id,
        label: store?.name || 'Store Pickup',
        subtitle: store?.address || '',
        distanceKm,
        storeAbbreviation,
        storeColor: store?.color || null,
        status: delivery.status,
        stopType: 'pickup',
        delivery
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return (a.delivery?.stop_order || 999) - (b.delivery?.stop_order || 999);
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm || (a.delivery?.stop_order || 999) - (b.delivery?.stop_order || 999);
    });
}

export function getNextModeValue(mode) {
  return normalizeTravelMode(mode) === 'cycling' ? 'driving' : 'cycling';
}