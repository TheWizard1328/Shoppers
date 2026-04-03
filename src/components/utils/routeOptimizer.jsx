/**
 * Advanced Route Optimization Utility
 * Optimizes delivery routes considering multiple factors:
 * - Distance optimization (PRIMARY - shortest route)
 * - Delivery time windows
 * - Stop duration (extra_time)
 * - Traffic patterns (time-based adjustments)
 * - Dynamic starting location (driver's current position or last completed stop)
 * - Driver's home location as final destination
 * - CRITICAL RULE (BUILT-IN): Store pickups must come BEFORE their deliveries
 * - EXCEPTION: "InterStore PickUp" deliveries are exempt from this constraint
 */

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Estimate travel time in minutes based on distance
const estimateTravelTime = (distanceKm, timeOfDay) => {
  let speedKmH = 30; // Base speed: 30 km/h for city driving
  
  const hour = parseInt(timeOfDay?.split(':')[0] || '10');
  
  // Rush hour adjustments
  if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18)) {
    speedKmH = 20; // Slower during rush hour
  } else if (hour >= 22 || hour <= 6) {
    speedKmH = 40; // Faster at night
  }
  
  return Math.round((distanceKm / speedKmH) * 60);
};

// Convert time string to minutes since midnight
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

// Convert minutes since midnight to time string
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const getUnitSortValue = (stop) => {
  const raw = normalizeText(stop?.unit_number);
  if (!raw) return { numeric: Number.POSITIVE_INFINITY, text: '' };
  const numericMatch = raw.match(/\d+/);
  return {
    numeric: numericMatch ? Number(numericMatch[0]) : Number.POSITIVE_INFINITY,
    text: raw
  };
};

const compareSameAddressStops = (a, b) => {
  const unitA = getUnitSortValue(a);
  const unitB = getUnitSortValue(b);

  if (unitA.numeric !== unitB.numeric) {
    return unitA.numeric - unitB.numeric;
  }

  if (unitA.text !== unitB.text) {
    return unitA.text.localeCompare(unitB.text, undefined, { numeric: true, sensitivity: 'base' });
  }

  return normalizeText(a?.patient_name || a?.full_name).localeCompare(
    normalizeText(b?.patient_name || b?.full_name),
    undefined,
    { numeric: true, sensitivity: 'base' }
  );
};

const sortSameAddressGroups = (stops = []) => {
  const result = [];
  let index = 0;

  while (index < stops.length) {
    const current = stops[index];
    if (!current) {
      index += 1;
      continue;
    }

    const group = [current];
    let nextIndex = index + 1;

    while (nextIndex < stops.length) {
      const candidate = stops[nextIndex];
      if (!candidate || !current.patient_id || !candidate.patient_id) break;
      if (normalizeText(current.address) !== normalizeText(candidate.address)) break;
      if (Math.abs(Number(current.latitude) - Number(candidate.latitude)) >= 1e-5) break;
      if (Math.abs(Number(current.longitude) - Number(candidate.longitude)) >= 1e-5) break;
      group.push(candidate);
      nextIndex += 1;
    }

    if (group.length > 1) {
      group.sort(compareSameAddressStops);
    }

    result.push(...group);
    index = nextIndex;
  }

  return result;
};

/**
 * Calculate the centroid (average center point) of a set of locations
 */
const calculateCentroid = (locations) => {
  if (!locations || locations.length === 0) return null;
  
  // CRITICAL FIX: Add defensive check
  const validLocations = locations.filter(loc => loc && loc.latitude != null && loc.longitude != null);
  if (validLocations.length === 0) return null;
  
  const sum = validLocations.reduce((acc, loc) => ({
    lat: acc.lat + loc.latitude,
    lon: acc.lon + loc.longitude
  }), { lat: 0, lon: 0 });
  
  return {
    lat: sum.lat / validLocations.length,
    lon: sum.lon / validLocations.length
  };
};

/**
 * IMPROVED: Optimize route with built-in pickup-before-delivery constraint
 * Now prioritizes shortest distance/time with advanced lookahead scoring
 */
