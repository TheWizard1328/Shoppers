/**
 * appUserMirror.jsx
 * Server → device MIRROR for the AppUser IndexedDB store (owner spec Nov 6 2026).
 *
 * WHY: app_users on a device is supposed to be an exact copy of the server table.
 * Instead devices accumulated thousands of partial "junk" rows (no user_id /
 * user_name) that grew from old partial writes, and per-record upserts never
 * removed them. The poller logs "Rejected N junk AppUser records" forever, and
 * the bloated PHI store makes every read decrypt the whole pile (the 5s map
 * stalls).
 *
 * HOW: an owner-triggered stamp in AppSettings (`app_users_mirror`). Bumping the
 * stamp does not push anything — every device compares its local stamp against
 * the server on boot and, when the server is newer, wipes app_users and rewrites
 * it from the authoritative server list in one bulk. A device that was offline
 * (or an APK that installs next week) heals itself on its next boot, which a
 * server push could never do.
 */
import { base44 } from '@/api/base44Client';

export const APP_USER_MIRROR_KEY = 'app_users_mirror';
const LS_VERSION_KEY = 'rxdeliver_appuser_mirror_version';

/** A record that is safe to keep in the local AppUser mirror. */
export const isValidAppUser = (u) =>
  !!(u && u.id && u.user_id && u.user_id !== 'undefined' && u.user_name && u.user_name !== 'undefined');

export function getLocalMirrorVersion() {
  try { return Number(localStorage.getItem(LS_VERSION_KEY) || 0) || 0; } catch { return 0; }
}

function setLocalMirrorVersion(v) {
  try { localStorage.setItem(LS_VERSION_KEY, String(Number(v) || 0)); } catch { /* ignore */ }
}

export async function getServerMirrorVersion() {
  try {
    const rows = await base44.entities.AppSettings.filter({ setting_key: APP_USER_MIRROR_KEY });
    return Number(rows?.[0]?.setting_value?.version) || 0;
  } catch {
    return 0;
  }
}

/** Owner action: raise the stamp so every device mirrors on its next boot. */
export async function bumpAppUserMirrorVersion() {
  const version = Date.now();
  const value = { version, requested_at: new Date().toISOString() };
  // This device must see its own bump at once, not on the next 15-min check.
  try { localStorage.removeItem(BOOT_CHECK_KEY); } catch { /* storage blocked */ }
  const rows = await base44.entities.AppSettings.filter({ setting_key: APP_USER_MIRROR_KEY }).catch(() => []);
  if (rows?.[0]?.id) {
    await base44.entities.AppSettings.update(rows[0].id, { setting_value: value });
  } else {
    await base44.entities.AppSettings.create({
      setting_key: APP_USER_MIRROR_KEY,
      setting_value: value,
      description: 'Force-mirror stamp for the local AppUser IndexedDB store (admin triggered)',
    });
  }
  return version;
}

/** Unsynced AppUser edits are the only local data a mirror would destroy. */
async function hasPendingAppUserMutations() {
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const pending = await offlineDB.getPendingMutations();
    return (pending || []).filter((m) =>
      String(m?.entity || m?.entity_name || m?.entityName || '').toLowerCase().replace(/[^a-z]/g, '') === 'appuser'
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Full mirror: clear the local app_users store and rewrite it from the server.
 * Refuses while this device still has unsynced AppUser mutations queued.
 */
export async function runAppUserMirror({ reason = 'boot', ignorePending = false } = {}) {
  if (!ignorePending && await hasPendingAppUserMutations()) return { skipped: 'pending-appuser-mutations' };

  let users = null;
  try {
    users = await base44.entities.AppUser.list();
  } catch (err) {
    console.warn('[AppUserMirror] server read failed:', err?.message || err);
    return { skipped: 'fetch-failed' };
  }
  if (!Array.isArray(users) || users.length === 0) return { skipped: 'no-server-rows' };

  const clean = users.filter(isValidAppUser);
  const { offlineDB } = await import('./offlineDatabase');
  try {
    await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, clean);
  } catch (err) {
    console.warn('[AppUserMirror] write failed:', err?.message || err);
    return { skipped: 'write-failed' };
  }

  const version = await getServerMirrorVersion();
  setLocalMirrorVersion(version || Date.now());
  console.log(`[AppUserMirror] mirrored ${clean.length} users (${reason}); dropped ${users.length - clean.length} invalid rows`);
  return { mirrored: clean.length, dropped: users.length - clean.length };
}

// The stamp check is itself an AppSettings read, so it ran on EVERY app open —
// one of the `AppSettings · GET` entries in the RATE LIMIT tooltip (owner report
// Nov 15 2026). A bumped stamp only has to be noticed once per 15 minutes.
const BOOT_CHECK_KEY = 'rxdeliver_appuser_mirror_check_at';
const BOOT_CHECK_MIN_GAP_MS = 15 * 60 * 1000;

/** Boot path: mirror only when the owner has bumped the stamp since this device last synced. */
export async function maybeRunAppUserMirror() {
  try {
    const last = Number(localStorage.getItem(BOOT_CHECK_KEY) || 0);
    if (last > 0 && Date.now() - last < BOOT_CHECK_MIN_GAP_MS) return { skipped: 'checked-recently' };
    localStorage.setItem(BOOT_CHECK_KEY, String(Date.now()));
  } catch { /* storage unavailable — check the stamp */ }
  const serverVersion = await getServerMirrorVersion();
  if (!serverVersion) return { skipped: 'no-stamp' };
  if (serverVersion <= getLocalMirrorVersion()) return { skipped: 'up-to-date' };
  return runAppUserMirror({ reason: 'stamp' });
}

/**
 * REPAIR A DEVICE WHOSE AppUser ROWS NO LONGER DECRYPT (owner report Nov 27 2026,
 * londonderry.shoppers warned "28 AppUser rows unreadable (PHI decrypt)" every
 * 12 minutes for a day). The poller's heal+mirror chain swallowed every failure,
 * so nobody could see WHY it kept repeating. This does the same work, reports the
 * outcome, and retries once with the pending-mutation guard relaxed when the
 * first pass bailed — a store tablet has no unsynced AppUser edits worth losing
 * against a roster that cannot be read at all.
 */
export async function repairUnreadableAppUsers({ reason = 'unreadable-appusers' } = {}) {
  let healed = 0;
  try {
    const m = await import('./idbCrypto');
    healed = await m.healUndecryptableStore('app_users');
  } catch (err) {
    console.warn('[AppUserMirror] heal failed:', err?.message || err);
  }
  let result = await runAppUserMirror({ reason });
  if (result?.skipped) {
    const relaxed = await runAppUserMirror({ reason: `${reason}:forced`, ignorePending: true });
    result = { ...relaxed, firstSkip: result.skipped };
  }
  // Verify: if the store still holds unusable rows the repair did not take.
  let remaining = null;
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const rows = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    remaining = (rows || []).filter((u) => !isValidAppUser(u)).length;
  } catch { /* count is best-effort */ }
  const summary = { healed, remaining, ...(result || {}) };
  if (result?.mirrored) {
    console.log(`[AppUserMirror] repair ${reason}: healed ${healed}, mirrored ${result.mirrored}, unusable left ${remaining}`);
  } else {
    console.warn(`[AppUserMirror] repair ${reason} did NOT mirror (${result?.skipped || 'unknown'}); unusable left ${remaining}`);
  }
  return summary;
}
