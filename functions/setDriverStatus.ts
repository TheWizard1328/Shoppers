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

    // Only enable location tracking if going on_duty
    if (newStatus === 'on_duty') {
      updateData.location_tracking_enabled = true;
    } else {
      updateData.location_tracking_enabled = false;
      updateData.current_latitude = null;
      updateData.current_longitude = null;
      updateData.location_updated_at = null;
    }

    await base44.asServiceRole.entities.AppUser.update(appUser.id, updateData);
    
    console.log(`✅ [setDriverStatus] Status set to: ${newStatus}`);
    console.log(`📍 [setDriverStatus] Location tracking enabled: ${newStatus === 'on_duty'}`);

    // When going on_break, ONLY clear isNextDelivery flags - DO NOT reorder deliveries
    if (newStatus === 'on_break') {
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing isNextDelivery flags ONLY`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      });
      
      const deliveriesWithNextFlag = allTodayDeliveries.filter(d => d.isNextDelivery === true);
      
      console.log(`📦 [setDriverStatus] Clearing isNextDelivery on ${deliveriesWithNextFlag.length} deliveries`);
      console.log(`📦 [setDriverStatus] NOT modifying stop_order - deliveries will remain in current sequence`);
      
      for (const delivery of deliveriesWithNextFlag) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
      
      console.log(`✅ [setDriverStatus] isNextDelivery flags cleared - delivery order preserved`);
    }
    
    // When coming back on_duty from break, set isNextDelivery flag and update ETAs
    if (newStatus === 'on_duty') {
      console.log(`🔄 [setDriverStatus] Driver back on duty - setting next delivery flag and updating ETAs`);
      
      const today = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      }, 'stop_order');
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompleteDeliveries = allTodayDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && d.status !== 'pending'
      ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
      if (incompleteDeliveries.length > 0) {
        const nextDelivery = incompleteDeliveries[0];
        
        console.log(`📍 [setDriverStatus] Setting isNextDelivery=true for: ${nextDelivery.patient_name || 'Pickup'}`);
        await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true });
        
        // ETAs will be automatically recalculated by ETATracker component
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