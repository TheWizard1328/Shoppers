import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Calculates real-time travel durations for all active deliveries for a driver
 * Uses driver's current GPS location and Google Directions API for traffic-aware estimates
 * Returns only durations - frontend calculates local ETAs
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate, deviceTime, currentLocalTime } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`📍 Calculating travel durations for driver ${driverId} on ${deliveryDate}`);

    // Get driver's current location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser || !driverAppUser.current_latitude || !driverAppUser.current_longitude) {
      return Response.json({ 
        error: 'Driver location not available',
        driverId 
      }, { status: 404 });
    }

    const driverLocation = {
      lat: driverAppUser.current_latitude,
      lng: driverAppUser.current_longitude
    };

    // Get ALL deliveries for the driver and date (not just active ones)
    const allDeliveriesForDay = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    });

    // CRITICAL: Early return if all deliveries are finished (route complete)
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const hasActiveDeliveries = allDeliveriesForDay.some(d => !finishedStatuses.includes(d.status));
    
    if (!hasActiveDeliveries) {
      console.log(`✅ Route complete - all ${allDeliveriesForDay.length} deliveries are finished. Skipping ETA calculation.`);
      return Response.json({ 
        message: 'Route complete - all deliveries finished',
        etas: [],
        routeComplete: true
      });
    }

    // Sort all deliveries by stop_order first
    const sortedAllDeliveries = [...allDeliveriesForDay].sort((a, b) => 
      (a.stop_order || Infinity) - (b.stop_order || Infinity)
    );

    // Filter to only active deliveries (in_transit or en_route)
    const activeDeliveries = allDeliveriesForDay.filter(d => 
      d.status === 'in_transit' || d.status === 'en_route'
    );

    // CRITICAL: Check if there are any 'in_transit' deliveries
    const inTransitDeliveries = activeDeliveries.filter(d => d.status === 'in_transit');

    let deliveriesToProcess = [];

    if (inTransitDeliveries.length > 0) {
      // If there are in_transit deliveries, process all active deliveries (in_transit + en_route)
      deliveriesToProcess = activeDeliveries;
      console.log(`📦 Found ${inTransitDeliveries.length} in_transit deliveries - processing all ${activeDeliveries.length} active stops`);
    } else {
      // If NO in_transit deliveries, only calculate ETA for the very first stop (Stop 1)
      // This prevents unnecessary API calls for pickups when route hasn't started
      const firstStop = sortedAllDeliveries.find(d => 
        (d.status === 'en_route' || d.status === 'pending') && d.stop_order === 1
      );
      if (firstStop) {
        deliveriesToProcess = [firstStop];
        console.log(`🚫 No in_transit deliveries - only calculating ETA for Stop 1: ${firstStop.puid ? 'Pickup' : firstStop.patient_name}`);
      }
    }

    if (deliveriesToProcess.length === 0) {
      return Response.json({ 
        message: 'No active or relevant deliveries found to calculate ETAs',
        etas: []
      });
    }

    // Get patients for coordinates
    const patientIds = [...new Set(deliveriesToProcess.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];

    const patientMap = new Map(patients.map(p => [p.id, p]));

    // Get stores for pickup coordinates
    const storeIds = [...new Set(deliveriesToProcess.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Sort deliveries to process by stop_order
    const sortedDeliveries = [...deliveriesToProcess].sort((a, b) => 
      (a.stop_order || Infinity) - (b.stop_order || Infinity)
    );

    // Get or create polyline record for counter tracking
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

    // Build waypoints for ONE API call with all incomplete stops
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const etaUpdates = [];
    const waypoints = [];
    const deliveriesWithCoords = [];

    // Collect all stop coordinates
    for (const delivery of sortedDeliveries) {
      if (delivery.status === 'completed') continue;

      let destLat, destLng;
      
      if (delivery.puid) {
        const store = storeMap.get(delivery.store_id);
        if (!store || !store.latitude || !store.longitude) continue;
        destLat = store.latitude;
        destLng = store.longitude;
      } else {
        const patient = patientMap.get(delivery.patient_id);
        if (!patient || !patient.latitude || !patient.longitude) continue;
        destLat = patient.latitude;
        destLng = patient.longitude;
      }

      deliveriesWithCoords.push({ delivery, lat: destLat, lng: destLng });
    }

    if (deliveriesWithCoords.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries with coordinates',
        etaUpdates: []
      });
    }

    // Build waypoints string (all stops except the last one)
    const waypointsStr = deliveriesWithCoords
      .slice(0, -1)
      .map(d => `${d.lat},${d.lng}`)
      .join('|');

    const lastStop = deliveriesWithCoords[deliveriesWithCoords.length - 1];

    // ONE API call for the entire route
    try {
      // Log API call
      // Get user's AppUser record for user_name
      const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const userAppUser = userAppUsers?.[0];
      
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions',
        purpose: `Calculating real-time ETAs for driver ${driverAppUser.user_name || driverId}`,
        function_name: 'calculateRealTimeETA',
        user_id: user.id,
        user_name: userAppUser?.user_name || user.full_name,
        metadata: {
          driver_id: driverId,
          delivery_date: deliveryDate,
          stops_count: deliveriesWithCoords.length
        }
      });

      const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
        `origin=${driverLocation.lat},${driverLocation.lng}&` +
        `destination=${lastStop.lat},${lastStop.lng}&` +
        (waypointsStr ? `waypoints=optimize:false|${waypointsStr}&` : '') +
        `departure_time=now&` +
        `traffic_model=best_guess&` +
        `key=${googleMapsKey}`;

      const directionsResponse = await fetch(directionsUrl);
      const directionsData = await directionsResponse.json();

      if (directionsData.status === 'OK' && directionsData.routes?.[0]) {
        const route = directionsData.routes[0];
        
        // CRITICAL: Use device's local time passed from frontend
        let cumulativeMinutes;
        if (currentLocalTime) {
          // currentLocalTime format: "14:30" (already in device's local timezone)
          const [hours, minutes] = currentLocalTime.split(':').map(Number);
          cumulativeMinutes = hours * 60 + minutes;
          console.log(`🕐 Using device local time: ${currentLocalTime} (${cumulativeMinutes} minutes)`);
        } else {
          // Fallback: use server time if no device time provided
          const now = new Date();
          cumulativeMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
          console.warn(`⚠️ No device time provided, using server UTC time as fallback`);
        }

        // Process each leg of the route - calculate actual clock time ETAs
        for (let i = 0; i < route.legs.length; i++) {
          const leg = route.legs[i];
          const delivery = deliveriesWithCoords[i].delivery;

          const durationSeconds = leg.duration_in_traffic?.value || leg.duration?.value || 0;
          const travelMinutes = Math.ceil(durationSeconds / 60);
          const serviceTime = delivery.extra_time || 5;
          
          cumulativeMinutes += travelMinutes;
          
          // CRITICAL: For pickups with no prior in_transit/en_route stops - ETA cannot be before delivery_time_start
          if (delivery.puid && delivery.delivery_time_start) {
            const [startHours, startMinutes] = delivery.delivery_time_start.split(':').map(Number);
            const startTimeMinutes = startHours * 60 + startMinutes;
            
            // Check if there are any prior in_transit/en_route stops
            const priorActiveStops = sortedAllDeliveries.filter(d => 
              (d.status === 'in_transit' || d.status === 'en_route') &&
              (d.stop_order || Infinity) < (delivery.stop_order || Infinity)
            );
            
            // If no prior active stops and ETA is before start time, use start time instead
            if (priorActiveStops.length === 0 && cumulativeMinutes < startTimeMinutes) {
              cumulativeMinutes = startTimeMinutes;
              console.log(`  ⏰ Pickup has no prior active stops - using delivery_time_start as minimum ETA`);
            }
          }
          
          // Apply time window waiting if applicable
          if (delivery.time_window_start && !delivery.puid) {
            const [windowHours, windowMinutes] = delivery.time_window_start.split(':').map(Number);
            const windowStartMinutes = windowHours * 60 + windowMinutes;
            if (cumulativeMinutes < windowStartMinutes) {
              cumulativeMinutes = windowStartMinutes;
            }
          }
          
          // Calculate ETA in HH:mm format
          const etaHours = Math.floor(cumulativeMinutes / 60) % 24;
          const etaMinutes = cumulativeMinutes % 60;
          const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMinutes).padStart(2, '0')}`;
          
          console.log(`  📍 Stop ${i + 1}: ${delivery.patient_name || 'Pickup'} - Travel=${travelMinutes}min, Cumulative=${cumulativeMinutes}min, ETA=${eta}`);
          
          // Track cumulative time for time window logic
          cumulativeMinutes += serviceTime;

          etaUpdates.push({
            deliveryId: delivery.id,
            delivery_id: delivery.delivery_id,
            eta: eta,
            status: delivery.status,
            travelMinutes: travelMinutes,
            serviceMinutes: serviceTime,
            stopOrder: delivery.stop_order,
            distanceMeters: leg.distance?.value || 0,
            trafficDelay: leg.duration_in_traffic?.value 
              ? (leg.duration_in_traffic.value - leg.duration.value) / 60
              : 0
          });
        }
        
        // CRITICAL: Update all delivery ETAs in the database
        console.log(`💾 Saving ${etaUpdates.length} ETAs to database...`);
        for (const update of etaUpdates) {
          await base44.asServiceRole.entities.Delivery.update(update.deliveryId, {
            delivery_time_eta: update.eta
          });
        }
        console.log(`✅ All ETAs saved to database`);

        console.log(`✅ Calculated ${etaUpdates.length} ETAs starting from current time with ONE API call`);
      }
    } catch (error) {
      console.error('Error calculating route ETAs:', error);
    }

    const apiCallCount = 1; // Only ONE API call now

    // Update polyline counter - only 1 API call now
    await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    });
    console.log(`📊 Incremented polyline counter by 1 (total: ${(polylineRecord.daily_generation_count || 0) + 1})`);


    console.log(`✅ Calculated ${etaUpdates.length} travel durations for driver ${driverId}`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      driverLocation,
      durationUpdates: etaUpdates,
      totalDeliveries: deliveriesToProcess.length,
      apiCallsMade: 1
    });

  } catch (error) {
    console.error('❌ Error calculating real-time ETAs:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});