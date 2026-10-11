/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 * Enhanced with offline caching support
 */

import { UserSettings } from '@/entities/UserSettings';
import { offlineManager } from './offlineManager';
import { connectionMonitor } from './connectionMonitor';
import { getUserAgentInfo, isMobileDeviceForTheme } from './deviceUtils';

// In-memory cache for current session
let cachedSettings = null;
let cachedGlobalSettings = null;
let currentUserId = null;
let cachedDeviceIdentifier = null;
let cachedDeviceType = null; // Cache device type (Mobile, Desktop, or Tablet)
let lastFetchTime = 0;
let inFlightSettingsPromise = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache to prevent rate limits

// IN-FLIGHT WRITE TRACKER (Oct 2 2026): "Force Full App Refresh" calls
// window.location.reload() right after a user action like changing the
// dashboard date. saveSetting's IDB write (saveToLocalPersistentStore) is
// fast but asynchronous and NOT awaited by its caller (globalFilters fires
// it and returns immediately) — a reload that lands before that write
// resolves discards it, so the next boot reads the IDB snapshot from
// whenever selected_date/selected_driver_id were last saved, which can be
// an old session (owner report: force-refreshing right after setting
// today's date restored a date from weeks earlier). Every saveSetting call
// registers its IDB-write promise here; waitForPendingSettingWrites lets a
// deliberate reload action wait for them first.
const pendingWritePromises = new Set();

/**
 * Gets unique device identifier - stored and persisted in localStorage
 * CRITICAL: Must be stable across sessions for the same physical device
 */
export function getDeviceIdentifier() {
  // Return cached if available
  if (cachedDeviceIdentifier) {
    return cachedDeviceIdentifier;
  }

  // Try to load from localStorage
  let deviceId = localStorage.getItem('rxdeliver_device_identifier');
  
  if (!deviceId) {
    // Generate new UUID for this device
    deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('rxdeliver_device_identifier', deviceId);
    console.log('🆔 [UserSettings] Generated new device identifier:', deviceId);
  } else {
    console.log('🆔 [UserSettings] Loaded device identifier:', deviceId);
  }

  cachedDeviceIdentifier = deviceId;
  return deviceId;
}

/**
 * Clears the in-memory device-identifier cache so the next getDeviceIdentifier()
 * call re-reads from localStorage. Used after DeviceRegistration writes a new
 * device identifier to localStorage in-place (without a page reload) so the
 * resumed boot sees the newly-selected device.
 */
export function invalidateDeviceIdentifierCache() {
  cachedDeviceIdentifier = null;
}

/**
 * Gets device type identifier - "Mobile", "Desktop", or "Tablet"
 * CRITICAL: Classifies Tablet as Mobile for settings purposes
 */
export function getDeviceType() {
  // Return cached if available
  if (cachedDeviceType) {
    return cachedDeviceType;
  }

  // Theme/Settings device classification MUST ignore viewport width to avoid PWAs mis-detecting
  const uaMobileOrTablet = isMobileDeviceForTheme();
  cachedDeviceType = uaMobileOrTablet ? 'Mobile' : 'Desktop';
  
  console.log('📱 [UserSettings] Device Type:', cachedDeviceType);
  return cachedDeviceType;
}

/**
 * Default settings values
 * CRITICAL: Check device type to set appropriate default theme
 */
const getInitialDefaultSettings = () => {
  const isMobile = isMobileDeviceForTheme(); // UA-only, ignore viewport to avoid PWA misclassification
  return {
    fab_map_cycle_phase: 1,
    units_of_measurement: 'kilometers',
    notifications_enabled: true,
    notifications_sound: true,
    notifications_vibration: true,
    sidebar_width: 240,
    right_panel_width: 350,
    breadcrumbs_enabled: true,
    theme_preference: isMobile ? 'auto' : 'light'
  };
};

const DEFAULT_SETTINGS = getInitialDefaultSettings();

/**
 * SETTINGS CLASSIFICATION
 * Defines which settings are global (synced across devices) vs device-specific
 */
