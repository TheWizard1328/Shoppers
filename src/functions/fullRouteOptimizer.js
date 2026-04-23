import { base44 } from '@/api/base44Client';

export async function fullRouteOptimizer(payload) {
  const normalizedPayload = payload?.currentLocation
    ? {
        ...payload,
        startLocation: {
          lat: payload.currentLocation.latitude,
          lng: payload.currentLocation.longitude
        }
      }
    : (payload || {});

  return await base44.functions.invoke('optimizeRouteRealTime', normalizedPayload);
}