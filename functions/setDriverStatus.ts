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

    // When going off_duty or on_break, clear isNextDelivery flag on all incomplete deliveries for this driver
    if (newStatus === 'off_duty' || newStatus === 'on_break') {
      console.log(`🔄 [setDriverStatus] Clearing isNextDelivery flags for driver ${user.id} (status: ${newStatus})`);
      
      const today = new Date().toISOString().split('T')[0];
      
      // CRITICAL: Fetch ALL incomplete deliveries, not just those with isNextDelivery=true
      // This ensures we catch any that might have been missed
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      });
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompleteWithNextFlag = allTodayDeliveries.filter(d => 
        !finishedStatuses.includes(d.status) && d.isNextDelivery === true
      );
      
      console.log(`📦 [setDriverStatus] Found ${incompleteWithNextFlag.length} incomplete deliveries with isNextDelivery=true (of ${allTodayDeliveries.length} total)`);
      
      for (const delivery of incompleteWithNextFlag) {
        console.log(`   • Clearing isNextDelivery for: ${delivery.patient_name || 'Pickup'} (ID: ${delivery.id})`);
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }
      
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${incompleteWithNextFlag.length} deliveries`);
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