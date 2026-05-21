// Redeployed on 2026-05-21 - Added distance-based temporary time window imputation for in_transit deliveries
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];
const TIME_ZONE = 'America/Edmonton';
const AUTOMATION_DEDUPE_WINDOW_MS = 60000;
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

// Geocode a patient address using Google Places API directly (no function invocation needed)
const geocodePatientAddress = async (patient) => {
  if (!patient?.address) return null;
  try {
    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) return null;
    const autocompleteResp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId' },
      body: JSON.stringify({ input: patient.address, languageCode: 'en', includedRegionCodes: ['CA'] })
    });
    if (!autocompleteResp.ok) return null;
    const autocompleteData = await autocompleteResp.json();
    const placeId = autocompleteData?.suggestions?.[0]?.placePrediction?.placeId;
    if (!placeId) return null;
    const detailsResp = await fetch(`https://places.googleapis.com/v1/places/${placeId}?fields=location&key=${apiKey}`, { headers: { 'X-Goog-FieldMask': 'location' } });
    if (!detailsResp.ok) return null;
    const detailsData = await detailsResp.json();
    if (detailsData?.location?.latitude && detailsData?.location?.longitude) {
      return { latitude: detailsData.location.latitude, longitude: detailsData.location.longitude };
    }
    return null;
  } catch (error) {
    console.warn(`[geocodePatientAddress] Failed:`, error?.message);
    return null;
  }
};

const getLatestFinishedDelivery = (deliveries) => [...(deliveries || [])]
  .filter((d) => FINISHED_STATUSES.includes(d?.status))
  .sort((a, b) => new Date(b?.actual_delivery_time || b?.updated_date || 0).getTime() - new Date(a?.actual_delivery_time || a?.updated_date || 0).getTime())[0] || null;

const getDeliveryCoords = (delivery, patientMap, storeMap) => {
  if (!delivery) return null;
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) return { lat: Number(patient.latitude), lng: Number(patient.longitude) };
  }
  if (delivery.is_cycling_start_marker && delivery.cycling_start_latitude != null) return { lat: Number(delivery.cycling_start_latitude), lng: Number(delivery.cycling_start_longitude) };
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null) return { lat: Number(store.latitude), lng: Number(store.longitude) };
  return null;
};

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const parseActualDeliveryTime = (actualTimeStr) => {
  if (!actualTimeStr) return null;
  const timePart = String(actualTimeStr).split('T')[1];
  if (!timePart) return null;
  return parseTimeToMinutes(timePart.substring(0, 5));
};

const getStorePickupWindow = (store, deliveryDate, ampm) => {
  if (!store || !deliveryDate) return { start: null, end: null };
  const d = new Date(deliveryDate + 'T12:00:00Z');
  const dow = d.getUTCDay();
  const slot = String(ampm || '').toUpperCase() === 'AM' ? 'am' : 'pm';
  let prefix;
  if (dow === 0) prefix = `sunday_${slot}`;
  else if (dow === 6) prefix = `saturday_${slot}`;
  else prefix = `weekday_${slot}`;
  if (!store[`${prefix}_enabled`]) return { start: null, end: null };
  return { start: store[`${prefix}_start`] || null, end: store[`${prefix}_end`] || null };
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  return `${String(Number(parts[0]) || 0).padStart(2, '0')}:${String(Number(parts[1]) || 0).padStart(2, '0')}:${String(Number(parts[2]) || 0).padStart(2, '0')}`;
};

const getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  return WEEKDAY_CODES[new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0)).getUTCDay()];
};

const getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'shortOffset', hour: '2-digit' })
    .formatToParts(new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0)))
    .find((p) => p.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  return `${match[1]}${String(match[2]).padStart(2, '0')}:${String(match[3] || '00').padStart(2, '0')}`;
};

const buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const getEdmontonTodayDateString = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const isHistoricalRouteDate = (dateStr) => !!dateStr && String(dateStr) < getEdmontonTodayDateString();

/**
 * Imputes a temporary delivery_time_end based on distance_from_store when a delivery
 * is in_transit and has a start time but no end time. This prevents HERE API from
 * treating these stops as low-priority open-ended deliveries.
 *
 * Rules:
 *   < 5 km  → +2 hrs
 *   5–10 km → +4 hrs
 *   > 10 km or unknown → +6 hrs, capped at 21:00
 */
const imputeTemporaryWindowEnd = (windowStart, patient) => {
  if (!windowStart) return null;
  const startMins = parseTimeToMinutes(windowStart);
  if (!Number.isFinite(startMins)) return null;

  const dist = patient?.distance_from_store;
  const MAX_END_MINS = parseTimeToMinutes('21:00'); // 9 PM hard cap

  let offsetMins;
  let label;
  if (dist != null && dist < 5) {
    offsetMins = 2 * 60;
    label = '<5km → +2hr';
  } else if (dist != null && dist >= 5 && dist <= 10) {
    offsetMins = 4 * 60;
    label = '5-10km → +4hr';
  } else {
    offsetMins = 6 * 60;
    label = '>10km/unknown → +6hr (cap 21:00)';
  }

  const rawEnd = startMins + offsetMins;
  const clampedEnd = Math.min(rawEnd, MAX_END_MINS);
  return { time: formatMinutesToTime(clampedEnd), label };
};

