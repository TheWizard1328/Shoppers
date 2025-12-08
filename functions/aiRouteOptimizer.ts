/**
 * AI-Powered Route Optimizer
 * 
 * This function performs intelligent route optimization using AI analysis.
 * It considers:
 * - Current traffic conditions
 * - Time windows
 * - Driver location
 * - New delivery assignments
 * - Historical delivery patterns
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Get current time in Eastern Time
const getCurrentTimeET = () => {
  const now = new Date();
  return now.toLocaleString('en-US', { 
    timeZone: 'America/Toronto', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
};

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Convert time string to minutes
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

// Convert minutes to time string
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

// Estimate travel time with traffic consideration
const estimateTravelTimeWithTraffic = (distanceKm, timeOfDay, trafficConditions = 'normal') => {
  let baseSpeedKmH = 30;
  const hour = parseInt(timeOfDay?.split(':')[0] || '10');
  
  // Rush hour adjustments
  if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18)) {
    baseSpeedKmH = 20;
  } else if (hour >= 22 || hour <= 6) {
    baseSpeedKmH = 40;
  }
  
  // Traffic condition multipliers
  const trafficMultipliers = {
    'light': 1.2,
    'normal': 1.0,
    'moderate': 0.8,
    'heavy': 0.6,
    'severe': 0.4
  };
  
  const multiplier = trafficMultipliers[trafficConditions] || 1.0;
  const effectiveSpeed = baseSpeedKmH * multiplier;
  
  return Math.round((distanceKm / effectiveSpeed) * 60);
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { 
      driverId, 
      deliveryDate, 
      currentLocation,
      trigger = 'manual', // 'on_duty', 'delivery_complete', 'manual', 'new_assignment'
      completedDeliveryId,
      enableAIAnalysis = true
    } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId and deliveryDate' 
      }, { status: 400 });
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('🤖 [AI Route Optimizer] Starting intelligent optimization');
    console.log('═══════════════════════════════════════════════');
    console.log(`📅 Date: ${deliveryDate}`);
    console.log(`🚗 Driver ID: ${driverId}`);
    console.log(`🎯 Trigger: ${trigger}`);
    console.log(`📍 Current Location: ${currentLocation ? `[${currentLocation.latitude}, ${currentLocation.longitude}]` : 'Not provided'}`);
    
    // Fetch all necessary data
    const [deliveries, patients, stores, appUsers] = await Promise.all([
      base44.asServiceRole.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }),
      base44.asServiceRole.entities.Patient.list(),
      base44.asServiceRole.entities.Store.list(),
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId })
    ]);
    
    console.log(`✅ Fetched ${deliveries.length} deliveries, ${patients.length} patients`);
    
    const driverAppUser = appUsers[0];
    const driverName = driverAppUser?.user_name || 'Driver';
    
    // Categorize deliveries
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const incompleteDeliveries = deliveries.filter(d => d && !finishedStatuses.includes(d.status));
    const completedDeliveries = deliveries.filter(d => d && finishedStatuses.includes(d.status));
    
    console.log(`📊 Incomplete: ${incompleteDeliveries.length}, Completed: ${completedDeliveries.length}`);
    
    if (incompleteDeliveries.length === 0) {
      console.log('✅ All deliveries complete - no optimization needed');
      return Response.json({
        success: true,
        message: 'Route complete - no optimization needed',
        routeComplete: true,
        notification: {
          type: 'route_complete',
          title: 'Route Complete! 🎉',
          message: `Congratulations! All ${completedDeliveries.length} stops completed.`
        }
      });
    }
    
    // Determine driver's current location (priority: provided location > GPS > last completed stop)
    let startLocation = null;
    let startLocationSource = null;
    
    if (currentLocation?.latitude && currentLocation?.longitude) {
      startLocation = currentLocation;
      startLocationSource = 'provided';
      console.log(`   📍 Using provided current location`);
    } else if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
      const locationAge = driverAppUser.location_updated_at 
        ? Date.now() - new Date(driverAppUser.location_updated_at).getTime()
        : Infinity;
      if (locationAge < 10 * 60 * 1000) {
        startLocation = { latitude: driverAppUser.current_latitude, longitude: driverAppUser.current_longitude };
        startLocationSource = 'GPS';
        console.log(`   📍 Using driver GPS location (${Math.round(locationAge / 1000)}s old)`);
      }
    }
    
    // Fallback: Use last completed delivery location
    if (!startLocation && completedDeliveries.length > 0) {
      const sortedCompleted = [...completedDeliveries].sort((a, b) => {
        const timeA = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
        const timeB = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
        return timeB - timeA; // Most recent first
      });
      const lastCompleted = sortedCompleted[0];
      
      // Get location from patient or store
      if (lastCompleted.patient_id) {
        const patient = patients.find(p => p?.id === lastCompleted.patient_id);
        if (patient?.latitude && patient?.longitude) {
          startLocation = { latitude: patient.latitude, longitude: patient.longitude };
          startLocationSource = 'last_completed';
          console.log(`   📍 Using last completed delivery location (${patient.full_name})`);
        }
      } else {
        const store = stores.find(s => s?.id === lastCompleted.store_id);
        if (store?.latitude && store?.longitude) {
          startLocation = { latitude: store.latitude, longitude: store.longitude };
          startLocationSource = 'last_completed';
          console.log(`   📍 Using last completed pickup location (${store.name})`);
        }
      }
    }
    
    // Final fallback: Use driver home location
    if (!startLocation && driverAppUser?.home_latitude && driverAppUser?.home_longitude) {
      startLocation = { latitude: driverAppUser.home_latitude, longitude: driverAppUser.home_longitude };
      startLocationSource = 'home';
      console.log(`   📍 Using driver home location (fallback)`);
    }
    
    console.log(`   📍 Start location source: ${startLocationSource || 'none'}`)
    
    // Enrich deliveries with coordinates
    const enrichedDeliveries = incompleteDeliveries.map(delivery => {
      const enriched = { ...delivery };
      if (delivery.patient_id) {
        const patient = patients.find(p => p?.id === delivery.patient_id);
        if (patient?.latitude && patient?.longitude) {
          enriched.latitude = patient.latitude;
          enriched.longitude = patient.longitude;
          enriched.patientName = patient.full_name;
        }
      } else {
        const store = stores.find(s => s?.id === delivery.store_id);
        if (store?.latitude && store?.longitude) {
          enriched.latitude = store.latitude;
          enriched.longitude = store.longitude;
          enriched.patientName = `${store.name} Pickup`;
        }
      }
      return enriched;
    }).filter(d => d.latitude && d.longitude);
    
    // AI Analysis Phase
    let aiSuggestions = null;
    let trafficConditions = 'normal';
    
    if (enableAIAnalysis && enrichedDeliveries.length > 1) {
      console.log('');
      console.log('🧠 [AI Analysis] Analyzing route with AI...');
      
      try {
        const currentTime = getCurrentTimeET();
        const hour = parseInt(currentTime.split(':')[0]);
        
        // Build context for AI
        const routeContext = {
          driverName,
          currentTime,
          totalStops: enrichedDeliveries.length,
          deliveries: enrichedDeliveries.map(d => ({
            name: d.patientName,
            timeWindow: d.time_window_start && d.time_window_end 
              ? `${d.time_window_start}-${d.time_window_end}` 
              : 'flexible',
            status: d.status,
            hasCOD: (d.cod_total_amount_required || 0) > 0,
            isPickup: !d.patient_id
          })),
          isRushHour: (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18),
          dayOfWeek: new Date(deliveryDate).toLocaleDateString('en-US', { weekday: 'long' })
        };
        
        const aiPrompt = `You are a delivery route optimization assistant. Analyze this route and provide brief, actionable suggestions.

Route Context:
- Driver: ${routeContext.driverName}
- Current time: ${routeContext.currentTime}
- Day: ${routeContext.dayOfWeek}
- Total stops remaining: ${routeContext.totalStops}
- Rush hour: ${routeContext.isRushHour ? 'Yes' : 'No'}

Stops:
${routeContext.deliveries.map((d, i) => `${i+1}. ${d.name} (${d.timeWindow}) - ${d.status}${d.hasCOD ? ' [COD]' : ''}${d.isPickup ? ' [PICKUP]' : ''}`).join('\n')}

Provide:
1. Traffic assessment (light/normal/moderate/heavy)
2. One key priority suggestion
3. Any time-sensitive alerts`;

        const aiResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: aiPrompt,
          response_json_schema: {
            type: 'object',
            properties: {
              trafficAssessment: { 
                type: 'string', 
                enum: ['light', 'normal', 'moderate', 'heavy', 'severe'] 
              },
              prioritySuggestion: { type: 'string' },
              alerts: { 
                type: 'array', 
                items: { type: 'string' } 
              },
              recommendedFirstStop: { type: 'string' },
              estimatedCompletionTime: { type: 'string' }
            }
          }
        });
        
        if (aiResponse) {
          aiSuggestions = aiResponse;
          trafficConditions = aiResponse.trafficAssessment || 'normal';
          console.log(`   ✅ AI Analysis complete - Traffic: ${trafficConditions}`);
          console.log(`   💡 Suggestion: ${aiResponse.prioritySuggestion}`);
        }
      } catch (aiError) {
        console.warn('   ⚠️ AI analysis failed:', aiError.message);
      }
    }
    
    // Optimize route with traffic-aware timing
    console.log('');
    console.log('🔄 [Optimization] Calculating optimal route...');
    
    const currentTimeStr = getCurrentTimeET();
    let currentMinutes = timeToMinutes(currentTimeStr);
    let currentLoc = startLocation || { latitude: enrichedDeliveries[0].latitude, longitude: enrichedDeliveries[0].longitude };
    
    // =============================================
    // PICKUP-CENTRIC OPTIMIZATION STRATEGY
    // 1. Order pickups by their time windows (e.g., Kingsway, Bonnie Doon AM, Scona, Meadows, Bonnie Doon PM)
    // 2. Between each pickup, maximize deliveries that can be done en-route to reduce backtracking
    // 3. Flexible deliveries (no time window or 4+ hour window) can go anywhere based on distance
    // =============================================
    
    const optimizedRoute = [];
    const remaining = [...enrichedDeliveries];
    
    // Separate pickups and deliveries
    const pickups = remaining.filter(d => !d.patient_id);
    const deliveriesOnly = remaining.filter(d => d.patient_id);
    
    console.log(`   📦 Organizing: ${pickups.length} pickups, ${deliveriesOnly.length} deliveries`);
    
    // Sort pickups STRICTLY by time window (this sets the pickup order: Kingsway → BD AM → Scona → Meadows → BD PM)
    pickups.sort((a, b) => {
      const aTime = timeToMinutes(a.delivery_time_start || a.time_window_start || '23:59');
      const bTime = timeToMinutes(b.delivery_time_start || b.time_window_start || '23:59');
      return aTime - bTime;
    });
    
    console.log('   📋 Pickup order (by time window):');
    pickups.forEach((p, i) => {
      const store = stores.find(s => s?.id === p.store_id);
      const tw = p.delivery_time_start || p.time_window_start || 'No TW';
      const ampm = p.ampm_deliveries || '';
      console.log(`      ${i + 1}. ${store?.name || 'Unknown'}${ampm ? ` [${ampm}]` : ''} - Ready at: ${tw}`);
    });
    
    // Group deliveries by their linked pickup (via PUID)
    const deliveriesByPickup = new Map();
    const unlinkedDeliveries = [];
    
    for (const delivery of deliveriesOnly) {
      if (delivery.puid) {
        // Find which pickup this delivery belongs to
        const linkedPickup = pickups.find(p => p.stop_id === delivery.puid);
        if (linkedPickup) {
          if (!deliveriesByPickup.has(linkedPickup.id)) {
            deliveriesByPickup.set(linkedPickup.id, []);
          }
          deliveriesByPickup.get(linkedPickup.id).push(delivery);
        } else {
          unlinkedDeliveries.push(delivery);
        }
      } else {
        unlinkedDeliveries.push(delivery);
      }
    }
    
    console.log(`   🔗 Linked deliveries: ${deliveriesOnly.length - unlinkedDeliveries.length}, Unlinked: ${unlinkedDeliveries.length}`);
    
    // First: Add any in_transit deliveries ONLY if their pickup is completed
    const inTransit = remaining.filter(d => d.status === 'in_transit');
    for (const delivery of inTransit) {
      // CRITICAL: Check if this delivery requires a pickup
      if (delivery.puid && !completedPickupStopIds.has(delivery.puid)) {
        console.log(`   ⚠️ Skipping in_transit delivery ${delivery.patientName} - pickup not completed yet (PUID: ${delivery.puid})`);
        continue; // Don't add it yet - will be added after its pickup
      }
      
      const idx = remaining.findIndex(d => d.id === delivery.id);
      if (idx !== -1) remaining.splice(idx, 1);
      
      const distance = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        delivery.latitude, delivery.longitude
      );
      const travelTime = estimateTravelTimeWithTraffic(distance, currentTimeStr, trafficConditions);
      currentMinutes += travelTime;
      
      delivery.calculatedETA = minutesToTime(currentMinutes);
      delivery.estimatedTravelTime = travelTime;
      
      currentMinutes += (delivery.extra_time || 5);
      currentLoc = { latitude: delivery.latitude, longitude: delivery.longitude };
      
      optimizedRoute.push(delivery);
      
      // Remove from pickups/deliveries lists if present
      const pickupIdx = pickups.findIndex(p => p.id === delivery.id);
      if (pickupIdx !== -1) pickups.splice(pickupIdx, 1);
      const deliveryIdx = unlinkedDeliveries.findIndex(d => d.id === delivery.id);
      if (deliveryIdx !== -1) unlinkedDeliveries.splice(deliveryIdx, 1);
      
      console.log(`   ✅ Added in_transit delivery: ${delivery.patientName} (pickup already done)`);
    }
    
    // Track completed pickup stop_ids (from database - already done)
    const completedPickupStopIds = new Set();
    
    // Add already completed pickups to the set (status = completed)
    const alreadyCompletedPickups = deliveries.filter(d => 
      !d.patient_id && finishedStatuses.includes(d.status)
    );
    for (const completedPickup of alreadyCompletedPickups) {
      if (completedPickup.stop_id) {
        completedPickupStopIds.add(completedPickup.stop_id);
      }
    }
    
    console.log(`   ✅ Already completed pickups: ${completedPickupStopIds.size}`);
    
    // Process pickups in time-window order
    // Between each pickup, do deliveries that are:
    // 1. Already picked up (their pickup's stop_id is in completedPickupStopIds)
    // 2. Flexible/unlinked and on the way to minimize backtracking
    
    for (let pickupIdx = 0; pickupIdx < pickups.length; pickupIdx++) {
      const currentPickup = pickups[pickupIdx];
      const nextPickup = pickups[pickupIdx + 1];
      
      // CRITICAL FIX: Only do deliveries from ALREADY COMPLETED pickups (not the current one we're about to do)
      // Get deliveries that are already picked up (from previous pickups)
      const availableDeliveries = [];
      
      // Add deliveries from completed pickups ONLY
      for (const [pickupId, linkedDeliveries] of deliveriesByPickup.entries()) {
        const pickup = pickups.find(p => p.id === pickupId);
        // CRITICAL: Only include deliveries from pickups that are ALREADY in completedPickupStopIds
        if (pickup && completedPickupStopIds.has(pickup.stop_id)) {
          availableDeliveries.push(...linkedDeliveries.filter(d => 
            !optimizedRoute.some(o => o.id === d.id)
          ));
        }
      }
      
      // Add ONLY truly unlinked/flexible deliveries (no PUID at all)
      const flexibleDeliveries = unlinkedDeliveries.filter(d => {
        if (optimizedRoute.some(o => o.id === d.id)) return false;
        
        // Must have NO PUID (truly unlinked)
        if (d.puid) return false;
        
        // Check if delivery has a flexible window (no window or 4+ hours)
        const twStart = d.time_window_start || d.delivery_time_start;
        const twEnd = d.time_window_end || d.delivery_time_end;
        if (!twStart) return true; // No time window = flexible
        
        const windowDuration = timeToMinutes(twEnd || '23:59') - timeToMinutes(twStart || '00:00');
        return windowDuration >= 240; // 4+ hours = flexible
      });
      availableDeliveries.push(...flexibleDeliveries);
      
      // Do deliveries that are ON THE WAY to the next pickup (minimize backtracking)
      // Score deliveries by: how much they reduce distance to next destination
      if (availableDeliveries.length > 0) {
        const nextDestination = currentPickup; // We're heading to this pickup
        
        // Sort available deliveries by efficiency (how much they're "on the way")
        const scoredDeliveries = availableDeliveries.map(delivery => {
          const directDistance = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            nextDestination.latitude, nextDestination.longitude
          );
          const viaDeliveryDistance = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            delivery.latitude, delivery.longitude
          ) + calculateDistance(
            delivery.latitude, delivery.longitude,
            nextDestination.latitude, nextDestination.longitude
          );
          
          // Detour = extra distance to do this delivery
          const detour = viaDeliveryDistance - directDistance;
          
          // Also consider time window urgency
          let urgencyBonus = 0;
          if (delivery.time_window_start && delivery.time_window_end) {
            const windowEnd = timeToMinutes(delivery.time_window_end);
            if (currentMinutes > windowEnd - 60) urgencyBonus = 50; // Urgent
            if (currentMinutes > windowEnd - 30) urgencyBonus = 100; // Very urgent
          }
          
          return { delivery, detour, urgencyBonus, score: urgencyBonus - detour };
        });
        
        // Only do deliveries with reasonable detour (< 5km extra) or urgent ones
        const worthwhileDeliveries = scoredDeliveries
          .filter(s => s.detour < 5 || s.urgencyBonus > 0)
          .sort((a, b) => b.score - a.score);
        
        for (const { delivery } of worthwhileDeliveries) {
          const distance = calculateDistance(
            currentLoc.latitude, currentLoc.longitude,
            delivery.latitude, delivery.longitude
          );
          const travelTime = estimateTravelTimeWithTraffic(distance, minutesToTime(currentMinutes), trafficConditions);
          currentMinutes += travelTime;
          
          delivery.calculatedETA = minutesToTime(currentMinutes);
          delivery.estimatedTravelTime = travelTime;
          
          currentMinutes += (delivery.extra_time || 5);
          currentLoc = { latitude: delivery.latitude, longitude: delivery.longitude };
          
          optimizedRoute.push(delivery);
          
          // Remove from unlinked list
          const unlinkedIdx = unlinkedDeliveries.findIndex(d => d.id === delivery.id);
          if (unlinkedIdx !== -1) unlinkedDeliveries.splice(unlinkedIdx, 1);
          
          console.log(`      📍 En-route delivery: ${delivery.patientName} (ETA: ${delivery.calculatedETA})`);
        }
      }
      
      // Now do the pickup
      // But first, ensure we don't arrive before the pickup time window
      const pickupWindowStart = timeToMinutes(currentPickup.delivery_time_start || currentPickup.time_window_start || '00:00');
      
      const distanceToPickup = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        currentPickup.latitude, currentPickup.longitude
      );
      const travelTimeToPickup = estimateTravelTimeWithTraffic(distanceToPickup, minutesToTime(currentMinutes), trafficConditions);
      let arrivalAtPickup = currentMinutes + travelTimeToPickup;
      
      // If we'd arrive early, adjust ETA to window start
      if (arrivalAtPickup < pickupWindowStart) {
        console.log(`      ⏰ Would arrive at pickup ${arrivalAtPickup} < ${pickupWindowStart}, waiting until items ready`);
        arrivalAtPickup = pickupWindowStart;
      }
      
      currentMinutes = arrivalAtPickup;
      currentPickup.calculatedETA = minutesToTime(currentMinutes);
      currentPickup.estimatedTravelTime = travelTimeToPickup;
      
      currentMinutes += (currentPickup.extra_time || 5);
      currentLoc = { latitude: currentPickup.latitude, longitude: currentPickup.longitude };
      
      optimizedRoute.push(currentPickup);
      completedPickupStopIds.add(currentPickup.stop_id);
      
      const pickupStore = stores.find(s => s?.id === currentPickup.store_id);
      console.log(`      🏪 Pickup: ${pickupStore?.name || 'Unknown'} (ETA: ${currentPickup.calculatedETA})`);
      
      // After this pickup, do its linked deliveries (optimized by distance)
      const linkedDeliveries = deliveriesByPickup.get(currentPickup.id) || [];
      const remainingLinked = linkedDeliveries.filter(d => !optimizedRoute.some(o => o.id === d.id));
      
      // Sort linked deliveries by distance from current location
      remainingLinked.sort((a, b) => {
        const distA = calculateDistance(currentLoc.latitude, currentLoc.longitude, a.latitude, a.longitude);
        const distB = calculateDistance(currentLoc.latitude, currentLoc.longitude, b.latitude, b.longitude);
        return distA - distB;
      });
      
      // If there's a next pickup, also consider doing deliveries that are "on the way"
      if (nextPickup) {
        // Score by: distance efficiency to next pickup
        remainingLinked.sort((a, b) => {
          const directToNext = calculateDistance(currentLoc.latitude, currentLoc.longitude, nextPickup.latitude, nextPickup.longitude);
          
          const viaA = calculateDistance(currentLoc.latitude, currentLoc.longitude, a.latitude, a.longitude) +
                       calculateDistance(a.latitude, a.longitude, nextPickup.latitude, nextPickup.longitude);
          const viaB = calculateDistance(currentLoc.latitude, currentLoc.longitude, b.latitude, b.longitude) +
                       calculateDistance(b.latitude, b.longitude, nextPickup.latitude, nextPickup.longitude);
          
          const detourA = viaA - directToNext;
          const detourB = viaB - directToNext;
          
          return detourA - detourB; // Less detour = better
        });
      }
      
      for (const delivery of remainingLinked) {
        const distance = calculateDistance(
          currentLoc.latitude, currentLoc.longitude,
          delivery.latitude, delivery.longitude
        );
        const travelTime = estimateTravelTimeWithTraffic(distance, minutesToTime(currentMinutes), trafficConditions);
        currentMinutes += travelTime;
        
        delivery.calculatedETA = minutesToTime(currentMinutes);
        delivery.estimatedTravelTime = travelTime;
        
        currentMinutes += (delivery.extra_time || 5);
        currentLoc = { latitude: delivery.latitude, longitude: delivery.longitude };
        
        optimizedRoute.push(delivery);
        console.log(`      📍 Delivery: ${delivery.patientName} (ETA: ${delivery.calculatedETA})`);
      }
    }
    
    // Finally, add any remaining unlinked deliveries (sorted by distance)
    const remainingDeliveries = unlinkedDeliveries.filter(d => !optimizedRoute.some(o => o.id === d.id));
    remainingDeliveries.sort((a, b) => {
      const distA = calculateDistance(currentLoc.latitude, currentLoc.longitude, a.latitude, a.longitude);
      const distB = calculateDistance(currentLoc.latitude, currentLoc.longitude, b.latitude, b.longitude);
      return distA - distB;
    });
    
    for (const delivery of remainingDeliveries) {
      const distance = calculateDistance(
        currentLoc.latitude, currentLoc.longitude,
        delivery.latitude, delivery.longitude
      );
      const travelTime = estimateTravelTimeWithTraffic(distance, minutesToTime(currentMinutes), trafficConditions);
      currentMinutes += travelTime;
      
      delivery.calculatedETA = minutesToTime(currentMinutes);
      delivery.estimatedTravelTime = travelTime;
      
      currentMinutes += (delivery.extra_time || 5);
      currentLoc = { latitude: delivery.latitude, longitude: delivery.longitude };
      
      optimizedRoute.push(delivery);
      console.log(`      📍 Remaining delivery: ${delivery.patientName} (ETA: ${delivery.calculatedETA})`);
    }
    
    // Update database with optimized route
    console.log('');
    console.log('💾 [Database] Updating delivery records...');
    
    // First reset all isNextDelivery flags
    for (const delivery of deliveries) {
      if (delivery.isNextDelivery) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
    }
    
    // Update with new order and ETAs
    const baseStopOrder = completedDeliveries.length;
    const updates = [];
    
    for (let i = 0; i < optimizedRoute.length; i++) {
      const stop = optimizedRoute[i];
      const newStopOrder = baseStopOrder + i + 1;
      const isNextStop = i === 0;
      
      await base44.asServiceRole.entities.Delivery.update(stop.id, {
        stop_order: newStopOrder,
        isNextDelivery: isNextStop,
        delivery_time_eta: stop.calculatedETA
      });
      
      updates.push({
        id: stop.id,
        name: stop.patientName,
        stop_order: newStopOrder,
        eta: stop.calculatedETA,
        isNextDelivery: isNextStop
      });
      
      console.log(`   #${newStopOrder}: ${stop.patientName} - ETA: ${stop.calculatedETA}${isNextStop ? ' ← NEXT' : ''}`);
    }
    
    // Generate polyline for next stop
    let polylineGenerated = false;
    if (optimizedRoute.length > 0 && startLocation) {
      const nextStop = optimizedRoute[0];
      
      try {
        console.log('');
        console.log('🗺️ [Polyline] Generating route to next stop...');
        
        const directionsResponse = await base44.asServiceRole.functions.invoke('getGoogleDirections', {
          origin_lat: startLocation.latitude,
          origin_lon: startLocation.longitude,
          dest_lat: nextStop.latitude,
          dest_lon: nextStop.longitude
        });
        
        if (directionsResponse?.encoded_polyline) {
          const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          });
          
          const polylineData = {
            segment_origin_lat: startLocation.latitude,
            segment_origin_lon: startLocation.longitude,
            segment_dest_lat: nextStop.latitude,
            segment_dest_lon: nextStop.longitude,
            encoded_polyline: directionsResponse.encoded_polyline,
            estimated_distance_km: directionsResponse.distance_km,
            estimated_duration_seconds: directionsResponse.duration_seconds,
            last_generated_at: new Date().toISOString()
          };
          
          if (existingPolylines?.length > 0) {
            await base44.asServiceRole.entities.DriverRoutePolyline.update(existingPolylines[0].id, polylineData);
          } else {
            await base44.asServiceRole.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: deliveryDate,
              ...polylineData
            });
          }
          
          polylineGenerated = true;
          console.log(`   ✅ Polyline generated: ${directionsResponse.distance_km?.toFixed(2)} km`);
        }
      } catch (polyError) {
        console.warn('   ⚠️ Polyline generation failed:', polyError.message);
      }
    }
    
    // Build notification
    const nextStop = optimizedRoute[0];
    let notification = null;
    
    if (trigger === 'on_duty') {
      notification = {
        type: 'route_optimized',
        title: 'Route Ready! 🚗',
        message: `${optimizedRoute.length} stops optimized. First stop: ${nextStop?.patientName || 'Unknown'} (ETA: ${nextStop?.calculatedETA || 'N/A'})`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    } else if (trigger === 'delivery_complete') {
      notification = {
        type: 'next_stop',
        title: 'Next Stop Updated 📍',
        message: `${optimizedRoute.length} stops remaining. Next: ${nextStop?.patientName || 'Unknown'} (ETA: ${nextStop?.calculatedETA || 'N/A'})`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    } else if (trigger === 'new_assignment') {
      notification = {
        type: 'route_updated',
        title: 'Route Updated! 🔄',
        message: `New deliveries added. ${optimizedRoute.length} stops total. Next: ${nextStop?.patientName || 'Unknown'}`,
        aiSuggestion: aiSuggestions?.prioritySuggestion
      };
    }
    
    // Add alerts if any
    if (aiSuggestions?.alerts?.length > 0) {
      notification.alerts = aiSuggestions.alerts;
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('✅ [AI Route Optimizer] Complete!');
    console.log(`   Updated ${updates.length} stops`);
    console.log(`   Traffic: ${trafficConditions}`);
    console.log(`   Polyline: ${polylineGenerated ? 'Generated' : 'Skipped'}`);
    console.log('═══════════════════════════════════════════════');
    
    return Response.json({
      success: true,
      message: `Optimized route with ${updates.length} stops`,
      updates,
      trafficConditions,
      aiSuggestions,
      notification,
      polylineGenerated,
      estimatedCompletionTime: aiSuggestions?.estimatedCompletionTime || minutesToTime(currentMinutes)
    });
    
  } catch (error) {
    console.error('❌ [AI Route Optimizer] Error:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});