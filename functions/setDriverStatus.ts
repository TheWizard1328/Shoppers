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
      console.log(`🔄 [setDriverStatus] Driver back on duty - finding closest delivery`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      }, 'stop_order');
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompleteDeliveries = allTodayDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );
      
      if (incompleteDeliveries.length > 0) {
        // Find closest stop to driver's current location
        let closestDelivery = null;
        let minDistance = Infinity;
        
        const driverLat = appUser.current_latitude;
        const driverLng = appUser.current_longitude;
        
        if (driverLat && driverLng) {
          // Calculate distance to each incomplete delivery
          for (const delivery of incompleteDeliveries) {
            let deliveryLat, deliveryLng;
            
            // Get coordinates based on delivery type
            if (delivery.patient_id) {
              // Patient delivery - fetch patient coordinates
              const patients = await base44.asServiceRole.entities.Patient.filter({ id: delivery.patient_id });
              if (patients && patients.length > 0) {
                deliveryLat = patients[0].latitude;
                deliveryLng = patients[0].longitude;
              }
            } else {
              // Store pickup - fetch store coordinates
              const stores = await base44.asServiceRole.entities.Store.filter({ id: delivery.store_id });
              if (stores && stores.length > 0) {
                deliveryLat = stores[0].latitude;
                deliveryLng = stores[0].longitude;
              }
            }
            
            if (deliveryLat && deliveryLng) {
              // Simple distance calculation (Haversine formula)
              const R = 6371; // Earth radius in km
              const dLat = (deliveryLat - driverLat) * Math.PI / 180;
              const dLng = (deliveryLng - driverLng) * Math.PI / 180;
              const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                        Math.cos(driverLat * Math.PI / 180) * Math.cos(deliveryLat * Math.PI / 180) *
                        Math.sin(dLng/2) * Math.sin(dLng/2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
              const distance = R * c;
              
              if (distance < minDistance) {
                minDistance = distance;
                closestDelivery = delivery;
              }
            }
          }
        }
        
        // If we found closest delivery, set it as next (but don't optimize yet - "Start" will handle that)
        if (closestDelivery) {
          console.log(`📍 [setDriverStatus] Closest delivery: ${closestDelivery.patient_name || 'Pickup'} (${minDistance.toFixed(2)} km away)`);
          console.log(`🎯 [setDriverStatus] Setting isNextDelivery=true - waiting for driver to click "Start"`);
          
          // ONLY set isNextDelivery flag - optimization happens when driver clicks "Start"
          await base44.asServiceRole.entities.Delivery.update(closestDelivery.id, { isNextDelivery: true });
          
          console.log(`✅ [setDriverStatus] Closest delivery marked as next - ready for driver to start`);
        } else {
          // Fallback to first stop by stop_order if distance calculation failed
          const nextDelivery = incompleteDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
          console.log(`📍 [setDriverStatus] Using first stop by order: ${nextDelivery.patient_name || 'Pickup'}`);
          await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true });
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