import { base44 } from '@/api/base44Client';
/**
 * clientRouteEngine.js
 *
 * Client-side route optimization + polyline generation engine.
 * Ports the core logic from backend functions `optimizeRemainingStops`,
 * `regenerateType1Polyline`, and `getHereDirections` into a single
 * framework-free module that runs in the browser.
 *
 * This eliminates the race condition where the backend optimizer reads
 * stale data before client-side writes have settled: the engine operates
 * on the fresh in-memory data that the device just wrote, then the caller
 * pushes the results to the backend DB for other viewers.
 *
 * Usage:
 *   const result = await optimizeRouteClientSide({
 *     deliveries, patients, stores, appUsers,
 *     driverId, deliveryDate, hereApiKey,
 *     currentLocation: { lat, lon },
 *     source: 'reoptimize_fab',
 *   });
 *   // result.orderedDeliveryIds, result.optimizedRoute, result.writeBatch
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
const LAST_FINISHED_STOP_PROXIMITY_KM = 0.25;
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

// ─── HERE Flexible Polyline decode ───────────────────────────────────────────

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
    if (value & 0x20) { shift += 5; continue; }
    values.push(current);
    current = 0;
    shift = 0;
  }
  if (shift > 0 || values.length < 2) return [];
  if (values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));
  let latitude = 0, longitude = 0, third = 0;
  const coordinates = [];
  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) third += toSigned(values[i + 2]);
    coordinates.push([latitude / factor, longitude / factor]);
  }
  return coordinates;
}

// ─── Google Polyline encode/decode ───────────────────────────────────────────

function encodeSigned(value) {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = '';
  while (signed >= 0x20) {
    encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
}

function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}

function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lon = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, shift = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lon / 1e5]);
  }
  return coordinates;
}

// ─── Utility functions ───────────────────────────────────────────────────────

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

const formatMinutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  return `${String(Number(parts[0]) || 0).padStart(2, '0')}:${String(Number(parts[1]) || 0).padStart(2, '0')}:${String(Number(parts[2]) || 0).padStart(2, '0')}`;
};

const getEffectiveWindowStart = (delivery, patient = null) =>
  delivery?.delivery_time_start || delivery?.time_window_start || patient?.time_window_start || null;

const getEffectiveWindowEnd = (delivery, patient = null) =>
  delivery?.delivery_time_end || delivery?.time_window_end || patient?.time_window_end || null;

const isLateWindowStop = (windowStart, currentMinutes) => {
  const startMinutes = parseTimeToMinutes(windowStart);
  return Number.isFinite(startMinutes) && startMinutes > currentMinutes;
};

const getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};

const getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, timeZoneName: 'shortOffset', hour: '2-digit'
  }).formatToParts(sampleDate).find((part) => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  return `${match[1]}${String(match[2]).padStart(2, '0')}:${String(match[3] || '00').padStart(2, '0')}`;
};

const buildLocalIso = (dateStr, timeStr) =>
  `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const getEdmontonTodayDateString = () => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
};

const isHistoricalRouteDate = (dateStr) => {
  if (!dateStr) return false;
  return String(dateStr) < getEdmontonTodayDateString();
};

const getLatestFinishedDelivery = (deliveries) =>
  [...(deliveries || [])]
    .filter((d) => FINISHED_STATUSES.includes(d?.status))
    .sort((a, b) => {
      const aTime = new Date(a?.actual_delivery_time || a?.updated_date || a?.created_date || 0).getTime();
      const bTime = new Date(b?.actual_delivery_time || b?.updated_date || b?.created_date || 0).getTime();
      return bTime - aTime;
    })[0] || null;

// ─── Coordinate resolution ───────────────────────────────────────────────────

const getDeliveryCoords = (delivery, patientMap, storeMap, ispSourceMap = new Map()) => {
  if (!delivery) return null;
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lng = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) return { lat, lng };
    return null;
  }
  if (delivery._interstore_source_id && !delivery.patient_id) {
    const ispLoc = ispSourceMap.get(delivery._interstore_source_id);
    const ispLat = Number(ispLoc?.store_latitude);
    const ispLng = Number(ispLoc?.store_longitude);
    if (Number.isFinite(ispLat) && Number.isFinite(ispLng) && ispLat !== 0 && ispLng !== 0) return { lat: ispLat, lng: ispLng };
  }
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) return { lat: Number(patient.latitude), lng: Number(patient.longitude) };
  }
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null) return { lat: Number(store.latitude), lng: Number(store.longitude) };
  return null;
};

// ─── HERE API: single segment duration ───────────────────────────────────────

const getHereSegmentDuration = async (origin, destination, hereApiKey, hereTransportMode) => {
  if (!origin || !destination) return null;
  try {
    const params = new URLSearchParams({
      transportMode: hereTransportMode === 'bicycle' ? 'bicycle' : hereTransportMode === 'pedestrian' ? 'pedestrian' : 'car',
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      return: 'summary',
      apiKey: hereApiKey
    });
    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const summary = data?.routes?.[0]?.sections?.[0]?.summary;
    if (!summary) return null;
    return { durationMinutes: Math.ceil(Number(summary.duration || 0) / 60), distanceKm: Number((Number(summary.length || 0) / 1000).toFixed(3)) };
  } catch { return null; }
};

// ─── HERE API: multi-stop route (replaces getHereDirections) ──────────────────

async function getMultiStopRouteHere(points, transportMode, hereApiKey) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const hereTransportMode = transportMode === 'cycling' ? 'bicycle' : transportMode === 'pedestrian' ? 'pedestrian' : 'car';

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', hereTransportMode);
  params.set('origin', `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set('destination', `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set('return', 'polyline,summary');

  const viaPoints = validPoints.slice(1, -1);
  viaPoints.forEach((p) => params.append('via', `${p.lat},${p.lon}`));

  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' }
  });
  const routeData = await routeResp.json().catch(() => null);
  const routeSections = Array.isArray(routeData?.routes?.[0]?.sections) ? routeData.routes[0].sections : [];

  if (!routeResp.ok || routeSections.length === 0) {
    console.warn('[clientRouteEngine] HERE Router returned no sections', {
      httpStatus: routeResp.status, sectionsCount: routeSections.length,
      notice: routeData?.notices ?? routeData?.title ?? null
    });
  }

  let anySegmentFellBack = false;
  const builtSections = validPoints.slice(0, -1).map((fromPoint, index) => {
    const section = routeSections[index] || {};
    let polyline = null;
    if (typeof section?.polyline === 'string' && section.polyline) {
      const coords = decodeHereFlexiblePolyline(section.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline(coords);
    }
    if (!polyline && typeof section?.encoded_polyline === 'string' && section.encoded_polyline) {
      polyline = section.encoded_polyline;
    }
    if (!polyline) {
      const toPoint = validPoints[index + 1];
      polyline = encodeGooglePolyline([[fromPoint.lat, fromPoint.lon], [toPoint.lat, toPoint.lon]]);
      anySegmentFellBack = true;
    }
    const summary = section?.summary || {};
    return {
      encoded_polyline: polyline,
      estimated_distance_km: summary.length ? Number((Number(summary.length) / 1000).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(Number(summary.duration) / 60) : null,
      transport_mode: transportMode || 'driving'
    };
  });

  return { sections: builtSections, usedFallbackPolyline: anySegmentFellBack };
}

// ─── HERE API: findsequence2 (waypoint sequencing) ────────────────────────────

async function callHereSequence({ sequenceStart, stopsToSequence, resolvedHomePosition, hereApiKey, hereTransportMode, deliveryDate, currentLocalTime, currentMinutes, includeTimeWindows }) {
  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('departure', buildLocalIso(deliveryDate, currentLocalTime || formatMinutesToTime(currentMinutes)));
  params.set('mode', `fastest;${hereTransportMode};traffic:disabled`);
  params.set('improveFor', 'quality');
  params.set('start', `driverStart;${sequenceStart.lat},${sequenceStart.lng}`);
  if (resolvedHomePosition) {
    params.set('end', `driverHome;${resolvedHomePosition.lat},${resolvedHomePosition.lng}`);
  }

  stopsToSequence.forEach((stop, index) => {
    const segments = [`${stop.delivery.stop_id || stop.delivery.delivery_id || stop.delivery.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      const accessConstraint = buildAccessConstraint(deliveryDate, stop.windowStart, stop.windowEnd);
      if (accessConstraint) segments.push(accessConstraint);
    }
    segments.push(`st:${Math.round((stop.delivery.extra_time || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(';'));
  });

  const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => null);
  return { response, data, includeTimeWindows };
}

// ─── ETA calculation ─────────────────────────────────────────────────────────

const getLegTravelMinutes = ({ stop, leg, segmentPolyline, fallbackMinutes = 5 }) => {
  if (typeof segmentPolyline?.estimatedDurationMinutes === 'number' && segmentPolyline.estimatedDurationMinutes > 0)
    return Math.ceil(segmentPolyline.estimatedDurationMinutes);
  if (typeof stop?.delivery?.estimated_duration_minutes === 'number' && stop.delivery.estimated_duration_minutes > 0)
    return Math.ceil(stop.delivery.estimated_duration_minutes);
  const travelSeconds = Number(leg?.duration || 0);
  if (travelSeconds > 0) return Math.ceil(travelSeconds / 60);
  return fallbackMinutes;
};

// ─── Main engine: optimizeRouteClientSide ────────────────────────────────────

/**
 * Client-side route optimization + polyline generation.
 *
 * @param {Object} params
 * @param {Array}  params.deliveries - All deliveries for driver+date (from local state)
 * @param {Array}  params.patients - Patient records (from local state)
 * @param {Array}  params.stores - Store records (from local state)
 * @param {Array}  params.appUsers - AppUser records (for driver GPS/home/travel mode)
 * @param {string} params.driverId
 * @param {string} params.deliveryDate - YYYY-MM-DD
 * @param {string} params.hereApiKey
 * @param {Object} [params.currentLocation] - { lat, lon } override for origin
 * @param {string} [params.source] - Label for logging
 * @param {boolean} [params.preserveExistingOrder=false]
 * @param {boolean} [params.cyclingSegmentOnly=false]
 * @param {Object} [params.cyclingOrigin]
 * @param {Object} [params.cyclingDestination]
 * @param {string[]} [params.cyclingStopIds]
 * @param {boolean} [params.drivingSegmentOnly=false]
 * @param {Object} [params.drivingOrigin]
 * @param {string[]} [params.excludeStopIds]
 * @param {number} [params.startingStopOrder]
 * @returns {Promise<Object>} { success, orderedDeliveryIds, optimizedRoute, writeBatch, usedFallbackOrdering, usedTimeWindows, locationSource }
 */
