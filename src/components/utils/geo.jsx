import { User } from '@/entities/User';

/**
 * Calculates the distance between two geographical points using the Haversine formula.
 * @param {number} lat1 - Latitude of the first point.
 * @param {number} lon1 - Longitude of the first point.
 * @param {number} lat2 - Latitude of the second point.
 * @param {number} lon2 - Longitude of the second point.
 * @returns {number} The distance in kilometers.
 */
export function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  
  const R = 6371; // Earth's radius in km
  const toRadians = (deg) => deg * (Math.PI / 180);
  
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c;
}

/**
 * Gets cities within a specified radius of a center city.
 * @param {Object} centerCity - The center city object with latitude and longitude.
 * @param {Array} allCities - Array of all city objects.
 * @param {number} radiusKm - The radius in kilometers (default: 75).
 * @returns {Array} Array of city objects within the radius (including the center city).
 */
export function getCitiesWithinRadius(centerCity, allCities, radiusKm = 75) {
  if (!centerCity || !centerCity.latitude || !centerCity.longitude) {
    console.warn('⚠️ [geo] Center city has no coordinates');
    return centerCity ? [centerCity] : [];
  }
  
  if (!allCities || !Array.isArray(allCities)) {
    return centerCity ? [centerCity] : [];
  }
  
  const nearbyCities = allCities.filter(city => {
    if (!city || !city.latitude || !city.longitude) return false;
    
    // Always include the center city itself
    if (city.id === centerCity.id) return true;
    
    const distance = calculateDistanceKm(
      centerCity.latitude, 
      centerCity.longitude, 
      city.latitude, 
      city.longitude
    );
    
    return distance <= radiusKm;
  });
  
  console.log(`📍 [geo] Found ${nearbyCities.length} cities within ${radiusKm}km of ${centerCity.name}:`, 
    nearbyCities.map(c => `${c.name} (${calculateDistanceKm(centerCity.latitude, centerCity.longitude, c.latitude, c.longitude).toFixed(1)}km)`).join(', ')
  );
  
  return nearbyCities;
}

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