const GLOBAL_SETTINGS = [
  'units_of_measurement',
  // FIX (Sep 29 2026): theme_preference is now GLOBAL. It used to be
  // device-specific, which meant choosing Dark on one device left every other
  // device (phone, tablet, desktop) in light or auto mode — the root cause of
  // the owner seeing a white Users page on devices where Dark was never set.
  // One choice now applies everywhere.
  'theme_preference'
];

// CRITICAL: These settings are NEVER synced across devices
// Each device maintains its own values for these
const DEVICE_SPECIFIC_SETTINGS = [
  'fab_map_cycle_phase',
  'sidebar_width',
  'right_panel_width',
  'admin_utilities_year',
  'admin_utilities_month',
  'admin_utilities_driver',
  'show_all_driver_markers',
  'show_breadcrumbs',
  'location_tracking_enabled',
  'selected_date',
  'selected_driver_id',
  'notifications_enabled',
  'notifications_sound',
  'notifications_vibration'
];

// Check if a setting is global or device-specific
function isGlobalSetting(key) {
  return GLOBAL_SETTINGS.includes(key);
}

function isDeviceSpecificSetting(key) {
  return DEVICE_SPECIFIC_SETTINGS.includes(key);
}

/**
 * Save settings to offlineManager's IndexedDB for robust local persistence
 */
async function saveToLocalPersistentStore(userId, deviceType, settings) {
  try {
    await offlineManager.cacheUserSettings(userId, deviceType, settings);
    console.log('📦 [UserSettings] Saved to local persistent store (IndexedDB)');
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error saving to local persistent store:', error);
  }
}

/**
 * Loads settings from offlineManager's IndexedDB (for offline use)
 */
async function loadFromLocalPersistentStore(userId, deviceType) {
  try {
    const cached = await offlineManager.getCachedUserSettings(userId, deviceType);
    if (cached) {
      console.log('📦 [UserSettings] Loaded from local persistent store (IndexedDB)');
      return cached;
    }
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading from local persistent store:', error);
  }
  return null;
}

/**
 * Loads global settings (synced across all devices) for the user
 * CRITICAL: Only loads settings explicitly marked as GLOBAL_SETTINGS
 * Device-specific settings like selected_driver_id and selected_date are NEVER loaded here
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - Global settings object (only units, notifications, etc.)
 */
async function loadGlobalSettings(userId) {
  try {
    // Add small delay to prevent rate limiting from concurrent requests
    await new Promise(r => setTimeout(r, 50));
    
    // CRITICAL: Query for global settings without device_id filter
    // Returns settings from any device (latest)
    const allUserSettings = await UserSettings.filter({
      user_id: userId
    }, '-updated', 1); // Get most recently updated record

    if (allUserSettings && allUserSettings.length > 0) {
      const latestSettings = allUserSettings[0];
      const globalSettings = {};
      
      // CRITICAL: Extract ONLY global settings - NOT device-specific ones like selected_driver_id, selected_date
      GLOBAL_SETTINGS.forEach(key => {
        if (latestSettings[key] !== undefined) {
          globalSettings[key] = latestSettings[key];
        }
      });
      
      console.log('🌐 [UserSettings] Loaded global settings:', Object.keys(globalSettings).join(', '));
      return globalSettings;
    }
    
    return {};
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading global settings:', error);
    return {};
  }
}

/**
 * Loads user settings from the backend for the current user and device
 * Retrieves the UserSettings record and extracts device-specific + global settings
 * Falls back to cached settings when offline
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - The merged settings object for current device
 */
/**
 * Background refresh of GLOBAL settings (currently: units_of_measurement,
 * theme_preference) so a choice made on ONE device propagates to every other
 * device. loadUserSettings short-circuits on the per-device IDB cache, which
 * is correct for device-specific settings but would otherwise freeze global
 * values at whatever this device cached last. Runs fire-and-forget: the app
 * renders from cache immediately, then applies the fresh global values and
 * dispatches 'themePreferenceChanged' (Layout.jsx listens) when the theme
 * changed. Skips while offline and never touches keys with a pending save.
 */
