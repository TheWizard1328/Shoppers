/**
 * Heartbeat Service
 *
 * For DISPATCHERS: sends a heartbeat every 5 minutes.
 *   - On each heartbeat, also checks if location_updated_at is stale (> 5 min).
 *     If stale → sets driver_status to 'off_duty' (offline).
 *     On a fresh heartbeat → restores driver_status to 'online'.
 *
 * For DRIVERS: heartbeat is handled by the location tracker (GPS updates act as heartbeats).
 *
 * Rules (used by monitorUserHeartbeat scheduled function):
 *   < 5 min  → online
 *   > 5 min  → off_duty (offline)
 */

import { base44 } from '@/api/base44Client';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 5 * 60 * 1000;    // 5 minutes — same threshold

let intervalId = null;
let currentAppUserId = null;
let isDispatcher = false;

const sendHeartbeat = async () => {
  if (!currentAppUserId) return;
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    if (isDispatcher) {
      // Fetch current record to check existing timestamp and status
      let existing = null;
      try {
        const results = await base44.entities.AppUser.filter({ id: currentAppUserId });
        existing = results?.[0] || null;
      } catch (_) { /* non-critical */ }

      const lastBeat = existing?.location_updated_at ? new Date(existing.location_updated_at) : null;
      const isStale = !lastBeat || (now - lastBeat) > STALE_THRESHOLD_MS;

      if (isStale && existing?.driver_status !== 'off_duty') {
        // Stale — mark offline
        await base44.entities.AppUser.update(currentAppUserId, {
          driver_status: 'off_duty',
        });
        console.log(`💤 [HeartbeatService] Dispatcher ${currentAppUserId} marked off_duty (stale heartbeat)`);
        return; // Don't update location_updated_at — we want it to remain stale until the user is active
      }

      // Active — send heartbeat and ensure status is 'online'
      const update = { location_updated_at: nowIso };
      if (existing?.driver_status !== 'online') {
        update.driver_status = 'online';
        console.log(`🟢 [HeartbeatService] Dispatcher ${currentAppUserId} restored to online`);
      }
      await base44.entities.AppUser.update(currentAppUserId, update);
      console.log(`💓 [HeartbeatService] Dispatcher heartbeat sent [${now.toLocaleTimeString('en-CA', { hour12: false })}]`);
    } else {
      // Non-dispatcher (driver) — just update timestamp, location tracker owns status
      await base44.entities.AppUser.update(currentAppUserId, {
        location_updated_at: nowIso,
      });
    }
  } catch (e) {
    // Silent — non-critical
  }
};

export const heartbeatService = {
  /**
   * Start the heartbeat for the given AppUser record id.
   * Pass isDispatcherRole=true for dispatchers so the 5-min stale check runs.
   * Safe to call multiple times — only one interval runs at a time.
   */
  start(appUserId, isDispatcherRole = false) {
    if (!appUserId) return;
    if (intervalId && currentAppUserId === appUserId) return; // already running for same user

    heartbeatService.stop(); // clear any previous interval

    currentAppUserId = appUserId;
    isDispatcher = isDispatcherRole;

    // Send immediately on start, then on interval
    sendHeartbeat();
    intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Also send when the tab becomes visible again after being hidden
    const handleVisibility = () => {
      if (!document.hidden) sendHeartbeat();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Store cleanup ref
    heartbeatService._visibilityCleanup = () =>
      document.removeEventListener('visibilitychange', handleVisibility);
  },

  stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (heartbeatService._visibilityCleanup) {
      heartbeatService._visibilityCleanup();
      heartbeatService._visibilityCleanup = null;
    }
    currentAppUserId = null;
    isDispatcher = false;
  },
};