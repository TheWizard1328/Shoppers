/* Force Redeploy */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

function isNotFoundError(error) {
  return error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
}

async function processInChunks(items, chunkSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(async (item) => {
      try {
        return await processor(item);
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    }));
    results.push(...chunkResults);
    if (i + chunkSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return results;
}

async function deletePolylinesIfPresent() {
  return 0;
}

function isRateLimitError(error) {
  return error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit exceeded');
}

function round5(value) {
  return Number(Number(value).toFixed(5));
}

function isValidCoordinatePair(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

function getDriverAvailabilityStatus(driverAppUser) {
  const status = String(driverAppUser?.driver_status || '').toLowerCase();
  return {
    status,
    isUnavailable: status === 'off_duty' || status === 'on_break'
  };
}

function isValidPoint(point) {
  return !!point && isValidCoordinatePair(Number(point.lat), Number(point.lon));
}

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
  let lastLat = 0;
  let lastLng = 0;
  let encoded = '';

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
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
}

function combineEncodedPolylines(...encodedPolylines) {
  const mergedPoints = [];

  encodedPolylines.filter(Boolean).forEach((encoded) => {
    const decoded = decodeGooglePolyline(encoded);
    decoded.forEach((point, index) => {
      const previous = mergedPoints[mergedPoints.length - 1];
      if (index === 0 && previous && previous[0] === point[0] && previous[1] === point[1]) return;
      mergedPoints.push(point);
    });
  });

  return mergedPoints.length >= 2 ? encodeGooglePolyline(mergedPoints) : null;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function parseBreadcrumbPolyline(rawBreadcrumbs) {
  if (!rawBreadcrumbs) return null;

  let parsed = rawBreadcrumbs;
  if (typeof rawBreadcrumbs === 'string') {
    try {
      parsed = JSON.parse(rawBreadcrumbs);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(parsed) || parsed.length < 2) return null;

  const coordinates = parsed
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const lat = Number(point[0]);
      const lon = Number(point[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return [lat, lon];
    })
    .filter(Boolean);

  if (coordinates.length < 2) return null;

  let totalMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [prevLat, prevLon] = coordinates[index - 1];
    const [nextLat, nextLon] = coordinates[index];
    totalMeters += distanceMeters(prevLat, prevLon, nextLat, nextLon);
  }

  return {
    encoded_polyline: encodeGooglePolyline(coordinates),
    estimated_distance_km: Number((totalMeters / 1000).toFixed(3)),
    estimated_duration_minutes: null,
    source: 'breadcrumbs'
  };
}

function buildFallbackBreadcrumbs(from, to, timestampSeed = Date.now()) {
  if (!from || !to) return null;
  if (![from.lat, from.lon, to.lat, to.lon].every((value) => Number.isFinite(value))) return null;
  return [
    [Number(from.lat), Number(from.lon), Number(timestampSeed)],
    [Number(to.lat), Number(to.lon), Number(timestampSeed) + 60000]
  ];
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
  if (values[0] !== 1) return [];

  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));

  let latitude = 0;
  let longitude = 0;
  let third = 0;
  const coordinates = [];

  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) {
      third += toSigned(values[i + 2]);
    }
    coordinates.push([latitude / factor, longitude / factor]);
  }

  return coordinates;
}

function makeSegmentKey(driverId, date, from, to) {
  return [
    String(driverId || ''),
    String(date || ''),
    round5(from.lat),
    round5(from.lon),
    round5(to.lat),
    round5(to.lon)
  ].join('|');
}

function makeDeliveryIdSegmentKey(deliveryId) {
  return String(deliveryId || '');
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return round5(a.lat) === round5(b.lat) && round5(a.lon) === round5(b.lon);
}

function findExactCachedSegment(rows, from, to) {
  return null;
}

function buildSegmentDeliveryUpdate(spec, directions, transportMode = 'driving') {
  const from = spec?.actualFrom || spec?.from;
  const to = spec?.actualTo || spec?.to;
  return {
    encoded_polyline: directions?.encoded_polyline || encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
    transport_mode: getNormalizedTravelMode(transportMode, 'driving'),
    estimated_distance_km: directions?.estimated_distance_km ?? null,
    estimated_duration_minutes: directions?.estimated_duration_minutes ?? null
  };
}

