// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const TIME_ZONE = 'America/Edmonton';
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_ROUTE_STATUSES = ['in_transit', 'en_route'];

const isRateLimitError = (error) => {
  const status = error?.status || error?.response?.status;
  const message = String(error?.message || '').toLowerCase();
  return status === 429 || message.includes('rate limit');
};
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

const normalizeTimeString = (timeStr, fallback) => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  const hours = String(Number(parts[0]) || 0).padStart(2, '0');
  const minutes = String(Number(parts[1]) || 0).padStart(2, '0');
  const seconds = String(Number(parts[2]) || 0).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60) + minutes;
};

const getEffectiveWindowStart = (delivery, patient = null) => {
  return delivery?.time_window_start || patient?.time_window_start || delivery?.delivery_time_start || null;
};

const getEffectiveWindowEnd = (delivery, patient = null) => {
  return delivery?.time_window_end || patient?.time_window_end || delivery?.delivery_time_end || null;
};

const isLateWindowStop = (windowStart, currentMinutes) => {
  const startMinutes = parseTimeToMinutes(windowStart);
  return startMinutes !== null && startMinutes > currentMinutes;
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
    timeZone: TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit'
  }).formatToParts(sampleDate).find((part) => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  const sign = match[1];
  const hours = String(match[2]).padStart(2, '0');
  const minutes = String(match[3] || '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
};

const buildLocalIso = (dateStr, timeStr) => {
  const normalizedTime = normalizeTimeString(timeStr, '00:00:00');
  return `${dateStr}T${normalizedTime}${getTimeZoneOffset(dateStr)}`;
};

const getEdmontonCurrentTime = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  return `${hour}:${minute}`;
};

const getEdmontonNowParts = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  return {
    date: `${parts.find((part) => part.type === 'year')?.value || '0000'}-${parts.find((part) => part.type === 'month')?.value || '00'}-${parts.find((part) => part.type === 'day')?.value || '00'}`,
    time: `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`
  };
};

const extractTimeFromDateTime = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
};

const resolveEtaBaseTime = (deliveryDate, completedDeliveries, fallbackTime) => {
  const now = getEdmontonNowParts();
  const routeIsPastDate = deliveryDate < now.date;
  const routeIsLateToday = deliveryDate === now.date && (parseTimeToMinutes(now.time) ?? 0) >= (21 * 60);
  const shouldUseFinishedStopTime = routeIsPastDate || routeIsLateToday;

  if (!shouldUseFinishedStopTime) {
    return fallbackTime;
  }

  const latestFinished = [...completedDeliveries]
    .filter((delivery) => delivery?.actual_delivery_time)
    .sort((a, b) => new Date(b.actual_delivery_time).getTime() - new Date(a.actual_delivery_time).getTime())[0];

  return extractTimeFromDateTime(latestFinished?.actual_delivery_time) || fallbackTime;
};

const resolveCurrentTime = ({ currentLocalTime, deviceTime }) => {
  if (typeof currentLocalTime === 'string' && currentLocalTime.includes(':')) {
    return currentLocalTime.slice(0, 5);
  }
  if (typeof deviceTime === 'string') {
    const match = deviceTime.match(/T(\d{2}:\d{2})/);
    if (match) return match[1];
  }
  return getEdmontonCurrentTime();
};

const buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes) {
    return null;
  }
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const formatMinutesToHHMM = (minutes) => {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const estimateCrowFliesTravelMinutes = (fromLat, fromLng, toLat, toLng) => {
  const lat1 = Number(fromLat);
  const lng1 = Number(fromLng);
  const lat2 = Number(toLat);
  const lng2 = Number(toLng);
  if ([lat1, lng1, lat2, lng2].some((value) => Number.isNaN(value))) return 0;
  const earthRadiusKm = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = earthRadiusKm * c;
  return Math.max(0, Math.ceil((distanceKm / 40) * 60));
};

const isValidEntityId = (value) => /^[a-f0-9]{24}$/i.test(String(value || ''));
const isActiveRouteStatus = (status) => ACTIVE_ROUTE_STATUSES.includes(status);
const round5 = (value) => Number(Number(value).toFixed(5));
const sameSegmentPoint = (a, b) => {
  if (!a || !b) return false;
  return round5(a.lat) === round5(b.lat) && round5(a.lng) === round5(b.lng);
};

const getStopCoordinates = (delivery, patientMap, storeMap) => {
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    return { lat: patient?.latitude, lng: patient?.longitude, patient };
  }
  const store = storeMap.get(delivery.store_id);
  return { lat: store?.latitude, lng: store?.longitude, store: store || null };
};

