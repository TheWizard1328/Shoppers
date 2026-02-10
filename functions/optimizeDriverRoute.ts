import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Dependency-Aware Route Optimization for Pharmacy Deliveries
 * 
 * RULES:
 * 1. Start location priority: Driver GPS → Last completed stop → Driver home
 * 2. Only optimize deliveries with status in_transit or en_route
 * 3. Stop types: pickup, delivery, isp_pickup, isp_delivery
 * 4. Dependencies:
 *    - ISP deliveries (patient has "(ISP)" in name/address/notes) must occur BEFORE their store pickup
 *    - Regular deliveries must occur AFTER their pickup (PUID)
 * 5. isNextDelivery lock: If a stop has isNextDelivery=true, it's first and used as new origin
 * 6. Optimization:
 *    - Branch-and-bound for ≤10 stops
 *    - Nearest-neighbor + 2-opt for >10 stops
 *    - Time window pruning during recursion
 * 7. After optimization: Single Google Directions API call for ETAs
 */

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { 
      driverId, 
      deliveryDate, 
      currentLocation = null,
      generatePolyline = false
    } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`🚀 Starting dependency-aware route optimization for driver ${driverId} on ${deliveryDate}`);

    // Get driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    // Get ALL deliveries for the driver and date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    });

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ 
        message: 'No deliveries found for optimization',
        optimizedCount: 0
      });
    }

    // CRITICAL: Early return if all deliveries are finished (route complete)
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const hasActiveDeliveries = allDeliveries.some(d => !finishedStatuses.includes(d.status));
    
    if (!hasActiveDeliveries) {
      console.log(`✅ Route complete - all ${allDeliveries.length} deliveries are finished. Skipping optimization.`);
      return Response.json({ 
        message: 'Route complete - all deliveries finished',
        optimizedCount: 0,
        routeComplete: true
      });
    }

    // Get patients and stores for coordinates and ISP detection
    const patientIds = [...new Set(allDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    const storeIds = [...new Set(allDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // STEP 1: Determine start location (priority: GPS → last completed → home)
    const completedDeliveries = allDeliveries
      .filter(d => d.status === 'completed')
      .sort((a, b) => (b.stop_order || 0) - (a.stop_order || 0));

    let startLocation = null;
    let startLocationSource = '';

    // Priority 1: Current GPS from parameter or AppUser
    if (currentLocation?.lat && currentLocation?.lng) {
      startLocation = { lat: currentLocation.lat, lng: currentLocation.lng };
      startLocationSource = 'current_gps_param';
    } else if (driverAppUser.current_latitude && driverAppUser.current_longitude) {
      startLocation = { lat: driverAppUser.current_latitude, lng: driverAppUser.current_longitude };
      startLocationSource = 'current_gps';
    }
    
    // Priority 2: Last completed stop
    if (!startLocation && completedDeliveries.length > 0) {
      const lastCompleted = completedDeliveries[0];
      if (lastCompleted.patient_id) {
        const patient = patientMap.get(lastCompleted.patient_id);
        if (patient?.latitude && patient?.longitude) {
          startLocation = { lat: patient.latitude, lng: patient.longitude };
          startLocationSource = 'last_completed_delivery';
        }
      } else if (lastCompleted.store_id) {
        const store = storeMap.get(lastCompleted.store_id);
        if (store?.latitude && store?.longitude) {
          startLocation = { lat: store.latitude, lng: store.longitude };
          startLocationSource = 'last_completed_pickup';
        }
      }
    }

    // Priority 3: Driver home
    if (!startLocation && driverAppUser.home_latitude && driverAppUser.home_longitude) {
      startLocation = { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude };
      startLocationSource = 'driver_home';
    }

    if (!startLocation) {
      return Response.json({ 
        error: 'Cannot determine start location',
        driverId 
      }, { status: 400 });
    }

    console.log(`📍 Start location: ${startLocationSource} (${startLocation.lat}, ${startLocation.lng})`);

    // STEP 2: Filter to only in_transit or en_route deliveries
    const stopsToOptimize = allDeliveries.filter(d => 
      d.status === 'in_transit' || d.status === 'en_route'
    );

    if (stopsToOptimize.length === 0) {
      return Response.json({ 
        message: 'No active deliveries to optimize',
        optimizedCount: 0
      });
    }

    console.log(`📋 Found ${stopsToOptimize.length} stops to optimize (in_transit/en_route)`);

    // STEP 3: Build stops with dependencies
    const stops = buildStopsWithDependencies(stopsToOptimize, patientMap, storeMap);
    console.log(`🔗 Built ${stops.length} stops with dependencies`);

    // STEP 4: Handle isNextDelivery lock
    let lockedFirstStop = null;
    let optimizableStops = stops;

    const nextDeliveryStop = stops.find(s => s.isNextDelivery);
    if (nextDeliveryStop) {
      lockedFirstStop = nextDeliveryStop;
      optimizableStops = stops.filter(s => s.id !== nextDeliveryStop.id);
      // Use the locked stop's location as the new origin for remaining optimization
      startLocation = { lat: lockedFirstStop.lat, lng: lockedFirstStop.lng };
      console.log(`🔒 Locked isNextDelivery: ${lockedFirstStop.id} (new origin for remaining stops)`);
    }

    // STEP 5: Run optimization algorithm
    let optimizedOrder;
    
    if (optimizableStops.length <= 1) {
      // No optimization needed
      optimizedOrder = optimizableStops.map(s => s.id);
    } else if (optimizableStops.length <= 10) {
      // Branch-and-bound for small routes
      console.log(`🔬 Using branch-and-bound for ${optimizableStops.length} stops`);
      optimizedOrder = branchAndBoundOptimize(optimizableStops, startLocation);
    } else {
      // Nearest-neighbor + 2-opt for larger routes
      console.log(`🏃 Using nearest-neighbor + 2-opt for ${optimizableStops.length} stops`);
      optimizedOrder = nearestNeighborWith2Opt(optimizableStops, startLocation);
    }

    // STEP 6: Prepend locked first stop if exists
    if (lockedFirstStop) {
      optimizedOrder = [lockedFirstStop.id, ...optimizedOrder];
    }

    console.log(`✅ Optimized order: ${optimizedOrder.length} stops`);

    // STEP 7: Call Google Directions API once for final ETAs
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    let apiCalls = 0;
    let etaUpdates = [];

    if (googleMapsKey && optimizedOrder.length > 0) {
      const etaResult = await calculateFinalETAs(
        optimizedOrder,
        stops,
        lockedFirstStop ? { lat: driverAppUser.current_latitude || driverAppUser.home_latitude, lng: driverAppUser.current_longitude || driverAppUser.home_longitude } : startLocation,
        googleMapsKey
      );
      apiCalls = etaResult.apiCalls;
      etaUpdates = etaResult.etaUpdates;
    }

    // STEP 8: Update stop_order and ETAs in database
    console.log(`💾 Updating ${optimizedOrder.length} stop orders and ETAs...`);
    
    for (let i = 0; i < optimizedOrder.length; i++) {
      const deliveryId = optimizedOrder[i];
      const etaUpdate = etaUpdates.find(e => e.deliveryId === deliveryId);
      
      const updateData = {
        stop_order: i + 1
      };
      
      if (etaUpdate?.eta) {
        updateData.delivery_time_eta = etaUpdate.eta;
      }
      
      await base44.asServiceRole.entities.Delivery.update(deliveryId, updateData);
    }

    // Log API usage
    // CRITICAL: Use local time without timezone offset
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const localTimestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    
    // Get user's AppUser record for user_name
    const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const userAppUser = userAppUsers?.[0];
    
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: localTimestamp,
      api_type: 'Directions',
      purpose: `Dependency-aware route optimization for driver ${driverAppUser.user_name || driverId}`,
      function_name: 'optimizeDriverRoute',
      user_id: user.id,
      user_name: userAppUser?.user_name || user.full_name,
      metadata: {
        driver_id: driverId,
        delivery_date: deliveryDate,
        stops_optimized: optimizedOrder.length,
        algorithm: optimizableStops.length <= 10 ? 'branch_and_bound' : 'nearest_neighbor_2opt',
        api_calls: apiCalls,
        start_location_source: startLocationSource,
        had_locked_stop: !!lockedFirstStop
      }
    });

    console.log(`\n✅ Route optimization complete!`);
    console.log(`   Stops optimized: ${optimizedOrder.length}`);
    console.log(`   API calls: ${apiCalls}`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      optimizedCount: optimizedOrder.length,
      optimizedOrder,
      apiCalls,
      etaUpdates: etaUpdates.length,
      startLocationSource,
      algorithm: optimizableStops.length <= 10 ? 'branch_and_bound' : 'nearest_neighbor_2opt'
    });

  } catch (error) {
    console.error('❌ Error in route optimization:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});

/**
 * Check if a patient is an ISP (has "(ISP)" in name, address, or notes)
 */
function isISPPatient(patient) {
  if (!patient) return false;
  const checkStr = `${patient.full_name || ''} ${patient.address || ''} ${patient.notes || ''}`.toLowerCase();
  return checkStr.includes('(isp)');
}

/**
 * Parse time string (HH:mm) to minutes since midnight
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length !== 2) return null;
  const [hours, minutes] = parts.map(Number);
  if (isNaN(hours) || isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Calculate crow-flies distance in km between two points
 */
function crowFliesDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Build stops array with all necessary attributes and dependencies
 */
function buildStopsWithDependencies(deliveries, patientMap, storeMap) {
  const stops = [];
  
  // First pass: Create all stops with basic info
  for (const delivery of deliveries) {
    let lat, lng, type;
    const patient = patientMap.get(delivery.patient_id);
    const store = storeMap.get(delivery.store_id);
    
    if (delivery.puid && delivery.stop_id) {
      // This is a pickup (has puid which IS the stop_id for pickups)
      // Actually, for pickups: stop_id is the pickup's own ID, puid links deliveries TO this pickup
      // Let me re-check: pickups have stop_id set, deliveries have puid pointing to pickup's stop_id
      
      // If this delivery has NO patient_id but HAS store_id, it's likely a pickup
      if (!delivery.patient_id && delivery.store_id) {
        lat = store?.latitude;
        lng = store?.longitude;
        type = 'pickup';
      } else {
        // It's a delivery with a PUID (linked to a pickup)
        lat = patient?.latitude;
        lng = patient?.longitude;
        
        // Check if ISP delivery
        if (isISPPatient(patient)) {
          type = 'isp_delivery';
        } else {
          type = 'delivery';
        }
      }
    } else if (!delivery.patient_id && delivery.store_id) {
      // Pickup (no patient, has store)
      lat = store?.latitude;
      lng = store?.longitude;
      type = 'pickup';
    } else {
      // Regular delivery
      lat = patient?.latitude;
      lng = patient?.longitude;
      
      if (isISPPatient(patient)) {
        type = 'isp_delivery';
      } else {
        type = 'delivery';
      }
    }

    if (!lat || !lng) {
      console.warn(`⚠️ Skipping delivery ${delivery.id} - no coordinates`);
      continue;
    }

    // CRITICAL: Use time_window_start if available, else delivery_time_start
    const timeWindowStart = parseTimeToMinutes(delivery.time_window_start || delivery.delivery_time_start);
    const timeWindowEnd = parseTimeToMinutes(delivery.time_window_end || delivery.delivery_time_end);

    stops.push({
      id: delivery.id,
      lat,
      lng,
      type,
      puid: delivery.puid || null,
      stopId: delivery.stop_id || null,
      storeId: delivery.store_id,
      timeWindowStart,
      timeWindowEnd,
      serviceTime: delivery.extra_time || 5,
      isNextDelivery: delivery.isNextDelivery || false,
      dependsOn: [], // Will be populated in second pass
      delivery: delivery // Store full delivery for accessing status later
    });
  }

  // Second pass: Build dependencies
  // Create lookup maps
  const stopsByStopId = new Map();
  const pickupsByStoreId = new Map();
  
  for (const stop of stops) {
    if (stop.stopId) {
      stopsByStopId.set(stop.stopId, stop);
    }
    if (stop.type === 'pickup') {
      if (!pickupsByStoreId.has(stop.storeId)) {
        pickupsByStoreId.set(stop.storeId, []);
      }
      pickupsByStoreId.get(stop.storeId).push(stop);
    }
  }

  // Apply dependency rules
  for (const stop of stops) {
    if (stop.type === 'isp_delivery') {
      // ISP deliveries must occur BEFORE their store pickup
      // So the store pickup depends on the ISP delivery
      const storePickups = pickupsByStoreId.get(stop.storeId) || [];
      for (const pickup of storePickups) {
        if (!pickup.dependsOn.includes(stop.id)) {
          pickup.dependsOn.push(stop.id);
          console.log(`🔗 Pickup ${pickup.id} depends on ISP delivery ${stop.id}`);
        }
      }
    } else if (stop.type === 'delivery' && stop.puid) {
      // Regular deliveries must occur AFTER their pickup
      const pickupStop = stopsByStopId.get(stop.puid);
      if (pickupStop) {
        stop.dependsOn.push(pickupStop.id);
        console.log(`🔗 Delivery ${stop.id} depends on pickup ${pickupStop.id}`);
      }
    }
  }

  return stops;
}

/**
 * Check if all dependencies for a stop have been visited
 */
function dependenciesSatisfied(stop, visitedIds) {
  return stop.dependsOn.every(depId => visitedIds.has(depId));
}

/**
 * Branch-and-bound optimization for ≤10 stops
 * Uses recursion with dependency checking and time window pruning
 */
function branchAndBoundOptimize(stops, startLocation) {
  const stopMap = new Map(stops.map(s => [s.id, s]));
  
  let bestOrder = null;
  let bestDistance = Infinity;
  
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  function recurse(currentLocation, visitedIds, currentOrder, currentDistance, currentTime) {
    // Base case: all stops visited
    if (currentOrder.length === stops.length) {
      if (currentDistance < bestDistance) {
        bestDistance = currentDistance;
        bestOrder = [...currentOrder];
      }
      return;
    }
    
    // Pruning: if current distance already exceeds best, stop
    if (currentDistance >= bestDistance) {
      return;
    }
    
    // Try each unvisited stop
    for (const stop of stops) {
      if (visitedIds.has(stop.id)) continue;
      
      // Check dependencies
      if (!dependenciesSatisfied(stop, visitedIds)) continue;
      
      // Calculate distance to this stop
      const dist = crowFliesDistance(currentLocation.lat, currentLocation.lng, stop.lat, stop.lng);
      const travelMinutes = Math.ceil(dist / 40 * 60); // ~40 km/h average
      let arrivalTime = currentTime + travelMinutes;
      
      // Time window pruning
      if (stop.timeWindowEnd !== null && arrivalTime > stop.timeWindowEnd) {
        // Would arrive too late, skip this branch
        continue;
      }
      
      // Wait if arriving before time window starts
      if (stop.timeWindowStart !== null && arrivalTime < stop.timeWindowStart) {
        arrivalTime = stop.timeWindowStart;
      }
      
      // Recurse
      visitedIds.add(stop.id);
      currentOrder.push(stop.id);
      
      recurse(
        { lat: stop.lat, lng: stop.lng },
        visitedIds,
        currentOrder,
        currentDistance + dist,
        arrivalTime + stop.serviceTime
      );
      
      // Backtrack
      currentOrder.pop();
      visitedIds.delete(stop.id);
    }
  }
  
  recurse(startLocation, new Set(), [], 0, currentMinutes);
  
  // If no valid order found (due to dependency cycles or impossible time windows), 
  // fall back to simple ordering
  if (!bestOrder) {
    console.warn('⚠️ Branch-and-bound found no valid order, using fallback');
    return fallbackOrder(stops, startLocation);
  }
  
  return bestOrder;
}

/**
 * Nearest-neighbor with 2-opt improvement for >10 stops
 */
function nearestNeighborWith2Opt(stops, startLocation) {
  const stopMap = new Map(stops.map(s => [s.id, s]));
  const order = [];
  const visitedIds = new Set();
  let currentLocation = startLocation;
  
  const now = new Date();
  let currentTime = now.getHours() * 60 + now.getMinutes();
  
  // Nearest-neighbor construction
  while (order.length < stops.length) {
    let bestStop = null;
    let bestDist = Infinity;
    
    for (const stop of stops) {
      if (visitedIds.has(stop.id)) continue;
      if (!dependenciesSatisfied(stop, visitedIds)) continue;
      
      const dist = crowFliesDistance(currentLocation.lat, currentLocation.lng, stop.lat, stop.lng);
      
      // Time window consideration (prefer stops we can reach in time)
      const travelMinutes = Math.ceil(dist / 40 * 60);
      const arrivalTime = currentTime + travelMinutes;
      
      // Penalize if we'd arrive too late
      let effectiveDist = dist;
      if (stop.timeWindowEnd !== null && arrivalTime > stop.timeWindowEnd) {
        effectiveDist += 1000; // Heavy penalty for late arrival
      }
      
      if (effectiveDist < bestDist) {
        bestDist = effectiveDist;
        bestStop = stop;
      }
    }
    
    if (!bestStop) {
      // No valid next stop found - try to find any unvisited stop
      for (const stop of stops) {
        if (!visitedIds.has(stop.id)) {
          bestStop = stop;
          break;
        }
      }
      if (!bestStop) break;
    }
    
    order.push(bestStop.id);
    visitedIds.add(bestStop.id);
    
    const travelMinutes = Math.ceil(bestDist / 40 * 60);
    currentTime += travelMinutes + bestStop.serviceTime;
    if (bestStop.timeWindowStart !== null && currentTime < bestStop.timeWindowStart) {
      currentTime = bestStop.timeWindowStart + bestStop.serviceTime;
    }
    
    currentLocation = { lat: bestStop.lat, lng: bestStop.lng };
  }
  
  // 2-opt improvement (only swap if dependencies allow)
  let improved = true;
  let iterations = 0;
  const maxIterations = 100;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    for (let i = 0; i < order.length - 2; i++) {
      for (let j = i + 2; j < order.length; j++) {
        // Check if swap is valid (dependencies still satisfied)
        const newOrder = twoOptSwap(order, i, j);
        if (isValidOrder(newOrder, stopMap) && calculateTotalDistance(newOrder, stopMap, startLocation) < calculateTotalDistance(order, stopMap, startLocation)) {
          order.splice(0, order.length, ...newOrder);
          improved = true;
        }
      }
    }
  }
  
  return order;
}

/**
 * 2-opt swap
 */
function twoOptSwap(order, i, j) {
  const newOrder = order.slice(0, i + 1);
  const reversed = order.slice(i + 1, j + 1).reverse();
  newOrder.push(...reversed);
  newOrder.push(...order.slice(j + 1));
  return newOrder;
}

/**
 * Check if an order respects all dependencies
 */
function isValidOrder(order, stopMap) {
  const visitedIds = new Set();
  for (const stopId of order) {
    const stop = stopMap.get(stopId);
    if (!stop) continue;
    if (!dependenciesSatisfied(stop, visitedIds)) {
      return false;
    }
    visitedIds.add(stopId);
  }
  return true;
}

/**
 * Calculate total crow-flies distance for an order
 */
function calculateTotalDistance(order, stopMap, startLocation) {
  let total = 0;
  let current = startLocation;
  
  for (const stopId of order) {
    const stop = stopMap.get(stopId);
    if (!stop) continue;
    total += crowFliesDistance(current.lat, current.lng, stop.lat, stop.lng);
    current = { lat: stop.lat, lng: stop.lng };
  }
  
  return total;
}

/**
 * Fallback ordering when optimization fails
 */
function fallbackOrder(stops, startLocation) {
  // Sort by: dependencies first, then by time window, then by distance
  const sorted = [...stops].sort((a, b) => {
    // Stops with no dependencies come first
    if (a.dependsOn.length !== b.dependsOn.length) {
      return a.dependsOn.length - b.dependsOn.length;
    }
    // Then by time window
    if (a.timeWindowStart !== null && b.timeWindowStart !== null) {
      return a.timeWindowStart - b.timeWindowStart;
    }
    if (a.timeWindowStart !== null) return -1;
    if (b.timeWindowStart !== null) return 1;
    // Then by distance from start
    const distA = crowFliesDistance(startLocation.lat, startLocation.lng, a.lat, a.lng);
    const distB = crowFliesDistance(startLocation.lat, startLocation.lng, b.lat, b.lng);
    return distA - distB;
  });
  
  return sorted.map(s => s.id);
}

/**
 * Calculate final ETAs using Google Directions API
 */
async function calculateFinalETAs(optimizedOrder, stops, startLocation, googleMapsKey) {
  try {
    const stopMap = new Map(stops.map(s => [s.id, s]));
    
    if (optimizedOrder.length === 0) {
      return { etaUpdates: [], apiCalls: 0 };
    }
    
    // Build waypoints
    const waypoints = optimizedOrder.map(id => {
      const stop = stopMap.get(id);
      return stop ? { id, lat: stop.lat, lng: stop.lng, serviceTime: stop.serviceTime, timeWindowStart: stop.timeWindowStart } : null;
    }).filter(Boolean);
    
    if (waypoints.length === 0) {
      return { etaUpdates: [], apiCalls: 0 };
    }
    
    const origin = `${startLocation.lat},${startLocation.lng}`;
    const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
    
    // Build intermediate waypoints (excluding destination)
    const intermediateWaypoints = waypoints.slice(0, -1);
    const waypointsStr = intermediateWaypoints.map(w => `${w.lat},${w.lng}`).join('|');
    
    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${origin}&` +
      `destination=${destination}&` +
      (waypointsStr ? `waypoints=${waypointsStr}&` : '') +
      `departure_time=now&` +
      `traffic_model=best_guess&` +
      `key=${googleMapsKey}`;
    
    const response = await fetch(directionsUrl);
    const data = await response.json();
    
    if (data.status !== 'OK' || !data.routes?.[0]) {
      console.error('❌ Google Directions API error:', data.status);
      return { etaUpdates: [], apiCalls: 1 };
    }
    
    const route = data.routes[0];
    const now = new Date();
    let cumulativeMinutes = now.getHours() * 60 + now.getMinutes();
    const etaUpdates = [];
    
    for (let i = 0; i < route.legs.length && i < waypoints.length; i++) {
      const leg = route.legs[i];
      const waypoint = waypoints[i];
      
      const durationSeconds = leg.duration_in_traffic?.value || leg.duration?.value || 0;
      const travelMinutes = Math.ceil(durationSeconds / 60);
      
      cumulativeMinutes += travelMinutes;
      
      // Apply time window waiting
      if (waypoint.timeWindowStart !== null && cumulativeMinutes < waypoint.timeWindowStart) {
        cumulativeMinutes = waypoint.timeWindowStart;
      }
      
      const etaHours = Math.floor(cumulativeMinutes / 60) % 24;
      const etaMinutesVal = cumulativeMinutes % 60;
      const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMinutesVal).padStart(2, '0')}`;
      
      etaUpdates.push({
        deliveryId: waypoint.id,
        eta
      });
      
      // Add service time
      cumulativeMinutes += waypoint.serviceTime;
    }
    
    console.log(`   📍 Calculated ETAs for ${etaUpdates.length} stops`);
    
    return { etaUpdates, apiCalls: 1 };
    
  } catch (error) {
    console.error('❌ Error calculating ETAs:', error);
    return { etaUpdates: [], apiCalls: 0 };
  }
}