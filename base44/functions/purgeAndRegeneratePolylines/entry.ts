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

async function getSegmentDirections(base44, from, to) {
  const segments = await getMultiSegmentDirections(base44, [{ from, to }]);
  return segments[0] || {
    encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
    estimated_distance_km: null,
    estimated_duration_minutes: null
  };
}

async function getMultiSegmentDirections(base44, segmentSpecs, transportMode = 'driving') {
  const safeSpecs = Array.isArray(segmentSpecs) ? segmentSpecs.filter((segment) => segment?.from && segment?.to) : [];
  if (safeSpecs.length === 0) return [];

  const origin = safeSpecs[0].from;
  const destination = safeSpecs[safeSpecs.length - 1].to;
  const waypoints = safeSpecs.slice(0, -1).map((segment) => ({ lat: segment.to.lat, lng: segment.to.lon }));

  try {
    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: origin.lat, lng: origin.lon },
      destination: { lat: destination.lat, lng: destination.lon },
      waypoints,
      transportMode
    });

    const data = response?.data || response || {};
    const sections = Array.isArray(data?.sections) ? data.sections : [];

    return safeSpecs.map((segment, index) => {
      const section = sections[index] || null;
      let polyline = null;

      if (section?.polyline && data?.polyline_format === 'flexible') {
        const coords = decodeHereFlexiblePolyline(section.polyline);
        if (coords.length > 1) polyline = encodeGooglePolyline(coords);
      } else if (typeof section?.polyline === 'string' && section.polyline) {
        polyline = section.polyline;
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
    const { driverId, deliveryDate, scope = 'active_only', reason = 'manual' } = body || {};

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

    const stopOrderRepairUpdates = buildStopOrderRepairUpdates(deliveries);
    if (stopOrderRepairUpdates.length > 0) {
      console.log(`# [purgeAndRegeneratePolylines] BEFORE stopOrderRepair bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0} | repairCount=${stopOrderRepairUpdates.length}`);
      const stopOrderUpdatesById = new Map(stopOrderRepairUpdates.map((update) => [update.id, { stop_order: update.stop_order }]));
      deliveries = await bulkUpdateDeliveries(base44, deliveries, stopOrderUpdatesById);
      const afterStopOrderRepairDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000);
      console.log(`# [purgeAndRegeneratePolylines] AFTER stopOrderRepair bulkUpdateDeliveries | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${afterStopOrderRepairDeliveries?.length || 0} | repairCount=${stopOrderRepairUpdates.length}`);
      deliveries = afterStopOrderRepairDeliveries;
    }

    const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '-updated_date', 50000);

    const structuralReason = ['stops_added', 'stops_deleted', 'route_reordered', 'manual'];
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
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));
    const driverAppUser = Array.isArray(appUsers) ? appUsers[0] : null;
    console.log(`# [purgeAndRegeneratePolylines] START | driver=${driverDisplayName} | date=${deliveryDate} | scope=${scope} | totalStops=${deliveries?.length || 0} | existingPolylines=${existingPolylines?.length || 0}`);

    const getLatLon = (delivery) => {
      if (!delivery) return null;

      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        if (patient?.latitude != null && patient?.longitude != null) {
          return { lat: Number(patient.latitude), lon: Number(patient.longitude) };
        }
      }

      if (delivery.store_id) {
        const store = storeMap.get(delivery.store_id);
        if (store?.latitude != null && store?.longitude != null) {
          return { lat: Number(store.latitude), lon: Number(store.longitude) };
        }
      }

      return null;
    };

    const finishedStops = deliveries
      .filter((delivery) => FINISHED_STATUSES.has(delivery.status))
      .sort((a, b) => {
        const aTime = new Date(a.actual_delivery_time || a.updated_date || a.created_date || 0).getTime();
        const bTime = new Date(b.actual_delivery_time || b.updated_date || b.created_date || 0).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return (a.stop_order || 0) - (b.stop_order || 0);
      });

    const latestFinishedStop = finishedStops[finishedStops.length - 1] || null;
    const activeStops = deliveries
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

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

    if (scope === 'all' || scope === 'completed_only') {
      const finishedSegmentSpecs = [];
      for (let index = 0; index < finishedStops.length; index += 1) {
        const stop = finishedStops[index];
        const previousStop = finishedStops[index - 1];
        const from = previousStop ? getLatLon(previousStop) : (() => {
          const store = storeMap.get(stop?.store_id);
          if (store?.latitude != null && store?.longitude != null) {
            return { lat: Number(store.latitude), lon: Number(store.longitude) };
          }
          return null;
        })();
        const to = getLatLon(stop);
        if (!from || !to) continue;
        const existingBreadcrumbs = stop?.delivery_route_breadcrumbs || null;
        const fallbackBreadcrumbs = existingBreadcrumbs || buildFallbackBreadcrumbs(
          from,
          to,
          new Date(stop?.actual_delivery_time || stop?.arrival_time || stop?.updated_date || stop?.created_date || Date.now()).getTime()
        );
        finishedSegmentSpecs.push({
          stop,
          from,
          to,
          breadcrumbDirections: parseBreadcrumbPolyline(existingBreadcrumbs),
          fallbackBreadcrumbs,
          usedFallbackBreadcrumbs: !existingBreadcrumbs && !!fallbackBreadcrumbs
        });
      }

      const finishedSegmentsNeedingApi = finishedSegmentSpecs.filter((segment) => !segment.breadcrumbDirections);
      const finishedDirectionsFromApi = finishedSegmentsNeedingApi.length > 0
        ? await getMultiSegmentDirections(base44, finishedSegmentsNeedingApi.map((segment) => ({ from: segment.from, to: segment.to })))
        : [];
      if (finishedSegmentsNeedingApi.length > 0) apiCallsMade += 1;

      let apiDirectionIndex = 0;
      finishedSegmentSpecs.forEach((segment) => {
        const directions = segment.breadcrumbDirections || finishedDirectionsFromApi[apiDirectionIndex++] || null;
        regeneratedFinishedLegStopIds.push(segment.stop.id);
        deliveryUpdatesById.set(segment.stop.id, {
          ...(deliveryUpdatesById.get(segment.stop.id) || {}),
          delivery_route_breadcrumbs: segment.usedFallbackBreadcrumbs ? segment.fallbackBreadcrumbs : (deliveryUpdatesById.get(segment.stop.id)?.delivery_route_breadcrumbs || segment.stop?.delivery_route_breadcrumbs),
          finished_leg_encoded_polyline: directions?.encoded_polyline || null,
          finished_leg_transport_mode: segment.stop?.finished_leg_transport_mode || 'driving',
          travel_dist: directions?.estimated_distance_km ?? null,
          PolylineUpdated: true
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

    if (scope === 'all' || scope === 'active_only') {
      const firstActive = getLatLon(activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0]);
      const preservedType1Row = scope === 'active_only' && firstActive
        ? (existingPolylines || []).find((row) => samePoint({ lat: row?.segment_dest_lat, lon: row?.segment_dest_lon }, firstActive)) || null
        : null;

      if (activeStops.length > 0) {
        const segmentSpecs = [];
        const seen = new Set();

        const pushSegment = (from, to, force = false) => {
          if (!from || !to) return;
          if (![from.lat, from.lon, to.lat, to.lon].every((value) => Number.isFinite(value))) return;
          const key = makeSegmentKey(driverId, deliveryDate, from, to);
          if (seen.has(key)) return;
          seen.add(key);
          segmentSpecs.push({ from, to, force });
        };

        const currentLat = Number(driverAppUser?.current_latitude);
        const currentLon = Number(driverAppUser?.current_longitude);
        const isToday = deliveryDate === getEdmontonDateString();

        const originFromFinishedStop = latestFinishedStop ? getLatLon(latestFinishedStop) : null;
        const useDriverLocationAsOrigin = scope === 'active_only' && firstActive && isToday && Number.isFinite(currentLat) && Number.isFinite(currentLon);

        if (useDriverLocationAsOrigin) {
          pushSegment({ lat: currentLat, lon: currentLon }, firstActive);
        }

        for (let index = 0; index < activeStops.length; index += 1) {
          const stop = activeStops[index];
          const previousStop = activeStops[index - 1];
          const from = previousStop
            ? getLatLon(previousStop)
            : originFromFinishedStop || (() => {
              const store = storeMap.get(stop?.store_id);
              if (store?.latitude != null && store?.longitude != null) {
                return { lat: Number(store.latitude), lon: Number(store.longitude) };
              }
              return null;
            })();
          const to = getLatLon(stop);
          pushSegment(from, to);
        }

        const lastActive = getLatLon(activeStops[activeStops.length - 1]);
        const homeLat = Number(driverAppUser?.home_latitude);
        const homeLon = Number(driverAppUser?.home_longitude);
        const hasHomeCoords = Number.isFinite(homeLat) && Number.isFinite(homeLon);

        const shouldAddHomeStartLeg = hasHomeCoords && firstActive && !originFromFinishedStop;
        if (shouldAddHomeStartLeg) {
          pushSegment({ lat: homeLat, lon: homeLon }, firstActive, true);
        }

        if (hasHomeCoords && lastActive) {
          pushSegment(lastActive, { lat: homeLat, lon: homeLon }, true);
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

        const uncachedDirections = await getMultiSegmentDirections(base44, uncachedSegments);
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
        const rowsToDelete = (existingPolylines || []).filter((row) => {
          if (segmentsToKeep.has(row.id)) return false;
          const rowKey = makeSegmentKey(driverId, deliveryDate, { lat: row?.segment_origin_lat, lon: row?.segment_origin_lon }, { lat: row?.segment_dest_lat, lon: row?.segment_dest_lon });
          return !allowedActiveSegmentKeys.has(rowKey);
        });
        if (rowsToDelete.length > 0) {
          console.log(`#[purgeAndRegeneratePolylines] BEFORE delete old polylines | driver=${driverDisplayName} | date=${deliveryDate} | rowsToDelete=${rowsToDelete.length} | totalStops=${deliveries?.length || 0}`);
          await processInChunks(rowsToDelete, 5, (row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
          console.log(`# [purgeAndRegeneratePolylines] AFTER delete old polylines | driver=${driverDisplayName} | date=${deliveryDate} | rowsToDelete=${rowsToDelete.length} | totalStops=${deliveries?.length || 0}`);
        }
        deletedPolylineCount = rowsToDelete.length;

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
        const hasHomeCoords = Number.isFinite(homeLat) && Number.isFinite(homeLon);
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
        const rowsToDelete = (existingPolylines || []).filter((row) => {
          if (segmentsToKeep.has(row.id)) return false;
          const rowKey = makeSegmentKey(driverId, deliveryDate, { lat: row?.segment_origin_lat, lon: row?.segment_origin_lon }, { lat: row?.segment_dest_lat, lon: row?.segment_dest_lon });
          return !allowedCompletedSegmentKeys.has(rowKey);
        });
        if (rowsToDelete.length > 0) {
          await processInChunks(rowsToDelete, 5, (row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
        }
        deletedPolylineCount = rowsToDelete.length;

        if (createdSegments.length > 0) {
          await base44.asServiceRole.entities.DriverRoutePolyline.bulkCreate(createdSegments);
        }
      }
    }

    console.log(`# [purgeAndRegeneratePolylines] BEFORE markDeliveriesPolylineUpdated | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${deliveries?.length || 0}`);
    await markDeliveriesPolylineUpdated(base44, deliveries, true);
    const finalDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);
    console.log(`# [purgeAndRegeneratePolylines] AFTER markDeliveriesPolylineUpdated | driver=${driverDisplayName} | date=${deliveryDate} | totalStops=${finalDeliveries?.length || 0}`);

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
      originStrategy: latestFinishedStop ? 'last_finished_stop' : 'home_through_remaining_route'
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