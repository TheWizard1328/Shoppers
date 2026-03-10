import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const fetchingKeys = new Set();
const memoryCache = new Map();
const USE_ENTITY_LOOKUP = false;
const USE_CROSS_DEVICE_LOCK = false;

// If the online entity has been purged, avoid rehydrating from stale localStorage keys
export function clearHereCacheForSegment(from, to) {
  try {
    if (!from || !to) return;
    const key = `here_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
    try { memoryCache.delete(key); } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
    try { localStorage.removeItem(`${key}:fail_until`); } catch (_) {}
  } catch (_) {}
}

let polylineSubscribed = false;
export const ensurePolylineSubscription = () => {
  if (polylineSubscribed) return;
  polylineSubscribed = true;
  try {
    const unsubscribe = base44.entities.DriverRoutePolyline.subscribe(async (event) => {
      try {
        if (event.type === 'delete') {
          let deletedRecord = null;
          try {
            const allRows = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);
            deletedRecord = (allRows || []).find((row) => row?.id === event.id) || null;
          } catch (_) {}
          if (deletedRecord?.segment_origin_lat != null && deletedRecord?.segment_origin_lon != null && deletedRecord?.segment_dest_lat != null && deletedRecord?.segment_dest_lon != null) {
            clearHereCacheForSegment(
              { latitude: deletedRecord.segment_origin_lat, longitude: deletedRecord.segment_origin_lon },
              { latitude: deletedRecord.segment_dest_lat, longitude: deletedRecord.segment_dest_lon }
            );
          }
          await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, event.id);
        } else if (event.data) {
          const rec = event.data;
          await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [rec]);
          // Also clear any stale localStorage key for the same segment before re-saving
          try {
            if (rec.segment_origin_lat != null && rec.segment_origin_lon != null && rec.segment_dest_lat != null && rec.segment_dest_lon != null) {
              const key = `here_${Number(rec.segment_origin_lat).toFixed(5)}_${Number(rec.segment_origin_lon).toFixed(5)}_${Number(rec.segment_dest_lat).toFixed(5)}_${Number(rec.segment_dest_lon).toFixed(5)}`;
              try { localStorage.removeItem(`${key}:fail_until`); } catch (_) {}
            }
          } catch (_) {}
          // Offline de-dup for same segment (keep latest by updated_date/last_generated_at)
          try {
            const rounded = (n) => Number(Number(n).toFixed(5));
            const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date,', rec.delivery_date);
          } catch(_) {}
          try {
            const rounded = (n) => Number(Number(n).toFixed(5));
            const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', rec.delivery_date);
            const same = (rows || []).filter(r => r.driver_id === rec.driver_id &&
              Number(r.segment_origin_lat)?.toFixed(5) === rounded(rec.segment_origin_lat).toFixed(5) &&
              Number(r.segment_origin_lon)?.toFixed(5) === rounded(rec.segment_origin_lon).toFixed(5) &&
              Number(r.segment_dest_lat)?.toFixed(5) === rounded(rec.segment_dest_lat).toFixed(5) &&
              Number(r.segment_dest_lon)?.toFixed(5) === rounded(rec.segment_dest_lon).toFixed(5)
            );
            if (same.length > 1) {
              const pick = same.reduce((best, cur) => {
                const bt = new Date(best.updated_date || best.last_generated_at || 0).getTime();
                const ct = new Date(cur.updated_date || cur.last_generated_at || 0).getTime();
                return ct > bt ? cur : best;
              });
              for (const row of same) {
                if (row.id !== pick.id) {
                  await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, row.id);
                }
              }
            }
          } catch(_) {}
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

const HERE_POLYLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split('').reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];

  const values = [];
  let current = 0;
  let shift = 0;

  for (const char of encoded) {
    const value = HERE_POLYLINE_DECODER[char];
    if (value == null) return [];
    current |= (value & 0x1f) << shift;
    if (value & 0x20) {
      shift += 5;
      continue;
    }
    values.push(current);
    current = 0;
    shift = 0;
  }

  if (shift > 0 || values.length < 2) return [];

  const version = values[0];
  if (version !== 1) return [];

  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;

  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));

  let latitude = 0;
  let longitude = 0;
  let z = 0;
  const coordinates = [];

  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) {
      z += toSigned(values[i + 2]);
    }
    coordinates.push([latitude / factor, longitude / factor]);
  }

  return coordinates;
}

function mergeDecodedPolylines(polylines, decoder) {
  if (!Array.isArray(polylines)) return null;
  const merged = [];

  for (const polyline of polylines) {
    const decoded = decoder(polyline);
    if (!decoded.length) continue;

    if (merged.length && merged[merged.length - 1][0] === decoded[0][0] && merged[merged.length - 1][1] === decoded[0][1]) {
      merged.push(...decoded.slice(1));
    } else {
      merged.push(...decoded);
    }
  }

  return merged.length > 1 ? merged : null;
}

function decodeRouteGeometry(data) {
  if (Array.isArray(data?.coordinates)) {
    const coords = data.coordinates.map((p) => [p.lat ?? p.latitude, p.lng ?? p.longitude]);
    return coords.length > 1 ? coords : null;
  }

  if (data?.polyline_format === 'flexible') {
    const mergedHere = mergeDecodedPolylines(data?.polylines, decodeHereFlexiblePolyline);
    if (mergedHere) return mergedHere;

    const singleHere = typeof data?.polyline === 'string' ? decodeHereFlexiblePolyline(data.polyline) : null;
    return singleHere && singleHere.length > 1 ? singleHere : null;
  }

  const googlePolyline = typeof data?.polyline === 'string' ? decodeGooglePolyline(data.polyline) : null;
  return googlePolyline && googlePolyline.length > 1 ? googlePolyline : null;
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

// Primary device gate for HERE polyline generation
// DEPRECATED: primary-device restriction removed
let __meCache = { id: null, ts: 0 };
let __myRolesCache = { roles: null, ts: 0 };
async function canGenerateForDriver(driverId) {
  try {
    const now = Date.now();
    // Cache current user
    if (!__meCache.id || (now - __meCache.ts) > 30000) {
      const me = await base44.auth.me();
      __meCache.id = me?.id || null;
      __meCache.ts = now;
    }
    if (!__meCache.id) return false;

    // Allow admins/dispatchers to generate polylines (useful from Dashboard)
    if (!__myRolesCache.roles || (now - __myRolesCache.ts) > 30000) {
      try {
        const mine = await base44.entities.AppUser.filter({ user_id: __meCache.id }, '-updated_date', 1);
        __myRolesCache.roles = (Array.isArray(mine) && mine[0]?.app_roles) || [];
      } catch (_) {
        __myRolesCache.roles = [];
      }
      __myRolesCache.ts = now;
    }
    const isAdminDispatcher = (__myRolesCache.roles || []).some((r) => r === 'admin' || r === 'dispatcher');
    if (isAdminDispatcher) return true;

    // Driver self-generation: driverId may be AppUser.id → map to user_id
    let allowedByDriver = false;
    if (driverId && driverId === __meCache.id) {
      allowedByDriver = true;
    } else if (driverId) {
      try {
        const recs = await base44.entities.AppUser.filter({ id: driverId }, '-updated_date', 1);
        const appUser = Array.isArray(recs) ? recs[0] : null;
        if (appUser?.user_id && appUser.user_id === __meCache.id) allowedByDriver = true;
      } catch (_) {}
    }
    if (!allowedByDriver) return false;

    // Primary device check removed; any authenticated owner (driver/admin/dispatcher) may generate
    return true;
  } catch (_) {
    return false;
  }
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
  // Ensure we are subscribed to entity changes so non-primary devices get updates
  ensurePolylineSubscription();

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

  // Early in-flight dedupe to prevent burst duplicates after cache purges
  if (fetchingKeys.has(cacheKey)) {
    console.debug('[HERE][client] Awaiting in-flight (early)', { cacheKey });
    return await new Promise((resolve) => {
      let waited = 0;
      const iv = setInterval(() => {
        if (memoryCache.has(cacheKey)) { clearInterval(iv); resolve(memoryCache.get(cacheKey)); return; }
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) { clearInterval(iv); resolve(JSON.parse(cached)); return; }
        } catch (_) {}
        if (!fetchingKeys.has(cacheKey) || waited > 6000) { clearInterval(iv); resolve(null); }
        waited += 150;
      }, 150);
    });
  }
  // Mark as in-flight before any DB/entity lookups to collapse concurrent callers
  if (!fetchingKeys.has(cacheKey)) fetchingKeys.add(cacheKey);

  // in-flight dedupe handled earlier above (no-op here)

  // Try offline DB cache before hitting network/entity (indexed by delivery_date for speed)
  try {
    const rounded = (n) => Number(n.toFixed(5));
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = formatter.formatToParts(new Date());
    const todayStr = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
    const deliveryDateSafe = deliveryDate || todayStr;

    // Enforce today-only policy: if requesting a non-today date, skip offline/entity hydration
    if (deliveryDateSafe !== todayStr) {
      // Clear any stale cache to avoid ghost lines
      try { localStorage.removeItem(cacheKey); } catch (_) {}
    } else {
      const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDateSafe);
      if (Array.isArray(rows) && rows.length) {
        const rec = rows.find(r => r.driver_id === driverId &&
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
    }
  } catch (e) {
    console.warn('[HERE][client] Offline polyline lookup failed', e);
  }

  // Check entity cache (DriverRoutePolyline) before hitting external APIs
  if (USE_ENTITY_LOOKUP) {
  try {
    const rounded = (n) => Number(n.toFixed(5));
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
const parts = formatter.formatToParts(new Date());
const todayStr = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
const deliveryDateSafe = deliveryDate || todayStr;
    if (deliveryDateSafe !== todayStr) {
      // Today-only policy: do not hydrate from entity for past days; also clear any cached coords
      try { localStorage.removeItem(cacheKey); } catch (_) {}
    } else {
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

  let __lockId = null;
  if (USE_CROSS_DEVICE_LOCK) {
    try {
      const lockKey = `polylock:${cacheKey}`;
      const now = Date.now();
      let existing = null;
      try {
        const locks = await base44.entities.AppSettings.filter({ setting_key: lockKey }, '-updated_date', 1);
        existing = Array.isArray(locks) ? locks[0] : null;
      } catch (_) {}
      const existingExpires = existing?.setting_value?.expires_at ? new Date(existing.setting_value.expires_at).getTime() : 0;
      const notExpired = existing && existingExpires > now;

      if (notExpired) {
        fetchingKeys.delete(cacheKey);
        return await new Promise((resolve) => {
          let waited = 0;
          const iv = setInterval(() => {
            if (memoryCache.has(cacheKey)) { clearInterval(iv); resolve(memoryCache.get(cacheKey)); return; }
            try {
              const cached = localStorage.getItem(cacheKey);
              if (cached) { clearInterval(iv); resolve(JSON.parse(cached)); return; }
            } catch (_) {}
            if (waited >= 6000) { clearInterval(iv); resolve(null); return; }
            waited += 150;
          }, 150);
        });
      }

      try {
        const me = await base44.auth.me().catch(()=>null);
        const newExpires = new Date(now + 12000).toISOString();
        if (existing) {
          await base44.entities.AppSettings.update(existing.id, { setting_value: { ...(existing.setting_value || {}), owner: me?.id || 'anon', expires_at: newExpires }, description: 'HERE polyline generation lock' });
          __lockId = existing.id;
        } else {
          const created = await base44.entities.AppSettings.create({ setting_key: lockKey, setting_value: { owner: me?.id || 'anon', created_at: new Date(now).toISOString(), expires_at: newExpires }, description: 'HERE polyline generation lock' });
          __lockId = created?.id;
        }
      } catch (_) {}
    } catch (_) {}
  }

  try {
    console.info('[HERE][client] Invoking getHereDirections', { cacheKey, origin: { lat: fromStop.latitude, lng: fromStop.longitude }, destination: { lat: toStop.latitude, lng: toStop.longitude } });
    const res = await base44.functions.invoke('getHereDirections', {
      origin: { lat: fromStop.latitude, lng: fromStop.longitude },
      destination: { lat: toStop.latitude, lng: toStop.longitude }
    });

    const coords = decodeRouteGeometry(res?.data);

    if (coords) {
      console.info('[HERE][client] Route OK', { cacheKey, points: coords.length, shape: res?.data?.polyline_format === 'flexible' ? 'here-polyline' : Array.isArray(res?.data?.coordinates) ? 'coordinates' : 'polyline' });
      memoryCache.set(cacheKey, coords);
      try { localStorage.setItem(cacheKey, JSON.stringify(coords)); } catch (e) { console.warn('Failed to save HERE polyline to localStorage', e); }
      try { localStorage.removeItem(failKey); } catch (_) {}

      ensurePolylineSubscription();

      // Persist to DriverRoutePolyline entity for future reuse
      // Strong server-side de-dupe: re-check right before persisting to avoid burst duplicates

      try {
        const rounded = (n) => Number(n.toFixed(5));
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
const parts = formatter.formatToParts(new Date());
const todayStr = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
const deliveryDateSafe = deliveryDate || todayStr;
        const encoded = encodeGooglePolyline(coords);
        if (encoded && typeof encoded === 'string') {
          const matches = await base44.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: deliveryDateSafe,
            segment_origin_lat: rounded(fromStop.latitude),
            segment_origin_lon: rounded(fromStop.longitude),
            segment_dest_lat: rounded(toStop.latitude),
            segment_dest_lon: rounded(toStop.longitude)
          }, '-updated_date');

          if (Array.isArray(matches) && matches.length) {
            // Pick canonical record (prefer most recent timestamp)
            const canonical = matches.reduce((best, cur) => {
              const bt = new Date(best.updated_date || best.last_generated_at || 0).getTime();
              const ct = new Date(cur.updated_date || cur.last_generated_at || 0).getTime();
              return ct > bt ? cur : best;
            });

            // Update canonical with fresh data
            const updated = await base44.entities.DriverRoutePolyline.update(canonical.id, {
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString(),
              estimated_distance_km: res?.data?.estimated_distance_km,
              estimated_duration_minutes: res?.data?.estimated_duration_minutes
            });

            // Try to remove server-side duplicates (best-effort)
            for (const m of matches) {
              if (m.id !== canonical.id) {
                try { await base44.entities.DriverRoutePolyline.delete(m.id); } catch(_) {}
              }
            }

            // Save canonical offline and clean offline duplicates
            const offlineRec = { ...(canonical || {}), ...(updated || {}), encoded_polyline: encoded,
              last_generated_at: new Date().toISOString(),
              estimated_distance_km: res?.data?.estimated_distance_km,
              estimated_duration_minutes: res?.data?.estimated_duration_minutes };
            await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [offlineRec]);
            try {
              const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDateSafe);
              const same = (rows || []).filter(r => r.driver_id === driverId &&
                Number(r.segment_origin_lat)?.toFixed(5) === rounded(fromStop.latitude).toFixed(5) &&
                Number(r.segment_origin_lon)?.toFixed(5) === rounded(fromStop.longitude).toFixed(5) &&
                Number(r.segment_dest_lat)?.toFixed(5) === rounded(toStop.latitude).toFixed(5) &&
                Number(r.segment_dest_lon)?.toFixed(5) === rounded(toStop.longitude).toFixed(5)
              );
              if (same.length > 1) {
                const pick = same.reduce((best, cur) => {
                  const bt = new Date(best.updated_date || best.last_generated_at || 0).getTime();
                  const ct = new Date(cur.updated_date || cur.last_generated_at || 0).getTime();
                  return ct > bt ? cur : best;
                });
                for (const row of same) { if (row.id !== pick.id) { await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, row.id); } }
              }
            } catch(_) {}
          } else {
            const created = await base44.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDateSafe,
              encoded_polyline: encoded,
              segment_origin_lat: rounded(fromStop.latitude),
              segment_origin_lon: rounded(fromStop.longitude),
              segment_dest_lat: rounded(toStop.latitude),
              segment_dest_lon: rounded(toStop.longitude),
              last_generated_at: new Date().toISOString(),
              estimated_distance_km: res?.data?.estimated_distance_km,
              estimated_duration_minutes: res?.data?.estimated_duration_minutes
            });
            if (created) {
              await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [created]);
              // Post-create double-check for accidental duplicates and remove them
              try {
                const again = await base44.entities.DriverRoutePolyline.filter({
                  driver_id: driverId,
                  delivery_date: deliveryDateSafe,
                  segment_origin_lat: rounded(fromStop.latitude),
                  segment_origin_lon: rounded(fromStop.longitude),
                  segment_dest_lat: rounded(toStop.latitude),
                  segment_dest_lon: rounded(toStop.longitude)
                }, '-updated_date');
                for (const m of again || []) { if (m.id !== created.id) { try { await base44.entities.DriverRoutePolyline.delete(m.id); } catch(_) {} } }
                const rows2 = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDateSafe);
                const same2 = (rows2 || []).filter(r => r.driver_id === driverId &&
                  Number(r.segment_origin_lat)?.toFixed(5) === rounded(fromStop.latitude).toFixed(5) &&
                  Number(r.segment_origin_lon)?.toFixed(5) === rounded(fromStop.longitude).toFixed(5) &&
                  Number(r.segment_dest_lat)?.toFixed(5) === rounded(toStop.latitude).toFixed(5) &&
                  Number(r.segment_dest_lon)?.toFixed(5) === rounded(toStop.longitude).toFixed(5)
                );
                if (same2.length > 1) {
                  for (const row of same2) { if (row.id !== created.id) { await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, row.id); } }
                }
              } catch(_) {}
            }
          }
        }
      } catch (e) {
        console.warn('Failed to persist polyline entity', e);
      }

      // Clear lock after success
      try { if (__lockId) { await base44.entities.AppSettings.delete(__lockId); __lockId = null; } } catch (_) {}
      fetchingKeys.delete(cacheKey);
      return coords;
    } else {
      // Keep dashed fallback if HERE returns nothing
    }

  } catch (err) {
    console.warn('[HERE][client] HERE fetch failed', { cacheKey, err: err?.message || err });
  } finally {
    // Ensure lock is cleared on error/timeout
    try { if (__lockId) { await base44.entities.AppSettings.delete(__lockId); __lockId = null; } } catch (_) {}
  }
  
  // Backoff 10s for this key on failure
  try { localStorage.setItem(`${cacheKey}:fail_until`, String(Date.now() + 10000)); console.warn('[HERE][client] Set backoff', { cacheKey, ms: 10000 }); } catch (_) {}

  fetchingKeys.delete(cacheKey);
  return null;
};