async function refreshGlobalSettings(userId, _attempt = 0) {
  // NETWORK STABILITY GATE (Oct 5 2026, owner spec): the "what changed after
  // boot" check must only run once the network is stable — on a degraded link
  // this UserSettings.filter call hangs and burns the throttler/bus for
  // nothing. If not stable yet, retry every 30s (bounded so an all-day outage
  // doesn't accumulate timers). A clean failure here is fine: the next WS
  // push or next boot re-checks.
  try {
    if (_attempt < 20 && !connectionMonitor.canAttemptNetwork()) {
      setTimeout(() => refreshGlobalSettings(userId, _attempt + 1).catch(() => {}), 30000);
      return;
    }
  } catch {}
  try {
    if (!offlineManager.getOnlineStatus()) return;
    const deviceIdentifier = getDeviceIdentifier();

    const userSettingsRecords = await UserSettings.filter({ user_id: userId }, '-updated', 1);
    if (!userSettingsRecords || userSettingsRecords.length === 0) return;
    const rawGlobalSettings = userSettingsRecords[0].global_settings || {};

    const updates = {};
    GLOBAL_SETTINGS.forEach(key => {
      const serverValue = rawGlobalSettings[key];
      if (serverValue === undefined) return;
      // Don't race a save that is still inside its debounce window for this key
      if (userSettingsSaveTimeouts.has(`${userId}:${deviceIdentifier}:${key}`)) return;
      if (cachedSettings && cachedSettings[key] !== serverValue) updates[key] = serverValue;
    });
    if (Object.keys(updates).length === 0) return;

    cachedSettings = { ...(cachedSettings || DEFAULT_SETTINGS), ...updates };
    cachedGlobalSettings = { ...(cachedGlobalSettings || {}), ...updates };
    lastFetchTime = Date.now();
    await saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);

    if (updates.theme_preference !== undefined) {
      window.dispatchEvent(new CustomEvent('themePreferenceChanged', {
        detail: { theme: updates.theme_preference }
      }));
    }
    console.log(`🔄 [UserSettings] Global settings refreshed from server:`, updates);
  } catch (_) { /* non-critical background refresh */ }
}

/**
 * Subscribe to UserSettings WebSocket broadcasts so settings changed on another
 * device of the same user (or from the web while driving) apply here in near
 * real time. The UserSettings entity is user-scoped, so the platform only
 * delivers this user's own records. The handler is a DIFF CHECK, not a full
 * sync (owner spec Oct 5 2026): it re-runs refreshGlobalSettings, which pulls
 * the latest record and applies only GLOBAL_SETTINGS keys that actually
 * changed, skipping keys with pending local saves. Throttled to at most one
 * check per 5s — rapid multi-key saves collapse into a single check.
 */
let _userSettingsWsUnsub = null;
let _lastWsRefreshAt = 0;
export async function subscribeToUserSettingsUpdates(userId) {
  if (!userId) return;
  try {
    if (typeof window !== 'undefined') {
      if (window.__userSettingsWsSubscribed) return;
      window.__userSettingsWsSubscribed = true;
    }
    if (_userSettingsWsUnsub) return;
    const { base44 } = await import('@/api/base44Client');
    _userSettingsWsUnsub = base44.entities.UserSettings.subscribe((event) => {
      const now = Date.now();
      if (now - _lastWsRefreshAt < 5000) return; // throttle
      _lastWsRefreshAt = now;
      // Only updates/creates matter; a delete keeps the cached values (defaults)
      if (event?.type && event.type !== 'update' && event.type !== 'create') return;
      refreshGlobalSettings(userId).catch(() => {});
    });
    console.log('✅ [UserSettings] WS subscription active — global settings sync via push');
  } catch (e) {
    console.warn('⚠️ [UserSettings] WS subscription failed:', e?.message);
  }
}

