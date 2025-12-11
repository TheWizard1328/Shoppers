import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // CRITICAL: Check authentication first
    let isAuthenticated = false;
    try {
      isAuthenticated = await base44.auth.isAuthenticated();
    } catch (authCheckError) {
      console.error('❌ [ETA Updates] Auth check error:', authCheckError.message);
      return Response.json({ error: 'Authentication check failed' }, { status: 401 });
    }
    
    if (!isAuthenticated) {
      console.error('❌ [ETA Updates] User not authenticated');
      return Response.json({ error: 'Unauthorized - not authenticated' }, { status: 401 });
    }
    
    let user;
    try {
      user = await base44.auth.me();
    } catch (authError) {
      console.error('❌[ETA Updates]  Auth error:', authError.message);
      return Response.json({ error: 'Authentication failed' }, { status: 401 });
    }

    if (!user) {
      return Response.json({ error: 'Unauthorized - no user' }, { status: 401 });
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (parseError) {
      console.warn('[ETA Updates] Failed to parse request body:', parseError);
    }

    const { driverId, deliveryDate, currentStopId } = body;

    if (!driverId || !deliveryDate) {
      console.error('[ETA Updates] Missing required parameters:', { driverId, deliveryDate });
      return Response.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    console.log('[ETA Updates] Starting ETA calculation for:', { driverId, deliveryDate });

    // Get driver's AppUser record for current location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    // CRITICAL: Skip ETA updates if driver is off duty or on break
    if (driverAppUser?.driver_status === 'off_duty' || driverAppUser?.driver_status === 'on_break') {
      console.log(`[ETA Updates] Skipping - driver is ${driverAppUser.driver_status}`);
      return Response.json({ message: `Driver is ${driverAppUser.driver_status} - skipping ETA updates`, updatedDeliveries: [] });
    }

    // Get all deliveries for this driver/date
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    console.log('[ETA Updates] Found deliveries:', deliveries?.length || 0);

    if (!deliveries || deliveries.length === 0) {
      console.log('[ETA Updates] No deliveries found for driver/date');
      return Response.json({ message: 'No deliveries found', updatedDeliveries: [] });
    }

    // CRITICAL: Skip ETA updates if no delivery is marked as next (isNextDelivery = true)
    const hasNextDelivery = deliveries.some(d => d.isNextDelivery === true);
    if (!hasNextDelivery) {
      console.log('[ETA Updates] Skipping - no delivery marked as isNextDelivery');
      return Response.json({ message: 'No next delivery flagged - skipping ETA updates', updatedDeliveries: [] });
    }

    // Get all patients for address lookups
    const patientIds = deliveries.filter(d => d.patient_id).map(d => d.patient_id);
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientMap = new Map(patients.map(p => [p.id, p]));

    // Get all stores for pickup locations
    const storeIds = [...new Set(deliveries.map(d => d.store_id))];
    const stores = await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } });
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Determine starting location and time - ALWAYS use LOCAL TIME
    let startLat, startLon;
    let startTimeMinutes; // Minutes since midnight in local time
    
    const now = new Date();
    const currentLocalHours = now.getHours();
    const currentLocalMinutes = now.getMinutes();
    const currentTotalMinutes = currentLocalHours * 60 + currentLocalMinutes;

    // Try current GPS location first (Rule 1a)
    if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
      const locationAge = driverAppUser.location_updated_at 
        ? (now - new Date(driverAppUser.location_updated_at)) / 1000 / 60 
        : Infinity;

      // Use GPS if less than 10 minutes old
      if (locationAge < 10) {
        startLat = driverAppUser.current_latitude;
        startLon = driverAppUser.current_longitude;
        startTimeMinutes = currentTotalMinutes;
        console.log(`[ETA Updates] Using current GPS location (${locationAge.toFixed(1)} min old)`);
      }
    }

    // Fallback to last finished stop location (Rule 1b)
    if (!startLat) {
      const finishedDeliveries = deliveries
        .filter(d => ['completed', 'failed', 'cancelled', 'returned'].includes(d.status))
        .sort((a, b) => {
          if (!a.actual_delivery_time) return 1;
          if (!b.actual_delivery_time) return -1;
          return new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time);
        });

      if (finishedDeliveries.length > 0) {
        const lastFinished = finishedDeliveries[0];
        if (lastFinished.patient_id) {
          const patient = patientMap.get(lastFinished.patient_id);
          if (patient?.latitude && patient?.longitude) {
            startLat = patient.latitude;
            startLon = patient.longitude;
            startTimeMinutes = currentTotalMinutes;
            console.log(`[ETA Updates] Using last finished stop location (${lastFinished.status})`);
          }
        } else {
          const store = storeMap.get(lastFinished.store_id);
          if (store?.latitude && store?.longitude) {
            startLat = store.latitude;
            startLon = store.longitude;
            startTimeMinutes = currentTotalMinutes;
            console.log(`[ETA Updates] Using last finished pickup location (${lastFinished.status})`);
          }
        }
      }
    }

    // Final fallback to home location (Rule 1b)
    if (!startLat && driverAppUser?.home_latitude && driverAppUser?.home_longitude) {
      startLat = driverAppUser.home_latitude;
      startLon = driverAppUser.home_longitude;
      startTimeMinutes = currentTotalMinutes;
      console.log(`[ETA Updates] Using home location`);
    }

    if (!startLat || !startLon) {
      return Response.json({ error: 'Could not determine starting location' }, { status: 400 });
    }
    
    console.log(`[ETA Updates] Starting from local time: ${String(currentLocalHours).padStart(2, '0')}:${String(currentLocalMinutes).padStart(2, '0')}`);
    console.log(`[ETA Updates] Location: ${startLat}, ${startLon}`);

    // Get incomplete deliveries (Rule 2b) - exclude pending/staged deliveries
    let incompleteDeliveries = deliveries.filter(d => 
      !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status)
    );

    // CRITICAL: If currentStopId is provided, ensure it's first in the optimization order
    if (currentStopId) {
      const currentStop = incompleteDeliveries.find(d => d.id === currentStopId);
      const otherStops = incompleteDeliveries.filter(d => d.id !== currentStopId)
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
      if (currentStop) {
        incompleteDeliveries = [currentStop, ...otherStops];
        console.log(`[ETA Updates] Prioritizing currentStopId ${currentStopId} as first stop`);
      } else {
        incompleteDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      }
    } else {
      incompleteDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    }

    if (incompleteDeliveries.length === 0) {
      return Response.json({ message: 'No incomplete deliveries', updatedDeliveries: [] });
    }

    // Build waypoints for Google Directions API (Rule 3a/b)
    const waypoints = incompleteDeliveries.map(delivery => {
      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        return {
          deliveryId: delivery.id,
          lat: patient?.latitude,
          lon: patient?.longitude,
          extraTime: delivery.extra_time || 5,
          isPickup: false,
          scheduledStartTime: null
        };
      } else {
        const store = storeMap.get(delivery.store_id);
        return {
          deliveryId: delivery.id,
          lat: store?.latitude,
          lon: store?.longitude,
          extraTime: delivery.extra_time || 5,
          isPickup: true,
          scheduledStartTime: delivery.delivery_time_start
        };
      }
    }).filter(w => w.lat && w.lon);

    if (waypoints.length === 0) {
      return Response.json({ error: 'No valid waypoints found' }, { status: 400 });
    }

    // Call Google Directions API
    const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY');

    // Increment polyline generation count before API call
    const todayStr = deliveryDate; // Already in YYYY-MM-DD format
    let driverPolyline = await base44.asServiceRole.entities.DriverRoutePolyline.filter({ 
      driver_id: driverId, 
      delivery_date: todayStr 
    });

    if (driverPolyline.length === 0) {
      driverPolyline = [await base44.asServiceRole.entities.DriverRoutePolyline.create({
        driver_id: driverId,
        delivery_date: todayStr,
        daily_generation_count: 0
      })];
    }
    
    // Ensure daily_generation_count is a number before incrementing
    const currentCount = typeof driverPolyline[0].daily_generation_count === 'number' 
      ? driverPolyline[0].daily_generation_count 
      : 0;
    
    await base44.asServiceRole.entities.DriverRoutePolyline.update(driverPolyline[0].id, {
      daily_generation_count: currentCount + 1,
      last_generated_at: new Date().toISOString()
    });
    
    console.log(`[ETA Updates] Google Maps API count incremented to ${currentCount + 1} for ${todayStr}`);

    const origin = `${startLat},${startLon}`;
    const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lon}`;
    const waypointsParam = waypoints.slice(0, -1).map(w => `${w.lat},${w.lon}`).join('|');

    let directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&key=${GOOGLE_MAPS_API_KEY}`;
    if (waypointsParam) {
      directionsUrl += `&waypoints=${waypointsParam}`;
    }

    const directionsResponse = await fetch(directionsUrl);
    const directionsData = await directionsResponse.json();

    if (directionsData.status !== 'OK') {
      console.error('[ETA Updates] Google Directions API error:', directionsData.status);
      return Response.json({ error: 'Failed to calculate route: ' + directionsData.status }, { status: 500 });
    }

    // Calculate ETAs for each stop - CRITICAL: Use simple minute arithmetic from current local time
    const route = directionsData.routes[0];
    const legs = route.legs;
    
    // Start with current local time in minutes since midnight
    let cumulativeMinutes = startTimeMinutes;
    
    console.log('');
    console.log('[ETA Updates] ═══════════════════════════════════════');
    console.log('[ETA Updates] Starting ETA calculation:');
    console.log(`[ETA Updates]   Starting time: ${String(Math.floor(cumulativeMinutes/60)).padStart(2, '0')}:${String(cumulativeMinutes%60).padStart(2, '0')} (${cumulativeMinutes} minutes since midnight)`);
    console.log(`[ETA Updates]   Number of stops: ${waypoints.length}`);
    console.log('[ETA Updates] ═══════════════════════════════════════');
    
    const updatedDeliveries = [];

    for (let i = 0; i < waypoints.length; i++) {
      const leg = legs[i];
      const waypoint = waypoints[i];

      console.log('');
      console.log(`[ETA Updates] ─── Stop ${i + 1} ───`);
      console.log(`[ETA Updates]   Type: ${waypoint.isPickup ? 'PICKUP' : 'DELIVERY'}`);
      console.log(`[ETA Updates]   Current time: ${String(Math.floor(cumulativeMinutes/60)).padStart(2, '0')}:${String(cumulativeMinutes%60).padStart(2, '0')}`);

      // For FIRST stop only, check if pickup has scheduled time in future
      if (i === 0 && waypoint.isPickup && waypoint.scheduledStartTime) {
        const [schedHours, schedMinutes] = waypoint.scheduledStartTime.split(':').map(Number);
        const scheduledTotalMinutes = schedHours * 60 + schedMinutes;

        if (scheduledTotalMinutes > cumulativeMinutes) {
          const waitMinutes = scheduledTotalMinutes - cumulativeMinutes;
          console.log(`[ETA Updates]   First pickup scheduled for ${waypoint.scheduledStartTime} (${waitMinutes} min wait)`);
          cumulativeMinutes = scheduledTotalMinutes;
        } else {
          console.log(`[ETA Updates]   First pickup scheduled time ${waypoint.scheduledStartTime} already passed - adding travel time`);
          // CRITICAL: If scheduled time has passed, add travel time from current location
          const travelSeconds = leg.duration.value;
          const travelMinutes = Math.ceil(travelSeconds / 60);
          console.log(`[ETA Updates]   Google travel time: ${travelSeconds}s = ${travelMinutes} minutes`);
          cumulativeMinutes += travelMinutes;
        }
      } else {
        // Add travel time from previous stop
        const travelSeconds = leg.duration.value;
        const travelMinutes = Math.ceil(travelSeconds / 60);
        console.log(`[ETA Updates]   Google travel time: ${travelSeconds}s = ${travelMinutes} minutes`);
        cumulativeMinutes += travelMinutes;
      }
      
      // ETA is the arrival time (before adding service time)
      const arrivalHours = Math.floor(cumulativeMinutes / 60) % 24;
      const arrivalMinutes = cumulativeMinutes % 60;
      const eta = `${String(arrivalHours).padStart(2, '0')}:${String(arrivalMinutes).padStart(2, '0')}`;
      
      console.log(`[ETA Updates]   ✅ Arrival ETA: ${eta}`);
      
      // Add service time for next leg
      const serviceTime = waypoint.extraTime || 5;
      cumulativeMinutes += serviceTime;
      console.log(`[ETA Updates]   Service time: +${serviceTime} min → ${String(Math.floor(cumulativeMinutes/60)).padStart(2, '0')}:${String(cumulativeMinutes%60).padStart(2, '0')}`);
      
      updatedDeliveries.push({
        id: waypoint.deliveryId,
        delivery_time_eta: eta
      });
    }
    
    console.log('');
    console.log('[ETA Updates] ═══════════════════════════════════════');

    // Update deliveries in database (Rule 5)
    for (const update of updatedDeliveries) {
      await base44.asServiceRole.entities.Delivery.update(update.id, {
        delivery_time_eta: update.delivery_time_eta
      });
    }

    console.log(`✅ [ETA Updates] Updated ETAs for ${updatedDeliveries.length} deliveries`);

    const startHours = Math.floor(startTimeMinutes / 60);
    const startMins = startTimeMinutes % 60;

    return Response.json({
      success: true,
      updatedDeliveries,
      startLocation: { lat: startLat, lon: startLon },
      startTime: `${String(startHours).padStart(2, '0')}:${String(startMins).padStart(2, '0')}`
    });

  } catch (error) {
    console.error('[ETA Updates] Error in etaOptimizer:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});