const optimizeStoreRoute = (stops, storeLocation, pickupTime, startLocation = null, startTime = null, driverHome = null, patients = []) => {
  if (!stops || stops.length === 0) return [];
  
  console.log(`  🔧 Optimizing route for ${stops.length} stops (distance-first approach)${driverHome ? ' with home destination' : ''}`);
  
  const optimized = [];
  const remaining = [...stops];
  
  // Track which stores have had their pickups completed
  const completedPickups = new Set();
  
  // Use provided starting location or default to store
  let currentLocation = startLocation || storeLocation;
  let currentTime = startTime !== null ? startTime : timeToMinutes(pickupTime);
  
  // NEW: Get current time for ignoring past time windows
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  console.log(`  📍 Starting optimization from: [${currentLocation.lat.toFixed(7)}, ${currentLocation.lon.toFixed(7)}] at ${minutesToTime(currentTime)}`);
  console.log(`  ⏰ Current time: ${minutesToTime(currentMinutes)} - ignoring past time windows`);
  if (driverHome) {
    console.log(`  🏠 Driver home location: [${driverHome.lat.toFixed(7)}, ${driverHome.lon.toFixed(7)}]`);
  }
  
  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    
    // Calculate centroid of remaining stops for lookahead scoring
    const remainingCentroid = calculateCentroid(
      remaining.filter(stopItem => stopItem && stopItem.latitude && stopItem.longitude)
    );
    
    for (let i = 0; i < remaining.length; i++) {
      const stop = remaining[i];
      
      // CRITICAL FIX: Add defensive check
      if (!stop) continue;
      
      // Skip if no location
      if (!stop.latitude || !stop.longitude) {
        console.warn(`    ⚠️ Stop missing coordinates:`, stop.patient_id ? 'Patient delivery' : 'Pickup');
        continue;
      }
      
      // CRITICAL: Check pickup-before-delivery constraint using PUID
      // This is an ABSOLUTE constraint - deliveries CANNOT come before their pickups
      if (stop.patient_id) { // This is a delivery
        // Check if this is an interstore delivery (exempt from constraint)
        const patient = patients.find(p => p && p.id === stop.patient_id);
        const patientName = patient?.full_name || '';
        const deliveryNotes = stop.delivery_notes || '';
        
        const isInterStoreDelivery = 
          deliveryNotes.toLowerCase().includes('interstore') ||
          patientName.toLowerCase().includes('interstore');
        
        if (!isInterStoreDelivery && stop.puid) {
          // Regular delivery with PUID - check if its pickup has been completed
          if (!completedPickups.has(stop.puid)) {
            // Pickup not done yet - find the pickup in remaining stops
            const pickupExists = remaining.some(stopItem => 
              stopItem && !stopItem.patient_id && stopItem.stop_id === stop.puid
            );
            
            if (pickupExists) {
              // Pickup exists but hasn't been done - ABSOLUTELY SKIP this delivery
              // console.log(`    🚫 Skipping delivery ${stop.patient_name || stop.patient_id} - pickup not done yet`);
              continue;
            }
          }
        }
      }
      
      // Calculate distance from current location to this stop
      const distanceToStop = calculateDistance(
        currentLocation.lat,
        currentLocation.lon,
        stop.latitude,
        stop.longitude
      );
      
      // Calculate time factors
      const travelTime = estimateTravelTime(distanceToStop, minutesToTime(currentTime));
      const arrivalTime = currentTime + travelTime;
      
      // PRIMARY SCORE: Distance (heavily weighted)
      // Lower distance = higher score
      const distanceScore = Math.max(0, 200 - distanceToStop * 20);
      
      // SECONDARY SCORE: Time window compliance
      // Time windows should guide ordering but NOT override distance for same-window stops
      let timeWindowScore = 0;
      const isPickup = !stop.patient_id;
      
      if (stop.time_window_start && stop.time_window_end) {
        const windowStart = timeToMinutes(stop.time_window_start);
        const windowEnd = timeToMinutes(stop.time_window_end);
        
        // Pickups: Time windows are CRITICAL - must arrive within window
        if (isPickup) {
          if (arrivalTime > windowEnd) {
            // Heavy penalty for arriving after the pickup window ends
            timeWindowScore = -1000;
          } else if (arrivalTime < windowStart - 15) {
            // Small penalty for arriving very early
            timeWindowScore = -30;
          } else {
            // Bonus for being on time
            timeWindowScore = 100;
          }
        } else {
          // Deliveries: Time windows matter but distance is primary
          // KEY FIX: Don't give bonus based on window start time - that was causing late windows to get deprioritized incorrectly
          
          if (arrivalTime >= windowStart && arrivalTime <= windowEnd) {
            // Perfect - within the acceptable window
            timeWindowScore = 50;
          } else if (arrivalTime < windowStart) {
            // Arriving early is fine - no penalty for being early to a delivery
            // The customer prefers early over late
            timeWindowScore = 30;
          } else {
            // Arriving after windowEnd - this is truly late
            // Heavy penalty that increases as we get further past the end time
            const lateness = arrivalTime - windowEnd;
            timeWindowScore = -200 - (lateness * 3);
          }
        }
      } else if (isPickup) {
        // Pickups without explicit time windows - check delivery_time_start/end
        if (stop.delivery_time_start && stop.delivery_time_end) {
          const windowStart = timeToMinutes(stop.delivery_time_start);
          const windowEnd = timeToMinutes(stop.delivery_time_end);
          
          if (arrivalTime > windowEnd) {
            timeWindowScore = -1000; // Must not miss pickup window
          } else if (arrivalTime >= windowStart) {
            timeWindowScore = 100; // On time
          } else {
            timeWindowScore = 50; // Early is okay
          }
        }
      }
      
      // LOOKAHEAD SCORE: How does this choice position us for remaining stops?
      let lookaheadScore = 0;
      if (remainingCentroid && remaining.length > 1) {
        // Calculate distance from this stop to the centroid of remaining stops
        const distanceToCentroid = calculateDistance(
          stop.latitude,
          stop.longitude,
          remainingCentroid.lat,
          remainingCentroid.lon
        );
        
        // Prefer stops that keep us closer to the remaining cluster
        lookaheadScore = Math.max(0, 100 - distanceToCentroid * 15);
      }
      
      // HOME DESTINATION SCORE: Progressively increase weight as we near the end
      let homeScore = 0;
      if (driverHome) {
        const distanceToHomeFromStop = calculateDistance(
          stop.latitude,
          stop.longitude,
          driverHome.lat,
          driverHome.lon
        );
        
        // Progressive weight: more important as we get closer to the end
        const remainingFraction = remaining.length / stops.length;
        const homeWeight = Math.max(0, (1 - remainingFraction) * 150); // Scale up to 150 points
        
        homeScore = Math.max(0, homeWeight - distanceToHomeFromStop * 10);
        
        if (remaining.length <= 5) {
          console.log(`    🏠 Home consideration for "${stop.patient_id ? 'delivery' : 'pickup'}" (${remaining.length} left): distance=${distanceToHomeFromStop.toFixed(2)}km, score=${homeScore.toFixed(1)}`);
        }
      }
      
      // BACKTRACKING PENALTY: Penalize stops that take us backwards
      let backtrackPenalty = 0;
      if (driverHome && remaining.length > 2) {
        const currentDistanceToHome = calculateDistance(
          currentLocation.lat,
          currentLocation.lon,
          driverHome.lat,
          driverHome.lon
        );
        
        const newDistanceToHome = calculateDistance(
          stop.latitude,
          stop.longitude,
          driverHome.lat,
          driverHome.lon
        );
        
        // If this stop takes us further from home when we're past halfway, penalize it
        if (remaining.length < stops.length * 0.6 && newDistanceToHome > currentDistanceToHome) {
          backtrackPenalty = -(newDistanceToHome - currentDistanceToHome) * 15;
          console.log(`    ⚠️ Backtrack penalty for "${stop.patient_id ? 'delivery' : 'pickup'}": ${backtrackPenalty.toFixed(1)} (moving away from home)`);
        }
      }
      
      // COMBINED SCORE: Distance is king, with lookahead, time windows, and home proximity as modifiers
      const score = distanceScore + timeWindowScore + lookaheadScore + homeScore + backtrackPenalty;
      
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    
    if (bestIndex === -1) {
      console.warn(`    ⚠️ No valid stop found - taking first remaining with coordinates`);
      // Find first stop with coordinates
      bestIndex = remaining.findIndex(stopItem => stopItem && stopItem.latitude && stopItem.longitude);
      if (bestIndex === -1) {
        console.error(`    ❌ CRITICAL: No stops with coordinates remain!`);
        break;
      }
    }
    
    // Add the best stop to optimized route
    const selectedStop = remaining.splice(bestIndex, 1)[0];
    
    // CRITICAL FIX: Add defensive check
    if (!selectedStop) {
      console.error(`    ❌ CRITICAL: selectedStop is null after splice!`);
      continue;
    }
    
    // Mark pickup as completed if this is a pickup (using stop_id as PUID)
    if (!selectedStop.patient_id && selectedStop.stop_id) {
      completedPickups.add(selectedStop.stop_id);
      console.log(`    ✅ Pickup completed - PUID: ${selectedStop.stop_id}`);
    }
    
    // Calculate arrival time and update for next iteration
    if (selectedStop.latitude && selectedStop.longitude) {
      const distance = calculateDistance(
        currentLocation.lat,
        currentLocation.lon,
        selectedStop.latitude,
        selectedStop.longitude
      );
      
      const travelTime = estimateTravelTime(distance, minutesToTime(currentTime));
      currentTime += travelTime;
      
      // ETA is always based on ACTUAL calculated arrival time (travel time + previous stops)
      // Time windows are used for scoring and validation, NOT for forcing delays
      const calculatedETA = currentTime;
      
      selectedStop.delivery_time_eta = minutesToTime(calculatedETA);
      selectedStop.estimated_arrival = minutesToTime(calculatedETA);
      
      const stopType = selectedStop.patient_id ? 'Delivery' : 'Pickup';
      const timeWindowInfo = selectedStop.time_window_start && selectedStop.time_window_end
        ? ` (Window: ${selectedStop.time_window_start}-${selectedStop.time_window_end})`
        : '';
      console.log(`    ⏱️ ${stopType} selected: ETA ${selectedStop.delivery_time_eta}${timeWindowInfo}, Distance: ${distance.toFixed(2)}km, Travel: ${travelTime}min`);
      
      // Add stop time and update currentTime to ETA + stop duration
      const stopDuration = selectedStop.extra_time || 5;
      currentTime = calculatedETA + stopDuration;
      
      // Update current location
      currentLocation = {
        lat: selectedStop.latitude,
        lon: selectedStop.longitude
      };
    }
    
    optimized.push(selectedStop);
  }
  
  // Log distance back to home if provided
  if (driverHome && optimized.length > 0) {
    const lastStop = optimized[optimized.length - 1];
    if (lastStop && lastStop.latitude && lastStop.longitude) {
      const distanceHome = calculateDistance(
        lastStop.latitude,
        lastStop.longitude,
        driverHome.lat,
        driverHome.lon
      );
      console.log(`  🏠 Final distance to home: ${distanceHome.toFixed(2)}km`);
    }
  }
  
  const reorderedOptimized = sortSameAddressGroups(optimized);
  console.log(`  ✅ Route optimized: ${reorderedOptimized.length} stops (distance-first with pickup-before-delivery constraint)`);
  return reorderedOptimized;
};