const extractOptimizationContext = (body = {}) => {
  const forceFullRemainingRouteOptimization = body?.forceFullRemainingRouteOptimization === true;
  if (body?.driverId && body?.deliveryDate) {
    return {
      driverId: body.driverId, deliveryDate: body.deliveryDate, currentLocalTime: body.currentLocalTime,
      deviceTime: body.deviceTime, preserveExistingOrder: body.preserveExistingOrder === true,
      forceFullRemainingRouteOptimization,
      bypassDriverStatus: body.bypassDriverStatus === true, bypassDeduplication: body.bypassDeduplication === true,
      triggerSource: body.triggerSource || 'manual'
    };
  }
  const eventType = body?.event?.type;
  const data = body?.data || null;
  const oldData = body?.old_data || null;
  return {
    driverId: body?.driverId || data?.driver_id || oldData?.driver_id || null,
    deliveryDate: body?.deliveryDate || data?.delivery_date || oldData?.delivery_date || null,
    currentLocalTime: body.currentLocalTime, deviceTime: body.deviceTime,
    preserveExistingOrder: body.preserveExistingOrder === true,
    forceFullRemainingRouteOptimization,
    bypassDriverStatus: body.bypassDriverStatus === true, bypassDeduplication: body.bypassDeduplication === true,
    triggerSource: eventType ? `automation:${eventType}` : 'automation',
    eventType, data, oldData, changedFields: Array.isArray(body?.changed_fields) ? body.changed_fields : []
  };
};

const shouldSkipAutomationEvent = (context = {}) => {
  if (!context?.eventType) return false;
  const { eventType, data, oldData, changedFields } = context;
  if (eventType === 'create') return !ACTIVE_STATUSES.includes(String(data?.status || ''));
  if (eventType === 'delete') return false;
  if (eventType !== 'update') return false;
  const deactivatedFromRoute = changedFields.includes('status')
    && FINISHED_STATUSES.includes(String(data?.status || ''))
    && ACTIVE_STATUSES.includes(String(oldData?.status || ''));
  if (deactivatedFromRoute) return true;
  const stopOrderChanged = changedFields.includes('stop_order') && !FINISHED_STATUSES.includes(String(data?.status || ''));
  const nextDeliveryChanged = changedFields.includes('isNextDelivery') && data?.isNextDelivery === true;
  const activatedToRoute = changedFields.includes('status')
    && ACTIVE_STATUSES.includes(String(data?.status || ''))
    && !ACTIVE_STATUSES.includes(String(oldData?.status || ''));
  return !(stopOrderChanged || nextDeliveryChanged || activatedToRoute);
};

const dedupeKeyFor = (driverId, deliveryDate) => `optimizeRemainingStops:${driverId}:${deliveryDate}`;

// Snap cumulativeTime forward to window start if arriving early
const snapToWindowStart = (cumulativeTime, stop) => {
  const ws = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start);
  return Number.isFinite(ws) && cumulativeTime < ws ? ws : cumulativeTime;
};

const isWindowExpired = (stop, currentMinutes) => {
  const we = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end);
  return Number.isFinite(we) && we <= currentMinutes;
};

// Recalculate all segment legs + ETAs for a given ordered route array from scratch (crow-flies fallback)
const recalcLegsAndEtas = (orderedStops, originPos, etaBase) => {
  const legs = [];
  const etas = [];
  let prevPos = originPos;
  let cumTime = etaBase;
  for (const stop of orderedStops) {
    const dKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
    const durMin = Math.ceil((dKm / 40) * 60 * 1.3);
    legs.push({ duration: durMin * 60, distance: dKm * 1000, estimatedDistanceKm: dKm, estimatedDurationMinutes: durMin });
    cumTime += durMin;
    cumTime = snapToWindowStart(cumTime, stop);
    etas.push(formatMinutesToTime(cumTime));
    cumTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
    prevPos = { lat: stop.lat, lng: stop.lng };
  }
  return { legs, etas };
};

