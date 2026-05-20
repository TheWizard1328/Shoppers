// Redeployed on 2026-05-20 - ETA anchoring fix: real-time first-leg + last-finished-stop anchor
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
const AUTOMATION_DEDUPE_WINDOW_MS = 60000;
const LAST_FINISHED_STOP_PROXIMITY_KM = 0.25;
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

// Geocode a patient address using Google Places API directly (no function invocation needed)
const geocodePatientAddress = async (patient) => {
  if (!patient?.address) return null;
  
  try {
    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      console.warn('[geocodePatientAddress] GOOGLE_MAPS_API_KEY not set');
      return null;
    }

    // Step 1: Autocomplete to get place_id
    const autocompleteUrl = 'https://places.googleapis.com/v1/places:autocomplete';
    const autocompleteResp = await fetch(autocompleteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId'
      },
      body: JSON.stringify({ input: patient.address, languageCode: 'en', includedRegionCodes: ['CA'] })
    });

    if (!autocompleteResp.ok) return null;
    const autocompleteData = await autocompleteResp.json();
    const placeId = autocompleteData?.suggestions?.[0]?.placePrediction?.placeId;
    if (!placeId) {
      console.warn(`[geocodePatientAddress] No place_id for: ${patient.address}`);
      return null;
    }

    // Step 2: Get place details with coordinates
    const detailsUrl = `https://places.googleapis.com/v1/places/${placeId}?fields=location&key=${apiKey}`;
    const detailsResp = await fetch(detailsUrl, {
      headers: { 'X-Goog-FieldMask': 'location' }
    });

    if (!detailsResp.ok) return null;
    const detailsData = await detailsResp.json();

    if (detailsData?.location?.latitude && detailsData?.location?.longitude) {
      return {
        latitude: detailsData.location.latitude,
        longitude: detailsData.location.longitude
      };
    }

    return null;
  } catch (error) {
    console.warn(`[geocodePatientAddress] Failed to geocode ${patient.address}:`, error?.message);
    return null;
  }
};

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
  // Cycling start markers store their location in dedicated fields
  if (delivery.is_cycling_start_marker && delivery.cycling_start_latitude != null && delivery.cycling_start_longitude != null) {
    return { lat: Number(delivery.cycling_start_latitude), lng: Number(delivery.cycling_start_longitude) };
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

// Parse the time portion from an actual_delivery_time timestamp (YYYY-MM-DDTHH:MM:SS)
const parseActualDeliveryTime = (actualTimeStr) => {
  if (!actualTimeStr) return null;
  const timePart = String(actualTimeStr).split('T')[1];
  if (!timePart) return null;
  return parseTimeToMinutes(timePart.substring(0, 5));
};

// Get the store's scheduled time window for a pickup based on delivery date day-of-week and AM/PM slot
const getStorePickupWindow = (store, deliveryDate, ampm) => {
  if (!store || !deliveryDate) return { start: null, end: null };
  const d = new Date(deliveryDate + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon...6=Sat
  const slot = String(ampm || '').toUpperCase() === 'AM' ? 'am' : 'pm';
  let prefix;
  if (dow === 0) prefix = `sunday_${slot}`;
  else if (dow === 6) prefix = `saturday_${slot}`;
  else prefix = `weekday_${slot}`;
  const enabled = store[`${prefix}_enabled`];
  if (!enabled) return { start: null, end: null };
  return {
    start: store[`${prefix}_start`] || null,
    end: store[`${prefix}_end`] || null,
  };
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
      bypassDeduplication: body.bypassDeduplication === true,
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
    bypassDeduplication: body.bypassDeduplication === true,
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
  // CRITICAL: When a delivery transitions FROM active → finished (completed/failed/cancelled/returned),
  // we must NOT re-optimize — the route is contracting, not changing order. Skip entirely.
  const deactivatedFromRoute = changedFields.includes('status')
    && FINISHED_STATUSES.includes(String(data?.status || ''))
    && ACTIVE_STATUSES.includes(String(oldData?.status || ''));

  // If the only trigger is a completion/failure/cancel, skip — no HERE calls needed.
  if (deactivatedFromRoute) return true;

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

// Check if a stop's time window is still valid (not completely expired)
const isWindowExpired = (stop, currentMinutes) => {
  const windowEnd = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end || stop.delivery?.time_window_end);
  if (!Number.isFinite(windowEnd)) return false; // No end time = always valid
  return windowEnd <= currentMinutes; // Window expired if end time has passed
};

// Check if arrival at a given time violates the stop's time window (strictly enforced for non-expired windows)
const violatesTimeWindow = (stop, arrivalMinutes, currentMinutes) => {
  // If window has expired, ignore it
  if (isWindowExpired(stop, currentMinutes)) {
    return false;
  }
  
  const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start || stop.delivery?.time_window_start);
  const windowEnd = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end || stop.delivery?.time_window_end);
  
  // Strict enforcement: arrival must be within [start, end] window
  if (Number.isFinite(windowStart) && arrivalMinutes < windowStart) {
    return true; // Arriving before window opens
  }
  if (Number.isFinite(windowEnd) && arrivalMinutes > windowEnd) {
    return true; // Arriving after window closes
  }
  
  return false;
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
      bypassDeduplication = false,
      triggerSource = 'manual'
    } = context;

    const firstStopId = body?.firstStopId || null;
    // When a stop is explicitly added/removed from a route (retry, return, restart),
    // the caller sets bypassHistoricalCheck=true so optimization runs even on past dates.
    const bypassHistoricalCheck = body?.bypassHistoricalCheck === true;

    if (!driverId || !deliveryDate) {
      return Response.json({
        error: 'Missing required parameters: driverId, deliveryDate'
      }, { status: 400 });
    }

    if (shouldSkipAutomationEvent(context)) {
      const { eventType, data, changedFields } = context;
      const isTerminalTransition = changedFields?.includes?.('status') && ['completed', 'failed', 'cancelled', 'returned'].includes(String(data?.status || ''));
      console.log(`⏭️ [optimizeRemainingStops] Skipping non-optimization event — type=${eventType}, terminal=${isTerminalTransition}, driver=${driverId}, date=${deliveryDate}`);
      return Response.json({
        success: true,
        skipped: true,
        reason: isTerminalTransition ? 'terminal_status_transition' : 'non_optimization_event',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    // CRITICAL: When triggered by an entity automation, the trigger delivery data is available.
    // If the triggered delivery is in a finished state (completed/failed/cancelled/returned),
    // always skip — stop order doesn't change on terminal transitions so no optimization needed.
    const FINISHED_STATUSES_SET = new Set(['completed', 'failed', 'cancelled', 'returned']);
    if (context?.eventType === 'update' && FINISHED_STATUSES_SET.has(String(context?.data?.status || ''))) {
      console.log(`⏭️ [optimizeRemainingStops] Skipping — triggered by terminal status (${context.data.status}) | driver=${driverId} | date=${deliveryDate}`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'terminal_status_trigger',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }

    // CRITICAL: _stampDedupeOnly = true means the caller just wants to pre-lock the dedupe key
    // to suppress any automation-triggered calls from individual delivery saves in the same batch.
    // Write the key and return immediately — no HERE API calls made.
    const stampDedupeOnly = body?._stampDedupeOnly === true;

    const dedupeKey = dedupeKeyFor(driverId, deliveryDate);

    // -- Optimistic-lock deduplication -------------------------------------------
    const dedupeCheck = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: dedupeKey }, '-updated_date', 1);
    const dedupeRecord = dedupeCheck?.[0] || null;
    const lastRunAt = dedupeRecord?.setting_value?.last_run_at ? new Date(dedupeRecord.setting_value.last_run_at).getTime() : 0;

    if (!bypassDeduplication && lastRunAt && Date.now() - lastRunAt < AUTOMATION_DEDUPE_WINDOW_MS) {
      console.log(`⏭️ [optimizeRemainingStops] Skipping - deduped (ran ${Math.round((Date.now() - lastRunAt) / 1000)}s ago) | driver=${driverId} | date=${deliveryDate}`);
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

    // Write the lock IMMEDIATELY before any HERE work begins.
    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lockPayload = {
      last_run_at: new Date().toISOString(),
      lock_id: lockId,
      trigger_source: stampDedupeOnly ? 'batch_dedupe_stamp' : triggerSource
    };
    if (dedupeRecord?.id) {
      await base44.asServiceRole.entities.AppSettings.update(dedupeRecord.id, {
        setting_value: { ...(dedupeRecord.setting_value || {}), ...lockPayload }
      });
    } else {
      await base44.asServiceRole.entities.AppSettings.create({
        setting_key: dedupeKey,
        description: 'Recent optimizeRemainingStops execution lock',
        setting_value: lockPayload
      });
    }

    // If NOT a bypassed call, verify we own the lock (optimistic lock check).
    if (!bypassDeduplication) {
      await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 100)));
      const recheckRows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: dedupeKey }, '-updated_date', 1);
      const recheckRecord = recheckRows?.[0] || null;
      const winner = recheckRecord?.setting_value?.lock_id;
      if (winner && winner !== lockId) {
        console.log(`⏭️ [optimizeRemainingStops] Lost optimistic lock (winner=${winner}, ours=${lockId}) - skipping duplicate | driver=${driverId} | date=${deliveryDate}`);
        return Response.json({
          success: true,
          skipped: true,
          reason: 'deduped_optimistic_lock',
          triggerSource,
          routeChanged: false,
          optimizedCount: 0,
          apiCallsMade: 0
        });
      }
    }

    // Early exit after stamping dedupe key — no HERE calls needed
    if (stampDedupeOnly) {
      console.log(`🔒 [optimizeRemainingStops] Dedupe key stamped for batch pipeline (${driverId}/${deliveryDate}) — returning early`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'dedupe_stamp_only',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
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

    // CRITICAL: Skip HERE API for past dates UNLESS this is an explicit add/remove stop action.
    if (isHistoricalRouteDate(deliveryDate) && !bypassHistoricalCheck) {
      console.log(`⏭️ [optimizeRemainingStops] Skipping — historical date (${deliveryDate}), no HERE calls needed`);
      return Response.json({
        success: true,
        skipped: true,
        reason: 'historical_date',
        triggerSource,
        routeChanged: false,
        optimizedCount: 0,
        apiCallsMade: 0
      });
    }
    if (bypassHistoricalCheck && isHistoricalRouteDate(deliveryDate)) {
      console.log(`🔓 [optimizeRemainingStops] bypassHistoricalCheck=true — running optimization on historical date (${deliveryDate}) due to stop add/remove`);
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

    // CRITICAL: For historical routes with bypassHistoricalCheck (new route creation / Accept All on retro date),
    // if there are no active stops treat all pending stops as optimizable — same as a future/new route.
    const isRetroNewRoute = bypassHistoricalCheck && isHistoricalRouteDate(deliveryDate) && activeRouteDeliveries.length === 0 && pendingRouteDeliveries.length > 0;
    const optimizableDeliveries = isRetroNewRoute ? pendingRouteDeliveries : activeRouteDeliveries;
    if (isRetroNewRoute) {
      console.log(`🕰️ [optimizeRemainingStops] Retro new-route detected — promoting ${pendingRouteDeliveries.length} pending stops to optimizable (full HERE sequencing + ETA)`);
    }

    if (optimizableDeliveries.length === 0 && pendingRouteDeliveries.length === 0) {
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

    // Track skipped stops and attempt geocoding for missing coordinates
    const skippedStops = [];
    const geocodedPatientIds = new Set();

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
      const isPickup = !delivery.patient_id;

      // Priority: delivery fields → store slot (pickups only) → patient window (deliveries only)
      let windowStart = delivery.delivery_time_start || null;
      let windowEnd = delivery.delivery_time_end || null;
      if (!windowStart && !windowEnd) {
        if (isPickup && delivery.store_id) {
          const store = storeMap.get(delivery.store_id);
          const storeWindow = getStorePickupWindow(store, deliveryDate, delivery.ampm_deliveries);
          windowStart = storeWindow.start;
          windowEnd = storeWindow.end;
        } else if (patient) {
          windowStart = patient.time_window_start || null;
          windowEnd = patient.time_window_end || null;
        }
      }

      if (delivery.patient_id && delivery.puid && pickupWindowByStopId.has(delivery.puid)) {
        const pickupWindow = pickupWindowByStopId.get(delivery.puid);
        const pickupStartMinutes = parseTimeToMinutes(pickupWindow?.start);
        const deliveryStartMinutes = parseTimeToMinutes(windowStart);
        if (Number.isFinite(pickupStartMinutes) && (!Number.isFinite(deliveryStartMinutes) || deliveryStartMinutes < pickupStartMinutes)) {
          windowStart = formatMinutesToTime(pickupStartMinutes + 5);
        }
      }

      const stop = {
        delivery,
        lat: coords?.lat,
        lng: coords?.lng,
        isPickup,
        windowStart,
        windowEnd,
        hasLateWindow: isLateWindowStop(windowStart, currentMinutes),
        timeMinutes: parseTimeToMinutes(windowStart || delivery.delivery_time_start)
      };

      // Mark window expiration status
      stop.windowExpired = isWindowExpired(stop, currentMinutes);

      return stop;
    });

     console.log(`📋 [optimizeRemainingStops] Coordinate check for ${optimizableDeliveries.length} active deliveries:`);
     
     // Process stops with geocoding for missing coordinates
     const enhancedStops = [];
     for (const stop of stops) {
       const delivery = stop.delivery;
       let coords = getDeliveryCoords(delivery, patientMap, storeMap);
       const hasCoords = Number.isFinite(coords?.lat) && Number.isFinite(coords?.lng);
       
       // Attempt geocoding if coordinates are missing and patient has address
       if (!hasCoords && delivery.patient_id && !geocodedPatientIds.has(delivery.patient_id)) {
         const patient = patientMap.get(delivery.patient_id);
         if (patient?.address && (patient.latitude == null || patient.longitude == null)) {
           console.log(`   🌍 [optimizeRemainingStops] Attempting geocoding for ${delivery.patient_name || 'Patient'} (${patient.address})`);
           const geocodedCoords = await geocodePatientAddress(patient);
           
           if (geocodedCoords) {
             // Update patient record with new coordinates
             try {
               await base44.asServiceRole.entities.Patient.update(patient.id, {
                 latitude: geocodedCoords.latitude,
                 longitude: geocodedCoords.longitude
               });
               console.log(`   ✅ [optimizeRemainingStops] Geocoded and saved: ${patient.address} -> (${geocodedCoords.latitude}, ${geocodedCoords.longitude})`);
               
               // Update patientMap and coords
               patientMap.set(patient.id, { ...patient, latitude: geocodedCoords.latitude, longitude: geocodedCoords.longitude });
               coords = geocodedCoords;
               geocodedPatientIds.add(patient.id);
               
               enhancedStops.push({ ...stop, lat: coords.lat, lng: coords.lng });
               continue;
             } catch (error) {
               console.warn(`   ⚠️ [optimizeRemainingStops] Failed to save geocoded coords for patient ${patient.id}:`, error?.message);
             }
           } else {
             console.warn(`   ❌ [optimizeRemainingStops] Geocoding failed for ${patient.address}`);
             geocodedPatientIds.add(patient.id);
           }
         }
       }
       
       // If still no coords, mark as skipped
       if (!Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) {
         const reason = delivery.patient_id ? 
           (patientMap.get(delivery.patient_id)?.address ? 'geocoding_failed' : 'no_patient_address') : 
           'pickup_no_coords';
         
         skippedStops.push({
           deliveryId: delivery.id,
           patientName: delivery.patient_name || 'Unknown',
           address: delivery.patient_id ? (patientMap.get(delivery.patient_id)?.address || 'No address') : 'Store pickup',
           reason
         });
         
         console.log(`   ⚠️ [optimizeRemainingStops] SKIP: ${delivery.id} (${delivery.patient_name || 'Pickup'}) - ${reason}`);
       } else {
         enhancedStops.push({ ...stop, lat: coords.lat, lng: coords.lng });
       }
     }
     
     const stopsWithCoords = enhancedStops;
     console.log(`📋 [optimizeRemainingStops] Prepared ${stopsWithCoords.length} stops for HERE sequencing (${skippedStops.length} skipped due to missing coordinates)`);

    const historicalRoute = isHistoricalRouteDate(deliveryDate);
    const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);

    let currentPosition;
    let locationSource;

    const explicitNextDelivery = (firstStopId ? incompleteDeliveries.find((d) => d?.id === firstStopId) : null)
      || incompleteDeliveries.find((delivery) => delivery?.isNextDelivery === true)
      || null;
    const latestFinishedCoords = latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap) : null;
    const routeHasStarted = completedDeliveries.length > 0;

    // CRITICAL: Prioritize real-time currentLocation from frontend over cached AppUser GPS
    const frontendProvidedLocation = body?.currentLocation 
      ? { lat: Number(body.currentLocation.lat), lng: Number(body.currentLocation.lon) }
      : null;
    
    const driverGpsPosition = frontendProvidedLocation
      || (driverAppUser.current_latitude != null && driverAppUser.current_longitude != null
        ? { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) }
        : null);
    const driverHomePosition = driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    const DISTANCE_THRESHOLD_KM = 1.0;

    // Rule 1: Route has started — always use the last finished stop as segment origin.
    if (routeHasStarted && latestFinishedCoords) {
      currentPosition = latestFinishedCoords;
      locationSource = 'last_finished_stop';
    }
    // Rule 2: Route not started — use home as origin if available
    else if (!routeHasStarted && driverHomePosition) {
      currentPosition = driverHomePosition;
      locationSource = 'home_route_not_started';
    }
    // Rule 3: Route not started and no home — use live GPS as fallback origin
    else if (!routeHasStarted && driverGpsPosition) {
      currentPosition = driverGpsPosition;
      locationSource = 'driver_gps_no_home';
    }

    // Last resort fallback
    if (!currentPosition && driverHomePosition) {
      currentPosition = driverHomePosition;
      locationSource = 'home_fallback';
    }

    if (!currentPosition) {
      return Response.json({
        error: 'Driver location not available - no GPS, last completed, or home location set'
      }, { status: 404 });
    }

    // logicalSegmentOrigin is used as the HERE API origin — always the last finished stop or home (not mid-route GPS)
    const logicalSegmentOrigin = latestFinishedCoords
      || (driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
        ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
        : null)
      || currentPosition;

    console.log(`📍 [optimizeRemainingStops] Starting from: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng})`);
    console.log(`🎯 [optimizeRemainingStops] Active next stop: ${explicitNextDelivery?.id || 'none'}`);

    const optimizationStops = activeRouteDeliveries
      .map((delivery) => stopsWithCoords.find((item) => item.delivery.id === delivery.id) || null)
      .filter(Boolean);

    // For retro new routes, pending stops are already in optimizationStops — don't append them again
    const pendingStops = isRetroNewRoute ? [] : pendingRouteDeliveries
      .map((delivery) => stopsWithCoords.find((item) => item.delivery.id === delivery.id) || null)
      .filter(Boolean);

    // Separate stops by time window expiration status: prioritize valid windows, then expired windows
    const partitionStopsByWindowValidity = (stopsArr) => {
      const valid = [];
      const expired = [];
      stopsArr.forEach(s => {
        if (s.windowExpired) {
          expired.push(s);
        } else {
          valid.push(s);
        }
      });
      return { valid, expired };
    };

    // Pre-sort stops by delivery_time_start window before passing to HERE as a hint
    const sortStopsByWindow = (stopsArr) =>
      stopsArr.slice().sort((a, b) => {
        const aMin = parseTimeToMinutes(a.windowStart || a.delivery?.delivery_time_start);
        const bMin = parseTimeToMinutes(b.windowStart || b.delivery?.delivery_time_start);
        const aVal = Number.isFinite(aMin) ? aMin : 99999;
        const bVal = Number.isFinite(bMin) ? bMin : 99999;
        return aVal - bVal;
      });

    // For retro new routes, pending stops were promoted to optimizableDeliveries — don't treat them as pending-to-append
    const pendingDeliveryIds = new Set(isRetroNewRoute ? [] : pendingRouteDeliveries.map(d => d.id));

    // CRITICAL: Resolve the locked "isNextDelivery" stop — this is ALWAYS placed first in the route
    const lockedNextStop = explicitNextDelivery
      ? stopsWithCoords.find(s => s.delivery.id === explicitNextDelivery.id) || null
      : null;

    // Remaining stops to be optimized by HERE: everything except the locked first stop.
    const stopsForHereUnfiltered = optimizationStops.filter(s => !lockedNextStop || s.delivery.id !== lockedNextStop.delivery.id);
    const { valid: validWindowStops, expired: expiredWindowStops } = partitionStopsByWindowValidity(stopsForHereUnfiltered);

    const stopsForHere = preserveExistingOrder
      ? stopsForHereUnfiltered.sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999))
      : [
          ...sortStopsByWindow(validWindowStops),
          ...sortStopsByWindow(expiredWindowStops)
        ];

    const stopsToSequence = lockedNextStop
      ? [lockedNextStop, ...stopsForHere]
      : stopsForHere;

    if (lockedNextStop) {
      console.log(`🔒 [optimizeRemainingStops] isNextDelivery stop locked at position 1: ${lockedNextStop.delivery.id} (window: ${lockedNextStop.windowStart || 'none'})`);
    }
    const validWindowCount = stopsWithCoords.filter(s => !s.windowExpired && (s.windowStart || s.windowEnd)).length;
    const expiredWindowCount = stopsWithCoords.filter(s => s.windowExpired && (s.windowStart || s.windowEnd)).length;
    if (validWindowCount > 0 || expiredWindowCount > 0) {
      console.log(`⏰ [optimizeRemainingStops] TIME WINDOW ENFORCEMENT: ${validWindowCount} stops with active time windows, ${expiredWindowCount} stops with expired windows (will be de-prioritized)`);
    }

    console.log(`📋 [optimizeRemainingStops] ${stopsToSequence.length} active stops for HERE, ${pendingDeliveryIds.size} pending (appended to end after sequencing)`);
    console.log(`\n🎯 [optimizeRemainingStops] Optimizing remaining route: ${optimizationStops.length} stops`);

    let attemptedHereCalls = 0;
    let usedTimeWindows = true;
    let routeStops = [];
    let directionsLegs = [];
    let segmentPolylines = [];
    let resolvedTrueOrigin = null; // set inside the else-if block, used in write batch

    const resolvedHomePosition = driverAppUser.home_latitude != null && driverAppUser.home_longitude != null
      ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
      : null;

    const allStopsForDeparture = stopsToSequence;
    const earliestWindowMinutes = allStopsForDeparture.reduce((earliest, s) => {
      const wm = parseTimeToMinutes(s.windowStart || s.delivery?.delivery_time_start);
      return Number.isFinite(wm) && wm < earliest ? wm : earliest;
    }, Infinity);

    const isFutureRoute = isFutureDate
      || (Number.isFinite(earliestWindowMinutes) && (earliestWindowMinutes - currentMinutes) > 60);

    const useWindowBasedDeparture = isFutureRoute || driverIsOffDuty;

    const earliestValidWindowMinutes = allStopsForDeparture.reduce((earliest, s) => {
      const windowEnd = parseTimeToMinutes(s.windowEnd || s.delivery?.delivery_time_end);
      if (Number.isFinite(windowEnd) && windowEnd <= currentMinutes) return earliest;
      const wm = parseTimeToMinutes(s.windowStart || s.delivery?.delivery_time_start);
      return Number.isFinite(wm) && wm < earliest ? wm : earliest;
    }, Infinity);
    const hasValidWindows = Number.isFinite(earliestValidWindowMinutes);

    let resolvedDepartureTime;
    if (useWindowBasedDeparture && Number.isFinite(earliestWindowMinutes)) {
      resolvedDepartureTime = formatMinutesToTime(earliestWindowMinutes);
      console.log(`⏰ [optimizeRemainingStops] Using window-based departureTime=${resolvedDepartureTime} (isFutureRoute=${isFutureRoute}, offDuty=${driverIsOffDuty})`);
    } else if (hasValidWindows && earliestValidWindowMinutes < currentMinutes) {
      resolvedDepartureTime = formatMinutesToTime(earliestValidWindowMinutes);
      console.log(`⏰ [optimizeRemainingStops] Using earliest-valid-window departureTime=${resolvedDepartureTime} (currentTime=${formatMinutesToTime(currentMinutes)}, earliest valid window=${formatMinutesToTime(earliestValidWindowMinutes)})`);
    } else {
      resolvedDepartureTime = currentLocalTime || formatMinutesToTime(currentMinutes);
      console.log(`⏰ [optimizeRemainingStops] Using current-time departureTime=${resolvedDepartureTime}`);
    }

    // If current time is more than 2 hours before the earliest scheduled window, use the window start as ETA base.
    // Within the 2-hour buffer, use current time as-is.
    const TWO_HOURS = 120;
    const etaBaseMinutes = useWindowBasedDeparture && Number.isFinite(earliestWindowMinutes)
      ? earliestWindowMinutes
      : (hasValidWindows && earliestValidWindowMinutes < currentMinutes)
        ? earliestValidWindowMinutes
        : (Number.isFinite(earliestWindowMinutes) && (earliestWindowMinutes - currentMinutes) > TWO_HOURS)
          ? earliestWindowMinutes
          : currentMinutes;

    console.log(`📅 [optimizeRemainingStops] isFutureDate=${isFutureDate}, isFutureRoute=${isFutureRoute}, etaBase=${formatMinutesToTime(etaBaseMinutes)}, currentTime=${formatMinutesToTime(currentMinutes)}, earliestWindow=${Number.isFinite(earliestWindowMinutes) ? formatMinutesToTime(earliestWindowMinutes) : 'none'}`);

    if (preserveExistingOrder) {
      // Just refresh ETAs using existing order, no HERE call needed
      routeStops = [...optimizationStops];
      let prevPos = currentPosition;
      for (const stop of routeStops) {
        const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
        directionsLegs.push({ duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), distance: distKm * 1000 });
        segmentPolylines.push({ deliveryId: stop.delivery.id, encodedPolyline: null, estimatedDistanceKm: distKm, estimatedDurationMinutes: Math.ceil((distKm / 40) * 60) });
        prevPos = { lat: stop.lat, lng: stop.lng };
      }
      console.log('✅ [optimizeRemainingStops] Preserving existing order and refreshing ETAs only');
    } else if (stopsToSequence.length > 0) {
       // -------------------------------------------------------------------
       // CRITICAL: Pre-check if route order would actually change
       // Only call HERE if a true reordering is detected.
       // ONE-CALL STRATEGY: When stopsForHere is empty (only 1 active stop = lockedNextStop),
       // there is nothing for HERE to sequence — skip the API call entirely and use crow-flies.
       // -------------------------------------------------------------------
       const currentActiveOrder = optimizationStops.map(s => s.delivery.id);
       const wouldHereChangeOrder = stopsForHere.length > 0 && (
         currentActiveOrder.length !== stopsForHere.length
         || currentActiveOrder.some((id, idx) => id !== stopsForHere[idx]?.delivery?.id)
       );

       // TWO-CALL STRATEGY:
       // Call 1 (Sequence): lockedNextStop → [stopsForHere optimized by HERE] → home
       // Call 2 (First Leg): real-time GPS → lockedNextStop (point-to-point, FRESH)
       // -------------------------------------------------------------------
       const trueOrigin = logicalSegmentOrigin;
       resolvedTrueOrigin = trueOrigin;
       const destinationForDirections = resolvedHomePosition
         || (stopsForHere.length > 0 ? { lat: stopsForHere[stopsForHere.length - 1].lat, lng: stopsForHere[stopsForHere.length - 1].lng } : trueOrigin);

       console.log(`🏠 [optimizeRemainingStops] trueOrigin=(${trueOrigin.lat},${trueOrigin.lng}) | dest=${resolvedHomePosition ? 'HOME' : 'LAST_STOP'} | lockedNextStop=${lockedNextStop?.delivery?.id || 'none'} | wouldHereChangeOrder=${wouldHereChangeOrder}`);

      const sequenceOrigin = lockedNextStop
        ? { lat: lockedNextStop.lat, lng: lockedNextStop.lng }
        : trueOrigin;

      const sequenceWaypoints = stopsForHere.map(s => ({ lat: s.lat, lng: s.lng }));
      const sequenceRouteContext = stopsForHere.map(s => ({
        id: s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id,
        stop_id: s.delivery.stop_id,
        delivery_id: s.delivery.delivery_id,
        time_window_start: s.delivery.delivery_time_start || null,
        time_window_end: s.delivery.delivery_time_end || null,
      }));

      let hereSequenceResult = null;

      // CRITICAL: Only call HERE if the order would actually change
      if (wouldHereChangeOrder) {
        try {
          const seqResp = await base44.asServiceRole.functions.invoke('getHereDirections', {
            origin: sequenceOrigin,
            destination: destinationForDirections,
            waypoints: sequenceWaypoints,
            routeContext: sequenceRouteContext,
            transportMode: routingTravelMode,
            deliveryDate,
            departureTime: resolvedDepartureTime,
            caller: 'optimizeRemainingStops:sequence',
            preserveWaypointOrder: false,
            skipSequenceApi: false,
            skipRoutingApi: true,
          });
          hereSequenceResult = seqResp?.data || seqResp || null;
          attemptedHereCalls += Number(hereSequenceResult?.api_call_count || 1);
          usedTimeWindows = hereSequenceResult?.used_time_windows ?? true;
          console.log(`📡 [optimizeRemainingStops] Sequence call: ${hereSequenceResult?.sections?.length || 0} sections`);
        } catch (err) {
          console.error('❌ [optimizeRemainingStops] Sequence call failed:', err?.message || err);
          hereSequenceResult = null;
        }
      } else {
        console.log(`⏭️ [optimizeRemainingStops] ONE-CALL STRATEGY: ${stopsForHere.length === 0 ? 'Only 1 active stop (lockedNextStop) — no sequence needed' : 'Route order unchanged'} — skipping HERE API call, using crow-flies ETA`);
      }

      // -------------------------------------------------------------------
      // First-leg calculation (origin → lockedNextStop)
      // Uses cached values if origin hasn't moved, otherwise crow-flies.
      // -------------------------------------------------------------------
      let firstLegPolyline = null;
      let firstLegDistKm = lockedNextStop
        ? calculateCrowFliesDistance(trueOrigin.lat, trueOrigin.lng, lockedNextStop.lat, lockedNextStop.lng)
        : 0;
      let firstLegDurMin = lockedNextStop
        ? Math.ceil((firstLegDistKm / 40) * 60 * 1.3)
        : 0;

      if (lockedNextStop) {
        // No frontend GPS: try to use cached first-leg values if origin hasn't moved
        const COORD_MATCH_THRESHOLD = 0.0002; // ~22m
        const existingDelivery = lockedNextStop.delivery;
        const cachedOriginLat = existingDelivery?.first_leg_origin_lat != null ? Number(existingDelivery.first_leg_origin_lat) : null;
        const cachedOriginLng = existingDelivery?.first_leg_origin_lng != null ? Number(existingDelivery.first_leg_origin_lng) : null;
        const cachedDistKm = existingDelivery?.estimated_distance_km != null ? Number(existingDelivery.estimated_distance_km) : null;
        const cachedDurMin = existingDelivery?.estimated_duration_minutes != null ? Number(existingDelivery.estimated_duration_minutes) : null;
        const originUnchanged = cachedOriginLat != null && cachedOriginLng != null
          && Math.abs(cachedOriginLat - trueOrigin.lat) < COORD_MATCH_THRESHOLD
          && Math.abs(cachedOriginLng - trueOrigin.lng) < COORD_MATCH_THRESHOLD;
        const hasCachedEta = cachedDistKm != null && cachedDurMin != null;
        if (originUnchanged && hasCachedEta) {
          firstLegDistKm = cachedDistKm;
          firstLegDurMin = cachedDurMin;
          console.log(`♻️ [optimizeRemainingStops] First-leg ETA cache HIT - dist=${firstLegDistKm}km, dur=${firstLegDurMin}min`);
        } else {
          console.log(`[optimizeRemainingStops] First-leg ETA using crow-flies (${firstLegDistKm.toFixed(2)}km)`);
        }
      }

      // Build routeStops: [lockedNextStop, ...HERE-optimized stopsForHere]
      // segmentPolylines[i] = inbound leg data FOR stop i (the segment arriving AT stop i)
      const optimizedWaypointIds = Array.isArray(hereSequenceResult?.optimized_waypoint_ids)
        ? hereSequenceResult.optimized_waypoint_ids : null;
      const sections = Array.isArray(hereSequenceResult?.sections) ? hereSequenceResult.sections : [];

      const stopLookupById = new Map(
        stopsForHere.map(s => {
          const key = s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id;
          return [key, s];
        })
      );

      if (optimizedWaypointIds && optimizedWaypointIds.length > 0 && sections.length > 0) {
        const hereOrderedStops = optimizedWaypointIds
          .map(id => stopLookupById.get(id) || null)
          .filter(Boolean);

        routeStops = lockedNextStop ? [lockedNextStop, ...hereOrderedStops] : hereOrderedStops;

        directionsLegs = [];
        segmentPolylines = [];

        routeStops.forEach((stop, index) => {
          // INBOUND LEG CONVENTION:
          // segmentPolylines[i] holds the leg data for the segment arriving AT stop i.
          // For the first stop (lockedNextStop): use the first-leg result.
          // For all other stops: match by waypoint_id from sequence call sections.
          if (index === 0 && lockedNextStop && stop.delivery.id === lockedNextStop.delivery.id) {
            directionsLegs.push({ duration: firstLegDurMin * 60, distance: firstLegDistKm * 1000 });
            segmentPolylines.push({
              deliveryId: stop.delivery.id,
              encodedPolyline: firstLegPolyline,
              estimatedDistanceKm: firstLegDistKm,
              estimatedDurationMinutes: firstLegDurMin,
            });
            return;
          }
          const stopId = stop.delivery.stop_id || stop.delivery.delivery_id || stop.delivery.id;
          const matchedSection = sections.find(s => s.waypoint_id === stopId) || null;
          if (matchedSection) {
            directionsLegs.push({
              duration: (matchedSection.estimated_duration_minutes || 0) * 60,
              distance: (matchedSection.estimated_distance_km || 0) * 1000
            });
            segmentPolylines.push({
              deliveryId: stop.delivery.id,
              encodedPolyline: matchedSection.encoded_polyline || null,
              estimatedDistanceKm: matchedSection.estimated_distance_km ?? null,
              estimatedDurationMinutes: matchedSection.estimated_duration_minutes ?? null,
            });
          } else {
            const prevPos = index === 0 ? trueOrigin : { lat: routeStops[index - 1].lat, lng: routeStops[index - 1].lng };
            const dKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
            directionsLegs.push({ duration: Math.ceil((dKm / 40) * 3600 * 1.3), distance: dKm * 1000 });
            segmentPolylines.push({ deliveryId: stop.delivery.id, encodedPolyline: null, estimatedDistanceKm: dKm, estimatedDurationMinutes: Math.ceil((dKm / 40) * 60) });
          }
        });

        console.log(`✅ [optimizeRemainingStops] Route built: ${routeStops.length} stops (locked=${!!lockedNextStop}), ${sections.length} HERE sections, ${attemptedHereCalls} API calls${usedTimeWindows ? ' with time windows' : ''}`);
        segmentPolylines.forEach((sp, i) => {
          console.log(`   Leg ${i + 1} -> ${sp.deliveryId}: polyline=${sp.encodedPolyline ? 'YES (' + sp.encodedPolyline.length + ' chars)' : 'NONE'}, dist=${sp.estimatedDistanceKm}km, dur=${sp.estimatedDurationMinutes}min`);
        });
      } else {
        // Fallback: locked stop first, rest sorted by time window, crow-flies distances
        console.log('⚠️ [optimizeRemainingStops] HERE sequencing failed — using time-window fallback');
        routeStops = lockedNextStop
          ? [lockedNextStop, ...sortStopsByWindow(stopsForHere)]
          : sortStopsByWindow(stopsToSequence);

        let prevPos = trueOrigin;
        for (let i = 0; i < routeStops.length; i++) {
          const stop = routeStops[i];
          if (i === 0 && lockedNextStop && stop.delivery.id === lockedNextStop.delivery.id) {
            directionsLegs.push({ duration: firstLegDurMin * 60, distance: firstLegDistKm * 1000 });
            segmentPolylines.push({ deliveryId: stop.delivery.id, encodedPolyline: firstLegPolyline, estimatedDistanceKm: firstLegDistKm, estimatedDurationMinutes: firstLegDurMin });
          } else {
            const dKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
            directionsLegs.push({ duration: Math.ceil((dKm / 40) * 60 * 60 * 1.3), distance: dKm * 1000 });
            segmentPolylines.push({ deliveryId: stop.delivery.id, encodedPolyline: null, estimatedDistanceKm: dKm, estimatedDurationMinutes: Math.ceil((dKm / 40) * 60) });
          }
          prevPos = { lat: stop.lat, lng: stop.lng };
        }
      }
    }

    // -------------------------------------------------------------------
    // POST-HERE TIME WINDOW VIOLATION CORRECTION
    // -------------------------------------------------------------------
    if (routeStops.length > 1 && !preserveExistingOrder) {
      let simTime = etaBaseMinutes;
      let prevSimPos = logicalSegmentOrigin;
      const simLegs = [];

      // Build sim legs using segment polylines or crow-flies fallback
      for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const seg = segmentPolylines[i];
        const durMin = (typeof seg?.estimatedDurationMinutes === 'number' && seg.estimatedDurationMinutes > 0)
          ? seg.estimatedDurationMinutes
          : (() => {
              const dKm = calculateCrowFliesDistance(prevSimPos.lat, prevSimPos.lng, stop.lat, stop.lng);
              return Math.ceil((dKm / 40) * 60 * 1.3);
            })();
        simLegs.push(durMin);
        prevSimPos = { lat: stop.lat, lng: stop.lng };
      }

      // Simulate ETAs and detect violations
      let simCumulative = simTime;
      const simEtas = [];
      for (let i = 0; i < routeStops.length; i++) {
        simCumulative += simLegs[i];
        // Snap to window start if arriving early
        const wStart = parseTimeToMinutes(routeStops[i].windowStart || routeStops[i].delivery?.delivery_time_start);
        if (Number.isFinite(wStart) && simCumulative < wStart) simCumulative = wStart;
        simEtas.push(simCumulative);
        simCumulative += routeStops[i].delivery.extra_time || (routeStops[i].isPickup ? 15 : 5);
      }

      // Find stops violating their window end — skip index 0 (locked next stop)
      const startIdx = lockedNextStop ? 1 : 0;
      let correctionMade = false;

      for (let i = startIdx; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const windowEnd = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end);
        if (!Number.isFinite(windowEnd) || isWindowExpired(stop, currentMinutes)) continue;
        if (simEtas[i] <= windowEnd) continue;

        // This stop arrives after its window end — find earliest position where it fits
        console.log(`⚠️ [optimizeRemainingStops] POST-CORRECTION: ${stop.delivery.patient_name || 'Stop'} ETA ${formatMinutesToTime(simEtas[i])} > window end ${formatMinutesToTime(windowEnd)} — moving earlier`);

        // Try inserting at earlier positions
        let bestPos = i;
        let testCum = etaBaseMinutes;
        for (let j = startIdx; j < i; j++) {
          const testSeg = simLegs[j];
          testCum += testSeg;
          const wS = parseTimeToMinutes(routeStops[j].windowStart || routeStops[j].delivery?.delivery_time_start);
          if (Number.isFinite(wS) && testCum < wS) testCum = wS;
          const dKm = j === 0
            ? calculateCrowFliesDistance(logicalSegmentOrigin.lat, logicalSegmentOrigin.lng, stop.lat, stop.lng)
            : calculateCrowFliesDistance(routeStops[j - 1].lat, routeStops[j - 1].lng, stop.lat, stop.lng);
          const testArrival = (j === 0 ? etaBaseMinutes : testCum - simLegs[j]) + Math.ceil((dKm / 40) * 60 * 1.3);
          const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start);
          const arrivalSnapped = Number.isFinite(windowStart) && testArrival < windowStart ? windowStart : testArrival;
          if (arrivalSnapped <= windowEnd) {
            bestPos = j;
            break;
          }
          testCum += routeStops[j].delivery.extra_time || (routeStops[j].isPickup ? 15 : 5);
        }

        if (bestPos < i) {
          // Move stop from position i to bestPos
          const [removedStop] = routeStops.splice(i, 1);
          const [removedLeg] = directionsLegs.splice(i, 1);
          const [removedPoly] = segmentPolylines.splice(i, 1);
          routeStops.splice(bestPos, 0, removedStop);
          directionsLegs.splice(bestPos, 0, removedLeg);
          segmentPolylines.splice(bestPos, 0, removedPoly);
          correctionMade = true;
          console.log(`✅ [optimizeRemainingStops] Moved ${removedStop.delivery.patient_name || 'Stop'} to position ${bestPos + 1} to respect window end ${formatMinutesToTime(windowEnd)}`);

          // Recalculate simEtas after correction
          simCumulative = etaBaseMinutes;
          let prevP = logicalSegmentOrigin;
          for (let k = 0; k < routeStops.length; k++) {
            const s = routeStops[k];
            const dKm = calculateCrowFliesDistance(prevP.lat, prevP.lng, s.lat, s.lng);
            const seg2 = segmentPolylines[k];
            const dur2 = (typeof seg2?.estimatedDurationMinutes === 'number' && seg2.estimatedDurationMinutes > 0)
              ? seg2.estimatedDurationMinutes
              : Math.ceil((dKm / 40) * 60 * 1.3);
            simLegs[k] = dur2;
            simCumulative += dur2;
            const wS2 = parseTimeToMinutes(s.windowStart || s.delivery?.delivery_time_start);
            if (Number.isFinite(wS2) && simCumulative < wS2) simCumulative = wS2;
            simEtas[k] = simCumulative;
            simCumulative += s.delivery.extra_time || (s.isPickup ? 15 : 5);
            prevP = { lat: s.lat, lng: s.lng };
          }
        }
      }

      if (correctionMade) {
        console.log(`🔧 [optimizeRemainingStops] Post-HERE time window corrections applied — final order: ${routeStops.map(s => s.delivery.patient_name || 'Stop').join(' → ')}`);
      }
    }

    // Co-located stop correction
    if (routeStops.length > 2) {
      const COORD_EPSILON = 0.0002;
      const corrected = routeStops.slice();
      const correctedLegs = directionsLegs.slice();
      const correctedPolylines = segmentPolylines.slice();

      for (let i = 1; i < corrected.length - 1; i++) {
        for (let j = i + 1; j < corrected.length; j++) {
          const si = corrected[i];
          const sj = corrected[j];
          const sameLocation = Math.abs(si.lat - sj.lat) < COORD_EPSILON && Math.abs(si.lng - sj.lng) < COORD_EPSILON;
          if (!sameLocation) continue;
          const wiMin = parseTimeToMinutes(si.windowStart || si.delivery?.delivery_time_start);
          const wjMin = parseTimeToMinutes(sj.windowStart || sj.delivery?.delivery_time_start);
          if (Number.isFinite(wiMin) && Number.isFinite(wjMin) && wjMin < wiMin) {
            [corrected[i], corrected[j]] = [corrected[j], corrected[i]];
            [correctedLegs[i], correctedLegs[j]] = [correctedLegs[j], correctedLegs[i]];
            [correctedPolylines[i], correctedPolylines[j]] = [correctedPolylines[j], correctedPolylines[i]];
            console.log(`🔀 [optimizeRemainingStops] Swapped co-located stops: ${corrected[i].delivery.patient_name || 'Pickup'} (${formatMinutesToTime(wjMin)}) before ${corrected[j].delivery.patient_name || 'Pickup'} (${formatMinutesToTime(wiMin)})`);
          }
        }
      }
      routeStops = corrected;
      directionsLegs = correctedLegs;
      segmentPolylines = correctedPolylines;
    }

    // Enforce pickup-before-delivery constraint
    if (routeStops.length > 1) {
      const pickupIndexByStopId = new Map();
      routeStops.forEach((s, idx) => {
        if (!s.delivery.patient_id && s.delivery.stop_id) {
          pickupIndexByStopId.set(s.delivery.stop_id, idx);
        }
      });

      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        if (!stop.delivery.patient_id || !stop.delivery.puid) continue;
        const pickupIdx = pickupIndexByStopId.get(stop.delivery.puid);
        if (pickupIdx == null || pickupIdx < i) continue;

        console.log(`🔧 [optimizeRemainingStops] Pickup-before-delivery fix: moving pickup (${routeStops[pickupIdx].delivery.stop_id}) from index ${pickupIdx} to ${i} (delivery: ${stop.delivery.patient_name || stop.delivery.id})`);
        const [removedStop] = routeStops.splice(pickupIdx, 1);
        const [removedLeg] = directionsLegs.splice(pickupIdx, 1);
        const [removedPoly] = segmentPolylines.splice(pickupIdx, 1);
        routeStops.splice(i, 0, removedStop);
        directionsLegs.splice(i, 0, removedLeg);
        segmentPolylines.splice(i, 0, removedPoly);
        pickupIndexByStopId.set(removedStop.delivery.stop_id, i);
      }
    }

    // Append pending stops (not included in HERE optimization)
    if (pendingStops.length > 0 && routeStops.length > 0) {
      for (const pendingStop of pendingStops) {
        routeStops.push(pendingStop);
        directionsLegs.push({ duration: 0, distance: 0 });
        segmentPolylines.push({ deliveryId: pendingStop.delivery.id, encodedPolyline: null, estimatedDistanceKm: null, estimatedDurationMinutes: null });
      }
      console.log(`📌 [optimizeRemainingStops] Appended ${pendingStops.length} pending stop(s) to end of route after HERE optimization`);
    }

    // -------------------------------------------------------------------
    // ETA calculation
    // -------------------------------------------------------------------
    const stageEtaMap = new Map();
    const segmentPolylineByDeliveryId = new Map(segmentPolylines.map((segment) => [segment.deliveryId, segment]));

    const firstActiveRouteStop = routeStops.find(s => !pendingDeliveryIds.has(s.delivery.id)) || null;
    const nextStopIdForEta = explicitNextDelivery?.id || firstActiveRouteStop?.delivery?.id || null;

    if (historicalRoute && routeStops.length > 0) {
      const completedSorted = completedDeliveries
        .slice()
        .sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));

      const lastFinished = completedSorted.length > 0 ? completedSorted[completedSorted.length - 1] : null;

      let cumulativeTime;
      if (lastFinished) {
        const lastFinishedActualMinutes = parseActualDeliveryTime(lastFinished.actual_delivery_time);
        if (Number.isFinite(lastFinishedActualMinutes)) {
          const firstStop = routeStops[0];
          const segmentPolyline0 = segmentPolylineByDeliveryId.get(firstStop.delivery.id) || null;
          const dur0 = getLegTravelMinutes({ stop: firstStop, leg: directionsLegs[0], segmentPolyline: segmentPolyline0 });
          cumulativeTime = lastFinishedActualMinutes + dur0;
          const firstEta = formatMinutesToTime(cumulativeTime);
          stageEtaMap.set(firstStop.delivery.id, firstEta);
          console.log(`  ✅ [optimizeRemainingStops] Retro Stop 1 ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${firstEta} (last finished actual_delivery_time ${formatMinutesToTime(lastFinishedActualMinutes)} + ${dur0}min)`);
        } else {
          const firstStop = routeStops[0];
          const firstStopStartMinutes = parseTimeToMinutes(firstStop.delivery.delivery_time_start);
          cumulativeTime = Number.isFinite(firstStopStartMinutes) ? firstStopStartMinutes : etaBaseMinutes;
          stageEtaMap.set(firstStop.delivery.id, formatMinutesToTime(cumulativeTime));
          console.log(`  ✅ [optimizeRemainingStops] Retro Stop 1 ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${formatMinutesToTime(cumulativeTime)} (fallback: delivery_time_start)`);
        }
      } else {
        const firstStop = routeStops[0];
        const firstStopStartMinutes = parseTimeToMinutes(firstStop.delivery.delivery_time_start);
        cumulativeTime = Number.isFinite(firstStopStartMinutes) ? firstStopStartMinutes : etaBaseMinutes;
        stageEtaMap.set(firstStop.delivery.id, formatMinutesToTime(cumulativeTime));
        console.log(`  ✅ [optimizeRemainingStops] Retro Stop 1 ${firstStop.delivery.patient_name || 'Pickup'} - ETA: ${formatMinutesToTime(cumulativeTime)} (= delivery_time_start)`);
      }

      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
        const durationMinutes = getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline });
        cumulativeTime += durationMinutes;

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        console.log(`  ✅ [optimizeRemainingStops] Retro Stop ${i + 1} ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta} (prev + ${durationMinutes}min)`);
      }
    } else {
      let cumulativeTime;

      cumulativeTime = etaBaseMinutes;
      console.log(`🕒 [optimizeRemainingStops] ETA anchor: etaBaseMinutes=${formatMinutesToTime(cumulativeTime)}`);

      for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const segmentPolyline = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;

        if (i === 0 && lockedNextStop) {
          // First stop ETA is already computed above as cumulativeTime — don't add travel again
          cumulativeTime = snapToWindowStart(cumulativeTime, stop);
        } else {
          const travelMinutes = getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline, fallbackMinutes: i === 0 ? 5 : 10 });
          cumulativeTime += travelMinutes;
          cumulativeTime = snapToWindowStart(cumulativeTime, stop);
        }

        if (!stop.windowExpired && violatesTimeWindow(stop, cumulativeTime, currentMinutes)) {
          const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start);
          const windowEnd = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end);
          console.warn(`⚠️ [optimizeRemainingStops] STRICT TIME WINDOW VIOLATION: ${stop.delivery.patient_name || 'Pickup'} scheduled arrival ${formatMinutesToTime(cumulativeTime)} violates window [${Number.isFinite(windowStart) ? formatMinutesToTime(windowStart) : 'none'}, ${Number.isFinite(windowEnd) ? formatMinutesToTime(windowEnd) : 'none'}]`);
        }

        const eta = formatMinutesToTime(cumulativeTime);
        stageEtaMap.set(stop.delivery.id, eta);
        cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}${stop.windowExpired ? ' (window expired)' : ''}`);
      }
    }

    const activeStops = routeStops.map((stop) => ({
      ...stop.delivery,
      delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
    }));

    console.log(`\n📢 [optimizeRemainingStops] HERE returned ${activeStops.length} ordered stops`);

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

    const nextStopId = lockedNextStop?.delivery?.id || explicitNextDelivery?.id || firstActiveRouteStop?.delivery?.id || null;

    const resolvePendingTimes = (stop) => {
      if (stop.status !== 'pending') return null;

      if (!stop.patient_id) {
        const t = stop.delivery_time_start || stop.delivery_time_eta;
        return t ? { startTime: t, eta: t } : null;
      }

      if (!stop.puid) return null;

      const pickup = activeStops.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid)
        || allDeliveries.find((candidate) => !candidate.patient_id && candidate.stop_id === stop.puid);

      if (!pickup) return null;

      const pickupState = finalizedById.get(pickup.id) || pickup;
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
      const resolvedEta = (isPendingStop && pendingTimes?.eta) ? pendingTimes.eta : stop.delivery_time_eta;

      const stopObj = routeStops.find(s => s.delivery.id === stop.id);
      const patientWindowStart = stopObj?.windowStart && stopObj?.delivery?.patient_id ? stopObj.windowStart : null;
      const patientWindowEnd = stopObj?.windowEnd && stopObj?.delivery?.patient_id ? stopObj.windowEnd : null;

      const hasNewPolyline = !isPendingStop && !!segmentPolyline?.encodedPolyline;
      const hasNewDistKm = !isPendingStop && typeof segmentPolyline?.estimatedDistanceKm === 'number';
      const hasNewDurMin = !isPendingStop && typeof segmentPolyline?.estimatedDurationMinutes === 'number';

      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder,
        delivery_time_eta: resolvedEta,
        isNextDelivery: stop.id === nextStopId,
        transport_mode: safeTransportMode,
        travel_dist: Number(directionsLegs[i]?.distance)
          ? Number((Number(directionsLegs[i].distance) / 1000).toFixed(3))
          : null,
        // Pending stops always get null; active stops only get overwritten when HERE returned a real polyline
        ...(isPendingStop ? { encoded_polyline: null, estimated_distance_km: null, estimated_duration_minutes: null } : {}),
        ...(hasNewPolyline ? { encoded_polyline: segmentPolyline.encodedPolyline } : {}),
        ...(hasNewDistKm ? { estimated_distance_km: segmentPolyline.estimatedDistanceKm } : {}),
        ...(hasNewDurMin ? { estimated_duration_minutes: segmentPolyline.estimatedDurationMinutes } : {}),
        // Persist first-leg origin on the isNextDelivery stop so future runs can cache-hit
        ...(stop.id === nextStopId && resolvedTrueOrigin ? {
          first_leg_origin_lat: resolvedTrueOrigin.lat,
          first_leg_origin_lng: resolvedTrueOrigin.lng,
        } : {}),
      };

      if (pendingTimes?.startTime) {
        updateData.delivery_time_start = pendingTimes.startTime;
        stop.delivery_time_start = pendingTimes.startTime;
      }
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
          ? logicalSegmentOrigin
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
            console.log(`  🚴 Cycling polyline updated for stop ${batchItem.id} (${batchItem.label}), inbound dist/dur updated on this stop`);
          } else {
            console.warn(`  ⚠️ No cycling polyline returned for stop ${batchItem.id} - keeping driving polyline`);
          }
        } catch (cycleErr) {
          console.warn(`  ⚠️ Cycling polyline fetch failed for stop ${batchItem.id}:`, cycleErr?.message);
        }
      }));
    }

    // Persist the optimized route to database
    await Promise.all(
      finalDeliveryWriteBatch.map(({ id, data }) =>
        base44.asServiceRole.entities.Delivery.update(id, data).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        })
      )
    );

    finalDeliveryWriteBatch.forEach(({ data, label }) => {
      console.log(`  📢 [optimizeRemainingStops] Stop #${data.stop_order}: ${label} | ETA: ${data.delivery_time_eta || 'none'}${data.encoded_polyline ? ' [polyline saved]' : ' [no polyline]'}${data.estimated_distance_km != null ? ` | dist=${data.estimated_distance_km}km` : ''}${data.estimated_duration_minutes != null ? ` dur=${data.estimated_duration_minutes}min` : ''}`);
    });

    console.log(`\n✅ [optimizeRemainingStops] Route optimization complete - ${activeStops.length} stops sequenced, ${attemptedHereCalls} sequence API calls.`);

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
      shouldRefreshPolylines: true,
      orderedDeliveryIds: finalDeliveryWriteBatch.map(item => item.id),
      trueOriginCoords: resolvedTrueOrigin ? { lat: resolvedTrueOrigin.lat, lon: resolvedTrueOrigin.lng } : null,
      skippedStopsCount: skippedStops.length,
      skippedStops: skippedStops,
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