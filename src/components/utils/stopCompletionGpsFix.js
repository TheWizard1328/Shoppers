/**
 * stopCompletionGpsFix — owner directive (Sep 24 2026).
 *
 * Problem: on the WEB PWA, Android Chrome suspends watchPosition while the app
 * is backgrounded. If a driver returns to the app just long enough to tap
 * "Complete" on a stop, the tracker has NOT re-acquired GPS yet — so the
 * AppUser location record (and the breadcrumb master trail) stays one or more
 * stops behind the driver's real position.
 *
 * Fix: whenever a driver finishes a stop (complete / fail / return), force a
 * FRESH GPS fix (maximumAge 0 — OS must acquire from the antenna, no cached
 * value) and write it through the tracker's own update path:
 *   1. AppUser DB: current_latitude / current_longitude / location_updated_at
 *      via updateLocationInDatabase(forceUpdate=true) — bypasses every throttle,
 *      keeps the primary-device gate, echo suppression and WS broadcast intact.
 *   2. Breadcrumbs: the same collectBreadcrumbForTracker the tracker ticks use —
 *      a stale-trail jump gets accepted and snaps the master trail forward;
 *      stationary dedup keeps it clean when the trail is already current.
 *
 * Always fire-and-forget — never blocks the ~37ms completion critical path.
 */
import { locationTracker } from './locationTracker';
import { collectBreadcrumbForTracker } from './locationBreadcrumbService';

export const recordStopCompletionGpsFix = async ({ currentUser, deliveryDate } = {}) => {
  try {
    // Only the delivery's own driver recording from their own device — an
    // admin completing remotely must not write THEIR location onto the
    // driver's record.
    if (!currentUser?.id || !locationTracker) return null;

    const pos = await locationTracker.getFreshPosition({
      timeout: 8000,
      maximumAge: 0,
      enableHighAccuracy: true,
    });
    if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) {
      console.warn('📍 [StopCompletionGpsFix] no GPS fix available — AppUser location left unchanged');
      return null;
    }

    // 1) AppUser location + timestamp (forceUpdate bypasses the 15s gate,
    //    background throttle and backoff; primary-device gate stays enforced
    //    inside updateLocationInDatabase).
    await locationTracker.updateLocationInDatabase(
      pos.latitude,
      pos.longitude,
      pos.accuracy || 0,
      true,
      false,
      locationTracker.isPrimaryDevice
    );

    // 2) Breadcrumb master trail point (collector enforces on_duty/on_break
    //    gate, Null-Island drop and stationary dedup internally).
    await collectBreadcrumbForTracker({
      driverStatus: locationTracker.driverStatus,
      appUserId: locationTracker.appUserId,
      currentUser,
      currentDeliveryDate: deliveryDate || null,
      latitude: pos.latitude,
      longitude: pos.longitude,
      timestamp: Date.now(),
    });

    console.log(`📍 [StopCompletionGpsFix] fix recorded: ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)} (±${Math.round(pos.accuracy || 0)}m)`);
    return pos;
  } catch (e) {
    console.warn('📍 [StopCompletionGpsFix] failed:', e?.message);
    return null;
  }
};
