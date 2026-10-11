import { base44 } from '@/api/base44Client';
import { requestManager } from './requestManager';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';
const DEVICE_CACHE_TTL_MS = 60000;

// ── Device identifier IDB backup (owner report Oct 8 2026) ────────────────
// Android WebView evicts localStorage while keeping IndexedDB alive. The
// device identifier previously lived ONLY in localStorage, so every eviction
// wiped it and DeviceRegistration re-prompted drivers to re-select a device
// from the device manager on every boot. Mirroring the idbCrypto key-backup
// pattern: back the identifier up inside IDB (crypto_meta store, never
// encrypted) and restore it at boot BEFORE any device check runs.
const DEVICE_ID_BACKUP_ID = 'rxdeliver_device_id_backup_v1';

/** Restore the device identifier from the IDB backup when localStorage lost it. */
export async function restoreDeviceIdentifierFromIdb() {
  try {
    if (localStorage.getItem(DEVICE_ID_KEY)) return false; // nothing lost
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    const rows = await offlineDB.getAll(offlineDB.STORES.CRYPTO_META).catch(() => []);
    const rec = (rows || []).find((r) => r?.id === DEVICE_ID_BACKUP_ID && r?.device_identifier);
    if (!rec) return false;
    localStorage.setItem(DEVICE_ID_KEY, rec.device_identifier);
    console.log('[DeviceManager] RESTORED device identifier from IDB backup — localStorage had been evicted');
    return true;
  } catch (e) {
    console.warn('[DeviceManager] Device identifier backup restore failed:', e?.message || e);
    return false;
  }
}

/** Persist the current device identifier to the IDB backup store (upsert). */
export async function backupDeviceIdentifierToIdb() {
  try {
    const deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) return;
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    await offlineDB.bulkSave(offlineDB.STORES.CRYPTO_META, [{
      id: DEVICE_ID_BACKUP_ID,
      device_identifier: deviceId,
      saved_at: new Date().toISOString()
    }]);
  } catch (e) {
    // non-fatal — identifier remains valid this session
    console.warn('[DeviceManager] Device identifier backup write failed:', e?.message || e);
  }
}

const getDeviceCacheStorageKey = (userId, deviceId) => `rxdeliver_current_device_${userId}_${deviceId}`;

/**
 * Get the current device's identifier from localStorage
 */
export function getDeviceIdentifier() {
  return localStorage.getItem(DEVICE_ID_KEY);
}

/**
 * Get the current device's UserDevice record from backend
 */
export async function getCurrentDevice(userId) {
  const deviceId = getDeviceIdentifier();
  if (!deviceId || !userId) {
    console.log(`⚠️ [DeviceManager] Missing deviceId (${!!deviceId}) or userId (${!!userId})`);
    return null;
  }

  const cacheKey = `current-device:${userId}:${deviceId}`;
  const localCacheKey = getDeviceCacheStorageKey(userId, deviceId);
  const registeredFlag = localStorage.getItem(`rxdeliver_device_registered_${deviceId}`) === 'true';

  // NOTE: Intentionally NOT using localStorage cache for primary-tracker checks —
  // the is_primary_tracker flag must always come from the live DB to avoid stale state.

  try {
    return await requestManager.memoized(cacheKey, async () => {
      const devices = await base44.entities.UserDevice.filter({
        user_id: userId,
        device_identifier: deviceId
      });

      if (devices && devices.length > 0) {
        const device = devices[0];
        try { localStorage.setItem(localCacheKey, JSON.stringify(device)); } catch (_) {}
        console.log(`📱 [DeviceManager] Found device: ${device.device_name} (Status: ${device.status || 'active'}, Primary: ${device.is_primary_tracker ? 'YES' : 'NO'})`);
        return device;
      }

      // Unregistered device (no DB record) — return null so callers treat it as primary.
      // Most drivers never explicitly register a device; null = "unknown = assume primary"
      // so they still get GPS upload authority and immersive mode.
      // Only an explicit is_primary_tracker=false record in the DB denotes non-primary.
      console.log(`⚠️ [DeviceManager] No UserDevice record found — returning null (assume primary)`);
      return null;
    }, {
      ttlMs: DEVICE_CACHE_TTL_MS,
      cacheNull: false  // Never cache null — a null means "no record found or failed"; retry next call
    });
  } catch (error) {
    console.error('❌ [DeviceManager] Failed to get current device:', error);
    if (registeredFlag) {
      const fallbackDevice = { user_id: userId, device_identifier: deviceId, status: 'active' };
      requestManager.set(cacheKey, fallbackDevice, DEVICE_CACHE_TTL_MS);
      return fallbackDevice;
    }
    return null;
  }
}

/**
 * Check if the current device is the primary tracker
 */
export async function isCurrentDevicePrimary(userId) {
  const device = await getCurrentDevice(userId);
  const isPrimary = device?.is_primary_tracker || false;
  
  const deviceName = device?.device_name || 'Unknown Device';
  console.log(`📱 [DeviceManager] Primary check for ${deviceName}: ${isPrimary ? 'YES ✅' : 'NO ❌'}`);
  
  return isPrimary;
}

/**
 * Update device's last active timestamp
 */
export async function updateDeviceLastActive(userId, existingDevice = undefined) {
  const device = existingDevice === undefined ? await getCurrentDevice(userId) : existingDevice;
  if (!device) return;

  try {
    const last_active_at = new Date().toISOString();
    await base44.entities.UserDevice.update(device.id, {
      last_active_at
    });

    const deviceId = getDeviceIdentifier();
    if (deviceId) {
      const nextDevice = {
        ...device,
        last_active_at
      };
      requestManager.set(`current-device:${userId}:${deviceId}`, nextDevice, DEVICE_CACHE_TTL_MS);
      try { localStorage.setItem(getDeviceCacheStorageKey(userId, deviceId), JSON.stringify(nextDevice)); } catch (_) {}
    }
  } catch (error) {
    console.error('Failed to update device last active:', error);
  }
}

/**
 * Clear device identifier from localStorage (use when logging out or resetting)
 */
export function clearDeviceIdentifier() {
  localStorage.removeItem(DEVICE_ID_KEY);
}