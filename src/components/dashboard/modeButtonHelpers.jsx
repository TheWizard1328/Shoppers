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
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

export function getNearbyModeStops({ deliveries = [], patients = [], stores = [], currentLocation, radiusKm = 5 }) {
  if (!currentLocation) return [];

  return deliveries
    .filter((delivery) => delivery && !['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status))
    .map((delivery) => {
      if (delivery.patient_id) {
        const patient = patients.find((item) => item?.id === delivery.patient_id);
        if (!patient?.latitude || !patient?.longitude) return null;
        const distanceKm = calculateDistanceKm(currentLocation, {
          latitude: patient.latitude,
          longitude: patient.longitude
        });
        return {
          id: delivery.id,
          label: patient.full_name || 'Patient Stop',
          subtitle: patient.address || '',
          distanceKm,
          status: delivery.status,
          stopType: 'delivery',
          delivery
        };
      }

      const store = stores.find((item) => item?.id === delivery.store_id);
      if (!store?.latitude || !store?.longitude) return null;
      const distanceKm = calculateDistanceKm(currentLocation, {
        latitude: store.latitude,
        longitude: store.longitude
      });
      return {
        id: delivery.id,
        label: store.name || 'Store Pickup',
        subtitle: store.address || '',
        distanceKm,
        status: delivery.status,
        stopType: 'pickup',
        delivery
      };
    })
    .filter(Boolean)
    .filter((stop) => stop.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.delivery?.stop_order || 999) - (b.delivery?.stop_order || 999));
}

export function getNextModeValue(mode) {
  return normalizeTravelMode(mode) === 'cycling' ? 'driving' : 'cycling';
}