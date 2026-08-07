import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

// Detects a "naive" local timestamp string with NO timezone info (no trailing
// Z, no +HH:MM/-HH:MM offset) — e.g. "2026-08-06T13:40:00". Delivery.actual_delivery_time
// and anchorTime values built by generateCompletionTimestamp() on the client are
// ALWAYS in this naive format, representing Edmonton wall-clock time.
const isNaiveTimestamp = (str) => {
  if (typeof str !== 'string') return false;
  return !/Z$/i.test(str) && !/[+-]\d{2}:\d{2}$/.test(str);
};

// Converts a naive "YYYY-MM-DDTHH:MM:SS" string that represents America/Edmonton
// wall-clock time into a true UTC ISO instant.
//
// ROOT CAUSE THIS FIXES: this backend function runs on a UTC server. new Date()
// on a naive string with no timezone suffix parses it as UTC (per the JS spec's
// "date-time string without offset" rule for the runtime's local zone, which on
// this server IS UTC) — NOT as Edmonton local time. That silently shifted every
// activity-segment boundary derived from a naive timestamp (client anchorTime,
// or a DB actual_delivery_time fallback) by Edmonton's UTC offset (6h MDT / 7h
// MST) into the past, corrupting on-duty segment durations.
//
// Uses a 2-pass Intl.DateTimeFormat convergence so it's correct even for
// timestamps that fall near a DST transition.
const edmontonNaiveToUTCISOString = (naiveStr) => {
  const match = String(naiveStr).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return new Date(naiveStr).toISOString();
  const y = Number(match[1]), mo = Number(match[2]), d = Number(match[3]);
  const h = Number(match[4]), mi = Number(match[5]), s = Number(match[6]);
  const targetMs = Date.UTC(y, mo - 1, d, h, mi, s); // naive components read as if UTC

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  let guessMs = targetMs;
  for (let i = 0; i < 2; i++) {
    const parts = dtf.formatToParts(new Date(guessMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    let edmH = get('hour'); if (edmH === 24) edmH = 0;
    const edmProjectedMs = Date.UTC(get('year'), get('month') - 1, get('day'), edmH, get('minute'), get('second'));
    const offsetMs = guessMs - edmProjectedMs; // how far ahead UTC is vs Edmonton at this instant
    guessMs = targetMs + offsetMs;
  }
  return new Date(guessMs).toISOString();
};

// Normalizes any timestamp that MIGHT be a naive Edmonton-local string into a
// real UTC ISO string. Already-correct 'Z'/offset timestamps pass through untouched.
const normalizeToUTC = (timestamp) => {
  if (!timestamp) return timestamp;
  return isNaiveTimestamp(timestamp) ? edmontonNaiveToUTCISOString(timestamp) : timestamp;
};

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
 * on_duty          → round DOWN (floor) to previous 5-min mark
 * off_duty / on_break → round UP (ceil) to next 5-min mark
 */
const roundTo5Min = (isoTimestamp, direction) => {
  const d = new Date(isoTimestamp);
  const ms = d.getTime();
  const fiveMin = 5 * 60 * 1000;
  let rounded;
  if (direction === 'floor') {
    rounded = Math.floor(ms / fiveMin) * fiveMin;
  } else {
    // If already exactly on a 5-min mark, don't round up
    if (ms % fiveMin === 0) {
      rounded = ms;
    } else {
      rounded = Math.ceil(ms / fiveMin) * fiveMin;
    }
  }
  return new Date(rounded).toISOString();
};

/**
 * Record a DriverDailyActivity segment for a status transition.
 *
 * SINGLE SOURCE OF TRUTH: This backend function is the ONLY place that records
 * DriverDailyActivity segments. Client-side liveDistanceTracker.updateDriverStatus
 * must NOT write segments — it only updates internal state for distance tracking.
 *
 * on_duty → open a new segment (close any dangling open segment first)
 * on_break / off_duty → close the open segment with a tot
 *
 * Rounding rules:
 *   on_duty  → floor (previous 5-min mark)
 *   on_break → ceil (next 5-min mark)
 *   off_duty → ceil (next 5-min mark)
 *
 * anchorTime: optional ISO timestamp to use instead of "now" for the segment boundary.
 *   - off_duty: should be the actual_delivery_time of the last completed stop
 *   - on_duty (first of day): should be the actual_delivery_time of the first completed stop
 */
const recordActivitySegment = async (base44, driverId, driverName, newStatus, previousStatus, anchorTime = null) => {
  try {
    const todayStr = getEdmDate();
    const rawNow = anchorTime ? normalizeToUTC(anchorTime) : new Date().toISOString();

    // Round segment boundary to nearest 5-minute mark per direction rule:
    //   on_duty  → floor (previous 5-min mark)
    //   on_break → ceil  (next 5-min mark)
    //   off_duty → ceil  (next 5-min mark)
    const roundDirection = (newStatus === 'off_duty' || newStatus === 'on_break') ? 'ceil' : 'floor';
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

    const openIdx = segments.findIndex(s => s.start_time && !s.end_time);

    if (newStatus === 'on_duty') {
      if (previousStatus === 'on_duty' && openIdx !== -1) {
        // Already on duty with an open segment — NO-OP. A redundant setDriverStatus('on_duty')
        // (e.g. from ensureDriverOnline using stale React state) must NOT close and reopen
        // the activity segment. This was the root cause of segments being closed at the
        // exact timestamp of a pickup completion and a new one opened simultaneously.
        console.log(`⏱️ [setDriverStatus] Already on_duty with open segment — no segment change for ${driverId}`);
      } else {
        // DEFENSIVE: Open a new segment when transitioning to on_duty AND there is
        // no currently open segment. If there IS an open segment (crash recovery /
        // returning from on_break where the close didn't propagate), close it first.
        if (openIdx !== -1) {
          const startMs = new Date(segments[openIdx].start_time).getTime();
          segments[openIdx] = { ...segments[openIdx], end_time: now, tot: Math.max(0, Math.round((nowMs - startMs) / 60000)) };
          console.log(`⏱️ [setDriverStatus] Closed dangling open segment before opening new one for ${driverId}`);
        }
        segments.push({ start_time: now, end_time: null, tot: null });
        await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
        console.log(`⏱️ [setDriverStatus] Activity segment opened for ${driverId} (start: ${now}, previousStatus: ${previousStatus})`);
      }

    } else if (newStatus === 'on_break' || newStatus === 'off_duty') {
      // Close the open segment. Guard: require previousStatus === 'on_duty' OR an open segment exists.
      // This prevents double-close if the driver is already on_break/off_duty.
      if (openIdx !== -1) {
        const startMs = new Date(segments[openIdx].start_time).getTime();
        const tot = Math.max(0, Math.round((nowMs - startMs) / 60000));
        segments[openIdx] = { ...segments[openIdx], end_time: now, tot };
        await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
        console.log(`⏸️ [setDriverStatus] Activity segment closed — ${tot} min for ${driverId} (end: ${now}, newStatus: ${newStatus})`);
      } else {
        console.log(`ℹ️ [setDriverStatus] No open segment to close for ${newStatus} (previousStatus: ${previousStatus})`);
      }
    } else {
      console.log(`ℹ️ [setDriverStatus] No segment action for ${newStatus} (previousStatus: ${previousStatus})`);
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

    const { newStatus, deviceId, selectedDate, targetUserId, previousStatus: clientPreviousStatus, anchorTime: clientAnchorTime } = await req.json();

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
    // CRITICAL: The frontend (DriverStatusToggle) may have ALREADY written the new
    // driver_status to the AppUser record via base44.entities.AppUser.update() before
    // calling this backend function. In that case, reading driver_status from the DB
    // would return the NEW status (not the actual previous status), causing
    // recordActivitySegment to miss the transition entirely (e.g., previousStatus
    // would be 'on_break' instead of 'on_duty' when going on break — the segment
    // close condition `previousStatus === 'on_duty'` would fail silently).
    // The frontend passes the true previous status; fall back to the DB value only
    // if the client didn't provide it (e.g., stop card actions path).
    const previousStatus = clientPreviousStatus || appUser.driver_status;
    console.log(`📱 [setDriverStatus] Found AppUser: ${appUser.id}, previous status: ${previousStatus} (source: ${clientPreviousStatus ? 'client' : 'db'})`);

    const updateData = {
      driver_status: newStatus
    };

    if (newStatus === 'on_duty' || newStatus === 'on_break') {
      updateData.location_tracking_enabled = true;
      updateData.location_updated_at = new Date().toISOString();
      console.log(`📍 [setDriverStatus] Updating location timestamp for status change to: ${newStatus}`);
    }

    if (newStatus === 'off_duty') {
      // Only disable location_tracking_enabled — do NOT null coordinates.
      // Other users are already gated by location_tracking_enabled + driver_status
      // checks in shouldShowMarker(). The driver themselves should still see their
      // own last known location marker on their devices.
      updateData.location_tracking_enabled = false;
      console.log('📍 [setDriverStatus] Disabling location sharing (coords preserved) for off duty');
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
    // - off_duty: prefer clientAnchorTime (passed from completion flow with the exact
    //   actual_delivery_time). Fall back to DB query only if not provided — the DB
    //   query is unreliable because the completing delivery's actual_delivery_time
    //   may not be committed yet when setDriverStatus fires.
    // - on_duty (first segment of the day): use actual_delivery_time of the first completed stop
    // - all other cases: use current time
    let activityAnchorTime = null;
    const targetDate = selectedDate || getEdmDate();

    if (newStatus === 'off_duty' && previousStatus === 'on_duty') {
      if (clientAnchorTime) {
        // Client passed the exact completion time — use it directly (most accurate)
        activityAnchorTime = clientAnchorTime;
        console.log(`⏱️ [setDriverStatus] Using client-provided anchorTime for off_duty: ${activityAnchorTime}`);
      } else {
        // Fallback: query DB for last completed delivery time
        // (less reliable — the just-completed delivery may not be written yet)
        const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
          driver_id: subjectUserId,
          delivery_date: targetDate
        }).catch(() => []);
        const completed = todayDeliveries
          .filter((d) => d?.actual_delivery_time && !d.is_cycling_marker)
          .sort((a, b) => new Date(b.actual_delivery_time).getTime() - new Date(a.actual_delivery_time).getTime());
        if (completed.length > 0) {
          activityAnchorTime = completed[0].actual_delivery_time;
          console.log(`⏱️ [setDriverStatus] Using last delivery time as off_duty anchor (DB fallback): ${activityAnchorTime}`);
        }
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
          // Sanity check must compare the CORRECTLY-interpreted (Edmonton-local ->
          // UTC) instant against real current time — comparing the naive string
          // directly against Date.now() misreads it as UTC and always looks
          // artificially far in the past, defeating the "in the past" guard.
          if (normalizeToUTC(firstDeliveryTime) && new Date(normalizeToUTC(firstDeliveryTime)).getTime() < Date.now()) {
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
      appUserId: appUser.id,
      data: updatedAppUser
    });

  } catch (error) {
    console.error('❌ [setDriverStatus] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
