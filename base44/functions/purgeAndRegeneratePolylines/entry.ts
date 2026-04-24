/* Force Redeploy */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

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

function findExactCachedSegment(rows, from, to) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.find((row) =>
    round5(row?.segment_origin_lat) === round5(from.lat) &&
    round5(row?.segment_origin_lon) === round5(from.lon) &&
    round5(row?.segment_dest_lat) === round5(to.lat) &&
    round5(row?.segment_dest_lon) === round5(to.lon) &&
    typeof row?.encoded_polyline === 'string' && row.encoded_polyline.trim().length > 0
  ) || null;
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


async function bulkUpdateDeliveries(base44, deliveries, updatesById) {
  if (!(updatesById instanceof Map) || updatesById.size === 0) {
    return deliveries || [];
  }

  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];

  try {
    await processInChunks(Array.from(updatesById.entries()), 20, async ([id, update]) => {
      return await base44.asServiceRole.entities.Delivery.update(id, update).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });
    });
    return mergeDeliveryUpdates(safeDeliveries, updatesById);
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

    await base44.asServiceRole.entities.Delivery.update(targetDelivery.id, {
      delivery_route_breadcrumbs: JSON.stringify(uniquePoints),
      finished_leg_encoded_polyline: null,
      finished_leg_transport_mode: null,
      PolylineUpdated: true
    });

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
    segmentCount: safeSpecs.length,
    totalPoints: safeSpecs.length + 1,
    origin,
    destination,
    waypointCount: waypoints.length
  });

  try {
    const routeContext = [origin, ...safeSpecs.map((segment) => segment.to)];
    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: origin.lat, lng: origin.lon },
      destination: { lat: destination.lat, lng: destination.lon },
      waypoints,
      routeContext: routeContext.map((point) => ({ lat: point.lat, lng: point.lon })),
      preserveWaypointOrder: true,
      transportMode
    });

    const data = response?.data || response || {};
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    const routePolylines = Array.isArray(data?.polylines) ? data.polylines : [];

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
      bypassPolylineDelete = false
    } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    let deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const appUsersForDriverName = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1);
    const driverNameAppUser = Array.isArray(appUsersForDriverName) ? appUsersForDriverName[0] : null;
    const driverDisplayName = driverNameAppUser?.user_name || driverNameAppUser?.full_name || driverId;
    const repairedStopOrders = 0;

    const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '-updated_date', 50000);

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
        repairedStopOrders: repairedStopOrders
      });
    }

    console.log('existingPolylines:', existingPolylines);
    console.log('Type of existingPolylines:', typeof existingPolylines, Array.isArray(existingPolylines));

    const previousGenerationCount = Array.isArray(existingPolylines) && existingPolylines.length
      ? Math.max(...existingPolylines.map((row) => Number(row?.daily_generation_count || 0)))
      : 0;

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      if (Array.isArray(existingPolylines) && existingPolylines.length > 0 && scope !== 'completed_only') {
        await processInChunks(existingPolylines, 5, (row) =>
          base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
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
        scope,
        deleted: 0,
        created: 0,
        apiCallsMade: 0,
        repairedStopOrders: repairedStopOrders
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
        repairedStopOrders: repairedStopOrders
      });
    }
    console.log(`# [purgeAndRegeneratePolylines] START | driver=${driverDisplayName} | date=${deliveryDate} | scope=${scope} | totalStops=${deliveries?.length || 0} | existingPolylines=${existingPolylines?.length || 0} | driver_status=${driverAvailability.status || 'missing'} | historical=${isHistoricalDate} | home_lat=${driverAppUser?.home_latitude} | home_lon=${driverAppUser?.home_longitude}`);

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

    const explicitStopOrderIds = Array.isArray(routeStopOrder) ? routeStopOrder.filter(Boolean) : [];
    const explicitStopMetaById = new Map(
      (Array.isArray(orderedStopsWithTransportMode) ? orderedStopsWithTransportMode : [])
        .filter((item) => item?.deliveryId)
        .map((item) => [item.deliveryId, item])
    );
    const deliveryById = new Map((deliveries || []).filter((delivery) => delivery?.id).map((delivery) => [delivery.id, delivery]));
    const orderedDeliveries = (explicitStopOrderIds.length > 0
      ? explicitStopOrderIds.map((id) => deliveryById.get(id) || null).filter(Boolean)
      : [...deliveries].sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))
    );

    const finishedStops = orderedDeliveries.filter((delivery) => FINISHED_STATUSES.has(delivery.status));
    const latestFinishedStop = finishedStops[finishedStops.length - 1] || null;
    const activeStops = orderedDeliveries.filter((delivery) => ACTIVE_STATUSES.has(delivery.status));

    let apiCallsMade = 0;
    let deletedPolylineCount = 0;
    let clearedFinishedLegs = 0;
    const regeneratedFinishedLegStopIds = [];
    const deliveryUpdatesById = new Map();

    const sortedForTravelDistance = [...deliveries].sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    if (scope === 'all' || scope === 'completed_only') {
      clearedFinishedLegs = 0;
    }

    const createdSegments = [];

    if ((scope === 'completed_only' || (scope === 'all' && explicitStopOrderIds.length === 0 && !explicitOrderedStopsOnly))) {
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
          const from = routePoints[index];
          const to = routePoints[index + 1];
          if (!from || !to) continue;
          const existingBreadcrumbs = stop?.delivery_route_breadcrumbs || null;
          const fallbackBreadcrumbs = existingBreadcrumbs || buildFallbackBreadcrumbs(
            from,
            to,
            new Date(stop?.actual_delivery_time || stop?.arrival_time || stop?.updated_date || stop?.created_date || Date.now()).getTime()
          );
          const explicitMeta = explicitStopMetaById.get(stop?.id) || null;
          const rawTransportMode = explicitMeta?.finished_leg_transport_mode || stop?.finished_leg_transport_mode || '';
          const normalizedTransportMode = ['driving', 'cycling', 'pedestrian'].includes(String(rawTransportMode).toLowerCase())
            ? String(rawTransportMode).toLowerCase()
            : 'driving';
          finishedSegmentSpecs.push({
            stop,
            from,
            to,
            transportMode: normalizedTransportMode,
            breadcrumbDirections: parseBreadcrumbPolyline(existingBreadcrumbs),
            fallbackBreadcrumbs,
            usedFallbackBreadcrumbs: !existingBreadcrumbs && !!fallbackBreadcrumbs
          });
        }
      }

      const finishedDirectionsByStopId = new Map();
      if (routeSource === 'polylines' && finishedSegmentSpecs.length > 0) {
        for (const mode of ['driving', 'cycling']) {
          const segmentsForMode = finishedSegmentSpecs.filter((segment) => segment.transportMode === mode);
          if (segmentsForMode.length === 0) continue;
          const finishedDirections = await getMultiSegmentDirections(
            base44,
            segmentsForMode.map((segment) => ({ from: segment.from, to: segment.to })),
            mode
          );
          apiCallsMade += 1;
          segmentsForMode.forEach((segment, index) => {
            finishedDirectionsByStopId.set(segment.stop.id, finishedDirections[index] || null);
          });
        }
      }

      finishedSegmentSpecs.forEach((segment) => {
        const directions = routeSource === 'polylines'
          ? finishedDirectionsByStopId.get(segment.stop.id) || null
          : segment.breadcrumbDirections || null;
        regeneratedFinishedLegStopIds.push(segment.stop.id);
        deliveryUpdatesById.set(segment.stop.id, {
          ...(deliveryUpdatesById.get(segment.stop.id) || {}),
          delivery_route_breadcrumbs: segment.usedFallbackBreadcrumbs ? segment.fallbackBreadcrumbs : (deliveryUpdatesById.get(segment.stop.id)?.delivery_route_breadcrumbs || segment.stop?.delivery_route_breadcrumbs),
          finished_leg_encoded_polyline: directions?.encoded_polyline || null,
          finished_leg_transport_mode: directions?.encoded_polyline ? segment.transportMode : null,
          travel_dist: directions?.estimated_distance_km ?? null,
          PolylineUpdated: bypassPolylineUpdated ? false : true
        });
      });

      clearedFinishedLegs = finishedStops.length;
    }

    if (deliveryUpdatesById.size > 0) {
      console.log(`# [purgeAndRegeneratePolylines] BEFORE finishedLeg bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0} | updateCount=${deliveryUpdatesById.size}`);
      deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
      const afterFinishedLegDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000);
      console.log(`# [purgeAndRegeneratePolylines] AFTER finishedLeg bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${afterFinishedLegDeliveries?.length || 0} | updateCount=${deliveryUpdatesById.size}`);
      deliveries = afterFinishedLegDeliveries;
    }

    if ((scope === 'all' || scope === 'active_only') && routeSource === 'polylines') {
      const firstActive = getLatLon(activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0]);
      const preservedType1Row = scope === 'active_only' && firstActive && !explicitOrderedStopsOnly
        ? (existingPolylines || []).find((row) => samePoint({ lat: row?.segment_dest_lat, lon: row?.segment_dest_lon }, firstActive)) || null
        : null;

      if (activeStops.length > 0) {
        const segmentSpecs = [];
        const seen = new Set();

        const pushSegment = (from, to, force = false) => {
          if (!isValidPoint(from) || !isValidPoint(to)) return;
          const key = makeSegmentKey(driverId, deliveryDate, from, to);
          if (seen.has(key)) return;
          seen.add(key);
          segmentSpecs.push({ from, to, force });
        };

        const currentLat = Number(driverAppUser?.current_latitude);
        const currentLon = Number(driverAppUser?.current_longitude);
        const homeLat = Number(driverAppUser?.home_latitude);
        const homeLon = Number(driverAppUser?.home_longitude);
        const hasHomeCoords = isValidCoordinatePair(homeLat, homeLon);
        const isToday = deliveryDate === getEdmontonDateString();
        const lockHomeOrigin = explicitRouteOrigin === 'home' && hasHomeCoords;
        const lockHomeDestination = explicitRouteDestination === 'home' && hasHomeCoords;

        const originFromFinishedStop = lockHomeOrigin
          ? { lat: homeLat, lon: homeLon }
          : (latestFinishedStop ? getLatLon(latestFinishedStop) : null);
        const useDriverLocationAsOrigin = !explicitStopOrderIds.length && scope === 'active_only' && firstActive && isToday && isValidCoordinatePair(currentLat, currentLon);

        if (useDriverLocationAsOrigin && !originFromFinishedStop) {
          pushSegment({ lat: currentLat, lon: currentLon }, firstActive);
        }

        for (let index = 0; index < activeStops.length; index += 1) {
          const stop = activeStops[index];
          const previousStop = activeStops[index - 1];
          const from = previousStop
            ? getLatLon(previousStop)
            : originFromFinishedStop || (hasHomeCoords ? { lat: homeLat, lon: homeLon } : null);
          const to = getLatLon(stop);
          pushSegment(from, to, !!explicitStopOrderIds.length);
        }

        const lastActive = getLatLon(activeStops[activeStops.length - 1]);

        if ((lockHomeDestination || explicitOrderedStopsOnly) && lastActive && hasHomeCoords) {
          pushSegment(lastActive, { lat: homeLat, lon: homeLon }, true);
        } else if (!explicitStopOrderIds.length) {
          const shouldAddHomeStartLeg = hasHomeCoords && firstActive && !originFromFinishedStop;
          if (shouldAddHomeStartLeg) {
            pushSegment({ lat: homeLat, lon: homeLon }, firstActive, true);
          }

          if (hasHomeCoords && lastActive) {
            pushSegment(lastActive, { lat: homeLat, lon: homeLon }, true);
          }
        }

        const segmentsToKeep = new Set();
        if (preservedType1Row) {
          segmentsToKeep.add(preservedType1Row.id);
        }

        const cachedSegments = [];
        const uncachedSegments = [];

        for (const spec of segmentSpecs) {
          const cachedSegment = !spec.force ? findExactCachedSegment(existingPolylines, spec.from, spec.to) : null;
          if (cachedSegment) {
            cachedSegments.push({ spec, cachedSegment });
          } else {
            uncachedSegments.push(spec);
          }
        }

        cachedSegments.forEach(({ spec, cachedSegment }) => {
          segmentsToKeep.add(cachedSegment.id);
          const matchingStop = activeStops.find((stop) => {
            const stopCoords = getLatLon(stop);
            return stop?.id && stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
          });
          if (matchingStop) {
            deliveryUpdatesById.set(matchingStop.id, {
              ...(deliveryUpdatesById.get(matchingStop.id) || {}),
              travel_dist: cachedSegment.estimated_distance_km ?? null
            });
          }
        });

        const uncachedDirections = await getMultiSegmentDirections(
          base44,
          uncachedSegments,
          explicitStopMetaById.get(activeStops[0]?.id)?.finished_leg_transport_mode || driverAppUser?.preferred_travel_mode || 'driving'
        );
        if (uncachedSegments.length > 0) apiCallsMade += 1;

        uncachedSegments.forEach((spec, index) => {
          const directions = uncachedDirections[index];
          const matchingStop = activeStops.find((stop) => {
            const stopCoords = getLatLon(stop);
            return stop?.id && stopCoords && samePoint({ lat: stopCoords.lat, lon: stopCoords.lon }, spec.to);
          });
          if (matchingStop) {
            deliveryUpdatesById.set(matchingStop.id, {
              ...(deliveryUpdatesById.get(matchingStop.id) || {}),
              travel_dist: directions?.estimated_distance_km ?? null
            });
          }
          createdSegments.push({
            driver_id: driverId,
            delivery_date: deliveryDate,
            encoded_polyline: directions?.encoded_polyline || encodeGooglePolyline([[spec.from.lat, spec.from.lon], [spec.to.lat, spec.to.lon]]),
            segment_origin_lat: round5(spec.from.lat),
            segment_origin_lon: round5(spec.from.lon),
            segment_dest_lat: round5(spec.to.lat),
            segment_dest_lon: round5(spec.to.lon),
            estimated_distance_km: directions?.estimated_distance_km ?? null,
            estimated_duration_minutes: directions?.estimated_duration_minutes ?? null,
            daily_generation_count: previousGenerationCount + apiCallsMade,
            last_generated_at: new Date().toISOString()
          });
        });

        const allowedActiveSegmentKeys = new Set(segmentSpecs.map((spec) => makeSegmentKey(driverId, deliveryDate, spec.from, spec.to)));
        const existingPolylineIds = new Set((existingPolylines || []).map((row) => row?.id).filter(Boolean));
        const rowsToDelete = (existingPolylines || []).filter((row) => {
          if (!existingPolylineIds.has(row?.id)) return false;
          if (segmentsToKeep.has(row.id)) return false;
          const rowKey = makeSegmentKey(driverId, deliveryDate, { lat: row?.segment_origin_lat, lon: row?.segment_origin_lon }, { lat: row?.segment_dest_lat, lon: row?.segment_dest_lon });
          return !allowedActiveSegmentKeys.has(rowKey);
        });
        if (!bypassPolylineDelete && rowsToDelete.length > 0) {
          console.log(`#[purgeAndRegeneratePolylines] BEFORE delete old polylines | driver=${driverDisplayName} | date=${deliveryDate} | rowsToDelete=${rowsToDelete.length} | totalStops=${deliveries?.length || 0}`);
          await processInChunks(rowsToDelete, 20, (row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
          console.log(`# [purgeAndRegeneratePolylines] AFTER delete old polylines | driver=${driverDisplayName} | date=${deliveryDate} | rowsToDelete=${rowsToDelete.length} | totalStops=${deliveries?.length || 0}`);
        }
        deletedPolylineCount = bypassPolylineDelete ? 0 : rowsToDelete.length;

        if (createdSegments.length > 0) {
          console.log(`# [purgeAndRegeneratePolylines] BEFORE DriverRoutePolyline.bulkCreate | driver=${driverDisplayName} | date=${deliveryDate} | createdSegments=${createdSegments.length} | totalStops=${deliveries?.length || 0}`);
          await base44.asServiceRole.entities.DriverRoutePolyline.bulkCreate(createdSegments);
          const afterPolylineCreateDeliveries = await base44.asServiceRole.entities.Delivery.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          }, 'stop_order', 50000);
          console.log(`# [purgeAndRegeneratePolylines] AFTER DriverRoutePolyline.bulkCreate | driver=${driverDisplayName} | date=${deliveryDate} | createdSegments=${createdSegments.length} | totalStops=${afterPolylineCreateDeliveries?.length || 0}`);
          deliveries = afterPolylineCreateDeliveries;
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
              force: true
            });
          }
        }

        if (latestFinishedStop && hasHomeCoords) {
          const latestFinishedCoords = getLatLon(latestFinishedStop);
          if (latestFinishedCoords) {
            completedRouteHomeSegment.push({
              from: latestFinishedCoords,
              to: { lat: homeLat, lon: homeLon },
              force: true
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

        const uncachedDirections = await getMultiSegmentDirections(base44, uncachedSegments);
        if (uncachedSegments.length > 0) apiCallsMade += 1;

        uncachedSegments.forEach((spec, index) => {
          const directions = uncachedDirections[index];
          createdSegments.push({
            driver_id: driverId,
            delivery_date: deliveryDate,
            encoded_polyline: directions?.encoded_polyline || encodeGooglePolyline([[spec.from.lat, spec.from.lon], [spec.to.lat, spec.to.lon]]),
            segment_origin_lat: round5(spec.from.lat),
            segment_origin_lon: round5(spec.from.lon),
            segment_dest_lat: round5(spec.to.lat),
            segment_dest_lon: round5(spec.to.lon),
            estimated_distance_km: directions?.estimated_distance_km ?? null,
            estimated_duration_minutes: directions?.estimated_duration_minutes ?? null,
            daily_generation_count: previousGenerationCount + apiCallsMade,
            last_generated_at: new Date().toISOString()
          });
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
          await processInChunks(rowsToDelete, 20, (row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
        }
        deletedPolylineCount = bypassPolylineDelete ? 0 : rowsToDelete.length;

        if (createdSegments.length > 0) {
          await base44.asServiceRole.entities.DriverRoutePolyline.bulkCreate(createdSegments);
        }
      }
    }

    let pendingBreadcrumbLiveMerge = { mergedCount: 0, sourceRows: 0, updatedDeliveryIds: [] };
    if (routeSource === 'breadcrumbs') {
      pendingBreadcrumbLiveMerge = await reintegratePendingBreadcrumbLive(base44, driverId, deliveryDate, deliveries);
      if (pendingBreadcrumbLiveMerge.updatedDeliveryIds.length > 0) {
        deliveries = await base44.asServiceRole.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        }, 'stop_order', 50000);
      }
    }

    let finalDeliveries;
    if (bypassPolylineUpdated) {
      finalDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000);
    } else {
      console.log(`# [purgeAndRegeneratePolylines] BEFORE markDeliveriesPolylineUpdated | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0}`);
      await markDeliveriesPolylineUpdated(base44, deliveries, true);
      finalDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000);
      console.log(`# [purgeAndRegeneratePolylines] AFTER markDeliveriesPolylineUpdated | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${finalDeliveries?.length || 0}`);
    }

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
      segments: createdSegments,
      clearedFinishedLegs,
      regeneratedFinishedLegs: regeneratedFinishedLegStopIds.length,
      regeneratedFinishedLegStopIds,
      repairedStopOrders: stopOrderRepairUpdates.length,
      recalculatedTravelDistances: sortedForTravelDistance.length,
      originStrategy: latestFinishedStop ? 'last_finished_stop' : 'home_through_remaining_route',
      consolidatedLegs,
      pendingBreadcrumbLiveMerge
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