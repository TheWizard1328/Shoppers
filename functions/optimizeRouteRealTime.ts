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
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate, currentLocalTime } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

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

    console.log(`🔄 Optimizing route for driver ${driverId} on ${deliveryDate}`);

    // Get driver's current location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser || !driverAppUser.current_latitude || !driverAppUser.current_longitude) {
      return Response.json({ 
        error: 'Driver location not available' 
      }, { status: 404 });
    }

    const driverLocation = {
      lat: driverAppUser.current_latitude,
      lng: driverAppUser.current_longitude
    };

    // Get ALL deliveries for this driver (completed AND incomplete)
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    if (!allDeliveries || allDeliveries.length === 0) {
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

    // Build list of stops with coordinates
    const stops = [];
    for (const delivery of deliveries) {
      let lat, lng, timeWindow;

      if (delivery.puid) {
        // Pickup - use store coordinates
        const store = storeMap.get(delivery.store_id);
        if (!store || !store.latitude || !store.longitude) continue;
        lat = store.latitude;
        lng = store.longitude;
        timeWindow = null; // Pickups are flexible
      } else {
        // Delivery - use patient coordinates
        const patient = patientMap.get(delivery.patient_id);
        if (!patient || !patient.latitude || !patient.longitude) continue;
        lat = patient.latitude;
        lng = patient.longitude;
        
        // Parse time window if available
        if (delivery.time_window_start && delivery.time_window_end) {
          const [startH, startM] = delivery.time_window_start.split(':').map(Number);
          const [endH, endM] = delivery.time_window_end.split(':').map(Number);
          timeWindow = {
            start: startH * 60 + startM,
            end: endH * 60 + endM
          };
        }
      }

      stops.push({
        delivery,
        lat,
        lng,
        timeWindow,
        currentOrder: delivery.stop_order || 999
      });
    }

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

    // Optimize route using nearest neighbor with time window constraints
    const optimizedRoute = [];
    const unvisited = new Set(stops.map((_, i) => i));
    let currentPos = 0; // Start from driver location (index 0 in origins)
    let cumulativeTime = currentMinutes;

    while (unvisited.size > 0) {
      let bestIdx = -1;
      let bestScore = Infinity;

      for (const idx of unvisited) {
        const stop = stops[idx];
        const travelTime = Math.ceil(matrix[currentPos][idx].duration / 60); // Convert to minutes
        const arrivalTime = cumulativeTime + travelTime;

        // Calculate score (lower is better)
        let score = travelTime;

        // Penalty for violating time windows
        if (stop.timeWindow) {
          if (arrivalTime < stop.timeWindow.start) {
            // Arriving too early - wait time penalty
            score += (stop.timeWindow.start - arrivalTime) * 0.5;
          } else if (arrivalTime > stop.timeWindow.end) {
            // Arriving too late - heavy penalty
            score += (arrivalTime - stop.timeWindow.end) * 2;
          }
        }

        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }

      if (bestIdx === -1) break;

      optimizedRoute.push(bestIdx);
      unvisited.delete(bestIdx);
      
      const travelTime = Math.ceil(matrix[currentPos][bestIdx].duration / 60);
      const serviceTime = stops[bestIdx].delivery.extra_time || 5;
      cumulativeTime += travelTime + serviceTime;
      currentPos = bestIdx + 1; // +1 because driver location is index 0
    }

    // Check if route changed
    const oldOrder = stops.map(s => s.currentOrder).join(',');
    const newOrder = optimizedRoute.map(i => i + 1).join(',');
    const routeChanged = oldOrder !== newOrder;

    // Calculate ETAs based on optimized route
    let currentPosition = 0; // Driver location
    let accumulatedMinutes = currentMinutes;
    
    // Update stop_order and ETAs in database (continuing from completed stops)
    const updates = [];
    for (let i = 0; i < optimizedRoute.length; i++) {
      const stopIdx = optimizedRoute[i];
      const stop = stops[stopIdx];
      const newStopOrder = startingStopOrder + i + 1; // Continue from completed stops

      // Calculate travel duration (don't calculate ETA on backend)
      const travelTime = Math.ceil(matrix[currentPosition][stopIdx].duration / 60);
      const serviceTime = stop.delivery.extra_time || 5;
      accumulatedMinutes += travelTime + serviceTime;

      // Update delivery with new stop_order only (no ETA)
      const updateData = {
        stop_order: newStopOrder
      };

      await base44.asServiceRole.entities.Delivery.update(stop.delivery.id, updateData);

      updates.push({
        deliveryId: stop.delivery.id,
        delivery_id: stop.delivery.delivery_id,
        oldOrder: stop.delivery.stop_order,
        newOrder: newStopOrder,
        cumulativeMinutes: accumulatedMinutes - currentMinutes,
        travelMinutes: travelTime,
        serviceMinutes: serviceTime
      });

      currentPosition = stopIdx + 1; // Move to next position in matrix
    }

    console.log(`✅ Route optimization complete - ${routeChanged ? 'CHANGED' : 'UNCHANGED'} (${updates.length} updates with durations)`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged,
      durationUpdates: updates,
      totalStops: stops.length,
      apiCallsMade: 1
    });

  } catch (error) {
    console.error('❌ Error optimizing route:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});