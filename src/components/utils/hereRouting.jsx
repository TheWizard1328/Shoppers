import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const fetchingKeys = new Set();
const memoryCache = new Map();
const routeRequestTimestamps = new Map();
const inFlightPromises = new Map();
const apiKeySelectionState = {
  loaded: false,
  loading: null,
  selectedApiKey: 'HERE_API_KEY',
  lastLoadedAt: 0
};
const backoffCache = new Map();
const backoffNoticeCache = new Map();
const failureCache = new Map();
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

function buildSegmentKey(fromStop, toStop, mode = 'driving') {
  return `${String(mode)}_${round5(fromStop.latitude)}_${round5(fromStop.longitude)}_${round5(toStop.latitude)}_${round5(toStop.longitude)}`;
}

function buildDriverDateKey(driverId, deliveryDate) {
  return `${String(driverId || '')}|${String(deliveryDate || '')}`;
}

export async function ensureSelectedApiKeyLoaded() {
  const now = Date.now();
  if (apiKeySelectionState.loaded && now - apiKeySelectionState.lastLoadedAt < 300000) {
    return apiKeySelectionState.selectedApiKey;
  }
  if (apiKeySelectionState.loading) return apiKeySelectionState.loading;

  apiKeySelectionState.loading = (async () => {
    try {
      const appSettings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      apiKeySelectionState.selectedApiKey = appSettings?.[0]?.setting_value?.selected_api_key || apiKeySelectionState.selectedApiKey || 'HERE_API_KEY';
      apiKeySelectionState.loaded = true;
      apiKeySelectionState.lastLoadedAt = Date.now();
      return apiKeySelectionState.selectedApiKey;
    } catch (error) {
      console.warn('[HERE][client] Using cached API key selection after AppSettings rate limit/error', error?.message || error);
      apiKeySelectionState.loaded = true;
      apiKeySelectionState.lastLoadedAt = Date.now();
      return apiKeySelectionState.selectedApiKey || 'HERE_API_KEY';
    } finally {
      apiKeySelectionState.loading = null;
    }
  })();

  return apiKeySelectionState.loading;
}

export function getSelectedApiKeyName() {
  return apiKeySelectionState.selectedApiKey;
}

if (typeof window !== 'undefined') {
  window.addEventListener('app-settings-updated', (event) => {
    const selectedApiKey = event?.detail?.settings?.selected_api_key;
    if (selectedApiKey) {
      apiKeySelectionState.selectedApiKey = selectedApiKey;
      apiKeySelectionState.loaded = true;
      apiKeySelectionState.lastLoadedAt = Date.now();
    }
  });
}


const pendingPolylinePayloads = [];
let polylinePersistTimer = null;

async function flushPolylinePersists() {
  if (pendingPolylinePayloads.length === 0) return;
  const payloads = [...pendingPolylinePayloads];
  pendingPolylinePayloads.length = 0;

  try {
    const uniquePayloadsMap = new Map();
    for (const p of payloads) {
      const key = `${p.driver_id}_${p.delivery_date}_${p.segment_origin_lat}_${p.segment_origin_lon}_${p.segment_dest_lat}_${p.segment_dest_lon}`;
      uniquePayloadsMap.set(key, p);
    }

    const uniquePayloads = Array.from(uniquePayloadsMap.values());
    const deliveries = await base44.entities.Delivery.filter({}, '-updated_date', 50000).catch(() => []);

    await Promise.all(uniquePayloads.map(async (payload) => {
      const match = (deliveries || []).find((delivery) =>
        delivery?.driver_id === payload.driver_id &&
        delivery?.delivery_date === payload.delivery_date &&
        Number(delivery?.segment_origin_lat).toFixed(5) === Number(payload.segment_origin_lat).toFixed(5) &&
        Number(delivery?.segment_origin_lon).toFixed(5) === Number(payload.segment_origin_lon).toFixed(5) &&
        Number(delivery?.segment_dest_lat).toFixed(5) === Number(payload.segment_dest_lat).toFixed(5) &&
        Number(delivery?.segment_dest_lon).toFixed(5) === Number(payload.segment_dest_lon).toFixed(5)
      );

      if (!match?.id) return;

      await base44.entities.Delivery.update(match.id, {
        encoded_polyline: payload.encoded_polyline,
        transport_mode: payload.transport_mode,
        estimated_distance_km: payload.estimated_distance_km,
        estimated_duration_minutes: payload.estimated_duration_minutes,
        PolylineUpdated: true
      });
    }));
  } catch (err) {
    console.warn('[HERE][client] Bulk persist failed', err);
  }
}