export async function loadUserSettings(userId) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, returning defaults');
    return {
      ...DEFAULT_SETTINGS,
      selected_date: null,
      selected_driver_id: 'all',
      show_all_driver_markers: false,
      show_breadcrumbs: false,
      location_tracking_enabled: true
    };
  }

  const deviceIdentifier = getDeviceIdentifier();
  const deviceType = getDeviceType();
  
  // Return cached if same user AND cache is fresh (< 5 min)
  const now = Date.now();
  if (cachedSettings && currentUserId === userId && (now - lastFetchTime < CACHE_DURATION)) {
    console.log('📋 [UserSettings] Returning cached settings (fresh)');
    return cachedSettings;
  }

  const indexedSettings = await loadFromLocalPersistentStore(userId, deviceIdentifier);
  if (indexedSettings) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
    currentUserId = userId;
    lastFetchTime = Date.now();

    if (cachedSettings.theme_preference === 'auto') {
      initializeAutoDarkMode();
    }

    // Global settings (e.g. theme chosen on another device) must not be frozen
    // at this device's last cached values — refresh them in the background.
    refreshGlobalSettings(userId).catch(() => {});

    return cachedSettings;
  }

  // Check if offline - use defaults when no local cache exists
  if (!offlineManager.getOnlineStatus()) {
    console.log('📴 [UserSettings] No local settings cache available while offline, using defaults');
    return {
      ...DEFAULT_SETTINGS,
      selected_date: null,
      selected_driver_id: 'all',
      show_all_driver_markers: false,
      show_breadcrumbs: false,
      location_tracking_enabled: true
    };
  }

  if (inFlightSettingsPromise) {
    return inFlightSettingsPromise;
  }

  try {
    inFlightSettingsPromise = (async () => {
      console.log(`🔍 [UserSettings] Loading settings for user: ${userId}, device: ${deviceIdentifier}`);
      
      // Load the main UserSettings record for this user
      const userSettingsRecords = await UserSettings.filter({
        user_id: userId
      }, '-updated', 1);

    if (userSettingsRecords && userSettingsRecords.length > 0) {
      const userSettingsRecord = userSettingsRecords[0];
      
      // Get device-specific settings or initialize empty object
      const deviceProfile = userSettingsRecord.device_settings_profiles?.[deviceIdentifier] || {};
      // CRITICAL: Only extract keys currently classified as GLOBAL_SETTINGS.
      // This prevents stale values (e.g. notifications_enabled stored as global
      // before it was moved to device-specific) from bleeding through into the
      // merged settings and wrongly applying across all devices.
      const rawGlobalSettings = userSettingsRecord.global_settings || {};
      const globalSettings = {};
      GLOBAL_SETTINGS.forEach(key => {
        if (rawGlobalSettings[key] !== undefined) globalSettings[key] = rawGlobalSettings[key];
      });
      // theme_preference is GLOBAL now — once a global choice exists it must
      // win over this device's stale profile value left from the
      // device-specific era. Before any global choice exists, the device's
      // own value (or the per-device default) still applies.
      if (globalSettings.theme_preference !== undefined) {
        delete deviceProfile.theme_preference;
      }
      
      cachedSettings = {
         ...DEFAULT_SETTINGS,
         ...globalSettings,
         ...deviceProfile,
         show_all_driver_markers: deviceProfile.show_all_driver_markers ?? false,
         show_breadcrumbs: deviceProfile.show_breadcrumbs ?? false,
         location_tracking_enabled: deviceProfile.location_tracking_enabled ?? true,
         device_identifier: deviceIdentifier,
         device_type: deviceType
       };
      
      cachedGlobalSettings = globalSettings;
      currentUserId = userId;
      lastFetchTime = Date.now();
      
      await saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);
      
      if (cachedSettings.theme_preference === 'auto') {
        initializeAutoDarkMode();
      }
      
      console.log(`✅ [UserSettings] Loaded device profile for ${deviceIdentifier}`);
      return cachedSettings;
    }

    // No settings record found - create new one
    console.log(`ℹ️ [UserSettings] No settings record found, creating...`);
    
    try {
      const now = new Date().toISOString();
      const isMobile = deviceType === 'Mobile';
      
      // Resolve denormalized user_name from AppUser so quick displays avoid a join.
      let resolvedUserName = '';
      try {
        const { AppUser } = await import('@/entities/AppUser');
        const matches = await AppUser.filter({ user_id: userId });
        resolvedUserName = matches?.[0]?.user_name || '';
      } catch (_) { /* non-critical — backfill job will populate later */ }

      const newRecord = await UserSettings.create({
        user_id: userId,
        user_name: resolvedUserName,
        device_settings_profiles: {
          [deviceIdentifier]: {
            device_identifier: deviceIdentifier,
            device_type: deviceType,
            ...DEFAULT_SETTINGS,
            theme_preference: isMobile ? 'auto' : 'light',
            last_active_at: now
          }
        },
        global_settings: {},
        active_device_identifier: deviceIdentifier,
        created: now,
        updated: now
      });
      
      cachedSettings = {
        ...DEFAULT_SETTINGS,
        selected_date: null,
        selected_driver_id: 'all',
        show_all_driver_markers: false,
        show_breadcrumbs: false,
        location_tracking_enabled: true,
        device_identifier: deviceIdentifier,
        device_type: deviceType
      };
      cachedGlobalSettings = {};
      currentUserId = userId;
      lastFetchTime = Date.now();

      await saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);

      if (cachedSettings.theme_preference === 'auto') {
        initializeAutoDarkMode();
      }

      console.log(`✅ [UserSettings] Created new settings record with device profile`);
      return cachedSettings;
    } catch (createError) {
      console.error('❌ [UserSettings] Error creating settings record:', createError);
      cachedSettings = { ...DEFAULT_SETTINGS, device_identifier: deviceIdentifier, device_type: deviceType };
      currentUserId = userId;
      return cachedSettings;
    }
    })();

    return await inFlightSettingsPromise;
  } catch (error) {
    console.error('❌ [UserSettings] Error loading settings:', error);
    return { ...DEFAULT_SETTINGS };
  } finally {
    inFlightSettingsPromise = null;
  }
}

