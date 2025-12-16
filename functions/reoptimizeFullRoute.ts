import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Re-optimize Full Route
 * Uses Google Maps Directions API to completely reoptimize all incomplete stops
 * for a driver's route, considering time windows and the driver's home as final destination.
 * 
 * CRITICAL: Only drivers can use this for their own routes.
 * 
 * Origin Priority:
 * 1. Driver's current GPS location
 * 2. Last completed stop location
 * 3. Driver's home location
 * 
 * Destination: Driver's home location (fixed)
 * 
 * Stops included: Only 'in_transit' and 'en_route' status stops
 */

// Haversine formula for distance calculation (fallback)
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

Deno.serve(async (req) => {
  console.log('🚀 [ReoptimizeFullRoute] Starting full route re-optimization');
  
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get request body
    const { driverId, deliveryDate } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    console.log(`📋 [ReoptimizeFullRoute] Driver: ${driverId}, Date: ${deliveryDate}`);

    // Get AppUser for authorization check and driver info
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const currentUserAppUser = appUsers[0];

    if (!currentUserAppUser) {
      return Response.json({ error: 'User profile not found' }, { status: 404 });
    }

    // Authorization: Only drivers can re-optimize their OWN routes
    const isDriver = currentUserAppUser.app_roles?.includes('driver');
    
    if (!isDriver) {
      return Response.json({ error: 'Only drivers can use route re-optimization' }, { status: 403 });
    }

    if (currentUserAppUser.user_id !== driverId) {
      return Response.json({ error: 'Drivers can only re-optimize their own routes' }, { status: 403 });
    }

    // Get Google Maps API Key
    const googleMapsApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!googleMapsApiKey) {
      return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 500 });
    }

    // Get driver's AppUser record for location info
    const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = driverAppUsers[0];

    if (!driverAppUser) {
      return Response.json({ error: 'Driver profile not found' }, { status: 404 });
    }

    // Check driver has home location (required for destination)
    if (!driverAppUser.home_latitude || !driverAppUser.home_longitude) {
      return Response.json({ 
        error: 'Driver home location not set. Please set your home address in settings.',
        code: 'NO_HOME_LOCATION'
      }, { status: 400 });
    }

    // Get all deliveries for this driver and date
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    console.log(`📦 [ReoptimizeFullRoute] Found ${allDeliveries.length} total deliveries`);

    // Separate by status
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const activeStatuses = ['in_transit', 'en_route'];
    
    const completedDeliveries = allDeliveries.filter(d => finishedStatuses.includes(d.status));
    const activeDeliveries = allDeliveries.filter(d => activeStatuses.includes(d.status));
    
    // Find isNextDelivery stop (locked in position)
    const isNextDeliveryStop = allDeliveries.find(d => d.isNextDelivery === true && !finishedStatuses.includes(d.status));

    console.log(`📊 [ReoptimizeFullRoute] Completed: ${completedDeliveries.length}, Active: ${activeDeliveries.length}, isNextDelivery: ${isNextDeliveryStop ? 'yes' : 'no'}`);

    if (activeDeliveries.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No active stops to optimize',
        optimizedCount: 0 
      });
    }

    // Get patients and stores for coordinates
    const patients = await base44.asServiceRole.entities.Patient.list();
    const stores = await base44.asServiceRole.entities.Store.list();

    const patientMap = new Map(patients.map(p => [p.id, p]));
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Determine ORIGIN (priority: current GPS > last completed > home)
    let originLat, originLng;
    let originSource = '';
    let currentTimeMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    // Priority 1: Driver's current GPS location (if recent)
    if (driverAppUser.current_latitude && driverAppUser.current_longitude && driverAppUser.location_updated_at) {
      const locationAge = Date.now() - new Date(driverAppUser.location_updated_at).getTime();
      const fiveMinutesMs = 5 * 60 * 1000;
      
      if (locationAge < fiveMinutesMs) {
        originLat = driverAppUser.current_latitude;
        originLng = driverAppUser.current_longitude;
        originSource = 'current_gps';
        console.log(`📍 [ReoptimizeFullRoute] Origin: Driver's current GPS location`);
      }
    }

    // Priority 2: Last completed stop
    if (!originLat && completedDeliveries.length > 0) {
      const sortedCompleted = [...completedDeliveries].sort((a, b) => 
        new Date(b.actual_delivery_time || 0) - new Date(a.actual_delivery_time || 0)
      );
      const lastCompleted = sortedCompleted[0];
      
      if (lastCompleted.patient_id) {
        const patient = patientMap.get(lastCompleted.patient_id);
        if (patient?.latitude && patient?.longitude) {
          originLat = patient.latitude;
          originLng = patient.longitude;
          originSource = 'last_completed';
        }
      } else if (lastCompleted.store_id) {
        const store = storeMap.get(lastCompleted.store_id);
        if (store?.latitude && store?.longitude) {
          originLat = store.latitude;
          originLng = store.longitude;
          originSource = 'last_completed';
        }
      }
      
      if (originLat) {
        console.log(`📍 [ReoptimizeFullRoute] Origin: Last completed stop`);
      }
    }

    // Priority 3: Driver's home location
    if (!originLat) {
      originLat = driverAppUser.home_latitude;
      originLng = driverAppUser.home_longitude;
      originSource = 'home';
      console.log(`📍 [ReoptimizeFullRoute] Origin: Driver's home location`);
    }

    // DESTINATION: Always driver's home
    const destLat = driverAppUser.home_latitude;
    const destLng = driverAppUser.home_longitude;
    console.log(`🏠 [ReoptimizeFullRoute] Destination: Driver's home location`);

    // Build waypoints array (exclude isNextDelivery - it stays locked)
    const stopsToOptimize = isNextDeliveryStop 
      ? activeDeliveries.filter(d => d.id !== isNextDeliveryStop.id)
      : activeDeliveries;

    // Enrich stops with coordinates
    const enrichedStops = stopsToOptimize.map(delivery => {
      let lat, lng;
      
      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        lat = patient?.latitude;
        lng = patient?.longitude;
      } else if (delivery.store_id) {
        const store = storeMap.get(delivery.store_id);
        lat = store?.latitude;
        lng = store?.longitude;
      }
      
      return {
        ...delivery,
        latitude: lat,
        longitude: lng,
        timeWindowStart: delivery.time_window_start || delivery.delivery_time_start,
        timeWindowEnd: delivery.time_window_end || delivery.delivery_time_end
      };
    }).filter(s => s.latitude && s.longitude);

    console.log(`🗺️ [ReoptimizeFullRoute] Stops with coordinates: ${enrichedStops.length}`);

    if (enrichedStops.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No stops with valid coordinates to optimize',
        optimizedCount: 0 
      });
    }

    // Log the API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: 'Full route re-optimization via FAB button',
      function_name: 'reoptimizeFullRoute',
      user_id: user.id,
      user_name: user.full_name,
      metadata: {
        driverId,
        deliveryDate,
        originSource,
        numStops: enrichedStops.length,
        hasIsNextDelivery: !!isNextDeliveryStop
      }
    });

    // Build Google Directions API request
    // If we have isNextDelivery, use IT as the actual origin for optimization
    let actualOriginLat = originLat;
    let actualOriginLng = originLng;
    
    if (isNextDeliveryStop) {
      // Get isNextDelivery coordinates
      if (isNextDeliveryStop.patient_id) {
        const patient = patientMap.get(isNextDeliveryStop.patient_id);
        if (patient?.latitude && patient?.longitude) {
          actualOriginLat = patient.latitude;
          actualOriginLng = patient.longitude;
        }
      } else if (isNextDeliveryStop.store_id) {
        const store = storeMap.get(isNextDeliveryStop.store_id);
        if (store?.latitude && store?.longitude) {
          actualOriginLat = store.latitude;
          actualOriginLng = store.longitude;
        }
      }
    }

    const waypointsStr = enrichedStops
      .map(s => `${s.latitude},${s.longitude}`)
      .join('|');

    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${actualOriginLat},${actualOriginLng}` +
      `&destination=${destLat},${destLng}` +
      `&waypoints=optimize:true|${waypointsStr}` +
      `&departure_time=now` +
      `&traffic_model=best_guess` +
      `&key=${googleMapsApiKey}`;

    console.log(`🌐 [ReoptimizeFullRoute] Calling Google Directions API...`);

    const directionsResponse = await fetch(directionsUrl);
    const directionsData = await directionsResponse.json();

    if (directionsData.status !== 'OK') {
      console.error(`❌ [ReoptimizeFullRoute] Google API error: ${directionsData.status}`, directionsData.error_message);
      return Response.json({ 
        error: `Google Directions API failed: ${directionsData.status}`,
        details: directionsData.error_message 
      }, { status: 500 });
    }

    const route = directionsData.routes[0];
    const waypointOrder = route.waypoint_order;
    const legs = route.legs;

    console.log(`✅ [ReoptimizeFullRoute] Google returned optimized order: [${waypointOrder.join(', ')}]`);

    // Reorder stops based on Google's optimization
    const orderedStops = waypointOrder.map(idx => enrichedStops[idx]);

    // Calculate ETAs using leg durations from Google
    let cumulativeTime = currentTimeMinutes;
    const updates = [];

    // First: Calculate and update isNextDelivery ETA (if exists)
    if (isNextDeliveryStop) {
      // Calculate travel time from current origin to isNextDelivery
      let isNextLat, isNextLng;
      if (isNextDeliveryStop.patient_id) {
        const patient = patientMap.get(isNextDeliveryStop.patient_id);
        isNextLat = patient?.latitude;
        isNextLng = patient?.longitude;
      } else if (isNextDeliveryStop.store_id) {
        const store = storeMap.get(isNextDeliveryStop.store_id);
        isNextLat = store?.latitude;
        isNextLng = store?.longitude;
      }
      
      if (isNextLat && isNextLng) {
        // Use simple distance calculation for isNextDelivery (it's not in the Directions response)
        const distanceKm = calculateDistance(originLat, originLng, isNextLat, isNextLng);
        const travelMinutes = Math.ceil((distanceKm / 40) * 60); // 40 km/h average
        
        cumulativeTime += travelMinutes;
        
        // Check time window
        if (isNextDeliveryStop.time_window_start || isNextDeliveryStop.delivery_time_start) {
          const windowStart = timeToMinutes(isNextDeliveryStop.time_window_start || isNextDeliveryStop.delivery_time_start);
          if (cumulativeTime < windowStart) {
            cumulativeTime = windowStart;
          }
        }
        
        const nextStopOrder = completedDeliveries.length + 1;
        const nextETA = minutesToTime(cumulativeTime);
        
        await base44.asServiceRole.entities.Delivery.update(isNextDeliveryStop.id, {
          stop_order: nextStopOrder,
          display_stop_order: nextStopOrder,
          delivery_time_eta: nextETA
        });
        
        console.log(`✅ [ReoptimizeFullRoute] isNextDelivery #${nextStopOrder}: ${isNextDeliveryStop.patient_name || 'Pickup'} ETA: ${nextETA}`);
        
        // Add service time
        const serviceTime = isNextDeliveryStop.extra_time || (isNextDeliveryStop.patient_id ? 5 : 15);
        cumulativeTime += serviceTime;
      }
    }

    // Then: Update all optimized stops
    const startingStopOrder = completedDeliveries.length + (isNextDeliveryStop ? 1 : 0);

    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const leg = legs[i]; // Each leg corresponds to travel TO this waypoint
      
      // Use Google's duration if available
      let travelMinutes = 10; // Default
      if (leg && leg.duration_in_traffic) {
        travelMinutes = Math.ceil(leg.duration_in_traffic.value / 60);
      } else if (leg && leg.duration) {
        travelMinutes = Math.ceil(leg.duration.value / 60);
      }
      
      cumulativeTime += travelMinutes;
      
      // Check time window - for pickups, must wait until window opens
      const isPickup = !stop.patient_id;
      if (stop.timeWindowStart) {
        const windowStart = timeToMinutes(stop.timeWindowStart);
        if (isPickup && cumulativeTime < windowStart) {
          // Pickups: wait until window opens
          cumulativeTime = windowStart;
        }
        // Deliveries: don't force waiting, just calculate ETA
      }
      
      const newStopOrder = startingStopOrder + i + 1;
      const eta = minutesToTime(cumulativeTime);
      
      await base44.asServiceRole.entities.Delivery.update(stop.id, {
        stop_order: newStopOrder,
        display_stop_order: newStopOrder,
        delivery_time_eta: eta
      });
      
      updates.push({
        deliveryId: stop.id,
        patient_name: stop.patient_name || 'Pickup',
        newStopOrder,
        eta,
        travelMinutes
      });
      
      console.log(`✅ [ReoptimizeFullRoute] Stop #${newStopOrder}: ${stop.patient_name || 'Pickup'} ETA: ${eta}`);
      
      // Add service time for next iteration
      const serviceTime = stop.extra_time || (stop.patient_id ? 5 : 15);
      cumulativeTime += serviceTime;
    }

    // Calculate final leg to home
    if (legs.length > orderedStops.length) {
      const finalLeg = legs[legs.length - 1];
      const homeArrivalMinutes = cumulativeTime + Math.ceil((finalLeg.duration_in_traffic?.value || finalLeg.duration?.value || 600) / 60);
      console.log(`🏠 [ReoptimizeFullRoute] Estimated home arrival: ${minutesToTime(homeArrivalMinutes)}`);
    }

    console.log(`🎉 [ReoptimizeFullRoute] Complete! Optimized ${updates.length} stops`);

    return Response.json({
      success: true,
      message: `Route re-optimized with ${updates.length} stops`,
      optimizedCount: updates.length,
      updates,
      originSource,
      totalDistance: route.legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0) / 1000,
      totalDuration: route.legs.reduce((sum, leg) => sum + (leg.duration_in_traffic?.value || leg.duration?.value || 0), 0) / 60
    });

  } catch (error) {
    console.error('❌ [ReoptimizeFullRoute] Error:', error.message, error.stack);
    return Response.json({ error: error.message }, { status: 500 });
  }
});