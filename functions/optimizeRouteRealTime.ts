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
    const body = await req.json();
    const { driverId, deliveryDate, startLocation, excludeDeliveryIds, currentLocalTime, deviceTime } = body;
    const excludedIds = excludeDeliveryIds || [];
    console.log('📦 [optimizeRouteRealTime] Request params:', { driverId, deliveryDate, currentLocalTime, startLocation, deviceTime, excludeDeliveryIds: excludedIds.length });

    if (!driverId || !deliveryDate) {
      console.error('❌ [optimizeRouteRealTime] Missing parameters:', { driverId, deliveryDate });
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('✅ [optimizeRouteRealTime] Parameters validated');

    // CRITICAL: Use device's local time - prefer HH:mm string to avoid timezone conversion
    let currentMinutes;
    if (currentLocalTime) {
      // currentLocalTime format: "14:30" (already in local time)
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
      console.log(`🕐 Using device local time: ${currentLocalTime} (${currentMinutes} minutes)`);
    } else if (deviceTime) {
      // Fallback: extract from ISO string
      const timeMatch = deviceTime.match(/T(\d{2}):(\d{2})/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        currentMinutes = hours * 60 + minutes;
        console.log(`🕐 Using device time from ISO: ${hours}:${String(minutes).padStart(2, '0')} (${currentMinutes} minutes)`);
      } else {
        const now = new Date();
        currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        console.warn(`⚠️ Could not parse device time, using server UTC time`);
      }
    } else {
      const now = new Date();
      currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      console.warn(`⚠️ No local time provided, using server UTC time`);
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
    
    // CRITICAL: Find isNextDelivery stop - this is the anchor point for optimization
    const isNextDeliveryStop = allDeliveries.find(d => d.isNextDelivery === true && !finishedStatuses.includes(d.status));
    
    // CRITICAL: Determine if route has started (has in_transit or finished stops)
    const routeHasStarted = allDeliveries.some(d => 
      d.status === 'in_transit' || finishedStatuses.includes(d.status)
    );
    
    // Filter incomplete deliveries - EXCLUDE isNextDelivery stop from optimization
    let incompleteDeliveries;
    if (routeHasStarted) {
      // Route has started: exclude finished statuses AND isNextDelivery stop
      incompleteDeliveries = allDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && 
        (!isNextDeliveryStop || d.id !== isNextDeliveryStop.id)
      );
      console.log(`📊 Route HAS started - optimizing ${incompleteDeliveries.length} stops AFTER isNextDelivery`);
    } else {
      // Route has NOT started: exclude pending AND finished statuses (all stops will be optimized)
      incompleteDeliveries = allDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );
      console.log(`📊 Route NOT started - optimizing all ${incompleteDeliveries.length} active stops`);
    }

    console.log(`📊 Route breakdown: ${completedDeliveries.length} completed, ${isNextDeliveryStop ? 1 : 0} isNextDelivery (locked), ${incompleteDeliveries.length} to optimize`);

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

    // CRITICAL: Assign stop_order to isNextDelivery stop (right after completed)
    if (isNextDeliveryStop) {
      const nextStopOrder = completedDeliveries.length + 1;
      
      if (isNextDeliveryStop.stop_order !== nextStopOrder || isNextDeliveryStop.display_stop_order !== nextStopOrder) {
        await base44.asServiceRole.entities.Delivery.update(isNextDeliveryStop.id, {
          stop_order: nextStopOrder,
          display_stop_order: nextStopOrder
        });
        console.log(`✅ Locked isNextDelivery at stop_order #${nextStopOrder}: ${isNextDeliveryStop.patient_name || 'Pickup'}`);
      }
    }

    const startingStopOrder = completedDeliveries.length + (isNextDeliveryStop ? 1 : 0);
    console.log(`🎯 Optimizable stops will start from stop_order ${startingStopOrder + 1}`);

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

    // Separate pickups, deliveries with time constraints, and ISPs
    const pickupStops = [];
    const deliveryStopsWithTimeConstraints = [];
    const deliveryStopsWithoutTimeConstraints = [];
    const ispDeliveryStops = [];
    
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const notes = (stop.delivery.delivery_notes || '').toLowerCase();
      const patientName = (stop.delivery.patient_name || '').toLowerCase();
      const patientAddress = (stop.delivery.address || '').toLowerCase();
      
      // Detect ISP deliveries - check notes, patient name, and address
      const isISP = notes.includes('interstore') || notes.includes('isp') || notes.includes('isd') ||
                    patientName.includes('interstore') || patientName.includes('isp') || patientName.includes('isd') ||
                    patientAddress.includes('interstore') || patientAddress.includes('isp') || patientAddress.includes('isd');
      
      if (stop.delivery.puid && !stop.delivery.patient_id) {
        // Regular pickup
        pickupStops.push({ ...stop, idx: i, isISP: false });
      } else if (isISP) {
        // ISP delivery - optimize between stages
        ispDeliveryStops.push({ ...stop, idx: i, isISP: true });
      } else if (stop.delivery.patient_id) {
        // Patient delivery - check if it has a preset delivery_time_start
        const patient = patientMap.get(stop.delivery.patient_id);
        const hasPresetTimeStart = patient?.time_window_start || stop.delivery.time_window_start;
        
        if (hasPresetTimeStart) {
          // Has time constraint - may need to move to different stage
          deliveryStopsWithTimeConstraints.push({ ...stop, idx: i, isISP: false });
        } else {
          // No time constraint - flexible positioning after pickup
          deliveryStopsWithoutTimeConstraints.push({ ...stop, idx: i, isISP: false });
        }
      }
    }

    console.log(`📊 Stops breakdown: ${pickupStops.length} pickups, ${deliveryStopsWithTimeConstraints.length} deliveries w/ time constraints, ${deliveryStopsWithoutTimeConstraints.length} deliveries flexible, ${ispDeliveryStops.length} ISP deliveries`);

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

    // Group flexible deliveries by their pickup store (for immediate assignment after pickup)
    const flexibleDeliveriesByPickup = new Map();
    deliveryStopsWithoutTimeConstraints.forEach(d => {
      const key = d.delivery.store_id;
      if (!flexibleDeliveriesByPickup.has(key)) {
        flexibleDeliveriesByPickup.set(key, []);
      }
      flexibleDeliveriesByPickup.get(key).push(d);
    });
    
    // Group time-constrained deliveries by store (may be moved to other stages)
    const constrainedDeliveriesByPickup = new Map();
    deliveryStopsWithTimeConstraints.forEach(d => {
      const key = d.delivery.store_id;
      if (!constrainedDeliveriesByPickup.has(key)) {
        constrainedDeliveriesByPickup.set(key, []);
      }
      constrainedDeliveriesByPickup.get(key).push(d);
    });

    // Get driver's home location for end-of-route optimization
    const driverHomeLocation = (driverAppUser.home_latitude && driverAppUser.home_longitude) 
      ? { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude }
      : null;

    // STAGE-BASED OPTIMIZATION: Build route by optimizing each store's pickups and deliveries as stages
    const optimizedRoute = [];
    const unvisitedPickups = new Set(pickupStops.map(p => p.idx));
    const unvisitedISPs = new Set(ispDeliveryStops.map(p => p.idx));
    const processedFlexibleDeliveries = new Set();
    const processedConstrainedDeliveries = new Set();
    let currentPos = 0; // Start from driver location
    let cumulativeTime = currentMinutes;

    console.log('🎯 [Stage Optimization] Starting stage-based route building...');

    // Build route: stages (pickup + flexible deliveries) with ISPs and constrained deliveries inserted optimally
    while (unvisitedPickups.size > 0 || unvisitedISPs.size > 0 || processedFlexibleDeliveries.size < deliveryStopsWithoutTimeConstraints.length || processedConstrainedDeliveries.size < deliveryStopsWithTimeConstraints.length) {
      let bestIdx = -1;
      let bestScore = Infinity;
      let bestType = null;

      // PRIORITY 1: Consider unvisited pickups (start new stages)
      for (const idx of unvisitedPickups) {
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][idx].duration / 60);
        const stop = stops[idx];
        const arrivalTime = cumulativeTime + travelTime;
        
        let score = travelTime;
        
        // Time window handling - pickups MUST arrive within window (Rule 3)
        if (stop.timeWindow) {
          if (arrivalTime > stop.timeWindow.end) {
            score += 10000; // Very heavy penalty - pickup time window is critical
          } else if (arrivalTime < stop.timeWindow.start - 30) {
            score += 100; // Moderate penalty for being too early
          }
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
          bestType = 'pickup';
        }
      }

      // PRIORITY 2: Consider ISPs (can be inserted between stages)
      for (const idx of unvisitedISPs) {
        const stop = stops[idx];
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][idx].duration / 60);
        const arrivalTime = cumulativeTime + travelTime;
        
        // ISPs compete with pickups - use distance as primary factor
        let score = travelTime;
        
        // Respect time windows if present
        if (stop.timeWindow) {
          if (arrivalTime > stop.timeWindow.end) {
            score += 1000; // Heavy penalty for being late
          }
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
          bestType = 'isp';
        }
      }

      // PRIORITY 3: Consider time-constrained deliveries from PREVIOUS stages
      // These can only be added if their time window can be met
      for (const d of deliveryStopsWithTimeConstraints) {
        if (processedConstrainedDeliveries.has(d.idx)) continue;
        
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][d.idx].duration / 60);
        const arrivalTime = cumulativeTime + travelTime;
        
        let score = travelTime;
        
        // STRICT time window enforcement (Rules 4 & 5)
        if (d.timeWindow) {
          if (arrivalTime > d.timeWindow.end) {
            score += 10000; // Invalid - too late
          } else if (arrivalTime < d.timeWindow.start) {
            // Can deliver, but need to wait
            const waitTime = d.timeWindow.start - arrivalTime;
            score += waitTime * 2; // Moderate penalty for waiting
          }
        }
        
        // Only consider if score is reasonable
        if (score < bestScore) {
          bestScore = score;
          bestIdx = d.idx;
          bestType = 'constrained_delivery';
        }
      }

      if (bestIdx === -1) break;

      // Add the selected stop and process based on type
      if (bestType === 'pickup') {
        unvisitedPickups.delete(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const pickupStop = stops[bestIdx];
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][bestIdx].duration / 60);
        const serviceTime = pickupStop.delivery.extra_time || 15;
        
        cumulativeTime += travelTime;
        if (pickupStop.timeWindow && cumulativeTime < pickupStop.timeWindow.start) {
          cumulativeTime = pickupStop.timeWindow.start;
        }
        cumulativeTime += serviceTime;
        currentPos = bestIdx + 1;

        console.log(`📦 [Stage] Added pickup for store ${pickupStop.delivery.store_id} at cumulative time ${cumulativeTime} minutes`);

        // STAGE OPTIMIZATION: Add flexible deliveries for this pickup immediately after
        const pickupStoreId = pickupStop.delivery.store_id;
        const flexibleDeliveries = flexibleDeliveriesByPickup.get(pickupStoreId) || [];
        const constrainedDeliveries = constrainedDeliveriesByPickup.get(pickupStoreId) || [];
        
        // First, try to add flexible deliveries (no time constraints) - nearest neighbor
        const unvisitedFlexible = flexibleDeliveries.filter(d => !processedFlexibleDeliveries.has(d.idx));
        
        let pickupPos = currentPos;
        const remainingFlexible = [...unvisitedFlexible];
        
        while (remainingFlexible.length > 0) {
          let bestDeliv = null;
          let bestDelivScore = Infinity;
          
          for (const deliv of remainingFlexible) {
            const travelTime = crowFliesMatrix[pickupPos][deliv.idx].duration / 60;
            const score = travelTime; // Pure distance optimization for flexible deliveries
            
            if (score < bestDelivScore) {
              bestDelivScore = score;
              bestDeliv = deliv;
            }
          }
          
          if (!bestDeliv) break;
          
          optimizedRoute.push(bestDeliv.idx);
          processedFlexibleDeliveries.add(bestDeliv.idx);
          
          const travelTime = Math.ceil(crowFliesMatrix[pickupPos][bestDeliv.idx].duration / 60);
          const serviceTime = bestDeliv.delivery.extra_time || 5;
          cumulativeTime += travelTime;
          cumulativeTime += serviceTime;
          pickupPos = bestDeliv.idx + 1;
          currentPos = pickupPos;
          
          const idx = remainingFlexible.indexOf(bestDeliv);
          if (idx > -1) remainingFlexible.splice(idx, 1);
        }
        
        // Second, try to fit time-constrained deliveries for this pickup if they can be delivered now
        const unvisitedConstrained = constrainedDeliveries.filter(d => !processedConstrainedDeliveries.has(d.idx));
        
        for (const deliv of unvisitedConstrained) {
          const travelTime = Math.ceil(crowFliesMatrix[currentPos][deliv.idx].duration / 60);
          const arrivalTime = cumulativeTime + travelTime;
          
          // Check if delivery can be made within time window
          let canDeliverNow = true;
          if (deliv.timeWindow) {
            if (arrivalTime > deliv.timeWindow.end) {
              canDeliverNow = false; // Too late - defer to later stage
            }
          }
          
          if (canDeliverNow) {
            optimizedRoute.push(deliv.idx);
            processedConstrainedDeliveries.add(deliv.idx);
            
            const serviceTime = deliv.delivery.extra_time || 5;
            cumulativeTime += travelTime;
            if (deliv.timeWindow && cumulativeTime < deliv.timeWindow.start) {
              cumulativeTime = deliv.timeWindow.start; // Wait until window opens
            }
            cumulativeTime += serviceTime;
            currentPos = deliv.idx + 1;
            
            console.log(`⏰ [Stage] Added time-constrained delivery: ${deliv.delivery.patient_name} (can deliver now)`);
          } else {
            console.log(`⏰ [Stage] Deferring time-constrained delivery: ${deliv.delivery.patient_name} (would arrive too late)`);
          }
        }
        
        console.log(`✅ [Stage] Completed stage for pickup ${pickupStoreId}`);
        
      } else if (bestType === 'isp') {
        unvisitedISPs.delete(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 5;
        cumulativeTime += travelTime;
        if (stops[bestIdx].timeWindow && cumulativeTime < stops[bestIdx].timeWindow.start) {
          cumulativeTime = stops[bestIdx].timeWindow.start;
        }
        cumulativeTime += serviceTime;
        currentPos = bestIdx + 1;
        
        console.log(`🔀 [ISP] Added ISP delivery between stages: ${stops[bestIdx].delivery.patient_name}`);
        
      } else if (bestType === 'constrained_delivery') {
        processedConstrainedDeliveries.add(bestIdx);
        optimizedRoute.push(bestIdx);
        
        const travelTime = Math.ceil(crowFliesMatrix[currentPos][bestIdx].duration / 60);
        const serviceTime = stops[bestIdx].delivery.extra_time || 5;
        cumulativeTime += travelTime;
        if (stops[bestIdx].timeWindow && cumulativeTime < stops[bestIdx].timeWindow.start) {
          cumulativeTime = stops[bestIdx].timeWindow.start;
        }
        cumulativeTime += serviceTime;
        currentPos = bestIdx + 1;
        
        console.log(`⏰ [Constrained] Added time-constrained delivery: ${stops[bestIdx].delivery.patient_name}`);
      }
    }

    console.log(`✅ [Stage Optimization] Route built with ${optimizedRoute.length} stops across all stages`);

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

    // Log API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Distance Matrix',
      purpose: `Optimizing route for driver ${driverAppUser.user_name || driverId}`,
      function_name: 'optimizeRouteRealTime',
      user_id: user.id,
      user_name: user.full_name,
      metadata: {
        driver_id: driverId,
        delivery_date: deliveryDate,
        stops_count: optimizedRoute.length,
        route_changed: routeChanged
      }
    });

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

    // CRITICAL: Calculate start time for ETA calculations
    // Priority: Use isNextDelivery's ETA + service time as starting point
    let realCumulativeTime = currentMinutes;
    if (isNextDeliveryStop) {
      // Use isNextDelivery's ETA (will be calculated by backend) as starting time for remaining stops
      // For now, use current time - backend will update this stop's ETA first
      console.log(`⏰ Will calculate remaining ETAs from isNextDelivery stop's ETA`);
    }

    // STEP 1: Calculate ETA for isNextDelivery stop first (if exists)
    if (isNextDeliveryStop) {
      // CRITICAL: Don't recalculate ETA for isNextDelivery when it's just been started
      // The delivery_time_start is already set correctly by the frontend
      // We only need to calculate ETAs for REMAINING stops after this one
      
      // Add service time for next iteration (skip ETA calculation for isNextDelivery)
      const serviceTime = isNextDeliveryStop.extra_time || (isNextDeliveryStop.patient_id ? 5 : 15);
      realCumulativeTime += serviceTime;
      
      console.log(`⏩ Skipped ETA update for isNextDelivery (already started), using cumulative time + service: ${realCumulativeTime} minutes`);
    }

    // STEP 2: Update remaining optimized stops with stop_order and ETAs
    const updates = [];

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stopIdx = optimizedRoute[i];
      const stop = stops[stopIdx];
      const newStopOrder = startingStopOrder + i + 1;

      // Get real travel time from Google API
      // CRITICAL: For first stop in optimized route, calculate from isNextDelivery location (not driver location)
      let realTravelTimeSeconds;
      if (i === 0 && isNextDeliveryStop) {
        // Find isNextDelivery in stops array to use as origin
        const nextDeliveryIdx = stops.findIndex(s => s.delivery.id === isNextDeliveryStop.id);
        if (nextDeliveryIdx >= 0) {
          // Use distance matrix row for isNextDelivery as origin
          realTravelTimeSeconds = finalMatrix[nextDeliveryIdx + 1][stopIdx].duration;
        } else {
          realTravelTimeSeconds = finalMatrix[0][stopIdx].duration;
        }
      } else {
        realTravelTimeSeconds = i === 0 
          ? finalMatrix[0][stopIdx].duration 
          : finalMatrix[stopIdx][stopIdx].duration;
      }
      
      const realTravelTimeMinutes = Math.ceil(realTravelTimeSeconds / 60);

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
      optimizedRoute: updates.map(u => ({ 
        deliveryId: u.deliveryId, 
        delivery_id: u.delivery_id, 
        travelMinutes: u.travelMinutes, 
        serviceMinutes: u.serviceMinutes, 
        stopOrder: u.stopOrder 
      })),
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