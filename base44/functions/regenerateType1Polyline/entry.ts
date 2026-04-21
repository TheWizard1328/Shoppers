// Redeployed on 2026-04-09
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
const DEFAULT_MIN_MOVE_METERS = 100;
const DEFAULT_MIN_INTERVAL_MS = 120000;

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

function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates = [];

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
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lat / 1e5, lon / 1e5]);
  }

  return coordinates;
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

function findExactStoredPolyline(rows, driverId, deliveryDate, from, to) {
  return (rows || []).find((row) =>
    row?.driver_id === driverId &&
    row?.delivery_date === deliveryDate &&
    round5(row?.segment_origin_lat) === round5(from.lat) &&
    round5(row?.segment_origin_lon) === round5(from.lon) &&
    round5(row?.segment_dest_lat) === round5(to.lat) &&
    round5(row?.segment_dest_lon) === round5(to.lon) &&
    typeof row?.encoded_polyline === 'string' && row.encoded_polyline.trim().length > 0
  ) || null;
}

async function getSegmentDirections(base44, from, to, transportMode = 'driving', existingPolylines = [], driverId = null, deliveryDate = null) {
  const cachedPolyline = findExactStoredPolyline(existingPolylines, driverId, deliveryDate, from, to);
  if (cachedPolyline) {
    return {
      encoded_polyline: cachedPolyline.encoded_polyline,
      estimated_distance_km: cachedPolyline.estimated_distance_km ?? null,
      estimated_duration_minutes: cachedPolyline.estimated_duration_minutes ?? null,
      transport_mode: cachedPolyline.transport_mode || transportMode || 'driving',
      from_cache: true
    };
  }

  const route = await getMultiStopRoute(base44, [from, to], transportMode);
  return {
    ...(route.sections[0] || {
      encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
      estimated_distance_km: null,
      estimated_duration_minutes: null,
      transport_mode: transportMode || 'driving'
    }),
    from_cache: false
  };
}

