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
 * Recursive algorithm to find the shortest path through a set of stops
 * Uses branch-and-bound with pruning for efficiency
 * @param {Object} origin - Starting point {lat, lng}
 * @param {Array} stops - Array of stops to visit [{lat, lng, idx, ...}]
 * @param {Object} destination - End point {lat, lng} (next pickup or home)
 * @param {number} currentTime - Current cumulative time in minutes
 * @returns {Object} - {path: [...indices], totalDistance: number}
 */
const findShortestPath = (origin, stops, destination, currentTime) => {
  const n = stops.length;
  
  // Base case: no stops to visit
  if (n === 0) {
    if (destination) {
      const dist = calculateCrowFliesDistance(origin.lat, origin.lng, destination.lat, destination.lng);
      return { path: [], totalDistance: dist };
    }
    return { path: [], totalDistance: 0 };
  }
  
  // For small number of stops (<=8), use exact permutation search
  // For larger sets, use nearest-neighbor with look-ahead
  if (n <= 8) {
    return findShortestPathExact(origin, stops, destination, currentTime);
  } else {
    return findShortestPathHeuristic(origin, stops, destination, currentTime);
  }
};

/**
 * Exact permutation search for small stop sets (n <= 8)
 * Tests all permutations to find the absolute shortest path
 */
const findShortestPathExact = (origin, stops, destination, currentTime) => {
  let bestPath = null;
  let bestDistance = Infinity;
  
  // Generate all permutations and find shortest total distance
  const permute = (arr, current = [], currentDist = 0, lastPos = origin) => {
    // Pruning: if current distance already exceeds best, abandon this branch
    if (currentDist >= bestDistance) return;
    
    if (arr.length === 0) {
      // Calculate final leg to destination
      let finalDist = currentDist;
      if (destination) {
        finalDist += calculateCrowFliesDistance(lastPos.lat, lastPos.lng, destination.lat, destination.lng);
      }
      
      if (finalDist < bestDistance) {
        bestDistance = finalDist;
        bestPath = [...current];
      }
      return;
    }
    
    for (let i = 0; i < arr.length; i++) {
      const stop = arr[i];
      const remaining = [...arr.slice(0, i), ...arr.slice(i + 1)];
      const legDist = calculateCrowFliesDistance(lastPos.lat, lastPos.lng, stop.lat, stop.lng);
      
      // Check time window constraints
      const travelMinutes = (legDist / 40) * 60; // ~40 km/h average
      const arrivalTime = currentTime + travelMinutes;
      
      // Skip if we'd arrive too late for a time window
      if (stop.timeWindow && arrivalTime > stop.timeWindow.end + 30) {
        continue; // Prune this branch - we'd be too late
      }
      
      permute(
        remaining, 
        [...current, stop.idx], 
        currentDist + legDist, 
        { lat: stop.lat, lng: stop.lng }
      );
    }
  };
  
  permute(stops);
  
  return { path: bestPath || stops.map(s => s.idx), totalDistance: bestDistance };
};

/**
 * Heuristic search for larger stop sets (n > 8)
 * Uses nearest-neighbor with 2-opt improvement
 */
const findShortestPathHeuristic = (origin, stops, destination, currentTime) => {
  // Start with nearest-neighbor
  const visited = [];
  const unvisited = [...stops];
  let currentPos = origin;
  let totalDistance = 0;
  
  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    
    for (let i = 0; i < unvisited.length; i++) {
      const dist = calculateCrowFliesDistance(currentPos.lat, currentPos.lng, unvisited[i].lat, unvisited[i].lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }
    
    const nearest = unvisited.splice(nearestIdx, 1)[0];
    visited.push(nearest);
    totalDistance += nearestDist;
    currentPos = { lat: nearest.lat, lng: nearest.lng };
  }
  
  // Add final leg to destination
  if (destination) {
    totalDistance += calculateCrowFliesDistance(currentPos.lat, currentPos.lng, destination.lat, destination.lng);
  }
  
  // 2-opt improvement (swap pairs to reduce crossings)
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < visited.length - 1; i++) {
      for (let j = i + 2; j < visited.length; j++) {
        const newDist = calculate2OptSwapDistance(origin, visited, destination, i, j);
        if (newDist < totalDistance) {
          // Perform the swap
          const newPath = [
            ...visited.slice(0, i + 1),
            ...visited.slice(i + 1, j + 1).reverse(),
            ...visited.slice(j + 1)
          ];
          visited.splice(0, visited.length, ...newPath);
          totalDistance = newDist;
          improved = true;
        }
      }
    }
  }
  
  return { path: visited.map(s => s.idx), totalDistance };
};

