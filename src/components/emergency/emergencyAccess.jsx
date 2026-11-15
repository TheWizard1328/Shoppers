// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY SYSTEM ACCESS (owner request Nov 14 2026)
//
// "I need to have a way to select which users are a part of the testing phase of
// the Emergency system. We can add a way to select All users and multi select
// individual users."
//
// The pilot list now lives in AppSettings → setting_value.emergency_settings so
// it can be edited from Admin Utilities instead of a hardcoded array:
//   test_all_users : every signed-in account runs the emergency system
//   test_users     : [{ id, user_id, name }] picked accounts
//
// `id` is the AppUser record id, `user_id` is the auth/platform user id. A
// signed-in user object carries one or the other depending on where it came
// from, so both are matched (plus the legacy TESTING_USER_IDS list in
// userRoles.jsx, which keeps Sharuk's device enabled through this change).
// ─────────────────────────────────────────────────────────────────────────────

import { isAppOwner, isTestingUser } from '@/components/utils/userRoles';

export const EMERGENCY_SETTINGS_CACHE_KEY = 'rxdeliver_emergency_settings_v1';

export const DEFAULT_EMERGENCY_SETTINGS = {
  manual_enabled: true,   // 5 second press-and-hold on the Dashboard map
  crash_enabled: true,    // impact detection prompt
  crash_threshold: 42,    // accelerationIncludingGravity magnitude that counts as a hit (m/s²)
  test_all_users: false,  // pilot scope: every signed-in account
  test_users: []          // pilot scope: picked accounts
};

/** Keep only well-formed entries, dedupe by id, and keep the display name. */
export const normalizeTestUsers = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    const id = String(entry.id || entry.app_user_id || entry.user_id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      user_id: entry.user_id ? String(entry.user_id) : null,
      name: entry.name || entry.user_name || entry.full_name || 'User'
    });
  }
  return out;
};

/** Settings as the rest of the app should read them (defaults + stored values). */
export const mergeEmergencySettings = (stored) => {
  const merged = { ...DEFAULT_EMERGENCY_SETTINGS };
  if (stored && typeof stored === 'object') {
    if (typeof stored.manual_enabled === 'boolean') merged.manual_enabled = stored.manual_enabled;
    if (typeof stored.crash_enabled === 'boolean') merged.crash_enabled = stored.crash_enabled;
    const threshold = Number(stored.crash_threshold);
    if (Number.isFinite(threshold) && threshold > 0) merged.crash_threshold = threshold;
    merged.test_all_users = !!stored.test_all_users;
    merged.test_users = normalizeTestUsers(stored.test_users);
  }
  return merged;
};

/**
 * Is the emergency system live for this account?
 * App Owner always. Then "All users". Then the picked accounts. Then the legacy
 * hardcoded testing list so an existing tester never loses access on deploy.
 */
/**
 * Turn raw AppUser rows into the pilot-scope picker list.
 * Owner request Nov 15 2026: ACTIVE accounts only, ordered the way every other
 * user list in the app orders them — manual sort_order first (layoutDataHelpers
 * sortUsers), un-numbered accounts after it, alphabetical inside each group.
 * Rows without a status count as active (AppUser defaults to 'active').
 */
export const buildPilotPeople = (rows = []) => {
  const seen = new Set();
  return (rows || [])
    .filter((row) => row && row.user_id && row.status !== 'inactive')
    .map((row) => ({
      id: String(row.id),
      user_id: row.user_id ? String(row.user_id) : null,
      name: row.user_name || row.user_id,
      roles: Array.isArray(row.app_roles) ? row.app_roles : [],
      duty: row.driver_status || null,
      sort_order: row.sort_order === null || row.sort_order === undefined || row.sort_order === ''
        ? null
        : (Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : null)
    }))
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .sort((a, b) => {
      const sa = a.sort_order ?? Infinity;
      const sb = b.sort_order ?? Infinity;
      if (sa !== sb) return sa - sb;
      return String(a.name).localeCompare(String(b.name));
    });
};

export const isEmergencyEnabledForUser = (currentUser, settings) => {
  if (!currentUser) return false;
  if (isAppOwner(currentUser)) return true;
  const resolved = settings && typeof settings === 'object'
    ? settings
    : DEFAULT_EMERGENCY_SETTINGS;
  if (resolved.test_all_users) return true;

  const candidates = [currentUser.id, currentUser.user_id, currentUser.app_user_id]
    .filter(Boolean)
    .map((value) => String(value));
  const picked = normalizeTestUsers(resolved.test_users);
  if (candidates.length > 0 && picked.length > 0) {
    const allowed = new Set();
    picked.forEach((entry) => {
      allowed.add(entry.id);
      if (entry.user_id) allowed.add(entry.user_id);
    });
    if (candidates.some((id) => allowed.has(id))) return true;
  }

  // Legacy fallback (hardcoded field testers, e.g. Sharuk on Nov 14 2026).
  return isTestingUser(currentUser);
};

/** Instant gate on app load — avoids a beat of "disabled" before settings land. */
export const readCachedEmergencySettings = () => {
  try {
    const raw = window.localStorage.getItem(EMERGENCY_SETTINGS_CACHE_KEY);
    if (!raw) return null;
    return mergeEmergencySettings(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const writeCachedEmergencySettings = (settings) => {
  try {
    window.localStorage.setItem(EMERGENCY_SETTINGS_CACHE_KEY, JSON.stringify(mergeEmergencySettings(settings)));
  } catch {
    /* storage may be unavailable (private mode) — the fetch still resolves the gate */
  }
};
