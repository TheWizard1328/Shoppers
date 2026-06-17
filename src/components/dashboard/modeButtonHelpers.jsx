import { normalizeTravelMode } from '@/components/dashboard/travelModeHelpers';

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

export function calculateDistanceKm(from, to) {
  if (!from?.latitude || !from?.longitude || !to?.latitude || !to?.longitude) return Infinity;
  const earthRadiusKm = 6371;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(Number(to.latitude) - Number(from.latitude));
  const deltaLon = toRadians(Number(to.longitude) - Number(from.longitude));
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.25; // Add a 25% multiplyer to offset direct line of sight
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

export function getNearbyModeStops({ deliveries = [], patients = [], stores = [], currentLocation, radiusKm = 50 }) {
  return deliveries
    .filter((delivery) => delivery && !delivery.is_cycling_marker && !['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status))
    .map((delivery) => {
      if (delivery.patient_id) {
        const patient = patients.find((item) => item?.id === delivery.patient_id || item?.patient_id === delivery.patient_id);
        const distanceKm = (currentLocation && patient?.latitude && patient?.longitude)
          ? calculateDistanceKm(currentLocation, { latitude: patient.latitude, longitude: patient.longitude })
          : null;
        if (currentLocation && distanceKm !== null && distanceKm > radiusKm) return null;
        return {
          id: delivery.id,
          label: patient?.full_name || 'Patient Stop',
          subtitle: patient?.address || '',
          distanceKm,
          status: delivery.status,
          stopType: 'delivery',
          delivery
        };
      }

      const store = stores.find((item) => item?.id === delivery.store_id);
      const distanceKm = (currentLocation && store?.latitude && store?.longitude)
        ? calculateDistanceKm(currentLocation, { latitude: store.latitude, longitude: store.longitude })
        : null;
      if (currentLocation && distanceKm !== null && distanceKm > radiusKm) return null;
      return {
        id: delivery.id,
        label: store?.name || 'Store Pickup',
        subtitle: store?.address || '',
        distanceKm,
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