function buildStopOrderRepairUpdates(deliveries) {
  const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
  const getCompletionTime = (delivery) => {
    if (!delivery) return Number.MAX_SAFE_INTEGER;
    if (delivery.actual_delivery_time) {
      const time = new Date(delivery.actual_delivery_time).getTime();
      if (Number.isFinite(time)) return time;
    }
    const fallback = delivery.arrival_time || delivery.updated_date || delivery.created_date;
    if (fallback) {
      const time = new Date(fallback).getTime();
      if (Number.isFinite(time)) return time;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  const getStopOrder = (delivery) => {
    const value = Number(delivery?.stop_order);
    return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  };
  const getEta = (delivery) => delivery?.delivery_time_eta || delivery?.delivery_time_start || '99:99';

  const sortedDeliveries = [...(deliveries || [])].sort((a, b) => {
    const isAFinished = finishedStatuses.has(a?.status);
    const isBFinished = finishedStatuses.has(b?.status);
    if (isAFinished && !isBFinished) return -1;
    if (!isAFinished && isBFinished) return 1;

    if (isAFinished && isBFinished) {
      const timeDiff = getCompletionTime(a) - getCompletionTime(b);
      if (timeDiff !== 0) return timeDiff;
      return getStopOrder(a) - getStopOrder(b);
    }

    const isAPending = a?.status === 'pending';
    const isBPending = b?.status === 'pending';
    if (isAPending && !isBPending) return 1;
    if (!isAPending && isBPending) return -1;

    const stopOrderDiff = getStopOrder(a) - getStopOrder(b);
    if (stopOrderDiff !== 0) return stopOrderDiff;

    return getEta(a).localeCompare(getEta(b));
  });

  return sortedDeliveries
    .map((delivery, index) => ({
      ...delivery,
      normalized_stop_order: index + 1
    }))
    .filter((delivery) => Number(delivery?.stop_order) !== delivery.normalized_stop_order)
    .map((delivery) => ({
      id: delivery.id,
      stop_order: delivery.normalized_stop_order
    }));
}

function mergeDeliveryUpdates(deliveries, updatesById) {
  return (deliveries || []).map((delivery) => {
    const update = updatesById.get(delivery.id);
    return update ? { ...delivery, ...update } : delivery;
  });
}

function getNormalizedTravelMode(value, fallback = 'driving') {
  const normalized = String(value || '').toLowerCase();
  return ['driving', 'cycling', 'pedestrian'].includes(normalized) ? normalized : fallback;
}

function groupModeOverrideRanges(stops, getMode) {
  const groups = [];
  let index = 0;

  while (index < stops.length) {
    const mode = getNormalizedTravelMode(getMode(stops[index]), 'driving');
    if (mode === 'driving') {
      index += 1;
      continue;
    }

    const startIndex = index;
    while (index + 1 < stops.length && getNormalizedTravelMode(getMode(stops[index + 1]), 'driving') === mode) {
      index += 1;
    }

    groups.push({
      mode,
      startIndex,
      endIndex: index
    });

    index += 1;
  }

  return groups;
}

function resolveStopTravelMode(stop, explicitMeta, driverAppUser, finishedField = 'transport_mode') {
  const explicitMode = explicitMeta?.transport_mode || explicitMeta?.[finishedField];
  const stopMode = stop?.[finishedField] || stop?.transport_mode;
  const driverMode = driverAppUser?.preferred_travel_mode;
  return getNormalizedTravelMode(explicitMode || stopMode || driverMode, 'driving');
}


function parseBreadcrumbsToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  return null;
}

async function bulkUpdateDeliveries(base44, deliveries, updatesById) {
  if (!(updatesById instanceof Map) || updatesById.size === 0) {
    return deliveries || [];
  }

  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const changedEntries = Array.from(updatesById.entries()).map(([id, update]) => {
    const existing = safeDeliveries.find((delivery) => delivery?.id === id) || {};
    const changed = Object.fromEntries(
      Object.entries(update || {}).filter(([key, value]) => JSON.stringify(existing?.[key] ?? null) !== JSON.stringify(value ?? null))
    );
    return Object.keys(changed).length > 0 ? [id, changed] : null;
  }).filter(Boolean);

  if (changedEntries.length === 0) {
    return safeDeliveries;
  }

  try {
    await processInChunks(changedEntries, 20, async ([id, update]) => {
      return await base44.asServiceRole.entities.Delivery.update(id, update).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });
    });
    return mergeDeliveryUpdates(safeDeliveries, new Map(changedEntries));
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn('[bulkUpdateDeliveries] Rate limit during bulk update');
    }
    throw error;
  }
}

async function markDeliveriesPolylineUpdated(base44, deliveries, value) {
  const finishedDeliveries = (Array.isArray(deliveries) ? deliveries : []).filter((delivery) =>
    delivery?.id && FINISHED_STATUSES.has(delivery.status) && delivery?.PolylineUpdated !== value
  );

  if (finishedDeliveries.length === 0) return;

  await processInChunks(finishedDeliveries, 20, async (delivery) => {
    return await base44.asServiceRole.entities.Delivery.update(delivery.id, {
      PolylineUpdated: value
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
  });
}

function getEdmontonDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

// Haversine distance in km
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pathDistanceKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

function normalizeRawPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lat = Number(point[0]);
    const lng = Number(point[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng, point.length >= 3 ? Number(point[2]) : null];
  }
  return null;
}

function evenlySpacedInterior(points, count) {
  const result = [];
  const step = (points.length - 1) / (count + 1);
  for (let i = 1; i <= count; i++) result.push(points[Math.round(step * i)]);
  return result;
}

function subsampleWaypoints(points, originCoords, destCoords) {
  const origin = originCoords ? [...originCoords] : (points.length > 0 ? points[0] : null);
  const dest = destCoords ? [...destCoords] : (points.length > 0 ? points[points.length - 1] : null);
  if (!origin || !dest) return null;
  if (points.length < 2) return [origin, dest];
  const totalKm = pathDistanceKm(points);
  let interiorCount = 0;
  if (totalKm >= 15) interiorCount = 3;
  else if (totalKm >= 5) interiorCount = 2;
  else if (totalKm >= 1) interiorCount = 1;
  const interior = interiorCount > 0 ? evenlySpacedInterior(points, interiorCount) : [];
  return [origin, ...interior, dest];
}

// Try to build a polyline from stored delivery_route_breadcrumbs (needs >= 3 points)
// or from PendingBreadcrumbLive for this stop. Returns { encoded_polyline, estimated_distance_km } or null.
async function tryResolveLegFromBreadcrumbs(base44, delivery, originCoords, destCoords, pendingBreadcrumbsByStopOrder) {
  let rawPoints = null;
  let source = null;

  // 1. Try delivery.delivery_route_breadcrumbs first
  const stored = delivery.delivery_route_breadcrumbs;
  let storedParsed = stored;
  if (typeof stored === 'string') {
    try { storedParsed = JSON.parse(stored); } catch { storedParsed = null; }
  }
  if (Array.isArray(storedParsed) && storedParsed.length >= 3) {
    rawPoints = storedParsed.map(normalizeRawPoint).filter(Boolean);
    if (rawPoints.length >= 3) source = 'delivery_route_breadcrumbs';
    else rawPoints = null;
  }

  // 2. Fall back to PendingBreadcrumbLive
  if (!rawPoints) {
    const pendingRows = pendingBreadcrumbsByStopOrder.get(Number(delivery.stop_order)) || [];
    const allPending = pendingRows.flatMap(r => Array.isArray(r.breadcrumbs) ? r.breadcrumbs : []);
    const pendingNormalized = allPending.map(normalizeRawPoint).filter(Boolean);
    // sort by timestamp if available
    const sorted = pendingNormalized[0]?.[2] != null
      ? [...pendingNormalized].sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0))
      : pendingNormalized;
    if (sorted.length >= 2) {
      rawPoints = sorted;
      source = 'pending_breadcrumb_live';
    }
  }

  if (!rawPoints || rawPoints.length < 2) return null;

  // Build strategic waypoints anchored to origin/dest
  const originArr = originCoords ? [originCoords.lat, originCoords.lon] : null;
  const destArr = destCoords ? [destCoords.lat, destCoords.lon] : null;
  const waypoints = subsampleWaypoints(rawPoints.map(p => [p[0], p[1]]), originArr, destArr);
  if (!waypoints || waypoints.length < 2) return null;

  const encoded = encodeGooglePolyline(waypoints);
  const distKm = pathDistanceKm(waypoints);

  console.log(`[purgeAndRegeneratePolylines] breadcrumb leg resolved | delivery=${delivery.id} | stop_order=${delivery.stop_order} | source=${source} | points=${waypoints.length} | dist=${distKm.toFixed(2)}km`);

  return {
    encoded_polyline: encoded,
    estimated_distance_km: Number(distKm.toFixed(3)),
    estimated_duration_minutes: null,
    source
  };
}