async function persistGeneratedPolyline(driverId, deliveryDate, fromStop, toStop, coords, metadata = {}) {
  const transportMode = metadata.transport_mode || 'driving';
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
    last_generated_at: new Date().toISOString(),
    transport_mode: transportMode
  };

  pendingPolylinePayloads.push(payload);
  if (polylinePersistTimer) clearTimeout(polylinePersistTimer);
  polylinePersistTimer = setTimeout(flushPolylinePersists, 2000);

  try {
    window.dispatchEvent(new CustomEvent('polylineUpdated', {
      detail: {
        driverId,
        deliveryDate,
        key: `here_${transportMode}_${payload.segment_origin_lat.toFixed(5)}_${payload.segment_origin_lon.toFixed(5)}_${payload.segment_dest_lat.toFixed(5)}_${payload.segment_dest_lon.toFixed(5)}`,
        coords
      }
    }));
  } catch (_) {}

  return payload;
}

async function getDeliverySegmentPolyline(fromStop, toStop, deliveryDate = null, driverId = null, transportMode = 'driving') {
  if (!driverId || !deliveryDate) return null;

  const rows = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-updated_date', 50000).catch(() => []);
  const targetKey = buildSegmentKey(fromStop, toStop, transportMode);

  const record = (rows || []).find((row) => {
    if (!row?.encoded_polyline) return false;
    return buildSegmentKey(
      { latitude: row.segment_origin_lat, longitude: row.segment_origin_lon },
      { latitude: row.segment_dest_lat, longitude: row.segment_dest_lon },
      row.transport_mode || 'driving'
    ) === targetKey;
  });

  if (!record?.encoded_polyline) return null;

  const coords = decodeGooglePolyline(record.encoded_polyline);
  if (Array.isArray(coords) && coords.length > 1) return coords;

  const flexibleCoords = decodeHereFlexiblePolyline(record.encoded_polyline);
  return Array.isArray(flexibleCoords) && flexibleCoords.length > 1 ? flexibleCoords : null;
}