Deno.serve(async (req) => {
  console.log('🚀 [optimizeRouteRealTime] Function called');

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { driverId, selectedDriverId, deliveryDate, startLocation, currentLocalTime, deviceTime } = body;
    const targetDriverId = selectedDriverId || driverId;

    if (!targetDriverId || !deliveryDate) {
      return Response.json({ error: 'Missing required parameters: driverId, deliveryDate' }, { status: 400 });
    }


    const [driverAppUsers, callerAppUsers, driverUsers] = await Promise.all([
      base44.asServiceRole.entities.AppUser.filter({ user_id: targetDriverId }),
      base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1),
      base44.asServiceRole.entities.User.filter({ id: targetDriverId }, '-updated_date', 1)
    ]);
    const driverAppUser = driverAppUsers?.[0];
    const callerAppUser = callerAppUsers?.[0];
    const driverUser = driverUsers?.[0];

    if (!driverAppUser || driverAppUser.driver_status === 'off_duty' || driverAppUser.driver_status === 'on_break') {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        routeChanged: false,
        optimizedRoute: [],
        totalStops: 0,
        apiCallsMade: 0,
        driverId: targetDriverId
      });
    }
    const resolvedHomeLat = driverAppUser?.home_latitude ?? driverUser?.home_latitude ?? null;
    const resolvedHomeLng = driverAppUser?.home_longitude ?? driverUser?.home_longitude ?? null;

    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    let currentPosition = null;
    let locationSource = null;
    let previousType1Origin = null;
    let previousType1Destination = null;

    if (startLocation?.lat != null && startLocation?.lng != null) {
      currentPosition = { lat: Number(startLocation.lat), lng: Number(startLocation.lng) };
      locationSource = 'start_button';
    } else if (driverAppUser.current_latitude != null && driverAppUser.current_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) };
      locationSource = 'gps';
    }

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: targetDriverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    const completedDeliveries = allDeliveries.filter((delivery) => FINISHED_STATUSES.includes(delivery.status));
    const activeDeliveries = allDeliveries.filter((delivery) => isActiveRouteStatus(delivery.status));
    const pendingDeliveries = allDeliveries.filter((delivery) => delivery.status === 'pending');
    const optimizationDeliveries = [...activeDeliveries, ...pendingDeliveries];

    completedDeliveries.sort((a, b) => {
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time).getTime() - new Date(b.actual_delivery_time).getTime();
    });

    if (activeDeliveries.length === 0) {
      return Response.json({ message: 'No active deliveries to optimize', routeChanged: false, optimizedRoute: [], totalStops: 0, apiCallsMade: 0 });
    }

    const patientIds = [...new Set(optimizationDeliveries
      .filter((delivery) => delivery.patient_id && isValidEntityId(delivery.patient_id))
      .map((delivery) => delivery.patient_id))];
    const storeIds = [...new Set(optimizationDeliveries.map((delivery) => delivery.store_id).filter(Boolean))];

    const [patients, stores, existingPolylines] = await Promise.all([
      patientIds.length > 0 ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }) : [],
      storeIds.length > 0 ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }) : [],
      base44.asServiceRole.entities.DriverRoutePolyline.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, '-updated_date', 50000)
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));
    const existingType1Row = (existingPolylines || []).find((row) => typeof row?.encoded_polyline === 'string' && row.encoded_polyline.trim().length > 0);
    previousType1Origin = existingType1Row ? { lat: Number(existingType1Row.segment_origin_lat), lng: Number(existingType1Row.segment_origin_lon) } : null;
    previousType1Destination = existingType1Row ? { lat: Number(existingType1Row.segment_dest_lat), lng: Number(existingType1Row.segment_dest_lon) } : null;

    if (!currentPosition && completedDeliveries.length > 0) {
      const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
      const lastCompletedCoords = getStopCoordinates(lastCompleted, patientMap, storeMap);
      if (lastCompletedCoords.lat != null && lastCompletedCoords.lng != null) {
        currentPosition = { lat: Number(lastCompletedCoords.lat), lng: Number(lastCompletedCoords.lng) };
        locationSource = 'last_completed';
      }
    }

    if (!currentPosition && resolvedHomeLat != null && resolvedHomeLng != null) {
      currentPosition = { lat: Number(resolvedHomeLat), lng: Number(resolvedHomeLng) };
      locationSource = 'home';
    }

    const currentRouteMinutes = parseTimeToMinutes(resolveCurrentTime({ currentLocalTime, deviceTime })) ?? parseTimeToMinutes(getEdmontonCurrentTime()) ?? 0;

    const stops = optimizationDeliveries
      .map((delivery, index) => {
        const { lat, lng, patient } = getStopCoordinates(delivery, patientMap, storeMap);
        const isPickup = !delivery.patient_id;
        const windowStart = getEffectiveWindowStart(delivery, patient);
        const windowEnd = getEffectiveWindowEnd(delivery, patient);
        const serviceMinutes = isPickup
          ? Math.max(Number(delivery.extra_time || 0), 15)
          : Math.max(Number(delivery.extra_time || 0), 5);
        const priorityRank = ACTIVE_ROUTE_STATUSES.includes(delivery.status) ? 0 : 1;
        const hasLateWindow = isLateWindowStop(windowStart, currentRouteMinutes);

        return {
          delivery,
          lat: lat != null ? Number(lat) : null,
          lng: lng != null ? Number(lng) : null,
          isPickup,
          isPending: delivery.status === 'pending',
          windowStart,
          windowEnd,
          serviceMinutes,
          priorityRank,
          hasLateWindow,
          waypointId: `destination${index + 1}`,
          waypointLabel: delivery.stop_id || delivery.delivery_id || delivery.id
        };
      })
      .filter((stop) => stop.lat != null && stop.lng != null && !Number.isNaN(stop.lat) && !Number.isNaN(stop.lng));

    if (stops.length === 0) {
      return Response.json({ error: 'No active stops have valid coordinates', routeChanged: false }, { status: 400 });
    }

    const nextDeliveryStop = stops.find((stop) => stop.delivery.isNextDelivery === true) || null;
    const canKeepLockedNextStop = !!nextDeliveryStop && !nextDeliveryStop.hasLateWindow;
    const lockedNextStop = canKeepLockedNextStop ? nextDeliveryStop : null;
    const stopsToSequence = lockedNextStop
      ? stops.filter((stop) => stop.delivery.id !== lockedNextStop.delivery.id)
      : stops;
    const optimizationStartPosition = currentPosition;

    if (!optimizationStartPosition?.lat || !optimizationStartPosition?.lng) {
      return Response.json({
        error: 'Driver location is unavailable for route optimization',
        routeChanged: false,
        details: {
          driverId,
          deliveryDate,
          locationSource,
          hasLockedNextStop: !!lockedNextStop,
          hasHomeLocation: driverAppUser.home_latitude != null && driverAppUser.home_longitude != null,
          hasGpsLocation: driverAppUser.current_latitude != null && driverAppUser.current_longitude != null
        }
      }, { status: 400 });
    }

    const candidateSequencedStops = [...stopsToSequence]
      .sort((a, b) => {
        if (a.hasLateWindow !== b.hasLateWindow) return a.hasLateWindow ? 1 : -1;
        if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
        const windowA = parseTimeToMinutes(a.windowStart);
        const windowB = parseTimeToMinutes(b.windowStart);
        if ((windowA ?? Infinity) !== (windowB ?? Infinity)) return (windowA ?? Infinity) - (windowB ?? Infinity);
        if (a.isPickup !== b.isPickup) return a.isPickup ? -1 : 1;
        return (Number(a.delivery.stop_order) || 9999) - (Number(b.delivery.stop_order) || 9999);
      });

    const fallbackDepartureTime = resolveCurrentTime({ currentLocalTime, deviceTime });
    const departureTime = resolveEtaBaseTime(deliveryDate, completedDeliveries, fallbackDepartureTime);
    const endLocation = (resolvedHomeLat != null && resolvedHomeLng != null)
      ? { lat: Number(resolvedHomeLat), lng: Number(resolvedHomeLng) }
      : null;
    const shouldStartFromHome = locationSource === 'home' || (!completedDeliveries.length && !!endLocation);
    const activeRouteOrigin = shouldStartFromHome && endLocation
      ? { lat: Number(endLocation.lat), lng: Number(endLocation.lng) }
      : (currentPosition ? { lat: Number(currentPosition.lat), lng: Number(currentPosition.lng) } : null);

    const routeContextPayload = candidateSequencedStops.map((stop) => ({
      id: stop.delivery.id,
      stop_id: stop.delivery.stop_id,
      delivery_id: stop.delivery.delivery_id,
      time_window_start: stop.windowStart,
      time_window_end: stop.windowEnd
    }));

    const sequencingResponse = stopsToSequence.length > 0
      ? await base44.asServiceRole.functions.invoke('getHereDirections', {
          origin: { lat: optimizationStartPosition.lat, lng: optimizationStartPosition.lng },
          destination: endLocation ? { lat: endLocation.lat, lng: endLocation.lng } : { lat: candidateSequencedStops[candidateSequencedStops.length - 1].lat, lng: candidateSequencedStops[candidateSequencedStops.length - 1].lng },
          waypoints: candidateSequencedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
          routeContext: routeContextPayload,
          deliveryDate,
          currentLocalTime: departureTime
        }).catch(() => null)
      : null;

    const sequencingData = sequencingResponse?.data || sequencingResponse || {};
    const usedTimeWindows = sequencingData?.used_time_windows !== false;
    const optimizedIds = Array.isArray(sequencingData?.optimized_waypoint_ids) ? sequencingData.optimized_waypoint_ids : [];
    const orderedStops = (optimizedIds.length > 0 ? optimizedIds : routeContextPayload.map((item) => String(item.id || item.stop_id || item.delivery_id)))
      .map((id, index) => {
        const stop = candidateSequencedStops.find((item) => String(item.delivery.id) === String(id) || String(item.delivery.stop_id) === String(id) || String(item.delivery.delivery_id) === String(id));
        return stop ? { stop, waypoint: { id, sequence: index + 1 } } : null;
      })
      .filter(Boolean);

    if (orderedStops.length !== stopsToSequence.length) {
      return Response.json({
        error: 'HERE response did not include all optimizable stops',
        details: {
          requestedStops: stopsToSequence.length,
          returnedStops: orderedStops.length,
          usedTimeWindows
        }
      }, { status: 422 });
    }

    const arrangedStops = [];
    const arrangedIds = new Set();
    const pushOrderedItem = (item) => {
      if (!item || arrangedIds.has(item.stop.delivery.id)) return;
      arrangedStops.push(item);
      arrangedIds.add(item.stop.delivery.id);
    };

    if (lockedNextStop) {
      pushOrderedItem({ stop: lockedNextStop, waypoint: null, leg: null, locked: true });
    }

    for (const item of orderedStops) {
      pushOrderedItem(item);
    }

    const sequencingSections = Array.isArray(sequencingData?.sections) ? sequencingData.sections : [];
    const interconnectionByToWaypoint = new Map(orderedStops.map((item, index) => [item.waypoint?.id, sequencingSections[index] || null]));
    const usedFinishedOrders = new Set(completedDeliveries.map((delivery) => Number(delivery.stop_order)).filter((order) => Number.isFinite(order) && order > 0));
    const availableActiveOrders = activeDeliveries.map((delivery) => Number(delivery.stop_order)).filter((order) => Number.isFinite(order) && order > 0 && !usedFinishedOrders.has(order)).sort((a, b) => a - b);
    let nextGeneratedOrder = Math.max(0, ...allDeliveries.map((delivery) => Number(delivery.stop_order)).filter((order) => Number.isFinite(order) && order > 0)) + 1;
    let assignedNextDeliveryStopOrder = null;
    let rollingMinutes = parseTimeToMinutes(departureTime) ?? parseTimeToMinutes(getEdmontonCurrentTime()) ?? 0;
    let previousPosition = currentPosition;

    const deliveryUpdates = [];
    const pendingDeliveryWriteBatch = [];

    for (let index = 0; index < arrangedStops.length; index += 1) {
      const { stop, waypoint, leg, locked } = arrangedStops[index];
      const resolvedLeg = waypoint ? interconnectionByToWaypoint.get(waypoint.id) : (leg || null);
      const fallbackTravelMinutes = previousPosition
        ? estimateCrowFliesTravelMinutes(previousPosition.lat, previousPosition.lng, stop.lat, stop.lng)
        : 0;
      const travelMinutes = Math.max(0, Math.ceil(Number(resolvedLeg?.time || 0) / 60) || fallbackTravelMinutes);
      rollingMinutes += travelMinutes;

      const windowStartMinutes = parseTimeToMinutes(stop.windowStart);
      if (windowStartMinutes !== null && rollingMinutes < windowStartMinutes) {
        rollingMinutes = windowStartMinutes;
      }

      const eta = formatMinutesToHHMM(rollingMinutes);
      const stopOrder = stop.isPending ? null : (availableActiveOrders[index] || nextGeneratedOrder++);

      if (!stop.isPending) {
        if (stop.delivery.isNextDelivery && assignedNextDeliveryStopOrder === null) {
          assignedNextDeliveryStopOrder = stopOrder;
        }

        const updateData = {
          stop_order: stopOrder,
          display_stop_order: stopOrder,
          delivery_time_eta: eta
        };
        const currentStopOrder = Number(stop.delivery.stop_order || 0);
        const currentDisplayStopOrder = Number(stop.delivery.display_stop_order || 0);
        const currentEta = String(stop.delivery.delivery_time_eta || '');
        const stopNeedsUpdate = currentStopOrder !== stopOrder || currentDisplayStopOrder !== stopOrder || currentEta !== eta;

        if (stopNeedsUpdate) {
          pendingDeliveryWriteBatch.push({
            id: stop.delivery.id,
            data: updateData
          });
        }
      }

      deliveryUpdates.push({
        stop,
        waypoint,
        leg: resolvedLeg,
        locked: !!locked,
        order: stopOrder,
        eta
      });

      previousPosition = { lat: stop.lat, lng: stop.lng };
      rollingMinutes += Math.max(0, Number(stop.serviceMinutes || 0));
    }

    if (pendingDeliveryWriteBatch.length > 0) {
      for (let index = 0; index < pendingDeliveryWriteBatch.length; index += 20) {
        const chunk = pendingDeliveryWriteBatch.slice(index, index + 20);
        await Promise.all(
          chunk.map(({ id, data }) =>
            base44.asServiceRole.entities.Delivery.update(id, data).catch((error) => {
              if (error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found')) {
                return null;
              }
              throw error;
            })
          )
        );
      }
    }

    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions (HERE)',
        purpose: `Real-time route optimization for driver ${driverAppUser?.user_name || driverId}`,
        function_name: 'optimizeRouteRealTime',
        user_id: user.id,
        user_name: callerAppUser?.user_name || user.id,
        metadata: {
          api_provider: 'here_waypoints_sequence_v8',
          call_count: stopsToSequence.length > 0 ? Number(sequencingData?.api_call_count || 1) : 0,
          driver_id: driverId,
          delivery_date: deliveryDate,
          stops_count: stops.length,
          location_source: locationSource,
          used_time_windows: usedTimeWindows,
          active_statuses_only: true,
          locked_next_delivery: !!nextDeliveryStop,
          distance_meters: Math.round(Number(sequencingData?.estimated_distance_km || 0) * 1000),
          duration_seconds: Math.round(Number(sequencingData?.estimated_duration_minutes || 0) * 60)
        }
      });
    } catch (_logError) {}

    // Tracking numbers are intentionally delayed until Assign All / Accept All.

    try {
      const allForDriverDate = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order');

      const activeStopsOnly = (allForDriverDate || []).filter((delivery) => delivery && isActiveRouteStatus(delivery.status));
      const existingStartedNextStops = activeStopsOnly.filter((delivery) => delivery.isNextDelivery === true);
      const protectedStartedStop = activeStopsOnly.find((delivery) => delivery.id === lockedNextStop?.delivery?.id)
        || existingStartedNextStops.find((delivery) => delivery.id === lockedNextStop?.delivery?.id)
        || existingStartedNextStops.sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999))[0]
        || null;

      if (activeStopsOnly.length > 0) {
        const firstActiveArrangedStop = arrangedStops.find((item) => !item?.stop?.isPending);
        const targetId = protectedStartedStop?.id || lockedNextStop?.delivery?.id || firstActiveArrangedStop?.stop?.delivery?.id || [...activeStopsOnly].sort((a, b) => {
          const stopOrderDiff = (a.stop_order || 999) - (b.stop_order || 999);
          if (stopOrderDiff !== 0) return stopOrderDiff;
          const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
          const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
          return etaA.localeCompare(etaB);
        })[0]?.id;

        if (targetId) {
          const nextUpdates = activeStopsOnly
            .map((delivery) => {
              const shouldBeNext = delivery.id === targetId;
              if (delivery.isNextDelivery === shouldBeNext) return null;
              return base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: shouldBeNext }).catch((error) => {
                if (error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found')) {
                  return null;
                }
                throw error;
              });
            })
            .filter(Boolean);

          if (nextUpdates.length > 0) {
            for (let index = 0; index < nextUpdates.length; index += 20) {
              await Promise.all(nextUpdates.slice(index, index + 20));
            }
          }
        }
      }
    } catch (_error) {}

    const optimizedRoute = deliveryUpdates.map(({ stop, waypoint, leg, order, eta, locked }) => ({
      deliveryId: stop.delivery.id,
      delivery_id: stop.delivery.delivery_id,
      patient_name: stop.delivery.patient_name || 'Pickup',
      newOrder: order,
      newETA: eta,
      travelSeconds: Math.round(Number(leg?.time || 0)),
      travelMeters: Math.round(Number(leg?.distance || 0)),
      sequence: locked ? 0 : waypoint?.sequence
    }));

    const firstActiveStop = arrangedStops.find((item) => !item?.stop?.isPending)?.stop || null;
    const firstActiveCoords = firstActiveStop ? { lat: Number(firstActiveStop.lat), lng: Number(firstActiveStop.lng) } : null;
    const activeSegmentChanged = !(
      sameSegmentPoint(activeRouteOrigin, previousType1Origin) &&
      sameSegmentPoint(firstActiveCoords, previousType1Destination)
    );

    const routeLegPoints = [
      activeRouteOrigin,
      ...orderedRouteStops.map((item) => ({ lat: Number(item.lat), lng: Number(item.lng) })),
      endLocation ? { lat: Number(endLocation.lat), lng: Number(endLocation.lng) } : null
    ].filter((point) => point?.lat != null && point?.lng != null);

    const routeDirectionsResponse = routeLegPoints.length >= 2
      ? await base44.asServiceRole.functions.invoke('getHereDirections', {
          origin: { lat: routeLegPoints[0].lat, lng: routeLegPoints[0].lng },
          destination: { lat: routeLegPoints[routeLegPoints.length - 1].lat, lng: routeLegPoints[routeLegPoints.length - 1].lng },
          waypoints: routeLegPoints.slice(1, -1).map((point) => ({ lat: point.lat, lng: point.lng })),
          routeContext: routeLegPoints,
          transportMode: String(driverAppUser?.preferred_travel_mode || 'driving').toLowerCase()
        }).catch(() => null)
      : null;

    const routeDirectionsData = routeDirectionsResponse?.data || routeDirectionsResponse || {};
    const routeSections = Array.isArray(routeDirectionsData?.sections) ? routeDirectionsData.sections : [];
    const transportMode = routeDirectionsData?.transport_mode || String(driverAppUser?.preferred_travel_mode || 'driving').toLowerCase();

    if (routeSections.length > 0) {
      const existingRows = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
        driver_id: targetDriverId,
        delivery_date: deliveryDate
      }, '-updated_date', 50000);

      const dailyGenerationCount = routeSections.length;
      const rowsToCreate = [];
      const rowsToUpdate = [];

      for (let index = 0; index < routeSections.length; index += 1) {
        const fromPoint = routeLegPoints[index];
        const toPoint = routeLegPoints[index + 1];
        const section = routeSections[index];
        if (!fromPoint || !toPoint || !section?.encoded_polyline) continue;

        const existingRow = (existingRows || []).find((row) =>
          round5(row?.segment_origin_lat) === round5(fromPoint.lat) &&
          round5(row?.segment_origin_lon) === round5(fromPoint.lng) &&
          round5(row?.segment_dest_lat) === round5(toPoint.lat) &&
          round5(row?.segment_dest_lon) === round5(toPoint.lng)
        );

        const rowPayload = {
          driver_id: targetDriverId,
          delivery_date: deliveryDate,
          encoded_polyline: section.encoded_polyline,
          transport_mode: transportMode,
          segment_origin_lat: round5(fromPoint.lat),
          segment_origin_lon: round5(fromPoint.lng),
          segment_dest_lat: round5(toPoint.lat),
          segment_dest_lon: round5(toPoint.lng),
          estimated_distance_km: section.estimated_distance_km ?? null,
          estimated_duration_minutes: section.estimated_duration_minutes ?? null,
          daily_generation_count: dailyGenerationCount,
          last_generated_at: new Date().toISOString()
        };

        if (existingRow?.id) {
          rowsToUpdate.push({ id: existingRow.id, data: rowPayload });
        } else {
          rowsToCreate.push(rowPayload);
        }
      }

      if (rowsToUpdate.length > 0) {
        for (let index = 0; index < rowsToUpdate.length; index += 10) {
          const chunk = rowsToUpdate.slice(index, index + 10);
          await Promise.all(chunk.map((row) =>
            base44.asServiceRole.entities.DriverRoutePolyline.update(row.id, row.data).catch(() => null)
          ));
        }
      }

      if (rowsToCreate.length > 0) {
        await base44.asServiceRole.entities.DriverRoutePolyline.bulkCreate(rowsToCreate).catch(() => null);
      }
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedRoute,
      totalStops: optimizedRoute.length,
      stagesCount: 1,
      apiCallsMade: stopsToSequence.length > 0 ? Number(sequencingData?.api_call_count || 1) : 0,
      locationSource,
      hereSummary: {
        distanceMeters: Math.round(Number(sequencingData?.estimated_distance_km || 0) * 1000),
        durationSeconds: Math.round(Number(sequencingData?.estimated_duration_minutes || 0) * 60)
      },
      polylineRefresh: {
        shouldRefresh: !!activeSegmentChanged,
        origin: activeRouteOrigin,
        destination: firstActiveCoords,
        nextStopId: firstActiveStop?.delivery?.id || null
      }
    });
  } catch (error) {
    const isAbort = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (isRateLimitError(error)) {
      console.warn('⚠️ [optimizeRouteRealTime] Deferred due to rate limit');
      return Response.json({
        success: false,
        routeChanged: false,
        optimizedRoute: [],
        totalStops: 0,
        apiCallsMade: 0,
        deferred: true,
        reason: 'rate_limited'
      });
    }
    console.error('❌ [optimizeRouteRealTime] ERROR:', error?.message || error);
    return Response.json({
      error: error?.message || 'Unexpected server error',
      stack: error?.stack
    }, { status: isAbort ? 504 : 500 });
  }
});