/**
 * Heartbeat Service
 *
 * For DISPATCHERS: sends a heartbeat every 5 minutes (only from the primary device —
 *   see isPrimaryDevice check in start()). Every call unconditionally refreshes
 *   location_updated_at to now and restores driver_status to 'online'. This client
 *   NEVER self-marks off_duty — the mere fact this code is running proves the app is
 *   active right now, so any "stale means offline" judgment call belongs exclusively
 *   to the server-side monitor below, which can see the absence of a heartbeat over
 *   time — something the client itself cannot reliably observe about its own status.
 *
 * For DRIVERS: heartbeat is handled by the location tracker (GPS updates act as heartbeats).
 *
 * Rules (enforced by the monitorUserHeartbeat scheduled function, server-side only):
 *   < 5 min since last heartbeat → online
 *   > 5 min since last heartbeat → off_duty (offline)
 */

import { base44 } from '@/api/base44Client';
import { getCurrentDevice } from './deviceManager';
import { isCapacitorNativeApp, getCapacitorPlatform } from './locationProviders/capacitorRuntime';
import { remoteLogger } from './remoteLogger';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalId = null;
let currentAppUserId = null;
let isDispatcher = false;
let isPrimaryDevice = false;
let currentDeviceName = null;

const sendHeartbeat = async () => {
  if (!currentAppUserId) return;

  // CRITICAL: Non-primary devices must NOT write location_updated_at.
  // Only the primary device (phone/tablet APK) owns the authoritative timestamp.
  // Without this check, every logged-in browser tab, PWA instance, and desktop
  // session writes to the same AppUser record, creating phantom timestamp updates.
  if (!isPrimaryDevice) {
    return;
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();

    if (isDispatcher) {
      // CRITICAL: This function only runs at all when isPrimaryDevice is true (see
      // start() below) — the very fact sendHeartbeat() is executing IS proof the app
      // is active right now. Always refresh the timestamp and restore 'online' status
      // unconditionally. Marking off_duty due to a STALE old timestamp used to happen
      // here too, but that punished the exact moment a dispatcher reopened the app: the
      // first heartbeat call would see the old stale timestamp, flip driver_status to
      // off_duty, and return WITHOUT writing a fresh timestamp — leaving them stuck
      // off_duty for up to 5 more minutes until the next tick self-corrected. Going
      // offline after inactivity is exclusively the job of the monitorUserHeartbeat
      // scheduled function (see file header) — the client must never self-mark off_duty.
      let existing = null;
      try {
        const results = await base44.entities.AppUser.filter({ id: currentAppUserId });
        existing = results?.[0] || null;
      } catch (_) { /* non-critical */ }

      const update = { location_updated_at: nowIso };
      if (existing?.driver_status !== 'online') {
        update.driver_status = 'online';
        console.log(`🟢 [HeartbeatService] Dispatcher ${currentAppUserId} restored to online`);
      }
      await base44.entities.AppUser.update(currentAppUserId, update);
      console.log(`💓 [HeartbeatService] Dispatcher heartbeat sent [${now.toLocaleTimeString('en-CA', { hour12: false })}]`);
      remoteLogger.info('[HEARTBEAT] DISPATCHER | ' + (currentDeviceName || 'Unknown') + ' | isPrimary=' + isPrimaryDevice + ' | ts=' + nowIso);
    } else {
      // Non-dispatcher (driver) — just update timestamp, location tracker owns status
      await base44.entities.AppUser.update(currentAppUserId, {
        location_updated_at: nowIso,
      });
      remoteLogger.info('[HEARTBEAT] DRIVER | ' + (currentDeviceName || 'Unknown') + ' | isPrimary=' + isPrimaryDevice + ' | ts=' + nowIso);
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
  async start(appUserId, isDispatcherRole = false, userId = null) {
    if (!appUserId) return;
    if (intervalId && currentAppUserId === appUserId) return; // already running for same user

    heartbeatService.stop(); // clear any previous interval

    currentAppUserId = appUserId;
    isDispatcher = isDispatcherRole;

    // CRITICAL: Check if this is the primary device BEFORE starting heartbeat.
    // Non-primary devices (desktop browsers, secondary tablets, PWA on non-primary)
    // must NOT write location_updated_at — only the primary device owns the timestamp.
    if (userId) {
      try {
        const currentDevice = await getCurrentDevice(userId);
        isPrimaryDevice = currentDevice !== null && currentDevice?.status !== 'inactive' && currentDevice?.is_primary_tracker === true;
        currentDeviceName = currentDevice?.device_name || 'Unknown';
        const platform = isCapacitorNativeApp() ? 'Native-' + getCapacitorPlatform() : 'Web/PWA';
        if (!isPrimaryDevice) {
          console.log('[HeartbeatService] Non-primary device (' + (currentDeviceName || 'unregistered') + ') — heartbeat disabled (no timestamp writes)');
          remoteLogger.warn('[HEARTBEAT] SKIP-NON-PRIMARY | ' + platform + ' | ' + (currentDeviceName || 'Unknown') + ' | isPrimary=false');
          return; // Don't start the interval at all
        }
      } catch (err) {
        console.warn('[HeartbeatService] Device check failed — defaulting to non-primary (safe):', err?.message);
        isPrimaryDevice = false;
        return;
      }
    }

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
    isPrimaryDevice = false;
    currentDeviceName = null;
  },
};