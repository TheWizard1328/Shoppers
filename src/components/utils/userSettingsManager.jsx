/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 */

import { UserSettings } from '@/entities/UserSettings';

const DEVICE_ID_KEY = 'rxdeliver_device_id';

// In-memory cache for current session
let cachedSettings = null;
let currentUserId = null;

/**
 * Gets or generates a unique device ID stored in localStorage
 */
export function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  
  if (!deviceId) {
    // Generate a UUID-like device ID
    deviceId = 'device_' + crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    console.log('📱 [UserSettings] Generated new device ID:', deviceId);
  }
  
  return deviceId;
}

/**
 * Default settings values
 */
const DEFAULT_SETTINGS = {
  fab_map_cycle_phase: 1,
  units_of_measurement: 'kilometers',
  notifications_enabled: true,
  notifications_sound: true,
  notifications_vibration: true,
  sidebar_width: 240,
  right_panel_width: 350,
  theme_preference: 'auto',
  selected_driver_id: null
};

/**
 * Loads user settings from the backend for the current user and device
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - The user settings object
 */
export async function loadUserSettings(userId) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, returning defaults');
    return { ...DEFAULT_SETTINGS };
  }

  const deviceId = getDeviceId();
  
  // Return cached if same user
  if (cachedSettings && currentUserId === userId) {
    console.log('📋 [UserSettings] Returning cached settings');
    return cachedSettings;
  }

  try {
    console.log(`🔍 [UserSettings] Loading settings for user: ${userId}, device: ${deviceId}`);
    
    const settings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    });

    if (settings && settings.length > 0) {
      // Merge with defaults to ensure all fields exist
      cachedSettings = { ...DEFAULT_SETTINGS, ...settings[0] };
      currentUserId = userId;
      console.log('✅ [UserSettings] Loaded existing settings:', cachedSettings);
      return cachedSettings;
    }

    // No settings found for this user/device combo - create a new record
    console.log('ℹ️ [UserSettings] No settings found, creating new record for user/device combo');
    try {
      const newSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS
      });
      cachedSettings = { ...DEFAULT_SETTINGS, ...newSettings };
      currentUserId = userId;
      console.log('✅ [UserSettings] Created new settings record:', cachedSettings);
      return cachedSettings;
    } catch (createError) {
      console.error('❌ [UserSettings] Error creating new settings record:', createError);
      cachedSettings = { ...DEFAULT_SETTINGS };
      currentUserId = userId;
      return cachedSettings;
    }

  } catch (error) {
    console.error('❌ [UserSettings] Error loading settings:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves a specific setting to the backend
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

  const deviceId = getDeviceId();

  try {
    console.log(`💾 [UserSettings] Saving ${key}=${value} for user: ${userId}, device: ${deviceId}`);

    // Find existing settings
    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    });

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      // Update existing record
      updatedSettings = await UserSettings.update(existingSettings[0].id, {
        [key]: value
      });
      console.log('✅ [UserSettings] Updated existing settings');
    } else {
      // Create new record with this setting
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS,
        [key]: value
      });
      console.log('✅ [UserSettings] Created new settings record');
    }

    // Update cache
    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving setting:', error);
    // Update local cache anyway for immediate UI response
    if (cachedSettings) {
      cachedSettings[key] = value;
    }
    return cachedSettings || { ...DEFAULT_SETTINGS, [key]: value };
  }
}

/**
 * Saves multiple settings at once
 * @param {string} userId - The user's ID
 * @param {object} settings - Object with key-value pairs to save
 * @returns {Promise<object>} - The updated settings object
 */
export async function saveSettings(userId, settings) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, cannot save');
    return cachedSettings || { ...DEFAULT_SETTINGS };
  }

  const deviceId = getDeviceId();

  try {
    console.log(`💾 [UserSettings] Saving multiple settings for user: ${userId}, device: ${deviceId}`, settings);

    // Find existing settings
    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    });

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      // Update existing record
      updatedSettings = await UserSettings.update(existingSettings[0].id, settings);
      console.log('✅ [UserSettings] Updated existing settings');
    } else {
      // Create new record with these settings
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS,
        ...settings
      });
      console.log('✅ [UserSettings] Created new settings record');
    }

    // Update cache
    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving settings:', error);
    // Update local cache anyway for immediate UI response
    if (cachedSettings) {
      cachedSettings = { ...cachedSettings, ...settings };
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
export function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}