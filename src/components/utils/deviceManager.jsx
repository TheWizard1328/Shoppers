import { base44 } from '@/api/base44Client';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

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

// ── IDB-first device record (owner spec Oct 13 2026) ──────────────────────
// OLD behavior: getCurrentDevice queried the server on every call (60s memo
// TTL, nulls never cached), and updateDeviceLastActive wrote the server on
// every GPS broadcast. In a traffic storm this became a self-feeding 429 loop
// ("Failed to get current device: Rate limit exceeded" x dozens/hour/device).
// NEW behavior, per owner design: this device's own UserDevice record lives
// in IDB. Steady state is ZERO server reads — the record is served from
// memory/IDB, and ONE up-sync cycle runs every 5 minutes which
//   1. writes last_active_at (the only field this device owns) and
//   2. applies the server's response, so admin changes (is_primary_tracker,
//      status) propagate to the device within 5 minutes.
// Down-sync happens ONLY when no IDB record exists (fresh login / app reset),
// with a 60s retry backoff on read failure so unregistered devices can never
// retry-loop. Unregistered devices (no DB record) cache the null result and
// re-check existence on the same 5-minute cycle (an admin may register the
// device later).
const DEVICE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SERVER_READ_RETRY_MS = 60 * 1000;
const DEVICE_RECORD_ID_PREFIX = 'rxdeliver_device_record_';

// Module state (per-session, per user+device key — reset on account switch)
let memoryUserKey = null;       // `${userId}:${deviceId}` memoryRecord belongs to
let memoryRecord = undefined;   // undefined = not loaded yet; null = confirmed no DB record; object = record
let lastSyncAt = 0;
let lastFailedReadAt = 0;
let syncInFlight = null;

const getDeviceCacheStorageKey = (userId, deviceId) => `rxdeliver_current_device_${userId}_${deviceId}`;
const deviceRecordId = (userId, deviceId) => `${DEVICE_RECORD_ID_PREFIX}${userId}_${deviceId}`;

/** Read this device's UserDevice record from the IDB backup store. */
async function readDeviceRecordFromIdb(userId, deviceId) {
  try {
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    const rows = await offlineDB.getAll(offlineDB.STORES.CRYPTO_META).catch(() => []);
    const rec = (rows || []).find((r) => r?.id === deviceRecordId(userId, deviceId));
    return rec?.record && typeof rec.record === 'object' ? rec.record : null;
  } catch (e) {
    return null;
  }
}

/** Persist this device's UserDevice record to the IDB backup store (upsert). */
async function writeDeviceRecordToIdb(userId, deviceId, record) {
  const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
  await offlineDB.bulkSave(offlineDB.STORES.CRYPTO_META, [{
    id: deviceRecordId(userId, deviceId),
    user_id: userId,
    device_identifier: deviceId,
    record,
    saved_at: new Date().toISOString()
  }]);
}

/** Wipe this device's IDB record backup (logout / reset). Best-effort. */
async function deleteDeviceRecordFromIdb(deviceId) {
  const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
  const rows = await offlineDB.getAll(offlineDB.STORES.CRYPTO_META).catch(() => []);
  const mine = (rows || []).filter((r) => String(r?.id || '').startsWith(DEVICE_RECORD_ID_PREFIX) && r?.device_identifier === deviceId);
  await Promise.all(mine.map((r) => offlineDB.deleteRecord(offlineDB.STORES.CRYPTO_META, r.id).catch(() => {})));
}

/**
 * Get the current device's identifier from localStorage
 */
export function getDeviceIdentifier() {
  return localStorage.getItem(DEVICE_ID_KEY);
}

/**
 * The 5-minute up-sync cycle (owner spec Oct 13 2026). ONE server round-trip
 * per device per 5 minutes, replacing the old read-every-60s +
 * write-every-broadcast pattern. The server's response is applied back into
 * IDB/memory so admin-side changes (primary flag, status) propagate.
 */
