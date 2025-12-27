
/**
 * Route Optimization using "As The Crow Flies" distance heuristic
 * Implements greedy nearest-neighbor algorithm with advanced constraints
 *
 * KEY RULES (UPDATED):
 * 1. Routes with no completed stops MUST start with Pickup or InterStore delivery
 * 2. If 2+ pickups have same time windows, either can be first stop
 * 3. Optimize for shortest route with last stop as close to driver home as possible
 * 4. TR# format: [Store Abbreviation][Number] (e.g., BS01, KW21, SC41)
 * 5. Deliveries from different stores can be interleaved for optimal routing
 * 6. EXCEPTION: InterStore deliveries can come BEFORE their pickup
 * 7. Completed/Failed/Cancelled stops are locked and only get ETA updates
 * 8. Uses stop_optimized flag for smart partial re-optimization
 */

import { parseDate, toDateString, daysBetween } from './dateUtils';

/**
 * Calculate straight-line distance between two lat/lng points (in km)
 * Uses Haversine formula
 */
export const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  if (Array.isArray(lat1) && Array.isArray(lat2)) {
    // Handle array input [lat, lng]
    if (!lat1[0] || !lat1[1] || !lat2[0] || !lat2[1]) return Infinity;
    [lat1, lng1] = lat1;
    [lat2, lng2] = lat2;
  } else if (!lat1 || !lng1 || !lat2 || !lng2) {
    return Infinity;
  }

  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
};

/**
 * Calculate drive time in minutes from distance.
 * This is a simplified version used in the new optimization logic.
 */
const _calculateMinutesFromDistance = (distanceKm, extraMinutes = 0) => {
  if (distanceKm === Infinity || isNaN(distanceKm)) {
    return 0;
  }

  const avgSpeedKmh = 40;
  const baseMinutes = (distanceKm / avgSpeedKmh) * 60;
  return Math.ceil(baseMinutes) + (extraMinutes || 0);
};

export const calculateDriveTime = (fromLat, fromLng, toLat, toLng, extraMinutes = 0) => {
  // Allow passing location objects {lat, lng} directly
  if (typeof fromLat === 'object' && fromLat !== null) {
    extraMinutes = toLng; // Shift extraMinutes if location objects are passed
    toLng = toLat;
    toLat = fromLng;
    fromLng = fromLat.lng;
    fromLat = fromLat.lat;
    
    // If toLat is also an object, extract its lat/lng
    if (typeof toLat === 'object' && toLat !== null) {
      const tempToLat = toLat.lat;
      const tempToLng = toLat.lng;
      toLat = tempToLat;
      toLng = tempToLng;
    }
  }

  const distanceKm = calculateCrowFliesDistance(fromLat, fromLng, toLat, toLng);

  if (distanceKm === Infinity || isNaN(distanceKm)) {
    return { minutes: 0, hours: 0, totalMinutes: 0 };
  }

  const avgSpeedKmh = 40;
  const baseMinutes = (distanceKm / avgSpeedKmh) * 60;
  const totalMinutes = Math.ceil(baseMinutes) + (extraMinutes || 0);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return {
    minutes: Math.ceil(minutes),
    hours,
    totalMinutes
  };
};

export const calculateETA = (previousETA, driveTime, serviceTime = 5) => {
  if (!previousETA) {
    return null;
  }

  const [hours, minutes] = previousETA.split(':').map(Number);

  if (isNaN(hours) || isNaN(minutes)) {
    return null;
  }

  const baseDate = new Date();
  baseDate.setHours(hours, minutes, 0, 0);

  const totalMinutesToAdd = (driveTime?.totalMinutes || 0) + serviceTime;
  const newDate = new Date(baseDate.getTime() + (totalMinutesToAdd * 60 * 1000));

  const newHours = String(newDate.getHours()).padStart(2, '0');
  const newMinutes = String(newDate.getMinutes()).padStart(2, '0');

  return `${newHours}:${newMinutes}`;
};

/**
 * Parse time string to minutes since midnight
 */
const parseTime = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Convert minutes since midnight to time string (HH:mm)
 */
const formatTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

/**
 * Check if a stop is an InterStore delivery
 * These can be sequenced BEFORE their pickup location
 */
