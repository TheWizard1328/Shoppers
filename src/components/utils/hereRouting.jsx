import { base44 } from '@/api/base44Client';

const fetchingKeys = new Set();
const memoryCache = new Map();

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
      
      // Save to localStorage
      try {
        localStorage.setItem(cacheKey, JSON.stringify(coords));
      } catch (e) {
        console.warn('Failed to save HERE polyline to localStorage', e);
      }
      
      fetchingKeys.delete(cacheKey);
      return coords;
    }
  } catch (err) {
    console.error('Failed to fetch HERE polyline:', err);
  }
  
  fetchingKeys.delete(cacheKey);
  return null;
};