// Clear route cache for a specific segment
export function clearHereCacheForSegment(from, to, transportMode = null) {
  try {
    if (!from || !to) return;
    const modes = transportMode ? [transportMode] : ['driving', 'cycling', 'pedestrian'];
    modes.forEach((mode) => {
      const key = `here_${mode}_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
      try { memoryCache.delete(key); } catch (_) {}
      try { backoffCache.delete(`${key}:fail_until`); } catch (_) {}
      try { backoffNoticeCache.delete(key); } catch (_) {}
      try { localStorage.removeItem(key); } catch (_) {}
      try { localStorage.removeItem(`${key}:fail_until`); } catch (_) {}
    });
  } catch (_) {}
}

export async function clearHereCacheForDriverDate(driverId, deliveryDate) {
  try {
    const deliveries = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-updated_date', 50000).catch(() => []);
    (deliveries || []).forEach((delivery) => {
      if (delivery?.segment_origin_lat != null && delivery?.segment_origin_lon != null && delivery?.segment_dest_lat != null && delivery?.segment_dest_lon != null) {
        clearHereCacheForSegment(
          { latitude: delivery.segment_origin_lat, longitude: delivery.segment_origin_lon },
          { latitude: delivery.segment_dest_lat, longitude: delivery.segment_dest_lon },
          delivery.transport_mode || 'driving'
        );
      }
    });
  } catch (_) {}
}

export const ensurePolylineSubscription = () => {};

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
    const coords = data.coordinates
      .map((p) => [p.lat ?? p.latitude, p.lng ?? p.longitude])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (coords.length > 1) return coords;
  }

  if (Array.isArray(data?.sections) && data.sections.length > 0) {
    const mergedSectionCoords = [];
    data.sections.forEach((section) => {
      let sectionCoords = null;
      if (typeof section?.encoded_polyline === 'string' && section.encoded_polyline) {
        sectionCoords = decodeGooglePolyline(section.encoded_polyline);
      } else if (typeof section?.polyline === 'string' && section.polyline) {
        sectionCoords = decodeHereFlexiblePolyline(section.polyline);
      } else if (Array.isArray(section?.coordinates)) {
        sectionCoords = section.coordinates
          .map((p) => [p.lat ?? p.latitude, p.lng ?? p.longitude])
          .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      }

      if (!Array.isArray(sectionCoords) || sectionCoords.length < 2) return;
      if (mergedSectionCoords.length > 0) {
        const [lastLat, lastLng] = mergedSectionCoords[mergedSectionCoords.length - 1] || [];
        const [firstLat, firstLng] = sectionCoords[0] || [];
        if (lastLat === firstLat && lastLng === firstLng) {
          mergedSectionCoords.push(...sectionCoords.slice(1));
          return;
        }
      }
      mergedSectionCoords.push(...sectionCoords);
    });

    if (mergedSectionCoords.length > 1) return mergedSectionCoords;
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

    if (!__myRolesCache.roles || (now - __myRolesCache.ts) > 30000) {
      try {
        const mine = await base44.entities.AppUser.filter({ user_id: __meCache.id }, '-updated_date', 1);
        __myRolesCache.roles = (Array.isArray(mine) && mine[0]?.app_roles) || [];
      } catch (_) {
        __myRolesCache.roles = [];
      }
      __myRolesCache.ts = now;
    }

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

    const currentDeviceId = localStorage.getItem('rxdeliver_device_identifier');
    if (!currentDeviceId) return false;

    try {
      const devices = await base44.entities.UserDevice.filter({ user_id: __meCache.id, device_identifier: currentDeviceId });
      const currentDevice = Array.isArray(devices) ? devices[0] : null;
      return currentDevice?.is_primary_tracker === true;
    } catch (_) {
      return false;
    }
  } catch (_) {
    return false;
  }
}

export const getHerePolyline = async (driverId, fromStop, toStop, deliveryDate, transportMode = 'driving') => {
  if (!fromStop || !toStop) return null;
  await ensureSelectedApiKeyLoaded();
  // Normalize coords to numbers (tablet sometimes sends strings)
  fromStop = { latitude: Number(fromStop.latitude), longitude: Number(fromStop.longitude) };
  toStop = { latitude: Number(toStop.latitude), longitude: Number(toStop.longitude) };
  if ([fromStop.latitude, fromStop.longitude, toStop.latitude, toStop.longitude].some((n) => Number.isNaN(n))) return null;

  // Skip HERE call for zero-distance legs
  const samePoint = Math.abs(fromStop.latitude - toStop.latitude) < 1e-5 && Math.abs(fromStop.longitude - toStop.longitude) < 1e-5;
  if (samePoint) {
    return null;
  }

  const cacheKey = `here_${transportMode}_${fromStop.latitude.toFixed(5)}_${fromStop.longitude.toFixed(5)}_${toStop.latitude.toFixed(5)}_${toStop.longitude.toFixed(5)}`;
  console.debug('[HERE][client] Cache key', { cacheKey, driverId, deliveryDate });
  const recentFailure = failureCache.get(cacheKey);
  if (recentFailure && Date.now() - recentFailure < 300000) {
    return null;
  }
  const lastRequestedAt = routeRequestTimestamps.get(cacheKey) || 0;
  if (Date.now() - lastRequestedAt < 120000) {
    return memoryCache.get(cacheKey) || null;
  }
  routeRequestTimestamps.set(cacheKey, Date.now());
  // Ensure we are subscribed to entity changes so non-primary devices get updates
  ensurePolylineSubscription();

  // Check memory cache
  if (memoryCache.has(cacheKey)) {
    const hit = memoryCache.get(cacheKey);
    console.debug('[HERE][client] Memory cache hit', { cacheKey, points: hit?.length });
    return hit;
  }

  // Early in-flight dedupe to prevent burst duplicates after cache purges
  if (inFlightPromises.has(cacheKey)) {
    console.debug('[HERE][client] Awaiting in-flight (early)', { cacheKey });
    return inFlightPromises.get(cacheKey);
  }
  // Mark as in-flight before any DB/entity lookups to collapse concurrent callers
  if (!fetchingKeys.has(cacheKey)) fetchingKeys.add(cacheKey);

  // in-flight dedupe handled earlier above (no-op here)

  // Try Delivery entity first, and only then consider HERE.
  const requestPromise = (async () => {
    try {
      const deliveryCoords = await getDeliverySegmentPolyline(fromStop, toStop, deliveryDate, driverId, transportMode);
      if (deliveryCoords) {
        memoryCache.set(cacheKey, deliveryCoords);
        return deliveryCoords;
      }
    } catch (e) {
      console.warn('[HERE][client] Delivery polyline lookup failed', e);
    }

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
        return null;
      }
    } catch (_) {}

    let __lockId = null;
    if (USE_CROSS_DEVICE_LOCK) {
      // Client-side entity locks removed to avoid extra Base44 traffic; fetchingKeys already dedupes in-flight requests in this session.
    }

    try {
      console.info('[HERE][client] Invoking getHereDirections', { cacheKey, origin: { lat: fromStop.latitude, lng: fromStop.longitude }, destination: { lat: toStop.latitude, lng: toStop.longitude } });
      const res = await base44.functions.invoke('getHereDirections', {
        origin: { lat: fromStop.latitude, lng: fromStop.longitude },
        destination: { lat: toStop.latitude, lng: toStop.longitude },
        caller: 'client_polyline_generation',
        caller_context: {
          driverId,
          deliveryDate,
          transportMode
        }
      });

      const coords = decodeRouteGeometry(res?.data);

      if (coords) {
        console.info('[HERE][client] Route OK', { cacheKey, points: coords.length, shape: res?.data?.polyline_format === 'flexible' ? 'here-polyline' : Array.isArray(res?.data?.coordinates) ? 'coordinates' : 'polyline' });
        memoryCache.set(cacheKey, coords);
        try { backoffCache.delete(failKey); } catch (_) {}
        try { backoffNoticeCache.delete(cacheKey); } catch (_) {}
        try { failureCache.delete(cacheKey); } catch (_) {}

        ensurePolylineSubscription();

        if (driverId && deliveryDate) {
          try {
            await persistGeneratedPolyline(driverId, deliveryDate, fromStop, toStop, coords, {
              estimated_distance_km: res?.data?.estimated_distance_km ?? null,
              estimated_duration_minutes: res?.data?.estimated_duration_minutes ?? null,
              transport_mode: transportMode
            });
          } catch (persistError) {
            console.warn('[HERE][client] Persist generated polyline failed', { cacheKey, error: persistError?.message || persistError });
          }
        }

        return coords;
      }
    } catch (err) {
      console.warn('[HERE][client] HERE fetch failed', { cacheKey, err: err?.message || err });
    } finally {
      try { if (__lockId) { await base44.entities.AppSettings.delete(__lockId); __lockId = null; } } catch (_) {}
    }
    
    try {
      backoffCache.set(`${cacheKey}:fail_until`, Date.now() + 300000);
      backoffNoticeCache.set(cacheKey, Date.now());
      failureCache.set(cacheKey, Date.now());
      console.info('[HERE][client] Set backoff fallback window', { cacheKey, ms: 300000 });
    } catch (_) {}

    return null;
  })();

  inFlightPromises.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inFlightPromises.delete(cacheKey);
    fetchingKeys.delete(cacheKey);
  }
};

export const getHereEncodedPolyline = async (driverId, fromStop, toStop, deliveryDate, transportMode = 'driving', _waypoints = []) => {
  const coords = await getHerePolyline(driverId, fromStop, toStop, deliveryDate, transportMode);
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const encoded = encodeGooglePolyline(coords);
  return encoded || null;
};