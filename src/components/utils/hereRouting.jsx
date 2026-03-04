import { base44 } from '@/api/base44Client';

const fetchingKeys = new Set();
const memoryCache = new Map();

// Decode Google encoded polyline to [[lat, lng], ...]
function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0, coordinates = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

export const getHerePolyline = async (driverId, fromStop, toStop) => {
  if (!fromStop || !toStop) return null;
  if (typeof fromStop.latitude !== 'number' || typeof toStop.latitude !== 'number') return null;

  const cacheKey = `here_${fromStop.latitude.toFixed(5)}_${fromStop.longitude.toFixed(5)}_${toStop.latitude.toFixed(5)}_${toStop.longitude.toFixed(5)}`;

  // Check memory cache
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }

  // Check localStorage
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const coords = JSON.parse(cached);
      memoryCache.set(cacheKey, coords);
      return coords;
    }
  } catch (e) {
    console.warn('Failed to read HERE polyline from localStorage', e);
  }

  if (fetchingKeys.has(cacheKey)) return null; // Prevent concurrent fetches for same key
  fetchingKeys.add(cacheKey);

  try {
    const res = await base44.functions.invoke('getHereDirections', {
      origin: { lat: fromStop.latitude, lng: fromStop.longitude },
      destination: { lat: toStop.latitude, lng: toStop.longitude }
    });

    if (res.data && res.data.coordinates) {
      const coords = res.data.coordinates.map(p => [p.lat, p.lng]);
      memoryCache.set(cacheKey, coords);
      try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (e) { console.warn('Failed to save HERE polyline to localStorage', e); }
      fetchingKeys.delete(cacheKey);
      return coords;
    }

    // Fallback: Google Directions if HERE failed or returned no coordinates
    const gres = await base44.functions.invoke('getGoogleDirections', {
      origin: { lat: fromStop.latitude, lon: fromStop.longitude },
      destination: { lat: toStop.latitude, lon: toStop.longitude }
    });
    if (gres?.data?.polyline && typeof gres.data.polyline === 'string') {
      const gcoords = decodeGooglePolyline(gres.data.polyline);
      if (Array.isArray(gcoords) && gcoords.length > 1) {
        memoryCache.set(cacheKey, gcoords);
        try { localStorage.setItem(cacheKey, JSON.stringify(gcoords)); } catch (e) { console.warn('Failed to save Google polyline to localStorage', e); }
        fetchingKeys.delete(cacheKey);
        return gcoords;
      }
    }
  } catch (err) {
    console.error('Failed to fetch polyline (HERE/Google):', err);
  }
  
  fetchingKeys.delete(cacheKey);
  return null;
};