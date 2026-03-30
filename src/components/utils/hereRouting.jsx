import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const fetchingKeys = new Set();
const memoryCache = new Map();
const backoffCache = new Map();
const backoffNoticeCache = new Map();
const polylineDateSyncInflight = new Map();
const polylineDateSyncCache = new Map();
const USE_CROSS_DEVICE_LOCK = false;

function clearLegacyHereLocalStorageCache() {
  try {
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('here_')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (_) {}
}

clearLegacyHereLocalStorageCache();

function round5(value) {
  return Number(Number(value).toFixed(5));
}

function buildSegmentKey(fromStop, toStop) {
  return `${round5(fromStop.latitude)}_${round5(fromStop.longitude)}_${round5(toStop.latitude)}_${round5(toStop.longitude)}`;
}

function buildDriverDateKey(driverId, deliveryDate) {
  return `${String(driverId || '')}|${String(deliveryDate || '')}`;
}

export async function syncDriverRoutePolylinesForDate(driverId, deliveryDate, force = false) {
  if (!driverId || !deliveryDate) return [];

  const syncKey = buildDriverDateKey(driverId, deliveryDate);
  if (!force) {
    const lastSyncedAt = polylineDateSyncCache.get(syncKey) || 0;
    if (Date.now() - lastSyncedAt < 15000) return [];
  }

  if (polylineDateSyncInflight.has(syncKey)) {
    return polylineDateSyncInflight.get(syncKey);
  }

  const promise = (async () => {
    try {
      const rows = await base44.entities.DriverRoutePolyline.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, '-updated_date', 5000);

      if (Array.isArray(rows) && rows.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, rows);
        await offlineDB.deduplicateDriverRoutePolylines(deliveryDate);
      }

      polylineDateSyncCache.set(syncKey, Date.now());
      return rows || [];
    } catch (error) {
      console.warn('[HERE][client] DriverRoutePolyline date sync failed', { driverId, deliveryDate, error: error?.message || error });
      return [];
    } finally {
      polylineDateSyncInflight.delete(syncKey);
    }
  })();

  polylineDateSyncInflight.set(syncKey, promise);
  return promise;
}

const pendingPolylinePayloads = [];
let polylinePersistTimer = null;

async function flushPolylinePersists() {
  if (pendingPolylinePayloads.length === 0) return;
  const payloads = [...pendingPolylinePayloads];
  pendingPolylinePayloads.length = 0;
  
  try {
    // Deduplicate payloads by segment
    const uniquePayloadsMap = new Map();
    for (const p of payloads) {
      const key = `${p.driver_id}_${p.delivery_date}_${p.segment_origin_lat}_${p.segment_origin_lon}_${p.segment_dest_lat}_${p.segment_dest_lon}`;
      uniquePayloadsMap.set(key, p);
    }
    const uniquePayloads = Array.from(uniquePayloadsMap.values());
    
    if (uniquePayloads.length > 0) {
      const created = await base44.entities.DriverRoutePolyline.bulkCreate(uniquePayloads);
      if (Array.isArray(created) && created.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, created);
      }
    }
  } catch (err) {
    console.warn('[HERE][client] Bulk persist failed', err);
  }
}

async function persistGeneratedPolyline(driverId, deliveryDate, fromStop, toStop, coords, metadata = {}) {
  if (!driverId || !deliveryDate || !Array.isArray(coords) || coords.length < 2) return null;

  const payload = {
    driver_id: driverId,
    delivery_date: deliveryDate,
    encoded_polyline: encodeGooglePolyline(coords),
    segment_origin_lat: round5(fromStop.latitude),
    segment_origin_lon: round5(fromStop.longitude),
    segment_dest_lat: round5(toStop.latitude),
    segment_dest_lon: round5(toStop.longitude),
    estimated_distance_km: metadata.estimated_distance_km ?? null,
    estimated_duration_minutes: metadata.estimated_duration_minutes ?? null,
    last_generated_at: new Date().toISOString()
  };

  // Save to offline DB immediately for local use
  const tempRecord = {
    ...payload,
    id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString()
  };
  
  await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [tempRecord]);
  await offlineDB.deduplicateDriverRoutePolylines(deliveryDate);
  polylineDateSyncCache.set(buildDriverDateKey(driverId, deliveryDate), Date.now());

  try {
    window.dispatchEvent(new CustomEvent('polylineUpdated', {
      detail: {
        driverId,
        deliveryDate,
        key: `here_${payload.segment_origin_lat.toFixed(5)}_${payload.segment_origin_lon.toFixed(5)}_${payload.segment_dest_lat.toFixed(5)}_${payload.segment_dest_lon.toFixed(5)}`
      }
    }));
  } catch (_) {}

  // Check if we already have a real backend record for this segment in offlineDB
  try {
    const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDate);
    const existing = (rows || []).filter(r => 
      r.driver_id === driverId &&
      r.segment_origin_lat === payload.segment_origin_lat &&
      r.segment_origin_lon === payload.segment_origin_lon &&
      r.segment_dest_lat === payload.segment_dest_lat &&
      r.segment_dest_lon === payload.segment_dest_lon &&
      r.id && !r.id.startsWith('temp_')
    );

    if (existing.length === 0) {
      pendingPolylinePayloads.push(payload);
      if (polylinePersistTimer) clearTimeout(polylinePersistTimer);
      polylinePersistTimer = setTimeout(flushPolylinePersists, 2000);
    }
  } catch (err) {
    // Fallback to queueing if offlineDB read fails
    pendingPolylinePayloads.push(payload);
    if (polylinePersistTimer) clearTimeout(polylinePersistTimer);
    polylinePersistTimer = setTimeout(flushPolylinePersists, 2000);
  }

  return tempRecord;
}

