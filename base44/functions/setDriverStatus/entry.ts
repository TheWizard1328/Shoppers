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

const clearNextDeliveryFlags = async (base44, driverId, deliveryDate) => {
  const deliveries = await base44.asServiceRole.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: deliveryDate
  });

  const flaggedDeliveries = deliveries.filter((delivery) => delivery?.isNextDelivery === true);

  for (const delivery of flaggedDeliveries) {
    await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
  }

  return flaggedDeliveries.length;
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

    // When going on_break, clear all next-stop flags for the selected driver/date
    if (newStatus === 'on_break') {
      const targetDate = selectedDate || getEdmDate();
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, user.id, targetDate);
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${clearedCount} deliveries for ${targetDate}`);
    }
    
    // When coming back on_duty, preserve existing route state.
    // Do not reassign isNextDelivery here because start/complete/optimizer own that flow.
    if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      const targetDate = selectedDate || getEdmDate();
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: targetDate
      }, 'stop_order');

      const flaggedDeliveries = allTodayDeliveries.filter((d) => d?.isNextDelivery === true);
      console.log(`📦 [setDriverStatus] Found ${allTodayDeliveries.length} deliveries for ${targetDate}`);
      console.log(`📦 [setDriverStatus] Preserving existing next-stop state on on_duty (${flaggedDeliveries.length} currently flagged)`);

      if (flaggedDeliveries.length > 0) {
        await base44.asServiceRole.functions.invoke('regenerateType1Polyline', {
          driverId: user.id,
          deliveryDate: targetDate,
          currentLocation: {
            lat: updatedAppUser.home_latitude,
            lon: updatedAppUser.home_longitude
          },
          isPrimaryDevice: true,
          force: true,
          routeChangeSource: 'on_duty_start'
        }).catch((error) => {
          console.warn('⚠️ [setDriverStatus] Initial home-to-first-stop polyline skipped:', error?.message || error);
        });
      }
    }
    
    // When going off_duty, clear all next-stop flags for the selected driver/date
    if (newStatus === 'off_duty') {
      const targetDate = selectedDate || getEdmDate();
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, user.id, targetDate);
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${clearedCount} deliveries for ${targetDate}`);
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