async function getMultiStopRoute(base44, points, transportMode = 'driving') {
  const validPoints = (points || []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
  if (validPoints.length < 2) {
    return { sections: [] };
  }

  const response = await base44.functions.invoke('getHereDirections', {
    origin: { lat: validPoints[0].lat, lng: validPoints[0].lon },
    destination: { lat: validPoints[validPoints.length - 1].lat, lng: validPoints[validPoints.length - 1].lon },
    waypoints: validPoints.slice(1, -1).map((point) => ({ lat: point.lat, lng: point.lon })),
    routeContext: validPoints.map((point) => ({ lat: point.lat, lng: point.lon })),
    transportMode
  });

  const data = response?.data || response || {};
  const sections = Array.isArray(data?.sections) ? data.sections : [];

  return {
    sections: validPoints.slice(0, -1).map((fromPoint, index) => {
      const section = sections[index] || {};
      let polyline = null;

      if (section?.polyline_format === 'flexible' && typeof section?.polyline === 'string') {
        const coords = decodeHereFlexiblePolyline(section.polyline);
        if (coords.length > 1) {
          polyline = encodeGooglePolyline(coords);
        }
      } else if (typeof section?.polyline === 'string' && section.polyline) {
        polyline = section.polyline;
      }

      if (!polyline) {
        const toPoint = validPoints[index + 1];
        polyline = encodeGooglePolyline([[fromPoint.lat, fromPoint.lon], [toPoint.lat, toPoint.lon]]);
      }

      return {
        encoded_polyline: polyline,
        estimated_distance_km: section?.estimated_distance_km ?? null,
        estimated_duration_minutes: section?.estimated_duration_minutes ?? null,
        transport_mode: data?.transport_mode || transportMode || 'driving'
      };
    })
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

    const [driverAppUser, driverUser, requesterAppUser] = await Promise.all([
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }),
      base44.asServiceRole.entities.User.filter({ id: driverId }, '-updated_date', 1),
      base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1)
    ]);
    const targetDriverAppUser = driverAppUser?.[0] || null;
    const actingAppUser = requesterAppUser?.[0] || null;
    const targetIsDriver = Array.isArray(targetDriverAppUser?.app_roles) && targetDriverAppUser.app_roles.includes('driver');
    const actorIsAdmin = Array.isArray(actingAppUser?.app_roles) && actingAppUser.app_roles.includes('admin');
    const actorIsSameDriver = user.id === driverId && Array.isArray(actingAppUser?.app_roles) && actingAppUser.app_roles.includes('driver');

    if (!targetDriverAppUser || !targetIsDriver) {
      return Response.json({ success: true, skipped: true, reason: 'target_not_driver' });
    }
    if (!actorIsAdmin && !actorIsSameDriver) {
      return Response.json({ success: true, skipped: true, reason: 'unauthorized_actor' });
    }
    if (targetDriverAppUser.driver_status === 'off_duty' || targetDriverAppUser.driver_status === 'on_break') {
      return Response.json({ success: true, skipped: true, reason: 'driver_unavailable' });
    }
    const homeLat = Number(driverAppUser[0]?.home_latitude ?? driverUser?.[0]?.home_latitude);
    const homeLon = Number(driverAppUser[0]?.home_longitude ?? driverUser?.[0]?.home_longitude);
    const preferredTravelMode = String(driverAppUser[0]?.preferred_travel_mode || 'driving').toLowerCase();

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

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const mostRecentFinishedStop = (deliveries || [])
      .filter((delivery) => finishedStatuses.has(delivery.status))
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null;

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

    const nextActiveStop = activeStops.find((stop) => stop.isNextDelivery === true) || null;
    const incompleteStops = (deliveries || [])
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

    const nextStopCoords = nextActiveStop
      ? getLatLon(nextActiveStop)
      : (mostRecentFinishedStop && Number.isFinite(homeLat) && Number.isFinite(homeLon)
          ? { lat: homeLat, lon: homeLon }
          : null);

    if (!nextStopCoords) {
      return Response.json({ success: true, skipped: true, reason: 'missing_next_stop_coordinates', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    let baseOriginCoords = null;
    if (mostRecentFinishedStop) {
      baseOriginCoords = getLatLon(mostRecentFinishedStop);
      console.log(`[regenerateType1Polyline] Using most recent finished stop ${mostRecentFinishedStop.id} as base origin`);
    } else if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
      baseOriginCoords = { lat: homeLat, lon: homeLon };
      console.log('[regenerateType1Polyline] Using driver home location as base origin');
    } else {
      baseOriginCoords = { lat: currentLat, lon: currentLon };
      console.log('[regenerateType1Polyline] WARNING: Using current location as base origin');
    }

    if (!baseOriginCoords) {
      return Response.json({ success: true, skipped: true, reason: 'missing_origin_coordinates', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    const effectiveOriginCoords = baseOriginCoords;

    const exactExistingType1 = (existingPolylines || []).find((row) =>
      round5(row?.segment_origin_lat) === round5(effectiveOriginCoords.lat) &&
      round5(row?.segment_origin_lon) === round5(effectiveOriginCoords.lon) &&
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

    if (!body?.force && !body?.allowDeviationCheck) {
      return Response.json({ success: true, skipped: true, reason: 'deviation_only_guard', repairedStopOrders: stopOrderRepairUpdates.length });
    }

    if (existingType1) {
      // CRITICAL: Check if driver has deviated from the existing polyline route
      // Decode the existing polyline to check deviation
      let deviationMeters = Infinity;
      try {
        let decodedCoords = decodeGooglePolyline(existingType1.encoded_polyline);
        if (!decodedCoords || decodedCoords.length <= 1) {
          decodedCoords = decodeHereFlexiblePolyline(existingType1.encoded_polyline);
        }
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

      // Only regenerate if driver has deviated significantly from the route
      const hasDeviated = deviationMeters > minMoveMeters;
      
      if (!hasDeviated) {
        return Response.json({ 
          success: true, 
          skipped: true, 
          reason: 'no_route_deviation', 
          deviationMeters: Math.round(deviationMeters),
          repairedStopOrders: stopOrderRepairUpdates.length 
        });
      } else {
        console.log(`[regenerateType1Polyline] Driver deviated ${Math.round(deviationMeters)}m from route - regenerating`);
      }
    }

    const driverDeviationMeters = existingType1
      ? distanceMeters(currentLat, currentLon, Number(existingType1.segment_origin_lat), Number(existingType1.segment_origin_lon))
      : 0;
    const remainingRoutePoints = [
      effectiveOriginCoords,
      ...incompleteStops.map((stop) => {
        const coords = getLatLon(stop);
        return coords ? { lat: coords.lat, lon: coords.lon } : null;
      }).filter(Boolean)
    ];
    const multiStopRoute = await getMultiStopRoute(base44, remainingRoutePoints, preferredTravelMode);
    const directions = multiStopRoute.sections[0] || await getSegmentDirections(base44, effectiveOriginCoords, nextStopCoords, preferredTravelMode, existingPolylines, driverId, deliveryDate);

    const payload = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      encoded_polyline: directions.encoded_polyline,
      segment_origin_lat: round5(effectiveOriginCoords.lat),
      segment_origin_lon: round5(effectiveOriginCoords.lon),
      segment_dest_lat: round5(nextStopCoords.lat),
      segment_dest_lon: round5(nextStopCoords.lon),
      estimated_distance_km: directions.estimated_distance_km,
      estimated_duration_minutes: directions.estimated_duration_minutes,
      transport_mode: directions.transport_mode || preferredTravelMode,
      daily_generation_count: directions.from_cache ? Number(existingType1?.daily_generation_count || 0) : Number(existingType1?.daily_generation_count || 0) + 1,
      last_generated_at: directions.from_cache ? (existingType1?.last_generated_at || new Date().toISOString()) : new Date().toISOString()
    };

    // Validation handled by determining originCoords; if we reach here, coordinates are considered valid.

    // Aggressive cleanup: delete any existing duplicate polylines for the exact origin-destination pair
    const exactMatchingSegments = existingPolylines.filter(row =>
      round5(row?.segment_origin_lat) === round5(effectiveOriginCoords.lat) &&
      round5(row?.segment_origin_lon) === round5(effectiveOriginCoords.lon) &&
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

    if (!directions.from_cache) {
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
    }

    return Response.json({
      success: true,
      updated: true,
      driverId,
      deliveryDate,
      nextStopId: nextActiveStop?.id || 'HOME_LOCATION',
      originStopId: mostRecentFinishedStop?.id || null,
      repairedStopOrders: stopOrderRepairUpdates.length
    });
  } catch (error) {
    console.error('[regenerateType1Polyline] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});