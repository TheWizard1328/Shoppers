import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Real-time route optimization
 * Dynamically re-sequences delivery stops based on:
 * - Current traffic conditions
 * - Driver's GPS location
 * - Delivery time windows
 * - Estimated travel times
 */
Deno.serve(async (req) => {
  console.log('🚀 [optimizeRouteRealTime] Function called');
  
  try {
    console.log('🔐 [optimizeRouteRealTime] Creating client from request...');
    const base44 = createClientFromRequest(req);
    
    console.log('🔐 [optimizeRouteRealTime] Checking auth...');
    const user = await base44.auth.me();

    if (!user) {
      console.error('❌ [optimizeRouteRealTime] Unauthorized - no user');
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    console.log('✅ [optimizeRouteRealTime] User authenticated:', user.email);

    console.log('📦 [optimizeRouteRealTime] Parsing request body...');
    const { driverId, deliveryDate, currentLocalTime, startLocation } = await req.json();
    console.log('📦 [optimizeRouteRealTime] Request params:', { driverId, deliveryDate, currentLocalTime, startLocation });

    if (!driverId || !deliveryDate) {
      console.error('❌ [optimizeRouteRealTime] Missing parameters:', { driverId, deliveryDate });
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('✅ [optimizeRouteRealTime] Parameters validated');

    // Use client's local time if provided, otherwise fall back to server UTC time
    let currentMinutes;
    if (currentLocalTime) {
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
      console.log(`🕐 Using client local time: ${currentLocalTime} (${currentMinutes} minutes)`);
    } else {
      const now = new Date();
      currentMinutes = now.getHours() * 60 + now.getMinutes();
      console.warn(`⚠️ No local time provided, using server time (may be UTC)`);
    }

    console.log(`🔄 [optimizeRouteRealTime] Optimizing route for driver ${driverId} on ${deliveryDate}`);

    console.log('📍 [optimizeRouteRealTime] Determining starting location...');
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];
    console.log('📍 [optimizeRouteRealTime] AppUser found:', !!driverAppUser);
    
    if (!driverAppUser) {
      console.error('❌ [optimizeRouteRealTime] Driver AppUser not found');
      return Response.json({ 
        error: 'Driver not found'
      }, { status: 404 });
    }
    
    // Priority: 1) Provided start location (from Start button), 2) GPS location, 3) Home location
    let driverLocation;
    let locationSource;
    
    if (startLocation?.lat && startLocation?.lng) {
      driverLocation = {
        lat: startLocation.lat,
        lng: startLocation.lng
      };
      locationSource = 'start_button';
      console.log('📍 [optimizeRouteRealTime] Using Start button location:', driverLocation);
    } else if (driverAppUser.current_latitude && driverAppUser.current_longitude) {
      driverLocation = {
        lat: driverAppUser.current_latitude,
        lng: driverAppUser.current_longitude
      };
      locationSource = 'gps';
      console.log('📍 [optimizeRouteRealTime] Using current GPS location:', driverLocation);
    } else if (driverAppUser.home_latitude && driverAppUser.home_longitude) {
      driverLocation = {
        lat: driverAppUser.home_latitude,
        lng: driverAppUser.home_longitude
      };
      locationSource = 'home';
      console.log('🏠 [optimizeRouteRealTime] Using home location as fallback:', driverLocation);
    } else {
      console.error('❌ [optimizeRouteRealTime] No location available');
      return Response.json({ 
        error: 'Driver location not available - no GPS or home location set'
      }, { status: 404 });
    }

    console.log('📦 [optimizeRouteRealTime] Fetching deliveries...');
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });
    console.log('📦 [optimizeRouteRealTime] Deliveries found:', allDeliveries?.length || 0);

    if (!allDeliveries || allDeliveries.length === 0) {
      console.warn('⚠️ [optimizeRouteRealTime] No deliveries found');
      return Response.json({ 
        message: 'No deliveries found',
        routeChanged: false
      });
    }

    // Separate completed and incomplete deliveries
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedDeliveries = allDeliveries.filter(d => finishedStatuses.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !finishedStatuses.includes(d.status));

    console.log(`📊 Route breakdown: ${completedDeliveries.length} completed, ${incompleteDeliveries.length} incomplete`);

    // CRITICAL: Sort completed deliveries by actual completion time
    completedDeliveries.sort((a, b) => {
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
    });

    // Update completed deliveries with sequential stop_order (preserve completion order)
    for (let i = 0; i < completedDeliveries.length; i++) {
      const delivery = completedDeliveries[i];
      const sequentialOrder = i + 1;
      
      // Only update if stop_order changed
      if (delivery.stop_order !== sequentialOrder) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, {
          stop_order: sequentialOrder
        });
        console.log(`✅ Reordered completed stop #${sequentialOrder}: ${delivery.patient_name || 'Pickup'}`);
      }
    }

    const startingStopOrder = completedDeliveries.length;
    console.log(`🎯 Incomplete stops will start from stop_order ${startingStopOrder + 1}`);

    if (incompleteDeliveries.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries to optimize',
        routeChanged: false,
        completedStopsReordered: completedDeliveries.length
      });
    }

    const deliveries = incompleteDeliveries;

    // Get patients and stores for coordinates
    const patientIds = [...new Set(deliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    const storeIds = [...new Set(deliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Separate pickups and deliveries for constraint-based optimization
    const pickupStops = [];
    const deliveryStops = [];
    const ispDeliveryStops = [];
    
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const notes = (stop.delivery.delivery_notes || '').toLowerCase();
      const patientName = (stop.delivery.patient_name || '').toLowerCase();
      const isISP = notes.includes('interstore pickup') || notes.includes('isp') || 
                    patientName.includes('interstore pickup') || patientName.includes('(isp)');
      
      if (stop.delivery.puid && !stop.delivery.patient_id) {
        // This is a pickup
        pickupStops.push({ ...stop, idx: i, isISP: false });
      } else if (isISP) {
        // ISP deliveries can go anywhere
        ispDeliveryStops.push({ ...stop, idx: i, isISP: true });
      } else {
        // Regular delivery
        deliveryStops.push({ ...stop, idx: i, isISP: false });
      }
    }

    console.log(`📊 Stops breakdown: ${pickupStops.length} pickups, ${deliveryStops.length} deliveries, ${ispDeliveryStops.length} ISP deliveries`);

    if (stops.length === 0) {
      return Response.json({ 
        message: 'No valid stops to optimize',
        routeChanged: false
      });
    }

    // Get polyline record for counter tracking
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

    // Use Google Distance Matrix API to get real-time travel times
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const origins = [driverLocation, ...stops.map(s => ({ lat: s.lat, lng: s.lng }))];
    const destinations = stops.map(s => ({ lat: s.lat, lng: s.lng }));

    const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
    const destinationsStr = destinations.map(d => `${d.lat},${d.lng}`).join('|');

    const matrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?` +
      `origins=${originsStr}&` +
      `destinations=${destinationsStr}&` +
      `departure_time=now&` +
      `traffic_model=best_guess&` +
      `key=${googleMapsKey}`;

    const matrixResponse = await fetch(matrixUrl);
    const matrixData = await matrixResponse.json();

    // Increment API counter
    await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    });

    if (matrixData.status !== 'OK') {
      return Response.json({ 
        error: 'Failed to get distance matrix',
        status: matrixData.status
      }, { status: 500 });
    }

    // Build distance/time matrix
    const matrix = matrixData.rows.map(row => 
      row.elements.map(el => ({
        duration: el.duration_in_traffic?.value || el.duration?.value || 999999,
        distance: el.distance?.value || 999999
      }))
    );

    // Group deliveries by their pickup store
    const deliveriesByPickup = new Map();
    deliveryStops.forEach(d => {
      const key = d.delivery.store_id;
      if (!deliveriesByPickup.has(key)) {
        deliveriesByPickup.set(key, []);
      }
      deliveriesByPickup.get(key).push(d);
    });

    // Constraint-based optimization algorithm
    const optimizedRoute = [];
    const unvisitedPickups = new Set(pickupStops.map(p => p.idx));
    const unvisitedISP = new Set(ispDeliveryStops.map(p => p.idx));
    let currentPos = 0; // Start from driver location
    let cumulativeTime = currentMinutes;

    // Build route: pickups with their deliveries + ISP deliveries inserted optimally
    while (unvisitedPickups.size > 0 || unvisitedISP.size > 0) {
      let bestIdx = -1;
      let bestScore = Infinity;
      let bestType = null; // 'pickup' or 'isp'

      // Consider all unvisited pickups
      for (const idx of unvisitedPickups) {
        const travelTime = Math.ceil(matrix[currentPos][idx].duration / 60);
        const score = travelTime; // Shortest distance priority
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
          bestType = 'pickup';
        }
      }

      // Consider ISP deliveries (can go anywhere)
      for (const idx of unvisitedISP) {
        const stop = stops[idx];
        const travelTime = Math.ceil(matrix[currentPos][idx].duration / 60);
        const serviceTime = stop.delivery.extra_time || 5;
        const arrivalTime = cumulativeTime + travelTime;
        
        let score = travelTime;
        
        // Apply time window penalties for ISP
        if (stop.timeWindow) {
          if (arrivalTime < stop.timeWindow.start) {
            score += (stop.timeWindow.start - arrivalTime) * 0.3;
          } else if (arrivalTime > stop.timeWindow.end) {
            score += (arrivalTime - stop.timeWindow.end) * 5;
          } else {
            score -= 10;
          }
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
          bestType = 'isp';
        }
      }

      if (bestIdx === -1) break;

      // Add the selected stop
      if (bestType === 'pickup') {
        unvisitedPickups.delete(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const travelTime = Math.ceil(matrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 15;
        cumulativeTime += travelTime + serviceTime;
        currentPos = bestIdx + 1;

        // Now insert this pickup's deliveries optimally
        const pickupStoreId = stops[bestIdx].delivery.store_id;
        const pickupDeliveries = deliveriesByPickup.get(pickupStoreId) || [];
        
        // Sort deliveries by time window urgency and distance
        const unvisitedDeliveries = pickupDeliveries.filter(d => !optimizedRoute.includes(d.idx));
        
        for (const deliv of unvisitedDeliveries) {
          optimizedRoute.push(deliv.idx);
          const travelTime = Math.ceil(matrix[currentPos][deliv.idx].duration / 60);
          const serviceTime = deliv.delivery.extra_time || 5;
          cumulativeTime += travelTime + serviceTime;
          currentPos = deliv.idx + 1;
        }
      } else if (bestType === 'isp') {
        unvisitedISP.delete(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const travelTime = Math.ceil(matrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 5;
        cumulativeTime += travelTime + serviceTime;
        currentPos = bestIdx + 1;
      }
    }

    // Check if route changed
    const oldOrder = stops.map(s => s.currentOrder).join(',');
    const newOrder = optimizedRoute.map(i => i + 1).join(',');
    const routeChanged = oldOrder !== newOrder;

    console.log('📋 Old order:', oldOrder);
    console.log('📋 New order:', newOrder);
    console.log('📋 Route changed:', routeChanged);

    // Update stop_order and display_stop_order for ALL deliveries in optimized sequence
    const updates = [];
    for (let i = 0; i < optimizedRoute.length; i++) {
      const stopIdx = optimizedRoute[i];
      const stop = stops[stopIdx];
      const newStopOrder = startingStopOrder + i + 1; // Continue from completed stops

      // CRITICAL: Update both stop_order AND display_stop_order to match
      const updateData = {
        stop_order: newStopOrder,
        display_stop_order: newStopOrder
      };

      await base44.asServiceRole.entities.Delivery.update(stop.delivery.id, updateData);

      updates.push({
        deliveryId: stop.delivery.id,
        delivery_id: stop.delivery.delivery_id,
        patient_name: stop.delivery.patient_name || 'Pickup',
        oldOrder: stop.delivery.stop_order,
        newOrder: newStopOrder
      });

      console.log(`✅ Updated stop #${newStopOrder}: ${stop.delivery.patient_name || 'Pickup'} (was #${stop.delivery.stop_order})`);
    }

    console.log(`✅ Route optimization complete - ${routeChanged ? 'CHANGED' : 'UNCHANGED'} (${updates.length} updates with durations)`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged,
      durationUpdates: updates,
      totalStops: stops.length,
      apiCallsMade: 1,
      locationSource
    });

  } catch (error) {
    console.error('❌❌❌ [optimizeRouteRealTime] FATAL ERROR:', error);
    console.error('Error type:', error.constructor?.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return Response.json({ 
      error: error.message,
      stack: error.stack,
      type: error.constructor?.name
    }, { status: 500 });
  }
});