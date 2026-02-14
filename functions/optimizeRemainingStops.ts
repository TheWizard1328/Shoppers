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
 * Parse time string (HH:mm) to minutes since midnight
 */
const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

/**
 * Format minutes since midnight to HH:mm string
 */
const formatMinutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * Optimize Remaining Stops - staged optimization for driver's route
 */
Deno.serve(async (req) => {
  console.log('🚀 [optimizeRemainingStops] Function called');
  
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    console.log('✅ [optimizeRemainingStops] User authenticated:', user.email);

    const body = await req.json();
    const { driverId, deliveryDate, currentLocalTime, deviceTime } = body;
    
    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    // Parse current time
    let currentMinutes;
    if (currentLocalTime) {
      const [hours, minutes] = currentLocalTime.split(':').map(Number);
      currentMinutes = hours * 60 + minutes;
    } else if (deviceTime) {
      const timeMatch = deviceTime.match(/T(\d{2}):(\d{2})/);
      if (timeMatch) {
        currentMinutes = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
      } else {
        const now = new Date();
        let mountainHours = now.getUTCHours() - 7;
        if (mountainHours < 0) mountainHours += 24;
        currentMinutes = mountainHours * 60 + now.getUTCMinutes();
      }
    } else {
      const now = new Date();
      let mountainHours = now.getUTCHours() - 7;
      if (mountainHours < 0) mountainHours += 24;
      currentMinutes = mountainHours * 60 + now.getUTCMinutes();
    }

    console.log(`🔄 [optimizeRemainingStops] Optimizing remaining stops for driver ${driverId} on ${deliveryDate}`);
    
    // Get driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];
    
    if (!driverAppUser) {
      return Response.json({ error: 'Driver not found' }, { status: 404 });
    }
    
    // Fetch all deliveries for the driver on this date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');
    
    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', routeChanged: false });
    }

    console.log(`📦 [optimizeRemainingStops] Found ${allDeliveries.length} deliveries`);

    // Separate completed and incomplete deliveries
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedDeliveries = allDeliveries.filter(d => finishedStatuses.includes(d.status));
    const incompleteDeliveries = allDeliveries.filter(d => !finishedStatuses.includes(d.status));

    if (incompleteDeliveries.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries to optimize',
        routeChanged: false
      });
    }

    console.log(`📊 [optimizeRemainingStops] Incomplete deliveries breakdown:`);
    incompleteDeliveries.forEach(d => {
      console.log(`   - ${d.patient_name || 'Pickup'}: isNextDelivery=${d.isNextDelivery}, delivery_time_start=${d.delivery_time_start}`);
    });

    // Get patient and store data for coordinates
    const patientIds = [...new Set(incompleteDeliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    const storeIds = [...new Set(incompleteDeliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Build stops with coordinates
    const stops = incompleteDeliveries.map(delivery => {
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

      return {
        delivery,
        lat,
        lng,
        isPickup: !delivery.patient_id,
        timeMinutes: parseTimeToMinutes(delivery.delivery_time_start)
      };
    }).filter(s => s.lat && s.lng);

    // STEP 1: CRITICAL - Sort by isNextDelivery FIRST, then by time_window_start (NOT delivery_time_start)
    stops.sort((a, b) => {
      // CRITICAL: isNextDelivery ALWAYS comes first (regardless of time)
      if (a.delivery.isNextDelivery && !b.delivery.isNextDelivery) return -1;
      if (!a.delivery.isNextDelivery && b.delivery.isNextDelivery) return 1;
      
      // Then sort by time_window_start (patient time window takes priority over delivery_time_start)
      const timeA = parseTimeToMinutes(a.delivery.time_window_start) ?? a.timeMinutes;
      const timeB = parseTimeToMinutes(b.delivery.time_window_start) ?? b.timeMinutes;
      if (timeA !== timeB) return timeA - timeB;
      
      // Pickups before deliveries at same time
      if (a.isPickup && !b.isPickup) return -1;
      if (!a.isPickup && b.isPickup) return 1;
      return 0;
    });

    console.log(`📋 [optimizeRemainingStops] Sorted ${stops.length} stops (isNextDelivery first, then by time)`);

    // STEP 2: Divide route into stages (each stage ends at a pickup)
    const stages = [];
    let currentStageStops = [];
    
    for (const stop of stops) {
      if (stop.isPickup && currentStageStops.length > 0) {
        // End current stage, pickup becomes end of this stage
        currentStageStops.push(stop);
        stages.push([...currentStageStops]);
        currentStageStops = [];
      } else {
        currentStageStops.push(stop);
      }
    }
    
    // Add remaining stops as final stage
    if (currentStageStops.length > 0) {
      stages.push(currentStageStops);
    }

    console.log(`📊 [optimizeRemainingStops] Divided into ${stages.length} stages`);

    // STEP 2.5: Check if first stage needs combining
    if (stages.length > 1 && stages[0].length === 1 && stages[0][0].isPickup) {
      console.log('🔗 [optimizeRemainingStops] First stage has only pickup - combining with next stage');
      const combinedStage = [...stages[0], ...stages[1]];
      stages.splice(0, 2, combinedStage);
      console.log(`📊 [optimizeRemainingStops] After combining: ${stages.length} stages`);
    }

    // STEP 3: Determine starting location for current stage
    let currentPosition;
    let locationSource;
    
    if (driverAppUser.current_latitude && driverAppUser.current_longitude) {
      currentPosition = { lat: driverAppUser.current_latitude, lng: driverAppUser.current_longitude };
      locationSource = 'current_gps';
    } else if (completedDeliveries.length > 0) {
      // Use last completed delivery location
      const lastCompleted = completedDeliveries.sort((a, b) => 
        new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time)
      )[0];
      
      if (lastCompleted.patient_id) {
        const patient = patientMap.get(lastCompleted.patient_id);
        if (patient?.latitude && patient?.longitude) {
          currentPosition = { lat: patient.latitude, lng: patient.longitude };
          locationSource = 'last_completed';
        }
      } else {
        const store = storeMap.get(lastCompleted.store_id);
        if (store?.latitude && store?.longitude) {
          currentPosition = { lat: store.latitude, lng: store.longitude };
          locationSource = 'last_completed';
        }
      }
    }
    
    if (!currentPosition && driverAppUser.home_latitude && driverAppUser.home_longitude) {
      currentPosition = { lat: driverAppUser.home_latitude, lng: driverAppUser.home_longitude };
      locationSource = 'home';
    }
    
    if (!currentPosition) {
      return Response.json({ 
        error: 'Driver location not available - no GPS, last completed, or home location set'
      }, { status: 404 });
    }

    console.log(`📍 [optimizeRemainingStops] Starting from: ${locationSource} (${currentPosition.lat}, ${currentPosition.lng})`);

    // STEP 4: Optimize ONLY the current (first) stage using Google Directions API
    const currentStage = stages[0];
    console.log(`\n🎯 [optimizeRemainingStops] Optimizing current stage: ${currentStage.length} stops`);

    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    let optimizedCurrentStage = [];
    let directionsLegs = [];
    let totalApiCalls = 0;

    // CRITICAL: Current stage is already sorted by delivery_time_start from STEP 1
    // Just use it as-is for Google API (no re-sorting, no optimize:true)
    const currentStageSorted = currentStage;

    console.log(`📋 [optimizeRemainingStops] Using time-sorted order for current stage`);

    // Get travel times from Google Directions API (with time-based pre-ordering)
    if (currentStageSorted.length > 0) {
      const routeCoords = [currentPosition, ...currentStageSorted.map(s => ({ lat: s.lat, lng: s.lng }))];
      
      if (routeCoords.length >= 2) {
        const origin = `${routeCoords[0].lat},${routeCoords[0].lng}`;
        const destination = `${routeCoords[routeCoords.length - 1].lat},${routeCoords[routeCoords.length - 1].lng}`;
        const waypoints = routeCoords.slice(1, -1).map(c => `${c.lat},${c.lng}`);
        const waypointsStr = waypoints.length > 0 ? `&waypoints=${waypoints.join('|')}` : '';

        // Log API call
        await base44.asServiceRole.entities.GoogleAPILog.create({
          timestamp: new Date().toISOString(),
          api_type: 'Directions',
          purpose: `Current stage optimization for driver ${driverAppUser.user_name}`,
          function_name: 'optimizeRemainingStops',
          user_id: user.id,
          user_name: user.full_name,
          metadata: { driver_id: driverId, delivery_date: deliveryDate, stops_count: currentStageSorted.length }
        });

        // CRITICAL: Don't use optimize:true - respect the time-based order
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
          `origin=${origin}&destination=${destination}${waypointsStr}&` +
          `departure_time=now&traffic_model=best_guess&key=${googleMapsKey}`;

        let directionsData = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
            const response = await fetch(directionsUrl, { signal: AbortSignal.timeout(15000) });
            directionsData = await response.json();
            if (directionsData.status === 'OK') {
              totalApiCalls++;
              break;
            }
          } catch (err) {
            console.warn(`[optimizeRemainingStops] Directions API attempt ${attempt + 1} failed:`, err.message);
          }
        }

        if (directionsData?.status === 'OK' && directionsData.routes?.[0]?.legs) {
          directionsLegs = directionsData.routes[0].legs.map(leg => ({
            duration: leg.duration_in_traffic?.value || leg.duration?.value || 0,
            distance: leg.distance?.value || 0
          }));
          console.log('✅ [optimizeRemainingStops] Google Directions API success');
          
          // Use the pre-sorted order (don't apply Google's waypoint_order)
          optimizedCurrentStage = currentStageSorted;
        } else {
          // Fallback to crow-flies
          console.log('⚠️ [optimizeRemainingStops] Google API failed - using crow-flies fallback');
          optimizedCurrentStage = currentStageSorted;
          let prevPos = currentPosition;
          for (const stop of optimizedCurrentStage) {
            const distKm = calculateCrowFliesDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
            directionsLegs.push({
              duration: Math.ceil((distKm / 40) * 60 * 60 * 1.3), // 40 km/h + 30% buffer
              distance: distKm * 1000
            });
            prevPos = { lat: stop.lat, lng: stop.lng };
          }
        }
      }
    }

    // STEP 5: Calculate ETAs for current stage
    let cumulativeTime = currentMinutes;
    const currentStageETAs = [];

    for (let i = 0; i < optimizedCurrentStage.length; i++) {
      const stop = optimizedCurrentStage[i];
      
      const travelSeconds = directionsLegs[i] ? directionsLegs[i].duration : 300;
      const travelMinutes = Math.ceil(travelSeconds / 60);
      cumulativeTime += travelMinutes;

      // Apply time window waiting
      if (stop.delivery.time_window_start) {
        const windowStart = parseTimeToMinutes(stop.delivery.time_window_start);
        if (cumulativeTime < windowStart) {
          cumulativeTime = windowStart;
        }
      }

      const eta = formatMinutesToTime(cumulativeTime);
      currentStageETAs.push({ deliveryId: stop.delivery.id, eta });

      const serviceTime = stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
      cumulativeTime += serviceTime;

      console.log(`  ✅ [optimizeRemainingStops] ${stop.delivery.patient_name || 'Pickup'} - ETA: ${eta}`);
    }

    // STEP 6: Update ETAs for current stage in database
    // CRITICAL: Also update delivery_time_start for pending stops
    for (let i = 0; i < currentStageETAs.length; i++) {
      const { deliveryId, eta } = currentStageETAs[i];
      const stop = optimizedCurrentStage[i];
      
      const updateData = {
        delivery_time_eta: eta
      };
      
      // Set delivery_time_start for pending stops
      if (stop.delivery.status === 'pending') {
        if (!stop.delivery.patient_id) {
          // Pending pickup - use its existing start time or ETA
          updateData.delivery_time_start = stop.delivery.delivery_time_start || eta;
        } else if (stop.delivery.puid) {
          // Pending delivery - find its pickup
          const pickup = incompleteDeliveries.find(d => !d.patient_id && d.stop_id === stop.delivery.puid);
          if (pickup) {
            const pickupStart = pickup.delivery_time_start;
            const pickupETA = currentStageETAs.find(e => e.deliveryId === pickup.id)?.eta || pickup.delivery_time_eta;
            
            // Use later of: pickup start time or ETA, then add 5 minutes
            let baseMinutes = parseTimeToMinutes(pickupStart);
            const etaMinutes = parseTimeToMinutes(pickupETA);
            if (etaMinutes > baseMinutes) {
              baseMinutes = etaMinutes;
            }
            updateData.delivery_time_start = formatMinutesToTime(baseMinutes + 5);
          }
        }
      }
      
      await base44.asServiceRole.entities.Delivery.update(deliveryId, updateData);
    }

    // STEP 7: Calculate ETAs for remaining stages (without Google API)
    // CRITICAL: Also set delivery_time_start for pending stops
    for (let stageIdx = 1; stageIdx < stages.length; stageIdx++) {
      const stageStops = stages[stageIdx];
      
      for (const stop of stageStops) {
        const travelMinutes = 10; // Estimated travel between stops
        cumulativeTime += travelMinutes;

        if (stop.delivery.time_window_start) {
          const windowStart = parseTimeToMinutes(stop.delivery.time_window_start);
          if (cumulativeTime < windowStart) {
            cumulativeTime = windowStart;
          }
        }

        const eta = formatMinutesToTime(cumulativeTime);
        
        const updateData = {
          delivery_time_eta: eta
        };
        
        // Set delivery_time_start for pending stops
        if (stop.delivery.status === 'pending') {
          if (!stop.delivery.patient_id) {
            // Pending pickup - use its existing start time or ETA
            updateData.delivery_time_start = stop.delivery.delivery_time_start || eta;
          } else if (stop.delivery.puid) {
            // Pending delivery - find its pickup in current or previous stages
            let pickup = null;
            for (let s = 0; s <= stageIdx; s++) {
              pickup = stages[s].find(st => !st.delivery.patient_id && st.delivery.stop_id === stop.delivery.puid);
              if (pickup) break;
            }
            
            if (pickup) {
              const pickupStart = pickup.delivery.delivery_time_start;
              const pickupETA = pickup.delivery.delivery_time_eta;
              
              // Use later of: pickup start time or ETA, then add 5 minutes
              let baseMinutes = parseTimeToMinutes(pickupStart);
              const etaMinutes = parseTimeToMinutes(pickupETA);
              if (etaMinutes > baseMinutes) {
                baseMinutes = etaMinutes;
              }
              updateData.delivery_time_start = formatMinutesToTime(baseMinutes + 5);
            }
          }
        }
        
        await base44.asServiceRole.entities.Delivery.update(stop.delivery.id, updateData);

        const serviceTime = stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
        cumulativeTime += serviceTime;
      }
    }

    // STEP 8: Re-fetch all incomplete deliveries with updated ETAs
    const updatedIncomplete = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });
    
    const activeStops = updatedIncomplete.filter(d => !finishedStatuses.includes(d.status));

    // STEP 9: CRITICAL - Re-sort activeStops (same logic as STEP 1)
    // isNextDelivery FIRST, then by time_window_start
    activeStops.sort((a, b) => {
      // CRITICAL: isNextDelivery ALWAYS comes first
      if (a.isNextDelivery && !b.isNextDelivery) return -1;
      if (!a.isNextDelivery && b.isNextDelivery) return 1;
      
      // Sort by time_window_start (patient time window) if available, else delivery_time_start
      const timeA = parseTimeToMinutes(a.time_window_start) ?? parseTimeToMinutes(a.delivery_time_start);
      const timeB = parseTimeToMinutes(b.time_window_start) ?? parseTimeToMinutes(b.delivery_time_start);
      if (timeA !== timeB) return timeA - timeB;
      
      // Pickups before deliveries at same time
      const isAPickup = !a.patient_id;
      const isBPickup = !b.patient_id;
      if (isAPickup && !isBPickup) return -1;
      if (!isAPickup && isBPickup) return 1;
      return 0;
    });

    console.log(`\n🔢 [optimizeRemainingStops] Re-sorted ${activeStops.length} stops (isNextDelivery first, then by time)`);

    // STEP 10: Re-assign stop_order numbers to match the sorted order
    // CRITICAL: Also set delivery_time_start for pending stops
    const startingOrder = completedDeliveries.length;
    for (let i = 0; i < activeStops.length; i++) {
      const stop = activeStops[i];
      const newOrder = startingOrder + i + 1;
      
      const updateData = {
        stop_order: newOrder,
        display_stop_order: newOrder
      };
      
      // CRITICAL: Set delivery_time_start for pending stops
      if (stop.status === 'pending' && !stop.patient_id) {
        // This is a pending pickup - use its existing delivery_time_start or ETA
        const pickupStartTime = stop.delivery_time_start || stop.delivery_time_eta;
        if (pickupStartTime) {
          updateData.delivery_time_start = pickupStartTime;
        }
      } else if (stop.status === 'pending' && stop.patient_id && stop.puid) {
        // This is a pending delivery - set start time to +5 min after pickup start time or ETA
        const pickup = allDeliveries.find(d => !d.patient_id && d.stop_id === stop.puid);
        if (pickup) {
          const pickupStartTime = pickup.delivery_time_start;
          const pickupETA = pickup.delivery_time_eta;
          
          // Use the later of: pickup start time or ETA
          let baseTime = pickupStartTime;
          if (pickupETA) {
            const startMinutes = parseTimeToMinutes(pickupStartTime);
            const etaMinutes = parseTimeToMinutes(pickupETA);
            if (etaMinutes > startMinutes) {
              baseTime = pickupETA;
            }
          }
          
          // Add 5 minutes
          if (baseTime) {
            const baseMinutes = parseTimeToMinutes(baseTime);
            const newStartMinutes = baseMinutes + 5;
            updateData.delivery_time_start = formatMinutesToTime(newStartMinutes);
          }
        }
      }
      
      await base44.asServiceRole.entities.Delivery.update(stop.id, updateData);
      console.log(`  🔢 [optimizeRemainingStops] Stop #${newOrder}: ${stop.patient_name || 'Pickup'}${updateData.delivery_time_start ? ` (start: ${updateData.delivery_time_start})` : ''}`);
    }

    // Update polyline record
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
    
    await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + totalApiCalls,
      last_generated_at: new Date().toISOString()
    });

    console.log(`\n✅ [optimizeRemainingStops] Route optimization complete - ${activeStops.length} stops updated, ${totalApiCalls} API calls`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      routeChanged: true,
      optimizedCount: activeStops.length,
      stagesCount: stages.length,
      apiCallsMade: totalApiCalls,
      locationSource
    });

  } catch (error) {
    console.error('❌ [optimizeRemainingStops] ERROR:', error.message);
    return Response.json({ 
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});