import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Staged Route Optimizer
 * 
 * Optimizes driver routes in stages, where each stage is defined by pickup locations.
 * 
 * STAGES:
 * - Stage 1: Driver Home/Current Location → First Pickup
 * - Stage 2: Pickup 1 → Pickup 2 (including all deliveries in between)
 * - Stage N: Pickup N-1 → Pickup N (including all deliveries in between)
 * - Final Stage: Last Pickup → Driver Home (including remaining deliveries)
 * 
 * RULES:
 * 1. Sort deliveries by time windows first (Delivery Stop Time Windows, not Patient Time Windows)
 * 2. Only optimize stages that have unoptimized or new stops
 * 3. If no in_transit deliveries, only optimize Stage 1 (to first pickup)
 * 4. When driver manually triggers optimization, optimize all stages sequentially
 * 5. Update all ETAs in one batch after all stages are optimized
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
      manualTrigger = false,  // If true, optimize all stages
      currentLocation = null   // { lat, lng } - driver's current position
    } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`🚀 Starting staged route optimization for driver ${driverId} on ${deliveryDate}`);
    console.log(`   Manual trigger: ${manualTrigger}`);

    // Get driver info for home location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }

    // Determine driver's starting location
    const driverLocation = currentLocation || {
      lat: driverAppUser.current_latitude || driverAppUser.home_latitude,
      lng: driverAppUser.current_longitude || driverAppUser.home_longitude
    };

    const driverHomeLocation = {
      lat: driverAppUser.home_latitude,
      lng: driverAppUser.home_longitude
    };

    if (!driverLocation.lat || !driverLocation.lng) {
      return Response.json({ 
        error: 'Driver location not available',
        driverId 
      }, { status: 404 });
    }

    // Get ALL deliveries for the driver and date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    });

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ 
        message: 'No deliveries found for optimization',
        stages: []
      });
    }

    // Get patients and stores for coordinates
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

    // STEP 1: Enrich deliveries with coordinates and store info
    const deliveriesWithTimeWindows = allDeliveries.map(d => {
      let coords = null;
      let storeDeliveryTimeStart = null;
      const store = storeMap.get(d.store_id);
      
      if (d.puid) {
        // Pickup - use store coordinates and store's delivery_time_start
        coords = store ? { lat: store.latitude, lng: store.longitude } : null;
        // Get the store's AM/PM delivery_time_start for sorting pickups
        storeDeliveryTimeStart = d.delivery_time_start || null;
      } else {
        // Delivery - use patient coordinates
        const patient = patientMap.get(d.patient_id);
        coords = patient ? { lat: patient.latitude, lng: patient.longitude } : null;
      }

      return {
        ...d,
        coords,
        storeDeliveryTimeStart,
        // Use delivery time window, fallback to patient time window
        effectiveTimeWindowStart: d.time_window_start || null,
        effectiveTimeWindowEnd: d.time_window_end || null,
        isPickup: !!d.puid
      };
    }).filter(d => d.coords); // Filter out deliveries without coordinates

    // STEP 2: Separate pickups, DMR pickups (special deliveries that go before regular pickups), and regular deliveries
    const pickups = deliveriesWithTimeWindows.filter(d => d.isPickup);
    
    // DMR PickUp deliveries can be optimized before their pickup locations
    // Check both delivery_notes and patient notes for 'DMR PickUp'
    const dmrPickupDeliveries = deliveriesWithTimeWindows.filter(d => {
      if (d.isPickup) return false;
      const deliveryNotes = (d.delivery_notes || '').toLowerCase();
      const deliveryInstructions = (d.delivery_instructions || '').toLowerCase();
      return deliveryNotes.includes('dmr pickup') || deliveryInstructions.includes('dmr pickup');
    });
    
    const regularDeliveries = deliveriesWithTimeWindows.filter(d => {
      if (d.isPickup) return false;
      const deliveryNotes = (d.delivery_notes || '').toLowerCase();
      const deliveryInstructions = (d.delivery_instructions || '').toLowerCase();
      return !deliveryNotes.includes('dmr pickup') && !deliveryInstructions.includes('dmr pickup');
    });

    console.log(`📋 Found ${dmrPickupDeliveries.length} DMR PickUp deliveries (can be optimized before pickups)`);

    // STEP 3: Sort pickups by their delivery_time_start (store pickup time)
    pickups.sort((a, b) => {
      const aTime = parseTimeToMinutes(a.storeDeliveryTimeStart || a.delivery_time_start);
      const bTime = parseTimeToMinutes(b.storeDeliveryTimeStart || b.delivery_time_start);
      if (aTime !== bTime) return aTime - bTime;
      // Fallback to existing stop_order
      return (a.stop_order || Infinity) - (b.stop_order || Infinity);
    });

    console.log(`📋 Pickup order by delivery_time_start:`);
    pickups.forEach((p, i) => {
      const store = storeMap.get(p.store_id);
      console.log(`   ${i + 1}. ${store?.name || 'Unknown'} - delivery_time_start: ${p.storeDeliveryTimeStart || p.delivery_time_start || 'N/A'}`);
    });

    // STEP 4: Group deliveries by their associated pickup (puid)
    // Create a map of puid (pickup's stop_id) to deliveries
    const deliveriesByPickup = new Map();
    for (const delivery of regularDeliveries) {
      const puid = delivery.puid;
      if (!deliveriesByPickup.has(puid)) {
        deliveriesByPickup.set(puid, []);
      }
      deliveriesByPickup.get(puid).push(delivery);
    }

    // Sort deliveries within each pickup group by time window
    for (const [puid, deliveries] of deliveriesByPickup) {
      deliveries.sort((a, b) => {
        if (a.effectiveTimeWindowStart && b.effectiveTimeWindowStart) {
          const aTime = parseTimeToMinutes(a.effectiveTimeWindowStart);
          const bTime = parseTimeToMinutes(b.effectiveTimeWindowStart);
          if (aTime !== bTime) return aTime - bTime;
        } else if (a.effectiveTimeWindowStart) {
          return -1;
        } else if (b.effectiveTimeWindowStart) {
          return 1;
        }
        return (a.stop_order || Infinity) - (b.stop_order || Infinity);
      });
    }

    // STEP 5: Build final sorted list
    // DMR PickUp deliveries go first (before any pickups), then for each pickup add pickup then its deliveries
    const sortedDeliveries = [];
    
    // Sort DMR pickups by time window first
    dmrPickupDeliveries.sort((a, b) => {
      if (a.effectiveTimeWindowStart && b.effectiveTimeWindowStart) {
        const aTime = parseTimeToMinutes(a.effectiveTimeWindowStart);
        const bTime = parseTimeToMinutes(b.effectiveTimeWindowStart);
        if (aTime !== bTime) return aTime - bTime;
      }
      return (a.stop_order || Infinity) - (b.stop_order || Infinity);
    });
    
    // Add DMR PickUp deliveries first (they can be done before pickups)
    sortedDeliveries.push(...dmrPickupDeliveries);
    console.log(`   Added ${dmrPickupDeliveries.length} DMR PickUp deliveries at the start`);
    
    // Then add pickups and their associated deliveries
    for (const pickup of pickups) {
      sortedDeliveries.push(pickup);
      const associatedDeliveries = deliveriesByPickup.get(pickup.stop_id) || [];
      // Filter out DMR pickups from associated deliveries (they're already added)
      const nonDmrDeliveries = associatedDeliveries.filter(d => {
        const deliveryNotes = (d.delivery_notes || '').toLowerCase();
        const deliveryInstructions = (d.delivery_instructions || '').toLowerCase();
        return !deliveryNotes.includes('dmr pickup') && !deliveryInstructions.includes('dmr pickup');
      });
      sortedDeliveries.push(...nonDmrDeliveries);
    }

    // Add any orphan deliveries (deliveries without matching pickup) at the end
    const assignedPuids = new Set(pickups.map(p => p.stop_id));
    for (const [puid, deliveries] of deliveriesByPickup) {
      if (!assignedPuids.has(puid)) {
        console.log(`⚠️ Found ${deliveries.length} orphan deliveries with puid ${puid}`);
        sortedDeliveries.push(...deliveries);
      }
    }

    // STEP 6: Build stages based on pickup locations
    const stages = buildStages(sortedDeliveries, driverLocation, driverHomeLocation);
    console.log(`📊 Built ${stages.length} stages for route`);

    // STEP 3: Check for in_transit deliveries
    const inTransitDeliveries = allDeliveries.filter(d => d.status === 'in_transit');
    const hasInTransitDeliveries = inTransitDeliveries.length > 0;

    console.log(`   In-transit deliveries: ${inTransitDeliveries.length}`);

    // STEP 4: Determine which stages to optimize
    let stagesToOptimize = [];

    if (manualTrigger) {
      // Manual trigger: optimize ALL stages sequentially
      stagesToOptimize = stages;
      console.log(`   Manual trigger - optimizing ALL ${stages.length} stages`);
    } else if (hasInTransitDeliveries) {
      // Has in_transit: find the current stage (stage containing in_transit deliveries) and optimize it
      const currentStageIndex = findCurrentStage(stages, inTransitDeliveries);
      if (currentStageIndex >= 0) {
        // Only optimize current stage if it has new/unoptimized stops
        const currentStage = stages[currentStageIndex];
        if (stageNeedsOptimization(currentStage)) {
          stagesToOptimize = [currentStage];
          console.log(`   Optimizing current stage ${currentStageIndex + 1} (has unoptimized stops)`);
        } else {
          console.log(`   Current stage ${currentStageIndex + 1} already optimized`);
        }
      }
    } else {
      // No in_transit: only optimize Stage 1 (driver to first pickup)
      if (stages.length > 0 && stageNeedsOptimization(stages[0])) {
        stagesToOptimize = [stages[0]];
        console.log(`   No in_transit - only optimizing Stage 1`);
      } else {
        console.log(`   Stage 1 already optimized or no stages`);
      }
    }

    if (stagesToOptimize.length === 0) {
      return Response.json({ 
        message: 'No stages require optimization',
        stages: stages.map(s => ({
          stageNumber: s.stageNumber,
          deliveryCount: s.deliveries.length,
          optimized: true
        }))
      });
    }

    // STEP 5: Optimize each stage
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const optimizedStages = [];
    let totalApiCalls = 0;

    for (const stage of stagesToOptimize) {
      console.log(`\n🔄 Optimizing Stage ${stage.stageNumber}...`);
      
      const optimizationResult = await optimizeStage(
        stage, 
        googleMapsKey, 
        base44, 
        user,
        driverId,
        deliveryDate
      );
      
      if (optimizationResult.success) {
        optimizedStages.push({
          stageNumber: stage.stageNumber,
          optimizedOrder: optimizationResult.optimizedOrder,
          apiCalls: optimizationResult.apiCalls
        });
        totalApiCalls += optimizationResult.apiCalls;
      }
    }

    // STEP 6: Update stop_order for all optimized deliveries
    let globalStopOrder = 1;
    const stopOrderUpdates = [];

    for (const stage of stages) {
      const optimizedStage = optimizedStages.find(os => os.stageNumber === stage.stageNumber);
      
      if (optimizedStage) {
        // Use optimized order
        for (const deliveryId of optimizedStage.optimizedOrder) {
          stopOrderUpdates.push({ id: deliveryId, stop_order: globalStopOrder++ });
        }
      } else {
        // Keep existing order for non-optimized stages
        const sortedStageDeliveries = [...stage.deliveries].sort((a, b) => 
          (a.stop_order || Infinity) - (b.stop_order || Infinity)
        );
        for (const delivery of sortedStageDeliveries) {
          stopOrderUpdates.push({ id: delivery.id, stop_order: globalStopOrder++ });
        }
      }
    }

    // Batch update stop orders
    console.log(`\n💾 Updating ${stopOrderUpdates.length} stop orders...`);
    for (const update of stopOrderUpdates) {
      await base44.asServiceRole.entities.Delivery.update(update.id, {
        stop_order: update.stop_order
      });
    }

    // STEP 7: Calculate ETAs for the entire route in one batch
    console.log(`\n🕐 Calculating ETAs for entire route...`);
    const etaResult = await calculateRouteETAs(
      stopOrderUpdates,
      allDeliveries,
      driverLocation,
      patientMap,
      storeMap,
      googleMapsKey,
      base44,
      user,
      driverId,
      deliveryDate
    );

    totalApiCalls += etaResult.apiCalls;

    // Log API usage
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: `Staged route optimization for driver ${driverAppUser.user_name || driverId}`,
      function_name: 'optimizeDriverRoute',
      user_id: user.id,
      user_name: user.full_name,
      metadata: {
        driver_id: driverId,
        delivery_date: deliveryDate,
        stages_optimized: stagesToOptimize.length,
        total_stages: stages.length,
        total_api_calls: totalApiCalls,
        manual_trigger: manualTrigger
      }
    });

    console.log(`\n✅ Route optimization complete!`);
    console.log(`   Stages optimized: ${optimizedStages.length}/${stages.length}`);
    console.log(`   Total API calls: ${totalApiCalls}`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      stagesOptimized: optimizedStages.length,
      totalStages: stages.length,
      totalApiCalls,
      stopOrderUpdates: stopOrderUpdates.length,
      etaUpdates: etaResult.etaUpdates?.length || 0
    });

  } catch (error) {
    console.error('❌ Error in staged route optimization:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});

/**
 * Parse time string (HH:mm) to minutes since midnight
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return Infinity;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Build stages from deliveries based on pickup locations
 * Each stage starts with a pickup and ends at the next pickup (or driver home for final stage)
 */
function buildStages(deliveries, driverLocation, driverHomeLocation) {
  const stages = [];
  let currentStage = {
    stageNumber: 1,
    startLocation: driverLocation,
    endLocation: null,
    deliveries: [],
    isFirstStage: true
  };

  for (const delivery of deliveries) {
    if (delivery.isPickup) {
      // If current stage has deliveries, close it
      if (currentStage.deliveries.length > 0) {
        currentStage.endLocation = delivery.coords;
        stages.push(currentStage);
        
        // Start new stage from this pickup
        currentStage = {
          stageNumber: stages.length + 1,
          startLocation: delivery.coords,
          endLocation: null,
          deliveries: [],
          isFirstStage: false
        };
      }
      // Add pickup to current stage
      currentStage.deliveries.push(delivery);
    } else {
      // Regular delivery - add to current stage
      currentStage.deliveries.push(delivery);
    }
  }

  // Close final stage with driver home as end location
  if (currentStage.deliveries.length > 0) {
    currentStage.endLocation = driverHomeLocation.lat ? driverHomeLocation : null;
    stages.push(currentStage);
  }

  return stages;
}

/**
 * Find the stage that contains in_transit deliveries
 */
function findCurrentStage(stages, inTransitDeliveries) {
  const inTransitIds = new Set(inTransitDeliveries.map(d => d.id));
  
  for (let i = 0; i < stages.length; i++) {
    const hasInTransit = stages[i].deliveries.some(d => inTransitIds.has(d.id));
    if (hasInTransit) return i;
  }
  
  return -1;
}

/**
 * Check if a stage needs optimization (has new or unoptimized stops)
 */
function stageNeedsOptimization(stage) {
  // For now, consider a stage needs optimization if:
  // 1. Any delivery has no stop_order
  // 2. Stage has more than 1 delivery (worth optimizing)
  
  if (stage.deliveries.length <= 1) return false;
  
  const hasUnorderedDeliveries = stage.deliveries.some(d => !d.stop_order || d.stop_order === 0);
  return hasUnorderedDeliveries;
}

/**
 * Optimize a single stage using Google Directions API
 * CRITICAL: Preserves position of any delivery with isNextDelivery: true
 */
async function optimizeStage(stage, googleMapsKey, base44, user, driverId, deliveryDate) {
  try {
    if (stage.deliveries.length <= 1) {
      // No optimization needed for single delivery
      return {
        success: true,
        optimizedOrder: stage.deliveries.map(d => d.id),
        apiCalls: 0
      };
    }

    // Build waypoints for optimization
    const origin = `${stage.startLocation.lat},${stage.startLocation.lng}`;
    
    // Get delivery coordinates
    const deliveryCoords = stage.deliveries.map(d => ({
      id: d.id,
      lat: d.coords.lat,
      lng: d.coords.lng,
      isPickup: d.isPickup,
      isNextDelivery: d.isNextDelivery || false,
      originalStopOrder: d.stop_order || Infinity
    }));

    // CRITICAL: Find and preserve the "next delivery" - it must maintain its position
    const nextDelivery = deliveryCoords.find(d => d.isNextDelivery);
    const nextDeliveryPosition = nextDelivery 
      ? stage.deliveries.findIndex(d => d.id === nextDelivery.id)
      : -1;

    if (nextDelivery) {
      console.log(`   🔒 Preserving isNextDelivery at position ${nextDeliveryPosition + 1}: ${nextDelivery.id}`);
    }

    // Pickups should maintain their relative order (first pickup stays first in stage)
    // Only optimize the delivery portion, excluding the "next delivery"
    const pickups = deliveryCoords.filter(d => d.isPickup);
    const regularDeliveries = deliveryCoords.filter(d => !d.isPickup && !d.isNextDelivery);

    if (regularDeliveries.length <= 1) {
      // Not enough deliveries to optimize - but still need to insert nextDelivery at correct position
      let finalOrder = [...pickups.map(p => p.id), ...regularDeliveries.map(d => d.id)];
      
      // Insert nextDelivery at its preserved position
      if (nextDelivery && nextDeliveryPosition >= 0) {
        finalOrder.splice(nextDeliveryPosition, 0, nextDelivery.id);
      } else if (nextDelivery) {
        finalOrder.push(nextDelivery.id);
      }
      
      return {
        success: true,
        optimizedOrder: finalOrder,
        apiCalls: 0
      };
    }

    // Use Google Directions with optimize:true for regular deliveries only (excluding nextDelivery)
    const destination = stage.endLocation 
      ? `${stage.endLocation.lat},${stage.endLocation.lng}`
      : `${regularDeliveries[regularDeliveries.length - 1].lat},${regularDeliveries[regularDeliveries.length - 1].lng}`;

    const waypointsStr = regularDeliveries
      .slice(0, -1)
      .map(d => `${d.lat},${d.lng}`)
      .join('|');

    // Start from last pickup location (or stage start if no pickups)
    const optimizeOrigin = pickups.length > 0 
      ? `${pickups[pickups.length - 1].lat},${pickups[pickups.length - 1].lng}`
      : origin;

    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${optimizeOrigin}&` +
      `destination=${destination}&` +
      (waypointsStr ? `waypoints=optimize:true|${waypointsStr}&` : '') +
      `key=${googleMapsKey}`;

    const response = await fetch(directionsUrl);
    const data = await response.json();

    if (data.status !== 'OK' || !data.routes?.[0]) {
      console.error(`❌ Google Directions API error for stage ${stage.stageNumber}:`, data.status);
      return {
        success: false,
        optimizedOrder: stage.deliveries.map(d => d.id),
        apiCalls: 1
      };
    }

    // Get optimized order from waypoint_order
    const waypointOrder = data.routes[0].waypoint_order || [];
    
    // Build final optimized order: pickups first, then optimized deliveries
    const optimizedDeliveries = waypointOrder.map(i => regularDeliveries[i].id);
    // Add the final destination delivery
    optimizedDeliveries.push(regularDeliveries[regularDeliveries.length - 1].id);

    let finalOrder = [
      ...pickups.map(p => p.id),
      ...optimizedDeliveries
    ];

    // CRITICAL: Insert nextDelivery at its preserved position
    if (nextDelivery && nextDeliveryPosition >= 0) {
      // Insert at the original position within the stage
      finalOrder.splice(nextDeliveryPosition, 0, nextDelivery.id);
      console.log(`   🔒 Re-inserted isNextDelivery at position ${nextDeliveryPosition + 1}`);
    } else if (nextDelivery) {
      // Fallback: add at end if position couldn't be determined
      finalOrder.push(nextDelivery.id);
    }

    console.log(`   ✅ Stage ${stage.stageNumber} optimized: ${finalOrder.length} stops`);

    return {
      success: true,
      optimizedOrder: finalOrder,
      apiCalls: 1
    };

  } catch (error) {
    console.error(`❌ Error optimizing stage ${stage.stageNumber}:`, error);
    return {
      success: false,
      optimizedOrder: stage.deliveries.map(d => d.id),
      apiCalls: 0
    };
  }
}

/**
 * Calculate ETAs for the entire route after optimization
 */
async function calculateRouteETAs(
  stopOrderUpdates,
  allDeliveries,
  driverLocation,
  patientMap,
  storeMap,
  googleMapsKey,
  base44,
  user,
  driverId,
  deliveryDate
) {
  try {
    // Sort by new stop order
    const sortedUpdates = [...stopOrderUpdates].sort((a, b) => a.stop_order - b.stop_order);
    
    // Build delivery lookup
    const deliveryMap = new Map(allDeliveries.map(d => [d.id, d]));
    
    // Build waypoints for ETA calculation
    const waypoints = [];
    for (const update of sortedUpdates) {
      const delivery = deliveryMap.get(update.id);
      if (!delivery) continue;

      let coords;
      if (delivery.puid) {
        const store = storeMap.get(delivery.store_id);
        coords = store ? { lat: store.latitude, lng: store.longitude } : null;
      } else {
        const patient = patientMap.get(delivery.patient_id);
        coords = patient ? { lat: patient.latitude, lng: patient.longitude } : null;
      }

      if (coords) {
        waypoints.push({
          deliveryId: delivery.id,
          lat: coords.lat,
          lng: coords.lng,
          extraTime: delivery.extra_time || 5,
          timeWindowStart: delivery.time_window_start
        });
      }
    }

    if (waypoints.length === 0) {
      return { etaUpdates: [], apiCalls: 0 };
    }

    // Single API call for entire route
    const origin = `${driverLocation.lat},${driverLocation.lng}`;
    const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
    const waypointsStr = waypoints
      .slice(0, -1)
      .map(w => `${w.lat},${w.lng}`)
      .join('|');

    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${origin}&` +
      `destination=${destination}&` +
      (waypointsStr ? `waypoints=optimize:false|${waypointsStr}&` : '') +
      `departure_time=now&` +
      `traffic_model=best_guess&` +
      `key=${googleMapsKey}`;

    const response = await fetch(directionsUrl);
    const data = await response.json();

    if (data.status !== 'OK' || !data.routes?.[0]) {
      console.error('❌ Failed to calculate ETAs:', data.status);
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
      if (waypoint.timeWindowStart) {
        const [windowHours, windowMinutes] = waypoint.timeWindowStart.split(':').map(Number);
        const windowStartMinutes = windowHours * 60 + windowMinutes;
        if (cumulativeMinutes < windowStartMinutes) {
          cumulativeMinutes = windowStartMinutes;
        }
      }

      const etaHours = Math.floor(cumulativeMinutes / 60) % 24;
      const etaMinutesVal = cumulativeMinutes % 60;
      const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMinutesVal).padStart(2, '0')}`;

      etaUpdates.push({
        deliveryId: waypoint.deliveryId,
        eta
      });

      cumulativeMinutes += waypoint.extraTime;
    }

    // Batch update ETAs
    console.log(`   💾 Updating ${etaUpdates.length} ETAs...`);
    for (const update of etaUpdates) {
      await base44.asServiceRole.entities.Delivery.update(update.deliveryId, {
        delivery_time_eta: update.eta
      });
    }

    return { etaUpdates, apiCalls: 1 };

  } catch (error) {
    console.error('❌ Error calculating route ETAs:', error);
    return { etaUpdates: [], apiCalls: 0 };
  }
}