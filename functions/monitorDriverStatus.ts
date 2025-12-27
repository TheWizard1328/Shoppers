/**
 * Monitor Driver Status
 * 
 * Checks all on-duty drivers and automatically updates their status:
 * - If location data is stale (>5 min) and not at a pickup location:
 *   - Has active stops remaining → Set to 'on_break'
 *   - No stops remaining → Set to 'off_duty'
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { format } from 'npm:date-fns@3.6.0';

// Haversine distance calculation (in meters)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Use service role for admin-level operations
    const now = new Date();
    const todayStr = format(now, 'yyyy-MM-dd');
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes in milliseconds
    const pickupProximityMeters = 100; // Consider "at pickup" if within 100m
    
    // Get all AppUsers who are drivers and currently on_duty
    const allAppUsers = await base44.asServiceRole.entities.AppUser.filter({
      driver_status: 'on_duty',
      location_tracking_enabled: true
    });
    
    // Filter to only those with driver role
    const onDutyDrivers = allAppUsers.filter(au => 
      au.app_roles && au.app_roles.includes('driver')
    );
    
    if (onDutyDrivers.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No on-duty drivers to monitor',
        checked: 0,
        updated: 0
      });
    }
    
    // Get all stores for pickup location checking
    const stores = await base44.asServiceRole.entities.Store.filter({});
    const storeLocations = stores
      .filter(s => s.latitude && s.longitude)
      .map(s => ({ id: s.id, lat: s.latitude, lon: s.longitude, name: s.name }));
    
    // Get today's deliveries to check for remaining stops
    const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      delivery_date: todayStr
    });
    
    const updatedDrivers = [];
    const skippedDrivers = [];
    
    for (const driver of onDutyDrivers) {
      const driverId = driver.user_id;
      const locationUpdatedAt = driver.location_updated_at ? new Date(driver.location_updated_at) : null;
      const currentLat = driver.current_latitude;
      const currentLon = driver.current_longitude;
      
      // Check if location data is stale
      const isLocationStale = !locationUpdatedAt || 
        (now.getTime() - locationUpdatedAt.getTime() > staleThresholdMs);
      
      if (!isLocationStale) {
        skippedDrivers.push({ 
          id: driverId, 
          name: driver.user_name, 
          reason: 'Location data is fresh' 
        });
        continue;
      }
      
      // Check if driver is at a pickup location (store)
      let isAtPickupLocation = false;
      if (currentLat && currentLon) {
        for (const store of storeLocations) {
          const distance = getDistanceMeters(currentLat, currentLon, store.lat, store.lon);
          if (distance <= pickupProximityMeters) {
            isAtPickupLocation = true;
            skippedDrivers.push({ 
              id: driverId, 
              name: driver.user_name, 
              reason: `At pickup location: ${store.name}` 
            });
            break;
          }
        }
      }
      
      if (isAtPickupLocation) {
        continue;
      }
      
      // Check for remaining active stops
      const driverDeliveries = todayDeliveries.filter(d => 
        d.driver_id === driverId && 
        d.status !== 'completed' && 
        d.status !== 'failed' && 
        d.status !== 'cancelled'
      );
      
      const hasActiveStops = driverDeliveries.length > 0;
      
      // Determine new status
      const newStatus = hasActiveStops ? 'on_break' : 'off_duty';
      
      // Update the driver's status
      try {
        await base44.asServiceRole.entities.AppUser.update(driver.id, {
          driver_status: newStatus,
          location_tracking_enabled: false
        });
        
        updatedDrivers.push({
          id: driverId,
          appUserId: driver.id,
          name: driver.user_name,
          previousStatus: 'on_duty',
          newStatus: newStatus,
          reason: hasActiveStops 
            ? `Location stale for >5min, ${driverDeliveries.length} active stops remaining` 
            : 'Location stale for >5min, no active stops remaining',
          lastLocationUpdate: locationUpdatedAt ? locationUpdatedAt.toISOString() : 'never',
          staleDurationMinutes: locationUpdatedAt 
            ? Math.round((now.getTime() - locationUpdatedAt.getTime()) / 60000) 
            : 'N/A'
        });
      } catch (updateError) {
        console.error(`Failed to update driver ${driverId}:`, updateError);
      }
    }
    
    return Response.json({
      success: true,
      timestamp: now.toISOString(),
      checked: onDutyDrivers.length,
      updated: updatedDrivers.length,
      skipped: skippedDrivers.length,
      updatedDrivers,
      skippedDrivers
    });
    
  } catch (error) {
    console.error('Monitor driver status error:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});