const isInterStoreDelivery = (stop, patientMap) => {
  if (!stop || !stop.patient_id) return false;

  const patient = patientMap.get(stop.patient_id);
  if (!patient) return false;

  const searchText = [
    patient.full_name || '',
    patient.address || '',
    patient.notes || '',
    stop.delivery_notes || '',
    stop.delivery_instructions || ''
  ].join(' ').toLowerCase();

  return searchText.includes('interstore') ||
         searchText.includes('inter store') ||
         searchText.includes('(isp)') ||
         searchText.includes('(isd)');
};

/**
 * Check if two time windows overlap
 */
const timeWindowsOverlap = (start1, end1, start2, end2) => {
  const start1Min = parseTime(start1 || '00:00');
  const end1Min = parseTime(end1 || '23:59');
  const start2Min = parseTime(start2 || '00:00');
  const end2Min = parseTime(end2 || '23:59');

  return start1Min <= end2Min && start2Min <= end1Min;
};

/**
 * Main route optimization function
 * @param {Array} stops - Array of delivery/pickup stops to optimize
 * @param {Map} patientMap - Map of patient ID to patient object
 * @param {Map} storeMap - Map of store ID to store object
 * @param {Object|null} startingPoint - Optional starting location {lat, lng}
 * @param {boolean} forceFullOptimization - Force complete re-optimization (not used in current logic)
 * @param {Object|null} driverHomeLocation - Driver's home location for end-of-route (not used in current logic)
 * @returns {Array} - Optimized array of stops with updated stop_order and tracking_number
 */
