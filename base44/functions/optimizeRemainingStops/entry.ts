// Redeployed on 2026-05-11 - fixed time window adherence for future dates / off-duty drivers
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
const AUTOMATION_DEDUPE_WINDOW_MS = 60000;
const LAST_FINISHED_STOP_PROXIMITY_KM = 0.25;
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

const getLatestFinishedDelivery = (deliveries) => [...(deliveries || [])]
  .filter((delivery) => FINISHED_STATUSES.includes(delivery?.status))
  .sort((a, b) => {
    const aTime = new Date(a?.actual_delivery_time || a?.updated_date || a?.created_date || 0).getTime();
    const bTime = new Date(b?.actual_delivery_time || b?.updated_date || b?.created_date || 0).getTime();
    return bTime - aTime;
  })[0] || null;

const getDeliveryCoords = (delivery, patientMap, storeMap) => {
  if (!delivery) return null;
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) {
      return { lat: Number(patient.latitude), lng: Number(patient.longitude) };
    }
  }
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null) {
    return { lat: Number(store.latitude), lng: Number(store.longitude) };
  }
  return null;
};

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const addRouteToHomePenalty = (routeStops, homePosition) => {
  if (!homePosition || !routeStops.length) return 0;
  const lastStop = routeStops[routeStops.length - 1];
  if (!lastStop) return 0;
  return calculateCrowFliesDistance(lastStop.lat, lastStop.lng, homePosition.lat, homePosition.lng);
};

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

const formatMinutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const getEffectiveWindowStart = (delivery, patient = null) => {
  return delivery?.time_window_start || patient?.time_window_start || delivery?.delivery_time_start || null;
};

const getEffectiveWindowEnd = (delivery, patient = null) => {
  return delivery?.time_window_end || patient?.time_window_end || delivery?.delivery_time_end || null;
};

const isLateWindowStop = (windowStart, currentMinutes) => {
  const startMinutes = parseTimeToMinutes(windowStart);
  return Number.isFinite(startMinutes) && startMinutes > currentMinutes;
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
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

const buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const getEdmontonTodayDateString = () => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
};

const isHistoricalRouteDate = (dateStr) => {
  if (!dateStr) return false;
  return String(dateStr) < getEdmontonTodayDateString();
};

const getLegTravelMinutes = ({ stop, leg, segmentPolyline, fallbackMinutes = 5 }) => {
  const estimatedDurationMinutes = segmentPolyline?.estimatedDurationMinutes;
  if (typeof estimatedDurationMinutes === 'number' && estimatedDurationMinutes > 0) {
    return Math.ceil(estimatedDurationMinutes);
  }
  const deliveryEstimatedDuration = stop?.delivery?.estimated_duration_minutes;
  if (typeof deliveryEstimatedDuration === 'number' && deliveryEstimatedDuration > 0) {
    return Math.ceil(deliveryEstimatedDuration);
  }
  const travelSeconds = Number(leg?.duration || 0);
  if (travelSeconds > 0) {
    return Math.ceil(travelSeconds / 60);
  }
  return fallbackMinutes;
};

const extractOptimizationContext = (body = {}) => {
  if (body?.driverId && body?.deliveryDate) {
    return {
      driverId: body.driverId,
      deliveryDate: body.deliveryDate,
      currentLocalTime: body.currentLocalTime,
      deviceTime: body.deviceTime,
      preserveExistingOrder: body.preserveExistingOrder === true,
      forceFullRemainingRouteOptimization: body.forceFullRemainingRouteOptimization === true,
      bypassDriverStatus: body.bypassDriverStatus === true,
      triggerSource: body.triggerSource || 'manual'
    };
  }

  const eventType = body?.event?.type;
  const data = body?.data || null;
  const oldData = body?.old_data || null;

  const resolvedDriverId = body?.driverId || data?.driver_id || oldData?.driver_id || null;
  const resolvedDeliveryDate = body?.deliveryDate || data?.delivery_date || oldData?.delivery_date || null;

  return {
    driverId: resolvedDriverId,
    deliveryDate: resolvedDeliveryDate,
    currentLocalTime: body.currentLocalTime,
    deviceTime: body.deviceTime,
    preserveExistingOrder: body.preserveExistingOrder === true,
    forceFullRemainingRouteOptimization: body.forceFullRemainingRouteOptimization === true,
    bypassDriverStatus: body.bypassDriverStatus === true,
    triggerSource: eventType ? `automation:${eventType}` : 'automation',
    eventType,
    data,
    oldData,
    changedFields: Array.isArray(body?.changed_fields) ? body.changed_fields : []
  };
};

