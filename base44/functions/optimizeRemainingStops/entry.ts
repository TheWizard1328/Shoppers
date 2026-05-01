// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const logApiUsage = async ({
  base44,
  appUserId,
  appUserName,
  provider,
  apiType,
  purpose,
  functionName,
  metadata = {},
  success,
  durationMs,
  errorMessage,
  callCount = 1,
}) => {
  if (!base44) return;

  await base44.asServiceRole.entities.GoogleAPILog.create({
    timestamp: new Date().toISOString(),
    api_type: apiType,
    purpose,
    function_name: functionName,
    user_id: appUserId || null,
    user_name: appUserName || null,
    metadata: {
      api_provider: provider,
      call_count: Number(callCount) || 1,
      success: success === true,
      duration_ms: durationMs,
      error_message: errorMessage || undefined,
      ...metadata,
    },
  }).catch((error) => {
    console.warn('[optimizeRemainingStops] Failed to persist API usage log:', error?.message || error);
  });
};

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
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

/**
 * Calculate crow-flies distance between two coordinates (Haversine formula)
 */
const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
};

const addRouteToHomePenalty = (routeStops, homePosition) => {
  if (!homePosition || !routeStops.length) return 0;
  const lastStop = routeStops[routeStops.length - 1];
  if (!lastStop) return 0;
  return calculateCrowFliesDistance(lastStop.lat, lastStop.lng, homePosition.lat, homePosition.lng);
};

/**
 * Parse time string (HH:mm) to minutes since midnight
 */
const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

/**
 * Format minutes since midnight to HH:mm string
 */
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


// ─── HERE Routing helpers (added to eliminate duplicate API call) ─────────────