function findLatestExactOfflineSegment(rows, fromStop, toStop) {
  const targetKey = buildSegmentKey(fromStop, toStop);
  return (rows || [])
    .filter((row) => row?.encoded_polyline && `${round5(row.segment_origin_lat)}_${round5(row.segment_origin_lon)}_${round5(row.segment_dest_lat)}_${round5(row.segment_dest_lon)}` === targetKey)
    .sort((a, b) => new Date(b.last_generated_at || b.updated_date || 0).getTime() - new Date(a.last_generated_at || a.updated_date || 0).getTime())[0] || null;
}

async function getOfflineSegmentPolyline(fromStop, toStop, deliveryDate = null) {
  const rows = deliveryDate
    ? await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDate)
    : await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);

  const record = findLatestExactOfflineSegment(rows, fromStop, toStop);
  if (!record?.encoded_polyline) return null;

  const coords = decodeGooglePolyline(record.encoded_polyline);
  return Array.isArray(coords) && coords.length > 1 ? coords : null;
}

// Clear route cache for a specific segment
export function clearHereCacheForSegment(from, to) {
  try {
    if (!from || !to) return;
    const key = `here_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
    try { memoryCache.delete(key); } catch (_) {}
    try { backoffCache.delete(`${key}:fail_until`); } catch (_) {}
    try { backoffNoticeCache.delete(key); } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
    try { localStorage.removeItem(`${key}:fail_until`); } catch (_) {}
  } catch (_) {}
}

export async function clearHereCacheForDriverDate(driverId, deliveryDate) {
  try {
    const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDate);
    const matches = (rows || []).filter((row) => row?.driver_id === driverId);

    for (const row of matches) {
      clearHereCacheForSegment(
        { latitude: row.segment_origin_lat, longitude: row.segment_origin_lon },
        { latitude: row.segment_dest_lat, longitude: row.segment_dest_lon }
      );
      try { await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, row.id); } catch (_) {}
    }

    polylineDateSyncCache.delete(buildDriverDateKey(driverId, deliveryDate));
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
              try { backoffCache.delete(`${key}:fail_until`); } catch (_) {}
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
export function encodeGooglePolyline(points) {
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


  // Early in-flight dedupe to prevent burst duplicates after cache purges
  if (fetchingKeys.has(cacheKey)) {
    console.debug('[HERE][client] Awaiting in-flight (early)', { cacheKey });
    return await new Promise((resolve) => {
      let waited = 0;
      const iv = setInterval(() => {
        if (memoryCache.has(cacheKey)) { clearInterval(iv); resolve(memoryCache.get(cacheKey)); return; }
        if (!fetchingKeys.has(cacheKey) || waited > 6000) { clearInterval(iv); resolve(null); }
        waited += 150;
      }, 150);
    });
  }
  // Mark as in-flight before any DB/entity lookups to collapse concurrent callers
  if (!fetchingKeys.has(cacheKey)) fetchingKeys.add(cacheKey);

  // in-flight dedupe handled earlier above (no-op here)

  // Try offline DB cache first; only use HERE for missing segments.
  try {
    const coords = await getOfflineSegmentPolyline(fromStop, toStop, deliveryDate);
    if (coords) {
      memoryCache.set(cacheKey, coords);
      fetchingKeys.delete(cacheKey);
      return coords;
    }
  } catch (e) {
    console.warn('[HERE][client] Offline polyline lookup failed', e);
  }

  // If we previously stored a hard error flag for this key, short-circuit for a bit to avoid hammering APIs
  const failKey = `${cacheKey}:fail_until`;
  try {
    const until = backoffCache.get(failKey);
    if (until && Date.now() < Number(until)) {
      const ms = Number(until) - Date.now();
      const lastNotice = backoffNoticeCache.get(cacheKey) || 0;
      if (Date.now() - lastNotice > 10000) {
        console.info('[HERE][client] Backoff active; using fallback line', { cacheKey, msRemaining: ms });
        backoffNoticeCache.set(cacheKey, Date.now());
      }
      fetchingKeys.delete(cacheKey);
      return null;
    }
  } catch (_) {}
  fetchingKeys.add(cacheKey);

  let __lockId = null;
  if (USE_CROSS_DEVICE_LOCK) {
    // Client-side entity locks removed to avoid extra Base44 traffic; fetchingKeys already dedupes in-flight requests in this session.
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
      try { backoffCache.delete(failKey); } catch (_) {}
      try { backoffNoticeCache.delete(cacheKey); } catch (_) {}

      ensurePolylineSubscription();

      if (driverId && deliveryDate && await canGenerateForDriver(driverId)) {
        try {
          await persistGeneratedPolyline(driverId, deliveryDate, fromStop, toStop, coords, {
            estimated_distance_km: res?.data?.estimated_distance_km ?? null,
            estimated_duration_minutes: res?.data?.estimated_duration_minutes ?? null
          });
        } catch (persistError) {
          console.warn('[HERE][client] Persist generated polyline failed', { cacheKey, error: persistError?.message || persistError });
        }
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
  try {
    backoffCache.set(`${cacheKey}:fail_until`, Date.now() + 10000);
    backoffNoticeCache.set(cacheKey, Date.now());
    console.info('[HERE][client] Set backoff fallback window', { cacheKey, ms: 10000 });
  } catch (_) {}

  fetchingKeys.delete(cacheKey);
  return null;
};

export const getHereEncodedPolyline = async (driverId, fromStop, toStop, deliveryDate) => {
  const coords = await getHerePolyline(driverId, fromStop, toStop, deliveryDate);
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const encoded = encodeGooglePolyline(coords);
  return encoded || null;
};