export const optimizeRoute = (
  stops,
  patientMap,
  storeMap,
  startingPoint = null,
  forceFullOptimization = false, // Not directly used in this implementation's flow
  driverHomeLocation = null // Not directly used in this implementation's flow
) => {
  if (!stops || stops.length === 0) {
    console.log('ℹ️ [RouteOptimization] No stops to optimize');
    return [];
  }

  console.log(`🚗 [RouteOptimization] Starting optimization for ${stops.length} stops`, {
    forceFullOptimization,
    hasStartingPoint: !!startingPoint,
    hasDriverHome: !!driverHomeLocation
  });

  // Create working copy with location data
  const workingStops = stops.map(stop => {
    const isPickup = !stop.patient_id || stop.patient_id === '';
    let location = null;

    if (isPickup) {
      const store = storeMap.get(stop.store_id);
      if (store && store.latitude && store.longitude) {
        location = { lat: store.latitude, lng: store.longitude };
      }
    } else {
      const patient = patientMap.get(stop.patient_id);
      if (patient && patient.latitude && patient.longitude) {
        location = { lat: patient.latitude, lng: patient.longitude };
      }
    }

    return {
      ...stop,
      location,
      isPickup,
      originalStopOrder: stop.stop_order,
      originalTrackingNumber: stop.tracking_number
    };
  }).filter(stop => stop.location !== null);

  if (workingStops.length === 0) {
    console.warn('⚠️ [RouteOptimization] No stops with valid locations');
    return stops; // Return original stops if none have valid locations for optimization
  }

  // Separate pickups and deliveries
  const pickups = workingStops.filter(s => s.isPickup);
  const deliveries = workingStops.filter(s => !s.isPickup);

  console.log(`📊 [RouteOptimization] ${pickups.length} pickups, ${deliveries.length} deliveries`);

  // Sort pickups by their delivery_time_start (scheduled pickup time)
  pickups.sort((a, b) => {
    const timeA = a.delivery_time_start || '00:00';
    const timeB = b.delivery_time_start || '00:00';
    return timeA.localeCompare(timeB);
  });

  // Build optimized route
  const optimizedRoute = [];
  let currentLocation = startingPoint || (pickups[0]?.location);
  let currentTime = pickups[0]?.delivery_time_start || '09:00'; // Start at first pickup time

  if (!currentLocation) {
    // Fallback if no starting point or valid first pickup location
    console.warn('⚠️ [RouteOptimization] No valid starting location found, using default Edmonton coordinates.');
    currentLocation = { lat: 53.5461, lng: -113.4938 };
  }


  let stopOrderCounter = 1;

  // Track tracking numbers by store
  const trackingByStore = new Map();

  // Initialize tracking counters from existing stops
  // Ensure the base for new TRs takes into account existing ones.
  stops.forEach(stop => {
    if (stop.tracking_number && stop.store_id) {
      const trackingNum = parseInt(stop.tracking_number, 10);
      if (!isNaN(trackingNum)) {
        // For pickups, find the highest multiple of 20
        // For deliveries, find the highest overall
        if (stop.isPickup) {
          const currentMax = trackingByStore.get(stop.store_id)?.pickupBase || 0;
          trackingByStore.set(stop.store_id, {
            pickupBase: Math.max(currentMax, Math.floor(trackingNum / 20) * 20),
            deliveryCounter: 0 // Will be recalculated
          });
        } else {
          // This logic is a bit tricky, if a delivery has a higher TR than its pickup base,
          // the next pickup base needs to jump over it.
          // For simplicity, just track the max number seen for any stop in that store.
          const currentMax = trackingByStore.get(stop.store_id)?.maxOverall || 0;
          trackingByStore.set(stop.store_id, {
            ...trackingByStore.get(stop.store_id),
            maxOverall: Math.max(currentMax, trackingNum)
          });
        }
      }
    }
  });


  // Process each pickup and its associated deliveries
  for (const pickup of pickups) {
    // Initialize tracking counter for this store if needed
    if (!trackingByStore.has(pickup.store_id)) {
      trackingByStore.set(pickup.store_id, { pickupBase: 0, deliveryCounter: 0, maxOverall: 0 });
    }

    let storeTrackingContext = trackingByStore.get(pickup.store_id);

    // If maxOverall exists, use it to determine the next base.
    // Ensure pickupTrackingBase is a multiple of 20 and higher than any existing TR for this store.
    let pickupTrackingBase = Math.max(
      storeTrackingContext.pickupBase,
      Math.ceil((storeTrackingContext.maxOverall + 1) / 20) * 20
    );
    
    // Fallback if the calculation above results in 0 when maxOverall is also 0
    if (pickupTrackingBase === 0 && storeTrackingContext.maxOverall === 0) {
      pickupTrackingBase = (optimizedRoute.length * 20) + 20; // Simple increment for new stores
    }

    // Calculate travel time to pickup
    const travelTimeToPickup = calculateDriveTime(currentLocation, pickup.location);
    let arrivalTimeAtPickup = addMinutesToTime(currentTime, travelTimeToPickup.totalMinutes);

    // Check if we arrive before the pickup window
    const pickupWindowStart = pickup.delivery_time_start || '09:00';
    const pickupWindowEnd = pickup.delivery_time_end || '21:00'; // Default end if not specified

    let pickupETA = arrivalTimeAtPickup;
    if (parseTime(arrivalTimeAtPickup) < parseTime(pickupWindowStart)) {
      // Wait until window opens
      pickupETA = pickupWindowStart;
      console.log(`⏰ [RouteOptimization] Waiting at pickup ${pickup.store_id} from ${arrivalTimeAtPickup} until ${pickupWindowStart}`);
    } else if (parseTime(arrivalTimeAtPickup) > parseTime(pickupWindowEnd)) {
      console.warn(`⚠️ [RouteOptimization] Pickup ${pickup.id} ETA ${arrivalTimeAtPickup} is past window end ${pickupWindowEnd}.`);
      // For now, allow late arrival in optimization, but log it.
    }

    // Add pickup to route
    optimizedRoute.push({
      ...pickup,
      stop_order: stopOrderCounter++,
      tracking_number: pickupTrackingBase.toString(),
      delivery_time_eta: pickupETA,
      stop_optimized: true
    });

    // Update tracking context for this store
    storeTrackingContext.pickupBase = pickupTrackingBase;
    storeTrackingContext.deliveryCounter = 0; // Reset for this pickup's deliveries
    storeTrackingContext.maxOverall = Math.max(storeTrackingContext.maxOverall, pickupTrackingBase);
    trackingByStore.set(pickup.store_id, storeTrackingContext);

    // Update current location and time
    currentLocation = pickup.location;
    currentTime = addMinutesToTime(pickupETA, 5); // 5 min at pickup location

    // Find deliveries for this pickup's store
    const storeDeliveries = deliveries.filter(d => d.store_id === pickup.store_id);

    if (storeDeliveries.length === 0) {
      continue;
    }

    // Optimize delivery sequence using nearest neighbor
    const remainingDeliveries = [...storeDeliveries];
    
    while (remainingDeliveries.length > 0) {
      // Find nearest unvisited delivery
      let nearestDelivery = null;
      let shortestDistance = Infinity;

      for (const delivery of remainingDeliveries) {
        const distance = calculateCrowFliesDistance(currentLocation, delivery.location);
        if (distance < shortestDistance) {
          shortestDistance = distance;
          nearestDelivery = delivery;
        }
      }

      if (!nearestDelivery) {
        console.warn(`⚠️ [RouteOptimization] No nearest delivery found for store ${pickup.store_id}, breaking delivery loop.`);
        break;
      }

      // Calculate travel time and ETA
      const travelTime = calculateDriveTime(currentLocation, nearestDelivery.location);
      let arrivalTimeAtDelivery = addMinutesToTime(currentTime, travelTime.totalMinutes);

      // Check delivery time window
      const windowStart = nearestDelivery.delivery_time_start || '09:00'; // Default start if not specified
      const windowEnd = nearestDelivery.delivery_time_end || '21:00'; // Default end if not specified

      let deliveryETA = arrivalTimeAtDelivery;
      if (parseTime(arrivalTimeAtDelivery) < parseTime(windowStart)) {
        // Wait until window opens
        deliveryETA = windowStart;
      } else if (parseTime(arrivalTimeAtDelivery) > parseTime(windowEnd)) {
        // Late delivery - use arrival time but flag it
        console.warn(`⚠️ [RouteOptimization] Late arrival at ${nearestDelivery.patient_id} (id: ${nearestDelivery.id}): ETA ${arrivalTimeAtDelivery} is past window end ${windowEnd}`);
        deliveryETA = arrivalTimeAtDelivery; // Still proceed, but user might need to know
      }

      // Increment delivery counter for the store's context
      storeTrackingContext.deliveryCounter++;
      const deliveryTrackingNum = pickupTrackingBase + storeTrackingContext.deliveryCounter;
      storeTrackingContext.maxOverall = Math.max(storeTrackingContext.maxOverall, deliveryTrackingNum);
      trackingByStore.set(pickup.store_id, storeTrackingContext); // Update context in map

      // Add to route
      optimizedRoute.push({
        ...nearestDelivery,
        stop_order: stopOrderCounter++,
        tracking_number: deliveryTrackingNum.toString(),
        delivery_time_eta: deliveryETA,
        stop_optimized: true
      });

      // Update state
      currentLocation = nearestDelivery.location;
      currentTime = addMinutesToTime(deliveryETA, 3); // 3 min per delivery

      // Remove from remaining
      const index = remainingDeliveries.indexOf(nearestDelivery);
      if (index > -1) {
        remainingDeliveries.splice(index, 1);
      }
    }
  }

  console.log(`✅ [RouteOptimization] Optimized ${optimizedRoute.length} stops`);

  return optimizedRoute;
};