const shouldSkipAutomationEvent = (context = {}) => {
  if (!context?.eventType) return false;
  const { eventType, data, oldData, changedFields } = context;

  if (eventType === 'create') {
    return !ACTIVE_STATUSES.includes(String(data?.status || ''));
  }

  if (eventType === 'delete') {
    return false;
  }

  if (eventType !== 'update') return false;

  const stopOrderChanged = changedFields.includes('stop_order') && !FINISHED_STATUSES.includes(String(data?.status || ''));
  const nextDeliveryChanged = changedFields.includes('isNextDelivery') && data?.isNextDelivery === true;
  const activatedToRoute = changedFields.includes('status')
    && ACTIVE_STATUSES.includes(String(data?.status || ''))
    && !ACTIVE_STATUSES.includes(String(oldData?.status || ''));

  return !(stopOrderChanged || nextDeliveryChanged || activatedToRoute);
};

const dedupeKeyFor = (driverId, deliveryDate) => `optimizeRemainingStops:${driverId}:${deliveryDate}`;

// Snap cumulativeTime to the effective earliest start for a stop (windowStart or delivery_time_start)
const snapToWindowStart = (cumulativeTime, stop) => {
  const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start || stop.delivery?.time_window_start);
  if (Number.isFinite(windowStart) && cumulativeTime < windowStart) {
    return windowStart;
  }
  return cumulativeTime;
};