const decodeHereFlexiblePolylineForRouting = (encoded) => {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const DEC = {};
  ALPHA.split('').forEach((c, i) => { DEC[c] = i; });
  const values = [];
  let cur = 0, shift = 0;
  for (const ch of encoded) {
    const v = DEC[ch];
    if (v == null) return [];
    cur |= (v & 0x1f) << shift;
    if (v & 0x20) { shift += 5; continue; }
    values.push(cur); cur = 0; shift = 0;
  }
  if (shift > 0 || values.length < 2 || values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDim = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dim = thirdDim ? 3 : 2;
  const toSigned = (n) => (n & 1) ? ~(n >> 1) : (n >> 1);
  let lat = 0, lng = 0;
  const coords = [];
  for (let i = 2; i < values.length; i += dim) {
    lat += toSigned(values[i]);
    lng += toSigned(values[i + 1]);
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
};

const encodeGooglePolylineLocal = (points) => {
  const encodeSigned = (value) => {
    let signed = value << 1;
    if (value < 0) signed = ~signed;
    let encoded = '';
    while (signed >= 0x20) {
      encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
      signed >>= 5;
    }
    encoded += String.fromCharCode(signed + 63);
    return encoded;
  };
  let lastLat = 0, lastLng = 0, result = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += encodeSigned(latE5 - lastLat);
    result += encodeSigned(lngE5 - lastLng);
    lastLat = latE5; lastLng = lngE5;
  }
  return result;
};

/**
 * Fetch per-segment polylines from HERE router API directly.
 * Uses polylineOrigin (last finished stop or home) as the visual start point,
 * NOT currentPosition (which is the optimization start point).
 * This means purgeAndRegeneratePolylines can reuse these and skip its own HERE call.
 */
const fetchRoutingPolylines = async (base44, user, driverAppUser, hereApiKey, transportMode, polylineOrigin, orderedStops, homeDestination) => {
  const allPoints = [polylineOrigin, ...orderedStops, ...(homeDestination ? [homeDestination] : [])];
  if (allPoints.length < 2) return [];

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', transportMode);
  params.set('return', 'polyline,summary');
  params.set('origin', `${allPoints[0].lat},${allPoints[0].lng}`);
  params.set('destination', `${allPoints[allPoints.length - 1].lat},${allPoints[allPoints.length - 1].lng}`);
  // Use append('via') — HERE router expects repeated 'via' params, NOT indexed keys like via[0]
  allPoints.slice(1, -1).forEach((pt) => {
    params.append('via', `${pt.lat},${pt.lng}`);
  });

  const startedAt = Date.now();
  try {
    console.log(`🗺️ [optimizeRemainingStops] fetchRoutingPolylines: origin=${polylineOrigin.lat},${polylineOrigin.lng} stops=${orderedStops.length} home=${!!homeDestination}`);
    const res = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      signal: AbortSignal.timeout(15000)
    });
    const routeData = await res.json().catch(() => null);
    const sections = routeData?.routes?.[0]?.sections ?? [];
    console.log(`✅ [optimizeRemainingStops] fetchRoutingPolylines: got ${sections.length} sections for ${orderedStops.length} stops`);

    await logApiUsage({
      base44,
      appUserId: driverAppUser?.id,
      appUserName: driverAppUser?.user_name || user?.full_name,
      provider: 'here',
      apiType: 'Directions (HERE)',
      purpose: 'Route optimization / polyline update',
      functionName: 'optimizeRemainingStops:fetchRoutingPolylines',
      success: res.ok,
      durationMs: Date.now() - startedAt,
      callCount: 1,
      metadata: {
        transport_mode: transportMode,
        stops_count: orderedStops.length,
        includes_home_destination: !!homeDestination,
        status_code: res.status
      }
    });

    return orderedStops.map((_stop, i) => {
      const section = sections[i] ?? null;
      if (!section) return { encodedPolyline: null, estimatedDistanceKm: null, estimatedDurationMinutes: null };
      const hereEncoded = section.polyline ?? '';
      let googleEncoded = null;
      if (hereEncoded) {
        const coords = decodeHereFlexiblePolylineForRouting(hereEncoded);
        if (coords.length >= 2) googleEncoded = encodeGooglePolylineLocal(coords);
      }
      const distanceM = section.summary?.length ?? 0;
      const durationS = section.summary?.duration ?? 0;
      return {
        encodedPolyline: googleEncoded,
        estimatedDistanceKm: distanceM > 0 ? Number((distanceM / 1000).toFixed(3)) : null,
        estimatedDurationMinutes: durationS > 0 ? Number((durationS / 60).toFixed(1)) : null,
      };
    });
  } catch (err) {
    await logApiUsage({
      base44,
      appUserId: driverAppUser?.id,
      appUserName: driverAppUser?.user_name || user?.full_name,
      provider: 'here',
      apiType: 'Directions (HERE)',
      purpose: 'Route optimization / polyline update',
      functionName: 'optimizeRemainingStops:fetchRoutingPolylines',
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: err?.message || 'Unknown error',
      callCount: 1,
      metadata: {
        transport_mode: transportMode,
        stops_count: orderedStops.length,
        includes_home_destination: !!homeDestination
      }
    });
    console.warn('[optimizeRemainingStops] fetchRoutingPolylines failed:', err?.message);
    return orderedStops.map(() => ({ encodedPolyline: null, estimatedDistanceKm: null, estimatedDurationMinutes: null }));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Optimize Remaining Stops - staged optimization for driver's route
 */
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
    const { driverId, deliveryDate, currentLocalTime, deviceTime, optimizationStartTime = null, skipCurrentTimeEtaChecks = false, preserveExistingOrder = false, forceFullRemainingRouteOptimization = false } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    // Parse current time
    const effectiveStartTime = optimizationStartTime || currentLocalTime;
    let currentMinutes;
    if (effectiveStartTime) {
      const [hours, minutes] = effectiveStartTime.split(':').map(Number);
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
    
    // Get driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];
    const bypassDriverStatus = body?.bypassDriverStatus === true;
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

    const appSettings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }, '-updated_date', 1);
    const activeApiKeyName = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
    const hereApiKey = activeApiKeyName.startsWith('HERE') || activeApiKeyName.startsWith('Here')
      ? Deno.env.get(activeApiKeyName)
      : Deno.env.get('HERE_API_KEY');

    if (!hereApiKey) {
      return Response.json({ error: `${activeApiKeyName} secret is not set` }, { status: 500 });
    }
    
    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }
    
    // Fetch all deliveries for the driver on this date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');
    
    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    console.log(`📦 [optimizeRemainingStops] Found ${allDeliveries.length} deliveries`);

    // Separate completed and incomplete deliveries
    const completedDeliveries = allDeliveries.filter(d => FINISHED_STATUSES.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !FINISHED_STATUSES.includes(d.status));
    const activeRouteDeliveries = incompleteDeliveries.filter((delivery) => ACTIVE_STATUSES.includes(delivery.status));
    const pendingRouteDeliveries = incompleteDeliveries.filter((delivery) => delivery.status === 'pending');
    const optimizableDeliveries = [...activeRouteDeliveries, ...pendingRouteDeliveries];
    const polylineEligibleDeliveries = [...activeRouteDeliveries];

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

    // Get patient and store data for coordinates
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

    // Build stops with coordinates
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

    // STEP 2: Determine origin for the incomplete section only
    let currentPosition;
    let locationSource;

    const explicitNextDelivery = incompleteDeliveries.find((delivery) => delivery?.isNextDelivery === true) || null;
    const explicitNextCoords = explicitNextDelivery ? getDeliveryCoords(explicitNextDelivery, patientMap, storeMap) : null;
    const previousStopBeforeNext = explicitNextDelivery
      ? allDeliveries
          .filter((delivery) => delivery?.id !== explicitNextDelivery.id)
          .filter((delivery) => Number(delivery?.stop_order || 0) < Number(explicitNextDelivery?.stop_order || 0))
          .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null
      : null;
    const previousStopCoords = previousStopBeforeNext ? getDeliveryCoords(previousStopBeforeNext, patientMap, storeMap) : null;
    const routeHasStarted = completedDeliveries.length > 0 || !!previousStopBeforeNext;
    const shouldLockExplicitNextStop = !!explicitNextDelivery && !forceFullRemainingRouteOptimization;

    if (previousStopCoords) {
      currentPosition = previousStopCoords;
      locationSource = 'previous_stop_before_next';
    }

    if (!currentPosition && routeHasStarted && latestFinishedDelivery) {
      currentPosition = getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap);
      locationSource = currentPosition ? 'last_finished_stop' : null;
    }

    if (!routeHasStarted && !currentPosition && explicitNextCoords) {
      currentPosition = explicitNextCoords;
      locationSource = 'next_delivery_stop';
    }

    if (!routeHasStarted && !currentPosition && driverAppUser.current_latitude != null && driverAppUser.current_longitude != null) {
      currentPosition = { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) };
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

    console.log(`📍 [optimizeRemainingStops] Starting from: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng})`);
    console.log(`🎯 [optimizeRemainingStops] Active next stop: ${explicitNextDelivery?.id || 'none'}`);
    console.log(`🏁 [optimizeRemainingStops] Home remains locked as final destination${driverAppUser.home_latitude != null && driverAppUser.home_longitude != null ? '' : ' (not set)'}`);

    // STEP 3: Let HERE sequence the full incomplete route in one call
    const optimizationStops = optimizableDeliveries
      .map((delivery) => stops.find((item) => item.delivery.id === delivery.id) || null)
      .filter(Boolean);

    const orderedOptimizationStops = preserveExistingOrder
      ? optimizationStops.slice().sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999))
      : optimizationStops;

    const nextDeliveryStop = orderedOptimizationStops.find((stop) => stop.delivery.isNextDelivery === true) || null;
    const lockedNextStop = !preserveExistingOrder && shouldLockExplicitNextStop && nextDeliveryStop ? nextDeliveryStop : null;
    const stopsToSequence = lockedNextStop
      ? orderedOptimizationStops.filter((stop) => stop.delivery.id !== lockedNextStop.delivery.id)
      : orderedOptimizationStops;

    console.log(`\n🎯 [optimizeRemainingStops] Optimizing remaining route: ${optimizationStops.length} stops`);

    let attemptedHereCalls = 0;
    let usedTimeWindows = true;
    let routeStops = lockedNextStop ? [lockedNextStop] : [];
    let directionsLegs = [];
    let segmentPolylines = [];
    let optimizedStopTransportModes = [];

    const resolvedHomePosition = driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;


    // polylineOrigin: where the VISUAL polyline starts from.
    // This is the stop BEFORE isNextDelivery (last finished stop), or home if no stops finished.
    // Different from currentPosition which is the optimization start point.
    const polylineOrigin = routeHasStarted
      ? (
          previousStopCoords
          ?? (latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap) : null)
          ?? currentPosition
        )
      : (
          resolvedHomePosition
          ?? currentPosition
        );

        const executeHereSequence = async (includeTimeWindows) => {
      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('departure', buildLocalIso(deliveryDate, effectiveStartTime || formatMinutesToTime(currentMinutes)));
      params.set('mode', `fastest;${hereTransportMode};traffic:disabled`);
      params.set('improveFor', 'time');
      params.set('start', `driverStart;${currentPosition.lat},${currentPosition.lng}`);
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

      let polylineData = null;
      if (response.ok && Array.isArray(data?.results) && data.results[0]) {
        const result = data.results[0];
        const orderedWaypoints = (Array.isArray(result?.waypoints) ? result.waypoints : [])
          .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
          .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
        const orderedStopsForPolyline = orderedWaypoints
          .map((waypoint) => stopsToSequence.find((item) => (item.delivery.stop_id || item.delivery.delivery_id || item.delivery.id) === waypoint.id) || null)
          .filter(Boolean);

        if (orderedStopsForPolyline.length > 0) {
          // Direct routing call using polylineOrigin (last finished stop or home).
          // This avoids invoking getHereDirections as a separate function (saves 1 HERE call
          // because purgeAndRegeneratePolylines will reuse these precomputed polylines).
          // Polyline generation happens after routeStops is fully ordered (see below).
          polylineData = null;
        }
      }

      return { response, data, includeTimeWindows, polylineData };
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
            const distKm = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, stop.lat, stop.lng);
            return { duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 };
          }
          const routeIndex = lockedNextStop ? index - 1 : index;
          const waypoint = orderedStops[routeIndex]?.waypoint;
          const leg = waypoint ? interconnectionByToWaypoint.get(waypoint.id) : null;
          return {
            duration: Number(leg?.time || 0),
            distance: Number(leg?.distance || 0)
          };
        });

        const sequencedStops = orderedStops.map((item) => item.stop);
        // segmentPolylines will be populated after routeStops is fully ordered (see below).
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

    // STEP 4: Calculate ETAs from the sequenced route
    const stageEtaMap = new Map();

    if (historicalRoute && routeStops.length > 0) {
      const firstStop = routeStops[0];
      let cumulativeTime = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.time_window_start || firstStop.delivery.delivery_time_start);
      if (!Number.isFinite(cumulativeTime)) {
        cumulativeTime = currentMinutes;
      }

      const firstStopEta = formatMinutesToTime(cumulativeTime);
      stageEtaMap.set(firstStop.delivery.id, firstStopEta);
      cumulativeTime += firstStop.delivery.extra_time || (firstStop.isPickup ? 15 : 5);
      console.log(`  ✅ [optimizeRemainingStops] ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${firstStopEta}`);

      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const travelSeconds = directionsLegs[i] ? directionsLegs[i].duration : 300;
        const travelMinutes = Math.ceil(travelSeconds / 60);
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
      let cumulativeTime = currentMinutes;

      for (let i = 0; i < routeStops.length; i++) {
        if (skipCurrentTimeEtaChecks && historicalRoute) {
          break;
        }
        const stop = routeStops[i];
        const travelSeconds = directionsLegs[i] ? directionsLegs[i].duration : 300;
        const travelMinutes = Math.ceil(travelSeconds / 60);
        cumulativeTime += travelMinutes;

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

    // ── Fetch all segment polylines in one call now that routeStops order is final ──────────
    // Route: polylineOrigin → stop[0] → stop[1] → ... → stop[N-1] → home
    // One HERE router call, N+1 sections, section[i] = leg INTO routeStops[i].
    if (routeStops.length > 0) {
      const perStopPolylines = await fetchRoutingPolylines(
        base44,
        user,
        driverAppUser,
        hereApiKey,
        hereTransportMode,
        polylineOrigin,
        routeStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        resolvedHomePosition
      );
      segmentPolylines = routeStops.map((stop, i) => ({
        deliveryId:              stop.delivery.id,
        encodedPolyline:         perStopPolylines[i]?.encodedPolyline         ?? null,
        estimatedDistanceKm:     perStopPolylines[i]?.estimatedDistanceKm     ?? null,
        estimatedDurationMinutes: perStopPolylines[i]?.estimatedDurationMinutes ?? null,
      }));
      console.log(`🗺️ [optimizeRemainingStops] Polylines fetched: ${segmentPolylines.filter((s) => !!s.encodedPolyline).length}/${routeStops.length} stops have polylines`);
    }
    // ──────────────────────────────────────────────────────────────────────────────────────────

    // STEP 8: Build one final delivery write batch and update once
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
      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder,
        delivery_time_eta: stop.delivery_time_eta,
        transport_mode: safeTransportMode,
        travel_dist: Number(directionsLegs[i]?.distance)
          ? Number((Number(directionsLegs[i].distance) / 1000).toFixed(3))
          : null,
        ...(segmentPolyline?.encodedPolyline ? {
          encoded_polyline: segmentPolyline.encodedPolyline,
          transport_mode: safeTransportMode,
          estimated_distance_km: typeof segmentPolyline.estimatedDistanceKm === 'number' ? segmentPolyline.estimatedDistanceKm : null,
          estimated_duration_minutes: typeof segmentPolyline.estimatedDurationMinutes === 'number' ? segmentPolyline.estimatedDurationMinutes : null
        } : {})
      };

      if (pendingStartTime) {
        updateData.delivery_time_start = pendingStartTime;
        stop.delivery_time_start = pendingStartTime;
      }

      stop.stop_order = newOrder;
      stop.display_stop_order = newOrder;

      finalDeliveryWriteBatch.push({
        id: stop.id,
        data: updateData,
        label: stop.patient_name || 'Pickup'
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

    const nextStopId = explicitNextDelivery?.id || activeStops[0]?.id || null;

    finalDeliveryWriteBatch.forEach(({ data, label }) => {
      console.log(`  🔢 [optimizeRemainingStops] Stop #${data.stop_order}: ${label}${data.delivery_time_start ? ` (start: ${data.delivery_time_start})` : ''}`);
    });

    // Tracking numbers are intentionally delayed until Assign All / Accept All.

    const shouldRefreshPolylines = activeStops.length > 0;

    // Skip purgeAndRegeneratePolylines if ALL active stops already have polylines
    // (they were written directly to the DB in finalDeliveryWriteBatch above).
    const stopsWithPolylines = segmentPolylines.filter((s) => !!s.encodedPolyline).length;
    const allStopsHavePolylines = stopsWithPolylines === activeStops.length;
    if (allStopsHavePolylines) {
      console.log(`🗺️ [optimizeRemainingStops] All ${activeStops.length} stops have polylines from fetchRoutingPolylines — skipping purgeAndRegeneratePolylines entirely ✅`);
    }

    if (shouldRefreshPolylines && !allStopsHavePolylines) {
      console.log(`🗺️ [optimizeRemainingStops] ${activeStops.length - stopsWithPolylines} stops missing polylines — calling purgeAndRegeneratePolylines for remaining`);
      await base44.asServiceRole.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate,
        scope: 'active_only',
        reason: routeOrderChanged ? 'route_reordered' : 'manual',
        sourcePage: 'Dashboard',
        bypassDriverStatus: true,
        routeStopOrder: activeStops.map((stop) => stop.id),
        orderedStopsWithTransportMode: optimizedStopTransportModes,
        explicitOrderedStopsOnly: true,
        explicitRouteOrigin: previousStopCoords ? 'previous_stop_before_next' : routeHasStarted ? 'last_finished_stop' : 'home',
        explicitRouteDestination: 'home',
        resolvedOriginCoords: polylineOrigin ? { lat: polylineOrigin.lat, lon: polylineOrigin.lng } : null,
        bypassPolylineUpdated: true,
        bypassPolylineDelete: true,
        reuseProvidedPolylines: segmentPolylines.some((s) => !!s.encodedPolyline),
        precomputedSegmentPolylines: segmentPolylines
          .filter((s) => !!s.encodedPolyline)
          .map((s) => ({
            deliveryId:                s.deliveryId,
            encoded_polyline:          s.encodedPolyline,
            estimated_distance_km:     s.estimatedDistanceKm      ?? null,
            estimated_duration_minutes: s.estimatedDurationMinutes ?? null,
          })),
      }).catch((error) => {
        console.warn('⚠️ [optimizeRemainingStops] Polyline refresh failed:', error?.message || error);
        return null;
      });
      console.log(`🗺️ [optimizeRemainingStops] Active route polyline refresh requested (${routeOrderChanged ? 'reordered' : 'same-order'})`);
    }

    // HERE usage is logged inside getHereDirections so dashboard counts stay aligned to real HTTP calls.

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
      optimizedRoute: activeStops.map((stop, index) => ({
        deliveryId: stop.id,
        newETA: stop.delivery_time_eta,
        stop_order: startingOrder + index + 1,
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