/**
 * Saves a specific setting to the backend
 * Updates either device-specific or global settings in UserSettings
 * @param {string} userId - The user's ID
 * @param {string} key - The setting key to update
 * @param {any} value - The new value
 * @returns {Promise<object>} - The updated settings object
 */
export async function saveSetting(userId, key, value) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, cannot save');
    return cachedSettings || { ...DEFAULT_SETTINGS };
  }

  const deviceIdentifier = getDeviceIdentifier();
  const deviceType = getDeviceType();
  const isGlobal = isGlobalSetting(key);

  console.log(`💾 [UserSettings] Saving ${isGlobal ? 'GLOBAL' : 'DEVICE'} setting: ${key}=${value}`);

  if (cachedSettings) {
    cachedSettings[key] = value;
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, [key]: value };
  }

  if (isGlobal) {
    cachedGlobalSettings = { ...cachedGlobalSettings, [key]: value };
  }
  currentUserId = userId;

  const idbWritePromise = saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);
  pendingWritePromises.add(idbWritePromise);
  idbWritePromise.finally(() => pendingWritePromises.delete(idbWritePromise));
  await idbWritePromise;

  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing setting ${key} for sync`);
    return cachedSettings;
  }

  return await new Promise((resolve) => {
    const timeoutKey = `${userId}:${deviceIdentifier}:${key}`;
    if (userSettingsSaveTimeouts.has(timeoutKey)) {
      clearTimeout(userSettingsSaveTimeouts.get(timeoutKey));
      try { pendingSaveBodies.delete(timeoutKey); } catch (_) {}
    }

    const performServerWrite = async (attempt) => {
      userSettingsSaveTimeouts.delete(timeoutKey);
      try {
        const userSettingsRecord = await getLatestUserSettingsRecord(userId);

        if (userSettingsRecord) {
          const now = new Date().toISOString();
          const updateData = {
            updated: now
          };

          if (isGlobal) {
            updateData.global_settings = {
              ...(userSettingsRecord.global_settings || {}),
              [key]: value
            };
          } else {
            updateData.device_settings_profiles = {
              ...(userSettingsRecord.device_settings_profiles || {}),
              [deviceIdentifier]: {
                ...(userSettingsRecord.device_settings_profiles?.[deviceIdentifier] || {}),
                device_identifier: deviceIdentifier,
                device_type: deviceType,
                [key]: value,
                last_active_at: now
              }
            };
          }

          await UserSettings.update(userSettingsRecord.id, updateData);
          console.log(`✅ [UserSettings] Updated ${isGlobal ? 'global' : 'device'} setting`);
        }

        resolve(cachedSettings);
      } catch (error) {
        const isRateLimit = error?.response?.status === 429 || error?.status === 429 || String(error?.message || '').includes('Rate limit exceeded');
        // FIX (Oct 1 2026): a 429 used to silently drop the server write — the
        // user's theme choice stayed local-only and the stale server value kept
        // winning on every restart. Retry with backoff instead of giving up.
        if (isRateLimit && attempt < 3) {
          console.warn(`⚠️ [UserSettings] Rate limited saving ${key} (attempt ${attempt + 1}) — retrying in ${(attempt + 2) * 1500}ms`);
          const retryId = setTimeout(() => performServerWrite(attempt + 1), (attempt + 2) * 1500);
          userSettingsSaveTimeouts.set(timeoutKey, retryId);
          pendingSaveBodies.set(timeoutKey, () => performServerWrite(attempt + 1));
          return;
        }
        console.error('❌ [UserSettings] Error saving setting:', error);
        resolve(cachedSettings || { ...DEFAULT_SETTINGS, [key]: value });
      }
    };

    const timeoutId = setTimeout(() => performServerWrite(0), 500);
    pendingSaveBodies.set(timeoutKey, () => performServerWrite(0));

    userSettingsSaveTimeouts.set(timeoutKey, timeoutId);
  });
}

// FIX (Oct 1 2026): killing/reloading the app inside the 500ms debounce window
// dropped the save entirely (theme choice lost, stale server value won on the
// next boot). Flush pending writes immediately when the page is being hidden.
const pendingSaveBodies = new Map();
export const flushPendingSettingSaves = () => {
  for (const [key, flush] of pendingSaveBodies.entries()) {
    const timer = userSettingsSaveTimeouts.get(key);
    if (timer) clearTimeout(timer);
    userSettingsSaveTimeouts.delete(key);
    pendingSaveBodies.delete(key);
    try { flush(); } catch (_) {}
  }
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingSettingSaves);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSettingSaves();
  });
}

/**
 * Waits for every currently in-flight setSetting IDB write (e.g. the
 * selected_date / selected_driver_id write kicked off by the dashboard's
 * date or driver picker) to resolve. Call this BEFORE a deliberate
 * window.location.reload() so the write that's already running can't lose
 * a race against the reload wiping the JS context mid-write.
 */
export async function waitForPendingSettingWrites() {
  if (pendingWritePromises.size === 0) return;
  // Snapshot — writes started by in-flight writes finishing (rare) will be
  // caught by the caller's own flow; we only need to not race the CURRENT ones.
  await Promise.allSettled(Array.from(pendingWritePromises));
}

/**
 * Saves multiple settings at once
 * Updates device-specific and/or global settings in UserSettings
 * @param {string} userId - The user's ID
 * @param {object} settings - Object with key-value pairs to save
 * @returns {Promise<object>} - The updated settings object
 */
export async function saveSettings(userId, settings) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, cannot save');
    return cachedSettings || { ...DEFAULT_SETTINGS };
  }

  const deviceIdentifier = getDeviceIdentifier();
  const deviceType = getDeviceType();
  
  const globalUpdates = {};
  const deviceUpdates = {};
  
  Object.keys(settings).forEach(key => {
    if (isGlobalSetting(key)) {
      globalUpdates[key] = settings[key];
    } else {
      deviceUpdates[key] = settings[key];
    }
  });
  
  console.log(`💾 [UserSettings] Saving ${Object.keys(globalUpdates).length} global + ${Object.keys(deviceUpdates).length} device settings`);
  
  // Update caches
  if (cachedSettings) {
    cachedSettings = { ...cachedSettings, ...settings };
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };
  }
  
  cachedGlobalSettings = { ...cachedGlobalSettings, ...globalUpdates };
  currentUserId = userId;
  
  await saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);

  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing settings for sync`);
    // Don't queue UserSettings updates when offline - just update cache
    // UserSettings should sync when online via background refresh
    return cachedSettings;
  }

  try {
    const userSettingsRecords = await UserSettings.filter({
      user_id: userId
    }, '-updated', 1);

    if (userSettingsRecords && userSettingsRecords.length > 0) {
      const userSettingsRecord = userSettingsRecords[0];
      const now = new Date().toISOString();
      
      const updateData = {
        updated: now
      };

      if (Object.keys(globalUpdates).length > 0) {
        updateData.global_settings = {
          ...(userSettingsRecord.global_settings || {}),
          ...globalUpdates
        };
      }

      if (Object.keys(deviceUpdates).length > 0) {
        updateData.device_settings_profiles = {
          ...(userSettingsRecord.device_settings_profiles || {}),
          [deviceIdentifier]: {
            ...(userSettingsRecord.device_settings_profiles?.[deviceIdentifier] || {}),
            device_identifier: deviceIdentifier,
            device_type: deviceType,
            ...deviceUpdates,
            last_active_at: now
          }
        };
      }

      await UserSettings.update(userSettingsRecord.id, updateData);
      console.log(`✅ [UserSettings] Updated settings`);
    }

    if (cachedSettings.theme_preference === 'auto') {
      initializeAutoDarkMode();
    }

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving settings:', error);
    // On error, just return cached - will retry on background refresh
    return cachedSettings || { ...DEFAULT_SETTINGS, ...settings };
  }
}

