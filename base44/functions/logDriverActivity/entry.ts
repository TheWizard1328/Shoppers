import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { latitude, longitude, driverId } = await req.json();

    if (!latitude || !longitude || !driverId) {
      return Response.json({ error: 'Missing required fields: latitude, longitude, driverId' }, { status: 400 });
    }

    // Get driver's AppUser record
    const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
    if (!appUsers || appUsers.length === 0) {
      return Response.json({ error: 'Driver AppUser not found' }, { status: 404 });
    }

    const appUser = appUsers[0];
    const previousLat = appUser.current_latitude;
    const previousLng = appUser.current_longitude;

    // Calculate distance from previous location (if available)
    let distanceTraveled = 0;
    if (previousLat !== null && previousLat !== undefined && 
        previousLng !== null && previousLng !== undefined) {
      // Haversine formula
      const R = 6371; // Earth's radius in km
      const dLat = (latitude - previousLat) * Math.PI / 180;
      const dLon = (longitude - previousLng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(previousLat * Math.PI / 180) * Math.cos(latitude * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distanceTraveled = R * c;
    }

    // Update driver's current location
    const updatedAppUser = await base44.entities.AppUser.update(appUser.id, {
      current_latitude: latitude,
      current_longitude: longitude,
      location_updated_at: new Date().toISOString()
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });

    if (!updatedAppUser) {
      return Response.json({ success: true, skipped: true, reason: 'app_user_not_found_during_update' });
    }

    // Find the current isNextDelivery stop for today
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const nextDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: today,
      isNextDelivery: true
    });

    // If there's an active next delivery, accumulate distance to its travel_dist
    if (nextDeliveries && nextDeliveries.length > 0 && distanceTraveled > 0) {
      const nextDelivery = nextDeliveries[0];
      const currentTravelDist = nextDelivery.travel_dist || 0;
      const newTravelDist = parseFloat((currentTravelDist + distanceTraveled).toFixed(2));

      await base44.entities.Delivery.update(nextDelivery.id, {
        travel_dist: newTravelDist
      }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });

      console.log(`📍 [logDriverActivity] Updated travel_dist for ${nextDelivery.patient_name || 'Pickup'}: ${currentTravelDist} + ${distanceTraveled.toFixed(2)} = ${newTravelDist}`);
    }

    return Response.json({
      success: true,
      distanceTraveled: parseFloat(distanceTraveled.toFixed(2)),
      location: { latitude, longitude }
    });

  } catch (error) {
    console.error('[logDriverActivity] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});