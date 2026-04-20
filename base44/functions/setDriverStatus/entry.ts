import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const getEdmDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { newStatus, deviceId, selectedDate } = await req.json();

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
    const previousStatus = appUser.driver_status;
    console.log(`📱 [setDriverStatus] Found AppUser: ${appUser.id}`);

    const updateData = {
      driver_status: newStatus
    };

    if (newStatus === 'on_duty' || newStatus === 'on_break') {
      updateData.location_tracking_enabled = true;
      updateData.location_updated_at = new Date().toISOString();
      console.log(`📍 [setDriverStatus] Updating location timestamp for status change to: ${newStatus}`);
    }

    if (newStatus === 'off_duty') {
      updateData.location_tracking_enabled = false;
      updateData.current_latitude = null;
      updateData.current_longitude = null;
      updateData.location_updated_at = null;
      console.log('📍 [setDriverStatus] Disabling location sharing for off duty');
    }

    // CRITICAL: Update with broadcast to ensure all clients receive the change immediately
    const updatedAppUser = await base44.asServiceRole.entities.AppUser.update(appUser.id, updateData).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });

    if (!updatedAppUser) {
      return Response.json({ success: true, skipped: true, reason: 'app_user_not_found_during_update' });
    }
    
    console.log(`✅ [setDriverStatus] Status set to: ${newStatus}`);
    console.log(`📍 [setDriverStatus] Location tracking enabled: ${newStatus === 'on_duty'}`);
    
    // CRITICAL: Broadcast the change to all connected clients immediately
    console.log(`📡 [setDriverStatus] Broadcasting driver status change to all clients...`);

    // When going on_break, clear ALL isNextDelivery flags for incomplete stops
    if (newStatus === 'on_break') {
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing ALL isNextDelivery flags`);
      
      const today = getEdmDate();
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
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }
      
      console.log(`✅ [setDriverStatus] All isNextDelivery flags cleared for incomplete stops`);
    }
    
    // When coming back on_duty, always ensure exactly one eligible stop is marked as next
    if (newStatus === 'on_duty') {
      const today = getEdmDate();
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      }, 'stop_order');

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const flaggedDeliveries = allTodayDeliveries.filter((d) => d?.isNextDelivery === true);

      for (const delivery of flaggedDeliveries) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }

      const eligibleDeliveries = allTodayDeliveries
        .filter((d) => !finishedStatuses.includes(d.status))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

      const nextDelivery = eligibleDeliveries[0] || null;

      if (nextDelivery) {
        await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
        console.log(`✅ [setDriverStatus] Ensured next stop is set: ${nextDelivery.patient_name || 'Pickup'}`);
      } else {
        console.log(`ℹ️ [setDriverStatus] No eligible unfinished deliveries available to mark as next`);
      }
    }
    
    // When going off_duty, clear isNextDelivery flags
    if (newStatus === 'off_duty') {
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags`);
      
      const targetDate = selectedDate || getEdmDate();
      const targetDateDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: targetDate
      });
      
      const deliveriesWithNextFlag = targetDateDeliveries.filter(d => d.isNextDelivery === true);
      
      for (const delivery of deliveriesWithNextFlag) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }
      
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${deliveriesWithNextFlag.length} deliveries for ${targetDate}`);
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