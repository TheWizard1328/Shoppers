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

/**
 * Round an ISO timestamp to the nearest 5-minute mark.
 * on_duty / on_break → round DOWN (floor) to previous 5-min mark
 * off_duty           → round UP (ceil) to next 5-min mark
 */
const roundTo5Min = (isoTimestamp, direction) => {
  const d = new Date(isoTimestamp);
  const ms = d.getTime();
  const fiveMin = 5 * 60 * 1000;
  let rounded;
  if (direction === 'floor') {
    rounded = Math.floor(ms / fiveMin) * fiveMin;
  } else {
    rounded = Math.ceil(ms / fiveMin) * fiveMin;
  }
  return new Date(rounded).toISOString();
};

/**
 * Record a DriverDailyActivity segment for a status transition.
 * on_duty → open a new segment (close any dangling open segment first)
 * on_break / off_duty → close the open segment with a tot
 *
 * anchorTime: optional ISO timestamp to use instead of "now" for the segment boundary.
 *   - off_duty: should be the actual_delivery_time of the last completed stop
 *   - on_duty (first of day): should be the actual_delivery_time of the first completed stop
 */
const recordActivitySegment = async (base44, driverId, driverName, newStatus, previousStatus, anchorTime = null) => {
  try {
    const todayStr = getEdmDate();
    const rawNow = anchorTime || new Date().toISOString();

    // Round segment boundary to nearest 5-minute mark per direction rule:
    //   on_duty / on_break → floor (previous 5-min mark)
    //   off_duty           → ceil  (next 5-min mark)
    const roundDirection = newStatus === 'off_duty' ? 'ceil' : 'floor';
    const now = roundTo5Min(rawNow, roundDirection);
    const nowMs = new Date(now).getTime();

    const existing = await base44.asServiceRole.entities.DriverDailyActivity.filter({
      driver_id: driverId,
      activity_date: todayStr
    }).catch(() => []);

    let record = existing?.[0] || null;

    if (!record) {
      record = await base44.asServiceRole.entities.DriverDailyActivity.create({
        driver_id: driverId,
        driver_name: driverName || '',
        activity_date: todayStr,
        activity_segments: []
      });
    }

    const segments = Array.isArray(record.activity_segments) ? [...record.activity_segments] : [];

    if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      // Close any dangling open segment (crash recovery)
      const openIdx = segments.findIndex(s => s.start_time && !s.end_time);
      if (openIdx !== -1) {
        const startMs = new Date(segments[openIdx].start_time).getTime();
        segments[openIdx] = { ...segments[openIdx], end_time: now, tot: Math.max(0, Math.round((nowMs - startMs) / 60000)) };
      }
      segments.push({ start_time: now, end_time: null, tot: null });
      await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
      console.log(`⏱️ [setDriverStatus] Activity segment opened for ${driverId}`);

    } else if ((newStatus === 'on_break' || newStatus === 'off_duty') && previousStatus === 'on_duty') {
      const openIdx = segments.findIndex(s => s.start_time && !s.end_time);
      if (openIdx !== -1) {
        const startMs = new Date(segments[openIdx].start_time).getTime();
        const tot = Math.max(0, Math.round((nowMs - startMs) / 60000));
        segments[openIdx] = { ...segments[openIdx], end_time: now, tot };
        await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
        console.log(`⏸️ [setDriverStatus] Activity segment closed — ${tot} min for ${driverId}`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [setDriverStatus] recordActivitySegment failed (non-critical):', err?.message || err);
  }
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

    const { newStatus, deviceId, selectedDate, targetUserId } = await req.json();

    if (!newStatus) {
      return Response.json({ error: 'Missing required field: newStatus' }, { status: 400 });
    }

    // Admins can pass targetUserId to update another driver's status
    const subjectUserId = targetUserId || user.id;
    console.log(`🔄 [setDriverStatus] User ${user.email} changing status to: ${newStatus} for userId: ${subjectUserId}`);

    // Find the AppUser record for this user (one per user, not per device)
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: subjectUserId });
    
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

    // Determine anchor time for activity segment boundaries:
    // - off_duty: use actual_delivery_time of the last completed stop (so TOT ends at last delivery, not clock time)
    // - on_duty (first segment of the day): use actual_delivery_time of the first completed stop if it predates now
    // - all other cases: use current time
    let activityAnchorTime = null;
    const targetDate = selectedDate || getEdmDate();

    if (newStatus === 'off_duty' && previousStatus === 'on_duty') {
      const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: subjectUserId,
        delivery_date: targetDate
      }).catch(() => []);
      const completed = todayDeliveries
        .filter((d) => d?.actual_delivery_time && !d.is_cycling_marker)
        .sort((a, b) => new Date(b.actual_delivery_time).getTime() - new Date(a.actual_delivery_time).getTime());
      if (completed.length > 0) {
        activityAnchorTime = completed[0].actual_delivery_time;
        console.log(`⏱️ [setDriverStatus] Using last delivery time as off_duty anchor: ${activityAnchorTime}`);
      }
    } else if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      // Only anchor to delivery time if there are no existing open segments (first on_duty of day)
      const existingActivity = await base44.asServiceRole.entities.DriverDailyActivity.filter({
        driver_id: subjectUserId,
        activity_date: targetDate
      }).catch(() => []);
      const hasExistingSegments = existingActivity?.[0]?.activity_segments?.length > 0;
      if (!hasExistingSegments) {
        const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
          driver_id: subjectUserId,
          delivery_date: targetDate
        }).catch(() => []);
        const completed = todayDeliveries
          .filter((d) => d?.actual_delivery_time && !d.is_cycling_marker)
          .sort((a, b) => new Date(a.actual_delivery_time).getTime() - new Date(b.actual_delivery_time).getTime());
        if (completed.length > 0) {
          const firstDeliveryTime = completed[0].actual_delivery_time;
          // Only use it if it's in the past (sanity check)
          if (new Date(firstDeliveryTime).getTime() < Date.now()) {
            activityAnchorTime = firstDeliveryTime;
            console.log(`⏱️ [setDriverStatus] Using first delivery time as on_duty anchor: ${activityAnchorTime}`);
          }
        }
      }
    }

    // Record DriverDailyActivity segment for this status transition
    await recordActivitySegment(base44, subjectUserId, appUser.user_name || '', newStatus, previousStatus, activityAnchorTime);
    
    console.log(`✅ [setDriverStatus] Status set to: ${newStatus}`);
    console.log(`📍 [setDriverStatus] Location tracking enabled: ${newStatus === 'on_duty'}`);
    
    // CRITICAL: Broadcast the change to all connected clients immediately
    console.log(`📡 [setDriverStatus] Broadcasting driver status change to all clients...`);

    // When going on_break, clear all next-stop flags for the selected driver/date
    if (newStatus === 'on_break') {
      const targetDate = selectedDate || getEdmDate();
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, subjectUserId, targetDate);
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${clearedCount} deliveries for ${targetDate}`);
    }
    
    // When coming back on_duty (from on_break OR off_duty), restore isNextDelivery and polyline.
    //
    // IMPORTANT: When a driver goes on_break, clearNextDeliveryFlags() wipes ALL isNextDelivery
    // flags. So when they return on_duty, flaggedDeliveries will be 0. We must call
    // setNextDeliveryFlag first to re-establish the correct next stop, THEN regenerate
    // the polyline so the route line appears correctly.
    if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      const targetDate = selectedDate || getEdmDate();
      const INCOMPLETE_STATUSES = new Set(['in_transit', 'en_route', 'arrived', 'pending']);
      const allTodayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: subjectUserId,
        delivery_date: targetDate
      }, 'stop_order');

      const flaggedDeliveries = allTodayDeliveries.filter((d) => d?.isNextDelivery === true);
      const incompleteDeliveries = allTodayDeliveries.filter((d) => d && INCOMPLETE_STATUSES.has(d.status) && !d.is_cycling_marker);
      console.log(`📦 [setDriverStatus] Found ${allTodayDeliveries.length} deliveries for ${targetDate}`);
      console.log(`📦 [setDriverStatus] Flagged: ${flaggedDeliveries.length}, Incomplete: ${incompleteDeliveries.length}`);

      // Always re-establish the isNextDelivery flag when going on_duty:
      // covers both returning from on_break (flags cleared) and first on_duty of the day (all pending).
      let resolvedFlagged = flaggedDeliveries;
      if (incompleteDeliveries.length > 0) {
        console.log(`🔄 [setDriverStatus] Calling setNextDeliveryFlag to establish next stop for on_duty`);
        await base44.asServiceRole.functions.invoke('setNextDeliveryFlag', {
          driverId: subjectUserId,
          deliveryDate: targetDate
        }).catch((error) => {
          console.warn('⚠️ [setDriverStatus] setNextDeliveryFlag failed on on_duty restore:', error?.message || error);
        });
        // Re-fetch to see what was flagged
        const refreshed = await base44.asServiceRole.entities.Delivery.filter({
          driver_id: subjectUserId,
          delivery_date: targetDate
        }, 'stop_order').catch(() => []);
        resolvedFlagged = refreshed.filter((d) => d?.isNextDelivery === true);
        console.log(`✅ [setDriverStatus] After setNextDeliveryFlag: ${resolvedFlagged.length} flagged`);
      }

      // Regenerate the current-leg polyline now that isNextDelivery is correctly set.
      // Use driver's current GPS if available, fall back to home coordinates.
      const originLat = updatedAppUser?.current_latitude ?? updatedAppUser?.home_latitude;
      const originLon = updatedAppUser?.current_longitude ?? updatedAppUser?.home_longitude;

      if (resolvedFlagged.length > 0 && originLat != null && originLon != null) {
        await base44.asServiceRole.functions.invoke('regenerateType1Polyline', {
          driverId: subjectUserId,
          deliveryDate: targetDate,
          currentLocation: { lat: originLat, lon: originLon },
          isPrimaryDevice: true,
          force: true,
          routeChangeSource: 'on_duty_restore'
        }).catch((error) => {
          console.warn('⚠️ [setDriverStatus] regenerateType1Polyline skipped on on_duty restore:', error?.message || error);
        });
      }
    }
    
    // When going off_duty, clear all next-stop flags for the selected driver/date
    if (newStatus === 'off_duty') {
      const targetDate = selectedDate || getEdmDate();
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, subjectUserId, targetDate);
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