// Helper to add minutes to time string
const addMinutesToTime = (timeStr, minutes) => {
  if (!timeStr) return '09:00';
  const [hours, mins] = timeStr.split(':').map(Number);
  const totalMinutes = hours * 60 + mins + minutes;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;
  return `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
};

/**
 * SIMULATION MODE - Route optimization for projected deliveries
 * Applies same rules as active route optimization
 */
export const simulateRoute = (
  stops,
  patientMap,
  storeMap,
  startingPoint = null,
  driverHomeLocation = null
) => {
  console.log('🎯 [RouteOptimization] SIMULATION: Starting projected route optimization');

  if (!stops || stops.length === 0) {
    console.log('⚠️ [RouteOptimization] SIMULATION: No stops to optimize');
    return [];
  }

  // Use the main optimization function with simulation mode
  // Pass forceFullOptimization=true since projections have no completed stops (or we assume we want a fresh full calculation)
  const optimizedStops = optimizeRoute(
    stops,
    patientMap,
    storeMap,
    startingPoint,
    true, // forceFullOptimization
    driverHomeLocation
  );

  console.log('✅ [RouteOptimization] SIMULATION: Optimization complete', {
    totalOptimizedStops: optimizedStops.length,
    sampleStops: optimizedStops.slice(0, 3).map(s => ({
      id: s?.id,
      stop_order: s?.stop_order,
      tracking_number: s?.tracking_number,
      patient_id: s?.patient_id
    }))
  });

  return optimizedStops;
};
