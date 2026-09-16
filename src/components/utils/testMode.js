/**
 * Test Mode — App Owner "Test as Dispatcher" (Sep 15, 2026)
 * ----------------------------------------------------------
 * Lets the App Owner simulate the dispatcher experience on ANY device
 * (APK, browser PWA, desktop) without needing Base44's editor-only
 * "Act As User" feature.
 *
 * How it works:
 *  - A config is stored in sessionStorage (per-tab / per-app-session,
 *    never persisted to disk — a crash or close clears it).
 *  - applyTestModeOverlay() clones the Owner's user object as a pure
 *    dispatcher (role stripped to 'user', app_roles = ['dispatcher'],
 *    store/city assignments mirrored from a real dispatcher). The real
 *    account is untouched — same ID, same auth, same session.
 *  - NO write blocking — this is a true "act as dispatcher" switch. The
 *    Owner gets the full dispatcher experience: same privileges, same
 *    store/city assignments, and every action they take performs for
 *    real, exactly as a dispatcher would (attributed to their account).
 *  - Auto-expires after 2 hours.
 *
 * Owner-only: the overlay only applies when the real platform user has
 * role === 'admin' (App Owner). No other account can activate it.
 */

const TEST_MODE_KEY = 'rxdeliver_test_mode_v1';
const TEST_MODE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Read the active Test Mode config (null if off/expired).
 */
export const getTestModeConfig = () => {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(TEST_MODE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg || !cfg.expires_at || Date.now() > cfg.expires_at) {
      sessionStorage.removeItem(TEST_MODE_KEY);
      return null;
    }
    return cfg;
  } catch {
    try { sessionStorage.removeItem(TEST_MODE_KEY); } catch {}
    return null;
  }
};

export const isTestModeActive = () => !!getTestModeConfig();

/**
 * Activate Test Mode and reload the app so every consumer boots clean.
 * cfg: { store_ids: string[], city_ids: string[], mirrored_from: string|null }
 */
export const activateTestMode = (cfg) => {
  const config = {
    store_ids: Array.isArray(cfg?.store_ids) ? cfg.store_ids : [],
    city_ids: Array.isArray(cfg?.city_ids) ? cfg.city_ids : [],
    mirrored_from: cfg?.mirrored_from || null,
    activated_at: Date.now(),
    expires_at: Date.now() + TEST_MODE_TTL_MS,
  };
  sessionStorage.setItem(TEST_MODE_KEY, JSON.stringify(config));
  try { window.dispatchEvent(new CustomEvent('testModeChanged')); } catch {}
  window.location.reload();
};

/**
 * Exit Test Mode and reload.
 */
export const exitTestMode = () => {
  try { sessionStorage.removeItem(TEST_MODE_KEY); } catch {}
  try { window.dispatchEvent(new CustomEvent('testModeChanged')); } catch {}
  window.location.reload();
};

/**
 * Overlay the Owner's user object as a pure dispatcher.
 * Returns the user untouched unless Test Mode is on AND the user is the
 * App Owner (platform role 'admin'). Never mutates the original object.
 */
export const applyTestModeOverlay = (user) => {
  if (!user) return user;
  const cfg = getTestModeConfig();
  if (!cfg || user.role !== 'admin') return user;
  return {
    ...user,
    // Strip App Owner privileges so admin-only UI hides — true dispatcher view.
    role: 'user',
    app_roles: ['dispatcher'],
    store_ids: cfg.store_ids,
    city_ids: cfg.city_ids,
    city_id: (cfg.city_ids && cfg.city_ids[0]) || user.city_id,
    // Non-drivers use 'online' to signal "logged in".
    driver_status: 'online',
    // Test-mode markers (also let the avatar tap re-open the dialog).
    __testModeActive: true,
    __testModeMirroredFrom: cfg.mirrored_from,
  };
};