/**
 * Try different pickup starting points and return the best route
 */
const findBestPickupOrder = (pickups, deliveries, stores, patients, startLocation, startTime, driverHome) => {
  if (pickups.length <= 1) {
    const firstPickupStore = stores.find(storeItem => storeItem && storeItem.id === pickups[0]?.store_id);
    const fallbackStoreLocation = { lat: firstPickupStore?.latitude, lon: firstPickupStore?.longitude };
    
    return optimizeStoreRoute(
      [...pickups, ...deliveries],
      startLocation || fallbackStoreLocation,
      pickups[0]?.delivery_time_start || '10:00',
      startLocation,
      startTime,
      driverHome,
      patients
    );
  }
  
  console.log(`  🔄 Testing ${pickups.length} different pickup starting points for shortest route...`);
  
  let bestRoute = null;
  let bestDistance = Infinity;
  
  // Try each pickup as the starting point
  for (let i = 0; i < pickups.length; i++) {
    const currentAttemptPickups = [pickups[i], ...pickups.filter((_, idx) => idx !== i)];
    const allStopsForAttempt = [...currentAttemptPickups, ...deliveries];
    
    const firstPickupInAttempt = currentAttemptPickups[0];
    const pickupStore = stores.find(storeItem => storeItem && storeItem.id === firstPickupInAttempt.store_id);
    
    const route = optimizeStoreRoute(
      allStopsForAttempt,
      { lat: pickupStore?.latitude, lon: pickupStore?.longitude },
      firstPickupInAttempt.delivery_time_start || '10:00',
      startLocation,
      startTime,
      driverHome,
      patients
    );
    
    // Calculate total distance including return to home
    const stats = calculateRouteStats(route, stores, patients);
    let totalDistance = stats.totalDistance;
    
    if (driverHome && route.length > 0) {
      const lastStop = route[route.length - 1];
      if (lastStop && lastStop.latitude && lastStop.longitude) {
        totalDistance += calculateDistance(
          lastStop.latitude,
          lastStop.longitude,
          driverHome.lat,
          driverHome.lon
        );
      }
    }
    
    // Only log if this is a new best route
    if (totalDistance < bestDistance) {
      console.log('');
      console.log(`    ✨ NEW BEST ROUTE FOUND - Pickup order ${i + 1}:`);
      console.log(`       Starting pickup: ${pickupStore?.name}`);
      console.log(`       Total distance: ${totalDistance.toFixed(2)} km`);
      console.log(`       Total time: ${stats.totalTime} minutes`);
      console.log(`       Stop sequence:`);
      route.forEach((routeStop, idx) => {
        if (!routeStop) return; // CRITICAL FIX
        const stopPatient = patients.find(patientItem => patientItem && patientItem.id === routeStop.patient_id);
        const stopStore = stores.find(storeItem => storeItem && storeItem.id === routeStop.store_id);
        const stopName = routeStop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
        const eta = routeStop.estimated_arrival || routeStop.delivery_time_start || 'N/A';
        console.log(`         ${idx + 1}. ${stopName} - ETA: ${eta}`);
      });
      
      bestDistance = totalDistance;
      bestRoute = route;
    }
  }
  
  console.log('');
  console.log(`  ✅ Best pickup order selected - Total distance: ${bestDistance.toFixed(2)}km`);
  return bestRoute;
};

