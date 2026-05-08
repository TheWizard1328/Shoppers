// Redeployed on 2026-05-07
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
const AUTOMATION_DEDUPE_WINDOW_MS = 10000;
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

// Call HERE Routing API for a single segment: origin -> destination
// Returns { durationMinutes, distanceKm } or null on failure
const getHereSegmentDuration = async (origin, destination, hereApiKey, hereTransportMode) => {
  if (!origin || !destination) return null;
  try {
    const params = new URLSearchParams({
      transportMode: hereTransportMode === 'bicycle' ? 'bicycle' : hereTransportMode === 'pedestrian' ? 'pedestrian' : 'car',
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      return: 'summary',
      apiKey: hereApiKey
    });
    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const summary = data?.routes?.[0]?.sections?.[0]?.summary;
    if (!summary) return null;
    return {
      durationMinutes: Math.ceil(Number(summary.duration || 0) / 60),
      distanceKm: Number((Number(summary.length || 0) / 1000).toFixed(3))
    };
  } catch {
    return null;
  }
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

    console.log(`🔄 [optimizeRemainingStops] Optimizing remaining stops for driver ${driverId} on ${deliveryDate}`);

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
    if (!bypassDriverStatus && (driverAppUser.driver_status === 'off_duty' || driverAppUser.driver_status === 'on_break')) {
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
    const hereTransportMode = preferredTravelMode === 'cycling'
      ? 'bicycle'
      : preferredTravelMode === 'pedestrian'
        ? 'pedestrian'
        : 'car';

    const hereApiKey = Deno.env.get('HERE_API_KEY');
    if (!hereApiKey) {
      return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
    }

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

    // --- Logical segment origin for isNextDelivery stop ---
    // estimated_duration_minutes / estimated_distance_km for the isNextDelivery stop must
    // reflect the segment from the previous finished stop (or home), NOT the driver's live GPS.
    // ETA is still calculated from driver's live GPS + current time.
    const logicalSegmentOrigin = latestFinishedCoords
      || (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
        ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
        : null)
      || currentPosition;

    console.log(`📍 [optimizeRemainingStops] Starting from: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng})`);
    console.log(`📐 [optimizeRemainingStops] Logical segment origin (for estimated_duration/distance of isNextDelivery): (${logicalSegmentOrigin?.lat}, ${logicalSegmentOrigin?.lng})`);
    console.log(`🎯 [optimizeRemainingStops] Active next stop: ${explicitNextDelivery?.id || 'none'}`);
    console.log(`🏁 [optimizeRemainingStops] Home remains locked as final destination${driverAppUser.home_latitude != null && driverAppUser.home_longitude != null ? '' : ' (not set)'}`);

    const optimizationStops = optimizableDeliveries
      .map((delivery) => stops.find((item) => item.delivery.id === delivery.id) || null)
      .filter(Boolean);

    const orderedOptimizationStops = preserveExistingOrder
      ? optimizationStops.slice().sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999))
      : optimizationStops;

    const nextDeliveryStop = orderedOptimizationStops.find((stop) => stop.delivery.isNextDelivery === true) || null;
    const lockedNextStop = !preserveExistingOrder && shouldLockExplicitNextStop && nextDeliveryStop ? nextDeliveryStop : null;
    const routeOriginStop = lockedNextStop || null;
    const stopsToSequence = routeOriginStop
      ? orderedOptimizationStops.filter((stop) => stop.delivery.id !== routeOriginStop.delivery.id)
      : orderedOptimizationStops;

    console.log(`\n🎯 [optimizeRemainingStops] Optimizing remaining route: ${optimizationStops.length} stops`);

    let attemptedHereCalls = 0;
    let usedTimeWindows = true;
    let routeStops = routeOriginStop ? [routeOriginStop] : [];
    let directionsLegs = [];
    let segmentPolylines = [];
    let optimizedStopTransportModes = [];

    const resolvedHomePosition = driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    // For the isNextDelivery stop: separately calculate segment from logical origin
    // (previous finished stop or home) to the isNextDelivery stop coords
    let nextStopLogicalSegment = null; // { durationMinutes, distanceKm }
    if (lockedNextStop && logicalSegmentOrigin && explicitNextCoords) {
      const samePoint = Math.abs(logicalSegmentOrigin.lat - currentPosition.lat) < 0.0001 &&
                        Math.abs(logicalSegmentOrigin.lng - currentPosition.lng) < 0.0001;
      if (!samePoint) {
        // logicalSegmentOrigin differs from live GPS — fetch the logical segment
        nextStopLogicalSegment = await getHereSegmentDuration(
          logicalSegmentOrigin,
          explicitNextCoords,
          hereApiKey,
          hereTransportMode
        );
        attemptedHereCalls += 1;
        if (nextStopLogicalSegment) {
          console.log(`📐 [optimizeRemainingStops] Logical segment for isNextDelivery: ${nextStopLogicalSegment.durationMinutes} min, ${nextStopLogicalSegment.distanceKm} km`);
        }
      } else {
        console.log(`📐 [optimizeRemainingStops] Logical origin == live GPS — skipping separate logical segment call`);
      }
    }

    const executeHereSequence = async (includeTimeWindows) => {
      const sequenceStart = routeOriginStop
        ? { lat: routeOriginStop.lat, lng: routeOriginStop.lng }
        : currentPosition;

      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('departure', buildLocalIso(deliveryDate, currentLocalTime || formatMinutesToTime(currentMinutes)));
      params.set('mode', `fastest;${hereTransportMode};traffic:disabled`);
      params.set('improveFor', 'time');
      params.set('start', `driverStart;${sequenceStart.lat},${sequenceStart.lng}`);
      if (resolvedHomePosition) {
        params.set('end', `driverHome;${resolvedHomePosition.lat},${resolvedHomePosition.lng}`);
      }

      stopsToSequence.forEach((stop, index) => {
        const segments = [`${stop.delivery.stop_id || stop.delivery.delivery_id || stop.delivery.id};${stop.lat},${stop.lng}`];
        if (includeTimeWindows) {
          const accessConstraint = buildAccessConstraint(deliveryDate, stop.windowStart, stop.windowEnd);
          if (accessConstraint) segments.push(accessConstraint);
        }
        segments.push(`st:${Math.round((stop.delivery.extra_time || (stop.isPickup ? 15 : 5)) * 60)}`);
        params.set(`destination${index + 1}`, segments.join(';'));
      });

      attemptedHereCalls += 1;
      const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
        signal: AbortSignal.timeout(20000)
      });
      const data = await response.json().catch(() => null);

      return { response, data, includeTimeWindows, polylineData: null };
    };

    if (preserveExistingOrder) {
      routeStops = [...orderedOptimizationStops];
      let prevPos = currentPosition;
      for (const stop of routeStops) {
        const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
        directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
        prevPos = { lat: stop.lat, lng: stop.lng };
      }
      console.log('✅ [optimizeRemainingStops] Preserving existing order and refreshing ETAs only');
    } else if (stopsToSequence.length > 0) {
      let hereAttempt = await executeHereSequence(true);
      let result = Array.isArray(hereAttempt.data?.results) ? hereAttempt.data.results[0] : null;
      let waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      let interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

      if ((!hereAttempt.response.ok || !result || waypoints.length === 0) && hereAttempt.includeTimeWindows) {
        hereAttempt = await executeHereSequence(false);
        usedTimeWindows = false;
        result = Array.isArray(hereAttempt.data?.results) ? hereAttempt.data.results[0] : null;
        waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
        interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
      }

      if (!hereAttempt.response.ok || !result || waypoints.length === 0) {
        console.log('⚠️ [optimizeRemainingStops] HERE sequencing failed - using crow-flies fallback');
        routeStops = [...routeStops, ...stopsToSequence].sort((a, b) => {
          const distA = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, a.lat, a.lng);
          const distB = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, b.lat, b.lng);
          const homePenaltyA = resolvedHomePosition ? calculateCrowFliesDistance(a.lat, a.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
          const homePenaltyB = resolvedHomePosition ? calculateCrowFliesDistance(b.lat, b.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
          return (distA - homePenaltyA * 0.15) - (distB - homePenaltyB * 0.15);
        });
        let prevPos = currentPosition;
        for (const stop of routeStops) {
          const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
          directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
          prevPos = { lat: stop.lat, lng: stop.lng };
        }
      } else {
        const orderedStops = waypoints
          .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
          .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
          .map((waypoint, index) => ({ stop: stopsToSequence[index] && stopsToSequence.find((item) => (item.delivery.stop_id || item.delivery.delivery_id || item.delivery.id) === waypoint.id) || null, waypoint }))
          .filter((item) => item.stop);

        routeStops = [...routeStops, ...orderedStops.map((item) => item.stop)];
        const interconnectionByToWaypoint = new Map(interconnections.map((item) => [item.toWaypoint, item]));
        directionsLegs = routeStops.map((stop, index) => {
          if (index === 0) {
            // index 0 is the locked isNextDelivery stop — use driver's live GPS distance for ETA calc leg
            const distKm = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, stop.lat, stop.lng);
            return { duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 };
          }
          const routeIndex = index - 1;
          const waypoint = orderedStops[routeIndex]?.waypoint;
          const leg = waypoint ? interconnectionByToWaypoint.get(waypoint.id) : null;
          return {
            duration: Number(leg?.time || 0),
            distance: Number(leg?.distance || 0)
          };
        });

        const polylineSegments = Array.isArray(hereAttempt?.polylineData?.polylines)
          ? hereAttempt.polylineData.polylines
          : [];
        segmentPolylines = routeStops.map((stop, index) => {
          const previousStop = index === 0 ? null : routeStops[index - 1];
          const origin = index === 0
            ? currentPosition
            : previousStop
              ? { lat: previousStop.lat, lng: previousStop.lng }
              : null;
          const destination = { lat: stop.lat, lng: stop.lng };
          const matchedSegment = polylineSegments[index] || null;
          return {
            deliveryId: stop.delivery.id,
            origin,
            destination,
            encodedPolyline: matchedSegment?.encodedPolyline || null,
            estimatedDistanceKm: matchedSegment?.estimated_distance_km ?? null,
            estimatedDurationMinutes: matchedSegment?.estimated_duration_minutes ?? null
          };
        });
        optimizedStopTransportModes = routeStops.map((stop, index) => {
          const resolvedTransportMode = String(stop?.delivery?.transport_mode || preferredTravelMode || 'driving').toLowerCase();
          const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(resolvedTransportMode) ? resolvedTransportMode : 'driving';
          return {
            deliveryId: stop.delivery.id,
            transport_mode: safeTransportMode,
            finished_leg_transport_mode: safeTransportMode,
            encoded_polyline: segmentPolylines[index]?.encodedPolyline || null,
            estimated_distance_km: typeof segmentPolylines[index]?.estimatedDistanceKm === 'number' ? segmentPolylines[index].estimatedDistanceKm : null,
            estimated_duration_minutes: typeof segmentPolylines[index]?.estimatedDurationMinutes === 'number' ? segmentPolylines[index].estimatedDurationMinutes : null
          };
        });
        console.log(`✅ [optimizeRemainingStops] HERE sequencing success${usedTimeWindows ? ' with time windows' : ' without time windows'}`);
      }
    }

    const stageEtaMap = new Map();
    const segmentPolylineByDeliveryId = new Map(segmentPolylines.map((segment) => [segment.deliveryId, segment]));

    if (historicalRoute && routeStops.length > 0) {
      const firstStop = routeStops[0];
      let cumulativeTime = currentMinutes;
      const firstStopWindowStart = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.time_window_start || firstStop.delivery.delivery_time_start);
      if (Number.isFinite(firstStopWindowStart) && cumulativeTime < firstStopWindowStart) {
        cumulativeTime = firstStopWindowStart;
      }

      const firstStopEta = formatMinutesToTime(cumulativeTime);
      stageEtaMap.set(firstStop.delivery.id, firstStopEta);
      cumulativeTime += firstStop.delivery.extra_time || (firstStop.isPickup ? 15 : 5);
      console.log(`  ✅ [optimizeRemainingStops] ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${firstStopEta}`);

      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
        const travelMinutes = getLegTravelMinutes({
          stop,
          leg: directionsLegs[i],
          segmentPolyline
        });
        cumulativeTime += travelMinutes;

        const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery.time_window_start || stop.delivery.delivery_time_start);
        if (Number.isFinite(windowStart) && cumulativeTime < windowStart) {
          cumulativeTime = windowStart;
        }

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);

        console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}`);
      }
    } else {
      // ETA calculation uses driver's live position (currentPosition) for the first leg
      // so directionsLegs[0] already reflects driver GPS -> isNextDelivery stop travel time
      let cumulativeTime = currentMinutes;

      for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
        const isLockedStartedStop = i === 0 && !!lockedNextStop;
        if (!isLockedStartedStop) {
          const travelMinutes = getLegTravelMinutes({
            stop,
            leg: directionsLegs[i],
            segmentPolyline
          });
          cumulativeTime += travelMinutes;
        }

        const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery.time_window_start);
        if (Number.isFinite(windowStart) && cumulativeTime < windowStart) {
          cumulativeTime = windowStart;
        }

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);

        console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}`);
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
    const nextStopId = explicitNextDelivery?.id || activeStops[0]?.id || null;

    const resolvePendingStartTime = (stop) => {
      if (stop.status !== 'pending') return undefined;

      if (!stop.patient_id) {
        return stop.delivery_time_start || stop.delivery_time_eta;
      }

      if (!stop.puid) return undefined;

      const pickup = activeStops.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid)
        || allDeliveries.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid);

      if (!pickup) return undefined;

      const pickupState = finalizedById.get(pickup.id) || pickup;
      const pickupETA = pickupState.delivery_time_eta;
      const pickupStartTime = pickupState.delivery_time_start;

      let baseMinutes = parseTimeToMinutes(pickupETA);
      if (!Number.isFinite(baseMinutes)) {
        baseMinutes = parseTimeToMinutes(pickupStartTime);
      }

      if (!Number.isFinite(baseMinutes)) return undefined;
      return formatMinutesToTime(baseMinutes + 5);
    };

    for (let i = 0; i < activeStops.length; i++) {
      const stop = activeStops[i];
      const newOrder = preserveExistingOrder ? Number(stop.stop_order || i + 1) : startingOrder + i + 1;
      const pendingStartTime = resolvePendingStartTime(stop);
      const segmentPolyline = segmentPolylines.find((segment) => segment.deliveryId === stop.id) || null;
      const resolvedTransportMode = String(stop?.transport_mode || preferredTravelMode || 'driving').toLowerCase();
      const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(resolvedTransportMode) ? resolvedTransportMode : 'driving';

      // For the isNextDelivery stop (i === 0 and lockedNextStop exists):
      // - delivery_time_eta: already based on driver's live GPS (currentMinutes = now, directionsLegs[0] from GPS)
      // - estimated_duration_minutes / estimated_distance_km: use logical segment (prev finished stop -> isNextDelivery)
      const isNextStop = stop.id === nextStopId && i === 0 && !!lockedNextStop;
      const logicalDurationMinutes = isNextStop && nextStopLogicalSegment
        ? nextStopLogicalSegment.durationMinutes
        : (typeof segmentPolyline?.estimatedDurationMinutes === 'number' ? segmentPolyline.estimatedDurationMinutes : null);
      const logicalDistanceKm = isNextStop && nextStopLogicalSegment
        ? nextStopLogicalSegment.distanceKm
        : (typeof segmentPolyline?.estimatedDistanceKm === 'number' ? segmentPolyline.estimatedDistanceKm : null);

      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder,
        delivery_time_eta: stop.delivery_time_eta,
        isNextDelivery: stop.id === nextStopId,
        transport_mode: safeTransportMode,
        travel_dist: Number(directionsLegs[i]?.distance)
          ? Number((Number(directionsLegs[i].distance) / 1000).toFixed(3))
          : null,
        ...(logicalDurationMinutes != null ? { estimated_duration_minutes: logicalDurationMinutes } : {}),
        ...(logicalDistanceKm != null ? { estimated_distance_km: logicalDistanceKm } : {}),
        ...(segmentPolyline?.encodedPolyline ? {
          encoded_polyline: segmentPolyline.encodedPolyline,
          transport_mode: safeTransportMode
        } : {})
      };

      if (pendingStartTime) {
        updateData.delivery_time_start = pendingStartTime;
        stop.delivery_time_start = pendingStartTime;
      }

      stop.stop_order = newOrder;
      stop.display_stop_order = newOrder;
      stop.isNextDelivery = stop.id === nextStopId;

      finalDeliveryWriteBatch.push({
        id: stop.id,
        data: updateData,
        label: stop.patient_name || 'Pickup',
        isNextStop
      });
    }

    await Promise.all(
      finalDeliveryWriteBatch.map(({ id, data }) =>
        base44.asServiceRole.entities.Delivery.update(id, data).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        })
      )
    );

    finalDeliveryWriteBatch.forEach(({ data, label, isNextStop }) => {
      console.log(`  🔢 [optimizeRemainingStops] Stop #${data.stop_order}: ${label}${isNextStop ? ' [isNextDelivery - logical segment used for estimated_duration/distance]' : ''}${data.delivery_time_start ? ` (start: ${data.delivery_time_start})` : ''}`);
    });

    const shouldRefreshPolylines = activeStops.length > 0;

    if (shouldRefreshPolylines) {
      console.log(`🗺️ [optimizeRemainingStops] Polyline refresh deferred to caller (${routeOrderChanged ? 'reordered' : 'same-order'})`);
    }

    console.log(`\n✅ [optimizeRemainingStops] Route optimization complete - ${activeStops.length} stops updated in one final batch, ${attemptedHereCalls} API calls`);

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
        encoded_polyline: segmentPolylines[index]?.encodedPolyline || null,
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