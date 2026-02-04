/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 * Enhanced with offline caching support
 */

import { UserSettings } from '@/entities/UserSettings';
import { offlineManager } from './offlineManager';
import { getUserAgentInfo } from './deviceUtils';

// In-memory cache for current session
let cachedSettings = null;
let cachedGlobalSettings = null;
let currentUserId = null;
let cachedDeviceIdentifier = null;
let cachedDeviceType = null; // Cache device type (Mobile, Desktop, or Tablet)
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache to prevent rate limits

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
 * Gets device type identifier - "Mobile", "Desktop", or "Tablet"
 * CRITICAL: Classifies Tablet as Mobile for settings purposes
 */
export function getDeviceType() {
  // Return cached if available
  if (cachedDeviceType) {
    return cachedDeviceType;
  }

  const { deviceType } = getUserAgentInfo();
  
  // Classify Tablet as Mobile
  if (deviceType === 'Tablet') {
    cachedDeviceType = 'Mobile';
  } else {
    cachedDeviceType = deviceType === 'Mobile' ? 'Mobile' : 'Desktop';
  }
  
  console.log('📱 [UserSettings] Device Type:', cachedDeviceType);
  return cachedDeviceType;
}

/**
 * Default settings values
 * CRITICAL: Check device type to set appropriate default theme
 */
const getInitialDefaultSettings = () => {
  const { deviceType } = getUserAgentInfo();
  const isMobile = deviceType === 'Mobile';
  
  return {
    fab_map_cycle_phase: 1,
    units_of_measurement: 'kilometers',
    notifications_enabled: true,
    notifications_sound: true,
    notifications_vibration: true,
    sidebar_width: 240,
    right_panel_width: 350,
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
  'notifications_enabled', 
  'notifications_sound',
  'notifications_vibration'
];

// CRITICAL: These settings are NEVER synced across devices
// Each device maintains its own values for these
const DEVICE_SPECIFIC_SETTINGS = [
  'fab_map_cycle_phase',
  'sidebar_width',
  'right_panel_width',
  'theme_preference',
  'admin_utilities_year',
  'admin_utilities_month',
  'admin_utilities_driver'
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
export async function loadUserSettings(userId) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, returning defaults');
    return { ...DEFAULT_SETTINGS };
  }

  const deviceIdentifier = getDeviceIdentifier();
  const deviceType = getDeviceType();
  
  // Return cached if same user AND cache is fresh (< 5 min)
  const now = Date.now();
  if (cachedSettings && currentUserId === userId && (now - lastFetchTime < CACHE_DURATION)) {
    console.log('📋 [UserSettings] Returning cached settings (fresh)');
    return cachedSettings;
  }

  // Check if offline - use cached settings from IndexedDB
  if (!offlineManager.getOnlineStatus()) {
    console.log('📴 [UserSettings] Offline - loading from local persistent store');
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceIdentifier);
    if (indexedSettings) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
      currentUserId = userId;

      if (cachedSettings.theme_preference === 'auto') {
        initializeAutoDarkMode();
      }

      return cachedSettings;
    }
    
    console.log('⚠️ [UserSettings] No cached settings available in IndexedDB, using defaults');
    return { ...DEFAULT_SETTINGS };
  }

  try {
    console.log(`🔍 [UserSettings] Loading settings for user: ${userId}, device: ${deviceIdentifier}`);
    
    // Load the main UserSettings record for this user
    const userSettingsRecords = await UserSettings.filter({
      user_id: userId
    }, '-updated', 1);

    if (userSettingsRecords && userSettingsRecords.length > 0) {
      const userSettingsRecord = userSettingsRecords[0];
      
      // Get device-specific settings or initialize empty object
      const deviceProfile = userSettingsRecord.device_settings_profiles?.[deviceIdentifier] || {};
      const globalSettings = userSettingsRecord.global_settings || {};
      
      cachedSettings = {
        ...DEFAULT_SETTINGS,
        ...globalSettings,
        ...deviceProfile,
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
      
      const newRecord = await UserSettings.create({
        user_id: userId,
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

  } catch (error) {
    console.error('❌ [UserSettings] Error loading settings:', error);
    
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceIdentifier);
    if (indexedSettings) {
      console.log('📦 [UserSettings] Network error - falling back to cached settings');
      cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
      currentUserId = userId;

      if (cachedSettings.theme_preference === 'auto') {
        initializeAutoDarkMode();
      }

      return cachedSettings;
    }
    
    return { ...DEFAULT_SETTINGS };
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
  
  // Update cache
  if (cachedSettings) {
    cachedSettings[key] = value;
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, [key]: value };
  }
  
  if (isGlobal) {
    cachedGlobalSettings = { ...cachedGlobalSettings, [key]: value };
  }
  currentUserId = userId;
  
  await saveToLocalPersistentStore(userId, deviceIdentifier, cachedSettings);

  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing setting ${key} for sync`);
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      key,
      value,
      isGlobal,
      deviceIdentifier,
      data: { [key]: value }
    });
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

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving setting:', error);
    
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        key,
        value,
        isGlobal,
        deviceIdentifier,
        data: { [key]: value }
      });
    }
    
    return cachedSettings || { ...DEFAULT_SETTINGS, [key]: value };
  }
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
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceIdentifier,
      data: settings
    });
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
    
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceIdentifier,
        data: settings
      });
    }
    
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
  
  if (currentSettings.theme_preference !== 'auto') {
    return; // Only applies to 'auto' mode
  }
  
  // Check device's system dark mode preference
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  // Apply theme to document root
  if (prefersDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  
  console.log(`🌓 [UserSettings] Auto dark mode synced with system: ${prefersDark ? 'DARK' : 'LIGHT'}`);
}

/**
 * Initialize auto dark mode monitoring
 * Listens for system dark mode changes and applies immediately
 */
let darkModeMediaQuery = null;

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
  console.log('🧹 [UserSettings] Cache cleared');
}

/**
 * Gets the default settings object
 * @returns {object} - Default settings
 */
export function getDefaultSettingsObject() {
  return { ...DEFAULT_SETTINGS };
}