/**
 * Main route optimization function
 * Prioritizes shortest distance and time with built-in pickup-before-delivery constraint
 */
export const optimizeRoute = (stops, stores, patients, options = {}) => {
  console.log('🚀 [Route Optimizer] Starting distance-first route optimization');
  console.log(`   Total stops to optimize: ${stops.length}`);
  
  const {
    useAdvancedOptimization = true,
    respectManualOrder = false,
    startLocation = null,
    startTime = null,
    driverHome = null
  } = options;
  
  if (respectManualOrder) {
    console.log('   ⚠️ Manual order mode - skipping optimization');
    return stops;
  }
  
  if (startLocation && startTime) {
    console.log(`   📍 Custom starting point: [${startLocation.lat.toFixed(7)}, ${startLocation.lon.toFixed(7)}] at ${startTime}`);
  }
  if (driverHome) {
    console.log(`   🏠 Driver home destination: [${driverHome.lat.toFixed(7)}, ${driverHome.lon.toFixed(7)}]`);
  }
  
  // Enrich all stops with coordinates
  console.log('');
  console.log('📍 Enriching stops with coordinates:');
  console.log('─────────────────────────────────');
  
  const enrichedStops = stops.map(stop => {
    // CRITICAL FIX: Add defensive check
    if (!stop) return null;

    const enriched = { ...stop };

    if (!stop.patient_id) {
      const store = stores.find(storeItem => storeItem && storeItem.id === stop.store_id);
      if (store?.latitude && store?.longitude) {
        enriched.latitude = store.latitude;
        enriched.longitude = store.longitude;
        console.log(`   🏪 Pickup: ${store.name} -> [${enriched.latitude.toFixed(7)}, ${enriched.longitude.toFixed(7)}]`);
      } else {
        console.error(`   ❌ Pickup missing coordinates: Store ID ${stop.store_id}`);
      }
    } else {
      const patient = patients.find(patientItem => patientItem && patientItem.id === stop.patient_id);
      if (patient?.latitude && patient?.longitude) {
        enriched.latitude = patient.latitude;
        enriched.longitude = patient.longitude;
        enriched.address = patient.address || '';
        enriched.unit_number = patient.unit_number || '';
        enriched.patient_name = patient.full_name || stop.patient_name || '';
        enriched.full_name = patient.full_name || '';
        console.log(`   📦 Delivery: ${patient.full_name} -> [${enriched.latitude.toFixed(7)}, ${enriched.longitude.toFixed(7)}]`);
      } else {
        console.error(`   ❌ Delivery missing coordinates: Patient ID ${stop.patient_id}`);
      }
    }

    return enriched;
  }).filter(stop => {
    if (!stop) return false;
    // The optimizer will process all stops. Status-based filtering will be handled by the calling context if needed.
    return true;
  });
  
  // Group stops by PUID (each pickup run and its deliveries)
  const stopsByPUID = {};
  const pickupsByStoreId = {};

  enrichedStops.forEach(stop => {
    if (!stop) return;

    if (!stop.patient_id) {
      // This is a pickup - use stop_id as PUID
      const puid = stop.stop_id;
      if (!puid) {
        console.warn(`⚠️ Pickup missing stop_id (PUID):`, stop);
        return;
      }

      stopsByPUID[puid] = {
        pickup: { ...stop }, // Preserve all stop properties including isNew
        deliveries: [],
        storeId: stop.store_id
      };

      // Track pickups by store for ordering
      if (!pickupsByStoreId[stop.store_id]) {
        pickupsByStoreId[stop.store_id] = [];
      }
      pickupsByStoreId[stop.store_id].push(puid);
    } else {
      // This is a delivery - group by its PUID
      const puid = stop.puid;
      if (!puid) {
        console.warn(`⚠️ Delivery missing PUID:`, stop);
        return;
      }

      if (!stopsByPUID[puid]) {
        stopsByPUID[puid] = {
          pickup: null,
          deliveries: [],
          storeId: stop.store_id
        };
      }
      stopsByPUID[puid].deliveries.push({ ...stop }); // Preserve all stop properties including isNew
    }
  });
  
  // Sort PUIDs by pickup time
  const sortedPUIDs = Object.keys(stopsByPUID).sort((a, b) => {
    const groupA = stopsByPUID[a];
    const groupB = stopsByPUID[b];
    const pickupA = groupA.pickup;
    const pickupB = groupB.pickup;
    
    if (!pickupA || !pickupB) return 0;
    
    const timeA = timeToMinutes(pickupA.delivery_time_start || '00:00');
    const timeB = timeToMinutes(pickupB.delivery_time_start || '00:00');
    
    return timeA - timeB;
  });
  
  console.log(`  📦 Grouped stops into ${sortedPUIDs.length} PUID groups`);
  
  const optimizedRoute = [];
  let hasUsedStartLocation = false;
  let globalCurrentTime = startTime ? timeToMinutes(startTime) : null;
  let globalCurrentLocation = startLocation;

  // Process each PUID group
  for (const puid of sortedPUIDs) {
    const puidGroup = stopsByPUID[puid];
    const pickup = puidGroup.pickup;
    const deliveries = puidGroup.deliveries;

    if (!pickup) {
      console.warn(`⚠️ PUID ${puid} has no pickup, skipping group`);
      continue;
    }
    
    // Keep pending deliveries included for route efficiency planning
    const activeDeliveries = deliveries;
    const pendingDeliveries = deliveries.filter(d => d.status === 'pending');

    if (pendingDeliveries.length > 0) {
      console.log(`  ⏳ Found ${pendingDeliveries.length} pending deliveries for PUID ${puid} - will be shown in pickup card`);
      // Sort pending deliveries by distance from store for TR# assignment
      const currentStore = stores.find(storeItem => storeItem && storeItem.id === puidGroup.storeId);
      if (currentStore?.latitude && currentStore?.longitude) {
        pendingDeliveries.sort((a, b) => {
          const distA = a.latitude && a.longitude
            ? calculateDistance(currentStore.latitude, currentStore.longitude, a.latitude, a.longitude)
            : Infinity;
          const distB = b.latitude && b.longitude
            ? calculateDistance(currentStore.latitude, currentStore.longitude, b.latitude, b.longitude)
            : Infinity;
          return distA - distB;
        });
        
        // Assign TR# to pending deliveries
        pendingDeliveries.forEach((del, idx) => {
          del.tracking_number = `TR-${idx + 1}`;
          del.stop_order = null;
          console.log(`    ➡️ Pending: ${del.patient_name} assigned TR# ${del.tracking_number}`);
        });
      }
    }

    // If pickup is pending but has active deliveries, include the pickup in the route
    // If pickup is active, include it in the route
    if (pickup.status !== 'pending' || activeDeliveries.length > 0) {
      // Process this PUID group with active deliveries
      const currentStore = stores.find(storeItem => storeItem && storeItem.id === puidGroup.storeId);
      console.log(`  🏪 Processing PUID ${puid}: ${currentStore?.name} (${activeDeliveries.length} future, ${pendingDeliveries.length} pending)`);
      
      if (!pickup.extra_time && pickup.extra_time !== 0) {
        pickup.extra_time = 15;
      }
      
      const useCustomStart = !hasUsedStartLocation && globalCurrentLocation && globalCurrentTime !== null;
      const pickupTime = pickup.delivery_time_start || '10:00';
      
      if (useAdvancedOptimization) {
        // Optimize pickup + all future deliveries, including pending stops
        const allStopsForPUID = [pickup, ...activeDeliveries];
        const storeLocation = {
          lat: currentStore?.latitude,
          lon: currentStore?.longitude
        };
        
        const optimizedStops = optimizeStoreRoute(
          allStopsForPUID,
          storeLocation,
          pickupTime,
          useCustomStart ? globalCurrentLocation : null,
          useCustomStart ? globalCurrentTime : null,
          driverHome,
          patients
        );
        
        if (useCustomStart) {
          hasUsedStartLocation = true;
          console.log(`     🎯 Used custom starting location`);
        }
        
        // Update global tracking
        if (optimizedStops.length > 0) {
          const lastStop = optimizedStops[optimizedStops.length - 1];
          if (lastStop && lastStop.latitude && lastStop.longitude && lastStop.estimated_arrival) {
            globalCurrentLocation = { lat: lastStop.latitude, lon: lastStop.longitude };
            globalCurrentTime = timeToMinutes(lastStop.estimated_arrival);
          }
        }
        
        optimizedRoute.push(...optimizedStops);
      } else {
        // Fallback: simple distance-based sorting for all future stops, including pending
        const allStopsForPUID = [pickup, ...activeDeliveries];
        const sortedStops = allStopsForPUID.sort((a, b) => {
          if (!a || !b) return 0;
          
          const distA = currentStore?.latitude && a.latitude
            ? calculateDistance(currentStore.latitude, currentStore.longitude, a.latitude, a.longitude)
            : 99999;
          const distB = currentStore?.latitude && b.latitude
            ? calculateDistance(currentStore.latitude, currentStore.longitude, b.latitude, b.longitude)
            : 99999;
          
          if (Math.abs(distA - distB) > 0.5) return distA - distB;
          
          const timeA = a.delivery_time_start || '99:99';
          const timeB = b.delivery_time_start || '99:99';
          return timeA.localeCompare(timeB);
        });
        
        optimizedRoute.push(...sortedStops);
      }
    } else {
      console.log(`  ⏭️ Skipping fully pending PUID ${puid} - pickup and all deliveries are pending`);
    }
  }

  // CRITICAL FIX: Ensure stop_order is set for non-pending deliveries only AFTER full optimization
  let stopOrderCounter = 1;
  optimizedRoute.forEach(stop => {
    if (stop && stop.status !== 'pending') {
      stop.stop_order = stopOrderCounter++;
    }
  });
  
  console.log(`✅ [Route Optimizer] Optimization complete: ${optimizedRoute.length} stops (distance-first with built-in constraint)`);
  return optimizedRoute;
};

