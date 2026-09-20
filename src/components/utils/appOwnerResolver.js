/**
 * App Owner resolution — platform-level (User.role === 'admin')
 *
 * IMPORTANT: "App Owner" is a PLATFORM concept (the built-in User entity's
 * role field), NOT the AppUser 'admin' app_role. Multiple AppUsers can hold
 * the 'admin' app_role (assistant/store admins), and messaging ALL of them
 * whenever a rule says "App Owner" leaks every driver stop event to people
 * who should not receive it.
 *
 * This module resolves the true platform owner ids (User.role === 'admin')
 * and caches them in-memory. This mirrors isAppOwner() in userRoles.js —
 * the ONLY authoritative definition of App Owner in the app.
 *
 * Note: base44.entities.User.list() is callable by all authenticated users
 * (DriverSettings already relies on it for emails), so this works from
 * driver devices too — which is where most stop-event notifications fire.
 */
import { base44 } from '@/api/base44Client';

let _ownerIds = null;        // Set<string> of platform User ids with role === 'admin'
let _loadedAt = 0;
let _inFlight = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Get the set of platform User ids that are App Owners (User.role === 'admin').
 * Cached for 10 minutes; concurrent callers share one in-flight request.
 *
 * On failure, keeps serving the stale cache until it expires; if there is
 * no cache at all, returns an EMPTY set — callers must treat "no owner
 * resolved" as "send to nobody", never fall back to all admins.
 */
export async function getAppOwnerUserIds(force = false) {
  const now = Date.now();
  if (!force && _ownerIds && (now - _loadedAt) < CACHE_TTL) {
    return _ownerIds;
  }
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const users = await base44.entities.User.list();
      const ids = new Set(
        (Array.isArray(users) ? users : [])
          .filter((u) => u?.role === 'admin' && u?.id)
          .map((u) => u.id)
      );
      _ownerIds = ids;
      _loadedAt = Date.now();
      return ids;
    } catch (e) {
      console.warn('[appOwnerResolver] Failed to resolve platform owner ids:', e?.message || e);
      if (_ownerIds) {
        // Keep serving stale data rather than dropping notifications entirely.
        _loadedAt = Date.now();
        return _ownerIds;
      }
      return new Set();
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Check whether a platform user id belongs to the App Owner.
 */
export async function isAppOwnerUserId(userId) {
  if (!userId) return false;
  const owners = await getAppOwnerUserIds();
  return owners.has(userId);
}
