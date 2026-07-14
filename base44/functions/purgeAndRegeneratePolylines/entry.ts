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
    // No inter-chunk sleep — rate limits are handled by error catch, not a fixed delay
  }
  return results;
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
  return JSON.stringify([
    [Number(from.lat), Number(from.lon), Number(timestampSeed)],
    [Number(to.lat), Number(to.lon), Number(timestampSeed) + 60000]
  ]);
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

function samePoint(a, b) {
  if (!a || !b) return false;
  return round5(a.lat) === round5(b.lat) && round5(a.lon) === round5(b.lon);
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
  // For pending stops: do NOT inherit the driver's preferred_travel_mode — a pending stop
  // hasn't started yet, so stamping the driver's current cycling/pedestrian mode on it
  // would incorrectly mark a new driving stop as cycling. Default to 'driving' instead.
  // Only completed/active stops get the driver's preferred mode as a fallback, since those
  // legs have already been travelled and the mode was set at the time of dispatch.
  const isPending = stop?.status === 'pending';
  const driverMode = isPending ? 'driving' : driverAppUser?.preferred_travel_mode;
  return getNormalizedTravelMode(explicitMode || stopMode || driverMode, 'driving');
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

/**
 * Returns true if delivery_id is an ISP or ISD inter-store delivery.
 * Format: ISP-{timestamp}-{fromPhone}-{toPhone}  or  ISD-{timestamp}-{fromPhone}-{toPhone}
 */
function isInterStoreDeliveryId(delivery_id) {
  if (!delivery_id) return false;
  const upper = String(delivery_id).toUpperCase();
  return upper.startsWith('ISP-') || upper.startsWith('ISD-');
}

/**
 * Extracts the "from" phone digits from an ISP/ISD delivery_id.
 * ISP → parts[2] (pickup/from store phone)
 * ISD → parts[3] (assigned/to store phone)
 */
function extractFromPhoneFromDeliveryIdStr(delivery_id) {
  if (!delivery_id) return null;
  const upper = String(delivery_id).toUpperCase();
  const parts = String(delivery_id).split('-');
  if (parts.length < 3) return null;
  if (upper.startsWith('ISP-')) {
    return parts[2] ? String(parts[2]).replace(/\D/g, '') : null;
  }
  if (upper.startsWith('ISD-')) {
    return parts[3] ? String(parts[3]).replace(/\D/g, '') : null;
  }
  return null;
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
      delivery_route_breadcrumbs: JSON.stringify(uniquePoints),
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

  console.log(`[purgeAndRegeneratePolylines] getMultiSegmentDirections mode=${transportMode} segments=${safeSpecs.length}`);
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

    console.log(`[purgeAndRegeneratePolylines] getMultiSegmentDirections response: ${sections.length} sections, format=${data?.polyline_format || 'encoded'}`);
    let anySegmentFellBackToCrowFlies = false;
    const mappedSegments = safeSpecs.map((segment, index) => {
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
        anySegmentFellBackToCrowFlies = true;
      }

      return {
        encoded_polyline: polyline,
        estimated_distance_km: section?.estimated_distance_km ?? null,
        estimated_duration_minutes: section?.estimated_duration_minutes ?? null
      };
    });
    mappedSegments.usedFallbackPolyline = anySegmentFellBackToCrowFlies || data?.usedFallbackPolyline === true || data?.polyline_format === 'fallback';
    return mappedSegments;
  } catch (error) {
    console.warn('[purgeAndRegeneratePolylines] Multi-segment directions unavailable, using fallback:', error?.message || error);
    const fallbackSegments = safeSpecs.map((segment) => ({
      encoded_polyline: encodeGooglePolyline([[segment.from.lat, segment.from.lon], [segment.to.lat, segment.to.lon]]),
      estimated_distance_km: null,
      estimated_duration_minutes: null
    }));
    fallbackSegments.usedFallbackPolyline = true;
    return fallbackSegments;
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
      scope = 'active_only',
      reason = 'manual',
      routeSource = 'polylines',
      bypassDriverStatus = false,
      bypassPolylineUpdated = false,
      routeStopOrder = [],
      orderedStopsWithTransportMode = [],
      explicitOrderedStopsOnly = false,
      explicitRouteOrigin = null,
      explicitRouteDestination = null,
      resolvedOriginCoords = null,
      bypassPolylineDelete = false,
      reuseProvidedPolylines = false,
      sourcePage = null
    } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    // Tracks whether any HERE call in this run fell back to a straight-line
    // ("crow-flies") polyline instead of a real routed one, so the caller/UI
    // can surface a degraded-optimization signal instead of a silent success.
    let anyFallbackPolylineUsed = false;

    if (sourcePage && sourcePage !== 'Dashboard') {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'non_dashboard_page',
        scope,
        deleted: 0,
        created: 0,
        apiCallsMade: 0,
        repairedStopOrders: 0
      });
    }

    let deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const appUsersForDriverName = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1);
    const driverNameAppUser = Array.isArray(appUsersForDriverName) ? appUsersForDriverName[0] : null;
    const driverDisplayName = driverNameAppUser?.user_name || driverNameAppUser?.full_name || driverId;

    const stopOrderRepairUpdates = buildStopOrderRepairUpdates(deliveries);
    if (stopOrderRepairUpdates.length > 0) {
      const stopOrderUpdateMap = new Map(stopOrderRepairUpdates.map((update) => [update.id, { stop_order: update.stop_order }]));
      console.log(`# [purgeAndRegeneratePolylines] REPAIR stop_order BEFORE route build | driver=${driverDisplayName} | date=${deliveryDate} | repairs=${stopOrderRepairUpdates.length}`);
      deliveries = await bulkUpdateDeliveries(base44, deliveries, stopOrderUpdateMap);
      deliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000);
    }

    // ── Force-regen guard ──────────────────────────────────────────────────
    // When bypassPolylineUpdated=true (Regenerate Polylines FAB) we pre-null
    // the polyline fields on every in-memory delivery record so that
    // bulkUpdateDeliveries change-detection always finds a real diff and never
    // silently skips a stop whose encoded_polyline or PolylineUpdated value
    // hasn't actually changed.  We also stamp PolylineUpdated=true normally
    // at the end of the run — bypassPolylineUpdated just means "don't skip
    // the write because the value looks the same".
    if (bypassPolylineUpdated && Array.isArray(deliveries)) {
      deliveries = deliveries.map((d) => d ? {
        ...d,
        encoded_polyline: null,
        finished_leg_encoded_polyline: null,
        PolylineUpdated: null,
      } : d);
    }

    let existingPolylines = [];

    const structuralReason = ['stops_added', 'stops_deleted', 'route_reordered', 'manual', 'manual_breadcrumbs'];
    if (!structuralReason.includes(reason)) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'non_structural_request',
        scope,
        deleted: 0,
        created: 0,
        apiCallsMade: 0,
        repairedStopOrders: stopOrderRepairUpdates.length
      });
    }

    console.log('existingPolylines:', existingPolylines);
    console.log('Type of existingPolylines:', typeof existingPolylines, Array.isArray(existingPolylines));

    const previousGenerationCount = Array.isArray(existingPolylines) && existingPolylines.length
      ? Math.max(...existingPolylines.map((row) => Number(row?.daily_generation_count || 0)))
      : 0;

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      if (scope !== 'completed_only' && scope !== 'all') {
        await processInChunks(deliveries, 20, (delivery) =>
          base44.asServiceRole.entities.Delivery.update(delivery.id, {
            encoded_polyline: null,
            transport_mode: null,
            segment_origin_lat: null,
            segment_origin_lon: null,
            segment_dest_lat: null,
            segment_dest_lon: null,
            estimated_distance_km: null,
            estimated_duration_minutes: null
          }).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          })
        );
      }

      return Response.json({
        success: true,
        scope,
        deleted: existingPolylines?.length || 0,
        created: 0,
        apiCallsMade: 0,
        segments: [],
        clearedFinishedLegs: 0,
        regeneratedFinishedLegs: 0,
        repairedStopOrders: 0
      });
    }

    const patientIds = [...new Set(deliveries.filter((d) => d?.patient_id).map((d) => d.patient_id))];
    const storeIds = [...new Set(deliveries.filter((d) => d?.store_id).map((d) => d.store_id))];

    // ISP stops: deliveries whose delivery_id starts with ISP- or ISD- and have no patient_id
    const ispDeliveries = deliveries.filter((d) => !d.patient_id && isInterStoreDeliveryId(d.delivery_id));

    const hasIspStops = ispDeliveries.length > 0;

    const [patients, stores, appUsers, allInterStoreLocations] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000) : [],
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1),
      hasIspStops ? base44.asServiceRole.entities.InterStoreLocation.list() : [],
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

    // Build phone → InterStoreLocation map (strip non-digits for reliable matching)
    const stripPhone = (s) => String(s || '').replace(/\D/g, '');
    // Map: phone digits → InterStoreLocation record
    const ispPhoneToLocation = new Map();
    (allInterStoreLocations || []).forEach((loc) => {
      const digits = stripPhone(loc.store_phone);
      if (digits) ispPhoneToLocation.set(digits, loc);
    });

    // ispSourceMap: delivery.id → resolved { store_latitude, store_longitude }
    // We extract the "from" phone from the delivery_id directly (parts[2] for ISP, parts[3] for ISD)
    const ispSourceMap = new Map();
    for (const delivery of ispDeliveries) {
      const fromPhone = extractFromPhoneFromDeliveryIdStr(delivery.delivery_id);
      if (!fromPhone) {
        console.warn(`[purgeAndRegeneratePolylines] ISP delivery has no parseable from-phone | delivery=${delivery.id} | delivery_id=${delivery.delivery_id}`);
        continue;
      }
      const loc = ispPhoneToLocation.get(fromPhone);
      if (loc?.store_latitude && loc?.store_longitude) {
        ispSourceMap.set(delivery.id, { store_latitude: loc.store_latitude, store_longitude: loc.store_longitude, source: 'interstore_location' });
        console.log(`[purgeAndRegeneratePolylines] ISP coords resolved via phone | delivery=${delivery.id} | phone=${fromPhone} | lat=${loc.store_latitude} | lon=${loc.store_longitude}`);
        continue;
      }
      // Fallback: match phone against Store entities
      const allStoresArr = Array.from(storeMap.values());
      const matchedStore = allStoresArr.find((s) => stripPhone(s.phone) === fromPhone && s.latitude && s.longitude);
      if (matchedStore) {
        ispSourceMap.set(delivery.id, { store_latitude: matchedStore.latitude, store_longitude: matchedStore.longitude, source: 'store_phone_match' });
        console.log(`[purgeAndRegeneratePolylines] ISP coords resolved via store phone fallback | delivery=${delivery.id} | store=${matchedStore.name}`);
        // Backfill InterStoreLocation if we have a record
        if (loc?.id) {
          base44.asServiceRole.entities.InterStoreLocation.update(loc.id, { store_latitude: matchedStore.latitude, store_longitude: matchedStore.longitude }).catch(() => null);
        }
        continue;
      }
      console.warn(`[purgeAndRegeneratePolylines] ISP coords unresolvable | delivery=${delivery.id} | phone=${fromPhone}`);
    }
    const driverAppUser = Array.isArray(appUsers) ? appUsers[0] : null;
    const driverAvailability = getDriverAvailabilityStatus(driverAppUser);
    const isHistoricalDate = deliveryDate !== getEdmontonDateString();
    if (!driverAppUser) {
      console.log(`[purgeAndRegeneratePolylines] driver record missing | driver=${driverDisplayName} | date=${deliveryDate}`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        scope,
        deleted: 0,
        created: 0,
        apiCallsMade: 0,
        repairedStopOrders: stopOrderRepairUpdates.length
      });
    }
    if (driverAvailability.isUnavailable && !isHistoricalDate && !bypassDriverStatus) {
      console.log(`[purgeAndRegeneratePolylines] driver unavailable | driver=${driverDisplayName} | status=${driverAvailability.status || 'missing'} | date=${deliveryDate}`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        scope,
        deleted: 0,
        created: 0,
        apiCallsMade: 0,
        repairedStopOrders: stopOrderRepairUpdates.length
      });
    }
    console.log(`# [purgeAndRegeneratePolylines] START | driver=${driverDisplayName} | date=${deliveryDate} | scope=${scope} | totalStops=${deliveries?.length || 0} | existingPolylines=${existingPolylines?.length || 0} | driver_status=${driverAvailability.status || 'missing'} | historical=${isHistoricalDate} | home_lat=${driverAppUser?.home_latitude} | home_lon=${driverAppUser?.home_longitude}`);

    const getLatLon = (delivery) => {
      if (!delivery) return null;

      // 1. Cycling markers: use dedicated cycling GPS fields on the delivery record
      if (delivery.is_cycling_marker) {
        const lat = Number(delivery.cycling_latitude);
        const lon = Number(delivery.cycling_longitude);
        if (isValidCoordinatePair(lat, lon)) return { lat, lon };
        console.warn(`[purgeAndRegeneratePolylines] cycling marker missing valid coords | delivery=${delivery.id}`);
        return null;
      }

      // 2. ISP inter-store stops: coords resolved from delivery_id phone number
      if (!delivery.patient_id && isInterStoreDeliveryId(delivery.delivery_id)) {
        const ispCoords = ispSourceMap.get(delivery.id);
        const lat = Number(ispCoords?.store_latitude);
        const lon = Number(ispCoords?.store_longitude);
        if (isValidCoordinatePair(lat, lon)) return { lat, lon };
        console.warn(`[purgeAndRegeneratePolylines] ISP coords unresolvable | delivery=${delivery.id} | delivery_id=${delivery.delivery_id}`);
        // Don't fall through — ISP stops have no patient and no store GPS to fall back to
        return null;
      }

      // 3. Patient address (standard delivery)
      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        const lat = Number(patient?.latitude);
        const lon = Number(patient?.longitude);
        if (isValidCoordinatePair(lat, lon)) return { lat, lon };
        console.warn(`[purgeAndRegeneratePolylines] invalid patient coords | delivery=${delivery.id} | patient_id=${delivery.patient_id} | lat=${patient?.latitude} | lon=${patient?.longitude}`);
      }

      // 4. Store address (pickup / store-only stops)
      if (delivery.store_id) {
        const store = storeMap.get(delivery.store_id);
        const lat = Number(store?.latitude);
        const lon = Number(store?.longitude);
        if (isValidCoordinatePair(lat, lon)) return { lat, lon };
        console.warn(`[purgeAndRegeneratePolylines] invalid store coords | delivery=${delivery.id} | store_id=${delivery.store_id} | lat=${store?.latitude} | lon=${store?.longitude}`);
      }

      console.warn(`[purgeAndRegeneratePolylines] no usable coords | delivery=${delivery.id} | stop_order=${delivery.stop_order ?? '?'} | patient=${delivery.patient_id || ''} | store=${delivery.store_id || ''}`);
      return null;
    };

    const explicitStopOrderIds = Array.isArray(routeStopOrder) ? routeStopOrder.filter(Boolean) : [];
    const explicitStopMetaById = new Map(
      (Array.isArray(orderedStopsWithTransportMode) ? orderedStopsWithTransportMode : [])
        .filter((item) => item?.deliveryId)
        .map((item) => [item.deliveryId, item])
    );
    const reusablePolylineMetaById = reuseProvidedPolylines ? explicitStopMetaById : new Map();
    const deliveryById = new Map((deliveries || []).filter((delivery) => delivery?.id).map((delivery) => [delivery.id, delivery]));
    // CRITICAL: Always sort strictly by stop_order ascending. This is the single source of truth
    // for stop sequence — it is derived from actual_delivery_time order so it is always correct.
    // Never rely on DB return order or coord proximity for sequence decisions.
    const orderedDeliveries = (explicitStopOrderIds.length > 0
      ? explicitStopOrderIds.map((id) => deliveryById.get(id) || null).filter(Boolean)
      : [...deliveries].sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))
    );

    const finishedStops = orderedDeliveries.filter((delivery) => FINISHED_STATUSES.has(delivery.status));
    const latestFinishedStop = finishedStops[finishedStops.length - 1] || null;
    // "Active" for polyline purposes = in_transit/en_route ONLY.
    // Pending stops have not been dispatched yet — never generate polylines for them.
    // CRITICAL: Re-sort activeStops strictly by stop_order so the index-based segment
    // assignment below is always in the correct sequence, even for clustered stops.
    const activeStops = orderedDeliveries
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));
    const pendingStops = orderedDeliveries.filter((delivery) => delivery.status === 'pending');

    // If scope=active_only but there are NO truly active stops and ALL stops are finished,
    // automatically escalate to completed_only so the full route gets polylines regenerated.
    const effectiveScope = (scope === 'active_only' && activeStops.length === 0 && finishedStops.length > 0)
      ? 'completed_only'
      : scope;
    if (effectiveScope !== scope) {
      console.log(`# [purgeAndRegeneratePolylines] scope escalated: ${scope} → ${effectiveScope} | driver=${driverDisplayName} | finishedStops=${finishedStops.length}`);
    }

    let apiCallsMade = 0;
    let deletedPolylineCount = 0;
    let clearedFinishedLegs = 0;
    const regeneratedFinishedLegStopIds = [];
    const deliveryUpdatesById = new Map();

    const sortedForTravelDistance = [...deliveries].sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    if (effectiveScope === 'all' || effectiveScope === 'completed_only') {
      clearedFinishedLegs = 0;
    }

    const createdSegments = [];

    if (effectiveScope === 'completed_only' || effectiveScope === 'all') {
      const homeLat = Number(driverAppUser?.home_latitude);
      const homeLon = Number(driverAppUser?.home_longitude);
      const hasHomeCoords = isValidCoordinatePair(homeLat, homeLon);
      const finishedSegmentSpecs = [];
      if (hasHomeCoords && finishedStops.length > 0) {
        const orderedStops = finishedStops
          .map((stop) => ({ stop, coords: getLatLon(stop) }))
          .filter((entry) => entry.coords);

        const routePoints = [
          { lat: homeLat, lon: homeLon },
          ...orderedStops.map((entry) => entry.coords),
          { lat: homeLat, lon: homeLon }
        ];

        for (let index = 0; index < orderedStops.length; index += 1) {
          const stop = orderedStops[index].stop;
          const actualStopCoords = orderedStops[index].coords;
          const from = routePoints[index];
          const to = routePoints[index + 1];
          if (!from || !to || !actualStopCoords) continue;
          const existingBreadcrumbs = stop?.delivery_route_breadcrumbs || null;
          const fallbackBreadcrumbs = existingBreadcrumbs || buildFallbackBreadcrumbs(
            from,
            to,
            new Date(stop?.actual_delivery_time || stop?.arrival_time || stop?.updated_date || stop?.created_date || Date.now()).getTime()
          );
          const explicitMeta = explicitStopMetaById.get(stop?.id) || null;
          const normalizedTransportMode = resolveStopTravelMode(stop, explicitMeta, driverAppUser, 'finished_leg_transport_mode');
          finishedSegmentSpecs.push({
            stop,
            from,
            to,
            actualFrom: from,
            actualTo: actualStopCoords,
            transportMode: normalizedTransportMode,
            breadcrumbDirections: parseBreadcrumbPolyline(existingBreadcrumbs),
            fallbackBreadcrumbs,
            usedFallbackBreadcrumbs: !existingBreadcrumbs && !!fallbackBreadcrumbs
          });
        }
      }

      const finishedDirectionsByStopId = new Map();
      if (routeSource === 'polylines' && finishedSegmentSpecs.length > 0) {
        // Detect whether any finished stop used cycling transport mode
        const hasCyclingSegments = finishedSegmentSpecs.some(
          (spec) => getNormalizedTravelMode(spec.transportMode) === 'cycling'
        );

        if (!hasCyclingSegments) {
          // ── Standard path (no cycling): group by mode, one HERE call per group ──
          // For a pure-driving route this is always 1 call.
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
            const groupedFinishedRoute = await getMultiSegmentDirections(base44, group.map((segment) => ({ from: segment.from, to: segment.to })), mode);
            apiCallsMade += 1;
            if (groupedFinishedRoute.usedFallbackPolyline) anyFallbackPolylineUsed = true;
            group.forEach((segment, index) => {
              finishedDirectionsByStopId.set(segment.stop.id, groupedFinishedRoute[index] || null);
            });
          }
        } else {
          // ── Optimized cycling path ──────────────────────────────────────────────
          // Total calls = 1 (full driving pass) + N (one per distinct cycling loop)
          // vs old behaviour: (drivingGroupCount + cyclingLoopCount) calls
          //
          // Step A: One driving-mode call covering every stop home→stop1→…→lastStop→home.
          //   HERE road-routes all waypoints as driving regardless of actual mode.
          //   This gives us per-section road geometry for every stop in one shot.
          const drivingPassDirections = await getMultiSegmentDirections(
            base44,
            finishedSegmentSpecs.map((spec) => ({ from: spec.from, to: spec.to })),
            'driving'
          );
          apiCallsMade += 1;
          if (drivingPassDirections.usedFallbackPolyline) anyFallbackPolylineUsed = true;
          finishedSegmentSpecs.forEach((spec, index) => {
            finishedDirectionsByStopId.set(spec.stop.id, drivingPassDirections[index] || null);
          });

          // Step B: Identify contiguous cycling groups (loops) and override those stops
          //   with bicycle-mode directions.  Each distinct cycling loop = 1 HERE call.
          const cyclingLoops = [];
          let currentCyclingGroup = null;
          for (const spec of finishedSegmentSpecs) {
            const mode = getNormalizedTravelMode(spec.transportMode);
            if (mode === 'cycling') {
              if (!currentCyclingGroup) currentCyclingGroup = [];
              currentCyclingGroup.push(spec);
            } else {
              if (currentCyclingGroup) {
                cyclingLoops.push(currentCyclingGroup);
                currentCyclingGroup = null;
              }
            }
          }
          if (currentCyclingGroup) cyclingLoops.push(currentCyclingGroup);

          for (const loopSpecs of cyclingLoops) {
            const cyclingDirections = await getMultiSegmentDirections(
              base44,
              loopSpecs.map((spec) => ({ from: spec.from, to: spec.to })),
              'cycling'
            );
            apiCallsMade += 1;
            if (cyclingDirections.usedFallbackPolyline) anyFallbackPolylineUsed = true;
            loopSpecs.forEach((spec, index) => {
              // Override the driving-pass result for this stop with bicycle directions
              finishedDirectionsByStopId.set(spec.stop.id, cyclingDirections[index] || null);
            });
          }

          console.log(
            `[purgeAndRegeneratePolylines] cycling-optimized polyline regen | driver=${driverDisplayName}` +
            ` | totalStops=${finishedSegmentSpecs.length} | cyclingLoops=${cyclingLoops.length}` +
            ` | apiCalls=1+${cyclingLoops.length} (was ${(() => {
              let groups = 1; let prevMode = getNormalizedTravelMode(finishedSegmentSpecs[0]?.transportMode);
              for (let i = 1; i < finishedSegmentSpecs.length; i++) {
                const m = getNormalizedTravelMode(finishedSegmentSpecs[i]?.transportMode);
                if (m !== prevMode) { groups++; prevMode = m; }
              }
              return groups;
            })()})`
          );
        }
      }

      finishedSegmentSpecs.forEach((segment) => {
        const directions = routeSource === 'polylines'
          ? finishedDirectionsByStopId.get(segment.stop.id) || null
          : segment.breadcrumbDirections || null;
        const mergedFinishedPolyline = directions?.encoded_polyline || null;
        regeneratedFinishedLegStopIds.push(segment.stop.id);
        deliveryUpdatesById.set(segment.stop.id, {
          ...(deliveryUpdatesById.get(segment.stop.id) || {}),
          // Also replace encoded_polyline (forward-route arrow) so map reflects home-origin regen
          ...buildSegmentDeliveryUpdate({ from: segment.from, to: segment.to }, directions, segment.transportMode),
          delivery_route_breadcrumbs: segment.usedFallbackBreadcrumbs ? segment.fallbackBreadcrumbs : (deliveryUpdatesById.get(segment.stop.id)?.delivery_route_breadcrumbs || segment.stop?.delivery_route_breadcrumbs),
          finished_leg_encoded_polyline: mergedFinishedPolyline,
          finished_leg_transport_mode: mergedFinishedPolyline ? segment.transportMode : null,
          travel_dist: directions?.estimated_distance_km ?? null,
          PolylineUpdated: true  // always true — pre-null in PATCH 1 ensures change-detection fires
        });
      });

      clearedFinishedLegs = finishedStops.length;
    }

    if (deliveryUpdatesById.size > 0) {
      deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
      console.log(`# [purgeAndRegeneratePolylines] finishedLeg bulkUpdate done | driver=${driverDisplayName} | updated=${deliveryUpdatesById.size}`);
    }

    // Clear the map so active-section updates are isolated from finished-leg updates
    deliveryUpdatesById.clear();

    if ((effectiveScope === 'all' || effectiveScope === 'active_only') && routeSource === 'polylines') {
      const firstActive = getLatLon(activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0]);
      const preservedType1Row = scope === 'active_only' && firstActive && !explicitOrderedStopsOnly
        ? (existingPolylines || []).find((row) => samePoint({ lat: row?.segment_dest_lat, lon: row?.segment_dest_lon }, firstActive)) || null
        : null;

      if (activeStops.length > 0) {
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
        // For a brand-new route (no finished stops, all pending) ALWAYS use home as origin —
        // never the driver's current GPS, which may be stale or somewhere irrelevant.
        const hasNoFinishedStops = !latestFinishedStop;
        const useDriverLocationAsOrigin = !explicitStopOrderIds.length && !useLastFinishedOrigin && !explicitResolvedOrigin && scope === 'active_only' && firstActive && isToday && isValidCoordinatePair(currentLat, currentLon) && !hasNoFinishedStops;

        if (useDriverLocationAsOrigin && !originFromFinishedStop) {
          const firstStop = activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0];
          const firstMeta = explicitStopMetaById.get(firstStop?.id) || null;
          pushSegment({ lat: currentLat, lon: currentLon }, firstActive, false, resolveStopTravelMode(firstStop, firstMeta, driverAppUser, 'transport_mode'));
        }

        // Walk backwards from index-1 to find the nearest preceding stop that has valid GPS.
        // If we just used getLatLon(previousActiveStop) and it returned null we would fall
        // through to originFromFinishedStop / home, producing a segment that jumps to the
        // wrong part of the map, breaks the continuity chain, and renders as a straight-line
        // fallback polyline for every subsequent stop in the same group.
        const getNearestValidPrevCoords = (index) => {
          for (let prev = index - 1; prev >= 0; prev -= 1) {
            const coords = getLatLon(activeStops[prev]);
            if (coords) return coords;
          }
          return null;
        };

        for (let index = 0; index < activeStops.length; index += 1) {
          const stop = activeStops[index];
          const from = index === 0
            ? (explicitResolvedOrigin
              || originFromFinishedStop
              || (!routeAlreadyStarted && hasHomeCoords ? { lat: homeLat, lon: homeLon } : null))
            : (getNearestValidPrevCoords(index)
              || originFromFinishedStop
              || (!routeAlreadyStarted && hasHomeCoords ? { lat: homeLat, lon: homeLon } : null));
          const to = getLatLon(stop);
          if (!to) {
            console.warn(`[purgeAndRegeneratePolylines] skipping stop with no coords | delivery=${stop?.id} | patient_id=${stop?.patient_id || ''} | stop_order=${stop?.stop_order ?? '?'}`);
          }
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
          if (groupedDirections.usedFallbackPolyline) anyFallbackPolylineUsed = true;
          group.forEach((spec, index) => {
            directionsBySegmentKey.set(
              makeSegmentKey(driverId, deliveryDate, spec.from, spec.to),
              groupedDirections[index] || null
            );
          });
        }

        // CRITICAL: Match polyline segments to active stops by POSITION (index), not by coords.
        // Coord-based matching fails when stops share identical GPS (clustered stops) because
        // usedStopIds would block the second stop from ever matching. Since activeStops is
        // already sorted by stop_order (strict ascending), and segmentSpecs was built by
        // iterating activeStops in order, the Nth segment belongs to the Nth active stop.
        // We iterate uncachedSegments in order and pair each one with the corresponding
        // active stop at the same index — no coord comparison needed.
        activeStops.forEach((matchingStop, stopIndex) => {
          if (!matchingStop?.id) return;
          // uncachedSegments is a subset of segmentSpecs; find the spec for this stop by index.
          // segmentSpecs was built as: [origin→stop0, stop0→stop1, ...] so stop at index i
          // corresponds to segmentSpecs[i]. We skip any home-leg specs (no active stop owns those).
          const spec = uncachedSegments[stopIndex] || null;
          if (!spec) return;

          const directions = directionsBySegmentKey.get(makeSegmentKey(driverId, deliveryDate, spec.from, spec.to));
          if (!directions) return;

          const matchingStopCoords = getLatLon(matchingStop);
          deliveryUpdatesById.set(matchingStop.id, {
            ...(deliveryUpdatesById.get(matchingStop.id) || {}),
            ...buildSegmentDeliveryUpdate({ ...spec, actualTo: matchingStopCoords || spec.to }, directions, spec.transportMode),
            travel_dist: directions?.estimated_distance_km ?? null
          });
          createdSegments.push({
            id: matchingStop.id,
            ...buildSegmentDeliveryUpdate({ ...spec, actualTo: matchingStopCoords || spec.to }, directions, spec.transportMode)
          });
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

        // Always null out polyline fields on pending stops — they are never routed
        pendingStops.forEach((stop) => {
          if (!stop?.id) return;
          deliveryUpdatesById.set(stop.id, {
            encoded_polyline: null,
            transport_mode: null,
            estimated_distance_km: null,
            estimated_duration_minutes: null,
            travel_dist: null
          });
        });

        if (deliveryUpdatesById.size > 0) {
          deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
          console.log(`# [purgeAndRegeneratePolylines] active bulkUpdate done | driver=${driverDisplayName} | updated=${deliveryUpdatesById.size}`);
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

        const uncachedDirectionsBySegmentKey = new Map();
        const uncachedSegments = [...completedRouteHomeSegment];
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
          if (groupedDirections.usedFallbackPolyline) anyFallbackPolylineUsed = true;
          group.forEach((spec, index) => {
            uncachedDirectionsBySegmentKey.set(
              makeSegmentKey(driverId, deliveryDate, spec.from, spec.to),
              groupedDirections[index] || null
            );
          });
        }

        const usedHomeStopIds = new Set();
        uncachedSegments.forEach((spec) => {
          const directions = uncachedDirectionsBySegmentKey.get(makeSegmentKey(driverId, deliveryDate, spec.from, spec.to));
          const matchingStop = deliveries
            .filter((stop) => {
              if (!stop?.id || usedHomeStopIds.has(stop.id)) return false;
              const stopCoords = getLatLon(stop);
              return stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
            })
            .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))[0] || null;
          if (matchingStop?.id) {
            usedHomeStopIds.add(matchingStop.id);
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

        deletedPolylineCount = 0;

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

    let pendingBreadcrumbLiveMerge = { mergedCount: 0, sourceRows: 0, updatedDeliveryIds: [] };
    if (routeSource === 'breadcrumbs') {
      pendingBreadcrumbLiveMerge = await reintegratePendingBreadcrumbLive(base44, driverId, deliveryDate, deliveries);
      // deliveries in-memory already updated via bulkUpdateDeliveries return value
    }

    // Use in-memory deliveries for PolylineUpdated stamp — avoid extra DB round trip.
    // Always runs — bypassPolylineUpdated only controls pre-nulling (to force change-detection),
    // not whether the final true stamp is written.
    await markDeliveriesPolylineUpdated(base44, deliveries, true);
    const finalDeliveries = deliveries;

    const trackingRecalcData = null;

    const consolidatedLegs = [];
    const completedLikeStops = (finalDeliveries || [])
      .filter((delivery) => FINISHED_STATUSES.has(String(delivery?.status || '')))
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

    return Response.json({
      success: true,
      scope,
      deleted: deletedPolylineCount,
      created: createdSegments.length,
      apiCallsMade,
      usedFallbackPolyline: anyFallbackPolylineUsed,
      segments: createdSegments,
      clearedFinishedLegs,
      regeneratedFinishedLegs: regeneratedFinishedLegStopIds.length,
      regeneratedFinishedLegStopIds,
      repairedStopOrders: stopOrderRepairUpdates.length,
      recalculatedTravelDistances: sortedForTravelDistance.length,
      originStrategy: latestFinishedStop ? 'last_finished_stop' : 'home_through_remaining_route',
      consolidatedLegs,
      pendingBreadcrumbLiveMerge,
      trackingNumbersUpdated: Number(trackingRecalcData?.updated || 0)
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