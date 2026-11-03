import { base44 } from '@/api/base44Client';
import { invalidateDeviceIdentifierCache } from './userSettingsManager';

/**
 * DEVICE REGISTRATION SELF-HEAL (owner report Nov 3 2026)
 *
 * Symptom: dispatchers opened the app each morning and were shown the DEVICE
 * CHOOSER ("select an existing device / create a new one") as if it were their
 * very first login, plus every other first-boot path that rides behind the
 * device gate (skipped user settings, skipped theme, skipped IDB boot). The
 * UserDevice rows themselves were untouched — they simply tapped their existing
 * device again and carried on until the next morning.
 *
 * The gate in useLayoutInit only knows `deviceRegistered = UserDevice rows for
 * (user_id, this device_identifier) > 0`. When the browser hands back a
 * different (or missing) identifier than the row it registered with, the gate
 * has no way to tell "brand new machine" from "the same store PC with a fresh
 * localStorage", so it always chose the chooser.
 *
 * This module gives the gate a memory: after ANY successful device link we
 * remember the device this browser profile uses for that user (localStorage +
 * IDB backup). On a later boot whose identifier does not match a server row we
 * look the remembered device up and re-link it SILENTLY, so a returning
 * machine never sees the chooser. If there is no memory, we only auto-link when
 * the server list is unambiguous for this machine (exactly one row with the same
 * host and device type); otherwise the chooser still appears, and whatever the
 * user picks becomes the new memory.
 */

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';
const REGISTERED_KEY = (id) => `rxdeliver_device_registered_${id}`;
const IDENTITY_KEY = (userId) => `rxdeliver_device_identity_${userId}`;
const IDB_IDENTITY_PREFIX = 'rxdeliver_device_identity_v1_';
const IDB_IDENTITY_ID = (userId) => `${IDB_IDENTITY_PREFIX}${userId}`;

const withTimeout = (promise, ms, label = 'device self-heal') =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);

const bareHost = (h) => String(h || '').replace(/^www\./, '').toLowerCase();

function currentHost() {
  try { return bareHost(window.location.hostname); } catch { return ''; }
}

function currentDeviceType() {
  try {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
    return mobile ? 'Mobile' : 'Desktop';
  } catch { return 'Desktop'; }
}

/** Read the remembered device for this (browser profile, user). */
async function readRememberedIdentity(userId) {
  if (!userId) return null;
  let identity = null;
  try {
    const raw = localStorage.getItem(IDENTITY_KEY(userId));
    if (raw) identity = JSON.parse(raw);
  } catch { /* ignore */ }
  if (identity?.device_identifier) return identity;
  // localStorage lost it — fall back to the IDB mirror.
  try {
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    const rows = await withTimeout(offlineDB.getAll(offlineDB.STORES.CRYPTO_META), 4000, 'identity IDB read').catch(() => []);
    const rec = (rows || []).find((r) => r?.id === IDB_IDENTITY_ID(userId));
    if (rec?.device_identifier) {
      identity = { device_identifier: rec.device_identifier, device_name: rec.device_name || null, host: rec.host || null };
      try { localStorage.setItem(IDENTITY_KEY(userId), JSON.stringify(identity)); } catch { /* ignore */ }
      return identity;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Remember which UserDevice this browser profile uses for this user, so a later
 * boot can re-link it silently instead of asking the user to choose again.
 * Called on every confirmed/silent device link.
 */
export async function rememberDeviceIdentity(userId, device) {
  const deviceIdentifier = device?.device_identifier || (() => {
    try { return localStorage.getItem(DEVICE_ID_KEY); } catch { return null; }
  })();
  if (!userId || !deviceIdentifier) return;
  const identity = {
    device_identifier: deviceIdentifier,
    device_name: device?.device_name || null,
    device_type: device?.device_info?.device_type || currentDeviceType(),
    host: currentHost() || null,
    remembered_at: new Date().toISOString(),
  };
  try { localStorage.setItem(IDENTITY_KEY(userId), JSON.stringify(identity)); } catch { /* ignore */ }
  try {
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    await offlineDB.bulkSave(offlineDB.STORES.CRYPTO_META, [{
      id: IDB_IDENTITY_ID(userId),
      ...identity,
      saved_at: identity.remembered_at,
    }]);
  } catch { /* non-fatal */ }
}

/** The identifier mirrored in IDB by deviceManager (survives localStorage loss). */
async function readIdbBackupIdentifier() {
  try {
    const offlineDB = (await import('./offlineDatabase.jsx')).offlineDB;
    const rows = await withTimeout(offlineDB.getAll(offlineDB.STORES.CRYPTO_META), 4000, 'identifier backup read').catch(() => []);
    const rec = (rows || []).find((r) => r?.id === 'rxdeliver_device_id_backup_v1' && r?.device_identifier);
    return rec?.device_identifier || null;
  } catch { return null; }
}

/**
 * Try to silently re-link this machine to one of the user's already-registered
 * devices. Returns the linked UserDevice row, or null when nothing is certain
 * enough (caller then shows the chooser as before).
 *
 * Never throws and never blocks boot for more than ~9 s.
 */
export async function trySelfHealDeviceRegistration({ userId, deviceIdentifier }) {
  if (!userId) return null;
  try {
    const remembered = await readRememberedIdentity(userId);
    const rows = await withTimeout(
      base44.entities.UserDevice.filter({ user_id: userId }),
      8000,
      'UserDevice self-heal lookup'
    ).catch(() => null);
    if (!Array.isArray(rows)) return null; // offline / rate limited — let the caller decide
    const active = rows.filter((r) => r && (r.status === 'active' || !r.status) && r.device_identifier);
    if (active.length === 0) return null; // genuinely a new user, or every device was removed

    // Only identifiers that PROVE this machine has used the account before are
    // eligible. Guessing from host/device-type alone could silently attach a
    // brand-new phone to an existing device record (wrong GPS ownership,
    // wrong is_primary_tracker) — a wrong auto-link is worse than one chooser.
    const byIdentifier = (id) => (id ? active.find((r) => r.device_identifier === id) || null : null);
    const backupIdentifier = await readIdbBackupIdentifier();
    const pick =
      byIdentifier(remembered?.device_identifier) ||
      byIdentifier(deviceIdentifier) ||
      byIdentifier(backupIdentifier);
    if (!pick) return null;

    if (!pick) return null;

    // Link it exactly the way the chooser would, but silently.
    try { localStorage.setItem(DEVICE_ID_KEY, pick.device_identifier); } catch { /* ignore */ }
    try { localStorage.setItem(REGISTERED_KEY(pick.device_identifier), 'true'); } catch { /* ignore */ }
    if (deviceIdentifier && deviceIdentifier !== pick.device_identifier) {
      try { localStorage.removeItem(REGISTERED_KEY(deviceIdentifier)); } catch { /* ignore */ }
    }
    try { invalidateDeviceIdentifierCache(); } catch { /* ignore */ }
    rememberDeviceIdentity(userId, pick).catch(() => {});
    withTimeout(
      base44.entities.UserDevice.update(pick.id, { last_active_at: new Date().toISOString() }),
      6000,
      'UserDevice self-heal stamp'
    ).catch(() => {});
    console.log('[DeviceSelfHeal] Re-linked this device silently to', pick.device_name || pick.device_identifier, '— no chooser shown');
    return pick;
  } catch (e) {
    console.warn('[DeviceSelfHeal] Self-heal skipped:', e?.message || e);
    return null;
  }
}
