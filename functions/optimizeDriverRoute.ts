/**
 * Backend Route Optimization Function
 * 
 * This function handles server-side route optimization for drivers.
 * It's triggered when:
 * 1. A driver completes a stop
 * 2. A driver starts a delivery
 * 3. Manual re-optimization is requested
 * 
 * Benefits:
 * - Faster updates (no frontend computation)
 * - Consistent optimization across all clients
 * - Reduced frontend lag
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Helper to detect if request is from mobile device
const isMobileRequest = (req) => {
  const userAgent = req.headers.get('user-agent') || '';
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
};

// =============================================
// UTILITY FUNCTIONS
// =============================================

// Get current time - uses client-provided time if available, otherwise falls back to ET
const getCurrentTime = (clientTime = null) => {
  // If client provided their device time, use it
  if (clientTime && typeof clientTime === 'string' && clientTime.match(/^\d{2}:\d{2}$/)) {
    console.log(`   ⏰ Using client-provided time: ${clientTime}`);
    return clientTime;
  }
  
  // Fallback to Eastern Time
  const now = new Date();
  const etTime = now.toLocaleString('en-US', { 
    timeZone: 'America/Toronto', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
  console.log(`   ⏰ Using server ET fallback time: ${etTime}`);
  return etTime; // Returns "HH:mm" format
};

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

// Format date to yyyy-MM-dd
const formatDate = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Calculate the centroid of a set of locations
const calculateCentroid = (locations) => {
  if (!locations || locations.length === 0) return null;
  
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

// =============================================
// ROUTE OPTIMIZATION LOGIC
// =============================================

const optimizeStoreRoute = (stops, startLocation, startTime, driverHome, patients) => {
  if (!stops || stops.length === 0) return [];
  
  console.log(`  🔧 Optimizing route for ${stops.length} stops`);
  
  const optimized = [];
  const remaining = [...stops];
  
  // Track which stores have had their pickups completed
  const completedPickups = new Set();
  
  let currentLocation = startLocation || { lat: 0, lon: 0 };
  let currentTime = startTime !== null ? startTime : 600; // Default 10:00
  
  // Get current time for ignoring past time windows
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  // =============================================
  // CRITICAL: Prioritize in_transit deliveries FIRST
  // Complete as many active deliveries as possible before pickups
  // =============================================
  const inTransitDeliveries = remaining.filter(s => s && s.status === 'in_transit' && s.patient_id);
  const pickups = remaining.filter(s => s && !s.patient_id);
  const otherDeliveries = remaining.filter(s => s && s.patient_id && s.status !== 'in_transit');
  
  console.log(`  📊 Stop breakdown: ${inTransitDeliveries.length} in_transit, ${pickups.length} pickups, ${otherDeliveries.length} other deliveries`);
  
  // First: Complete all in_transit deliveries (sorted by distance from current location)
  if (inTransitDeliveries.length > 0) {
    console.log(`  🚀 Processing ${inTransitDeliveries.length} in_transit deliveries FIRST (priority over pickups)`);
    
    // Sort in_transit by distance from current location
    inTransitDeliveries.sort((a, b) => {
      const distA = calculateDistance(currentLocation.lat, currentLocation.lon, a.latitude, a.longitude);
      const distB = calculateDistance(currentLocation.lat, currentLocation.lon, b.latitude, b.longitude);
      return distA - distB;
    });
    
    for (const delivery of inTransitDeliveries) {
      // Remove from remaining
      const idx = remaining.findIndex(s => s && s.id === delivery.id);
      if (idx !== -1) {
        remaining.splice(idx, 1);
      }
      
      // Calculate ETA
      const distance = calculateDistance(
        currentLocation.lat,
        currentLocation.lon,
        delivery.latitude,
        delivery.longitude
      );
      const travelTime = estimateTravelTime(distance, minutesToTime(currentTime));
      currentTime += travelTime;
      
      delivery.delivery_time_eta = minutesToTime(currentTime);
      delivery.estimated_arrival = minutesToTime(currentTime);
      
      const stopDuration = delivery.extra_time || 5;
      currentTime += stopDuration;
      
      currentLocation = { lat: delivery.latitude, lon: delivery.longitude };
      
      optimized.push(delivery);
      
      const patientName = patients?.find(p => p?.id === delivery.patient_id)?.full_name || 'Unknown';
      console.log(`    ✅ In-transit: ${patientName} - ETA: ${delivery.estimated_arrival}`);
    }
  }
  
  // Now process remaining stops (pickups and pending deliveries) with normal algorithm
  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    
    // Calculate centroid of remaining stops for lookahead scoring
    const remainingCentroid = calculateCentroid(
      remaining.filter(stopItem => stopItem && stopItem.latitude && stopItem.longitude)
    );
    
    for (let i = 0; i < remaining.length; i++) {
      const stop = remaining[i];
      
      if (!stop) continue;
      
      // Skip if no location
      if (!stop.latitude || !stop.longitude) {
        continue;
      }
      
      // CRITICAL: Check pickup-before-delivery constraint using PUID
      if (stop.patient_id) { // This is a delivery
        const patientName = patients?.find(p => p?.id === stop.patient_id)?.full_name || '';
        const deliveryNotes = stop.delivery_notes || '';
        
        const isInterStoreDelivery = 
          deliveryNotes.toLowerCase().includes('interstore') ||
          patientName.toLowerCase().includes('interstore');
        
        if (!isInterStoreDelivery && stop.puid) {
          if (!completedPickups.has(stop.puid)) {
            const pickupIndex = remaining.findIndex(stopItem => 
              stopItem && !stopItem.patient_id && stopItem.stop_id === stop.puid
            );
            
            if (pickupIndex !== -1) {
              continue; // Pickup exists but hasn't been done - SKIP
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
      
      // PRIMARY SCORE: Time Window Urgency (most important)
      let timeWindowScore = 0;
      const isPickup = !stop.patient_id;
      
      if (stop.time_window_start && stop.time_window_end) {
        const windowStart = timeToMinutes(stop.time_window_start);
        const windowEnd = timeToMinutes(stop.time_window_end);
        
        const minutesUntilWindowEnd = windowEnd - arrivalTime;
        const minutesUntilWindowStart = windowStart - arrivalTime;
        
        if (isPickup) {
          // Pickups: Lower priority, but still prefer doing them on time
          if (arrivalTime >= windowStart && arrivalTime <= windowEnd) {
            timeWindowScore = 150; // Good to do pickup in window
          } else if (arrivalTime > windowEnd) {
            timeWindowScore = 50; // Late pickup - acceptable since deliveries take priority
          } else {
            timeWindowScore = 100; // Early pickup
          }
        } else {
          // Patient deliveries: Heavily prioritize time window compliance
          if (arrivalTime >= windowStart && arrivalTime <= windowEnd) {
            // Perfect - within window, heavily favor stops with tighter windows
            timeWindowScore = 500;
            if (minutesUntilWindowEnd < 60) {
              timeWindowScore += 200; // Urgent - less than 1 hour until window closes
            }
            if (minutesUntilWindowEnd < 30) {
              timeWindowScore += 300; // Very urgent - less than 30 min
            }
          } else if (arrivalTime < windowStart) {
            // Too early - prefer later
            timeWindowScore = 100 - Math.abs(minutesUntilWindowStart);
          } else {
            // Late - heavily penalize
            const minutesLate = arrivalTime - windowEnd;
            timeWindowScore = -500 - (minutesLate * 10);
          }
        }
      } else {
        // No time window - neutral score
        timeWindowScore = 50;
      }
      
      // SECONDARY SCORE: Distance
      const distanceScore = Math.max(0, 100 - distanceToStop * 10);
      
      // LOOKAHEAD SCORE (reduced weight)
      let lookaheadScore = 0;
      if (remainingCentroid && remaining.length > 1) {
        const distanceToCentroid = calculateDistance(
          stop.latitude,
          stop.longitude,
          remainingCentroid.lat,
          remainingCentroid.lon
        );
        lookaheadScore = Math.max(0, 50 - distanceToCentroid * 5);
      }
      
      // HOME DESTINATION SCORE (reduced weight)
      let homeScore = 0;
      if (driverHome && remaining.length <= 3) {
        const distanceToHomeFromStop = calculateDistance(
          stop.latitude,
          stop.longitude,
          driverHome.lat,
          driverHome.lon
        );
        homeScore = Math.max(0, 50 - distanceToHomeFromStop * 5);
      }
      
      // COMBINED SCORE (time window is now dominant factor)
      const score = timeWindowScore + distanceScore + lookaheadScore + homeScore;
      
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    
    if (bestIndex === -1) {
      bestIndex = remaining.findIndex(stopItem => stopItem && stopItem.latitude && stopItem.longitude);
      if (bestIndex === -1) {
        break;
      }
    }
    
    // Add the best stop to optimized route
    const selectedStop = remaining.splice(bestIndex, 1)[0];
    
    if (!selectedStop) continue;
    
    // Mark pickup as completed
    if (!selectedStop.patient_id && selectedStop.stop_id) {
      completedPickups.add(selectedStop.stop_id);
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
      
      selectedStop.delivery_time_eta = minutesToTime(currentTime);
      selectedStop.estimated_arrival = minutesToTime(currentTime);
      
      // Add stop time and update currentTime
      const stopDuration = selectedStop.extra_time || 5;
      currentTime += stopDuration;
      
      // Update current location
      currentLocation = {
        lat: selectedStop.latitude,
        lon: selectedStop.longitude
      };
    }
    
    optimized.push(selectedStop);
  }
  
  return optimized;
};

// =============================================
// MAIN HANDLER
// =============================================

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Authenticate
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Parse request body
    const body = await req.json();
    const { 
      driverId, 
      deliveryDate, 
      currentLocation,
      completedDeliveryId,
      startedDeliveryId,
      forceReoptimization = false,
      clientCurrentTime = null, // NEW: Device's current time in HH:mm format
      generatePolyline = false // NEW: Generate Google Maps polyline
    } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId and deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('🚀 [Backend Optimizer] Starting route optimization');
    console.log('═══════════════════════════════════');
    console.log(`📅 Date: ${deliveryDate}`);
    console.log(`🚗 Driver ID: ${driverId}`);
    console.log(`📍 Current Location: ${currentLocation ? `[${currentLocation.lat}, ${currentLocation.lon}]` : 'Not provided'}`);
    console.log(`✅ Completed Delivery: ${completedDeliveryId || 'None'}`);
    console.log(`▶️ Started Delivery: ${startedDeliveryId || 'None'}`);
    
    // Track if this optimization was triggered by a "Start" button click
    const isStartedDeliveryTrigger = !!startedDeliveryId;
    
    // =============================================
    // STEP 1: Fetch all necessary data
    // =============================================
    console.log('');
    console.log('🏗️ STEP 1: Fetching data from database');
    
    const [deliveries, patients, stores, appUsers] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }),
      base44.asServiceRole.entities.Patient.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId })
    ]);
    
    console.log(`✅ Fetched ${deliveries.length} deliveries, ${patients.length} patients, ${stores.length} stores`);
    
    const driverAppUser = appUsers[0];
    const driverHome = driverAppUser?.home_latitude && driverAppUser?.home_longitude
      ? { lat: driverAppUser.home_latitude, lon: driverAppUser.home_longitude }
      : null;
    
    // =============================================
    // STEP 2: Reset ALL isNextDelivery flags first, then categorize
    // =============================================
    console.log('');
    console.log('🏗️ STEP 2: Resetting isNextDelivery flags for ALL deliveries');
    
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    
    // CRITICAL: Reset isNextDelivery to false for ALL deliveries on this route
    const resetPromises = [];
    for (const delivery of deliveries) {
      if (delivery && delivery.isNextDelivery === true) {
        console.log(`   Resetting isNextDelivery for: ${delivery.patient_name || 'Pickup'} (${delivery.id})`);
        resetPromises.push(
          base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false })
        );
      }
    }
    
    if (resetPromises.length > 0) {
      await Promise.all(resetPromises);
      console.log(`✅ Reset isNextDelivery for ${resetPromises.length} deliveries`);
    } else {
      console.log(`✅ No deliveries had isNextDelivery=true`);
    }
    
    // Categorize deliveries
    const completedDeliveries = deliveries.filter(d => d && finishedStatuses.includes(d.status));
    const incompleteDeliveries = deliveries.filter(d => d && !finishedStatuses.includes(d.status));
    
    console.log(`📊 Completed: ${completedDeliveries.length}, Incomplete: ${incompleteDeliveries.length}`);
    
    if (incompleteDeliveries.length === 0) {
      console.log('✅ No incomplete deliveries - route complete!');
      return Response.json({ 
        success: true, 
        message: 'Route complete - no optimization needed',
        routeComplete: true
      });
    }
    
    // =============================================
    // STEP 2.5: Handle "Started" delivery and pre-sort remaining by time window
    // =============================================
    console.log('');
    console.log('🏗️ STEP 2.5: Processing started delivery and pre-sorting remaining stops');
    
    let startedDelivery = null;
    let startedDeliveryETA = null;
    let startedDeliveryLocation = null;
    
    // If a delivery was just started, calculate its ETA first
    if (isStartedDeliveryTrigger && startedDeliveryId) {
      startedDelivery = incompleteDeliveries.find(d => d && d.id === startedDeliveryId);
      
      if (startedDelivery) {
        console.log(`   ▶️ Processing started delivery: ${startedDelivery.patient_name || 'Pickup'}`);
        
        // Get the started delivery's location
        if (startedDelivery.patient_id) {
          const patient = patients.find(p => p?.id === startedDelivery.patient_id);
          if (patient?.latitude && patient?.longitude) {
            startedDeliveryLocation = { lat: patient.latitude, lon: patient.longitude };
          }
        } else {
          const store = stores.find(s => s?.id === startedDelivery.store_id);
          if (store?.latitude && store?.longitude) {
            startedDeliveryLocation = { lat: store.latitude, lon: store.longitude };
          }
        }
        
        // Calculate ETA for started delivery based on driver's current location
        let etaStartLocation = null;
        
        // Priority 1: Use provided current location
        if (currentLocation?.lat && currentLocation?.lon) {
          etaStartLocation = currentLocation;
          console.log(`   📍 Using provided current location for ETA calculation`);
        }
        // Priority 2: Use driver's GPS location from AppUser
        else if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
          const locationAge = driverAppUser.location_updated_at 
            ? Date.now() - new Date(driverAppUser.location_updated_at).getTime()
            : Infinity;
          
          if (locationAge < 10 * 60 * 1000) { // Less than 10 minutes old
            etaStartLocation = { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude };
            console.log(`   📍 Using driver's GPS location (${Math.round(locationAge / 1000)}s old)`);
          }
        }
        // Priority 3: Use last completed delivery location
        if (!etaStartLocation && completedDeliveries.length > 0) {
          const sortedCompleted = [...completedDeliveries].sort((a, b) => 
            new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time)
          );
          const lastCompleted = sortedCompleted[0];
          
          const lastLocation = lastCompleted.patient_id
            ? patients.find(p => p?.id === lastCompleted.patient_id)
            : stores.find(s => s?.id === lastCompleted.store_id);
          
          if (lastLocation?.latitude && lastLocation?.longitude) {
            etaStartLocation = { lat: lastLocation.latitude, lon: lastLocation.longitude };
            console.log(`   📍 Using last completed stop location for ETA calculation`);
          }
        }
        
        // Calculate ETA for the started delivery
        if (etaStartLocation && startedDeliveryLocation) {
          const distance = calculateDistance(
            etaStartLocation.lat,
            etaStartLocation.lon,
            startedDeliveryLocation.lat,
            startedDeliveryLocation.lon
          );
          // Use client-provided time or fallback to ET
          const currentTimeStr = getCurrentTime(clientCurrentTime);
          const travelTime = estimateTravelTime(distance, currentTimeStr);
          const currentMinutes = timeToMinutes(currentTimeStr);
          const etaMinutes = currentMinutes + travelTime;
          startedDeliveryETA = minutesToTime(etaMinutes);
          
          console.log(`   ⏱️ Base time: ${currentTimeStr}`);
          console.log(`   ⏱️ Started delivery ETA: ${startedDeliveryETA} (${travelTime} min travel, ${distance.toFixed(2)} km)`);
          
          // Update the started delivery object with calculated ETA
          startedDelivery.delivery_time_eta = startedDeliveryETA;
          startedDelivery.estimated_arrival = startedDeliveryETA;
        }
        
        // Remove started delivery from incompleteDeliveries - we'll add it first later
        const startedIndex = incompleteDeliveries.findIndex(d => d && d.id === startedDeliveryId);
        if (startedIndex !== -1) {
          incompleteDeliveries.splice(startedIndex, 1);
        }
      }
    }
    
    // =============================================
    // PICKUP TIME WINDOW LOGIC:
    // Pickups have time windows that indicate WHEN the items will be ready.
    // We MUST respect these windows by ordering pickups chronologically.
    // The ONLY exception is when a started delivery out-of-time-order is detected.
    // =============================================
    
    // Separate pickups and deliveries for proper ordering
    const pickups = incompleteDeliveries.filter(d => !d.patient_id);
    const deliveriesOnly = incompleteDeliveries.filter(d => d.patient_id);
    
    console.log(`   📦 Organizing: ${pickups.length} pickups, ${deliveriesOnly.length} deliveries`);
    
    // Sort pickups STRICTLY by their time windows (these represent when items are READY)
    pickups.sort((a, b) => {
      const aTimeStart = a.delivery_time_start || a.time_window_start || '23:59';
      const bTimeStart = b.delivery_time_start || b.time_window_start || '23:59';
      return timeToMinutes(aTimeStart) - timeToMinutes(bTimeStart);
    });
    
    console.log('   📋 Pickups sorted by time window:');
    pickups.forEach((p, i) => {
      const store = stores.find(s => s?.id === p.store_id);
      const tw = p.delivery_time_start || p.time_window_start || 'No TW';
      console.log(`      ${i + 1}. ${store?.name || 'Unknown'} - Ready at: ${tw}`);
    });
    
    // Sort deliveries by their time windows
    deliveriesOnly.sort((a, b) => {
      const aTimeStart = a.time_window_start || a.delivery_time_start || '23:59';
      const bTimeStart = b.time_window_start || b.delivery_time_start || '23:59';
      const aMinutes = timeToMinutes(aTimeStart);
      const bMinutes = timeToMinutes(bTimeStart);
      
      if (aMinutes !== bMinutes) {
        return aMinutes - bMinutes;
      }
      return (a.stop_order || 0) - (b.stop_order || 0);
    });
    
    // INTERLEAVE pickups and deliveries based on time windows
    // Goal: Do pickups BEFORE their items are needed for deliveries
    const currentTimeStr = getCurrentTime(clientCurrentTime);
    const currentMinutes = timeToMinutes(currentTimeStr);
    
    // Clear incompleteDeliveries and rebuild with proper ordering
    incompleteDeliveries.length = 0;
    
    // Track which pickups have been added
    const addedPickups = new Set();
    const addedDeliveries = new Set();
    
    // Build the route by interleaving
    // First: Add any pickups that are already past their time (should be done ASAP)
    for (const pickup of pickups) {
      const pickupTime = timeToMinutes(pickup.delivery_time_start || pickup.time_window_start || '00:00');
      if (pickupTime <= currentMinutes && !addedPickups.has(pickup.id)) {
        incompleteDeliveries.push(pickup);
        addedPickups.add(pickup.id);
      }
    }
    
    // Then: Add remaining pickups and deliveries in time order
    // Merge pickups and deliveries into a single time-ordered list
    const allStops = [...pickups.filter(p => !addedPickups.has(p.id)), ...deliveriesOnly];
    allStops.sort((a, b) => {
      const aIsPickup = !a.patient_id;
      const bIsPickup = !b.patient_id;
      const aTime = timeToMinutes(a.delivery_time_start || a.time_window_start || '23:59');
      const bTime = timeToMinutes(b.delivery_time_start || b.time_window_start || '23:59');
      
      // If times are equal, pickups come first
      if (aTime === bTime) {
        if (aIsPickup && !bIsPickup) return -1;
        if (!aIsPickup && bIsPickup) return 1;
      }
      
      return aTime - bTime;
    });
    
    for (const stop of allStops) {
      const isPickup = !stop.patient_id;
      if (isPickup && addedPickups.has(stop.id)) continue;
      if (!isPickup && addedDeliveries.has(stop.id)) continue;
      
      incompleteDeliveries.push(stop);
      if (isPickup) {
        addedPickups.add(stop.id);
      } else {
        addedDeliveries.add(stop.id);
      }
    }
    
    console.log('✅ Pre-sorted remaining incomplete deliveries:');
    incompleteDeliveries.forEach((d, i) => {
      const name = d.patient_id 
        ? patients.find(p => p?.id === d.patient_id)?.full_name || 'Unknown'
        : stores.find(s => s?.id === d.store_id)?.name + ' Pickup' || 'Pickup';
      const tw = d.time_window_start || d.delivery_time_start || 'No TW';
      console.log(`   ${i + 1}. ${name} - TW: ${tw}`);
    });
    
    // =============================================
    // STEP 3: Determine starting point for optimization
    // =============================================
    console.log('');
    console.log('🏗️ STEP 3: Determining starting location for optimization');
    
    let startLocation = null;
    let startTime = null;
    
    // If we have a started delivery, use ITS location and ETA as the starting point for remaining stops
    if (startedDelivery && startedDeliveryLocation && startedDeliveryETA) {
      startLocation = startedDeliveryLocation;
      // Add stop time to the started delivery's ETA for when driver will leave
      const stopDuration = startedDelivery.extra_time || 5;
      startTime = timeToMinutes(startedDeliveryETA) + stopDuration;
      console.log(`   ✅ Using started delivery location as start point (will leave at ${minutesToTime(startTime)})`);
    }
    // Otherwise, use normal priority order
    else {
      // Priority 1: Use provided current location
      if (currentLocation?.lat && currentLocation?.lon) {
        startLocation = currentLocation;
        startTime = timeToMinutes(getCurrentTime(clientCurrentTime));
        console.log(`   ✅ Using provided current location`);
      }
      // Priority 2: Use driver's last known GPS location
      else if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
        const locationAge = driverAppUser.location_updated_at 
          ? Date.now() - new Date(driverAppUser.location_updated_at).getTime()
          : Infinity;

        if (locationAge < 5 * 60 * 1000) { // Less than 5 minutes old
          startLocation = { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude };
          startTime = timeToMinutes(getCurrentTime(clientCurrentTime));
          console.log(`   ✅ Using driver's GPS location (${Math.round(locationAge / 1000)}s old)`);
        }
      }
      // Priority 3: Use last completed stop
      if (!startLocation && completedDeliveries.length > 0) {
        const sortedCompleted = [...completedDeliveries].sort((a, b) => 
          new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time)
        );
        const lastCompleted = sortedCompleted[0];

        const location = lastCompleted.patient_id
          ? patients.find(p => p?.id === lastCompleted.patient_id)
          : stores.find(s => s?.id === lastCompleted.store_id);

        if (location?.latitude && location?.longitude) {
          startLocation = { lat: location.latitude, lon: location.longitude };
          startTime = timeToMinutes(getCurrentTime(clientCurrentTime));
          console.log(`   ✅ Using last completed stop location`);
        }
      }
      // Priority 4: Use first incomplete stop
      if (!startLocation && incompleteDeliveries.length > 0) {
        const firstStop = incompleteDeliveries.sort((a, b) => 
          (a.stop_order || 0) - (b.stop_order || 0)
        )[0];
        
        const location = firstStop.patient_id
          ? patients.find(p => p?.id === firstStop.patient_id)
          : stores.find(s => s?.id === firstStop.store_id);
        
        if (location?.latitude && location?.longitude) {
          startLocation = { lat: location.latitude, lon: location.longitude };
          startTime = timeToMinutes(firstStop.delivery_time_start || '09:00');
          console.log(`   ✅ Using first incomplete stop as start`);
        }
      }
    }
    
    if (startLocation) {
      console.log(`📍 Start: [${startLocation.lat.toFixed(6)}, ${startLocation.lon.toFixed(6)}] at ${minutesToTime(startTime || 600)}`);
    }
    
    // =============================================
    // STEP 4: Enrich deliveries with coordinates
    // =============================================
    console.log('');
    console.log('🏗️ STEP 4: Enriching deliveries with coordinates');
    
    const enrichedIncomplete = incompleteDeliveries.map(delivery => {
      if (!delivery) return null;
      const enriched = { ...delivery };
      
      if (delivery.patient_id) {
        const patient = patients.find(p => p?.id === delivery.patient_id);
        if (patient?.latitude && patient?.longitude) {
          enriched.latitude = patient.latitude;
          enriched.longitude = patient.longitude;
        }
      } else {
        const store = stores.find(s => s?.id === delivery.store_id);
        if (store?.latitude && store?.longitude) {
          enriched.latitude = store.latitude;
          enriched.longitude = store.longitude;
        }
      }
      
      return enriched;
    }).filter(d => d && d.latitude && d.longitude);
    
    console.log(`✅ Enriched ${enrichedIncomplete.length} deliveries with coordinates`);
    
    // =============================================
    // STEP 5: Optimize the route with current location and time
    // =============================================
    console.log('');
    console.log('🏗️ STEP 5: Running optimization algorithm');
    console.log(`   📍 Start location: ${startLocation ? `[${startLocation.lat.toFixed(6)}, ${startLocation.lon.toFixed(6)}]` : 'None'}`);
    console.log(`   ⏰ Start time: ${startTime !== null ? minutesToTime(startTime) : 'None'}`);
    
    const optimizedRoute = optimizeStoreRoute(
      enrichedIncomplete,
      startLocation,
      startTime,
      driverHome,
      patients
    );
    
    console.log(`✅ Optimized route: ${optimizedRoute.length} stops`);
    console.log('📋 Route order after optimization:');
    optimizedRoute.forEach((stop, idx) => {
      const name = stop.patient_id 
        ? patients.find(p => p?.id === stop.patient_id)?.full_name || 'Unknown'
        : stores.find(s => s?.id === stop.store_id)?.name + ' Pickup' || 'Pickup';
      console.log(`   ${idx + 1}. ${name} - ETA: ${stop.estimated_arrival || 'calculating...'}`);
    });
    
    // If we had a started delivery, prepend it to the optimized route
    if (startedDelivery) {
      // Enrich started delivery with coordinates if not already done
      if (!startedDelivery.latitude || !startedDelivery.longitude) {
        if (startedDelivery.patient_id) {
          const patient = patients.find(p => p?.id === startedDelivery.patient_id);
          if (patient?.latitude && patient?.longitude) {
            startedDelivery.latitude = patient.latitude;
            startedDelivery.longitude = patient.longitude;
          }
        } else {
          const store = stores.find(s => s?.id === startedDelivery.store_id);
          if (store?.latitude && store?.longitude) {
            startedDelivery.latitude = store.latitude;
            startedDelivery.longitude = store.longitude;
          }
        }
      }
      
      optimizedRoute.unshift(startedDelivery);
      console.log(`   ✅ Prepended started delivery to route (now ${optimizedRoute.length} stops)`);
    }
    
    // =============================================
    // STEP 6: Determine which stop should be marked as isNextDelivery
    // =============================================
    console.log('');
    console.log('🏗️ STEP 6: Determining next delivery (first incomplete stop)');
    
    // The first incomplete stop (first in optimizedRoute) is the next delivery
    let nextDeliveryId = null;
    
    if (optimizedRoute.length > 0) {
      // Find the FIRST incomplete stop in the optimized route
      const firstIncomplete = optimizedRoute.find(stop => 
        stop && !finishedStatuses.includes(stop.status)
      );
      
      if (firstIncomplete) {
        nextDeliveryId = firstIncomplete.id;
        const nextName = firstIncomplete.patient_id 
          ? patients.find(p => p?.id === firstIncomplete.patient_id)?.full_name || 'Unknown'
          : stores.find(s => s?.id === firstIncomplete.store_id)?.name + ' Pickup' || 'Pickup';
        console.log(`   ✅ Next delivery: ${nextName} (ID: ${nextDeliveryId})`);
      } else {
        console.log(`   ⚠️ No incomplete stops found in optimized route`);
      }
    } else {
      console.log(`   ⚠️ Optimized route is empty`);
    }
    
    // =============================================
    // STEP 7: Build final route and update database
    // =============================================
    console.log('');
    console.log('🏗️ STEP 7: Updating database with optimized route');
    
    // Sort completed by actual delivery time
    const sortedCompleted = [...completedDeliveries].sort((a, b) => 
      new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
    );
    
    // Combine completed + optimized incomplete
    const finalRoute = [...sortedCompleted, ...optimizedRoute];
    
    console.log('📋 Final route to save to DB:');
    console.log(`   Total stops: ${finalRoute.length} (${sortedCompleted.length} completed + ${optimizedRoute.length} incomplete)`);
    
    const updates = [];
    
    for (let i = 0; i < finalRoute.length; i++) {
      const stop = finalRoute[i];
      if (!stop) continue;
      
      const newStopOrder = i + 1;
      // CRITICAL: Only set isNextDelivery=true for the ONE stop that matches nextDeliveryId
      // All other stops MUST be explicitly set to false
      const isNextStop = nextDeliveryId !== null && stop.id === nextDeliveryId;
      
      const updatePayload = {
        stop_order: newStopOrder,
        isNextDelivery: isNextStop // Explicitly set for EVERY delivery
      };
      
      // Only update ETAs for incomplete deliveries
      if (!finishedStatuses.includes(stop.status)) {
        updatePayload.delivery_time_eta = stop.estimated_arrival || stop.delivery_time_start;
      }
      
      console.log(`   💾 Saving #${newStopOrder}: ${stop.patient_name || stores.find(s => s?.id === stop.store_id)?.name + ' Pickup' || 'Unknown'}`);
      console.log(`      • stop_order: ${newStopOrder}`);
      console.log(`      • isNextDelivery: ${isNextStop}`);
      console.log(`      • ETA: ${updatePayload.delivery_time_eta || 'N/A'}`);
      
      await base44.asServiceRole.entities.Delivery.update(stop.id, updatePayload);
      
      updates.push({
        id: stop.id,
        stop_order: newStopOrder,
        isNextDelivery: isNextStop,
        eta: updatePayload.delivery_time_eta
      });
      
      const stopName = stop.patient_id
        ? patients.find(p => p?.id === stop.patient_id)?.full_name
        : stores.find(s => s?.id === stop.store_id)?.name + ' Pickup';
      
      console.log(`   ✅ Saved #${newStopOrder}: ${stopName}${isNextStop ? ' ← NEXT DELIVERY' : ''}`);
    }
    
    console.log(`✅ Database updated: ${updates.length} deliveries saved`);
    
    // =============================================
    // STEP 8: Generate blue dotted polyline
    // =============================================
    // RULE 1: Polyline shows from most recent completed/failed/canceled stop 
    //         to the driver's next stop to complete
    console.log('');
    console.log('🏗️ STEP 8: Generating blue dotted polyline');
    console.log('   RULE: From last completed/failed/canceled stop → next stop');
    
    try {
      let originLat = null;
      let originLon = null;
      let destLat = null;
      let destLon = null;
      
      // ORIGIN: Most recent completed/failed/canceled stop
      if (completedDeliveries.length > 0) {
        const sortedCompleted = [...completedDeliveries].sort((a, b) => 
          new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time)
        );
        const lastCompleted = sortedCompleted[0];
        
        if (lastCompleted.patient_id) {
          const patient = patients.find(p => p?.id === lastCompleted.patient_id);
          if (patient?.latitude && patient?.longitude) {
            originLat = patient.latitude;
            originLon = patient.longitude;
            console.log(`   📍 Origin: Last completed stop (${patient.full_name})`);
          }
        } else {
          const store = stores.find(s => s?.id === lastCompleted.store_id);
          if (store?.latitude && store?.longitude) {
            originLat = store.latitude;
            originLon = store.longitude;
            console.log(`   📍 Origin: Last completed pickup (${store.name})`);
          }
        }
      } else {
        console.log('   ⚠️ No completed/failed/canceled stops yet - no polyline to show');
      }
      
      // DESTINATION: Next stop to complete
      if (nextDeliveryId) {
        const nextDelivery = finalRoute.find(d => d && d.id === nextDeliveryId);
        if (nextDelivery && nextDelivery.latitude && nextDelivery.longitude) {
          destLat = nextDelivery.latitude;
          destLon = nextDelivery.longitude;
          const destName = nextDelivery.patient_id 
            ? patients.find(p => p?.id === nextDelivery.patient_id)?.full_name || 'Patient'
            : stores.find(s => s?.id === nextDelivery.store_id)?.name || 'Store';
          console.log(`   🎯 Destination: Next stop (${destName})`);
        }
      }
      
      // Only generate polyline if we have both origin and destination
      if (originLat && originLon && destLat && destLon) {
        console.log('   🌐 Calling Google Directions API...');
        
        let encodedPolyline = null;
        let distanceKm = null;
        let durationSeconds = null;
        
        try {
          const directionsResponse = await base44.asServiceRole.functions.invoke('getGoogleDirections', {
            origin_lat: originLat,
            origin_lon: originLon,
            dest_lat: destLat,
            dest_lon: destLon
          });
          
          if (directionsResponse?.encoded_polyline) {
            encodedPolyline = directionsResponse.encoded_polyline;
            distanceKm = directionsResponse.distance_km;
            durationSeconds = directionsResponse.duration_seconds;
            console.log(`   ✅ Got polyline (${distanceKm?.toFixed(2)} km, ${Math.round((durationSeconds || 0) / 60)} min)`);
          } else {
            console.warn('   ⚠️ Google Directions returned no polyline');
          }
        } catch (directionsError) {
          console.warn('   ⚠️ Google Directions API error:', directionsError.message);
        }
        
        // Save polyline to database
        const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        });
        
        const polylineData = {
          segment_origin_lat: originLat,
          segment_origin_lon: originLon,
          segment_dest_lat: destLat,
          segment_dest_lon: destLon,
          encoded_polyline: encodedPolyline,
          estimated_distance_km: distanceKm,
          estimated_duration_seconds: durationSeconds,
          last_generated_at: new Date().toISOString()
        };
        
        if (existingPolylines && existingPolylines.length > 0) {
          await base44.asServiceRole.entities.DriverRoutePolyline.update(
            existingPolylines[0].id,
            polylineData
          );
          console.log('   ✅ Updated polyline record');
        } else {
          await base44.asServiceRole.entities.DriverRoutePolyline.create({
            driver_id: driverId,
            delivery_date: deliveryDate,
            ...polylineData
          });
          console.log('   ✅ Created polyline record');
        }
      } else {
        console.log('   ⏭️ No polyline generated (need both origin and destination)');
      }
    } catch (polylineError) {
      console.warn('   ⚠️ Could not generate polyline:', polylineError.message);
    }
    
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('✅ [Backend Optimizer] Complete!');
    console.log(`   Updated ${updates.length} deliveries`);
    console.log('═══════════════════════════════════');
    
    return Response.json({
      success: true,
      message: `Optimized route with ${updates.length} stops`,
      updates,
      routeComplete: false
    });
    
  } catch (error) {
    console.error('❌ [Backend Optimizer] Error:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});