async function reintegratePendingBreadcrumbLive(base44, driverId, deliveryDate, deliveries) {
  const completedLikeStops = (Array.isArray(deliveries) ? deliveries : [])
    .filter((delivery) => FINISHED_STATUSES.has(String(delivery?.status || '')))
    .sort((a, b) => {
      const aTime = new Date(a?.actual_delivery_time || a?.arrival_time || a?.updated_date || a?.created_date || 0).getTime();
      const bTime = new Date(b?.actual_delivery_time || b?.arrival_time || b?.updated_date || b?.created_date || 0).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return Number(a?.stop_order || 0) - Number(b?.stop_order || 0);
    });

  if (completedLikeStops.length === 0) {
    return { mergedCount: 0, sourceRows: 0, updatedDeliveryIds: [] };
  }

  const relevantStopOrders = [...new Set(
    completedLikeStops
      .map((delivery) => Number(delivery?.stop_order))
      .filter((stopOrder) => Number.isFinite(stopOrder))
  )];

  const pendingRows = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter(
    { driver_id: driverId, delivery_date: deliveryDate },
    '-updated_date',
    50000
  );

  const rowsForDate = pendingRows || [];

  if (rowsForDate.length === 0) {
    return { mergedCount: 0, sourceRows: 0, updatedDeliveryIds: [] };
  }

  const stopWindows = completedLikeStops.map((delivery, index) => {
    const completedAt = new Date(delivery?.actual_delivery_time || delivery?.arrival_time || delivery?.updated_date || delivery?.created_date || 0).getTime();
    const prevCompletedAt = index > 0
      ? new Date(completedLikeStops[index - 1]?.actual_delivery_time || completedLikeStops[index - 1]?.arrival_time || completedLikeStops[index - 1]?.updated_date || completedLikeStops[index - 1]?.created_date || 0).getTime()
      : null;

    return {
      delivery,
      startTs: Number.isFinite(prevCompletedAt) ? prevCompletedAt : null,
      endTs: Number.isFinite(completedAt) ? completedAt : null
    };
  }).filter((window) => Number.isFinite(window.endTs));

  const pointsByDeliveryId = new Map(stopWindows.map((window) => [window.delivery.id, []]));
  const rowsByDeliveryId = new Map(stopWindows.map((window) => [window.delivery.id, []]));

  rowsForDate.forEach((row) => {
    const normalizedPoints = (Array.isArray(row?.breadcrumbs) ? row.breadcrumbs : [])
      .map((point) => {
        if (!Array.isArray(point) || point.length < 2) return null;
        const lat = Number(point[0]);
        const lon = Number(point[1]);
        const ts = Number(point[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ts)) return null;
        return [lat, lon, ts];
      })
      .filter(Boolean)
      .sort((a, b) => a[2] - b[2]);

    if (normalizedPoints.length === 0) return;

    let matchedDeliveryId = null;
    const crumbStartTime = String(row?.delivery_start_time || '');

    if (crumbStartTime) {
      const exactWindow = stopWindows.find((window) => String(window.delivery?.actual_delivery_time || '') === crumbStartTime);
      matchedDeliveryId = exactWindow?.delivery?.id || null;
    }

    if (!matchedDeliveryId) {
      const firstTs = normalizedPoints[0][2];
      const lastTs = normalizedPoints[normalizedPoints.length - 1][2];
      const overlapMatch = stopWindows.find((window) => {
        const startsBeforeWindowEnds = firstTs <= window.endTs;
        const endsAfterWindowStarts = window.startTs == null || lastTs > window.startTs;
        return startsBeforeWindowEnds && endsAfterWindowStarts;
      });

      if (overlapMatch?.delivery?.id) {
        matchedDeliveryId = overlapMatch.delivery.id;
      } else {
        const nearestWindow = stopWindows.reduce((best, window) => {
          const distance = Math.abs((window.endTs || 0) - lastTs);
          if (!best || distance < best.distance) return { deliveryId: window.delivery.id, distance };
          return best;
        }, null);
        matchedDeliveryId = nearestWindow?.deliveryId || null;
      }
    }

    if (!matchedDeliveryId) return;

    pointsByDeliveryId.get(matchedDeliveryId)?.push(...normalizedPoints);
    rowsByDeliveryId.get(matchedDeliveryId)?.push(row);
  });

  let mergedCount = 0;
  let sourceRows = 0;
  const updatedDeliveryIds = [];

  for (const window of stopWindows) {
    const targetDelivery = window.delivery;
    const rawPoints = pointsByDeliveryId.get(targetDelivery.id) || [];
    const rows = rowsByDeliveryId.get(targetDelivery.id) || [];
    if (rawPoints.length === 0 || rows.length === 0) continue;

    const uniquePoints = rawPoints
      .sort((a, b) => a[2] - b[2])
      .filter((point, index, arr) => index === 0 || !(arr[index - 1][0] === point[0] && arr[index - 1][1] === point[1] && arr[index - 1][2] === point[2]));

    const breadcrumbUpdate = {
      delivery_route_breadcrumbs: uniquePoints,
      finished_leg_encoded_polyline: null,
      finished_leg_transport_mode: null,
      PolylineUpdated: true
    };
    const changedBreadcrumbUpdate = Object.fromEntries(
      Object.entries(breadcrumbUpdate).filter(([key, value]) => JSON.stringify(targetDelivery?.[key] ?? null) !== JSON.stringify(value ?? null))
    );
    if (Object.keys(changedBreadcrumbUpdate).length > 0) {
      await base44.asServiceRole.entities.Delivery.update(targetDelivery.id, changedBreadcrumbUpdate);
    }

    await processInChunks(rows, 20, async (row) => {
      return await base44.asServiceRole.entities.PendingBreadcrumbLive.delete(row.id).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });
    });

    mergedCount += uniquePoints.length;
    sourceRows += rows.length;
    updatedDeliveryIds.push(targetDelivery.id);
  }

  return { mergedCount, sourceRows, updatedDeliveryIds };
}

