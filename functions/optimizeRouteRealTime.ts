import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

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

/**
 * Real-time route optimization with staged approach
 * 1. Sort incomplete stops by delivery_time_start
 * 2. Divide route into stages (each stage ends at a pickup)
 * 3. Optimize each stage using Google Directions API
 * 4. Update ETAs, stop orders, UI, and databases
 */
Deno.serve(async (req) => {
  console.log('🚀 [optimizeRouteRealTime] Function called');
  
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
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
        const flagged = incompletes.filter(d => d.isNextDelivery === true);

        if (flagged.length === 0) {
          // Pick the earliest by stop_order, then by ETA
          const chosen = [...incompletes].sort((a, b) => {
            const so = (a.stop_order || 999) - (b.stop_order || 999);
            if (so !== 0) return so;
            const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
            const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
            return etaA.localeCompare(etaB);
          })[0];
          if (chosen?.id) {
            await base44.asServiceRole.entities.Delivery.update(chosen.id, { isNextDelivery: true });
          }
        } else if (flagged.length > 1) {
          // Keep the earliest flagged, clear the rest
          const sortedFlagged = [...flagged].sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999));
          const keepId = sortedFlagged[0].id;
          const toClear = sortedFlagged.slice(1);
          if (toClear.length > 0) {
            await Promise.all(toClear.map(d => base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false })));
          }
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