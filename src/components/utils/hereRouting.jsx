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

// Encode Google polyline helpers
function encodeSigned(value) {
  let sgn = value << 1;
  if (value < 0) sgn = ~sgn;
  let encoded = '';
  while (sgn >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  encoded += String.fromCharCode(sgn + 63);
  return encoded;
}
function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    out += encodeSigned(latE5 - lastLat);
    out += encodeSigned(lngE5 - lastLng);
    lastLat = latE5; lastLng = lngE5;
  }
  return out;
}

export const getHerePolyline = async (driverId, fromStop, toStop, deliveryDate) => {
  if (!fromStop || !toStop) return null;
  if (typeof fromStop.latitude !== 'number' || typeof toStop.latitude !== 'number') return null;

  // Skip HERE call for zero-distance legs
  const samePoint = Math.abs(fromStop.latitude - toStop.latitude) < 1e-5 && Math.abs(fromStop.longitude - toStop.longitude) < 1e-5;
  if (samePoint) return null;

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

  // Check entity cache (DriverRoutePolyline) before hitting external APIs
  try {
    const rounded = (n) => Number(n.toFixed(5));
    const deliveryDateSafe = deliveryDate || (new Date().toISOString().slice(0,10));
    const recs = await base44.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDateSafe,
      segment_origin_lat: rounded(fromStop.latitude),
      segment_origin_lon: rounded(fromStop.longitude),
      segment_dest_lat: rounded(toStop.latitude),
      segment_dest_lon: rounded(toStop.longitude)
    }, '-updated_date', 1);
    const rec = Array.isArray(recs) ? recs[0] : null;
    if (rec?.encoded_polyline) {
      const coords = decodeGooglePolyline(rec.encoded_polyline);
      if (Array.isArray(coords) && coords.length > 1) {
        memoryCache.set(cacheKey, coords);
        try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (_) {}
        return coords;
      }
    }
  } catch (e) {
    console.warn('Entity polyline lookup failed', e);
  }

  // If we previously stored a hard error flag for this key, short-circuit for a bit to avoid hammering APIs
  const failKey = `${cacheKey}:fail_until`;
  try {
    const until = localStorage.getItem(failKey);
    if (until && Date.now() < Number(until)) {
      return null;
    }
  } catch (_) {}
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

      // Persist to DriverRoutePolyline entity for future reuse
      try {
        const rounded = (n) => Number(n.toFixed(5));
        const deliveryDateSafe = deliveryDate || (new Date().toISOString().slice(0,10));
        const encoded = encodeGooglePolyline(coords);
        if (encoded && typeof encoded === 'string') {
          const existing = await base44.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: deliveryDateSafe,
            segment_origin_lat: rounded(fromStop.latitude),
            segment_origin_lon: rounded(fromStop.longitude),
            segment_dest_lat: rounded(toStop.latitude),
            segment_dest_lon: rounded(toStop.longitude)
          }, '-updated_date', 1);
          if (Array.isArray(existing) && existing.length) {
            await base44.entities.DriverRoutePolyline.update(existing[0].id, {
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString()
            });
          } else {
            await base44.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDateSafe,
              encoded_polyline: encoded,
              segment_origin_lat: rounded(fromStop.latitude),
              segment_origin_lon: rounded(fromStop.longitude),
              segment_dest_lat: rounded(toStop.latitude),
              segment_dest_lon: rounded(toStop.longitude),
              last_generated_at: new Date().toISOString()
            });
          }
        }
      } catch (e) {
        console.warn('Failed to persist polyline entity', e);
      }

      fetchingKeys.delete(cacheKey);
      return coords;
    }

    // Google fallback disabled: use dashed straight line when HERE/Entity not available
  } catch (err) {
    console.error('Failed to fetch polyline (HERE/Google):', err);
  }
  
  // Backoff 60s for this key on repeated failure
  try { localStorage.setItem(`${cacheKey}:fail_until`, String(Date.now() + 10000)); } catch (_) {}

  fetchingKeys.delete(cacheKey);
  return null;
};