export async function optimizeRouteClientSide({
  deliveries,
  patients = [],
  stores = [],
  appUsers = [],
  driverId,
  deliveryDate,
  hereApiKey,
  currentLocation = null,
  source = 'client_engine',
  preserveExistingOrder = false,
  cyclingSegmentOnly = false,
  cyclingOrigin = null,
  cyclingDestination = null,
  cyclingStopIds = [],
  drivingSegmentOnly = false,
  drivingOrigin = null,
  excludeStopIds = [],
  startingStopOrder = null,
}) {
  if (!driverId || !deliveryDate) {
    return { success: false, error: 'Missing driverId or deliveryDate' };
  }
  if (!hereApiKey) {
    return { success: false, error: 'Missing HERE API key' };
  }

  const allDeliveries = deliveries || [];
  if (allDeliveries.length === 0) {
    return { success: true, routeChanged: false, optimizedCount: 0, orderedDeliveryIds: [], optimizedRoute: [], writeBatch: [] };
  }

  // Build lookup maps
  const patientMap = new Map((patients || []).map(p => [p.id, p]));
  const storeMap = new Map((stores || []).map(s => [s.id, s]));

  // Resolve driver AppUser — first from local array, then DB fallback
  let driverAppUser = (appUsers || []).find((au) => au?.user_id === driverId || au?.id === driverId) || null;
  if (!driverAppUser) {
    console.warn(`[clientRouteEngine] ${source} — driver AppUser NOT FOUND in appUsers (array size=${(appUsers || []).length}, driverId=${driverId}). Fetching from DB...`);
    try {
      const dbResults = await base44.entities.AppUser.filter({ user_id: driverId }).catch(() => []);
      if (Array.isArray(dbResults) && dbResults.length > 0) {
        driverAppUser = dbResults[0];
        console.log(`[clientRouteEngine] ${source} — driver AppUser found via DB fallback: user_id=${driverAppUser.user_id}, gps=${driverAppUser.current_latitude ?? 'null'},${driverAppUser.current_longitude ?? 'null'}, home=${driverAppUser.home_latitude ?? 'null'},${driverAppUser.home_longitude ?? 'null'}`);
      } else {
        console.warn(`[clientRouteEngine] ${source} — driver AppUser NOT in DB either. Proceeding with defaults — will use stop coords as origin fallback.`);
      }
    } catch (err) {
      console.warn(`[clientRouteEngine] ${source} — DB fallback for AppUser failed:`, err?.message || err);
    }
  } else {
    console.log(`[clientRouteEngine] ${source} — driver AppUser found locally: user_id=${driverAppUser.user_id}, gps=${driverAppUser.current_latitude ?? 'null'},${driverAppUser.current_longitude ?? 'null'}, home=${driverAppUser.home_latitude ?? 'null'},${driverAppUser.home_longitude ?? 'null'}, travelMode=${driverAppUser.preferred_travel_mode || 'default'}`);
  }
  // Soft-fallback: use empty object so downstream null-checks still work
  const _driverAppUser = driverAppUser || {};

  const preferredTravelMode = String(_driverAppUser?.preferred_travel_mode || 'driving').toLowerCase();
  const effectiveTravelMode = cyclingSegmentOnly ? 'cycling' : (preferredTravelMode === 'cycling' ? 'driving' : preferredTravelMode);
  const hereTransportMode = cyclingSegmentOnly ? 'bicycle' : effectiveTravelMode === 'pedestrian' ? 'pedestrian' : 'car';

  // Current time in Edmonton
  const now = new Date();
  const edmontonFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false
  });
  const edmontonParts = edmontonFormatter.formatToParts(now);
  const edmontonHour = parseInt(edmontonParts.find(p => p.type === 'hour')?.value || '0', 10);
  const edmontonMinute = parseInt(edmontonParts.find(p => p.type === 'minute')?.value || '0', 10);
  let currentMinutes = edmontonHour * 60 + edmontonMinute;
  const currentLocalTime = `${String(edmontonHour).padStart(2, '0')}:${String(edmontonMinute).padStart(2, '0')}`;

  // CRITICAL: Filter to only this driver's deliveries for this date.
  // allDeliveries may contain other drivers' stops (admin/dispatcher view), which would
  // cause cross-driver polyline contamination and wrong sequencing.
  const driverDeliveries = allDeliveries.filter(d =>
    d && String(d.driver_id) === String(driverId) && d.delivery_date === deliveryDate
  );
  console.log(`[clientRouteEngine] ${source} — allDeliveries=${allDeliveries.length}, after driver/date filter=${driverDeliveries.length} (driverId=${driverId}, date=${deliveryDate})`);

  // Separate deliveries by status
  const completedDeliveries = driverDeliveries.filter(d => FINISHED_STATUSES.includes(d.status));
  const incompleteDeliveries = driverDeliveries.filter(d => !FINISHED_STATUSES.includes(d.status));
  const activeRouteDeliveries = incompleteDeliveries.filter(d => ACTIVE_STATUSES.includes(d.status));
  const pendingRouteDeliveries = incompleteDeliveries.filter(d => d.status === 'pending');
  const filteredPendingRouteDeliveries = pendingRouteDeliveries.filter(d => !d.is_cycling_marker);
  let optimizableDeliveries = [...activeRouteDeliveries, ...filteredPendingRouteDeliveries];

  if (cyclingSegmentOnly && cyclingStopIds.length > 0) {
    optimizableDeliveries = optimizableDeliveries.filter(d => cyclingStopIds.includes(d.id) && !d.is_cycling_marker);
  }
  if (drivingSegmentOnly && excludeStopIds.length > 0) {
    optimizableDeliveries = optimizableDeliveries.filter(d => !excludeStopIds.includes(d.id) && !d.is_cycling_marker);
  }

  if (optimizableDeliveries.length === 0) {
    console.warn(`[clientRouteEngine] ${source} — no optimizable deliveries (completed=${completedDeliveries.length}, active=${activeRouteDeliveries.length}, pending=${pendingRouteDeliveries.length})`);
    return { success: true, routeChanged: false, optimizedCount: 0, orderedDeliveryIds: [], optimizedRoute: [], writeBatch: [] };
  }

  console.log(`[clientRouteEngine] ${source} — INPUT: ${allDeliveries.length} total deliveries → completed=${completedDeliveries.length}, active=${activeRouteDeliveries.length}, pending=${pendingRouteDeliveries.length}, optimizable=${optimizableDeliveries.length}`);

  // ISP source locations (client-side: try to resolve from stores by phone match)
  const ispSourceIds = [...new Set(allDeliveries.filter(d => d._interstore_source_id && !d.patient_id).map(d => d._interstore_source_id))];
  const ispSourceMap = new Map(); // Client-side: we don't have InterStoreLocation entity locally; rely on store coords fallback
  // If we have ISP source IDs, the backend function resolved them. On client side, getDeliveryCoords
  // will fall through to store coords if ispSourceMap doesn't have the ID — which is the correct fallback.

  // Build pickup window lookup
  const pickupWindowByStopId = new Map(
    optimizableDeliveries
      .filter(d => d && !d.patient_id && d.stop_id)
      .map(d => [d.stop_id, { start: d.delivery_time_start || null, end: d.delivery_time_end || null }])
  );

  // Build optimization stops
  const stops = optimizableDeliveries.map(delivery => {
    const coords = getDeliveryCoords(delivery, patientMap, storeMap, ispSourceMap);
    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
    let windowStart = getEffectiveWindowStart(delivery, patient);
    let windowEnd = getEffectiveWindowEnd(delivery, patient);

    if (delivery.patient_id && delivery.puid && pickupWindowByStopId.has(delivery.puid)) {
      const pickupWindow = pickupWindowByStopId.get(delivery.puid);
      const pickupEndMinutes = parseTimeToMinutes(pickupWindow?.end || pickupWindow?.start);
      const deliveryStartMinutes = parseTimeToMinutes(windowStart);
      if (Number.isFinite(pickupEndMinutes) && (!Number.isFinite(deliveryStartMinutes) || deliveryStartMinutes < pickupEndMinutes)) {
        windowStart = formatMinutesToTime(pickupEndMinutes + 5);
      }
    }

    return {
      delivery,
      lat: coords?.lat,
      lng: coords?.lng,
      isPickup: !delivery.patient_id,
      windowStart,
      windowEnd,
      hasLateWindow: isLateWindowStop(windowStart, currentMinutes),
      timeMinutes: parseTimeToMinutes(windowStart || delivery.delivery_time_start)
    };
  }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const _droppedStops = optimizableDeliveries.length - stops.length;
  if (_droppedStops > 0) {
    console.warn(`[clientRouteEngine] ${source} — ${_droppedStops} stops DROPPED (missing coords). storeMap size=${storeMap.size}, patientMap size=${patientMap.size}`);
    const dropped = optimizableDeliveries.filter(d => {
      const c = getDeliveryCoords(d, patientMap, storeMap, ispSourceMap);
      return !c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng);
    });
    dropped.forEach(d => console.warn(`  └─ dropped delivery ${d.id} store_id=${d.store_id} patient_id=${d.patient_id || 'N/A'}`));
  } else {
    console.log(`[clientRouteEngine] ${source} — ${stops.length} stops resolved with valid coords`);
  }

  // ── Future route light mode ──────────────────────────────────────────────
  const historicalRoute = isHistoricalRouteDate(deliveryDate);
  const isFutureRoute = !historicalRoute && deliveryDate > getEdmontonTodayDateString();
  const routeOfficiallyStarted = completedDeliveries.length > 0;

  if (isFutureRoute && !routeOfficiallyStarted) {
    return _handleFutureRoute({
      optimizableDeliveries, stops, storeMap, patientMap, deliveryDate,
      startingStopOrder, completedDeliveries, currentMinutes, source
    });
  }

  // ── Determine current position (origin) ───────────────────────────────────
  const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);
  const explicitNextDelivery = incompleteDeliveries.find(d => d?.isNextDelivery === true) || null;
  const explicitNextCoords = explicitNextDelivery ? getDeliveryCoords(explicitNextDelivery, patientMap, storeMap, ispSourceMap) : null;
  const latestFinishedCoords = latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap, ispSourceMap) : null;
  const previousStopBeforeNext = explicitNextDelivery
    ? allDeliveries
        .filter(d => d?.id !== explicitNextDelivery.id)
        .filter(d => Number(d?.stop_order || 0) < Number(explicitNextDelivery?.stop_order || 0))
        .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null
    : null;
  const previousStopCoords = previousStopBeforeNext ? getDeliveryCoords(previousStopBeforeNext, patientMap, storeMap, ispSourceMap) : null;
  const routeHasStarted = completedDeliveries.length > 0 || !!previousStopBeforeNext;
  const shouldLockExplicitNextStop = !!explicitNextDelivery;

  const driverGpsPosition = _driverAppUser.current_latitude != null && _driverAppUser.current_longitude != null
    ? { lat: Number(_driverAppUser.current_latitude), lng: Number(_driverAppUser.current_longitude) }
    : null;
  console.log(`[clientRouteEngine] ${source} — driver location: gps=${driverGpsPosition ? `(${driverGpsPosition.lat.toFixed(4)},${driverGpsPosition.lng.toFixed(4)})` : 'null'}, home=${_driverAppUser.home_latitude != null ? `(${_driverAppUser.home_latitude},${_driverAppUser.home_longitude})` : 'null'}, travelMode=${preferredTravelMode}`);

  let currentPosition = null;
  let locationSource = null;

  if (routeHasStarted && latestFinishedCoords) {
    const distanceFromLastFinishedStop = driverGpsPosition
      ? calculateCrowFliesDistance(driverGpsPosition.lat, driverGpsPosition.lng, latestFinishedCoords.lat, latestFinishedCoords.lng)
      : null;
    if (distanceFromLastFinishedStop != null && distanceFromLastFinishedStop > LAST_FINISHED_STOP_PROXIMITY_KM) {
      currentPosition = driverGpsPosition;
      locationSource = 'driver_gps_away_from_last_finished_stop';
    } else {
      currentPosition = latestFinishedCoords;
      locationSource = 'last_finished_stop';
    }
  }
  if (!currentPosition && previousStopCoords) { currentPosition = previousStopCoords; locationSource = 'previous_stop_before_next'; }
  if (!currentPosition && explicitNextCoords) { currentPosition = explicitNextCoords; locationSource = 'next_delivery_stop'; }
  if (!routeHasStarted && !currentPosition && driverGpsPosition) { currentPosition = driverGpsPosition; locationSource = 'driver_gps'; }
  if (!currentPosition && _driverAppUser.home_latitude != null && _driverAppUser.home_longitude != null) {
    currentPosition = { lat: Number(_driverAppUser.home_latitude), lng: Number(_driverAppUser.home_longitude) };
    locationSource = 'home';
  }
  if (cyclingSegmentOnly && cyclingOrigin?.lat != null && cyclingOrigin?.lon != null) {
    currentPosition = { lat: Number(cyclingOrigin.lat), lng: Number(cyclingOrigin.lon) };
    locationSource = 'cycling_origin_override';
  }
  if (drivingSegmentOnly && drivingOrigin?.lat != null && drivingOrigin?.lon != null) {
    currentPosition = { lat: Number(drivingOrigin.lat), lng: Number(drivingOrigin.lon) };
    locationSource = 'driving_origin_override';
  }
  // Allow explicit currentLocation override (from caller)
  if (!currentPosition && currentLocation && Number.isFinite(currentLocation.lat) && Number.isFinite(currentLocation.lon)) {
    currentPosition = { lat: currentLocation.lat, lng: currentLocation.lon };
    locationSource = 'caller_provided';
  }

  if (!currentPosition) {
    console.error(`[clientRouteEngine] ${source} — ABORT: no currentPosition resolved (no GPS, no home, no completed stops, no next delivery coords)`);
    return { success: false, error: 'Driver location not available - no GPS, last completed, or home location set' };
  }
  console.log(`[clientRouteEngine] ${source} — currentPosition=(${currentPosition.lat.toFixed(4)}, ${currentPosition.lng.toFixed(4)}) source=${locationSource}`);

  const logicalSegmentOrigin = latestFinishedCoords
    || (_driverAppUser.home_latitude != null && _driverAppUser.home_longitude != null
      ? { lat: Number(_driverAppUser.home_latitude), lng: Number(_driverAppUser.home_longitude) }
      : null)
    || currentPosition;

  const resolvedHomePosition = _driverAppUser.home_latitude != null && _driverAppUser.home_longitude != null
    ? { lat: Number(_driverAppUser.home_latitude), lng: Number(_driverAppUser.home_longitude) }
    : null;

  // Build optimization stops list
  const optimizationStops = optimizableDeliveries
    .map(d => stops.find(item => item.delivery.id === d.id) || null)
    .filter(Boolean);

  const orderedOptimizationStops = preserveExistingOrder
    ? optimizationStops.slice().sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999))
    : optimizationStops;

  // Lock isNextDelivery stop as first in sequence.
  // The isNextDelivery stop is the one the driver is currently heading to — it must
  // NOT be re-sequenced by HERE. If no explicit isNextDelivery exists yet (e.g. after
  // Accept All where no stop has been flagged), fall back to the first active stop.
  const explicitNextStop = orderedOptimizationStops.find(s => s.delivery.isNextDelivery === true) || null;
  const explicitNextIsActive = explicitNextStop && ACTIVE_STATUSES.includes(explicitNextStop.delivery.status);
  // If no explicit isNextDelivery, pick the first active stop as implicit next
  const implicitNextStop = !explicitNextStop
    ? orderedOptimizationStops.find(s => ACTIVE_STATUSES.includes(s.delivery.status)) || null
    : null;
  const lockedNextStop = !preserveExistingOrder
    ? (explicitNextIsActive ? explicitNextStop : (implicitNextStop || null))
    : null;
  const routeOriginStop = lockedNextStop || null;
  const stopsToSequence = routeOriginStop
    ? orderedOptimizationStops.filter(s => s.delivery.id !== routeOriginStop.delivery.id)
    : orderedOptimizationStops;
  console.log(`[clientRouteEngine] ${source} — isNextDelivery lock: explicit=${explicitNextStop?.delivery.id || 'none'}(active=${explicitNextIsActive}), implicit=${implicitNextStop?.delivery.id || 'none'}, locked=${lockedNextStop?.delivery.id || 'none'}`);

  let usedTimeWindows = true;
  let usedFallbackOrdering = false;
  let routeStops = routeOriginStop ? [routeOriginStop] : [];
  let directionsLegs = [];
  let segmentPolylines = [];

  // Logical segment for isNextDelivery stop
  let nextStopLogicalSegment = null;
  if (lockedNextStop && logicalSegmentOrigin && explicitNextCoords) {
    const samePoint = Math.abs(logicalSegmentOrigin.lat - currentPosition.lat) < 0.0001 &&
                      Math.abs(logicalSegmentOrigin.lng - currentPosition.lng) < 0.0001;
    if (!samePoint) {
      nextStopLogicalSegment = await getHereSegmentDuration(logicalSegmentOrigin, explicitNextCoords, hereApiKey, hereTransportMode);
    }
  }

  // Dispatch phase event: optimization (sequencing) starting
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('routeOptimizationPhase', { detail: { phase: 'optimizing', source, driverId, deliveryDate } }));
  }

  // ── Run HERE sequencing or fallback ────────────────────────────────────────
  if (preserveExistingOrder) {
    routeStops = [...orderedOptimizationStops];
    let prevPos = currentPosition;
    for (const stop of routeStops) {
      const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
      directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
      prevPos = { lat: stop.lat, lng: stop.lng };
    }
  } else if (stopsToSequence.length > 0) {
    console.log(`[clientRouteEngine] ${source} — calling HERE findsequence2 for ${stopsToSequence.length} stops (preserveExistingOrder=${preserveExistingOrder})`);
    let hereAttempt = await callHereSequence({
      sequenceStart: routeOriginStop ? { lat: routeOriginStop.lat, lng: routeOriginStop.lng } : currentPosition,
      stopsToSequence, resolvedHomePosition, hereApiKey, hereTransportMode,
      deliveryDate, currentLocalTime, currentMinutes, includeTimeWindows: true
    });
    let result = Array.isArray(hereAttempt.data?.results) ? hereAttempt.data.results[0] : null;
    let waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
    let interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

    if ((!hereAttempt.response.ok || !result || waypoints.length === 0) && hereAttempt.includeTimeWindows) {
      usedTimeWindows = false;
      hereAttempt = await callHereSequence({
        sequenceStart: routeOriginStop ? { lat: routeOriginStop.lat, lng: routeOriginStop.lng } : currentPosition,
        stopsToSequence, resolvedHomePosition, hereApiKey, hereTransportMode,
        deliveryDate, currentLocalTime, currentMinutes, includeTimeWindows: false
      });
      result = Array.isArray(hereAttempt.data?.results) ? hereAttempt.data.results[0] : null;
      waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
    }

    if (!hereAttempt.response.ok || !result || waypoints.length === 0) {
      // Crow-flies fallback
      console.warn(`[clientRouteEngine] ${source} — HERE sequencing FAILED (status=${hereAttempt.response.status}, usedTimeWindows=${usedTimeWindows}), using crow-flies fallback`);
      usedFallbackOrdering = true;
      routeStops = [...routeStops, ...stopsToSequence].sort((a, b) => {
        const distA = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, a.lat, a.lng);
        const distB = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, b.lat, b.lng);
        const homePenaltyA = resolvedHomePosition ? calculateCrowFliesDistance(a.lat, a.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
        const homePenaltyB = resolvedHomePosition ? calculateCrowFliesDistance(b.lat, b.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
        return (distA - homePenaltyA * 0.15) - (distB - homePenaltyB * 0.15);
      });
      let prevPos = currentPosition;
      for (const stop of routeStops) {
        const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
        directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
        prevPos = { lat: stop.lat, lng: stop.lng };
      }
    } else {
      // HERE success — map waypoints to stops
      console.log(`[clientRouteEngine] ${source} — HERE sequencing OK: ${waypoints.length} waypoints, usedTimeWindows=${usedTimeWindows}`);
      const orderedStops = waypoints
        .filter(wp => wp.id !== 'driverStart' && wp.id !== 'driverEnd')
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(wp => ({
          stop: stopsToSequence.find(item => (item.delivery.stop_id || item.delivery.delivery_id || item.delivery.id) === wp.id) || null,
          waypoint: wp
        }))
        .filter(item => item.stop);

      routeStops = [...routeStops, ...orderedStops.map(item => item.stop)];
      const interconnectionByToWaypoint = new Map(interconnections.map(item => [item.toWaypoint, item]));
      directionsLegs = routeStops.map((stop, index) => {
        if (index === 0) {
          const distKm = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, stop.lat, stop.lng);
          return { duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 };
        }
        const routeIndex = index - 1;
        const waypoint = orderedStops[routeIndex]?.waypoint;
        const leg = waypoint ? interconnectionByToWaypoint.get(waypoint.id) : null;
        return { duration: Number(leg?.time || 0), distance: Number(leg?.distance || 0) };
      });
    }
  }

  // ── Unit-number micro-sort ─────────────────────────────────────────────────
  _unitNumberMicroSort(routeStops, patientMap);

  // Dispatch phase event: polyline generation starting
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('routeOptimizationPhase', { detail: { phase: 'polylines', source, driverId, deliveryDate } }));
  }

  // ── Generate polylines via HERE Router v8 ──────────────────────────────────
  const segmentPolylineByDeliveryId = new Map();

  // Build the list of points for multi-stop routing: origin → each stop in order
  // ONLY generate polylines for active stops (en_route, in_transit) — pending stops
  // haven't been picked up yet so there's no driving path to them.
  const activeRouteStops = routeStops.filter(s => s.delivery.status !== 'pending');
  console.log(`[clientRouteEngine] ${source} — POLYLINE PHASE: routeStops=${routeStops.length}, activeRouteStops=${activeRouteStops.length} (pending excluded from polylines)`);
  if (activeRouteStops.length > 0) {
    const polylineOrigin = (() => {
      // Match regenerateType1Polyline origin logic: most recent finished stop by time, or home, or current position
      if (latestFinishedCoords) return { lat: latestFinishedCoords.lat, lon: latestFinishedCoords.lng };
      if (resolvedHomePosition) return { lat: resolvedHomePosition.lat, lon: resolvedHomePosition.lng };
      return { lat: currentPosition.lat, lon: currentPosition.lng };
    })();
    console.log(`[clientRouteEngine] ${source} — polylineOrigin=(${polylineOrigin.lat.toFixed(4)}, ${polylineOrigin.lon.toFixed(4)}) originSource=${latestFinishedCoords ? 'lastFinished' : resolvedHomePosition ? 'home' : 'currentPos'}`);

    const routePoints = [
      polylineOrigin,
      ...activeRouteStops.map(s => ({ lat: s.lat, lon: s.lng }))
    ];

    const multiStopRoute = await getMultiStopRouteHere(routePoints, effectiveTravelMode, hereApiKey).catch((err) => {
      console.error(`[clientRouteEngine] ${source} — HERE Router v8 THREW:`, err?.message || err);
      return { sections: [], usedFallbackPolyline: true };
    });
    const routeSections = multiStopRoute.sections;
    console.log(`[clientRouteEngine] ${source} — HERE Router v8 returned ${routeSections.length} sections for ${routePoints.length} points (fallback=${multiStopRoute.usedFallbackPolyline})`);

    // Map sections to stops (section[0] = origin → stop[0], section[1] = stop[0] → stop[1], etc.)
    activeRouteStops.forEach((stop, index) => {
      const section = routeSections[index] || null;
      segmentPolylineByDeliveryId.set(stop.delivery.id, {
        deliveryId: stop.delivery.id,
        encodedPolyline: section?.encoded_polyline || null,
        estimatedDistanceKm: section?.estimated_distance_km ?? null,
        estimatedDurationMinutes: section?.estimated_duration_minutes ?? null
      });
    });

    const _polylineCount = [...segmentPolylineByDeliveryId.values()].filter(s => s?.encodedPolyline != null).length;
    console.log(`[clientRouteEngine] ${source} — polylines generated: ${_polylineCount}/${activeRouteStops.length} stops have encoded_polyline`);

    // Re-sync directionsLegs with actual HERE routing durations if available
    activeRouteStops.forEach((stop, index) => {
      const section = routeSections[index];
      if (section?.estimated_duration_minutes && Number(section.estimated_duration_minutes) > 0) {
        directionsLegs[routeStops.indexOf(stop)] = {
          ...directionsLegs[routeStops.indexOf(stop)],
          duration: Number(section.estimated_duration_minutes) * 60,
          distance: section.estimated_distance_km ? Number(section.estimated_distance_km) * 1000 : directionsLegs[routeStops.indexOf(stop)]?.distance
        };
      }
    });
  }

  // ── ETA calculation ────────────────────────────────────────────────────────
  const stageEtaMap = new Map();

  if (historicalRoute && routeStops.length > 0) {
    const firstStop = routeStops[0];
    let cumulativeTime = currentMinutes;
    const firstStopWindowStart = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.time_window_start || firstStop.delivery.delivery_time_start);
    if (Number.isFinite(firstStopWindowStart) && cumulativeTime < firstStopWindowStart) cumulativeTime = firstStopWindowStart;
    stageEtaMap.set(firstStop.delivery.id, formatMinutesToTime(cumulativeTime));
    cumulativeTime += firstStop.delivery.extra_time || (firstStop.isPickup ? 15 : 5);
    for (let i = 1; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const seg = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
      cumulativeTime += getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline: seg });
      const ws = parseTimeToMinutes(stop.windowStart || stop.delivery.time_window_start || stop.delivery.delivery_time_start);
      if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
      stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumulativeTime));
      cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
    }
  } else {
    let cumulativeTime = currentMinutes;
    if (isFutureRoute && routeStops.length > 0) {
      const firstStop = routeStops[0];
      const firstWindowStart = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.delivery_time_start);
      if (Number.isFinite(firstWindowStart)) cumulativeTime = firstWindowStart;
    }
    for (let i = 0; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const seg = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
      cumulativeTime += getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline: seg });
      const ws = parseTimeToMinutes(stop.windowStart || stop.delivery.time_window_start);
      if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
      if (isFutureRoute && !routeOfficiallyStarted && stop.isPickup) {
        const pickupStart = parseTimeToMinutes(stop.delivery.delivery_time_start);
        if (Number.isFinite(pickupStart) && cumulativeTime < pickupStart) cumulativeTime = pickupStart;
      }
      stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumulativeTime));
      cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
    }
  }

  // ── Build response + write batch ───────────────────────────────────────────
  const optimizedRouteStopsForResponse = routeStops.map(stop => ({
    ...stop.delivery,
    delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
  }));

  // NOTE: Do NOT sort pending stops to end — the HERE optimizer already sequenced them
  // correctly, and reordering here would scramble the stop_order vs polyline mapping.
  const activeStops = routeStops.map(stop => ({
    ...stop.delivery,
    delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
  }));

  const startOrder = startingStopOrder != null ? startingStopOrder : completedDeliveries.length;
  const originalActiveOrder = activeRouteDeliveries
    .slice().sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999))
    .map(d => String(d.id));
  const optimizedActiveOrder = activeStops.map(s => String(s.id));
  const routeOrderChanged = preserveExistingOrder
    ? false
    : originalActiveOrder.length !== optimizedActiveOrder.length
      || originalActiveOrder.some((id, index) => id !== optimizedActiveOrder[index]);

  const nextStopId = explicitNextDelivery?.id || activeStops[0]?.id || null;
  const finalizedById = new Map(activeStops.map(s => [s.id, s]));
  const writeBatch = [];

  const resolvePendingStartTime = (stop) => {
    if (stop.status !== 'pending') return undefined;
    if (!stop.patient_id) return stop.delivery_time_start || stop.delivery_time_eta;
    if (!stop.puid) return undefined;
    const pickup = activeStops.find(c => !c.patient_id && c.stop_id === stop.puid)
      || allDeliveries.find(c => !c.patient_id && c.stop_id === stop.puid);
    if (!pickup) return undefined;
    const pickupState = finalizedById.get(pickup.id) || pickup;
    let baseMinutes = parseTimeToMinutes(pickupState.delivery_time_eta);
    if (!Number.isFinite(baseMinutes)) baseMinutes = parseTimeToMinutes(pickupState.delivery_time_start);
    if (!Number.isFinite(baseMinutes)) return undefined;
    return formatMinutesToTime(baseMinutes + 5);
  };

  for (let i = 0; i < activeStops.length; i++) {
    const stop = activeStops[i];
    const newOrder = preserveExistingOrder ? Number(stop.stop_order || i + 1) : startOrder + i + 1;
    const pendingStartTime = resolvePendingStartTime(stop);
    const seg = segmentPolylineByDeliveryId.get(stop.id) || null;
    const isPendingStop = stop?.status === 'pending';
    const rawTransportMode = isPendingStop ? effectiveTravelMode : String(stop?.transport_mode || effectiveTravelMode).toLowerCase();
    const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(rawTransportMode) ? rawTransportMode : 'driving';
    const isNextStop = stop.id === nextStopId && i === 0;
    const logicalDurationMinutes = isNextStop && nextStopLogicalSegment
      ? nextStopLogicalSegment.durationMinutes
      : (typeof seg?.estimatedDurationMinutes === 'number' ? seg.estimatedDurationMinutes : null);
    const logicalDistanceKm = isNextStop && nextStopLogicalSegment
      ? nextStopLogicalSegment.distanceKm
      : (typeof seg?.estimatedDistanceKm === 'number' ? seg.estimatedDistanceKm : null);
    const isPending = stop.status === 'pending';

    // Correct pickup status if somehow in_transit
    const isPickupStop = !stop.patient_id && !stop.is_cycling_marker;
    const correctedStatus = isPickupStop && stop.status === 'in_transit' ? 'en_route' : undefined;

    const updateData = {
      stop_order: newOrder,
      display_stop_order: newOrder,
      delivery_time_eta: stop.delivery_time_eta,
      isNextDelivery: stop.id === nextStopId,
      ...(stop.id !== nextStopId ? { isNextDelivery: false } : {}),
      transport_mode: safeTransportMode,
      ...(correctedStatus ? { status: correctedStatus } : {}),
      travel_dist: isPending ? null : (Number(directionsLegs[i]?.distance)
        ? Number((Number(directionsLegs[i].distance) / 1000).toFixed(3)) : null),
      ...(!isPending && logicalDurationMinutes != null ? { estimated_duration_minutes: logicalDurationMinutes } : {}),
      ...(!isPending && logicalDistanceKm != null ? { estimated_distance_km: logicalDistanceKm } : {}),
      ...(!isPending && seg?.encodedPolyline ? { encoded_polyline: seg.encodedPolyline, transport_mode: safeTransportMode } : {}),
      ...(isPending ? { encoded_polyline: null, estimated_distance_km: null, estimated_duration_minutes: null } : {})
    };

    if (pendingStartTime) {
      updateData.delivery_time_start = pendingStartTime;
      stop.delivery_time_start = pendingStartTime;
    }

    stop.stop_order = newOrder;
    stop.display_stop_order = newOrder;
    stop.isNextDelivery = stop.id === nextStopId;

    writeBatch.push({ id: stop.id, data: updateData });
  }

  const _polylineWriteCount = writeBatch.filter(w => w.data?.encoded_polyline != null).length;
  const _pendingClearCount = writeBatch.filter(w => w.data?.encoded_polyline === null).length;
  console.log(`[clientRouteEngine] ${source} — WRITE BATCH: ${writeBatch.length} updates, ${_polylineWriteCount} with polylines, ${_pendingClearCount} pending-cleared`);

  const orderedDeliveryIds = optimizedRouteStopsForResponse.map(s => s.id);
  const optimizedRoute = optimizedRouteStopsForResponse.map((stop, index) => {
    const writeEntry = writeBatch.find(b => b.id === stop.id);
    const legIndex = routeStops.findIndex(s => s.delivery.id === stop.id);
    return {
      deliveryId: stop.id,
      newETA: stop.delivery_time_eta,
      stop_order: startOrder + index + 1,
      isNextDelivery: stop.id === nextStopId,
      transport_mode: stop.transport_mode || 'driving',
      encoded_polyline: segmentPolylineByDeliveryId.get(stop.id)?.encodedPolyline || null,
      estimated_distance_km: writeEntry?.data?.estimated_distance_km ?? null,
      estimated_duration_minutes: writeEntry?.data?.estimated_duration_minutes ?? null,
      travel_dist: legIndex >= 0 && Number(directionsLegs[legIndex]?.distance)
        ? Number((Number(directionsLegs[legIndex].distance) / 1000).toFixed(3)) : null
    };
  });

  return {
    success: true,
    driverId,
    deliveryDate,
    routeChanged: routeOrderChanged,
    optimizedCount: routeStops.length,
    locationSource,
    usedTimeWindows,
    usedFallbackOrdering,
    preserveExistingOrder,
    nextDeliveryId: nextStopId,
    shouldRefreshPolylines: activeStops.length > 0,
    orderedDeliveryIds,
    optimizedRoute,
    writeBatch,
  };
}