/**
 * Validate if a manual route adjustment is feasible
 * Checks for conflicts with time windows and store assignments
 */
export const validateRouteAdjustment = (stops, stores, patients) => {
  const issues = [];
  
  const completedPickupsForValidation = new Set();
  
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    
    // CRITICAL FIX: Add defensive check
    if (!stop) continue;
    
    let stopLocationData = stop;
    if (!stop.latitude || !stop.longitude) {
      if (!stop.patient_id) {
        stopLocationData = stores.find(storeItem => storeItem && storeItem.id === stop.store_id);
      } else {
        stopLocationData = patients.find(patientItem => patientItem && patientItem.id === stop.patient_id);
      }
      if (stopLocationData) {
        stop.latitude = stopLocationData.latitude;
        stop.longitude = stopLocationData.longitude;
      }
    }

    if (!stop.patient_id && stop.stop_id) {
      completedPickupsForValidation.add(stop.stop_id);
    } else {
      // Check if this is an interstore delivery (exempt from constraint)
      const patient = patients.find(p => p && p.id === stop.patient_id);
      const patientName = patient?.full_name || '';
      const deliveryNotes = stop.delivery_notes || '';
      
      const isInterStoreDelivery = 
        deliveryNotes.toLowerCase().includes('interstore') ||
        patientName.toLowerCase().includes('interstore');
      
      if (!isInterStoreDelivery && stop.puid) {
        if (!completedPickupsForValidation.has(stop.puid)) {
          issues.push({
            stopIndex: i,
            type: 'pickup_order',
            message: `Delivery for ${stop.patient_name || stop.patient_id} (PUID: ${stop.puid}) comes before its pickup`
          });
        }
      }
      
      const arrivalTime = timeToMinutes(stop.estimated_arrival || stop.delivery_time_start); 
      
      if (stop.time_window_start && stop.time_window_end && arrivalTime !== null) {
        const windowStart = timeToMinutes(stop.time_window_start);
        const windowEnd = timeToMinutes(stop.time_window_end);
        
        // Only flag as late if arriving after the window end time
        // Arriving after windowStart but before windowEnd is acceptable
        if (arrivalTime > windowEnd + 15) {
          issues.push({
            stopIndex: i,
            type: 'time_late',
            message: `Delivery for ${stop.patient_name || stop.store_id} arrives late (${minutesToTime(arrivalTime)}) - window ends at ${stop.time_window_end}`
          });
        }
      }
    }
  }
  
  return {
    isValid: issues.length === 0,
    issues
  };
};