async function getMultiSegmentDirections(base44, segmentSpecs, transportMode = 'driving') {
  const safeSpecs = Array.isArray(segmentSpecs) ? segmentSpecs.filter((segment) => segment?.from && segment?.to) : [];
  if (safeSpecs.length === 0) return [];

  const origin = safeSpecs[0].from;
  const destination = safeSpecs[safeSpecs.length - 1].to;
  const waypoints = safeSpecs.slice(0, -1).map((segment) => ({ lat: segment.to.lat, lng: segment.to.lon }));

  console.log('[purgeAndRegeneratePolylines] getMultiSegmentDirections points', {
    transportMode,
    segmentCount: safeSpecs.length,
    totalPoints: safeSpecs.length + 1,
    origin,
    destination,
    waypointCount: waypoints.length,
    segments: safeSpecs.map((segment, index) => ({
      index,
      from: segment.from,
      to: segment.to
    }))
  });

  try {
    const routeContext = [origin, ...safeSpecs.map((segment) => segment.to)];
    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: origin.lat, lng: origin.lon },
      destination: { lat: destination.lat, lng: destination.lon },
      waypoints,
      routeContext: routeContext.map((point) => ({ lat: point.lat, lng: point.lon })),
      preserveWaypointOrder: true,
      skipSequenceApi: true,
      transportMode,
      caller: 'purgeAndRegeneratePolylines',
      caller_context: { segmentCount: safeSpecs.length }
    });

    const data = response?.data || response || {};
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    const routePolylines = Array.isArray(data?.polylines) ? data.polylines : [];

    console.log('[purgeAndRegeneratePolylines] getMultiSegmentDirections response summary', {
      transportMode,
      requestedSegmentCount: safeSpecs.length,
      sectionCount: sections.length,
      routePolylineCount: routePolylines.length,
      polylineFormat: data?.polyline_format || null,
      sectionShapes: sections.map((section, index) => ({
        index,
        hasEncodedPolyline: !!section?.encoded_polyline,
        encodedPolylineLength: typeof section?.encoded_polyline === 'string' ? section.encoded_polyline.length : 0,
        hasFlexiblePolyline: !!section?.polyline,
        flexiblePolylineLength: typeof section?.polyline === 'string' ? section.polyline.length : 0,
        estimated_distance_km: section?.estimated_distance_km ?? null,
        estimated_duration_minutes: section?.estimated_duration_minutes ?? null,
        waypoint_id: section?.waypoint_id ?? null,
        sequence: section?.sequence ?? null,
        coordinates: Array.isArray(section?.coordinates) ? section.coordinates : null
      })),
      routePolylineLengths: routePolylines.map((polyline, index) => ({
        index,
        length: typeof polyline === 'string' ? polyline.length : 0
      }))
    });

    return safeSpecs.map((segment, index) => {
      const section = sections[index] || null;
      const routePolyline = routePolylines[index] || null;
      let polyline = null;

      if (typeof section?.encoded_polyline === 'string' && section.encoded_polyline) {
        polyline = section.encoded_polyline;
      } else if (section?.polyline && data?.polyline_format === 'flexible') {
        const coords = decodeHereFlexiblePolyline(section.polyline);
        if (coords.length > 1) polyline = encodeGooglePolyline(coords);
      } else if (typeof section?.polyline === 'string' && section.polyline) {
        polyline = section.polyline;
      }

      if (!polyline && typeof routePolyline === 'string' && routePolyline) {
        if (data?.polyline_format === 'flexible') {
          const coords = decodeHereFlexiblePolyline(routePolyline);
          if (coords.length > 1) polyline = encodeGooglePolyline(coords);
        } else {
          polyline = routePolyline;
        }
      }

      if (!polyline) {
        polyline = encodeGooglePolyline([[segment.from.lat, segment.from.lon], [segment.to.lat, segment.to.lon]]);
      }

      console.log('[purgeAndRegeneratePolylines] getMultiSegmentDirections segment mapping', {
        transportMode,
        index,
        requestedFrom: segment.from,
        requestedTo: segment.to,
        sectionSequence: section?.sequence ?? null,
        sectionWaypointId: section?.waypoint_id ?? null,
        sectionCoordinatesCount: Array.isArray(section?.coordinates) ? section.coordinates.length : 0,
        usedSectionEncodedPolyline: !!section?.encoded_polyline,
        usedSectionFlexiblePolyline: !section?.encoded_polyline && !!section?.polyline,
        usedRoutePolyline: !section?.encoded_polyline && !section?.polyline && !!routePolyline,
        finalPolylineLength: typeof polyline === 'string' ? polyline.length : 0,
        estimated_distance_km: section?.estimated_distance_km ?? null,
        estimated_duration_minutes: section?.estimated_duration_minutes ?? null
      });

      return {
        encoded_polyline: polyline,
        estimated_distance_km: section?.estimated_distance_km ?? null,
        estimated_duration_minutes: section?.estimated_duration_minutes ?? null
      };
    });
  } catch (error) {
    console.warn('[purgeAndRegeneratePolylines] Multi-segment directions unavailable, using fallback:', error?.message || error);
    return safeSpecs.map((segment) => ({
      encoded_polyline: encodeGooglePolyline([[segment.from.lat, segment.from.lon], [segment.to.lat, segment.to.lon]]),
      estimated_distance_km: null,
      estimated_duration_minutes: null
    }));
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const {
      driverId,
      deliveryDate,
      orderedDeliveryIds = [],
      completionTime = null,
      recalculateEtas = false,
      currentPosition = null  // Driver's current/home location to prepend to first leg
    } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    if (!Array.isArray(orderedDeliveryIds) || orderedDeliveryIds.length === 0) {
      return Response.json({ error: 'orderedDeliveryIds array is required and must not be empty' }, { status: 400 });
    }

    let deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return Response.json({ error: 'No deliveries found for this driver and date' }, { status: 404 });
    }

    const appUsersForDriverName = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1);
    const driverNameAppUser = Array.isArray(appUsersForDriverName) ? appUsersForDriverName[0] : null;
    const driverDisplayName = driverNameAppUser?.user_name || driverNameAppUser?.full_name || driverId;

    // Filter deliveries to only those in orderedDeliveryIds
    const deliveryById = new Map(deliveries.map(d => [d.id, d]));
    const orderedDeliveries = orderedDeliveryIds
      .map(id => deliveryById.get(id))
      .filter(Boolean);

    if (orderedDeliveries.length === 0) {
      return Response.json({ error: 'None of the provided delivery IDs match this driver/date' }, { status: 400 });
    }

    console.log(`# [purgeAndRegeneratePolylines] START | driver=${driverDisplayName} | date=${deliveryDate} | orderedDeliveries=${orderedDeliveries.length} | totalStops=${deliveries.length}`);

    const patientIds = [...new Set(orderedDeliveries.filter((d) => d?.patient_id).map((d) => d.patient_id))];
    const storeIds = [...new Set(orderedDeliveries.filter((d) => d?.store_id).map((d) => d.store_id))];

    const [patients, stores, appUsers] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000) : [],
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1)
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((stores) => [stores.id, stores]));
    const driverAppUser = Array.isArray(appUsers) ? appUsers[0] : null;
    const driverAvailability = getDriverAvailabilityStatus(driverAppUser);
    const isHistoricalDate = deliveryDate !== getEdmontonDateString();
    if (!driverAppUser) {
      console.log(`[purgeAndRegeneratePolylines] driver record missing | driver=${driverDisplayName} | date=${deliveryDate}`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        deleted: 0,
        created: 0,
        apiCallsMade: 0
      });
    }

    console.log(`# [purgeAndRegeneratePolylines] START | driver=${driverDisplayName} | date=${deliveryDate} | orderedDeliveries=${orderedDeliveries.length} | totalStops=${deliveries?.length || 0} | driver_status=${driverAvailability.status || 'missing'} | historical=${isHistoricalDate} | home_lat=${driverAppUser?.home_latitude} | home_lon=${driverAppUser?.home_longitude}`);

    const getLatLon = (delivery) => {
      if (!delivery) return null;

      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        const lat = Number(patient?.latitude);
        const lon = Number(patient?.longitude);
        if (isValidCoordinatePair(lat, lon)) {
          return { lat, lon };
        }
        console.warn(`[purgeAndRegeneratePolylines] invalid patient coords | delivery=${delivery.id} | patient_id=${delivery.patient_id} | raw_lat=${patient?.latitude} | raw_lon=${patient?.longitude} | lat=${lat} | lon=${lon}`);
      }

      if (delivery.store_id) {
        const store = storeMap.get(delivery.store_id);
        const lat = Number(store?.latitude);
        const lon = Number(store?.longitude);
        if (isValidCoordinatePair(lat, lon)) {
          return { lat, lon };
        }
        console.warn(`[purgeAndRegeneratePolylines] invalid store coords | delivery=${delivery.id} | store_id=${delivery.store_id} | raw_lat=${store?.latitude} | raw_lon=${store?.longitude} | lat=${lat} | lon=${lon}`);
      }

      console.warn(`[purgeAndRegeneratePolylines] no usable coords | delivery=${delivery.id} | patient_id=${delivery.patient_id || ''} | store_id=${delivery.store_id || ''}`);
      return null;
    };



    let apiCallsMade = 0;
    const deliveryUpdatesById = new Map();

    const createdSegments = [];

    if (orderedDeliveries.length > 0) {
      // Build segment specs for the ordered deliveries
      const segmentSpecs = [];

      // Get last finished stop or home as route origin
      const finishedDeliveries = deliveries.filter((d) => FINISHED_STATUSES.has(d?.status))
        .sort((a, b) => {
          const aTime = new Date(a?.actual_delivery_time || a?.updated_date || 0).getTime();
          const bTime = new Date(b?.actual_delivery_time || b?.updated_date || 0).getTime();
          return bTime - aTime;
        });
      const lastFinishedStop = finishedDeliveries.length > 0 ? finishedDeliveries[0] : null;
      const routeOrigin = lastFinishedStop
        ? getLatLon(lastFinishedStop)
        : (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
          ? { lat: Number(driverAppUser.home_latitude), lon: Number(driverAppUser.home_longitude) }
          : null);

      for (let index = 0; index < orderedDeliveries.length; index += 1) {
        const delivery = orderedDeliveries[index];
        const from = index === 0 && currentPosition && isValidCoordinatePair(Number(currentPosition.lat), Number(currentPosition.lon))
          ? currentPosition
          : (index === 0 ? routeOrigin : getLatLon(orderedDeliveries[index - 1]));
        const to = getLatLon(delivery);

        if (!from || !to) continue;

        segmentSpecs.push({
          delivery,
          from,
          to,
          transportMode: getNormalizedTravelMode(delivery?.transport_mode || driverAppUser?.preferred_travel_mode, 'driving')
        });
      }

      const finishedSegmentSpecs = segmentSpecs;

      // Single call to get polylines for all segments in ordered sequence
      if (finishedSegmentSpecs.length > 0) {
        const groupedByMode = [];
        let currentGroup = [finishedSegmentSpecs[0]];
        for (let index = 1; index < finishedSegmentSpecs.length; index += 1) {
          const prev = finishedSegmentSpecs[index - 1];
          const curr = finishedSegmentSpecs[index];
          if (getNormalizedTravelMode(prev.transportMode) === getNormalizedTravelMode(curr.transportMode)) currentGroup.push(curr);
          else {
            groupedByMode.push(currentGroup);
            currentGroup = [curr];
          }
        }
        if (currentGroup.length > 0) groupedByMode.push(currentGroup);

        for (const group of groupedByMode) {
          const mode = getNormalizedTravelMode(group[0]?.transportMode, 'driving');
          const groupedDirections = await getMultiSegmentDirections(base44, group.map((segment) => ({ from: segment.from, to: segment.to })), mode);
          apiCallsMade += 1;
          group.forEach((segment, index) => {
            let polyline = (groupedDirections[index] || {})?.encoded_polyline || null;
            

            
            deliveryUpdatesById.set(segment.delivery.id, {
              encoded_polyline: polyline,
              transport_mode: segment.transportMode,
              estimated_distance_km: (groupedDirections[index] || {})?.estimated_distance_km ?? null,
              estimated_duration_minutes: (groupedDirections[index] || {})?.estimated_duration_minutes ?? null
            });
          });
        }
        console.log(`[purgeAndRegeneratePolylines] Generated polylines for ${finishedSegmentSpecs.length} segments using ${groupedByMode.length} HERE call(s)`);
      }
    }

    if (deliveryUpdatesById.size > 0) {
      console.log(`# [purgeAndRegeneratePolylines] Updating deliveries with polylines | driver=${driverDisplayName} | date=${deliveryDate} | count=${deliveryUpdatesById.size}`);
      deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
    }

    if (false) {
      // Dead code block removed - only orderedDeliveryIds mode is supported
      if (false && orderedDeliveries.length > 0) {
        const segmentSpecs = [];
        const seen = new Set();

        const pushSegment = (from, to, force = false, transportMode = 'driving') => {
          if (!isValidPoint(from) || !isValidPoint(to)) return;
          const key = makeSegmentKey(driverId, deliveryDate, from, to);
          if (seen.has(key)) return;
          seen.add(key);
          segmentSpecs.push({ from, to, force, transportMode: getNormalizedTravelMode(transportMode, 'driving') });
        };

        const currentLat = Number(driverAppUser?.current_latitude);
        const currentLon = Number(driverAppUser?.current_longitude);
        const homeLat = Number(driverAppUser?.home_latitude);
        const homeLon = Number(driverAppUser?.home_longitude);
        const hasHomeCoords = isValidCoordinatePair(homeLat, homeLon);
        const isToday = deliveryDate === getEdmontonDateString();
        const lockHomeOrigin = explicitRouteOrigin === 'home' && hasHomeCoords;
        const lockHomeDestination = explicitRouteDestination === 'home' && hasHomeCoords;
        const explicitResolvedOrigin = isValidCoordinatePair(Number(resolvedOriginCoords?.lat), Number(resolvedOriginCoords?.lon))
          ? { lat: Number(resolvedOriginCoords.lat), lon: Number(resolvedOriginCoords.lon) }
          : null;

        const useLastFinishedOrigin = explicitRouteOrigin === 'last_finished_stop';
        const originFromFinishedStop = explicitResolvedOrigin || (lockHomeOrigin
          ? { lat: homeLat, lon: homeLon }
          : (useLastFinishedOrigin || latestFinishedStop ? getLatLon(latestFinishedStop) : null));
        const routeAlreadyStarted = useLastFinishedOrigin || !!explicitResolvedOrigin || !!latestFinishedStop;
        const useDriverLocationAsOrigin = !explicitStopOrderIds.length && !useLastFinishedOrigin && !explicitResolvedOrigin && scope === 'active_only' && firstActive && isToday && isValidCoordinatePair(currentLat, currentLon);

        if (useDriverLocationAsOrigin && !originFromFinishedStop) {
          const firstStop = activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0];
          const firstMeta = explicitStopMetaById.get(firstStop?.id) || null;
          pushSegment({ lat: currentLat, lon: currentLon }, firstActive, false, resolveStopTravelMode(firstStop, firstMeta, driverAppUser, 'transport_mode'));
        }

        for (let index = 0; index < activeStops.length; index += 1) {
          const stop = activeStops[index];
          const previousActiveStop = activeStops[index - 1];
          const from = index === 0
            ? (explicitResolvedOrigin
              || originFromFinishedStop
              || (!routeAlreadyStarted && hasHomeCoords ? { lat: homeLat, lon: homeLon } : null))
            : (previousActiveStop ? getLatLon(previousActiveStop) : null)
              || originFromFinishedStop
              || (!routeAlreadyStarted && hasHomeCoords ? { lat: homeLat, lon: homeLon } : null);
          const to = getLatLon(stop);
          const stopMeta = explicitStopMetaById.get(stop?.id) || null;
          const transportMode = resolveStopTravelMode(stop, stopMeta, driverAppUser, 'transport_mode');
          pushSegment(from, to, !!explicitStopOrderIds.length, transportMode);
        }

        const lastActive = getLatLon(activeStops[activeStops.length - 1]);

        if ((lockHomeDestination || explicitOrderedStopsOnly) && lastActive && hasHomeCoords) {
          const lastStop = activeStops[activeStops.length - 1];
          const lastMeta = explicitStopMetaById.get(lastStop?.id) || null;
          pushSegment(lastActive, { lat: homeLat, lon: homeLon }, true, resolveStopTravelMode(lastStop, lastMeta, driverAppUser, 'transport_mode'));
        } else if (!explicitStopOrderIds.length) {
          const shouldAddHomeStartLeg = hasHomeCoords && firstActive && !originFromFinishedStop;
          if (shouldAddHomeStartLeg) {
            const firstStop = activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0];
            const firstMeta = explicitStopMetaById.get(firstStop?.id) || null;
            pushSegment({ lat: homeLat, lon: homeLon }, firstActive, true, resolveStopTravelMode(firstStop, firstMeta, driverAppUser, 'transport_mode'));
          }

          if (hasHomeCoords && lastActive) {
            const lastStop = activeStops[activeStops.length - 1];
            const lastMeta = explicitStopMetaById.get(lastStop?.id) || null;
            pushSegment(lastActive, { lat: homeLat, lon: homeLon }, true, resolveStopTravelMode(lastStop, lastMeta, driverAppUser, 'transport_mode'));
          }
        }

        const segmentsToKeep = new Set();
        const uncachedSegments = [...segmentSpecs];
        const directionsBySegmentKey = new Map();

        if (reuseProvidedPolylines) {
          uncachedSegments.forEach((spec) => {
            const matchingStop = activeStops.find((stop) => {
              const stopCoords = getLatLon(stop);
              return stop?.id && stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
            });
            const provided = matchingStop?.id ? reusablePolylineMetaById.get(matchingStop.id) : null;
            if (provided?.encoded_polyline) {
              directionsBySegmentKey.set(
                makeSegmentKey(driverId, deliveryDate, spec.from, spec.to),
                {
                  encoded_polyline: provided.encoded_polyline,
                  estimated_distance_km: provided.estimated_distance_km ?? null,
                  estimated_duration_minutes: provided.estimated_duration_minutes ?? null
                }
              );
            }
          });
        }

        const remainingUncachedSegments = uncachedSegments.filter((spec) => !directionsBySegmentKey.has(makeSegmentKey(driverId, deliveryDate, spec.from, spec.to)));

        const segmentGroups = [];
        if (remainingUncachedSegments.length > 0) {
          let currentGroup = [remainingUncachedSegments[0]];
          for (let index = 1; index < remainingUncachedSegments.length; index += 1) {
            const previous = remainingUncachedSegments[index - 1];
            const current = remainingUncachedSegments[index];
            const sameMode = getNormalizedTravelMode(previous?.transportMode, 'driving') === getNormalizedTravelMode(current?.transportMode, 'driving');
            const isContinuous = samePoint(previous?.to, current?.from);
            if (sameMode && isContinuous) {
              currentGroup.push(current);
            } else {
              segmentGroups.push(currentGroup);
              currentGroup = [current];
            }
          }
          if (currentGroup.length > 0) {
            segmentGroups.push(currentGroup);
          }
        }

        for (const group of segmentGroups) {
          const primaryTransportMode = getNormalizedTravelMode(group[0]?.transportMode, 'driving');
          const groupedDirections = await getMultiSegmentDirections(
            base44,
            group.map((spec) => ({ from: spec.from, to: spec.to })),
            primaryTransportMode
          );
          apiCallsMade += 1;
          group.forEach((spec, index) => {
            directionsBySegmentKey.set(
              makeSegmentKey(driverId, deliveryDate, spec.from, spec.to),
              groupedDirections[index] || null
            );
          });
        }

        uncachedSegments.forEach((spec) => {
          const directions = directionsBySegmentKey.get(makeSegmentKey(driverId, deliveryDate, spec.from, spec.to));
          const matchingStop = activeStops.find((stop) => {
            const stopCoords = getLatLon(stop);
            return stop?.id && stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
          });
          if (matchingStop) {
            const matchingStopCoords = getLatLon(matchingStop);
            deliveryUpdatesById.set(matchingStop.id, {
              ...(deliveryUpdatesById.get(matchingStop.id) || {}),
              ...buildSegmentDeliveryUpdate({ ...spec, actualTo: matchingStopCoords || spec.to }, directions, spec.transportMode),
              travel_dist: directions?.estimated_distance_km ?? null
            });
          }
          if (matchingStop?.id) {
            const matchingStopCoords = getLatLon(matchingStop);
            createdSegments.push({
              id: matchingStop.id,
              ...buildSegmentDeliveryUpdate({ ...spec, actualTo: matchingStopCoords || spec.to }, directions, spec.transportMode)
            });
          }
        });

        deletedPolylineCount = 0;

        if (createdSegments.length > 0) {
          createdSegments.forEach((segment) => {
            deliveryUpdatesById.set(segment.id, {
              ...(deliveryUpdatesById.get(segment.id) || {}),
              encoded_polyline: segment.encoded_polyline,
              transport_mode: segment.transport_mode || 'driving',
              segment_origin_lat: segment.segment_origin_lat,
              segment_origin_lon: segment.segment_origin_lon,
              segment_dest_lat: segment.segment_dest_lat,
              segment_dest_lon: segment.segment_dest_lon,
              estimated_distance_km: segment.estimated_distance_km,
              estimated_duration_minutes: segment.estimated_duration_minutes
            });
          });
        }

        const activeStopIds = new Set(activeStops.map((stop) => stop?.id).filter(Boolean));
        deliveries.filter((delivery) => delivery?.id && activeStopIds.has(delivery.id)).forEach((delivery) => {
          if (deliveryUpdatesById.has(delivery.id)) return;
          deliveryUpdatesById.set(delivery.id, {
            encoded_polyline: null,
            transport_mode: null,
            segment_origin_lat: null,
            segment_origin_lon: null,
            segment_dest_lat: null,
            segment_dest_lon: null,
            estimated_distance_km: null,
            estimated_duration_minutes: null
          });
        });

        // CRITICAL: Always clear polylines from pending stops — they must never have
        // a polyline (their coords must not be used as origins for subsequent stops).
        const pendingStopIds = new Set(pendingStops.map((stop) => stop?.id).filter(Boolean));
        pendingStops.forEach((stop) => {
          if (!stop?.id) return;
          deliveryUpdatesById.set(stop.id, {
            encoded_polyline: null,
            transport_mode: null,
            segment_origin_lat: null,
            segment_origin_lon: null,
            segment_dest_lat: null,
            segment_dest_lon: null,
            estimated_distance_km: null,
            estimated_duration_minutes: null
          });
        });
        if (pendingStops.length > 0) {
          console.log(`# [purgeAndRegeneratePolylines] Cleared polylines from ${pendingStops.length} pending stop(s) | driver=${driverDisplayName} | date=${deliveryDate}`);
        }

        if (deliveryUpdatesById.size > 0) {
          console.log(`# [purgeAndRegeneratePolylines] BEFORE active bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0} | updateCount=${deliveryUpdatesById.size}`);
          deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
          deliveries = await base44.asServiceRole.entities.Delivery.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          }, 'stop_order', 50000);
          console.log(`# [purgeAndRegeneratePolylines] AFTER active bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0} | updateCount=${deliveryUpdatesById.size}`);
        }
      } else {
        const homeLat = Number(driverAppUser?.home_latitude);
        const homeLon = Number(driverAppUser?.home_longitude);
        const firstFinishedStop = finishedStops[0] || null;
        const hasHomeCoords = isValidCoordinatePair(homeLat, homeLon);
        const completedRouteHomeSegment = [];

        if (hasHomeCoords && firstFinishedStop) {
          const firstFinishedCoords = getLatLon(firstFinishedStop);
          if (firstFinishedCoords) {
            completedRouteHomeSegment.push({
              from: { lat: homeLat, lon: homeLon },
              to: firstFinishedCoords,
              force: true,
              transportMode: getNormalizedTravelMode(firstFinishedStop?.finished_leg_transport_mode || firstFinishedStop?.transport_mode || driverAppUser?.preferred_travel_mode, 'driving')
            });
          }
        }

        if (latestFinishedStop && hasHomeCoords) {
          const latestFinishedCoords = getLatLon(latestFinishedStop);
          if (latestFinishedCoords) {
            completedRouteHomeSegment.push({
              from: latestFinishedCoords,
              to: { lat: homeLat, lon: homeLon },
              force: true,
              transportMode: getNormalizedTravelMode(latestFinishedStop?.finished_leg_transport_mode || latestFinishedStop?.transport_mode || driverAppUser?.preferred_travel_mode, 'driving')
            });
          }
        }

        const segmentsToKeep = new Set();
        if (preservedType1Row) {
          segmentsToKeep.add(preservedType1Row.id);
        }

        const cachedSegments = [];
        const uncachedSegments = [];

        for (const spec of completedRouteHomeSegment) {
          const cachedSegment = !spec.force ? findExactCachedSegment(existingPolylines, spec.from, spec.to) : null;
          if (cachedSegment) {
            cachedSegments.push({ spec, cachedSegment });
          } else {
            uncachedSegments.push(spec);
          }
        }

        cachedSegments.forEach(({ cachedSegment }) => {
          segmentsToKeep.add(cachedSegment.id);
        });

        const uncachedDirectionsBySegmentKey = new Map();
        const completedSegmentGroups = [];
        if (uncachedSegments.length > 0) {
          let currentGroup = [uncachedSegments[0]];
          for (let index = 1; index < uncachedSegments.length; index += 1) {
            const previous = uncachedSegments[index - 1];
            const current = uncachedSegments[index];
            const sameMode = getNormalizedTravelMode(previous?.transportMode, 'driving') === getNormalizedTravelMode(current?.transportMode, 'driving');
            const isContinuous = samePoint(previous?.to, current?.from);
            if (sameMode && isContinuous) {
              currentGroup.push(current);
            } else {
              completedSegmentGroups.push(currentGroup);
              currentGroup = [current];
            }
          }
          if (currentGroup.length > 0) completedSegmentGroups.push(currentGroup);
        }

        for (const group of completedSegmentGroups) {
          const primaryTransportMode = getNormalizedTravelMode(group[0]?.transportMode, 'driving');
          const groupedDirections = await getMultiSegmentDirections(
            base44,
            group.map((spec) => ({ from: spec.from, to: spec.to })),
            primaryTransportMode
          );
          apiCallsMade += 1;
          group.forEach((spec, index) => {
            uncachedDirectionsBySegmentKey.set(
              makeSegmentKey(driverId, deliveryDate, spec.from, spec.to),
              groupedDirections[index] || null
            );
          });
        }

        uncachedSegments.forEach((spec) => {
          const directions = uncachedDirectionsBySegmentKey.get(makeSegmentKey(driverId, deliveryDate, spec.from, spec.to));
          const matchingStop = deliveries.find((stop) => {
            const stopCoords = getLatLon(stop);
            return stop?.id && stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
          });
          if (matchingStop?.id) {
            createdSegments.push({
              id: matchingStop.id,
              transport_mode: getNormalizedTravelMode(spec.transportMode, 'driving'),
              encoded_polyline: directions?.encoded_polyline || encodeGooglePolyline([[spec.from.lat, spec.from.lon], [spec.to.lat, spec.to.lon]]),
              segment_origin_lat: round5(spec.from.lat),
              segment_origin_lon: round5(spec.from.lon),
              segment_dest_lat: round5(spec.to.lat),
              segment_dest_lon: round5(spec.to.lon),
              estimated_distance_km: directions?.estimated_distance_km ?? null,
              estimated_duration_minutes: directions?.estimated_duration_minutes ?? null
            });
          }
        });

        const allowedCompletedSegmentKeys = new Set(completedRouteHomeSegment.map((spec) => makeSegmentKey(driverId, deliveryDate, spec.from, spec.to)));
        const existingPolylineIds = new Set((existingPolylines || []).map((row) => row?.id).filter(Boolean));
        const rowsToDelete = (existingPolylines || []).filter((row) => {
          if (!existingPolylineIds.has(row?.id)) return false;
          if (segmentsToKeep.has(row.id)) return false;
          const rowKey = makeSegmentKey(driverId, deliveryDate, { lat: row?.segment_origin_lat, lon: row?.segment_origin_lon }, { lat: row?.segment_dest_lat, lon: row?.segment_dest_lon });
          return !allowedCompletedSegmentKeys.has(rowKey);
        });
        if (!bypassPolylineDelete && rowsToDelete.length > 0) {
          deletedPolylineCount = await deletePolylinesIfPresent(base44, rowsToDelete);
          existingPolylines = (existingPolylines || []).filter((row) => !rowsToDelete.some((candidate) => candidate.id === row?.id));
        } else {
          deletedPolylineCount = 0;
        }

        if (createdSegments.length > 0) {
          await processInChunks(createdSegments, 20, (segment) =>
            base44.asServiceRole.entities.Delivery.update(segment.id, {
              encoded_polyline: segment.encoded_polyline,
              transport_mode: segment.transport_mode || 'driving',
              segment_origin_lat: segment.segment_origin_lat,
              segment_origin_lon: segment.segment_origin_lon,
              segment_dest_lat: segment.segment_dest_lat,
              segment_dest_lon: segment.segment_dest_lon,
              estimated_distance_km: segment.estimated_distance_km,
              estimated_duration_minutes: segment.estimated_duration_minutes
            }).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
        }
      }
    }

    let finalDeliveries = deliveries;

    // Recalculate ETAs if requested
    let etasRecalculated = false;
    if (recalculateEtas && completionTime) {
      const completionTimeMs = (() => {
        const parts = String(completionTime || '00:00').split(':');
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        return h * 60 + m;
      })();

      let cumulativeMinutes = completionTimeMs;
      const etaUpdates = new Map();

      // If driver is >100m from route origin, add travel time from current location
      const currentLat = Number(driverAppUser?.current_latitude);
      const currentLon = Number(driverAppUser?.current_longitude);
      const routeOriginLat = routeOrigin ? Number(routeOrigin.lat) : null;
      const routeOriginLon = routeOrigin ? Number(routeOrigin.lon) : null;

      if (isValidCoordinatePair(currentLat, currentLon) && isValidCoordinatePair(routeOriginLat, routeOriginLon)) {
        const distanceMetersFromOrigin = distanceMeters(currentLat, currentLon, routeOriginLat, routeOriginLon);
        if (distanceMetersFromOrigin > 100) {
          // Estimate ~60 km/h average speed = 1 km per minute
          const estimatedTravelMinutes = Math.ceil(distanceMetersFromOrigin / 1000);
          cumulativeMinutes += estimatedTravelMinutes;
          console.log(`[purgeAndRegeneratePolylines] ETA adjustment for driver position | distance=${distanceMetersFromOrigin.toFixed(0)}m | extraMinutes=${estimatedTravelMinutes}`);
        }
      }

      orderedDeliveries.forEach((delivery) => {
        const travelDuration = Number(delivery?.estimated_duration_minutes) || 0;
        const serviceTime = Number(delivery?.extra_time) || 5;
        cumulativeMinutes += travelDuration + serviceTime;

        const hours = Math.floor(cumulativeMinutes / 60) % 24;
        const minutes = cumulativeMinutes % 60;
        const etaStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        etaUpdates.set(delivery.id, { delivery_time_eta: etaStr });
      });

      if (etaUpdates.size > 0) {
        console.log(`# [purgeAndRegeneratePolylines] Recalculating ETAs | driver=${driverDisplayName} | date=${deliveryDate} | startTime=${completionTime} | deliveriesToUpdate=${etaUpdates.size}`);
        await processInChunks(
          Array.from(etaUpdates.entries()),
          20,
          async ([deliveryId, update]) => {
            return await base44.asServiceRole.entities.Delivery.update(deliveryId, update).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            });
          }
        );
        etasRecalculated = true;
      }
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      orderedDeliveryIds: orderedDeliveryIds.length,
      apiCallsMade,
      etasRecalculated,
      polylineCount: deliveryUpdatesById.size
    });
  } catch (error) {
    console.error('[purgeAndRegeneratePolylines] Error:', error?.message || error);

    if (isNotFoundError(error) || isRateLimitError(error)) {
      return Response.json({
        success: false,
        skipped: true,
        error: error?.message || 'Skipped'
      });
    }

    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});