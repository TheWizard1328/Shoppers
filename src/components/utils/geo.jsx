import { User } from '@/entities/User';

/**
 * Calculates the initial bearing (direction) between two geographical points.
 * @param {number} lat1 - Latitude of the starting point.
 * @param {number} lon1 - Longitude of the starting point.
 * @param {number} lat2 - Latitude of the destination point.
 * @param {number} lon2 - Longitude of the destination point.
 * @returns {number} The initial bearing in degrees (0-360).
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRadians = (deg) => deg * (Math.PI / 180);
  const toDegrees = (rad) => (rad * (180 / Math.PI) + 360) % 360;

  const lat1Rad = toRadians(lat1);
  const lat2Rad = toRadians(lat2);
  const deltaLonRad = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLonRad) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLonRad);
  
  return toDegrees(Math.atan2(y, x));
}