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
    
    // When coming back on_duty, set next delivery differently based on previous status
    if (newStatus === 'on_duty') {
      const today = getEdmDate();
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      }, 'stop_order');

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const flaggedDeliveries = allTodayDeliveries.filter(d => d?.isNextDelivery === true);
      for (const delivery of flaggedDeliveries) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }

      if (previousStatus === 'on_break') {
        console.log(`🔄 [setDriverStatus] Driver returning from break - finding closest delivery (non-pending only, respecting time windows)`);

        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();
        const currentTimeInMinutes = currentHours * 60 + currentMinutes;

        const isWithinTimeWindow = (delivery) => {
          if (!delivery.delivery_time_start && !delivery.delivery_time_end) {
            return true;
          }

          let windowEndMinutes = 24 * 60;
          if (delivery.delivery_time_end) {
            const [hours, mins] = delivery.delivery_time_end.split(':').map(Number);
            windowEndMinutes = (hours || 0) * 60 + (mins || 0);
          }

          return currentTimeInMinutes <= windowEndMinutes;
        };

        const incompleteDeliveries = allTodayDeliveries.filter(d =>
          !finishedStatuses.includes(d.status) &&
          d.status !== 'pending' &&
          isWithinTimeWindow(d)
        );

        console.log(`📦 [setDriverStatus] Filtered to ${incompleteDeliveries.length} eligible deliveries (non-pending, within time windows)`);

        if (incompleteDeliveries.length > 0) {
          const driverLat = appUser.current_latitude;
          const driverLng = appUser.current_longitude;

          if (driverLat && driverLng) {
            let bestDelivery = null;
            let bestETADifference = Infinity;

            console.log(`🔍 [setDriverStatus] Evaluating ${incompleteDeliveries.length} stops for optimal time-window match...`);

            for (const delivery of incompleteDeliveries) {
              let deliveryLat, deliveryLng;

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

              const R = 6371;
              const dLat = (deliveryLat - driverLat) * Math.PI / 180;
              const dLng = (deliveryLng - driverLng) * Math.PI / 180;
              const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                        Math.cos(driverLat * Math.PI / 180) * Math.cos(deliveryLat * Math.PI / 180) *
                        Math.sin(dLng/2) * Math.sin(dLng/2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
              const distanceKm = R * c;
              const travelTimeMinutes = (distanceKm / 25) * 60;
              const driverETA = currentHours * 60 + currentMinutes + travelTimeMinutes;

              let windowStartMinutes = currentHours * 60 + currentMinutes;
              if (delivery.delivery_time_start) {
                const [hours, mins] = delivery.delivery_time_start.split(':').map(Number);
                windowStartMinutes = (hours || 0) * 60 + (mins || 0);
              }

              const etaDifference = Math.abs(driverETA - windowStartMinutes);

              console.log(`  Stop: ${delivery.patient_name || 'Pickup'} | Distance: ${distanceKm.toFixed(1)}km | ETA: ${Math.floor(driverETA/60)}:${String(Math.floor(driverETA%60)).padStart(2,'0')} | TimeStart: ${delivery.delivery_time_start || 'none'} | Diff: ${etaDifference.toFixed(0)}min`);

              if (etaDifference < bestETADifference) {
                bestETADifference = etaDifference;
                bestDelivery = delivery;
              }
            }

            if (bestDelivery) {
              console.log(`🎯 [setDriverStatus] Selected: ${bestDelivery.patient_name || 'Pickup'} (ETA matches time window by ${bestETADifference.toFixed(0)} min)`);
              await base44.asServiceRole.entities.Delivery.update(bestDelivery.id, { isNextDelivery: true }).catch((error) => {
                if (isNotFoundError(error)) return null;
                throw error;
              });
              console.log(`✅ [setDriverStatus] Delivery marked as next - ready for driver to start`);
            } else {
              console.log(`⚠️ [setDriverStatus] Could not evaluate stops with coordinates`);
            }
          } else {
            const nextDelivery = incompleteDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
            if (nextDelivery) {
              console.log(`📍 [setDriverStatus] No driver location - using first stop by order: ${nextDelivery.patient_name || 'Pickup'}`);
              await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true }).catch((error) => {
                if (isNotFoundError(error)) return null;
                throw error;
              });
            }
          }
        } else {
          console.log(`ℹ️ [setDriverStatus] No incomplete deliveries to mark as next`);
        }
      } else {
        console.log(`🔄 [setDriverStatus] Driver going on duty from ${previousStatus || 'unknown'} - using next stop by stop order`);
        const nextDelivery = allTodayDeliveries
          .filter(d => !finishedStatuses.includes(d.status) && d.status !== 'pending')
          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];

        if (nextDelivery) {
          await base44.asServiceRole.entities.Delivery.update(nextDelivery.id, { isNextDelivery: true });
          console.log(`✅ [setDriverStatus] Next stop by order marked as next: ${nextDelivery.patient_name || 'Pickup'}`);
        } else {
          console.log(`ℹ️ [setDriverStatus] No active deliveries available to mark as next`);
        }
      }
    }
    
    // When going off_duty, clear isNextDelivery flags
    if (newStatus === 'off_duty') {
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags`);
      
      const today = getEdmDate();
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: user.id,
        delivery_date: today
      });
      
      const deliveriesWithNextFlag = allTodayDeliveries.filter(d => d.isNextDelivery === true);
      
      for (const delivery of deliveriesWithNextFlag) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
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