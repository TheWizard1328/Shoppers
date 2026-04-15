// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const TIME_ZONE = 'America/Edmonton';
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_ROUTE_STATUSES = ['in_transit', 'en_route'];
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
    const { driverId, deliveryDate, startLocation, currentLocalTime, deviceTime } = body;

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required parameters: driverId, deliveryDate' }, { status: 400 });
    }

    const hereApiKey = Deno.env.get('HERE_API_KEY');
    if (!hereApiKey) {
      return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
    }

    const [driverAppUsers, callerAppUsers] = await Promise.all([
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }),
      base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1)
    ]);
    const driverAppUser = driverAppUsers?.[0];
    const callerAppUser = callerAppUsers?.[0];

    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    let currentPosition = null;
    let locationSource = null;

    if (startLocation?.lat != null && startLocation?.lng != null) {
      currentPosition = { lat: Number(startLocation.lat), lng: Number(startLocation.lng) };
      locationSource = 'start_button';
    } else if (driverAppUser.current_latitude != null && driverAppUser.current_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) };
      locationSource = 'gps';
    }

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
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

    const [patients, stores] = await Promise.all([
      patientIds.length > 0 ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }) : [],
      storeIds.length > 0 ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }) : []
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

    if (!currentPosition && completedDeliveries.length > 0) {
      const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
      const lastCompletedCoords = getStopCoordinates(lastCompleted, patientMap, storeMap);
      if (lastCompletedCoords.lat != null && lastCompletedCoords.lng != null) {
        currentPosition = { lat: Number(lastCompletedCoords.lat), lng: Number(lastCompletedCoords.lng) };
        locationSource = 'last_completed';
      }
    }

    if (!currentPosition && driverAppUser.home_latitude != null && driverAppUser.home_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) };
      locationSource = 'home';
    }

    const stops = optimizationDeliveries
      .map((delivery, index) => {
        const { lat, lng, patient } = getStopCoordinates(delivery, patientMap, storeMap);
        const isPickup = !delivery.patient_id;
        const windowStart = delivery.time_window_start || delivery.delivery_time_start || patient?.time_window_start || null;
        const windowEnd = delivery.time_window_end || delivery.delivery_time_end || patient?.time_window_end || null;
        const serviceMinutes = isPickup
          ? Math.max(Number(delivery.extra_time || 0), 15)
          : Math.max(Number(delivery.extra_time || 0), 5);

        return {
          delivery,
          lat: lat != null ? Number(lat) : null,
          lng: lng != null ? Number(lng) : null,
          isPickup,
          isPending: delivery.status === 'pending',
          windowStart,
          windowEnd,
          serviceMinutes,
          waypointId: `destination${index + 1}`,
          waypointLabel: delivery.stop_id || delivery.delivery_id || delivery.id
        };
      })
      .filter((stop) => stop.lat != null && stop.lng != null && !Number.isNaN(stop.lat) && !Number.isNaN(stop.lng));

    if (stops.length === 0) {
      return Response.json({ error: 'No active stops have valid coordinates', routeChanged: false }, { status: 400 });
    }

    const nextDeliveryStop = stops.find((stop) => stop.delivery.isNextDelivery === true) || null;
    const lockedNextStop = nextDeliveryStop;
    const stopsToSequence = lockedNextStop
      ? stops.filter((stop) => stop.delivery.id !== lockedNextStop.delivery.id)
      : stops;
    const optimizationStartPosition = lockedNextStop
      ? { lat: lockedNextStop.lat, lng: lockedNextStop.lng }
      : currentPosition;

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

    const sequencedStops = stopsToSequence.map((stop, index) => ({
      ...stop,
      hereWaypointId: `destination${index + 1}`
    }));

    const fallbackDepartureTime = resolveCurrentTime({ currentLocalTime, deviceTime });
    const departureTime = resolveEtaBaseTime(deliveryDate, completedDeliveries, fallbackDepartureTime);
    const departureIso = buildLocalIso(deliveryDate, departureTime);
    const endLocation = (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null)
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    const executeHereSequence = async (includeTimeWindows) => {
      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('departure', departureIso);
      params.set('mode', 'shortest;car;traffic:disabled');
      params.set('improveFor', 'distance');
      params.set('start', `driverStart;${optimizationStartPosition.lat},${optimizationStartPosition.lng}`);
      if (endLocation) {
        params.set('end', `driverHome;${endLocation.lat},${endLocation.lng}`);
      }

      for (const stop of sequencedStops) {
        const segments = [`${stop.waypointLabel};${stop.lat},${stop.lng}`];
        if (includeTimeWindows) {
          const accessConstraint = buildAccessConstraint(deliveryDate, stop.windowStart, stop.windowEnd);
          if (accessConstraint) segments.push(accessConstraint);
        }
        segments.push(`st:${Math.round(stop.serviceMinutes * 60)}`);
        params.set(stop.hereWaypointId, segments.join(';'));
      }

      const hereUrl = `https://wps.hereapi.com/v8/findsequence2?${params.toString()}`;

      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(hereUrl, { signal: AbortSignal.timeout(20000) });
          if (response.status === 429) {
            const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          const data = await response.json().catch(() => null);
          return { response, data, includeTimeWindows };
        } catch (err) {
          lastError = err;
          if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
        }
      }

      throw lastError || new Error('HERE API rate limit exceeded after retries');
    };

    let hereResponse = { ok: true, status: 200 };
    let hereData = null;
    let usedTimeWindows = true;
    let result = null;
    let waypoints = [];
    let interconnections = [];

    if (stopsToSequence.length > 0) {
      let hereAttempt = await executeHereSequence(true);
      hereResponse = hereAttempt.response;
      hereData = hereAttempt.data;
      usedTimeWindows = hereAttempt.includeTimeWindows;

      result = Array.isArray(hereData?.results) ? hereData.results[0] : null;
      waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

      const needsFallback = !hereResponse.ok || !result || waypoints.length === 0;
      if (needsFallback && usedTimeWindows) {
        hereAttempt = await executeHereSequence(false);
        hereResponse = hereAttempt.response;
        hereData = hereAttempt.data;
        usedTimeWindows = hereAttempt.includeTimeWindows;
        result = Array.isArray(hereData?.results) ? hereData.results[0] : null;
        waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
        interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
      }

      if (!hereResponse.ok) {
        return Response.json({
          error: 'HERE Waypoints Sequence API request failed',
          details: hereData,
          status: hereResponse.status,
          usedTimeWindows
        }, { status: 502 });
      }

      if (!result || waypoints.length === 0) {
        return Response.json({
          error: 'HERE did not return an optimized sequence',
          details: hereData,
          usedTimeWindows
        }, { status: 422 });
      }
    }

    const stopWaypoints = waypoints
      .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const orderedStops = stopWaypoints
      .map((waypoint) => {
        const stop = sequencedStops.find((item) => item.hereWaypointId === waypoint.id || item.waypointLabel === waypoint.id);
        return stop ? { stop, waypoint } : null;
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

    const interconnectionByToWaypoint = new Map(interconnections.map((item) => [item.toWaypoint, item]));
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
      await Promise.all(
        pendingDeliveryWriteBatch.map(({ id, data }) =>
          base44.asServiceRole.entities.Delivery.update(id, data).catch((error) => {
            if (error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found')) {
              return null;
            }
            throw error;
          })
        )
      );
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
          call_count: stopsToSequence.length > 0 ? 1 : 0,
          driver_id: driverId,
          delivery_date: deliveryDate,
          stops_count: stops.length,
          location_source: locationSource,
          used_time_windows: usedTimeWindows,
          active_statuses_only: true,
          locked_next_delivery: !!nextDeliveryStop,
          distance_meters: Number(result?.distance || 0),
          duration_seconds: Number(result?.time || 0)
        }
      });
    } catch (_logError) {}

    // Post-optimization follow-up functions are triggered by the Assign All / Accept All flow only,
    // so they run exactly once after optimization completes.

    try {
      const allForDriverDate = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order');

      const activeStopsOnly = (allForDriverDate || []).filter((delivery) => delivery && isActiveRouteStatus(delivery.status));

      if (activeStopsOnly.length > 0) {
        const firstActiveArrangedStop = arrangedStops.find((item) => !item?.stop?.isPending);
        const targetId = lockedNextStop?.delivery?.id || firstActiveArrangedStop?.stop?.delivery?.id || [...activeStopsOnly].sort((a, b) => {
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
            await Promise.all(nextUpdates);
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
    const activeRouteOrigin = currentPosition ? { lat: Number(currentPosition.lat), lng: Number(currentPosition.lng) } : null;
    const activeSegmentChanged = !(sameSegmentPoint(activeRouteOrigin, firstActiveCoords) && nextDeliveryStop && firstActiveStop?.delivery?.id === nextDeliveryStop.id);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedRoute,
      totalStops: optimizedRoute.length,
      stagesCount: 1,
      apiCallsMade: stopsToSequence.length > 0 ? 1 : 0,
      locationSource,
      hereSummary: {
        distanceMeters: Number(result?.distance || 0),
        durationSeconds: Number(result?.time || 0)
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
    console.error('❌ [optimizeRouteRealTime] ERROR:', error?.message || error);
    return Response.json({
      error: error?.message || 'Unexpected server error',
      stack: error?.stack
    }, { status: isAbort ? 504 : 500 });
  }
});