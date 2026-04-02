/* Force Redeploy */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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
  const deliveryMap = new Map(safeDeliveries.map((delivery) => [delivery.id, delivery]));
  const payload = Array.from(updatesById.entries()).map(([id, update]) => {
    const existing = deliveryMap.get(id);
    if (!existing) return null;
    return { ...existing, ...update };
  }).filter(Boolean);

  try {
    await base44.asServiceRole.entities.Delivery.bulkCreate(payload);
    return mergeDeliveryUpdates(safeDeliveries, updatesById);
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn('[bulkUpdateDeliveries] Rate limit during bulk update');
    }
    throw error;
  }
}

async function markDeliveriesPolylineUpdated(base44, deliveries, value) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return;

  const eligibleDeliveries = deliveries.filter((delivery) =>
    delivery && delivery.finished_leg_end_longitude != null && delivery.finished_leg_end_longitude !== ''
  );

  if (eligibleDeliveries.length === 0) return;

  await processInChunks(eligibleDeliveries, 20, async (delivery) => {
    try {
      return await base44.asServiceRole.entities.Delivery.update(delivery.id, { PolylineUpdated: value });
    } catch (error) {
      if (isRateLimitError(error)) {
        console.warn('[markDeliveriesPolylineUpdated] Rate limit, skipping flag update');
        return null;
      }
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
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
  let data = {};

  try {
    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: from.lat, lng: from.lon },
      destination: { lat: to.lat, lng: to.lon }
    });

    data = response?.data || response || {};
  } catch (error) {
    console.warn('[purgeAndRegeneratePolylines] Directions unavailable, using fallback segment:', error?.message || error);
    return {
      encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
      estimated_distance_km: null,
      estimated_duration_minutes: null
    };
  }

  let polyline = null;

  if (Array.isArray(data?.coordinates) && data.coordinates.length > 1) {
    polyline = encodeGooglePolyline(
      data.coordinates.map((point) => [Number(point?.lat ?? point?.latitude), Number(point?.lng ?? point?.longitude)])
    );
  } else if (data?.polyline_format === 'flexible' && typeof data?.polyline === 'string') {
    const coords = decodeHereFlexiblePolyline(data.polyline);
    if (coords.length > 1) {
      polyline = encodeGooglePolyline(coords);
    }
  } else if (typeof data?.polyline === 'string' && data.polyline) {
    polyline = data.polyline;
  }

  if (!polyline) {
    polyline = encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]);
  }

  return {
    encoded_polyline: polyline,
    estimated_distance_km: data?.estimated_distance_km ?? null,
    estimated_duration_minutes: data?.estimated_duration_minutes ?? null
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate, scope = 'all' } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    let deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const stopOrderRepairUpdates = buildStopOrderRepairUpdates(deliveries);
    if (stopOrderRepairUpdates.length > 0) {
      const stopOrderUpdatesById = new Map(stopOrderRepairUpdates.map((update) => [update.id, { stop_order: update.stop_order }]));
      deliveries = await bulkUpdateDeliveries(base44, deliveries, stopOrderUpdatesById);
    }

    const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '-updated_date', 50000);

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

    const activeStops = deliveries
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    let apiCallsMade = 0;
    let deletedPolylineCount = 0;
    let clearedFinishedLegs = 0;
    const regeneratedFinishedLegStopIds = [];
    const deliveryUpdatesById = new Map();

    if (scope === 'all' || scope === 'completed_only') {
      const finishedLegsToClear = finishedStops.filter((delivery) => typeof delivery?.finished_leg_encoded_polyline === 'string'
        ? delivery.finished_leg_encoded_polyline.trim().length > 0
        : !!delivery?.finished_leg_encoded_polyline);

      if (finishedLegsToClear.length > 0) {
        finishedLegsToClear.forEach((delivery) => {
          deliveryUpdatesById.set(delivery.id, {
            ...(deliveryUpdatesById.get(delivery.id) || {}),
            finished_leg_encoded_polyline: ''
          });
        });
      }
      clearedFinishedLegs = finishedLegsToClear.length;

      for (let index = 1; index < finishedStops.length; index += 1) {
        const fromStop = getLatLon(finishedStops[index - 1]);
        const toStop = getLatLon(finishedStops[index]);
        if (!fromStop || !toStop) continue;

        const cachedSegment = findExactCachedSegment(existingPolylines, fromStop, toStop);
        const directions = cachedSegment ? {
          encoded_polyline: cachedSegment.encoded_polyline,
          estimated_distance_km: cachedSegment.estimated_distance_km ?? null,
          estimated_duration_minutes: cachedSegment.estimated_duration_minutes ?? null
        } : await getSegmentDirections(base44, fromStop, toStop);
        if (!cachedSegment) {
          apiCallsMade += 1;
        }

        deliveryUpdatesById.set(finishedStops[index].id, {
          ...(deliveryUpdatesById.get(finishedStops[index].id) || {}),
          finished_leg_encoded_polyline: directions.encoded_polyline || ''
        });

        regeneratedFinishedLegStopIds.push(finishedStops[index].id);
      }
    }

    const createdSegments = [];

    if (deliveryUpdatesById.size > 0) {
      deliveries = await bulkUpdateDeliveries(base44, deliveries, deliveryUpdatesById);
    }

    if (scope === 'all' || scope === 'active_only') {
      const firstActive = getLatLon(activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0]);
      const preservedType1Row = scope === 'active_only' && firstActive
        ? (existingPolylines || []).find((row) => samePoint({ lat: row?.segment_dest_lat, lon: row?.segment_dest_lon }, firstActive)) || null
        : null;

      if (activeStops.length > 0) {
        const segmentSpecs = [];
        const seen = new Set();

        const pushSegment = (from, to) => {
          if (!from || !to) return;
          if (![from.lat, from.lon, to.lat, to.lon].every((value) => Number.isFinite(value))) return;
          const key = makeSegmentKey(driverId, deliveryDate, from, to);
          if (seen.has(key)) return;
          seen.add(key);
          segmentSpecs.push({ from, to });
        };

        const currentLat = Number(driverAppUser?.current_latitude);
        const currentLon = Number(driverAppUser?.current_longitude);
        const isToday = deliveryDate === getEdmontonDateString();

        if (scope === 'all' && firstActive && isToday && Number.isFinite(currentLat) && Number.isFinite(currentLon)) {
          pushSegment({ lat: currentLat, lon: currentLon }, firstActive);
        }

        for (let index = 0; index < activeStops.length - 1; index += 1) {
          const from = getLatLon(activeStops[index]);
          const to = getLatLon(activeStops[index + 1]);
          pushSegment(from, to);
        }

        const lastActive = getLatLon(activeStops[activeStops.length - 1]);
        const homeLat = Number(driverAppUser?.home_latitude);
        const homeLon = Number(driverAppUser?.home_longitude);

        if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
          pushSegment(lastActive, { lat: homeLat, lon: homeLon });
        }

        const segmentsToKeep = new Set();
        if (preservedType1Row) {
          segmentsToKeep.add(preservedType1Row.id);
        }

        for (const spec of segmentSpecs) {
          const cachedSegment = findExactCachedSegment(existingPolylines, spec.from, spec.to);
          if (cachedSegment) {
            segmentsToKeep.add(cachedSegment.id);
            // We already have this segment, no need to recreate
          } else {
            const directions = await getSegmentDirections(base44, spec.from, spec.to);
            apiCallsMade += 1;
            createdSegments.push({
              driver_id: driverId,
              delivery_date: deliveryDate,
              encoded_polyline: directions.encoded_polyline,
              segment_origin_lat: round5(spec.from.lat),
              segment_origin_lon: round5(spec.from.lon),
              segment_dest_lat: round5(spec.to.lat),
              segment_dest_lon: round5(spec.to.lon),
              estimated_distance_km: directions.estimated_distance_km,
              estimated_duration_minutes: directions.estimated_duration_minutes,
              daily_generation_count: previousGenerationCount + apiCallsMade,
              last_generated_at: new Date().toISOString()
            });
          }
        }

        const rowsToDelete = (existingPolylines || []).filter((row) => !segmentsToKeep.has(row.id));
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
      } else {
        const rowsToDelete = (existingPolylines || []).filter((row) => row?.id !== preservedType1Row?.id);
        if (rowsToDelete.length > 0) {
          await processInChunks(rowsToDelete, 5, (row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            })
          );
        }
        deletedPolylineCount = rowsToDelete.length;
      }
    }

    await markDeliveriesPolylineUpdated(base44, deliveries, true);

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
      repairedStopOrders: stopOrderRepairUpdates.length
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