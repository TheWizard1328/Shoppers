/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 * Enhanced with offline caching support
 */

import { UserSettings } from '@/entities/UserSettings';
import { offlineManager } from './offlineManager';

const DEVICE_ID_KEY = 'rxdeliver_device_id';
const LOCAL_SETTINGS_KEY = 'rxdeliver_user_settings_cache';

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
 * Save settings to local storage for offline access
 */
function saveToLocalCache(userId, settings) {
  try {
    const cacheData = {
      userId,
      settings,
      timestamp: Date.now()
    };
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(cacheData));
    
    // Also save to IndexedDB via offlineManager
    offlineManager.cacheUserSettings(userId, settings);
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error saving to local cache:', error);
  }
}

/**
 * Load settings from local cache (for offline use)
 */
function loadFromLocalCache(userId) {
  try {
    const cached = localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (cached) {
      const data = JSON.parse(cached);
      if (data.userId === userId && data.settings) {
        console.log('📦 [UserSettings] Loaded from local cache');
        return data.settings;
      }
    }
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading from local cache:', error);
  }
  return null;
}

/**
 * Loads user settings from the backend for the current user and device
 * Falls back to cached settings when offline
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

  // Check if offline - use cached settings
  if (!offlineManager.getOnlineStatus()) {
    console.log('📴 [UserSettings] Offline - loading from cache');
    
    // Try local storage first
    const localSettings = loadFromLocalCache(userId);
    if (localSettings) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...localSettings };
      currentUserId = userId;
      return cachedSettings;
    }
    
    // Try IndexedDB cache
    const indexedSettings = await offlineManager.getCachedUserSettings(userId);
    if (indexedSettings) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
      currentUserId = userId;
      return cachedSettings;
    }
    
    // Return defaults if no cache available
    console.log('⚠️ [UserSettings] No cached settings available, using defaults');
    return { ...DEFAULT_SETTINGS };
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
      
      // Cache for offline use
      saveToLocalCache(userId, cachedSettings);
      
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
      
      // Cache for offline use
      saveToLocalCache(userId, cachedSettings);
      
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
    
    // Try to load from cache on error
    const localSettings = loadFromLocalCache(userId);
    if (localSettings) {
      console.log('📦 [UserSettings] Network error - falling back to cached settings');
      cachedSettings = { ...DEFAULT_SETTINGS, ...localSettings };
      currentUserId = userId;
      return cachedSettings;
    }
    
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves a specific setting to the backend
 * Queues for offline sync if not connected
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
  
  // Update local cache immediately for responsive UI
  if (cachedSettings) {
    cachedSettings[key] = value;
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, [key]: value };
  }
  currentUserId = userId;
  
  // Save to local cache for offline access
  saveToLocalCache(userId, cachedSettings);

  // If offline, queue for later sync
  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing setting ${key} for sync`);
    
    // Queue the update for when we're back online
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceId,
      key,
      value,
      data: { [key]: value }
    });
    
    return cachedSettings;
  }

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
    
    // Update local cache
    saveToLocalCache(userId, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving setting:', error);
    
    // Queue for retry if network error
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceId,
        key,
        value,
        data: { [key]: value }
      });
    }
    
    return cachedSettings || { ...DEFAULT_SETTINGS, [key]: value };
  }
}

/**
 * Saves multiple settings at once
 * Queues for offline sync if not connected
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
  
  // Update local cache immediately
  if (cachedSettings) {
    cachedSettings = { ...cachedSettings, ...settings };
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };
  }
  currentUserId = userId;
  
  // Save to local cache for offline access
  saveToLocalCache(userId, cachedSettings);

  // If offline, queue for later sync
  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing settings for sync`);
    
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceId,
      data: settings
    });
    
    return cachedSettings;
  }

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
    
    // Update local cache
    saveToLocalCache(userId, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving settings:', error);
    
    // Queue for retry if network error
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceId,
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