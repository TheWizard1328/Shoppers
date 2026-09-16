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
 *  - installTestModeWriteGuard() hard-blocks all entity WRITES and all
 *    known mutating backend functions while Test Mode is active, so
 *    nothing the tester clicks can change real data. Reads work
 *    normally, so the map / dashboard / sidebar render exactly as a
 *    dispatcher would see them.
 *  - Auto-expires after 2 hours.
 *
 * Owner-only: the overlay only applies when the real platform user has
 * role === 'admin' (App Owner). No other account can activate it.
 */

const TEST_MODE_KEY = 'rxdeliver_test_mode_v1';
const TEST_MODE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Entity handler methods that mutate data — hard-blocked in Test Mode.
// list/filter/get/subscribe are reads and stay allowed.
const BLOCKED_ENTITY_METHODS = new Set([
  'create', 'update', 'delete', 'deleteMany',
  'bulkCreate', 'updateMany', 'bulkUpdate', 'importEntities',
]);

// Backend functions known to mutate data / have side effects (Square writes,
// status changes, route/patient mutations, notifications, catalog ops...).
// Read-only functions (queries, geocoding, ETA calc, doc serving...) stay allowed.
const BLOCKED_FUNCTIONS = new Set([
  'approveDocAccess', 'backfillGoogleApiLogUsername', 'backfillPatientHistory',
  'bulkUpdateDeliveries', 'clearAndSetNextDelivery', 'clearRemoteLogs',
  'consolidateBreadcrumbSegment', 'consolidateBreadcrumbs', 'deleteMyAccount',
  'docAccessManager', 'driverAvailabilityManager',
  'ensureDefaultPickupsForDriver', 'ensurePickupCompletion', 'ensurePickupForDelivery',
  'etaOptimizer', 'fullRouteOptimizer',
  'generateDemoData', 'generateDemoWeekV2', 'generateRouteManifest', 'generateStoreInvoices',
  'handleStartDelivery', 'processBarcode',
  'recalculateTrackingNumbers', 'recalculateTravelDistance', 'recordFridgeTemperature',
  'runPatientActivityScan', 'saveCrumbPolylineToDelivery',
  'scanPatientHistoryForStore', 'scanPrescriptionLabel', 'sendPushNotification',
  'setDriverStatus', 'snapMasterTimeline',
  'squareCleanupCatalog', 'squareCodReconcile', 'squareCreateCodItem', 'squareDeleteCodItem',
  'squareMarkDebit', 'squareMirrorCatalog', 'squarePurgeCatalog', 'squareRecordPmt',
  'squareSyncCatalog2', 'squareSyncCatalogItems', 'squareSyncOnline',
  'syncPatientLastDeliveryDate', 'syncPendingBreadcrumbs', 'syncRoutePatients', 'syncSquareCods',
  'updateMatchingPatientGPS', 'updatePatientsAfterRouteCompletion',
]);

const notifyBlocked = (detail) => {
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('testModeWriteBlocked', { detail }));
    }
    console.warn(`[TestMode] Blocked ${detail.kind === 'function' ? 'function' : 'entity write'}: ${detail.name} — Test Mode is active`);
  } catch {}
};

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

/**
 * Install the write guard on the shared Base44 SDK client.
 * Call once from base44Client.js right after createClient().
 */
export const installTestModeWriteGuard = (client) => {
  if (!client || !client.entities) return;

  // ── Guard entity writes ──────────────────────────────────────────────
  const originalEntities = client.entities;
  try {
    client.entities = new Proxy(originalEntities, {
      get(target, entityName) {
        if (typeof entityName !== 'string' || entityName === 'then' || entityName.startsWith('_')) {
          return Reflect.get(target, entityName);
        }
        const handler = Reflect.get(target, entityName);
        if (!handler || typeof handler !== 'object') return handler;
        return new Proxy(handler, {
          get(h, method) {
            const fn = Reflect.get(h, method);
            if (typeof fn !== 'function' || !BLOCKED_ENTITY_METHODS.has(method)) return fn;
            const label = `${entityName}.${method}`;
            return function (...args) {
              if (isTestModeActive()) {
                notifyBlocked({ kind: 'entity', name: label });
                return Promise.reject(new Error(`TEST_MODE_BLOCKED: ${label}() — entity writes are disabled while Test Mode is active`));
              }
              return fn.apply(h, args);
            };
          },
        });
      },
    });
  } catch (e) {
    console.error('[TestMode] Failed to install entity write guard:', e?.message || e);
  }

  // ── Guard mutating backend functions ────────────────────────────────
  try {
    const fns = client.functions;
    if (fns && typeof fns.invoke === 'function') {
      const originalInvoke = fns.invoke.bind(fns);
      fns.invoke = function (functionName, data) {
        if (isTestModeActive() && BLOCKED_FUNCTIONS.has(functionName)) {
          notifyBlocked({ kind: 'function', name: functionName });
          return Promise.reject(new Error(`TEST_MODE_BLOCKED: ${functionName}() is disabled while Test Mode is active`));
        }
        return originalInvoke(functionName, data);
      };
    }
  } catch (e) {
    console.error('[TestMode] Failed to install function guard:', e?.message || e);
  }
};