/**
 * Calculate route statistics
 */
export const calculateRouteStats = (stops, stores, patients) => {
  let totalDistance = 0;
  let totalTime = 0;
  let currentLocation = null;
  
  for (const stop of stops) {
    // CRITICAL FIX: Add defensive check
    if (!stop) continue;
    
    let stopLocationData = stop;
    if (!stop.latitude || !stop.longitude) {
      if (!stop.patient_id) {
        stopLocationData = stores.find(storeItem => storeItem && storeItem.id === stop.store_id);
      } else {
        stopLocationData = patients.find(patientItem => patientItem && patientItem.id === stop.patient_id);
      }
    }

    if (stopLocationData?.latitude && stopLocationData?.longitude) {
      if (currentLocation) {
        const distance = calculateDistance(
          currentLocation.lat,
          currentLocation.lon,
          stopLocationData.latitude,
          stopLocationData.longitude
        );
        totalDistance += distance;
        totalTime += estimateTravelTime(distance, stop.estimated_arrival || stop.delivery_time_start);
      }
      
      currentLocation = {
        lat: stopLocationData.latitude,
        lon: stopLocationData.longitude
      };
      
      // Add stop time
      totalTime += stop.extra_time || 5;
    }
  }
  
  return {
    totalDistance: Math.round(totalDistance * 10) / 10,
    totalTime: Math.round(totalTime),
    averageTimePerStop: stops.length > 0 ? Math.round(totalTime / stops.length) : 0,
    numberOfStops: stops.length
  };
};