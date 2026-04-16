// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
const ACTIVE_STATUSES = ['in_transit', 'en_route'];

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
    const { driverId, deliveryDate, currentLocalTime, deviceTime } = body;
    
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
    const preferredTravelMode = String(driverAppUser?.preferred_travel_mode || 'driving').toLowerCase();
    const hereTransportMode = preferredTravelMode === 'cycling'
      ? 'bicycle'
      : preferredTravelMode === 'pedestrian'
        ? 'pedestrian'
        : 'car';
    
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

    if (incompleteDeliveries.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries to optimize',
        routeChanged: false
      });
    }

    console.log(`📊 [optimizeRemainingStops] Incomplete deliveries breakdown:`);
    incompleteDeliveries.forEach(d => {
      console.log(`   - ${d.patient_name || 'Pickup'}: isNextDelivery=${d.isNextDelivery}, delivery_time_start=${d.delivery_time_start}`);
    });

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
      const coords = getDeliveryCoords(delivery, patientMap, storeMap);
      const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
      const windowStart = getEffectiveWindowStart(delivery, patient);
      const windowEnd = getEffectiveWindowEnd(delivery, patient);
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

    // STEP 1: CRITICAL - Sort by isNextDelivery FIRST, then by time_window_start (NOT delivery_time_start)
    stops.sort((a, b) => {
      if (a.hasLateWindow !== b.hasLateWindow) return a.hasLateWindow ? 1 : -1;
      if (a.delivery.isNextDelivery !== b.delivery.isNextDelivery) {
        const aCanLead = a.delivery.isNextDelivery && !a.hasLateWindow;
        const bCanLead = b.delivery.isNextDelivery && !b.hasLateWindow;
        if (aCanLead && !bCanLead) return -1;
        if (!aCanLead && bCanLead) return 1;
      }
      const timeA = parseTimeToMinutes(a.windowStart) ?? a.timeMinutes;
      const timeB = parseTimeToMinutes(b.windowStart) ?? b.timeMinutes;
      if (timeA !== timeB) return timeA - timeB;
      if (a.isPickup && !b.isPickup) return -1;
      if (!a.isPickup && b.isPickup) return 1;
      return 0;
    });

    console.log(`📋 [optimizeRemainingStops] Sorted ${stops.length} stops (isNextDelivery first, then by time)`);

    const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);

    // STEP 2: Determine origin for the incomplete section only
    let currentPosition;
    let locationSource;

    if (latestFinishedDelivery) {
      currentPosition = getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap);
      locationSource = currentPosition ? 'last_finished_stop' : null;
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

    // STEP 3: Optimize the full incomplete route in one HERE call
    const routeStops = [...activeRouteDeliveries, ...pendingRouteDeliveries]
      .map((delivery) => {
        const stop = stops.find((item) => item.delivery.id === delivery.id);
        return stop || null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.hasLateWindow !== b.hasLateWindow) return a.hasLateWindow ? 1 : -1;
        const aIsActive = ACTIVE_STATUSES.includes(a.delivery.status);
        const bIsActive = ACTIVE_STATUSES.includes(b.delivery.status);
        if (aIsActive && !bIsActive) return -1;
        if (!aIsActive && bIsActive) return 1;
        const aCanLead = a.delivery.isNextDelivery && !a.hasLateWindow;
        const bCanLead = b.delivery.isNextDelivery && !b.hasLateWindow;
        if (aCanLead && !bCanLead) return -1;
        if (!aCanLead && bCanLead) return 1;
        const windowA = parseTimeToMinutes(a.windowStart || a.delivery.delivery_time_start);
        const windowB = parseTimeToMinutes(b.windowStart || b.delivery.delivery_time_start);
        if ((windowA ?? Infinity) !== (windowB ?? Infinity)) return (windowA ?? Infinity) - (windowB ?? Infinity);
        if (a.isPickup !== b.isPickup) return a.isPickup ? -1 : 1;
        const orderDiff = (Number(a.delivery.stop_order) || 9999) - (Number(b.delivery.stop_order) || 9999);
        if (orderDiff !== 0) return orderDiff;
        return a.timeMinutes - b.timeMinutes;
      });

    console.log(`\n🎯 [optimizeRemainingStops] Optimizing remaining route: ${routeStops.length} stops`);

    let directionsLegs = [];
    let attemptedHereCalls = 0;

    if (routeStops.length > 0) {
      const destinationStop = routeStops[routeStops.length - 1];
      const viaWaypoints = routeStops.slice(0, -1).map((stop) => ({ lat: stop.lat, lng: stop.lng }));

      attemptedHereCalls += 1;
      const directionsResponse = await base44.functions.invoke('getHereDirections', {
        origin: { lat: currentPosition.lat, lng: currentPosition.lng },
        destination: { lat: destinationStop.lat, lng: destinationStop.lng },
        waypoints: viaWaypoints,
        transportMode: preferredTravelMode,
        routeContext: routeStops.map((stop) => ({
          id: stop.delivery.id,
          status: stop.delivery.status,
          time_window_start: stop.delivery.time_window_start || stop.delivery.delivery_time_start || null,
          time_window_end: stop.delivery.time_window_end || stop.delivery.delivery_time_end || null
        }))
      }).catch((error) => {
        console.warn('[optimizeRemainingStops] HERE route call failed:', error?.message || error);
        return null;
      });

      const directionsData = directionsResponse?.data || directionsResponse || null;
      if (Array.isArray(directionsData?.sections) && directionsData.sections.length > 0) {
        directionsLegs = directionsData.sections.map((section) => ({
          duration: Number(section?.estimated_duration_minutes || 0) * 60,
          distance: Number(section?.estimated_distance_km || 0) * 1000
        }));
        console.log('✅ [optimizeRemainingStops] HERE Routing API success');
      } else {
        console.log('⚠️ [optimizeRemainingStops] HERE API failed - using crow-flies fallback');
        let prevPos = currentPosition;
        for (const stop of routeStops) {
          const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
          directionsLegs.push({
            duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3),
            distance: distKm * 1000
          });
          prevPos = { lat: stop.lat, lng: stop.lng };
        }
      }
    }

    // STEP 4: Calculate all ETAs in memory from the single remaining-route response
    let cumulativeTime = currentMinutes;
    const stageEtaMap = new Map();

    for (let i = 0; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const travelSeconds = directionsLegs[i] ? directionsLegs[i].duration : 300;
      const travelMinutes = Math.ceil(travelSeconds / 60);
      cumulativeTime += travelMinutes;

      if (stop.delivery.time_window_start) {
        const windowStart = parseTimeToMinutes(stop.delivery.time_window_start);
        if (cumulativeTime < windowStart) {
          cumulativeTime = windowStart;
        }
      }

      const eta = formatMinutesToTime(cumulativeTime);
      stageEtaMap.set(stop.delivery.id, eta);

      const serviceTime = stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
      cumulativeTime += serviceTime;

      console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}`);
    }

    const activeStops = incompleteDeliveries.map((delivery) => ({
      ...delivery,
      delivery_time_eta: stageEtaMap.get(delivery.id) || delivery.delivery_time_eta
    }));

    // STEP 7: Re-sort activeStops after full optimization is complete
    activeStops.sort((a, b) => {
      const aHasLateWindow = isLateWindowStop(a.time_window_start || a.delivery_time_start, currentMinutes);
      const bHasLateWindow = isLateWindowStop(b.time_window_start || b.delivery_time_start, currentMinutes);
      if (aHasLateWindow !== bHasLateWindow) return aHasLateWindow ? 1 : -1;

      const aCanLead = a.isNextDelivery && !aHasLateWindow;
      const bCanLead = b.isNextDelivery && !bHasLateWindow;
      if (aCanLead && !bCanLead) return -1;
      if (!aCanLead && bCanLead) return 1;

      const timeA = parseTimeToMinutes(a.time_window_start) ?? parseTimeToMinutes(a.delivery_time_start);
      const timeB = parseTimeToMinutes(b.time_window_start) ?? parseTimeToMinutes(b.delivery_time_start);
      if (timeA !== timeB) return timeA - timeB;

      const isAPickup = !a.patient_id;
      const isBPickup = !b.patient_id;
      if (isAPickup && !isBPickup) return -1;
      if (!isAPickup && isBPickup) return 1;
      return 0;
    });

    console.log(`\n🔢 [optimizeRemainingStops] Re-sorted ${activeStops.length} stops (isNextDelivery first, then by time)`);

    // STEP 8: Build one final delivery write batch and update once
    const startingOrder = completedDeliveries.length;
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
      const pickupStartTime = pickupState.delivery_time_start;
      const pickupETA = pickupState.delivery_time_eta;

      let baseMinutes = parseTimeToMinutes(pickupStartTime);
      const etaMinutes = parseTimeToMinutes(pickupETA);
      if (etaMinutes > baseMinutes) {
        baseMinutes = etaMinutes;
      }

      if (!Number.isFinite(baseMinutes)) return undefined;
      return formatMinutesToTime(baseMinutes + 5);
    };

    for (let i = 0; i < activeStops.length; i++) {
      const stop = activeStops[i];
      const newOrder = startingOrder + i + 1;
      const pendingStartTime = resolvePendingStartTime(stop);
      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder,
        delivery_time_eta: stop.delivery_time_eta
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

    finalDeliveryWriteBatch.forEach(({ data, label }) => {
      console.log(`  🔢 [optimizeRemainingStops] Stop #${data.stop_order}: ${label}${data.delivery_time_start ? ` (start: ${data.delivery_time_start})` : ''}`);
    });

    // Tracking numbers are intentionally delayed until Assign All / Accept All.

    try {
      await base44.asServiceRole.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate
      });
      console.log('🧹 [optimizeRemainingStops] Polylines purged and regenerated');
    } catch (polylineError) {
      console.warn('[optimizeRemainingStops] purgeAndRegeneratePolylines failed (non-fatal):', polylineError?.message || polylineError);
    }

    try {
      if (attemptedHereCalls > 0) {
        await base44.asServiceRole.entities.GoogleAPILog.create({
          timestamp: new Date().toISOString(),
          api_type: 'Directions (HERE)',
          purpose: `Current stage optimization for driver ${driverAppUser?.user_name || driverId}`,
          function_name: 'optimizeRemainingStops',
          user_id: user.id,
          user_name: driverAppUser?.user_name || user.full_name,
          metadata: {
            api_provider: 'here',
            call_count: attemptedHereCalls,
            successful_calls: totalApiCalls,
            driver_id: driverId,
            delivery_date: deliveryDate,
            stops_count: currentStageSorted.length,
            transport_mode: preferredTravelMode
          }
        });
      }
    } catch (logError) {
      console.warn('[optimizeRemainingStops] Non-fatal log error:', logError?.message || logError);
    }

    console.log(`\n✅ [optimizeRemainingStops] Route optimization complete - ${activeStops.length} stops updated in one final batch, ${attemptedHereCalls} API calls`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedCount: activeStops.length,
      stagesCount: 1,
      apiCallsMade: attemptedHereCalls,
      locationSource
    });

  } catch (error) {
    console.error('❌ [optimizeRemainingStops] ERROR:', error.message);
    return Response.json({ 
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});