function maybeSyncDeviceRecord(userId, deviceId) {
  if (Date.now() - lastSyncAt < DEVICE_SYNC_INTERVAL_MS) return null;
  if (syncInFlight) return syncInFlight;
  lastSyncAt = Date.now();
  syncInFlight = (async () => {
    try {
      const rec = memoryRecord;
      if (rec?.id) {
        // Domain stamp (owner request Oct 29 2026): the Devices panel now shows
        // which domain each device is running on, so every up-sync also writes
        // THIS device's host into device_info. MERGED, never replaced — an admin
        // may have set device_type/other info on the record and that must survive.
        let currentHost = null;
        try { currentHost = window.location.hostname || null; } catch (_) {}
        const deviceInfo = rec.device_info && typeof rec.device_info === 'object' ? { ...rec.device_info } : {};
        if (currentHost && deviceInfo.host !== currentHost) deviceInfo.host = currentHost;
        const updated = await base44.entities.UserDevice.update(rec.id, {
          last_active_at: new Date().toISOString(),
          ...(currentHost ? { device_info: deviceInfo } : {}),
        });
        const fresh = (updated && typeof updated === 'object') ? { ...rec, ...updated, id: rec.id } : { ...rec };
        memoryRecord = fresh;
        await writeDeviceRecordToIdb(userId, deviceId, fresh).catch(() => {});
      } else {
        // Unregistered (or null record): periodic existence check — an admin
        // may register this device later. Same 5-minute cadence as the write.
        const devices = await base44.entities.UserDevice.filter({ user_id: userId, device_identifier: deviceId });
        if (devices && devices.length > 0) {
          memoryRecord = devices[0];
          await writeDeviceRecordToIdb(userId, deviceId, devices[0]).catch(() => {});
          console.log(`📱 [DeviceManager] Up-sync found a new UserDevice record: ${devices[0].device_name} — cached to IDB`);
        } else {
          memoryRecord = null; // still unregistered — re-checked next cycle
        }
      }
    } catch (e) {
      // Transient failure — retry in 60s (NOT immediately: never feed the storm)
      lastSyncAt = Date.now() - DEVICE_SYNC_INTERVAL_MS + SERVER_READ_RETRY_MS;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/**
 * Domain stamp (owner report Oct 29 2026: "the logged in domain is not being
 * saved at all"). The client-side device_info merge in the up-sync is not
 * reliable on its own — UserDevice is RLS-scoped to created_by === the caller's
 * email, so a record created by ANOTHER account (admin registration,
 * service-role write) rejects the device's own update silently. The
 * stampDeviceHost backend function writes under the service role and is scoped
 * to the caller's own user_id + device_identifier, so this works regardless of
 * who created the row. Fired once per session per host.
 */
const HOST_STAMP_KEY = 'rxdeliver_host_stamp';
const readHostStamp = () => {
  try { return localStorage.getItem(HOST_STAMP_KEY) || ''; } catch (_) { return ''; }
};
const writeHostStamp = (value) => {
  try { localStorage.setItem(HOST_STAMP_KEY, value); } catch (_) {}
};

export async function stampDeviceHost(userId, deviceRecord, { force = false } = {}) {
  try {
    const deviceId = getDeviceIdentifier();
    if (!deviceId || !userId) return null;
    let host = '';
    try { host = window.location.hostname || ''; } catch (_) { host = ''; }
    if (!host) return null;
    const stampKey = `${userId}:${deviceId}:${host}`;
    if (!force && readHostStamp() === stampKey) return null;
    if (deviceRecord && deviceRecord.device_info?.host === host) {
      writeHostStamp(stampKey); // server already has it
      return host;
    }
    writeHostStamp(stampKey); // set first: never retry-storm on failure
    await base44.functions.invoke('stampDeviceHost', { deviceIdentifier: deviceId, host });
    if (memoryRecord && memoryRecord.id) {
      memoryRecord = {
        ...memoryRecord,
        device_info: { ...(memoryRecord.device_info || {}), host },
      };
      const cached = memoryRecord;
      writeDeviceRecordToIdb(userId, deviceId, cached).catch(() => {});
      try { localStorage.setItem(getDeviceCacheStorageKey(userId, deviceId), JSON.stringify(cached)); } catch (_) {}
    }
    console.log(`🌐 [DeviceManager] Domain stamped: ${host}`);
    return host;
  } catch (e) {
    console.warn('[DeviceManager] Domain stamp failed (non-fatal):', e?.message || e);
    return null;
  }
}

/**
 * Get the current device's UserDevice record. IDB-first (owner spec Oct 13
 * 2026): steady state serves memory/IDB with ZERO server reads; the server is
 * touched only for the first down-sync (fresh login/reset) and the 5-minute
 * up-sync cycle. null means "no DB record" — callers treat unregistered
 * devices as primary (unchanged semantics).
 */
export async function getCurrentDevice(userId) {
  const deviceId = getDeviceIdentifier();
  if (!deviceId || !userId) {
    console.log(`⚠️ [DeviceManager] Missing deviceId (${!!deviceId}) or userId (${!!userId})`);
    return null;
  }

  const userKey = `${userId}:${deviceId}`;
  if (memoryUserKey !== userKey) {
    // Account switch / identifier change — reset session state
    memoryUserKey = userKey;
    memoryRecord = undefined;
    lastSyncAt = 0;
  }

  // Steady state: serve memory, refresh via the 5-minute cycle in background
  if (memoryRecord !== undefined) {
    maybeSyncDeviceRecord(userId, deviceId);
    stampDeviceHost(userId, memoryRecord).catch(() => {});
    return memoryRecord;
  }

  // First call this session: IDB-first
  const idbRec = await readDeviceRecordFromIdb(userId, deviceId);
  if (idbRec) {
    memoryRecord = idbRec;
    maybeSyncDeviceRecord(userId, deviceId);
    stampDeviceHost(userId, idbRec).catch(() => {});
    console.log(`📱 [DeviceManager] IDB record: ${idbRec.device_name} (Status: ${idbRec.status || 'active'}, Primary: ${idbRec.is_primary_tracker ? 'YES' : 'NO'})`);
    return idbRec;
  }

  // No IDB record — one down-sync (fresh login / reset), with retry backoff
  if (Date.now() - lastFailedReadAt < SERVER_READ_RETRY_MS) return null;
  try {
    const devices = await base44.entities.UserDevice.filter({
      user_id: userId,
      device_identifier: deviceId
    });
    const rec = devices && devices.length > 0 ? devices[0] : null;
    memoryRecord = rec;
    if (rec) {
      stampDeviceHost(userId, rec).catch(() => {});
      await writeDeviceRecordToIdb(userId, deviceId, rec).catch(() => {});
      try { localStorage.setItem(getDeviceCacheStorageKey(userId, deviceId), JSON.stringify(rec)); } catch (_) {}
      console.log(`📱 [DeviceManager] Down-synced device record: ${rec.device_name} (Status: ${rec.status || 'active'}, Primary: ${rec.is_primary_tracker ? 'YES' : 'NO'}) — cached to IDB`);
    } else {
      // Unregistered device — null = assume primary (unchanged semantics).
      // The null IS cached (re-checked on the 5-minute cycle) so unregistered
      // devices stop querying the server on every call.
      console.log('⚠️ [DeviceManager] No UserDevice record found — cached null (assume primary)');
    }
    // The down-sync response IS server truth — count it as this cycle's sync
    // so the 5-minute up-sync doesn't immediately re-read the server.
    lastSyncAt = Date.now();
    return rec;
  } catch (error) {
    lastFailedReadAt = Date.now();
    console.error('❌ [DeviceManager] Failed to get current device:', error);
    const registeredFlag = localStorage.getItem(`rxdeliver_device_registered_${deviceId}`) === 'true';
    if (registeredFlag) {
      // Parity with the old fallback: a device KNOWN to be registered serves a
      // stub rather than null, so primary checks don't flip mid-outage.
      return { user_id: userId, device_identifier: deviceId, status: 'active' };
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
 * Update device's last active timestamp. Owner spec Oct 13 2026: this is now a
 * LOCAL write (memory + IDB) — the server write is delivered by the 5-minute
 * up-sync cycle, replacing the old write-on-every-GPS-broadcast pattern.
 */
export async function updateDeviceLastActive(userId, existingDevice = undefined) {
  const device = existingDevice === undefined ? await getCurrentDevice(userId) : existingDevice;
  if (!device) return;

  const last_active_at = new Date().toISOString();
  const nextDevice = { ...device, last_active_at };
  const deviceId = getDeviceIdentifier();
  if (deviceId && memoryUserKey === `${userId}:${deviceId}`) {
    memoryRecord = nextDevice;
  }
  if (deviceId) {
    writeDeviceRecordToIdb(userId, deviceId, nextDevice).catch(() => {});
    try { localStorage.setItem(getDeviceCacheStorageKey(userId, deviceId), JSON.stringify(nextDevice)); } catch (_) {}
  }
}

/**
 * Clear device identifier from localStorage (use when logging out or resetting)
 */
export function clearDeviceIdentifier() {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  localStorage.removeItem(DEVICE_ID_KEY);
  memoryUserKey = null;
  memoryRecord = undefined;
  lastSyncAt = 0;
  lastFailedReadAt = 0;
  if (deviceId) {
    deleteDeviceRecordFromIdb(deviceId).catch(() => {});
  }
}

// ── Editor compute-host designation (owner spec Oct 14 2026) ──────────────────
// THE-DESKTOP(Editor) is the always-running main instance. Every OTHER owner
// device (PWA, phone, tablet, laptop) runs the LIGHT profile: no historical
// backfill, no future-dates boot sync, no usage-badge polling, and never
// computes Square (snapshot pulls only). Device lookup is IDB-cached, so the
// steady-state check costs zero API calls.
export const EDITOR_HOST_DEVICE_NAME = 'THE-DESKTOP(Editor)';
let editorHostCache = { key: null, value: false };
export const isEditorHostInstance = async (userId) => {
  try {
    if (!userId) return false;
    const key = `${userId}:${getDeviceIdentifier() || 'no-id'}`;
    if (editorHostCache.key === key) return editorHostCache.value;
    const rec = await getCurrentDevice(userId).catch(() => null);
    const value = rec?.device_name === EDITOR_HOST_DEVICE_NAME;
    editorHostCache = { key, value };
    return value;
  } catch (_) { return false; }
};
export const isSecondaryOwnerInstance = async (user) => {
  try {
    if (!user || user?.role !== 'admin') return false; // non-owners keep their existing behavior
    return !(await isEditorHostInstance(user.id));
  } catch (_) { return false; }
  // NOTE: an owner device whose UserDevice record can't be resolved counts as
  // SECONDARY (fail toward light) — matching the Square host gate, which also
  // requires the exact Editor name to run heavy work.
};
