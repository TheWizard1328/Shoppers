import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { newStatus, deviceId } = await req.json();

    if (!newStatus) {
      return Response.json({ error: 'Missing required field: newStatus' }, { status: 400 });
    }

    console.log(`🔄 [setDriverStatus] User ${user.email} changing status to: ${newStatus}`);

    // Find the AppUser record for this user (one per user, not per device)
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    
    if (!appUsers || appUsers.length === 0) {
      return Response.json({ error: 'AppUser record not found' }, { status: 404 });
    }

    const appUser = appUsers[0];
    console.log(`📱 [setDriverStatus] Found AppUser: ${appUser.id}`);

    const updateData = {
      driver_status: newStatus
    };

    // CRITICAL: Drivers can ALWAYS see their own shared location marker on other devices
    // Location tracking remains enabled for ALL statuses (on_duty, off_duty, on_break)
    // This allows drivers to see their own marker on other devices they're logged into
    // Only the driver_status field changes - location tracking continues
    if (newStatus === 'on_duty' || newStatus === 'off_duty' || newStatus === 'on_break') {
      updateData.location_tracking_enabled = true;
    }
    
    // CRITICAL: Update timestamp when status changes so marker updates immediately
    // This ensures timestamp is fresh even if driver is stationary
    if (newStatus !== 'off_duty') {
      updateData.location_updated_at = new Date().toISOString();
      console.log(`📍 [setDriverStatus] Updating location timestamp for status change to: ${newStatus}`);
    }
    // Location data is NEVER cleared - drivers can always see their own position

    // CRITICAL: Update with broadcast to ensure all clients receive the change immediately
    await base44.asServiceRole.entities.AppUser.update(appUser.id, updateData);
    
    console.log(`✅ [setDriverStatus] Status set to: ${newStatus}`);
    console.log(`📍 [setDriverStatus] Location tracking enabled: ${newStatus === 'on_duty'}`);
    
    // CRITICAL: Broadcast the change to all connected clients immediately
    console.log(`📡 [setDriverStatus] Broadcasting driver status change to all clients...`);

    // When going on_break, clear ALL isNextDelivery flags for incomplete stops
    if (newStatus === 'on_break') {
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing ALL isNextDelivery flags`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      });
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompleteDeliveries = allTodayDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );
      
      console.log(`📦 [setDriverStatus] Clearing isNextDelivery on ${incompleteDeliveries.length} incomplete deliveries`);
      
      for (const delivery of incompleteDeliveries) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
      
      console.log(`✅ [setDriverStatus] All isNextDelivery flags cleared for incomplete stops`);
    }
    
    // When coming back on_duty from break, find closest delivery and set it as isNextDelivery
    if (newStatus === 'on_duty') {
      console.log(`🔄 [setDriverStatus] Driver back on duty - finding closest delivery (non-pending only, respecting time windows)`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      }, 'stop_order');
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      
      // CRITICAL: Get current time for time window checking
      const now = new Date();
      const currentHours = now.getHours();
      const currentMinutes = now.getMinutes();
      const currentTimeInMinutes = currentHours * 60 + currentMinutes;
      
      // Helper to check if delivery is within acceptable time window
      const isWithinTimeWindow = (delivery) => {
        // If no time window set, always eligible
        if (!delivery.delivery_time_start && !delivery.delivery_time_end) {
          return true;
        }
        
        // Parse time window strings (HH:mm format)
        let windowStartMinutes = 0;
        let windowEndMinutes = 24 * 60; // End of day
        
        if (delivery.delivery_time_start) {
          const [hours, mins] = delivery.delivery_time_start.split(':').map(Number);
          windowStartMinutes = (hours || 0) * 60 + (mins || 0);
        }
        
        if (delivery.delivery_time_end) {
          const [hours, mins] = delivery.delivery_time_end.split(':').map(Number);
          windowEndMinutes = (hours || 0) * 60 + (mins || 0);
        }
        
        // Check if current time is before window or within window
        // CRITICAL: Allow selection if current time is before window (not yet started)
        // OR if current time is within window
        return currentTimeInMinutes <= windowEndMinutes;
      };
      
      const incompleteDeliveries = allTodayDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && 
        d.status !== 'pending' &&  // CRITICAL: Skip pending status stops
        isWithinTimeWindow(d)       // CRITICAL: Respect time windows
      );
      
      console.log(`📦 [setDriverStatus] Filtered to ${incompleteDeliveries.length} eligible deliveries (non-pending, within time windows)`);
      
      if (incompleteDeliveries.length > 0) {
        const driverLat = appUser.current_latitude;
        const driverLng = appUser.current_longitude;
        
        if (driverLat && driverLng) {
          // CRITICAL: Find stop where driver's ETA is closest to the delivery time window start
          // This prioritizes stops the driver will naturally arrive near their scheduled time
          let bestDelivery = null;
          let bestETADifference = Infinity;
          
          console.log(`🔍 [setDriverStatus] Evaluating ${incompleteDeliveries.length} stops for optimal time-window match...`);
          
          for (const delivery of incompleteDeliveries) {
            let deliveryLat, deliveryLng;
            
            // Get coordinates based on delivery type
            if (delivery.patient_id) {
              const patients = await base44.asServiceRole.entities.Patient.filter({ id: delivery.patient_id });
              if (patients && patients.length > 0) {
                deliveryLat = patients[0].latitude;
                deliveryLng = patients[0].longitude;
              }
            } else {
              const stores = await base44.asServiceRole.entities.Store.filter({ id: delivery.store_id });
              if (stores && stores.length > 0) {
                deliveryLat = stores[0].latitude;
                deliveryLng = stores[0].longitude;
              }
            }
            
            if (!deliveryLat || !deliveryLng) continue;
            
            // Calculate distance (Haversine formula)
            const R = 6371; // Earth radius in km
            const dLat = (deliveryLat - driverLat) * Math.PI / 180;
            const dLng = (deliveryLng - driverLng) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(driverLat * Math.PI / 180) * Math.cos(deliveryLat * Math.PI / 180) *
                      Math.sin(dLng/2) * Math.sin(dLng/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const distanceKm = R * c;
            
            // Estimate travel time: assume 25 km/h average (urban delivery speed)
            const travelTimeMinutes = (distanceKm / 25) * 60;
            
            // Calculate driver's ETA
            const driverETA = currentHours * 60 + currentMinutes + travelTimeMinutes;
            
            // Get delivery time window start (default to current time if not set)
            let windowStartMinutes = currentHours * 60 + currentMinutes;
            if (delivery.delivery_time_start) {
              const [hours, mins] = delivery.delivery_time_start.split(':').map(Number);
              windowStartMinutes = (hours || 0) * 60 + (mins || 0);
            }
            
            // Calculate difference between ETA and time window start
            // CRITICAL: Prefer stops where ETA matches time window (small difference)
            const etaDifference = Math.abs(driverETA - windowStartMinutes);
            
            console.log(`  Stop: ${delivery.patient_name || 'Pickup'} | Distance: ${distanceKm.toFixed(1)}km | ETA: ${Math.floor(driverETA/60)}:${String(Math.floor(driverETA%60)).padStart(2,'0')} | TimeStart: ${delivery.delivery_time_start || 'none'} | Diff: ${etaDifference.toFixed(0)}min`);
            
            // Select stop with smallest ETA difference (closest to time window)
            if (etaDifference < bestETADifference) {
              bestETADifference = etaDifference;
              bestDelivery = delivery;
            }
          }
          
          if (bestDelivery) {
            console.log(`🎯 [setDriverStatus] Selected: ${bestDelivery.patient_name || 'Pickup'} (ETA matches time window by ${bestETADifference.toFixed(0)} min)`);
            await base44.asServiceRole.entities.Delivery.update(bestDelivery.id, { isNextDelivery: true });
            console.log(`✅ [setDriverStatus] Delivery marked as next - ready for driver to start`);
          } else {
            console.log(`⚠️ [setDriverStatus] Could not evaluate stops with coordinates`);
          }
        } else {
          // No location available - fallback to first stop by order
          const nextDelivery = incompleteDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
          if (nextDelivery) {
            console.log(`📍 [setDriverStatus] No driver location - using first stop by order: ${nextDelivery.patient_name || 'Pickup'}`);
            await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true });
          }
        }
      } else {
        console.log(`ℹ️ [setDriverStatus] No incomplete deliveries to mark as next`);
      }
    }
    
    // When going off_duty, clear isNextDelivery flags
    if (newStatus === 'off_duty') {
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      });
      
      const deliveriesWithNextFlag = allTodayDeliveries.filter(d => d.isNextDelivery === true);
      
      for (const delivery of deliveriesWithNextFlag) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
      
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${deliveriesWithNextFlag.length} deliveries`);
    }

    return Response.json({
      success: true,
      newStatus,
      appUserId: appUser.id
    });

  } catch (error) {
    console.error('❌ [setDriverStatus] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});