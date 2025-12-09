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
      return Response.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // Get driver's AppUser record for current location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    // Get all deliveries for this driver/date
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

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

    // Determine starting location and time (Rule 1a/b)
    let startLat, startLon, startTime;
    const now = new Date();

    // Try current GPS location first (Rule 1a)
    if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
      const locationAge = driverAppUser.location_updated_at 
        ? (now - new Date(driverAppUser.location_updated_at)) / 1000 / 60 
        : Infinity;

      // Use GPS if less than 10 minutes old
      if (locationAge < 10) {
        startLat = driverAppUser.current_latitude;
        startLon = driverAppUser.current_longitude;
        startTime = now;
        console.log('[ETA Updates] Using current GPS location');
      }
    }

    // Fallback to last finished stop (Rule 1b) - completed, failed, cancelled, or returned
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
            startTime = lastFinished.actual_delivery_time ? new Date(lastFinished.actual_delivery_time) : now;
            console.log(`[ETA Updates] Using last finished stop location (${lastFinished.status})`);
          }
        } else {
          const store = storeMap.get(lastFinished.store_id);
          if (store?.latitude && store?.longitude) {
            startLat = store.latitude;
            startLon = store.longitude;
            startTime = lastFinished.actual_delivery_time ? new Date(lastFinished.actual_delivery_time) : now;
            console.log(`[ETA Updates] Using last finished pickup location (${lastFinished.status})`);
          }
        }
      }
    }

    // Final fallback to home location (Rule 1b)
    if (!startLat && driverAppUser?.home_latitude && driverAppUser?.home_longitude) {
      startLat = driverAppUser.home_latitude;
      startLon = driverAppUser.home_longitude;
      startTime = now;
      console.log('[ETA Updates] Using home location');
    }

    if (!startLat || !startLon) {
      return Response.json({ error: 'Could not determine starting location' }, { status: 400 });
    }

    // Get incomplete deliveries (Rule 2b)
    const incompleteDeliveries = deliveries.filter(d => 
      !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
    ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

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
          extraTime: delivery.extra_time || 5
        };
      } else {
        const store = storeMap.get(delivery.store_id);
        return {
          deliveryId: delivery.id,
          lat: store?.latitude,
          lon: store?.longitude,
          extraTime: delivery.extra_time || 5
        };
      }
    }).filter(w => w.lat && w.lon);

    if (waypoints.length === 0) {
      return Response.json({ error: 'No valid waypoints found' }, { status: 400 });
    }

    // Call Google Directions API
    const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY');
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

    // Calculate ETAs for each stop (Rule 3a/b)
    const route = directionsData.routes[0];
    const legs = route.legs;
    
    // CRITICAL: Parse delivery date + current time to get actual date-time for ETA calculation
    const deliveryDateObj = new Date(deliveryDate + 'T00:00:00');
    const currentHours = startTime.getHours();
    const currentMinutes = startTime.getMinutes();
    
    // Set cumulative time to delivery date + start time (not just the time object)
    let cumulativeTime = new Date(deliveryDateObj);
    cumulativeTime.setHours(currentHours);
    cumulativeTime.setMinutes(currentMinutes);
    cumulativeTime.setSeconds(0);
    cumulativeTime.setMilliseconds(0);
    
    console.log('[ETA Updates] Starting ETA calculation:');
    console.log(`  - Delivery date: ${deliveryDate}`);
    console.log(`  - Start time: ${startTime.toISOString()}`);
    console.log(`  - Cumulative time initialized: ${cumulativeTime.toISOString()}`);
    
    const updatedDeliveries = [];

    for (let i = 0; i < waypoints.length; i++) {
      const leg = legs[i];
      const waypoint = waypoints[i];
      
      // Add travel time
      const travelMinutes = Math.ceil(leg.duration.value / 60);
      cumulativeTime = new Date(cumulativeTime.getTime() + travelMinutes * 60000);
      
      console.log(`  - Stop ${i + 1}: +${travelMinutes} min travel → ${cumulativeTime.toISOString()}`);
      
      // Add extra time at stop
      cumulativeTime = new Date(cumulativeTime.getTime() + (waypoint.extraTime || 5) * 60000);
      
      console.log(`  - Stop ${i + 1}: +${waypoint.extraTime || 5} min service → ${cumulativeTime.toISOString()}`);
      
      // Format ETA as HH:mm
      const etaHours = String(cumulativeTime.getHours()).padStart(2, '0');
      const etaMinutes = String(cumulativeTime.getMinutes()).padStart(2, '0');
      const eta = `${etaHours}:${etaMinutes}`;
      
      console.log(`  - Stop ${i + 1}: Final ETA = ${eta}`);
      
      updatedDeliveries.push({
        id: waypoint.deliveryId,
        delivery_time_eta: eta
      });
    }

    // Update deliveries in database (Rule 5)
    for (const update of updatedDeliveries) {
      await base44.asServiceRole.entities.Delivery.update(update.id, {
        delivery_time_eta: update.delivery_time_eta
      });
    }

    console.log(`✅ [ETA Updates] Updated ETAs for ${updatedDeliveries.length} deliveries`);

    return Response.json({
      success: true,
      updatedDeliveries,
      startLocation: { lat: startLat, lon: startLon },
      startTime: startTime.toISOString()
    });

  } catch (error) {
    console.error('[ETA Updates] Error in etaOptimizer:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});