// ─── Future route handler (light mode, no HERE call) ─────────────────────────

function _handleFutureRoute({ optimizableDeliveries, storeMap, patientMap, deliveryDate, startingStopOrder, completedDeliveries, currentMinutes, source }) {
  const startOrder = (startingStopOrder != null) ? startingStopOrder : completedDeliveries.length;
  const weekdayCode = getWeekdayCode(deliveryDate);
  const isWeekend = weekdayCode === 'sa' || weekdayCode === 'su';
  const isSaturday = weekdayCode === 'sa';

  const getStoreDefaultWindow = (storeId, ampm) => {
    const sw = storeMap.get(storeId);
    if (!sw) return { start: null, end: null };
    const prefix = isSaturday ? 'saturday' : isWeekend ? 'sunday' : 'weekday';
    const slot = (ampm || 'AM').toUpperCase() === 'PM' ? 'pm' : 'am';
    return { start: sw[`${prefix}_${slot}_start`] || null, end: sw[`${prefix}_${slot}_end`] || null };
  };

  const pickups = optimizableDeliveries.filter(d => !d.patient_id);
  const pendingDeliveries = optimizableDeliveries.filter(d => d.patient_id && d.status === 'pending');
  const activeDeliveries = optimizableDeliveries.filter(d => d.patient_id && d.status !== 'pending');

  const normalizedPickups = pickups.map(p => {
    const dw = getStoreDefaultWindow(p.store_id, p.ampm_deliveries);
    return { ...p, delivery_time_start: p.delivery_time_start || dw.start || p.delivery_time_start, delivery_time_end: p.delivery_time_end || dw.end || p.delivery_time_end };
  }).sort((a, b) => parseTimeToMinutes(a.delivery_time_start || '00:00') - parseTimeToMinutes(b.delivery_time_start || '00:00'));

  const pickupByPuid = new Map(normalizedPickups.map(p => [p.stop_id, p]));
  const normalizedPendingDeliveries = pendingDeliveries.map(d => {
    const patient = patientMap.get(d.patient_id);
    const pickup = d.puid ? pickupByPuid.get(d.puid) : null;
    let deliveryStart = d.delivery_time_start;
    if (!deliveryStart && pickup?.delivery_time_start) deliveryStart = formatMinutesToTime(parseTimeToMinutes(pickup.delivery_time_start) + 5);
    return { ...d, delivery_time_start: deliveryStart || d.delivery_time_start, time_window_start: d.time_window_start || patient?.time_window_start || null, time_window_end: d.time_window_end || patient?.time_window_end || null, _resolvedPickupStart: pickup?.delivery_time_start || null };
  });

  const sortedPendingDeliveries = normalizedPendingDeliveries.sort((a, b) =>
    parseTimeToMinutes(a.delivery_time_start || a._resolvedPickupStart || '99:99') - parseTimeToMinutes(b.delivery_time_start || b._resolvedPickupStart || '99:99')
  );

  const orderedStops = [];
  const addedDeliveryIds = new Set();
  for (const pickup of normalizedPickups) {
    orderedStops.push({ delivery: pickup, isPickup: true });
    const pickupDeliveries = [
      ...activeDeliveries.filter(d => d.puid === pickup.stop_id),
      ...sortedPendingDeliveries.filter(d => d.puid === pickup.stop_id)
    ].sort((a, b) => parseTimeToMinutes(a.time_window_start || a.delivery_time_start || '99:99') - parseTimeToMinutes(b.time_window_start || b.delivery_time_start || '99:99'));
    for (const del of pickupDeliveries) { orderedStops.push({ delivery: del, isPickup: false }); addedDeliveryIds.add(del.id); }
  }
  for (const del of [...activeDeliveries, ...sortedPendingDeliveries]) {
    if (!addedDeliveryIds.has(del.id)) orderedStops.push({ delivery: del, isPickup: false });
  }

  const firstStop = orderedStops[0];
  let cumulativeTime = firstStop ? parseTimeToMinutes(firstStop.delivery.delivery_time_start || '00:00') : currentMinutes;
  const etaMap = new Map();
  for (let i = 0; i < orderedStops.length; i++) {
    const { delivery, isPickup } = orderedStops[i];
    if (isPickup) { const ps = parseTimeToMinutes(delivery.delivery_time_start || '00:00'); if (Number.isFinite(ps) && cumulativeTime < ps) cumulativeTime = ps; }
    const ws = parseTimeToMinutes(delivery.time_window_start || delivery.delivery_time_start || '');
    if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
    etaMap.set(delivery.id, formatMinutesToTime(cumulativeTime));
    cumulativeTime += delivery.extra_time || (isPickup ? 15 : 5);
  }

  const writeBatch = orderedStops.map(({ delivery, isPickup }, i) => {
    const newEta = etaMap.get(delivery.id);
    const updateData = { stop_order: startOrder + i + 1, delivery_time_eta: newEta, isNextDelivery: i === 0 };
    const np = isPickup ? normalizedPickups.find(p => p.id === delivery.id) : null;
    if (np) {
      if (np.delivery_time_start !== delivery.delivery_time_start) updateData.delivery_time_start = np.delivery_time_start;
      if (np.delivery_time_end !== delivery.delivery_time_end) updateData.delivery_time_end = np.delivery_time_end;
    }
    if (!isPickup && delivery.status === 'pending') {
      const nd = normalizedPendingDeliveries.find(d => d.id === delivery.id);
      if (nd) {
        if (nd.delivery_time_start && nd.delivery_time_start !== delivery.delivery_time_start) updateData.delivery_time_start = nd.delivery_time_start;
        if (nd.time_window_start !== delivery.time_window_start) updateData.time_window_start = nd.time_window_start;
        if (nd.time_window_end !== delivery.time_window_end) updateData.time_window_end = nd.time_window_end;
      }
    }
    return { id: delivery.id, data: updateData };
  });

  return {
    success: true, driverId: null, deliveryDate,
    routeChanged: true, optimizedCount: writeBatch.length,
    locationSource: 'future_schedule', usedTimeWindows: true, usedFallbackOrdering: false,
    preserveExistingOrder: false, shouldRefreshPolylines: true,
    orderedDeliveryIds: writeBatch.map(w => w.id),
    optimizedRoute: writeBatch.map((w, i) => ({ deliveryId: w.id, newETA: w.data.delivery_time_eta, stop_order: startOrder + i + 1, isNextDelivery: i === 0 })),
    writeBatch
  };
}

