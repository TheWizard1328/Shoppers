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
 * Resolution runs through an authenticated backend function with service-role
 * visibility. Driver-side User.list() can be RLS-scoped to the current driver,
 * which previously made app-owner notification rules resolve to nobody.
 */
import { base44 } from '@/api/base44Client';

let _ownerIds = null;        // Set<string> of platform User ids with role === 'admin'
let _loadedAt = 0;
let _inFlight = null;
let _failedAt = 0;           // last backend failure — backs off instead of retrying every delivery
const CACHE_TTL = 10 * 60 * 1000;       // 10 minutes
const FAILURE_BACKOFF = 30 * 60 * 1000; // after a failure, do not ask again for 30 minutes

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
  // OWNER REPORT (Nov 5 2026): a failing resolve used to be retried on every
  // single delivery completion, producing a 15-second error toast each time.
  // One failure now parks the lookup for 30 minutes and notifications keep
  // working off whatever ids are already known.
  if (_ownerIds && (now - _failedAt) < FAILURE_BACKOFF) return _ownerIds;
  if (!_ownerIds && (now - _failedAt) < FAILURE_BACKOFF) return new Set();

  _inFlight = (async () => {
    try {
      // Resolve through an authenticated backend function using service-role
      // visibility. Driver-side User.list() can be RLS-scoped to the caller,
      // which made relation:appowner resolve to nobody on driver devices.
      const response = await base44.functions.invoke('resolveAppOwnerIds', {});
      const ownerIds = response?.data?.owner_ids ?? response?.owner_ids ?? [];
      const ids = new Set((Array.isArray(ownerIds) ? ownerIds : []).filter(Boolean));
      _ownerIds = ids;
      _loadedAt = Date.now();
      return ids;
    } catch (e) {
      _failedAt = Date.now();
      console.warn('[appOwnerResolver] Backend owner resolution failed:', e?.message || e);
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