Deno.serve(async (req) => {
  console.log('🚀 [optimizeRemainingStops] Function called');

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('✅ [optimizeRemainingStops] User authenticated:', user.email);

    const body = await req.json();
    const context = extractOptimizationContext(body);
    const {
      driverId,
      deliveryDate,
      currentLocalTime,
      deviceTime,
      preserveExistingOrder = false,
      forceFullRemainingRouteOptimization = false,
      bypassDriverStatus = false,
      triggerSource = 'manual'
    } = context;

    const firstStopId = body?.firstStopId || null;

    if (!driverId || !deliveryDate) {
      return Response.json({
        error: 'Missing required parameters: driverId, deliveryDate'
      }, { status: 400 });
    }

    if (shouldSkipAutomationEvent(context)) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'non_optimization_event',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    const dedupeKey = dedupeKeyFor(driverId, deliveryDate);
    const dedupeCheck = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: dedupeKey }, '-updated_date', 1);
    const dedupeRecord = dedupeCheck?.[0] || null;
    const lastRunAt = dedupeRecord?.setting_value?.last_run_at ? new Date(dedupeRecord.setting_value.last_run_at).getTime() : 0;
    if (lastRunAt && Date.now() - lastRunAt < AUTOMATION_DEDUPE_WINDOW_MS) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'deduped_recent_run',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    if (dedupeRecord?.id) {
      await base44.asServiceRole.entities.AppSettings.update(dedupeRecord.id, {
        setting_value: {
          ...(dedupeRecord.setting_value || {}),
          last_run_at: new Date().toISOString(),
          trigger_source: triggerSource
        }
      });
    } else {
      await base44.asServiceRole.entities.AppSettings.create({
        setting_key: dedupeKey,
        description: 'Recent optimizeRemainingStops execution lock',
        setting_value: {
          last_run_at: new Date().toISOString(),
          trigger_source: triggerSource
        }
      });
    }

    // Resolve current wall-clock time in Edmonton (always "now")
    let currentMinutes;
    if (currentLocalTime) {
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
    } else if (deviceTime) {
      const deviceDate = new Date(deviceTime);
      if (!Number.isNaN(deviceDate.getTime())) {
        currentMinutes = deviceDate.getHours() * 60 + deviceDate.getMinutes();
      } else {
        const now = new Date();
        let mountainHours = now.getUTCHours() - 7;
        if (mountainHours < 0) mountainHours += 24;
        currentMinutes = mountainHours * 60 + now.getUTCMinutes();
      }
    } else {
      const now = new Date();
      let mountainHours = now.getUTCHours() - 7;
      if (mountainHours < 0) mountainHours += 24;
      currentMinutes = mountainHours * 60 + now.getUTCMinutes();
    }

    // Determine if this is a future delivery date
    const todayStr = getEdmontonTodayDateString();
    const isFutureDate = String(deliveryDate) > todayStr;

    // isFutureRoute = true for future dates OR today but earliest window >1hr from now.
    // Computed after stops are built (see below where earliestWindowMinutes is resolved).

    console.log(`🔄 [optimizeRemainingStops] Optimizing remaining stops for driver ${driverId} on ${deliveryDate} (today=${todayStr}, isFuture=${isFutureDate})`);

    // Resolve AppUser: try AppUser.id first (new standard), fallback to user_id (legacy)
    let driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1))?.[0] || null;
    if (!driverAppUser) {
      driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1))?.[0] || null;
    }
    if (!driverAppUser) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    // CRITICAL: Allow optimization for future dates regardless of driver status.
    // For today's routes, only skip if driver is off_duty/on_break AND bypassDriverStatus is not set.
    const driverIsOffDuty = driverAppUser.driver_status === 'off_duty' || driverAppUser.driver_status === 'on_break';
    if (!bypassDriverStatus && !isFutureDate && driverIsOffDuty) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'driver_unavailable',
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    const preferredTravelMode = String(driverAppUser?.preferred_travel_mode || 'driving').toLowerCase();
    // For route optimization sequencing, always use driving so HERE can find the globally
    // optimal stop order. Cycling-mode stops get their own polyline pass afterwards.
    const routingTravelMode = 'driving';

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    console.log(`📦 [optimizeRemainingStops] Found ${allDeliveries.length} deliveries`);

    const completedDeliveries = allDeliveries.filter(d => FINISHED_STATUSES.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !FINISHED_STATUSES.includes(d.status));
    const activeRouteDeliveries = incompleteDeliveries.filter((delivery) => ACTIVE_STATUSES.includes(delivery.status));
    const pendingRouteDeliveries = incompleteDeliveries.filter((delivery) => delivery.status === 'pending');
    const optimizableDeliveries = [...activeRouteDeliveries, ...pendingRouteDeliveries];

    if (optimizableDeliveries.length === 0) {
      return Response.json({
        success: true,
        message: 'No optimizable stops found',
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    console.log(`📊 [optimizeRemainingStops] Incomplete deliveries breakdown:`);
    incompleteDeliveries.forEach(d => {
      console.log(`   - ${d.patient_name || 'Pickup'}: isNextDelivery=${d.isNextDelivery}, delivery_time_start=${d.delivery_time_start}`);
    });

    const patientIds = [...new Set(optimizableDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    const storeIds = [...new Set(optimizableDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    const pickupWindowByStopId = new Map(
      optimizableDeliveries
        .filter((delivery) => delivery && !delivery.patient_id && delivery.stop_id)
        .map((delivery) => [delivery.stop_id, {
          start: delivery.delivery_time_start || null,
          end: delivery.delivery_time_end || null
        }])
    );

    const stops = optimizableDeliveries.map(delivery => {
      const coords = getDeliveryCoords(delivery, patientMap, storeMap);
      const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
      let windowStart = getEffectiveWindowStart(delivery, patient);
      let windowEnd = getEffectiveWindowEnd(delivery, patient);

      if (delivery.patient_id && delivery.puid && pickupWindowByStopId.has(delivery.puid)) {
        const pickupWindow = pickupWindowByStopId.get(delivery.puid);
        const pickupEndMinutes = parseTimeToMinutes(pickupWindow?.end || pickupWindow?.start);
        const deliveryStartMinutes = parseTimeToMinutes(windowStart);
        if (Number.isFinite(pickupEndMinutes) && (!Number.isFinite(deliveryStartMinutes) || deliveryStartMinutes < pickupEndMinutes)) {
          windowStart = formatMinutesToTime(pickupEndMinutes + 5);
        }
      }

      return {
        delivery,
        lat: coords?.lat,
        lng: coords?.lng,
        isPickup: !delivery.patient_id,
        windowStart,
        windowEnd,
        hasLateWindow: isLateWindowStop(windowStart, currentMinutes),
        timeMinutes: parseTimeToMinutes(windowStart || delivery.delivery_time_start)
      };
    }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));

    console.log(`📋 [optimizeRemainingStops] Prepared ${stops.length} stops for HERE sequencing`);

    const historicalRoute = isHistoricalRouteDate(deliveryDate);
    const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);

    let currentPosition;
    let locationSource;

    const explicitNextDelivery = (firstStopId ? incompleteDeliveries.find((d) => d?.id === firstStopId) : null)
      || incompleteDeliveries.find((delivery) => delivery?.isNextDelivery === true)
      || null;
    const explicitNextCoords = explicitNextDelivery ? getDeliveryCoords(explicitNextDelivery, patientMap, storeMap) : null;
    const latestFinishedCoords = latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap) : null;
    const previousStopBeforeNext = explicitNextDelivery
      ? allDeliveries
          .filter((delivery) => delivery?.id !== explicitNextDelivery.id)
          .filter((delivery) => Number(delivery?.stop_order || 0) < Number(explicitNextDelivery?.stop_order || 0))
          .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null
      : null;
    const previousStopCoords = previousStopBeforeNext ? getDeliveryCoords(previousStopBeforeNext, patientMap, storeMap) : null;
    const routeHasStarted = completedDeliveries.length > 0 || !!previousStopBeforeNext;
    const shouldLockExplicitNextStop = !!explicitNextDelivery;

    const driverGpsPosition = driverAppUser.current_latitude != null && driverAppUser.current_longitude != null
      ? { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) }
      : null;

    if (routeHasStarted && latestFinishedCoords) {
      const distanceFromLastFinishedStop = driverGpsPosition
        ? calculateCrowFliesDistance(driverGpsPosition.lat, driverGpsPosition.lng, latestFinishedCoords.lat, latestFinishedCoords.lng)
        : null;

      if (distanceFromLastFinishedStop != null && distanceFromLastFinishedStop > LAST_FINISHED_STOP_PROXIMITY_KM) {
        currentPosition = driverGpsPosition;
        locationSource = 'driver_gps_away_from_last_finished_stop';
      } else {
        currentPosition = latestFinishedCoords;
        locationSource = 'last_finished_stop';
      }
    }

    if (!currentPosition && previousStopCoords) {
      currentPosition = previousStopCoords;
      locationSource = 'previous_stop_before_next';
    }

    if (!currentPosition && explicitNextCoords) {
      currentPosition = explicitNextCoords;
      locationSource = 'next_delivery_stop';
    }

    if (!routeHasStarted && !currentPosition && driverGpsPosition) {
      currentPosition = driverGpsPosition;
      locationSource = 'driver_gps';
    }

    if (!currentPosition && driverAppUser.home_latitude != null && driverAppUser.home_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) };
      locationSource = 'home';
    }

    if (!currentPosition) {
      return Response.json({
        error: 'Driver location not available - no GPS, last completed, or home location set'
      }, { status: 404 });
    }

    const logicalSegmentOrigin = latestFinishedCoords
      || (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
        ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
        : null)
      || currentPosition;

    console.log(`📍 [optimizeRemainingStops] Starting from: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng})`);
    console.log(`🎯 [optimizeRemainingStops] Active next stop: ${explicitNextDelivery?.id || 'none'}`);

    const optimizationStops = optimizableDeliveries
      .map((delivery) => stops.find((item) => item.delivery.id === delivery.id) || null)
      .filter(Boolean);

    // CRITICAL: Pre-sort stops by delivery_time_start window before optimization.
    // This gives HERE a chronologically-sensible initial ordering as input hint,
    // which helps it respect time windows correctly during sequencing.
    const sortStopsByWindow = (stopsArr) =>
      stopsArr.slice().sort((a, b) => {
        const aMin = parseTimeToMinutes(a.windowStart || a.delivery?.delivery_time_start);
        const bMin = parseTimeToMinutes(b.windowStart || b.delivery?.delivery_time_start);
        const aVal = Number.isFinite(aMin) ? aMin : 99999;
        const bVal = Number.isFinite(bMin) ? bMin : 99999;
        return aVal - bVal;
      });

    const orderedOptimizationStops = preserveExistingOrder
      ? optimizationStops.slice().sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999))
      : sortStopsByWindow(optimizationStops);

    const nextDeliveryStop = orderedOptimizationStops.find((stop) => stop.delivery.isNextDelivery === true) || null;
    const lockedNextStop = !preserveExistingOrder && shouldLockExplicitNextStop && nextDeliveryStop ? nextDeliveryStop : null;
    const routeOriginStop = lockedNextStop || null;
    const stopsToSequence = routeOriginStop
      ? orderedOptimizationStops.filter((stop) => stop.delivery.id !== routeOriginStop.delivery.id)
      : orderedOptimizationStops;

    // Track which stops are pending — they participate in sequencing but get no polyline
    const pendingDeliveryIds = new Set(pendingRouteDeliveries.map(d => d.id));

    console.log(`\n🎯 [optimizeRemainingStops] Optimizing remaining route: ${optimizationStops.length} stops`);

    let attemptedHereCalls = 0;
    let usedTimeWindows = true;
    let routeStops = routeOriginStop ? [routeOriginStop] : [];
    let directionsLegs = [];
    let segmentPolylines = [];

    const resolvedHomePosition = driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    // -------------------------------------------------------------------
    // CRITICAL: Resolve departureTime for HERE API call.
    //
    // Conditions requiring strict time-window-based departure (not "now"):
    //   1. deliveryDate is in the future
    //   2. Today's route but driver is off-duty (bypassDriverStatus=true from dispatcher/admin)
    //   3. Today's route but current time is >1hr before the first stop's window start
    //
    // In all three cases, use the earliest windowStart across all stops as the
    // departureTime so HERE correctly respects time windows during sequencing.
    // -------------------------------------------------------------------
    const allStopsForDeparture = routeOriginStop ? [routeOriginStop, ...stopsToSequence] : stopsToSequence;
    const earliestWindowMinutes = allStopsForDeparture.reduce((earliest, s) => {
      const wm = parseTimeToMinutes(s.windowStart || s.delivery?.delivery_time_start);
      return Number.isFinite(wm) && wm < earliest ? wm : earliest;
    }, Infinity);

    // isFutureRoute: future date OR today but earliest window start is >1hr from now.
    // This is the canonical flag for "route hasn't started yet, use window-based ETAs".
    const isFutureRoute = isFutureDate
      || (Number.isFinite(earliestWindowMinutes) && (earliestWindowMinutes - currentMinutes) > 60);

    const useWindowBasedDeparture = isFutureRoute
      || driverIsOffDuty; // off-duty = pre-route planning mode

    let resolvedDepartureTime;
    if (useWindowBasedDeparture && Number.isFinite(earliestWindowMinutes)) {
      resolvedDepartureTime = formatMinutesToTime(earliestWindowMinutes);
      console.log(`⏰ [optimizeRemainingStops] Using window-based departureTime=${resolvedDepartureTime} (isFutureRoute=${isFutureRoute}, offDuty=${driverIsOffDuty})`);
    } else {
      resolvedDepartureTime = currentLocalTime || formatMinutesToTime(currentMinutes);
      console.log(`⏰ [optimizeRemainingStops] Using current-time departureTime=${resolvedDepartureTime}`);
    }

    // CRITICAL: For future routes, ALWAYS base ETAs from the earliest window start.
    // This prevents ETAs being anchored to the wall-clock time of optimization.
    const etaBaseMinutes = useWindowBasedDeparture && Number.isFinite(earliestWindowMinutes)
      ? earliestWindowMinutes
      : currentMinutes;

    console.log(`📅 [optimizeRemainingStops] isFutureDate=${isFutureDate}, isFutureRoute=${isFutureRoute}, etaBase=${formatMinutesToTime(etaBaseMinutes)}, currentTime=${formatMinutesToTime(currentMinutes)}, earliestWindow=${Number.isFinite(earliestWindowMinutes) ? formatMinutesToTime(earliestWindowMinutes) : 'none'}`);

    if (preserveExistingOrder) {
      // Just refresh ETAs using existing order, no HERE call needed
      routeStops = [...orderedOptimizationStops];
      let prevPos = currentPosition;
      for (const stop of routeStops) {
        const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
        directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
        prevPos = { lat: stop.lat, lng: stop.lng };
      }
      console.log('✅ [optimizeRemainingStops] Preserving existing order and refreshing ETAs only');
    } else if (stopsToSequence.length > 0) {
      // -------------------------------------------------------------------
      // Step 1: Call getHereDirections to get optimized sequence + polylines
      // -------------------------------------------------------------------
      const originForDirections = currentPosition;

      const allWaypointsForDirections = routeOriginStop
        ? [{ lat: routeOriginStop.lat, lng: routeOriginStop.lng }, ...stopsToSequence.map(s => ({ lat: s.lat, lng: s.lng }))]
        : stopsToSequence.map(s => ({ lat: s.lat, lng: s.lng }));

      const allRouteContextForDirections = routeOriginStop
        ? [
            {
              id: routeOriginStop.delivery.stop_id || routeOriginStop.delivery.delivery_id || routeOriginStop.delivery.id,
              stop_id: routeOriginStop.delivery.stop_id,
              delivery_id: routeOriginStop.delivery.delivery_id,
              time_window_start: routeOriginStop.windowStart,
              time_window_end: routeOriginStop.windowEnd,
            },
            ...stopsToSequence.map(s => ({
              id: s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id,
              stop_id: s.delivery.stop_id,
              delivery_id: s.delivery.delivery_id,
              time_window_start: s.windowStart,
              time_window_end: s.windowEnd,
            }))
          ]
        : stopsToSequence.map(s => ({
            id: s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id,
            stop_id: s.delivery.stop_id,
            delivery_id: s.delivery.delivery_id,
            time_window_start: s.windowStart,
            time_window_end: s.windowEnd,
          }));

      // Destination: home if available, otherwise last waypoint
      const lastWaypoint = allWaypointsForDirections[allWaypointsForDirections.length - 1];
      const destinationForDirections = resolvedHomePosition || lastWaypoint || originForDirections;

      let hereDirectionsResult = null;
      try {
        const hereResp = await base44.asServiceRole.functions.invoke('getHereDirections', {
          origin: originForDirections,
          destination: destinationForDirections,
          waypoints: allWaypointsForDirections,
          routeContext: allRouteContextForDirections,
          transportMode: routingTravelMode,
          deliveryDate,
          departureTime: resolvedDepartureTime,
          caller: 'optimizeRemainingStops',
          preserveWaypointOrder: false,
          skipSequenceApi: false,
        });

        hereDirectionsResult = hereResp?.data || hereResp || null;
        const apiCallCount = Number(hereDirectionsResult?.api_call_count || 1);
        attemptedHereCalls += apiCallCount;
        usedTimeWindows = hereDirectionsResult?.used_time_windows ?? true;
        console.log(`📡 [optimizeRemainingStops] getHereDirections returned ${hereDirectionsResult?.sections?.length || 0} sections, polyline_format=${hereDirectionsResult?.polyline_format}`);
      } catch (hereErr) {
        console.error('❌ [optimizeRemainingStops] getHereDirections failed:', hereErr?.message || hereErr);
        hereDirectionsResult = null;
      }

      // -------------------------------------------------------------------
      // Step 2: Build routeStops in the optimized order returned by HERE
      // -------------------------------------------------------------------
      const optimizedWaypointIds = Array.isArray(hereDirectionsResult?.optimized_waypoint_ids)
        ? hereDirectionsResult.optimized_waypoint_ids
        : null;

      const sections = Array.isArray(hereDirectionsResult?.sections) ? hereDirectionsResult.sections : [];

      if (optimizedWaypointIds && optimizedWaypointIds.length > 0 && sections.length > 0) {
        const allSequencedStops = routeOriginStop ? [routeOriginStop, ...stopsToSequence] : stopsToSequence;
        const stopLookupById = new Map(
          allSequencedStops.map(s => [s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id, s])
        );

        const orderedSequencedStops = optimizedWaypointIds
          .map(waypointId => stopLookupById.get(waypointId) || null)
          .filter(Boolean);

        routeStops = orderedSequencedStops;

        directionsLegs = routeStops.map((stop, index) => {
          const section = sections[index] || null;
          if (section) {
            return {
              duration: (section.estimated_duration_minutes || 0) * 60,
              distance: (section.estimated_distance_km || 0) * 1000
            };
          }
          const prevPos = index === 0 ? originForDirections : { lat: routeStops[index - 1].lat, lng: routeStops[index - 1].lng };
          const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
          return { duration: Math.ceil((distKm / 40) * 3600 * 1.3), distance: distKm * 1000 };
        });

        segmentPolylines = routeStops.map((stop, index) => {
          const section = sections[index] || null;
          const isPending = pendingDeliveryIds.has(stop.delivery.id);
          return {
            deliveryId: stop.delivery.id,
            encodedPolyline: isPending ? null : (section?.encoded_polyline || null),
            estimatedDistanceKm: section?.estimated_distance_km ?? null,
            estimatedDurationMinutes: section?.estimated_duration_minutes ?? null,
          };
        });

        console.log(`✅ [optimizeRemainingStops] HERE sequence+polyline success: ${routeStops.length} stops, ${sections.length} sections${usedTimeWindows ? ' with time windows' : ' without time windows'}`);
        segmentPolylines.forEach((sp, i) => {
          console.log(`   Leg ${i + 1} -> ${sp.deliveryId}: polyline=${sp.encodedPolyline ? 'YES (' + sp.encodedPolyline.length + ' chars)' : 'NONE'}, dist=${sp.estimatedDistanceKm}km, dur=${sp.estimatedDurationMinutes}min`);
        });
      } else {
        // Fallback: crow-flies ordering
        console.log('⚠️ [optimizeRemainingStops] HERE sequencing failed or returned no sections - using crow-flies fallback');
        const allStopsForFallback = routeOriginStop ? [routeOriginStop, ...stopsToSequence] : [...stopsToSequence];
        allStopsForFallback.sort((a, b) => {
          const distA = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, a.lat, a.lng);
          const distB = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, b.lat, b.lng);
          const homePenaltyA = resolvedHomePosition ? calculateCrowFliesDistance(a.lat, a.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
          const homePenaltyB = resolvedHomePosition ? calculateCrowFliesDistance(b.lat, b.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
          return (distA - homePenaltyA * 0.15) - (distB - homePenaltyB * 0.15);
        });
        routeStops = allStopsForFallback;
        let prevPos = currentPosition;
        for (const stop of routeStops) {
          const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
          directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
          prevPos = { lat: stop.lat, lng: stop.lng };
        }
      }
    }

    // -------------------------------------------------------------------
    // ETA calculation
    // CRITICAL: For all cases (historical, future, today) we always snap
    // cumulativeTime upward to the stop's effective window start (windowStart
    // OR delivery_time_start) so ETAs strictly respect time windows.
    // etaBaseMinutes is "now" for active routes, or the earliest window
    // start for future/off-duty/early routes.
    // -------------------------------------------------------------------
    const stageEtaMap = new Map();
    const segmentPolylineByDeliveryId = new Map(segmentPolylines.map((segment) => [segment.deliveryId, segment]));

    if (historicalRoute && routeStops.length > 0) {
      const firstStop = routeStops[0];
      let cumulativeTime = snapToWindowStart(etaBaseMinutes, firstStop);

      const firstStopEta = formatMinutesToTime(cumulativeTime);
      stageEtaMap.set(firstStop.delivery.id, firstStopEta);
      cumulativeTime += firstStop.delivery.extra_time || (firstStop.isPickup ? 15 : 5);
      console.log(`  ✅ [optimizeRemainingStops] ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${firstStopEta}`);

      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
        const travelMinutes = getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline });
        cumulativeTime += travelMinutes;
        cumulativeTime = snapToWindowStart(cumulativeTime, stop);

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}`);
      }
    } else {
      // CRITICAL: For future dates or window-based departures, always start ETA accumulation
      // from etaBaseMinutes (the earliest window start), NOT from currentMinutes.
      // This ensures all stops get ETAs projected from the correct route start time,
      // not from the wall-clock time of optimization.
      let cumulativeTime = etaBaseMinutes;

      for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
        const isLockedStartedStop = i === 0 && !!lockedNextStop;
        if (!isLockedStartedStop) {
          const travelMinutes = getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline, fallbackMinutes: 10 });
          cumulativeTime += travelMinutes;
        }

        // CRITICAL: Pickups on future routes always get an ETA exactly equal to their
        // delivery_time_start — no travel-time drift allowed for scheduled pickups.
        if (stop.isPickup && isFutureRoute) {
          const pickupStartMinutes = parseTimeToMinutes(stop.delivery?.delivery_time_start || stop.windowStart);
          if (Number.isFinite(pickupStartMinutes)) {
            cumulativeTime = pickupStartMinutes;
          }
        } else {
          // Snap UP to the stop's own window start if we'd arrive too early.
          cumulativeTime = snapToWindowStart(cumulativeTime, stop);
        }

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        // Advance by service time at this stop before calculating the next leg
        cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta} (base=${formatMinutesToTime(etaBaseMinutes)}, isFutureRoute=${isFutureRoute})`);
      }
    }

    const activeStops = routeStops.map((stop) => ({
      ...stop.delivery,
      delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
    }));

    console.log(`\n🔢 [optimizeRemainingStops] HERE returned ${activeStops.length} ordered stops`);

    const startingOrder = completedDeliveries.length;
    const originalActiveOrder = activeRouteDeliveries
      .slice()
      .sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999))
      .map((delivery) => String(delivery.id));
    const optimizedActiveOrder = activeStops.map((stop) => String(stop.id));
    const routeOrderChanged = preserveExistingOrder
      ? false
      : originalActiveOrder.length !== optimizedActiveOrder.length
        || originalActiveOrder.some((id, index) => id !== optimizedActiveOrder[index]);

    console.log('🏠 [optimizeRemainingStops] Final-route distance to home penalty applied:', addRouteToHomePenalty(routeStops, resolvedHomePosition).toFixed(2), 'km');
    const finalDeliveryWriteBatch = [];
    const finalizedById = new Map(activeStops.map((stop) => [stop.id, stop]));
    // CRITICAL: Lock the explicit isNextDelivery stop — do NOT override it with activeStops[0]
    const nextStopId = explicitNextDelivery?.id || null;

    // Returns { startTime, eta } for pending stops linked to a pickup.
    // The ETA for any pending delivery = its pickup's ETA + 5 min (pickup service time).
    const resolvePendingTimes = (stop) => {
      if (stop.status !== 'pending') return null;

      if (!stop.patient_id) {
        // Pickup: keep its existing delivery_time_start as both start and ETA
        const t = stop.delivery_time_start || stop.delivery_time_eta;
        return t ? { startTime: t, eta: t } : null;
      }

      if (!stop.puid) return null;

      const pickup = activeStops.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid)
        || allDeliveries.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid);

      if (!pickup) return null;

      const pickupState = finalizedById.get(pickup.id) || pickup;
      // Use the pickup's finalized ETA, falling back to its delivery_time_start
      let pickupEtaMinutes = parseTimeToMinutes(pickupState.delivery_time_eta);
      if (!Number.isFinite(pickupEtaMinutes)) {
        pickupEtaMinutes = parseTimeToMinutes(pickupState.delivery_time_start);
      }
      if (!Number.isFinite(pickupEtaMinutes)) return null;

      const serviceMinutes = pickupState.extra_time || 5;
      const resolvedTime = formatMinutesToTime(pickupEtaMinutes + serviceMinutes);
      return { startTime: resolvedTime, eta: resolvedTime };
    };

    for (let i = 0; i < activeStops.length; i++) {
      const stop = activeStops[i];
      const newOrder = preserveExistingOrder ? Number(stop.stop_order || i + 1) : startingOrder + i + 1;
      const pendingTimes = resolvePendingTimes(stop);
      const segmentPolyline = segmentPolylineByDeliveryId.get(stop.id) || null;
      const resolvedTransportMode = String(stop?.transport_mode || preferredTravelMode || 'driving').toLowerCase();
      const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(resolvedTransportMode) ? resolvedTransportMode : 'driving';

      const isPendingStop = pendingDeliveryIds.has(stop.id);
      // CRITICAL: Pending stops linked to a pickup get their ETA overridden to pickup ETA + 5 min
      const resolvedEta = (isPendingStop && pendingTimes?.eta) ? pendingTimes.eta : stop.delivery_time_eta;

      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder,
        delivery_time_eta: resolvedEta,
        isNextDelivery: stop.id === nextStopId,
        transport_mode: safeTransportMode,
        travel_dist: Number(directionsLegs[i]?.distance)
          ? Number((Number(directionsLegs[i].distance) / 1000).toFixed(3))
          : null,
        // Pending stops never get a polyline — clear any stale one
        encoded_polyline: isPendingStop ? null : (segmentPolyline?.encodedPolyline || null),
        ...(typeof segmentPolyline?.estimatedDurationMinutes === 'number' && !isPendingStop ? { estimated_duration_minutes: segmentPolyline.estimatedDurationMinutes } : {}),
        ...(typeof segmentPolyline?.estimatedDistanceKm === 'number' && !isPendingStop ? { estimated_distance_km: segmentPolyline.estimatedDistanceKm } : {}),
      };

      if (pendingTimes?.startTime) {
        updateData.delivery_time_start = pendingTimes.startTime;
        stop.delivery_time_start = pendingTimes.startTime;
      }
      // Sync the ETA back onto the stop object so the response reflects the override
      stop.delivery_time_eta = resolvedEta;

      stop.stop_order = newOrder;
      stop.display_stop_order = newOrder;
      stop.isNextDelivery = stop.id === nextStopId;

      finalDeliveryWriteBatch.push({
        id: stop.id,
        data: updateData,
        label: stop.patient_name || 'Pickup',
      });
    }

    // -------------------------------------------------------------------
    // Cycling polyline override pass
    // -------------------------------------------------------------------
    const cyclingBatchItems = finalDeliveryWriteBatch.filter(
      ({ data }) => data.transport_mode === 'cycling' && !pendingDeliveryIds.has(data.id ?? '')
    );

    if (cyclingBatchItems.length > 0) {
      console.log(`🚴 [optimizeRemainingStops] Fetching cycling polylines for ${cyclingBatchItems.length} stop(s)...`);

      await Promise.all(cyclingBatchItems.map(async (batchItem) => {
        const stopIndex = routeStops.findIndex((s) => s.delivery.id === batchItem.id);
        if (stopIndex < 0) return;

        const fromPos = stopIndex === 0
          ? currentPosition
          : { lat: routeStops[stopIndex - 1].lat, lng: routeStops[stopIndex - 1].lng };
        const toStop = routeStops[stopIndex];

        try {
          const cycleResp = await base44.asServiceRole.functions.invoke('getHereDirections', {
            origin: fromPos,
            destination: { lat: toStop.lat, lng: toStop.lng },
            waypoints: [],
            routeContext: [],
            transportMode: 'cycling',
            deliveryDate,
            departureTime: resolvedDepartureTime,
            caller: 'optimizeRemainingStops:cyclingOverride',
            preserveWaypointOrder: true,
            skipSequenceApi: true,
          });

          const cycleResult = cycleResp?.data || cycleResp || null;
          const cycleSection = Array.isArray(cycleResult?.sections) ? cycleResult.sections[0] : null;

          if (cycleSection?.encoded_polyline) {
            batchItem.data.encoded_polyline = cycleSection.encoded_polyline;
            if (typeof cycleSection.estimated_distance_km === 'number') {
              batchItem.data.estimated_distance_km = cycleSection.estimated_distance_km;
            }
            if (typeof cycleSection.estimated_duration_minutes === 'number') {
              batchItem.data.estimated_duration_minutes = cycleSection.estimated_duration_minutes;
            }
            console.log(`  🚴 Cycling polyline updated for stop ${batchItem.id} (${batchItem.label})`);
          } else {
            console.warn(`  ⚠️ No cycling polyline returned for stop ${batchItem.id} - keeping driving polyline`);
          }
        } catch (cycleErr) {
          console.warn(`  ⚠️ Cycling polyline fetch failed for stop ${batchItem.id}:`, cycleErr?.message);
        }
      }));
    }

    await Promise.all(
      finalDeliveryWriteBatch.map(({ id, data }) =>
        base44.asServiceRole.entities.Delivery.update(id, data).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        })
      )
    );

    finalDeliveryWriteBatch.forEach(({ data, label }) => {
      console.log(`  🔢 [optimizeRemainingStops] Stop #${data.stop_order}: ${label} | ETA: ${data.delivery_time_eta || 'none'}${data.encoded_polyline ? ' [polyline saved]' : ' [no polyline]'}${data.delivery_time_start ? ` (start: ${data.delivery_time_start})` : ''}`);
    });

    const shouldRefreshPolylines = activeStops.length > 0;

    console.log(`\n✅ [optimizeRemainingStops] Route optimization complete - ${activeStops.length} stops updated, ${attemptedHereCalls} API calls`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: routeOrderChanged,
      optimizedCount: routeStops.length,
      stagesCount: 1,
      apiCallsMade: attemptedHereCalls,
      locationSource,
      usedTimeWindows,
      preserveExistingOrder,
      forceFullRemainingRouteOptimization,
      nextDeliveryId: nextStopId,
      shouldRefreshPolylines,
      optimizedRoute: activeStops.map((stop, index) => ({
        deliveryId: stop.id,
        newETA: stop.delivery_time_eta,
        stop_order: startingOrder + index + 1,
        isNextDelivery: stop.id === nextStopId,
        transport_mode: stop.transport_mode || preferredTravelMode,
        encoded_polyline: finalDeliveryWriteBatch[index]?.data?.encoded_polyline || null,
        estimated_distance_km: finalDeliveryWriteBatch[index]?.data?.estimated_distance_km ?? null,
        estimated_duration_minutes: finalDeliveryWriteBatch[index]?.data?.estimated_duration_minutes ?? null,
        travel_dist: Number(directionsLegs[index]?.distance)
          ? Number((Number(directionsLegs[index].distance) / 1000).toFixed(3))
          : null
      }))
    });

  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn('⚠️ [optimizeRemainingStops] Deferred due to rate limit');
      return Response.json({
        success: false,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0,
        deferred: true,
        reason: 'rate_limited'
      });
    }

    console.error('❌ [optimizeRemainingStops] ERROR:', error.message);
    return Response.json({
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});