// ─── Unit-number micro-sort ──────────────────────────────────────────────────

function _unitNumberMicroSort(routeStops, patientMap) {
  const GPS_PRECISION = 4;
  const roundGps = (v) => Number(Number(v).toFixed(GPS_PRECISION));
  const processed = new Set();

  for (let i = 0; i < routeStops.length; i++) {
    if (processed.has(i)) continue;
    const stop = routeStops[i];
    const d = stop.delivery;
    if (d.status !== 'in_transit' || !d.patient_id || !String(d.delivery_id || '').toUpperCase().startsWith('DID')) continue;

    const lat = roundGps(stop.lat);
    const lng = roundGps(stop.lng);
    const groupIndices = [i];
    for (let j = i + 1; j < routeStops.length; j++) {
      const s = routeStops[j];
      if (s.delivery.status !== 'in_transit' || !s.delivery.patient_id || !String(s.delivery.delivery_id || '').toUpperCase().startsWith('DID')) continue;
      if (roundGps(s.lat) === lat && roundGps(s.lng) === lng) groupIndices.push(j);
    }
    if (groupIndices.length < 2) { processed.add(i); continue; }

    const group = groupIndices.map(idx => routeStops[idx]);
    group.sort((a, b) => {
      const ua = String(a.delivery.unit_number || patientMap.get(a.delivery.patient_id)?.unit_number || '').trim();
      const ub = String(b.delivery.unit_number || patientMap.get(b.delivery.patient_id)?.unit_number || '').trim();
      const na = parseInt(ua, 10);
      const nb = parseInt(ub, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return ua.localeCompare(ub);
    });
    groupIndices.forEach((idx, pos) => { routeStops[idx] = group[pos]; processed.add(idx); });
  }
}
