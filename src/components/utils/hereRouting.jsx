import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const fetchingKeys = new Set();
const memoryCache = new Map();
const USE_ENTITY_LOOKUP = true;

let polylineSubscribed = false;
const ensurePolylineSubscription = () => {
  if (polylineSubscribed) return;
  polylineSubscribed = true;
  try {
    const unsubscribe = base44.entities.DriverRoutePolyline.subscribe(async (event) => {
      try {
        if (event.type === 'delete') {
          await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, event.id);
        } else if (event.data) {
          const rec = event.data;
          await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [rec]);
          // Invalidate caches for this segment
          const key = rec && rec.segment_origin_lat != null && rec.segment_origin_lon != null && rec.segment_dest_lat != null && rec.segment_dest_lon != null
            ? `here_${Number(rec.segment_origin_lat).toFixed(5)}_${Number(rec.segment_origin_lon).toFixed(5)}_${Number(rec.segment_dest_lat).toFixed(5)}_${Number(rec.segment_dest_lon).toFixed(5)}`
            : null;
          if (key) {
            try {
              if (rec.encoded_polyline) {
                const coords = decodeGooglePolyline(rec.encoded_polyline);
                if (Array.isArray(coords) && coords.length > 1) {
                  memoryCache.set(key, coords);
                  try { localStorage.setItem(key, JSON.stringify(coords)); } catch (_) {}
                }
              }
            } catch (_) {}
            try { window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: rec.driver_id, deliveryDate: rec.delivery_date, key } })); } catch (_) {}
          }
        }
      } catch (e) {
        console.warn('[HERE][client] Realtime polyline offline sync failed', e);
      }
    });
    // Optional: store unsubscribe somewhere if needed
  } catch (e) {
    console.warn('[HERE][client] Failed to subscribe to DriverRoutePolyline realtime', e);
  }
};

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
  // Normalize coords to numbers (tablet sometimes sends strings)
  fromStop = { latitude: Number(fromStop.latitude), longitude: Number(fromStop.longitude) };
  toStop = { latitude: Number(toStop.latitude), longitude: Number(toStop.longitude) };
  if ([fromStop.latitude, fromStop.longitude, toStop.latitude, toStop.longitude].some((n) => Number.isNaN(n))) return null;

  // Skip HERE call for zero-distance legs
  const samePoint = Math.abs(fromStop.latitude - toStop.latitude) < 1e-5 && Math.abs(fromStop.longitude - toStop.longitude) < 1e-5;
  if (samePoint) {
    console.info('[HERE][client] Skipping HERE call: zero-distance leg', { from: fromStop, to: toStop });
    return null;
  }

  const cacheKey = `here_${fromStop.latitude.toFixed(5)}_${fromStop.longitude.toFixed(5)}_${toStop.latitude.toFixed(5)}_${toStop.longitude.toFixed(5)}`;
  console.debug('[HERE][client] Cache key', { cacheKey, driverId, deliveryDate });

  // Check memory cache
  if (memoryCache.has(cacheKey)) {
    const hit = memoryCache.get(cacheKey);
    console.debug('[HERE][client] Memory cache hit', { cacheKey, points: hit?.length });
    return hit;
  }

  // Check localStorage
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const coords = JSON.parse(cached);
      console.debug('[HERE][client] localStorage cache hit', { cacheKey, points: coords?.length });
      memoryCache.set(cacheKey, coords);
      return coords;
    } else {
      console.debug('[HERE][client] localStorage miss', { cacheKey });
    }
  } catch (e) {
    console.warn('[HERE][client] Failed to read HERE polyline from localStorage', e);
  }

  if (fetchingKeys.has(cacheKey)) { 
    console.debug('[HERE][client] Awaiting in-flight (poll)', { cacheKey });
    return await new Promise((resolve) => {
      let waited = 0;
      const iv = setInterval(() => {
        if (memoryCache.has(cacheKey)) { clearInterval(iv); resolve(memoryCache.get(cacheKey)); return; }
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) { clearInterval(iv); resolve(JSON.parse(cached)); return; }
        } catch (_) {}
        if (!fetchingKeys.has(cacheKey) || waited > 5000) { clearInterval(iv); resolve(null); }
        waited += 100;
      }, 100);
    });
  } // De-duplicate concurrent fetches

  // Try offline DB cache before hitting network/entity
  try {
    const all = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);
    if (Array.isArray(all) && all.length) {
      const rounded = (n) => Number(n.toFixed(5));
      const deliveryDateSafe = deliveryDate || (new Date().toISOString().slice(0,10));
      const rec = all.find(r => r.driver_id === driverId && r.delivery_date === deliveryDateSafe &&
        Number(r.segment_origin_lat)?.toFixed(5) === rounded(fromStop.latitude).toFixed(5) &&
        Number(r.segment_origin_lon)?.toFixed(5) === rounded(fromStop.longitude).toFixed(5) &&
        Number(r.segment_dest_lat)?.toFixed(5) === rounded(toStop.latitude).toFixed(5) &&
        Number(r.segment_dest_lon)?.toFixed(5) === rounded(toStop.longitude).toFixed(5)
      );
      if (rec?.encoded_polyline) {
        const coords = decodeGooglePolyline(rec.encoded_polyline);
        if (Array.isArray(coords) && coords.length > 1) {
          memoryCache.set(cacheKey, coords);
          try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (_) {}
          return coords;
        }
      }
    }
  } catch (e) {
    console.warn('[HERE][client] Offline polyline lookup failed', e);
  }

  // Check entity cache (DriverRoutePolyline) before hitting external APIs
  if (USE_ENTITY_LOOKUP) {
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
    console.debug('[HERE][client] Entity cache lookup', { found: !!rec, hasPolyline: !!rec?.encoded_polyline });
    if (rec?.encoded_polyline) {
      const coords = decodeGooglePolyline(rec.encoded_polyline);
      if (Array.isArray(coords) && coords.length > 1) {
        memoryCache.set(cacheKey, coords);
        try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (_) {}
        try { await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [rec]); } catch (_) {}
        return coords;
      }
    }
  } catch (e) {
    console.warn('Entity polyline lookup failed', e);
  }
  }

  // If we previously stored a hard error flag for this key, short-circuit for a bit to avoid hammering APIs
  const failKey = `${cacheKey}:fail_until`;
  try {
    const until = localStorage.getItem(failKey);
    if (until && Date.now() < Number(until)) {
      const ms = Number(until) - Date.now();
      console.warn('[HERE][client] Backoff active; skipping fetch', { cacheKey, msRemaining: ms });
      return null;
    }
  } catch (_) {}
  fetchingKeys.add(cacheKey);

  try {
    console.info('[HERE][client] Invoking getHereDirections', { cacheKey, origin: { lat: fromStop.latitude, lng: fromStop.longitude }, destination: { lat: toStop.latitude, lng: toStop.longitude } });
    const res = await base44.functions.invoke('getHereDirections', {
      origin: { lat: fromStop.latitude, lng: fromStop.longitude },
      destination: { lat: toStop.latitude, lng: toStop.longitude }
    });

    if (res.data && res.data.coordinates) {
      const coords = res.data.coordinates.map(p => [p.lat, p.lng]);
      console.info('[HERE][client] Received coordinates', { cacheKey, points: coords.length });
      memoryCache.set(cacheKey, coords);
      try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (e) { console.warn('Failed to save HERE polyline to localStorage', e); }
      try { localStorage.removeItem(failKey); } catch (_) {}

      ensurePolylineSubscription();

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
            const updated = await base44.entities.DriverRoutePolyline.update(existing[0].id, {
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString()
            });
            // Sync to offline DB as well
            const offlineRec = {
              ...(existing[0] || {}),
              ...(updated || {}),
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString()
            };
            await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [offlineRec]);
          } else {
            const created = await base44.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDateSafe,
              encoded_polyline: encoded,
              segment_origin_lat: rounded(fromStop.latitude),
              segment_origin_lon: rounded(fromStop.longitude),
              segment_dest_lat: rounded(toStop.latitude),
              segment_dest_lon: rounded(toStop.longitude),
              last_generated_at: new Date().toISOString()
            });
            // Save created record offline
            if (created) {
              await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [created]);
            }
          }
        }
      } catch (e) {
        console.warn('Failed to persist polyline entity', e);
      }

      fetchingKeys.delete(cacheKey);
      return coords;
    } else {
      // Google fallback disabled to avoid quota usage; keep dashed fallback if HERE returns nothing
    }

    // Google fallback disabled: use dashed straight line when HERE/Entity not available
  } catch (err) {
    console.error('[HERE][client] Failed to fetch polyline', { cacheKey, err: err?.message || err });
  }
  
  // Backoff 60s for this key on repeated failure
  try { localStorage.setItem(`${cacheKey}:fail_until`, String(Date.now() + 10000)); console.warn('[HERE][client] Set backoff', { cacheKey, ms: 10000 }); } catch (_) {}

  fetchingKeys.delete(cacheKey);
  return null;
};