import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Calculates real-time ETAs for all active deliveries for a driver
 * Uses driver's current GPS location and Google Directions API for traffic-aware estimates
 * Stores ETAs as local time strings (HH:mm) based on device's timezone
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate, currentLocalTime } = await req.json();

    if (!driverId || !deliveryDate || !currentLocalTime) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate, currentLocalTime' 
      }, { status: 400 });
    }

    // Parse device's current local time (HH:mm format)
    const [currentHours, currentMinutes] = currentLocalTime.split(':').map(Number);
    const currentTotalMinutes = currentHours * 60 + currentMinutes;

    console.log(`📍 Calculating real-time ETAs for driver ${driverId} on ${deliveryDate}, current time: ${currentLocalTime}`);

    // Get driver's current location
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverAppUser = appUsers?.[0];

    if (!driverAppUser || !driverAppUser.current_latitude || !driverAppUser.current_longitude) {
      return Response.json({ 
        error: 'Driver location not available',
        driverId 
      }, { status: 404 });
    }

    const driverLocation = {
      lat: driverAppUser.current_latitude,
      lng: driverAppUser.current_longitude
    };

    // Get all active deliveries for this driver on this date
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      status: { $in: ['pending', 'Ready For Pickup', 'in_transit', 'en_route'] }
    });

    if (!deliveries || deliveries.length === 0) {
      return Response.json({ 
        message: 'No active deliveries found',
        etas: []
      });
    }

    // Get patients for coordinates
    const patientIds = [...new Set(deliveries.filter(d => d.patient_id).map(d => d.patient_id))];
    const patients = patientIds.length > 0 
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];

    const patientMap = new Map(patients.map(p => [p.id, p]));

    // Get stores for pickup coordinates
    const storeIds = [...new Set(deliveries.map(d => d.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } })
      : [];
    
    const storeMap = new Map(stores.map(s => [s.id, s]));

    // Sort deliveries by stop_order
    const sortedDeliveries = deliveries.sort((a, b) => 
      (a.stop_order || Infinity) - (b.stop_order || Infinity)
    );

    // Get or create polyline record for counter tracking
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

    // Build waypoints for ONE API call with all incomplete stops
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const etaUpdates = [];
    const waypoints = [];
    const deliveriesWithCoords = [];

    // Collect all stop coordinates
    for (const delivery of sortedDeliveries) {
      if (delivery.status === 'completed') continue;

      let destLat, destLng;
      
      if (delivery.puid) {
        const store = storeMap.get(delivery.store_id);
        if (!store || !store.latitude || !store.longitude) continue;
        destLat = store.latitude;
        destLng = store.longitude;
      } else {
        const patient = patientMap.get(delivery.patient_id);
        if (!patient || !patient.latitude || !patient.longitude) continue;
        destLat = patient.latitude;
        destLng = patient.longitude;
      }

      deliveriesWithCoords.push({ delivery, lat: destLat, lng: destLng });
    }

    if (deliveriesWithCoords.length === 0) {
      return Response.json({ 
        message: 'No incomplete deliveries with coordinates',
        etaUpdates: []
      });
    }

    // Build waypoints string (all stops except the last one)
    const waypointsStr = deliveriesWithCoords
      .slice(0, -1)
      .map(d => `${d.lat},${d.lng}`)
      .join('|');

    const lastStop = deliveriesWithCoords[deliveriesWithCoords.length - 1];

    // ONE API call for the entire route
    try {
      const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
        `origin=${driverLocation.lat},${driverLocation.lng}&` +
        `destination=${lastStop.lat},${lastStop.lng}&` +
        (waypointsStr ? `waypoints=optimize:false|${waypointsStr}&` : '') +
        `departure_time=now&` +
        `traffic_model=best_guess&` +
        `key=${googleMapsKey}`;

      const directionsResponse = await fetch(directionsUrl);
      const directionsData = await directionsResponse.json();

      if (directionsData.status === 'OK' && directionsData.routes?.[0]) {
        const route = directionsData.routes[0];
        let cumulativeMinutes = 0;

        // Process each leg of the route
        for (let i = 0; i < route.legs.length; i++) {
          const leg = route.legs[i];
          const delivery = deliveriesWithCoords[i].delivery;

          const durationSeconds = leg.duration_in_traffic?.value || leg.duration?.value || 0;
          const durationMinutes = Math.ceil(durationSeconds / 60);
          const serviceTime = delivery.extra_time || 5;
          
          cumulativeMinutes += durationMinutes + serviceTime;

          // Calculate ETA
          const etaTotalMinutes = currentTotalMinutes + cumulativeMinutes;
          const etaHours = Math.floor(etaTotalMinutes / 60) % 24;
          const etaMinutes = etaTotalMinutes % 60;
          const etaString = `${etaHours.toString().padStart(2, '0')}:${etaMinutes.toString().padStart(2, '0')}`;

          etaUpdates.push({
            deliveryId: delivery.id,
            delivery_id: delivery.delivery_id,
            oldEta: delivery.delivery_time_eta,
            newEta: etaString,
            durationMinutes,
            distanceMeters: leg.distance?.value || 0,
            trafficDelay: leg.duration_in_traffic?.value 
              ? (leg.duration_in_traffic.value - leg.duration.value) / 60
              : 0
          });

          // Update delivery ETA in database if changed
          if (delivery.delivery_time_eta !== etaString) {
            await base44.asServiceRole.entities.Delivery.update(delivery.id, {
              delivery_time_eta: etaString
            });
          }
        }

        console.log(`✅ Updated ${etaUpdates.length} ETAs with ONE API call`);
      }
    } catch (error) {
      console.error('Error calculating route ETAs:', error);
    }

    const apiCallCount = 1; // Only ONE API call now

    // Update polyline counter - only 1 API call now
    await base44.asServiceRole.entities.DriverRoutePolyline.update(polylineRecord.id, {
      daily_generation_count: (polylineRecord.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    });
    console.log(`📊 Incremented polyline counter by 1 (total: ${(polylineRecord.daily_generation_count || 0) + 1})`);


    console.log(`✅ Updated ${etaUpdates.length} ETAs for driver ${driverId}`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      driverLocation,
      etaUpdates,
      totalDeliveries: deliveries.length,
      apiCallsMade: 1
    });

  } catch (error) {
    console.error('❌ Error calculating real-time ETAs:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});