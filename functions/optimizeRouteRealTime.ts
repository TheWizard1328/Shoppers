import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const TIME_ZONE = 'America/Edmonton';
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return (parts[0] * 60) + parts[1];
};

const normalizeTimeString = (timeStr, fallback) => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  const hours = String(Number(parts[0]) || 0).padStart(2, '0');
  const minutes = String(Number(parts[1]) || 0).padStart(2, '0');
  const seconds = String(Number(parts[2]) || 0).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
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
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const parseHereTimeToHHMM = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
};

const getStopCoordinates = (delivery, patientMap, storeMap) => {
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    return { lat: patient?.latitude, lng: patient?.longitude, patient };
  }
  const store = storeMap.get(delivery.store_id);
  return { lat: store?.latitude, lng: store?.longitude, store };
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

    console.log(`🔄 Optimizing route for driver ${driverId} on ${deliveryDate}`);

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

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
    } else if (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) };
      locationSource = 'home';
    }

    if (!currentPosition || Number.isNaN(currentPosition.lat) || Number.isNaN(currentPosition.lng)) {
      return Response.json({ error: 'Driver location not available - no GPS or home location set' }, { status: 404 });
    }

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    console.log(`📦 Found ${allDeliveries.length} deliveries`);

    const completedDeliveries = allDeliveries.filter((delivery) => FINISHED_STATUSES.includes(delivery.status));
    const incompleteDeliveries = allDeliveries.filter((delivery) => !FINISHED_STATUSES.includes(delivery.status));

    completedDeliveries.sort((a, b) => {
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time).getTime() - new Date(b.actual_delivery_time).getTime();
    });

    const completedUpdates = completedDeliveries
      .map((delivery, index) => {
        const sequentialOrder = index + 1;
        if (delivery.stop_order === sequentialOrder) return null;
        return base44.asServiceRole.entities.Delivery.update(delivery.id, {
          stop_order: sequentialOrder,
          display_stop_order: sequentialOrder
        });
      })
      .filter(Boolean);

    if (completedUpdates.length > 0) {
      await Promise.all(completedUpdates);
    }

    if (incompleteDeliveries.length === 0) {
      return Response.json({ message: 'No incomplete deliveries to optimize', routeChanged: false });
    }

    const patientIds = [...new Set(incompleteDeliveries.filter((delivery) => delivery.patient_id).map((delivery) => delivery.patient_id))];
    const storeIds = [...new Set(incompleteDeliveries.map((delivery) => delivery.store_id).filter(Boolean))];

    const [patients, stores] = await Promise.all([
      patientIds.length > 0 ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }) : [],
      storeIds.length > 0 ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }) : []
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

    if (completedDeliveries.length > 0) {
      const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
      const lastCompletedCoords = getStopCoordinates(lastCompleted, patientMap, storeMap);
      if (lastCompletedCoords.lat != null && lastCompletedCoords.lng != null) {
        currentPosition = { lat: Number(lastCompletedCoords.lat), lng: Number(lastCompletedCoords.lng) };
        locationSource = 'last_completed';
      }
    }

    const stops = incompleteDeliveries
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
          windowStart,
          windowEnd,
          serviceMinutes,
          waypointId: `destination${index + 1}`,
          waypointLabel: delivery.stop_id || delivery.delivery_id || delivery.id,
          beforeIds: []
        };
      })
      .filter((stop) => stop.lat != null && stop.lng != null && !Number.isNaN(stop.lat) && !Number.isNaN(stop.lng));

    if (stops.length === 0) {
      return Response.json({ error: 'No incomplete stops have valid coordinates', routeChanged: false }, { status: 400 });
    }

    const stopByDeliveryId = new Map(stops.map((stop) => [stop.delivery.id, stop]));
    const pickupByStopId = new Map(
      stops.filter((stop) => stop.isPickup && stop.delivery.stop_id).map((stop) => [stop.delivery.stop_id, stop])
    );

    const nextDeliveryStop = stops.find((stop) => stop.delivery.isNextDelivery === true) || null;

    if (nextDeliveryStop) {
      for (const stop of stops) {
        if (stop.delivery.id !== nextDeliveryStop.delivery.id) {
          nextDeliveryStop.beforeIds.push(stop.waypointId);
        }
      }
    }

    for (const stop of stops) {
      if (!stop.isPickup && stop.delivery.puid) {
        const pickupStop = pickupByStopId.get(stop.delivery.puid);
        if (pickupStop && pickupStop.delivery.id !== stop.delivery.id) {
          pickupStop.beforeIds.push(stop.waypointId);
        }
      }
    }

    for (const stop of stops) {
      stop.beforeIds = [...new Set(stop.beforeIds)];
    }

    const departureTime = resolveCurrentTime({ currentLocalTime, deviceTime });
    const departureIso = buildLocalIso(deliveryDate, departureTime);
    const endLocation = (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null)
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    const params = new URLSearchParams();
    params.set('apiKey', hereApiKey);
    params.set('departure', departureIso);
    params.set('mode', 'fastest;car;traffic:enabled');
    params.set('improveFor', 'time');
    params.set('start', `driverStart;${currentPosition.lat},${currentPosition.lng}`);

    if (endLocation && !Number.isNaN(endLocation.lat) && !Number.isNaN(endLocation.lng)) {
      params.set('end', `driverEnd;${endLocation.lat},${endLocation.lng}`);
    }

    for (const stop of stops) {
      const segments = [`${stop.waypointLabel};${stop.lat},${stop.lng}`];
      const accessConstraint = buildAccessConstraint(deliveryDate, stop.windowStart, stop.windowEnd);
      if (accessConstraint) segments.push(accessConstraint);
      segments.push(`st:${Math.round(stop.serviceMinutes * 60)}`);
      for (const beforeId of stop.beforeIds) {
        segments.push(`before:${beforeId}`);
      }
      params.set(stop.waypointId, segments.join(';'));
    }

    const hereUrl = `https://wps.hereapi.com/v8/findsequence2?${params.toString()}`;
    console.log(`🌐 [optimizeRouteRealTime] Calling HERE Waypoints Sequence API for ${stops.length} stops`);

    const hereResponse = await fetch(hereUrl, { signal: AbortSignal.timeout(20000) });
    const hereData = await hereResponse.json().catch(() => null);

    if (!hereResponse.ok) {
      console.error('[optimizeRouteRealTime] HERE HTTP error:', hereResponse.status, hereData);
      return Response.json({
        error: 'HERE Waypoints Sequence API request failed',
        details: hereData,
        status: hereResponse.status
      }, { status: 502 });
    }

    const result = Array.isArray(hereData?.results) ? hereData.results[0] : null;
    const waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
    const interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

    if (!result || waypoints.length === 0) {
      console.error('[optimizeRouteRealTime] HERE returned no optimized sequence:', hereData);
      return Response.json({
        error: 'HERE did not return an optimized sequence',
        details: hereData
      }, { status: 422 });
    }

    const stopWaypoints = waypoints
      .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const orderedStops = stopWaypoints
      .map((waypoint) => {
        const stop = stops.find((item) => item.waypointId === waypoint.id);
        return stop ? { stop, waypoint } : null;
      })
      .filter(Boolean);

    if (orderedStops.length !== stops.length) {
      return Response.json({
        error: 'HERE response did not include all incomplete stops',
        details: {
          requestedStops: stops.length,
          returnedStops: orderedStops.length,
          response: hereData
        }
      }, { status: 422 });
    }

    const interconnectionByToWaypoint = new Map(interconnections.map((item) => [item.toWaypoint, item]));
    let stopOrderCounter = completedDeliveries.length;
    let assignedNextDeliveryStopOrder = null;

    const deliveryUpdates = orderedStops.map(({ stop, waypoint }) => {
      stopOrderCounter += 1;
      if (stop.delivery.isNextDelivery && assignedNextDeliveryStopOrder === null) {
        assignedNextDeliveryStopOrder = stopOrderCounter;
      }

      const eta = parseHereTimeToHHMM(waypoint.estimatedArrival || waypoint.estimatedDeparture) || stop.delivery.delivery_time_eta || null;
      const leg = interconnectionByToWaypoint.get(waypoint.id);

      return {
        stop,
        waypoint,
        leg,
        order: stopOrderCounter,
        eta,
        updatePromise: base44.asServiceRole.entities.Delivery.update(stop.delivery.id, {
          stop_order: stopOrderCounter,
          display_stop_order: stopOrderCounter,
          delivery_time_eta: eta
        })
      };
    });

    await Promise.all(deliveryUpdates.map((item) => item.updatePromise));

    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions (HERE)',
        purpose: `Real-time route optimization for driver ${driverAppUser?.user_name || driverId}`,
        function_name: 'optimizeRouteRealTime',
        user_id: user.id,
        user_name: user.full_name,
        metadata: {
          api_provider: 'here_waypoints_sequence_v8',
          call_count: 1,
          driver_id: driverId,
          delivery_date: deliveryDate,
          stops_count: stops.length,
          location_source: locationSource,
          used_time_windows: true,
          used_service_times: true,
          used_before_constraints: true,
          locked_next_delivery: !!nextDeliveryStop,
          distance_meters: Number(result?.distance || 0),
          duration_seconds: Number(result?.time || 0)
        }
      });
    } catch (logError) {
      console.warn('[optimizeRouteRealTime] Non-fatal log error:', logError?.message || logError);
    }

    try {
      await base44.asServiceRole.functions.invoke('recalculateTrackingNumbers', { driverId, deliveryDate });
      console.log('🔢 [optimizeRouteRealTime] Tracking numbers recalculated');
    } catch (trackingError) {
      console.warn('[optimizeRouteRealTime] recalculateTrackingNumbers failed (non-fatal):', trackingError?.message || trackingError);
    }

    try {
      await base44.asServiceRole.functions.invoke('purgeAndRegeneratePolylines', { driverId, deliveryDate });
      console.log('🧹 [optimizeRouteRealTime] Polylines purged and regenerated');
    } catch (polylineError) {
      console.warn('[optimizeRouteRealTime] purgeAndRegeneratePolylines failed (non-fatal):', polylineError?.message || polylineError);
    }

    try {
      const allForDriverDate = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order');

      const incompletes = (allForDriverDate || []).filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status) && delivery.status !== 'pending');

      if (incompletes.length > 0) {
        const targetId = nextDeliveryStop?.delivery?.id || [...incompletes].sort((a, b) => {
          const stopOrderDiff = (a.stop_order || 999) - (b.stop_order || 999);
          if (stopOrderDiff !== 0) return stopOrderDiff;
          const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
          const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
          return etaA.localeCompare(etaB);
        })[0]?.id;

        if (targetId) {
          const updates = incompletes.map((delivery) => {
            const shouldBeNext = delivery.id === targetId;
            if (delivery.isNextDelivery === shouldBeNext) return null;
            return base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: shouldBeNext });
          }).filter(Boolean);

          if (updates.length > 0) {
            await Promise.all(updates);
          }
        }
      }
    } catch (error) {
      console.warn('[optimizeRouteRealTime] ensure isNextDelivery failed (non-fatal):', error?.message || error);
    }

    const optimizedRoute = deliveryUpdates.map(({ stop, waypoint, leg, order, eta }) => ({
      deliveryId: stop.delivery.id,
      delivery_id: stop.delivery.delivery_id,
      patient_name: stop.delivery.patient_name || 'Pickup',
      newOrder: order,
      newETA: eta,
      travelSeconds: Math.round(Number(leg?.time || 0)),
      travelMeters: Math.round(Number(leg?.distance || 0)),
      sequence: waypoint.sequence
    }));

    console.log(`✅ Route optimization complete - ${optimizedRoute.length} stops updated, 1 HERE API call`);
    if (assignedNextDeliveryStopOrder !== null) {
      console.log(`🎯 [optimizeRouteRealTime] isNextDelivery assigned stop order ${assignedNextDeliveryStopOrder}`);
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedRoute,
      totalStops: optimizedRoute.length,
      stagesCount: 1,
      apiCallsMade: 1,
      locationSource,
      hereSummary: {
        distanceMeters: Number(result?.distance || 0),
        durationSeconds: Number(result?.time || 0)
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
    }
    
    console.log('✅ User authenticated:', user.email);

    const body = await req.json();
    const { driverId, deliveryDate, startLocation, currentLocalTime, deviceTime } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    // Parse current time
    let currentMinutes;
    if (currentLocalTime) {
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
    } else if (deviceTime) {
      const timeMatch = deviceTime.match(/T(\d{2}):(\d{2})/);
      if (timeMatch) {
        currentMinutes = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
      } else {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', hour: 'numeric', minute: 'numeric', hour12: false });
        const parts = formatter.formatToParts(now);
        const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
        const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
        currentMinutes = (h === 24 ? 0 : h) * 60 + m;
      }
    } else {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', hour: 'numeric', minute: 'numeric', hour12: false });
      const parts = formatter.formatToParts(now);
      const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
      const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
      currentMinutes = (h === 24 ? 0 : h) * 60 + m;
    }

    console.log(`🔄 Optimizing route for driver ${driverId} on ${deliveryDate}`);
    
    // Get driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];
    
    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }
    
    // Determine starting location
    let driverLocation;
    let locationSource;
    
    if (startLocation?.lat && startLocation?.lng) {
      driverLocation = { lat: startLocation.lat, lng: startLocation.lng };
      locationSource = 'start_button';
    } else if (driverAppUser.current_latitude && driverAppUser.current_longitude) {
      driverLocation = { lat: driverAppUser.current_latitude, lng: driverAppUser.current_longitude };
      locationSource = 'gps';
    } else if (driverAppUser.home_latitude && driverAppUser.home_longitude) {
      driverLocation = { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude };
      locationSource = 'home';
    } else {
      return Response.json({ 
        error: 'Driver location not available - no GPS or home location set'
      }, { status: 404 });
    }

    // Fetch all deliveries for the driver on this date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');
    
    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    console.log(`📦 Found ${allDeliveries.length} deliveries`);

    // Separate completed and incomplete deliveries
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedDeliveries = allDeliveries.filter(d => finishedStatuses.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !finishedStatuses.includes(d.status));

    // Sort completed by actual completion time and assign stop_order
    completedDeliveries.sort((a, b) => {
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
    });

    for (let i = 0; i < completedDeliveries.length; i++) {
      const delivery = completedDeliveries[i];
      const sequentialOrder = i + 1;
      if (delivery.stop_order !== sequentialOrder) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, {
          stop_order: sequentialOrder,
          display_stop_order: sequentialOrder
        });
      }
    }

    if (incompleteDeliveries.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries to optimize',
        routeChanged: false
      });
    }

    // Get patient and store data for coordinates
    const patientIds = [...new Set(incompleteDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    const storeIds = [...new Set(incompleteDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Build stops with coordinates
    const stops = incompleteDeliveries.map(delivery => {
      let lat, lng;
      
      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        lat = patient?.latitude;
        lng = patient?.longitude;
      } else {
        const store = storeMap.get(delivery.store_id);
        lat = store?.latitude;
        lng = store?.longitude;
      }

      return {
        delivery,
        lat,
        lng,
        isPickup: !delivery.patient_id,
        isNextDelivery: delivery.isNextDelivery === true,
        timeMinutes: parseTimeToMinutes(delivery.delivery_time_start)
      };
    }).filter(s => s.lat && s.lng);

    // CRITICAL: Find the isNextDelivery stop - this stop's position is LOCKED
    const nextDeliveryStop = stops.find(s => s.isNextDelivery);
    const stopsToOptimize = stops.filter(s => !s.isNextDelivery);

    console.log(`📋 Found ${stops.length} stops, isNextDelivery: ${nextDeliveryStop ? 'YES' : 'NO'}`);

    // STEP 1: Sort remaining stops (excluding isNextDelivery) by delivery_time_start
    stopsToOptimize.sort((a, b) => {
      if (a.timeMinutes !== b.timeMinutes) return a.timeMinutes - b.timeMinutes;
      // Pickups before deliveries at same time
      if (a.isPickup && !b.isPickup) return -1;
      if (!a.isPickup && b.isPickup) return 1;
      return 0;
    });

    console.log(`📋 Sorted ${stopsToOptimize.length} stops (after isNextDelivery) by delivery_time_start`);

    // STEP 2: Divide route into stages (each stage ends at a pickup)
    // CRITICAL: isNextDelivery stop is processed FIRST with its own stage, remaining stops follow
    const stages = [];
    
    // If there's an isNextDelivery stop, it gets processed first as its own "stage"
    if (nextDeliveryStop) {
      stages.push([nextDeliveryStop]);
      console.log(`🎯 isNextDelivery stop locked at position 1: ${nextDeliveryStop.delivery.patient_name || 'Pickup'}`);
    }
    
    // Now process remaining stops into stages
    let currentStageStops = [];
    
    for (const stop of stopsToOptimize) {
      if (stop.isPickup && currentStageStops.length > 0) {
        // End current stage, pickup becomes end of this stage
        currentStageStops.push(stop);
        stages.push([...currentStageStops]);
        currentStageStops = [];
      } else {
        currentStageStops.push(stop);
      }
    }
    
    // Add remaining stops as final stage
    if (currentStageStops.length > 0) {
      stages.push(currentStageStops);
    }

    console.log(`📊 Divided into ${stages.length} stages (first stage is isNextDelivery if set)`);

    // STEP 3: Optimize each stage using Google Directions API
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    let currentPosition = driverLocation;
    
    // Use last completed delivery location if available
    if (completedDeliveries.length > 0) {
      const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
      if (lastCompleted.patient_id) {
        const patient = patientMap.get(lastCompleted.patient_id);
        if (patient?.latitude && patient?.longitude) {
          currentPosition = { lat: patient.latitude, lng: patient.longitude };
          locationSource = 'last_completed';
        }
      }
    }

    let stopOrderCounter = completedDeliveries.length;
    let cumulativeTime = currentMinutes;
    const updates = [];
    let totalApiCalls = 0;
    let assignedNextDeliveryStopOrder = null;

    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      const stageStops = stages[stageIdx];
      const isNextDeliveryStage = stageIdx === 0 && nextDeliveryStop && stageStops.length === 1 && stageStops[0].isNextDelivery;
      
      console.log(`\n--- Stage ${stageIdx + 1}: ${stageStops.length} stops ${isNextDeliveryStage ? '(isNextDelivery - LOCKED)' : ''} ---`);

      // CRITICAL: If this is the isNextDelivery stage, don't optimize - just process it as-is
      let optimizedStageStops;
      
      if (isNextDeliveryStage) {
        // isNextDelivery stop is locked in position - no optimization needed
        optimizedStageStops = stageStops;
        console.log(`🔒 isNextDelivery stop locked - no optimization`);
      } else {
        // Determine stage end location (pickup at end, or driver home for final stage)
        const lastStopInStage = stageStops[stageStops.length - 1];
        const stageEndLocation = lastStopInStage.isPickup 
          ? { lat: lastStopInStage.lat, lng: lastStopInStage.lng }
          : (driverAppUser.home_latitude && driverAppUser.home_longitude)
            ? { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude }
            : null;

        // Separate pickups (stay at end) and deliveries (to optimize)
        const pickupsInStage = stageStops.filter(s => s.isPickup);
        const deliveriesInStage = stageStops.filter(s => !s.isPickup);

        // Optimize deliveries within stage using nearest neighbor from current position
        const optimizedDeliveries = [];
        let tempPos = currentPosition;
        const remainingDeliveries = [...deliveriesInStage];

        while (remainingDeliveries.length > 0) {
          let nearestIdx = 0;
          let nearestDist = Infinity;

          for (let i = 0; i < remainingDeliveries.length; i++) {
            const dist = calculateCrowFliesDistance(
              tempPos.lat, tempPos.lng,
              remainingDeliveries[i].lat, remainingDeliveries[i].lng
            );
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestIdx = i;
            }
          }

          const nearest = remainingDeliveries.splice(nearestIdx, 1)[0];
          optimizedDeliveries.push(nearest);
          tempPos = { lat: nearest.lat, lng: nearest.lng };
        }

        // Combine: optimized deliveries + pickups at end
        optimizedStageStops = [...optimizedDeliveries, ...pickupsInStage];
      }

      // Calculate travel times using crow-flies distance (no Google API)
      let directionsLegs = [];
      
      if (optimizedStageStops.length > 0) {
        let prevPos = currentPosition;
        for (const stop of optimizedStageStops) {
          const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
          directionsLegs.push({
            duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), // 40 km/h + 30% buffer
            distance: distKm * 1000
          });
          prevPos = { lat: stop.lat, lng: stop.lng };
        }
        console.log(`📏 [Stage ${stageIdx + 1}] Using crow-flies distance (no Google API)`);
      }

      // STEP 4: Update ETAs and stop orders
      for (let i = 0; i < optimizedStageStops.length; i++) {
        const stop = optimizedStageStops[i];
        stopOrderCounter++;
        if (stop.isNextDelivery && assignedNextDeliveryStopOrder === null) {
          assignedNextDeliveryStopOrder = stopOrderCounter;
        }

        const travelMinutes = directionsLegs[i] ? Math.ceil(directionsLegs[i].duration / 60) : 5;
        cumulativeTime += travelMinutes;

        // Apply time window waiting
        if (stop.delivery.time_window_start) {
          const windowStart = parseTimeToMinutes(stop.delivery.time_window_start);
          if (cumulativeTime < windowStart) {
            cumulativeTime = windowStart;
          }
        }

        const eta = formatMinutesToTime(cumulativeTime);
        const serviceTime = stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        cumulativeTime += serviceTime;

        // Update delivery in database
        await base44.asServiceRole.entities.Delivery.update(stop.delivery.id, {
          stop_order: stopOrderCounter,
          display_stop_order: stopOrderCounter,
          delivery_time_eta: eta
        });

        updates.push({
          deliveryId: stop.delivery.id,
          delivery_id: stop.delivery.delivery_id,
          patient_name: stop.delivery.patient_name || 'Pickup',
          newOrder: stopOrderCounter,
          newETA: eta
        });

        console.log(`✅ Stop #${stopOrderCounter}: ${stop.delivery.patient_name || 'Pickup'} ETA: ${eta}`);
        currentPosition = { lat: stop.lat, lng: stop.lng };
      }
    }

    try {
      await base44.asServiceRole.functions.invoke('recalculateTrackingNumbers', {
        driverId,
        deliveryDate
      });
      console.log('🔢 [optimizeRouteRealTime] Tracking numbers recalculated');
    } catch (trackingError) {
      console.warn('[optimizeRouteRealTime] recalculateTrackingNumbers failed (non-fatal):', trackingError?.message || trackingError);
    }

    try {
      await base44.asServiceRole.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate
      });
      console.log('🧹 [optimizeRouteRealTime] Polylines purged and regenerated');
    } catch (polylineError) {
      console.warn('[optimizeRouteRealTime] purgeAndRegeneratePolylines failed (non-fatal):', polylineError?.message || polylineError);
    }

    console.log(`\n✅ Route optimization complete - ${updates.length} stops updated, ${totalApiCalls} API calls`);
    if (assignedNextDeliveryStopOrder !== null) {
      console.log(`🎯 [optimizeRouteRealTime] isNextDelivery assigned stop order ${assignedNextDeliveryStopOrder}`);
    }

    // Ensure exactly one isNextDelivery is set for remaining incomplete stops
    try {
      const allForDriverDate = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order');

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompletes = (allForDriverDate || []).filter(d => d && !finishedStatuses.includes(d.status) && d.status !== 'pending');

      if (incompletes.length > 0) {
        const targetId = nextDeliveryStop?.delivery?.id || [...incompletes].sort((a, b) => {
          const so = (a.stop_order || 999) - (b.stop_order || 999);
          if (so !== 0) return so;
          const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
          const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
          return etaA.localeCompare(etaB);
        })[0]?.id;

        if (targetId) {
          const toFalse = incompletes.filter(d => d.id !== targetId && d.isNextDelivery === true);
          if (toFalse.length > 0) {
            await Promise.all(toFalse.map(d => base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false })));
          }
          await base44.asServiceRole.entities.Delivery.update(targetId, { isNextDelivery: true });
        }
      }
    } catch (e) {
      console.warn('[optimizeRouteRealTime] ensure isNextDelivery failed (non-fatal):', e?.message || e);
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedRoute: updates,
      totalStops: updates.length,
      stagesCount: stages.length,
      apiCallsMade: totalApiCalls,
      locationSource
    });

  } catch (error) {
    console.error('❌ [optimizeRouteRealTime] ERROR:', error.message);
    return Response.json({ 
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});