/**
 * Calculate total distance after a 2-opt swap
 */
const calculate2OptSwapDistance = (origin, path, destination, i, j) => {
  let dist = 0;
  let prev = origin;
  
  // Before swap segment
  for (let k = 0; k <= i; k++) {
    dist += calculateCrowFliesDistance(prev.lat, prev.lng, path[k].lat, path[k].lng);
    prev = { lat: path[k].lat, lng: path[k].lng };
  }
  
  // Reversed segment
  for (let k = j; k > i; k--) {
    dist += calculateCrowFliesDistance(prev.lat, prev.lng, path[k].lat, path[k].lng);
    prev = { lat: path[k].lat, lng: path[k].lng };
  }
  
  // After swap segment
  for (let k = j + 1; k < path.length; k++) {
    dist += calculateCrowFliesDistance(prev.lat, prev.lng, path[k].lat, path[k].lng);
    prev = { lat: path[k].lat, lng: path[k].lng };
  }
  
  // Final leg to destination
  if (destination) {
    dist += calculateCrowFliesDistance(prev.lat, prev.lng, destination.lat, destination.lng);
  }
  
  return dist;
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
    
    // CRITICAL: Determine if route has started (has in_transit, en_route, or finished stops)
    const routeHasStarted = allDeliveries.some(d => 
      d.status === 'in_transit' || d.status === 'en_route' || finishedStatuses.includes(d.status)
    );
    
    // Filter incomplete deliveries - EXCLUDE isNextDelivery stop from optimization
    // Include ALL non-finished stops: pending, en_route, in_transit (except isNextDelivery)
    const incompleteDeliveries = allDeliveries.filter(d => 
      !finishedStatuses.includes(d.status) && 
      (!isNextDeliveryStop || d.id !== isNextDeliveryStop.id)
    );
    console.log(`📊 Route ${routeHasStarted ? 'HAS' : 'NOT'} started - optimizing ${incompleteDeliveries.length} stops (excluding isNextDelivery)`);
    console.log(`📊 Statuses in incomplete: ${[...new Set(incompleteDeliveries.map(d => d.status))].join(', ')}`)

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

    // ═══════════════════════════════════════════════════════════════════════════════
    // STAGE-BASED RECURSIVE OPTIMIZATION
    // ═══════════════════════════════════════════════════════════════════════════════
    // Strategy: Optimize in STAGES, where each stage is:
    //   Origin (current position) → Deliveries → Next Pickup (or Home if no more pickups)
    // 
    // CRITICAL: isNextDelivery stop is LOCKED and always comes first after driver location.
    // Optimization only applies to stops AFTER the isNextDelivery stop.
    // ═══════════════════════════════════════════════════════════════════════════════
    
    const optimizedRoute = [];
    const completedPickupStores = new Set();
    let currentPosition = { lat: driverLocation.lat, lng: driverLocation.lng };
    let cumulativeTime = currentMinutes;

    // CRITICAL: If isNextDelivery exists, it's LOCKED as first stop - start optimization from there
    let isNextDeliveryStopData = null;
    if (isNextDeliveryStop) {
      // Find isNextDelivery in the stops array
      isNextDeliveryStopData = stops.find(s => s.delivery.id === isNextDeliveryStop.id);
      
      if (isNextDeliveryStopData) {
        console.log(`🔒 [isNextDelivery LOCKED] ${isNextDeliveryStopData.delivery.patient_name || 'Pickup'} - maintaining position as Stop #${startingStopOrder + 1}`);
        
        // Add isNextDelivery to route first (it's locked)
        optimizedRoute.push(isNextDeliveryStopData.idx);
        
        // If it's a pickup, mark that store's deliveries as available
        if (isNextDeliveryStopData.delivery.puid && !isNextDeliveryStopData.delivery.patient_id) {
          completedPickupStores.add(isNextDeliveryStopData.delivery.store_id);
        }
        
        // Update position to isNextDelivery location for subsequent optimization
        currentPosition = { lat: isNextDeliveryStopData.lat, lng: isNextDeliveryStopData.lng };
        
        // Update cumulative time
        const travelDist = calculateCrowFliesDistance(driverLocation.lat, driverLocation.lng, isNextDeliveryStopData.lat, isNextDeliveryStopData.lng);
        const travelMinutes = (travelDist / 40) * 60;
        cumulativeTime += travelMinutes;
        
        if (isNextDeliveryStopData.timeWindow && cumulativeTime < isNextDeliveryStopData.timeWindow.start) {
          cumulativeTime = isNextDeliveryStopData.timeWindow.start;
        }
        
        const serviceTime = isNextDeliveryStopData.delivery.extra_time || (isNextDeliveryStopData.delivery.patient_id ? 5 : 15);
        cumulativeTime += serviceTime;
      }
    }

    // CRITICAL: Sort pickups AFTER determining currentPosition (which is after isNextDelivery)
    // This ensures distances are calculated from the correct starting point
    // Sort pickups by delivery_time_start (scheduled pickup time), then by distance as tiebreaker
    const sortPickupsFromPosition = (position) => {
      return [...pickupStops]
        .filter(p => !isNextDeliveryStopData || p.idx !== isNextDeliveryStopData.idx) // Exclude isNextDelivery if it was a pickup
        .sort((a, b) => {
          // Parse delivery_time_start for both pickups
          const aTimeStart = a.delivery.delivery_time_start;
          const bTimeStart = b.delivery.delivery_time_start;
          
          // Convert to minutes for comparison
          let aMinutes = Infinity;
          let bMinutes = Infinity;
          
          if (aTimeStart) {
            const [aH, aM] = aTimeStart.split(':').map(Number);
            aMinutes = aH * 60 + aM;
          }
          if (bTimeStart) {
            const [bH, bM] = bTimeStart.split(':').map(Number);
            bMinutes = bH * 60 + bM;
          }
          
          // Primary sort: by scheduled pickup time
          if (aMinutes !== bMinutes) {
            return aMinutes - bMinutes;
          }
          
          // Tiebreaker: by distance from provided position
          const distA = calculateCrowFliesDistance(position.lat, position.lng, a.lat, a.lng);
          const distB = calculateCrowFliesDistance(position.lat, position.lng, b.lat, b.lng);
          return distA - distB;
        });
    };
    
    // Initial sort using current position (will be updated after isNextDelivery is processed)
    let sortedPickups = sortPickupsFromPosition(currentPosition);
    
    console.log('📦 Initial pickup order by delivery_time_start (from driver location):');
    sortedPickups.forEach((p, i) => {
      console.log(`   ${i+1}. ${p.delivery.patient_name || 'Pickup'} @ ${p.delivery.delivery_time_start || 'no time'}`);
    });

    console.log('🎯 [Stage-Based Optimization] Starting recursive optimization...');
    console.log(`📊 Total: ${pickupStops.length} pickups, ${deliveryStopsWithoutTimeConstraints.length} flexible, ${deliveryStopsWithTimeConstraints.length} constrained, ${ispDeliveryStops.length} ISPs`);
    if (isNextDeliveryStopData) {
      console.log(`🔒 isNextDelivery is locked - optimizing ${stops.length - 1} remaining stops`);
    }

    // Track unvisited stops (exclude isNextDelivery if it exists)
    let unvisitedPickups = new Set(sortedPickups.map(p => p.idx));
    const unvisitedFlexible = new Set(
      deliveryStopsWithoutTimeConstraints
        .filter(d => !isNextDeliveryStopData || d.idx !== isNextDeliveryStopData.idx)
        .map(d => d.idx)
    );
    const unvisitedConstrained = new Set(
      deliveryStopsWithTimeConstraints
        .filter(d => !isNextDeliveryStopData || d.idx !== isNextDeliveryStopData.idx)
        .map(d => d.idx)
    );
    const unvisitedISPs = new Set(
      ispDeliveryStops
        .filter(d => !isNextDeliveryStopData || d.idx !== isNextDeliveryStopData.idx)
        .map(d => d.idx)
    );
    
    // CRITICAL: Re-sort pickups to ensure correct order before optimization
    // Sort by delivery_time_start (scheduled pickup time) - this is the primary sort
    console.log(`\n🔄 Ensuring pickups are in correct scheduled order...`);
    sortedPickups = sortPickupsFromPosition(currentPosition);
    unvisitedPickups = new Set(sortedPickups.map(p => p.idx));
    
    console.log('📦 Pickup order by delivery_time_start:');
    sortedPickups.forEach((p, i) => {
      console.log(`   ${i+1}. ${p.delivery.patient_name || 'Pickup'} @ ${p.delivery.delivery_time_start || 'no time'}`);
    });

    // HYBRID OPTIMIZATION:
    // - Pickups: Maintain original order by delivery_time_start (already sorted in sortedPickups)
    // - Deliveries: 
    //   * in_transit deliveries: Keep immediately after their pickup (LOCKED position)
    //   * Pending/other deliveries: Optimize with shortest path after all in_transit for their store
    while (unvisitedPickups.size > 0 || unvisitedFlexible.size > 0 || unvisitedConstrained.size > 0 || unvisitedISPs.size > 0) {
      
      // STEP 1: Get next pickup in scheduled order
      let nextScheduledPickup = null;
      for (const sortedPickup of sortedPickups) {
        if (unvisitedPickups.has(sortedPickup.idx)) {
          nextScheduledPickup = sortedPickup;
          break;
        }
      }
      
      console.log(`\n📍 [Hybrid] Next pickup: ${nextScheduledPickup?.delivery.patient_name || 'None'}`);
      
      // STEP 2: Collect deliveries - separate in_transit from others
      const inTransitDeliveriesForStore = [];
      const availableOtherDeliveries = [];
      
      // CRITICAL: If a pickup exists, check for in_transit deliveries from its store FIRST
      if (nextScheduledPickup) {
        // Get in_transit deliveries from this pickup's store
        for (const idx of unvisitedFlexible) {
          const deliv = deliveryStopsWithoutTimeConstraints.find(d => d.idx === idx);
          if (deliv && deliv.delivery.store_id === nextScheduledPickup.delivery.store_id && deliv.delivery.status === 'in_transit') {
            inTransitDeliveriesForStore.push(deliv);
          }
        }
        for (const idx of unvisitedConstrained) {
          const deliv = deliveryStopsWithTimeConstraints.find(d => d.idx === idx);
          if (deliv && deliv.delivery.store_id === nextScheduledPickup.delivery.store_id && deliv.delivery.status === 'in_transit') {
            inTransitDeliveriesForStore.push(deliv);
          }
        }
        
        console.log(`   📦 Found ${inTransitDeliveriesForStore.length} in_transit deliveries for upcoming pickup (${nextScheduledPickup.delivery.patient_name || 'Pickup'})`);
      }
      
      // Collect other available deliveries (whose pickup is already completed, excluding in_transit)
      for (const idx of unvisitedFlexible) {
        const deliv = deliveryStopsWithoutTimeConstraints.find(d => d.idx === idx);
        if (deliv && completedPickupStores.has(deliv.delivery.store_id) && deliv.delivery.status !== 'in_transit') {
          availableOtherDeliveries.push(deliv);
        }
      }
      
      for (const idx of unvisitedConstrained) {
        const deliv = deliveryStopsWithTimeConstraints.find(d => d.idx === idx);
        if (deliv && completedPickupStores.has(deliv.delivery.store_id) && deliv.delivery.status !== 'in_transit') {
          availableOtherDeliveries.push(deliv);
        }
      }
      
      for (const idx of unvisitedISPs) {
        const isp = ispDeliveryStops.find(d => d.idx === idx);
        if (isp) {
          availableOtherDeliveries.push(isp);
        }
      }
      
      console.log(`   📍 Available OTHER deliveries (non in_transit): ${availableOtherDeliveries.length}`);
      
      // STEP 3: Decision - handle in_transit deliveries OR optimize other deliveries OR go to next pickup
      
      if (availableDeliveries.length > 0) {
        // Check if next pickup has a time constraint we need to respect
        let pickupTimeUrgent = false;
        
        if (nextScheduledPickup && nextScheduledPickup.delivery.delivery_time_start) {
          const pickupDistance = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, nextScheduledPickup.lat, nextScheduledPickup.lng);
          const [h, m] = nextScheduledPickup.delivery.delivery_time_start.split(':').map(Number);
          const pickupTimeMinutes = h * 60 + m;
          const travelToPickupMinutes = (pickupDistance / 40) * 60;
          const arrivalAtPickup = cumulativeTime + travelToPickupMinutes;
          
          // If we'd arrive late to pickup, prioritize it
          if (arrivalAtPickup > pickupTimeMinutes + 15) {
            pickupTimeUrgent = true;
            console.log(`   ⚠️ Pickup time urgent! Scheduled: ${nextScheduledPickup.delivery.delivery_time_start}`);
          }
        }
        
        if (pickupTimeUrgent && nextScheduledPickup) {
          // Go to pickup immediately
          optimizedRoute.push(nextScheduledPickup.idx);
          unvisitedPickups.delete(nextScheduledPickup.idx);
          completedPickupStores.add(nextScheduledPickup.delivery.store_id);
          
          const travelDist = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, nextScheduledPickup.lat, nextScheduledPickup.lng);
          cumulativeTime += (travelDist / 40) * 60;
          
          if (nextScheduledPickup.delivery.delivery_time_start) {
            const [h, m] = nextScheduledPickup.delivery.delivery_time_start.split(':').map(Number);
            if (cumulativeTime < h * 60 + m) cumulativeTime = h * 60 + m;
          }
          
          cumulativeTime += nextScheduledPickup.delivery.extra_time || 15;
          currentPosition = { lat: nextScheduledPickup.lat, lng: nextScheduledPickup.lng };
          console.log(`   ✅ Going to urgent pickup: ${nextScheduledPickup.delivery.patient_name || 'Pickup'}`);
        } else {
          // USE SHORTEST PATH ALGORITHM for all available deliveries toward next pickup
          const stageDestination = nextScheduledPickup 
            ? { lat: nextScheduledPickup.lat, lng: nextScheduledPickup.lng }
            : driverHomeLocation;
          
          console.log(`   🔄 Finding optimal path through ${availableDeliveries.length} deliveries...`);
          
          const { path: optimizedPath, totalDistance } = findShortestPath(
            currentPosition,
            availableDeliveries,
            stageDestination,
            cumulativeTime
          );
          
          console.log(`   ✅ Optimal path found: ${optimizedPath.length} stops, ~${totalDistance.toFixed(1)} km total`);
          
          // Add ALL optimized deliveries to route
          for (const idx of optimizedPath) {
            const stop = stops[idx];
            optimizedRoute.push(idx);
            
            unvisitedFlexible.delete(idx);
            unvisitedConstrained.delete(idx);
            unvisitedISPs.delete(idx);
            
            const travelDist = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, stop.lat, stop.lng);
            cumulativeTime += (travelDist / 40) * 60;
            
            if (stop.timeWindow && cumulativeTime < stop.timeWindow.start) {
              cumulativeTime = stop.timeWindow.start;
            }
            
            cumulativeTime += stop.delivery.extra_time || 5;
            currentPosition = { lat: stop.lat, lng: stop.lng };
            
            console.log(`      📬 ${stop.delivery.patient_name || 'Delivery'}`);
          }
        }
      } else if (nextScheduledPickup) {
        // No available deliveries, go to next scheduled pickup
        optimizedRoute.push(nextScheduledPickup.idx);
        unvisitedPickups.delete(nextScheduledPickup.idx);
        completedPickupStores.add(nextScheduledPickup.delivery.store_id);
        
        const travelDist = calculateCrowFliesDistance(currentPosition.lat, currentPosition.lng, nextScheduledPickup.lat, nextScheduledPickup.lng);
        cumulativeTime += (travelDist / 40) * 60;
        
        if (nextScheduledPickup.delivery.delivery_time_start) {
          const [h, m] = nextScheduledPickup.delivery.delivery_time_start.split(':').map(Number);
          if (cumulativeTime < h * 60 + m) {
            console.log(`   ⏳ Waiting at pickup until ${nextScheduledPickup.delivery.delivery_time_start}`);
            cumulativeTime = h * 60 + m;
          }
        }
        
        cumulativeTime += nextScheduledPickup.delivery.extra_time || 15;
        currentPosition = { lat: nextScheduledPickup.lat, lng: nextScheduledPickup.lng };
        
        console.log(`   ✅ Going to next pickup: ${nextScheduledPickup.delivery.patient_name || 'Pickup'}`);
      } else {
        break;
      }
    }

    // Final pass: any remaining deliveries after all pickups
    const remainingDeliveries = [];
    for (const idx of unvisitedFlexible) {
      const stop = stops[idx];
      remainingDeliveries.push({ ...stop, idx });
    }
    for (const idx of unvisitedConstrained) {
      const stop = stops[idx];
      remainingDeliveries.push({ ...stop, idx });
    }
    for (const idx of unvisitedISPs) {
      const stop = stops[idx];
      remainingDeliveries.push({ ...stop, idx });
    }

    if (remainingDeliveries.length > 0) {
      console.log(`\n📍 [Final Stage] ${remainingDeliveries.length} remaining deliveries → Home`);
      
      const { path: finalPath } = findShortestPath(
        currentPosition,
        remainingDeliveries,
        driverHomeLocation,
        cumulativeTime
      );
      
      for (const idx of finalPath) {
        optimizedRoute.push(idx);
        unvisitedFlexible.delete(idx);
        unvisitedConstrained.delete(idx);
        unvisitedISPs.delete(idx);
        
        const stop = stops[idx];
        currentPosition = { lat: stop.lat, lng: stop.lng };
        console.log(`      📬 ${stop.delivery.patient_name || 'Delivery'}`);
      }
    }

    console.log(`\n✅ [Stage-Based Optimization] Complete: ${optimizedRoute.length} stops optimized using recursive shortest-path`);

    // Check if route changed
    const oldOrder = stops.map(s => s.currentOrder).join(',');
    const newOrder = optimizedRoute.map(i => i + 1).join(',');
    const routeChanged = oldOrder !== newOrder;

    console.log('📋 Old order:', oldOrder);
    console.log('📋 New order:', newOrder);
    console.log('📋 Route changed:', routeChanged);

    // NOW use Google Directions API for sequential travel times between stops
    console.log('🌐 [optimizeRouteRealTime] Calling Google Directions API for sequential travel times...');
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const finalRouteCoords = optimizedRoute.map(idx => allStopCoords[idx]);
    
    // Build sequential route: driver location → all stops in order
    // For Directions API: origin, destination, and waypoints in between
    const routeOrigin = isNextDeliveryStopData 
      ? `${isNextDeliveryStopData.lat},${isNextDeliveryStopData.lng}`
      : `${driverLocation.lat},${driverLocation.lng}`;
    
    // If we have stops, the last one is the destination, the rest are waypoints
    let directionsLegs = [];
    
    if (finalRouteCoords.length > 0) {
      const routeDestination = `${finalRouteCoords[finalRouteCoords.length - 1].lat},${finalRouteCoords[finalRouteCoords.length - 1].lng}`;
      const waypointsArr = finalRouteCoords.slice(0, -1).map(c => `${c.lat},${c.lng}`);
      const waypointsStr = waypointsArr.length > 0 ? `&waypoints=${waypointsArr.join('|')}` : '';
      
      console.log(`📍 Directions API: Origin → ${finalRouteCoords.length} stops (${waypointsArr.length} waypoints + 1 destination)`);

      // Log API call
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions',
        purpose: `Sequential travel times for driver ${driverAppUser.user_name || driverId}`,
        function_name: 'optimizeRouteRealTime',
        user_id: user.id,
        user_name: user.full_name,
        metadata: {
          driver_id: driverId,
          delivery_date: deliveryDate,
          stops_count: optimizedRoute.length,
          route_changed: routeChanged,
          waypoints_count: waypointsArr.length
        }
      });

      const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
        `origin=${routeOrigin}&` +
        `destination=${routeDestination}` +
        `${waypointsStr}&` +
        `departure_time=now&` +
        `traffic_model=best_guess&` +
        `key=${googleMapsKey}`;

      const directionsResponse = await fetch(directionsUrl);
      const directionsData = await directionsResponse.json();

      // Increment API counter
      const updatedPolylineRecord = await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
        daily_generation_count: (polylineRecord.daily_generation_count || 0) + 1,
        last_generated_at: new Date().toISOString()
      });
      polylineRecord = updatedPolylineRecord;

      if (directionsData.status !== 'OK') {
        console.error('❌ [optimizeRouteRealTime] Google Directions API failed:', directionsData.status, directionsData.error_message);
        return Response.json({ 
          error: 'Failed to get directions',
          status: directionsData.status,
          message: directionsData.error_message
        }, { status: 500 });
      }

      // Extract legs - each leg is the travel between consecutive waypoints
      // legs[0] = origin to first waypoint (or destination if no waypoints)
      // legs[1] = first waypoint to second waypoint, etc.
      directionsLegs = directionsData.routes[0].legs.map(leg => ({
        duration: leg.duration_in_traffic?.value || leg.duration?.value || 0,
        distance: leg.distance?.value || 0
      }));
      
      console.log(`✅ [optimizeRouteRealTime] Directions API returned ${directionsLegs.length} legs`);
      directionsLegs.forEach((leg, i) => {
        console.log(`   Leg ${i+1}: ${Math.ceil(leg.duration/60)} min, ${(leg.distance/1000).toFixed(1)} km`);
      });
    } else {
      console.log('⚠️ No stops to get directions for');
    }

    // CRITICAL: Calculate start time for ETA calculations
    // Priority: Use isNextDelivery's ETA + service time as starting point
    let realCumulativeTime = currentMinutes;
    if (isNextDeliveryStop) {
      // Use isNextDelivery's ETA (will be calculated by backend) as starting time for remaining stops
      // For now, use current time - backend will update this stop's ETA first
      console.log(`⏰ Will calculate remaining ETAs from isNextDelivery stop's ETA`);
    }

    // STEP 1: Calculate ETA for isNextDelivery stop first (if exists)
    // CRITICAL: isNextDelivery's ETA is calculated from driver's current location
    // All subsequent stops' ETAs are calculated SEQUENTIALLY from isNextDelivery's location + service time
    // 
    // NOTE: isNextDelivery is NOT in the optimizedRoute array (it was excluded from optimization)
    // so we need to use the FIRST element of finalMatrix (driver location) to calculate its ETA
    if (isNextDeliveryStop && isNextDeliveryStopData) {
      // CRITICAL: isNextDelivery is NOT in optimizedRoute, so we need to calculate 
      // the distance from driver to isNextDelivery using crow-flies as approximation
      // The finalMatrix only contains optimized route stops, not isNextDelivery
      const travelDistKm = calculateCrowFliesDistance(
        driverLocation.lat, driverLocation.lng,
        isNextDeliveryStopData.lat, isNextDeliveryStopData.lng
      );
      // Estimate: 40 km/h average speed with 1.3x traffic factor
      const travelTimeMinutes = Math.ceil((travelDistKm / 40) * 60 * 1.3);
      
      realCumulativeTime += travelTimeMinutes;
      
      // Apply time window waiting for isNextDelivery
      if (isNextDeliveryStopData.timeWindow && realCumulativeTime < isNextDeliveryStopData.timeWindow.start) {
        realCumulativeTime = isNextDeliveryStopData.timeWindow.start;
      }
      
      const isNextETA = `${String(Math.floor(realCumulativeTime / 60) % 24).padStart(2, '0')}:${String(realCumulativeTime % 60).padStart(2, '0')}`;
      
      // Update isNextDelivery's ETA
      await base44.asServiceRole.entities.Delivery.update(isNextDeliveryStop.id, {
        delivery_time_eta: isNextETA
      });
      
      console.log(`⏱️ isNextDelivery ETA calculated: ${isNextETA} (${travelTimeMinutes} min travel from driver, ${travelDistKm.toFixed(1)} km)`);
      
      // Add service time for next iteration
      const serviceTime = isNextDeliveryStop.extra_time || (isNextDeliveryStop.patient_id ? 5 : 15);
      realCumulativeTime += serviceTime;
      
      console.log(`⏩ isNextDelivery complete time: ${realCumulativeTime} minutes (includes ${serviceTime} min service)`);
    }

    // STEP 2: Update remaining optimized stops with stop_order and ETAs
    // CRITICAL: ETAs must be calculated SEQUENTIALLY from isNextDelivery (or driver if no isNextDelivery)
    // Each stop's ETA = previous stop's ETA + service time + travel time to this stop
    const updates = [];

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stopIdx = optimizedRoute[i];
      const stop = stops[stopIdx];
      const newStopOrder = startingStopOrder + i + 1;

      // Get real travel time from Google Directions API legs
      // directionsLegs[i] = travel time from previous point to this stop
      let realTravelTimeSeconds = 0;
      
      if (directionsLegs.length > i) {
        realTravelTimeSeconds = directionsLegs[i].duration;
        const distanceMeters = directionsLegs[i].distance;
        console.log(`📍 Stop ${i+1} (${stop.delivery.patient_name || 'Pickup'}): ${Math.ceil(realTravelTimeSeconds/60)} min, ${(distanceMeters/1000).toFixed(1)} km`);
      } else {
        // Fallback to crow-flies if no leg data
        const prevCoords = i === 0 
          ? (isNextDeliveryStopData || driverLocation)
          : { lat: stops[optimizedRoute[i-1]].lat, lng: stops[optimizedRoute[i-1]].lng };
        const distKm = calculateCrowFliesDistance(prevCoords.lat, prevCoords.lng, stop.lat, stop.lng);
        realTravelTimeSeconds = (distKm / 40) * 60 * 60 * 1.3;
        console.log(`📍 Stop ${i+1} (fallback crow-flies): ${Math.ceil(realTravelTimeSeconds/60)} min`);
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