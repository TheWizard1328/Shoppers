import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
// OWNER DIRECTIVE (Nov 1 2026): Alberta did NOT go permanent UTC-6 — the Nov 1
// fall-back happened normally and the normal DST cycle continues. Activity
// segments are now stored as NAIVE Edmonton wall-clock strings
// ("YYYY-MM-DDTHH:mm", no Z, no offset) and never converted, so an edit can
// never compound a +1h shift. The offset is only ever asked from the tz
// database (Intl + America/Edmonton) inside the shared helper.
import {
  edmontonTodayKey,
  edmontonWallString,
  roundWallTo5Min,
  utcMsOf,
  wallMinutesBetween,
  wallStringOf,
} from '../../shared/albertaWall.ts';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

// Wall-clock conversions, segment rounding and "what day is it in Edmonton" all
// live in base44/shared/albertaWall.ts — one Intl-backed implementation shared
// with squareBalancesCompute and dashboardWeatherPoll. No offset is hardcoded
// anywhere in this function any more.

// Rounding to the 5-minute mark now happens on the WALL clock (roundWallTo5Min):
// on_duty → floor (previous mark), on_break/off_duty → ceil (next mark), seconds
// ignored and an exact 5-minute mark left alone (owner rule Oct 29 2026).

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
// Merges activity_segments from every duplicate DriverDailyActivity record for the
// same driver_id+activity_date into ONE surviving record (the oldest by created_date),
// deleting the rest. Segments are deduped by identical start_time+end_time and sorted
// chronologically. Self-heals duplicates created by the historical race below every
// time this function touches that driver's day, so the admin Timeline/Cards view
// converges back to a single row within one status-change cycle.
const mergeDuplicateActivityRecords = async (base44, records) => {
  const sorted = [...records].sort((a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime());
  const survivor = sorted[0];
  const dupes = sorted.slice(1);

  const seen = new Set();
  const mergedSegments = [];
  sorted.forEach((rec) => {
    (Array.isArray(rec.activity_segments) ? rec.activity_segments : []).forEach((seg) => {
      const key = `${seg?.start_time || ''}|${seg?.end_time || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      mergedSegments.push(seg);
    });
  });
  // Sort on the wall-clock keys so a mix of legacy ISO-Z rows and new naive rows
  // still orders chronologically.
  mergedSegments.sort((a, b) => String(wallStringOf(a.start_time) || '').localeCompare(String(wallStringOf(b.start_time) || '')));

  await base44.asServiceRole.entities.DriverDailyActivity.update(survivor.id, { activity_segments: mergedSegments }).catch(() => {});
  for (const dupe of dupes) {
    await base44.asServiceRole.entities.DriverDailyActivity.delete(dupe.id).catch((err) => {
      console.warn(`⚠️ [setDriverStatus] Failed to delete duplicate DriverDailyActivity ${dupe.id}:`, err?.message || err);
    });
  }
  console.log(`🩹 [setDriverStatus] Merged ${records.length} duplicate DriverDailyActivity records into ${survivor.id} for driver ${survivor.driver_id} (${dupes.length} deleted)`);
  return { ...survivor, activity_segments: mergedSegments };
};

// Get-or-create is NOT atomic on this platform (no compound-unique-index / upsert
// primitive exposed) — a filter-then-create can race when setDriverStatus is invoked
// twice in close succession for the same driver+day. This happens in practice because
// multiple independent call sites fire newStatus:'on_duty' redundantly without
// coordination (DriverStatusToggle's manual toggle, useStopCardActions.ensureDriverOnline
// firing on nearly every stop-card action by design, and queued offline mutations
// replaying in a burst on reconnect). Two concurrent invocations can both see zero
// matching records and both create — producing two DriverDailyActivity rows for the
// same driver_id+activity_date, each with its own orphaned open segment (visible as
// duplicate driver rows in the admin Timeline/Cards view).
//
// Mitigated with self-healing (merge existing dupes on every read) plus a
// create-then-reconcile double-check (re-query immediately after create; if a
// concurrent request won the race, merge down to one record instead of leaving two).
const getOrCreateDailyActivityRecord = async (base44, driverId, driverName, todayStr) => {
  let existing = await base44.asServiceRole.entities.DriverDailyActivity.filter({
    driver_id: driverId,
    activity_date: todayStr
  }).catch(() => []);

  if (existing.length > 1) {
    return await mergeDuplicateActivityRecords(base44, existing);
  }
  if (existing.length === 1) {
    return existing[0];
  }

  const created = await base44.asServiceRole.entities.DriverDailyActivity.create({
    driver_id: driverId,
    driver_name: driverName || '',
    activity_date: todayStr,
    activity_segments: []
  });

  // Race check: did a concurrent invocation ALSO create a record for this driver+day
  // in the window between our filter() and our create() above?
  const recheck = await base44.asServiceRole.entities.DriverDailyActivity.filter({
    driver_id: driverId,
    activity_date: todayStr
  }).catch(() => [created]);

  if (recheck.length > 1) {
    return await mergeDuplicateActivityRecords(base44, recheck);
  }
  return created;
};

const recordActivitySegment = async (base44, requestClient, driverId, driverName, newStatus, previousStatus, anchorTime = null) => {
  // OWNER REPORT (Oct 30 2026 15:11): duty-time values disagreed between devices
  // (2 minutes apart until something refreshed them). Root cause: the activity
  // record is written with asServiceRole, and a service-role write does NOT
  // broadcast a WebSocket event — so every other device kept its old segments
  // until a lazy pull, and a break boundary landed minutes later on the tablet
  // than on the phone. The record is now returned to the caller AND re-written
  // with the REQUEST-SCOPED client (best-effort) so the platform broadcasts it
  // to every connected device the moment it changes.
  let lastSavedActivity = null;
  try {
    const todayStr = edmontonTodayKey();
    // Anchor (a naive actual_delivery_time) passes through verbatim; anything
    // else becomes Edmonton wall clock from "now". No offset math.
    const rawNow = anchorTime ? wallStringOf(anchorTime) : edmontonWallString();

    // Round segment boundary to nearest 5-minute mark per direction rule:
    //   on_duty  → floor (previous 5-min mark)
    //   on_break → ceil  (next 5-min mark)
    //   off_duty → ceil  (next 5-min mark)
    const roundDirection = (newStatus === 'off_duty' || newStatus === 'on_break') ? 'ceil' : 'floor';
    const now = roundWallTo5Min(rawNow, roundDirection);

    const record = await getOrCreateDailyActivityRecord(base44, driverId, driverName, todayStr);

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
          const tot = Math.max(0, wallMinutesBetween(segments[openIdx].start_time, now) ?? 0);
          segments[openIdx] = { ...segments[openIdx], end_time: now, tot };
          console.log(`⏱️ [setDriverStatus] Closed dangling open segment before opening new one for ${driverId}`);
        }
        segments.push({ start_time: now, end_time: null, tot: null });
        const savedOpen = await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
        lastSavedActivity = savedOpen || { ...record, activity_segments: segments };
        console.log(`⏱️ [setDriverStatus] Activity segment opened for ${driverId} (start: ${now}, previousStatus: ${previousStatus})`);
      }

    } else if (newStatus === 'on_break' || newStatus === 'off_duty') {
      // Close the open segment. Guard: require previousStatus === 'on_duty' OR an open segment exists.
      // This prevents double-close if the driver is already on_break/off_duty.
      if (openIdx !== -1) {
        const tot = Math.max(0, wallMinutesBetween(segments[openIdx].start_time, now) ?? 0);
        segments[openIdx] = { ...segments[openIdx], end_time: now, tot };
        const savedClose = await base44.asServiceRole.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
        lastSavedActivity = savedClose || { ...record, activity_segments: segments };
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

  // Broadcast the authoritative record (request-scoped write = realtime event).
  // Best effort: RLS may reject a dispatcher writing another driver's record,
  // in which case devices still converge through their normal pulls.
  if (lastSavedActivity?.id) {
    try {
      await requestClient?.entities?.DriverDailyActivity?.update(lastSavedActivity.id, {
        activity_segments: lastSavedActivity.activity_segments,
      });
    } catch (err) {
      console.warn('⚠️ [setDriverStatus] activity broadcast write skipped:', err?.message || err);
    }
  }
  return lastSavedActivity;
};

// ── Transient-failure resilience (owner report Nov 6 2026) ────────────────────
// Twice in one day an on_break -> on_duty toggle produced a 500 and NO
// DriverDailyActivity segment: the status transition landed in the middle of a
// 429 storm, AppUser.update threw, and the whole function aborted BEFORE the
// payroll-critical segment was written. The client then retried a few times,
// abandoned the mutation and the driver had to fix his own duty time by hand.
// Every write below now retries transient failures and the activity segment is
// recorded BEFORE the cosmetic status write, so a rate limit can no longer cost
// a driver his duty-time record.
const isTransientStatusError = (error) => {
  const status = Number(error?.status || error?.response?.status || 0);
  const msg = String(error?.message || error || '');
  return status === 429 || status === 502 || status === 503 || status === 504
    || status >= 500 || /rate limit|timeout|network error/i.test(msg);
};

const withTransientRetry = async (fn, label = 'write', attempts = 4) => {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientStatusError(error) || i === attempts) break;
      const delay = 700 * i + Math.floor(Math.random() * 400);
      console.warn(`⏳ [setDriverStatus] ${label} transient failure (attempt ${i}/${attempts}) — retrying in ${delay}ms:`, error?.message || error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
};

const clearNextDeliveryFlags = async (base44, driverId, deliveryDate) => {
  const deliveries = await base44.asServiceRole.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: deliveryDate
  });

  const flaggedDeliveries = deliveries.filter((delivery) => delivery?.isNextDelivery === true);

  for (const delivery of flaggedDeliveries) {
    // A rate limit here must NEVER fail the duty transition (the flag converges
    // through the next pull / WS echo) — the Nov 6 500s came from this throw.
    await withTransientRetry(
      () => base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }),
      `clear isNextDelivery ${delivery.id}`,
      2
    ).catch((error) => {
      if (isNotFoundError(error)) return null;
      console.warn(`⚠️ [setDriverStatus] isNextDelivery clear skipped for ${delivery.id}:`, error?.message || error);
      return null;
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

    // Determine anchor time for activity segment boundaries:
    // - off_duty: prefer clientAnchorTime (passed from completion flow with the exact
    //   actual_delivery_time). Fall back to DB query only if not provided — the DB
    //   query is unreliable because the completing delivery's actual_delivery_time
    //   may not be committed yet when setDriverStatus fires.
    // - on_duty (first segment of the day): use actual_delivery_time of the first completed stop
    // - all other cases: use current time
    let activityAnchorTime = null;
    const targetDate = selectedDate || edmontonTodayKey();

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
      // Check ALL matching records, not just [0] — duplicate rows from the historical
      // race (see recordActivitySegment/getOrCreateDailyActivityRecord) can put real
      // segments on a record that isn't the first one returned by filter().
      const hasExistingSegments = (existingActivity || []).some((rec) => (rec?.activity_segments?.length || 0) > 0);
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
          const firstDeliveryUtcMs = utcMsOf(firstDeliveryTime);
          if (firstDeliveryUtcMs != null && firstDeliveryUtcMs < Date.now()) {
            activityAnchorTime = firstDeliveryTime;
            console.log(`⏱️ [setDriverStatus] Using first delivery time as on_duty anchor: ${activityAnchorTime}`);
          }
        }
      }
    }

    // ── 1) PAYROLL-CRITICAL FIRST: record the DriverDailyActivity segment ──────
    // Ordering matters: if the status write below is rate-limited, the driver's
    // duty-time record must already be safe.
    const dailyActivityRecord = await recordActivitySegment(base44, base44, subjectUserId, appUser.user_name || '', newStatus, previousStatus, activityAnchorTime);

    // ── 2) Then the AppUser status flag (cosmetic for payroll; the toggling
    // device already wrote it locally and re-broadcasts on the next sync) ──────
    let updatedAppUser = null;
    try {
      updatedAppUser = await withTransientRetry(
        () => base44.asServiceRole.entities.AppUser.update(appUser.id, updateData),
        'AppUser status update'
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return Response.json({ success: true, skipped: true, reason: 'app_user_not_found_during_update' });
      }
      console.warn('⚠️ [setDriverStatus] AppUser status write failed after retries — activity segment already saved:', error?.message || error);
    }
    
    console.log(`✅ [setDriverStatus] Status set to: ${newStatus}`);
    console.log(`📍 [setDriverStatus] Location tracking enabled: ${newStatus === 'on_duty'}`);
    
    // CRITICAL: Broadcast the change to all connected clients immediately
    console.log(`📡 [setDriverStatus] Broadcasting driver status change to all clients...`);

    // When going on_break, clear all next-stop flags for the selected driver/date
    if (newStatus === 'on_break') {
      const targetDate = selectedDate || edmontonTodayKey();
      console.log(`🔄 [setDriverStatus] Driver going on break - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, subjectUserId, targetDate);
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${clearedCount} deliveries for ${targetDate}`);
    }
    
    // When coming back on_duty (from on_break OR off_duty), restore isNextDelivery.
    //
    // OWNER REPORT (Oct 30 2026 14:48): "when a driver returns from a break back
    // to on duty it is not setting the is next delivery flag to the next stop…
    // requiring the driver to hit the start button and costing API hits to the
    // Google and HERE APIs." Root cause: this block called setNextDeliveryFlag
    // through base44.functions.invoke(), and a backend→backend invoke does NOT
    // carry the caller's auth context, so the gateway rejected it with 401/403
    // before its code ran. The flag was therefore never re-established — going on
    // break clears every flag (clearNextDeliveryFlags below), so the driver came
    // back to a route with NO next stop and had to press Start, which runs the
    // whole optimizer (HERE + Google) just to re-flag one stop.
    //
    // The resolution is now INLINE and self-contained (no cross-function hop, no
    // optimizer, no routing API calls): active stops (in_transit/en_route/arrived,
    // cycling markers included) by stop_order, else pending stops by stop_order.
    // Only records whose flag actually changes are written.
    if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      const targetDate = selectedDate || edmontonTodayKey();
      const FINISHED = new Set(['completed', 'failed', 'cancelled']);
      const ACTIVE = new Set(['in_transit', 'en_route', 'arrived']);
      const byOrder = (a, b) => {
        const diff = Number(a?.stop_order || 0) - Number(b?.stop_order || 0);
        return diff !== 0 ? diff : String(a?.id || '').localeCompare(String(b?.id || ''));
      };

      const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: subjectUserId,
        delivery_date: targetDate
      }, 'stop_order', 5000);

      const activeStops = routeDeliveries
        .filter((d) => d && !FINISHED.has(d.status) && (ACTIVE.has(d.status) || d.is_cycling_marker === true))
        .sort(byOrder);
      const pendingStops = routeDeliveries
        .filter((d) => d && d.status === 'pending' && !d.is_cycling_marker)
        .sort(byOrder);

      const nextStop = activeStops[0] || pendingStops[0] || null;
      console.log(`📦 [setDriverStatus] On-duty restore: ${routeDeliveries.length} stops, next=${nextStop?.id || 'none'} (order ${nextStop?.stop_order ?? '-'})`);

      if (nextStop) {
        const flagWrites = routeDeliveries
          .filter((d) => !!d?.isNextDelivery !== (d.id === nextStop.id))
          .map((d) => ({ id: d.id, isNextDelivery: d.id === nextStop.id }));
        for (const write of flagWrites) {
          try {
            await base44.asServiceRole.entities.Delivery.update(write.id, { isNextDelivery: write.isNextDelivery });
          } catch (error) {
            if (!isNotFoundError(error)) {
              console.warn(`⚠️ [setDriverStatus] isNextDelivery write failed for ${write.id}:`, error?.message || error);
            }
          }
        }
        console.log(`🔄 [setDriverStatus] isNextDelivery restored on ${nextStop.id} (${flagWrites.length} record(s) changed)`);
      } else {
        console.log('ℹ️ [setDriverStatus] No incomplete stops left — no next-delivery flag to restore');
      }

      // NOTE: the polyline is NOT regenerated here. The legacy
      // regenerateType1Polyline function was deleted when polyline generation
      // moved client-side (routeOptimizationCoordinator / routePolylineGenerator);
      // invoking it just burned a failed call on every on-duty transition. The
      // existing legs are already correct — returning from a break does not
      // change the route.

      console.log(`📡 [setDriverStatus] Broadcast driver status change to on_duty complete`);
    }

    // When going off_duty, clear all next-stop flags for the selected driver/date
    if (newStatus === 'off_duty') {
      const targetDate = selectedDate || edmontonTodayKey();
      console.log(`🔄 [setDriverStatus] Driver going off duty - clearing all isNextDelivery flags for ${targetDate}`);
      const clearedCount = await clearNextDeliveryFlags(base44, subjectUserId, targetDate);
      console.log(`✅ [setDriverStatus] Cleared isNextDelivery on ${clearedCount} deliveries for ${targetDate}`);
    }

    return Response.json({
      success: true,
      newStatus,
      appUserId: appUser.id,
      // Authoritative DriverDailyActivity row so the toggling device can adopt it
      // immediately instead of waiting for a pull (duty-time parity across devices).
      dailyActivity: dailyActivityRecord || null,
      data: updatedAppUser
    });

  } catch (error) {
    console.error('❌ [setDriverStatus] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});