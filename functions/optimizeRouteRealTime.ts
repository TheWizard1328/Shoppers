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
    const { driverId, deliveryDate, currentLocalTime, startLocation, deviceTime } = await req.json();
    console.log('📦 [optimizeRouteRealTime] Request params:', { driverId, deliveryDate, currentLocalTime, startLocation, deviceTime });

    if (!driverId || !deliveryDate) {
      console.error('❌ [optimizeRouteRealTime] Missing parameters:', { driverId, deliveryDate });
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('✅ [optimizeRouteRealTime] Parameters validated');

    // CRITICAL: Use device's local time - ALWAYS prefer deviceTime over currentLocalTime
    let currentMinutes;
    if (deviceTime) {
      const deviceDate = new Date(deviceTime);
      currentMinutes = deviceDate.getHours() * 60 + deviceDate.getMinutes();
      console.log(`🕐 Using device local time: ${deviceDate.toLocaleTimeString()} (${currentMinutes} minutes)`);
    } else if (currentLocalTime) {
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
      console.log(`🕐 Using client local time string: ${currentLocalTime} (${currentMinutes} minutes)`);
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

    // Update completed deliveries with sequential stop_order + display_stop_order
    for (let i = 0; i < completedDeliveries.length; i++) {
      const delivery = completedDeliveries[i];
      const sequentialOrder = i + 1;
      
      // Update both stop_order and display_stop_order if either changed
      if (delivery.stop_order !== sequentialOrder || delivery.display_stop_order !== sequentialOrder) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, {
          stop_order: sequentialOrder,
          display_stop_order: sequentialOrder
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

    // Build stops array with coordinates and time windows
    const stops = deliveries.map((delivery, idx) => {
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

      let timeWindow = null;
      if (delivery.time_window_start && delivery.time_window_end) {
        const [startHours, startMinutes] = delivery.time_window_start.split(':').map(Number);
        const [endHours, endMinutes] = delivery.time_window_end.split(':').map(Number);
        timeWindow = {
          start: startHours * 60 + startMinutes,
          end: endHours * 60 + endMinutes
        };
      }

      return {
        delivery,
        lat,
        lng,
        timeWindow,
        currentOrder: delivery.stop_order
      };
    }).filter(s => s.lat && s.lng);

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
        pickupStops.push({ ...stop, idx: i, isISP: false });
      } else if (isISP) {
        ispDeliveryStops.push({ ...stop, idx: i, isISP: true });
      } else {
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

    // OPTIMIZATION: Use crow-flies distance for initial route optimization
    console.log('📐 [optimizeRouteRealTime] Building crow-flies distance matrix...');
    const allStopCoords = stops.map(s => ({ lat: s.lat, lng: s.lng }));
    const origins = [driverLocation, ...allStopCoords];
    const destinations = allStopCoords;

    // Build crow-flies distance/time matrix
    const crowFliesMatrix = origins.map(origin => 
      destinations.map(dest => {
        const distanceKm = calculateCrowFliesDistance(origin.lat, origin.lng, dest.lat, dest.lng);
        // Estimate duration: 40 km/h average speed = 1.5 minutes per km
        const durationSeconds = (distanceKm / 40) * 60 * 60;
        return {
          duration: durationSeconds,
          distance: distanceKm * 1000 // Convert to meters for consistency
        };
      })
    );
    console.log('✅ [optimizeRouteRealTime] Crow-flies matrix built (no API calls used)');

    // Group deliveries by their pickup store
    const deliveriesByPickup = new Map();
    deliveryStops.forEach(d => {
      const key = d.delivery.store_id;
      if (!deliveriesByPickup.has(key)) {
        deliveriesByPickup.set(key, []);
      }
      deliveriesByPickup.get(key).push(d);
    });

    // Get driver's home location for end-of-route optimization
    const driverHomeLocation = (driverAppUser.home_latitude && driverAppUser.home_longitude) 
      ? { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude }
      : null;

    // Constraint-based optimization algorithm using crow-flies distance
    const optimizedRoute = [];
    const unvisitedPickups = new Set(pickupStops.map(p => p.idx));
    const unvisitedISP = new Set(ispDeliveryStops.map(p => p.idx));
    let currentPos = 0; // Start from driver location
    let cumulativeTime = currentMinutes;

    // Build route: pickups with their deliveries + ISP deliveries inserted optimally
    while (unvisitedPickups.size > 0 || unvisitedISP.size > 0) {
      let bestIdx = -1;
      let bestScore = Infinity;
      let bestType = null;

      // Calculate remaining stops count for end-of-route optimization
      const totalRemainingStops = unvisitedPickups.size + unvisitedISP.size;

      // Consider all unvisited pickups - PRIORITY: Shortest distance
      for (const idx of unvisitedPickups) {
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][idx].duration / 60);
        let score = travelTime; // Base score is pure travel time/distance
        
        // Time window penalty (light) - only if we'd arrive VERY late
        const stop = stops[idx];
        const arrivalTime = cumulativeTime + travelTime;
        if (stop.timeWindow && arrivalTime > stop.timeWindow.end + 60) {
          score += (arrivalTime - stop.timeWindow.end - 60) * 0.2; // Very light penalty, only for extreme lateness
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
          bestType = 'pickup';
        }
      }

      // Consider ISP deliveries (can go anywhere) - PRIORITY: Shortest distance
      for (const idx of unvisitedISP) {
        const stop = stops[idx];
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][idx].duration / 60);
        const arrivalTime = cumulativeTime + travelTime;
        
        let score = travelTime; // Base score is pure travel time/distance
        
        // Time window penalty (moderate) - penalize arriving outside window
        if (stop.timeWindow) {
          if (arrivalTime < stop.timeWindow.start) {
            score += (stop.timeWindow.start - arrivalTime) * 0.1; // Light penalty for early arrival (wait time)
          } else if (arrivalTime > stop.timeWindow.end) {
            score += (arrivalTime - stop.timeWindow.end) * 0.5; // Moderate penalty for late arrival
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
        
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 15;
        cumulativeTime += travelTime;
        if (stops[bestIdx].timeWindow && !stops[bestIdx].delivery.puid && cumulativeTime < stops[bestIdx].timeWindow.start) {
          cumulativeTime = stops[bestIdx].timeWindow.start;
        }
        cumulativeTime += serviceTime;
        currentPos = bestIdx + 1;

        // Insert this pickup's deliveries using nearest-neighbor from pickup location
        const pickupStoreId = stops[bestIdx].delivery.store_id;
        const pickupDeliveries = deliveriesByPickup.get(pickupStoreId) || [];
        const unvisitedDeliveries = pickupDeliveries.filter(d => !optimizedRoute.includes(d.idx));
        
        // Optimize delivery sequence from this pickup using nearest-neighbor
        let pickupPos = currentPos; // Start from pickup location
        const remainingDelivs = [...unvisitedDeliveries];
        
        while (remainingDelivs.length > 0) {
          // Find nearest unvisited delivery from current position
          let nearestDeliv = null;
          let shortestTime = Infinity;
          
          for (const deliv of remainingDelivs) {
            const travelTime = crowFliesMatrix[pickupPos][deliv.idx].duration / 60;
            if (travelTime < shortestTime) {
              shortestTime = travelTime;
              nearestDeliv = deliv;
            }
          }
          
          if (!nearestDeliv) break;
          
          // Add nearest delivery to route
          optimizedRoute.push(nearestDeliv.idx);
          const travelTime = Math.ceil(crowFliesMatrix[pickupPos][nearestDeliv.idx].duration / 60);
          const serviceTime = nearestDeliv.delivery.extra_time || 5;
          cumulativeTime += travelTime;
          if (stops[nearestDeliv.idx].timeWindow && !stops[nearestDeliv.idx].delivery.puid && cumulativeTime < stops[nearestDeliv.idx].timeWindow.start) {
            cumulativeTime = stops[nearestDeliv.idx].timeWindow.start;
          }
          cumulativeTime += serviceTime;
          pickupPos = nearestDeliv.idx + 1;
          currentPos = pickupPos;
          
          // Remove from remaining
          const idx = remainingDelivs.indexOf(nearestDeliv);
          if (idx > -1) remainingDelivs.splice(idx, 1);
        }
      } else if (bestType === 'isp') {
        unvisitedISP.delete(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 5;
        cumulativeTime += travelTime;
        if (stops[bestIdx].timeWindow && !stops[bestIdx].delivery.puid && cumulativeTime < stops[bestIdx].timeWindow.start) {
          cumulativeTime = stops[bestIdx].timeWindow.start;
        }
        cumulativeTime += serviceTime;
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

    // NOW use Google Distance Matrix API for the final optimized route only
    console.log('🌐 [optimizeRouteRealTime] Calling Google API for final route distances...');
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const finalRouteCoords = optimizedRoute.map(idx => allStopCoords[idx]);
    const finalOrigins = [driverLocation, ...finalRouteCoords];
    const finalDestinations = finalRouteCoords;

    const finalOriginsStr = finalOrigins.map(o => `${o.lat},${o.lng}`).join('|');
    const finalDestinationsStr = finalDestinations.map(d => `${d.lat},${d.lng}`).join('|');

    const finalMatrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?` +
      `origins=${finalOriginsStr}&` +
      `destinations=${finalDestinationsStr}&` +
      `departure_time=now&` +
      `traffic_model=best_guess&` +
      `key=${googleMapsKey}`;

    const finalMatrixResponse = await fetch(finalMatrixUrl);
    const finalMatrixData = await finalMatrixResponse.json();

    // Increment API counter (only 1 call now instead of N calls)
    const updatedPolylineRecord = await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    });
    polylineRecord = updatedPolylineRecord;

    if (finalMatrixData.status !== 'OK') {
      console.error('❌ [optimizeRouteRealTime] Google API failed:', finalMatrixData.status);
      return Response.json({ 
        error: 'Failed to get final distance matrix',
        status: finalMatrixData.status
      }, { status: 500 });
    }

    // Build final distance/time matrix from Google API
    const finalMatrix = finalMatrixData.rows.map(row => 
      row.elements.map(el => ({
        duration: el.duration_in_traffic?.value || el.duration?.value || 999999,
        distance: el.distance?.value || 999999
      }))
    );
    console.log('✅ [optimizeRouteRealTime] Google API results received');

    // Update stop_order, display_stop_order, and ETAs with real Google distances
    const updates = [];
    let realCumulativeTime = currentMinutes;

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stopIdx = optimizedRoute[i];
      const stop = stops[stopIdx];
      const newStopOrder = startingStopOrder + i + 1;

      // Get real travel time from Google API
      const realTravelTimeSeconds = i === 0 
        ? finalMatrix[0][i].duration 
        : finalMatrix[i][i].duration;
      const realTravelTimeMinutes = Math.ceil(realTravelTimeSeconds / 60);
      const realDistanceKm = i === 0 
        ? finalMatrix[0][i].distance / 1000 
        : finalMatrix[i][i].distance / 1000;

      // Calculate real ETA
      realCumulativeTime += realTravelTimeMinutes;
      
      // Apply time window waiting
      if (stop.timeWindow && !stop.delivery.puid && realCumulativeTime < stop.timeWindow.start) {
        realCumulativeTime = stop.timeWindow.start;
      }
      
      const estimatedArrivalHHMM = `${String(Math.floor(realCumulativeTime / 60) % 24).padStart(2, '0')}:${String(realCumulativeTime % 60).padStart(2, '0')}`;
      
      // Add service time for next iteration
      const serviceTime = stop.delivery.extra_time || (stop.delivery.patient_id ? 5 : 15);
      realCumulativeTime += serviceTime;

      const updateData = {
        stop_order: newStopOrder,
        display_stop_order: newStopOrder,
        delivery_time_eta: estimatedArrivalHHMM
      };

      await base44.asServiceRole.entities.Delivery.update(stop.delivery.id, updateData);

      updates.push({
        deliveryId: stop.delivery.id,
        delivery_id: stop.delivery.delivery_id,
        patient_name: stop.delivery.patient_name || 'Pickup',
        oldOrder: stop.delivery.stop_order,
        newOrder: newStopOrder,
        newETA: estimatedArrivalHHMM
      });

      console.log(`✅ Updated stop #${newStopOrder}: ${stop.delivery.patient_name || 'Pickup'} (was #${stop.delivery.stop_order}) ETA: ${estimatedArrivalHHMM}`);
    }

    console.log(`✅ Route optimization complete - ${routeChanged ? 'CHANGED' : 'UNCHANGED'} (${updates.length} updates)`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged,
      durationUpdates: updates,
      totalStops: stops.length,
      apiCallsMade: polylineRecord.daily_generation_count,
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