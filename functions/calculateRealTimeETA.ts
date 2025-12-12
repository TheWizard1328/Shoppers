import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

/**
 * Calculates real-time ETAs for all active deliveries for a driver
 * Uses driver's current GPS location and Google Directions API for traffic-aware estimates
 * Stores ETAs as UTC ISO strings for timezone-independent accuracy
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required parameters: driverId, deliveryDate' 
      }, { status: 400 });
    }

    console.log(`📍 Calculating real-time ETAs for driver ${driverId} on ${deliveryDate}`);

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

    // Calculate cumulative ETAs
    const googleMapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    const etaUpdates = [];
    let currentLocation = driverLocation;
    let cumulativeMinutes = 0;

    for (const delivery of sortedDeliveries) {
      // Determine destination coordinates
      let destLat, destLng;
      
      if (delivery.puid) {
        // This is a pickup - use store coordinates
        const store = storeMap.get(delivery.store_id);
        if (!store || !store.latitude || !store.longitude) continue;
        destLat = store.latitude;
        destLng = store.longitude;
      } else {
        // This is a delivery - use patient coordinates
        const patient = patientMap.get(delivery.patient_id);
        if (!patient || !patient.latitude || !patient.longitude) continue;
        destLat = patient.latitude;
        destLng = patient.longitude;
      }

      // Skip if already completed
      if (delivery.status === 'completed') continue;

      // Call Google Directions API for traffic-aware ETA
      try {
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
          `origin=${currentLocation.lat},${currentLocation.lng}&` +
          `destination=${destLat},${destLng}&` +
          `departure_time=now&` +
          `traffic_model=best_guess&` +
          `key=${googleMapsKey}`;

        const directionsResponse = await fetch(directionsUrl);
        const directionsData = await directionsResponse.json();

        if (directionsData.status === 'OK' && directionsData.routes?.[0]) {
          const route = directionsData.routes[0];
          const leg = route.legs[0];
          
          // Get duration in traffic (in seconds)
          const durationSeconds = leg.duration_in_traffic?.value || leg.duration?.value || 0;
          const durationMinutes = Math.ceil(durationSeconds / 60);

          // Add service time (5 minutes per stop)
          const serviceTime = delivery.extra_time || 5;
          cumulativeMinutes += durationMinutes + serviceTime;

          // Calculate ETA as UTC Date object
          const now = new Date();
          const etaTime = new Date(now.getTime() + cumulativeMinutes * 60000);
          const etaIsoString = etaTime.toISOString();

          etaUpdates.push({
            deliveryId: delivery.id,
            delivery_id: delivery.delivery_id,
            oldEta: delivery.delivery_time_eta,
            newEta: etaIsoString,
            durationMinutes,
            distanceMeters: leg.distance?.value || 0,
            trafficDelay: leg.duration_in_traffic?.value 
              ? (leg.duration_in_traffic.value - leg.duration.value) / 60
              : 0
          });

          // Update delivery ETA in database if changed
          if (delivery.delivery_time_eta !== etaIsoString) {
            await base44.asServiceRole.entities.Delivery.update(delivery.id, {
              delivery_time_eta: etaIsoString
            });
          }

          // Move current location to this stop
          currentLocation = { lat: destLat, lng: destLng };
        }
      } catch (error) {
        console.error(`Error calculating ETA for delivery ${delivery.id}:`, error);
      }
    }

    console.log(`✅ Updated ${etaUpdates.length} ETAs for driver ${driverId}`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      driverLocation,
      etaUpdates,
      totalDeliveries: deliveries.length
    });

  } catch (error) {
    console.error('❌ Error calculating real-time ETAs:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});