/**
 * Gets a specific setting value (from cache or defaults)
 * @param {string} key - The setting key
 * @returns {any} - The setting value
 */
export function getSetting(key) {
  if (cachedSettings && cachedSettings[key] !== undefined) {
    return cachedSettings[key];
  }
  return DEFAULT_SETTINGS[key];
}

/**
 * Apply auto dark mode - syncs with device's system dark mode preference
 * CRITICAL: Uses native prefers-color-scheme media query (no API calls)
 */
function applyAutoDarkMode() {
  const currentSettings = cachedSettings || { ...DEFAULT_SETTINGS };
  if (currentSettings.theme_preference !== 'auto') return;

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const root = document.documentElement;

  root.classList.remove('light-theme', 'dark-theme');
  root.classList.add('auto-theme');

  if (prefersDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  root.setAttribute('data-system-theme', prefersDark ? 'dark' : 'light');
  console.log(`🌓 [UserSettings] Auto dark mode synced with system: ${prefersDark ? 'DARK' : 'LIGHT'}`);
}

/**
 * Initialize auto dark mode monitoring
 * Listens for system dark mode changes and applies immediately
 */
let darkModeMediaQuery = null;
let userSettingsSaveTimeouts = new Map();
let inFlightUserSettingsRecordPromise = null;

async function getLatestUserSettingsRecord(userId) {
  if (!userId) return null;
  if (!inFlightUserSettingsRecordPromise) {
    inFlightUserSettingsRecordPromise = UserSettings.filter({
      user_id: userId
    }, '-updated', 1)
      .then((records) => records?.[0] || null)
      .finally(() => {
        inFlightUserSettingsRecordPromise = null;
      });
  }
  return inFlightUserSettingsRecordPromise;
}

export function initializeAutoDarkMode() {
  // Clean up existing listener
  if (darkModeMediaQuery) {
    darkModeMediaQuery.removeEventListener('change', applyAutoDarkMode);
  }
  
  // Apply immediately
  applyAutoDarkMode();
  
  // Listen for system dark mode changes
  darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkModeMediaQuery.addEventListener('change', applyAutoDarkMode);
  
  console.log('🌓 [UserSettings] Auto dark mode monitoring initialized (syncs with system)');
}

/**
 * Gets all current settings (from cache or defaults)
 * @returns {object} - All settings
 */
export function getAllSettings() {
  return cachedSettings || { ...DEFAULT_SETTINGS };
}

/**
 * Clears the settings cache (useful on logout)
 */
export function clearSettingsCache() {
  cachedSettings = null;
  currentUserId = null;
  inFlightSettingsPromise = null;
  console.log('🧹 [UserSettings] Cache cleared');
}

/**
 * Gets the default settings object
 * @returns {object} - Default settings
 */
export function getDefaultSettingsObject() {
  return { ...DEFAULT_SETTINGS };
}