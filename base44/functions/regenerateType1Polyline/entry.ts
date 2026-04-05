import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

function isNotFoundError(error) {
  return error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
}

const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);
const HERE_POLYLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split('').reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});
const DEFAULT_MIN_MOVE_METERS = 75;
const DEFAULT_MIN_INTERVAL_MS = 30000;

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

// Re-use the decodeHereFlexiblePolyline function already defined above

function buildStopOrderRepairUpdates(deliveries) {
  const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
  const getCompletionTime = (delivery) => {
    const value = delivery?.actual_delivery_time || delivery?.arrival_time || delivery?.updated_date || delivery?.created_date || 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
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

async function getSegmentDirections(base44, from, to) {
  const response = await base44.functions.invoke('getHereDirections', {
    origin: { lat: from.lat, lng: from.lon },
    destination: { lat: to.lat, lng: to.lon }
  });

  const data = response?.data || response || {};
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
    const driverId = body?.driverId;
    const deliveryDate = body?.deliveryDate;
    const rawLocation = body?.currentLocation || {};
    const currentLat = Number(rawLocation?.lat);
    const currentLon = Number(rawLocation?.lon ?? rawLocation?.lng);
    const minMoveMeters = Number(body?.minMoveMeters || DEFAULT_MIN_MOVE_METERS);

    if (!driverId || !deliveryDate || !Number.isFinite(currentLat) || !Number.isFinite(currentLon)) {
      return Response.json({ error: 'driverId, deliveryDate, and currentLocation are required' }, { status: 400 });
    }

    const driverAppUser = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const homeLat = Number(driverAppUser[0]?.home_latitude);
    const homeLon = Number(driverAppUser[0]?.home_longitude);

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const stopOrderRepairUpdates = buildStopOrderRepairUpdates(deliveries);
    if (stopOrderRepairUpdates.length > 0) {
      await Promise.all(
        stopOrderRepairUpdates.map((update) =>
          base44.asServiceRole.entities.Delivery.update(update.id, { stop_order: update.stop_order })
        )
      );

      deliveries.forEach((delivery) => {
        const repaired = stopOrderRepairUpdates.find((update) => update.id === delivery.id);
        if (repaired) {
          delivery.stop_order = repaired.stop_order;
        }
      });
    }

    const activeStops = (deliveries || [])
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    if (activeStops.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'no_active_route', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    const patientIds = [...new Set(activeStops.filter((d) => d?.patient_id).map((d) => d.patient_id))];
    const storeIds = [...new Set(activeStops.filter((d) => d?.store_id).map((d) => d.store_id))];

    const [patients, stores, existingPolylines] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000) : [],
      base44.asServiceRole.entities.DriverRoutePolyline.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-updated_date', 50000)
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

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

    const nextActiveStop = activeStops.find((stop) => stop.isNextDelivery === true);
    if (!nextActiveStop) {
      return Response.json({ success: true, skipped: true, reason: 'no_next_delivery_marked', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    const nextStopCoords = getLatLon(nextActiveStop);
    if (!nextStopCoords) {
      return Response.json({ success: true, skipped: true, reason: 'missing_next_stop_coordinates', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    // CRITICAL: Origin is the stop immediately BEFORE the next delivery by stop_order, NOT by completion time
    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const nextStopOrder = Number(nextActiveStop?.stop_order || 0);
    
    // Find the stop with the highest stop_order that is less than nextStopOrder and is finished
    const originStop = (deliveries || [])
      .filter((d) => finishedStatuses.has(d.status) && Number(d?.stop_order || 0) < nextStopOrder)
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null;
    
    let originCoords;
    if (originStop) {
      originCoords = getLatLon(originStop);
      console.log(`[regenerateType1Polyline] Using completed stop ${originStop.id} (stop_order=${originStop.stop_order}) as origin`);
    } else if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
      originCoords = { lat: homeLat, lon: homeLon };
      console.log(`[regenerateType1Polyline] Using driver home location as origin (no completed stops yet)`);
    } else {
      // Fallback if no home location set and no completed stops - use current location
      originCoords = { lat: currentLat, lon: currentLon };
      console.log(`[regenerateType1Polyline] WARNING: Using driver current location as origin (no home location set)`);
    }
    
    if (!originCoords) {
      return Response.json({ success: true, skipped: true, reason: 'missing_origin_coordinates', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    const exactExistingType1 = (existingPolylines || []).find((row) =>
      round5(row?.segment_origin_lat) === round5(originCoords.lat) &&
      round5(row?.segment_origin_lon) === round5(originCoords.lon) &&
      round5(row?.segment_dest_lat) === round5(nextStopCoords.lat) &&
      round5(row?.segment_dest_lon) === round5(nextStopCoords.lon) &&
      typeof row?.encoded_polyline === 'string' && row.encoded_polyline.trim().length > 0
    ) || null;

    if (exactExistingType1) {
      return Response.json({ success: true, skipped: true, reason: 'cached_exact_segment', driverId, deliveryDate, nextStopId: nextActiveStop.id, repairedStopOrders: stopOrderRepairUpdates.length });
    }

    const existingType1 = (existingPolylines || []).find((row) =>
      round5(row?.segment_dest_lat) === round5(nextStopCoords.lat) &&
      round5(row?.segment_dest_lon) === round5(nextStopCoords.lon) &&
      row.encoded_polyline
    ) || null;

    if (existingType1) {
      // CRITICAL: Check if driver has deviated from the existing polyline route
      // Decode the existing polyline to check deviation
      let deviationMeters = Infinity;
      try {
        const decodedCoords = decodeHereFlexiblePolyline(existingType1.encoded_polyline);
        if (decodedCoords && decodedCoords.length > 1) {
          // Find closest point on polyline to current driver location
          let minDistance = Infinity;
          for (let i = 0; i < decodedCoords.length - 1; i++) {
            const dist = distanceMeters(currentLat, currentLon, decodedCoords[i][0], decodedCoords[i][1]);
            if (dist < minDistance) minDistance = dist;
          }
          deviationMeters = minDistance;
        }
      } catch (e) {
        console.warn('[regenerateType1Polyline] Failed to decode polyline for deviation check:', e);
      }

      // Only regenerate if driver has deviated significantly from the route (>200m)
      const hasDeviated = deviationMeters > 200;
      
      if (!hasDeviated) {
        // Check if origin point has changed (completed a new stop)
        const originChanged = !(
          round5(existingType1.segment_origin_lat) === round5(originCoords.lat) &&
          round5(existingType1.segment_origin_lon) === round5(originCoords.lon)
        );
        
        if (!originChanged) {
          return Response.json({ 
            success: true, 
            skipped: true, 
            reason: 'no_deviation_and_origin_unchanged', 
            deviationMeters: Math.round(deviationMeters),
            repairedStopOrders: stopOrderRepairUpdates.length 
          });
        }
        
        // Origin changed (driver completed a stop) - allow regeneration
        console.log(`[regenerateType1Polyline] Origin changed - regenerating polyline`);
      } else {
        console.log(`[regenerateType1Polyline] Driver deviated ${Math.round(deviationMeters)}m from route - regenerating`);
      }
    }

    const directions = await getSegmentDirections(base44, originCoords, nextStopCoords);

    const payload = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      encoded_polyline: directions.encoded_polyline,
      segment_origin_lat: round5(originCoords.lat),
      segment_origin_lon: round5(originCoords.lon),
      segment_dest_lat: round5(nextStopCoords.lat),
      segment_dest_lon: round5(nextStopCoords.lon),
      estimated_distance_km: directions.estimated_distance_km,
      estimated_duration_minutes: directions.estimated_duration_minutes,
      daily_generation_count: Number(existingType1?.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    };

    // Validation handled by determining originCoords; if we reach here, coordinates are considered valid.

    // Aggressive cleanup: delete any existing duplicate polylines for the exact origin-destination pair
    const exactMatchingSegments = existingPolylines.filter(row =>
      round5(row?.segment_origin_lat) === round5(originCoords.lat) &&
      round5(row?.segment_origin_lon) === round5(originCoords.lon) &&
      round5(row?.segment_dest_lat) === round5(nextStopCoords.lat) &&
      round5(row?.segment_dest_lon) === round5(nextStopCoords.lon)
    );

    let polylineRecordToUpdate = null;
    if (exactMatchingSegments.length > 0) {
      polylineRecordToUpdate = exactMatchingSegments[0];
      for (let i = 1; i < exactMatchingSegments.length; i++) {
        await base44.asServiceRole.entities.DriverRoutePolyline.delete(exactMatchingSegments[i].id).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }
    }

    if (polylineRecordToUpdate?.id) {
      await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecordToUpdate.id, payload).catch(async (error) => {
        if (isNotFoundError(error)) {
          await base44.asServiceRole.entities.DriverRoutePolyline.create(payload);
          return null;
        }
        throw error;
      });
    } else {
      await base44.asServiceRole.entities.DriverRoutePolyline.create(payload);
    }

    return Response.json({
      success: true,
      updated: true,
      driverId,
      deliveryDate,
      nextStopId: nextActiveStop.id,
      originStopId: originStop?.id || null,
      repairedStopOrders: stopOrderRepairUpdates.length
    });
  } catch (error) {
    console.error('[regenerateType1Polyline] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});