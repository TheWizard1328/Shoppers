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
    const stages = [];
    let currentStageStops = [];
    
    for (const stop of stops) {
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

    console.log(`📊 Divided into ${stages.length} stages`);

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

    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      const stageStops = stages[stageIdx];
      console.log(`\n--- Stage ${stageIdx + 1}: ${stageStops.length} stops ---`);

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
      const optimizedStageStops = [...optimizedDeliveries, ...pickupsInStage];

      // Get travel times from Google Directions API
      let directionsLegs = [];
      
      if (optimizedStageStops.length > 0) {
        const routeCoords = [currentPosition, ...optimizedStageStops.map(s => ({ lat: s.lat, lng: s.lng }))];
        
        if (routeCoords.length >= 2) {
          const origin = `${routeCoords[0].lat},${routeCoords[0].lng}`;
          const destination = `${routeCoords[routeCoords.length - 1].lat},${routeCoords[routeCoords.length - 1].lng}`;
          const waypoints = routeCoords.slice(1, -1).map(c => `${c.lat},${c.lng}`);
          const waypointsStr = waypoints.length > 0 ? `&waypoints=${waypoints.join('|')}` : '';

          // Log API call
          await base44.asServiceRole.entities.GoogleAPILog.create({
            timestamp: new Date().toISOString(),
            api_type: 'Directions',
            purpose: `Stage ${stageIdx + 1} optimization for driver ${driverAppUser.user_name || driverId}`,
            function_name: 'optimizeRouteRealTime',
            user_id: user.id,
            user_name: user.full_name,
            metadata: { driver_id: driverId, delivery_date: deliveryDate, stage: stageIdx + 1, stops_count: optimizedStageStops.length }
          });

          const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${origin}&destination=${destination}${waypointsStr}&` +
            `departure_time=now&traffic_model=best_guess&key=${googleMapsKey}`;

          let directionsData = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
              const response = await fetch(directionsUrl, { signal: AbortSignal.timeout(15000) });
              directionsData = await response.json();
              if (directionsData.status === 'OK') {
                totalApiCalls++;
                break;
              }
            } catch (err) {
              console.warn(`Directions API attempt ${attempt + 1} failed:`, err.message);
            }
          }

          if (directionsData?.status === 'OK') {
            directionsLegs = directionsData.routes[0].legs.map(leg => ({
              duration: leg.duration_in_traffic?.value || leg.duration?.value || 0,
              distance: leg.distance?.value || 0
            }));
          } else {
            // Fallback to crow-flies
            let prevPos = currentPosition;
            for (const stop of optimizedStageStops) {
              const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
              directionsLegs.push({
                duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3),
                distance: distKm * 1000
              });
              prevPos = { lat: stop.lat, lng: stop.lng };
            }
          }
        }
      }

      // STEP 4: Update ETAs and stop orders
      for (let i = 0; i < optimizedStageStops.length; i++) {
        const stop = optimizedStageStops[i];
        stopOrderCounter++;

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

    // Update polyline record
    let polylineRecords = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });
    
    let polylineRecord = polylineRecords?.[0];
    if (!polylineRecord) {
      polylineRecord = await base44.asServiceRole.entities.DriverRoutePolyline.create({
        driver_id: driverId,
        delivery_date: deliveryDate,
        daily_generation_count: 0
      });
    }
    
    await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + totalApiCalls,
      last_generated_at: new Date().toISOString()
    });

    console.log(`\n✅ Route optimization complete - ${updates.length} stops updated, ${totalApiCalls} API calls`);

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