Deno.serve(async (req) => {
  console.log('🚀 [optimizeRemainingStops] Function called');

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    console.log('✅ [optimizeRemainingStops] User authenticated:', user.email);

    const body = await req.json();
    const context = extractOptimizationContext(body);
    const {
      driverId, deliveryDate, currentLocalTime, deviceTime,
      preserveExistingOrder = false,
      forceFullRemainingRouteOptimization = false,
      bypassDriverStatus = false, bypassDeduplication = false,
      triggerSource = 'manual'
    } = context;

    const firstStopId = body?.firstStopId || null;
    const bypassHistoricalCheck = body?.bypassHistoricalCheck === true;
    const stampDedupeOnly = body?._stampDedupeOnly === true;

    if (!driverId || !deliveryDate) return Response.json({ error: 'Missing required parameters: driverId, deliveryDate' }, { status: 400 });

    if (shouldSkipAutomationEvent(context)) {
      const { eventType, data, changedFields } = context;
      const isTerminal = changedFields?.includes?.('status') && FINISHED_STATUSES.includes(String(data?.status || ''));
      console.log(`⏭️ [optimizeRemainingStops] Skipping non-optimization event — type=${eventType}, terminal=${isTerminal}`);
      return Response.json({ success: true, skipped: true, reason: isTerminal ? 'terminal_status_transition' : 'non_optimization_event', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    if (context?.eventType === 'update' && new Set(FINISHED_STATUSES).has(String(context?.data?.status || ''))) {
      console.log(`⏭️ [optimizeRemainingStops] Skipping — triggered by terminal status (${context.data.status})`);
      return Response.json({ success: true, skipped: true, reason: 'terminal_status_trigger', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    const dedupeKey = dedupeKeyFor(driverId, deliveryDate);
    const dedupeCheck = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: dedupeKey }, '-updated_date', 1);
    const dedupeRecord = dedupeCheck?.[0] || null;
    const lastRunAt = dedupeRecord?.setting_value?.last_run_at ? new Date(dedupeRecord.setting_value.last_run_at).getTime() : 0;

    if (!bypassDeduplication && lastRunAt && Date.now() - lastRunAt < AUTOMATION_DEDUPE_WINDOW_MS) {
      console.log(`⏭️ [optimizeRemainingStops] Deduped (ran ${Math.round((Date.now() - lastRunAt) / 1000)}s ago)`);
      return Response.json({ success: true, skipped: true, reason: 'deduped_recent_run', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lockPayload = { last_run_at: new Date().toISOString(), lock_id: lockId, trigger_source: stampDedupeOnly ? 'batch_dedupe_stamp' : triggerSource };
    if (dedupeRecord?.id) {
      await base44.asServiceRole.entities.AppSettings.update(dedupeRecord.id, { setting_value: { ...(dedupeRecord.setting_value || {}), ...lockPayload } });
    } else {
      await base44.asServiceRole.entities.AppSettings.create({ setting_key: dedupeKey, description: 'Recent optimizeRemainingStops execution lock', setting_value: lockPayload });
    }

    if (!bypassDeduplication) {
      await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 100)));
      const recheckRows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: dedupeKey }, '-updated_date', 1);
      const winner = recheckRows?.[0]?.setting_value?.lock_id;
      if (winner && winner !== lockId) {
        console.log(`⏭️ [optimizeRemainingStops] Lost optimistic lock (winner=${winner})`);
        return Response.json({ success: true, skipped: true, reason: 'deduped_optimistic_lock', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
      }
    }

    if (stampDedupeOnly) {
      console.log(`🔒 [optimizeRemainingStops] Dedupe key stamped for batch pipeline — returning early`);
      return Response.json({ success: true, skipped: true, reason: 'dedupe_stamp_only', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    // Resolve current wall-clock time in Edmonton
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
        let mh = now.getUTCHours() - 7;
        if (mh < 0) mh += 24;
        currentMinutes = mh * 60 + now.getUTCMinutes();
      }
    } else {
      const now = new Date();
      let mh = now.getUTCHours() - 7;
      if (mh < 0) mh += 24;
      currentMinutes = mh * 60 + now.getUTCMinutes();
    }

    const todayStr = getEdmontonTodayDateString();
    const isFutureDate = String(deliveryDate) > todayStr;
    console.log(`🔄 [optimizeRemainingStops] Optimizing driver ${driverId} on ${deliveryDate} (today=${todayStr}, isFuture=${isFutureDate})`);

    let driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1))?.[0] || null;
    if (!driverAppUser) driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1))?.[0] || null;
    if (!driverAppUser) return Response.json({ success: true, skipped: true, reason: 'driver_unavailable', routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });

    const driverIsOffDuty = driverAppUser.driver_status === 'off_duty' || driverAppUser.driver_status === 'on_break';
    if (!bypassDriverStatus && !isFutureDate && driverIsOffDuty) {
      return Response.json({ success: true, skipped: true, reason: 'driver_unavailable', routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    if (isHistoricalRouteDate(deliveryDate) && !bypassHistoricalCheck) {
      console.log(`⏭️ [optimizeRemainingStops] Skipping — historical date (${deliveryDate})`);
      return Response.json({ success: true, skipped: true, reason: 'historical_date', triggerSource, routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    const preferredTravelMode = String(driverAppUser?.preferred_travel_mode || 'driving').toLowerCase();
    const routingTravelMode = 'driving'; // always use driving for sequencing

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, 'stop_order');
    if (!allDeliveries || allDeliveries.length === 0) return Response.json({ message: 'No deliveries found', routeChanged: false });
    console.log(`📦 [optimizeRemainingStops] Found ${allDeliveries.length} deliveries`);

    const completedDeliveries = allDeliveries.filter(d => FINISHED_STATUSES.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !FINISHED_STATUSES.includes(d.status));
    const activeRouteDeliveries = incompleteDeliveries.filter(d => ACTIVE_STATUSES.includes(d.status));
    const pendingRouteDeliveries = incompleteDeliveries.filter(d => d.status === 'pending');

    const isRetroNewRoute = bypassHistoricalCheck && isHistoricalRouteDate(deliveryDate) && activeRouteDeliveries.length === 0 && pendingRouteDeliveries.length > 0;
    const optimizableDeliveries = isRetroNewRoute ? pendingRouteDeliveries : activeRouteDeliveries;

    if (optimizableDeliveries.length === 0 && pendingRouteDeliveries.length === 0) {
      return Response.json({ success: true, message: 'No optimizable stops found', routeChanged: false, optimizedCount: 0, apiCallsMade: 0 });
    }

    // Load patients + stores
    const patientIds = [...new Set(optimizableDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }) : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));
    const storeIds = [...new Set(optimizableDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0 ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }) : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    const pickupWindowByStopId = new Map(
      optimizableDeliveries.filter(d => d && !d.patient_id && d.stop_id).map(d => [d.stop_id, { start: d.delivery_time_start || null, end: d.delivery_time_end || null }])
    );

    // Build stops with coords + time windows
    const skippedStops = [];
    const geocodedPatientIds = new Set();
    const stopsRaw = optimizableDeliveries.map(delivery => {
      const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
      const isPickup = !delivery.patient_id;
      let windowStart = delivery.delivery_time_start || null;
      let windowEnd = delivery.delivery_time_end || null;

      if (!windowStart && !windowEnd) {
        if (isPickup && delivery.store_id) {
          const sw = getStorePickupWindow(storeMap.get(delivery.store_id), deliveryDate, delivery.ampm_deliveries);
          windowStart = sw.start; windowEnd = sw.end;
        } else if (patient) {
          windowStart = patient.time_window_start || null;
          windowEnd = patient.time_window_end || null;
        }
      }

      // ── Distance-based temporary time window imputation ──────────────────
      // For active (in_transit/en_route) delivery stops that have a start time but
      // no end time, impute a temporary end time based on the patient's distance
      // from the originating store. This prevents HERE from treating these stops as
      // low-priority open-ended deliveries and pushing them to the end of the route.
      //
      //   < 5 km  → start + 2 hrs
      //   5–10 km → start + 4 hrs
      //   > 10 km or unknown → start + 6 hrs (capped at 21:00)
      if (!isPickup && ACTIVE_STATUSES.includes(delivery.status) && windowStart && !windowEnd && patient) {
        const imputed = imputeTemporaryWindowEnd(windowStart, patient);
        if (imputed) {
          windowEnd = imputed.time;
          console.log(`⏱️ [optimizeRemainingStops] Imputed temp window for delivery ${delivery.id}: ${windowStart}–${windowEnd} (${imputed.label}, dist=${patient.distance_from_store ?? 'n/a'}km)`);
        }
      }

      // Ensure delivery window starts after its pickup window
      if (delivery.patient_id && delivery.puid && pickupWindowByStopId.has(delivery.puid)) {
        const pw = pickupWindowByStopId.get(delivery.puid);
        const pickupStartMin = parseTimeToMinutes(pw?.start);
        const deliveryStartMin = parseTimeToMinutes(windowStart);
        if (Number.isFinite(pickupStartMin) && (!Number.isFinite(deliveryStartMin) || deliveryStartMin < pickupStartMin)) {
          windowStart = formatMinutesToTime(pickupStartMin + 5);
        }
      }

      return {
        delivery, isPickup, windowStart, windowEnd,
        windowExpired: Number.isFinite(parseTimeToMinutes(windowEnd)) && parseTimeToMinutes(windowEnd) <= currentMinutes,
        lat: null, lng: null
      };
    });

    // Resolve coordinates (with geocoding fallback)
    const stopsWithCoords = [];
    for (const stop of stopsRaw) {
      let coords = getDeliveryCoords(stop.delivery, patientMap, storeMap);
      if (!Number.isFinite(coords?.lat) && stop.delivery.patient_id && !geocodedPatientIds.has(stop.delivery.patient_id)) {
        const patient = patientMap.get(stop.delivery.patient_id);
        if (patient?.address && patient.latitude == null) {
          const gc = await geocodePatientAddress(patient);
          if (gc) {
            await base44.asServiceRole.entities.Patient.update(patient.id, { latitude: gc.latitude, longitude: gc.longitude }).catch(() => {});
            patientMap.set(patient.id, { ...patient, latitude: gc.latitude, longitude: gc.longitude });
            coords = { lat: gc.latitude, lng: gc.longitude };
          }
          geocodedPatientIds.add(stop.delivery.patient_id);
        }
      }
      if (!Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) {
        skippedStops.push({ deliveryId: stop.delivery.id, patientName: stop.delivery.patient_name || 'Unknown', reason: 'no_coords' });
        continue;
      }
      stopsWithCoords.push({ ...stop, lat: coords.lat, lng: coords.lng });
    }

    console.log(`📋 [optimizeRemainingStops] ${stopsWithCoords.length} stops with coords (${skippedStops.length} skipped)`);

    // Resolve origin position
    const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);
    const latestFinishedCoords = latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap) : null;
    const routeHasStarted = completedDeliveries.length > 0;
    const driverHomePosition = driverAppUser.home_latitude != null ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) } : null;
    const driverGpsPosition = body?.currentLocation
      ? { lat: Number(body.currentLocation.lat), lng: Number(body.currentLocation.lon) }
      : (driverAppUser.current_latitude != null ? { lat: Number(driverAppUser.current_latitude), lng: Number(driverAppUser.current_longitude) } : null);

    let currentPosition, locationSource;
    if (routeHasStarted && latestFinishedCoords) { currentPosition = latestFinishedCoords; locationSource = 'last_finished_stop'; }
    else if (!routeHasStarted && driverHomePosition) { currentPosition = driverHomePosition; locationSource = 'home_route_not_started'; }
    else if (!routeHasStarted && driverGpsPosition) { currentPosition = driverGpsPosition; locationSource = 'driver_gps_no_home'; }
    if (!currentPosition && driverHomePosition) { currentPosition = driverHomePosition; locationSource = 'home_fallback'; }
    if (!currentPosition) return Response.json({ error: 'Driver location not available' }, { status: 404 });

    // logicalSegmentOrigin is used for HERE sequencing (last finished stop = logical start of remaining route)
    // etaOrigin is used for ETA calculation of the FIRST stop — always the driver's real current position
    const logicalSegmentOrigin = latestFinishedCoords || driverHomePosition || currentPosition;
    const etaOrigin = driverGpsPosition || currentPosition;
    console.log(`📍 [optimizeRemainingStops] Origin: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng}), etaOrigin: (${etaOrigin.lat}, ${etaOrigin.lng})`);

    // Partition stops
    const optimizationStops = activeRouteDeliveries.map(d => stopsWithCoords.find(s => s.delivery.id === d.id) || null).filter(Boolean);
    const pendingStops = isRetroNewRoute ? [] : pendingRouteDeliveries.map(d => stopsWithCoords.find(s => s.delivery.id === d.id) || null).filter(Boolean);
    const pendingDeliveryIds = new Set(isRetroNewRoute ? [] : pendingRouteDeliveries.map(d => d.id));

    const effectiveForceFullOptimization = forceFullRemainingRouteOptimization && optimizationStops.length > 1;

    const explicitNextDelivery = (firstStopId ? incompleteDeliveries.find(d => d?.id === firstStopId) : null)
      || incompleteDeliveries.find(d => d?.isNextDelivery === true) || null;

    // When forceFullRemainingRouteOptimization is true we still lock the current
    // isNextDelivery stop (the one the driver is actively en-route to) as first,
    // so HERE only re-sequences everything *after* it. Without this, HERE can
    // pull a future pickup (e.g. a 6 PM window) to the front just because it has
    // a tight time window, displacing the stop the driver is already heading to.
    const lockedNextStop = explicitNextDelivery
      ? stopsWithCoords.find(s => s.delivery.id === explicitNextDelivery.id) || null
      : null;

    // Sort stops by window start first, then by proximity to driver's current position as tiebreaker.
    // This gives HERE a stronger sequencing hint — nearby stops with the same or earlier window
    // are listed first so HERE is less likely to defer them in favour of distant same-store pickups.
    const sortByWindowThenProximity = (arr) => arr.slice().sort((a, b) => {
      const aMin = parseTimeToMinutes(a.windowStart || a.delivery?.delivery_time_start);
      const bMin = parseTimeToMinutes(b.windowStart || b.delivery?.delivery_time_start);
      const aFinite = Number.isFinite(aMin);
      const bFinite = Number.isFinite(bMin);
      // Primary: earlier window start wins; stops with no window go last
      if (aFinite !== bFinite) return aFinite ? -1 : 1;
      if (aFinite && bFinite && aMin !== bMin) return aMin - bMin;
      // Tiebreaker: closer to driver's current position wins
      const origin = etaOrigin || logicalSegmentOrigin;
      if (origin) {
        const aDist = calculateCrowFliesDistance(origin.lat, origin.lng, a.lat, a.lng);
        const bDist = calculateCrowFliesDistance(origin.lat, origin.lng, b.lat, b.lng);
        return aDist - bDist;
      }
      return 0;
    });

    // Departure time
    const isFutureRoute = isFutureDate || (driverIsOffDuty && !routeHasStarted);
    const allWindowMins = stopsWithCoords.map(s => parseTimeToMinutes(s.windowStart || s.delivery?.delivery_time_start)).filter(Number.isFinite);
    const earliestWindowMinutes = allWindowMins.length > 0 ? Math.min(...allWindowMins) : Infinity;
    let resolvedDepartureTime;
    if (effectiveForceFullOptimization) {
      resolvedDepartureTime = currentLocalTime || formatMinutesToTime(currentMinutes);
    } else if (isFutureRoute && Number.isFinite(earliestWindowMinutes)) {
      resolvedDepartureTime = formatMinutesToTime(earliestWindowMinutes);
    } else {
      resolvedDepartureTime = currentLocalTime || formatMinutesToTime(currentMinutes);
    }
    const etaBaseMinutes = (!effectiveForceFullOptimization && isFutureRoute && Number.isFinite(earliestWindowMinutes)) ? earliestWindowMinutes : currentMinutes;
    console.log(`⏰ [optimizeRemainingStops] departureTime=${resolvedDepartureTime}, etaBase=${formatMinutesToTime(etaBaseMinutes)}`);

    let routeStops = [];
    let segmentPolylines = [];
    let attemptedHereCalls = 0;
    let usedTimeWindows = false;
    let resolvedTrueOrigin = logicalSegmentOrigin;

    // ─────────────────────────────────────────────────────────────────────
    // SEQUENCING
    // ─────────────────────────────────────────────────────────────────────
    if (preserveExistingOrder) {
      routeStops = [...optimizationStops].sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999));
      console.log('✅ [optimizeRemainingStops] Preserving existing order (user-requested)');
    } else if (stopsWithCoords.length > 0) {
      const stopsForHere = optimizationStops.filter(s => !lockedNextStop || s.delivery.id !== lockedNextStop.delivery.id);
      const sortedHint = sortByWindowThenProximity(stopsForHere);

      const sequenceOrigin = lockedNextStop ? { lat: lockedNextStop.lat, lng: lockedNextStop.lng } : logicalSegmentOrigin;
      const destinationForDirections = driverHomePosition || (sortedHint.length > 0 ? { lat: sortedHint[sortedHint.length - 1].lat, lng: sortedHint[sortedHint.length - 1].lng } : logicalSegmentOrigin);

      const sequenceWaypoints = sortedHint.map(s => ({ lat: s.lat, lng: s.lng }));
      const sequenceRouteContext = sortedHint.map(s => ({
        id: s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id,
        stop_id: s.delivery.stop_id,
        delivery_id: s.delivery.delivery_id,
        time_window_start: s.windowStart || null,
        time_window_end: s.windowEnd || null, // Includes imputed temporary end time for HERE sequencing
      }));

      let hereSequenceResult = null;

      if (sortedHint.length > 0) {
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
          console.log(`📡 [optimizeRemainingStops] HERE sequence returned ${hereSequenceResult?.sections?.length || 0} sections, ${hereSequenceResult?.optimized_waypoint_ids?.length || 0} waypoints`);
        } catch (err) {
          console.error('❌ [optimizeRemainingStops] HERE sequence call failed:', err?.message || err);
        }
      }

      const stopLookupById = new Map(sortedHint.map(s => [s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id, s]));
      const optimizedWaypointIds = Array.isArray(hereSequenceResult?.optimized_waypoint_ids) ? hereSequenceResult.optimized_waypoint_ids : null;

      let hereOrderedStops;
      if (optimizedWaypointIds && optimizedWaypointIds.length > 0) {
        hereOrderedStops = optimizedWaypointIds.map(id => stopLookupById.get(id) || null).filter(Boolean);
        const returnedIds = new Set(optimizedWaypointIds);
        sortedHint.forEach(s => {
          const key = s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id;
          if (!returnedIds.has(key)) hereOrderedStops.push(s);
        });
      } else {
        console.warn('⚠️ [optimizeRemainingStops] HERE returned no sequence — using time-window sort fallback');
        hereOrderedStops = sortedHint;
      }

      routeStops = lockedNextStop ? [lockedNextStop, ...hereOrderedStops] : hereOrderedStops;
    }

    if (lockedNextStop) console.log(`🔒 [optimizeRemainingStops] Locked first stop: ${lockedNextStop.delivery.id} (window: ${lockedNextStop.windowStart || 'none'})`);

    // ─────────────────────────────────────────────────────────────────────
    // POST-SEQUENCING CORRECTIONS (applied before stop_order/ETA writes)
    // ─────────────────────────────────────────────────────────────────────

    // 1. Pickup-before-delivery enforcement
    if (routeStops.length > 1) {
      const pickupIndexByStopId = new Map();
      routeStops.forEach((s, idx) => { if (!s.delivery.patient_id && s.delivery.stop_id) pickupIndexByStopId.set(s.delivery.stop_id, idx); });
      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        if (!stop.delivery.patient_id || !stop.delivery.puid) continue;
        const pickupIdx = pickupIndexByStopId.get(stop.delivery.puid);
        if (pickupIdx == null || pickupIdx < i) continue;
        console.log(`🔧 [optimizeRemainingStops] Pickup-before-delivery fix: moving pickup to index ${i}`);
        const [removed] = routeStops.splice(pickupIdx, 1);
        routeStops.splice(i, 0, removed);
        pickupIndexByStopId.set(removed.delivery.stop_id, i);
      }
    }

    // 2. Co-located stop correction (same address → sort by window start)
    if (routeStops.length > 2) {
      const startIdx = lockedNextStop ? 1 : 0;
      for (let i = startIdx; i < routeStops.length - 1; i++) {
        for (let j = i + 1; j < routeStops.length; j++) {
          const si = routeStops[i], sj = routeStops[j];
          if (Math.abs(si.lat - sj.lat) > 0.0002 || Math.abs(si.lng - sj.lng) > 0.0002) continue;
          const wiMin = parseTimeToMinutes(si.windowStart || si.delivery?.delivery_time_start);
          const wjMin = parseTimeToMinutes(sj.windowStart || sj.delivery?.delivery_time_start);
          if (Number.isFinite(wiMin) && Number.isFinite(wjMin) && wjMin < wiMin) {
            [routeStops[i], routeStops[j]] = [routeStops[j], routeStops[i]];
            console.log(`🔀 [optimizeRemainingStops] Co-located swap: ${routeStops[i].delivery.patient_name || 'Stop'} before ${routeStops[j].delivery.patient_name || 'Stop'}`);
          }
        }
      }
    }

    // 3. Time-window violation correction (move late-arriving stops earlier)
    if (routeStops.length > 1 && !preserveExistingOrder) {
      const startIdx = lockedNextStop ? 1 : 0;
      const { etas: simEtas } = recalcLegsAndEtas(routeStops, etaOrigin, etaBaseMinutes);
      let correctionMade = false;
      for (let i = startIdx; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const windowEnd = parseTimeToMinutes(stop.windowEnd || stop.delivery?.delivery_time_end);
        if (!Number.isFinite(windowEnd) || isWindowExpired(stop, currentMinutes) || parseTimeToMinutes(simEtas[i]) <= windowEnd) continue;
        console.log(`⚠️ [optimizeRemainingStops] POST-CORRECTION: ${stop.delivery.patient_name || 'Stop'} ETA ${simEtas[i]} > window end ${formatMinutesToTime(windowEnd)} — moving earlier`);
        let bestPos = i;
        for (let j = startIdx; j < i; j++) {
          const dKm = calculateCrowFliesDistance(j === 0 ? logicalSegmentOrigin.lat : routeStops[j - 1].lat, j === 0 ? logicalSegmentOrigin.lng : routeStops[j - 1].lng, stop.lat, stop.lng);
          const testArrival = parseTimeToMinutes(simEtas[j === 0 ? 0 : j - 1] || formatMinutesToTime(etaBaseMinutes)) + Math.ceil((dKm / 40) * 60 * 1.3);
          const windowStart = parseTimeToMinutes(stop.windowStart || stop.delivery?.delivery_time_start);
          const snapped = Number.isFinite(windowStart) && testArrival < windowStart ? windowStart : testArrival;
          if (snapped <= windowEnd) { bestPos = j; break; }
        }
        if (bestPos < i) {
          const [removed] = routeStops.splice(i, 1);
          routeStops.splice(bestPos, 0, removed);
          correctionMade = true;
          console.log(`✅ [optimizeRemainingStops] Moved to position ${bestPos + 1}`);
        }
      }
      if (correctionMade) console.log(`🔧 Post-correction order: ${routeStops.map(s => s.delivery.patient_name || 'Stop').join(' → ')}`);
    }

    // Append pending stops to end
    if (pendingStops.length > 0) {
      pendingStops.forEach(ps => routeStops.push(ps));
      console.log(`📌 [optimizeRemainingStops] Appended ${pendingStops.length} pending stop(s)`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ETA CALCULATION — after all corrections, from scratch
    // ─────────────────────────────────────────────────────────────────────
    const stageEtaMap = new Map();
    const historicalRoute = isHistoricalRouteDate(deliveryDate);

    if (historicalRoute) {
      const completedSorted = completedDeliveries.slice().sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));
      const lastFinished = completedSorted[completedSorted.length - 1] || null;
      let cumTime = lastFinished
        ? (parseActualDeliveryTime(lastFinished.actual_delivery_time) || parseTimeToMinutes(routeStops[0]?.delivery?.delivery_time_start) || etaBaseMinutes)
        : (parseTimeToMinutes(routeStops[0]?.delivery?.delivery_time_start) || etaBaseMinutes);
      if (routeStops.length > 0) stageEtaMap.set(routeStops[0].delivery.id, formatMinutesToTime(cumTime));
      for (let i = 1; i < routeStops.length; i++) {
        const stop = routeStops[i];
        const prev = routeStops[i - 1];
        const dKm = calculateCrowFliesDistance(prev.lat, prev.lng, stop.lat, stop.lng);
        cumTime += Math.ceil((dKm / 40) * 60 * 1.3);
        stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumTime));
        cumTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
      }
    } else {
      let cumTime = etaBaseMinutes;
      for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        if (i === 0) {
          const dKm = calculateCrowFliesDistance(etaOrigin.lat, etaOrigin.lng, stop.lat, stop.lng);
          cumTime += Math.ceil((dKm / 40) * 60 * 1.3);
        } else {
          const prev = routeStops[i - 1];
          const dKm = calculateCrowFliesDistance(prev.lat, prev.lng, stop.lat, stop.lng);
          cumTime += Math.ceil((dKm / 40) * 60 * 1.3);
        }
        cumTime = snapToWindowStart(cumTime, stop);
        stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumTime));
        cumTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        console.log(`  ✅ ${stop.delivery.patient_name || 'Pickup'} — stop #${i + 1} ETA: ${formatMinutesToTime(parseTimeToMinutes(stageEtaMap.get(stop.delivery.id)))}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // BUILD WRITE BATCH
    // ─────────────────────────────────────────────────────────────────────
    const startingOrder = completedDeliveries.length;
    const activeStops = routeStops.map(s => ({ ...s.delivery, delivery_time_eta: stageEtaMap.get(s.delivery.id) || s.delivery.delivery_time_eta }));
    const originalActiveOrder = activeRouteDeliveries.slice().sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999)).map(d => String(d.id));
    const optimizedActiveOrder = activeStops.map(s => String(s.id));
    const routeOrderChanged = preserveExistingOrder ? false : originalActiveOrder.length !== optimizedActiveOrder.length || originalActiveOrder.some((id, i) => id !== optimizedActiveOrder[i]);

    const nextStopId = lockedNextStop?.delivery?.id || explicitNextDelivery?.id || routeStops.find(s => !pendingDeliveryIds.has(s.delivery.id))?.delivery?.id || null;

    const finalDeliveryWriteBatch = [];
    for (let i = 0; i < activeStops.length; i++) {
      const stop = activeStops[i];
      const newOrder = preserveExistingOrder ? Number(stop.stop_order || i + 1) : startingOrder + i + 1;
      const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(String(stop?.transport_mode || preferredTravelMode)) ? String(stop?.transport_mode || preferredTravelMode) : 'driving';

      finalDeliveryWriteBatch.push({
        id: stop.id,
        label: stop.patient_name || 'Pickup',
        data: {
          stop_order: newOrder,
          delivery_time_eta: stop.delivery_time_eta,
          isNextDelivery: stop.id === nextStopId,
          transport_mode: safeTransportMode,
          ...(resolvedTrueOrigin && stop.id === nextStopId ? { first_leg_origin_lat: resolvedTrueOrigin.lat, first_leg_origin_lng: resolvedTrueOrigin.lng } : {}),
        }
      });
    }

    // Persist to database
    await Promise.all(
      finalDeliveryWriteBatch.map(({ id, data }) =>
        base44.asServiceRole.entities.Delivery.update(id, data).catch(err => {
          if (isNotFoundError(err)) return null;
          throw err;
        })
      )
    );

    finalDeliveryWriteBatch.forEach(({ data, label }) => {
      console.log(`  📢 Stop #${data.stop_order}: ${label} | ETA: ${data.delivery_time_eta || 'none'}`);
    });

    console.log(`\n✅ [optimizeRemainingStops] Complete — ${activeStops.length} stops sequenced, ${attemptedHereCalls} HERE calls`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: routeOrderChanged,
      optimizedCount: routeStops.length,
      apiCallsMade: attemptedHereCalls,
      locationSource,
      usedTimeWindows,
      preserveExistingOrder,
      nextDeliveryId: nextStopId,
      shouldRefreshPolylines: true,
      orderedDeliveryIds: finalDeliveryWriteBatch.map(item => item.id),
      trueOriginCoords: resolvedTrueOrigin ? { lat: resolvedTrueOrigin.lat, lon: resolvedTrueOrigin.lng } : null,
      skippedStopsCount: skippedStops.length,
      skippedStops,
      optimizedRoute: activeStops.map((stop, index) => ({
        deliveryId: stop.id,
        newETA: stop.delivery_time_eta,
        stop_order: startingOrder + index + 1,
        isNextDelivery: stop.id === nextStopId,
        transport_mode: stop.transport_mode || preferredTravelMode,
      }))
    });

  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn('⚠️ [optimizeRemainingStops] Deferred due to rate limit');
      return Response.json({ success: false, routeChanged: false, optimizedCount: 0, apiCallsMade: 0, deferred: true, reason: 'rate_limited' });
    }
    console.error('❌ [optimizeRemainingStops] ERROR:', error.message);
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});