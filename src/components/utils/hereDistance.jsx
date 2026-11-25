import { base44 } from '@/api/base44Client';
import { calculateDistanceKmSafe } from './geoUtils';

// OWNER RULE (Nov 24 2026): "Dist from store" must be the HERE road distance, not
// the crow-flies estimate. getPatientDistanceFromStore is the dedicated HERE Router
// call (car profile) and already falls back to haversine server-side if the key or
// the route is unavailable. Keys come from Admin Utilities > App Settings.
export const resolveHereDistanceKm = async (originLat, originLng, destLat, destLng) => {
  const oLat = Number(originLat);
  const oLng = Number(originLng);
  const dLat = Number(destLat);
  const dLng = Number(destLng);
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) return null;
  try {
    const res = await base44.functions.invoke('getPatientDistanceFromStore', {
      originLat: oLat,
      originLng: oLng,
      destLat: dLat,
      destLng: dLng,
    });
    const data = res?.data || res;
    const km = Number(data?.distance_km);
    if (Number.isFinite(km) && km > 0) return Math.round(km * 100) / 100;
  } catch (err) {
    console.warn('[hereDistance] HERE lookup failed, using straight line:', err?.message);
  }
  const fallback = calculateDistanceKmSafe(oLat, oLng, dLat, dLng);
  return fallback === null ? null : Math.round(fallback * 100) / 100;
};
